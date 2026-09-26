import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { READ_DESCRIPTION } from '../src/server/prompts.ts';
import { READ_MAX_FILE_BYTES, READ_MAX_LINES, workspaceReadTool } from '../src/server/read-tool.ts';
import { WorkspaceShell } from '../src/server/workspace-shell.ts';
import { startFakeRunner, type FakeRunner } from './support/fake-runner.ts';

// The built-in read, pointed at the workspace (ADR 0047): /manual and /memory only, through the runner.

/**
 * The fake runner runs on this machine, where /manual and /memory do not exist, so the workspace's two places are
 * directories here and every command has them spelled out. What the tool sends is otherwise run as it is.
 */
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-read-')));
  await mkdir(join(root, 'manual'));
  await mkdir(join(root, 'memory'));
  await mkdir(join(root, 'work'));
  const runner: FakeRunner = await startFakeRunner({ dir: join(root, 'work') });
  const shell = new WorkspaceShell({ socketPath: runner.path });
  const sent: string[] = [];
  const tool = workspaceReadTool(command => {
    sent.push(command);
    return shell.capture(command.replaceAll("'/manual/", `'${root}/manual/`).replaceAll("'/memory/", `'${root}/memory/`));
  });
  const read = async (params: { path: string; offset?: number; limit?: number }) => {
    try {
      const result = await tool.execute('call-1', params, undefined, undefined, undefined as never);
      return { ok: true, text: result.content.map(part => part.type === 'text' ? part.text : `[${part.type}]`).join('') };
    } catch (error) { return { ok: false, text: (error as Error).message }; }
  };
  return { root, sent, read, tool, async cleanup() { await runner.close(); await rm(root, { recursive: true, force: true }); } };
}

test('a manual page and a memory file are read through the runner', async () => {
  const f = await setup();
  try {
    await writeFile(join(f.root, 'manual', 'INDEX.md'), '# マニュアル\n一行目\n');
    await writeFile(join(f.root, 'memory', 'people.md'), '# 人\n- 田中さん\n');
    assert.deepEqual(await f.read({ path: '/manual/INDEX.md' }), { ok: true, text: '# マニュアル\n一行目\n' });
    assert.deepEqual(await f.read({ path: '/memory/people.md' }), { ok: true, text: '# 人\n- 田中さん\n' });
    // A relative path is the workspace's: its working directory is /work, so it reaches the memory through `..`.
    assert.deepEqual(await f.read({ path: '../memory/people.md' }), { ok: true, text: '# 人\n- 田中さん\n' });
    assert.ok(f.sent.length > 0);
  } finally { await f.cleanup(); }
});

test('anything outside /manual and /memory is refused before the runner is asked', async () => {
  const f = await setup();
  try {
    for (const path of ['/etc/passwd', '/work/draft.md', '/home/natsumi/.bashrc', '/memory', '/manualx/a.md',
      '/memory/../etc/passwd', 'draft.md', '~/.bashrc', '/run/secrets/natsumi_tls_key']) {
      const outcome = await f.read({ path });
      assert.equal(outcome.ok, false, path);
      assert.match(outcome.text, /\/manual と \/memory の下/, path);
    }
    assert.deepEqual(f.sent, []);
  } finally { await f.cleanup(); }
});

test('a missing file says so', async () => {
  const f = await setup();
  try {
    const outcome = await f.read({ path: '/memory/nothing.md' });
    assert.equal(outcome.ok, false);
    assert.match(outcome.text, /見つかりません/);
  } finally { await f.cleanup(); }
});

test('images and other binary files are not read, and nothing is sent as an image', async () => {
  const f = await setup();
  try {
    await writeFile(join(f.root, 'memory', 'face.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
    await writeFile(join(f.root, 'memory', 'data.bin'), Buffer.from([0x41, 0x00, 0x42]));
    for (const path of ['/memory/face.png', '/memory/data.bin']) {
      const outcome = await f.read({ path });
      assert.equal(outcome.ok, false, path);
      assert.match(outcome.text, /view/, path);
    }
  } finally { await f.cleanup(); }
});

test('one read returns at most the line limit and says where to go on', async () => {
  const f = await setup();
  try {
    const lines = Array.from({ length: READ_MAX_LINES + 50 }, (_, index) => `行 ${index + 1}`);
    await writeFile(join(f.root, 'memory', 'long.md'), lines.join('\n'));
    const first = await f.read({ path: '/memory/long.md' });
    assert.ok(first.ok);
    assert.ok(first.text.startsWith('行 1\n'));
    assert.ok(first.text.includes(`行 ${READ_MAX_LINES}\n`));
    assert.ok(!first.text.includes(`行 ${READ_MAX_LINES + 1}\n`));
    assert.match(first.text, new RegExp(`offset=${READ_MAX_LINES + 1}`));
    // Asking for more than the limit gets the limit.
    const asked = await f.read({ path: '/memory/long.md', limit: 10_000 });
    assert.ok(!asked.text.includes(`行 ${READ_MAX_LINES + 1}\n`));
    const rest = await f.read({ path: '/memory/long.md', offset: READ_MAX_LINES + 1 });
    assert.ok(rest.text.startsWith(`行 ${READ_MAX_LINES + 1}\n`));
    assert.ok(rest.text.endsWith(`行 ${READ_MAX_LINES + 50}`));
  } finally { await f.cleanup(); }
});

test('a file larger than the runner answers at once is read in pieces, whole and unbroken', async () => {
  const f = await setup();
  try {
    // Multi-byte characters across the runner's 64 KiB answer, so a piece boundary falls inside a character.
    const text = Array.from({ length: 300 }, (_, index) => `${index}: ${'日本語の記憶'.repeat(40)}`).join('\n');
    assert.ok(Buffer.byteLength(text) > 64 * 1024 && Buffer.byteLength(text) < READ_MAX_FILE_BYTES);
    await writeFile(join(f.root, 'memory', 'big.md'), text);
    const outcome = await f.read({ path: '/memory/big.md', offset: 250, limit: 5 });
    assert.ok(outcome.ok, outcome.text);
    assert.ok(outcome.text.startsWith(`249: ${'日本語の記憶'.repeat(40)}\n`));
    assert.doesNotMatch(outcome.text, /�/);
  } finally { await f.cleanup(); }
});

test('a file past the size limit is refused with the way to read part of it', async () => {
  const f = await setup();
  try {
    await writeFile(join(f.root, 'memory', 'huge.md'), 'a'.repeat(READ_MAX_FILE_BYTES + 1));
    const outcome = await f.read({ path: '/memory/huge.md' });
    assert.equal(outcome.ok, false);
    assert.match(outcome.text, /run_shell/);
  } finally { await f.cleanup(); }
});

test('the description is the fixed Japanese one, naming the limit the tool enforces', async () => {
  const f = await setup();
  try {
    assert.equal(f.tool.name, 'read');
    assert.equal(f.tool.description, READ_DESCRIPTION);
    assert.ok(READ_DESCRIPTION.includes(`${READ_MAX_LINES} 行`));
  } finally { await f.cleanup(); }
});
