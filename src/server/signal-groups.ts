import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isoAt, localDate, localDateTime } from './nightly.ts';
import { describeSignalFailure, SIGNAL_GROUPS, type DoveSignalGroups } from './dove.ts';
import type { DoveTarget } from './dove-request.ts';
import { writeFileAtomically } from './paths.ts';
import type { Flow, MessageLine, ResolvedTarget } from './slack-archive.ts';
import type { Attention, SourceRegistration } from './sources.ts';
import { SOURCES_PATH } from './view.ts';

/**
 * Fork (ADR F06): what natsumi hears in the Signal groups the owner approved, written as one JSON Lines file a day under
 * `sources/signal/<group>/`, which the workspace sees read-only as `/sources/signal/`. A line is a message, in the shape
 * of a Slack line (`at`, `from`, `text`, `attachments`), so she reads both the same way. A message that mentions her or
 * quotes one of her lines is told to the core as an attention, with its line. No phone number or Signal ID is written.
 *
 * Anyone in a group she is in can add her to another (groups v2), and Signal cannot stop it. So a group she is found in
 * (added, invited, or there at the start) that is not approved is asked about once in the owner's 1:1 chat: a 👍 (or a
 * quoted 参加/ok) approves it, a 👎 or ❌ (or 見送る/no) or no answer within a day makes her leave and block it. Until it
 * is approved nothing from it is written, said or answered. The groups in the config are approved while they are listed
 * there. Each group's state is kept in a table of this fork's own, made here, as F02 and F04 do.
 *
 * ponytail: lines are appended and never written again, so an edit, a deletion or a reaction in Signal is not seen;
 * keep the messages in SQLite and write the day again, as slack-archive.ts does, if that matters.
 */

export const SIGNAL_SOURCE = 'signal';
export const SIGNAL_PATH = `${SOURCES_PATH}/${SIGNAL_SOURCE}`;
/** How the core measures Signal: by group (`signal/<group>`). The index of the groups is not news. */
export const SIGNAL_REGISTRATION: SourceRegistration = { name: SIGNAL_SOURCE, depth: 1, exclude: ['INDEX.md'] };

/** A file natsumi can read: the group reads it, and nobody writes it through the workspace (ADR 0033), as Slack's. */
const FILE_MODE = 0o640;
/** How much of a quoted line is kept with the reply. */
const QUOTE_CHARS = 60;
/** What signal-cli leaves in the text where a mention is. */
const MENTION_MARK = '\uFFFC';

interface Mention { number?: unknown; uuid?: unknown; start?: unknown; length?: unknown }

/** A message envelope as signal-cli writes it, as far as a group needs. */
export interface GroupEnvelope {
  sourceNumber?: unknown; sourceUuid?: unknown; sourceName?: unknown; timestamp?: unknown;
  dataMessage?: {
    timestamp?: unknown; message?: unknown;
    groupInfo?: { groupId?: unknown; type?: unknown };
    mentions?: Mention[];
    quote?: { authorNumber?: unknown; authorUuid?: unknown; text?: unknown } | null;
    attachments?: { contentType?: unknown; filename?: unknown; size?: unknown }[];
  };
}

/**
 * Fork (ADR F07): when a message with no mention is still for her. `followUpMs`: after her own last post, what people
 * say is a `follow-up`. `quietMs`: a group quiet this long after talk that raised nothing is a `conversation`, at most
 * once every `conversationEveryMs` and never so soon after any other attention there or her own post. `burstMs`: a
 * `name` or `follow-up` this soon after another attention there is not raised again. A message older than `staleMs`
 * (by its Signal time, as when the stream comes back) raises none of those three, and one older than `staleMentionMs`
 * not even a mention or a quote of her.
 */
export const GROUP_TIMING = {
  followUpMs: 10 * 60_000, quietMs: 2 * 60_000, conversationEveryMs: 5 * 60_000, burstMs: 60_000,
  staleMs: 10 * 60_000, staleMentionMs: 6 * 60 * 60_000,
};
/** How far a sender's clock may be behind hers, for a `follow-up`. */
const CLOCK_SKEW_MS = 5_000;

/** How long a group waits for the owner's answer before she leaves it. */
export const GROUP_ANSWER_MS = 24 * 60 * 60 * 1000;
/** How many times a question that could not be sent is tried again, on the sweeps after it. */
const MAX_ASK_TRIES = 3;

export interface SignalGroupsOptions {
  db: DatabaseSync;
  /** Asks the owner, and leaves, blocks or joins a group: the daemon's SignalApi (signal.ts), which imports this. */
  api: {
    send(message: string): Promise<number>;
    listGroups?(): Promise<ListedGroup[]>;
    quitGroup?(groupId: string): Promise<void>;
    block?(groupId: string): Promise<void>;
    acceptGroup?(groupId: string): Promise<void>;
    sendGroup?(groupId: string, message: string, options?: { quote?: { timestamp: number; author: string; text: string }; attachments?: string[] }): Promise<number>;
    reactInGroup?(groupId: string, emoji: string, target: { timestamp: number; author: string }): Promise<void>;
    /** Marks a group message as read for its sender (ADR F07). */
    receipt?(recipient: string, timestamp: number): Promise<void>;
  };
  /** `sources/signal` in the data directory. */
  directory: string;
  /**
   * Directory name → group ID (base64), from the config: approved while it is listed, under that name. It is never
   * written to the table, so a group taken out of the config is asked about like any other (unless the owner approved
   * it before), and a name moved to another group moves with the config.
   */
  groups: Readonly<Record<string, string>>;
  /** The number natsumi is registered as: a mention or quote of it is for her. */
  account: string;
  /** Her name, written where a message mentions her. */
  selfName: string;
  timeZone: string;
  attention?: (attention: Attention) => void;
  /** Other names she answers to in a group, besides `selfName` (ADR F07), such as a romaji spelling. */
  names?: readonly string[];
  /**
   * Called with each attention that asks for an answer (all but `conversation`), and with each post of hers sent, so
   * "typing…" can be shown in the group while she works on it, and again after a post while she still is (ADR F07).
   */
  typing?: { start(groupId: string, place: { file: string; path: string }): void; posted(groupId: string): void };
  /** The waits of the attentions without a mention; the defaults are `GROUP_TIMING`. Tests shorten them. */
  timing?: Partial<typeof GROUP_TIMING>;
  /**
   * Whether an attention raised before is still waiting for her, or for its turn to end (ADR F07): a `name` or a
   * `follow-up` is held back only while one is, since she reads the new line with it. Without it, `burstMs` decides.
   */
  isOpen?: (place: { file: string; path: string }) => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

interface GroupRow { group_id: string; name: string; title: string; state: 'pending' | 'approved' | 'refused'; asked_at: string; question: string; asked_ts: number | null; tries: number }
/** A group as it stands: approved by the config, or as the table has it. */
interface Standing { state: GroupRow['state']; name: string; title: string }
/** A line written, as the server keeps it (ADR F07): with the Signal timestamp and author a quote or a reaction needs. */
interface LineRow { group_id: string; file_date: string; line: number; sent_ts: number; author: string; speaker: string; at: string; text: string }

export class SignalGroups implements DoveSignalGroups {
  private readonly options: SignalGroupsOptions;
  private readonly now: () => number;
  private readonly configured: Map<string, string>;
  /** Asking, joining and leaving go one at a time, so a group is never asked about twice. */
  private chain: Promise<void> = Promise.resolve();
  /** The profile names seen, by number and by UUID, so a mention can be written as a name. ponytail: in memory only. */
  private readonly names = new Map<string, string>();
  /** The names she answers to, in lower case, with hiragana and katakana each written both ways. */
  private readonly callNames: string[];
  private readonly timing: typeof GROUP_TIMING;
  /**
   * By group directory: when her last post went, when the last attention was raised, the latest line, and the wait for
   * the talk to settle. ponytail: in memory, so a restart forgets them; a conversation being waited on is simply lost.
   */
  private readonly lastOwn = new Map<string, number>();
  private readonly attended = new Map<string, number>();
  private readonly latest = new Map<string, { file: string; path: string }>();
  private readonly settling = new Map<string, ReturnType<typeof setTimeout>>();
  /** The place of the last attention raised in each group, and the order of what happened there, so a `conversation` knows what covered its line. */
  private readonly lastPlace = new Map<string, { file: string; path: string }>();
  private readonly order = new Map<string, { line: number; attention: number; own: number }>();
  private step = 0;
  private stopped = false;
  /** The groups' names in Signal as the last listing had them, for the index. */
  private readonly titles = new Map<string, string>();
  /** Whether the last listing failed, so a failure and the recovery after it are logged once each. */
  private listing: 'ok' | 'failing' = 'ok';
  /** Approved groups whose invitation could not be accepted, so the owner is told once. ponytail: in memory only. */
  private readonly acceptFailed = new Set<string>();
  private writing: Promise<unknown> = Promise.resolve();

  constructor(options: SignalGroupsOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.configured = new Map(Object.entries(options.groups).map(([name, id]) => [id, name]));
    this.timing = { ...GROUP_TIMING, ...options.timing };
    const kana = (text: string, from: number, to: number) => text.replace(/[\u3041-\u3096\u30a1-\u30f6]/g, ch => {
      const code = ch.codePointAt(0)!;
      return code >= from && code <= from + 0x55 ? String.fromCodePoint(code - from + to) : ch;
    });
    // NFKC, so half-width kana and full-width Latin match too. A name of one character would match everything.
    this.callNames = [...new Set([options.selfName, ...options.names ?? []].map(normal).filter(name => [...name].length >= 2)
      .flatMap(name => [name, kana(name, 0x3041, 0x30a1), kana(name, 0x30a1, 0x3041)]))];
    options.db.exec(`CREATE TABLE IF NOT EXISTS fork_signal_groups (
      group_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'refused')),
      asked_at TEXT NOT NULL,
      question TEXT NOT NULL DEFAULT '',
      asked_ts INTEGER UNIQUE,
      tries INTEGER NOT NULL DEFAULT 0,
      decided_at TEXT
    ) STRICT`);
    // Fork (ADR F07): what the dove needs of each line to quote it or react to it, never shown to natsumi (ADR 0024).
    options.db.exec(`CREATE TABLE IF NOT EXISTS fork_signal_lines (
      group_id TEXT NOT NULL,
      file_date TEXT NOT NULL,
      line INTEGER NOT NULL,
      sent_ts INTEGER NOT NULL,
      author TEXT NOT NULL,
      speaker TEXT NOT NULL,
      at TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (group_id, file_date, line)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS fork_signal_lines_by_ts ON fork_signal_lines (group_id, sent_ts)`);
    // Her last post in each group, so a follow-up is known across a restart.
    for (const row of options.db.prepare(`SELECT group_id, MAX(sent_ts) AS at FROM fork_signal_lines WHERE author = ? GROUP BY group_id`)
      .all(options.account) as { group_id: string; at: number }[]) {
      const name = this.standing(row.group_id)?.name;
      if (name) this.lastOwn.set(name, row.at);
    }
  }

  /**
   * One sweep over the groups signal-cli lists: one she is in or invited to that is not known is asked about (a blocked
   * one, or one she left, never is); a question that could not be sent is tried again; an approved group she is still
   * only invited to is joined. A failed listing changes nothing.
   */
  sync(): Promise<void> {
    return this.enqueue(async () => {
      // Those that failed on an earlier sweep, not one asked just now.
      const unsent = this.options.db.prepare(`SELECT * FROM fork_signal_groups WHERE state = 'pending' AND asked_ts IS NULL AND tries < ?`)
        .all(MAX_ASK_TRIES) as unknown as GroupRow[];
      const listed = await this.list();
      for (const group of listed) {
        if (typeof group.id !== 'string') continue;
        if (typeof group.name === 'string') this.titles.set(group.id, oneLine(group.name));
        const standing = this.standing(group.id);
        if (!standing && group.isBlocked !== true && (group.isMember === true || this.invited(group))) await this.ask(group.id, undefined, group);
        if (standing?.state === 'approved' && group.isMember !== true && this.invited(group)) await this.accept(group.id, standing.title);
      }
      for (const row of unsent) if (!this.configured.has(row.group_id)) await this.send(row);
      await this.writeIndex();
    });
  }

  /**
   * The questions the owner did not answer within a day of being asked: she leaves those groups and blocks them. A
   * group the config approves is never left.
   */
  expire(): Promise<void> {
    const before = isoAt(this.now() - GROUP_ANSWER_MS);
    const late = this.options.db.prepare(`SELECT group_id FROM fork_signal_groups WHERE state = 'pending' AND asked_at <= ?`).all(before) as { group_id: string }[];
    return this.enqueue(async () => { for (const { group_id } of late) await this.refuse(group_id, '24 時間答えがなかったので'); });
  }

  /**
   * A reaction by the owner. True when it is on a group's question, so it is not also said to natsumi; one on a question
   * already decided (answered, or a day old) changes nothing.
   */
  react(sentAt: number, emoji: string): boolean {
    const row = this.asked(sentAt);
    if (!row) return false;
    const decision = emoji.startsWith('👍') ? 'approve' : emoji.startsWith('👎') || emoji === '❌' ? 'refuse' : undefined;
    if (decision) this.decide(row.group_id, decision);
    return true;
  }

  /** A quoted reply. True when it answered a group's question. */
  answer(quotedAt: number, text: string): boolean {
    const row = this.asked(quotedAt);
    const word = text.trim().toLowerCase();
    const decision = word === '参加' || word === 'ok' ? 'approve' : word === '見送る' || word === 'no' ? 'refuse' : undefined;
    if (!row || !decision) return false;
    this.decide(row.group_id, decision);
    return true;
  }

  /** Waits for the asking, joining, leaving and writing started so far. */
  async idle(): Promise<void> {
    let current: [Promise<unknown>, Promise<unknown>];
    do { current = [this.chain, this.writing]; await Promise.all(current); } while (current[0] !== this.chain || current[1] !== this.writing);
  }

  private decide(groupId: string, decision: 'approve' | 'refuse'): void {
    void this.enqueue(async () => {
      const row = this.row(groupId);
      if (row?.state !== 'pending' || this.configured.has(groupId)) return;
      if (decision === 'refuse') { await this.refuse(groupId, ''); return; }
      this.options.db.prepare(`UPDATE fork_signal_groups SET state = 'approved', decided_at = ? WHERE group_id = ?`).run(isoAt(this.now()), groupId);
      await this.writeIndex();
      await this.options.api.send(`→ 参加しました: 『${row.title}』。${SIGNAL_PATH}/${row.name} に記録します`);
      // An invitation is accepted now rather than at the next sweep.
      const group = (await this.list()).find(candidate => candidate.id === groupId);
      if (group && group.isMember !== true && this.invited(group)) await this.accept(groupId, row.title);
    });
  }

  /** Accepts the invitation to an approved group. A failure is tried again on every sweep, and told to the owner once. */
  private async accept(groupId: string, title: string): Promise<void> {
    try {
      await this.options.api.acceptGroup?.(groupId);
      this.acceptFailed.delete(groupId);
    } catch (error) {
      this.log(`an invitation could not be accepted (${describe(error)})`);
      if (this.acceptFailed.has(groupId)) return;
      this.acceptFailed.add(groupId);
      await this.options.api.send(`→ 『${title}』の招待を受けられませんでした。毎分試し直します。Signal のアプリでも確かめてください`);
    }
  }

  /** Leaves and blocks a group, records it as refused, and tells the owner what came of it. */
  private async refuse(groupId: string, why: string): Promise<void> {
    const row = this.row(groupId);
    if (!row || row.state !== 'pending' || this.configured.has(groupId)) return;
    this.options.db.prepare(`UPDATE fork_signal_groups SET state = 'refused', decided_at = ? WHERE group_id = ?`).run(isoAt(this.now()), groupId);
    const failed: string[] = [];
    try { await this.options.api.quitGroup?.(groupId); } catch (error) { failed.push('退出'); this.log(`a group could not be left (${describe(error)})`); }
    try { await this.options.api.block?.(groupId); } catch (error) { failed.push('ブロック'); this.log(`a group could not be blocked (${describe(error)})`); }
    const done = failed.length === 0 ? '退出してブロックしました' : `${failed.join('と')}に失敗しました。Signal のアプリで確かめてください`;
    await this.options.api.send(`→ ${why === '' ? '' : `${why}、`}『${row.title}』から${done}`);
  }

  /**
   * Records a group as waiting and asks the owner about it. The row comes first, so a send that fails after it was
   * delivered never asks again every minute: it is tried again on the next sweeps, a few times, and the day counts
   * from the first try. A group listed as one she is neither in nor invited to (she left it) is not asked about.
   */
  private async ask(groupId: string, adder: string | undefined, known?: ListedGroup): Promise<void> {
    if (this.standing(groupId)) return;
    const group = known ?? (await this.list()).find(candidate => candidate.id === groupId);
    if (group && group.isMember !== true && !this.invited(group)) return;
    const title = typeof group?.name === 'string' && group.name.trim() !== '' ? oneLine(group.name) : '名前のないグループ';
    const invited = group !== undefined && group.isMember !== true;
    const members = Array.isArray(group?.members) ? `（メンバー ${group.members.length} 人）` : '';
    const who = adder === undefined ? '誰か' : `${adder}さん`;
    const question = [
      `${who}が Signal のグループ『${title}』${members}に${this.options.selfName}を${invited ? '招待' : '追加'}しました。参加しますか？`,
      '👍 で参加、👎 で退出してブロック（引用して「参加」「見送る」でも）。24 時間答えがなければ退出してブロックします。',
    ].join('\n');
    const name = `g-${createHash('sha256').update(groupId).digest('hex').slice(0, 8)}`;
    this.options.db.prepare(`INSERT INTO fork_signal_groups (group_id, name, title, state, asked_at, question) VALUES (?, ?, ?, 'pending', ?, ?)`)
      .run(groupId, name, title, isoAt(this.now()), question);
    await this.send(this.row(groupId)!);
  }

  /** Sends a waiting group's question, once it is sent no more. */
  private async send(row: GroupRow): Promise<void> {
    if (row.asked_ts !== null) return;
    this.options.db.prepare('UPDATE fork_signal_groups SET tries = tries + 1 WHERE group_id = ?').run(row.group_id);
    try {
      const sentAt = await this.options.api.send(row.question);
      this.options.db.prepare('UPDATE fork_signal_groups SET asked_ts = ? WHERE group_id = ?').run(sentAt, row.group_id);
    } catch (error) {
      this.log(`a question about a group could not be sent (${describe(error)}); it is tried again on the next sweep`);
    }
  }

  /** Whether her own account is among a group's pending members: she is invited. */
  private invited(group: ListedGroup): boolean {
    return objects<{ number?: unknown }>(group.pendingMembers).some(member => member.number === this.options.account);
  }

  private standing(groupId: string): Standing | undefined {
    const name = this.configured.get(groupId);
    if (name !== undefined) return { state: 'approved', name, title: this.titles.get(groupId) ?? name };
    const row = this.row(groupId);
    return row && { state: row.state, name: row.name, title: row.title };
  }

  /** `INDEX.md`: each approved group's directory and its name in Signal, which may change and is not a directory. */
  private async writeIndex(): Promise<void> {
    const approved = this.options.db.prepare(`SELECT group_id, name, title FROM fork_signal_groups WHERE state = 'approved'`).all() as
      { group_id: string; name: string; title: string }[];
    const rows = [...approved.filter(row => !this.configured.has(row.group_id)),
      ...[...this.configured].map(([id, name]) => ({ name, title: this.titles.get(id) ?? '' }))].sort((a, b) => a.name.localeCompare(b.name));
    const lines = ['# Signal のグループ', '', '参加しているグループの記録のディレクトリと、Signal でのグループ名です。読み方は /manual/signal.md にあります。', ''];
    if (rows.length === 0) lines.push('まだ参加しているグループはありません。');
    else lines.push('| ディレクトリ | グループ名 |', '| --- | --- |', ...rows.map(row => `| ${SIGNAL_PATH}/${row.name} | ${row.title.replaceAll('|', '\\|')} |`));
    await mkdir(this.options.directory, { recursive: true, mode: 0o750 });
    await writeFileAtomically(join(this.options.directory, 'INDEX.md'), `${lines.join('\n')}\n`, FILE_MODE);
  }

  private async list(): Promise<ListedGroup[]> {
    try {
      const listed = await this.options.api.listGroups?.() ?? [];
      if (this.listing === 'failing') this.log('the groups can be listed again');
      this.listing = 'ok';
      return listed;
    } catch (error) {
      if (this.listing === 'ok') this.log(`the groups could not be listed (${describe(error)}); tried again every minute`);
      this.listing = 'failing';
      return [];
    }
  }

  // The dove's side (ADR F07).

  resolve(to: DoveTarget): { ok: true; target: ResolvedTarget } | { ok: false; text: string } {
    const refuse = (text: string) => ({ ok: false as const, text });
    const where = `to.file には、${SIGNAL_PATH} の下のグループのディレクトリ（例: ${SIGNAL_PATH}/iori-test）か、`
      + `その中の日付のファイル（例: ${SIGNAL_PATH}/iori-test/2026-10-25.jsonl）を書いてください。`;
    const parts = to.file.slice(SIGNAL_PATH.length + 1).replace(/\/+$/, '').split('/');
    if (parts.some(part => part === '' || part === '.' || part === '..')) return refuse(`to.file「${to.file}」が読めません。${where}`);
    const day = parts.length === 2 && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(parts[1]!) ? parts[1]!.slice(0, -'.jsonl'.length) : undefined;
    if (parts.length !== 1 && !day) return refuse(`to.file「${to.file}」は、グループのディレクトリでも日付のファイルでもありません。${where}`);
    const groupId = this.groupNamed(parts[0]!);
    if (!groupId) return refuse(`${SIGNAL_PATH}/${parts[0]!} は、参加しているグループではありません。${SIGNAL_PATH}/INDEX.md にあるディレクトリを書いてください。`);
    if (!day) {
      if (to.path !== undefined) return refuse(`グループのディレクトリに path は付けません。発言に返すなら、to.file にその発言のある日のファイルを書いてください。`);
      return { ok: true, target: this.target(groupId, null) };
    }
    if (to.path === undefined) return refuse(`発言に返すなら、to.path にその行の場所（例: ".[3]"）を書いてください。グループそのものに投稿するなら、to.file にグループのディレクトリを書きます。`);
    const index = Number(/^\.\[(\d+)\]$/.exec(to.path)?.[1] ?? Number.NaN);
    const row = this.options.db.prepare('SELECT * FROM fork_signal_lines WHERE group_id = ? AND file_date = ? AND line = ?')
      .get(groupId, day, index) as LineRow | undefined;
    if (!row) return refuse(`${to.file} に ${to.path} の行はありません。行の番号は 0 から数えます。ファイルの行か、出来事の attention の file と path を、そのまま写してください。`);
    return { ok: true, target: this.target(groupId, lineKey(row.sent_ts, row.author)) };
  }

  target(groupId: string, ts: string | null): ResolvedTarget {
    const label = `Signal のグループ『${this.standing(groupId)?.title ?? '?'}』`;
    const row = ts === null ? undefined : this.lineAt(groupId, ts);
    return { workspace: SIGNAL_GROUPS, channelId: groupId, label,
      ...(ts !== null ? { message: { ts, speaker: row?.speaker ?? 'someone', at: row?.at ?? '', text: row?.text ?? '' } } : {}) };
  }

  flows(target: ResolvedTarget, messages: number, chars: number): { now: string; channel: Flow; thread: Flow | null } {
    const rows = (this.options.db.prepare(`SELECT speaker, at, text FROM fork_signal_lines WHERE group_id = ? ORDER BY sent_ts DESC, rowid DESC LIMIT ?`)
      .all(target.channelId, messages) as { speaker: string; at: string; text: string }[]).reverse();
    return { now: this.at(this.now()), channel: { last_at: rows.at(-1)?.at ?? null, messages: rows.map(row => ({ from: row.speaker, at: row.at,
      text: cut(row.text, chars) })) }, thread: null };
  }

  lineOf(groupId: string, ts: string): MessageLine | undefined {
    const row = this.lineAt(groupId, ts);
    const name = this.standing(groupId)?.name;
    return row && name ? { file: `${SIGNAL_PATH}/${name}/${row.file_date}.jsonl`, path: `.[${row.line}]` } : undefined;
  }

  isEmoji(emoji: string): boolean {
    const segments = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(emoji)];
    // A keycap (1️⃣, #️⃣) is a digit or sign with U+20E3.
    return segments.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(emoji) && !/[\s:]/u.test(emoji);
  }

  async post(groupId: string, text: string, options: { quote?: string; attachments?: string[] }): Promise<string> {
    const standing = this.standing(groupId);
    if (standing?.state !== 'approved' || !this.options.api.sendGroup) throw new Error('not an approved group');
    const quoted = options.quote === undefined ? undefined : this.lineAt(groupId, options.quote);
    const ms = await this.options.api.sendGroup(groupId, text, { ...(quoted ? { quote: { timestamp: quoted.sent_ts, author: quoted.author, text: quoted.text } } : {}),
      ...(options.attachments?.length ? { attachments: options.attachments } : {}) });
    const images = options.attachments?.length ?? 0;
    const entry = { at: this.at(ms), from: this.options.selfName, mine: true, text,
      ...(quoted ? { quote: { from: quoted.speaker, text: cut(oneLine(quoted.text), QUOTE_CHARS) } } : {}),
      ...(images > 0 ? { attachments: [`画像 ${images} 枚`] } : {}) };
    // It was sent whatever comes of this.
    this.lastOwn.set(standing.name, ms);
    const run = this.writing.then(() => this.append(standing.name, localDate(ms, this.options.timeZone), entry, undefined,
      { groupId, ts: ms, author: this.options.account }, 'hers'));
    this.writing = run.catch(() => undefined);
    await run.catch(() => { this.log('her own group message could not be written'); });
    return lineKey(ms, this.options.account);
  }

  async putReaction(groupId: string, ts: string, emoji: string): Promise<void> {
    const row = this.lineAt(groupId, ts);
    if (this.standing(groupId)?.state !== 'approved' || !row || !this.options.api.reactInGroup) throw new Error('not an approved group or line');
    await this.options.api.reactInGroup(groupId, emoji, { timestamp: row.sent_ts, author: row.author });
  }

  /** An approved group's ID by its directory. */
  private groupNamed(name: string): string | undefined {
    for (const [id, configured] of this.configured) if (configured === name) return id;
    const row = this.options.db.prepare(`SELECT group_id FROM fork_signal_groups WHERE name = ? AND state = 'approved'`).get(name) as
      { group_id: string } | undefined;
    return row && !this.configured.has(row.group_id) ? row.group_id : undefined;
  }

  /** A line by its key, `<Signal timestamp>:<author>`: two people may send in the same millisecond, one person never. */
  private lineAt(groupId: string, key: string): LineRow | undefined {
    const at = key.indexOf(':');
    return this.options.db.prepare('SELECT * FROM fork_signal_lines WHERE group_id = ? AND sent_ts = ? AND author = ? ORDER BY rowid LIMIT 1')
      .get(groupId, Number(key.slice(0, at)), key.slice(at + 1)) as LineRow | undefined;
  }

  /** A time as a line writes it: local date and time to the second. */
  private at(ms: number): string {
    return `${localDateTime(ms, this.options.timeZone)}:${String(new Date(ms).getUTCSeconds()).padStart(2, '0')}`;
  }

  private row(groupId: string): GroupRow | undefined {
    return this.options.db.prepare('SELECT * FROM fork_signal_groups WHERE group_id = ?').get(groupId) as GroupRow | undefined;
  }

  private asked(sentAt: number): GroupRow | undefined {
    return this.options.db.prepare(`SELECT * FROM fork_signal_groups WHERE asked_ts = ?`).get(sentAt) as GroupRow | undefined;
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(work).catch(error => { this.log(`a group could not be asked about or left (${describe(error)})`); });
    return this.chain;
  }

  /** Makes the directory natsumi sees and its index, so an empty source still shows. */
  prepare(): Promise<void> { return this.writeIndex(); }

  /**
   * A message in a group. One from a group not known yet asks the owner about it (named after its sender when it is
   * the update that added her); one from a group not approved, or with nothing to read (a reaction, a group update), is
   * let go. Writes go one at a time, so a line's place is what the file held before it.
   */
  handle(envelope: GroupEnvelope): Promise<void> {
    const message = envelope.dataMessage;
    const groupId = message?.groupInfo?.groupId;
    if (!message || typeof groupId !== 'string') return Promise.resolve();
    const from = typeof envelope.sourceName === 'string' && envelope.sourceName.trim() !== '' ? oneLine(envelope.sourceName) : 'someone';
    const standing = this.standing(groupId);
    if (!standing) {
      const adder = message.groupInfo?.type === 'UPDATE' && from !== 'someone' ? from : undefined;
      return this.enqueue(() => this.ask(groupId, adder));
    }
    if (standing.state !== 'approved') return Promise.resolve();
    const group = standing.name;
    for (const key of [envelope.sourceNumber, envelope.sourceUuid]) if (typeof key === 'string' && from !== 'someone') this.names.set(key, from);
    const raw = typeof message.message === 'string' ? message.message : '';
    const attachments = objects<{ contentType?: unknown; filename?: unknown; size?: unknown }>(message.attachments).map(noted);
    if (raw.trim() === '' && attachments.length === 0) return Promise.resolve();
    const mentions = objects<Mention>(message.mentions);
    const mentioned = mentions.some(mention => this.isMe(mention.number));
    const quote = typeof message.quote === 'object' && message.quote !== null ? message.quote : undefined;
    const quotedMe = quote !== undefined && this.isMe(quote.authorNumber);
    const sentAt = typeof message.timestamp === 'number' ? message.timestamp : typeof envelope.timestamp === 'number' ? envelope.timestamp : undefined;
    const ms = sentAt ?? this.now();
    const quoted = quote && typeof quote.text === 'string' ? {
      from: quotedMe ? this.options.selfName : this.nameOf(quote.authorNumber, quote.authorUuid), text: cut(oneLine(quote.text), QUOTE_CHARS),
      ...(quotedMe ? { mine: true } : {}) } : undefined;
    const entry = {
      at: this.at(ms), from, text: this.withNames(raw, mentions), ...(quoted ? { quote: quoted } : {}), ...(attachments.length > 0 ? { attachments } : {}),
    };
    const author = typeof envelope.sourceNumber === 'string' ? envelope.sourceNumber : typeof envelope.sourceUuid === 'string' ? envelope.sourceUuid : '';
    // Read, as the owner's messages are (F04): a read receipt to whoever sent it.
    if (author !== '' && author !== this.options.account && sentAt !== undefined) {
      this.options.api.receipt?.(author, sentAt).catch(error => { this.log(`a read receipt could not be sent (${describeSignalFailure(error)})`); });
    }
    // Most for her first. A name without a mention, and what follows her own post, are hers to judge (ADR F07); none of
    // those for what is old (a backlog after the stream comes back), nor a burst of them.
    const age = this.now() - ms;
    const fresh = age <= this.timing.staleMs;
    const own = this.lastOwn.get(group);
    const last = this.attended.get(group);
    const lastPlace = this.lastPlace.get(group);
    const burst = this.options.isOpen
      ? lastPlace !== undefined && (() => { try { return this.options.isOpen!(lastPlace); } catch { return false; } })()
      : last !== undefined && this.now() - last < this.timing.burstMs;
    const kind = (mentioned || quotedMe) && age <= this.timing.staleMentionMs ? mentioned ? 'mention' : 'quote-reply'
      : !fresh || burst ? undefined
        : this.calls(raw) ? 'name'
          : own !== undefined && ms >= own - CLOCK_SKEW_MS && ms - own <= this.timing.followUpMs ? 'follow-up' : undefined;
    const run = this.writing.then(() => this.append(group, localDate(ms, this.options.timeZone), entry, kind, { groupId, ts: ms, author },
      fresh ? 'heard' : 'old'));
    this.writing = run.catch(() => undefined);
    return run.catch(() => { this.log('a group message could not be written'); });
  }

  private async append(group: string, date: string, entry: { at: string; from: string; text: string }, kind: string | undefined,
    sent: { groupId: string; ts: number; author: string }, heard: 'heard' | 'old' | 'hers'): Promise<void> {
    const directory = join(this.options.directory, group);
    const path = join(directory, `${date}.jsonl`);
    await mkdir(directory, { recursive: true, mode: 0o750 });
    let before = '';
    try { before = await readFile(path, 'utf8'); } catch { /* the day's first line */ }
    const index = before.split('\n').filter(Boolean).length;
    await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: FILE_MODE });
    this.options.db.prepare(`INSERT OR REPLACE INTO fork_signal_lines (group_id, file_date, line, sent_ts, author, speaker, at, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(sent.groupId, date, index, sent.ts, sent.author, entry.from, entry.at, entry.text);
    const place = { file: `${SIGNAL_PATH}/${group}/${date}.jsonl`, path: `.[${index}]` };
    // Her own post, or a message from a backlog: no wait for the talk to settle. Her post is the talk answered.
    const order = this.orderOf(group);
    if (heard !== 'old' && heard !== 'hers') { this.latest.set(group, place); order.line = ++this.step; }
    if (heard === 'hers') order.own = ++this.step;
    clearTimeout(this.settling.get(group));
    this.settling.delete(group);
    if (heard === 'hers') this.options.typing?.posted(sent.groupId);
    if (kind) {
      order.attention = ++this.step;
      this.lastPlace.set(group, place);
      if (heard === 'heard') this.attended.set(group, this.now());
      this.options.attention?.({ source: SIGNAL_SOURCE, kind, ...place });
      // Not for an old one from a backlog: she may well have nothing to say to it now.
      if (heard === 'heard') this.options.typing?.start(sent.groupId, place);
    }
    if (heard !== 'heard' || kind) return;
    // Talk that raised nothing: once it settles, she is told of it once, to read the room (`conversation`).
    this.settle(group, this.timing.quietMs);
  }

  private settle(group: string, waitMs: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => { this.settling.delete(group); this.converse(group); }, waitMs);
    timer.unref();
    this.settling.set(group, timer);
  }

  private orderOf(group: string): { line: number; attention: number; own: number } {
    let order = this.order.get(group);
    if (!order) this.order.set(group, order = { line: 0, attention: 0, own: 0 });
    return order;
  }

  /** The talk in a group settled: one `conversation` attention on its latest line, unless too soon (the people talking are awake, whatever the owner's hours). */
  private converse(group: string): void {
    const now = this.now();
    const place = this.latest.get(group);
    const order = this.orderOf(group);
    // An attention or her own post since its latest line covered it: nothing to tell.
    if (!place || order.attention > order.line || order.own > order.line) return;
    // Too soon after another attention or her own post (which holds back no name or follow-up): told when the window
    // ends instead, looked at again then.
    const last = Math.max(this.attended.get(group) ?? 0, this.lastOwn.get(group) ?? 0);
    const wait = last + this.timing.conversationEveryMs - now;
    if (wait > 0) { this.settle(group, wait); return; }
    this.attended.set(group, now);
    order.attention = ++this.step;
    this.lastPlace.set(group, place);
    this.options.attention?.({ source: SIGNAL_SOURCE, kind: 'conversation', ...place });
  }

  /** Whether a text names her, by any name she answers to. */
  private calls(text: string): boolean {
    const plain = normal(text);
    return this.callNames.some(name => plain.includes(name));
  }

  /** Drops the waits for talk to settle, as the server stops; none is started after. */
  stop(): void {
    this.stopped = true;
    for (const timer of this.settling.values()) clearTimeout(timer);
    this.settling.clear();
  }

  /** ponytail: by her number only, as signal-cli fills it in for its own account; add her UUID if one ever comes without it. */
  private isMe(number: unknown): boolean {
    return number === this.options.account;
  }

  private nameOf(number: unknown, uuid: unknown): string {
    return (typeof uuid === 'string' ? this.names.get(uuid) : undefined) ?? (typeof number === 'string' ? this.names.get(number) : undefined) ?? 'someone';
  }

  /** The text with each mention's mark written as `@name`, from the end so the earlier places stay where they are. */
  private withNames(text: string, mentions: Mention[]): string {
    let out = text;
    const placed = mentions.filter(mention => typeof mention.start === 'number' && typeof mention.length === 'number')
      .sort((a, b) => (b.start as number) - (a.start as number));
    for (const mention of placed) {
      const start = mention.start as number;
      const end = start + (mention.length as number);
      if (out.slice(start, end) !== MENTION_MARK) continue;
      const name = this.isMe(mention.number) ? this.options.selfName : this.nameOf(mention.number, mention.uuid);
      out = `${out.slice(0, start)}@${name}${out.slice(end)}`;
    }
    return out;
  }

  private log(line: string): void { this.options.log?.(`signal: ${line}`); }
}

/** An attachment as a line: its name, type and size. It is not fetched. */
function noted(attachment: { contentType?: unknown; filename?: unknown; size?: unknown }): string {
  const name = typeof attachment.filename === 'string' && attachment.filename !== '' ? oneLine(attachment.filename) : '名前なし';
  const facts = [
    ...typeof attachment.contentType === 'string' ? [oneLine(attachment.contentType)] : [],
    ...typeof attachment.size === 'number' ? [attachment.size >= 1024 * 1024 ? `${(attachment.size / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(attachment.size / 1024))} KB`] : [],
  ];
  return facts.length > 0 ? `${name} (${facts.join(', ')})` : name;
}

/**
 * Fork (ADR F07): whether an event that came after the last answer of the agents asked at or after `since` is over:
 * the turn that read the answer ended, whatever came of it. For the group's "typing…".
 */
export function followedUpSince(db: DatabaseSync, since: string): boolean {
  return db.prepare(`SELECT 1 FROM loop_events WHERE state IN ('replied', 'no-reply', 'failed') AND created_at >=
    (SELECT MAX(updated_at) FROM agent_tasks WHERE sent_at >= ? AND state <> 'waiting') LIMIT 1`).get(since) !== undefined;
}

/** What the dove keeps for a line (as `target_ts`): its Signal timestamp and its author, which only the server sees. */
function lineKey(ts: number, author: string): string { return `${ts}:${author}`; }

/** A group as signal-cli's listGroups shows it, as far as asking about it needs. */
export interface ListedGroup { id?: unknown; name?: unknown; isMember?: unknown; isBlocked?: unknown; members?: unknown[]; pendingMembers?: unknown[] }

/** The objects of a list from the daemon; anything else in it (null, a string) is left out, as is a list that is not one. */
export function objects<T extends object>(list: unknown): T[] {
  return Array.isArray(list) ? list.filter((item): item is T => typeof item === 'object' && item !== null) : [];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

/** A text as names are matched in it: NFKC and lower case. */
function normal(text: string): string { return text.normalize('NFKC').toLowerCase(); }

function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

function cut(text: string, max: number): string {
  const characters = [...text];
  return characters.length > max ? `${characters.slice(0, max).join('')}…` : text;
}
