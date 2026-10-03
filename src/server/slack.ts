import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ArchivedMessage, ArchivedReaction, ChannelRow, Reactor, SlackArchive } from './slack-archive.ts';
import type { Attention } from './sources.ts';
import { describeFailure, toSlackMessage, type SlackApi, type SlackConversation, type SlackMessage, type SlackSocket } from './slack-api.ts';
import { imageType } from './view.ts';

/** The images the server fetches. Anything else attached but a PDF is only noted. */
const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
/**
 * A PDF is fetched too, for natsumi to read with poppler in the workspace; it never reaches the model as an image. The
 * limit is the most an image may be set to: a document of some tens of pages fits, a whole scanned book does not.
 */
const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** The subtypes that are someone saying something. Joins, topic changes and the like are not recorded. */
const SPOKEN = new Set([undefined, 'file_share', 'thread_broadcast', 'bot_message', 'me_message']);

/** Tells the core of the sources that a message is for her (ADR 0050). */
export type TellAttention = (attention: Attention) => void;

export interface SlackWorkspaceOptions {
  /** The workspace's name in the config, and in every path and reference natsumi reads. */
  name: string;
  api: SlackApi;
  socket: SlackSocket;
  archive: SlackArchive;
  attention: TellAttention;
  /** Put on a mention or a DM as it arrives, by the server alone (ADR 0039). */
  reaction: string;
  backfillDays: number;
  maxImageBytes: number;
  now: () => number;
  log?: (line: string) => void;
}

/**
 * One Slack workspace, received (ADR 0012, ADR 0039, ADR 0050, ADR 0053). Every message of the channels the bot is in
 * goes into the archive; a real mention of the bot, or a DM, is also told to the core as an attention (`mention` or
 * `dm`), and gets the server's reaction as it arrives. A person's reply without a mention in a thread natsumi spoke in
 * is told as `thread-reply`, without the reaction: it may be people talking among themselves. Slack's own retries and its twin `app_mention` event tell nothing twice:
 * one message is told once, whichever way and however often it comes.
 *
 * A reaction put on or taken off a recorded message is recorded too (ADR 0043); one on anything else is let go.
 *
 * On every (re)connection each channel is filled in from its last recorded message, with the reactions on what it
 * fills in. What happens here happens in
 * order, one thing at a time, so a fill-in and the live events never write the same day at once.
 *
 * A failure is closed where it happens: a conversation Slack refuses is skipped and the rest are filled in, and a
 * thread, a name or an image that cannot be fetched leaves the message recorded without it. The log names the
 * workspace, the Web API method and Slack's code for the failure, never what anyone said nor any Slack ID.
 */
export class SlackWorkspace {
  private readonly options: SlackWorkspaceOptions;
  private self: { userId: string; botId?: string } | undefined;
  private readonly names = new Map<string, string>();
  /** People whose name Slack would not give, not asked again until the next fill-in. */
  private readonly unnamed = new Set<string>();
  /** While a fill-in runs: the failures it has logged, each once, and how many other failures it met. */
  private filling: { logged: Set<string>; others: number } | undefined;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(options: SlackWorkspaceOptions) { this.options = options; }

  async start(): Promise<void> {
    const { api, socket } = this.options;
    this.self = await api.whoAmI();
    socket.onEvent(event => this.enqueue('an event', () => this.handle(event)));
    socket.onConnected(() => this.enqueue('a fill-in', () => this.backfill()));
    await socket.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try { await this.options.socket.stop(); } catch { /* going away either way */ }
    await this.idle();
  }

  /** Resolves once everything received so far has been handled. */
  async idle(): Promise<void> {
    let current: Promise<void>;
    do { current = this.chain; await current; } while (current !== this.chain);
  }

  private enqueue(what: string, work: () => Promise<void>): void {
    this.chain = this.chain.then(async () => {
      if (this.stopped) return;
      try { await work(); } catch (error) {
        this.log(`handling ${what} failed (${describeFailure(error)})`);
      }
    });
  }

  private async handle(event: Record<string, unknown>): Promise<void> {
    if (event.type === 'reaction_added' || event.type === 'reaction_removed') return this.reacted(event);
    if (event.type !== 'message' && event.type !== 'app_mention') return;
    const channelId = typeof event.channel === 'string' ? event.channel : undefined;
    if (!channelId) return;
    const { archive, name } = this.options;
    const subtype = typeof event.subtype === 'string' ? event.subtype : undefined;
    if (subtype === 'message_deleted') {
      if (typeof event.deleted_ts === 'string') await archive.remove(name, channelId, event.deleted_ts);
      return;
    }
    const channel = await this.channel(channelId);
    if (subtype === 'message_changed') {
      const changed = event.message && typeof event.message === 'object' ? toSlackMessage(event.message as Record<string, unknown>) : undefined;
      // An edit changes the file and is told nothing more: what she was told of once is not told again.
      if (changed?.ts) await archive.record(name, channelId, { ...await this.archived(channel, changed), edited: true });
      return;
    }
    if (!SPOKEN.has(subtype)) return;
    await this.receive(channel, toSlackMessage(event), { live: true, mayRaise: true });
  }

  /**
   * A reaction put on or taken off. Only one on a message already recorded counts: a message older than the records
   * or in a channel never seen is not fetched for it.
   */
  private async reacted(event: Record<string, unknown>): Promise<void> {
    const item = event.item && typeof event.item === 'object' ? event.item as Record<string, unknown> : {};
    const { archive, name } = this.options;
    if (item.type !== 'message' || typeof item.channel !== 'string' || typeof item.ts !== 'string') return;
    if (typeof event.reaction !== 'string' || event.reaction === '' || typeof event.user !== 'string') return;
    if (!archive.has(name, item.channel, item.ts)) return;
    if (event.type === 'reaction_removed') return archive.unreact(name, item.channel, item.ts, event.reaction, event.user);
    await archive.react(name, item.channel, item.ts, event.reaction, await this.reactor(event.user));
  }

  /**
   * Fills in every channel from its last recorded message, and one never recorded from `backfillDays` back. Nothing
   * recorded is removed. A first fill-in tells of no mention: they are old news, and natsumi finds them in the files.
   */
  private async backfill(): Promise<void> {
    const conversations = await this.options.api.conversations();
    this.unnamed.clear();
    const filling = this.filling = { logged: new Set<string>(), others: 0 };
    let filled = 0;
    let done = 0;
    let failed = 0;
    try {
      for (const conversation of conversations) {
        if (this.stopped) return;
        try {
          filled += await this.fillIn(conversation);
          done += 1;
        } catch (error) {
          failed += 1;
          this.report('filling in a conversation failed', error, false);
        }
      }
    } finally {
      this.filling = undefined;
    }
    if (filled > 0 || failed > 0 || filling.others > 0) {
      this.log(`filled in ${filled} message(s) from ${done} conversation(s); ${failed} conversation(s) failed`
        + (filling.others > 0 ? `; ${filling.others} other failure(s)` : ''));
    }
  }

  /** One conversation, from its last recorded message. Returns how many messages were new. */
  private async fillIn(conversation: SlackConversation): Promise<number> {
    const { api, archive, name } = this.options;
    const channel = await this.channel(conversation.id, conversation);
    const cursor = archive.cursor(name, conversation.id);
    const oldest = cursor ?? String(Math.floor(this.options.now() / 1000) - this.options.backfillDays * 86_400);
    const how = { live: false, mayRaise: cursor !== undefined };
    let filled = 0;
    for (const message of await api.history(conversation.id, oldest)) {
      if (!SPOKEN.has(message.subtype)) continue;
      if (await this.fillInOne(channel, message, how)) filled += 1;
      if (!message.replyCount) continue;
      let thread: SlackMessage[];
      try { thread = await api.replies(conversation.id, message.ts); } catch (error) {
        this.report('a thread could not be fetched', error);
        continue;
      }
      for (const reply of thread) {
        if (reply.ts === message.ts || !SPOKEN.has(reply.subtype)) continue;
        if (await this.fillInOne(channel, reply, how)) filled += 1;
      }
    }
    return filled;
  }

  /** One message of a fill-in: one that cannot be recorded is logged and passed over. */
  private async fillInOne(channel: ChannelRow, message: SlackMessage, how: { live: boolean; mayRaise: boolean }): Promise<boolean> {
    try { return await this.receive(channel, message, how); } catch (error) {
      this.report('a message could not be recorded', error);
      return false;
    }
  }

  /** Records one message and, when it is for her, tells the core once. Returns whether it was new. */
  private async receive(channel: ChannelRow, message: SlackMessage, how: { live: boolean; mayRaise: boolean }): Promise<boolean> {
    const { archive, name } = this.options;
    if (!message.ts) return false;
    const reply = message.threadTs && message.threadTs !== message.ts ? message.threadTs : undefined;
    if (reply && !archive.has(name, channel.channel_id, reply)) {
      // Without its parent the reply still stands, on its own.
      try { await this.fetchParent(channel, reply, message.ts); } catch (error) { this.report('a thread could not be fetched', error); }
    }
    // What the Web API answers says every reaction; a live event says none.
    const fetched = how.live ? message : { ...message, reactions: message.reactions ?? [] };
    const isNew = await archive.record(name, channel.channel_id, { ...await this.archived(channel, fetched), ...(reply ? { threadTs: reply } : {}) });
    if (!how.mayRaise || !(isNew || how.live)) return isNew;
    const kind = this.forHer(channel, message) ? (channel.is_im ? 'dm' : 'mention')
      : reply && this.fromPerson(message) && archive.spokeIn(name, channel.channel_id, reply) ? 'thread-reply' : undefined;
    if (!kind) return isNew;
    // Its line is written by now, so the place told is where natsumi finds it.
    const place = archive.markForHer(name, channel.channel_id, message.ts);
    if (!place) return isNew;
    this.options.attention({ source: 'slack', kind, file: place.file, path: place.path,
      ...(place.images.length > 0 ? { images: place.images } : {}) });
    if (kind === 'thread-reply') return isNew;
    try { await this.options.api.addReaction(channel.channel_id, message.ts, this.options.reaction); } catch (error) {
      this.report('the reaction could not be added', error);
    }
    return isNew;
  }

  /**
   * A reply to a thread recorded nowhere: its parent is fetched and recorded first, so the reply has a place and the
   * thread can be read from the file — the flow around a mention is never sent with it (ADR 0050).
   */
  private async fetchParent(channel: ChannelRow, threadTs: string, except: string): Promise<void> {
    const thread = await this.options.api.replies(channel.channel_id, threadTs);
    const parent = thread.find(message => message.ts === threadTs);
    if (parent && parent.ts !== except) {
      await this.options.archive.record(this.options.name, channel.channel_id,
        await this.archived(channel, { ...parent, reactions: parent.reactions ?? [] }));
    }
  }

  /** A real mention of the bot, or a DM, from a person. No bot is for her, her own least of all. */
  private forHer(channel: ChannelRow, message: SlackMessage): boolean {
    if (!this.fromPerson(message)) return false;
    return channel.is_im === 1 || message.text.includes(`<@${this.self!.userId}>`);
  }

  /** Said by a person other than natsumi: not a bot, her own least of all. */
  private fromPerson(message: SlackMessage): boolean {
    return !message.botId && !!message.user && message.user !== this.self!.userId;
  }

  private async channel(channelId: string, known?: { name?: string; isIm: boolean; user?: string }): Promise<ChannelRow> {
    const { archive, api, name } = this.options;
    const existing = archive.channel(name, channelId);
    if (existing) return existing;
    const conversation = known ?? await api.conversation(channelId);
    const userName = conversation.isIm && conversation.user ? await this.userName(conversation.user) : undefined;
    return archive.addChannel(name, channelId, { ...(conversation.name ? { name: conversation.name } : {}), isIm: conversation.isIm,
      ...(userName ? { userName } : {}) });
  }

  private async archived(channel: ChannelRow, message: SlackMessage): Promise<ArchivedMessage> {
    const self = this.self!;
    const own = message.user === self.userId || (self.botId !== undefined && message.botId === self.botId);
    const speaker = message.user ? await this.userName(message.user) : message.username ?? 'bot';
    return {
      ts: message.ts, speaker, own, text: await this.plainText(message.text), edited: message.edited === true,
      files: await this.files(channel, message),
      ...(message.reactions ? { reactions: await this.reactions(message.reactions) } : {}),
    };
  }

  private async reactions(reactions: NonNullable<SlackMessage['reactions']>): Promise<ArchivedReaction[]> {
    const archived: ArchivedReaction[] = [];
    for (const reaction of reactions) {
      const people: Reactor[] = [];
      for (const user of new Set(reaction.users)) people.push(await this.reactor(user));
      archived.push({ name: reaction.name, people, others: Math.max(0, reaction.count - people.length) });
    }
    return archived;
  }

  /** Someone who put a reaction on, under the name their messages are recorded under. */
  private async reactor(userId: string): Promise<Reactor> {
    return { userId, name: await this.userName(userId), countable: userId !== this.self!.userId };
  }

  /** Slack's markup as natsumi reads it: names instead of IDs, links with their address. */
  private async plainText(text: string): Promise<string> {
    const users = [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map(match => match[1]!);
    for (const user of new Set(users)) await this.userName(user);
    return text
      .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, user: string) => `@${this.names.get(user) ?? 'someone'}`)
      .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => `#${label || this.options.archive.channel(this.options.name, id)?.directory || 'channel'}`)
      .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label?: string) => label || '@group')
      .replace(/<!date\^[^|>]*\|([^>]*)>/g, '$1')
      .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
      .replace(/<mailto:[^|>]*\|([^>]*)>/g, '$1')
      .replace(/<([a-z][a-z0-9+.-]*:[^|>]*)\|([^>]*)>/g, '$2（$1）')
      .replace(/<([a-z][a-z0-9+.-]*:[^>]*)>/g, '$1')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  /** Images and PDFs within their limits are fetched beside the day's file; the rest are only noted by name. */
  private async files(channel: ChannelRow, message: SlackMessage): Promise<ArchivedMessage['files']> {
    const noted: ArchivedMessage['files'] = [];
    for (const [index, file] of message.files.entries()) {
      const pdf = file.mimetype === 'application/pdf';
      const extension = pdf ? 'pdf' : IMAGE_TYPES[file.mimetype];
      const limit = pdf ? MAX_PDF_BYTES : this.options.maxImageBytes;
      if (!extension || file.size > limit || !file.url) { noted.push({ name: file.name }); continue; }
      const path = this.options.archive.filePath(this.options.name, channel.channel_id, message.ts, index, extension);
      if (await exists(path.disk)) { noted.push({ name: file.name, path: path.shown }); continue; }
      try {
        const body = await this.options.api.download(file.url, limit);
        // What Slack says a file is is the poster's word: the bytes have to agree.
        const agrees = body && (pdf ? body.subarray(0, 5).toString('latin1') === '%PDF-' : imageType(body));
        if (!agrees) { noted.push({ name: file.name }); continue; }
        await mkdir(dirname(path.disk), { recursive: true, mode: 0o750 });
        await writeFile(path.disk, body, { mode: 0o640 });
        noted.push({ name: file.name, path: path.shown });
      } catch (error) {
        this.report(pdf ? 'a PDF could not be fetched' : 'an image could not be fetched', error);
        noted.push({ name: file.name });
      }
    }
    return noted;
  }

  private async userName(userId: string): Promise<string> {
    const known = this.names.get(userId);
    if (known) return known;
    if (this.unnamed.has(userId)) return 'someone';
    let name: string;
    try { name = (await this.options.api.userName(userId)).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() || 'someone'; } catch (error) {
      this.unnamed.add(userId);
      this.report('a name could not be looked up', error);
      return 'someone';
    }
    this.names.set(userId, name);
    return name;
  }

  /**
   * A failure that was closed where it happened. During a fill-in the same line is logged once and the rest are
   * counted, so a scope missing for every image makes one line, not one per image. A failed conversation is counted
   * by the fill-in itself, not among the others.
   */
  private report(what: string, error: unknown, other = true): void {
    const line = `${what} (${describeFailure(error)})`;
    const filling = this.filling;
    if (filling) {
      if (other) filling.others += 1;
      if (filling.logged.has(line)) return;
      filling.logged.add(line);
    }
    this.log(line);
  }

  private log(line: string) { this.options.log?.(`slack (${this.options.name}): ${line}`); }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}
