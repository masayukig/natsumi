import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import WebSocket from 'ws';
import {
  approveAtGitHub, CLIENT_SECRET, login, MINUTE, OWNER, PUBLIC_ORIGIN, startFixture, UPSTREAM_DETAIL, type Fixture,
} from './support/server-fixture.ts';
import { dashboardCookie } from '../src/server/dashboard.ts';
import { TurnStats } from '../src/server/turn-stats.ts';
import { SessionRecord } from './support/session-record.ts';

const COOKIE = 'natsumi_dashboard';
const DAY = 24 * 60 * MINUTE;

async function withFixture(fn: (f: Fixture) => Promise<void>, options?: Parameters<typeof startFixture>[0]) {
  const f = await startFixture(options);
  try { await fn(f); } finally { await f.cleanup(); }
}

/** Nothing sensitive may reach a log line or a response. */
function assertNoLeaks(f: Fixture, extra: string[] = []) {
  const haystack = [...f.seen, ...f.logs].join('\n');
  for (const needle of [CLIENT_SECRET, UPSTREAM_DETAIL, ...f.stub.accessTokens, ...extra]) {
    assert.ok(!haystack.includes(needle), `leaked a secret value: ${needle.slice(0, 12)}…`);
  }
}

/** The dashboard cookie a response sets, with its attributes, or undefined when it sets none. */
function setCookie(headers: Headers): { value: string; attributes: Map<string, string> } | undefined {
  const line = headers.getSetCookie().find(cookie => cookie.startsWith(`${COOKIE}=`));
  if (!line) return undefined;
  const [pair, ...rest] = line.split(';').map(part => part.trim());
  const attributes = new Map(rest.map(part => {
    const [name, ...value] = part.split('=');
    return [name!.toLowerCase(), value.join('=')] as const;
  }));
  return { value: pair!.slice(COOKIE.length + 1), attributes };
}

const withCookie = (value: string, init: RequestInit = {}): RequestInit =>
  ({ ...init, headers: { ...(init.headers as Record<string, string> | undefined), cookie: `${COOKIE}=${value}` } });

/** `/dashboard` without a cookie goes to GitHub; returns the authorize URL. */
async function startBrowserLogin(f: Fixture, path = '/dashboard') {
  const res = await f.fetch(path);
  assert.equal(res.status, 302, res.text);
  const authorize = new URL(res.headers.get('location')!);
  assert.equal(`${authorize.origin}${authorize.pathname}`, f.stub.endpoints.authorizeUrl);
  return authorize;
}

/** The whole browser login; returns the cookie's value. */
async function browserLogin(f: Fixture) {
  const res = await f.fetch(await approveAtGitHub(f, await startBrowserLogin(f)));
  assert.equal(res.status, 200, res.text);
  const cookie = setCookie(res.headers);
  assert.ok(cookie?.value, 'the callback sets the dashboard cookie');
  return cookie.value;
}

function assertLoginAgain(res: Awaited<ReturnType<Fixture['fetch']>>, f: Fixture) {
  assert.equal(res.status, 302, 'without a live session the dashboard sends the browser to log in');
  assert.equal(new URL(res.headers.get('location')!).pathname, new URL(f.stub.endpoints.authorizeUrl).pathname);
  assert.ok(!res.text.includes('いまの状態'));
}

function connect(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => { ws.close(); resolve(101); });
    ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); res.resume(); ws.terminate(); });
    ws.once('error', reject);
  });
}

test('opening /dashboard without a cookie starts the GitHub login with state and PKCE, on the registered callback', () => withFixture(async f => {
  const q = (await startBrowserLogin(f)).searchParams;
  assert.equal(q.get('client_id'), 'Iv1.fixtureclient');
  assert.equal(q.get('redirect_uri'), `${PUBLIC_ORIGIN}/auth/github/callback`);
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.ok((q.get('state') ?? '').length >= 32);
  assert.ok(q.get('code_challenge'));
  // A page below /dashboard starts the same login; where it came back to is still /dashboard.
  await startBrowserLogin(f, '/dashboard/anything?next=https://attacker.example.test');
}));

test('the allowed account gets an HttpOnly, Secure, SameSite=Strict cookie on /dashboard that lasts thirty days', () => withFixture(async f => {
  const res = await f.fetch(await approveAtGitHub(f, await startBrowserLogin(f)));
  assert.equal(res.status, 200);
  const cookie = setCookie(res.headers)!;
  assert.ok(cookie.value.length >= 43);
  assert.equal(cookie.attributes.get('path'), '/dashboard');
  assert.ok(cookie.attributes.has('httponly'));
  assert.ok(cookie.attributes.has('secure'), 'the public origin is https, so the cookie is Secure');
  assert.equal(cookie.attributes.get('samesite'), 'Strict');
  assert.equal(cookie.attributes.get('max-age'), String(30 * DAY / 1000));
  assert.equal(Date.parse(cookie.attributes.get('expires')!), f.clock.now + 30 * DAY);
  assert.ok(!f.logs.join('\n').includes(cookie.value), 'the session token is never logged');
  assertNoLeaks(f);
}));

test('the callback answers with a page of its own that moves on to /dashboard, since a Strict cookie is not sent on the way back from GitHub', () => withFixture(async f => {
  const res = await f.fetch(await approveAtGitHub(f, await startBrowserLogin(f)));
  assert.equal(res.status, 200, 'not a redirect: the redirect would carry on the cross-site navigation, without the cookie');
  assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
  assert.match(res.text, /<meta http-equiv="refresh" content="0; url=\/dashboard">/);
  assert.match(res.text, /<a href="\/dashboard">/);
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
}));

test('with the cookie, /dashboard shows the page under a strict CSP and the usual headers', () => withFixture(async f => {
  const cookie = await browserLogin(f);
  const res = await f.fetch('/dashboard', withCookie(cookie));
  assert.equal(res.status, 200, res.text);
  assert.match(res.headers.get('content-type') ?? '', /^text\/html; charset=utf-8/);
  const csp = res.headers.get('content-security-policy') ?? '';
  for (const directive of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "frame-ancestors 'none'",
    "object-src 'none'", "base-uri 'none'", "form-action 'self'"]) {
    assert.ok(csp.split(';').map(part => part.trim()).includes(directive), `missing ${directive} in ${csp}`);
  }
  assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'));
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');

  // Nothing inline for the CSP to refuse: the script and the style sheet are files of their own.
  assert.match(res.text, /<script src="\/dashboard\/static\/dashboard\.js" defer><\/script>/);
  assert.match(res.text, /<link rel="stylesheet" href="\/dashboard\/static\/dashboard\.css">/);
  assert.equal(res.text.match(/<script/g)?.length, 1);
  assert.ok(!/<style|\sstyle=|\son[a-z]+=/i.test(res.text));
  assert.match(res.text, /<meta name="viewport" content="width=device-width, initial-scale=1">/);

  // The frame: the sections, of which only the graphs are still to come, and the logout.
  assert.match(res.text, /いまの状態/);
  assert.match(res.text, /統計<small>準備中/);
  for (const [label, href] of [['ターン', 'turns'], ['失敗と待ち', 'waits'], ['一行メモ', 'memos'], ['ポッポさん', 'dove'], ['端末', 'devices']]) {
    assert.match(res.text, new RegExp(`<a href="/dashboard/${href}">${label}</a>`));
  }
  assert.match(res.text, /<form method="post" action="\/dashboard\/logout">/);
  assert.match(res.text, /data-refresh="\/dashboard\/status"/);
}));

test('the state section shows the server, the route, the fold, the context, the turn and the queue', () => withFixture(async f => {
  const cookie = await browserLogin(f);
  const res = await f.fetch('/dashboard/status', withCookie(cookie));
  assert.equal(res.status, 200, res.text);
  assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
  assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  assert.ok(!res.text.includes('<html'), 'a fragment for the page to put in place, not a page');
  assert.match(res.text, /id="status"/);
  assert.match(res.text, /動いている/, 'the heartbeat in status.json is fresh');
  assert.match(res.text, /default/, 'the route in use');
  assert.match(res.text, /gpt-5\.5/);
  assert.match(res.text, /畳み込み[\s\S]*off/);
  assert.match(res.text, /60,?000/, 'the compaction threshold');
  assert.match(res.text, /実行中のターン[\s\S]*なし/);
  assert.match(res.text, /キュー[\s\S]*0/);
}));

test('a use of the dashboard renews the session and its cookie, like the app’s (ADR 0030)', () => withFixture(async f => {
  const cookie = await browserLogin(f);
  for (let i = 0; i < 3; i++) {
    f.clock.advance(20 * DAY);
    const res = await f.fetch('/dashboard/status', withCookie(cookie));
    assert.equal(res.status, 200, `still in use after ${(i + 1) * 20} days`);
    const renewed = setCookie(res.headers)!;
    assert.equal(renewed.value, cookie);
    assert.equal(Date.parse(renewed.attributes.get('expires')!), f.clock.now + 30 * DAY);
  }
  f.clock.advance(30 * DAY);
  assertLoginAgain(await f.fetch('/dashboard', withCookie(cookie)), f);
}));

test('an expired, a revoked, a garbled or an unknown cookie is turned to the login and cleared', () => withFixture(async f => {
  const expired = await browserLogin(f);
  f.clock.advance(30 * DAY);
  const res = await f.fetch('/dashboard', withCookie(expired));
  assertLoginAgain(res, f);
  assert.equal(setCookie(res.headers)?.attributes.get('max-age'), '0', 'the dead cookie is cleared');

  for (const value of ['', 'fixture-unknown-token', '%%%not-a-token', 'a'.repeat(5000), 'x;y', '"quoted"']) {
    assertLoginAgain(await f.fetch('/dashboard', withCookie(value)), f);
  }
  assertLoginAgain(await f.fetch('/dashboard', { headers: { cookie: 'other=1; natsumi_dashboard' } }), f);
}));

test('the refreshed section answers 401 without a live session instead of starting a login', () => withFixture(async f => {
  const res = await f.fetch('/dashboard/status');
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('location'), null);
  assert.equal((await f.fetch('/dashboard/status', withCookie('fixture-unknown-token'))).status, 401);
}));

test('an app session in Authorization does not open the dashboard: it takes the cookie only', () => withFixture(async f => {
  const { token } = await login(f);
  assertLoginAgain(await f.fetch('/dashboard', { headers: { authorization: `Bearer ${token}` } }), f);
}));

test('an account that is not allowed gets no cookie', () => withFixture(async f => {
  f.stub.user = { id: 7777777, login: OWNER.login };
  const res = await f.fetch(await approveAtGitHub(f, await startBrowserLogin(f)));
  assert.equal(res.status, 403);
  assert.equal(setCookie(res.headers), undefined);
  assert.match(res.text, /account-not-allowed/);
  assert.ok(!res.text.includes('7777777'));
  assertNoLeaks(f);
}));

test('GitHub refusing or failing is shown as a fixed code and gives no cookie', () => withFixture(async f => {
  const authorize = await startBrowserLogin(f);
  const callback = new URL(await approveAtGitHub(f, authorize), PUBLIC_ORIGIN);
  callback.searchParams.delete('code');
  callback.searchParams.set('error', 'access_denied');
  const res = await f.fetch(`${callback.pathname}${callback.search}`);
  assert.equal(res.status, 403);
  assert.match(res.text, /github-denied/);
  assert.equal(setCookie(res.headers), undefined);

  f.stub.userStatus = 500;
  const failed = await f.fetch(await approveAtGitHub(f, await startBrowserLogin(f)));
  assert.equal(failed.status, 502);
  assert.match(failed.text, /github-unavailable/);
  assert.equal(setCookie(failed.headers), undefined);
  assertNoLeaks(f);
}));

test('a cookie of an account that is no longer allowed opens nothing', () => withFixture(async f => {
  const cookie = await browserLogin(f);
  await f.restart(OWNER.id + 1);
  assertLoginAgain(await f.fetch('/dashboard', withCookie(cookie)), f);
}));

test('logging out revokes that browser’s session only and clears its cookie', () => withFixture(async f => {
  const first = await browserLogin(f);
  const second = await browserLogin(f);
  const { token } = await login(f);

  const res = await f.fetch('/dashboard/logout', withCookie(first, { method: 'POST', headers: { origin: PUBLIC_ORIGIN } }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/dashboard/signed-out');
  const cleared = setCookie(res.headers)!;
  assert.equal(cleared.value, '');
  assert.equal(cleared.attributes.get('max-age'), '0');
  assert.equal(cleared.attributes.get('path'), '/dashboard');

  assertLoginAgain(await f.fetch('/dashboard', withCookie(first)), f);
  assert.equal((await f.fetch('/dashboard', withCookie(second))).status, 200, 'another browser stays logged in');
  assert.equal(await connect(f.wsUrl, { authorization: `Bearer ${token}` }), 101, 'the app stays logged in');

  const out = await f.fetch('/dashboard/signed-out');
  assert.equal(out.status, 200, 'the page after logging out needs no session and starts no login');
  assert.match(out.text, /<a href="\/dashboard">/);
}));

test('a logout without the public origin as its Origin is refused and logs nothing out', () => withFixture(async f => {
  const cookie = await browserLogin(f);
  for (const headers of [{}, { origin: 'https://attacker.example.test' }, { origin: 'null' }, { origin: `${PUBLIC_ORIGIN}.attacker.example.test` }] as Record<string, string>[]) {
    const res = await f.fetch('/dashboard/logout', withCookie(cookie, { method: 'POST', headers }));
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.equal(setCookie(res.headers), undefined);
  }
  assert.equal((await f.fetch('/dashboard', withCookie(cookie))).status, 200);
  assert.equal((await f.fetch('/dashboard/logout', withCookie(cookie))).status, 405, 'a GET does not log out');
}));

test('the app’s ways in never read the dashboard cookie', () => withFixture(async f => {
  const cookie = await browserLogin(f);
  assert.equal((await f.fetch('/v1/images/fixture-image', withCookie(cookie))).status, 401);
  assert.equal((await f.fetch('/auth/logout', withCookie(cookie, { method: 'POST' }))).status, 401);
  assert.equal(await connect(f.wsUrl, { cookie: `${COOKIE}=${cookie}` }), 401);
  assert.equal(await connect(f.wsUrl, { cookie: `${COOKIE}=${cookie}`, origin: PUBLIC_ORIGIN }), 401);
  assert.equal((await f.fetch('/dashboard', withCookie(cookie))).status, 200, 'the cookie itself is still good');
}));

test('the style sheet and the script are served as files, and nothing else under /dashboard/static', () => withFixture(async f => {
  const css = await f.fetch('/dashboard/static/dashboard.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /^text\/css/);
  assert.match(css.text, /prefers-color-scheme: dark/);
  const js = await f.fetch('/dashboard/static/dashboard.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') ?? '', /^text\/javascript/);
  assert.match(js.text, /data-refresh/);
  for (const path of ['/dashboard/static/other.js', '/dashboard/static/%2e%2e%2fdashboard.css', '/dashboard/static/..%2f..%2fpackage.json',
    '/dashboard/static/']) {
    assert.equal((await f.fetch(path)).status, 404, path);
  }
}));

test('the cookie is Secure unless the public origin is plain http on loopback, where a browser would drop it', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.match(dashboardCookie('token', now + DAY, now, true), /; Secure;/);
  const loopback = dashboardCookie('token', now + DAY, now, false);
  assert.ok(!loopback.includes('Secure'));
  assert.match(loopback, /HttpOnly; SameSite=Strict$/);
  assert.match(dashboardCookie('', 0, now, true), /^natsumi_dashboard=; Path=\/dashboard; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0;/);
});

/** The app connected over the WebSocket with its session and synced, as a device; resolves with its device ID. */
async function connectAsApp(f: Fixture): Promise<{ ws: WebSocket; deviceId: unknown }> {
  const { token } = await login(f);
  const ws = new WebSocket(f.wsUrl, { headers: { authorization: `Bearer ${token}` } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const replies: Record<string, unknown>[] = [];
  ws.on('message', data => { replies.push(JSON.parse(String(data)) as Record<string, unknown>); });
  ws.send(JSON.stringify({ v: 1, requestId: 'sync-1', type: 'session.sync', payload: { resume: null } }));
  const deadline = Date.now() + 5_000;
  let deviceId: unknown;
  while (!deviceId && Date.now() < deadline) {
    deviceId = (replies.find(reply => reply.requestId === 'sync-1')?.payload as { deviceId?: unknown } | undefined)?.deviceId;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return { ws, deviceId };
}

/** An owner message sent the way the app sends it, over the WebSocket with the app's session; resolves once sent. */
async function sendAsApp(f: Fixture, text: string): Promise<WebSocket> {
  const { ws, deviceId } = await connectAsApp(f);
  ws.send(JSON.stringify({ v: 1, requestId: 'send-1', deviceId, type: 'conversation.send', payload: { text } }));
  return ws;
}

const HOSTILE = '<img src=x onerror=alert(1)>';

test('a turn the loop ran is listed, opened whole and escaped, and its running self is linked from the state (ADR 0049)', () => withFixture(async f => {
  const cookie = await browserLogin(f);
  const ws = await sendAsApp(f, `架空の質問 ${HOSTILE}`);
  try {
    const call = await f.model.next();
    // While it runs: the state links to it, and its page reads what the record has so far.
    const status = await f.fetch('/dashboard/status', withCookie(cookie));
    const link = /<a href="(\/dashboard\/turns\/turn-[0-9a-f-]+)">/.exec(status.text)?.[1];
    assert.ok(link, status.text);
    const running = await f.fetch(link, withCookie(cookie));
    assert.equal(running.status, 200, running.text);
    assert.match(running.text, /実行中/);
    assert.match(running.text, /架空の質問 &lt;img/);

    call.think(`架空の思考 ${HOSTILE}`);
    call.call('reply_to_mac', { text: '架空の返事', expression: 'neutral' });
    call.finish();
    const second = await f.model.next();
    second.delta('済んだ');
    second.finish();
    const deadline = Date.now() + 5_000;
    let list = await f.fetch('/dashboard/turns', withCookie(cookie));
    while (!list.text.includes(link) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
      list = await f.fetch('/dashboard/turns', withCookie(cookie));
    }
    assert.equal(list.status, 200);
    assert.ok(list.text.includes(`href="${link}"`), 'the same turn, now with its row');
    assert.match(list.text, /mac_message/);
    assert.match(list.text, /aria-current="page">ターン/);

    const detail = await f.fetch(link, withCookie(cookie));
    assert.equal(detail.status, 200);
    assert.doesNotMatch(detail.text, /実行中/);
    assert.match(detail.text, /架空の思考 &lt;img/);
    assert.match(detail.text, /reply_to_mac[\s\S]*架空の返事/);
    assert.match(detail.text, /一行メモ/);
    assert.doesNotMatch(detail.text, /推定/);
    assert.ok(!detail.text.includes('<img src=x'));
    assert.match(detail.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.equal(detail.headers.get('cache-control'), 'no-store');
  } finally { ws.close(); }
}));

test('the turns, a turn and its images need the cookie; unknown turns, images and pages are not found', () => withFixture(async f => {
  for (const path of ['/dashboard/turns', '/dashboard/turns/turn-1', '/dashboard/turns/turn-1/images/0']) {
    assertLoginAgain(await f.fetch(path), f);
  }
  const cookie = await browserLogin(f);
  // A turn of the record written by hand, with an image in its events.
  const record = new SessionRecord('fixture-session');
  const start = record.bytes();
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const first = record.events('2026-01-01T00:00:01.000Z', [{ type: 'slack_mention', received_at: 'x' }], '',
    [{ data: png.toString('base64'), mimeType: 'image/png' }, { data: 'PHN2Zz4=', mimeType: 'image/svg+xml' }]);
  const last = record.assistant('2026-01-01T00:00:02.000Z', [{ type: 'text', text: '見た' }]);
  await writeFile(join(f.root, 'pi', 'sessions', 'fixture.jsonl'), record.text());
  const db = new DatabaseSync(join(f.data, '.natsumi', 'state.sqlite'));
  try {
    new TurnStats(db).record({ turnId: 'turn-fixture', startedAt: Date.parse('2026-01-01T00:00:00Z'), endedAt: Date.parse('2026-01-01T00:00:03Z'),
      receivedAt: Date.parse('2026-01-01T00:00:00Z'), fold: 'off', route: 'default', eventKinds: 'slack_mention', outcome: 'ok', modelCalls: 1,
      usage: { input: 1, cacheRead: 1, output: 1 }, contextTokens: 1, compacted: false,
      confusion: { repeatedCalls: 0, toolErrors: 0, doveRefusals: 0, unansweredMessages: 0 },
      place: { sessionFile: 'fixture.jsonl', firstEntryId: first, lastEntryId: last, startOffset: start, endOffset: record.bytes() } });
  } finally { db.close(); }

  const page = await f.fetch('/dashboard/turns/turn-fixture', withCookie(cookie));
  assert.equal(page.status, 200, page.text);
  assert.match(page.text, /<img src="\/dashboard\/turns\/turn-fixture\/images\/0"/);
  const image = await fetch(`${f.base}/dashboard/turns/turn-fixture/images/0`, withCookie(cookie));
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(image.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  // Only the kinds of image a browser shows as a picture: an SVG could carry script.
  assert.equal((await f.fetch('/dashboard/turns/turn-fixture/images/1', withCookie(cookie))).status, 404);
  for (const path of ['/dashboard/turns/turn-fixture/images/2', '/dashboard/turns/turn-fixture/images/-1',
    '/dashboard/turns/turn-fixture/images/x', '/dashboard/turns/turn-missing', '/dashboard/turns/turn-missing/images/0',
    '/dashboard/turns/..%2F..%2Fetc', '/dashboard/turns?page=0', '/dashboard/turns?page=x']) {
    assert.equal((await f.fetch(path, withCookie(cookie))).status, 404, path);
  }
}));

// The lists (ADR 0049): the failures and the waits, the memos, the dove's posts and the devices.

test('the lists need the cookie, and the refreshed failures and waits answer 401 instead of starting a login', () => withFixture(async f => {
  for (const path of ['/dashboard/waits', '/dashboard/memos', '/dashboard/dove', '/dashboard/devices']) assertLoginAgain(await f.fetch(path), f);
  const res = await f.fetch('/dashboard/waits/live');
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('location'), null);
  const cookie = await browserLogin(f);
  for (const path of ['/dashboard/memos?page=0', '/dashboard/memos?page=x', '/dashboard/dove?page=-1', '/dashboard/devices/other', '/dashboard/waits/other']) {
    assert.equal((await f.fetch(path, withCookie(cookie))).status, 404, path);
  }
}));

test('the failures and waits show what the state database holds, and refresh as a fragment', () => withFixture(async f => {
  const cookie = await browserLogin(f);
  const db = new DatabaseSync(join(f.data, '.natsumi', 'state.sqlite'));
  try {
    db.prepare(`INSERT INTO loop_events (event_id, kind, state, reason, created_at, updated_at)
      VALUES ('event-failed', 'mac_message', 'failed', 'model-error', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z')`).run();
    db.prepare(`INSERT INTO self_checks (check_id, reason, reason_key, due_at, state, created_at, updated_at)
      VALUES ('check-1', ?, 'k', '2026-01-01T03:00:00.000Z', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run(`架空の確認 ${HOSTILE}`);
  } finally { db.close(); }
  const page = await f.fetch('/dashboard/waits', withCookie(cookie));
  assert.equal(page.status, 200, page.text);
  assert.match(page.text, /data-refresh="\/dashboard\/waits\/live"/);
  assert.match(page.text, /model-error/);
  assert.match(page.text, /架空の確認 &lt;img/);
  assert.ok(!page.text.includes('<img src=x'));
  const live = await f.fetch('/dashboard/waits/live', withCookie(cookie));
  assert.equal(live.status, 200);
  assert.ok(!live.text.includes('<html'));
  assert.match(live.text, /^<section id="waits"/);
  assert.match(live.text, /model-error/);
}));

test('the memos page shows the memo each turn left, read from its record', () => withFixture(async f => {
  const cookie = await browserLogin(f);
  f.model.memo = () => `架空のメモ ${HOSTILE}`;
  const ws = await sendAsApp(f, '架空の質問');
  try {
    const call = await f.model.next();
    call.delta('済んだ');
    call.finish();
    const deadline = Date.now() + 5_000;
    let res = await f.fetch('/dashboard/memos', withCookie(cookie));
    while (!res.text.includes('架空のメモ') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
      res = await f.fetch('/dashboard/memos', withCookie(cookie));
    }
    assert.equal(res.status, 200);
    assert.match(res.text, /架空のメモ &lt;img/);
    assert.ok(!res.text.includes('<img src=x'));
    assert.match(res.text, /<a href="\/dashboard\/turns\/turn-[0-9a-f-]+">/);
  } finally { ws.close(); }
}));

test('the dove page lists the posts with their words', () => withFixture(async f => {
  const cookie = await browserLogin(f);
  const db = new DatabaseSync(join(f.data, '.natsumi', 'state.sqlite'));
  try {
    db.prepare(`INSERT INTO dove_posts (post_id, kind, workspace, channel_id, reference, text, verdict, state, created_at, updated_at)
      VALUES ('post-1', 'post', 'fixture-space', 'C0FIXTURE', '#架空', ?, 'send', 'sent', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run(`架空の投稿 ${HOSTILE}`);
  } finally { db.close(); }
  const res = await f.fetch('/dashboard/dove', withCookie(cookie));
  assert.equal(res.status, 200, res.text);
  assert.match(res.text, /架空の投稿 &lt;img/);
  assert.match(res.text, /C0FIXTURE/);
  assert.ok(!res.text.includes('<img src=x'));
}));

test('the devices page shows a connected device and the sessions, this browser’s among them, with no token', () => withFixture(async f => {
  const cookie = await browserLogin(f);
  const { ws } = await connectAsApp(f);
  try {
    const res = await f.fetch('/dashboard/devices', withCookie(cookie));
    assert.equal(res.status, 200, res.text);
    assert.match(res.text, /つながっている/);
    assert.match(res.text, /このブラウザ/);
    assert.match(res.text, /有効 2/, 'this browser’s session and the app’s');
    assert.ok(!res.text.includes(cookie), 'the token is never shown');
  } finally { ws.close(); }
}));
