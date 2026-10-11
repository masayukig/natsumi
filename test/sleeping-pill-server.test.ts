import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import WebSocket from 'ws';
import { login, OWNER, startFixture, type Fixture } from './support/server-fixture.ts';

// The sleeping pill in the client contract (ADR 0077): sleep.status shows the judgement, sleep.take gives the pill.

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

function sessionFile(f: Fixture) {
  const db = new DatabaseSync(join(f.data, '.natsumi', 'state.sqlite'), { readOnly: true });
  try { return (db.prepare('SELECT pi_session_file FROM conversations').get() as { pi_session_file: string }).pi_session_file; } finally { db.close(); }
}

test('sleep.status shows the judgement, and sleep.take gives the pill, which a second one joins; both need a sync first', async () => {
  const f = await startFixture();
  try {
    const c = await client(f);
    for (const type of ['sleep.status', 'sleep.take']) {
      assert.deepEqual([(await c.request(type)).payload.code], ['sync-required'], `${type} needs a sync first`);
    }
    await c.sync();

    const empty = await c.request('sleep.status');
    assert.equal(empty.type, 'command.accepted');
    assert.deepEqual(Object.keys(empty.payload.sleep).sort(), ['done', 'inProgress', 'kind', 'lastFailure', 'night']);
    assert.equal(empty.payload.sleep.kind, 'none', 'nothing has been said yet');

    // natsumi answers, and the last night left no review: a pill sleeps deep. The review then waits on the model.
    f.model.auto = context => context.messages.at(-1)?.role === 'user' && !JSON.stringify(context.messages.at(-1)).includes('nightly_review')
      ? { calls: [{ name: 'reply_to_mac', arguments: { text: 'はい', expression: 'neutral' } }] } : {};
    await c.request('conversation.send', { text: '架空の話' });
    await c.until(message => message.type === 'conversation.event.completed');
    assert.equal((await c.request('sleep.status')).payload.sleep.kind, 'deep');
    f.model.takeOver();

    const taken = await c.request('sleep.take');
    assert.equal(taken.type, 'command.accepted');
    assert.deepEqual(Object.keys(taken.payload).sort(), ['eventId', 'joined', 'kind']);
    assert.equal(taken.payload.kind, 'deep');
    assert.equal(taken.payload.joined, false);
    await c.until(message => message.type === 'avatar.expression' && message.payload.expression === 'sleepy');
    const again = await c.request('sleep.take');
    assert.deepEqual(again.payload, { eventId: taken.payload.eventId, kind: 'deep', joined: true }, 'a second pill joins the first');
    const status = await c.request('sleep.status');
    assert.deepEqual([status.payload.sleep.inProgress.kind, status.payload.sleep.inProgress.state], ['deep', 'running']);
    c.close();
  } finally { await f.cleanup(); }
});

test('while natsumi cannot talk, sleep.status and sleep.take are answered service.unavailable', async () => {
  const f = await startFixture();
  try {
    const c = await client(f);
    await c.sync();
    f.model.auto = () => ({ calls: [{ name: 'reply_to_mac', arguments: { text: 'はい', expression: 'neutral' } }] });
    await c.request('conversation.send', { text: '架空の話' });
    await c.until(message => message.type === 'conversation.event.completed');
    c.close();
    await rm(join(f.root, 'pi', 'sessions', sessionFile(f)));
    await f.restart(OWNER.id);

    const again = await client(f);
    assert.equal((await again.sync()).type, 'service.unavailable');
    for (const type of ['sleep.status', 'sleep.take']) {
      const refused = await again.request(type);
      assert.deepEqual([refused.type, refused.payload.code], ['service.unavailable', 'conversation-restore-failed']);
    }
    again.close();
  } finally { await f.cleanup(); }
});
