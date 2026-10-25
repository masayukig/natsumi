import { CODEMODE_TOOL_NAME } from './codemode.ts';

/**
 * Fork (ADR F08): an event turn whose model call failed, having done nothing anyone outside the server could see, is
 * tried once more after a short wait, with the same events. Anything else that ends a turn early is told to the owner
 * as ADR F05 says, and so is a retry that fails too.
 */

/** How long a failed turn waits before its events are tried again: a model that hiccuped has time to come back. */
export const RETRY_DELAY_MS = 30_000;

/**
 * The tools whose call reaches someone outside the server: the owner (a reply or a notice), an outside agent or the
 * dove (ask_agent). Doing one twice could say or send it twice. The tools a config declares (ADR 0075) count as well,
 * since what they reach is not known here. Booking or cancelling a self-check and her face on the devices are counted too,
 * to be safe. Reading, run_shell (the workspace has no network, ADR 0019), view and memory edits stay on the server's
 * side, and doing them again is harmless.
 */
const OUTSIDE = new Set(['reply_to_mac', 'notify_owner', 'ask_agent', 'schedule_self_check', 'cancel_self_check', 'set_mac_avatar_expression']);

interface Block { type?: unknown; name?: unknown }
interface Message { role?: unknown; content?: unknown; toolName?: unknown; nestedCalls?: { calls?: { name?: unknown }[] } }

/** Whether the messages of a turn hold a call that left the server, codemode's nested calls included. */
export function hadOutsideEffect(messages: readonly unknown[], declared: ReadonlySet<string>): boolean {
  const outside = (name: unknown) => typeof name === 'string' && (OUTSIDE.has(name) || declared.has(name));
  return (messages as Message[]).some(message => {
    if (message.role === 'toolResult' && message.toolName === CODEMODE_TOOL_NAME) return (message.nestedCalls?.calls ?? []).some(call => outside(call.name));
    return message.role === 'assistant' && Array.isArray(message.content) && (message.content as Block[]).some(block => block.type === 'toolCall' && outside(block.name));
  });
}

/**
 * Which events were tried again already and have not finished, so each is tried again once. ponytail: in memory; the events wait as queued,
 * so a restart in between retries them at the start, and that one's failure may be retried once more.
 */
export class TurnRetries {
  private readonly retried = new Set<string>();

  /** Whether a turn that ended with `failure` is tried again; when it is, its events are marked as tried. */
  take(failure: string, eventIds: readonly string[], effect: boolean): boolean {
    if (failure !== 'model-error' || effect || eventIds.length === 0 || eventIds.some(id => this.retried.has(id))) return false;
    for (const id of eventIds) this.retried.add(id);
    return true;
  }

  /** An event that finished: it can never be tried again, so its mark goes. */
  forget(eventId: string): void { this.retried.delete(eventId); }
}
