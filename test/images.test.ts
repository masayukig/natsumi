import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { ImageStore, imageSize, takeImages } from '../src/server/images.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { PNG, pngOf } from './support/fake-slack.ts';

/**
 * The images natsumi hands the server from /work, such as those she names in a request to the dove (ADR 0044): only files under /work, only PNG, JPEG and WebP by
 * their bytes, and within the limits. What passes is copied to the server's side at once, so what the owner approves
 * and what is sent is the copy, whatever becomes of the file in /work.
 */

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(24, 3)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(24, 4)]);
const LIMITS = { maxBytes: 1024, maxCount: 3 };

async function setup(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-dove-images-')));
  const work = join(root, 'work');
  const destination = join(root, 'state', 'images');
  await mkdir(join(work, 'images'), { recursive: true });
  await writeFile(join(work, 'images', 'cat.png'), PNG);
  await writeFile(join(work, 'images', 'dog.jpg'), JPEG);
  await writeFile(join(work, 'images', 'bird.webp'), WEBP);
  await writeFile(join(root, 'secret.png'), PNG);
  t.after(() => rm(root, { recursive: true, force: true }));
  const take = (paths: string[], limits = LIMITS) => takeImages(paths, { workDirectory: work, destination, limits });
  return { root, work, destination, take };
}

test('images under /work are copied, each with its type by its bytes, its size and its digest', async t => {
  const f = await setup(t);
  const taken = await f.take(['/work/images/cat.png', '/work/images/dog.jpg', '/work/images/bird.webp']);
  assert.ok(taken.ok, JSON.stringify(taken));
  assert.deepEqual(taken.images.map(image => [image.source, image.mimeType, image.bytes]), [
    ['/work/images/cat.png', 'image/png', PNG.length],
    ['/work/images/dog.jpg', 'image/jpeg', JPEG.length],
    ['/work/images/bird.webp', 'image/webp', WEBP.length],
  ]);
  const [cat] = taken.images;
  assert.equal(cat!.sha256, createHash('sha256').update(PNG).digest('hex'));
  assert.match(cat!.imageId, /^image-[0-9a-f-]{36}$/);
  assert.equal(cat!.file, join(f.destination, `${cat!.imageId}.png`));
  assert.deepEqual(await readFile(cat!.file), PNG);
  assert.equal(new Set(taken.images.map(image => image.imageId)).size, 3);
});

test('the copy stays as it was taken when the file in /work is written over afterwards', async t => {
  const f = await setup(t);
  const taken = await f.take(['/work/images/cat.png']);
  assert.ok(taken.ok);
  await writeFile(join(f.work, 'images', 'cat.png'), JPEG);
  assert.deepEqual(await readFile(taken.images[0]!.file), PNG);
});

test('a path is read the way the workspace sees it, so a dot or a doubled slash inside /work is fine', async t => {
  const f = await setup(t);
  const taken = await f.take(['/work/./images//cat.png']);
  assert.ok(taken.ok);
  assert.equal(taken.images[0]!.source, '/work/images/cat.png');
});

for (const [name, path, pattern] of [
  ['a file outside /work', '/sources/slack/cat.png', /\/work/],
  ['a path that climbs out of /work', '/work/../secret.png', /\/work/],
  ['/work itself', '/work', /\/work/],
  ['a file that is not there', '/work/images/none.png', /見つかりません/],
  ['a directory', '/work/images', /ファイルではありません/],
] as const) {
  test(`${name} is refused, and nothing is copied`, async t => {
    const f = await setup(t);
    const taken = await f.take(['/work/images/cat.png', path]);
    assert.equal(taken.ok, false);
    assert.match((taken as { text: string }).text, pattern);
    assert.deepEqual(await readdir(f.destination).catch(() => []), []);
  });
}

test('a link that leads out of /work is refused as if it were outside, and says nothing of where it leads', async t => {
  const f = await setup(t);
  await symlink(join(f.root, 'secret.png'), join(f.work, 'images', 'link.png'));
  await symlink(f.root, join(f.work, 'up'));
  for (const path of ['/work/images/link.png', '/work/up/secret.png']) {
    const taken = await f.take([path]);
    assert.equal(taken.ok, false, path);
    assert.match((taken as { text: string }).text, /\/work/);
    assert.doesNotMatch((taken as { text: string }).text, new RegExp(f.root));
  }
});

test('a link that stays inside /work is followed', async t => {
  const f = await setup(t);
  await symlink(join(f.work, 'images', 'cat.png'), join(f.work, 'latest.png'));
  const taken = await f.take(['/work/latest.png']);
  assert.ok(taken.ok);
  assert.equal(taken.images[0]!.mimeType, 'image/png');
});

test('only PNG, JPEG and WebP are taken, by their bytes and not their names', async t => {
  const f = await setup(t);
  await writeFile(join(f.work, 'images', 'moving.png'), GIF);
  await writeFile(join(f.work, 'images', 'notes.png'), 'これは画像ではありません');
  for (const path of ['/work/images/moving.png', '/work/images/notes.png']) {
    const taken = await f.take([path]);
    assert.equal(taken.ok, false, path);
    assert.match((taken as { text: string }).text, /PNG・JPEG・WebP/);
  }
});

test('an image larger than the limit is refused with the limit', async t => {
  const f = await setup(t);
  await writeFile(join(f.work, 'images', 'large.png'), Buffer.concat([PNG, Buffer.alloc(2048)]));
  const taken = await f.take(['/work/images/large.png']);
  assert.equal(taken.ok, false);
  assert.match((taken as { text: string }).text, /大きすぎ/);
  assert.match((taken as { text: string }).text, /1 KB/);
});

test('more images than the limit are refused before any is read', async t => {
  const f = await setup(t);
  const taken = await f.take(['/work/images/cat.png', '/work/images/dog.jpg', '/work/images/bird.webp', '/work/images/cat.png']);
  assert.equal(taken.ok, false);
  assert.match((taken as { text: string }).text, /3 枚まで/);
  assert.deepEqual(await readdir(f.destination).catch(() => []), []);
});

test('taken images are recorded by ID, and each is read back by its ID alone, from the copy', async t => {
  const f = await setup(t);
  const db = openStateDatabase(join(f.root, 'state.sqlite'));
  t.after(() => db.close());
  migrate(db, MIGRATIONS);
  const store = new ImageStore(db, f.destination);
  const taken = await store.take(['/work/images/cat.png', '/work/images/dog.jpg'], f.work, LIMITS);
  assert.ok(taken.ok);
  store.record(taken.images, '2026-09-26T00:00:00.000Z');
  const [cat, dog] = taken.images;
  await writeFile(join(f.work, 'images', 'cat.png'), JPEG);
  assert.deepEqual(await store.read(cat!.imageId), { mimeType: 'image/png', data: PNG });
  assert.deepEqual(await store.read(dog!.imageId), { mimeType: 'image/jpeg', data: JPEG });
  assert.equal(await store.read('image-unknown'), undefined);
  const row = db.prepare('SELECT source, file, bytes FROM images WHERE image_id = ?').get(cat!.imageId) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { source: '/work/images/cat.png', file: `${cat!.imageId}.png`, bytes: PNG.length });
  await rm(cat!.file);
  assert.equal(await store.read(cat!.imageId), undefined, 'a copy that is gone is not there');
});

/** A baseline JPEG with an APP0 segment before the frame that says its size. */
function jpegOf(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    ...Buffer.alloc(9)]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16, 5)]);
}

/** An extended WebP (VP8X), whose canvas is the size less one in 24 bits. */
function webpOf(width: number, height: number): Buffer {
  const chunk = Buffer.alloc(10);
  chunk.writeUIntLE(width - 1, 4, 3);
  chunk.writeUIntLE(height - 1, 7, 3);
  return Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8X'), Buffer.from([10, 0, 0, 0]),
    chunk, Buffer.alloc(16, 6)]);
}

// ADR 0045: the devices lay a picture out before it arrives, when its size can be read from its header.
test('the width and height are read from a PNG, JPEG or WebP header, and left out when the header does not say', () => {
  assert.deepEqual(imageSize(pngOf(896, 1152), 'image/png'), { width: 896, height: 1152 });
  assert.deepEqual(imageSize(jpegOf(1024, 768), 'image/jpeg'), { width: 1024, height: 768 });
  assert.deepEqual(imageSize(webpOf(1152, 896), 'image/webp'), { width: 1152, height: 896 });
  assert.equal(imageSize(PNG, 'image/png'), undefined);
  assert.equal(imageSize(JPEG, 'image/jpeg'), undefined);
  assert.equal(imageSize(WEBP, 'image/webp'), undefined);
});

test('a taken image keeps its width and height when they can be read, and the record keeps them too', async t => {
  const f = await setup(t);
  await writeFile(join(f.work, 'images', 'wide.png'), pngOf(1152, 896));
  const db = openStateDatabase(join(f.root, 'state.sqlite'));
  t.after(() => db.close());
  migrate(db, MIGRATIONS);
  const store = new ImageStore(db, f.destination);
  const taken = await store.take(['/work/images/wide.png', '/work/images/cat.png'], f.work, LIMITS);
  assert.ok(taken.ok);
  const [wide, cat] = taken.images;
  assert.deepEqual([wide!.width, wide!.height], [1152, 896]);
  assert.equal('width' in cat!, false);
  store.record(taken.images, '2026-09-26T00:00:00.000Z');
  const size = (imageId: string) => ({ ...db.prepare('SELECT width, height FROM images WHERE image_id = ?').get(imageId) as object });
  assert.deepEqual(size(wide!.imageId), { width: 1152, height: 896 });
  assert.deepEqual(size(cat!.imageId), { width: null, height: null });
});

// ADR 0069: a reply to the owner may show an image an outside agent handed back, where the server put it.
test('with the replies of the outside agents allowed, an image under /sources/agents is taken too, and the rest of /sources is not', async t => {
  const f = await setup(t);
  const agents = join(f.root, 'sources', 'agents');
  await mkdir(join(agents, 'wiki', '20260924T030000Z-ab12', 'images'), { recursive: true });
  await writeFile(join(agents, 'wiki', '20260924T030000Z-ab12', 'images', 'shot.png'), PNG);
  await mkdir(join(f.root, 'sources', 'slack'), { recursive: true });
  await writeFile(join(f.root, 'sources', 'slack', 'cat.png'), PNG);
  await symlink(join(f.root, 'secret.png'), join(agents, 'wiki', 'link.png'));
  const take = (paths: string[]) => takeImages(paths, { workDirectory: f.work, agentReplies: agents, destination: f.destination, limits: LIMITS });

  const taken = await take(['/work/images/cat.png', '/sources/agents/wiki/20260924T030000Z-ab12/images/shot.png']);
  assert.ok(taken.ok, JSON.stringify(taken));
  assert.deepEqual(taken.images.map(image => image.source),
    ['/work/images/cat.png', '/sources/agents/wiki/20260924T030000Z-ab12/images/shot.png']);
  for (const path of ['/sources/slack/cat.png', '/sources/agents/../slack/cat.png', '/sources/agents/wiki/link.png']) {
    const refused = await take([path]);
    assert.equal(refused.ok, false, path);
    assert.match((refused as { text: string }).text, /\/sources\/agents\//);
  }
  // Without it, as for a post to Slack, only /work.
  const work = await f.take(['/sources/agents/wiki/20260924T030000Z-ab12/images/shot.png']);
  assert.equal(work.ok, false);
  assert.match((work as { text: string }).text, /画像にできるのは \/work\/ の下のファイルだけです/);
});
