import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { ConfigError } from '../src/server/config.ts';
import { STATE_DIRECTORY } from '../src/server/data-directory.ts';
import { login, startFixture, type Fixture } from './support/server-fixture.ts';

// The model routes as the clients see them (ADR 0046): in the snapshot, by command, and as an event.

const ROUTES = {
  routes: { main: { model: { provider: 'openai-codex', id: 'gpt-5.6-sol' } }, spare: { model: { provider: 'openai-codex', id: 'gpt-6-sol' } } },
  defaultRoute: 'main',
};

interface Envelope { type: string; requestId?: string; payload: Record<string, any> }

async function client(f: Fixture) {
  const { token } = await login(f);
  const ws = new WebSocket(f.wsUrl, { headers: { authorization: `Bearer ${token}` } });
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
    messages, until, request,
    async sync() { const reply = await request('session.sync', { resume: null }); deviceId = reply.payload.deviceId; return reply; },
    close: () => ws.close(),
  };
}

test('the snapshot carries the routes; model.list reads them and model.use chooses one, which every device hears of', async () => {
  const f = await startFixture({ pi: ROUTES });
  try {
    const c = await client(f);
    assert.equal((await c.request('model.list')).type, 'command.rejected', 'a device command needs a sync first');
    const snapshot = await c.sync();
    assert.equal(snapshot.type, 'session.snapshot');
    const routes = {
      defaultRoute: 'main', current: 'main', chosen: 'main',
      routes: [{ name: 'main', provider: 'openai-codex', model: 'gpt-5.6-sol', ready: true },
        { name: 'spare', provider: 'openai-codex', model: 'gpt-6-sol', ready: true }],
    };
    assert.deepEqual(snapshot.payload.modelRoutes, routes);
    const listed = await c.request('model.list');
    assert.equal(listed.type, 'command.accepted');
    assert.deepEqual(listed.payload, routes);

    const used = await c.request('model.use', { route: 'spare' });
    assert.equal(used.type, 'command.accepted');
    assert.equal(used.payload.chosen, 'spare');
    const told = await c.until(message => message.type === 'model.routes' && message.payload.current === 'spare');
    assert.deepEqual(told.payload, { ...routes, current: 'spare', chosen: 'spare' });
    // The command line reads what the server wrote.
    const written = JSON.parse(await readFile(join(f.data, STATE_DIRECTORY, 'model-routes.json'), 'utf8'));
    assert.equal(written.current, 'spare');

    for (const [payload, code] of [[{ route: 'nowhere' }, 'unknown-route'], [{}, 'invalid-request'], [{ route: 42 }, 'invalid-request']] as const) {
      const refused = await c.request('model.use', payload);
      assert.deepEqual([refused.type, refused.payload.code], ['command.rejected', code]);
    }
    c.close();
  } finally { await f.cleanup(); }
});

test('a choice made with the command line reaches the running server without a turn', async () => {
  const f = await startFixture({ pi: ROUTES });
  try {
    const c = await client(f);
    await c.sync();
    const { writeRouteChoice } = await import('../src/server/model-routes.ts');
    await writeRouteChoice(f.data, 'spare', Date.now());
    await f.server.refreshRoutes();
    const told = await c.until(message => message.type === 'model.routes');
    assert.equal(told.payload.current, 'spare');
    c.close();
  } finally { await f.cleanup(); }
});

test('a subscription route whose threshold its model\'s window cannot hold stops startup', async () => {
  await assert.rejects(startFixture({ pi: { routes: { main: { model: { provider: 'openai-codex', id: 'gpt-5.6-sol' }, compactionThreshold: 240_000 } },
    defaultRoute: 'main' } }), (error: unknown) => {
    assert.ok(error instanceof ConfigError, String(error));
    assert.equal(error.path, 'pi.routes.main.compactionThreshold');
    assert.match(error.message, /openai-codex\/gpt-5\.6-sol/);
    return true;
  });
});
