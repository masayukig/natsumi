import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { REFLECTION_REQUEST } from './prompts.ts';
import type { TurnInProgress } from './thinking-loop.ts';
import type { TurnKind, TurnPlace } from './turn-stats.ts';

/**
 * The turns as the dashboard reads them (ADR 0049): the list from `turn_stats` alone, and each turn's words from the
 * Pi session record, where alone they are kept (ADR 0008, ADR 0047).
 *
 * A turn is read from the place its row keeps, and only that: the bytes are read asynchronously, so a record of tens of
 * megabytes neither is read whole nor holds up the thinking loop and the WebSocket. A turn recorded before the places
 * existed is estimated instead, from its times and the `<events>` that begin every turn, and says it was. A line not
 * ended yet is one Pi is still writing, and is left out.
 */

export const TURNS_PER_PAGE = 50;

/** One row of `turn_stats`, as the dashboard shows it. */
export interface TurnRow {
  turnId: string;
  kind: TurnKind;
  startedAt: string;
  turnMs: number;
  fold: string;
  route: string;
  eventKinds: string;
  outcome: string;
  firstOutMs: number | null;
  modelCalls: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  contextTokens: number | null;
  reflectionMs: number | null;
  compacted: boolean;
  toolErrors: number;
  place: TurnPlace | null;
  eventIds: string[] | null;
}

/** An entry of the session record: Pi's shape, read as data. */
export interface RecordEntry { type: string; id: string; parentId: string | null; timestamp: string; [key: string]: unknown }

export type TurnReading =
  | { found: true; estimated: boolean; sessionFile: string; entries: RecordEntry[] }
  | { found: false; reason: 'no-file' | 'not-in-file' };

export interface TurnSource { db: DatabaseSync; sessionDirectory: string }

export function listTurns(db: DatabaseSync, page: number): { rows: TurnRow[]; more: boolean } {
  const rows = db.prepare('SELECT * FROM turn_stats ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?')
    .all(TURNS_PER_PAGE + 1, (page - 1) * TURNS_PER_PAGE) as Record<string, unknown>[];
  return { rows: rows.slice(0, TURNS_PER_PAGE).map(turnRow), more: rows.length > TURNS_PER_PAGE };
}

export function findTurn(db: DatabaseSync, turnId: string): TurnRow | undefined {
  const row = db.prepare('SELECT * FROM turn_stats WHERE turn_id = ?').get(turnId) as Record<string, unknown> | undefined;
  return row && turnRow(row);
}

function turnRow(row: Record<string, unknown>): TurnRow {
  const text = (value: unknown) => typeof value === 'string' ? value : null;
  const count = (value: unknown) => typeof value === 'number' ? value : null;
  const sessionFile = text(row.session_file);
  const place = sessionFile && text(row.first_entry_id) && text(row.last_entry_id) && count(row.start_offset) !== null
    && count(row.end_offset) !== null
    ? { sessionFile, firstEntryId: row.first_entry_id as string, lastEntryId: row.last_entry_id as string,
      startOffset: row.start_offset as number, endOffset: row.end_offset as number }
    : null;
  let eventIds: string[] | null = null;
  try { eventIds = text(row.event_ids) ? JSON.parse(row.event_ids as string) as string[] : null; } catch { /* shown without */ }
  return {
    turnId: row.turn_id as string, kind: row.kind === 'review' ? 'review' : 'events', startedAt: row.started_at as string,
    turnMs: row.turn_ms as number, fold: row.fold as string, route: row.route as string, eventKinds: row.event_kinds as string,
    outcome: row.outcome as string, firstOutMs: count(row.first_out_ms), modelCalls: row.model_calls as number,
    inputTokens: row.input_tokens as number, cacheReadTokens: row.cache_read_tokens as number, outputTokens: row.output_tokens as number,
    contextTokens: count(row.context_tokens), reflectionMs: count(row.reflection_ms), compacted: row.compacted === 1,
    toolErrors: row.tool_errors as number, place, eventIds,
  };
}

/** The turns that asked for a memo in a page of memos (ADR 0047); each memo is read from its record, so fewer than the turns. */
export const MEMOS_PER_PAGE = 20;
/**
 * How far back from the end of its turn a memo is looked for. It is the turn's last message but for the compaction
 * after it, so the first look is short; a long summary may take the second. A turn whose memo is further back than the
 * last is not read on: the list says so and links to the turn.
 */
const MEMO_WINDOWS = [16 * 1024, 128 * 1024];
export const MEMO_READ_LIMIT_BYTES = 1024 * 1024;

export type MemoReading =
  | { found: true; text: string }
  /**
   * `estimated`: the turn is from before the places, and finding it means reading the record from the start.
   * `moved`: the bytes no longer end at the turn's last entry. `too-far`: no memo request within the limit.
   * `no-memo`: the turn asked for none it got an answer to.
   */
  | { found: false; reason: 'estimated' | 'no-file' | 'moved' | 'too-far' | 'no-memo' };

/** The ordinary turns that asked for a memo, newest first, a page at a time. */
export function listMemoTurns(db: DatabaseSync, page: number): { rows: TurnRow[]; more: boolean } {
  const rows = db.prepare(`SELECT * FROM turn_stats WHERE kind = 'events' AND reflection_ms IS NOT NULL
    ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(MEMOS_PER_PAGE + 1, (page - 1) * MEMOS_PER_PAGE) as Record<string, unknown>[];
  return { rows: rows.slice(0, MEMOS_PER_PAGE).map(turnRow), more: rows.length > MEMOS_PER_PAGE };
}

/**
 * A turn's memo, read backwards from the end of its place a window at a time, never past its start nor further than
 * MEMO_READ_LIMIT_BYTES: the answer to the last memo request in the turn. The turn's steps before it are not read.
 */
export async function readMemo(source: TurnSource, row: TurnRow): Promise<MemoReading> {
  const place = row.place;
  if (!place) return { found: false, reason: 'estimated' };
  const path = await existing(source.sessionDirectory, place.sessionFile);
  if (!path) return { found: false, reason: 'no-file' };
  const span = place.endOffset - place.startOffset;
  for (const window of [...MEMO_WINDOWS, MEMO_READ_LIMIT_BYTES]) {
    const whole = window >= span;
    const from = whole ? place.startOffset : place.endOffset - window;
    const entries: RecordEntry[] = [];
    let first = true;
    for await (const line of lines(path, from, place.endOffset)) {
      // Unless the window begins at the turn's start, its first line is the tail of one cut in two.
      if (first && !whole) { first = false; continue; }
      first = false;
      const entry = parse(line);
      if (entry) entries.push(entry);
    }
    // A window inside one long line has no whole entry yet: the next one looks further.
    if (entries.length === 0 && !whole) continue;
    if (entries.at(-1)?.id !== place.lastEntryId) return { found: false, reason: 'moved' };
    const asked = entries.findLastIndex(entry => entry.type === 'message'
      && (entry.message as { role?: string } | undefined)?.role === 'user' && contentText((entry.message as { content?: unknown }).content) === REFLECTION_REQUEST);
    if (asked >= 0) {
      const answer = entries.slice(asked + 1).find(entry => entry.type === 'message' && (entry.message as { role?: string } | undefined)?.role === 'assistant');
      return answer ? { found: true, text: contentText((answer.message as { content?: unknown }).content) } : { found: false, reason: 'no-memo' };
    }
    if (whole) return { found: false, reason: 'no-memo' };
  }
  return { found: false, reason: 'too-far' };
}

/** The entries of a recorded turn, or of the one in progress. */
export async function readTurn(source: TurnSource, target: { row: TurnRow } | { inProgress: TurnInProgress }): Promise<TurnReading> {
  if ('inProgress' in target) {
    const place = target.inProgress.place;
    const path = place && await existing(source.sessionDirectory, place.sessionFile);
    if (!place || !path) return { found: false, reason: 'no-file' };
    const entries: RecordEntry[] = [];
    for await (const line of lines(path, place.startOffset)) { const entry = parse(line); if (entry) entries.push(entry); }
    return entries.length > 0 ? { found: true, estimated: false, sessionFile: place.sessionFile, entries } : { found: false, reason: 'not-in-file' };
  }
  const { row } = target;
  if (row.place) return readPlaced(source, row.place);
  return estimate(source, row);
}

async function readPlaced(source: TurnSource, place: TurnPlace): Promise<TurnReading> {
  const path = await existing(source.sessionDirectory, place.sessionFile);
  if (!path) return { found: false, reason: 'no-file' };
  const entries: RecordEntry[] = [];
  if (place.endOffset > place.startOffset) {
    for await (const line of lines(path, place.startOffset, place.endOffset)) { const entry = parse(line); if (entry) entries.push(entry); }
  }
  if (entries[0]?.id === place.firstEntryId && entries.at(-1)?.id === place.lastEntryId) {
    return { found: true, estimated: false, sessionFile: place.sessionFile, entries };
  }
  // The bytes moved under the row, as when Pi rewrites a record: the entries are looked for by their IDs.
  const byId: RecordEntry[] = [];
  for await (const line of lines(path, 0)) {
    if (byId.length === 0 && idOf(line) !== place.firstEntryId) continue;
    const entry = parse(line);
    if (!entry) continue;
    byId.push(entry);
    if (entry.id === place.lastEntryId) return { found: true, estimated: false, sessionFile: place.sessionFile, entries: byId };
  }
  return { found: false, reason: 'not-in-file' };
}

/**
 * A turn from before the places: the session current when it started, from its first `<events>` at or after its start
 * up to the next `<events>` after its end. An `<events>` inside its time is a message steered in; what follows its end
 * before the next turn is its memo and the compaction after it.
 */
async function estimate(source: TurnSource, row: TurnRow): Promise<TurnReading> {
  const startedAt = Date.parse(row.startedAt);
  const endedAt = startedAt + row.turnMs;
  const file = await sessionAt(source, startedAt);
  if (!file) return { found: false, reason: 'no-file' };
  const entries: RecordEntry[] = [];
  // A little before the start, for clocks read a moment apart.
  const from = startedAt - 2_000;
  for await (const line of lines(file.path, 0)) {
    const at = timeOf(line);
    if (entries.length === 0) {
      if (at !== undefined && at < from) continue;
      if (at !== undefined && at > endedAt) break;
      const entry = parse(line);
      if (entry && isEvents(entry)) entries.push(entry);
      continue;
    }
    const entry = parse(line);
    if (!entry) continue;
    if (isEvents(entry) && Date.parse(entry.timestamp) > endedAt) break;
    entries.push(entry);
  }
  return entries.length > 0 ? { found: true, estimated: true, sessionFile: file.name, entries } : { found: false, reason: 'not-in-file' };
}

/** The session file current at a time: of those the conversation has used, the latest begun by then. */
async function sessionAt(source: TurnSource, at: number): Promise<{ name: string; path: string } | undefined> {
  const names = (source.db.prepare(`SELECT pi_session_file AS name FROM conversations
    UNION SELECT from_session_file FROM session_rotations UNION SELECT to_session_file FROM session_rotations`)
    .all() as { name: string | null }[]).flatMap(row => row.name ? [row.name] : []);
  let best: { name: string; path: string; begun: number } | undefined;
  for (const name of names) {
    const path = await existing(source.sessionDirectory, name);
    if (!path) continue;
    const begun = await headerTime(path);
    if (begun === undefined || begun > at) continue;
    if (!best || begun > best.begun) best = { name, path, begun };
  }
  return best;
}

async function headerTime(path: string): Promise<number | undefined> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(4_096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const end = text.indexOf('\n');
    if (end < 0) return undefined;
    const header = JSON.parse(text.slice(0, end)) as { type?: string; timestamp?: string };
    const time = header.type === 'session' && typeof header.timestamp === 'string' ? Date.parse(header.timestamp) : NaN;
    return Number.isNaN(time) ? undefined : time;
  } catch { return undefined; } finally { await handle.close(); }
}

/** The file inside the session directory, when it exists there; nothing outside it is ever opened. */
async function existing(directory: string, name: string): Promise<string | undefined> {
  const path = resolve(directory, name);
  const rel = relative(directory, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  try { return (await stat(path)).isFile() ? path : undefined; } catch { return undefined; }
}

/**
 * The lines from `start` to `end` (exclusive; the end of the file when omitted), read a chunk at a time. Only lines
 * that end with a newline are given: the last one may be half written.
 */
async function* lines(path: string, start: number, end?: number): AsyncGenerator<string> {
  const stream = createReadStream(path, { start, ...(end === undefined ? {} : { end: end - 1 }), highWaterMark: 256 * 1024 });
  let pending: Buffer[] = [];
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let from = 0;
      for (let at = chunk.indexOf(10); at >= 0; at = chunk.indexOf(10, from)) {
        pending.push(chunk.subarray(from, at));
        const line = Buffer.concat(pending).toString('utf8');
        pending = [];
        from = at + 1;
        if (line) yield line;
      }
      if (from < chunk.length) pending.push(chunk.subarray(from));
    }
  } finally { stream.destroy(); }
}

function parse(line: string): RecordEntry | undefined {
  try {
    const entry = JSON.parse(line) as RecordEntry;
    return entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.type !== 'session' ? entry : undefined;
  } catch { return undefined; }
}

/** An entry's time and ID, read off the front of its line without parsing the rest, where Pi writes them. */
function timeOf(line: string): number | undefined {
  const match = /"timestamp":"([^"]+)"/.exec(line.slice(0, 300));
  const time = match ? Date.parse(match[1]!) : NaN;
  return Number.isNaN(time) ? undefined : time;
}
function idOf(line: string): string | undefined {
  return /"id":"([^"]+)"/.exec(line.slice(0, 200))?.[1];
}

/** Whether the entry is the owner-side prompt of events that begins a turn, or is steered into one. */
export function isEvents(entry: RecordEntry): boolean {
  const message = entry.message as { role?: string; content?: unknown } | undefined;
  return entry.type === 'message' && message?.role === 'user' && contentText(message.content).startsWith('<events>');
}

/** The text parts of a message's content, joined. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => part && (part as { type?: string }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : '').join('');
}

export interface RecordImage { data: string; mimeType: string }

/** The images of one entry, in order: in the events, a tool's result or an extension's message. */
export function imagesIn(entry: RecordEntry): RecordImage[] {
  const content = entry.type === 'message' ? (entry.message as { content?: unknown } | undefined)?.content
    : entry.type === 'custom_message' ? entry.content : undefined;
  if (!Array.isArray(content)) return [];
  return content.flatMap(part => {
    const image = part as { type?: string; data?: unknown; mimeType?: unknown };
    return image?.type === 'image' && typeof image.data === 'string' && typeof image.mimeType === 'string'
      ? [{ data: image.data, mimeType: image.mimeType }] : [];
  });
}

/** Every image of the turn, numbered from 0 in the order the page shows them. */
export function turnImages(entries: RecordEntry[]): RecordImage[] {
  return entries.flatMap(imagesIn);
}
