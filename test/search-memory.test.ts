import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SEARCH_MEMORY_DESCRIPTION } from '../src/server/prompts.ts';
import { SEARCH_OUTPUT_CHARS, searchCommand, searchMemoryTool } from '../src/server/search-memory.ts';
import { WorkspaceShell } from '../src/server/workspace-shell.ts';
import { startFakeRunner, type FakeRunner } from './support/fake-runner.ts';

// search_memory (ADR 0055): rg with fixed options over /memory, through the runner, for natsumi and the curator.

/**
 * The fake runner runs on this machine, where /memory does not exist, so the tool is given a directory here as its
 * root. What it sends is otherwise run as it is, by the real rg.
 */
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-search-')));
  const memory = join(root, 'memory');
  await mkdir(join(memory, 'people'), { recursive: true });
  await mkdir(join(memory, '.git'));
  const runner: FakeRunner = await startFakeRunner({ dir: root });
  const shell = new WorkspaceShell({ socketPath: runner.path });
  const sent: string[] = [];
  const tool = searchMemoryTool(command => { sent.push(command); return shell.capture(command); }, memory);
  const search = async (params: { query: string; path?: string }) => {
    try {
      const result = await tool.execute('call-1', params, undefined, undefined, undefined as never);
      return { ok: true, text: result.content.map(part => part.type === 'text' ? part.text : '').join('') };
    } catch (error) { return { ok: false, text: (error as Error).message }; }
  };
  return { root, memory, sent, search, tool, async cleanup() { await runner.close(); await rm(root, { recursive: true, force: true }); } };
}

test('a word is found in every memory file, with its file, its line number and two lines around it', async () => {
  const f = await setup();
  try {
    await writeFile(join(f.memory, 'people', 'tanaka.md'), '# 田中さん\n\n一行目\n二行目\n好物は Ramen\n四行目\n五行目\n六行目\n');
    await writeFile(join(f.memory, 'food.md'), '# 食べもの\n- ramen の店\n');
    // Not memory: the history is never searched.
    await writeFile(join(f.memory, '.git', 'ramen.md'), 'ramen\n');
    const found = await f.search({ query: 'RAMEN' });
    assert.equal(found.ok, true, found.text);
    assert.match(found.text, new RegExp(`${f.memory}/people/tanaka\\.md:5:好物は Ramen`));
    assert.match(found.text, new RegExp(`${f.memory}/food\\.md:2:- ramen の店`));
    // Two lines on each side, marked as context.
    assert.match(found.text, new RegExp(`${f.memory}/people/tanaka\\.md-3-一行目`));
    assert.match(found.text, new RegExp(`${f.memory}/people/tanaka\\.md-7-五行目`));
    assert.doesNotMatch(found.text, /六行目/);
    assert.doesNotMatch(found.text, /\.git/);
    assert.match(found.text, /read/, 'the rest is read with read');
  } finally { await f.cleanup(); }
});

test('the word is taken as it is written, never as a pattern or as an option', async () => {
  const f = await setup();
  try {
    await writeFile(join(f.memory, 'notes.md'), '# メモ\n- a.b を覚える\n- axb は別\n- --version と書いた\n- -e foo もある\n');
    const dotted = await f.search({ query: 'a.b' });
    assert.match(dotted.text, /a\.b を覚える/);
    assert.doesNotMatch(dotted.text, /notes\.md:\d+:- axb/, 'a dot is a dot, not any character');
    for (const query of ['--version', '-e foo']) {
      const outcome = await f.search({ query });
      assert.equal(outcome.ok, true, outcome.text);
      assert.match(outcome.text, new RegExp(`notes\\.md:\\d+:- ${query}`), query);
    }
    const quoted = await f.search({ query: "it's; rm -rf /" });
    assert.equal(quoted.ok, true, quoted.text);
    assert.match(quoted.text, /見つかりませんでした/);
    // Every query and path goes after `--`, in single quotes.
    for (const command of f.sent) assert.match(command, / -- '/);
  } finally { await f.cleanup(); }
});

test('a path narrows the search to a file or a directory inside memory, and nothing outside it is reached', async () => {
  const f = await setup();
  try {
    await writeFile(join(f.memory, 'people', 'tanaka.md'), '# 田中さん\n- 約束あり\n');
    await writeFile(join(f.memory, 'plans.md'), '# 予定\n- 約束あり\n');
    const narrowed = await f.search({ query: '約束', path: 'people' });
    assert.match(narrowed.text, /people\/tanaka\.md:2/);
    assert.doesNotMatch(narrowed.text, /plans\.md/);
    // The workspace's own spelling of the same place.
    const absolute = await f.search({ query: '約束', path: `${f.memory}/plans.md` });
    assert.match(absolute.text, /plans\.md:2/);
    const sentBefore = f.sent.length;
    for (const path of ['../secret', '/etc', 'people/../../x', '\u0000', '/memoryx']) {
      const outcome = await f.search({ query: '約束', path });
      assert.equal(outcome.ok, false, path);
      assert.match(outcome.text, /\/memory の中/, path);
    }
    assert.equal(f.sent.length, sentBefore, 'refused before the runner is asked');
    const missing = await f.search({ query: '約束', path: 'nowhere.md' });
    assert.equal(missing.ok, false);
    assert.match(missing.text, /探せませんでした/);
  } finally { await f.cleanup(); }
});

test('an empty word, a word of several lines and a word too long are refused before the runner is asked', async () => {
  const f = await setup();
  try {
    for (const query of ['', '   ', 'a\nb', 'x'.repeat(201), 'a\u0000b']) {
      const outcome = await f.search({ query });
      assert.equal(outcome.ok, false, JSON.stringify(query));
    }
    assert.deepEqual(f.sent, []);
  } finally { await f.cleanup(); }
});

test('nothing found says so, and a long result is cut with a note', async () => {
  const f = await setup();
  try {
    await writeFile(join(f.memory, 'empty.md'), '# 空\n');
    const none = await f.search({ query: '存在しない言葉' });
    assert.equal(none.ok, true);
    assert.match(none.text, /見つかりませんでした/);
    for (let i = 0; i < 40; i += 1) {
      await writeFile(join(f.memory, `long-${String(i).padStart(2, '0')}.md`), `# 長い\n${'- 長い行 needle '.repeat(20)}\n`.repeat(30));
    }
    const long = await f.search({ query: 'needle' });
    assert.equal(long.ok, true);
    assert.ok([...long.text].length < SEARCH_OUTPUT_CHARS + 400, String([...long.text].length));
    assert.match(long.text, /長いので/);
  } finally { await f.cleanup(); }
});

test('the command is rg with fixed options, and the description is one fixed string', () => {
  const built = searchCommand('ramen', undefined, '/memory');
  assert.equal(built.ok, true);
  const command = (built as { command: string }).command;
  for (const option of ['--fixed-strings', '--ignore-case', '--context 2', '--line-number', '--with-filename', '--max-count',
    '--max-columns', "--glob '!.git'"]) {
    assert.ok(command.includes(option), option);
  }
  assert.ok(command.endsWith("-- 'ramen' '/memory'"), command);
  assert.equal(searchMemoryTool(async () => ({ ok: false, text: '' })).description, SEARCH_MEMORY_DESCRIPTION);
  assert.doesNotMatch(SEARCH_MEMORY_DESCRIPTION, /\$\{/);
});
