import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DataDirectoryError, initializeDataDirectory, resolveDataDirectory } from '../src/server/data-directory.ts';

async function withRoot(fn: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-data-')));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('--data-dir wins over the launch cwd and is resolved to an absolute real path', () => withRoot(async root => {
  await mkdir(join(root, 'real'));
  await symlink(join(root, 'real'), join(root, 'link'));
  assert.equal(await resolveDataDirectory('link', root), join(root, 'real'));
  assert.equal(await resolveDataDirectory(undefined, join(root, 'link')), join(root, 'real'));
  assert.equal(await resolveDataDirectory(join(root, 'real'), '/'), join(root, 'real'));
}));

test('a missing data directory is refused instead of being created from a typo', () => withRoot(async root => {
  await assert.rejects(resolveDataDirectory(join(root, 'nope'), root),
    (error: unknown) => error instanceof DataDirectoryError && /does not exist/.test(error.message));
  await writeFile(join(root, 'file'), '');
  await assert.rejects(resolveDataDirectory(join(root, 'file'), root), /not a directory/);
}));

test('a data directory inside a natsumi code checkout is refused', () => withRoot(async root => {
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'natsumi' }));
  await mkdir(join(root, 'data', 'nested'), { recursive: true });
  for (const dir of [root, join(root, 'data'), join(root, 'data', 'nested')]) {
    await assert.rejects(resolveDataDirectory(dir, '/'),
      (error: unknown) => error instanceof DataDirectoryError && /code checkout/.test(error.message));
  }
  // A symlink from outside still resolves into the checkout.
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-link-')));
  try {
    await symlink(join(root, 'data'), join(outside, 'data'));
    await assert.rejects(resolveDataDirectory(join(outside, 'data'), '/'), /code checkout/);
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

test('this repository itself is recognized as a code checkout', async () => {
  await assert.rejects(resolveDataDirectory(new URL('..', import.meta.url).pathname, '/'), /code checkout/);
});

test('an unrelated package or a private git repository is an acceptable data directory', () => withRoot(async root => {
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'something-else' }));
  await mkdir(join(root, '.git'));
  assert.equal(await resolveDataDirectory(root, '/'), root);
}));

test('initialization shares the workspace places with the group and keeps the server state to its owner', () => withRoot(async root => {
  await initializeDataDirectory(root);
  // memory/, and the two places the workspace container mounts as /work and /home/natsumi (ADR 0019), and the list of
  // agents it sees read-only as /manual/agents (ADR 0036). The workspace may run as another UID in a shared group, so
  // the group writes them, and setgid keeps new entries in that group (ADR 0033). skills/ is where the owner's clone of
  // their skills goes, which the workspace sees read-only as /skills and the owner writes over ssh (ADR 0073).
  for (const dir of ['memory', 'work', 'home', 'agents', 'skills']) {
    const info = await stat(join(root, dir));
    assert.ok(info.isDirectory());
    assert.equal(info.mode & 0o7777, 0o2770, dir);
  }
  const state = await stat(join(root, '.natsumi'));
  assert.ok(state.isDirectory());
  assert.equal(state.mode & 0o7777, 0o700);
  // personality.md is not made here: it belongs to the memory repository (ADR 0018).
  await assert.rejects(stat(join(root, 'personality.md')));
}));

test('initialization never overwrites or re-permissions existing personal files', () => withRoot(async root => {
  await mkdir(join(root, 'memory'), { mode: 0o755 });
  await writeFile(join(root, 'memory', 'note.md'), 'existing memory');
  await writeFile(join(root, 'personality.md'), 'my own personality', { mode: 0o644 });
  await initializeDataDirectory(root);
  await initializeDataDirectory(root);
  assert.equal(await readFile(join(root, 'personality.md'), 'utf8'), 'my own personality');
  assert.equal(await readFile(join(root, 'memory', 'note.md'), 'utf8'), 'existing memory');
  assert.equal((await stat(join(root, 'personality.md'))).mode & 0o777, 0o644);
  assert.equal((await stat(join(root, 'memory'))).mode & 0o777, 0o755);
}));

test('a file where a directory is expected stops initialization', () => withRoot(async root => {
  await writeFile(join(root, 'memory'), 'not a directory');
  await assert.rejects(initializeDataDirectory(root), (error: unknown) => error instanceof DataDirectoryError);
  assert.equal(await readFile(join(root, 'memory'), 'utf8'), 'not a directory');
}));
