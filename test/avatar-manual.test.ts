import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { loadAvatar } from '../src/server/avatar.ts';
import { AVATAR_MANUAL_DIRECTORY, IMAGES_PAGE, readImagesTemplate, renderImagesPage, SDCTL_PARAMS_FILE,
  writeAvatarManual } from '../src/server/avatar-manual.ts';

/**
 * What the server writes for the workspace from the avatar (ADR 0057): the page on drawing, with her own look and the
 * defaults of the params put in, and the params themselves. With natsumi, the fixture records her current drawing contract.
 */

const FIXTURES = join(import.meta.dirname, 'fixtures', 'avatar');

async function scratch(fn: (dir: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-avatar-manual-')));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('with natsumi, the page on drawing is word for word her current drawing contract', async () => {
  const page = renderImagesPage(await readImagesTemplate(), await loadAvatar(undefined));
  assert.equal(page, await readFile(join(FIXTURES, 'natsumi-images.md'), 'utf8'));
});

test('with natsumi, the params select Anima 2.9B and its modules', async () => {
  const avatar = await loadAvatar(undefined);
  const params = parse(avatar.sdctlParams);
  assert.equal(params.override_settings.sd_model_checkpoint, 'anima_2_9_Anima-2.9B-preview-v1');
  assert.deepEqual(params.override_settings.forge_additional_modules,
    ['qwen_image_vae.safetensors', 'qwen_3_06b_base.safetensors']);
});

test('an avatar without a look of its own is told so, and nothing of natsumi\'s look is left in', () => scratch(async root => {
  const dir = join(root, 'hana');
  await mkdir(dir);
  await writeFile(join(dir, 'avatar.json'), JSON.stringify({ id: 'hana', name: 'はな' }));
  const page = renderImagesPage(await readImagesTemplate(), await loadAvatar({ directory: dir }));
  assert.match(page, /## あなた自身の姿\n\n/);
  assert.match(page, /決まった姿/);
  for (const word of ['kutara', 'freckles', 'sagging', 'business suit', '{{']) assert.ok(!page.includes(word), word);
  assert.match(page, /- 既定はモデル `anima_mignolia_v10`、896×1152（縦長）。横長は `--width 1152 --height 896`。/);
}));

test('the look, the checks and the examples come from appearance.yaml', () => scratch(async root => {
  const dir = join(root, 'hana');
  await mkdir(dir);
  await writeFile(join(dir, 'avatar.json'), JSON.stringify({ id: 'hana', name: 'はな' }));
  await writeFile(join(dir, 'appearance.yaml'), [
    'body: |',
    '  masterpiece,',
    '  girl, red hair, cat ears,',
    'outfit: school uniform,',
    'keep: [red hair, cat ears, green eyes]',
    'examples:',
    '  - title: 雨の日',
    '    outfit: raincoat,',
    '    scene: |',
    '      1girl, solo,',
    '      outdoors, rain',
    '',
  ].join('\n'));
  const page = renderImagesPage(await readImagesTemplate(), await loadAvatar({ directory: dir }));
  assert.ok(page.includes('先頭にこれを置きます。\n\n```\nmasterpiece,\ngirl, red hair, cat ears,\nschool uniform,\n```'), page);
  assert.ok(page.includes('- **体の行**（`girl, red hair, cat ears,` まで）は毎回そのまま写します。'), page);
  assert.ok(page.includes('`red hair`・`cat ears` と `green eyes` を消しません。'), page);
  assert.ok(page.includes('指定が無ければ上の服です。'), page);
  assert.ok(page.includes(`for w in 'red hair' 'cat ears' 'green eyes'; do grep -q "$w" /work/prompts/me.yaml || echo "無い: $w"; done`), page);
  assert.ok(page.includes('雨の日:\n\n```\nprompt: |\n  masterpiece,\n  girl, red hair, cat ears,\n  raincoat,\n  1girl, solo,\n  outdoors, rain\n```'), page);
  assert.ok(!page.includes('LoRA'), page);
}));

test('the size line follows the params: a landscape default says how to draw portrait', () => scratch(async root => {
  const dir = join(root, 'hana');
  await mkdir(dir);
  await writeFile(join(dir, 'avatar.json'), JSON.stringify({ id: 'hana', name: 'はな' }));
  await writeFile(join(dir, 'sdctl-params.yaml'), 'width: 1216\nheight: 832\n');
  const page = renderImagesPage(await readImagesTemplate(), await loadAvatar({ directory: dir }));
  assert.match(page, /- 既定は 1216×832（横長）。縦長は `--width 832 --height 1216`。/);
}));

/** The page for an avatar named `hana` whose only file beside avatar.json is the given params. */
async function pageWithParams(root: string, params: string): Promise<string> {
  const dir = join(root, 'hana');
  await mkdir(dir);
  await writeFile(join(dir, 'avatar.json'), JSON.stringify({ id: 'hana', name: 'はな' }));
  await writeFile(join(dir, 'sdctl-params.yaml'), params);
  return renderImagesPage(await readImagesTemplate(), await loadAvatar({ directory: dir }));
}

/** MOSS-Image SFT's params as an environment gives them (its recommended settings, a portrait 896×1152). */
const MOSS_PARAMS = [
  'negative_prompt: ""',
  'steps: 50',
  'width: 896',
  'height: 1152',
  'cfg_scale: 3',
  'distilled_cfg_scale: 5',
  'sampler: "Euler"',
  'scheduler: "simple"',
  'override_settings:',
  '  sd_model_checkpoint: "moss-image_moss_image_sft_bf16"',
  '  forge_additional_modules:',
  '    - "qwen3.5_9b_bf16.safetensors"',
  '    - "flux2-vae.safetensors"',
  '  moss_uncond_skip_layers: "22"',
  '',
].join('\n');

// The page is shared by every avatar, and their models differ: what is one family's own way of writing is put in
// from the default params' model, never written in the common part.
test('the common part of the page carries no one family\'s way of writing a prompt', async () => {
  const template = await readImagesTemplate();
  for (const word of ['masterpiece', 'newest', '(smile', 'highres', 'anime illustration', '品質・安全']) {
    assert.ok(!template.includes(word), word);
  }
  assert.match(template, /^\{\{prompting\}\}$/m);
});

test('with an Anima model by default, the page says how to write for Anima', async () => {
  const page = renderImagesPage(await readImagesTemplate(), await loadAvatar(undefined));
  assert.match(page, /^## プロンプトの書き方（Anima）$/m);
  for (const word of ['`anima_2_9_Anima-2.9B-preview-v1`', 'masterpiece, best quality, newest, safe,', '品質・安全 → 人数',
    '`(smile:1.5)`', '`On the left,`', '`the girl`', '`anima-prompt`']) {
    assert.ok(page.includes(word), word);
  }
  for (const word of ['MOSS-Image', 'moss-prompt', 'highres']) assert.ok(!page.includes(word), word);
});

test('the server\'s default (an Anima model) is told the Anima way too', () => scratch(async root => {
  const dir = join(root, 'hana');
  await mkdir(dir);
  await writeFile(join(dir, 'avatar.json'), JSON.stringify({ id: 'hana', name: 'はな' }));
  const page = renderImagesPage(await readImagesTemplate(), await loadAvatar({ directory: dir }));
  assert.match(page, /^## プロンプトの書き方（Anima）$/m);
  assert.ok(page.includes('`(smile:1.5)`'));
}));

test('with a MOSS-Image model by default, the page says how to write for MOSS-Image and nothing of Anima\'s', () => scratch(async root => {
  const page = await pageWithParams(root, MOSS_PARAMS);
  assert.match(page, /- 既定はモデル `moss-image_moss_image_sft_bf16`、896×1152（縦長）。横長は `--width 1152 --height 896`。/);
  assert.match(page, /^## プロンプトの書き方（MOSS-Image）$/m);
  for (const word of ['`best quality, highres`', '`anime illustration`', '`(x:1.2)`', '`BREAK`', '文字のまま', '引用符',
    '`negative_prompt`', '`moss-prompt`']) {
    assert.ok(page.includes(word), word);
  }
  for (const word of ['masterpiece', 'newest', '(smile', 'anima-prompt', '品質・安全']) assert.ok(!page.includes(word), word);
  // Her own section is the appearance's, whatever the model: none here, so nothing about a LoRA either.
  assert.match(page, /## あなた自身の姿\n\nあなたの決まった姿はありません。/);
  assert.ok(!page.includes('{{'));
}));

test('a model of no family the page knows is told plainly, without another family\'s way of writing', () => scratch(async root => {
  const page = await pageWithParams(root, 'override_settings:\n  sd_model_checkpoint: "IL_illustrij_v4"\n');
  assert.match(page, /^## プロンプトの書き方$/m);
  assert.ok(page.includes('`IL_illustrij_v4`'), page);
  assert.ok(page.includes('`sd-generate`'), page);
  for (const word of ['masterpiece', '(smile', 'highres', 'anime illustration', 'anima-prompt', 'moss-prompt', '{{']) {
    assert.ok(!page.includes(word), word);
  }
}));

test('params that name no model are told the same plain way', () => scratch(async root => {
  const page = await pageWithParams(root, 'width: 1216\nheight: 832\n');
  assert.match(page, /^## プロンプトの書き方$/m);
  assert.ok(page.includes('既定の params にモデルの名前がありません'), page);
  for (const word of ['masterpiece', '(smile', 'highres', '{{']) assert.ok(!page.includes(word), word);
}));

test('the page and the params are written for the workspace, readable by its group, and replaced on every start', () => scratch(async root => {
  const directory = join(root, AVATAR_MANUAL_DIRECTORY);
  await mkdir(directory);
  await writeFile(join(directory, IMAGES_PAGE), 'old');
  const avatar = await loadAvatar(undefined);
  await writeAvatarManual(directory, avatar);
  assert.equal(await readFile(join(directory, IMAGES_PAGE), 'utf8'), await readFile(join(FIXTURES, 'natsumi-images.md'), 'utf8'));
  assert.equal(await readFile(join(directory, SDCTL_PARAMS_FILE), 'utf8'), avatar.sdctlParams);
  assert.equal((await stat(join(directory, IMAGES_PAGE))).mode & 0o777, 0o640);
  assert.equal(AVATAR_MANUAL_DIRECTORY, 'avatar');
  assert.equal(SDCTL_PARAMS_FILE, 'sdctl-params.yaml');
}));
