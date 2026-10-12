import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EVAL_A2A_TOKEN_FILE, Stage, type ActorModel } from '../src/eval/actors.ts';
import { runCondition, runEvaluation } from '../src/eval/run.ts';
import { conditions, loadScene } from '../src/eval/scene.ts';
import { pullSnapshot } from '../src/eval/snapshot.ts';
import { bwrapAvailable, goAvailable, WorkspaceRunner } from '../src/eval/workspace.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import type { RunRecord } from '../src/eval/record.ts';
import { makeFakeBackup } from './support/fake-backup.ts';

const REPOSITORY = join(import.meta.dirname, '..');
const skip = (await goAvailable()) ? false : 'go is not installed, so the runner cannot be built';
// A scene that reads the workspace's paths (/manual, /memory, /sources) needs them laid out, which only bubblewrap does.
const sandboxed = skip || ((await bwrapAvailable()) ? false : 'bubblewrap cannot make a sandbox here');

const DOVE_REQUEST = JSON.stringify({ kind: 'post', to: { file: '/sources/slack/work/dev/2026-09-27.jsonl', path: '.[36]' }, face: 'happy',
  text: 'デプロイは毎週木曜だそうです！' });

/** Asks the Wiki keeper and the dove, hears back from both, and tells the owner what the keeper said. */
const FOLLOWED = `
time: "2026-09-27T10:00:00+09:00"
follow: true
actors:
  wiki-keeper:
    card: FIXTURE-CARD Wiki の管理人
    replies: [デプロイは毎週木曜です（FIXTURE-KEEPER-REPLY）。]
  poppo:
    replies:
      - { result: returned, text: ポッポ、これは届けられないよ（FIXTURE-DOVE-REPLY）。 }
event: { mac_message: デプロイっていつだっけ？ }
dryRun:
  - calls:
      - { tool: run_shell, args: { command: "cat /manual/agents/INDEX.md" } }
      - { tool: ask_agent, args: { agent: wiki-keeper, message: デプロイの曜日を教えて, continue: false } }
      - { tool: ask_agent, args: { agent: poppo, message: ${JSON.stringify(DOVE_REQUEST)}, continue: false } }
  - text: 返事を待つ。
  - calls:
      - { tool: reply_to_mac, args: { text: 毎週木曜だって！, expression: happy } }
  - text: ポッポさんの返事も読んだ。
checks:
  - { id: listed, output: FIXTURE-CARD }
  - { id: told, reply: 木曜 }
  - { id: asked-keeper, asked: { agent: wiki-keeper } }
`;

async function withRoot(body: (root: string, runner: WorkspaceRunner) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-replay-'));
  try {
    const runner = await WorkspaceRunner.prepare({ repository: REPOSITORY, cache: join(root, 'cache') });
    await body(root, runner);
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function scene(root: string, name: string, yaml: string) {
  await mkdir(join(root, 'scenes', name), { recursive: true });
  await writeFile(join(root, 'scenes', name, 'scene.yaml'), yaml);
  return conditions(await loadScene(join(root, 'scenes', name)));
}

test('a followed scene hands the actors\' replies back as events, turn after turn, through the real paths', { skip: sandboxed }, async () => {
  await withRoot(async (root, runner) => {
    const [condition] = await scene(root, 'followed', FOLLOWED);
    const record = await runCondition(condition!, { run: 1, dryRun: true, repository: REPOSITORY, work: join(root, 'work'), runner });
    assert.equal(record.outcome, 'ok', record.error);
    // The ask, and the keeper's answer with the dove's.
    assert.equal(record.turns, 2);
    // Both are put under /sources and told by their attentions, in one event (ADR 0069, ADR 0074).
    const attentions = (event: Record<string, unknown>) =>
      (event.changed as { attention?: Record<string, unknown>[] }[] | undefined)?.flatMap(entry => entry.attention ?? []) ?? [];
    assert.deepEqual(record.events.map(event => event.type), ['mac_message', 'sources_updated']);
    const told = attentions(record.events[1]!);
    const keeper = told.find(attention => attention.agent === 'wiki-keeper')!;
    assert.equal(keeper.kind, 'agent_reply');
    assert.equal(keeper.state, 'completed');
    assert.match(String(keeper.summary), /FIXTURE-KEEPER-REPLY/);
    assert.match(String(keeper.file), /^\/sources\/agents\/wiki-keeper\/.*\/README\.md$/);
    const dove = told.find(attention => attention.agent === 'poppo')!;
    assert.equal(dove.kind, 'agent_reply');
    assert.equal(dove.state, 'returned');
    assert.match(String(dove.summary), /FIXTURE-DOVE-REPLY/);
    assert.match(String(dove.file), /^\/sources\/agents\/poppo\/.*\/results\.jsonl$/);
    assert.equal(dove.path, '.[0]');
    assert.equal(dove.request, 'デプロイは毎週木曜だそうです！');
    // Neither event names a task, a context or an ID (ADR 0024).
    assert.ok(!JSON.stringify(record.events).includes('actor-task'));
    // The two asks of one call run side by side, so they are compared by agent, not in the order they were recorded.
    const actors = [...record.actors!].sort((a, b) => b.agent.localeCompare(a.agent));
    assert.deepEqual(actors.map(exchange => [exchange.agent, exchange.turn, exchange.taken, exchange.by]), [
      ['wiki-keeper', 1, true, 'written'], ['poppo', 1, true, 'written']]);
    assert.equal(actors[1]!.result, 'returned');
    assert.deepEqual(record.replies.map(reply => reply.text), ['毎週木曜だって！']);
    assert.deepEqual(record.checks.map(check => [check.id, check.pass]), [['listed', true], ['told', true], ['asked-keeper', true]]);
    // The numbers are those of all the turns: two calls in each.
    assert.equal(record.modelCalls, 4);
  });
});

test('without follow the actors only take the request, and the run is one turn', { skip }, async () => {
  await withRoot(async (root, runner) => {
    const [condition] = await scene(root, 'one', FOLLOWED.replace('follow: true\n', ''));
    const record = await runCondition(condition!, { run: 1, dryRun: true, repository: REPOSITORY, work: join(root, 'work'), runner });
    assert.equal(record.outcome, 'ok', record.error);
    assert.equal(record.turns, 1);
    assert.deepEqual(record.events.map(event => event.type), ['mac_message']);
    assert.deepEqual([...record.actors!].sort((a, b) => b.agent.localeCompare(a.agent)).map(exchange => [exchange.agent, exchange.taken, exchange.reply]),
      [['wiki-keeper', true, undefined], ['poppo', true, undefined]]);
    const asked = record.tools.filter(tool => tool.name === 'ask_agent').map(tool => tool.result);
    assert.match(asked[0]!, /wiki-keeper.*頼みました/);
    assert.match(asked[1]!, /受け付けました/);
  });
});

test('following stops at the most turns the scene allows, and an LLM plays an actor with no written replies', { skip }, async () => {
  await withRoot(async (root, runner) => {
    const [condition] = await scene(root, 'capped', `
follow: { maxTurns: 2 }
actors:
  researcher:
    instructions: FIXTURE-INSTRUCTIONS
event: { ping: {} }
dryRun:
  - calls: [{ tool: ask_agent, args: { agent: researcher, message: 一つ目, continue: false } }]
  - text: 待つ
  - calls: [{ tool: ask_agent, args: { agent: researcher, message: 二つ目, continue: false } }]
  - text: 待つ
  - calls: [{ tool: ask_agent, args: { agent: researcher, message: 三つ目, continue: false } }]
  - text: 待つ
`);
    const asked: string[] = [];
    const actor: ActorModel = { reply: async (who, request) => { asked.push(`${who.name}:${who.instructions}:${request}`); return { text: `答え(${request})` }; } };
    const record = await runCondition(condition!, { run: 1, dryRun: true, repository: REPOSITORY, work: join(root, 'work'), runner, actor });
    assert.equal(record.outcome, 'ok', record.error);
    assert.equal(record.turns, 2);
    assert.deepEqual(asked, ['researcher:FIXTURE-INSTRUCTIONS:一つ目']);
    assert.deepEqual(record.actors!.map(exchange => [exchange.request, exchange.by ?? null, exchange.reply ?? null]), [
      ['一つ目', 'llm', '答え(一つ目)'], ['二つ目', null, null]]);
  });
});

test('the loop is given no secret: the A2A token is a file that is not there, and the actors are its only agents', () => {
  const stage = new Stage({ actors: { 'wiki-keeper': { name: 'wiki-keeper', card: 'x', replies: [] },
    poppo: { name: 'poppo', card: '', replies: [] } }, dryRun: true });
  const config = stage.a2aConfig()!;
  assert.equal(config.tokenFile, EVAL_A2A_TOKEN_FILE);
  assert.deepEqual(Object.keys(config.agents), ['wiki-keeper']);
  assert.match(config.agents['wiki-keeper']!.url, /\.invalid\/$/);
  assert.equal(new Stage({ actors: {}, dryRun: true }).a2aConfig(), undefined);
});

test('a scene starts from a working copy of a snapshot: its state, its session, the branch\'s migrations, and the snapshot untouched', { skip: sandboxed }, async () => {
  await withRoot(async (root, runner) => {
    await makeFakeBackup(join(root, 'backup'));
    const kubectl = join(root, 'kubectl');
    await writeFile(kubectl, `#!/bin/sh\nexec "${process.execPath}" "${join(REPOSITORY, 'test', 'support', 'fake-kubectl.ts')}" "$@"\n`);
    await chmod(kubectl, 0o755);
    const store = join(root, 'snapshots');
    const pulled = await pullSnapshot({ kubectl, env: { FAKE_KUBECTL_LOG: join(root, 'log'), FAKE_KUBECTL_BACKUP: join(root, 'backup') },
      namespace: 'natsumi', cronjob: 'natsumi-backup', store, keep: 3 });
    // The backup's schema is one migration behind the branch, so that the branch's migrations have something to do.
    const snapshotDatabase = join(pulled.directory, 'data', '.natsumi', 'state.sqlite');
    const digest = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
    const before = [await digest(snapshotDatabase), await digest(join(pulled.directory, 'data', 'memory', 'personality.md'))];

    await mkdir(join(root, 'scenes', 'replay'), { recursive: true });
    await writeFile(join(root, 'scenes', 'replay', 'scene.yaml'), `
start: { snapshot: latest }
files:
  /memory/extra.md: FIXTURE-SCENE-FILE
event: { mac_message: きのうの続きだけど }
dryRun:
  - calls:
      - { tool: run_shell, args: { command: "cat /memory/personality.md /memory/extra.md /sources/slack/fixture/2026-09-27.md /work/draft.md; echo changed > /memory/personality.md" } }
  - text: 読んだ
checks:
  - { id: memory, output: FIXTURE-SNAPSHOT-PERSONALITY }
  - { id: scene-file, output: FIXTURE-SCENE-FILE }
  - { id: sources, output: FIXTURE-SOURCE-LINE }
  - { id: work, output: FIXTURE-WORK-NOTE }
`);
    const result = await runEvaluation({ scenes: [join(root, 'scenes')], out: join(root, 'results'), label: 'replay', dryRun: true, runs: 1,
      repository: REPOSITORY, snapshots: store, runner });
    const [record] = result.records as RunRecord[];
    assert.equal(record!.outcome, 'ok', record!.error);
    assert.deepEqual(record!.checks.map(check => [check.id, check.pass]), [['memory', true], ['scene-file', true], ['sources', true], ['work', true]]);
    // The conversation the snapshot's SQLite points at is the one opened; the event left queued in it is not handled.
    assert.ok(record!.priorMessages >= 2, String(record!.priorMessages));
    assert.deepEqual(record!.events.map(event => event.type), ['mac_message']);
    assert.equal(record!.snapshot, pulled.name);
    // The copy was migrated; the snapshot was not, and nothing in it changed.
    const copy = new DatabaseSync(join(root, 'results', 'replay', 'work', 'replay', 'base', 'run-1', 'data', '.natsumi', 'state.sqlite'), { readOnly: true });
    try {
      assert.equal((copy.prepare('SELECT max(version) AS v FROM schema_migrations').get() as { v: number }).v, MIGRATIONS.at(-1)!.version);
    } finally { copy.close(); }
    assert.deepEqual([await digest(snapshotDatabase), await digest(join(pulled.directory, 'data', 'memory', 'personality.md'))], before);

    // A scene whose snapshot is not there is skipped, and the summary says why.
    const none = await runEvaluation({ scenes: [join(root, 'scenes')], out: join(root, 'results'), label: 'none', dryRun: true, runs: 1,
      repository: REPOSITORY, snapshots: join(root, 'no-snapshots'), runner });
    assert.deepEqual(none.records, []);
    assert.deepEqual(none.summary.skipped, [{ scene: 'replay', reason: 'no snapshot (latest)' }]);
  });
});
