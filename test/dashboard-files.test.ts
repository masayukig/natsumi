import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  classify, filesUrl, listDirectory, locate, look, openFile, readHead, TEXT_LIMIT, workspacePath, type FileRoots,
} from '../src/server/dashboard-files.ts';

// Her files as the dashboard reads them (ADR 0054): five places, one level at a time, never following a symlink and
// never leaving the place a URL names.

async function withRoots(fn: (roots: FileRoots, outside: string) => Promise<void>) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-files-')));
  const roots: FileRoots = { memory: join(base, 'data/memory'), work: join(base, 'data/work'), home: join(base, 'data/home'),
    manual: join(base, 'code/manual'), agents: join(base, 'data/agents'), avatar: join(base, 'data/avatar') };
  for (const directory of Object.values(roots)) await mkdir(directory, { recursive: true });
  const outside = join(base, 'data/.natsumi');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'not for the browser');
  try { await fn(roots, outside); } finally { await rm(base, { recursive: true, force: true }); }
}

const at = (path: string) => {
  const location = locate(`/dashboard/files${path}`);
  assert.ok(location, `${path} is a place`);
  return location;
};

test('a URL names one of the five places and the path below it, taken one element at a time', () => {
  assert.deepEqual(locate('/dashboard/files/memory'), { root: 'memory', place: '/memory', segments: [] });
  assert.deepEqual(locate('/dashboard/files/work/a/b.txt'), { root: 'work', place: '/work', segments: ['a', 'b.txt'] });
  assert.deepEqual(locate('/dashboard/files/home/natsumi/.bashrc'), { root: 'home', place: '/home/natsumi', segments: ['.bashrc'] });
  assert.deepEqual(locate('/dashboard/files/manual/INDEX.md'), { root: 'manual', place: '/manual', segments: ['INDEX.md'] });
  assert.deepEqual(locate('/dashboard/files/manual/agents/INDEX.md'), { root: 'agents', place: '/manual/agents', segments: ['INDEX.md'] },
    'as in the workspace, /manual/agents is its own place over /manual');
  assert.deepEqual(locate('/dashboard/files/work/%E3%83%A1%E3%83%A2%20a.md'), { root: 'work', place: '/work', segments: ['メモ a.md'] });
  assert.equal(workspacePath(at('/home/natsumi/a b')), '/home/natsumi/a b');
});

test('a URL that would leave its place, or is not one, names nothing', () => {
  for (const path of ['/dashboard/files', '/dashboard/files/', '/dashboard/files/etc/passwd', '/dashboard/files/home',
    '/dashboard/files/home/other', '/dashboard/files/memoryx', '/dashboard/files/work/../memory', '/dashboard/files/work/..',
    '/dashboard/files/work/.', '/dashboard/files/work/%2e%2e/secret', '/dashboard/files/work/%2E%2E',
    '/dashboard/files/work/a%2F..%2F..%2Fsecret', '/dashboard/files/work/..%2Fsecret', '/dashboard/files/work/a%2fb',
    '/dashboard/files/work/a%00b', '/dashboard/files/work//etc', '/dashboard/files/work/a/', '/dashboard/files/work/%E3%83',
    '/dashboard/files/work/%2Fetc%2Fpasswd', '/dashboard/filesx/work', '/dashboard/files/manual/agents/..']) {
    assert.equal(locate(path), undefined, path);
  }
});

test('a path in the workspace becomes the URL of its place, and one outside every place does not', () => {
  assert.equal(filesUrl('/memory/notes/a b.md'), '/dashboard/files/memory/notes/a%20b.md');
  assert.equal(filesUrl('/manual/agents/INDEX.md'), '/dashboard/files/manual/agents/INDEX.md');
  assert.equal(filesUrl('/home/natsumi'), '/dashboard/files/home/natsumi');
  assert.equal(filesUrl('/work/メモ.md'), '/dashboard/files/work/%E3%83%A1%E3%83%A2.md');
  for (const path of ['/etc/passwd', '/sources/slack/a.jsonl', '/memoryx/a', '/work/../etc/passwd', 'work/a', '/home/other',
    '/memory/.git/config', '/memory/.git', '/work/a\u0000b']) {
    assert.equal(filesUrl(path), undefined, path);
  }
});

test('a directory lists its entries one level down: directories first by name, sizes and times, and symlinks with where they point', () => withRoots(async roots => {
  await mkdir(join(roots.work, 'b-dir/deep'), { recursive: true });
  await writeFile(join(roots.work, 'b-dir/deep/big.txt'), 'x'.repeat(5000));
  await writeFile(join(roots.work, 'a.txt'), 'hello');
  await writeFile(join(roots.work, 'C.txt'), 'hi');
  await symlink('/etc', join(roots.work, 'etc-link'));
  const listing = await look(roots, at('/work'));
  assert.equal(listing.kind, 'directory');
  if (listing.kind !== 'directory') return;
  const { entries } = listDirectory(listing, { hidden: false, sort: 'name', order: 'asc' });
  assert.deepEqual(entries.map(entry => entry.name), ['b-dir', 'a.txt', 'C.txt', 'etc-link']);
  const dir = entries.find(entry => entry.name === 'b-dir')!;
  assert.equal(dir.type, 'directory');
  assert.equal(dir.size, null, 'a directory is not summed');
  assert.equal(entries.find(entry => entry.name === 'a.txt')!.size, 5);
  const link = entries.find(entry => entry.name === 'etc-link')!;
  assert.equal(link.type, 'symlink');
  assert.equal(link.target, '/etc');
}));

test('the listing sorts by name, time or size either way, directories first, and hides dotfiles unless asked', () => withRoots(async roots => {
  await writeFile(join(roots.home, 'old'), 'a'.repeat(30));
  await writeFile(join(roots.home, 'new'), 'a'.repeat(10));
  await writeFile(join(roots.home, 'mid'), 'a'.repeat(20));
  await writeFile(join(roots.home, '.bashrc'), 'set -o vi');
  await mkdir(join(roots.home, '.config'));
  await mkdir(join(roots.home, 'z-dir'));
  await utimes(join(roots.home, 'old'), 1_000, 1_000);
  await utimes(join(roots.home, 'mid'), 2_000, 2_000);
  await utimes(join(roots.home, 'new'), 3_000, 3_000);
  const listing = await look(roots, at('/home/natsumi'));
  assert.equal(listing.kind, 'directory');
  if (listing.kind !== 'directory') return;
  const names = (options: Parameters<typeof listDirectory>[1]) => listDirectory(listing, options).entries.map(entry => entry.name);
  assert.deepEqual(names({ hidden: false, sort: 'name', order: 'asc' }), ['z-dir', 'mid', 'new', 'old']);
  assert.deepEqual(names({ hidden: false, sort: 'name', order: 'desc' }), ['z-dir', 'old', 'new', 'mid']);
  assert.deepEqual(names({ hidden: false, sort: 'mtime', order: 'desc' }), ['z-dir', 'new', 'mid', 'old']);
  assert.deepEqual(names({ hidden: false, sort: 'mtime', order: 'asc' }), ['z-dir', 'old', 'mid', 'new']);
  assert.deepEqual(names({ hidden: false, sort: 'size', order: 'desc' }), ['z-dir', 'old', 'mid', 'new']);
  assert.deepEqual(names({ hidden: true, sort: 'name', order: 'asc' }), ['.config', 'z-dir', '.bashrc', 'mid', 'new', 'old']);
  assert.equal(listDirectory(listing, { hidden: false, sort: 'name', order: 'asc' }).hiddenCount, 2);
}));

test('the memory’s .git is never listed, not even with the dotfiles, and cannot be opened', () => withRoots(async roots => {
  await mkdir(join(roots.memory, '.git'));
  await writeFile(join(roots.memory, '.git/config'), '[core]');
  await writeFile(join(roots.memory, '.gitignore'), '*.tmp');
  await writeFile(join(roots.memory, 'always.md'), '# always');
  const listing = await look(roots, at('/memory'));
  assert.equal(listing.kind, 'directory');
  if (listing.kind !== 'directory') return;
  assert.deepEqual(listDirectory(listing, { hidden: true, sort: 'name', order: 'asc' }).entries.map(entry => entry.name), ['.gitignore', 'always.md']);
  assert.deepEqual(await look(roots, at('/memory/.git')), { kind: 'refused', reason: 'missing' });
  assert.deepEqual(await look(roots, at('/memory/.git/config')), { kind: 'refused', reason: 'missing' });
  assert.equal((await readHead(roots, at('/memory/.git/config'), TEXT_LIMIT)).kind, 'refused');
  // Elsewhere a .git is only a hidden directory.
  await mkdir(join(roots.work, 'repo/.git'), { recursive: true });
  assert.equal((await look(roots, at('/work/repo/.git'))).kind, 'directory');
}));

test('a symlink is never followed: not at the end, not in the middle, not even when it points inside the place', () => withRoots(async (roots, outside) => {
  await mkdir(join(roots.work, 'real'));
  await writeFile(join(roots.work, 'real/a.txt'), 'inside');
  await symlink(outside, join(roots.work, 'out'));
  await symlink(join(outside, 'secret.txt'), join(roots.work, 'secret-link'));
  await symlink('real', join(roots.work, 'in'));
  await symlink('real/a.txt', join(roots.work, 'a-link'));
  for (const path of ['/work/out', '/work/secret-link', '/work/in', '/work/a-link']) {
    const found = await look(roots, at(path));
    assert.equal(found.kind, 'refused', path);
    assert.equal(found.kind === 'refused' && found.reason, 'symlink', path);
  }
  assert.deepEqual(await look(roots, at('/work/secret-link')), { kind: 'refused', reason: 'symlink', target: join(outside, 'secret.txt') });
  for (const path of ['/work/out/secret.txt', '/work/in/a.txt']) {
    assert.deepEqual(await look(roots, at(path)), { kind: 'refused', reason: 'symlink' }, path);
    assert.equal((await readHead(roots, at(path), TEXT_LIMIT)).kind, 'refused', path);
    assert.equal((await openFile(roots, at(path))).kind, 'refused', path);
  }
  for (const path of ['/work/secret-link', '/work/a-link']) {
    assert.equal((await readHead(roots, at(path), TEXT_LIMIT)).kind, 'refused', path);
    assert.equal((await openFile(roots, at(path))).kind, 'refused', path);
  }
  const opened = await readHead(roots, at('/work/real/a.txt'), TEXT_LIMIT);
  assert.equal(opened.kind, 'file');
  assert.equal(opened.kind === 'file' && opened.head.toString(), 'inside');
}));

test('a place that is itself reached through a symlink is read where it really is', () => withRoots(async (roots) => {
  const real = `${roots.memory}-real`;
  await rm(roots.memory, { recursive: true });
  await mkdir(real);
  await writeFile(join(real, 'a.md'), 'remembered');
  await symlink(real, roots.memory);
  const opened = await readHead(roots, at('/memory/a.md'), TEXT_LIMIT);
  assert.equal(opened.kind === 'file' && opened.head.toString(), 'remembered');
}));

test('what is not there, and what is neither a file nor a directory, is refused', () => withRoots(async roots => {
  assert.deepEqual(await look(roots, at('/work/nothing')), { kind: 'refused', reason: 'missing' });
  assert.deepEqual(await look(roots, at('/work/nothing/deeper')), { kind: 'refused', reason: 'missing' });
  await writeFile(join(roots.work, 'file'), 'x');
  assert.deepEqual(await look(roots, at('/work/file/below')), { kind: 'refused', reason: 'missing' });
  await rm(roots.home, { recursive: true });
  assert.deepEqual(await look(roots, at('/home/natsumi')), { kind: 'refused', reason: 'missing' });
  assert.equal((await readHead(roots, at('/work'), TEXT_LIMIT)).kind, 'refused', 'a directory is not read as a file');
}));

test('the manual lists the agents as its own place, over anything of that name in the manual', () => withRoots(async roots => {
  await writeFile(join(roots.manual, 'INDEX.md'), '# manual');
  await mkdir(join(roots.manual, 'agents'));
  await writeFile(join(roots.manual, 'agents/stale.md'), 'baked in');
  await writeFile(join(roots.agents, 'INDEX.md'), '# agents');
  const listing = await look(roots, at('/manual'));
  assert.equal(listing.kind, 'directory');
  if (listing.kind !== 'directory') return;
  const entries = listDirectory(listing, { hidden: false, sort: 'name', order: 'asc' }).entries;
  assert.deepEqual(entries.map(entry => [entry.name, entry.type]), [['agents', 'directory'], ['INDEX.md', 'file']]);
  const agents = await look(roots, at('/manual/agents'));
  assert.equal(agents.kind, 'directory');
  if (agents.kind !== 'directory') return;
  assert.deepEqual(listDirectory(agents, { hidden: false, sort: 'name', order: 'asc' }).entries.map(entry => entry.name), ['INDEX.md']);
}));

test('a file is opened for streaming whole, with its size', () => withRoots(async roots => {
  await writeFile(join(roots.work, 'data.bin'), Buffer.from([0, 1, 2, 3]));
  const opened = await openFile(roots, at('/work/data.bin'));
  assert.equal(opened.kind, 'file');
  if (opened.kind !== 'file') return;
  try {
    assert.equal(opened.size, 4);
    assert.deepEqual([...(await opened.handle.readFile())], [0, 1, 2, 3]);
  } finally { await opened.handle.close(); }
}));

test('readHead reads at most the limit, and says how big the whole file is', () => withRoots(async roots => {
  await writeFile(join(roots.work, 'long.txt'), 'a'.repeat(100));
  const opened = await readHead(roots, at('/work/long.txt'), 10);
  assert.equal(opened.kind, 'file');
  if (opened.kind !== 'file') return;
  assert.equal(opened.size, 100);
  assert.equal(opened.head.length, 10);
}));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = Buffer.from('GIF89a\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

test('images are told by their first bytes, not their names: PNG, JPEG, GIF and WebP only', () => {
  assert.deepEqual(classify(PNG, PNG.length, TEXT_LIMIT), { type: 'image', mimeType: 'image/png' });
  assert.deepEqual(classify(JPEG, JPEG.length, TEXT_LIMIT), { type: 'image', mimeType: 'image/jpeg' });
  assert.deepEqual(classify(GIF, GIF.length, TEXT_LIMIT), { type: 'image', mimeType: 'image/gif' });
  assert.deepEqual(classify(WEBP, WEBP.length, TEXT_LIMIT), { type: 'image', mimeType: 'image/webp' });
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.deepEqual(classify(svg, svg.length, TEXT_LIMIT), { type: 'text', text: svg.toString(), truncated: false }, 'an SVG is text');
});

test('text is what has no NUL and reads as UTF-8; anything else is binary, named when it is known', () => {
  const text = Buffer.from('こんにちは\nline 2\n');
  assert.deepEqual(classify(text, text.length, TEXT_LIMIT), { type: 'text', text: text.toString(), truncated: false });
  assert.deepEqual(classify(Buffer.from([0x41, 0, 0x42]), 3, TEXT_LIMIT), { type: 'binary', label: 'バイナリ' });
  assert.deepEqual(classify(Buffer.from([0x41, 0xff, 0xfe, 0x42]), 4, TEXT_LIMIT), { type: 'binary', label: 'バイナリ' });
  assert.deepEqual(classify(Buffer.from('%PDF-1.7\n\u0000'), 10, TEXT_LIMIT), { type: 'binary', label: 'PDF' });
  assert.deepEqual(classify(Buffer.from([0x50, 0x4b, 3, 4, 0]), 5, TEXT_LIMIT), { type: 'binary', label: 'ZIP' });
  assert.deepEqual(classify(Buffer.from([0x1f, 0x8b, 8, 0]), 4, TEXT_LIMIT), { type: 'binary', label: 'gzip' });
  assert.deepEqual(classify(Buffer.from('SQLite format 3\u0000'), 16, TEXT_LIMIT), { type: 'binary', label: 'SQLite' });
  assert.deepEqual(classify(Buffer.alloc(0), 0, TEXT_LIMIT), { type: 'text', text: '', truncated: false }, 'an empty file is text');
});

test('text cut at the limit is cut on a character, and says it was cut', () => {
  // 'あ' is three bytes: a limit of 4 cuts the second one in half.
  const whole = Buffer.from('ああ');
  const head = whole.subarray(0, 4);
  assert.deepEqual(classify(head, whole.length, 4), { type: 'text', text: 'あ', truncated: true });
  assert.equal(TEXT_LIMIT, 1024 * 1024);
});

// ADR 0057: the page on drawing and the params the server writes from the avatar, seen as /manual/avatar.
test('/manual/avatar is a place of its own, found before /manual', () => {
  assert.deepEqual(locate('/dashboard/files/manual/avatar/images.md'), { root: 'avatar', place: '/manual/avatar', segments: ['images.md'] });
});
