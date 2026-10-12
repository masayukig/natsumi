import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPLY_FILE_MODE } from './agent-files.ts';
import { AGENTS_SOURCE, firstLine, makeReplyDirectory, type RequestPlace } from './agent-replies.ts';
import type { DoveTarget } from './dove-request.ts';
import { writeFileAtomically } from './paths.ts';
import type { Attention } from './sources.ts';

/**
 * The dove's requests and results as files under /sources/agents/poppo (ADR 0074): a directory a request, as ADR 0069
 * makes one for an outside agent's, with `request.json` and a line of `results.jsonl` for every result, the newest last.
 * The server alone writes here; the workspace reads it. Each result is told by an attention that points at its line.
 *
 * Unlike an outside agent's reply there is no README: the request and its results are short, and each line is whole.
 */

export const DOVE_REQUEST_FILE = 'request.json';
export const DOVE_RESULTS_FILE = 'results.jsonl';

/** What a request answers, as she would read it in the record: the channel, and the message when one was named. */
export interface DoveRequestTarget {
  /** `work/#dev`. */
  channel: string;
  at?: string;
  from?: string;
  /** How the message begins. */
  text?: string;
}

/** A request as it is kept: what she wrote, when, and what the server added for a reader. */
export interface DoveRequestRecord {
  kind: 'post' | 'reaction';
  to: DoveTarget;
  face?: string;
  text?: string;
  emoji?: string;
  images?: string[];
  /** When she asked, in the owner's time zone. */
  asked_at: string;
  target: DoveRequestTarget;
  /** Set on one made from the record afterwards, rather than as it was asked. */
  note?: string;
}

/** One result as `results.jsonl` keeps it. */
export interface DoveResultLine {
  /** When it came, in the owner's time zone. */
  at: string;
  state: string;
  /** The dove's words. */
  text: string;
  /** Her own post in the record, when one was sent and its line is known. */
  slack_file?: string;
  slack_path?: string;
}

/** The longest start of the message replied to that a request keeps, in characters. */
const TARGET_HEAD_CHARS = 100;

/** The start of a message, as a request keeps it. */
export function targetHead(text: string): string {
  const characters = [...text.replace(/\s+/g, ' ').trim()];
  return characters.length > TARGET_HEAD_CHARS ? `${characters.slice(0, TARGET_HEAD_CHARS).join('')}…` : characters.join('');
}

/** Makes a request's directory under `directory` (`sources/agents`), with its request.json, named by when it was asked. */
export async function writeDoveRequest(directory: string, agent: string, at: number, record: DoveRequestRecord): Promise<RequestPlace> {
  return makeReplyDirectory(directory, agent, at, async temporary => {
    await writeFile(join(temporary, DOVE_REQUEST_FILE), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: REPLY_FILE_MODE });
  });
}

/** Writes a request's results.jsonl whole, from every result so far: a line never moves, and the file is never half-written. */
export async function writeDoveResults(directory: string, lines: readonly DoveResultLine[]): Promise<void> {
  await writeFileAtomically(join(directory, DOVE_RESULTS_FILE), lines.map(line => `${JSON.stringify(line)}\n`).join(''), REPLY_FILE_MODE);
}

/** What a request asked, in a line for its attention: the start of the text, the emoji, or the images alone. */
export function requestLine(record: Pick<DoveRequestRecord, 'kind' | 'text' | 'emoji' | 'images'>): string {
  if (record.kind === 'reaction') return `:${record.emoji ?? ''}:`;
  if (record.text) return firstLine(record.text);
  return `画像 ${record.images?.length ?? 0} 枚`;
}

/**
 * The attention that tells of one result (ADR 0074): the line of results.jsonl it is, the dove's name, the state as of
 * this result, the dove's words as the summary, what was asked and when, and her own post's line when one was sent.
 */
export function resultAttention(place: string, agent: string, index: number, line: DoveResultLine,
  request: { line: string; askedAt: string }): Attention {
  return { source: AGENTS_SOURCE, kind: 'agent_reply', file: `${place}/${DOVE_RESULTS_FILE}`, path: `.[${index}]`,
    details: { agent, state: line.state, summary: line.text, request: request.line, asked_at: request.askedAt,
      ...(line.slack_file && line.slack_path ? { slack_file: line.slack_file, slack_path: line.slack_path } : {}) } };
}
