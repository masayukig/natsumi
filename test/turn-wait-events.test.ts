import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { withCodemode } from '../src/server/codemode.ts';
import { DEFAULT_CODEMODE, LOOP_DEFAULTS, RESERVED_TOOL_NAMES, type LoopConfig } from '../src/server/config.ts';
import { createLoopTools, type LoopToolHost } from '../src/server/loop-tools.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { WAIT_FOR_EVENTS_DESCRIPTION } from '../src/server/prompts.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop, type LoopClientEvent, type LoopOptions, type SourceEvents } from '../src/server/thinking-loop.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel, type ScriptedStep } from './support/scripted-model.ts';

/**
 * Waiting for news within a turn (ADR 0094): what is marked for her (an attention) is steered into the running turn as
 * an owner's message is, `wait_for_events` waits in the turn for what can be steered in, and a long turn whose context
 * has grown past the route's compaction threshold is asked to end at a good place, and stopped at one and a half times.
 */

type OpenOptions = Partial<Omit<LoopOptions, 'loop'>> & { loop?: Partial<LoopConfig> };

interface FakeAttention { kind: string; images?: true }

/** The sources as the loop reads them: attentions and plain changes the test puts there, taken as `Sources.take` would. */
function fakeSources() {
  const state = { attentions: [] as FakeAttention[], plain: [] as string[], taken: [] as { eventId: string; attentionsOnly: boolean }[] };
  const lines = new Map<string, Record<string, unknown>>();
  const sources: SourceEvents = {
    steerable: () => state.attentions.some(attention => !attention.images),
    async take(eventId, options = {}) {
      if (lines.has(eventId)) return true;
      const attentionsOnly = options.attentionsOnly === true;
      const chosen = attentionsOnly ? state.attentions.filter(attention => !attention.images) : [...state.attentions];
      const plain = attentionsOnly ? [] : state.plain.splice(0);
      if (chosen.length === 0 && plain.length === 0) return false;
      state.attentions = state.attentions.filter(attention => !chosen.includes(attention));
      lines.set(eventId, { changed: [...plain.map(dir => ({ dir })),
        ...(chosen.length > 0 ? [{ dir: '/sources/jobs/x', attention: chosen.map(({ kind }) => ({ kind })) }] : [])] });
      state.taken.push({ eventId, attentionsOnly });
      return true;
    },
    eventLine: (eventId, receivedAt) => ({ type: 'sources_updated', received_at: receivedAt, ...lines.get(eventId) }),
    images: async () => [],
  };
  return { sources, state };
}

async function setup(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-turn-wait-')));
  const data = join(root, 'data');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  await mkdir(data);
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(join(data, 'personality.md'), '# 性格・話し方\n落ち着いている\n');
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const model = new ScriptedModel();
  const sessions: AgentSession[] = [];
  const opened: ThinkingLoop[] = [];
  const logs: string[] = [];
  const fake = fakeSources();
  const clock = { now: Date.parse('2026-11-06T03:00:00Z') };
  let counter = 0;
  t.after(async () => {
    t.mock.timers.reset();
    for (const loop of opened) await loop.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    db, model, sessions, logs, clock, ...fake,
    async open({ loop: settings, ...options }: OpenOptions = {}) {
      const loop = await ThinkingLoop.open({
        db, dataDirectory: data, sessionDirectory, agentDirectory, target: SUBSCRIPTION_TARGET, thinking: 'on',
        runtime: fixtureRuntime, loop: { ...LOOP_DEFAULTS, eventModelCalls: 8, ...settings }, now: () => clock.now,
        configureSession: session => { session.agent.streamFunction = model.streamFunction; sessions.push(session); },
        sources: fake.sources, log: line => { logs.push(line); },
        ...options,
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
    /** A request to an outside agent whose reply is still waited for: something `wait_for_events` may wait for. */
    waitForAgent() {
      db.prepare(`INSERT INTO agent_tasks (agent, task_id, context_id, state, sent_at, created_at, updated_at)
        VALUES ('wiki', 'task-1', 'context-1', 'waiting', ?, ?, ?)`).run(...Array(3).fill(new Date(clock.now).toISOString()));
    },
    /** A turn of the day, so that the night has a session to review. */
    async dayBefore(loop: ThinkingLoop) {
      model.auto = () => ({});
      this.send(loop, 'おはよう');
      await loop.idle();
    },
    /** Resolves when the session in use starts running the tool named. */
    started(name: string) {
      const session = sessions.at(-1)!;
      return new Promise<void>(resolve => {
        const stop = session.subscribe(event => {
          if (event.type === 'tool_execution_start' && event.toolName === name) { stop(); resolve(); }
        });
      });
    },
    eventState: (eventId: string) =>
      db.prepare('SELECT state, reason FROM loop_events WHERE event_id = ?').get(eventId) as { state: string; reason: string | null },
  };
}

const textOf = (message: Context['messages'][number]) => {
  const content = (message as { content: unknown }).content;
  if (typeof content === 'string') return content;
  return (content as { type: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text).join('');
};
const userTexts = (context: Context) => context.messages.filter(m => m.role === 'user').map(textOf);
const lastUserText = (context: Context) => userTexts(context).at(-1)!;
/** The tool results a model call saw after its previous assistant message, in order. */
const toolResults = (context: Context) => {
  const lastAssistant = context.messages.map(m => m.role).lastIndexOf('assistant');
  return context.messages.slice(lastAssistant + 1).filter(m => m.role === 'toolResult')
    .map(m => ({ name: (m as { toolName: string }).toolName, text: textOf(m), isError: (m as { isError: boolean }).isError }));
};
const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });
const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(check: () => boolean) {
  for (let i = 0; i < 1000 && !check(); i += 1) await flush();
  assert.ok(check(), 'timed out');
}

// MARK: - Attentions steered into the running turn

test('an attention raised while a turn runs is steered into it at the next model call, and is not shown again after it', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  f.send(loop, '集計して');
  const first = await f.model.next();
  f.state.attentions.push({ kind: 'shell_finished' });
  loop.raiseSourcesUpdated();
  await until(() => f.state.taken.length === 1);
  assert.equal(f.state.taken[0]!.attentionsOnly, true);
  first.call('list_self_checks', {});
  first.finish();

  const second = await f.model.next();
  assert.match(lastUserText(second.context), /"type":"sources_updated".*shell_finished/);
  second.finish();
  await loop.idle();
  // The event queued for after the turn found nothing left to show, so no turn was run for it.
  assert.equal(f.model.calls, 2);
  assert.equal(f.eventState(f.state.taken[0]!.eventId).state, 'no-reply');
});

test('a change with no attention is not steered in: it waits for a turn after the running one, as before', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  f.send(loop, '集計して');
  const first = await f.model.next();
  f.state.plain.push('/sources/slack/work/dev');
  loop.raiseSourcesUpdated();
  await flush();
  first.call('list_self_checks', {});
  first.finish();
  const second = await f.model.next();
  assert.doesNotMatch(lastUserText(second.context), /sources_updated/);
  second.finish();

  const after = await f.model.next();
  assert.match(lastUserText(after.context), /"type":"sources_updated".*slack\/work\/dev/);
  after.finish();
  await loop.idle();
  assert.deepEqual(f.state.taken.map(taken => taken.attentionsOnly), [false]);
});

test('an attention with images to show waits for a turn of its own, where they go beside its line', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  f.send(loop, '集計して');
  const first = await f.model.next();
  f.state.attentions.push({ kind: 'mention', images: true });
  loop.raiseSourcesUpdated();
  await flush();
  first.finish();
  const after = await f.model.next();
  assert.match(lastUserText(after.context), /"type":"sources_updated".*mention/);
  after.finish();
  await loop.idle();
  assert.deepEqual(f.state.taken.map(taken => taken.attentionsOnly), [false]);
});

test('nothing is steered into the nightly review, nor into a turn a stop is waiting for', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  await f.dayBefore(loop);
  f.model.takeOver();
  const rotation = loop.rotate();
  const review = await f.model.next();
  f.state.attentions.push({ kind: 'shell_finished' });
  loop.raiseSourcesUpdated();
  await flush();
  review.call('write_handoff_note', { text: '明日の引き継ぎ' });
  review.finish();
  const reviewEnd = await f.model.next();
  assert.ok(userTexts(reviewEnd.context).every(text => !text.includes('sources_updated')));
  reviewEnd.finish();
  f.model.auto = () => ({});
  assert.equal((await rotation).result, 'switched');
  await loop.idle();
  assert.deepEqual(f.state.taken.map(taken => taken.attentionsOnly), [false], 'shown in a turn of its own after the night');

  f.model.takeOver();
  f.send(loop, 'もう一件');
  const turn = await f.model.next();
  const drained = loop.drain(10_000);
  f.state.attentions.push({ kind: 'shell_finished' });
  loop.raiseSourcesUpdated();
  await flush();
  turn.finish();
  assert.equal((await drained).result, 'ended');
  assert.equal(f.state.taken.length, 1);
});

test('an attention steered in that Pi did not deliver goes back to the queue, and the next turn shows it', async t => {
  const f = await setup(t);
  const { loop } = await f.open({ loop: { eventModelCalls: 1 } });
  f.send(loop, '集計して');
  const first = await f.model.next();
  f.state.attentions.push({ kind: 'shell_finished' });
  loop.raiseSourcesUpdated();
  await until(() => f.state.taken.length === 1);
  // The limit ends the turn at this call, before the boundary the attention was waiting for.
  first.call('list_self_checks', {});
  first.finish();
  const next = await f.model.next();
  assert.match(lastUserText(next.context), /"type":"sources_updated".*shell_finished/);
  next.finish();
  await loop.idle();
  assert.equal(f.state.taken.length, 1, 'its line was made once');
});

// MARK: - wait_for_events

test('with nothing to wait for, wait_for_events comes back at once and says so', async t => {
  const f = await setup(t);
  const { loop } = await f.open();
  f.model.auto = (() => {
    const steps: ScriptedStep[] = [{ calls: [call('wait_for_events', { max_seconds: 600 })] }];
    return () => steps.shift() ?? {};
  })();
  f.send(loop, '待って');
  await loop.idle();
  const [result] = toolResults(f.model.contexts[1]!);
  assert.equal(result!.isError, false);
  assert.match(result!.text, /待つ相手がいない/);
});

test('wait_for_events comes back as soon as something that can be steered in arrives', async t => {
  const f = await setup(t);
  f.waitForAgent();
  const { loop } = await f.open();
  f.send(loop, '待って');
  const first = await f.model.next();
  const started = f.started('wait_for_events');
  first.call('wait_for_events', { max_seconds: 600 });
  first.finish();
  await started;
  for (let i = 0; i < 20; i += 1) await flush();
  f.state.attentions.push({ kind: 'agent_reply' });
  loop.raiseSourcesUpdated();
  const second = await f.model.next();
  const [result] = toolResults(second.context);
  assert.match(result!.text, /届きました/);
  assert.match(lastUserText(second.context), /"type":"sources_updated".*agent_reply/);
  second.finish();
  await loop.idle();
});

test('an owner message wakes wait_for_events too, and is steered in after it', async t => {
  const f = await setup(t);
  f.waitForAgent();
  const { loop } = await f.open();
  f.send(loop, '待って');
  const first = await f.model.next();
  const started = f.started('wait_for_events');
  first.call('wait_for_events', { max_seconds: 600 });
  first.finish();
  await started;
  for (let i = 0; i < 20; i += 1) await flush();
  f.send(loop, 'まだ？');
  const second = await f.model.next();
  assert.match(toolResults(second.context)[0]!.text, /届きました/);
  assert.match(lastUserText(second.context), /まだ？/);
  second.finish();
  await loop.idle();
});

test('wait_for_events comes back when its seconds are up, saying nothing came', async t => {
  const f = await setup(t);
  f.waitForAgent();
  const { loop } = await f.open();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.send(loop, '待って');
  const first = await f.model.next();
  const started = f.started('wait_for_events');
  first.call('wait_for_events', { max_seconds: 30 });
  first.finish();
  await started;
  // The tool runs a moment after Pi says it starts; its timer is set by then.
  for (let i = 0; i < 20; i += 1) await flush();
  t.mock.timers.tick(30_000 - 1);
  await flush();
  assert.equal(f.model.calls, 1);
  t.mock.timers.tick(1);
  const second = await f.model.next();
  const [result] = toolResults(second.context);
  assert.match(result!.text, /30 秒/);
  assert.match(result!.text, /届きませんでした/);
  second.finish();
  await loop.idle();
});

test('the wait is cut to what is left of the turn, and with nothing left she is told to end the turn', async t => {
  const f = await setup(t);
  f.waitForAgent();
  const { loop } = await f.open({ loop: { eventTimeoutMinutes: 1 } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.send(loop, '待って');
  const first = await f.model.next();
  f.clock.now += 50_000;
  const started = f.started('wait_for_events');
  first.call('wait_for_events', { max_seconds: 600 });
  first.finish();
  await started;
  // The tool runs a moment after Pi says it starts; its timer is set by then.
  for (let i = 0; i < 20; i += 1) await flush();
  t.mock.timers.tick(10_000);
  const second = await f.model.next();
  const [cut] = toolResults(second.context);
  assert.match(cut!.text, /10 秒/);
  assert.match(cut!.text, /残り/);
  f.clock.now += 10_000;
  second.call('wait_for_events', { max_seconds: 600 });
  second.finish();
  const third = await f.model.next();
  const [over] = toolResults(third.context);
  assert.match(over!.text, /ターンを終え/);
  third.finish();
  await loop.idle();
});

test('the nightly review does not wait: nothing could be steered into it', async t => {
  const f = await setup(t);
  f.waitForAgent();
  const { loop } = await f.open();
  await f.dayBefore(loop);
  f.model.takeOver();
  const rotation = loop.rotate();
  const review = await f.model.next();
  review.call('wait_for_events', { max_seconds: 600 });
  review.call('write_handoff_note', { text: '明日の引き継ぎ' });
  review.finish();
  const next = await f.model.next();
  assert.match(toolResults(next.context)[0]!.text, /振り返り/);
  next.finish();
  f.model.auto = () => ({});
  assert.equal((await rotation).result, 'switched');
});

test('wait_for_events is the model\'s own: always there, last, with a fixed description, and never a script\'s', () => {
  const host = { runShell: async () => ({ ok: true, text: '' }), capture: async () => ({ ok: false, text: '' }) } as unknown as LoopToolHost;
  const tools = createLoopTools(host);
  assert.equal(tools.at(-1)!.name, 'wait_for_events');
  assert.equal(tools.at(-1)!.description, WAIT_FOR_EVENTS_DESCRIPTION);
  assert.deepEqual(Object.keys((tools.at(-1)!.parameters as { properties: object }).properties), ['max_seconds']);
  assert.equal(createLoopTools({} as LoopToolHost).at(-1)!.name, 'wait_for_events');
  assert.ok(RESERVED_TOOL_NAMES.has('wait_for_events'));
  const { tools: given } = withCodemode(tools, { ...DEFAULT_CODEMODE, enabled: true, workspaceTools: 'codemode' }, () => undefined);
  const exposure = (given.definitions as { name: string; exposure?: string }[]).find(tool => tool.name === 'wait_for_events')!.exposure;
  assert.equal(exposure, 'model-only');
  // The description says nothing a deployment decides (ADR 0019).
  assert.doesNotMatch(WAIT_FOR_EVENTS_DESCRIPTION, /\d/);
});

// MARK: - A context grown too large in a long turn

test('past the compaction threshold, the next tool result asks her to end at a good place, and wait_for_events does not wait', async t => {
  const f = await setup(t);
  f.waitForAgent();
  const { loop } = await f.open({ loop: { compactionThreshold: 10_000 } });
  const steps: ScriptedStep[] = [
    { usage: { input: 9_000 }, calls: [call('list_self_checks', {})] },
    { usage: { input: 10_500 }, calls: [call('list_self_checks', {}), call('wait_for_events', { max_seconds: 600 })] },
  ];
  f.model.auto = () => steps.shift() ?? {};
  f.send(loop, '長い作業');
  await loop.idle();
  const [under] = toolResults(f.model.contexts[1]!);
  assert.doesNotMatch(under!.text, /区切り/);
  const [listed, waited] = toolResults(f.model.contexts[2]!);
  assert.match(listed!.text, /区切りのいいところでターンを終え/);
  assert.match(waited!.text, /区切りのいいところでターンを終え/);
  assert.equal([...waited!.text.matchAll(/区切り/g)].length, 1, 'said once');
});

test('past one and a half times the threshold the turn is stopped, the event failing as context-limit, and the memo still asked', async t => {
  const f = await setup(t);
  const { loop, events } = await f.open({ loop: { compactionThreshold: 10_000 } });
  const steps: ScriptedStep[] = [
    { usage: { input: 14_000 }, calls: [call('list_self_checks', {})] },
    { usage: { input: 15_001 }, calls: [call('list_self_checks', {})] },
    { calls: [call('list_self_checks', {})] },
  ];
  f.model.auto = () => steps.shift() ?? {};
  const sent = f.send(loop, '長い作業');
  await loop.idle();
  assert.equal(f.model.calls, 2);
  assert.deepEqual({ ...f.eventState(sent.eventId) }, { state: 'failed', reason: 'context-limit' });
  const done = events.find(e => e.type === 'conversation.event.completed' && e.payload.eventId === sent.eventId)!;
  assert.deepEqual([done.payload.status, done.payload.reason], ['failed', 'context-limit']);
  assert.ok(f.logs.some(line => /stopped at the context limit/.test(line)), f.logs.join('\n'));
  assert.equal(f.model.reflections.length, 1);
});

test('a stop beginning wakes wait_for_events, so the stop does not wait for the wait (ADR 0083)', async t => {
  const f = await setup(t);
  f.waitForAgent();
  const { loop } = await f.open();
  f.send(loop, '待って');
  const first = await f.model.next();
  const started = f.started('wait_for_events');
  first.call('wait_for_events', { max_seconds: 600 });
  first.finish();
  await started;
  for (let i = 0; i < 20; i += 1) await flush();
  const drained = loop.drain(10_000);
  const second = await f.model.next();
  assert.match(toolResults(second.context)[0]!.text, /止まろうとしています/);
  second.finish();
  assert.equal((await drained).result, 'ended');
});
