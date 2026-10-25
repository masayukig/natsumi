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
 * The page is `assets/manual/images.md` of the code with three marks filled in: `{{defaults}}`, the line on the model
 * and the size, from the params; `{{prompting}}`, the section on writing a prompt for the family of that model; and
 * `{{self}}`, the section on her own look, from `appearance.yaml`. The page is shared by every avatar and their models
 * differ, so what is one family's own way of writing stays out of the template.
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
  const params = parseParams(avatar.sdctlParams);
  return template.replace('{{defaults}}', () => defaultsLine(params)).replace('{{prompting}}', () => promptingSection(params))
    .replace('{{self}}', () => selfSection(avatar.appearance));
}

/** Writes the page and the params into `directory` (the data directory's `avatar/`), group-readable and no more. */
export async function writeAvatarManual(directory: string, avatar: Avatar): Promise<void> {
  // Group-readable and no more: the workspace may run as another user of the shared group, and only reads them (ADR 0033).
  await writeFileAtomically(join(directory, IMAGES_PAGE), renderImagesPage(await readImagesTemplate(), avatar), 0o640);
  await writeFileAtomically(join(directory, SDCTL_PARAMS_FILE), avatar.sdctlParams, 0o640);
}

function parseParams(params: string): Record<string, any> {
  try { return (parse(params) as Record<string, any>) ?? {}; } catch { return {}; /* checked when the avatar was read */ }
}

/** The checkpoint the params select with each request, if they name one. */
function modelOf(params: Record<string, any>): string | undefined {
  const model = params.override_settings?.sd_model_checkpoint;
  return typeof model === 'string' && model !== '' ? model : undefined;
}

/** The model and the size the params draw with, and how to turn the picture the other way. */
function defaultsLine(params: Record<string, any>): string {
  const model = modelOf(params);
  const { width, height } = params;
  const named = model ? `モデル \`${model}\`` : undefined;
  if (typeof width !== 'number' || typeof height !== 'number') return named ? `- 既定は${named}。` : '- モデルと大きさは既定のままです。';
  const shape = width < height ? '縦長' : width > height ? '横長' : '正方形';
  const turned = width === height ? '' : `${width < height ? '横長' : '縦長'}は \`--width ${height} --height ${width}\`。`;
  return `- 既定は${named ? `${named}、` : ' '}${width}×${height}（${shape}）。${turned}`;
}

/**
 * How to write a prompt for each family, by the prefix of the model's name (sdctl's skill names the families so, in
 * its `docs/config.md`). Each says it whole, so that an instance without the owner's skills can draw from this page.
 */
const FAMILIES: { prefix: string, name: string, body: string }[] = [
  { prefix: 'anima_', name: 'Anima', body: `英語で、上から 品質・安全 → 人数（人がいなければ \`no humans\`）→ 場面を 1 文 → 人物のタグ → 構図 → 背景と光 の順に書きます。

\`\`\`
mkdir -p /work/prompts
cat > /work/prompts/cat.yaml <<'EOF'
prompt: |
  masterpiece, best quality, newest, safe,
  no humans,
  A white cat is sleeping on a sunny windowsill.
  cat, white fur, sleeping, curled up,
  indoors, windowsill, sunlight
EOF
\`\`\`

- プロンプトのタグは小文字、単語はスペースで区切ります。2 人以上なら、\`On the left,\` のような位置の言葉で人ごとに分けます。文では \`she\` でなく \`the girl\` と書きます。
- 強めたい語は \`(smile:1.5)\`。
- skill の一覧に \`anima-prompt\` があれば、もっと詳しい書き方を調べるのに読んでかまいません。` },
  { prefix: 'moss-image_', name: 'MOSS-Image', body: `英語で書きます。1 人の人物ならタグを並べ、場面や風景なら文で書きます。文なら 画風・媒体 → 描くものと動き → 見た目と服 → 場所 → 光・色・雰囲気 の順です。

\`\`\`
mkdir -p /work/prompts
cat > /work/prompts/cat.yaml <<'EOF'
prompt: |
  A soft anime illustration with beautiful anime-style coloring.
  A white cat is sleeping curled up on a sunny windowsill.
  Indoors, warm sunlight through the window.
EOF
\`\`\`

- 画風・媒体（\`anime illustration\`・\`beautiful anime-style coloring\`・\`photograph\` など）を必ず書きます。書かないと、ピクセルアートのような絵にぶれます。
- 品質のタグは無くてかまいません。付けるなら \`best quality, highres\` までです。
- 重み \`(x:1.2)\`・\`BREAK\`・括弧の \`\\(\` は使いません。効かず、文字のまま渡ります。強めたいことは言葉で書きます。\`[a:b:数字]\` の形の文字列も書きません（別の意味に読み替えられます）。
- 書かなかったところはモデルが決めます。全身を描くなら、下の服と靴まで書きます。
- 2 人以上なら、\`On the left,\` のような位置の言葉で人ごとに分け、人ごとに見た目・服・動きを書きます。
- 絵の中に文字を描くなら、その文字を引用符で囲んで原文どおりに書きます（\`"MOONLIGHT COFFEE"\`）。書体・色・置き場所も書きます。
- \`negative_prompt\` は書きません。MOSS-Image では空が勧められています。
- skill の一覧に \`moss-prompt\` があれば、もっと詳しい書き方を調べるのに読んでかまいません。` },
];

const PROMPTING = '## プロンプトの書き方';

/** For a family the page does not know, or no model named: plain English, and nothing that only some models take. */
const UNKNOWN_FAMILY = `英語で、描くもの・場所・光を、短い文とタグで書きます。

\`\`\`
mkdir -p /work/prompts
cat > /work/prompts/cat.yaml <<'EOF'
prompt: |
  A white cat is sleeping on a sunny windowsill.
  cat, white fur, sleeping, curled up, indoors, sunlight
EOF
\`\`\`

- 重み \`(x:1.2)\` のような、モデルによって効いたり効かなかったりする書き方は使いません。
- skill の一覧に \`sd-generate\` があれば、その \`docs/config.md\` でモデルの名前から系統を確かめ、書き方を調べてかまいません。`;

/** The family's way of writing, after the line naming the model and its family. */
function promptingSection(params: Record<string, any>): string {
  const model = modelOf(params);
  const family = model ? FAMILIES.find(({ prefix }) => model.startsWith(prefix)) : undefined;
  if (family) return `${PROMPTING}（${family.name}）\n\n既定のモデル \`${model}\` は ${family.name} の系統です。\n\n${family.body}`;
  const lead = model ? `既定のモデル \`${model}\` の系統の書き方は、このページにはありません。`
    : '既定の params にモデルの名前がありません。絵は、画像生成サーバーがいま読み込んでいるモデルで描かれます。';
  return `${PROMPTING}\n\n${lead}\n\n${UNKNOWN_FAMILY}`;
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
