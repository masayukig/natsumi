import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { CURATOR_DEFAULTS, LOOP_DEFAULTS, type CuratorConfig, type LoopConfig } from '../src/server/config.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { CURATOR_STAGES } from '../src/server/memory-curator.ts';
import { curatorSystemPrompt } from '../src/server/prompts.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop, type LoopClientEvent, type LoopOptions } from '../src/server/thinking-loop.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { startFakeRunner, type FakeRunner } from './support/fake-runner.ts';
import { ScriptedModel, type ScriptedStep } from './support/scripted-model.ts';

// The memory curator in the nightly switch (ADR 0055), a night in stages (ADR 0068). Fictional memories only.

const HANDOFF = 'HANDOFF-MARKER-8812';
const PERSONA = 'PERSONA-MARKER-4410';
const NOTE = 'NOTE-MARKER-3307';
const INDEX_NOTE = 'INDEX-NOTE-MARKER-5120';

type OpenOptions = Partial<Omit<LoopOptions, 'loop' | 'curator'>> & { loop?: Partial<LoopConfig>; curator?: Partial<CuratorConfig> | false };

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-curator-loop-')));
  const data = join(root, 'data');
  const memory = join(data, 'memory');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  await mkdir(memory, { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(join(data, 'personality.md'), `# 性格・話し方\n${PERSONA}\n`);
  await writeFile(join(memory, '予定.md'), '# 予定\n\n## 2026-09-25\n- 歯医者は金曜\n');
  await writeFile(join(memory, '予定メモ.md'), '# 予定メモ\n\n- 散髪は土曜\n');
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const model = new ScriptedModel();
  const git = (...args: string[]) => execFileSync('git', ['-C', memory, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8' }).trim();
  const opened: ThinkingLoop[] = [];
  let runner: FakeRunner | undefined;
  const logs: string[] = [];
  let counter = 0;
  const f = {
    root, data, memory, sessionDirectory, db, model, git, logs,
    async open({ loop: settings, curator, ...options }: OpenOptions = {}) {
      runner ??= await startFakeRunner({ dir: memory });
      const loop = await ThinkingLoop.open({
        db, dataDirectory: data, sessionDirectory, agentDirectory, target: SUBSCRIPTION_TARGET, thinking: 'on',
        runtime: fixtureRuntime, loop: { ...LOOP_DEFAULTS, timeZone: 'Asia/Tokyo', workspaceSocket: runner.path, ...settings },
        ...(curator === false ? {} : { curator: { ...CURATOR_DEFAULTS, ...curator } }),
        configureSession: session => { session.agent.streamFunction = model.streamFunction; },
        log: line => logs.push(line), ...options,
      });
      opened.push(loop);
      const events: LoopClientEvent[] = [];
      loop.subscribe(event => { events.push(event); });
      return { loop, events };
    },
    send(loop: ThinkingLoop, text: string) {
      const outcome = loop.send({ requestId: `request-${++counter}`, deviceId: 'device-1', text });
      assert.equal(outcome.kind, 'accepted');
      return outcome as Extract<typeof outcome, { kind: 'accepted' }>;
    },
    commits: () => Number(git('rev-list', '--count', 'HEAD')),
    turns: () => db.prepare('SELECT * FROM turn_stats ORDER BY started_at, rowid').all() as Record<string, unknown>[],
    read: (name: string) => readFile(join(memory, name), 'utf8'),
    async cleanup() {
      for (const loop of opened) await loop.close();
      await runner?.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  return f;
}

const textOf = (message: Context['messages'][number]) => {
  const content = (message as { content: unknown }).content;
  if (typeof content === 'string') return content;
  return (content as { type: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text).join('');
};
const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });
const isCurator = (context: Context) => context.systemPrompt?.startsWith(curatorSystemPrompt('なつみ')) === true;
const firstUser = (context: Context) => textOf(context.messages.find(message => message.role === 'user')!);

/** The stage a curator's context belongs to, told by the instructions in its system prompt. */
const stageOf = (context: Context) => CURATOR_STAGES.find(stage => context.systemPrompt?.includes(stage.instructions('なつみ')))?.name;

type Steps = Partial<Record<string, ScriptedStep[]>>;

/**
 * natsumi answers owner messages and writes her handoff at night; each stage of the curator follows the steps given
 * for it, one model call each, and then stops.
 */
function behave(f: Awaited<ReturnType<typeof setup>>, curator: Steps, seen: Context[] = []) {
  f.model.auto = context => {
    if (context.messages.at(-1)?.role === 'assistant') return { calls: [] };
    if (isCurator(context)) {
      seen.push(context);
      const calls = context.messages.filter(message => message.role === 'assistant').length;
      return curator[stageOf(context) ?? '']?.[calls] ?? { calls: [] };
    }
    const last = textOf(context.messages.at(-1)!);
    if (last.includes('"nightly_review"')) return { calls: [call('write_handoff_note', { text: `${HANDOFF} 明日も続き` })] };
    if (context.messages.at(-1)?.role !== 'user') return { calls: [] };
    return { calls: [call('reply_to_mac', { text: 'はい', expression: 'neutral' })] };
  };
  return seen;
}

async function aDay(f: Awaited<ReturnType<typeof setup>>, loop: ThinkingLoop) {
  f.send(loop, '今日の話');
  await loop.idle();
}

const MERGE: ScriptedStep[] = [
  { calls: [call('run_shell', { command: "mkdir -p 暮らし && printf '# 予定\\n\\n- 歯医者は金曜\\n- 散髪は土曜\\n' > 暮らし/予定.md && rm 予定.md 予定メモ.md" })] },
  { calls: [call('write_change_note', { text: `予定をまとめた ${NOTE}\n\n- 予定メモ.md: 予定.md と重なるので統合した` })] },
];
const INDEX: ScriptedStep[] = [
  { calls: [call('run_shell', { command: "printf '# 記憶の索引\\n\\n- 暮らし/予定.md: 近い予定\\n' > INDEX.md" })] },
  { calls: [call('write_change_note', { text: `索引を今の構成に合わせた ${INDEX_NOTE}` })] },
];
const NIGHT: Steps = { structure: MERGE, index: INDEX };

test('after the review, a curator with no personality reorganizes memory in stages, a commit each, and natsumi is told nothing', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const seen = behave(f, NIGHT);
    await aDay(f, loop);
    const before = f.commits();

    assert.equal((await loop.rotate()).result, 'switched');

    // Each stage is a session of its own, begun from nothing but its instructions and its brief.
    const firsts = seen.filter(context => context.messages.length === 1);
    assert.deepEqual(firsts.map(stageOf), ['knowledge', 'archive', 'structure', 'index']);
    for (const first of firsts) assert.doesNotMatch(first.systemPrompt ?? '', new RegExp(`${PERSONA}|${HANDOFF}`));
    // The first stage is handed the day's conversation, out of natsumi's session.
    assert.match(firstUser(firsts[0]!), /\] マスター: 今日の話\n\[[^\]]+\] なつみ → マスター: はい/);
    const brief = firstUser(firsts[2]!);
    assert.match(brief, /^<curation>/);
    assert.match(brief, /- 予定\.md（\d+ 文字・最後に変わった日 \d{4}-\d{2}-\d{2}・まだ整理していない）\n {2}- # 予定（0 行）\n {2}- ## 2026-09-25（1 行）/);
    assert.match(brief, /すべてのトピック/, 'small memory: every topic may be rewritten');
    // The index stage sees what the first stage left.
    assert.match(firstUser(firsts[3]!), /暮らし\/予定\.md/);
    assert.doesNotMatch(JSON.stringify(firsts[3]!.messages), new RegExp(NOTE), 'nothing of the stage before reaches it but memory');

    // The review's commit, then one for each stage under its note.
    assert.equal(f.commits(), before + 3);
    assert.match(f.git('log', '-1', '--format=%B'), new RegExp(INDEX_NOTE));
    assert.match(f.git('log', '-1', '--skip=1', '--format=%B'), new RegExp(NOTE));
    assert.match(f.git('log', '-1', '--skip=2', '--format=%s'), /nightly_review/);
    assert.equal(f.git('status', '--porcelain'), '');
    assert.match(await f.read('暮らし/予定.md'), /散髪は土曜/);
    await assert.rejects(stat(join(f.memory, '予定メモ.md')));
    assert.match(await f.read('INDEX.md'), /暮らし\/予定\.md/);
    // The switch recorded the review's commit, which is what the new session begins from.
    const [rotation] = f.db.prepare('SELECT * FROM session_rotations').all() as Record<string, unknown>[];
    assert.equal(rotation!.handoff_commit, f.git('rev-parse', 'HEAD~2'));

    // A turn for each stage, of the curator's kind, named by its stage and placed in its own record.
    const curatorTurns = f.turns().filter(turn => turn.kind === 'curator');
    assert.deepEqual(curatorTurns.map(turn => turn.event_kinds), ['memory_curator:knowledge', 'memory_curator:archive', 'memory_curator:structure',
      'memory_curator:index']);
    assert.deepEqual(curatorTurns.map(turn => turn.outcome), ['ok', 'ok', 'ok', 'ok']);
    for (const turn of curatorTurns) assert.match(turn.session_file as string, /^curator\/.+\.jsonl$/);
    // The knowledge and the archiving had nothing to do, and ended at their first call.
    assert.deepEqual(curatorTurns.map(turn => (turn.model_calls as number) >= 2), [false, false, true, true]);
    assert.equal(new Set(curatorTurns.map(turn => turn.session_file)).size, 4);
    assert.equal((await readdir(join(f.sessionDirectory, 'curator'))).length, 4);
    assert.equal(loop.turnInProgress(), undefined, 'nothing is left shown as in progress');
    // What it handled is dated, and the next night counts from the night's last commit.
    const curated = f.db.prepare('SELECT path FROM memory_curation ORDER BY path').all().map(row => (row as { path: string }).path);
    assert.ok(curated.includes('暮らし/予定.md'));
    assert.equal((f.db.prepare('SELECT base_commit FROM memory_curator').get() as { base_commit: string }).base_commit, f.git('rev-parse', 'HEAD'));

    // The next day: natsumi starts from her handoff, and nothing of the curator's notes reaches her.
    let morning: Context | undefined;
    f.model.auto = context => { if (context.messages.at(-1)?.role === 'user' && !morning) morning = context; return { calls: [] }; };
    f.send(loop, 'おはよう');
    await loop.idle();
    assert.match(morning!.systemPrompt ?? '', new RegExp(HANDOFF));
    assert.doesNotMatch(JSON.stringify(morning), new RegExp(`${NOTE}|${INDEX_NOTE}`));
    assert.doesNotMatch(JSON.stringify(events), new RegExp(`${NOTE}|${INDEX_NOTE}`));
  } finally { await f.cleanup(); }
});

test('a stage that touches natsumi\'s own file loses its own changes only; the next stage still runs, and the switch happens', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open();
    behave(f, { structure: [MERGE[0]!, { calls: [call('run_shell', { command: "printf '# 常時記憶\\n\\n係が書いた\\n' > always.md" })] }, MERGE[1]!],
      index: INDEX });
    await aDay(f, loop);
    const before = f.commits();

    assert.equal((await loop.rotate()).result, 'switched');

    assert.equal(f.commits(), before + 2, 'the review and the index stage committed');
    assert.equal(f.git('status', '--porcelain'), '');
    assert.match(await f.read('予定メモ.md'), /散髪/);
    await assert.rejects(stat(join(f.memory, '暮らし')));
    assert.doesNotMatch(await f.read('always.md'), /係が書いた/);
    assert.match(f.git('log', '-1', '--format=%B'), new RegExp(INDEX_NOTE));
    const outcomes = f.turns().filter(turn => turn.kind === 'curator').map(turn => [turn.event_kinds, turn.outcome]);
    assert.deepEqual(outcomes, [['memory_curator:knowledge', 'ok'], ['memory_curator:archive', 'ok'], ['memory_curator:structure', 'rejected'], ['memory_curator:index', 'ok']]);
    assert.ok(f.logs.some(line => /always\.md/.test(line)), 'the log names what failed');
    const row = f.db.prepare('SELECT base_commit FROM memory_curator').get() as { base_commit: string | null } | undefined;
    assert.equal(row?.base_commit ?? null, null, 'the base does not move while the reorganizing failed');
  } finally { await f.cleanup(); }
});

test('a stage that fails after one that succeeded leaves the earlier commit in place', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open();
    // The index stage writes a topic, which is not its to write.
    behave(f, { structure: MERGE, index: [{ calls: [call('run_shell', { command: "printf '# 索引\\n' > INDEX.md && printf '# 予定\\n\\n- 書き換えた\\n' > 暮らし/予定.md" })] }] });
    await aDay(f, loop);
    const before = f.commits();

    assert.equal((await loop.rotate()).result, 'switched');

    assert.equal(f.commits(), before + 2, 'the review and the reorganizing committed');
    assert.match(f.git('log', '-1', '--format=%B'), new RegExp(NOTE));
    assert.equal(f.git('status', '--porcelain'), '');
    assert.match(await f.read('暮らし/予定.md'), /散髪は土曜/);
    const outcomes = f.turns().filter(turn => turn.kind === 'curator').map(turn => turn.outcome);
    assert.deepEqual(outcomes, ['ok', 'ok', 'ok', 'rejected']);
    assert.ok(f.logs.some(line => /暮らし\/予定\.md/.test(line)));
    assert.equal((f.db.prepare('SELECT base_commit FROM memory_curator').get() as { base_commit: string }).base_commit, f.git('rev-parse', 'HEAD'));
  } finally { await f.cleanup(); }
});

test('the call limit is each stage\'s own: one cut off loses that stage, and the next has its whole limit', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open({ curator: { modelCalls: 1 } });
    behave(f, { structure: MERGE, index: [{ calls: [] }] });
    await aDay(f, loop);
    const before = f.commits();
    assert.equal((await loop.rotate()).result, 'switched');
    assert.equal(f.commits(), before + 1);
    assert.equal(f.git('status', '--porcelain'), '');
    assert.match(await f.read('予定.md'), /歯医者/);
    assert.deepEqual(f.turns().filter(turn => turn.kind === 'curator').map(turn => turn.outcome), ['ok', 'ok', 'model-call-limit', 'ok']);
  } finally { await f.cleanup(); }
});

test('natsumi sleeps through the curator: a message waits and the new session answers it', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    let late: ReturnType<typeof f.send> | undefined;
    behave(f, { structure: [{ calls: [call('run_shell', { command: 'true' })] }] });
    const auto = f.model.auto!;
    f.model.auto = context => {
      if (isCurator(context) && !late) {
        late = f.send(loop, '夜中にごめん');
        assert.equal(late.state, 'queued');
      }
      return auto(context);
    };
    await aDay(f, loop);
    assert.equal((await loop.rotate()).result, 'switched');
    await loop.idle();
    assert.ok(late);
    const done = events.find(event => event.type === 'conversation.event.completed' && event.payload.eventId === late!.eventId);
    assert.equal(done?.payload.status, 'replied');
    // Asleep the whole time: the message never woke her into thinking before the switch was over.
    const expressions = events.filter(event => event.type === 'avatar.expression').map(event => event.payload.expression);
    const sleepy = expressions.indexOf('sleepy');
    assert.ok(sleepy >= 0);
    assert.equal(expressions.slice(sleepy + 1)[0], 'thinking', 'woken for the message only after the switch');
  } finally { await f.cleanup(); }
});

test('with the curator off, or with no workspace, the night is as it was', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open({ curator: { enabled: false } });
    const seen = behave(f, NIGHT);
    await aDay(f, loop);
    assert.equal((await loop.rotate()).result, 'switched');
    assert.equal(seen.length, 0);
    assert.equal(f.turns().some(turn => turn.kind === 'curator'), false);
  } finally { await f.cleanup(); }
});

test('the next night hands over only what changed since, and the files in turn', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open({ curator: { rotateFiles: 1, rewriteAllMaxChars: 0 } });
    behave(f, {});
    await aDay(f, loop);
    assert.equal((await loop.rotate()).result, 'switched');
    await writeFile(join(f.memory, '新しい話.md'), '# 新しい話\n');
    const seen = behave(f, {});
    const auto = f.model.auto!;
    let wrote = false;
    f.model.auto = context => {
      if (!isCurator(context) && !wrote && textOf(context.messages.at(-1)!).includes('mac_message')) wrote = true;
      return auto(context);
    };
    await aDay(f, loop);
    assert.equal((await loop.rotate()).result, 'switched');
    const brief = firstUser(seen.find(context => stageOf(context) === 'structure')!);
    const changed = brief.slice(brief.indexOf('変わったもの'), brief.indexOf('順番が回ってきたもの'));
    assert.match(changed, /- 新しい話\.md/);
    assert.doesNotMatch(changed, /予定/);
    const rotated = brief.slice(brief.indexOf('順番が回ってきたもの'));
    assert.equal(rotated.match(/^- /gm)?.length, 1);
  } finally { await f.cleanup(); }
});

test('a curator cut off by a stop keeps nothing of that stage, runs no further stage, and the next start finishes the switch', async () => {
  const f = await setup();
  try {
    const first = await f.open();
    behave(f, { structure: [{ calls: [call('run_shell', { command: "printf '# 書きかけ\\n' > 書きかけ.md && rm 予定.md" })] }] });
    const auto = f.model.auto!;
    let stopping: Promise<void> | undefined;
    f.model.auto = context => {
      if (isCurator(context) && context.messages.at(-1)?.role === 'toolResult' && !stopping) {
        stopping = first.loop.close();
        return { calls: [call('run_shell', { command: 'true' })] };
      }
      return auto(context);
    };
    await aDay(f, first.loop);
    assert.equal((await first.loop.rotate()).result, 'failed');
    await stopping;
    assert.equal(f.git('status', '--porcelain'), '');
    assert.match(await f.read('予定.md'), /歯医者/);
    assert.deepEqual(f.turns().filter(turn => turn.kind === 'curator').map(turn => turn.outcome), ['ok', 'ok', 'stopped'], 'the knowledge and the archiving had nothing to do');

    behave(f, {});
    const second = await f.open();
    assert.equal(second.loop.unavailable, undefined);
    assert.equal((f.db.prepare('SELECT state FROM session_rotations').get() as { state: string }).state, 'switched');
  } finally { await f.cleanup(); }
});

test('what a curator left when the process died is thrown away at the next start, before anything reads memory', async () => {
  const f = await setup();
  try {
    const first = await f.open();
    await first.loop.close();
    // As a process that died mid-run leaves it: the run marked, the tree changed.
    f.db.prepare("INSERT INTO memory_curator (owner, running_since) VALUES (1, '2026-09-27T19:00:00.000Z')").run();
    await writeFile(join(f.memory, '残骸.md'), '# 残骸\n');
    await rm(join(f.memory, '予定.md'));
    await f.open();
    assert.equal(f.git('status', '--porcelain'), '');
    assert.match(await f.read('予定.md'), /歯医者/);
    await assert.rejects(stat(join(f.memory, '残骸.md')));
    assert.equal((f.db.prepare('SELECT running_since FROM memory_curator').get() as { running_since: unknown }).running_since, null);
    assert.ok(f.logs.some(line => /memory curator: a run was cut off/.test(line)));
  } finally { await f.cleanup(); }
});

// ADR 0068: the curator's route and the limits of a stage, as the settings give them for the night.
test('the night runs on the route and with the limits the settings give, and each stage\'s turn names that route', async () => {
  const f = await setup();
  try {
    const FIRST = { provider: 'openai-codex', model: 'gpt-5.5' };
    const SECOND = { provider: 'openai-codex', model: 'gpt-5.6-sol' };
    const routes = { defaultRoute: 'main', list: [{ name: 'main', target: FIRST, compactionThreshold: 60_000, compatible: false },
      { name: 'spare', target: SECOND, compactionThreshold: 60_000, compatible: false }] };
    const night = { route: 'spare' as string | null, modelCalls: 1, timeoutMinutes: 30 };
    const { loop } = await f.open({ routes, curator: { route: 'main', modelCalls: 60 },
      settings: { turnLimits: () => LOOP_DEFAULTS, awakeHours: () => LOOP_DEFAULTS.awakeHours, curator: () => night } });
    behave(f, { structure: MERGE, index: [{ calls: [] }] });
    await aDay(f, loop);
    assert.equal((await loop.rotate()).result, 'switched');
    const curatorTurns = () => f.turns().filter(turn => turn.kind === 'curator');
    assert.deepEqual(curatorTurns().map(turn => [turn.route, turn.outcome]),
      [['spare', 'ok'], ['spare', 'ok'], ['spare', 'model-call-limit'], ['spare', 'ok']],
      'the settings\' route and call limit, not the config\'s; the knowledge and the archiving had nothing to do');
    assert.ok(f.turns().filter(turn => turn.kind !== 'curator').every(turn => turn.route === 'main'), 'natsumi stays on her route');

    // None of its own: the curator follows the route natsumi is on.
    night.route = null;
    night.modelCalls = 60;
    await aDay(f, loop);
    assert.equal((await loop.rotate()).result, 'switched');
    assert.deepEqual(curatorTurns().slice(4).map(turn => turn.route), ['main', 'main', 'main', 'main']);

    // A route the config no longer has is not tried: natsumi's is used, and the log says so.
    night.route = 'gone';
    await aDay(f, loop);
    assert.equal((await loop.rotate()).result, 'switched');
    assert.deepEqual(curatorTurns().slice(8).map(turn => turn.route), ['main', 'main', 'main', 'main']);
    assert.ok(f.logs.some(line => line.includes('gone')), f.logs.join('\n'));
  } finally { await f.cleanup(); }
});
