import { buildSessionContext, type ContextEvent, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { REFLECTION_REQUEST } from '../server/prompts.ts';
import { foldTurns } from '../server/turn-fold.ts';

/**
 * What a replay of a past session sends (ADR 0047), apart from sending it: where each turn starts and ends, the
 * context its first call had in production, the same context folded with a memo after every ended turn, and how a
 * first response is sorted. Nothing here reads files or calls a model.
 */

type AgentMessage = ContextEvent['messages'][number];
type Block = { type: string; name?: string; arguments?: Record<string, unknown>; text?: string };

export type Category = 'reply' | 'lookup' | 'dove' | 'other' | 'none';
export interface FirstAction { category: Category; tool: string | null }

export interface Turn {
  index: number;
  /** The entry of the event prompt that started it. */
  startEntryId: string;
  /** Its last entry: everything up to the next turn, or up to the nightly review. */
  lastEntryId: string;
  /** The kinds of the events in its prompt, as the model saw them, joined with `+`. */
  eventKinds: string;
  /** How its first call acted in production. */
  production: FirstAction;
}

/** The longest an event steered in takes to follow the tool result before it; in production it is a few milliseconds. */
export const STEERED_WITHIN_MS = 1000;

const messageOf = (entry: SessionEntry) => entry.type === 'message' ? (entry as { message: AgentMessage }).message : undefined;

function textOf(message: AgentMessage | undefined): string {
  if (!message || message.role !== 'user') return '';
  const content = message.content;
  return typeof content === 'string' ? content : content.map(part => part.type === 'text' ? part.text : '').join('');
}

const isEvents = (message: AgentMessage | undefined) => textOf(message).startsWith('<events>');
const isReview = (message: AgentMessage | undefined) => /"type":"nightly_review"/.test(textOf(message));

/**
 * The turns of a session, in order. A turn starts with an event prompt; an event steered in right after a tool result
 * is part of the turn it arrived in. The nightly review is not a turn to replay, and ends the turn before it.
 */
export function findTurns(entries: SessionEntry[]): Turn[] {
  const messages = entries.map((entry, position) => ({ entry, position, message: messageOf(entry) }))
    .filter(item => item.message !== undefined);
  const starts: { position: number; review: boolean }[] = [];
  messages.forEach((item, index) => {
    if (!isEvents(item.message)) return;
    // An event right after a tool result was steered in at a model-call boundary, within milliseconds; one that came
    // later started a turn of its own after a turn that ended on a tool (a limit, or an older version's end).
    const previous = messages[index - 1];
    if (previous?.message?.role === 'toolResult'
      && Date.parse(item.entry.timestamp) - Date.parse(previous.entry.timestamp) <= STEERED_WITHIN_MS) return;
    starts.push({ position: item.position, review: isReview(item.message) });
  });
  const turns: Turn[] = [];
  starts.forEach((start, index) => {
    if (start.review) return;
    const end = (starts[index + 1]?.position ?? entries.length) - 1;
    const first = entries.slice(start.position + 1, end + 1).map(messageOf).find(message => message?.role === 'assistant');
    const kinds = [...textOf(messageOf(entries[start.position]!)).matchAll(/"type":"([a-z_]+)"/g)].map(match => match[1]!);
    turns.push({ index: turns.length, startEntryId: entries[start.position]!.id, lastEntryId: entries[end]!.id,
      eventKinds: [...new Set(kinds)].join('+'), production: first ? classify(first as never) : { category: 'none', tool: null } });
  });
  return turns;
}

/** The context as Pi builds it at an entry: compactions applied, system messages left out. */
export function contextAt(entries: SessionEntry[], entryId: string): AgentMessage[] {
  return buildSessionContext(entries, entryId).messages.filter(message => message.role !== 'system');
}

/** The context of the memo for a turn: the whole turn as production had it, then the request. */
export function memoContext(entries: SessionEntry[], turn: Turn): AgentMessage[] {
  return [...contextAt(entries, turn.lastEntryId), { role: 'user', content: [{ type: 'text', text: REFLECTION_REQUEST }], timestamp: 0 }];
}

/**
 * The context turn `index`'s first call would have had with folding on: production's, with the memo request and its
 * answer after every turn that had ended, folded as the loop folds it.
 */
export function foldedContextAt(entries: SessionEntry[], turns: Turn[], index: number, memos: Map<number, string>): AgentMessage[] {
  const messages = contextAt(entries, turns[index]!.startEntryId);
  const startOf = new Map<unknown, number>();
  for (const turn of turns.slice(1, index + 1)) {
    const entry = entries.find(candidate => candidate.id === turn.startEntryId)!;
    startOf.set(messageOf(entry)!.timestamp, turn.index);
  }
  const withMemos: AgentMessage[] = [];
  for (const message of messages) {
    const started = message.role === 'user' ? startOf.get(message.timestamp) : undefined;
    if (started !== undefined) {
      const memo = memos.get(started - 1) ?? '';
      withMemos.push({ role: 'user', content: [{ type: 'text', text: REFLECTION_REQUEST }], timestamp: message.timestamp - 2 });
      withMemos.push({ role: 'assistant', content: memo ? [{ type: 'text', text: memo }] : [], api: 'openai-completions',
        provider: 'replay', model: 'replay', stopReason: 'stop', timestamp: message.timestamp - 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    }
    withMemos.push(message);
  }
  return foldTurns(withMemos) ?? withMemos;
}

/** How a response first acted: its first tool call, sorted, or none. */
export function classify(response: { content: Block[] }): FirstAction {
  const first = response.content.find(block => block.type === 'toolCall');
  if (!first?.name) return { category: 'none', tool: null };
  const tool = first.name;
  if (tool === 'reply_to_mac' || tool === 'notify_owner') return { category: 'reply', tool };
  if (tool === 'run_shell' || tool === 'read') return { category: 'lookup', tool };
  if (tool === 'ask_agent') return { category: first.arguments?.agent === 'poppo' ? 'dove' : 'other', tool };
  return { category: 'other', tool };
}

const lookupKey = (block: Block) => block.name === 'run_shell' && typeof block.arguments?.command === 'string'
  ? `run_shell ${block.arguments.command.trim().replace(/\s+/g, ' ')}`
  : block.name === 'read' && typeof block.arguments?.path === 'string' ? `read ${block.arguments.path.trim()}` : undefined;

/** The response's run_shell commands and reads, and how many of them an earlier turn of the session had made. */
export function lookups(entries: SessionEntry[], turns: Turn[], index: number, response: { content: Block[] }): { lookups: number; repeated: number } {
  const start = entries.findIndex(entry => entry.id === turns[index]!.startEntryId);
  const seen = new Set<string>();
  for (const entry of entries.slice(0, start)) {
    const message = messageOf(entry);
    if (message?.role !== 'assistant') continue;
    for (const block of message.content as Block[]) {
      const key = block.type === 'toolCall' ? lookupKey(block) : undefined;
      if (key) seen.add(key);
    }
  }
  const keys = response.content.filter(block => block.type === 'toolCall').map(lookupKey).filter((key): key is string => key !== undefined);
  return { lookups: keys.length, repeated: keys.filter(key => seen.has(key)).length };
}

/** A small seeded generator, so the same run draws the same pairs. */
function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; };
}

/** Up to `count` turns where the two sides first acted differently, each with the folded side hidden as A or B. */
export function pickPairs<T extends { key: string; differs: boolean }>(rows: T[], count: number, seed: number): { key: string; foldedIs: 'A' | 'B' }[] {
  const next = random(seed);
  const candidates = rows.filter(row => row.differs).map(row => ({ row, order: next() })).sort((a, b) => a.order - b.order);
  return candidates.slice(0, count).map(({ row }) => ({ key: row.key, foldedIs: next() < 0.5 ? 'A' as const : 'B' as const }));
}
