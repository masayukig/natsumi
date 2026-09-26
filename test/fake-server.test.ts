import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { startFakeServer, type FakeServerOptions } from '../src/fake-server/main.ts';

type Envelope = { seq: number; type: string; requestId?: string; payload: Record<string, any> };

/** A connection to the fake server that keeps everything it is sent, to wait on. */
async function connect(port: number) {
  const ws = new WebSocket(`ws://localhost:${port}/v1/ws`);
  const received: Envelope[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', data => {
    received.push(JSON.parse(String(data)));
    for (const wake of waiters.splice(0)) wake();
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let requests = 0;
  return {
    received,
    send(type: string, payload: Record<string, unknown>) {
      const requestId = `r${++requests}`;
      ws.send(JSON.stringify({ v: 1, requestId, type, payload }));
      return requestId;
    },
    /** The first envelope, from `from` on, that matches. */
    async next(match: (e: Envelope) => boolean, from = 0): Promise<Envelope> {
      for (;;) {
        const found = received.slice(from).find(match);
        if (found) return found;
        await new Promise<void>(wake => waiters.push(wake));
      }
    },
    close: () => ws.close(),
  };
}

async function withServer(fn: (port: number) => Promise<void>, options: Partial<FakeServerOptions> = {}) {
  const server = await startFakeServer({
    port: 0, replyDelayMs: 0, short: true, approvalDelayMs: 0, sendDelayMs: 0, switchDelayMs: 0, log: false, ...options,
  });
  try { await fn(server.port); } finally { await server.close(); }
}

async function synced(port: number) {
  const client = await connect(port);
  const sync = client.send('session.sync', { resume: null });
  const snapshot = await client.next(e => e.requestId === sync);
  return { client, snapshot };
}

test('the snapshot carries the approvals waiting at the start', () => withServer(async port => {
  const { client, snapshot } = await synced(port);
  assert.equal(snapshot.type, 'session.snapshot');
  const approvals = snapshot.payload.pendingApprovals;
  assert.deepEqual(approvals.map((a: any) => a.approvalId), ['approval-review', 'approval-lunch']);
  const [review, lunch] = approvals;
  assert.equal(review.kind, 'slack-post');
  assert.equal(review.revision, 1);
  assert.deepEqual(review.target.replyTo, { speaker: '山田', at: '2026-09-25 14:32:05', text: '明日のレビュー、何時からなら大丈夫そう？' });
  assert.equal(review.reason.verdict, 'rewrite-limit');
  assert.equal(review.reason.issues[0].flagged, true);
  assert.equal('flagged' in review.reason.issues[1], false);
  assert.equal(review.history.length, 2);
  // A post to the channel itself has no line to answer, no verdict and no odds.
  assert.equal(lunch.target.replyTo, undefined);
  assert.equal(lunch.target.placement, 'channel');
  assert.equal(lunch.reason.verdict, 'no-verdict');
  assert.equal(lunch.reason.placement, undefined);
  client.close();
}));

test('approving is accepted, and approval.resolved says it was sent with the draft', () => withServer(async port => {
  const { client } = await synced(port);
  const request = client.send('approval.decide', { approvalId: 'approval-review', revision: 1, decision: 'approve', placement: 'channel' });
  const accepted = await client.next(e => e.requestId === request);
  assert.equal(accepted.type, 'command.accepted');
  assert.deepEqual(accepted.payload, { approvalId: 'approval-review', revision: 1, state: 'approved' });
  const resolved = await client.next(e => e.type === 'approval.resolved');
  assert.equal(resolved.payload.state, 'approved');
  assert.equal(resolved.payload.delivery, 'sent');
  assert.equal(resolved.payload.sentText, '明日は 10 時からなら大丈夫です。資料は今日中に共有しておきますね。');
  assert.equal(typeof resolved.payload.resolvedAt, 'string');

  // It is no longer waiting.
  const sync = client.send('session.sync', { resume: null });
  const snapshot = await client.next(e => e.requestId === sync);
  assert.deepEqual(snapshot.payload.pendingApprovals.map((a: any) => a.approvalId), ['approval-lunch']);
  client.close();
}));

test('an edit sends the owner\'s text, and a rejection closes without delivery', () => withServer(async port => {
  const { client } = await synced(port);
  client.send('approval.decide', { approvalId: 'approval-review', revision: 1, decision: 'edit', text: '10 時からでお願いします。' });
  const edited = await client.next(e => e.type === 'approval.resolved');
  assert.equal(edited.payload.state, 'edited');
  assert.equal(edited.payload.sentText, '10 時からでお願いします。');

  const from = client.received.length;
  client.send('approval.decide', { approvalId: 'approval-lunch', revision: 1, decision: 'reject' });
  const rejected = await client.next(e => e.type === 'approval.resolved', from);
  assert.equal(rejected.payload.state, 'rejected');
  assert.equal('delivery' in rejected.payload, false);
  assert.equal('sentText' in rejected.payload, false);
  client.close();
}));

test('a second decision is answered with the first one\'s state and changes nothing', () => withServer(async port => {
  const { client } = await synced(port);
  client.send('approval.decide', { approvalId: 'approval-lunch', revision: 1, decision: 'reject' });
  await client.next(e => e.type === 'approval.resolved');
  const from = client.received.length;
  const again = client.send('approval.decide', { approvalId: 'approval-lunch', revision: 1, decision: 'approve' });
  const answer = await client.next(e => e.requestId === again);
  assert.equal(answer.type, 'command.accepted');
  assert.equal(answer.payload.state, 'rejected');
  // Nothing more is resolved for it.
  const sync = client.send('session.sync', { resume: null });
  await client.next(e => e.requestId === sync, from);
  assert.equal(client.received.slice(from).some(e => e.type === 'approval.resolved'), false);
  client.close();
}));

test('a decision for another revision is stale, and malformed ones are invalid', () => withServer(async port => {
  const { client } = await synced(port);
  const code = async (payload: Record<string, unknown>) => {
    const request = client.send('approval.decide', payload);
    const answer = await client.next(e => e.requestId === request);
    assert.equal(answer.type, 'command.rejected');
    return answer.payload.code;
  };
  assert.equal(await code({ approvalId: 'approval-review', revision: 2, decision: 'approve' }), 'stale-revision');
  assert.equal(await code({ approvalId: 'approval-unknown', revision: 1, decision: 'approve' }), 'invalid-request');
  assert.equal(await code({ approvalId: 'approval-review', revision: 1, decision: 'maybe' }), 'invalid-request');
  assert.equal(await code({ approvalId: 'approval-review', revision: 1, decision: 'edit', text: '  ' }), 'invalid-request');
  // Still waiting after all of that.
  const sync = client.send('session.sync', { resume: null });
  const snapshot = await client.next(e => e.requestId === sync);
  assert.equal(snapshot.payload.pendingApprovals.length, 2);
  client.close();
}));

test('one more approval arrives after the first sync', () => withServer(async port => {
  const { client } = await synced(port);
  const pending = await client.next(e => e.type === 'approval.pending');
  assert.equal(pending.payload.approvalId, 'approval-dm');
  assert.equal(pending.payload.target.channel, 'work/@佐藤');
  const sync = client.send('session.sync', { resume: null });
  const snapshot = await client.next(e => e.requestId === sync);
  assert.deepEqual(snapshot.payload.pendingApprovals.map((a: any) => a.approvalId), ['approval-review', 'approval-lunch', 'approval-dm']);
  client.close();
}, { approvalDelayMs: 10 }));

test('logging out puts the approvals back as they were at the start', () => withServer(async port => {
  const { client } = await synced(port);
  client.send('approval.decide', { approvalId: 'approval-lunch', revision: 1, decision: 'reject' });
  await client.next(e => e.type === 'approval.resolved');
  const logout = await fetch(`http://localhost:${port}/auth/logout`, { method: 'POST' });
  assert.equal(logout.status, 204);
  const sync = client.send('session.sync', { resume: null });
  const snapshot = await client.next(e => e.requestId === sync);
  assert.deepEqual(snapshot.payload.pendingApprovals.map((a: any) => a.approvalId), ['approval-review', 'approval-lunch']);
  client.close();
}));

// docs/client-contract.md (ADR 0044): an approval with images, and each image fetched with the session.
test('the post to a channel carries two images, each fetched with the token and refused without it', () => withServer(async port => {
  const { client, snapshot } = await synced(port);
  const lunch = snapshot.payload.pendingApprovals.find((a: any) => a.approvalId === 'approval-lunch');
  assert.equal(lunch.images.length, 2);
  assert.equal(snapshot.payload.pendingApprovals.find((a: any) => a.approvalId === 'approval-review').images, undefined);
  for (const image of lunch.images) {
    assert.deepEqual(Object.keys(image).sort(), ['bytes', 'imageId', 'mimeType']);
    const path = `http://localhost:${port}/v1/images/${image.imageId}`;
    const fetched = await fetch(path, { headers: { authorization: 'Bearer fake-token' } });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get('content-type'), image.mimeType);
    const body = Buffer.from(await fetched.arrayBuffer());
    assert.equal(body.length, image.bytes);
    assert.deepEqual([...body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal((await fetch(path)).status, 401);
  }
  const unknown = await fetch(`http://localhost:${port}/v1/images/image-none`, { headers: { authorization: 'Bearer fake-token' } });
  assert.equal(unknown.status, 404);
  client.close();
}));

// docs/client-contract.md (ADR 0045): a reply with images in the conversation, fetched the same way.
test('the conversation holds a reply with images, and a message asking for a picture is answered with one', () => withServer(async port => {
  const { client, snapshot } = await synced(port);
  const withImages = snapshot.payload.messages.filter((m: any) => m.images !== undefined);
  assert.equal(withImages.length, 1);
  assert.equal(withImages[0].kind, 'reply');
  assert.equal(withImages[0].images.length, 2);
  // Every other line has no field at all.
  assert.ok(snapshot.payload.messages.filter((m: any) => m !== withImages[0]).every((m: any) => !('images' in m)));
  for (const image of withImages[0].images) {
    assert.deepEqual(Object.keys(image).sort(), ['bytes', 'height', 'imageId', 'mimeType', 'width']);
    const fetched = await fetch(`http://localhost:${port}/v1/images/${image.imageId}`, { headers: { authorization: 'Bearer fake-token' } });
    assert.equal(fetched.status, 200);
    assert.equal(Buffer.from(await fetched.arrayBuffer()).length, image.bytes);
  }

  const from = client.received.length;
  client.send('conversation.send', { text: '絵を見せて' });
  const reply = await client.next(e => e.type === 'conversation.message' && e.payload.kind === 'reply', from);
  assert.equal(reply.payload.images.length, 1);
  client.send('conversation.send', { text: 'ありがとう' });
  const plain = await client.next(e => e.type === 'conversation.message' && e.payload.kind === 'reply' && e.payload.text.includes('ありがとう'), from);
  assert.equal('images' in plain.payload, false);
  client.close();
}));

// docs/client-contract.md「モデルの経路」(ADR 0046): the routes in the snapshot, model.list and model.use.
test('the snapshot and model.list carry the routes, one of them not ready', () => withServer(async port => {
  const { client, snapshot } = await synced(port);
  const routes = snapshot.payload.modelRoutes;
  assert.equal(routes.defaultRoute, 'local');
  assert.equal(routes.current, 'local');
  assert.equal(routes.chosen, 'local');
  assert.deepEqual(routes.routes.map((r: any) => [r.name, r.ready]), [['local', true], ['plus', true], ['spare', false]]);
  for (const route of routes.routes) assert.deepEqual(Object.keys(route).sort(), ['model', 'name', 'provider', 'ready']);
  const list = client.send('model.list', {});
  const answer = await client.next(e => e.requestId === list);
  assert.equal(answer.type, 'command.accepted');
  assert.deepEqual(answer.payload, routes);
  client.close();
}));

test('model.use is accepted with the route before the old one, and model.routes follows when it moves', () => withServer(async port => {
  const { client } = await synced(port);
  const from = client.received.length;
  const use = client.send('model.use', { route: 'plus' });
  const accepted = await client.next(e => e.requestId === use, from);
  assert.equal(accepted.type, 'command.accepted');
  assert.deepEqual(accepted.payload, { chosen: 'plus', current: 'local' });
  const moved = await client.next(e => e.type === 'model.routes', from);
  assert.equal(moved.payload.current, 'plus');
  assert.equal(moved.payload.chosen, 'plus');
  assert.ok(moved.seq > accepted.seq);

  // The choice stays for the next sync, and choosing the route in use again changes nothing.
  const sync = client.send('session.sync', { resume: null });
  const snapshot = await client.next(e => e.requestId === sync);
  assert.equal(snapshot.payload.modelRoutes.current, 'plus');
  const after = client.received.length;
  const again = client.send('model.use', { route: 'plus' });
  assert.deepEqual((await client.next(e => e.requestId === again, after)).payload, { chosen: 'plus', current: 'plus' });
  const list = client.send('model.list', {});
  await client.next(e => e.requestId === list, after);
  assert.equal(client.received.slice(after).some(e => e.type === 'model.routes'), false);
  client.close();
}));

test('model.use refuses a route not in the list, one not ready, and a route that is not a name', () => withServer(async port => {
  const { client } = await synced(port);
  for (const [payload, code] of [
    [{ route: 'nowhere' }, 'unknown-route'], [{ route: 'spare' }, 'route-unavailable'], [{ route: '' }, 'invalid-request'],
    [{ route: 3 }, 'invalid-request'], [{}, 'invalid-request'],
  ] as const) {
    const request = client.send('model.use', payload);
    const answer = await client.next(e => e.requestId === request);
    assert.equal(answer.type, 'command.rejected', JSON.stringify(payload));
    assert.equal(answer.payload.code, code, JSON.stringify(payload));
  }
  client.close();
}));

test('logging out puts the routes back to the default', () => withServer(async port => {
  const { client } = await synced(port);
  client.send('model.use', { route: 'plus' });
  await client.next(e => e.type === 'model.routes');
  await fetch(`http://localhost:${port}/auth/logout`, { method: 'POST' });
  const sync = client.send('session.sync', { resume: null });
  const snapshot = await client.next(e => e.requestId === sync);
  assert.equal(snapshot.payload.modelRoutes.current, 'local');
  assert.equal(snapshot.payload.modelRoutes.chosen, 'local');
  client.close();
}));
