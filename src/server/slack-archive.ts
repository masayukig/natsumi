import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DoveTarget } from './dove-request.ts';
import { isoAt } from './nightly.ts';
import { writeFileAtomically } from './paths.ts';
import type { SourceRegistration } from './sources.ts';
import { SOURCES_PATH } from './view.ts';

/**
 * What natsumi reads of Slack (ADR 0039, ADR 0050): every message of every channel the bot is in, kept in SQLite and
 * written out as one JSON Lines file a day under `sources/slack/<workspace>/<channel>/`, which the workspace sees
 * read-only as `/sources/slack/`. One line is one message, a reply in a thread included, in the order they were
 * recorded: a line never moves, so a `jq -s` path keeps pointing at its message. A change to a message writes its day's
 * file again from the rows, so an edit, a deletion or a reaction (ADR 0043) is never a patch on the file; a deleted
 * message stays as a line that says so. Nothing is removed from disk: the owner clears old files by hand.
 *
 * The core of the sources notices the files change (ADR 0050). A message for her — a real mention, a DM, or a reply in
 * a thread she spoke in (ADR 0053) — is told to it as an attention, with the line it is on. No Slack ID (ts, channel, user) is ever written where she reads it
 * (ADR 0024): a message is named by its file and the `jq -s` path of its line, as she reads it and as she names it to
 * the dove (ADR 0074).
 */

export const SLACK_SOURCE = 'slack';
/** Where natsumi sees this source. */
export const SLACK_PATH = `${SOURCES_PATH}/${SLACK_SOURCE}`;
/**
 * How the core measures Slack: by channel (`slack/<workspace>/<channel>`). The index changes with every message and
 * the fetched images and PDFs are named in the lines, so neither is kept in the history.
 */
export const SLACK_REGISTRATION: SourceRegistration = { name: SLACK_SOURCE, depth: 2, exclude: ['INDEX.md', '*/*/files/'] };

/** A message as it is recorded: the speaker's name is resolved and Slack's markup already turned into text. */
export interface ArchivedMessage {
  ts: string;
  /** Set on a reply, to its parent's ts. A parent's own `thread_ts` is not kept. */
  threadTs?: string;
  speaker: string;
  /** Posted by natsumi's own bot. */
  own: boolean;
  text: string;
  /** `path` is where the workspace sees a fetched image or PDF; without it the file was only noted. */
  files: { name: string; path?: string }[];
  edited: boolean;
  /**
   * Every reaction on it, when Slack said (a fill-in): what is recorded is made to match. Left out when Slack did
   * not say (a live message event), so what is recorded stays.
   */
  reactions?: ArchivedReaction[];
}

/** Someone who put a reaction on. `countable` is false for natsumi herself: her own reactions are never news to her. */
export interface Reactor { userId: string; name: string; countable: boolean }

/** One reaction on a message: the people Slack named, and how many more it only counted. */
export interface ArchivedReaction { name: string; people: Reactor[]; others: number }

/**
 * Where natsumi asked the dove to go, matched against the record (ADR 0040, ADR 0074): the channel, and the message
 * when one was named. The Slack IDs stay on the server's side of it.
 */
export interface ResolvedTarget {
  workspace: string;
  channelId: string;
  /** How she names the channel: `work/#dev`, `work/@name`. */
  label: string;
  message?: { ts: string; threadTs?: string; speaker: string; at: string; text: string };
}

/** One message as the dove's judge and the owner see it: who, when (local, to the second), what. */
export interface SeenMessage { from: string; at: string; text: string }
/** One flow of the talk as the dove's judge sees it: its latest messages, and when the last of them was said. */
export interface Flow { last_at: string | null; messages: SeenMessage[] }

export interface ChannelRow { workspace: string; channel_id: string; directory: string; label: string; is_im: number }

interface ReactionRow { ts: string; name: string; user_id: string; reactor: string; others: number }

interface MessageRow {
  workspace: string; channel_id: string; ts: string; thread_ts: string | null; speaker: string; own: number; text: string;
  files: string; edited: number; deleted: number; file_date: string; line: number;
}

/** Where a message is as natsumi reads it: its day's file and the `jq -s` path of its line. */
export interface MessageLine { file: string; path: string }

/** A message for her, as the core is told of it: the file and the `jq -s` path of its line, and its images. */
export interface ForHer extends MessageLine { images: string[] }

export interface SlackArchiveOptions {
  db: DatabaseSync;
  /** `sources/slack` in the data directory. */
  directory: string;
  timeZone: string;
  now: () => number;
}

/** A file natsumi can read: the group reads it, and nobody writes it through the workspace (ADR 0033). */
const FILE_MODE = 0o640;

export class SlackArchive {
  private readonly options: SlackArchiveOptions;
  private readonly db: DatabaseSync;
  private readonly clock: Intl.DateTimeFormat;
  /** File writes go one at a time, so two changes to a day never write its file out of order. */
  private writing: Promise<unknown> = Promise.resolve();

  constructor(options: SlackArchiveOptions) {
    this.options = options;
    this.db = options.db;
    this.clock = new Intl.DateTimeFormat('en-CA', { timeZone: options.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  }

  channel(workspace: string, channelId: string): ChannelRow | undefined {
    return this.db.prepare('SELECT * FROM slack_channels WHERE workspace = ? AND channel_id = ?').get(workspace, channelId) as
      ChannelRow | undefined;
  }

  /**
   * Records a channel the first time it is seen. Its directory is fixed then: a channel renamed later keeps its
   * files where natsumi has been reading them. A DM is named after the person, as `@name`.
   */
  addChannel(workspace: string, channelId: string, seen: { name?: string; isIm: boolean; userName?: string }): ChannelRow {
    const existing = this.channel(workspace, channelId);
    if (existing) return existing;
    const base = safeName(seen.isIm ? `@${seen.userName ?? 'someone'}` : seen.name ?? 'channel');
    let directory = base;
    for (let n = 2; this.db.prepare('SELECT 1 FROM slack_channels WHERE workspace = ? AND directory = ?').get(workspace, directory); n += 1) {
      directory = `${base}-${n}`;
    }
    const label = directory.startsWith('@') ? directory : `#${directory}`;
    this.db.prepare(`INSERT INTO slack_channels (workspace, channel_id, directory, label, is_im, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(workspace, channelId, directory, label, seen.isIm ? 1 : 0, this.iso());
    return this.channel(workspace, channelId)!;
  }

  has(workspace: string, channelId: string, ts: string): boolean {
    return this.row(workspace, channelId, ts) !== undefined;
  }

  /** Whether natsumi posted in a thread — its parent or a reply — with the post still there. */
  spokeIn(workspace: string, channelId: string, threadTs: string): boolean {
    return this.db.prepare(`SELECT 1 FROM slack_messages WHERE workspace = ? AND channel_id = ? AND (ts = ? OR thread_ts = ?)
      AND own = 1 AND deleted = 0 LIMIT 1`).get(workspace, channelId, threadTs, threadTs) !== undefined;
  }

  /** The newest top-level message recorded in a channel: a fill-in asks Slack for what came after it. */
  cursor(workspace: string, channelId: string): string | undefined {
    const row = this.db.prepare(`SELECT ts FROM slack_messages WHERE workspace = ? AND channel_id = ? AND thread_ts IS NULL
      ORDER BY CAST(ts AS REAL) DESC LIMIT 1`).get(workspace, channelId) as { ts: string } | undefined;
    return row?.ts;
  }

  /**
   * Where a fetched image or PDF goes: beside the day's files, named by the message's local time. Returns the path on
   * disk and the one natsumi reads.
   */
  filePath(workspace: string, channelId: string, ts: string, index: number, extension: string): { disk: string; shown: string } {
    const channel = this.channel(workspace, channelId)!;
    const { date, time } = this.local(ts);
    const name = `${date}-${time.replace(/:/g, '')}-${ts.split('.')[1] ?? '0'}-${index + 1}.${extension}`;
    return {
      disk: join(this.options.directory, workspace, channel.directory, 'files', name),
      shown: `${SLACK_PATH}/${workspace}/${channel.directory}/files/${name}`,
    };
  }

  /**
   * Records a message, or what changed in one already recorded, and writes its day's file and the index again. A new
   * one takes the next line of its day's file. Returns whether it was new.
   */
  async record(workspace: string, channelId: string, message: ArchivedMessage): Promise<boolean> {
    const existing = this.row(workspace, channelId, message.ts);
    const now = this.iso();
    const files = JSON.stringify(message.files);
    if (existing) {
      this.db.prepare(`UPDATE slack_messages SET text = ?, files = ?, edited = MAX(edited, ?), deleted = 0, updated_at = ?
        WHERE workspace = ? AND channel_id = ? AND ts = ?`)
        .run(message.text, files, message.edited ? 1 : 0, now, workspace, channelId, message.ts);
    } else {
      const parent = message.threadTs ? this.row(workspace, channelId, message.threadTs) : undefined;
      const fileDate = parent?.file_date ?? this.local(message.ts).date;
      const { next } = this.db.prepare(`SELECT COALESCE(MAX(line) + 1, 0) AS next FROM slack_messages
        WHERE workspace = ? AND channel_id = ? AND file_date = ?`).get(workspace, channelId, fileDate) as { next: number };
      this.db.prepare(`INSERT INTO slack_messages (workspace, channel_id, ts, thread_ts, speaker, own, text, files, edited, deleted,
        file_date, counted, line, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?)`)
        .run(workspace, channelId, message.ts, message.threadTs ?? null, message.speaker, message.own ? 1 : 0, message.text, files,
          message.edited ? 1 : 0, fileDate, next, now, now);
    }
    if (message.reactions) this.matchReactions(workspace, channelId, message.ts, message.reactions);
    await this.write(workspace, channelId, (existing ?? this.row(workspace, channelId, message.ts)!).file_date);
    return !existing;
  }

  /** A message deleted in Slack: its line stays, saying only that it was deleted, so no line after it moves. */
  async remove(workspace: string, channelId: string, ts: string): Promise<void> {
    const row = this.row(workspace, channelId, ts);
    if (!row || row.deleted) return;
    this.db.prepare(`UPDATE slack_messages SET deleted = 1, updated_at = ? WHERE workspace = ? AND channel_id = ? AND ts = ?`)
      .run(this.iso(), workspace, channelId, ts);
    await this.write(workspace, channelId, row.file_date);
  }

  /**
   * A reaction put on a recorded message: its day's file is written again with it. One already recorded (Slack sent
   * the event again) changes nothing. Returns false when the message is not recorded, and the reaction is let go.
   */
  async react(workspace: string, channelId: string, ts: string, name: string, reactor: Reactor): Promise<boolean> {
    const row = this.row(workspace, channelId, ts);
    if (!row) return false;
    const { changes } = this.db.prepare(`INSERT INTO slack_reactions (workspace, channel_id, ts, name, position, user_id, reactor, others,
      counted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?) ON CONFLICT DO NOTHING`)
      .run(workspace, channelId, ts, name, this.position(workspace, channelId, ts, name), reactor.userId, reactor.name, this.iso());
    if (Number(changes) > 0) await this.write(workspace, channelId, row.file_date);
    return true;
  }

  /** A reaction taken off: gone from the file. Someone Slack only counted comes off the number. */
  async unreact(workspace: string, channelId: string, ts: string, name: string, userId: string): Promise<void> {
    const row = this.row(workspace, channelId, ts);
    if (!row) return;
    let { changes } = this.db.prepare(`DELETE FROM slack_reactions WHERE workspace = ? AND channel_id = ? AND ts = ? AND name = ? AND user_id = ?`)
      .run(workspace, channelId, ts, name, userId);
    if (Number(changes) === 0) {
      ({ changes } = this.db.prepare(`UPDATE slack_reactions SET others = others - 1 WHERE workspace = ? AND channel_id = ? AND ts = ?
        AND name = ? AND user_id = '' AND others > 0`).run(workspace, channelId, ts, name));
      this.db.prepare(`DELETE FROM slack_reactions WHERE workspace = ? AND channel_id = ? AND ts = ? AND name = ? AND user_id = '' AND others = 0`)
        .run(workspace, channelId, ts, name);
    }
    if (Number(changes) > 0) await this.write(workspace, channelId, row.file_date);
  }

  /**
   * Marks a recorded message as for her, once: returns where it is — its day's file and the `jq -s` path of its line —
   * and its images (not its PDFs: she reads those with poppler), or undefined when it was marked before (Slack sent it
   * again, or it was a mention event before).
   */
  markForHer(workspace: string, channelId: string, ts: string): ForHer | undefined {
    const row = this.row(workspace, channelId, ts);
    const line = this.lineOf(workspace, channelId, ts);
    if (!row || !line) return undefined;
    const { changes } = this.db.prepare(`INSERT INTO slack_attention (workspace, channel_id, ts, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT DO NOTHING`).run(workspace, channelId, ts, this.iso());
    if (Number(changes) === 0) return undefined;
    return { ...line, images: fetched(parseFiles(row.files)).images };
  }

  /**
   * Where a recorded message is as natsumi reads it: its day's file and the `jq -s` path of its line. A line is its
   * place among its day's, which never moves (ADR 0050).
   */
  lineOf(workspace: string, channelId: string, ts: string): MessageLine | undefined {
    const row = this.row(workspace, channelId, ts);
    const channel = this.channel(workspace, channelId);
    if (!row || !channel) return undefined;
    const { index } = this.db.prepare(`SELECT COUNT(*) AS "index" FROM slack_messages WHERE workspace = ? AND channel_id = ? AND file_date = ?
      AND (line < ? OR (line = ? AND CAST(ts AS REAL) < CAST(? AS REAL)))`)
      .get(workspace, channelId, row.file_date, row.line, row.line, row.ts) as { index: number };
    return { file: `${SLACK_PATH}/${workspace}/${channel.directory}/${row.file_date}.jsonl`, path: `.[${index}]` };
  }

  /**
   * Finds what natsumi named for the dove (ADR 0074): a channel by its directory, or a message by its day's file and the
   * `jq -s` path of its line, as she reads them. Anything else, or anything the record does not have, is a sentence
   * saying what to write instead, which never names a ts (ADR 0024).
   */
  resolve(to: DoveTarget): { ok: true; target: ResolvedTarget } | { ok: false; text: string } {
    const refuse = (text: string) => ({ ok: false as const, text });
    const where = `to.file には、${SLACK_PATH} の下のチャンネルのディレクトリ（例: ${SLACK_PATH}/work/dev）か、`
      + `その中の日付のファイル（例: ${SLACK_PATH}/work/dev/2026-09-25.jsonl）を書いてください。`;
    const relative = to.file.startsWith(`${SLACK_PATH}/`) ? to.file.slice(SLACK_PATH.length + 1).replace(/\/+$/, '') : undefined;
    const parts = relative?.split('/') ?? [];
    if (relative === undefined || parts.some(part => part === '' || part === '.' || part === '..')) {
      return refuse(`to.file「${to.file}」は Slack の記録（${SLACK_PATH}）の外です。${where}`);
    }
    const day = parts.length === 3 && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(parts[2]!) ? parts[2]!.slice(0, -'.jsonl'.length) : undefined;
    if (parts.length !== 2 && !day) return refuse(`to.file「${to.file}」は、チャンネルのディレクトリでも日付のファイルでもありません。${where}`);
    const [workspace, directory] = parts as [string, string];
    const channelPath = `${SLACK_PATH}/${workspace}/${directory}`;
    const channel = this.db.prepare('SELECT * FROM slack_channels WHERE workspace = ? AND directory = ?').get(workspace, directory) as
      ChannelRow | undefined;
    if (!channel) return refuse(`チャンネル ${channelPath} の記録がありません。${SLACK_PATH}/INDEX.md にあるチャンネルのディレクトリを書いてください。`);
    const target: ResolvedTarget = { workspace, channelId: channel.channel_id, label: `${workspace}/${channel.label}` };
    if (!day) {
      if (to.path !== undefined) {
        return refuse(`チャンネルのディレクトリに path は付けません。発言に返すなら、to.file にその発言のある日のファイル（${channelPath}/<日付>.jsonl）を書いてください。`);
      }
      return { ok: true, target };
    }
    if (to.path === undefined) {
      return refuse(`発言に返すなら、to.path にその行の場所（例: ".[12]"）を書いてください。チャンネルそのものに投稿するなら、to.file にチャンネルのディレクトリ（${channelPath}）を書きます。`);
    }
    const index = Number(/^\.\[(\d+)\]$/.exec(to.path)?.[1] ?? Number.NaN);
    const row = Number.isSafeInteger(index) ? this.db.prepare(`SELECT * FROM slack_messages WHERE workspace = ? AND channel_id = ? AND file_date = ?
      ORDER BY line, CAST(ts AS REAL) LIMIT 1 OFFSET ?`).get(workspace, channel.channel_id, day, index) as MessageRow | undefined : undefined;
    if (!row) return refuse(`${to.file} に ${to.path} の行はありません。行の番号は 0 から数えます。ファイルの行か、出来事の attention の file と path を、そのまま写してください。`);
    if (row.deleted) return refuse(`${to.file} の ${to.path} の発言は消されています。`);
    const { date, time } = this.local(row.ts);
    return { ok: true, target: { ...target, message: { ts: row.ts, ...(row.thread_ts ? { threadTs: row.thread_ts } : {}), speaker: row.speaker,
      at: `${date} ${time}`, text: row.text } } };
  }

  /**
   * What the dove's judge is shown of the talk (ADR 0062): the time now, and the channel's latest top-level messages and
   * the latest in the target's thread, each up to now with the time of its last message, oldest first and cut to
   * `chars`. The thread is the one the reply would go to: the target's own, or the one it is in. Without a message
   * named there is no thread.
   */
  flows(target: ResolvedTarget, messages: number, chars: number): { now: string; channel: Flow; thread: Flow | null } {
    const seen = (rows: unknown[]): Flow => {
      const shown = (rows as MessageRow[]).reverse().map(row => {
        const { date, time } = this.local(row.ts);
        return { from: row.speaker, at: `${date} ${time}`, text: cut(row.text, chars) };
      });
      return { last_at: shown.at(-1)?.at ?? null, messages: shown };
    };
    const channel = seen(this.db.prepare(`SELECT * FROM slack_messages WHERE workspace = ? AND channel_id = ? AND deleted = 0
      AND thread_ts IS NULL ORDER BY CAST(ts AS REAL) DESC LIMIT ?`).all(target.workspace, target.channelId, messages));
    const root = target.message ? target.message.threadTs ?? target.message.ts : undefined;
    const thread = root === undefined ? null : seen(this.db.prepare(`SELECT * FROM slack_messages WHERE workspace = ? AND channel_id = ?
      AND deleted = 0 AND (ts = ? OR thread_ts = ?) ORDER BY CAST(ts AS REAL) DESC LIMIT ?`).all(target.workspace, target.channelId, root, root, messages));
    const { date, time } = this.localMs(this.options.now());
    return { now: `${date} ${time}`, channel, thread };
  }

  /** How many top-level messages came in the channel after this one. */
  following(workspace: string, channelId: string, ts: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM slack_messages WHERE workspace = ? AND channel_id = ? AND deleted = 0
      AND thread_ts IS NULL AND CAST(ts AS REAL) > CAST(? AS REAL)`).get(workspace, channelId, ts) as { n: number }).n;
  }

  /** Whether a recorded message is still there: neither deleted in Slack nor unknown. */
  isPresent(workspace: string, channelId: string, ts: string): boolean {
    const row = this.row(workspace, channelId, ts);
    return row !== undefined && row.deleted === 0;
  }

  /**
   * Makes the directory natsumi sees and the index, so an empty source still says so. Day files still in Markdown
   * (before ADR 0050) are written again as JSON Lines from every row recorded, and then removed.
   */
  async prepare(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o750 });
    await this.enqueue(async () => {
      const markdown = await this.markdownDays();
      if (markdown.length > 0) {
        const days = this.db.prepare('SELECT DISTINCT workspace, channel_id, file_date FROM slack_messages').all() as
          { workspace: string; channel_id: string; file_date: string }[];
        for (const day of days) await this.writeDay(day.workspace, day.channel_id, day.file_date);
        for (const path of markdown) await rm(path, { force: true });
      }
      await this.writeIndex();
    });
  }

  /** The day files written in Markdown, under every workspace and channel. */
  private async markdownDays(): Promise<string[]> {
    const found: string[] = [];
    const list = async (path: string) => { try { return await readdir(path, { withFileTypes: true }); } catch { return []; } };
    for (const workspace of await list(this.options.directory)) {
      if (!workspace.isDirectory()) continue;
      for (const channel of await list(join(this.options.directory, workspace.name))) {
        if (!channel.isDirectory()) continue;
        for (const file of await list(join(this.options.directory, workspace.name, channel.name))) {
          if (file.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(file.name)) found.push(join(this.options.directory, workspace.name, channel.name, file.name));
        }
      }
    }
    return found;
  }

  private row(workspace: string, channelId: string, ts: string): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM slack_messages WHERE workspace = ? AND channel_id = ? AND ts = ?').get(workspace, channelId, ts) as
      MessageRow | undefined;
  }

  /** Makes a message's recorded reactions what Slack said they are: what is no longer there goes, what is new comes. */
  private matchReactions(workspace: string, channelId: string, ts: string, reactions: ArchivedReaction[]): void {
    const key = (name: string, userId: string) => `${name}\u0000${userId}`;
    const wanted = new Set(reactions.flatMap(reaction => [
      ...reaction.people.map(person => key(reaction.name, person.userId)), ...(reaction.others > 0 ? [key(reaction.name, '')] : [])]));
    const recorded = this.db.prepare('SELECT name, user_id FROM slack_reactions WHERE workspace = ? AND channel_id = ? AND ts = ?')
      .all(workspace, channelId, ts) as { name: string; user_id: string }[];
    const gone = this.db.prepare('DELETE FROM slack_reactions WHERE workspace = ? AND channel_id = ? AND ts = ? AND name = ? AND user_id = ?');
    for (const row of recorded) if (!wanted.has(key(row.name, row.user_id))) gone.run(workspace, channelId, ts, row.name, row.user_id);
    const put = this.db.prepare(`INSERT INTO slack_reactions (workspace, channel_id, ts, name, position, user_id, reactor, others, counted,
      created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET position = excluded.position, others = excluded.others`);
    const now = this.iso();
    for (const [position, reaction] of reactions.entries()) {
      for (const person of reaction.people) {
        put.run(workspace, channelId, ts, reaction.name, position, person.userId, person.name, 0, 0, now);
      }
      if (reaction.others > 0) put.run(workspace, channelId, ts, reaction.name, position, '', '', reaction.others, 0, now);
    }
  }

  /** Where a reaction put on goes among a message's: its own place while anyone has it on, and otherwise the last. */
  private position(workspace: string, channelId: string, ts: string, name: string): number {
    const found = this.db.prepare(`SELECT MIN(CASE WHEN name = ? THEN position END) AS own, MAX(position) AS last FROM slack_reactions
      WHERE workspace = ? AND channel_id = ? AND ts = ?`).get(name, workspace, channelId, ts) as { own: number | null; last: number | null };
    return found.own ?? (found.last ?? -1) + 1;
  }

  private write(workspace: string, channelId: string, date: string): Promise<void> {
    return this.enqueue(async () => {
      await this.writeDay(workspace, channelId, date);
      await this.writeIndex();
    });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.writing.then(work, work);
    this.writing = run.catch(() => undefined);
    return run;
  }

  /** One day of one channel, from the rows: one line a message, in the order they were recorded. */
  private async writeDay(workspace: string, channelId: string, date: string): Promise<void> {
    const channel = this.channel(workspace, channelId)!;
    const rows = (this.db.prepare(`SELECT * FROM slack_messages WHERE workspace = ? AND channel_id = ? AND file_date = ?
      ORDER BY line, CAST(ts AS REAL)`).all(workspace, channelId, date) as unknown as MessageRow[]);
    const reactions = new Map<string, ReactionRow[]>();
    for (const reaction of this.db.prepare(`SELECT r.ts, r.name, r.user_id, r.reactor, r.others FROM slack_reactions r
      JOIN slack_messages m ON m.workspace = r.workspace AND m.channel_id = r.channel_id AND m.ts = r.ts
      WHERE m.workspace = ? AND m.channel_id = ? AND m.file_date = ? ORDER BY r.position, r.rowid`).all(workspace, channelId, date) as unknown as ReactionRow[]) {
      reactions.set(reaction.ts, [...reactions.get(reaction.ts) ?? [], reaction]);
    }
    const index = new Map(rows.map((row, at) => [row.ts, at]));
    const lines = rows.map(row => JSON.stringify(this.entry(row, index, reactions.get(row.ts) ?? [])));
    const path = join(this.options.directory, workspace, channel.directory, `${date}.jsonl`);
    await mkdir(join(this.options.directory, workspace, channel.directory), { recursive: true, mode: 0o750 });
    await writeFileAtomically(path, lines.length > 0 ? `${lines.join('\n')}\n` : '', FILE_MODE);
  }

  /**
   * One message as its line: when (local, to the second) and who, which are what a reference to it is written from;
   * `mine` on her own; `reply_to` the line of its thread's parent in the same file (`in_thread` when the parent is not
   * recorded); then the text, images, PDFs, attachments not taken in, `edited`, and the reactions. A deleted one keeps only
   * when, who, its place in a thread, and `deleted`.
   */
  private entry(row: MessageRow, index: Map<string, number>, reactions: ReactionRow[]): Record<string, unknown> {
    const { date, time } = this.local(row.ts);
    const parent = row.thread_ts ? index.get(row.thread_ts) : undefined;
    const base = {
      at: `${date} ${time}`, from: row.speaker, ...(row.own ? { mine: true } : {}),
      ...(row.thread_ts ? parent !== undefined ? { reply_to: parent } : { in_thread: true } : {}),
    };
    if (row.deleted) return { ...base, deleted: true };
    const files = parseFiles(row.files);
    const { images, pdfs } = fetched(files);
    const attachments = files.flatMap(file => file.path ? [] : [oneLine(file.name)]);
    const reacted = reactionList(reactions);
    return {
      ...base, text: row.text, ...(images.length > 0 ? { images } : {}), ...(pdfs.length > 0 ? { pdfs } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(row.edited ? { edited: true } : {}), ...(reacted.length > 0 ? { reactions: reacted } : {}),
    };
  }

  /** `INDEX.md`: every channel with when it last changed and its newest file. */
  private async writeIndex(): Promise<void> {
    const rows = this.db.prepare(`SELECT c.workspace, c.label, c.directory, MAX(CAST(m.ts AS REAL)) AS latest, MAX(m.file_date) AS file_date
      FROM slack_channels c LEFT JOIN slack_messages m ON m.workspace = c.workspace AND m.channel_id = c.channel_id
      GROUP BY c.workspace, c.channel_id ORDER BY c.workspace, c.label`).all() as
      { workspace: string; label: string; directory: string; latest: number | null; file_date: string | null }[];
    const lines = [
      '# Slack',
      '',
      'サーバーが書いている Slack の記録の目次です。チャンネルごとに、最後に発言が記録された時刻と、いちばん新しいファイルがあります。',
      '読み方は /manual/slack.md にあります。',
      '',
    ];
    if (rows.length === 0) lines.push('まだ記録しているチャンネルはありません。');
    else {
      lines.push('| チャンネル | 最後の発言 | いちばん新しいファイル |', '| --- | --- | --- |');
      for (const row of rows) {
        const last = row.latest === null ? '（まだなし）' : (({ date, time }) => `${date} ${time}`)(this.localMs(row.latest * 1000));
        const file = row.file_date ? `${SLACK_PATH}/${row.workspace}/${row.directory}/${row.file_date}.jsonl` : '';
        lines.push(`| ${row.workspace}/${row.label} | ${last} | ${file} |`);
      }
    }
    await mkdir(this.options.directory, { recursive: true, mode: 0o750 });
    await writeFileAtomically(join(this.options.directory, 'INDEX.md'), `${lines.join('\n')}\n`, FILE_MODE);
  }

  /** A ts as natsumi's local date and time to the second. */
  private local(ts: string): { date: string; time: string } {
    return this.localMs(Math.floor(Number(ts) * 1000));
  }

  private localMs(ms: number): { date: string; time: string } {
    const parts = Object.fromEntries(this.clock.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
  }

  private iso(): string { return isoAt(this.options.now()); }
}

/**
 * Each reaction in its place, with who put it on in the order they did, and how many more Slack only counted:
 * `[{ name: '+1', by: ['山田', '佐藤'] }, { name: 'tada', by: ['田中'], others: 3 }]`.
 */
function reactionList(rows: ReactionRow[]): { name: string; by: string[]; others?: number }[] {
  const byName = new Map<string, { people: string[]; others: number }>();
  for (const row of rows) {
    const reaction = byName.get(row.name) ?? { people: [], others: 0 };
    if (row.user_id === '') reaction.others += row.others; else reaction.people.push(oneLine(row.reactor) || 'someone');
    byName.set(row.name, reaction);
  }
  return [...byName].map(([name, { people, others }]) => ({ name: oneLine(name), by: people, ...(others > 0 ? { others } : {}) }));
}

function parseFiles(json: string): { name: string; path?: string }[] {
  try { return JSON.parse(json) as { name: string; path?: string }[]; } catch { return []; }
}

/** The fetched files' paths, told apart by the extension the server gave them. */
function fetched(files: { name: string; path?: string }[]): { images: string[]; pdfs: string[] } {
  const paths = files.flatMap(file => file.path ? [file.path] : []);
  return { images: paths.filter(path => !path.endsWith('.pdf')), pdfs: paths.filter(path => path.endsWith('.pdf')) };
}

/** A name that is safe as one directory: no separators, no control characters, no leading dot. */
function safeName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]+/g, '_').replace(/^\.+/, '_').trim().slice(0, 80);
  return cleaned === '' || cleaned === '@' ? `${cleaned}_` : cleaned;
}

function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

function cut(text: string, max: number): string {
  const characters = [...text];
  return characters.length > max ? `${characters.slice(0, max).join('')}…` : text;
}
