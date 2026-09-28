import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { Appearance, Avatar } from './avatar.ts';
import { writeFileAtomically } from './paths.ts';

/**
 * What the server writes for the workspace from the avatar (ADR 0057), in the data directory's `avatar/`, which the
 * workspace sees read-only as `/manual/avatar`: the page on drawing and the sdctl params, which the workspace image's
 * `/etc/sdctl/config.yaml` names. Both are replaced whole on every start, as the list of agents is (ADR 0036).
 *
 * The page is `assets/manual/images.md` of the code with two marks filled in: `{{defaults}}`, the line on the model
 * and the size, from the params; and `{{self}}`, the section on her own look, from `appearance.yaml`.
 */

export const AVATAR_MANUAL_DIRECTORY = 'avatar';
export const IMAGES_PAGE = 'images.md';
export const SDCTL_PARAMS_FILE = 'sdctl-params.yaml';

/** `assets/manual/` beside `src/` in a checkout, and beside `dist/` in the image. */
const TEMPLATE_DIRECTORIES = ['../../assets/manual/', '../../../assets/manual/'].map(path => fileURLToPath(new URL(path, import.meta.url)));

/** The code's page on drawing, with its marks. */
export async function readImagesTemplate(): Promise<string> {
  for (const directory of TEMPLATE_DIRECTORIES) {
    try { return await readFile(join(directory, IMAGES_PAGE), 'utf8'); } catch { /* the other place */ }
  }
  throw new Error('the page on drawing (assets/manual/images.md) is missing from the code');
}

export function renderImagesPage(template: string, avatar: Avatar): string {
  return template.replace('{{defaults}}', () => defaultsLine(avatar.sdctlParams)).replace('{{self}}', () => selfSection(avatar.appearance));
}

/** Writes the page and the params into `directory` (the data directory's `avatar/`), group-readable and no more. */
export async function writeAvatarManual(directory: string, avatar: Avatar): Promise<void> {
  // Group-readable and no more: the workspace may run as another user of the shared group, and only reads them (ADR 0033).
  await writeFileAtomically(join(directory, IMAGES_PAGE), renderImagesPage(await readImagesTemplate(), avatar), 0o640);
  await writeFileAtomically(join(directory, SDCTL_PARAMS_FILE), avatar.sdctlParams, 0o640);
}

/** The model and the size the params draw with, and how to turn the picture the other way. */
function defaultsLine(params: string): string {
  let parsed: Record<string, any> = {};
  try { parsed = (parse(params) as Record<string, any>) ?? {}; } catch { /* checked when the avatar was read */ }
  const model = parsed.override_settings?.sd_model_checkpoint;
  const { width, height } = parsed;
  const named = typeof model === 'string' && model !== '' ? `モデル \`${model}\`` : undefined;
  if (typeof width !== 'number' || typeof height !== 'number') return named ? `- 既定は${named}。` : '- モデルと大きさは既定のままです。';
  const shape = width < height ? '縦長' : width > height ? '横長' : '正方形';
  const turned = width === height ? '' : `${width < height ? '横長' : '縦長'}は \`--width ${height} --height ${width}\`。`;
  return `- 既定は${named ? `${named}、` : ' '}${width}×${height}（${shape}）。${turned}`;
}

const HEADING = '## あなた自身の姿';

function selfSection(appearance: Appearance | undefined): string {
  if (!appearance) return `${HEADING}\n\nあなたの決まった姿はありません。あなたが入る絵は、頼まれたことや場面に合わせて、人物のタグを書きます。`;
  const { body, outfit, keep } = appearance;
  const lastBodyLine = body.split('\n').filter(line => line.trim() !== '').at(-1)!;
  const parts = [
    HEADING,
    `あなたが入る絵は、自撮りでなくても（気分や場面の絵、ほかの人と並ぶ絵でも）、先頭にこれを置きます${appearance.lora ? '（1 行目はあなたの LoRA）' : ''}。`,
    `\`\`\`\n${body}\n${outfit}\n\`\`\``,
    [`- **体の行**（\`${lastBodyLine}\` まで）は毎回そのまま写します。服を替えても、場面を文で書いても、${keep.length > 0 ? `${words(keep)} を消しません。` : '体の行を消しません。'}`,
      `- **服の行**（最後の行）だけを、頼まれた服や場面に合わせて替えます。指定が無ければ${appearance.outfitName ?? '上の服'}です。`].join('\n'),
  ];
  const checked = [...appearance.lora ? [appearance.lora] : [], ...keep];
  if (checked.length > 0) {
    parts.push('描く前に確かめます（何も出なければよい）:',
      `\`\`\`\nfor w in ${checked.map(quote).join(' ')}; do grep -q "$w" /work/prompts/me.yaml || echo "無い: $w"; done\n\`\`\``);
  }
  for (const example of appearance.examples) {
    parts.push(`${example.title}:`, `\`\`\`\nprompt: |\n${indent(body)}\n${indent(example.outfit)}\n${indent(example.scene)}\n\`\`\``);
  }
  return parts.join('\n\n');
}

/** `a`, `a` と `b`, `a`・`b` と `c`. */
function words(list: string[]): string {
  const quoted = list.map(word => `\`${word}\``);
  return quoted.length === 1 ? quoted[0]! : `${quoted.slice(0, -1).join('・')} と ${quoted.at(-1)}`;
}

/** A word for the shell: bare when it is plain, single-quoted otherwise. */
function quote(word: string): string {
  return /^[A-Za-z0-9._:-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Two spaces before every line that has anything on it, as a YAML block holds it. */
function indent(text: string): string {
  return text.split('\n').map(line => line === '' ? '' : `  ${line}`).join('\n');
}
