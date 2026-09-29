import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import WebSocket from 'ws';
import { openPush } from '../src/server/push-crypto.ts';
import { apnsTestKey, FakeApns } from './support/fake-apns.ts';
import { pngOf } from './support/fake-slack.ts';
import { login, startFixture, type Fixture, type FixtureOptions } from './support/server-fixture.ts';

interface Envelope { type: string; requestId?: string; seq: number; payload: Record<string, any> }

/** A client that keeps what it received, as far as these tests need. */
class Client {
  readonly messages: Envelope[] = [];
  deviceId: string | undefined;
  private readonly ws: WebSocket;
  private counter = 0;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', data => {
      const envelope = JSON.parse(String(data)) as Envelope;
      if (envelope.type !== 'conversation.thinking') this.messages.push(envelope);
    });
  }

  static open(f: Fixture, token: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(f.wsUrl, { headers: { authorization: `Bearer ${token}` } });
      const client = new Client(ws);
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  send(type: string, payload: Record<string, unknown>) {
    const requestId = `request-${++this.counter}-${Math.random().toString(36).slice(2)}`;
    this.ws.send(JSON.stringify({ v: 1, requestId, deviceId: this.deviceId, type, payload }));
    return requestId;
  }

  async until(predicate: (message: Envelope) => boolean, from = 0): Promise<Envelope> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const found = this.messages.slice(from).find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out; received ${this.messages.map(m => m.type).join(', ')}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  async command(type: string, payload: Record<string, unknown>) {
    const from = this.messages.length;
    const requestId = this.send(type, payload);
    return this.until(message => message.requestId === requestId, from);
  }

  async sync() {
    const reply = await this.command('session.sync', { resume: null });
    this.deviceId = reply.payload.deviceId;
    return reply;
  }

  close() {
    const closed = new Promise(resolve => this.ws.once('close', resolve));
    this.ws.close();
    return closed;
  }
}

function keyPair() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey().toString('base64') };
}

const TOKEN = 'c3'.repeat(32);

async function withPush(fn: (f: Fixture, apns: FakeApns) => Promise<void>, options: FixtureOptions = {}) {
  const apns = await new FakeApns().start();
  const f = await startFixture({ ...options, apns: { origin: apns.origin, pem: apnsTestKey().pem, retryDelaysMs: [1, 1] } });
  try { await fn(f, apns); } finally {
    await f.cleanup();
    await apns.close();
  }
}

function registrations(f: Fixture) {
  const db = new DatabaseSync(join(f.data, '.natsumi', 'state.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT device_id, token, environment FROM push_registrations').all().map(row => ({ ...row })); } finally { db.close(); }
}

const freshPrompt = (context: Context) => context.messages.at(-1)?.role === 'user';

/** natsumi answers every message with one reply and one notice. */
function answerEveryMessage(f: Fixture) {
  f.model.auto = context => freshPrompt(context) ? { calls: [
    { name: 'reply_to_mac', arguments: { text: '架空の返事', expression: 'happy' } },
    { name: 'notify_owner', arguments: { text: '架空の知らせ', expression: 'worried' } },
  ] } : {};
}

/** Sends a message from the Mac and waits until natsumi's turn is over. */
async function talk(mac: Client, text: string) {
  const from = mac.messages.length;
  const accepted = await mac.command('conversation.send', { text });
  assert.equal(accepted.type, 'command.accepted');
  await mac.until(m => m.type === 'conversation.event.completed' && m.payload.eventId === accepted.payload.eventId, from);
  const said = mac.messages.slice(from).filter(m => m.type === 'conversation.message' && m.payload.role === 'natsumi');
  const find = (kind: string) => said.find(m => m.payload.kind === kind)?.payload as Record<string, any>;
  return { reply: find('reply'), notice: find('notice') };
}

test('push.register needs a synced device and a valid payload, and is overwritten in place', () => withPush(async f => {
  const { token } = await login(f);
  const phone = await Client.open(f, token);
  const { publicKey } = keyPair();
  const register = { token: TOKEN, publicKey, environment: 'sandbox' };
  const early = await phone.command('push.register', register);
  assert.deepEqual([early.type, early.payload.code], ['command.rejected', 'sync-required']);
  await phone.sync();

  for (const payload of [{}, { ...register, publicKey: 'not base64' }, { ...register, environment: 'development' }, { ...register, token: 'xyz' }]) {
    const refused = await phone.command('push.register', payload);
    assert.deepEqual([refused.type, refused.payload.code], ['command.rejected', 'invalid-request'], JSON.stringify(payload));
  }
  const accepted = await phone.command('push.register', register);
  assert.deepEqual([accepted.type, accepted.payload], ['command.accepted', { environment: 'sandbox' }]);
  const again = await phone.command('push.register', { ...register, environment: 'production' });
  assert.equal(again.type, 'command.accepted');
  assert.deepEqual(registrations(f), [{ device_id: phone.deviceId, token: TOKEN, environment: 'production' }]);

  // Another device's ID in the envelope is refused, as with every command.
  const foreign = phone.deviceId;
  phone.deviceId = 'device-someone-else';
  const mismatch = await phone.command('push.register', register);
  assert.deepEqual([mismatch.type, mismatch.payload.code], ['command.rejected', 'device-mismatch']);
  phone.deviceId = foreign;
  await phone.close();
}));

test('without apns the registration is still kept, and nothing is sent', async () => {
  const f = await startFixture();
  try {
    const { token } = await login(f);
    const phone = await Client.open(f, token);
    await phone.sync();
    const accepted = await phone.command('push.register', { token: TOKEN, publicKey: keyPair().publicKey, environment: 'sandbox' });
    assert.equal(accepted.type, 'command.accepted');
    assert.equal(registrations(f).length, 1);
    assert.ok(f.logs.some(line => line.includes('apns is not configured')), f.logs.join('\n'));
    await phone.close();
  } finally { await f.cleanup(); }
});

test('a phone that is away gets an alert for the reply and the notice, and a background push when the Mac reads', () => withPush(async (f, apns) => {
  const phoneLogin = await login(f);
  const macLogin = await login(f);
  const phone = await Client.open(f, phoneLogin.token);
  await phone.sync();
  const keys = keyPair();
  await phone.command('push.register', { token: TOKEN, publicKey: keys.publicKey, environment: 'sandbox' });
  const mac = await Client.open(f, macLogin.token);
  await mac.sync();
  answerEveryMessage(f);

  // While the phone is connected, it gets the conversation over the WebSocket and no push.
  await talk(mac, 'つながっているとき');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(apns.received.length, 0);

  await phone.close();
  const { reply, notice } = await talk(mac, 'はなれているとき');
  const [first, second] = await apns.waitFor(2);
  const byKind = Object.fromEntries([first!, second!].map(push => [push.body.kind, push]));
  for (const [kind, said, body] of [['reply', reply, '返事があります'], ['notice', notice, '知らせがあります']] as const) {
    const push = byKind[kind]!;
    assert.equal(push.headers[':path'], `/3/device/${TOKEN}`);
    assert.equal(push.headers['apns-push-type'], 'alert');
    assert.equal(push.headers['apns-topic'], 'net.example.natsumi');
    assert.equal(push.body.messageId, said.messageId);
    assert.deepEqual(push.body.aps.alert, { title: 'なつみ', body });
    assert.equal(push.body.aps['mutable-content'], 1);
    assert.equal(push.body.aps.sound, 'default');
    assert.equal(typeof push.body.position, 'number');
    const plain = JSON.parse(openPush({ devicePrivateKey: keys.privateKey, messageId: said.messageId, sealed: push.body.e }).toString());
    // Her face for the line, served for Slack on the public origin (ADR 0057).
    assert.deepEqual(plain, { text: said.text, expression: said.expression,
      icon: `https://natsumi.example.test/avatar/${said.expression ?? 'neutral'}.png` });
  }
  // Two replies unread and two notices unchecked by the time the second push was made.
  assert.equal(Math.max(first!.body.aps.badge, second!.body.aps.badge), 4);

  await mac.command('conversation.read', { throughMessageId: reply.messageId });
  const [, , read] = await apns.waitFor(3);
  assert.equal(read!.headers['apns-push-type'], 'background');
  assert.equal(read!.headers['apns-priority'], '5');
  assert.deepEqual({ ...read!.body, readThroughPosition: typeof read!.body.readThroughPosition },
    { aps: { 'content-available': 1 }, kind: 'read', badge: 2, readThroughPosition: 'number' });

  await mac.command('notification.ack', { notificationId: notice.messageId });
  const [, , , acked] = await apns.waitFor(4);
  assert.equal(acked!.body.kind, 'acked');
  assert.equal(acked!.body.notificationId, notice.messageId);
  assert.equal(acked!.body.badge, 1);
  await mac.close();
}));

test('after the phone logs out or its session expires, nothing is sent to it', () => withPush(async (f, apns) => {
  const phoneLogin = await login(f);
  const phone = await Client.open(f, phoneLogin.token);
  await phone.sync();
  await phone.command('push.register', { token: TOKEN, publicKey: keyPair().publicKey, environment: 'sandbox' });
  await phone.close();
  const macLogin = await login(f);
  const mac = await Client.open(f, macLogin.token);
  await mac.sync();
  answerEveryMessage(f);

  const loggedOut = await f.fetch('/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${phoneLogin.token}` } });
  assert.equal(loggedOut.status, 204);
  await talk(mac, 'ログアウトのあと');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(apns.received.length, 0);
  await mac.close();

  // A second phone whose session runs out while it is away.
  const second = await login(f);
  const phone2 = await Client.open(f, second.token);
  await phone2.sync();
  await phone2.command('push.register', { token: 'd4'.repeat(32), publicKey: keyPair().publicKey, environment: 'sandbox' });
  await phone2.close();
  f.clock.advance(Date.parse(second.expiresAt) - f.clock.now);
  const fresh = await login(f);
  const mac2 = await Client.open(f, fresh.token);
  await mac2.sync();
  await talk(mac2, '期限のあと');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(apns.received.length, 0);
  await mac2.close();
}));

test('APNs saying the token is unregistered removes the registration', () => withPush(async (f, apns) => {
  const phoneLogin = await login(f);
  const phone = await Client.open(f, phoneLogin.token);
  await phone.sync();
  await phone.command('push.register', { token: TOKEN, publicKey: keyPair().publicKey, environment: 'sandbox' });
  await phone.close();
  const mac = await Client.open(f, (await login(f)).token);
  await mac.sync();
  f.model.auto = context => freshPrompt(context) ? { calls: [{ name: 'reply_to_mac', arguments: { text: '返事', expression: 'neutral' } }] } : {};
  apns.answers.push({ status: 410, reason: 'Unregistered' });
  await talk(mac, 'こんにちは');
  await apns.waitFor(1);
  const deadline = Date.now() + 5_000;
  while (registrations(f).length > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(registrations(f), []);
  assert.ok(f.logs.some(line => line.includes('push: removed')), f.logs.join('\n'));
  for (const line of f.logs) assert.ok(!line.includes(TOKEN), 'no whole device token in the log');
  await mac.close();
}));

// ADR 0045, docs/client-contract.md: a reply's images are fetched by ID with the session, like an approval's, and the
// phone that is away is told how many there are at the end of the text.
test('a reply with images lists them, each is fetched only with a live session, and the push marks how many', () => withPush(async (f, apns) => {
  await mkdir(join(f.data, 'work', 'images'), { recursive: true });
  const drawn = pngOf(896, 1152);
  await writeFile(join(f.data, 'work', 'images', 'me.png'), drawn);
  f.model.auto = context => freshPrompt(context) ? { calls: [
    { name: 'reply_to_mac', arguments: { text: '描きました', expression: 'happy', images: ['/work/images/me.png'] } },
  ] } : {};
  const phoneLogin = await login(f);
  const macLogin = await login(f);
  const phone = await Client.open(f, phoneLogin.token);
  await phone.sync();
  const keys = keyPair();
  await phone.command('push.register', { token: TOKEN, publicKey: keys.publicKey, environment: 'sandbox' });
  await phone.close();
  const mac = await Client.open(f, macLogin.token);
  await mac.sync();

  const { reply } = await talk(mac, '絵を見せて');
  const images = reply.images as { imageId: string; mimeType: string; bytes: number; width: number; height: number }[];
  assert.deepEqual(images.map(({ imageId: _id, ...image }) => image), [{ mimeType: 'image/png', bytes: drawn.length, width: 896, height: 1152 }]);
  const snapshot = await mac.sync();
  assert.deepEqual(snapshot.payload.messages.at(-1).images, images);

  const path = `/v1/images/${images[0]!.imageId}`;
  const image = await fetch(`${f.base}${path}`, { headers: { authorization: `Bearer ${macLogin.token}` } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('content-length'), String(drawn.length));
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), drawn);
  assert.equal((await f.fetch(path)).status, 401, 'no session');
  assert.deepEqual((await f.fetch(path, { headers: { authorization: 'Bearer not-a-session' } })).json(), { error: 'unauthorized' });
  const unknown = await f.fetch('/v1/images/image-unknown', { headers: { authorization: `Bearer ${macLogin.token}` } });
  assert.deepEqual([unknown.status, unknown.json()], [404, { error: 'not-found' }]);

  const [push] = await apns.waitFor(1);
  assert.deepEqual(push!.body.aps.alert, { title: 'なつみ', body: '返事があります' });
  const plain = JSON.parse(openPush({ devicePrivateKey: keys.privateKey, messageId: reply.messageId, sealed: push!.body.e }).toString());
  assert.deepEqual(plain, { text: '描きました（画像 1 枚）', expression: 'happy', icon: 'https://natsumi.example.test/avatar/happy.png' });

  await mac.close();
  await f.fetch('/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${macLogin.token}` } });
  assert.equal((await f.fetch(path, { headers: { authorization: `Bearer ${macLogin.token}` } })).status, 401, 'not after logging out');
}));
