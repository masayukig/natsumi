import { createCodemodeExtension, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { CodemodeConfig, ToolExposure } from './config.ts';
import { READ_TOOL_NAME, RUN_SHELL_TOOL_NAME, SEARCH_MEMORY_TOOL_NAME } from './loop-tools.ts';

/** Pi's name for the tool that runs a script (ADR 0066). */
export const CODEMODE_TOOL_NAME = 'codemode';
/**
 * The built-in tools a script can call: the workspace's. Every other built-in tool is for the model to call itself
 * (ADR 0066); a tool the config declares is reached as it declares (ADR 0075).
 */
export const WORKSPACE_TOOL_NAMES: ReadonlySet<string> = new Set([RUN_SHELL_TOOL_NAME, READ_TOOL_NAME, SEARCH_MEMORY_TOOL_NAME]);

/** Refused once the scripts of a turn have made as many calls as they may. */
export const NESTED_CALL_LIMIT = (limit: number) =>
  `このターンでスクリプトから呼べる回数（${limit} 回）を使い切りました。この呼び出しはしていません。`;

/** The calls the scripts of the turn under way have made. Whoever runs the turn starts it at zero. */
export interface NestedCallCount { nestedCalls: number }

type Tool = { name: string };

/** A session's tools and extensions, as `openPiSession` takes them. */
export interface CodemodeTools<T extends Tool> {
  tools: { names: string[]; definitions: T[]; declared?: string[] };
  extensions: ExtensionFactory[];
}

/**
 * The tools of a session with Codemode as configured (ADR 0066). Off, or with no workspace tool for a script to call,
 * the tools come back as they were given and no extension is added, so nothing on the prefix moves. On, `codemode` is
 * added after every other tool; the workspace tools are reached as configured, the tools the config declares as each
 * declares in `exposures` (ADR 0075), and every other tool is the model's alone (`model-only`): what reaches the owner
 * or anyone outside never depends on a script's branches. Pi's `models` are not handed to scripts. `turn` gives the
 * count of the turn under way, or nothing between turns.
 */
export function withCodemode<T extends Tool>(tools: T[], config: CodemodeConfig, turn: () => NestedCallCount | undefined,
  exposures: ReadonlyMap<string, ToolExposure> = new Map()): CodemodeTools<T> {
  const names = tools.map(tool => tool.name);
  if (!config.enabled || !tools.some(tool => WORKSPACE_TOOL_NAMES.has(tool.name))) return { tools: { names, definitions: tools }, extensions: [] };
  const exposureOf = (name: string): ToolExposure =>
    WORKSPACE_TOOL_NAMES.has(name) ? config.workspaceTools : exposures.get(name) ?? 'model-only';
  const definitions = tools.map(tool => ({ ...tool, exposure: exposureOf(tool.name) }));
  const scriptsOnly = new Set(names.filter(name => exposureOf(name) === 'codemode'));
  return {
    tools: {
      names: [...names, CODEMODE_TOOL_NAME], definitions,
      // A tool named in the allowlist is declared even when its exposure says otherwise, so the declared ones are
      // given apart.
      ...(scriptsOnly.size > 0 ? { declared: [...names.filter(name => !scriptsOnly.has(name)), CODEMODE_TOOL_NAME] } : {}),
    },
    extensions: [createCodemodeExtension({ mode: 'on', models: false }), nestedCallLimit(config.nestedCalls, turn)],
  };
}

/**
 * Counts the calls scripts make — the ones Pi marks with the script's call as their parent — and refuses those past
 * the limit. The model's own calls are limited as they always were (ADR 0008).
 */
function nestedCallLimit(limit: number, turn: () => NestedCallCount | undefined): ExtensionFactory {
  return pi => {
    pi.on('tool_call', event => {
      if (event.parentToolCallId === undefined) return undefined;
      const count = turn();
      if (!count) return { block: true, reason: NESTED_CALL_LIMIT(limit) };
      count.nestedCalls += 1;
      return count.nestedCalls > limit ? { block: true, reason: NESTED_CALL_LIMIT(limit) } : undefined;
    });
  };
}
