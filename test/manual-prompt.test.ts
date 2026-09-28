import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { codeManualDirectory, readManualIndex } from '../src/server/manual.ts';
import { composeSystemPrompt, MANUAL_FALLBACK, WORKSPACE_COMMANDS } from '../src/server/prompts.ts';

/** The index of the manual and the workspace's own commands in the system prompt (ADR 0056). */

const parts = { personality: '', always: '', handoff: '' };
const INDEX = '| やりたいこと | 読むもの |\n| --- | --- |\n| FIXTURE-INDEX-4410 | `/manual/images.md` |';

test('with a workspace, the index the server read goes into the prompt in place of the sentence that points at it', () => {
  const prompt = composeSystemPrompt({ workspace: true, manualIndex: INDEX, ...parts });
  assert.ok(prompt.includes(INDEX));
  assert.ok(!prompt.includes(MANUAL_FALLBACK));
  // It stands inside the workspace section, before the kinds of event.
  assert.ok(prompt.indexOf('## 記憶と作業場') < prompt.indexOf(INDEX));
  assert.ok(prompt.indexOf(INDEX) < prompt.indexOf('## 出来事の種類'));
});

test('an index that could not be read leaves the one sentence of ADR 0036', () => {
  const prompt = composeSystemPrompt({ workspace: true, ...parts });
  assert.ok(prompt.includes(MANUAL_FALLBACK));
  assert.match(MANUAL_FALLBACK, /\/manual\/INDEX\.md/);
});

test('the three commands of the workspace are there, one line each, with the page to read and what does not work', () => {
  for (const index of [INDEX, undefined]) {
    const prompt = composeSystemPrompt({ workspace: true, ...(index ? { manualIndex: index } : {}), ...parts });
    assert.ok(prompt.includes(WORKSPACE_COMMANDS));
  }
  const lines = WORKSPACE_COMMANDS.split('\n').filter(line => line.startsWith('- '));
  assert.equal(lines.length, 3);
  const [sdctl, diff, view] = lines as [string, string, string];
  assert.match(sdctl, /^- `sdctl/);
  assert.match(sdctl, /\/manual\/images\.md/);
  assert.match(sdctl, /Python/);
  assert.match(diff, /^- `sources-diff/);
  assert.match(diff, /\/manual\/slack\.md/);
  assert.match(view, /^- `view/);
  // view is the server's own, and only a command that is view and a path alone reaches it.
  assert.match(view, /だけ/);
  assert.match(view, /cd/);
  assert.match(view, /&&/);
});

test('without a workspace, neither the index nor the commands go in', () => {
  const prompt = composeSystemPrompt({ workspace: false, manualIndex: INDEX, ...parts });
  assert.ok(!prompt.includes('FIXTURE-INDEX-4410'));
  assert.ok(!prompt.includes(WORKSPACE_COMMANDS));
  assert.ok(!prompt.includes('sdctl'));
  assert.ok(!prompt.includes(MANUAL_FALLBACK));
});

test('the index is read from INDEX.md alone, without its heading; the list of agents beside it stays out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-manual-'));
  try {
    await mkdir(join(root, 'agents'));
    await writeFile(join(root, 'INDEX.md'), `# マニュアル\n\n${INDEX}\n`);
    await writeFile(join(root, 'agents', 'INDEX.md'), '# 頼める相手\n\nFIXTURE-AGENT-9920\n');
    const index = await readManualIndex(root);
    assert.equal(index, INDEX);
    const prompt = composeSystemPrompt({ workspace: true, manualIndex: index, ...parts });
    assert.ok(!prompt.includes('FIXTURE-AGENT-9920'));
    assert.ok(!prompt.includes('# マニュアル\n'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a manual without INDEX.md, or with an empty one, is read as nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-manual-'));
  try {
    assert.equal(await readManualIndex(root), undefined);
    await writeFile(join(root, 'INDEX.md'), '# マニュアル\n');
    assert.equal(await readManualIndex(root), undefined);
    assert.equal(await readManualIndex(join(root, 'missing')), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the code manual is the checkout’s manual/, and its index reads as the prompt wants it', async () => {
  const directory = await codeManualDirectory();
  const index = await readManualIndex(directory);
  assert.ok(index);
  assert.equal(`# マニュアル\n\n${index}\n`, await readFile(join(directory, 'INDEX.md'), 'utf8'));
  // What only fits a file opened with read is not written there: the prompt says how to read already.
  assert.doesNotMatch(index, /read で読んでください/);
  // The agents' list is pointed at, not held.
  assert.match(index, /\/manual\/agents\/INDEX\.md/);
});
