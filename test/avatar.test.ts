import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readdir } from 'node:fs/promises';
import { AVATAR_EXPRESSIONS, avatarManifest, BUILT_IN_DIRECTORY, builtInAvatars, DEFAULT_AVATAR_DIRECTORY, FALLBACK_DIRECTORY, inspectAvatar, loadAvatar } from '../src/server/avatar.ts';
import { ConfigError } from '../src/server/config.ts';
import { EXPRESSIONS } from '../src/server/loop-tools.ts';

/**
 * The avatar the server is pointed at (ADR 0057): read once at start, checked, filled in with the faceless pictures
 * where it has none, and handed to the apps as one bundle whose version is its content.
 */

const NATSUMI = join(import.meta.dirname, '..', 'assets', 'avatars', 'natsumi');
const FALLBACK = join(import.meta.dirname, '..', 'assets', 'avatars', 'nanashi');
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function scratch(fn: (dir: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-avatar-')));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

/** nanashi's avatar.json as the apps are given it: without angry, which the server does not use yet. */
async function servedFallback(): Promise<Record<string, any>> {
  const fallback = JSON.parse(await readFile(join(FALLBACK, 'avatar.json'), 'utf8'));
  delete fallback.icons.angry;
  delete fallback.expressions.angry;
  return fallback;
}

/** A directory holding an avatar.json of `fields` and nothing else. */
async function bare(root: string, fields: Record<string, unknown> = { id: 'hana', name: 'はな' }): Promise<string> {
  const dir = join(root, 'hana');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'avatar.json'), JSON.stringify(fields));
  return dir;
}

test('without a directory the server uses natsumi from the image, with nothing filled in', async () => {
  const avatar = await loadAvatar(undefined);
  assert.equal(avatar.id, 'natsumi');
  assert.equal(avatar.name, 'なつみ');
  assert.equal(await realpath(avatar.directory), await realpath(NATSUMI));
  assert.equal(await realpath(DEFAULT_AVATAR_DIRECTORY), await realpath(NATSUMI));
  assert.equal(await realpath(FALLBACK_DIRECTORY), await realpath(FALLBACK));
  assert.deepEqual(avatar.filled, []);
  assert.deepEqual([...avatar.files.keys()].sort(),
    ['avatar.json', ...EXPRESSIONS.map(expression => `icons/${expression}.webp`), 'pet.json', 'spritesheet.webp'].sort());
  // The sheet, the icons and the pet go as they are; avatar.json as the server resolved it.
  assert.deepEqual(avatar.files.get('spritesheet.webp')!.data, await readFile(join(NATSUMI, 'spritesheet.webp')));
  assert.deepEqual(avatar.files.get('icons/happy.webp')!.data, await readFile(join(NATSUMI, 'icons', 'happy.webp')));
  assert.deepEqual(avatar.files.get('pet.json')!.data, await readFile(join(NATSUMI, 'pet.json')));
  assert.equal(avatar.files.get('spritesheet.webp')!.contentType, 'image/webp');
  const served = JSON.parse(avatar.files.get('avatar.json')!.data.toString('utf8'));
  const source = JSON.parse(await readFile(join(NATSUMI, 'avatar.json'), 'utf8'));
  // Her angry face is in the directory but not handed out: the server has no angry yet.
  assert.equal(source.icons.angry, 'icons/angry.webp');
  delete source.icons.angry;
  assert.deepEqual(served, source);
  assert.match(avatar.version, /^[0-9a-f]{32}$/);
});

test('the Slack icons are the avatar\'s PNGs, and nothing is given for what is not a feeling', async () => {
  const avatar = await loadAvatar(undefined);
  for (const expression of EXPRESSIONS) {
    assert.deepEqual(avatar.slack(expression), await readFile(join(NATSUMI, 'slack', `${expression}.png`)));
  }
  assert.equal(avatar.slack('angry'), undefined);
  assert.equal(avatar.slack('../avatar'), undefined);
});

test('natsumi keeps her body features, glasses included, and draws with her own params', async () => {
  const avatar = await loadAvatar(undefined);
  assert.equal(avatar.appearance?.lora, 'kutara_anima.v1');
  assert.ok(avatar.appearance!.body.includes('black glasses'));
  assert.ok(avatar.appearance!.body.includes('kutara natsumi'));
  for (const word of avatar.appearance!.keep) assert.ok(avatar.appearance!.body.includes(word));
  assert.match(avatar.sdctlParams, /anima_2_9_Anima-2.9B-preview-v1/);
  assert.deepEqual(avatar.appearance?.keep, ['freckles', 'large breasts', 'low ponytail']);
  assert.equal(avatar.appearance?.outfit, 'black business suit,  collared white shirt,');
  assert.equal(avatar.sdctlParams, await readFile(join(NATSUMI, 'sdctl-params.yaml'), 'utf8'));
  assert.deepEqual(avatar.defaults, ['personality.md']);
});

test('the manifest lists every file with its size and hash under the version', async () => {
  const avatar = await loadAvatar(undefined);
  const manifest = avatarManifest(avatar);
  assert.equal(manifest.version, avatar.version);
  assert.equal(manifest.id, 'natsumi');
  assert.equal(manifest.name, 'なつみ');
  const sheet = manifest.files.find(file => file.path === 'spritesheet.webp')!;
  const data = await readFile(join(NATSUMI, 'spritesheet.webp'));
  assert.deepEqual(sheet, { path: 'spritesheet.webp', bytes: data.length, sha256: sha256(data) });
  assert.deepEqual(manifest.files.map(file => file.path), [...manifest.files.map(file => file.path)].sort());
});

test('an avatar of only a name is filled with the faceless pictures, never with natsumi\'s', () => scratch(async root => {
  const dir = await bare(root);
  const avatar = await loadAvatar({ directory: dir });
  assert.equal(avatar.id, 'hana');
  assert.equal(avatar.name, 'はな');
  assert.deepEqual(avatar.filled, ['spritesheet', ...EXPRESSIONS.map(expression => `icons/${expression}`),
    ...EXPRESSIONS.map(expression => `slack/${expression}`)]);
  assert.deepEqual(avatar.defaults, ['pet.json', 'appearance.yaml', 'sdctl-params.yaml', 'personality.md']);
  assert.deepEqual(avatar.files.get('spritesheet.webp')!.data, await readFile(join(FALLBACK, 'spritesheet.webp')));
  assert.deepEqual(avatar.files.get('icons/sad.webp')!.data, await readFile(join(FALLBACK, 'icons', 'sad.webp')));
  assert.deepEqual(avatar.slack('sad'), await readFile(join(FALLBACK, 'slack', 'sad.png')));
  const served = JSON.parse(avatar.files.get('avatar.json')!.data.toString('utf8'));
  const fallback = await servedFallback();
  assert.deepEqual(served, { ...fallback, id: 'hana', name: 'はな' });
  // A pet made from the avatar's own name, for an app that reads pet.json first.
  assert.deepEqual(JSON.parse(avatar.files.get('pet.json')!.data.toString('utf8')),
    { id: 'hana', displayName: 'はな', spritesheetPath: 'spritesheet.webp' });
  assert.equal(avatar.appearance, undefined);
}));

test('a missing icon or Slack picture is filled one feeling at a time', () => scratch(async root => {
  const dir = join(root, 'copy');
  await cp(NATSUMI, dir, { recursive: true });
  await rm(join(dir, 'icons', 'sad.webp'));
  await rm(join(dir, 'slack', 'sleepy.png'));
  const avatar = await loadAvatar({ directory: dir });
  assert.deepEqual(avatar.filled, ['icons/sad', 'slack/sleepy']);
  assert.deepEqual(avatar.files.get('icons/sad.webp')!.data, await readFile(join(FALLBACK, 'icons', 'sad.webp')));
  assert.deepEqual(avatar.files.get('icons/happy.webp')!.data, await readFile(join(NATSUMI, 'icons', 'happy.webp')));
  assert.deepEqual(avatar.slack('sleepy'), await readFile(join(FALLBACK, 'slack', 'sleepy.png')));
  const served = JSON.parse(avatar.files.get('avatar.json')!.data.toString('utf8'));
  assert.equal(served.icons.sad, 'icons/sad.webp');
  assert.equal(served.atlas.rows, 11);
}));

test('a sheet that is named but not there takes the faceless sheet and its animations together', () => scratch(async root => {
  const dir = join(root, 'copy');
  await cp(NATSUMI, dir, { recursive: true });
  await rm(join(dir, 'spritesheet.webp'));
  const avatar = await loadAvatar({ directory: dir });
  assert.deepEqual(avatar.filled, ['spritesheet']);
  const served = JSON.parse(avatar.files.get('avatar.json')!.data.toString('utf8'));
  const fallback = await servedFallback();
  assert.deepEqual(served.atlas, fallback.atlas);
  assert.deepEqual(served.animations, fallback.animations);
  assert.deepEqual(served.expressions, fallback.expressions);
  // The avatar's own icons stay.
  assert.deepEqual(avatar.files.get('icons/happy.webp')!.data, await readFile(join(NATSUMI, 'icons', 'happy.webp')));
}));

test('a PNG sheet and PNG icons are served under their own extension', () => scratch(async root => {
  const dir = await bare(root, { id: 'hana', name: 'はな', spritesheet: 'art/sheet.png',
    atlas: { columns: 1, rows: 1, cellWidth: 10, cellHeight: 10 }, animations: { idle: { row: 0, frames: 1 } },
    expressions: { neutral: 'idle' }, icons: { happy: 'faces/happy.png' } });
  await mkdir(join(dir, 'art'));
  await mkdir(join(dir, 'faces'));
  await writeFile(join(dir, 'art', 'sheet.png'), 'sheet');
  await writeFile(join(dir, 'faces', 'happy.png'), 'happy');
  const avatar = await loadAvatar({ directory: dir });
  assert.equal(avatar.files.get('spritesheet.png')!.data.toString(), 'sheet');
  assert.equal(avatar.files.get('spritesheet.png')!.contentType, 'image/png');
  assert.equal(avatar.files.get('icons/happy.png')!.data.toString(), 'happy');
  const served = JSON.parse(avatar.files.get('avatar.json')!.data.toString('utf8'));
  assert.equal(served.spritesheet, 'spritesheet.png');
  assert.equal(served.icons.happy, 'icons/happy.png');
  assert.equal(served.icons.sad, 'icons/sad.webp');
  assert.equal(served.framesPerSecond, undefined);
}));

test('the version follows the content: the same files give the same version, a changed one another', () => scratch(async root => {
  const one = join(root, 'one');
  const two = join(root, 'two');
  await cp(NATSUMI, one, { recursive: true });
  await cp(NATSUMI, two, { recursive: true });
  assert.equal((await loadAvatar({ directory: one })).version, (await loadAvatar({ directory: two })).version);
  assert.equal((await loadAvatar({ directory: one })).version, (await loadAvatar(undefined)).version);
  await writeFile(join(two, 'icons', 'happy.webp'), 'another face');
  assert.notEqual((await loadAvatar({ directory: one })).version, (await loadAvatar({ directory: two })).version);
  // What the apps are not given does not move it.
  await writeFile(join(one, 'README.md'), 'changed');
  await writeFile(join(one, 'slack', 'happy.png'), 'another icon');
  assert.equal((await loadAvatar({ directory: one })).version, (await loadAvatar(undefined)).version);
}));

/** The errors `inspectAvatar` finds, and that loading stops with a ConfigError on `avatar.directory`. */
async function refused(dir: string, pattern: RegExp) {
  const inspected = await inspectAvatar(dir);
  assert.ok(inspected.errors.some(error => pattern.test(error)), `${pattern}: ${inspected.errors.join(' / ')}`);
  await assert.rejects(loadAvatar({ directory: dir }), (error: unknown) => error instanceof ConfigError && error.path === 'avatar.directory'
    && pattern.test(error.message));
}

test('a directory that is not there, or holds no avatar.json, stops the start', () => scratch(async root => {
  await refused(join(root, 'nowhere'), /does not exist/);
  await writeFile(join(root, 'file'), '');
  await refused(join(root, 'file'), /not a directory/);
  await mkdir(join(root, 'empty'));
  await refused(join(root, 'empty'), /avatar\.json/);
}));

test('an avatar.json without its ID or name, or out of shape, stops the start', () => scratch(async root => {
  const cases: [Record<string, unknown> | string, RegExp][] = [
    ['{ not json', /avatar\.json: not valid JSON/],
    [[] as unknown as Record<string, unknown>, /avatar\.json: must be an object/],
    [{ name: 'はな' }, /id/],
    [{ id: 'Hana', name: 'はな' }, /id/],
    [{ id: 'hana' }, /name/],
    [{ id: 'hana', name: '' }, /name/],
    [{ id: 'hana', name: 'は\nな' }, /name/],
    [{ id: 'hana', name: 'は'.repeat(33) }, /name/],
    [{ id: 'hana', name: 'はな', icons: { happy: '../happy.webp' } }, /icons\.happy/],
    [{ id: 'hana', name: 'はな', icons: { happy: 'happy.gif' } }, /icons\.happy/],
    [{ id: 'hana', name: 'はな', spritesheet: 'sheet.webp', animations: { idle: { row: 0, frames: 1 } } }, /atlas/],
    [{ id: 'hana', name: 'はな', spritesheet: 'sheet.webp', atlas: { columns: 1, rows: 1, cellWidth: 1, cellHeight: 1 } }, /animations/],
    [{ id: 'hana', name: 'はな', atlas: { columns: 0, rows: 1, cellWidth: 1, cellHeight: 1 } }, /atlas\.columns/],
    [{ id: 'hana', name: 'はな', animations: { idle: { row: 0, frames: 1 } }, expressions: { happy: 'waving' } }, /expressions\.happy/],
    [{ id: 'hana', name: 'はな', framesPerSecond: -1 }, /framesPerSecond/],
  ];
  for (const [index, [fields, pattern]] of cases.entries()) {
    const dir = join(root, `case-${index}`);
    await mkdir(dir);
    await writeFile(join(dir, 'avatar.json'), typeof fields === 'string' ? fields : JSON.stringify(fields));
    await refused(dir, pattern);
  }
}));

test('a pet.json, appearance.yaml or sdctl-params.yaml that is there but broken stops the start', () => scratch(async root => {
  const cases: [string, string, RegExp][] = [
    ['pet.json', '{ broken', /pet\.json/],
    ['appearance.yaml', 'body: [unclosed', /appearance\.yaml/],
    ['appearance.yaml', 'outfit: suit,\n', /appearance\.yaml: body/],
    ['appearance.yaml', 'body: woman,\n', /appearance\.yaml: outfit/],
    ['appearance.yaml', 'body: woman,\noutfit: suit,\nkeep: freckles\n', /appearance\.yaml: keep/],
    ['appearance.yaml', 'body: woman,\noutfit: suit,\nexamples:\n  - title: x\n', /appearance\.yaml: examples/],
    ['appearance.yaml', 'body: woman,\noutfit: suit,\nsurprise: 1\n', /appearance\.yaml: surprise/],
    ['sdctl-params.yaml', '- a list\n', /sdctl-params\.yaml/],
    ['sdctl-params.yaml', 'steps: [30\n', /sdctl-params\.yaml/],
  ];
  for (const [index, [file, text, pattern]] of cases.entries()) {
    const dir = await bare(join(root, `case-${index}`));
    await writeFile(join(dir, file), text);
    await refused(dir, pattern);
  }
}));

test('a file that leads out of the directory through a symlink stops the start', () => scratch(async root => {
  const outside = join(root, 'outside.webp');
  await writeFile(outside, 'not hers');
  const dir = await bare(root, { id: 'hana', name: 'はな', icons: { happy: 'icons/happy.webp' } });
  await mkdir(join(dir, 'icons'));
  await symlink(outside, join(dir, 'icons', 'happy.webp'));
  await refused(dir, /icons\.happy/);
}));

test('inspecting sorts what stops the start from what is filled and what takes the default', () => scratch(async root => {
  const good = await inspectAvatar(await bare(root));
  assert.deepEqual(good.errors, []);
  assert.equal(good.avatar?.id, 'hana');
  assert.equal(good.filled.length, 1 + EXPRESSIONS.length * 2);
  assert.deepEqual(good.defaults, ['pet.json', 'appearance.yaml', 'sdctl-params.yaml', 'personality.md']);
  const bad = await inspectAvatar(await bare(join(root, 'bad'), { name: 'はな', framesPerSecond: 0 }));
  assert.equal(bad.avatar, undefined);
  assert.ok(bad.errors.length >= 2, bad.errors.join(' / '));
}));

// personality.md is where her memory's personality starts from (ADR 0060): optional, read as it is, and no part of
// the bundle the apps are given, since only the server reads it.
test('an avatar\'s personality.md is read as it is and kept out of the bundle', () => scratch(async root => {
  const dir = await bare(root);
  const without = await loadAvatar({ directory: dir });
  assert.equal(without.personality, undefined);
  assert.ok(without.defaults.includes('personality.md'));
  const text = '# 性格・話し方\n\nのんびりしていて、語尾をのばす。\n';
  await writeFile(join(dir, 'personality.md'), text);
  const avatar = await loadAvatar({ directory: dir });
  assert.equal(avatar.personality, text);
  assert.ok(!avatar.defaults.includes('personality.md'));
  assert.ok(![...avatar.files.keys()].some(path => path.includes('personality')));
  assert.equal(avatar.version, without.version);
}));

test('a personality.md that is there but empty, or leads outside, stops the start', () => scratch(async root => {
  const dir = await bare(root);
  await writeFile(join(dir, 'personality.md'), ' \n\n');
  await refused(dir, /personality\.md: must be text/);
  await rm(join(dir, 'personality.md'));
  const outside = join(root, 'outside.md');
  await writeFile(outside, '# 性格\n\nよその性格\n');
  await symlink(outside, join(dir, 'personality.md'));
  await refused(dir, /personality\.md leads outside the directory/);
}));

// The built-in avatars are the image's own: a broken one is a broken image, so each is held to the start's checks here.
test('every built-in avatar passes the start\'s checks under the ID its directory is named by', async () => {
  const names = (await readdir(BUILT_IN_DIRECTORY, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(await builtInAvatars(), names);
  assert.deepEqual(names, ['iori', 'myao', 'nanashi', 'natsumi']);
  for (const id of names) {
    const inspected = await inspectAvatar(join(BUILT_IN_DIRECTORY, id));
    assert.deepEqual(inspected.errors, [], id);
    assert.equal(inspected.avatar?.id, id);
    assert.deepEqual(inspected.filled, [], id);
    const chosen = await loadAvatar({ id });
    assert.equal(chosen.version, inspected.avatar!.version, id);
  }
});

test('iori has her own name, complete assets and drawing settings', async () => {
  const avatar = await loadAvatar({ id: 'iori' });
  assert.equal(avatar.name, '伊織');
  assert.deepEqual(avatar.filled, []);
  assert.deepEqual(avatar.defaults, ['personality.md']);
  assert.equal(avatar.appearance?.lora, 'iori_funaki_anima.v4');
  assert.deepEqual(avatar.appearance?.keep, ['freckles', 'purple eyes', 'light brown hair']);
  assert.equal(avatar.appearance?.outfit, 'white dress,');
  assert.equal(avatar.sdctlParams, await readFile(join(BUILT_IN_DIRECTORY, 'iori', 'sdctl-params.yaml'), 'utf8'));
  assert.notEqual(avatar.version, (await loadAvatar(undefined)).version);
});

test('an appearance.yaml in the config replaces a built-in avatar\'s own, whole, through a symlink', () => scratch(async root => {
  const iori = await loadAvatar({ id: 'iori' });
  await mkdir(join(root, '..2026_x'));
  await writeFile(join(root, '..2026_x', 'appearance.yaml'), 'body: woman, black glasses,\noutfit: black suit,\nkeep: [black glasses]\n');
  await symlink('..2026_x', join(root, '..data'));
  await symlink('..data/appearance.yaml', join(root, 'appearance.yaml'));
  const suited = await loadAvatar({ id: 'iori', appearance: join(root, 'appearance.yaml') });
  assert.deepEqual(suited.appearance, { body: 'woman, black glasses,', outfit: 'black suit,', keep: ['black glasses'], examples: [] });
  assert.equal(suited.version, iori.version);
  for (const [text, pattern] of [[undefined, /cannot be read/], ['outfit: suit,\n', /appearance\.yaml: body/]] as const) {
    const path = join(root, `broken-${pattern.source.length}.yaml`);
    if (text !== undefined) await writeFile(path, text);
    await assert.rejects(loadAvatar({ id: 'iori', appearance: path }), (error: unknown) => error instanceof ConfigError
      && error.path === 'avatar.appearance' && pattern.test(error.message));
  }
}));

test('an sdctl-params.yaml in the config replaces the avatar\'s own, whole, through a symlink', () => scratch(async root => {
  const natsumi = await loadAvatar(undefined);
  const params = 'width: 1024\nheight: 1024\noverride_settings:\n  sd_model_checkpoint: other-model\n';
  await mkdir(join(root, '..2026_x'));
  await writeFile(join(root, '..2026_x', 'sdctl-params.yaml'), params);
  await symlink('..2026_x', join(root, '..data'));
  await symlink('..data/sdctl-params.yaml', join(root, 'sdctl-params.yaml'));
  const replaced = await loadAvatar({ id: 'natsumi', sdctlParams: join(root, 'sdctl-params.yaml') });
  assert.equal(replaced.sdctlParams, params);
  assert.equal(replaced.version, natsumi.version);
  assert.deepEqual(replaced.appearance, natsumi.appearance);
  // One that had none of its own no longer stands on the server's default.
  const hana = await loadAvatar({ directory: await bare(root), sdctlParams: join(root, 'sdctl-params.yaml') });
  assert.equal(hana.sdctlParams, params);
  assert.deepEqual(hana.defaults, ['pet.json', 'appearance.yaml', 'personality.md']);
  for (const [text, pattern] of [[undefined, /cannot be read/], ['- a list\n', /sdctl-params\.yaml: must be a mapping/],
    ['steps: [30\n', /sdctl-params\.yaml: not valid YAML/]] as const) {
    const path = join(root, `broken-${pattern.source.length}.yaml`);
    if (text !== undefined) await writeFile(path, text);
    await assert.rejects(loadAvatar({ id: 'natsumi', sdctlParams: path }), (error: unknown) => error instanceof ConfigError
      && error.path === 'avatar.sdctlParams' && pattern.test(error.message));
  }
}));

test('the config may replace both the appearance and the sdctl params of one avatar', () => scratch(async root => {
  const iori = await loadAvatar({ id: 'iori' });
  await writeFile(join(root, 'appearance.yaml'), 'body: woman, black glasses,\noutfit: black suit,\n');
  await writeFile(join(root, 'sdctl-params.yaml'), 'steps: 30\n');
  const both = await loadAvatar({ id: 'iori', appearance: join(root, 'appearance.yaml'), sdctlParams: join(root, 'sdctl-params.yaml') });
  assert.equal(both.appearance?.outfit, 'black suit,');
  assert.equal(both.sdctlParams, 'steps: 30\n');
  assert.equal(both.version, iori.version);
}));

test('an ID chooses a built-in avatar, the same as leaving the avatar out for natsumi', async () => {
  const chosen = await loadAvatar({ id: 'natsumi' });
  assert.equal(chosen.version, (await loadAvatar(undefined)).version);
  assert.equal(await realpath(chosen.directory), await realpath(NATSUMI));
});

test('an ID that is no built-in avatar stops the start', async () => {
  for (const id of ['hana', 'fallback']) {
    await assert.rejects(loadAvatar({ id }), (error: unknown) => error instanceof ConfigError && error.path === 'avatar.id'
      && error.message === `avatar.id: ${id} is not a built-in avatar (iori, myao, nanashi, natsumi)`, id);
  }
});

// 名無し is where the missing pictures come from, and an avatar of its own that lacks nothing.
test('nanashi is a built-in avatar that lacks nothing, and the one the missing pictures come from', async () => {
  const nanashi = await loadAvatar({ id: 'nanashi' });
  assert.equal(nanashi.id, 'nanashi');
  assert.equal(nanashi.name, '名無し');
  assert.deepEqual(nanashi.filled, []);
  assert.deepEqual(nanashi.defaults, ['appearance.yaml', 'personality.md']);
  assert.equal(nanashi.appearance, undefined);
  assert.equal(await realpath(FALLBACK_DIRECTORY), await realpath(join(BUILT_IN_DIRECTORY, 'nanashi')));
  assert.deepEqual(nanashi.files.get('spritesheet.webp')!.data, await readFile(join(FALLBACK, 'spritesheet.webp')));
});

// angry is in the avatar's spec and not yet among the server's feelings (ADR 0057): allowed, checked for its shape,
// and neither handed out nor filled in until the server has it.
test('the spec names angry beside the server\'s feelings, and the server does not use it yet', () => {
  assert.deepEqual(AVATAR_EXPRESSIONS, [...EXPRESSIONS, 'angry']);
  assert.ok(!(EXPRESSIONS as readonly string[]).includes('angry'));
});

test('an angry face, its animation and its Slack icon are allowed, and none of it is handed out or filled in', () => scratch(async root => {
  const dir = join(root, 'copy');
  await cp(NATSUMI, dir, { recursive: true });
  const manifest = JSON.parse(await readFile(join(dir, 'avatar.json'), 'utf8'));
  manifest.expressions.angry = 'failed';
  await writeFile(join(dir, 'avatar.json'), JSON.stringify(manifest));
  const avatar = await loadAvatar({ directory: dir });
  assert.deepEqual(avatar.filled, []);
  assert.ok(![...avatar.files.keys()].some(path => path.includes('angry')));
  const served = JSON.parse(avatar.files.get('avatar.json')!.data.toString('utf8'));
  assert.equal(served.icons.angry, undefined);
  assert.equal(served.expressions.angry, undefined);
  assert.equal(avatar.slack('angry'), undefined);
  // Without them nothing is missing either: the server does not ask for angry yet.
  await rm(join(dir, 'icons', 'angry.webp'));
  await rm(join(dir, 'slack', 'angry.png'));
  assert.deepEqual((await loadAvatar({ directory: dir })).filled, []);
  assert.equal((await loadAvatar({ directory: dir })).version, (await loadAvatar(undefined)).version);
}));

test('an angry that is out of shape stops the start like any other feeling', () => scratch(async root => {
  for (const [index, fields] of [
    { id: 'hana', name: 'はな', icons: { angry: '../angry.webp' } },
    { id: 'hana', name: 'はな', animations: { idle: { row: 0, frames: 1 } }, expressions: { angry: 'stomping' } },
  ].entries()) {
    const dir = join(root, `case-${index}`);
    await mkdir(dir);
    await writeFile(join(dir, 'avatar.json'), JSON.stringify(fields));
    await refused(dir, /\.angry/);
  }
}));

test('all built-in avatars carry every feeling of the spec, angry included', async () => {
  for (const id of ['iori', 'myao', 'nanashi', 'natsumi']) {
    const dir = join(BUILT_IN_DIRECTORY, id);
    const manifest = JSON.parse(await readFile(join(dir, 'avatar.json'), 'utf8'));
    for (const expression of AVATAR_EXPRESSIONS) {
      assert.ok(manifest.icons[expression], `${id}: icons.${expression}`);
      await readFile(join(dir, manifest.icons[expression]));
      await readFile(join(dir, 'slack', `${expression}.png`));
    }
  }
  const nanashi = JSON.parse(await readFile(join(FALLBACK, 'avatar.json'), 'utf8'));
  assert.deepEqual(Object.keys(nanashi.expressions).sort(), [...AVATAR_EXPRESSIONS].sort());
});

test('myao has her own name, complete assets and Anima drawing settings', async () => {
  const avatar = await loadAvatar({ id: 'myao' });
  assert.equal(avatar.name, 'ミャオ');
  assert.deepEqual(avatar.filled, []);
  assert.deepEqual(avatar.defaults, []);
  // Her personality to start from, in the owner's words (ADR 0060).
  assert.equal(avatar.personality, await readFile(join(BUILT_IN_DIRECTORY, 'myao', 'personality.md'), 'utf8'));
  assert.match(avatar.personality!, /^# 性格・話し方\n[\s\S]*一人称は、ミャー/);
  assert.equal(avatar.appearance?.lora, 'myao_anima.v1');
  assert.deepEqual(avatar.appearance?.keep, ['pale blue-gray hair', 'amber eyes', 'cat ears']);
  for (const word of avatar.appearance!.keep) {
    assert.ok(avatar.appearance!.body.includes(word), `body must contain keep word: ${word}`);
  }
  assert.ok(!avatar.appearance!.body.includes('short hair'));
  assert.equal(avatar.appearance?.outfitName, '黄色いシャツ');
  assert.match(avatar.sdctlParams, /anima_anima-base-v1.0/);
  assert.match(avatar.sdctlParams, /human ears, extra ears, normal ears, realistic ears:1\.7/);
});
