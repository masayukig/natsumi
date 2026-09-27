import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { conditions, loadScene } from '../src/eval/scene.ts';
import { runCondition, runEvaluation } from '../src/eval/run.ts';
import { bwrapAvailable, goAvailable, WorkspaceRunner } from '../src/eval/workspace.ts';
import type { RunRecord } from '../src/eval/record.ts';

const run = promisify(execFile);
const REPOSITORY = join(import.meta.dirname, '..');
const skip = (await goAvailable()) ? false : 'go is not installed, so the runner cannot be built';
// A scene that reads the workspace's paths (/manual, /memory, /sources) needs them laid out, which only bubblewrap does.
const sandboxed = skip || ((await bwrapAvailable()) ? false : 'bubblewrap cannot make a sandbox here');

const GREETING = `
description: 本人のあいさつに、作業場のメモを見てから返事をする
runs: 2
time: "2026-09-27T09:00:00+09:00"
files:
  /work/notes.md: |
    FIXTURE-NOTE-3301
  /memory/personality.md: |
    # 性格・話し方
    FIXTURE-PERSONALITY-2210
event:
  mac_message: おはよう
dryRun:
  - calls:
      - { tool: run_shell, args: { command: "cat notes.md && echo written > out.txt && cat out.txt" } }
  - calls:
      - { tool: reply_to_mac, args: { text: おはよう！メモを見たよ, expression: happy } }
checks:
  - { id: replied, called: reply_to_mac, max: 1 }
  - { id: looked, shell: "cat notes\\\\.md" }
  - { id: saw, output: FIXTURE-NOTE-3301 }
  - { id: wrote, output: written }
  - { id: quiet, notCalled: notify_owner }
  - { id: kind, rubric: 朝のあいさつとして自然に返している。 }
  - { id: custom, function: happy }
variants:
  plain: {}
  edited:
    prompt:
      - replace: "FIXTURE-PERSONALITY-2210"
        with: "FIXTURE-PERSONALITY-EDITED"
`;

const CHECKS_TS = `
import type { RunRecord } from '../../../src/eval/record.ts';
export const happy = (record: RunRecord) => record.replies.some(reply => reply.expression === 'happy');
`;

async function withScenes(scenes: Record<string, { yaml: string; ts?: string; files?: Record<string, string> }>,
  body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-eval-'));
  try {
    for (const [name, scene] of Object.entries(scenes)) {
      await mkdir(join(root, 'scenes', name), { recursive: true });
      await writeFile(join(root, 'scenes', name, 'scene.yaml'), scene.yaml);
      if (scene.ts) await writeFile(join(root, 'scenes', name, 'scene.ts'), scene.ts.replace('../../../src', join(REPOSITORY, 'src')));
      for (const [file, text] of Object.entries(scene.files ?? {})) await writeFile(join(root, 'scenes', name, file), text);
    }
    await body(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('a dry run goes through the real turn: the event line, the shell in the workspace, the reply and the checks', { skip }, async () => {
  await withScenes({ greeting: { yaml: GREETING, ts: CHECKS_TS } }, async root => {
    const scene = await loadScene(join(root, 'scenes', 'greeting'));
    const [plain, edited] = conditions(scene);
    const runner = await WorkspaceRunner.prepare({ repository: REPOSITORY, cache: join(root, 'cache') });
    const record = await runCondition(plain!, { run: 1, dryRun: true, repository: REPOSITORY, work: join(root, 'work'), runner });

    assert.equal(record.outcome, 'ok', record.error);
    assert.equal(record.dryRun, true);
    // The line is the loop's own: a mac_message with the text, and no event ID (ADR 0024).
    assert.match(record.prompt, /^<events>\n/);
    assert.deepEqual(record.events.map(event => [event.type, event.text]), [['mac_message', 'おはよう']]);
    assert.ok(!record.prompt.includes('event-'));
    // The shell ran for real in the workspace.
    const shell = record.tools.find(tool => tool.name === 'run_shell')!;
    assert.match(shell.result, /FIXTURE-NOTE-3301/);
    assert.match(shell.result, /written/);
    // The reply went through the loop into its records, as the Mac would have been shown it.
    assert.deepEqual(record.replies, [{ kind: 'reply', text: 'おはよう！メモを見たよ', expression: 'happy', call: 2 }]);
    assert.equal(record.modelCalls, 3);
    assert.deepEqual(record.checks.map(check => [check.id, check.by, check.pass]), [
      ['replied', 'rule', true], ['looked', 'rule', true], ['saw', 'rule', true], ['wrote', 'rule', true], ['quiet', 'rule', true],
      ['kind', 'llm', true], ['custom', 'function', true]]);
    // Each check met by a call says which: the shell was the first call, the reply the second. Not doing, rubrics and
    // functions say none.
    assert.deepEqual(record.checks.map(check => [check.id, check.reached?.call]), [
      ['replied', 2], ['looked', 1], ['saw', 1], ['wrote', 1], ['quiet', undefined], ['kind', undefined], ['custom', undefined]]);
    // Each call ends later than the one before, and the time and tokens up to a check are those of the calls up to it.
    const ends = record.calls.map(call => call.at!);
    assert.ok(ends.every((end, index) => end > 0 && (index === 0 || end >= ends[index - 1]!)), ends.join(','));
    const replied = record.checks[0]!.reached!;
    assert.equal(replied.ms, ends[1]);
    assert.equal(replied.tokens.input, record.calls[0]!.input + record.calls[1]!.input);

    // A variant that edits the instructions is handed a different prompt; the record tells them apart by a digest.
    const second = await runCondition(edited!, { run: 1, dryRun: true, repository: REPOSITORY, work: join(root, 'work'), runner });
    assert.equal(second.outcome, 'ok', second.error);
    assert.notEqual(second.instructions.sha256, record.instructions.sha256);
    assert.equal(second.instructions.sha256.length, 64);
  });
});

test('a prompt edit whose text is not in the instructions stops the run with the reason', { skip }, async () => {
  await withScenes({ bad: { yaml: `
event: { mac_message: やあ }
prompt:
  - replace: "この文はどこにもない"
    with: "x"
` } }, async root => {
    const [condition] = conditions(await loadScene(join(root, 'scenes', 'bad')));
    const runner = await WorkspaceRunner.prepare({ repository: REPOSITORY, cache: join(root, 'cache') });
    const record = await runCondition(condition!, { run: 1, dryRun: true, repository: REPOSITORY, work: join(root, 'work'), runner });
    assert.equal(record.outcome, 'error');
    assert.match(record.error!, /この文はどこにもない/);
  });
});

test('the turn before sets the context: a prelude, and a session copied from an earlier run', { skip }, async () => {
  await withScenes({
    prelude: { yaml: `
context:
  prelude:
    - event: { mac_message: きのうの話 }
      calls:
        - { tool: reply_to_mac, args: { text: うん、覚えてる, expression: happy } }
  padding: { turns: 2, chars: 500 }
event: { ping: {} }
` },
  }, async root => {
    const runner = await WorkspaceRunner.prepare({ repository: REPOSITORY, cache: join(root, 'cache') });
    const [condition] = conditions(await loadScene(join(root, 'scenes', 'prelude')));
    const first = await runCondition(condition!, { run: 1, dryRun: true, repository: REPOSITORY, work: join(root, 'work'), runner });
    assert.equal(first.outcome, 'ok', first.error);
    // The prelude turn, its memo, and two padding turns with theirs.
    assert.ok(first.priorMessages >= 6, String(first.priorMessages));
    assert.deepEqual(first.events.map(event => event.type), ['ping']);
    assert.ok(first.session, 'the session of the run is kept');

    await mkdir(join(root, 'scenes', 'copied'));
    await writeFile(join(root, 'scenes', 'copied', 'session.jsonl'), await readFile(first.session!));
    await writeFile(join(root, 'scenes', 'copied', 'scene.yaml'), 'context:\n  session: ./session.jsonl\nevent: { mac_message: つづき }\n');
    const [copied] = conditions(await loadScene(join(root, 'scenes', 'copied')));
    const second = await runCondition(copied!, { run: 1, dryRun: true, repository: REPOSITORY, work: join(root, 'work'), runner });
    assert.equal(second.outcome, 'ok', second.error);
    assert.ok(second.priorMessages >= first.priorMessages + 2, `${second.priorMessages} after ${first.priorMessages}`);
  });
});

test('a raw event line is handed over through the loop, and a scene that needs a missing feature is skipped', { skip }, async () => {
  await withScenes({
    raw: { yaml: 'event:\n  line: { type: fixture_event, note: FIXTURE-LINE-8812 }\n' },
    later: { yaml: 'requires: [sources-updated]\nevent:\n  line: { type: sources_updated }\n' },
  }, async root => {
    const out = join(root, 'results');
    const result = await runEvaluation({ scenes: [join(root, 'scenes')], out, label: 'dry', dryRun: true, runs: 1,
      repository: REPOSITORY, features: new Set() });
    const records = (await readFile(join(out, 'dry', 'runs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as RunRecord);
    assert.deepEqual(records.map(record => [record.scene, record.outcome]), [['raw', 'ok']]);
    assert.match(records[0]!.prompt, /FIXTURE-LINE-8812/);
    assert.deepEqual(result.summary.skipped, [{ scene: 'later', reason: 'requires sources-updated' }]);
    assert.match(await readFile(join(out, 'dry', 'summary.md'), 'utf8'), /later/);
  });
});

test('npm run eval runs, summarizes and compares; the model file key and endpoint never reach the results', { skip }, async () => {
  await withScenes({ greeting: { yaml: GREETING, ts: CHECKS_TS } }, async root => {
    const out = join(root, 'results');
    await writeFile(join(root, 'key'), 'fixture-secret-key-9051\n');
    await writeFile(join(root, 'model.json'), JSON.stringify({ pi: { model: { provider: 'natsumi-compatible', id: 'fixture-model' },
      compatible: { baseUrl: 'https://llm.internal-fixture.example/v1', apiKeyFile: join(root, 'key') } } }));
    const cli = (...args: string[]) => run(process.execPath, [join(REPOSITORY, 'src', 'eval', 'cli.ts'), ...args],
      { cwd: REPOSITORY, encoding: 'utf8' });
    for (const label of ['a', 'b']) {
      await cli('run', '--scenes', join(root, 'scenes'), '--model', join(root, 'model.json'), '--dry-run', '--runs', '2',
        '--out', out, '--label', label);
    }
    const files = await readdir(join(out, 'a'));
    assert.ok(files.includes('runs.jsonl') && files.includes('summary.md') && files.includes('summary.json'), files.join(','));
    const records = (await readFile(join(out, 'a', 'runs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as RunRecord);
    // Two variants, two runs each, taken in turns so that a drifting endpoint weighs on every condition alike.
    assert.deepEqual(records.map(record => `${record.variant}#${record.run}`), ['plain#1', 'edited#1', 'plain#2', 'edited#2']);
    assert.deepEqual(records[0]!.model, { provider: 'natsumi-compatible', id: 'fixture-model' });
    const everything = await run('grep', ['-r', '-l', '-e', 'fixture-secret-key-9051', '-e', 'internal-fixture', out]).catch(error => error);
    assert.equal(everything.stdout ?? '', '');

    const summary = await cli('summarize', join(out, 'a'));
    assert.match(summary.stdout, /replied/);
    // The reply is the second call in every run, the shell the first.
    assert.match(summary.stdout, /\| plain \| replied \| rule \| 2\/2 \| 100% \| [^|]+ \| 0 \| 2 \/ 2 \| /);
    assert.match(summary.stdout, /\| plain \| looked \| rule \| 2\/2 \| 100% \| [^|]+ \| 0 \| 1 \/ 1 \| /);
    const compared = await cli('compare', join(out, 'a'), join(out, 'b'));
    assert.match(compared.stdout, /replied/);
    assert.match(compared.stdout, /\+0/);
    assert.match(compared.stdout, /\| plain \| replied \| .* \| 2（2 回） \| 2（2 回） \| 0 \|/);
  });
});

test('a run deep in the results still reaches its runner: the socket is not made under the run directory', { skip }, async () => {
  await withScenes({ greeting: { yaml: GREETING, ts: CHECKS_TS } }, async root => {
    const [plain] = conditions(await loadScene(join(root, 'scenes', 'greeting')));
    const runner = await WorkspaceRunner.prepare({ repository: REPOSITORY, cache: join(root, 'cache') });
    const deep = join(root, 'results', 'a-long-label-for-a-long-comparison', 'work', 'x'.repeat(60));
    const record = await runCondition(plain!, { run: 1, dryRun: true, repository: REPOSITORY, work: deep, runner });
    assert.equal(record.outcome, 'ok', record.error);
  });
});

// ADR 0050 is on this branch: the repository's sources_updated scene runs on the loop's real side for outside events.
test('the sources-mention scene of the repository runs dry: the mention and its parent are read, and the dove is asked', { skip: sandboxed }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-eval-sources-'));
  try {
    const scene = await loadScene(join(REPOSITORY, 'eval', 'scenes', 'sources-mention'));
    assert.deepEqual(scene.requires, []);
    const runner = await WorkspaceRunner.prepare({ repository: REPOSITORY, cache: join(root, 'cache') });
    const all = conditions(scene);
    for (const condition of [all.find(c => c.variant === 'P/with'), all.find(c => c.variant === 'P/without')]) {
      assert.ok(condition, all.map(c => c.variant).join(','));
      const record = await runCondition(condition, { run: 1, dryRun: true, repository: REPOSITORY, work: join(root, 'work', condition.variant), runner });
      assert.equal(record.outcome, 'ok', record.error);
      assert.match(record.prompt, /"type":"sources_updated"/);
      assert.match(record.prompt, /"path":"\.\[36\]"/);
      const passed = Object.fromEntries(record.checks.filter(check => check.by !== 'llm').map(check => [check.id, check.pass]));
      assert.deepEqual(passed, { mention: true, 'mention-clean': true, parent: true, 'reply-target': true, 'random-once': true, finished: true },
        condition.variant);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
