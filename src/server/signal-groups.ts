import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isoAt, localDate, localDateTime } from './nightly.ts';
import { writeFileAtomically } from './paths.ts';
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
 * is approved nothing from it is written, said or answered. The groups in the config are approved from the start. Each
 * group's state is kept in a table of this fork's own, made here, as F02 and F04 do.
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
    quote?: { authorNumber?: unknown; authorUuid?: unknown; text?: unknown };
    attachments?: { contentType?: unknown; filename?: unknown; size?: unknown }[];
  };
}

/** How long a group waits for the owner's answer before she leaves it. */
export const GROUP_ANSWER_MS = 24 * 60 * 60 * 1000;

export interface SignalGroupsOptions {
  db: DatabaseSync;
  /** Asks the owner, and leaves, blocks or joins a group: the daemon's SignalApi (signal.ts), which imports this. */
  api: {
    send(message: string): Promise<number>;
    listGroups?(): Promise<ListedGroup[]>;
    quitGroup?(groupId: string): Promise<void>;
    block?(groupId: string): Promise<void>;
    acceptGroup?(groupId: string): Promise<void>;
  };
  /** `sources/signal` in the data directory. */
  directory: string;
  /** Directory name → group ID (base64), from the config: approved from the start, under that name. */
  groups: Readonly<Record<string, string>>;
  /** The number natsumi is registered as: a mention or quote of it is for her. */
  account: string;
  /** Her name, written where a message mentions her. */
  selfName: string;
  timeZone: string;
  attention?: (attention: Attention) => void;
  now?: () => number;
  log?: (line: string) => void;
}

interface GroupRow { group_id: string; name: string; title: string; state: 'pending' | 'approved' | 'refused'; invited: number; asked_at: string | null }

export class SignalGroups {
  private readonly options: SignalGroupsOptions;
  private readonly now: () => number;
  /** Asking, joining and leaving go one at a time, so a group is never asked about twice. */
  private chain: Promise<void> = Promise.resolve();
  /** The profile names seen, by number and by UUID, so a mention can be written as a name. ponytail: in memory only. */
  private readonly names = new Map<string, string>();
  private writing: Promise<unknown> = Promise.resolve();

  constructor(options: SignalGroupsOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    options.db.exec(`CREATE TABLE IF NOT EXISTS fork_signal_groups (
      group_id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'refused')),
      invited INTEGER NOT NULL DEFAULT 0,
      asked_at TEXT,
      asked_ts INTEGER UNIQUE,
      decided_at TEXT
    ) STRICT`);
    const approve = options.db.prepare(`INSERT INTO fork_signal_groups (group_id, name, state, decided_at) VALUES (?, ?, 'approved', ?)
      ON CONFLICT (group_id) DO UPDATE SET name = excluded.name, state = 'approved'`);
    for (const [name, id] of Object.entries(options.groups)) approve.run(id, name, isoAt(this.now()));
  }

  /**
   * The groups signal-cli says she is in or invited to: any not known yet is asked about. A blocked one is left alone.
   * ponytail: a group she was removed from looks like an invitation (isMember false) and is asked about too; read
   * pendingMembers if that turns up.
   */
  sync(): Promise<void> {
    return this.enqueue(async () => {
      const retitle = this.options.db.prepare(`UPDATE fork_signal_groups SET title = ? WHERE group_id = ?`);
      for (const group of await this.list()) {
        if (typeof group.id !== 'string') continue;
        if (this.row(group.id)) { if (typeof group.name === 'string') retitle.run(oneLine(group.name), group.id); }
        else if (group.isBlocked !== true) await this.ask(group.id, undefined, group);
      }
      await this.writeIndex();
    });
  }

  /** The approvals the owner did not answer within a day: she leaves those groups and blocks them. */
  expire(): Promise<void> {
    const before = isoAt(this.now() - GROUP_ANSWER_MS);
    const late = this.options.db.prepare(`SELECT group_id FROM fork_signal_groups WHERE state = 'pending' AND asked_at <= ?`).all(before) as { group_id: string }[];
    return this.enqueue(async () => { for (const { group_id } of late) await this.refuse(group_id, '24 時間答えがなかったので'); });
  }

  /** A reaction by the owner. True when it is on a group's question, so it is not also said to natsumi. */
  react(sentAt: number, emoji: string): boolean {
    const row = this.asked(sentAt);
    if (!row) return false;
    const decision = emoji.startsWith('👍') ? 'approve' : emoji.startsWith('👎') || emoji === '❌' ? 'refuse' : undefined;
    if (decision) this.decide(row, decision);
    return true;
  }

  /** A quoted reply. True when it answered a group's question. */
  answer(quotedAt: number, text: string): boolean {
    const row = this.asked(quotedAt);
    const word = text.trim().toLowerCase();
    const decision = word === '参加' || word === 'ok' ? 'approve' : word === '見送る' || word === 'no' ? 'refuse' : undefined;
    if (!row || !decision) return false;
    this.decide(row, decision);
    return true;
  }

  /** Waits for the asking, joining and leaving started so far. */
  async idle(): Promise<void> {
    let current: Promise<void>;
    do { current = this.chain; await current; } while (current !== this.chain);
  }

  private decide(row: GroupRow, decision: 'approve' | 'refuse'): void {
    void this.enqueue(async () => {
      if (this.row(row.group_id)?.state !== 'pending') return;
      if (decision === 'refuse') { await this.refuse(row.group_id, ''); return; }
      this.options.db.prepare(`UPDATE fork_signal_groups SET state = 'approved', decided_at = ? WHERE group_id = ?`).run(isoAt(this.now()), row.group_id);
      let joined = '';
      if (row.invited) {
        try { await this.options.api.acceptGroup?.(row.group_id); } catch (error) {
          this.log(`an invitation could not be accepted (${describe(error)})`);
          joined = '。ただし招待を受けられませんでした。Signal のアプリで確かめてください';
        }
      }
      await this.writeIndex();
      await this.options.api.send(`→ 参加しました: 『${row.title}』。${SIGNAL_PATH}/${row.name} に記録します${joined}`);
    });
  }

  /** `INDEX.md`: each approved group's directory and its name in Signal, which may change and is not a directory. */
  private async writeIndex(): Promise<void> {
    const rows = this.options.db.prepare(`SELECT name, title FROM fork_signal_groups WHERE state = 'approved' ORDER BY name`).all() as
      { name: string; title: string }[];
    const lines = ['# Signal のグループ', '', '参加しているグループの記録のディレクトリと、Signal でのグループ名です。読み方は /manual/signal.md にあります。', ''];
    if (rows.length === 0) lines.push('まだ参加しているグループはありません。');
    else lines.push('| ディレクトリ | グループ名 |', '| --- | --- |', ...rows.map(row => `| ${SIGNAL_PATH}/${row.name} | ${row.title.replaceAll('|', '\\|')} |`));
    await mkdir(this.options.directory, { recursive: true, mode: 0o750 });
    await writeFileAtomically(join(this.options.directory, 'INDEX.md'), `${lines.join('\n')}\n`, FILE_MODE);
  }

  /** Leaves and blocks a group, records it as refused, and tells the owner what came of it. */
  private async refuse(groupId: string, why: string): Promise<void> {
    const row = this.row(groupId);
    if (!row || row.state !== 'pending') return;
    this.options.db.prepare(`UPDATE fork_signal_groups SET state = 'refused', decided_at = ? WHERE group_id = ?`).run(isoAt(this.now()), groupId);
    const failed: string[] = [];
    try { await this.options.api.quitGroup?.(groupId); } catch (error) { failed.push('退出'); this.log(`a group could not be left (${describe(error)})`); }
    try { await this.options.api.block?.(groupId); } catch (error) { failed.push('ブロック'); this.log(`a group could not be blocked (${describe(error)})`); }
    const done = failed.length === 0 ? '退出してブロックしました' : `${failed.join('と')}に失敗しました。Signal のアプリで確かめてください`;
    await this.options.api.send(`→ ${why === '' ? '' : `${why}、`}『${row.title}』から${done}`);
  }

  /** Asks the owner about a group once, and records it as waiting. */
  private async ask(groupId: string, adder: string | undefined, known?: ListedGroup): Promise<void> {
    if (this.row(groupId)) return;
    const group = known ?? (await this.list()).find(candidate => candidate.id === groupId);
    const title = typeof group?.name === 'string' && group.name.trim() !== '' ? oneLine(group.name) : '名前のないグループ';
    const invited = group?.isMember === false;
    const members = Array.isArray(group?.members) ? `（メンバー ${group.members.length} 人）` : '';
    const who = adder === undefined ? '誰か' : `${adder}さん`;
    const sentAt = await this.options.api.send([
      `${who}が Signal のグループ『${title}』${members}に${this.options.selfName}を${invited ? '招待' : '追加'}しました。参加しますか？`,
      '👍 で参加、👎 で退出してブロック（引用して「参加」「見送る」でも）。24 時間答えがなければ退出してブロックします。',
    ].join('\n'));
    const name = `g-${createHash('sha256').update(groupId).digest('hex').slice(0, 8)}`;
    this.options.db.prepare(`INSERT INTO fork_signal_groups (group_id, name, title, state, invited, asked_at, asked_ts)
      VALUES (?, ?, ?, 'pending', ?, ?, ?)`).run(groupId, name, title, invited ? 1 : 0, isoAt(this.now()), sentAt);
  }

  private async list(): Promise<ListedGroup[]> {
    try { return await this.options.api.listGroups?.() ?? []; } catch (error) {
      this.log(`the groups could not be listed (${describe(error)})`);
      return [];
    }
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
    const row = this.row(groupId);
    if (!row) {
      const adder = message.groupInfo?.type === 'UPDATE' && from !== 'someone' ? from : undefined;
      return this.enqueue(() => this.ask(groupId, adder));
    }
    if (row.state !== 'approved') return Promise.resolve();
    const group = row.name;
    for (const key of [envelope.sourceNumber, envelope.sourceUuid]) if (typeof key === 'string' && from !== 'someone') this.names.set(key, from);
    const raw = typeof message.message === 'string' ? message.message : '';
    const attachments = (Array.isArray(message.attachments) ? message.attachments : []).map(noted);
    if (raw.trim() === '' && attachments.length === 0) return Promise.resolve();
    const mentions = Array.isArray(message.mentions) ? message.mentions : [];
    const mentioned = mentions.some(mention => this.isMe(mention.number));
    const quote = message.quote;
    const quotedMe = quote !== undefined && this.isMe(quote.authorNumber);
    const ms = typeof message.timestamp === 'number' ? message.timestamp : typeof envelope.timestamp === 'number' ? envelope.timestamp : Date.now();
    const quoted = quote && typeof quote.text === 'string' ? {
      from: quotedMe ? this.options.selfName : this.nameOf(quote.authorNumber, quote.authorUuid), text: cut(oneLine(quote.text), QUOTE_CHARS),
      ...(quotedMe ? { mine: true } : {}) } : undefined;
    const entry = {
      at: `${localDateTime(ms, this.options.timeZone)}:${String(new Date(ms).getUTCSeconds()).padStart(2, '0')}`, from,
      text: this.withNames(raw, mentions), ...(quoted ? { quote: quoted } : {}), ...(attachments.length > 0 ? { attachments } : {}),
    };
    const run = this.writing.then(() => this.append(group, localDate(ms, this.options.timeZone), entry, mentioned ? 'mention' : quotedMe ? 'quote-reply' : undefined));
    this.writing = run.catch(() => undefined);
    return run.catch(() => { this.log('a group message could not be written'); });
  }

  private async append(group: string, date: string, entry: Record<string, unknown>, kind: string | undefined): Promise<void> {
    const directory = join(this.options.directory, group);
    const path = join(directory, `${date}.jsonl`);
    await mkdir(directory, { recursive: true, mode: 0o750 });
    let before = '';
    try { before = await readFile(path, 'utf8'); } catch { /* the day's first line */ }
    const index = before.split('\n').filter(Boolean).length;
    await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: FILE_MODE });
    if (kind) this.options.attention?.({ source: SIGNAL_SOURCE, kind, file: `${SIGNAL_PATH}/${group}/${date}.jsonl`, path: `.[${index}]` });
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

/** A group as signal-cli's listGroups shows it, as far as asking about it needs. */
export interface ListedGroup { id?: unknown; name?: unknown; isMember?: unknown; isBlocked?: unknown; members?: unknown[] }

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

function cut(text: string, max: number): string {
  const characters = [...text];
  return characters.length > max ? `${characters.slice(0, max).join('')}…` : text;
}
