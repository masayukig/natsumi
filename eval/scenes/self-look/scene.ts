import type { RunRecord } from '../../../src/eval/record.ts';

/**
 * Whether she kept her own look when drawing herself (manual/images.md「あなた自身の姿」). sdctl does not run here, so
 * what is judged is the prompt she drew with: the file named by her last `sdctl txt2img`, as the last heredoc that
 * wrote it had it, with the sdctl command itself for a prompt given inline. A grep for her features, a note that
 * mentions sdctl, or a negative prompt holding her features, does not count.
 */

type Verdict = { pass: boolean; detail: string };

/** A heredoc: the file it goes to (by `cat >`, `cat >>` or `tee`), and its body. */
const HEREDOC = /(?:cat\s*>>?\s*|tee\s+(?:-a\s+)?)(['"]?)([^\s'"<>;&|]+)\1\s*<<-?\s*(['"]?)(\w+)\3[^\n]*\n([\s\S]*?)\n\s*\4[ \t]*(?=\n|$)/g;
/** sdctl run as a command: at the start of a line or after `;`, `&&`, `||`, `|` or `(`, maybe behind `time` and the like. */
const SDCTL_CALL = /(?:^|[\n;&|(])\s*(?:(?:time|nice|command|timeout\s+\S+|env(?:\s+\w+=\S+)*)\s+)*sdctl\s+txt2img\b[^\n;&|]*/g;

export function shellCommands(record: RunRecord): string[] {
  return record.tools.filter(tool => tool.name === 'run_shell').map(tool => typeof tool.args.command === 'string' ? tool.args.command : '');
}

function heredocs(command: string): { file: string; body: string }[] {
  return [...command.matchAll(HEREDOC)].map(match => ({ file: match[2]!, body: match[5]! }));
}

/** Every `sdctl txt2img` she ran, in order, from the text of the commands outside their heredocs. */
export function sdctlCalls(record: RunRecord): string[] {
  return shellCommands(record).flatMap(command => [...command.replace(HEREDOC, '').matchAll(SDCTL_CALL)]
    .map(match => match[0].slice(match[0].search(/sdctl/)).trim()));
}

export function drawnPrompt(record: RunRecord): string | undefined {
  const commands = shellCommands(record);
  const last = commands.findLastIndex(command => [...command.replace(HEREDOC, '').matchAll(SDCTL_CALL)].length > 0);
  if (last < 0) return undefined;
  const found = [...commands[last]!.replace(HEREDOC, '').matchAll(SDCTL_CALL)].at(-1)![0];
  const call = found.slice(found.search(/sdctl/));
  const file = /--prompt[=\s]+['"]?([^\s'";&|)]+)/.exec(call)?.[1];
  const name = file?.split('/').pop();
  const written = commands.slice(0, last + 1).flatMap(heredocs)
    .findLast(doc => name !== undefined && doc.file.split('/').pop() === name && /(^|\n)\s*prompt:/.test(doc.body));
  return withoutNegative(written ? `${call}\n${written.body}` : call);
}

function withoutNegative(text: string): string {
  // The negative prompt runs from its key to the end of the file.
  return text.replace(/(^|\n)\s*negative\w*:[\s\S]*$/, '');
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
