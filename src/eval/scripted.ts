import type { AssistantMessage, AssistantMessageEvent, JsonObject } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AgentSession } from '@earendil-works/pi-coding-agent';

type StreamFunction = AgentSession['agent']['streamFunction'];
type Model = Parameters<StreamFunction>[0];
type Options = Parameters<StreamFunction>[2];

/** One answer of the model, written ahead: hidden thinking, visible text, then tool calls. */
export interface Answer { thinking?: string; text?: string; calls?: { tool: string; args: Record<string, unknown> }[] }

let counter = 0;

/**
 * A model call answered with `answer` at once, streamed as a provider would stream it (ADR 0051). It stands in for the
 * model where the answer is known: the turns before the evaluated one, the memo after it, and every call of a dry run.
 * No usage is reported, so these calls weigh nothing in the numbers.
 */
export function scriptedStream(model: Model, answer: Answer, options?: Options): ReturnType<StreamFunction> {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [],
    stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  if (options?.signal?.aborted) {
    message.stopReason = 'aborted';
    stream.push({ type: 'error', reason: 'aborted', error: message });
    return stream;
  }
  const push = (event: AssistantMessageEvent) => stream.push(event);
  push({ type: 'start', partial: message });
  for (const [kind, value] of [['thinking', answer.thinking], ['text', answer.text]] as const) {
    if (!value) continue;
    const index = message.content.length;
    if (kind === 'thinking') {
      message.content.push({ type: 'thinking', thinking: value });
      push({ type: 'thinking_start', contentIndex: index, partial: message });
      push({ type: 'thinking_delta', contentIndex: index, delta: value, partial: message });
      push({ type: 'thinking_end', contentIndex: index, content: value, partial: message });
    } else {
      message.content.push({ type: 'text', text: value });
      push({ type: 'text_start', contentIndex: index, partial: message });
      push({ type: 'text_delta', contentIndex: index, delta: value, partial: message });
      push({ type: 'text_end', contentIndex: index, content: value, partial: message });
    }
  }
  for (const call of answer.calls ?? []) {
    const index = message.content.length;
    const toolCall = { type: 'toolCall' as const, id: `scripted-${++counter}`, name: call.tool, arguments: call.args as JsonObject };
    message.content.push(toolCall);
    push({ type: 'toolcall_start', contentIndex: index, partial: message });
    push({ type: 'toolcall_end', contentIndex: index, toolCall, partial: message });
  }
  const reason = (answer.calls ?? []).length > 0 ? 'toolUse' : 'stop';
  message.stopReason = reason;
  push({ type: 'done', reason, message });
  return stream;
}
