import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { DeclaredToolConfig } from './config.ts';
import type { ToolOutcome } from './loop-tools.ts';

/**
 * The tools an instance declares in its config (ADR 0075). Nothing here is code from outside: each is a definition the
 * server builds from the declaration, and its call is one request to the workspace runner, which starts the program
 * under /tools with the model's arguments on stdin. The description and the parameters go to the model as they were
 * written, so they sit on the prefix like any other tool's and move only when the config does.
 */

/**
 * Kept with every result of a declared tool, so the record says which calls were to one even after the config has
 * changed: the dashboard marks them by it.
 */
export const DECLARED_TOOL_DETAILS = { declared: true } as const;

/** Runs one declared tool with its arguments, already as the JSON its program reads on stdin. */
export type DeclaredToolRun = (tool: DeclaredToolConfig, input: string) => Promise<ToolOutcome>;

/**
 * The definitions of the declared tools, in the order they were declared. Their exposure is Codemode's to give, as it
 * gives the others' (see `withCodemode`).
 */
export function createDeclaredTools(tools: readonly DeclaredToolConfig[], run: DeclaredToolRun) {
  return tools.map(tool => defineTool({
    name: tool.name, label: tool.name,
    description: tool.description,
    // Checked at start to the types every provider takes; Pi checks a call against it as it does a TypeBox schema.
    parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters),
    execute: async (_id, params) => {
      const outcome = await run(tool, JSON.stringify(params ?? {}));
      // A failure is returned rather than thrown, so the record keeps the details that mark it as a declared tool's.
      return { content: [{ type: 'text' as const, text: outcome.text }], details: DECLARED_TOOL_DETAILS,
        ...(outcome.ok ? {} : { isError: true }) };
    },
  }));
}
