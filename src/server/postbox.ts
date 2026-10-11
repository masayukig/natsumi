import type { DatabaseSync } from 'node:sqlite';
import { parse as parseYaml } from 'yaml';
import { lastRun, nextRun, parseCron, type Cron } from './cron.ts';
import { instant, isoAt, localIso, localParts } from './nightly.ts';
import { checkOutgoingText, MAX_OUTPUT_CHARS } from './output-checks.ts';

/**
 * The postbox (ADR 0076): letters natsumi or the owner commits to memory's `postbox/`, each a request to an outside
 * agent on a cron, which the server sends at its time with no turn of hers. The server reads only what HEAD holds, so
 * a letter is whatever passed her turn's check, or whatever the owner committed; the owner's are checked as they are
 * read, and one that fails is passed over and told.
 *
 * This file is the letters and their clock: the check, the record of each letter's runs, and the look that sends a run
 * once. The request itself, and what comes back, are `AgentRequests`'s, which tells the record here how a run went.
 */

/** Where the letters are in memory. */
export const POSTBOX_DIRECTORY = 'postbox';
export const POSTBOX_DEFAULTS = { enabled: true, minIntervalMinutes: 15 };
/** Failures or give-ups in a row that are told at once rather than as an ordinary update. */
export const POSTBOX_FAILURES_TOLD = 3;
/** How often the HEAD of memory is looked at for a commit the server did not make: the owner's, or the curator's. */
export const POSTBOX_HEAD_LOOK_MS = 60_000;

const MINUTE = 60_000;
/** A letter's name: its file name without `.md`. */
const LETTER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEYS = ['to', 'cron', 'paused', 'notify'];
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
/** Where natsumi reads who she can ask, as `ask_agent` names it. */
const AGENT_LIST_PATH = '/manual/agents/INDEX.md';

/** Whether a path of memory is in the postbox, or is the postbox itself. */
export function inPostbox(path: string): boolean {
  return path === POSTBOX_DIRECTORY || path.startsWith(`${POSTBOX_DIRECTORY}/`);
}

export type LetterNotify = 'update' | 'attention';

/** A letter as it is sent. */
export interface Letter {
  name: string;
  to: string;
  cron: Cron;
  paused: boolean;
  notify: LetterNotify;
  /** The request, as the agent is given it. */
  body: string;
}

/** What a letter is checked against: the agents of the config, the shortest gap between runs, and the owner's clock. */
export interface LetterRules {
  agents: readonly string[];
  minIntervalMinutes: number;
  timeZone: string;
}

export type LetterCheck = { ok: true; letter: Letter } | { ok: false; reason: string };

/** A letter's name by its path: `postbox/morning-news.md` is `morning-news`, and anything else its path below the postbox. */
export function letterName(path: string): string {
  const rest = path.startsWith(`${POSTBOX_DIRECTORY}/`) ? path.slice(POSTBOX_DIRECTORY.length + 1) : path;
  return rest.endsWith('.md') ? rest.slice(0, -'.md'.length) : rest;
}

/**
 * Whether a file of the postbox is a letter the server can send, and the letter, or why not in one sentence: the same
 * check for her writes, which go back when they fail (ADR 0018), and for the owner's commits, which are passed over.
 */
export function checkLetter(path: string, text: string, rules: LetterRules & { now: number }): LetterCheck {
  const fail = (reason: string): LetterCheck => ({ ok: false, reason });
  const rest = path.startsWith(`${POSTBOX_DIRECTORY}/`) ? path.slice(POSTBOX_DIRECTORY.length + 1) : '';
  if (rest === '' || rest.includes('/')) return fail(`定期便は ${POSTBOX_DIRECTORY}/ の直下に 1 通 1 ファイルで置きます（サブディレクトリは使えません）`);
  if (!rest.endsWith('.md')) return fail('定期便は .md のファイルです');
  const name = letterName(path);
  if (!LETTER_NAME.test(name)) return fail('ファイル名（定期便の名前）は小文字の英数字とハイフンで書きます（例: morning-news.md）');
  const match = FRONTMATTER.exec(text);
  if (!match) return fail('頭に frontmatter（--- の行で囲んだ YAML）が要ります。to と cron を書きます');
  let front: unknown;
  try { front = parseYaml(match[1]!); } catch {
    return fail('frontmatter を YAML として読めません（cron の式は "0 7 * * *" のように引用符で囲みます）');
  }
  if (typeof front !== 'object' || front === null || Array.isArray(front)) return fail('frontmatter は「項目: 値」の形で書きます');
  const fields = front as Record<string, unknown>;
  const unknown = Object.keys(fields).filter(key => !KEYS.includes(key));
  if (unknown.length > 0) return fail(`frontmatter に知らない項目があります（${unknown.join('、')}）。使えるのは to・cron・paused・notify です`);
  const { to, cron: cronText, paused = false, notify } = fields;
  if (typeof to !== 'string' || to.trim() === '') return fail('to に送る相手の名前を書きます');
  if (!rules.agents.includes(to)) return fail(`to の「${to}」は頼める相手にいません。相手と名前は ${AGENT_LIST_PATH} にあります`);
  if (typeof cronText !== 'string') return fail('cron に送る時刻を 5 項目の cron 式で書きます（例: "0 7 * * *"）');
  const parsed = parseCron(cronText);
  if (!parsed.ok) return fail(`cron の式を読めません。${parsed.reason}`);
  const gap = cronGapMinutes(parsed.cron, rules.timeZone, rules.now);
  if (gap === undefined) return fail(`cron "${parsed.cron.text}" に当てはまる時刻がありません`);
  if (gap < rules.minIntervalMinutes) {
    return fail(`cron "${parsed.cron.text}" の回の間隔が ${gap} 分で、下限の ${rules.minIntervalMinutes} 分より短いです`);
  }
  if (typeof paused !== 'boolean') return fail('paused は true か false で書きます');
  if (notify !== undefined && notify !== 'attention') return fail('notify は書くなら attention だけです（書かなければふつうの更新で知らせます）');
  const body = text.slice(match[0].length).trim();
  if (body === '') return fail('本文（相手に渡す依頼）が空です');
  const outgoing = checkOutgoingText(body);
  if (!outgoing.ok) {
    if (outgoing.reason === 'too-long') return fail(`本文が長すぎます（${MAX_OUTPUT_CHARS} 文字まで）`);
    return fail(`本文に送れない文字があります（${outgoing.found?.join(' ') ?? ''}）`);
  }
  return { ok: true, letter: { name, to, cron: parsed.cron, paused, notify: notify === 'attention' ? 'attention' : 'update', body } };
}

/**
 * The shortest gap between two runs of a cron, in minutes; undefined when it has no run at all. Within a day it is the
 * closest two times of the day; across days, the last run of each of the next eight run days to the first of the one
 * after, which covers a week whichever weekdays it runs on. One with a single run left has nothing to be close to.
 */
export function cronGapMinutes(cron: Cron, timeZone: string, from: number): number | undefined {
  let run = nextRun(cron, from, timeZone);
  if (run === undefined) return undefined;
  const times = cron.hours.flatMap(hour => cron.minutes.map(minute => hour * 60 + minute));
  let shortest = Number.MAX_SAFE_INTEGER;
  for (let i = 1; i < times.length; i += 1) shortest = Math.min(shortest, times[i]! - times[i - 1]!);
  const last = times.at(-1)!;
  for (let day = 0; day < 8; day += 1) {
    const date = localParts(run, timeZone);
    const end = instant(date.year, date.month, date.day, Math.floor(last / 60), last % 60, timeZone);
    const next = nextRun(cron, end, timeZone);
    if (next === undefined) break;
    shortest = Math.min(shortest, Math.round((next - end) / MINUTE));
    run = next;
  }
  return shortest;
}

/** The time of the last reply as a request carries it: ISO 8601 to the second in the owner's zone, and the zone's short name. */
export function receivedStamp(ms: number, timeZone: string): { iso: string; zone: string } {
  return { iso: localIso(Math.floor(ms / 1000) * 1000, timeZone), zone: zoneName(ms, timeZone) };
}

/** The line a request ends with: the contract with the agents of fraction-agents, and the same in every request. */
export function receivedLine(ms: number, timeZone: string): string {
  const { iso, zone } = receivedStamp(ms, timeZone);
  return `前回の受け取り: ${iso} (${zone})`;
}

/** The zone's short name (`JST`, `EDT`) where one is known, or its IANA name; never an offset such as `GMT+9`. */
function zoneName(ms: number, timeZone: string): string {
  for (const locale of ['en-US', 'ja-JP']) {
    const name = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' }).formatToParts(ms)
      .find(part => part.type === 'timeZoneName')?.value;
    if (name && /^[A-Z]{2,5}$/.test(name)) return name;
  }
  return timeZone;
}

/** How a run went, as the record keeps it. `waiting` is a request sent whose reply has not come. */
export type PostboxResult = 'waiting' | 'received' | 'empty' | 'failed' | 'gave-up' | 'input-required';

/** A letter as the dashboard shows it. Times are milliseconds. */
export interface LetterRecord {
  name: string;
  path: string;
  to?: string;
  cron?: string;
  paused: boolean;
  notify: LetterNotify;
  /** Why it is not sent, when it fails the check. */
  problem?: string;
  nextAt?: number;
  lastSentAt?: number;
  lastResult?: PostboxResult | 'skipped';
  lastResultAt?: number;
  /** Why the last run was passed over. */
  note?: string;
  failures: number;
  lastReceivedAt?: number;
}

interface LetterRow {
  name: string; path: string; agent: string | null; cron: string | null; paused: number; notify: LetterNotify; problem: string | null;
  due_at: string | null; last_run_at: string | null; last_sent_at: string | null; last_result: LetterRecord['lastResult'] | null;
  last_result_at: string | null; note: string | null; failures: number; last_received_at: string | null;
}

/** A file of `postbox/` as HEAD holds it: its text, or why it is not a file that can be read. */
export interface CommittedLetterFile { path: string; text?: string; problem?: string }

/** One file read from HEAD: the letter, or why it is passed over. */
export type ReadLetter = { path: string; name: string } & ({ letter: Letter } | { problem: string });

const ms = (iso: string | null) => iso === null ? undefined : Date.parse(iso);

/**
 * The record of each letter in SQLite (`postbox_letters`): as HEAD last held it, its next run, how its runs went, and
 * when the last one that went well was sent. Rows of the request itself, and the task it started, are `agent_tasks`'s.
 */
export class PostboxLedger {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number) {
    this.db = db;
    this.now = now;
  }

  /**
   * Makes the record the letters HEAD holds now: a new or changed one is due at its next run from now, one whose cron
   * and pause did not change keeps its run, and one gone from HEAD is forgotten. Returns the files whose problem is new
   * or changed, so each is told once.
   */
  sync(read: readonly ReadLetter[], timeZone: string): { path: string; problem: string }[] {
    const now = this.now();
    const iso = isoAt(now);
    const told: { path: string; problem: string }[] = [];
    const rows = new Map(this.rows().map(row => [row.name, row]));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of read) {
        const before = rows.get(entry.name);
        rows.delete(entry.name);
        if ('problem' in entry) {
          if (before?.problem !== entry.problem) told.push({ path: entry.path, problem: entry.problem });
          this.db.prepare(`INSERT INTO postbox_letters (name, path, problem, due_at, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)
            ON CONFLICT (name) DO UPDATE SET path = excluded.path, problem = excluded.problem, due_at = NULL, updated_at = excluded.updated_at`)
            .run(entry.name, entry.path, entry.problem, iso, iso);
          continue;
        }
        const { letter } = entry;
        const same = before && before.problem === null && before.cron === letter.cron.text && before.paused === Number(letter.paused)
          && before.due_at !== null;
        const next = nextRun(letter.cron, now, timeZone);
        const due = letter.paused ? null : same ? before.due_at : next === undefined ? null : isoAt(next);
        this.db.prepare(`INSERT INTO postbox_letters (name, path, agent, cron, paused, notify, problem, due_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
          ON CONFLICT (name) DO UPDATE SET path = excluded.path, agent = excluded.agent, cron = excluded.cron, paused = excluded.paused,
            notify = excluded.notify, problem = NULL, due_at = excluded.due_at, updated_at = excluded.updated_at`)
          .run(entry.name, entry.path, letter.to, letter.cron.text, Number(letter.paused), letter.notify, due, iso, iso);
      }
      for (const name of rows.keys()) this.db.prepare('DELETE FROM postbox_letters WHERE name = ?').run(name);
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
    return told;
  }

  /** The letters whose run has come: sendable, not paused, and due. */
  due(): { name: string; dueAt: string }[] {
    return (this.db.prepare(`SELECT name, due_at FROM postbox_letters
      WHERE problem IS NULL AND paused = 0 AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at, name`).all(isoAt(this.now())) as
      { name: string; due_at: string }[]).map(row => ({ name: row.name, dueAt: row.due_at }));
  }

  /**
   * Takes a run for sending by moving the letter on to its next run first, so a run is sent at most once: by one look
   * of one process, and never again after a restart. False when another look took it already.
   */
  claim(name: string, dueAt: string, run: number, next: number | undefined): boolean {
    const changed = this.db.prepare(`UPDATE postbox_letters SET due_at = ?, last_run_at = ?, updated_at = ? WHERE name = ? AND due_at = ?`)
      .run(next === undefined ? null : isoAt(next), isoAt(run), isoAt(this.now()), name, dueAt).changes;
    return Number(changed) === 1;
  }

  /** A run passed over, and why. */
  skip(name: string, note: string): void {
    const iso = isoAt(this.now());
    this.db.prepare(`UPDATE postbox_letters SET last_result = 'skipped', last_result_at = ?, note = ?, updated_at = ? WHERE name = ?`)
      .run(iso, note, iso, name);
  }

  /** Whether a request of the letter is still waiting for its reply. */
  waiting(name: string): boolean {
    return this.db.prepare(`SELECT 1 FROM agent_tasks WHERE postbox = ? AND state = 'waiting' LIMIT 1`).get(name) !== undefined;
  }

  /** Whether the letter's replies are told at once. False for a letter no longer in HEAD. */
  notifies(name: string): boolean {
    return (this.row(name)?.notify ?? 'update') === 'attention';
  }

  /** The failures and give-ups in a row so far. */
  failures(name: string): number {
    return this.row(name)?.failures ?? 0;
  }

  /** When the last run that went well was sent, or undefined when none has. */
  lastReceived(name: string): number | undefined {
    return ms(this.row(name)?.last_received_at ?? null);
  }

  /**
   * How a run went, sent at `sentAt`: the result shown, a run that went well (an empty reply too) moving the last reply
   * to when it was sent, never back, and the failures counted until one goes well. A letter no longer in HEAD has
   * nothing to record. The caller's transaction holds it with the rows of the reply.
   */
  record(name: string, result: PostboxResult, at: number, sentAt: number): void {
    const iso = isoAt(at);
    const sent = isoAt(sentAt);
    if (result === 'waiting') {
      this.db.prepare(`UPDATE postbox_letters SET last_sent_at = ?, last_result = 'waiting', last_result_at = ?, note = NULL, updated_at = ?
        WHERE name = ?`).run(sent, iso, iso, name);
    } else if (result === 'received' || result === 'empty') {
      this.db.prepare(`UPDATE postbox_letters SET last_result = ?, last_result_at = ?, note = NULL, failures = 0,
        last_received_at = CASE WHEN last_received_at IS NULL OR last_received_at < ? THEN ? ELSE last_received_at END, updated_at = ?
        WHERE name = ?`).run(result, iso, sent, sent, iso, name);
    } else if (result === 'failed' || result === 'gave-up') {
      this.db.prepare(`UPDATE postbox_letters SET last_result = ?, last_result_at = ?, note = NULL, failures = failures + 1, updated_at = ?
        WHERE name = ?`).run(result, iso, iso, name);
    } else {
      this.db.prepare(`UPDATE postbox_letters SET last_result = ?, last_result_at = ?, note = NULL, updated_at = ? WHERE name = ?`)
        .run(result, iso, iso, name);
    }
  }

  /** Every letter, by name. */
  list(): LetterRecord[] {
    return this.rows().map(row => ({
      name: row.name, path: row.path, ...(row.agent !== null ? { to: row.agent } : {}), ...(row.cron !== null ? { cron: row.cron } : {}),
      paused: row.paused === 1, notify: row.notify, ...(row.problem !== null ? { problem: row.problem } : {}),
      ...optionalTime('nextAt', row.due_at), ...optionalTime('lastSentAt', row.last_sent_at),
      ...(row.last_result !== null ? { lastResult: row.last_result } : {}), ...optionalTime('lastResultAt', row.last_result_at),
      ...(row.note !== null ? { note: row.note } : {}), failures: row.failures, ...optionalTime('lastReceivedAt', row.last_received_at),
    }));
  }

  private rows(): LetterRow[] {
    return this.db.prepare('SELECT * FROM postbox_letters ORDER BY name').all() as unknown as LetterRow[];
  }

  private row(name: string): LetterRow | undefined {
    return this.db.prepare('SELECT * FROM postbox_letters WHERE name = ?').get(name) as LetterRow | undefined;
  }
}

function optionalTime<K extends string>(key: K, iso: string | null): Partial<Record<K, number>> {
  return iso === null ? {} : { [key]: Date.parse(iso) } as Record<K, number>;
}

/** What the postbox hands the sender for one run. */
export interface PostboxSend {
  name: string;
  agent: string;
  /** The letter's body, as written. The sender adds the line about the last reply. */
  body: string;
  /** When the last run that went well was sent; undefined for none. */
  lastReceivedAt?: number;
  notify: LetterNotify;
  /** When the run is sent. */
  at: number;
}

/** The memory repository as the postbox reads it: HEAD alone, never the working tree. */
export interface PostboxRepository {
  headCommit(): Promise<string | undefined>;
  committedPostbox(): Promise<CommittedLetterFile[]>;
}

export interface PostboxOptions {
  db: DatabaseSync;
  now: () => number;
  timeZone: string;
  /** `postbox.enabled`: false sends nothing, and the letters are still read for the dashboard. */
  enabled: boolean;
  /** The agents of the config and the floor of `postbox.minIntervalMinutes`, read at every reading. */
  rules: () => LetterRules;
  repository: PostboxRepository;
  /** Sends one run's request: `AgentRequests.sendPostbox`, which records how it went. */
  sender: { sendPostbox(input: PostboxSend): Promise<void> };
  ledger: PostboxLedger;
  log?: (line: string) => void;
}

/**
 * The look at the letters, from the scheduler's tick whatever the hour (the night's replies wait for the morning as
 * every ordinary update does): HEAD read again when its commit changed, then each letter whose run has come sent once.
 * The runs missed while the server was stopped become one, sent on the first look; a run that comes while the last
 * one's reply is still awaited is passed over. Looks never overlap.
 */
export class Postbox {
  private readonly options: PostboxOptions;
  private chain: Promise<unknown> = Promise.resolve();
  private head: string | undefined;
  private lookedAt: number | undefined;
  private notice: { path: string; problem: string }[] = [];
  /** The letters HEAD held when it was last read, by name. */
  private letters = new Map<string, Letter>();

  constructor(options: PostboxOptions) {
    this.options = options;
  }

  /** Reads HEAD again now: after a turn's commit, which may have changed a letter. */
  reload(): Promise<void> {
    return this.serialize(() => this.read());
  }

  /** One look: HEAD read again when its commit changed, at most once a minute, and the letters whose run has come sent. */
  tick(): Promise<void> {
    return this.serialize(async () => {
      const now = this.options.now();
      if (this.lookedAt === undefined || now - this.lookedAt >= POSTBOX_HEAD_LOOK_MS) {
        this.lookedAt = now;
        const head = await this.options.repository.headCommit();
        if (head !== this.head || head === undefined) await this.read(head);
      }
      if (this.options.enabled) await this.send();
    });
  }

  /** What she is told of the owner's letters that were passed over, taken once: it rides on her next turn's input. */
  takeNotice(): string {
    const told = this.notice;
    this.notice = [];
    if (told.length === 0) return '';
    return ['郵便ポストの定期便のうち、次のものはコミットされた内容が検査に通らないので、送らずに飛ばしています（ほかの定期便は送ります）。',
      ...told.map(entry => `- ${entry.path}: ${entry.problem}`),
      '送るようにするなら、理由を直してコミットしてください。'].join('\n');
  }

  private async read(known?: string): Promise<void> {
    const { repository, ledger, timeZone } = this.options;
    const head = known ?? await repository.headCommit();
    const files = await repository.committedPostbox();
    const rules = { ...this.options.rules(), timeZone, now: this.options.now() };
    const read: ReadLetter[] = files.map(file => {
      const name = letterName(file.path);
      if (file.problem !== undefined || file.text === undefined) return { path: file.path, name, problem: file.problem ?? '読めないファイルです' };
      const checked = checkLetter(file.path, file.text, rules);
      if (!checked.ok) return { path: file.path, name, problem: checked.reason };
      return { path: file.path, name, letter: checked.letter };
    });
    const told = ledger.sync(read, timeZone);
    this.letters = new Map(read.flatMap(entry => 'letter' in entry ? [[entry.name, entry.letter] as const] : []));
    this.head = head;
    if (told.length > 0) {
      this.notice.push(...told);
      this.log(`${told.length} letter(s) fail the check and are passed over`);
    }
  }

  private async send(): Promise<void> {
    const { ledger, timeZone } = this.options;
    for (const due of ledger.due()) {
      const letter = this.letters.get(due.name);
      if (!letter) continue;
      const now = this.options.now();
      const run = lastRun(letter.cron, now, timeZone) ?? Date.parse(due.dueAt);
      if (!ledger.claim(due.name, due.dueAt, run, nextRun(letter.cron, now, timeZone))) continue;
      if (ledger.waiting(due.name)) {
        ledger.skip(due.name, '前の回の返事を待っているので、この回は送りませんでした');
        continue;
      }
      const last = ledger.lastReceived(due.name);
      try {
        await this.options.sender.sendPostbox({ name: letter.name, agent: letter.to, body: letter.body, notify: letter.notify, at: now,
          ...(last !== undefined ? { lastReceivedAt: last } : {}) });
      } catch {
        this.log(`the letter ${due.name} could not be sent`);
      }
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private log(line: string) { this.options.log?.(`postbox: ${line}`); }
}
