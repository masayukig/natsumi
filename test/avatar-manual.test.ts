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
 * defaults of the params put in, and the params themselves. With natsumi, the page is the one the image held before.
 */

const FIXTURES = join(import.meta.dirname, 'fixtures', 'avatar');

async function scratch(fn: (dir: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-avatar-manual-')));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('with natsumi, the page on drawing is word for word the manual/images.md the image held', async () => {
  const page = renderImagesPage(await readImagesTemplate(), await loadAvatar(undefined));
  assert.equal(page, await readFile(join(FIXTURES, 'natsumi-images.md'), 'utf8'));
});

test('with natsumi, the params say what the image\'s anima.yaml said', async () => {
  const avatar = await loadAvatar(undefined);
  assert.deepEqual(parse(avatar.sdctlParams), parse(await readFile(join(FIXTURES, 'default-params.yaml'), 'utf8')));
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
