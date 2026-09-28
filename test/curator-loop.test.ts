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
import { curatorSystemPrompt } from '../src/server/prompts.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop, type LoopClientEvent, type LoopOptions } from '../src/server/thinking-loop.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { startFakeRunner, type FakeRunner } from './support/fake-runner.ts';
import { ScriptedModel, type ScriptedStep } from './support/scripted-model.ts';

// The memory curator in the nightly switch (ADR 0055). Fictional memories only.

const HANDOFF = 'HANDOFF-MARKER-8812';
const PERSONA = 'PERSONA-MARKER-4410';
const NOTE = 'NOTE-MARKER-3307';

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

/**
 * natsumi answers owner messages and writes her handoff at night; the curator follows the steps given, one model call
 * each, and then stops.
 */
function behave(f: Awaited<ReturnType<typeof setup>>, curator: ScriptedStep[], seen: Context[] = []) {
  f.model.auto = context => {
    if (context.messages.at(-1)?.role === 'assistant') return { calls: [] };
    if (isCurator(context)) {
      seen.push(context);
      const calls = context.messages.filter(message => message.role === 'assistant').length;
      return curator[calls] ?? { calls: [] };
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
  { calls: [call('run_shell', { command: "printf '# 記憶の索引\\n\\n- 暮らし/予定.md: 近い予定\\n' > INDEX.md" })] },
  { calls: [call('write_change_note', { text: `予定をまとめた ${NOTE}\n\n- 予定メモ.md: 予定.md と重なるので統合した` })] },
];

test('after the review, a curator with no personality reorganizes memory in one commit, and natsumi is told nothing', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const seen = behave(f, MERGE);
    await aDay(f, loop);
    const before = f.commits();

    assert.equal((await loop.rotate()).result, 'switched');

    // A session of its own, begun from nothing but its instructions and the brief.
    assert.ok(seen.length >= 3);
    const [first] = seen;
    assert.equal(first!.messages.length, 1);
    assert.doesNotMatch(first!.systemPrompt ?? '', new RegExp(`${PERSONA}|${HANDOFF}`));
    const brief = firstUser(first!);
    assert.match(brief, /^<curation>/);
    assert.match(brief, /- 予定\.md（\d+ 文字）\n {2}- # 予定\n {2}- ## 2026-09-25/);
    assert.match(brief, /変わったもの\n(- .*\n)*- 予定\.md/, 'a first night counts the last day, which here is all of it');

    // The review's commit, then the curator's under its note.
    assert.equal(f.commits(), before + 2);
    assert.match(f.git('log', '-1', '--format=%B'), new RegExp(NOTE));
    assert.match(f.git('log', '-1', '--skip=1', '--format=%s'), /nightly_review/);
    assert.equal(f.git('status', '--porcelain'), '');
    assert.match(await f.read('暮らし/予定.md'), /散髪は土曜/);
    await assert.rejects(stat(join(f.memory, '予定メモ.md')));
    assert.match(await f.read('INDEX.md'), /暮らし\/予定\.md/);
    // The switch recorded the review's commit, which is what the new session begins from.
    const [rotation] = f.db.prepare('SELECT * FROM session_rotations').all() as Record<string, unknown>[];
    assert.equal(rotation!.handoff_commit, f.git('rev-parse', 'HEAD~1'));

    // Its turn is a turn of its own kind, placed in its own record.
    const curatorTurn = f.turns().find(turn => turn.kind === 'curator')!;
    assert.equal(curatorTurn.outcome, 'ok');
    assert.equal(curatorTurn.event_kinds, 'memory_curator');
    assert.match(curatorTurn.session_file as string, /^curator\/.+\.jsonl$/);
    assert.ok((curatorTurn.model_calls as number) >= 3);
    assert.deepEqual((await readdir(join(f.sessionDirectory, 'curator'))).length, 1);
    // What it handled is dated, and the next night counts from here.
    const curated = f.db.prepare('SELECT path FROM memory_curation ORDER BY path').all().map(row => (row as { path: string }).path);
    assert.ok(curated.includes('暮らし/予定.md'));
    assert.equal((f.db.prepare('SELECT base_commit FROM memory_curator').get() as { base_commit: string }).base_commit, f.git('rev-parse', 'HEAD'));

    // The next day: natsumi starts from her handoff, and nothing of the curator's note reaches her.
    let morning: Context | undefined;
    f.model.auto = context => { if (context.messages.at(-1)?.role === 'user' && !morning) morning = context; return { calls: [] }; };
    f.send(loop, 'おはよう');
    await loop.idle();
    assert.match(morning!.systemPrompt ?? '', new RegExp(HANDOFF));
    assert.doesNotMatch(JSON.stringify(morning), new RegExp(NOTE));
    assert.doesNotMatch(JSON.stringify(events), new RegExp(NOTE));
  } finally { await f.cleanup(); }
});

test('a curator that touches natsumi\'s own file loses the whole night, and the switch still happens', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open();
    behave(f, [MERGE[0]!, { calls: [call('run_shell', { command: "printf '# 常時記憶\\n\\n係が書いた\\n' > always.md" })] }, MERGE[2]!]);
    await aDay(f, loop);
    const before = f.commits();

    assert.equal((await loop.rotate()).result, 'switched');

    assert.equal(f.commits(), before + 1, 'only the review committed');
    assert.equal(f.git('status', '--porcelain'), '');
    assert.match(await f.read('予定メモ.md'), /散髪/);
    await assert.rejects(stat(join(f.memory, '暮らし')));
    assert.doesNotMatch(await f.read('always.md'), /係が書いた/);
    const curatorTurn = f.turns().find(turn => turn.kind === 'curator')!;
    assert.equal(curatorTurn.outcome, 'rejected');
    assert.ok(f.logs.some(line => /always\.md/.test(line)), 'the log names what failed');
    const row = f.db.prepare('SELECT base_commit FROM memory_curator').get() as { base_commit: string | null } | undefined;
    assert.equal(row?.base_commit ?? null, null, 'the base does not move');
  } finally { await f.cleanup(); }
});

test('a curator cut off at its call limit loses the whole night', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open({ curator: { modelCalls: 1 } });
    behave(f, MERGE);
    await aDay(f, loop);
    const before = f.commits();
    assert.equal((await loop.rotate()).result, 'switched');
    assert.equal(f.commits(), before + 1);
    assert.equal(f.git('status', '--porcelain'), '');
    assert.match(await f.read('予定.md'), /歯医者/);
    assert.equal(f.turns().find(turn => turn.kind === 'curator')!.outcome, 'model-call-limit');
  } finally { await f.cleanup(); }
});

test('natsumi sleeps through the curator: a message waits and the new session answers it', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    let late: ReturnType<typeof f.send> | undefined;
    behave(f, [{ calls: [call('run_shell', { command: 'true' })] }]);
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
    const seen = behave(f, MERGE);
    await aDay(f, loop);
    assert.equal((await loop.rotate()).result, 'switched');
    assert.equal(seen.length, 0);
    assert.equal(f.turns().some(turn => turn.kind === 'curator'), false);
  } finally { await f.cleanup(); }
});

test('the next night hands over only what changed since, and the files in turn', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open({ curator: { rotateFiles: 1 } });
    behave(f, [{ calls: [] }]);
    await aDay(f, loop);
    assert.equal((await loop.rotate()).result, 'switched');
    await writeFile(join(f.memory, '新しい話.md'), '# 新しい話\n');
    const seen = behave(f, [{ calls: [] }]);
    const auto = f.model.auto!;
    let wrote = false;
    f.model.auto = context => {
      if (!isCurator(context) && !wrote && textOf(context.messages.at(-1)!).includes('mac_message')) wrote = true;
      return auto(context);
    };
    await aDay(f, loop);
    assert.equal((await loop.rotate()).result, 'switched');
    const brief = firstUser(seen[0]!);
    const changed = brief.slice(brief.indexOf('変わったもの'), brief.indexOf('順番が回ってきたもの'));
    assert.match(changed, /- 新しい話\.md/);
    assert.doesNotMatch(changed, /予定/);
    const rotated = brief.slice(brief.indexOf('順番が回ってきたもの'));
    assert.equal(rotated.match(/^- /gm)?.length, 1);
  } finally { await f.cleanup(); }
});

test('a curator cut off by a stop keeps nothing, and the next start finishes the switch', async () => {
  const f = await setup();
  try {
    const first = await f.open();
    behave(f, [{ calls: [call('run_shell', { command: "printf '# 書きかけ\\n' > 書きかけ.md && rm 予定.md" })] }]);
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
    assert.equal(f.turns().find(turn => turn.kind === 'curator')!.outcome, 'stopped');

    behave(f, []);
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
