import type { ImageContent } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { workspaceReadTool, type RunnerCapture } from './read-tool.ts';
import { ASK_AGENT_DESCRIPTION, CANCEL_SELF_CHECK_DESCRIPTION, LIST_SELF_CHECKS_DESCRIPTION,
  NOTIFY_OWNER_DESCRIPTION, REPLY_TO_MAC_DESCRIPTION, RUN_SHELL_DESCRIPTION, SCHEDULE_SELF_CHECK_DESCRIPTION,
  SET_MAC_AVATAR_EXPRESSION_DESCRIPTION, WRITE_CHANGE_NOTE_DESCRIPTION,
  WRITE_HANDOFF_NOTE_DESCRIPTION } from './prompts.ts';

/** The avatar expressions the Mac can show. The model picks from these only. */
export const EXPRESSIONS = ['neutral', 'happy', 'laughing', 'surprised', 'thinking', 'worried', 'sad', 'sleepy'] as const;
export type Expression = typeof EXPRESSIONS[number];

/**
 * A tool call's effect as a sentence the model reads. `ok: false` means nothing was sent or changed. `images` go into
 * the result beside the sentence, as `view` answers (ADR 0039).
 */
export interface ToolOutcome { ok: boolean; text: string; images?: ImageContent[] }

type Outcome = ToolOutcome | Promise<ToolOutcome>;

/**
 * What the tools act on. Every check happens here, on the server, not in the tool description. No tool names an
 * event: what a tool acts on is what the turn is handling, which the server knows and natsumi need not copy (ADR 0024).
 */
export interface LoopToolHost {
  /**
   * A line carries the feeling natsumi chose for it; it is kept with the line and never moves the avatar (ADR 0026).
   * A reply may carry images from /work, as the workspace names them (ADR 0045); a notice never does.
   */
  reply(text: string, expression: Expression, images?: string[]): Outcome;
  notify(text: string, expression: Expression): Outcome;
  setExpression(expression: Expression): Outcome;
  writeHandoff(text: string): Outcome;
  writeChangeNote(text: string): Outcome;
  scheduleSelfCheck(reason: string, when: { inMinutes?: number; at?: string }): Outcome;
  listSelfChecks(): Outcome;
  cancelSelfCheck(checkId: string): Outcome;
  /** Always present, whether or not any agent is configured, so the tool list never moves with the config (ADR 0036). */
  askAgent(agent: string, message: string, goOn: boolean): Outcome;
  /** Present only when the workspace container's runner is configured (ADR 0019). */
  runShell?(command: string): Outcome;
  /** The runner's raw answer, for `read` (ADR 0047). Present exactly when `runShell` is. */
  capture?: RunnerCapture;
}

/**
 * The allowlist given to Pi (ADR 0004, ADR 0008, ADR 0009, ADR 0014, ADR 0024, ADR 0035). Pi's own bash/edit/write stay
 * disabled: the only shell is `run_shell`, and it runs in the workspace container, never here. Pi's read is given only
 * pointed at the workspace, through the runner, and only at /manual and /memory (ADR 0047). There is no tool to
 * end a turn with: a turn ends when natsumi stops without calling one (ADR 0024).
 */
export const LOOP_TOOL_NAMES = ['reply_to_mac', 'notify_owner', 'set_mac_avatar_expression',
  'write_handoff_note', 'write_change_note', 'schedule_self_check', 'list_self_checks', 'cancel_self_check', 'ask_agent'];
/** Added to the allowlist with a runner: the whole of natsumi's workspace, memory included (ADR 0019). */
export const RUN_SHELL_TOOL_NAME = 'run_shell';
/** Pi's own read, added with a runner and pointed at /manual and /memory in the workspace (ADR 0047). */
export const READ_TOOL_NAME = 'read';

/**
 * The expressions as a parameter. The avatar and every line share this one list, so an expression added to the Mac is
 * one a line can carry too (ADR 0026). Pi checks a call against it and refuses a missing or unknown value before the
 * host is reached, so nothing is sent.
 */
const expressionParameter = () => Type.Union(EXPRESSIONS.map(expression => Type.Literal(expression)));

async function result(outcome: Outcome) {
  const settled = await outcome;
  // A thrown error becomes an error tool result carrying this sentence.
  if (!settled.ok) throw new Error(settled.text);
  return { content: [{ type: 'text' as const, text: settled.text }, ...settled.images ?? []], details: {} };
}

export function createLoopTools(host: LoopToolHost) {
  const shell = host.runShell?.bind(host);
  return [
    ...(shell ? [defineTool({
      name: RUN_SHELL_TOOL_NAME, label: 'Work in the workspace',
      description: RUN_SHELL_DESCRIPTION,
      parameters: Type.Object({ command: Type.String() }),
      execute: async (_id, params) => result(shell(params.command)),
    })] : []),
    defineTool({
      name: 'reply_to_mac', label: 'Reply to the owner',
      description: REPLY_TO_MAC_DESCRIPTION,
      parameters: Type.Object({ text: Type.String(), expression: expressionParameter(), images: Type.Optional(Type.Array(Type.String())) }),
      execute: async (_id, params) => result(host.reply(params.text, params.expression as Expression, params.images)),
    }),
    defineTool({
      name: 'notify_owner', label: 'Notify the owner',
      description: NOTIFY_OWNER_DESCRIPTION,
      parameters: Type.Object({ text: Type.String(), expression: expressionParameter() }),
      execute: async (_id, params) => result(host.notify(params.text, params.expression as Expression)),
    }),
    defineTool({
      name: 'set_mac_avatar_expression', label: 'Set the avatar expression',
      description: SET_MAC_AVATAR_EXPRESSION_DESCRIPTION(EXPRESSIONS),
      parameters: Type.Object({ expression: expressionParameter() }),
      execute: async (_id, params) => result(host.setExpression(params.expression as Expression)),
    }),
    defineTool({
      name: 'write_handoff_note', label: 'Write the handoff note',
      description: WRITE_HANDOFF_NOTE_DESCRIPTION,
      parameters: Type.Object({ text: Type.String() }),
      execute: async (_id, params) => result(host.writeHandoff(params.text)),
    }),
    defineTool({
      name: 'write_change_note', label: 'Write the change note',
      description: WRITE_CHANGE_NOTE_DESCRIPTION,
      parameters: Type.Object({ text: Type.String() }),
      execute: async (_id, params) => result(host.writeChangeNote(params.text)),
    }),
    defineTool({
      name: 'schedule_self_check', label: 'Book a self-check',
      description: SCHEDULE_SELF_CHECK_DESCRIPTION,
      parameters: Type.Object({ reason: Type.String(), in_minutes: Type.Optional(Type.Number()), at: Type.Optional(Type.String()) }),
      execute: async (_id, params) => result(host.scheduleSelfCheck(params.reason, {
        ...(params.in_minutes === undefined ? {} : { inMinutes: params.in_minutes }), ...(params.at === undefined ? {} : { at: params.at }),
      })),
    }),
    defineTool({
      name: 'list_self_checks', label: 'List self-checks',
      description: LIST_SELF_CHECKS_DESCRIPTION,
      parameters: Type.Object({}),
      execute: async () => result(host.listSelfChecks()),
    }),
    defineTool({
      name: 'cancel_self_check', label: 'Cancel a self-check',
      description: CANCEL_SELF_CHECK_DESCRIPTION,
      parameters: Type.Object({ check_id: Type.String() }),
      execute: async (_id, params) => result(host.cancelSelfCheck(params.check_id)),
    }),
    // Last, so that adding it left every definition before it where it was on the prefix.
    defineTool({
      name: 'ask_agent', label: 'Ask an outside agent',
      description: ASK_AGENT_DESCRIPTION,
      parameters: Type.Object({ agent: Type.String(), message: Type.String(), continue: Type.Boolean() }),
      execute: async (_id, params) => result(host.askAgent(params.agent, params.message, params.continue)),
    }),
    // After ask_agent for the same reason: every definition before it stays where it was on the prefix (ADR 0047).
    ...(host.capture ? [workspaceReadTool(host.capture)] : []),
  ];
}
