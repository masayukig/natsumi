import type { ContextEvent, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { isReflectionRequest } from './prompts.ts';

/**
 * Folding the turns that have ended (ADR 0047). The session records every turn whole; what the model is sent has
 * each ended turn's thinking and working steps taken out, leaving what arrived, what she sent out, what she read and
 * the one-line memo the server asked her for when the turn ended. The fold is made afresh before every model call from
 * the messages alone, so the same messages always give the same result — which is what keeps the prefix cache — and
 * turning it off gives back the whole record at once.
 */

type AgentMessage = ContextEvent['messages'][number];
type Assistant = Extract<AgentMessage, { role: 'assistant' }>;
type ToolResult = Extract<AgentMessage, { role: 'toolResult' }>;

/**
 * The calls a fold keeps, with their results: what reached the owner or someone outside — replies, notices, and
 * requests to other agents, the dove's Slack posts among them — and what she read with `read`, which is kept so that
 * a manual or a memory once read need not be read again. Everything else she did on the way is working.
 */
export const KEPT_TOOLS = new Set(['reply_to_mac', 'notify_owner', 'ask_agent', 'read']);
/** What a kept reply or notice's result becomes: the line itself is in the call. */
export const SENT = '送りました。';
/** Stands before the memo, which is folded into a line of her own. */
export const MEMO_HEADING = '（このターンの振り返り）';
/**
 * The longest memo a fold keeps, in characters. The request asks for about 100; one far past it is cut here, with a
 * mark, so that a memo cannot grow the folded context the way the steps it replaces did.
 */
export const MEMO_MAX_CHARS = 200;
/** Stands where a memo was cut. */
export const MEMO_CUT = '…（以下略）';
/** What a memo with nothing to say is: it leaves no line, as an empty one does not. */
const NOTHING = /^[「『"]?(特に)?なし[」』"]?[。.]?$/;
/** A read of a file whose content was already kept, in an earlier folded turn, word for word. */
export const ALREADY_READ = (path: string) => `既に読みました（${path}）。前に読んだときと同じ内容です。`;
const SENT_TOOLS = new Set(['reply_to_mac', 'notify_owner']);

/**
 * The messages as the model is sent them, or undefined when nothing is folded: until a turn has ended and another has
 * begun, the messages go out as they are. A turn has ended once its memo was asked for and something came after the
 * request; a turn that ended without one (an error) is folded together with the next turn that has one.
 */
export function foldTurns(messages: readonly AgentMessage[]): AgentMessage[] | undefined {
  const requests = messages.flatMap((message, index) => isRequest(message) ? [index] : []);
  // The end of the last turn that can be folded: its request has an answer, and a new turn has begun after it.
  let end = -1;
  for (const request of requests) {
    const next = messages.findIndex((message, index) => index > request && message.role === 'user' && !isRequest(message));
    if (next < 0) break;
    end = next;
  }
  if (end < 0) return undefined;
  const folded: AgentMessage[] = [];
  const kept = new Set<string>();
  let start = 0;
  for (const request of requests) {
    if (request >= end) break;
    const next = messages.findIndex((message, index) => index > request && message.role === 'user' && !isRequest(message));
    folded.push(...foldTurn(messages.slice(start, request), messages.slice(request + 1, next), kept));
    start = next;
  }
  return [...folded, ...messages.slice(end)];
}

function isRequest(message: AgentMessage): boolean {
  return message.role === 'user' && isReflectionRequest(textOf(message.content));
}

/** One ended turn: its steps, then the answer to its memo request. `kept` holds every read already kept. */
function foldTurn(steps: AgentMessage[], answer: AgentMessage[], kept: Set<string>): AgentMessage[] {
  const results = new Map<string, ToolResult>();
  for (const message of steps) if (message.role === 'toolResult') results.set(message.toolCallId, message);
  const out: AgentMessage[] = [];
  for (const message of steps) {
    if (message.role === 'toolResult') continue;
    if (message.role !== 'assistant') { out.push(message); continue; }
    const calls = message.content.filter((block): block is Extract<Assistant['content'][number], { type: 'toolCall' }> =>
      block.type === 'toolCall' && KEPT_TOOLS.has(block.name) && results.get(block.id)?.isError === false);
    if (calls.length === 0) continue;
    // The reasoning a call was paired with is gone, so an ID that names the pairing keeps only the call's own part.
    out.push({ ...message, content: calls.map(block => ({ ...block, id: callId(block.id) })) });
    for (const block of calls) out.push(foldResult(results.get(block.id)!, block.arguments, kept));
  }
  const memo = answer.filter((message): message is Assistant => message.role === 'assistant').at(-1);
  const line = memo ? memoLine(textOf(memo.content)) : '';
  if (memo && line) out.push({ ...memo, content: [{ type: 'text', text: `${MEMO_HEADING}${line}` }] });
  return out;
}

function foldResult(result: ToolResult, args: Record<string, unknown>, kept: Set<string>): ToolResult {
  const base = { ...result, toolCallId: callId(result.toolCallId) };
  if (SENT_TOOLS.has(result.toolName)) return { ...base, content: [{ type: 'text', text: SENT }] };
  if (result.toolName !== 'read') return base;
  const path = typeof args.path === 'string' ? args.path : '';
  const key = `${path}\n${JSON.stringify(result.content)}`;
  if (!kept.has(key)) { kept.add(key); return base; }
  return { ...base, content: [{ type: 'text', text: ALREADY_READ(path) }] };
}

/** The memo as a fold keeps it: on one line, empty when it says there is nothing, and cut past the limit. */
export function memoLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (NOTHING.test(line)) return '';
  const characters = [...line];
  return characters.length <= MEMO_MAX_CHARS ? line : `${characters.slice(0, MEMO_MAX_CHARS).join('')}${MEMO_CUT}`;
}

const callId = (id: string) => id.split('|')[0]!;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (part as { type?: string; text?: string }).type === 'text' ? (part as { text: string }).text : '').join('');
}

/** What the extension asks the loop, before every model call and every tool call. */
export interface TurnFoldState {
  /** Whether ended turns are folded now. It changes only between turns. */
  folding(): boolean;
  /** Whether the model call in progress is the memo request, which may not use any tool. */
  reflecting(): boolean;
}

/** Refused while the memo is written: the tools stay declared, so the prefix does not move, but none runs. */
export const NO_TOOLS_WHILE_REFLECTING = 'ツールは使えません。振り返りのメモは、ツールを呼ばずに一行で書いてください。';

/** The fold and the refusal, as the one extension the loop gives Pi (ADR 0047). Nothing is recorded here. */
export function turnFoldExtension(state: TurnFoldState): ExtensionFactory {
  return pi => {
    pi.on('context', event => {
      if (!state.folding()) return undefined;
      const messages = foldTurns(event.messages);
      return messages ? { messages } : undefined;
    });
    pi.on('tool_call', () => state.reflecting() ? { block: true, reason: NO_TOOLS_WHILE_REFLECTING } : undefined);
  };
}
