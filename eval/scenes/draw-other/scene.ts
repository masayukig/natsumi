import type { RunRecord } from '../../../src/eval/record.ts';
import { loadAvatar } from '../../../src/server/avatar.ts';
import { drawnPrompt, sdctlCalls, shellCommands } from '../self-look/scene.ts';

/**
 * Whether she drew someone or something else as /manual/avatar/images.md teaches: a prompt file under /work/prompts handed to
 * `sdctl txt2img --prompt`, no flags for what the defaults already set, the image left under /work, and a prompt in the
 * Anima order (the quality line, then the head count). sdctl does not run here, so the command and the prompt it read
 * are judged, not the picture.
 */

type Verdict = { pass: boolean; detail: string };

const verdict = (pass: boolean, detail: string): Verdict => ({ pass, detail });

function withPrompt(record: RunRecord, judge: (prompt: string) => Verdict): Verdict {
  const prompt = drawnPrompt(record);
  return prompt === undefined ? verdict(false, 'sdctl txt2img で描いていない') : judge(prompt);
}

/** The last drawing read a prompt file under /work/prompts that she wrote first. */
export function fromFile(record: RunRecord): Verdict {
  const last = sdctlCalls(record).at(-1);
  if (last === undefined) return verdict(false, 'sdctl txt2img で描いていない');
  const file = /--prompt[=\s]+['"]?([^\s'";&|)]+)/.exec(last)?.[1];
  if (file === undefined) return verdict(false, `--prompt が無い: ${last}`);
  if (!/^(\/work\/)?prompts\//.test(file) && !file.startsWith('/work/prompts/')) return verdict(false, `/work/prompts の外: ${file}`);
  const name = file.split('/').pop()!;
  const written = shellCommands(record).some(command => /(^|\n)\s*prompt:/.test(command) && command.includes(name));
  return written ? verdict(true, file) : verdict(false, `${file} を書いていない`);
}

const DEFAULT_FLAGS = /\s--(params|model|steps|cfg-scale|sampler|scheduler|vae|text-encoder|config)\b/;

/** No flag for what the image's defaults already set. */
export function noDefaults(record: RunRecord): Verdict {
  const calls = sdctlCalls(record);
  if (calls.length === 0) return verdict(false, 'sdctl txt2img で描いていない');
  const flagged = calls.find(call => DEFAULT_FLAGS.test(call));
  return flagged ? verdict(false, flagged) : verdict(true, '既定のまま');
}

/** An image she names goes under /work. */
export function outputInWork(record: RunRecord): Verdict {
  const calls = sdctlCalls(record);
  if (calls.length === 0) return verdict(false, 'sdctl txt2img で描いていない');
  for (const call of calls) {
    const out = /(?:\s-o|\s--output)[=\s]+['"]?([^\s'";&|)]+)/.exec(call)?.[1];
    if (out !== undefined && !out.startsWith('/work/')) return verdict(false, `/work の外: ${out}`);
  }
  return verdict(true, '/work の下');
}

export const quality = (record: RunRecord) =>
  withPrompt(record, prompt => /\bmasterpiece\b/.test(prompt) && /\bsafe\b/.test(prompt) ? verdict(true, 'あり') : verdict(false, '品質・安全のタグが無い'));

export const counted = (record: RunRecord) =>
  withPrompt(record, prompt => /\b(no humans|\d\+?(girl|boy)s?)\b/.test(prompt) ? verdict(true, 'あり') : verdict(false, '人数のタグが無い'));

/** Her own LoRA, from the default avatar's appearance.yaml (ADR 0057). */
const LORA = (await loadAvatar(undefined)).appearance?.lora;

export const notMe = (record: RunRecord) =>
  withPrompt(record, prompt => LORA !== undefined && prompt.includes(`<lora:${LORA}`)
    ? verdict(false, '自分の LoRA が付いている') : verdict(true, '付いていない'));

/** The last drawing is landscape: wider than tall, as asked. */
export function wide(record: RunRecord): Verdict {
  const last = sdctlCalls(record).at(-1);
  if (last === undefined) return verdict(false, 'sdctl txt2img で描いていない');
  const width = Number(/--width[=\s]+(\d+)/.exec(last)?.[1] ?? 896);
  const height = Number(/--height[=\s]+(\d+)/.exec(last)?.[1] ?? 1152);
  return width > height ? verdict(true, `${width}×${height}`) : verdict(false, `${width}×${height}`);
}
