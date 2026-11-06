import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import WebSocket from 'ws';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { LOOP_DEFAULTS } from '../src/server/config.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop, type LoopClientEvent, type SendOutcome } from '../src/server/thinking-loop.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel } from './support/scripted-model.ts';
import { login, startFixture } from './support/server-fixture.ts';

// A stop waits for the turn in progress to end on its own (ADR 0083): no new turn starts, the owner's messages wait in
// the queue for the next start, and the night is cut as before.

async function until<T>(check: () => T | undefined | false, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-drain-')));
  const data = join(root, 'data');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  await mkdir(data);
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const model = new ScriptedModel();
  const opened: ThinkingLoop[] = [];
  let counter = 0;
  const f = {
    db, model,
    async open() {
      const loop = await ThinkingLoop.open({
        db, dataDirectory: data, sessionDirectory, agentDirectory, target: SUBSCRIPTION_TARGET, thinking: 'on',
        runtime: fixtureRuntime, loop: { ...LOOP_DEFAULTS, eventModelCalls: 4 },
        configureSession: session => { session.agent.streamFunction = model.streamFunction; },
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
    event: (eventId: string) => ({ ...db.prepare('SELECT state, reason FROM loop_events WHERE event_id = ?').get(eventId) as
      { state: string; reason: string | null } }),
    async cleanup() {
      for (const loop of opened) await loop.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  return f;
}

const userText = (context: Context) => {
  const message = context.messages.filter(item => item.role === 'user').at(-1) as { content: string | { type: string; text?: string }[] };
  return typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('');
};
const completed = (events: LoopClientEvent[], eventId: string) =>
  until(() => events.find(e => e.type === 'conversation.event.completed' && e.payload.eventId === eventId));

test('a stop waits for the event turn in progress to end, with its memo, and starts nothing after it', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const sent = f.send(loop, 'はじめの話');
    const first = await f.model.next();
    let drained = false;
    const draining = loop.drain(60_000).then(outcome => { drained = true; return outcome; });
    // The owner may still talk: the message is kept, waits in the queue and is not steered into the turn.
    assert.equal(loop.unavailable, undefined);
    const later = f.send(loop, '止まる途中の話');
    assert.equal(later.state, 'queued');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(drained, false, 'the turn is still going');

    first.call('reply_to_mac', { text: '返事です', expression: 'neutral' });
    first.finish();
    (await f.model.next()).finish();
    const outcome = await draining;
    assert.equal(outcome.result, 'ended');
    assert.equal((await completed(events, sent.eventId)).payload.status, 'replied');
    assert.equal(f.event(sent.eventId).state, 'replied');
    assert.equal(f.model.reflections.length, 1, 'the memo is part of the turn waited for');
    assert.ok(!f.model.contexts.some(context => userText(context).includes('止まる途中の話')), 'no new turn starts');
    await loop.close();
    assert.equal(f.event(later.eventId).state, 'queued');

    // The next start takes the message up.
    f.model.auto = context => context.messages.at(-1)?.role === 'user'
      ? { calls: [{ name: 'reply_to_mac', arguments: { text: 'あとで返事', expression: 'neutral' } }] } : {};
    const again = await f.open();
    assert.equal((await completed(again.events, later.eventId)).payload.status, 'replied');
    assert.ok(f.model.contexts.some(context => userText(context).includes('止まる途中の話')));
  } finally { await f.cleanup(); }
});

test('a turn that does not end within the limit is stopped as before', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open();
    const sent = f.send(loop, '長くなる話');
    await f.model.next();
    const started = Date.now();
    const outcome = await loop.drain(50);
    assert.equal(outcome.result, 'limit');
    assert.ok(Date.now() - started >= 40);
    await loop.close();
    assert.deepEqual(f.event(sent.eventId), { state: 'failed', reason: 'stopped' });
  } finally { await f.cleanup(); }
});

test('a limit of 0 waits for nothing', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open();
    const sent = f.send(loop, '話');
    await f.model.next();
    assert.deepEqual(await loop.drain(0), { result: 'limit', waitedMs: 0 });
    await loop.close();
    assert.deepEqual(f.event(sent.eventId), { state: 'failed', reason: 'stopped' });
  } finally { await f.cleanup(); }
});

test('with nothing in progress the stop waits for nothing', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open();
    assert.deepEqual(await loop.drain(60_000), { result: 'idle', waitedMs: 0 });
  } finally { await f.cleanup(); }
});

test('the nightly switch is not waited for: it is cut, and the next night goes on', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open();
    // A day with something in it, so the night has a session to review.
    f.model.auto = () => ({});
    f.send(loop, '昼の話');
    await loop.idle();
    f.model.takeOver();
    const rotation = loop.rotate();
    await f.model.next();
    const started = Date.now();
    assert.equal((await loop.drain(60_000)).result, 'night');
    assert.ok(Date.now() - started < 1_000);
    await loop.close();
    assert.deepEqual(await rotation, { result: 'failed', reason: 'stopped' });
  } finally { await f.cleanup(); }
});

interface Envelope { type: string; requestId?: string; payload: Record<string, any> }

test('the server keeps its clients while it waits, so the reply reaches them, and logs how the wait ended', async () => {
  const f = await startFixture({ loop: { shutdownDrainSeconds: 60 } });
  try {
    const { token } = await login(f);
    const ws = new WebSocket(f.wsUrl, { headers: { authorization: `Bearer ${token}` } });
    const received: Envelope[] = [];
    ws.on('message', data => { received.push(JSON.parse(String(data)) as Envelope); });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    let deviceId: string | undefined;
    let counter = 0;
    const request = async (type: string, payload: Record<string, unknown> = {}) => {
      const requestId = `request-${++counter}`;
      ws.send(JSON.stringify({ v: 1, requestId, deviceId, type, payload }));
      return until(() => received.find(message => message.requestId === requestId));
    };
    deviceId = (await request('session.sync', { resume: null })).payload.deviceId;
    await request('conversation.send', { text: 'はじめの話' });
    const first = await f.model.next();

    let stopped = false;
    const stopping = f.server.stop().then(() => { stopped = true; });
    await until(() => f.logs.some(line => line.includes('stopping: waiting')));
    const later = await request('conversation.send', { text: '止まる途中の話' });
    assert.equal(later.payload.state, 'queued');
    assert.equal(stopped, false);

    f.model.auto = () => ({});
    first.call('reply_to_mac', { text: '止まる前の返事', expression: 'neutral' });
    first.finish();
    await until(() => received.find(message => message.type === 'conversation.message' && message.payload.text === '止まる前の返事'));
    await stopping;
    assert.ok(f.logs.some(line => /stopping: the turn in progress ended after \d+ seconds/.test(line)), f.logs.join('\n'));
    ws.close();
  } finally { await f.cleanup(); }
});
