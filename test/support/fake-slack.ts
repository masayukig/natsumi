import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SlackCallError, type SlackApi, type SlackConversation, type SlackMessage, type SlackSocket } from '../../src/server/slack-api.ts';

/** A PNG's first bytes, enough for the server to take a file for an image. */
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

/**
 * A whole 1×1 PNG, for an image that must reach the model: Pi decodes what a prompt carries and leaves out what it
 * cannot read.
 */
export const DECODABLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** A PNG whose header says its size, as a real one's does. */
export function pngOf(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13);
  return Buffer.concat([PNG.subarray(0, 8), length, Buffer.from('IHDR'), ihdr, Buffer.alloc(4), Buffer.alloc(32, 1)]);
}

/** Slack's `ts` for a moment given in UTC. The fraction keeps two messages of the same second apart. */
export function tsAt(iso: string, fraction = '000100'): string {
  return `${Math.floor(Date.parse(iso) / 1000)}.${fraction}`;
}

/**
 * A stand-in for one Slack workspace: the Web API the server calls and the Socket Mode connection it listens on.
 * Nothing goes over the network. The test puts channels, users and messages in, and emits events as Slack would.
 */
export class FakeSlack implements SlackApi, SlackSocket {
  readonly botUserId = 'UBOT';
  readonly botId = 'BBOT';
  readonly channels = new Map<string, SlackConversation>();
  /** Every message of a channel, replies included (they carry `threadTs`). */
  readonly messages = new Map<string, SlackMessage[]>();
  readonly users = new Map<string, string>([['U1', '山田'], ['U2', '佐藤'], ['UBOT', 'natsumi']]);
  readonly files = new Map<string, Buffer>();
  readonly reactions: { channel: string; ts: string; name: string }[] = [];
  /** The workspace's custom emoji as `emoji.list` answers: an image's URL, or `alias:<name>`. */
  readonly emoji = new Map<string, string>();
  emojiCalls = 0;
  /** What the dove posted, as `chat.postMessage` was called. */
  readonly posts: { channel: string; text: string; threadTs?: string; replyBroadcast?: true; iconUrl: string }[] = [];
  /** What the dove uploaded, one entry per files.uploadV2 (its three calls taken as one). */
  readonly uploads: { channel: string; files: { filename: string; data: Buffer }[]; threadTs?: string; initialComment?: string }[] = [];
  readonly historyCalls: { channel: string; oldest: string }[] = [];
  readonly downloads: string[] = [];
  /** Calls that fail as Slack would refuse them, by `<call> <argument>` (`history C2`, `userName U3`, `download <url>`). */
  readonly failures = new Map<string, SlackCallError>();
  started = 0;
  stopped = 0;
  private eventHandler: ((event: Record<string, unknown>) => void) | undefined;
  private connectedHandler: (() => void) | undefined;

  addChannel(conversation: SlackConversation): void {
    this.channels.set(conversation.id, conversation);
    if (!this.messages.has(conversation.id)) this.messages.set(conversation.id, []);
  }

  /** A message Slack already holds, as a backfill would find it. */
  post(channel: string, message: SlackMessage): void {
    this.messages.get(channel)!.push(message);
  }

  /** From now on, `call` with `argument` fails with Slack's error `code` (and the scope it lacked, if given). */
  fail(call: string, argument: string, method: string, code: string, needed?: string): void {
    this.failures.set(`${call} ${argument}`, new SlackCallError(method, code, needed));
  }

  private check(call: string, argument: string): void {
    const failure = this.failures.get(`${call} ${argument}`);
    if (failure) throw failure;
  }

  /** Slack sends an event over the socket. */
  emit(event: Record<string, unknown>): void { this.eventHandler?.(event); }

  /** Slack (re)connects: the server fills in what it missed. */
  connect(): void { this.connectedHandler?.(); }

  // SlackSocket

  onEvent(handler: (event: Record<string, unknown>) => void): void { this.eventHandler = handler; }
  onConnected(handler: () => void): void { this.connectedHandler = handler; }
  async start(): Promise<void> { this.started += 1; }
  async stop(): Promise<void> { this.stopped += 1; }

  // SlackApi

  async whoAmI() { return { userId: this.botUserId, botId: this.botId }; }

  async conversations(): Promise<SlackConversation[]> { return [...this.channels.values()]; }

  async conversation(id: string): Promise<SlackConversation> {
    this.check('conversation', id);
    const found = this.channels.get(id);
    if (!found) throw new Error('channel_not_found');
    return found;
  }

  async history(channel: string, oldest: string): Promise<SlackMessage[]> {
    this.historyCalls.push({ channel, oldest });
    this.check('history', channel);
    const all = this.messages.get(channel) ?? [];
    return all
      .filter(message => (!message.threadTs || message.threadTs === message.ts) && Number(message.ts) > Number(oldest))
      .map(message => ({ ...message, replyCount: all.filter(reply => reply.threadTs === message.ts && reply.ts !== message.ts).length }));
  }

  async replies(channel: string, threadTs: string): Promise<SlackMessage[]> {
    this.check('replies', threadTs);
    const all = this.messages.get(channel) ?? [];
    return all.filter(message => message.ts === threadTs || message.threadTs === threadTs)
      .sort((a, b) => Number(a.ts) - Number(b.ts));
  }

  async userName(userId: string): Promise<string> {
    this.check('userName', userId);
    return this.users.get(userId) ?? userId;
  }

  async addReaction(channel: string, ts: string, name: string): Promise<void> {
    this.check('addReaction', ts);
    this.reactions.push({ channel, ts, name });
  }

  async customEmoji(): Promise<string[]> {
    this.emojiCalls += 1;
    this.check('customEmoji', '');
    return [...this.emoji.keys()];
  }

  async postMessage(channel: string, text: string, options: { threadTs?: string; replyBroadcast?: boolean; iconUrl: string }): Promise<string> {
    this.check('postMessage', channel);
    this.posts.push({ channel, text, ...(options.threadTs ? { threadTs: options.threadTs } : {}),
      ...(options.replyBroadcast ? { replyBroadcast: true as const } : {}), iconUrl: options.iconUrl });
    return `${1_800_000_000 + this.posts.length}.000100`;
  }

  async uploadFiles(channel: string, files: { filename: string; data: Buffer }[], options: { threadTs?: string; initialComment?: string }): Promise<void> {
    this.check('uploadFiles', channel);
    this.uploads.push({ channel, files: files.map(file => ({ filename: file.filename, data: Buffer.from(file.data) })),
      ...(options.threadTs ? { threadTs: options.threadTs } : {}), ...(options.initialComment ? { initialComment: options.initialComment } : {}) });
  }

  async download(url: string, maxBytes: number): Promise<Buffer | undefined> {
    this.downloads.push(url);
    this.check('download', url);
    const body = this.files.get(url);
    if (!body) throw new Error('not found');
    return body.length > maxBytes ? undefined : body;
  }
}

/**
 * What natsumi does with a `sources_updated` that has an attention in Slack (ADR 0050), done by a scripted model: reads
 * the line its path names in the day file (`jq -s '.[N]' <file>`) and writes the reference to it from its time and
 * speaker. Undefined when the prompt carries no attention. `text` is the prompt as JSON; `data` is the data directory.
 */
export function referenceFromAttention(text: string, data: string): string | undefined {
  const match = /\\"file\\":\\"\/sources\/slack\/([^/"\\]+)\/([^/"\\]+)\/([^"\\]+\.jsonl)\\",\\"path\\":\\"\.\[(\d+)\]\\"/.exec(text);
  if (!match) return undefined;
  const [, workspace, directory, file, index] = match;
  const lines = readFileSync(join(data, 'sources', 'slack', workspace!, directory!, file!), 'utf8').split('\n').filter(Boolean);
  const line = JSON.parse(lines[Number(index)]!) as { at: string; from: string };
  const label = directory!.startsWith('@') ? directory! : `#${directory!}`;
  return `${workspace}/${label} ${line.at} ${line.from}`;
}
