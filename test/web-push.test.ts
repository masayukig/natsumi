import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { MIGRATIONS } from '../src/server/migrations.ts';
import type { PushEvent } from '../src/server/push.ts';
import { migrate } from '../src/server/state-db.ts';
import {
  encryptWebPush, loadVapidKey, parseSubscription, vapidAuthorization, WEB_PUSH_PLAINTEXT_MAX_BYTES, webPushPayload, WebPushNotifier,
  WebPushSubscriptions, type WebPushRequest,
} from '../src/server/web-push.ts';

/** Web Push to the browsers that are away (ADR 0065): the VAPID key and token, aes128gcm, and who is sent what. */

const OWNER = 4242001;
const NOW = Date.parse('2026-01-01T00:00:00Z');
const b64 = (text: string) => Buffer.from(text, 'base64url');

/** The browser's side of RFC 8291, written apart from the server's, as a push service's client would. */
function decrypt(body: Buffer, browser: { privateKey: Buffer; auth: Buffer }): Buffer {
  const salt = body.subarray(0, 16);
  const keyLength = body[20]!;
  const serverKey = body.subarray(21, 21 + keyLength);
  const record = body.subarray(21 + keyLength);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(browser.privateKey);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), serverKey]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(serverKey), browser.auth, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  assert.equal(padded.at(-1), 2, 'the last record ends with the delimiter 0x02');
  return padded.subarray(0, -1);
}

function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { privateKey: ecdh.getPrivateKey(), p256dh: ecdh.getPublicKey(), auth: Buffer.alloc(16, 7) };
}

const subscriptionJson = (endpoint: string, keys: { p256dh: Buffer; auth: Buffer }) =>
  ({ endpoint, expirationTime: null, keys: { p256dh: keys.p256dh.toString('base64url'), auth: keys.auth.toString('base64url') } });

// RFC 8291, Appendix A.
test('encrypting with the RFC’s keys and salt reproduces its example byte for byte', () => {
  const body = encryptWebPush({
    p256dh: b64('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
    auth: b64('BTBZMqHH6r4Tts7J_aSIgg'),
    plaintext: Buffer.from('When I grow up, I want to be a watermelon'),
    serverPrivateKey: b64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
    salt: b64('DGv6ra1nlYgDCS1FRnbzlw'),
  });
  assert.equal(body.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  assert.equal(decrypt(body, { privateKey: b64('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'), auth: b64('BTBZMqHH6r4Tts7J_aSIgg') }).toString(),
    'When I grow up, I want to be a watermelon');
});

test('a push is opened by the browser’s key, with a fresh key pair and salt each time', () => {
  const browser = browserKeys();
  const plaintext = Buffer.from(JSON.stringify({ title: 'なつみ', text: '返事' }));
  const first = encryptWebPush({ p256dh: browser.p256dh, auth: browser.auth, plaintext });
  const second = encryptWebPush({ p256dh: browser.p256dh, auth: browser.auth, plaintext });
  assert.notDeepEqual(first.subarray(0, 86), second.subarray(0, 86));
  assert.equal(first.readUInt32BE(16), 4096);
  assert.deepEqual(decrypt(first, browser), plaintext);
  assert.deepEqual(decrypt(second, browser), plaintext);
});

test('the VAPID key is made once in a 0600 file and read back the same; the token is an ES256 JWT for the push service', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'natsumi-vapid-'));
  try {
    const file = join(dir, 'web-push-key.pem');
    const made = await loadVapidKey(file);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const again = await loadVapidKey(file);
    assert.equal(again.publicKey, made.publicKey);
    assert.equal(b64(made.publicKey).length, 65);
    assert.match(await readFile(file, 'utf8'), /BEGIN PRIVATE KEY/);

    const authorization = vapidAuthorization({ vapid: made, endpoint: 'https://push.example.test/send/abc?x=1', subject: 'https://natsumi.example.test', now: NOW });
    const [, jwt, key] = /^vapid t=([^,]+), k=(.+)$/.exec(authorization)!;
    assert.equal(key, made.publicKey);
    const [header, claims, signature] = jwt!.split('.');
    assert.deepEqual(JSON.parse(b64(header!).toString()), { typ: 'JWT', alg: 'ES256' });
    assert.deepEqual(JSON.parse(b64(claims!).toString()),
      { aud: 'https://push.example.test', exp: NOW / 1000 + 12 * 3600, sub: 'https://natsumi.example.test' });
    const raw = b64(key!);
    const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    assert.ok(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, b64(signature!)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a subscription takes an https endpoint, a P-256 key and a 16-byte auth secret, all base64url', () => {
  const keys = browserKeys();
  const good = subscriptionJson('https://push.example.test/send/abc', keys);
  assert.deepEqual(parseSubscription(good), { endpoint: good.endpoint, p256dh: keys.p256dh, auth: keys.auth });
  for (const bad of [
    undefined, {}, { ...good, endpoint: 'http://push.example.test/send/abc' }, { ...good, endpoint: 'not a url' },
    { ...good, keys: { ...good.keys, p256dh: keys.p256dh.subarray(1).toString('base64url') } },
    { ...good, keys: { ...good.keys, p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url') } },
    { ...good, keys: { ...good.keys, auth: Buffer.alloc(8).toString('base64url') } },
    { ...good, keys: { ...good.keys, auth: 'not base64!' } },
  ]) assert.equal(parseSubscription(bad), undefined, JSON.stringify(bad));
});

test('a long line of wide characters is cut to fit one record, with the image mark kept', () => {
  const payload = webPushPayload('なつみ', 'message-1', { text: '𠮷'.repeat(1000), imageCount: 1 });
  assert.ok(payload.length <= WEB_PUSH_PLAINTEXT_MAX_BYTES);
  const { title, tag, text } = JSON.parse(payload.toString());
  assert.deepEqual([title, tag], ['なつみ', 'message-1']);
  assert.match(text, /^𠮷+…（画像 1 枚）$/u);
});

// Who is sent what.

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, MIGRATIONS);
  return db;
}

function device(db: DatabaseSync, deviceId: string, revoked = false) {
  const iso = (ms: number) => new Date(ms).toISOString();
  db.prepare(`INSERT INTO client_sessions (session_id, token_hash, github_user_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(`session-${deviceId}`, `hash-${deviceId}`, OWNER, iso(NOW), iso(NOW + 3_600_000), revoked ? iso(NOW) : null);
  db.prepare(`INSERT INTO devices (device_id, github_user_id, client_session_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`)
    .run(deviceId, OWNER, `session-${deviceId}`, iso(NOW), iso(NOW));
}

async function notifierWith(answer: (request: WebPushRequest) => number) {
  const dir = await mkdtemp(join(tmpdir(), 'natsumi-vapid-'));
  const vapid = await loadVapidKey(join(dir, 'key.pem'));
  await rm(dir, { recursive: true, force: true });
  const db = database();
  const subscriptions = new WebPushSubscriptions(db, () => NOW);
  const listeners: ((event: PushEvent) => void)[] = [];
  const sent: WebPushRequest[] = [];
  const logs: string[] = [];
  const connected = new Set<string>();
  const notifier = new WebPushNotifier({
    loop: { subscribe: listener => { listeners.push(listener); return () => {}; } }, subscriptions, vapid, subject: 'https://natsumi.example.test',
    allowedUserId: OWNER, isConnected: deviceId => connected.has(deviceId), log: line => logs.push(line), now: () => NOW,
    iconOrigin: 'https://natsumi.example.test', send: async request => { sent.push(request); return answer(request); },
  });
  const emit = async (event: PushEvent) => {
    for (const listener of listeners) listener(event);
    await new Promise(resolve => setTimeout(resolve, 20));
  };
  return { db, subscriptions, sent, logs, connected, notifier, emit };
}

const reply = (text: string) => ({ type: 'conversation.message', payload: { role: 'natsumi', kind: 'reply', messageId: 'message-1', text, expression: 'happy' } });

test('the alerts go to the subscribed browsers that are away, encrypted, and nothing else is sent', async () => {
  const { db, subscriptions, sent, connected, notifier, emit } = await notifierWith(() => 201);
  const away = browserKeys();
  const here = browserKeys();
  for (const id of ['device-away', 'device-here', 'device-revoked']) device(db, id, id === 'device-revoked');
  subscriptions.save('device-away', parseSubscription(subscriptionJson('https://push.example.test/away', away))!);
  subscriptions.save('device-here', parseSubscription(subscriptionJson('https://push.example.test/here', here))!);
  subscriptions.save('device-revoked', parseSubscription(subscriptionJson('https://push.example.test/revoked', browserKeys()))!);
  connected.add('device-here');

  await emit(reply('おかえり'));
  assert.deepEqual(sent.map(request => request.endpoint), ['https://push.example.test/away']);
  const [push] = sent;
  assert.equal(push!.headers['content-encoding'], 'aes128gcm');
  assert.equal(push!.headers.ttl, '86400');
  assert.match(push!.headers.authorization!, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.deepEqual(JSON.parse(decrypt(push!.body, away).toString()),
    { title: 'なつみ', tag: 'message-1', text: 'おかえり', expression: 'happy', icon: 'https://natsumi.example.test/avatar/happy.png' });

  await emit({ type: 'approval.pending', payload: { approvalId: 'approval-1', text: '下書き', target: { channel: 'work/#dev' } } });
  assert.deepEqual(JSON.parse(decrypt(sent[1]!.body, away).toString()), { title: 'なつみ', tag: 'approval-1', text: '承認待ちがあります（work/#dev）\n下書き' });

  // The owner's own lines and the iPhone's background pushes are not for the browser.
  await emit({ type: 'conversation.message', payload: { role: 'owner', kind: 'message', messageId: 'message-2', text: 'ただいま' } });
  await emit({ type: 'conversation.read', payload: {} });
  await emit({ type: 'approval.resolved', payload: { approvalId: 'approval-1' } });
  assert.equal(sent.length, 2);
  notifier.close();
});

test('a push service answering 404 or 410 drops the subscription; another error only logs', async () => {
  const statuses = new Map([['https://push.example.test/gone', 410], ['https://push.example.test/missing', 404], ['https://push.example.test/busy', 503]]);
  const { db, subscriptions, logs, notifier, emit } = await notifierWith(request => statuses.get(request.endpoint)!);
  for (const [endpoint] of statuses) {
    const id = `device-${endpoint.split('/').at(-1)}`;
    device(db, id);
    subscriptions.save(id, parseSubscription(subscriptionJson(endpoint, browserKeys()))!);
  }
  await emit(reply('こんにちは'));
  assert.deepEqual(subscriptions.targets(OWNER).map(target => target.deviceId), ['device-busy']);
  assert.ok(logs.includes('web push: removed the subscription of device-gone (410)'), logs.join('\n'));
  assert.ok(logs.includes('web push: a push to device-busy was refused with 503'), logs.join('\n'));
  for (const line of logs) assert.ok(!line.includes('https://'), 'no endpoint in the log');
  notifier.close();
});

test('a subscription is one per device and an endpoint belongs to one device', () => {
  const db = database();
  const subscriptions = new WebPushSubscriptions(db, () => NOW);
  device(db, 'device-a');
  device(db, 'device-b');
  const keys = browserKeys();
  subscriptions.save('device-a', parseSubscription(subscriptionJson('https://push.example.test/one', keys))!);
  subscriptions.save('device-a', parseSubscription(subscriptionJson('https://push.example.test/two', keys))!);
  assert.deepEqual(subscriptions.targets(OWNER).map(target => [target.deviceId, target.endpoint]), [['device-a', 'https://push.example.test/two']]);
  subscriptions.save('device-b', parseSubscription(subscriptionJson('https://push.example.test/two', keys))!);
  assert.deepEqual(subscriptions.targets(OWNER).map(target => target.deviceId), ['device-b']);
  assert.equal(subscriptions.remove('device-b', 'https://push.example.test/one'), false, 'not the endpoint it has now');
  assert.equal(subscriptions.remove('device-b', 'https://push.example.test/two'), true);
});

test('an answer that comes after the notifier has closed touches nothing, even with the database closed', async () => {
  let answer!: (status: number) => void;
  const { db, subscriptions, logs, notifier, emit } = await notifierWith(() => 0);
  device(db, 'device-away');
  subscriptions.save('device-away', parseSubscription(subscriptionJson('https://push.example.test/away', browserKeys()))!);
  (notifier as unknown as { send: () => Promise<number> }).send = () => new Promise(resolve => { answer = resolve; });
  await emit(reply('おかえり'));
  notifier.close();
  db.close();
  answer(410);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(logs, []);
});
