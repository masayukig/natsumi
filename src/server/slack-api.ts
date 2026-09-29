import { LogLevel, SocketModeClient } from '@slack/socket-mode';
import { ErrorCode, WebClient } from '@slack/web-api';

/**
 * The edge of Slack (ADR 0012, ADR 0039): the few Web API calls the server makes with the bot token, and the Socket
 * Mode connection it listens on with the app token. Everything past this file works on the shapes below, so the
 * tests put a stand-in here and never touch the network.
 *
 * Only the bot's own tokens are used. Nothing here reads as the owner. The calls that post, `postMessage` and
 * `uploadFiles`, are the dove's alone (ADR 0040, ADR 0044): natsumi has no way to them but a request to the dove.
 */

/** A file attached to a message, as far as the server needs it. */
export interface SlackFile { id: string; name: string; mimetype: string; size: number; url: string }

/**
 * A reaction on a message as `conversations.history` and `replies` report it: its name, who put it on, and how many
 * did. Slack may name fewer people than it counts.
 */
export interface SlackReaction { name: string; users: string[]; count: number }

/** A message as the server records it. `threadTs` is set on a reply, and on a parent equals its own `ts`. */
export interface SlackMessage {
  ts: string;
  threadTs?: string;
  user?: string;
  /** Set when a bot posted it, the bot's own included. */
  botId?: string;
  /** The name a bot posted under, when it has no user. */
  username?: string;
  text: string;
  files: SlackFile[];
  subtype?: string;
  edited?: boolean;
  /** How many replies a parent has, as `conversations.history` reports it. */
  replyCount?: number;
  /** Its reactions, when Slack said: the Web API leaves the field out of a message with none, and an event of it. */
  reactions?: SlackReaction[];
}

/** A channel the bot is in, or a direct message with one person (`user`). */
export interface SlackConversation { id: string; name?: string; isIm: boolean; user?: string }

export interface SlackApi {
  /** Who the bot is: its user, to tell a mention, and its bot ID, to tell its own posts. */
  whoAmI(): Promise<{ userId: string; botId?: string }>;
  /** The channels and DMs the bot is a member of. */
  conversations(): Promise<SlackConversation[]>;
  conversation(id: string): Promise<SlackConversation>;
  /** Every top-level message after `oldest` (exclusive), oldest first, through all the pages. */
  history(channel: string, oldest: string): Promise<SlackMessage[]>;
  /** A thread: its parent and every reply, oldest first. */
  replies(channel: string, threadTs: string): Promise<SlackMessage[]>;
  userName(userId: string): Promise<string>;
  addReaction(channel: string, ts: string, name: string): Promise<void>;
  /** The names of the workspace's custom emoji, aliases included (`emoji.list`, which needs `emoji:read`). */
  customEmoji(): Promise<string[]>;
  /**
   * Posts as the bot, in a thread when `threadTs` is given and shown in the channel too when `replyBroadcast` is (ADR 0059),
   * under the icon at `iconUrl`. Returns the new message's ts.
   */
  postMessage(channel: string, text: string, options: { threadTs?: string; replyBroadcast?: boolean; iconUrl: string }): Promise<string>;
  /**
   * Posts images as the bot, as one message with the comment when given, in a thread when `threadTs` is given: the three
   * calls of `files.uploadV2` (ADR 0044). Slack takes no icon here, so the bot's own is shown.
   */
  uploadFiles(channel: string, files: { filename: string; data: Buffer }[], options: { threadTs?: string; initialComment?: string }): Promise<void>;
  /** A file's bytes, or undefined when it is larger than `maxBytes`. */
  download(url: string, maxBytes: number): Promise<Buffer | undefined>;
}

export interface SlackSocket {
  /** An Events API event, already acknowledged. The same event may come again: Slack retries. */
  onEvent(handler: (event: Record<string, unknown>) => void): void;
  /** Every (re)connection, the first included. */
  onConnected(handler: () => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * A Web API call Slack refused or that never got an answer: the method, and Slack's own code for why (`missing_scope`,
 * `not_in_channel`, `http_403`, `ratelimited`...), with the scope it lacked when Slack says. Nothing asked for or
 * answered is kept, so the log can say it whole.
 */
export class SlackCallError extends Error {
  readonly method: string;
  readonly reason: string;
  readonly needed: string | undefined;

  constructor(method: string, reason: string, needed?: string) {
    super(`${method} failed (${reason})`);
    this.name = 'SlackCallError';
    this.method = method;
    this.reason = reason;
    this.needed = needed;
  }
}

/** Slack's codes and scopes are plain words; anything else is not copied into the log. */
const PLAIN = /^[A-Za-z0-9_.:,-]{1,64}$/;
const plain = (value: unknown): string | undefined => typeof value === 'string' && PLAIN.test(value) ? value : undefined;

/** What the official SDK threw on `method`, as a `SlackCallError`. */
export function callError(method: string, error: unknown): SlackCallError {
  if (error instanceof SlackCallError) return error;
  const failure = (error ?? {}) as { code?: unknown; data?: { error?: unknown; needed?: unknown }; statusCode?: unknown;
    original?: { code?: unknown; name?: unknown } };
  switch (failure.code) {
    case ErrorCode.PlatformError: return new SlackCallError(method, plain(failure.data?.error) ?? 'unknown', plain(failure.data?.needed));
    case ErrorCode.HTTPError: return new SlackCallError(method, `http_${Number(failure.statusCode) || 'error'}`);
    case ErrorCode.RateLimitedError: return new SlackCallError(method, 'ratelimited');
    case ErrorCode.RequestError: return new SlackCallError(method, plain(failure.original?.code) ?? plain(failure.original?.name) ?? 'request_error');
    default: return new SlackCallError(method, plain(failure.code) ?? (error instanceof Error ? plain(error.name) : undefined) ?? 'error');
  }
}

/** One failure as the log says it: the call and Slack's code, or else the kind of error. Never a message or a path. */
export function describeFailure(error: unknown): string {
  if (error instanceof SlackCallError) return `${error.method}: ${error.reason}${error.needed ? `, needed ${error.needed}` : ''}`;
  if (!(error instanceof Error)) return 'error';
  const code = plain((error as { code?: unknown }).code);
  return `${plain(error.name) ?? 'Error'}${code ? `: ${code}` : ''}`;
}

/** Runs one Web API call, so that what it throws names the call. */
async function calling<T>(method: string, work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw callError(method, error); }
}

export type SlackConnector = (tokens: { botToken: string; appToken: string }) => { api: SlackApi; socket: SlackSocket };

/** A message from the Events API or the Web API, in the server's shape. Anything else in it is dropped. */
export function toSlackMessage(raw: Record<string, unknown>): SlackMessage {
  const string = (key: string) => typeof raw[key] === 'string' ? raw[key] as string : undefined;
  const files = Array.isArray(raw.files) ? raw.files as Record<string, unknown>[] : [];
  return {
    ts: string('ts') ?? '',
    ...(string('thread_ts') ? { threadTs: string('thread_ts') } : {}),
    ...(string('user') ? { user: string('user') } : {}),
    ...(string('bot_id') ? { botId: string('bot_id') } : {}),
    ...(string('username') ?? botName(raw) ? { username: string('username') ?? botName(raw) } : {}),
    text: string('text') ?? '',
    files: files.map(file => ({
      id: String(file.id ?? ''), name: String(file.name ?? file.title ?? 'file'), mimetype: String(file.mimetype ?? ''),
      size: typeof file.size === 'number' ? file.size : 0, url: String(file.url_private_download ?? file.url_private ?? ''),
    })),
    ...(string('subtype') ? { subtype: string('subtype') } : {}),
    ...(raw.edited ? { edited: true } : {}),
    ...(typeof raw.reply_count === 'number' ? { replyCount: raw.reply_count } : {}),
    ...(Array.isArray(raw.reactions) ? { reactions: reactions(raw.reactions) } : {}),
  };
}

function reactions(raw: unknown[]): SlackReaction[] {
  return raw.flatMap(item => {
    const reaction = (item ?? {}) as { name?: unknown; users?: unknown; count?: unknown };
    if (typeof reaction.name !== 'string' || reaction.name === '') return [];
    const users = Array.isArray(reaction.users) ? reaction.users.filter((user): user is string => typeof user === 'string') : [];
    return [{ name: reaction.name, users, count: typeof reaction.count === 'number' ? reaction.count : users.length }];
  });
}

function botName(raw: Record<string, unknown>): string | undefined {
  const profile = raw.bot_profile as { name?: unknown } | undefined;
  return typeof profile?.name === 'string' ? profile.name : undefined;
}

/** The official SDKs: they keep the socket alive, reconnect, and wait out Slack's rate limits on the Web API. */
export function connectSlack({ botToken, appToken }: { botToken: string; appToken: string }, options: { apiUrl?: string } = {}):
  ReturnType<SlackConnector> {
  // The SDKs log to the console on their own; only their errors are let through, and natsumi's own log says the rest.
  // `apiUrl` is for the tests, which answer the Web API on loopback.
  const web = new WebClient(botToken, { logLevel: LogLevel.ERROR, ...(options.apiUrl ? { slackApiUrl: options.apiUrl } : {}) });
  const socketClient = new SocketModeClient({ appToken, logLevel: LogLevel.ERROR });
  const api: SlackApi = {
    async whoAmI() {
      const answer = await calling('auth.test', () => web.auth.test());
      return { userId: String(answer.user_id), ...(answer.bot_id ? { botId: String(answer.bot_id) } : {}) };
    },
    async conversations() {
      const found: SlackConversation[] = [];
      let cursor: string | undefined;
      do {
        const page = await calling('users.conversations', () =>
          web.users.conversations({ types: 'public_channel,private_channel,im', limit: 200, exclude_archived: true, cursor }));
        for (const channel of page.channels ?? []) found.push(conversation(channel as Record<string, unknown>));
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return found;
    },
    async conversation(id) {
      const answer = await calling('conversations.info', () => web.conversations.info({ channel: id }));
      return conversation(answer.channel as Record<string, unknown>);
    },
    async history(channel, oldest) {
      const found: SlackMessage[] = [];
      let cursor: string | undefined;
      do {
        const page = await calling('conversations.history', () => web.conversations.history({ channel, oldest, limit: 200, cursor }));
        for (const message of page.messages ?? []) found.push(toSlackMessage(message as Record<string, unknown>));
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return found.filter(message => message.ts !== oldest).sort((a, b) => Number(a.ts) - Number(b.ts));
    },
    async replies(channel, threadTs) {
      const found: SlackMessage[] = [];
      let cursor: string | undefined;
      do {
        const page = await calling('conversations.replies', () => web.conversations.replies({ channel, ts: threadTs, limit: 200, cursor }));
        for (const message of page.messages ?? []) found.push(toSlackMessage(message as Record<string, unknown>));
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return found.sort((a, b) => Number(a.ts) - Number(b.ts));
    },
    async userName(userId) {
      const answer = await calling('users.info', () => web.users.info({ user: userId }));
      const user = answer.user;
      return user?.profile?.display_name || user?.real_name || user?.name || userId;
    },
    async addReaction(channel, ts, name) {
      try { await calling('reactions.add', () => web.reactions.add({ channel, timestamp: ts, name })); } catch (error) {
        // Already there (a retry that raced the first try) is what was wanted.
        if ((error as SlackCallError).reason !== 'already_reacted') throw error;
      }
    },
    async customEmoji() {
      const answer = await calling('emoji.list', () => web.emoji.list());
      return Object.keys(answer.emoji ?? {});
    },
    async postMessage(channel, text, { threadTs, replyBroadcast, iconUrl }) {
      // icon_url needs chat:write.customize. Links are not unfurled: a preview is more than what was judged. A reply in a
      // thread shown in the channel too (reply_broadcast, ADR 0059) needs nothing more than chat:write.
      const message = { channel, text, icon_url: iconUrl, unfurl_links: false, unfurl_media: false };
      const answer = await calling('chat.postMessage', () => web.chat.postMessage(!threadTs ? message
        : replyBroadcast ? { ...message, thread_ts: threadTs, reply_broadcast: true } : { ...message, thread_ts: threadTs }));
      return String(answer.ts ?? '');
    },
    async uploadFiles(channel, files, { threadTs, initialComment }) {
      // 1. A URL for each file. 2. Its bytes to that URL, which is Slack's own and signed: the token is not sent there.
      // 3. One completion that shares them all in the channel, as one message.
      const targets = await Promise.all(files.map(async file => {
        const answer = await calling('files.getUploadURLExternal', () =>
          web.files.getUploadURLExternal({ filename: file.filename, length: file.data.length }));
        if (!answer.upload_url || !answer.file_id) throw new SlackCallError('files.getUploadURLExternal', 'no_upload_url');
        return { url: answer.upload_url, id: answer.file_id, file };
      }));
      for (const { url, file } of targets) {
        let response: Response;
        try {
          response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(file.data) });
        } catch (error) {
          const cause = (error as { cause?: { code?: unknown } }).cause;
          throw new SlackCallError('files.upload', plain(cause?.code) ?? 'request_error');
        }
        await response.arrayBuffer().catch(() => undefined);
        if (!response.ok) throw new SlackCallError('files.upload', `http_${response.status}`);
      }
      const [first, ...rest] = targets.map(({ id, file }) => ({ id, title: file.filename }));
      if (!first) return;
      await calling('files.completeUploadExternal', () => web.files.completeUploadExternal({ files: [first, ...rest], channel_id: channel,
        ...(initialComment ? { initial_comment: initialComment } : {}), ...(threadTs ? { thread_ts: threadTs } : {}) }));
    },
    async download(url, maxBytes) {
      let response: Response;
      try { response = await fetch(url, { headers: { authorization: `Bearer ${botToken}` } }); } catch (error) {
        const cause = (error as { cause?: { code?: unknown } }).cause;
        throw new SlackCallError('files.download', plain(cause?.code) ?? 'request_error');
      }
      if (!response.ok || !response.body) throw new SlackCallError('files.download', `http_${response.status}`);
      // Slack answers a missing scope with its sign-in page rather than an error.
      if ((response.headers.get('content-type') ?? '').startsWith('text/html')) throw new SlackCallError('files.download', 'answered_with_a_page');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) return undefined;
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },
  };
  const socket: SlackSocket = {
    onEvent(handler) {
      socketClient.on('slack_event', async ({ ack, type, body }: { ack: () => Promise<void>; type: string; body?: { event?: unknown } }) => {
        await ack();
        if (type === 'events_api' && body?.event && typeof body.event === 'object') handler(body.event as Record<string, unknown>);
      });
    },
    onConnected(handler) { socketClient.on('connected', () => handler()); },
    async start() { await socketClient.start(); },
    async stop() { await socketClient.disconnect(); },
  };
  return { api, socket };
}

function conversation(raw: Record<string, unknown>): SlackConversation {
  return {
    id: String(raw.id), isIm: raw.is_im === true,
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(typeof raw.user === 'string' ? { user: raw.user } : {}),
  };
}
