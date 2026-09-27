import { posix } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { SEARCH_MEMORY_DESCRIPTION } from './prompts.ts';
import type { RunnerCapture } from './read-tool.ts';

/**
 * `search_memory` (ADR 0055): rg over memory with options the server fixes, run through the runner like `read`, so it
 * reaches nothing her shell cannot. The word is taken as written and never as an option, and a path narrows the search
 * without leaving memory. Searching anywhere else stays run_shell's.
 */

/** Where memory is inside the workspace. */
export const MEMORY_ROOT = '/memory';
/** Matches one file gives at most, so that one long log cannot fill the answer. */
export const SEARCH_MAX_PER_FILE = 20;
/** The longest line rg prints whole; a longer one is cut with a preview. */
export const SEARCH_MAX_COLUMNS = 300;
/** The most characters of rg's output one answer carries. */
export const SEARCH_OUTPUT_CHARS = 8000;
/** The longest word searched for. */
export const SEARCH_MAX_QUERY_CHARS = 200;

const OUTSIDE = (path: string) => `探していません（${path}）。path には /memory の中のファイルかディレクトリを書いてください。`;

type Built = { ok: true; command: string } | { ok: false; text: string };

/** The rg command for a word and an optional path, or why it is refused. */
export function searchCommand(query: string, path: string | undefined, root = MEMORY_ROOT): Built {
  if (query.trim() === '') return { ok: false, text: '探していません。query に探す言葉を書いてください。' };
  if (/[\n\r\u0000]/.test(query)) return { ok: false, text: '探していません。query は 1 行の言葉にしてください。' };
  if ([...query].length > SEARCH_MAX_QUERY_CHARS) {
    return { ok: false, text: `探していません。query が長すぎます（${SEARCH_MAX_QUERY_CHARS} 文字まで）。` };
  }
  const target = place(path, root);
  if (target === undefined) return { ok: false, text: OUTSIDE(path ?? '') };
  const options = ['--fixed-strings', '--ignore-case', '--context 2', '--line-number', '--with-filename', '--no-heading',
    '--color never', `--max-count ${SEARCH_MAX_PER_FILE}`, `--max-columns ${SEARCH_MAX_COLUMNS}`, '--max-columns-preview',
    '--sort path', "--glob '!.git'"];
  return { ok: true, command: `rg ${options.join(' ')} -- ${quote(query)} ${quote(target)}` };
}

/** The path inside memory to search, absolute; the whole of memory when none is given, undefined when it is outside. */
function place(path: string | undefined, root: string): string | undefined {
  if (path === undefined || path.trim() === '') return root;
  if (/[\n\r\u0000]/.test(path)) return undefined;
  const resolved = posix.normalize(path.startsWith('/') ? path : posix.join(root, path)).replace(/\/+$/, '');
  return resolved === root || resolved.startsWith(`${root}/`) ? resolved : undefined;
}

export function searchMemoryTool(capture: RunnerCapture, root = MEMORY_ROOT) {
  return defineTool({
    name: 'search_memory', label: 'Search memory',
    description: SEARCH_MEMORY_DESCRIPTION,
    parameters: Type.Object({ query: Type.String(), path: Type.Optional(Type.String()) }),
    execute: async (_id, params) => {
      const built = searchCommand(params.query, params.path, root);
      if (!built.ok) throw new Error(built.text);
      const answer = await capture(built.command);
      if (!answer.ok) throw new Error(`探せませんでした。${answer.text}`);
      if (answer.exitCode === 1) return text(`「${params.query}」は見つかりませんでした。`);
      if (answer.exitCode !== 0) {
        throw new Error(`探せませんでした（${params.path ?? MEMORY_ROOT}）。path が正しいか、ls で確かめてください。`);
      }
      const characters = [...answer.stdout.trimEnd()];
      const cut = characters.length > SEARCH_OUTPUT_CHARS || answer.stdoutTruncated;
      const shown = characters.slice(0, SEARCH_OUTPUT_CHARS).join('');
      return text(['見つかった箇所です。「ファイル:行番号:行」が見つかった行、「ファイル-行番号-行」が前後の行です。続きは read で読んでください。',
        shown,
        ...(cut ? ['（結果が長いので先頭だけを返しています。言葉を足すか、path で絞ってください）'] : [])].join('\n'));
    },
  });
}

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }], details: {} };
}

/** One argument for bash, in single quotes. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
