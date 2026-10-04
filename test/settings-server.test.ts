import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { STATE_DIRECTORY } from '../src/server/data-directory.ts';
import { RUNTIME_SETTINGS_FILE } from '../src/server/settings/store.ts';
import { login, startFixture, type Fixture, type FixtureOptions } from './support/server-fixture.ts';

// The runtime settings over the WebSocket (ADR 0058): in the snapshot, by command, and as an event to every device.

const ROUTES = {
  routes: { main: { model: { provider: 'openai-codex', id: 'gpt-5.5' } }, spare: { model: { provider: 'openai-codex', id: 'gpt-5.6-sol' } } },
  defaultRoute: 'main',
};

const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });

interface Envelope { type: string; requestId?: string; payload: Record<string, any> }

async function client(f: Fixture, token?: string) {
  const bearer = token ?? (await login(f)).token;
  const ws = new WebSocket(f.wsUrl, { headers: { authorization: `Bearer ${bearer}` } });
  const messages: Envelope[] = [];
  ws.on('message', data => { messages.push(JSON.parse(String(data)) as Envelope); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let counter = 0;
  let deviceId: string | undefined;
  const until = async (predicate: (message: Envelope) => boolean, timeout = 5_000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out; received ${messages.map(m => m.type).join(', ')}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  const request = async (type: string, payload: Record<string, unknown> = {}) => {
    const requestId = `request-${++counter}`;
    ws.send(JSON.stringify({ v: 1, requestId, deviceId, type, payload }));
    return until(message => message.requestId === requestId);
  };
  return {
    messages, until, request, token: bearer,
    async sync() { const reply = await request('session.sync', { resume: null }); deviceId = reply.payload.deviceId; return reply; },
    close: () => ws.close(),
  };
}

async function withFixture(fn: (f: Fixture) => Promise<void>, options: FixtureOptions = {}) {
  const f = await startFixture({ pi: ROUTES, ...options });
  try { await fn(f); } finally { await f.cleanup(); }
}

const CONFIG_LOOP = { eventModelCalls: 6, awakeHours: { start: '08:00', end: '22:00' }, pingIntervalMinutes: 60, timeZone: 'Asia/Tokyo' };

test('the snapshot and settings.list carry every setting with the config’s value beside it', () => withFixture(async f => {
  const c = await client(f);
  assert.deepEqual([(await c.request('settings.list')).type, (await c.request('settings.list')).payload.code], ['command.rejected', 'sync-required']);
  const snapshot = await c.sync();
  const settings = snapshot.payload.settings;
  assert.deepEqual(settings.modelRoute, { value: 'main', config: 'main', overridden: false, inUse: 'main', routes: [
    { name: 'main', provider: 'openai-codex', model: 'gpt-5.5', ready: true },
    { name: 'spare', provider: 'openai-codex', model: 'gpt-5.6-sol', ready: true }] });
  assert.deepEqual(settings.turnFold, { value: 'off', config: 'off', overridden: false, inUse: 'off' });
  assert.deepEqual(settings.eventModelCalls, { value: 6, config: 6, overridden: false });
  assert.deepEqual(settings.reviewModelCalls, { value: 40, config: 40, overridden: false });
  assert.deepEqual(settings.awakeHours, { value: { start: '08:00', end: '22:00' }, config: { start: '08:00', end: '22:00' },
    overridden: false, timeZone: 'Asia/Tokyo' });
  assert.deepEqual(settings.pingIntervalMinutes, { value: 60, config: 60, overridden: false });
  const listed = await c.request('settings.list');
  assert.equal(listed.type, 'command.accepted');
  assert.deepEqual(listed.payload.settings, settings);
  // The routes are still told as before, for the apps that read them.
  assert.equal(snapshot.payload.modelRoutes.current, 'main');
  c.close();
}, { loop: CONFIG_LOOP }));

test('the curator\'s route is listed with the config\'s, where the next night runs and which routes are outside services (ADR 0068)', () => withFixture(async f => {
  const c = await client(f);
  const settings = (await c.sync()).payload.settings;
  assert.deepEqual(settings.curatorRoute, { value: 'spare', config: 'spare', overridden: false, night: 'spare', outside: ['main', 'spare'] });
  assert.deepEqual(settings.curatorModelCalls, { value: 60, config: 60, overridden: false });
  assert.deepEqual(settings.curatorTimeoutMinutes, { value: 20, config: 20, overridden: false });
  assert.equal((await c.request('settings.set', { key: 'curatorRoute', value: 'nowhere' })).payload.code, 'unknown-route');
  const set = await c.request('settings.set', { key: 'curatorRoute', value: null });
  assert.equal(set.type, 'command.accepted');
  assert.deepEqual(set.payload.settings.curatorRoute, { value: null, config: 'spare', overridden: true, night: 'main', outside: ['main', 'spare'] });
  const file = JSON.parse(await readFile(join(f.data, STATE_DIRECTORY, RUNTIME_SETTINGS_FILE), 'utf8'));
  assert.deepEqual(file.overrides, { curatorRoute: null });
  c.close();
}, { curator: { route: 'spare', timeoutMinutes: 20 } }));

test('settings.set writes an override that every device hears of, and settings.reset takes it back', () => withFixture(async f => {
  const a = await client(f);
  const b = await client(f);
  await a.sync();
  await b.sync();
  const set = await a.request('settings.set', { key: 'eventModelCalls', value: 12 });
  assert.equal(set.type, 'command.accepted');
  assert.deepEqual(set.payload.settings.eventModelCalls, { value: 12, config: 6, overridden: true });
  const told = await b.until(message => message.type === 'settings.changed');
  assert.deepEqual(told.payload.settings.eventModelCalls, { value: 12, config: 6, overridden: true });
  const written = JSON.parse(await readFile(join(f.data, STATE_DIRECTORY, RUNTIME_SETTINGS_FILE), 'utf8'));
  assert.deepEqual(written.overrides, { eventModelCalls: 12 });

  const reset = await b.request('settings.reset', { key: 'eventModelCalls' });
  assert.equal(reset.type, 'command.accepted');
  assert.deepEqual(reset.payload.settings.eventModelCalls, { value: 6, config: 6, overridden: false });
  await a.until(message => message.type === 'settings.changed' && message.payload.settings.eventModelCalls.overridden === false);
  a.close();
  b.close();
}, { loop: CONFIG_LOOP }));

test('what the settings refuse is answered with a code, and nothing changes', () => withFixture(async f => {
  const c = await client(f);
  await c.sync();
  const cases: [string, Record<string, unknown>, string][] = [
    ['settings.set', { key: 'eventModelCalls', value: 0 }, 'invalid-value'],
    ['settings.set', { key: 'pingIntervalMinutes', value: 1 }, 'invalid-value'],
    ['settings.set', { key: 'awakeHours', value: { start: '09:00', end: '09:00' } }, 'invalid-value'],
    ['settings.set', { key: 'compactionThreshold', value: 1 }, 'unknown-setting'],
    ['settings.set', { key: 'modelRoute', value: 'nowhere' }, 'unknown-route'],
    ['settings.set', { key: 'eventModelCalls' }, 'invalid-request'],
    ['settings.set', { value: 3 }, 'invalid-request'],
    ['settings.set', { key: 7, value: 3 }, 'invalid-request'],
    ['settings.reset', { key: 'listen' }, 'unknown-setting'],
    ['settings.reset', {}, 'invalid-request'],
  ];
  for (const [type, payload, code] of cases) {
    const answer = await c.request(type, payload);
    assert.deepEqual([answer.type, answer.payload.code], ['command.rejected', code], `${type} ${JSON.stringify(payload)}`);
  }
  assert.equal(c.messages.some(message => message.type === 'settings.changed'), false);
  c.close();
}));

test('the route set through the settings moves between turns, as model.use does, and the devices hear of both', () => withFixture(async f => {
  const c = await client(f);
  await c.sync();
  const set = await c.request('settings.set', { key: 'modelRoute', value: 'spare' });
  assert.equal(set.type, 'command.accepted');
  assert.equal(set.payload.settings.modelRoute.value, 'spare');
  assert.equal(set.payload.settings.modelRoute.overridden, true);
  await c.until(message => message.type === 'model.routes' && message.payload.current === 'spare');
  await c.until(message => message.type === 'settings.changed' && message.payload.settings.modelRoute.inUse === 'spare');
  const reset = await c.request('settings.reset', { key: 'modelRoute' });
  assert.equal(reset.type, 'command.accepted');
  await c.until(message => message.type === 'model.routes' && message.payload.current === 'main');
  await c.until(message => message.type === 'settings.changed' && message.payload.settings.modelRoute.inUse === 'main'
    && message.payload.settings.modelRoute.overridden === false);
  c.close();
}));

test('a limit set from a device is the next turn’s limit', () => withFixture(async f => {
  const c = await client(f);
  await c.sync();
  assert.equal((await c.request('settings.set', { key: 'eventModelCalls', value: 2 })).type, 'command.accepted');
  f.model.auto = () => ({ calls: [call('set_mac_avatar_expression', { expression: 'thinking' })] });
  const sent = await c.request('conversation.send', { text: '止まらない場面' });
  assert.equal(sent.type, 'command.accepted');
  const done = await c.until(message => message.type === 'conversation.event.completed' && message.payload.eventId === sent.payload.eventId);
  assert.equal(done.payload.reason, 'model-call-limit');
  assert.equal(f.model.calls, 2);
  c.close();
}, { loop: CONFIG_LOOP }));

test('with no overrides the server does as before: the config’s limit stops a turn', () => withFixture(async f => {
  const c = await client(f);
  await c.sync();
  f.model.auto = () => ({ calls: [call('set_mac_avatar_expression', { expression: 'thinking' })] });
  const sent = await c.request('conversation.send', { text: '止まらない場面' });
  const done = await c.until(message => message.type === 'conversation.event.completed' && message.payload.eventId === sent.payload.eventId);
  assert.equal(done.payload.reason, 'model-call-limit');
  assert.equal(f.model.calls, 6);
  c.close();
}, { loop: CONFIG_LOOP }));

test('a data directory with the route and the fold chosen before starts on them, and shows them as overrides', () => withFixture(async f => {
  const c = await client(f);
  const snapshot = await c.sync();
  assert.equal(snapshot.payload.modelRoutes.current, 'spare');
  assert.deepEqual(
    [snapshot.payload.settings.modelRoute.value, snapshot.payload.settings.modelRoute.inUse, snapshot.payload.settings.modelRoute.overridden],
    ['spare', 'spare', true]);
  assert.deepEqual(snapshot.payload.settings.turnFold, { value: 'on', config: 'off', overridden: true, inUse: 'on' });
  assert.equal(snapshot.payload.settings.eventModelCalls.overridden, false);
  c.close();
}, {
  prepare: async data => {
    await mkdir(join(data, STATE_DIRECTORY), { recursive: true, mode: 0o700 });
    await writeFile(join(data, STATE_DIRECTORY, 'model-route.json'), `${JSON.stringify({ route: 'spare', chosenAt: '2026-09-27T01:00:00.000Z' })}\n`);
    await writeFile(join(data, STATE_DIRECTORY, 'turn-fold.json'), `${JSON.stringify({ fold: 'on', chosenAt: '2026-09-27T01:00:00.000Z' })}\n`);
  },
}));

test('a fold chosen on the command line while the server runs is found with the heartbeat and told to the devices', () => withFixture(async f => {
  const c = await client(f);
  await c.sync();
  await writeFile(join(f.data, STATE_DIRECTORY, 'turn-fold.json'), JSON.stringify({ fold: 'on' }));
  await f.server.refreshSettings();
  const told = await c.until(message => message.type === 'settings.changed');
  assert.deepEqual([told.payload.settings.turnFold.value, told.payload.settings.turnFold.overridden], ['on', true]);
  c.close();
}));
