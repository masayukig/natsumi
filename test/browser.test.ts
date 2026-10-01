import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import WebSocket from 'ws';
import type { WebPushRequest } from '../src/server/web-push.ts';
import { apnsTestKey, FakeApns } from './support/fake-apns.ts';
import { approveAtGitHub, login, MINUTE, PUBLIC_ORIGIN, startFixture, type Fixture, type FixtureOptions } from './support/server-fixture.ts';

/**
 * The browser as one more device (ADR 0058): one cookie at Path=/ for the dashboard, the chat and the settings; the
 * chat's page and its bundle; and /v1/ws taking that cookie only with the public origin as the Origin.
 */

const COOKIE = 'natsumi_session';
const LEGACY = 'natsumi_dashboard';
const DAY = 24 * 60 * MINUTE;

async function withFixture(fn: (f: Fixture) => Promise<void>, options: FixtureOptions = {}) {
  const f = await startFixture(options);
  try { await fn(f); } finally { await f.cleanup(); }
}

/** Every cookie a response sets, by name, with its attributes. */
function setCookies(headers: Headers): Map<string, { value: string; attributes: Map<string, string> }> {
  return new Map(headers.getSetCookie().map(line => {
    const [pair, ...rest] = line.split(';').map(part => part.trim());
    const at = pair!.indexOf('=');
    const attributes = new Map(rest.map(part => {
      const [name, ...value] = part.split('=');
      return [name!.toLowerCase(), value.join('=')] as const;
    }));
    return [pair!.slice(0, at), { value: pair!.slice(at + 1), attributes }] as const;
  }));
}

const withCookie = (cookie: string, init: RequestInit = {}): RequestInit =>
  ({ ...init, headers: { ...(init.headers as Record<string, string> | undefined), cookie } });

/** Opens a page without a session and follows the login through GitHub; returns the callback's answer. */
async function loginFrom(f: Fixture, path: string) {
  const start = await f.fetch(path);
  assert.equal(start.status, 302, start.text);
  const authorize = new URL(start.headers.get('location')!);
  assert.equal(`${authorize.origin}${authorize.pathname}`, f.stub.endpoints.authorizeUrl);
  return f.fetch(await approveAtGitHub(f, authorize));
}

/** The whole browser login from `/`; returns the session cookie's value. */
async function browserLogin(f: Fixture) {
  const res = await loginFrom(f, '/');
  const cookie = setCookies(res.headers).get(COOKIE);
  assert.ok(cookie?.value, 'the callback sets the session cookie');
  return cookie.value;
}

function connect(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => { ws.close(); resolve(101); });
    ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); res.resume(); ws.terminate(); });
    ws.once('error', reject);
  });
}

interface Envelope { type: string; requestId?: string; payload: Record<string, any> }

/** A device over the WebSocket, with the headers a browser or an app would send. */
async function device(f: Fixture, headers: Record<string, string>) {
  const ws = new WebSocket(f.wsUrl, { headers });
  const messages: Envelope[] = [];
  ws.on('message', data => { messages.push(JSON.parse(String(data)) as Envelope); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let counter = 0;
  let deviceId: string | undefined;
  const until = async (predicate: (message: Envelope) => boolean, from = 0) => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const found = messages.slice(from).find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out; received ${messages.map(m => m.type).join(', ')}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  const request = async (type: string, payload: Record<string, unknown> = {}) => {
    const requestId = `request-${++counter}`;
    const from = messages.length;
    ws.send(JSON.stringify({ v: 1, requestId, deviceId, type, payload }));
    return until(message => message.requestId === requestId, from);
  };
  return {
    messages, until, request,
    get deviceId() { return deviceId; },
    async sync(resume: string | undefined = deviceId) {
      deviceId = resume;
      const reply = await request('session.sync', { resume: null });
      deviceId = reply.payload.deviceId;
      return reply;
    },
    close: () => new Promise(resolve => { ws.once('close', resolve); ws.close(); }),
  };
}

const browserHeaders = (cookie: string) => ({ cookie: `${COOKIE}=${cookie}`, origin: PUBLIC_ORIGIN });

// Login and the cookie.

test('the login gives one cookie for the whole origin: HttpOnly, Secure, SameSite=Strict, Path=/, thirty days', () => withFixture(async f => {
  const res = await loginFrom(f, '/');
  const cookie = setCookies(res.headers).get(COOKIE)!;
  assert.ok(cookie.value.length >= 43);
  assert.equal(cookie.attributes.get('path'), '/');
  assert.ok(cookie.attributes.has('httponly'));
  assert.ok(cookie.attributes.has('secure'));
  assert.equal(cookie.attributes.get('samesite'), 'Strict');
  assert.equal(cookie.attributes.get('max-age'), String(30 * DAY / 1000));
  assert.equal(setCookies(res.headers).has(LEGACY), false, 'the old cookie is never set again');
  assert.ok(!f.logs.join('\n').includes(cookie.value), 'the session token is never logged');
}));

test('the login goes back to the page it began at, and to nowhere else', () => withFixture(async f => {
  for (const path of ['/', '/settings', '/dashboard']) {
    const res = await loginFrom(f, path);
    assert.equal(res.status, 200);
    assert.ok(res.text.includes(`<meta http-equiv="refresh" content="0; url=${path}">`), `${path}: ${res.text}`);
    assert.ok(res.text.includes(`<a href="${path}">`));
  }
  // A page under /dashboard goes back to the dashboard's front, as before.
  const deep = await loginFrom(f, '/dashboard/turns');
  assert.ok(deep.text.includes('url=/dashboard"'));
}));

test('/ and /settings without a live session go to the login, clearing a dead cookie', () => withFixture(async f => {
  for (const path of ['/', '/settings']) {
    const res = await f.fetch(path);
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get('location')!).pathname, new URL(f.stub.endpoints.authorizeUrl).pathname);
  }
  const dead = await f.fetch('/', withCookie(`${COOKIE}=fixture-unknown-token`));
  assert.equal(dead.status, 302);
  assert.equal(setCookies(dead.headers).get(COOKIE)?.attributes.get('max-age'), '0');
}));

test('a browser with the old dashboard cookie is moved to the new one on the dashboard, once', () => withFixture(async f => {
  // The session of the old cookie is the same kind as the app's; an app session stands in for one issued before.
  const { token } = await login(f);
  const res = await f.fetch('/dashboard', withCookie(`${LEGACY}=${token}`));
  assert.equal(res.status, 200, res.text);
  const cookies = setCookies(res.headers);
  assert.equal(cookies.get(COOKIE)?.value, token, 'the same session, under the new name');
  assert.equal(cookies.get(COOKIE)?.attributes.get('path'), '/');
  assert.equal(cookies.get(LEGACY)?.value, '');
  assert.equal(cookies.get(LEGACY)?.attributes.get('path'), '/dashboard');
  assert.equal(cookies.get(LEGACY)?.attributes.get('max-age'), '0');
  // With both, the new one alone is read.
  const both = await f.fetch('/dashboard', withCookie(`${LEGACY}=${token}; ${COOKIE}=fixture-unknown-token`));
  assert.equal(both.status, 302);
  // The old cookie is sent under /dashboard only, and nothing else reads it.
  assert.equal((await f.fetch('/', withCookie(`${LEGACY}=${token}`))).status, 302);
  assert.equal(await connect(f.wsUrl, { cookie: `${LEGACY}=${token}`, origin: PUBLIC_ORIGIN }), 401);
}));

test('logging out clears the cookie for the whole origin, and the old one with it', () => withFixture(async f => {
  const cookie = await browserLogin(f);
  const res = await f.fetch('/dashboard/logout', withCookie(`${COOKIE}=${cookie}`, { method: 'POST', headers: { origin: PUBLIC_ORIGIN } }));
  assert.equal(res.status, 303);
  const cookies = setCookies(res.headers);
  assert.deepEqual([cookies.get(COOKIE)?.value, cookies.get(COOKIE)?.attributes.get('path'), cookies.get(COOKIE)?.attributes.get('max-age')], ['', '/', '0']);
  assert.equal(cookies.get(LEGACY)?.attributes.get('max-age'), '0');
  assert.equal(await connect(f.wsUrl, browserHeaders(cookie)), 401);
}));

// The pages and the bundle.

test('/ and /settings are one page under a strict CSP that names the WebSocket; without a bundle it says so and loads nothing', () => withFixture(async f => {
  const cookie = await browserLogin(f);
  const chat = await f.fetch('/', withCookie(`${COOKIE}=${cookie}`));
  const settings = await f.fetch('/settings', withCookie(`${COOKIE}=${cookie}`));
  for (const res of [chat, settings]) {
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html; charset=utf-8/);
    const csp = res.headers.get('content-security-policy') ?? '';
    for (const directive of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:",
      "connect-src 'self' wss://natsumi.example.test", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
      assert.ok(csp.includes(directive), `${directive} in ${csp}`);
    }
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(setCookies(res.headers).get(COOKIE)?.value, cookie, 'a use renews the cookie');
    assert.ok(!res.text.includes('<script'), 'no bundle, no script');
    assert.match(res.text, /画面の JS がまだありません/);
  }
  assert.equal(chat.text, settings.text);
}));

test('with a bundle the page loads it, and the bundle is served to anyone, by its name only', () => withFixture(async f => {
  const cookie = await browserLogin(f);
  const page = await f.fetch('/', withCookie(`${COOKIE}=${cookie}`));
  assert.match(page.text, /<script type="module" src="\/app\/app\.js"><\/script>/);
  assert.match(page.text, /<link rel="stylesheet" href="\/app\/app\.css">/);
  assert.match(page.text, /<div id="app"><\/div>/);
  assert.ok(!page.text.includes('まだありません'));
  const js = await f.fetch('/app/app.js');
  assert.equal(js.status, 200, 'no login: it is the code of a public repository');
  assert.match(js.headers.get('content-type') ?? '', /^text\/javascript/);
  assert.equal(js.text, 'console.log("fixture bundle");\n');
  const css = await f.fetch('/app/app.css');
  assert.match(css.headers.get('content-type') ?? '', /^text\/css/);
  for (const path of ['/app/missing.js', '/app/../package.json', '/app/%2e%2e%2fpackage.json', '/app/', '/app/secret.txt', '/app/.hidden.js']) {
    assert.equal((await f.fetch(path)).status, 404, path);
  }
  assert.equal((await f.fetch('/', { method: 'POST' })).status, 405);
  assert.equal((await f.fetch('/settings/other')).status, 404);
}, { prepare: async data => {
  const bundle = join(data, '..', 'bundle');
  await mkdir(bundle, { recursive: true });
  await writeFile(join(bundle, 'app.js'), 'console.log("fixture bundle");\n');
  await writeFile(join(bundle, 'app.css'), 'body { margin: 0; }\n');
  await writeFile(join(bundle, 'secret.txt'), 'not served\n');
  await writeFile(join(bundle, '.hidden.js'), 'not served\n');
}, webBundle: root => join(root, 'bundle') }));

test('the page names the manifest and the VAPID key; the service worker may take / as its scope (ADR 0065)', () => withFixture(async f => {
  const cookie = await browserLogin(f);
  const page = await f.fetch('/', withCookie(`${COOKIE}=${cookie}`));
  assert.match(page.text, /<link rel="manifest" href="\/app\/manifest\.webmanifest">/);
  const key = /<meta name="natsumi-push-key" content="([\w-]+)">/.exec(page.text)?.[1];
  assert.equal(Buffer.from(key!, 'base64url').length, 65);
  assert.equal((await stat(join(f.data, '.natsumi', 'web-push-key.pem'))).mode & 0o777, 0o600);
  const manifest = await f.fetch('/app/manifest.webmanifest');
  assert.equal(manifest.headers.get('content-type'), 'application/manifest+json');
  const { icons, ...rest } = manifest.json() as { icons: { src: string; sizes: string }[] };
  assert.deepEqual(rest, { name: 'なつみ', short_name: 'なつみ', start_url: '/', scope: '/', display: 'standalone' });
  assert.equal(icons[0]!.src, '/avatar/neutral.png');
  assert.match(icons[0]!.sizes, /^\d+x\d+$/);
  const worker = await f.fetch('/app/sw.js');
  assert.equal(worker.headers.get('service-worker-allowed'), '/');
  assert.equal((await f.fetch('/app/app.js')).headers.get('service-worker-allowed'), null);
}, { prepare: async data => {
  const bundle = join(data, '..', 'bundle');
  await mkdir(bundle, { recursive: true });
  await writeFile(join(bundle, 'app.js'), 'console.log("fixture bundle");\n');
  await writeFile(join(bundle, 'sw.js'), 'self.addEventListener("push", () => {});\n');
}, webBundle: root => join(root, 'bundle') }));

// The WebSocket.

test('/v1/ws takes the cookie only when the Origin is the public origin', () => withFixture(async f => {
  const cookie = await browserLogin(f);
  assert.equal(await connect(f.wsUrl, browserHeaders(cookie)), 101);
  assert.equal(await connect(f.wsUrl, { cookie: `${COOKIE}=${cookie}` }), 403, 'no Origin');
  assert.equal(await connect(f.wsUrl, { cookie: `${COOKIE}=${cookie}`, origin: 'https://elsewhere.example.test' }), 403);
  assert.equal(await connect(f.wsUrl, { cookie: `${COOKIE}=fixture-unknown-token`, origin: PUBLIC_ORIGIN }), 401);
  assert.equal(await connect(f.wsUrl, { origin: PUBLIC_ORIGIN }), 401);
  // A bearer decides alone: a bad one is refused even with a good cookie beside it.
  assert.equal(await connect(f.wsUrl, { ...browserHeaders(cookie), authorization: 'Bearer fixture-unknown-token' }), 401);
  const { token } = await login(f);
  assert.equal(await connect(f.wsUrl, { authorization: `Bearer ${token}` }), 101, 'the apps are as before');
  f.clock.advance(31 * DAY);
  assert.equal(await connect(f.wsUrl, browserHeaders(cookie)), 401, 'an expired cookie opens nothing');
}));

test('the browser is one more device: it syncs, talks and changes a setting, and may not register for APNs', () => withFixture(async f => {
  const cookie = await browserLogin(f);
  const browser = await device(f, browserHeaders(cookie));
  const snapshot = await browser.sync(undefined);
  assert.equal(snapshot.type, 'session.snapshot');
  assert.match(browser.deviceId!, /\S/);
  f.model.auto = context => context.messages.at(-1)?.role === 'user'
    ? { calls: [{ name: 'reply_to_mac', arguments: { text: 'ブラウザにも返事', expression: 'happy' } }] } : {};
  const sent = await browser.request('conversation.send', { text: 'ブラウザから' });
  assert.equal(sent.type, 'command.accepted');
  await browser.until(message => message.type === 'conversation.message' && message.payload.text === 'ブラウザにも返事');
  assert.equal((await browser.request('settings.set', { key: 'eventTimeoutMinutes', value: 15 })).type, 'command.accepted');
  const push = await browser.request('push.register', { token: 'c3'.repeat(32), publicKey: 'x', environment: 'sandbox' });
  assert.deepEqual([push.type, push.payload.code], ['command.rejected', 'invalid-request']);
  // The next connection keeps the device the server gave it.
  const id = browser.deviceId;
  await browser.close();
  const again = await device(f, browserHeaders(cookie));
  assert.equal((await again.sync(id)).payload.deviceId, id);
  await again.close();
}));

test('an image of the conversation is fetched with the cookie, as with the app’s bearer', () => withFixture(async f => {
  const cookie = await browserLogin(f);
  const res = await f.fetch('/v1/images/fixture-image', withCookie(`${COOKIE}=${cookie}`));
  assert.equal(res.status, 404, 'past the login: an image nobody was shown is not found');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const none = await f.fetch('/v1/images/fixture-image');
  assert.deepEqual([none.status, none.headers.get('cache-control')], [401, 'no-store']);
  assert.equal((await f.fetch('/v1/images/fixture-image', withCookie(`${COOKIE}=fixture-unknown-token`))).status, 401);
  assert.equal((await f.fetch('/auth/logout', withCookie(`${COOKIE}=${cookie}`, { method: 'POST' }))).status, 401, 'the app’s logout takes the bearer only');
}));

test('a browser registers a Web Push subscription, and is pushed to while it is away only (ADR 0065)', async () => {
  const sent: WebPushRequest[] = [];
  let status = 201;
  await withFixture(async f => {
    const cookie = await browserLogin(f);
    const browser = await device(f, browserHeaders(cookie));
    await browser.sync(undefined);
    const keys = createECDH('prime256v1');
    keys.generateKeys();
    const subscription = { endpoint: 'https://push.example.test/send/one', expirationTime: null,
      keys: { p256dh: keys.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } };
    const refused = await browser.request('push.register', { subscription: { ...subscription, endpoint: 'http://push.example.test/' } });
    assert.deepEqual([refused.type, refused.payload.code], ['command.rejected', 'invalid-request']);
    const registered = await browser.request('push.register', { subscription });
    assert.deepEqual([registered.type, registered.payload], ['command.accepted', {}]);
    // An app's bearer connection may not register a subscription.
    const phone = await device(f, { authorization: `Bearer ${(await login(f)).token}` });
    await phone.sync(undefined);
    const fromApp = await phone.request('push.register', { subscription });
    assert.deepEqual([fromApp.type, fromApp.payload.code], ['command.rejected', 'invalid-request']);

    f.model.auto = (context: Context) => context.messages.at(-1)?.role === 'user'
      ? { calls: [{ name: 'reply_to_mac', arguments: { text: '架空の返事', expression: 'happy' } }] } : {};
    const talk = async (text: string) => {
      const accepted = await phone.request('conversation.send', { text });
      await phone.until(message => message.type === 'conversation.event.completed' && message.payload.eventId === accepted.payload.eventId);
      await new Promise(resolve => setTimeout(resolve, 50));
    };
    await talk('ブラウザがつながっているとき');
    assert.equal(sent.length, 0, 'a connected browser gets the conversation instead');
    await browser.close();
    await talk('ブラウザがはなれているとき');
    assert.deepEqual(sent.map(request => [request.endpoint, request.headers['content-encoding']]), [[subscription.endpoint, 'aes128gcm']]);
    assert.match(sent[0]!.headers.authorization!, /^vapid t=/);

    status = 410;
    await talk('購読が切れたあと');
    await talk('もう送らない');
    assert.equal(sent.length, 2, 'the subscription went with the 410');
    assert.ok(f.logs.some(line => line.includes('web push: removed the subscription')), f.logs.join('\n'));
    await phone.close();
  }, { webPush: { send: async request => { sent.push(request); return status; } } });
});

test('the iPhone away is still pushed to while the browser is connected', async () => {
  const apns = await new FakeApns().start();
  const f = await startFixture({ apns: { origin: apns.origin, pem: apnsTestKey().pem, retryDelaysMs: [1, 1] } });
  try {
    const phone = await device(f, { authorization: `Bearer ${(await login(f)).token}` });
    await phone.sync(undefined);
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const registered = await phone.request('push.register', { token: 'c3'.repeat(32), publicKey: ecdh.getPublicKey().toString('base64'),
      environment: 'sandbox' });
    assert.equal(registered.type, 'command.accepted');
    await phone.close();
    const browser = await device(f, browserHeaders(await browserLogin(f)));
    await browser.sync(undefined);
    f.model.auto = (context: Context) => context.messages.at(-1)?.role === 'user'
      ? { calls: [{ name: 'reply_to_mac', arguments: { text: '架空の返事', expression: 'happy' } }] } : {};
    const sent = await browser.request('conversation.send', { text: 'ブラウザで話す' });
    await browser.until(message => message.type === 'conversation.event.completed' && message.payload.eventId === sent.payload.eventId);
    const [alert] = await apns.waitFor(1);
    assert.equal(alert!.headers['apns-push-type'], 'alert');
    assert.equal(alert!.body.kind, 'reply');
    await browser.close();
  } finally {
    await f.cleanup();
    await apns.close();
  }
});
