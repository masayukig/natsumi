import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { CURATOR_DEFAULTS } from '../src/server/config.ts';
import { CURATOR_STAGES, CurationRecord, runCuratorNight, type CuratorStageResult } from '../src/server/memory-curator.ts';
import { MemoryRepository } from '../src/server/memory-repository.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { WorkspaceShell } from '../src/server/workspace-shell.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { startFakeRunner } from './support/fake-runner.ts';
import { ScriptedModel, type ScriptedStep } from './support/scripted-model.ts';

// The curator's night called from outside the thinking loop (ADR 0068), as the evaluation on a copy of production
// calls it. Fictional memories only.

const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });
const stageOf = (context: Context) => CURATOR_STAGES.find(stage => context.systemPrompt?.includes(stage.instructions('なつみ')))?.name;

test('a night runs every stage from what it is handed, and tells each stage\'s outcome, commit and note', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-curator-night-')));
  const data = join(root, 'data');
  const memory = join(data, 'memory');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  for (const directory of [memory, sessionDirectory, agentDirectory]) await mkdir(directory, { recursive: true });
  await writeFile(join(memory, '予定.md'), '# 予定\n\n- 歯医者は金曜\n');
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const runner = await startFakeRunner({ dir: memory });
  try {
    const repository = new MemoryRepository({ directory: memory, dataDirectory: data });
    await repository.initialize(undefined);
    const shell = new WorkspaceShell({ socketPath: runner.path, timeoutMs: 10_000, timeZone: 'Asia/Tokyo', memoryChanges: () => repository.changeSummary() });
    const model = new ScriptedModel();
    const steps: Record<string, ScriptedStep[]> = {
      structure: [
        { calls: [call('run_shell', { command: "printf '# 予定\\n\\n## 通院\\n- 歯医者は金曜\\n' > 予定.md" })] },
        { calls: [call('write_change_note', { text: '予定を節に分けた' })] },
      ],
      index: [{ calls: [call('run_shell', { command: "printf '# 記憶の索引\\n\\n- 予定.md: 近い予定\\n' > INDEX.md" })] }],
    };
    model.auto = context => {
      if (context.messages.at(-1)?.role === 'assistant') return { calls: [] };
      return steps[stageOf(context) ?? '']?.[context.messages.filter(message => message.role === 'assistant').length] ?? { calls: [] };
    };
    const now = Date.parse('2026-10-04T19:00:00.000Z');
    const record = new CurationRecord(db, () => now);
    const begun: string[] = [];
    const ended: CuratorStageResult[] = [];
    const logs: string[] = [];

    const night = await runCuratorNight({
      repository, shell, modelRuntime: await fixtureRuntime(),
      route: { name: 'default', target: SUBSCRIPTION_TARGET, compatible: false },
      config: CURATOR_DEFAULTS, record, now: () => now, log: line => logs.push(line),
      name: 'なつみ', timeZone: 'Asia/Tokyo', fileMaxChars: 32000,
      dataDirectory: data, agentDirectory, sessionDirectory, thinking: 'off',
      configureSession: session => { session.agent.streamFunction = model.streamFunction; },
      onStageBegin: stage => { begun.push(stage.stage); },
      onStageEnd: result => { ended.push(result); },
    });

    assert.deepEqual(night.stages.map(stage => [stage.stage, stage.eventKinds, stage.outcome]),
      [['archive', 'memory_curator:archive', 'ok'], ['structure', 'memory_curator:structure', 'ok'], ['index', 'memory_curator:index', 'ok']]);
    assert.deepEqual(begun, ['archive', 'structure', 'index']);
    assert.deepEqual(ended, night.stages);
    const git = (...args: string[]) => execFileSync('git', ['-C', memory, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8' }).trim();
    const [, structure, index] = night.stages;
    assert.equal(structure!.commit, git('rev-parse', 'HEAD~1'));
    assert.equal(structure!.note, '予定を節に分けた');
    assert.deepEqual(structure!.files, ['予定.md']);
    assert.equal(index!.commit, git('rev-parse', 'HEAD'));
    assert.equal(index!.note, undefined);
    assert.match(git('log', '-1', '--format=%s'), /^memory_curator:index: INDEX\.md$/);
    assert.match(await readFile(join(memory, '予定.md'), 'utf8'), /## 通院/);
    assert.equal(record.base(), git('rev-parse', 'HEAD'));
    assert.ok(record.curatedAt().has('予定.md'));
    assert.ok(structure!.calls >= 2);
    assert.match(structure!.place?.sessionFile ?? '', /^curator\//);
  } finally {
    await runner.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a stop before a stage begins runs no stage', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-curator-night-')));
  const memory = join(root, 'memory');
  await mkdir(memory, { recursive: true });
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  try {
    const repository = new MemoryRepository({ directory: memory, dataDirectory: root });
    await repository.initialize(undefined);
    const controller = new AbortController();
    controller.abort();
    const night = await runCuratorNight({
      repository, shell: { run: async () => ({ ok: true, text: '' }), capture: async () => ({ ok: false, text: 'unused' }) },
      modelRuntime: await fixtureRuntime(), route: { name: 'default', target: SUBSCRIPTION_TARGET, compatible: false },
      config: CURATOR_DEFAULTS, record: new CurationRecord(db, Date.now), now: Date.now, log: () => {},
      name: 'なつみ', timeZone: 'Asia/Tokyo', fileMaxChars: 32000,
      dataDirectory: root, agentDirectory: root, sessionDirectory: root, thinking: 'off', signal: controller.signal,
    });
    assert.deepEqual(night.stages, []);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** A night on a fictional memory, each stage following its steps by the number of model calls it has made. */
async function aNight(steps: Record<string, ScriptedStep[]>, config: Partial<typeof CURATOR_DEFAULTS> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-curator-night-')));
  const data = join(root, 'data');
  const memory = join(data, 'memory');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  for (const directory of [memory, sessionDirectory, agentDirectory]) await mkdir(directory, { recursive: true });
  await writeFile(join(memory, '予定.md'), '# 予定\n\n- 歯医者は金曜\n- なつみのマスターは 2026-09-10 に健診を受けた\n');
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const runner = await startFakeRunner({ dir: memory });
  const seen: Context[] = [];
  try {
    const repository = new MemoryRepository({ directory: memory, dataDirectory: data });
    await repository.initialize(undefined);
    const shell = new WorkspaceShell({ socketPath: runner.path, timeoutMs: 10_000, timeZone: 'Asia/Tokyo', memoryChanges: () => repository.changeSummary() });
    const model = new ScriptedModel();
    model.auto = context => {
      seen.push(context);
      if (context.messages.at(-1)?.role === 'assistant') return { calls: [] };
      return steps[stageOf(context) ?? '']?.[context.messages.filter(message => message.role === 'assistant').length] ?? { calls: [] };
    };
    const now = Date.parse('2026-10-04T19:00:00.000Z');
    const logs: string[] = [];
    const night = await runCuratorNight({
      repository, shell, modelRuntime: await fixtureRuntime(),
      route: { name: 'default', target: SUBSCRIPTION_TARGET, compatible: false },
      config: { ...CURATOR_DEFAULTS, ...config }, record: new CurationRecord(db, () => now), now: () => now, log: line => logs.push(line),
      name: 'なつみ', timeZone: 'Asia/Tokyo', fileMaxChars: 32000,
      dataDirectory: data, agentDirectory, sessionDirectory, thinking: 'off',
      configureSession: session => { session.agent.streamFunction = model.streamFunction; },
    });
    const git = (...args: string[]) => execFileSync('git', ['-C', memory, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8' }).trim();
    return { night, seen, logs, git, read: (path: string) => readFile(join(memory, path), 'utf8'),
      stage: (name: string) => night.stages.find(stage => stage.stage === name)!,
      cleanup: async () => { await runner.close(); db.close(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) {
    await runner.close();
    db.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

const userTexts = (context: Context) => context.messages.filter(message => message.role === 'user')
  .map(message => typeof message.content === 'string' ? message.content : message.content.map(part => part.type === 'text' ? part.text : '').join(''));

test('the archiving stage moves an old fact out of its topic into this month\'s archive, and the next stages run on that', async () => {
  const n = await aNight({
    archive: [
      { calls: [call('run_shell', { command: "mkdir -p archive && printf '# 2026-10\\n\\n## 予定\\n- なつみのマスターは 2026-09-10 に健診を受けた\\n' >> archive/2026-10.md && printf '# 予定\\n\\n- 歯医者は金曜\\n' > 予定.md" })] },
      { calls: [call('write_change_note', { text: '済んだ健診を archive へ\n\n- 予定.md: 健診は済んだので archive/2026-10.md へ' })] },
    ],
  });
  try {
    assert.deepEqual(n.night.stages.map(stage => [stage.stage, stage.outcome]), [['archive', 'ok'], ['structure', 'ok'], ['index', 'ok']]);
    assert.deepEqual([...n.stage('archive').files].sort(), ['archive/2026-10.md', '予定.md']);
    assert.match(await n.read('archive/2026-10.md'), /## 予定\n- なつみのマスターは 2026-09-10 に健診を受けた/);
    assert.doesNotMatch(await n.read('予定.md'), /健診/);
    assert.match(n.git('log', '-1', '--format=%s', n.stage('archive').commit!), /^済んだ健診を archive へ$/);
    // The stage is told tonight's month file.
    const first = n.seen.find(context => stageOf(context) === 'archive')!;
    assert.match(userTexts(first)[0]!, /archive\/2026-10\.md/);
  } finally { await n.cleanup(); }
});

test('a stage that fails the check is told what and why in the same session, once, and is kept when it puts it right', async () => {
  const n = await aNight({
    structure: [
      { calls: [call('run_shell', { command: "printf '# 予定\\n\\n## 通院\\n- 歯医者は金曜\\n' > 予定.md && printf 'メモ\\n' > メモ.txt" })] },
      { calls: [] },
      { calls: [call('run_shell', { command: 'rm メモ.txt' })] },
    ],
  });
  try {
    const structure = n.stage('structure');
    assert.equal(structure.outcome, 'ok');
    assert.deepEqual(structure.retried.map(file => file.path), ['メモ.txt']);
    assert.deepEqual(structure.rejected, []);
    assert.deepEqual(structure.files, ['予定.md']);
    assert.match(await n.read('予定.md'), /## 通院/);
    const last = n.seen.filter(context => stageOf(context) === 'structure').at(-1)!;
    const told = userTexts(last);
    assert.equal(told.length, 2, 'the brief, then the one retry');
    assert.match(told[1]!, /メモ\.txt: \.md 以外のファイルは記憶に置けません/);
    assert.equal(n.git('status', '--porcelain'), '');
  } finally { await n.cleanup(); }
});

test('a stage that fails the check again after its one retry is thrown away', async () => {
  const n = await aNight({
    structure: [{ calls: [call('run_shell', { command: "printf '# 予定\\n\\n- 書き換えた\\n' > 予定.md && printf 'メモ\\n' > メモ.txt" })] }],
  });
  try {
    const structure = n.stage('structure');
    assert.equal(structure.outcome, 'rejected');
    assert.deepEqual(structure.retried.map(file => file.path), ['メモ.txt']);
    assert.deepEqual(structure.rejected.map(file => file.path), ['メモ.txt']);
    assert.equal(structure.commit, undefined);
    assert.match(await n.read('予定.md'), /歯医者/);
    const last = n.seen.filter(context => stageOf(context) === 'structure').at(-1)!;
    assert.equal(userTexts(last).length, 2, 'one retry, no more');
    assert.equal(n.git('status', '--porcelain'), '');
  } finally { await n.cleanup(); }
});

test('the retry comes out of the stage\'s own limit: a stage that used its calls up is thrown away without one', async () => {
  const n = await aNight({
    structure: [{ calls: [call('run_shell', { command: "printf 'メモ\\n' > メモ.txt" })] }, { calls: [] }],
  }, { modelCalls: 2 });
  try {
    const structure = n.stage('structure');
    assert.equal(structure.outcome, 'rejected');
    assert.deepEqual(structure.retried, []);
    const last = n.seen.filter(context => stageOf(context) === 'structure').at(-1)!;
    assert.equal(userTexts(last).length, 1);
  } finally { await n.cleanup(); }
});
