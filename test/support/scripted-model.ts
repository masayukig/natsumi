import type { AssistantMessage, AssistantMessageEvent, Context, JsonObject } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { getCurrentSystemPrompt } from '@earendil-works/pi-ai/utils/transcript';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { SUBSCRIPTION_TARGET } from '../../src/probe/session.ts';
import { REFLECTION_REQUEST } from '../../src/server/prompts.ts';

/** Carried by every failed reply. It must never reach a client. */
export const PRIVATE_DETAIL = 'synthetic private provider detail';

export interface ScriptedCall { name: string; arguments: Record<string, unknown> }

/** What one model call produces at once: hidden thinking, visible text (inner monologue) and tool calls, in that order. */
export interface ScriptedStep {
  thinking?: string; text?: string; calls?: ScriptedCall[]; finish?: 'stop' | 'length' | 'error';
  /** The tokens the reply reports, as a provider's usage does. Zero when omitted. */
  usage?: { input?: number; cacheRead?: number; output?: number };
}

/** A call that asked for the turn's memo (ADR 0047): answered by `memo`, and kept apart from the turn's calls. */
export interface ReflectionCall { context: Context; reasoning: string | undefined }

export interface ScriptedReply {
  context: Context;
  think(text: string): void;
  delta(text: string): void;
  call(name: string, args: Record<string, unknown>): void;
  /** Ends the reply. With tool calls a normal stop becomes `toolUse`. */
  finish(reason?: 'stop' | 'length' | 'error'): void;
}

type Block = AssistantMessage['content'][number];

/**
 * A synthetic model driven by the test: each model call waits until the test streams its content and finishes it.
 * With `auto` set, every call is answered at once with the returned step (a string is visible text).
 * An abort ends the reply as `aborted`.
 */
export class ScriptedModel {
  /**
   * The system prompt and the messages each call saw. Pi hands both over as one transcript; the system messages that
   * carry the prompt and the tool definitions are folded back into the prompt, and the tools are left out: they carry
   * functions.
   */
  readonly contexts: Context[] = [];
  /** The thinking level each call in `contexts` was made with; undefined when thinking was off. */
  readonly reasonings: (string | undefined)[] = [];
  auto: ((context: Context) => ScriptedStep | string) | undefined;
  /**
   * Every memo request the loop made after a turn. They are answered at once by `memo` and never counted in `calls`
   * nor handed out by `next()`, so a test about something else sees the turns it scripted and nothing more.
   */
  readonly reflections: ReflectionCall[] = [];
  memo: (context: Context) => ScriptedStep | string = () => 'メモ: 特になし';
  private readonly waiting: ((reply: ScriptedReply) => void)[] = [];
  private readonly pending: ScriptedReply[] = [];

  get calls(): number { return this.contexts.length; }

  /** Stops answering automatically and drops the calls already answered, so `next()` waits for a new one. */
  takeOver(): void {
    this.auto = undefined;
    this.pending.length = 0;
  }

  /** The next model call, including one that already happened and was not taken yet. */
  next(): Promise<ScriptedReply> {
    const ready = this.pending.shift();
    return ready ? Promise.resolve(ready) : new Promise(resolve => this.waiting.push(resolve));
  }

  readonly streamFunction: AgentSession['agent']['streamFunction'] = (_model, context, options) => {
    const seen: Context = { systemPrompt: getCurrentSystemPrompt(context.messages),
      messages: structuredClone(context.messages.filter(message => message.role !== 'system')) };
    const last = seen.messages.at(-1);
    const reflecting = last?.role === 'user' && (typeof last.content === 'string' ? last.content
      : last.content.map(part => part.type === 'text' ? part.text : '').join('')) === REFLECTION_REQUEST;
    if (reflecting) this.reflections.push({ context: seen, reasoning: options?.reasoning });
    else { this.contexts.push(seen); this.reasonings.push(options?.reasoning); }
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', api: 'openai-codex-responses', provider: SUBSCRIPTION_TARGET.provider,
      model: SUBSCRIPTION_TARGET.model, content: [], stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    let ended = false;
    let open: { kind: 'text' | 'thinking'; index: number } | undefined;
    const end = (event: AssistantMessageEvent) => { if (!ended) { ended = true; stream.push(event); } };
    const close = () => {
      if (!open) return;
      const block = message.content[open.index] as Block;
      if (open.kind === 'text' && block.type === 'text') stream.push({ type: 'text_end', contentIndex: open.index, content: block.text, partial: message });
      if (open.kind === 'thinking' && block.type === 'thinking') {
        stream.push({ type: 'thinking_end', contentIndex: open.index, content: block.thinking, partial: message });
      }
      open = undefined;
    };
    const append = (kind: 'text' | 'thinking', chunk: string) => {
      if (ended) return;
      if (open?.kind !== kind) {
        close();
        open = { kind, index: message.content.length };
        message.content.push(kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' });
        stream.push({ type: kind === 'text' ? 'text_start' : 'thinking_start', contentIndex: open.index, partial: message });
      }
      const block = message.content[open.index] as Block;
      if (block.type === 'text') block.text += chunk;
      if (block.type === 'thinking') block.thinking += chunk;
      stream.push({ type: kind === 'text' ? 'text_delta' : 'thinking_delta', contentIndex: open.index, delta: chunk, partial: message });
    };
    const fail = (reason: 'error' | 'aborted') => {
      message.stopReason = reason;
      message.errorMessage = PRIVATE_DETAIL;
      end({ type: 'error', reason, error: message });
    };
    stream.push({ type: 'start', partial: message });
    const reply: ScriptedReply = {
      context: seen,
      think: chunk => append('thinking', chunk),
      delta: chunk => append('text', chunk),
      call(name, args) {
        if (ended) return;
        close();
        const toolCall = { type: 'toolCall' as const, id: `call-${this.context.messages.length}-${message.content.length}`, name, arguments: args as JsonObject };
        const index = message.content.length;
        message.content.push(toolCall);
        stream.push({ type: 'toolcall_start', contentIndex: index, partial: message });
        stream.push({ type: 'toolcall_end', contentIndex: index, toolCall, partial: message });
      },
      finish(reason = 'stop') {
        if (ended) return;
        if (reason === 'error') { fail('error'); return; }
        close();
        const stopReason = reason === 'stop' && message.content.some(block => block.type === 'toolCall') ? 'toolUse' : reason;
        message.stopReason = stopReason;
        end({ type: 'done', reason: stopReason, message });
      },
    };
    if (options?.signal?.aborted) fail('aborted');
    else options?.signal?.addEventListener('abort', () => fail('aborted'), { once: true });
    const answering = reflecting ? this.memo : this.auto;
    if (answering) {
      const answer = answering(seen);
      const step: ScriptedStep = typeof answer === 'string' ? { text: answer } : answer;
      if (step.usage) {
        const { input = 0, cacheRead = 0, output = 0 } = step.usage;
        Object.assign(message.usage, { input, cacheRead, output, totalTokens: input + cacheRead + output });
      }
      if (step.thinking) reply.think(step.thinking);
      if (step.text) reply.delta(step.text);
      for (const call of step.calls ?? []) reply.call(call.name, call.arguments);
      reply.finish(step.finish ?? 'stop');
      if (reflecting) return stream;
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter(reply); else this.pending.push(reply);
    return stream;
  };
}
