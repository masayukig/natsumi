import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { LOOP_DEFAULTS, type LoopConfig } from '../src/server/config.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop, type LoopClientEvent, type LoopOptions, type SendOutcome } from '../src/server/thinking-loop.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel } from './support/scripted-model.ts';

/**
 * The day's plan on a ping (ADR 0090): the committed `goals/today.md` rides on the first ping of a session — after a
 * nightly switch or a nap too — and on the first ping after a compaction, and on no other. Whether it rode is kept in
 * the server's memory alone, so a restart shows it again; with no plan committed nothing rides and nothing is counted.
 */

type OpenOptions = Partial<Omit<LoopOptions, 'loop'>> & { loop?: Partial<LoopConfig> };

// A fictional plan.
const PLAN = '# 2026-10-31\n\n- [ ] cluster-health: アラートの一覧を見る（日課）\n- [ ] 買い物のメモを整える\n';
const PLAN_FIELD = 'today_plan';

async function until<T>(check: () => T | undefined | false, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const textOf = (message: Context['messages'][number]) => {
  const content = (message as { content: unknown }).content;
  if (typeof content === 'string') return content;
  return (content as { type: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text).join('');
};
const eventLines = (text: string) => [...text.matchAll(/^\{.*\}$/gm)].map(match => JSON.parse(match[0]) as Record<string, unknown>);
const isSummary = (context: Context) => (context.systemPrompt ?? '').includes('summarization');

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-goals-loop-')));
  const data = join(root, 'data');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  const memory = join(data, 'memory');
  await mkdir(memory, { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const model = new ScriptedModel();
  /** Every event line a turn was handed, in order, by its type. */
  const lines: Record<string, unknown>[] = [];
  model.auto = context => {
    if (isSummary(context)) return '要約: なし';
    const last = context.messages.at(-1);
    if (last?.role !== 'user') return {};
    lines.push(...eventLines(textOf(last)));
    const review = lines.at(-1)?.type === 'nightly_review';
    return review ? { calls: [{ name: 'write_handoff_note', arguments: { text: '明日も計画を進める' } }] } : {};
  };
  const opened: ThinkingLoop[] = [];
  let counter = 0;
  const f = {
    memory, model, lines,
    pings: () => lines.filter(line => line.type === 'ping'),
    async open({ loop: settings, ...options }: OpenOptions = {}) {
      const loop = await ThinkingLoop.open({
        db, dataDirectory: data, sessionDirectory, agentDirectory, target: SUBSCRIPTION_TARGET, thinking: 'on',
        runtime: fixtureRuntime, loop: { ...LOOP_DEFAULTS, timeZone: 'Asia/Tokyo', eventModelCalls: 4, ...settings },
        configureSession: session => { session.agent.streamFunction = model.streamFunction; },
        ...options,
      });
      opened.push(loop);
      const events: LoopClientEvent[] = [];
      loop.subscribe(event => { events.push(event); });
      return { loop, events };
    },
    /** A ping, and the line it became once its turn is over. */
    async ping(loop: ThinkingLoop) {
      const before = f.pings().length;
      assert.equal(loop.ping(), true);
      await until(() => f.pings().length > before);
      await loop.idle();
      return f.pings().at(-1)!;
    },
    async send(loop: ThinkingLoop, events: LoopClientEvent[], text: string) {
      const outcome = loop.send({ requestId: `request-${++counter}`, deviceId: 'device-1', text }) as Extract<SendOutcome, { kind: 'accepted' }>;
      assert.equal(outcome.kind, 'accepted');
      await until(() => events.find(e => e.type === 'conversation.event.completed' && e.payload.eventId === outcome.eventId));
      await loop.idle();
    },
    /** The owner's commit over ssh: no check, and no turn of hers. */
    commit(name: string, text: string) {
      execFileSync('mkdir', ['-p', join(memory, 'goals')]);
      // Before the first start the owner's repository is made as git makes one; the start then keeps its history.
      execFileSync('sh', ['-c', 'test -d .git || git init -q -b main', 'sh'], { cwd: memory });
      execFileSync('sh', ['-c', 'cat > "$1"', 'sh', join(memory, name)], { input: text });
      execFileSync('git', ['-C', memory, '-c', 'user.name=owner', '-c', 'user.email=owner@example.invalid', 'add', '-A']);
      execFileSync('git', ['-C', memory, '-c', 'user.name=owner', '-c', 'user.email=owner@example.invalid', 'commit', '-q', '-m', 'plan']);
    },
    async cleanup() {
      for (const loop of opened) await loop.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  return f;
}

test('no plan committed: nothing rides and nothing is counted, so the first ping after one is committed carries it, and only that one', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open();
    assert.equal(PLAN_FIELD in await f.ping(loop), false);
    f.commit('goals/today.md', PLAN);
    const first = await f.ping(loop);
    assert.equal(first[PLAN_FIELD], PLAN);
    // The other keys of a ping stay as they were.
    assert.equal(typeof first.local_time, 'string');
    assert.equal(PLAN_FIELD in await f.ping(loop), false);
    assert.equal(PLAN_FIELD in await f.ping(loop), false);
  } finally { await f.cleanup(); }
});

test('only what HEAD holds rides: a plan written but not committed is not shown', async () => {
  const f = await setup();
  try {
    f.commit('goals/today.md', PLAN);
    await writeFile(join(f.memory, 'goals', 'today.md'), `${PLAN}- [ ] まだコミットしていない\n`);
    const { loop } = await f.open();
    assert.equal((await f.ping(loop))[PLAN_FIELD], PLAN);
  } finally { await f.cleanup(); }
});

test('a message is never a ping: the plan waits for the first ping, and rides on it', async () => {
  const f = await setup();
  try {
    f.commit('goals/today.md', PLAN);
    const { loop, events } = await f.open();
    await f.send(loop, events, 'こんにちは');
    const message = f.lines.find(line => line.type === 'mac_message')!;
    assert.equal(PLAN_FIELD in message, false);
    assert.equal((await f.ping(loop))[PLAN_FIELD], PLAN);
  } finally { await f.cleanup(); }
});

test('a restart forgets that it rode, so the same session is shown the plan again', async () => {
  const f = await setup();
  try {
    f.commit('goals/today.md', PLAN);
    const first = await f.open();
    assert.equal((await f.ping(first.loop))[PLAN_FIELD], PLAN);
    assert.equal(PLAN_FIELD in await f.ping(first.loop), false);
    await first.loop.close();
    const again = await f.open();
    assert.equal((await f.ping(again.loop))[PLAN_FIELD], PLAN);
    assert.equal(PLAN_FIELD in await f.ping(again.loop), false);
  } finally { await f.cleanup(); }
});

test('the nightly switch begins a new session, whose first ping carries the plan', async () => {
  const f = await setup();
  try {
    f.commit('goals/today.md', PLAN);
    const { loop } = await f.open();
    assert.equal((await f.ping(loop))[PLAN_FIELD], PLAN);
    assert.equal((await loop.rotate()).result, 'switched');
    await loop.idle();
    assert.equal((await f.ping(loop))[PLAN_FIELD], PLAN);
    assert.equal(PLAN_FIELD in await f.ping(loop), false);
  } finally { await f.cleanup(); }
});

test('a compaction summarizes the plan away, so the first ping after it carries the plan again', async () => {
  const f = await setup();
  try {
    f.commit('goals/today.md', PLAN);
    const { loop, events } = await f.open({ loop: { compactionThreshold: 1_500, compactionKeepRecent: 400 } });
    assert.equal((await f.ping(loop))[PLAN_FIELD], PLAN);
    assert.equal(PLAN_FIELD in await f.ping(loop), false);
    const long = 'あ'.repeat(1_500);
    for (let i = 0; i < 4 && !loop.dashboardState().lastCompactionAt; i++) await f.send(loop, events, `話 ${i} ${long}`);
    assert.ok(loop.dashboardState().lastCompactionAt, 'compacted');
    assert.equal((await f.ping(loop))[PLAN_FIELD], PLAN);
  } finally { await f.cleanup(); }
});
