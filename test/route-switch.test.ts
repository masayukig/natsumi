import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import { LOOP_DEFAULTS, type LoopConfig } from '../src/server/config.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { readRouteChoice, readRouteStatus, writeRouteChoice } from '../src/server/model-routes.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop, type LoopClientEvent, type LoopOptions, type LoopRoute, type SendOutcome } from '../src/server/thinking-loop.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel } from './support/scripted-model.ts';

// Switching the model route by hand, between turns (ADR 0046). Both routes are subscription models the fixture's
// synthetic login covers; the scripted stream stands in for either, and records which model each call went to.

const FIRST = { provider: 'openai-codex', model: 'gpt-5.5' };
const SECOND = { provider: 'openai-codex', model: 'gpt-5.6-sol' };
const route = (name: string, target: typeof FIRST, compactionThreshold = 60_000): LoopRoute =>
  ({ name, target, compactionThreshold, compatible: false });
const ROUTES = { list: [route('main', FIRST), route('spare', SECOND),
  route('broken', { provider: 'openai-codex', model: 'fixture-unknown-model' })], defaultRoute: 'main' };

async function until<T>(check: () => T | undefined | false, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const isSummary = (context: Context) => /summar|要約/i.test(JSON.stringify(context.messages.at(-1)));
/** The memo asked for after every turn (ADR 0047) is not one of the turn's calls. */
const isMemo = (context: Context) => JSON.stringify(context.messages.at(-1)).includes('<turn_memo>');

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-routes-')));
  const data = join(root, 'data');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  await mkdir(join(data, '.natsumi'), { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(join(data, 'personality.md'), '# 性格・話し方\nfixture\n');
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const model = new ScriptedModel();
  /** The model each call went to, and whether it was a compaction's summary, in order. */
  const calls: { model: string; summary: boolean; memo: boolean }[] = [];
  const logs: string[] = [];
  const opened: ThinkingLoop[] = [];
  let counter = 0;
  const f = {
    data, db, model, calls, logs, sessionDirectory,
    async open(options: Partial<Omit<LoopOptions, 'loop'>> & { loop?: Partial<LoopConfig> } = {}) {
      const { loop: settings, ...rest } = options;
      const loop = await ThinkingLoop.open({
        db, dataDirectory: data, sessionDirectory, agentDirectory, target: FIRST, thinking: 'on', routes: ROUTES,
        runtime: fixtureRuntime, loop: { ...LOOP_DEFAULTS, eventModelCalls: 4, ...settings }, log: line => { logs.push(line); },
        configureSession: session => {
          session.agent.streamFunction = (target, context, streamOptions) => {
            calls.push({ model: target.id, summary: isSummary(context), memo: isMemo(context) });
            return model.streamFunction(target, context, streamOptions);
          };
        },
        ...rest,
      });
      opened.push(loop);
      const events: LoopClientEvent[] = [];
      loop.subscribe(event => { events.push(event); });
      return { loop, events };
    },
    send(loop: ThinkingLoop, text: string) {
      const outcome = loop.send({ requestId: `request-${++counter}`, deviceId: 'device-1', text });
      assert.equal(outcome.kind, 'accepted', JSON.stringify(outcome));
      return outcome as Extract<SendOutcome, { kind: 'accepted' }>;
    },
    /** Answers every call at once: a reply to the owner, then a stop. */
    answer() {
      model.auto = context => context.messages.at(-1)?.role === 'toolResult' || isSummary(context) ? 'おしまい'
        : { calls: [{ name: 'reply_to_mac', arguments: { text: 'はい', expression: 'neutral' } }] };
    },
    async cleanup() {
      for (const loop of opened) await loop.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  return f;
}

const completed = (events: LoopClientEvent[], eventId: string) =>
  until(() => events.find(e => e.type === 'conversation.event.completed' && e.payload.eventId === eventId));
const turnModels = (calls: { model: string; summary: boolean; memo: boolean }[]) => calls.filter(c => !c.summary && !c.memo).map(c => c.model);

test('a switch asked for during a turn waits for it to end; the next turn is on the new route, in the same session', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    assert.deepEqual(loop.snapshot().modelRoutes, {
      defaultRoute: 'main', current: 'main', chosen: 'main',
      routes: [{ name: 'main', provider: 'openai-codex', model: 'gpt-5.5', ready: true },
        { name: 'spare', provider: 'openai-codex', model: 'gpt-5.6-sol', ready: true },
        { name: 'broken', provider: 'openai-codex', model: 'fixture-unknown-model', ready: false }],
    });
    const first = f.send(loop, 'ひとつめ');
    const reply = await f.model.next();
    // Chosen while she is in the middle of the turn: the turn's remaining calls stay on the first route.
    assert.deepEqual(await loop.chooseRoute({ route: 'spare', deviceId: 'device-1' }), { kind: 'accepted', chosen: 'spare', current: 'main' });
    assert.equal(await readRouteChoice(f.data), 'spare');
    reply.call('reply_to_mac', { text: 'はい', expression: 'neutral' });
    reply.finish();
    (await f.model.next()).finish();
    await completed(events, first.eventId);
    f.answer();
    await loop.idle();
    assert.deepEqual(turnModels(f.calls), ['gpt-5.5', 'gpt-5.5']);

    const second = f.send(loop, 'ふたつめ');
    await completed(events, second.eventId);
    assert.deepEqual(turnModels(f.calls).slice(2), ['gpt-5.6-sol', 'gpt-5.6-sol']);
    const changed = events.filter(e => e.type === 'model.routes');
    assert.equal(changed.at(-1)?.payload.current, 'spare');
    assert.equal(loop.snapshot().modelRoutes.current, 'spare');
    assert.equal((await readdir(f.sessionDirectory)).filter(name => name.endsWith('.jsonl')).length, 1);
    assert.ok(f.logs.some(line => line === 'thinking loop: now on the model route spare'), f.logs.join('\n'));
  } finally { await f.cleanup(); }
});

test('a choice written by the command line is taken before the next turn, and survives a restart', async () => {
  const f = await setup();
  try {
    f.answer();
    const { loop, events } = await f.open();
    await writeRouteChoice(f.data, 'spare', Date.now());
    await completed(events, f.send(loop, 'きりかえた？').eventId);
    assert.deepEqual(turnModels(f.calls), ['gpt-5.6-sol', 'gpt-5.6-sol']);
    await loop.close();

    const restarted = await f.open();
    assert.equal(restarted.loop.snapshot().modelRoutes.current, 'spare');
    await completed(restarted.events, f.send(restarted.loop, '再起動後').eventId);
    assert.deepEqual(turnModels(f.calls).slice(2), ['gpt-5.6-sol', 'gpt-5.6-sol']);
    assert.equal((await readRouteStatus(f.data))?.current, 'spare');
  } finally { await f.cleanup(); }
});

test('while idle, a refresh moves to a newly chosen route at once and tells the devices', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    await writeRouteChoice(f.data, 'spare', Date.now());
    await loop.refreshRoutes();
    await loop.idle();
    assert.equal(loop.snapshot().modelRoutes.current, 'spare');
    assert.deepEqual(events.filter(e => e.type === 'model.routes').map(e => [e.payload.current, e.payload.chosen]), [['spare', 'spare']]);
    assert.equal((await readRouteStatus(f.data))?.current, 'spare');
    // Nothing changed: nothing is told.
    await loop.refreshRoutes();
    assert.equal(events.filter(e => e.type === 'model.routes').length, 1);
  } finally { await f.cleanup(); }
});

test('a chosen route that is no longer in the config gives way to the default, with a line in the log', async () => {
  const f = await setup();
  try {
    await writeRouteChoice(f.data, 'removed', Date.now());
    f.answer();
    const { loop, events } = await f.open();
    assert.equal(loop.snapshot().modelRoutes.current, 'main');
    assert.equal(loop.snapshot().modelRoutes.chosen, 'main');
    assert.equal(await readRouteChoice(f.data), 'main');
    assert.ok(f.logs.includes('thinking loop: the chosen model route removed is not in the config; back to the default main'), f.logs.join('\n'));
    await completed(events, f.send(loop, 'だいじょうぶ？').eventId);
    assert.deepEqual(turnModels(f.calls), ['gpt-5.5', 'gpt-5.5']);
  } finally { await f.cleanup(); }
});

test('a route that does not exist or is not ready is refused, and the session stays where it is', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open();
    assert.deepEqual(await loop.chooseRoute({ route: 'nowhere', deviceId: 'device-1' }), { kind: 'rejected', code: 'unknown-route' });
    assert.deepEqual(await loop.chooseRoute({ route: 'broken', deviceId: 'device-1' }), { kind: 'rejected', code: 'route-unavailable' });
    assert.equal(await readRouteChoice(f.data), undefined);
    // Chosen behind its back, a route that is not ready is not moved to: no route stands in, and the log says why once.
    await writeRouteChoice(f.data, 'broken', Date.now());
    await loop.refreshRoutes();
    await loop.refreshRoutes();
    assert.equal(loop.snapshot().modelRoutes.current, 'main');
    assert.equal(loop.snapshot().modelRoutes.chosen, 'broken');
    assert.equal(f.logs.filter(line => line === 'thinking loop: the model route broken is not ready; staying on main').length, 1);
  } finally { await f.cleanup(); }
});

test('a chosen route that is not ready at startup leaves natsumi unable to talk rather than falling back', async () => {
  const f = await setup();
  try {
    await writeRouteChoice(f.data, 'broken', Date.now());
    const { loop } = await f.open();
    assert.equal(loop.unavailable, 'pi-unavailable');
    assert.ok(f.logs.includes('thinking loop: the model route broken is not ready'), f.logs.join('\n'));
    assert.equal((await readRouteStatus(f.data))?.current, null);
  } finally { await f.cleanup(); }
});

test('after a switch to a route with a lower threshold, the session is compacted before the next turn, on the new route', async () => {
  const f = await setup();
  try {
    const routes = { list: [route('main', FIRST, 60_000), route('spare', SECOND, 1_500)], defaultRoute: 'main' };
    f.answer();
    const { loop, events } = await f.open({ routes, loop: { compactionKeepRecent: 400 } });
    const long = 'あ'.repeat(4_000);
    await completed(events, f.send(loop, `長い話 ${long}`).eventId);
    await completed(events, f.send(loop, `もっと長い話 ${long}`).eventId);
    await loop.idle();
    assert.equal(f.calls.some(c => c.summary), false);

    assert.equal((await loop.chooseRoute({ route: 'spare', deviceId: 'device-1' })).kind, 'accepted');
    await loop.idle();
    const summary = f.calls.findIndex(c => c.summary);
    assert.ok(summary >= 0, 'compacted after the switch');
    assert.equal(f.calls[summary]!.model, 'gpt-5.6-sol');
    await completed(events, f.send(loop, 'つぎ').eventId);
    assert.ok(f.calls.findIndex((c, i) => i > summary && !c.summary && !c.memo) > summary);
  } finally { await f.cleanup(); }
});
