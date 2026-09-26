import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { STATE_DIRECTORY } from './data-directory.ts';
import type { Fold } from './fold-setting.ts';
import { isoAt } from './nightly.ts';
import { REFLECTION_REQUEST } from './prompts.ts';
import { openStateDatabase } from './state-db.ts';

/**
 * The numbers each ordinary turn leaves, so that turns folded and not can be compared in production (ADR 0047). Only
 * numbers and names the server chose are kept; nothing anyone said.
 */

export interface TokenCounts { input: number; cacheRead: number; output: number }

export interface TurnRecord {
  turnId: string;
  startedAt: number;
  endedAt: number;
  /** When the earliest of the turn's events arrived. */
  receivedAt: number;
  /** Her first reply to the owner or request to the dove in the turn, if any. */
  firstOutAt?: number;
  fold: Fold;
  route: string;
  /** The kinds of the turn's events, in the names the model sees, joined with `+`. */
  eventKinds: string;
  /** `ok`, or why the turn failed. */
  outcome: string;
  modelCalls: number;
  usage: TokenCounts;
  /** What the turn's first model call was sent, in tokens. */
  contextTokens: number | null;
  /** The memo, when one was asked for. */
  reflection?: TokenCounts & { ms: number };
  /** Whether the session was compacted after the turn. */
  compacted: boolean;
  /** Signs of her losing her way, counted by the server from what the turn did (ADR 0047). */
  confusion: Confusion;
}

export interface Confusion {
  /** run_shell commands (spaces normalized) and read paths already used earlier in the session's context. */
  repeatedCalls: number;
  /** Tool results that came back as errors. */
  toolErrors: number;
  /** Requests the dove turned back: a heading written wrong, a reference that names no one message. */
  doveRefusals: number;
  /** Owner messages the turn was shown and ended without answering. */
  unansweredMessages: number;
}

export class TurnStats {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  record(turn: TurnRecord): void {
    const { reflection } = turn;
    this.db.prepare(`INSERT INTO turn_stats (turn_id, started_at, fold, route, event_kinds, outcome, first_out_ms, turn_ms,
      model_calls, input_tokens, cache_read_tokens, output_tokens, context_tokens, reflection_ms, reflection_input_tokens,
      reflection_cache_read_tokens, reflection_output_tokens, compacted, repeated_calls, tool_errors, dove_refusals,
      unanswered_messages) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(turn.turnId, isoAt(turn.startedAt), turn.fold, turn.route, turn.eventKinds, turn.outcome,
        turn.firstOutAt === undefined ? null : Math.max(0, turn.firstOutAt - turn.receivedAt),
        Math.max(0, turn.endedAt - turn.startedAt), turn.modelCalls, turn.usage.input, turn.usage.cacheRead, turn.usage.output,
        turn.contextTokens, reflection?.ms ?? null, reflection?.input ?? null, reflection?.cacheRead ?? null,
        reflection?.output ?? null, turn.compacted ? 1 : 0, turn.confusion.repeatedCalls, turn.confusion.toolErrors,
        turn.confusion.doveRefusals, turn.confusion.unansweredMessages);
  }
}

/** The value at a percentile, by nearest rank; undefined for no values. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export type StatsCommand = { command: 'stats'; dataDir: string | undefined } &
  ({ since?: string; until?: string; memos?: undefined } | { memos: number; config: string });

/** A day (taken as UTC midnight) or a full ISO time, as `--since` and `--until` accept them. */
export const STATS_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z)?$/;

type Row = Record<string, number | string | null>;

/** Each line: its label, and how a turn's value is read off its row (undefined to leave the turn out). */
const MEASURES: [string, (row: Row) => number | undefined, (value: number) => string][] = [
  ['first reply or post (s)', row => seconds(row.first_out_ms), value => value.toFixed(1)],
  ['turn length (s)', row => seconds(row.turn_ms), value => value.toFixed(1)],
  ['model calls', row => number(row.model_calls), value => String(value)],
  ['context at start (tokens)', row => number(row.context_tokens), value => String(Math.round(value))],
  ['cached share of input (%)', row => share(row.cache_read_tokens, row.input_tokens), value => value.toFixed(0)],
  ['output tokens', row => number(row.output_tokens), value => String(Math.round(value))],
  ['memo time (s)', row => seconds(row.reflection_ms), value => value.toFixed(1)],
  ['memo cached share (%)', row => share(row.reflection_cache_read_tokens, row.reflection_input_tokens), value => value.toFixed(0)],
];

/** Each line: its label, and what one turn counts toward the average per turn. */
const RATES: [string, (row: Row) => number][] = [
  ['repeated calls / turn', row => number(row.repeated_calls) ?? 0],
  ['tool errors / turn', row => number(row.tool_errors) ?? 0],
  ['dove refusals / turn', row => number(row.dove_refusals) ?? 0],
  ['unanswered messages / turn', row => number(row.unanswered_messages) ?? 0],
];

/**
 * `natsumi stats`: medians and p90s of the turns in the period, folded and not side by side, then the signs of
 * confusion as averages per turn. With `--memos`, the latest memos instead, read from the session files, for the owner
 * to judge by eye: they are never copied anywhere else (ADR 0047).
 */
export async function runStatsCommand(cli: StatsCommand, dataDirectory: string, write: (line: string) => void): Promise<number> {
  if (cli.memos !== undefined) return listMemos(cli, write);
  const path = join(dataDirectory, STATE_DIRECTORY, 'state.sqlite');
  if (!existsSync(path)) { write('no state database in this data directory'); return 1; }
  const db = openStateDatabase(path);
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'turn_stats'").get();
    if (!table) { write('no turns recorded yet: the server has not run this version'); return 0; }
    const since = cli.since ? boundary(cli.since) : '';
    const until = cli.until ? boundary(cli.until) : '9999';
    const rows = db.prepare('SELECT * FROM turn_stats WHERE started_at >= ? AND started_at < ? ORDER BY started_at')
      .all(since, until) as Row[];
    const period = `${cli.since ?? 'the start'} to ${cli.until ?? 'now'}`;
    if (rows.length === 0) { write(`no turns from ${period}`); return 0; }
    const off = rows.filter(row => row.fold === 'off');
    const on = rows.filter(row => row.fold === 'on');
    write(`turns: ${rows.length} (off ${off.length}, on ${on.length}), from ${period}`);
    const width = Math.max(...MEASURES.map(([label]) => label.length), 'compactions'.length);
    write(`${''.padEnd(width)}  ${'off p50'.padStart(8)}  ${'off p90'.padStart(8)}  ${'on p50'.padStart(8)}  ${'on p90'.padStart(8)}`);
    for (const [label, pick, show] of MEASURES) {
      const cells = [off, on].flatMap(group => {
        const values = group.map(pick).filter((value): value is number => value !== undefined);
        return [50, 90].map(p => { const value = percentile(values, p); return value === undefined ? '-' : show(value); });
      });
      write(`${label.padEnd(width)}  ${cells.map(cell => cell.padStart(8)).join('  ')}`);
    }
    const compactions = (group: Row[]) => String(group.filter(row => row.compacted === 1).length);
    write(`${'compactions'.padEnd(width)}  ${compactions(off).padStart(8)}  ${''.padStart(8)}  ${compactions(on).padStart(8)}`.trimEnd());
    write('');
    const rateWidth = Math.max(...RATES.map(([label]) => label.length), 'cut short (%)'.length);
    write(`${''.padEnd(rateWidth)}  ${'off'.padStart(8)}  ${'on'.padStart(8)}`);
    const mean = (group: Row[], pick: (row: Row) => number) =>
      group.length === 0 ? '-' : (group.reduce((sum, row) => sum + pick(row), 0) / group.length).toFixed(2);
    for (const [label, pick] of RATES) write(`${label.padEnd(rateWidth)}  ${mean(off, pick).padStart(8)}  ${mean(on, pick).padStart(8)}`);
    // Stopped at the call limit or the time limit.
    const cut = (group: Row[]) => group.length === 0 ? '-'
      : ((group.filter(row => row.outcome === 'model-call-limit' || row.outcome === 'timeout').length / group.length) * 100).toFixed(0);
    write(`${'cut short (%)'.padEnd(rateWidth)}  ${cut(off).padStart(8)}  ${cut(on).padStart(8)}`);
    return 0;
  } finally { db.close(); }
}

/** The latest memos, oldest first, each with when it was written. */
async function listMemos(cli: Extract<StatsCommand, { memos: number }>, write: (line: string) => void): Promise<number> {
  let directory: unknown;
  try { directory = (JSON.parse(await readFile(cli.config, 'utf8')) as { pi?: { sessionDirectory?: unknown } }).pi?.sessionDirectory; } catch {
    write(`cannot read the config ${cli.config}`); return 1;
  }
  if (typeof directory !== 'string') { write('the config names no pi.sessionDirectory'); return 1; }
  const memos: { at: string; text: string }[] = [];
  let files: string[];
  try { files = (await readdir(directory)).filter(name => name.endsWith('.jsonl')); } catch { write(`cannot read ${directory}`); return 1; }
  for (const file of files) {
    let asked = false;
    for (const line of (await readFile(join(directory, file), 'utf8')).split('\n')) {
      let entry: { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== 'message' || !entry.message) continue;
      const text = textOf(entry.message.content).trim();
      if (entry.message.role === 'user') { asked = text === REFLECTION_REQUEST; continue; }
      if (entry.message.role !== 'assistant' || !asked) continue;
      asked = false;
      if (text) memos.push({ at: entry.timestamp ?? '', text: text.replace(/\s+/g, ' ') });
    }
  }
  memos.sort((a, b) => a.at.localeCompare(b.at));
  const latest = memos.slice(-cli.memos);
  if (latest.length === 0) write('no memos yet');
  for (const memo of latest) write(`${memo.at}  ${memo.text}`);
  return 0;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (part as { type?: string }).type === 'text' ? (part as { text: string }).text : '').join('');
}

function boundary(value: string): string {
  return value.length === 10 ? `${value}T00:00:00.000Z` : new Date(value).toISOString();
}

const number = (value: unknown) => typeof value === 'number' ? value : undefined;
const seconds = (value: unknown) => typeof value === 'number' ? value / 1000 : undefined;
function share(cached: unknown, uncached: unknown): number | undefined {
  if (typeof cached !== 'number' || typeof uncached !== 'number' || cached + uncached === 0) return undefined;
  return (cached / (cached + uncached)) * 100;
}
