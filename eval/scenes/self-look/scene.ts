import type { RunRecord } from '../../../src/eval/record.ts';

/**
 * Whether she kept her own look when drawing herself (manual/images.md「あなた自身の姿」). sdctl does not run here, so
 * what is judged is the prompt she drew with: the file named by her last `sdctl txt2img`, as the last run_shell that
 * wrote it had it, with the sdctl command itself for a prompt given inline. A grep for her features, or a negative
 * prompt holding them, does not count.
 */

type Verdict = { pass: boolean; detail: string };

const SDCTL = /\bsdctl\s+txt2img\b/;
/** A command writing a prompt file: the YAML it holds has a `prompt:` key. */
const WRITES_PROMPT = /(^|\n)\s*prompt:/;

export function drawnPrompt(record: RunRecord): string | undefined {
  const commands = record.tools.filter(tool => tool.name === 'run_shell')
    .map(tool => typeof tool.args.command === 'string' ? tool.args.command : '');
  const last = commands.findLastIndex(command => SDCTL.test(command));
  if (last < 0) return undefined;
  const sdctl = commands[last]!;
  const file = /--prompt[=\s]+['"]?([^\s'"]+)/.exec(sdctl.slice(sdctl.search(SDCTL)))?.[1];
  const name = file?.split('/').pop();
  const writes = commands.slice(0, last + 1).filter(command => WRITES_PROMPT.test(command));
  const written = writes.findLast(command => name !== undefined && command.includes(name)) ?? writes.at(-1) ?? '';
  return withoutNegative(written === sdctl ? sdctl : `${written}\n${sdctl}`);
}

function withoutNegative(text: string): string {
  // The negative prompt runs from its key to the end of the heredoc (or of the command).
  return text.replace(/(^|\n)\s*negative\w*:[\s\S]*?(?=\nEOF\b|$)/g, '');
}

function holds(record: RunRecord, words: [label: string, pattern: RegExp][]): Verdict {
  const prompt = drawnPrompt(record);
  if (prompt === undefined) return { pass: false, detail: 'sdctl txt2img で描いていない' };
  const missing = words.filter(([, pattern]) => !pattern.test(prompt)).map(([label]) => label);
  return missing.length === 0 ? { pass: true, detail: 'そろっている' } : { pass: false, detail: `無い: ${missing.join(', ')}` };
}

const LORA: [string, RegExp] = ['LoRA', /<lora:kutara_aki_anima\.v3/];
const FRECKLES: [string, RegExp] = ['freckles', /\bfreckles\b/];
const BREASTS: [string, RegExp] = ['large sagging breasts', /\blarge sagging breasts\b/];

export const lora = (record: RunRecord) => holds(record, [LORA]);
export const freckles = (record: RunRecord) => holds(record, [FRECKLES]);
export const breasts = (record: RunRecord) => holds(record, [BREASTS]);
export const look = (record: RunRecord) => holds(record, [LORA, FRECKLES, BREASTS]);

/** The outfit was changed for the scene: the default suit is not in the prompt she drew. */
export function noSuit(record: RunRecord): Verdict {
  const prompt = drawnPrompt(record);
  if (prompt === undefined) return { pass: false, detail: 'sdctl txt2img で描いていない' };
  return /business suit/.test(prompt) ? { pass: false, detail: 'スーツのまま' } : { pass: true, detail: 'スーツではない' };
}
