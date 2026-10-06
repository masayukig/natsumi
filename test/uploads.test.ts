import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStore } from '../src/server/conversation-store.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { safeFileName, UNSENT_UPLOAD_MS, Uploads } from '../src/server/uploads.ts';
import { pngOf } from './support/fake-slack.ts';

/**
 * The files the owner hands natsumi from the chat (ADR 0071): put under /sources/uploads as they came, one directory
 * each, and attached to one owner message at most. The IDs are the browser's and the server's; she is shown the place.
 */

const MB = 1024 * 1024;
const OWNER = 4242001;

async function setup(t: test.TestContext, limits = { maxFileBytes: 1024, maxFiles: 3 }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-uploads-')));
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const clock = { now: Date.parse('2026-10-06T12:34:56.789Z') };
  const sources = join(root, 'sources');
  const uploads = new Uploads({ db, sourcesDirectory: sources, stagingDirectory: join(root, 'staging'), limits, now: () => clock.now });
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const receive = (data: Buffer | Buffer[], name: string, githubUserId = OWNER) =>
    uploads.receive((async function* () { for (const chunk of Array.isArray(data) ? data : [data]) yield chunk; })(), { name, githubUserId });
  /** An owner message to attach to, as the conversation records one. */
  const store = new ConversationStore(db, () => clock.now);
  const messages = new Map<string, string>();
  const message = (name: string) => {
    const { row } = store.insertOwnerMessage({ requestId: `request-${name}`, deviceId: 'device-1', text: '' });
    messages.set(name, row.message_id);
    return row.message_id;
  };
  return { root, db, clock, sources, uploads, receive, message, id: (name: string) => messages.get(name) ?? name };
}

test('a name is kept as it was given, but for what would lead out of its directory or hide it', () => {
  assert.equal(safeFileName('報告書 2026.pdf'), '報告書 2026.pdf');
  assert.equal(safeFileName('../../etc/passwd'), 'passwd', 'only the last part of a path');
  assert.equal(safeFileName('C:\\Users\\owner\\memo.txt'), 'memo.txt');
  assert.equal(safeFileName('..'), 'file');
  assert.equal(safeFileName(''), 'file');
  assert.equal(safeFileName('   '), 'file');
  assert.equal(safeFileName('.env'), '_env', 'never hidden');
  assert.equal(safeFileName('a\u0000b\nc\u007f.txt'), 'a_b_c_.txt', 'no control characters');
  assert.equal(safeFileName('ガ'.normalize('NFD')), 'ガ'.normalize('NFC'), 'the Mac’s decomposed names are composed');
  const long = safeFileName(`${'あ'.repeat(200)}.pdf`);
  assert.ok(Buffer.byteLength(long) <= 200, `${Buffer.byteLength(long)} bytes`);
  assert.ok(long.endsWith('.pdf'), 'the extension stays');
});

test('a file is put under sources/uploads in a directory of its own, readable by the workspace, and recorded', async t => {
  const f = await setup(t);
  const data = Buffer.from('%PDF-1.7 not much of a pdf');
  const result = await f.receive([data.subarray(0, 4), data.subarray(4)], '報告書.pdf');
  assert.ok(result.ok, JSON.stringify(result));
  const { upload } = result;
  assert.match(upload.uploadId, /^upload-[0-9a-f-]{36}$/);
  assert.deepEqual({ ...upload, uploadId: '' }, { uploadId: '', name: '報告書.pdf', bytes: data.length });
  const [directory, ...others] = await readdir(join(f.sources, 'uploads'));
  assert.deepEqual(others, []);
  assert.match(directory!, /^20261006T123456Z-[0-9a-f]{4}$/);
  assert.deepEqual(await readFile(join(f.sources, 'uploads', directory!, '報告書.pdf')), data);
  assert.equal((await stat(join(f.sources, 'uploads', directory!, '報告書.pdf'))).mode & 0o777, 0o640);
  assert.equal((await stat(join(f.sources, 'uploads', directory!))).mode & 0o777, 0o750);
  const row = f.db.prepare('SELECT * FROM uploads WHERE upload_id = ?').get(upload.uploadId) as Record<string, unknown>;
  assert.equal(row.path, `uploads/${directory}/報告書.pdf`);
  assert.equal(row.sha256, createHash('sha256').update(data).digest('hex'));
  assert.equal(row.message_id, null);
  assert.deepEqual(await readdir(join(f.root, 'staging')), [], 'nothing is left where it was written');
});

test('an image is told apart by its bytes, with its size; a name that says image does not make one', async t => {
  const f = await setup(t, { maxFileBytes: MB, maxFiles: 3 });
  const image = await f.receive(pngOf(3, 2), 'shot.bin');
  assert.ok(image.ok);
  assert.deepEqual({ ...image.upload, uploadId: '' }, { uploadId: '', name: 'shot.bin', bytes: pngOf(3, 2).length, mimeType: 'image/png', width: 3, height: 2 });
  const text = await f.receive(Buffer.from('not a picture'), 'photo.png');
  assert.ok(text.ok);
  assert.equal(text.upload.mimeType, undefined);
});

test('a file past the limit is refused, and nothing of it is kept', async t => {
  const f = await setup(t);
  const result = await f.receive([Buffer.alloc(600), Buffer.alloc(600)], 'big.bin');
  assert.deepEqual(result, { ok: false, code: 'too-large' });
  assert.deepEqual(f.db.prepare('SELECT * FROM uploads').all(), []);
  assert.deepEqual(await readdir(join(f.root, 'staging')), []);
  assert.deepEqual(await readdir(join(f.sources, 'uploads')).catch(() => []), []);
});

test('two files of one name go to two directories', async t => {
  const f = await setup(t);
  const one = await f.receive(Buffer.from('1'), 'memo.txt');
  const two = await f.receive(Buffer.from('2'), 'memo.txt');
  assert.ok(one.ok && two.ok);
  assert.equal((await readdir(join(f.sources, 'uploads'))).length, 2);
});

test('a message takes files not sent yet, of the same account, within the limit, each once', async t => {
  const f = await setup(t);
  const ids: string[] = [];
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
    const result = await f.receive(Buffer.from(name), name);
    assert.ok(result.ok);
    ids.push(result.upload.uploadId);
  }
  const other = await f.receive(Buffer.from('x'), 'x.txt', 1);
  assert.ok(other.ok);
  assert.deepEqual(f.uploads.check(ids, OWNER), { ok: false, code: 'too-many-uploads' });
  assert.deepEqual(f.uploads.check(['upload-unknown'], OWNER), { ok: false, code: 'upload-not-found' });
  assert.deepEqual(f.uploads.check([other.upload.uploadId], OWNER), { ok: false, code: 'upload-not-found' }, 'another account’s');
  assert.deepEqual(f.uploads.check([ids[0]!, ids[0]!], OWNER), { ok: false, code: 'invalid-request' });
  assert.deepEqual(f.uploads.check([ids[1]!, ids[0]!], OWNER), { ok: true });
  f.uploads.attach([ids[1]!, ids[0]!], f.message('message-1'));
  assert.deepEqual(f.uploads.check([ids[0]!], OWNER), { ok: false, code: 'upload-not-found' }, 'already sent');
  assert.deepEqual(f.uploads.idsOf(f.id('message-1')), [ids[1], ids[0]], 'in the order they were sent');
  assert.deepEqual(f.uploads.shown([f.id('message-1'), 'message-none']).get(f.id('message-1'))?.map(item => item.name), ['b.txt', 'a.txt']);
  assert.equal(f.uploads.shown(['message-none']).size, 0);
});

test('what she is told of a message’s files: the places, and the first four images shown beside it', async t => {
  const f = await setup(t, { maxFileBytes: MB, maxFiles: 10 });
  const ids: string[] = [];
  const add = async (data: Buffer, name: string) => {
    const result = await f.receive(data, name);
    assert.ok(result.ok);
    ids.push(result.upload.uploadId);
  };
  await add(Buffer.from('%PDF'), 'doc.pdf');
  for (const index of [1, 2, 3, 4, 5]) await add(pngOf(index, index), `p${index}.png`);
  f.uploads.attach(ids, f.message('message-1'));
  const line = f.uploads.lineEntries(f.id('message-1'));
  assert.equal(line.length, 6);
  assert.match(line[0]!.path, /^\/sources\/uploads\/20261006T123456Z-[0-9a-f]{4}\/doc\.pdf$/);
  assert.deepEqual(line.map(entry => [entry.bytes > 0, entry.shown_as_image ?? false]),
    [[true, false], [true, true], [true, true], [true, true], [true, true], [true, false]]);
  assert.equal(f.uploads.hasImages(f.id('message-1')), true);
  const images = await f.uploads.images(f.id('message-1'));
  assert.deepEqual(images.map(image => [image.mimeType, Buffer.from(image.data, 'base64').equals(pngOf(images.indexOf(image) + 1, images.indexOf(image) + 1))]),
    [['image/png', true], ['image/png', true], ['image/png', true], ['image/png', true]]);
});

test('an image too large to show is told by its place only', async t => {
  const f = await setup(t, { maxFileBytes: 8 * MB, maxFiles: 10 });
  const big = Buffer.concat([pngOf(1, 1), Buffer.alloc(6 * MB)]);
  const result = await f.receive(big, 'big.png');
  assert.ok(result.ok);
  assert.equal(result.upload.mimeType, 'image/png', 'still an image to the devices');
  f.uploads.attach([result.upload.uploadId], f.message('message-1'));
  assert.equal(f.uploads.lineEntries(f.id('message-1'))[0]!.shown_as_image, undefined);
  assert.equal(f.uploads.hasImages(f.id('message-1')), false);
  assert.deepEqual(await f.uploads.images(f.id('message-1')), []);
});

test('only a file a message carries is read back, by its ID', async t => {
  const f = await setup(t);
  const sent = await f.receive(Buffer.from('sent'), 'sent.txt');
  const unsent = await f.receive(Buffer.from('unsent'), 'unsent.txt');
  assert.ok(sent.ok && unsent.ok);
  f.uploads.attach([sent.upload.uploadId], f.message('message-1'));
  const read = await f.uploads.read(sent.upload.uploadId);
  assert.equal(read?.name, 'sent.txt');
  assert.deepEqual(await readFile(read!.file), Buffer.from('sent'));
  assert.equal(await f.uploads.read(unsent.upload.uploadId), undefined);
  assert.equal(await f.uploads.read('upload-unknown'), undefined);
});

test('files not sent within a day are cleared away; those sent are kept', async t => {
  const f = await setup(t);
  const sent = await f.receive(Buffer.from('sent'), 'sent.txt');
  const old = await f.receive(Buffer.from('old'), 'old.txt');
  assert.ok(sent.ok && old.ok);
  f.uploads.attach([sent.upload.uploadId], f.message('message-1'));
  f.clock.now += UNSENT_UPLOAD_MS / 2;
  const fresh = await f.receive(Buffer.from('fresh'), 'fresh.txt');
  assert.ok(fresh.ok);
  f.clock.now += UNSENT_UPLOAD_MS / 2 + 1;
  assert.equal(await f.uploads.sweep(), 1);
  assert.deepEqual(f.uploads.check([old.upload.uploadId], OWNER), { ok: false, code: 'upload-not-found' });
  assert.deepEqual(f.uploads.check([fresh.upload.uploadId], OWNER), { ok: true });
  assert.equal((await readdir(join(f.sources, 'uploads'))).length, 2);
  assert.ok(await f.uploads.read(sent.upload.uploadId));
});
