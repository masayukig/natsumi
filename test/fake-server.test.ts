import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { FAKE_SESSION_COOKIE, startFakeServer, type FakeServerOptions } from '../src/fake-server/main.ts';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Envelope = { seq: number; type: string; requestId?: string; payload: Record<string, any> };

/** A connection to the fake server that keeps everything it is sent, to wait on. */
async function connect(port: number, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://localhost:${port}/v1/ws`, { headers });
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
    /** Sends a command and waits for its answer. */
    async request(type: string, payload: Record<string, unknown>): Promise<Envelope> {
      const requestId = this.send(type, payload);
      return this.next(e => e.requestId === requestId);
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

/** A bundle for the page to load, as the browser's app would build it. */
async function fakeBundle() {
  const directory = await mkdtemp(join(tmpdir(), 'natsumi-fake-bundle-'));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'app.js'), 'console.log("fake bundle");\n');
  return directory;
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
  assert.deepEqual(Object.keys(review.reason.placement.probabilities), ['thread', 'channel', 'broadcast'], 'the odds of the three places (ADR 0062)');
  // A post to the channel itself has no line to answer, no verdict and no odds.
  assert.equal(lunch.target.replyTo, undefined);
  assert.equal(lunch.target.placement, 'channel');
  assert.equal(lunch.reason.verdict, 'no-verdict');
  assert.equal(lunch.reason.placement, undefined);
  client.close();
}));

test('approving is accepted, and approval.resolved says it was sent with the draft', () => withServer(async port => {
  const { client } = await synced(port);
  const request = client.send('approval.decide', { approvalId: 'approval-review', revision: 1, decision: 'approve', placement: 'broadcast' });
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
  assert.equal(await code({ approvalId: 'approval-review', revision: 1, decision: 'approve', placement: 'dm' }), 'invalid-request');
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
  // A broadcast, with the odds of before: two places, not three (ADR 0062).
  assert.equal(pending.payload.target.placement, 'broadcast');
  assert.deepEqual(pending.payload.reason.placement, { probabilities: { thread: 0.45, broadcast: 0.55 } });
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
    assert.equal(fetched.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    const body = Buffer.from(await fetched.arrayBuffer());
    assert.equal(body.length, image.bytes);
    assert.deepEqual([...body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    const none = await fetch(path);
    assert.deepEqual([none.status, none.headers.get('cache-control')], [401, 'no-store']);
  }
  const unknown = await fetch(`http://localhost:${port}/v1/images/image-none`, { headers: { authorization: 'Bearer fake-token' } });
  assert.deepEqual([unknown.status, unknown.headers.get('cache-control')], [404, 'no-store']);
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

// ADR 0057: the avatar the apps fetch without a login, and its version in the snapshot, as the server gives them.
test('the fake server hands out natsumi\'s avatar and its version, as the server does', () => withServer(async port => {
  const { client, snapshot } = await synced(port);
  client.close();
  const manifest = await (await fetch(`http://localhost:${port}/v1/avatar`)).json() as
    { version: string; id: string; name: string; files: { path: string; bytes: number }[] };
  assert.equal(snapshot.payload.avatarVersion, manifest.version);
  assert.equal(manifest.id, 'natsumi');
  assert.equal(manifest.name, 'なつみ');
  for (const file of manifest.files) {
    const res = await fetch(`http://localhost:${port}/v1/avatar/${manifest.version}/${file.path}`);
    assert.equal(res.status, 200, file.path);
    assert.equal((await res.arrayBuffer()).byteLength, file.bytes, file.path);
  }
  assert.equal((await fetch(`http://localhost:${port}/v1/avatar/0123456789abcdef0123456789abcdef/pet.json`)).status, 404);
}));

// The browser's side (ADR 0058): the runtime settings, the cookie, and the page.

test('settings.list answers every setting; settings.set changes one, which every connection hears, and settings.reset takes it back', () => withServer(async port => {
  const { client, snapshot } = await synced(port);
  const other = await synced(port);
  assert.deepEqual(snapshot.payload.settings.eventModelCalls, { value: 8, config: 8, overridden: false });
  assert.equal(snapshot.payload.settings.modelRoute.inUse, 'local');
  assert.deepEqual(snapshot.payload.settings.awakeHours.timeZone, 'Asia/Tokyo');
  // The dove's judges (ADR 0059): logprobs on, Jev with no endpoint in the made-up config.
  assert.deepEqual(snapshot.payload.settings.judgeLogprobs, { value: 'on', config: 'on', overridden: false, available: true });
  assert.deepEqual(snapshot.payload.settings.judgeJev, { value: 'off', config: 'off', overridden: false, available: false });
  assert.deepEqual(snapshot.payload.settings.judgeAdopted, { value: 'logprobs', config: 'logprobs', overridden: false });
  assert.deepEqual(snapshot.payload.settings.judgeLogprobsThresholds, { value: { owner: 0.5, return: 0.9 }, config: { owner: 0.5, return: 0.9 }, overridden: false });
  assert.deepEqual(snapshot.payload.settings.judgeJevThresholds.config, { owner: 0.5, return: 0.9 });
  // The curator's route and limits (ADR 0068): on natsumi's route, `plus` an outside service.
  assert.deepEqual(snapshot.payload.settings.curatorRoute, { value: null, config: null, overridden: false, night: 'local', outside: ['plus'] });
  assert.deepEqual(snapshot.payload.settings.curatorModelCalls, { value: 60, config: 60, overridden: false });
  assert.equal((await client.request('settings.set', { key: 'curatorRoute', value: 'spare' })).payload.code, 'route-unavailable');
  const listed = await client.request('settings.list', {});
  assert.equal(listed.type, 'command.accepted');
  assert.deepEqual(listed.payload.settings, snapshot.payload.settings);

  const from = other.client.received.length;
  const set = await client.request('settings.set', { key: 'pingIntervalMinutes', value: false });
  assert.equal(set.type, 'command.accepted');
  assert.deepEqual(set.payload.settings.pingIntervalMinutes, { value: false, config: 180, overridden: true });
  const told = await other.client.next(e => e.type === 'settings.changed', from);
  assert.deepEqual(told.payload.settings.pingIntervalMinutes, { value: false, config: 180, overridden: true });

  const reset = await client.request('settings.reset', { key: 'pingIntervalMinutes' });
  assert.deepEqual(reset.payload.settings.pingIntervalMinutes, { value: 180, config: 180, overridden: false });
  client.close();
  other.client.close();
}));

test('settings.set refuses what the server refuses, and moves the route between turns as model.use does', () => withServer(async port => {
  const { client } = await synced(port);
  for (const [payload, code] of [
    [{ key: 'eventModelCalls', value: 0 }, 'invalid-value'], [{ key: 'awakeHours', value: { start: '9:00', end: '23:00' } }, 'invalid-value'],
    [{ key: 'compactionThreshold', value: 1 }, 'unknown-setting'], [{ key: 'modelRoute', value: 'spare' }, 'route-unavailable'],
    [{ key: 'modelRoute', value: 'nowhere' }, 'unknown-route'], [{ key: 'eventModelCalls' }, 'invalid-request'],
    [{ key: 'judgeJev', value: 'on' }, 'judge-unavailable'], [{ key: 'judgeAdopted', value: 'both' }, 'invalid-value'],
    [{ key: 'judgeJevThresholds', value: { owner: 0.9, return: 0.5 } }, 'invalid-value'],
  ] as const) {
    const answer = await client.request('settings.set', payload);
    assert.deepEqual([answer.type, answer.payload.code], ['command.rejected', code], JSON.stringify(payload));
  }
  const set = await client.request('settings.set', { key: 'modelRoute', value: 'plus' });
  assert.deepEqual([set.payload.settings.modelRoute.value, set.payload.settings.modelRoute.inUse], ['plus', 'local']);
  await client.next(e => e.type === 'model.routes' && e.payload.current === 'plus');
  await client.next(e => e.type === 'settings.changed' && e.payload.settings.modelRoute.inUse === 'plus');
  client.close();
}));

test('logging out puts the settings back to the config’s', () => withServer(async port => {
  const { client } = await synced(port);
  await client.request('settings.set', { key: 'turnFold', value: 'on' });
  client.close();
  await fetch(`http://localhost:${port}/auth/logout`, { method: 'POST' });
  const again = await synced(port);
  assert.equal(again.snapshot.payload.settings.turnFold.overridden, false);
  again.client.close();
}));

test('the browser logs in at the fake login, gets the page, and connects with its cookie from the server’s own origin', async () => withServer(async port => {
  const base = `http://localhost:${port}`;
  const start = await fetch(`${base}/settings`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  assert.equal(start.headers.get('location'), '/fake-login?to=%2Fsettings');
  const loggedIn = await fetch(`${base}${start.headers.get('location')}`, { redirect: 'manual' });
  assert.equal(loggedIn.status, 302);
  assert.equal(loggedIn.headers.get('location'), '/settings');
  const cookie = loggedIn.headers.getSetCookie()[0]!;
  assert.match(cookie, /^natsumi_session=fake-session; Path=\/; HttpOnly; SameSite=Strict$/);
  assert.equal(FAKE_SESSION_COOKIE, 'natsumi_session=fake-session');

  const page = await fetch(`${base}/`, { headers: { cookie: FAKE_SESSION_COOKIE } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', new RegExp(`connect-src 'self' ws://localhost:${port}`));
  assert.match(await page.text(), /<script type="module" src="\/app\/app\.js"><\/script>/);
  const js = await fetch(`${base}/app/app.js`);
  assert.equal(await js.text(), 'console.log("fake bundle");\n');

  const refused = await new Promise<number>(resolve => {
    const ws = new WebSocket(`ws://localhost:${port}/v1/ws`, { headers: { cookie: FAKE_SESSION_COOKIE, origin: 'https://elsewhere.example.test' } });
    ws.on('error', () => {});
    ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); res.resume(); ws.terminate(); });
    ws.once('open', () => { resolve(101); ws.close(); });
  });
  assert.equal(refused, 403);
  const browser = await connect(port, { cookie: FAKE_SESSION_COOKIE, origin: base });
  const sync = browser.send('session.sync', { resume: null });
  assert.equal((await browser.next(e => e.requestId === sync)).type, 'session.snapshot');
  const push = await browser.request('push.register', { token: 'ab', publicKey: 'x', environment: 'sandbox' });
  assert.deepEqual([push.type, push.payload.code], ['command.rejected', 'invalid-request']);
  const image = await fetch(`${base}/v1/images/image-fake-happy`, { headers: { cookie: FAKE_SESSION_COOKIE } });
  assert.equal(image.status, 200);
  browser.close();

  const out = await fetch(`${base}/dashboard/logout`, { method: 'POST', redirect: 'manual', headers: { cookie: FAKE_SESSION_COOKIE, origin: base } });
  assert.equal(out.status, 303);
  assert.match(out.headers.getSetCookie()[0]!, /^natsumi_session=; Path=\/; Max-Age=0/);
}, { bundleDirectory: await fakeBundle() }));
