import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { ApnsRequest, ApnsResponse } from '../src/server/apns.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { APNS_PAYLOAD_MAX_BYTES, parseRegistration, PushNotifier, PushRegistrations, type PushEvent } from '../src/server/push.ts';
import { openPush } from '../src/server/push-crypto.ts';
import { migrate } from '../src/server/state-db.ts';

const OWNER = 4242001;
const NOW = Date.parse('2026-01-01T00:00:00Z');
const TOKEN_A = 'a1'.repeat(32);
const TOKEN_B = 'b2'.repeat(32);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function keyPair() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey() };
}

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, MIGRATIONS);
  return db;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A device whose last sync was made with a session in the given state. */
function device(db: DatabaseSync, deviceId: string, session: { expiresAt?: number; revoked?: boolean; user?: number } = {}) {
  const sessionId = `session-${deviceId}`;
  db.prepare(`INSERT INTO client_sessions (session_id, token_hash, github_user_id, created_at, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(sessionId, `hash-${deviceId}`, session.user ?? OWNER, iso(NOW), iso(session.expiresAt ?? NOW + 3_600_000),
    session.revoked ? iso(NOW) : null);
  db.prepare(`INSERT INTO devices (device_id, github_user_id, client_session_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`)
    .run(deviceId, session.user ?? OWNER, sessionId, iso(NOW), iso(NOW));
}

let position = 0;
function message(db: DatabaseSync, kind: 'message' | 'reply' | 'notice', text: string, expression: string | null = 'happy') {
  position += 1;
  const messageId = `message-${position}-${Math.random().toString(36).slice(2)}`;
  const role = kind === 'message' ? 'owner' : 'natsumi';
  db.prepare(`INSERT INTO conversation_messages (message_id, position, role, kind, text, event_id, request_id, device_id, expression, created_at)
    VALUES (?, (SELECT COALESCE(MAX(position), 0) + 1 FROM conversation_messages), ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    messageId, role, kind, text, kind === 'notice' ? null : `event-${messageId}`, kind === 'message' ? `request-${messageId}` : null,
    kind === 'message' ? 'device-mac' : null, kind === 'message' ? null : expression, iso(NOW));
  const row = db.prepare('SELECT position FROM conversation_messages WHERE message_id = ?').get(messageId) as { position: number };
  return { messageId, role, kind, text, createdAt: iso(NOW), position: row.position, ...(expression && kind !== 'message' ? { expression } : {}) };
}

// Registration input.

test('a registration takes a hex device token, an uncompressed P-256 key in base64 and the APNs environment', () => {
  const publicKey = keyPair().publicKey.toString('base64');
  assert.deepEqual(parseRegistration({ token: TOKEN_A, publicKey, environment: 'sandbox' }),
    { token: TOKEN_A, publicKey: Buffer.from(publicKey, 'base64'), environment: 'sandbox' });
  assert.equal(parseRegistration({ token: TOKEN_A.toUpperCase(), publicKey, environment: 'production' })?.token, TOKEN_A,
    'the token is kept in lower case');
  const bad: unknown[] = [
    {}, { publicKey, environment: 'sandbox' },
    { token: '', publicKey, environment: 'sandbox' },
    { token: 'zz'.repeat(32), publicKey, environment: 'sandbox' },
    { token: `${TOKEN_A}0`, publicKey, environment: 'sandbox' },
    { token: `${TOKEN_A.slice(0, 20)}/../${TOKEN_A.slice(20)}`, publicKey, environment: 'sandbox' },
    { token: 'ab'.repeat(101), publicKey, environment: 'sandbox' },
    { token: 'ab'.repeat(7), publicKey, environment: 'sandbox' },
    { token: TOKEN_A, environment: 'sandbox' },
    { token: TOKEN_A, publicKey: 'not base64', environment: 'sandbox' },
    { token: TOKEN_A, publicKey: Buffer.alloc(65, 4).toString('base64'), environment: 'sandbox' },
    { token: TOKEN_A, publicKey: keyPair().publicKey.subarray(0, 64).toString('base64'), environment: 'sandbox' },
    { token: TOKEN_A, publicKey },
    { token: TOKEN_A, publicKey, environment: 'development' },
    { token: TOKEN_A, publicKey, environment: 'Sandbox' },
    { token: 42, publicKey, environment: 'sandbox' },
  ];
  for (const payload of bad) assert.equal(parseRegistration(payload), undefined, JSON.stringify(payload));
});

test('one registration per device, overwritten in place; a token moves to the device that registered it last', () => {
  const db = database();
  device(db, 'device-a');
  device(db, 'device-b');
  const registrations = new PushRegistrations(db, () => NOW);
  const first = parseRegistration({ token: TOKEN_A, publicKey: keyPair().publicKey.toString('base64'), environment: 'sandbox' })!;
  const second = parseRegistration({ token: TOKEN_B, publicKey: keyPair().publicKey.toString('base64'), environment: 'production' })!;
  registrations.save('device-a', first);
  registrations.save('device-a', first);
  registrations.save('device-a', second);
  const rows = db.prepare('SELECT device_id, token, environment FROM push_registrations').all();
  assert.deepEqual(rows.map(row => ({ ...row })), [{ device_id: 'device-a', token: TOKEN_B, environment: 'production' }]);
  // Reinstalling the app gives a new device the same token: only one of them may be sent to.
  registrations.save('device-b', second);
  assert.deepEqual(db.prepare('SELECT device_id FROM push_registrations').all().map(row => row.device_id), ['device-b']);
});

test('only devices whose last session is live, unrevoked and of the allowed account are targets', () => {
  const db = database();
  device(db, 'device-live');
  device(db, 'device-revoked', { revoked: true });
  device(db, 'device-expired', { expiresAt: NOW });
  device(db, 'device-other', { user: OWNER + 1 });
  device(db, 'device-unregistered');
  const registrations = new PushRegistrations(db, () => NOW);
  ['device-live', 'device-revoked', 'device-expired', 'device-other'].forEach((id, i) => {
    registrations.save(id, parseRegistration({ token: `0${i + 1}`.repeat(32), publicKey: keyPair().publicKey.toString('base64'), environment: 'sandbox' })!);
  });
  assert.deepEqual(registrations.targets(OWNER).map(target => target.deviceId), ['device-live']);
});

test('a registration is removed only while it still holds the token that failed', () => {
  const db = database();
  device(db, 'device-a');
  const registrations = new PushRegistrations(db, () => NOW);
  const publicKey = keyPair().publicKey.toString('base64');
  registrations.save('device-a', parseRegistration({ token: TOKEN_B, publicKey, environment: 'sandbox' })!);
  assert.equal(registrations.remove('device-a', TOKEN_A), false);
  assert.equal(registrations.targets(OWNER).length, 1);
  assert.equal(registrations.remove('device-a', TOKEN_B), true);
  assert.equal(registrations.targets(OWNER).length, 0);
});

// Sending.

class FakeLoop {
  private listener: ((event: PushEvent) => void) | undefined;
  subscribe(listener: (event: PushEvent) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
  emit(type: string, payload: Record<string, unknown>) { this.listener?.({ type, payload }); }
  get listening() { return this.listener !== undefined; }
}

class FakeSender {
  readonly requests: ApnsRequest[] = [];
  readonly answers: (ApnsResponse | Error)[] = [];
  async send(request: ApnsRequest): Promise<ApnsResponse> {
    this.requests.push(request);
    const answer = this.answers.shift() ?? { status: 200 };
    if (answer instanceof Error) throw answer;
    return answer;
  }
  async waitFor(count: number) {
    const deadline = Date.now() + 5_000;
    while (this.requests.length < count) {
      if (Date.now() > deadline) throw new Error(`timed out; ${this.requests.length} of ${count} sent`);
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    return this.requests;
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 30));

function setup(options: { connected?: string[]; retryDelaysMs?: number[]; iconOrigin?: string } = {}) {
  const db = database();
  const loop = new FakeLoop();
  const sender = new FakeSender();
  const logs: string[] = [];
  const registrations = new PushRegistrations(db, () => NOW);
  const keys = { a: keyPair(), b: keyPair() };
  device(db, 'device-a');
  device(db, 'device-b');
  device(db, 'device-mac');
  registrations.save('device-a', parseRegistration({ token: TOKEN_A, publicKey: keys.a.publicKey.toString('base64'), environment: 'sandbox' })!);
  registrations.save('device-b', parseRegistration({ token: TOKEN_B, publicKey: keys.b.publicKey.toString('base64'), environment: 'production' })!);
  const connected = new Set(options.connected ?? []);
  const notifier = new PushNotifier({
    db, loop, registrations, sender, allowedUserId: OWNER, isConnected: deviceId => connected.has(deviceId),
    log: line => { logs.push(line); }, retryDelaysMs: options.retryDelaysMs ?? [1, 1, 1],
    ...(options.iconOrigin === undefined ? {} : { iconOrigin: options.iconOrigin }),
  });
  return { db, loop, sender, logs, registrations, keys, connected, notifier };
}

test('a reply is pushed as an alert to every registered device that is not connected', async () => {
  const { db, loop, sender, keys, notifier } = setup({ connected: ['device-b'] });
  try {
    const { position: at, ...reply } = message(db, 'reply', '晴れです', 'happy');
    loop.emit('conversation.message', reply);
    const [request] = await sender.waitFor(1);
    await settle();
    assert.equal(sender.requests.length, 1, 'the connected device gets the event instead');
    assert.equal(request!.environment, 'sandbox');
    assert.equal(request!.token, TOKEN_A);
    assert.equal(request!.pushType, 'alert');
    assert.match(request!.id!, UUID);
    const { e, ...rest } = request!.payload as Record<string, any>;
    assert.deepEqual(rest, {
      aps: { alert: { title: 'なつみ', body: '返事があります' }, 'mutable-content': 1, badge: 1, sound: 'default' },
      messageId: reply.messageId, kind: 'reply', position: at,
    });
    const opened = openPush({ devicePrivateKey: keys.a.privateKey, messageId: reply.messageId, sealed: e });
    assert.deepEqual(JSON.parse(opened.toString()), { text: '晴れです', expression: 'happy' });
  } finally { notifier.close(); }
});

test('a notice says so, and the badge counts unread replies and unacknowledged notices', async () => {
  const { db, loop, sender, keys, notifier } = setup();
  try {
    message(db, 'message', '本人のメッセージ');
    message(db, 'reply', '返事 1');
    const { position: at, ...notice } = message(db, 'notice', 'お知らせ', 'worried');
    loop.emit('conversation.message', notice);
    const requests = await sender.waitFor(2);
    const toA = requests.find(r => r.token === TOKEN_A)!;
    const payload = toA.payload as Record<string, any>;
    assert.deepEqual(payload.aps.alert, { title: 'なつみ', body: '知らせがあります' });
    assert.equal(payload.aps.badge, 2);
    assert.equal(payload.kind, 'notice');
    assert.equal(payload.position, at);
    assert.deepEqual(JSON.parse(openPush({ devicePrivateKey: keys.a.privateKey, messageId: notice.messageId, sealed: payload.e }).toString()),
      { text: 'お知らせ', expression: 'worried' });
    const toB = requests.find(r => r.token === TOKEN_B)!;
    assert.equal(toB.environment, 'production');
    assert.throws(() => openPush({ devicePrivateKey: keys.a.privateKey, messageId: notice.messageId, sealed: (toB.payload as any).e }),
      'each device gets its own ciphertext');
  } finally { notifier.close(); }
});

test('an owner message and other events are not pushed', async () => {
  const { db, loop, sender, notifier } = setup();
  try {
    const { position: _, ...owner } = message(db, 'message', '本人');
    loop.emit('conversation.message', owner);
    loop.emit('avatar.expression', { expression: 'thinking' });
    loop.emit('conversation.thinking', { line: '考え中' });
    loop.emit('conversation.event.completed', { eventId: 'event-x', messageId: 'message-x', status: 'replied' });
    await settle();
    assert.equal(sender.requests.length, 0);
  } finally { notifier.close(); }
});

test('moving the read cursor sends a background push with the badge and the cursor position', async () => {
  const { db, loop, sender, notifier } = setup({ connected: ['device-b'] });
  try {
    message(db, 'reply', '返事 1');
    const read = message(db, 'reply', '返事 2');
    message(db, 'notice', '知らせ');
    db.prepare(`INSERT INTO read_cursor (owner, message_id, device_id, updated_at) VALUES (1, ?, 'device-mac', ?)`).run(read.messageId, iso(NOW));
    loop.emit('conversation.read', { readThroughMessageId: read.messageId, unreadReplyCount: 0 });
    const [request] = await sender.waitFor(1);
    assert.equal(request!.pushType, 'background');
    assert.equal(request!.token, TOKEN_A);
    assert.deepEqual(request!.payload, { aps: { 'content-available': 1 }, kind: 'read', badge: 1, readThroughPosition: read.position });
  } finally { notifier.close(); }
});

test('acknowledging a notice sends a background push with the badge, the cursor position and the notice', async () => {
  const { db, loop, sender, notifier } = setup({ connected: ['device-b'] });
  try {
    const notice = message(db, 'notice', '知らせ');
    message(db, 'reply', '返事');
    db.prepare(`INSERT INTO notice_acknowledgements (message_id, device_id, acknowledged_at) VALUES (?, 'device-mac', ?)`).run(notice.messageId, iso(NOW));
    loop.emit('notification.acked', { notificationId: notice.messageId, acknowledgedAt: iso(NOW) });
    const [request] = await sender.waitFor(1);
    assert.equal(request!.pushType, 'background');
    // No cursor yet: the position is left out rather than sent as null.
    assert.deepEqual(request!.payload, { aps: { 'content-available': 1 }, kind: 'acked', badge: 1, notificationId: notice.messageId });
  } finally { notifier.close(); }
});

test('the longest reply still fits the APNs payload limit, shortened further when its characters are wide', async () => {
  const { db, loop, sender, keys, notifier } = setup();
  try {
    for (const text of ['あ'.repeat(1500), '😀'.repeat(1500), 'a'.repeat(1500), '"\\'.repeat(800)]) {
      const { position: _, ...reply } = message(db, 'reply', text, 'neutral');
      const before = sender.requests.length;
      loop.emit('conversation.message', reply);
      const requests = await sender.waitFor(before + 2);
      for (const request of requests.slice(before)) {
        assert.ok(Buffer.byteLength(JSON.stringify(request.payload)) <= APNS_PAYLOAD_MAX_BYTES, `${text.slice(0, 3)}: too large`);
      }
      const toA = requests.slice(before).find(r => r.token === TOKEN_A)!;
      const sent = JSON.parse(openPush({ devicePrivateKey: keys.a.privateKey, messageId: reply.messageId, sealed: (toA.payload as any).e }).toString());
      const chars = [...sent.text];
      assert.ok(chars.length <= 1000);
      assert.equal(chars.at(-1), '…');
      assert.ok(text.startsWith(chars.slice(0, -1).join('')));
      if (text.startsWith('a')) assert.equal(chars.length, 1000, 'narrow text is cut at 1000 characters only');
    }
  } finally { notifier.close(); }
});

test('5xx, 429 and failed connections are sent again a few times, then given up with a log line', async () => {
  const { db, loop, sender, logs, notifier } = setup({ connected: ['device-b'] });
  try {
    sender.answers.push({ status: 503 }, { status: 429, reason: 'TooManyRequests' }, new Error('connect ECONNREFUSED'));
    const { position: _, ...reply } = message(db, 'reply', '秘密の本文-5521');
    loop.emit('conversation.message', reply);
    await sender.waitFor(4);
    await settle();
    assert.equal(sender.requests.length, 4, 'delivered on the fourth try');
    assert.ok(sender.requests.every(r => r.id === sender.requests[0]!.id), 'the same apns-id on every try');

    sender.answers.push({ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 });
    const { position: __, ...again } = message(db, 'reply', '秘密の本文-5522');
    loop.emit('conversation.message', again);
    await sender.waitFor(8);
    await settle();
    assert.equal(sender.requests.length, 8, 'one try and three more, no fifth');
    assert.ok(logs.some(line => /push: gave up/.test(line) && line.includes('device-a')), logs.join('\n'));
    for (const line of logs) {
      assert.ok(!line.includes(TOKEN_A), 'no whole device token in the log');
      assert.ok(!line.includes('秘密の本文'), 'no text in the log');
    }
  } finally { notifier.close(); }
});

test('410 and BadDeviceToken remove the registration; another client error is logged and not tried again', async () => {
  const { db, loop, sender, logs, registrations, notifier } = setup();
  try {
    sender.answers.push({ status: 410, reason: 'Unregistered' }, { status: 400, reason: 'BadDeviceToken' });
    const { position: _, ...reply } = message(db, 'reply', '返事');
    loop.emit('conversation.message', reply);
    await sender.waitFor(2);
    await settle();
    assert.deepEqual(registrations.targets(OWNER), []);
    assert.equal(sender.requests.length, 2);
    assert.equal(logs.filter(line => /push: removed/.test(line)).length, 2);
  } finally { notifier.close(); }

  const second = setup();
  try {
    second.sender.answers.push({ status: 400, reason: 'BadTopic' }, { status: 403, reason: 'InvalidProviderToken' });
    const { position: _, ...reply } = message(second.db, 'reply', '返事');
    second.loop.emit('conversation.message', reply);
    await second.sender.waitFor(2);
    await settle();
    assert.equal(second.sender.requests.length, 2);
    assert.equal(second.registrations.targets(OWNER).length, 2);
    assert.ok(second.logs.some(line => line.includes('BadTopic')));
  } finally { second.notifier.close(); }
});

test('a sender that throws at once never reaches the loop, and closing stops listening and cancels the waiting tries', async () => {
  const { db, loop, sender, notifier } = setup({ retryDelaysMs: [60_000] });
  sender.send = () => { throw new Error('synchronous failure'); };
  const { position: _, ...reply } = message(db, 'reply', '返事');
  assert.doesNotThrow(() => loop.emit('conversation.message', reply));
  await settle();
  notifier.close();
  assert.equal(loop.listening, false);
  // Nothing keeps the process alive: node:test would report a pending timer as a hang.
});

// ADR 0045: the alert stays text alone; a reply with images says how many at the end of its text, the mark kept whole.
test('a reply with images carries a mark of how many at the end of its text, kept whole when the text is cut', async () => {
  const { db, loop, sender, keys, notifier } = setup({ connected: ['device-b'] });
  try {
    const image = { imageId: 'image-1', mimeType: 'image/png', bytes: 10 };
    const opened = async (text: string, images: object[] | undefined) => {
      const { position: _, ...reply } = message(db, 'reply', text, 'happy');
      const before = sender.requests.length;
      loop.emit('conversation.message', images ? { ...reply, images } : reply);
      const [request] = (await sender.waitFor(before + 1)).slice(before);
      assert.ok(Buffer.byteLength(JSON.stringify(request!.payload)) <= APNS_PAYLOAD_MAX_BYTES);
      assert.equal((request!.payload as any).aps.alert.body, '返事があります');
      return JSON.parse(openPush({ devicePrivateKey: keys.a.privateKey, messageId: reply.messageId, sealed: (request!.payload as any).e })
        .toString()) as { text: string };
    };
    assert.deepEqual(await opened('描きました', [image, { ...image, imageId: 'image-2' }]), { text: '描きました（画像 2 枚）', expression: 'happy' });
    assert.equal((await opened('描きました', [image])).text, '描きました（画像 1 枚）');
    assert.equal((await opened('描きました', undefined)).text, '描きました');
    assert.equal((await opened('描きました', [])).text, '描きました');
    for (const long of ['a'.repeat(1500), 'あ'.repeat(1500)]) {
      const chars = [...(await opened(long, [image])).text];
      assert.ok(chars.length <= 1000);
      assert.equal(chars.slice(-9).join(''), '…（画像 1 枚）');
    }
  } finally { notifier.close(); }
});

test('with a public origin, a reply or a notice seals the URL of her face for its feeling, neutral when it has none', async () => {
  const { db, loop, sender, keys, notifier } = setup({ connected: ['device-b'], iconOrigin: 'https://natsumi.example.net' });
  const opened = async (kind: 'reply' | 'notice', expression: string | null) => {
    const { position: _, ...line } = message(db, kind, '晴れです', expression);
    const before = sender.requests.length;
    loop.emit('conversation.message', line);
    const [request] = (await sender.waitFor(before + 1)).slice(before);
    return JSON.parse(openPush({ devicePrivateKey: keys.a.privateKey, messageId: line.messageId, sealed: (request!.payload as any).e })
      .toString()) as Record<string, unknown>;
  };
  try {
    assert.deepEqual(await opened('reply', 'happy'),
      { text: '晴れです', expression: 'happy', icon: 'https://natsumi.example.net/avatar/happy.png' });
    assert.deepEqual(await opened('notice', 'worried'),
      { text: '晴れです', expression: 'worried', icon: 'https://natsumi.example.net/avatar/worried.png' });
    // A line with no feeling recorded wears the neutral face, as the app showed it before.
    assert.deepEqual(await opened('reply', null), { text: '晴れです', icon: 'https://natsumi.example.net/avatar/neutral.png' });
  } finally { notifier.close(); }
});

test('without a public origin no face is sealed, and the face travels only inside the ciphertext', async () => {
  const { db, loop, sender, keys, notifier } = setup({ connected: ['device-b'] });
  try {
    const { position: _, ...reply } = message(db, 'reply', '晴れです', 'happy');
    loop.emit('conversation.message', reply);
    const [request] = await sender.waitFor(1);
    const payload = request!.payload as Record<string, any>;
    assert.deepEqual(JSON.parse(openPush({ devicePrivateKey: keys.a.privateKey, messageId: reply.messageId, sealed: payload.e }).toString()),
      { text: '晴れです', expression: 'happy' });
  } finally { notifier.close(); }
  const withFace = setup({ connected: ['device-b'], iconOrigin: 'https://natsumi.example.net' });
  try {
    const { position: _, ...reply } = message(withFace.db, 'reply', '晴れです', 'happy');
    withFace.loop.emit('conversation.message', reply);
    const [request] = await withFace.sender.waitFor(1);
    const { e: _e, ...plain } = request!.payload as Record<string, unknown>;
    assert.ok(!JSON.stringify(plain).includes('avatar'), 'the face is not in the clear');
  } finally { withFace.notifier.close(); }
});

test('the face of the longest reply stays whole within the APNs payload limit; the text is what is cut', async () => {
  const { db, loop, sender, keys, notifier } = setup({ iconOrigin: 'https://natsumi.example.net' });
  try {
    for (const text of ['あ'.repeat(1500), '😀'.repeat(1500), '"\\'.repeat(800)]) {
      const { position: _, ...reply } = message(db, 'reply', text, 'surprised');
      const before = sender.requests.length;
      loop.emit('conversation.message', { ...reply, images: [{ imageId: 'image-1', mimeType: 'image/png', bytes: 10 }] });
      const requests = (await sender.waitFor(before + 2)).slice(before);
      for (const request of requests) assert.ok(Buffer.byteLength(JSON.stringify(request.payload)) <= APNS_PAYLOAD_MAX_BYTES);
      const toA = requests.find(r => r.token === TOKEN_A)!;
      const sent = JSON.parse(openPush({ devicePrivateKey: keys.a.privateKey, messageId: reply.messageId, sealed: (toA.payload as any).e }).toString());
      assert.equal(sent.icon, 'https://natsumi.example.net/avatar/surprised.png');
      assert.ok(sent.text.endsWith('…（画像 1 枚）'));
    }
  } finally { notifier.close(); }
});

test('an approval seals no face, as before', async () => {
  const db = database();
  const loop = new FakeLoop();
  const approvals = new FakeLoop();
  const sender = new FakeSender();
  const registrations = new PushRegistrations(db, () => NOW);
  const key = keyPair();
  device(db, 'device-a');
  registrations.save('device-a', parseRegistration({ token: TOKEN_A, publicKey: key.publicKey.toString('base64'), environment: 'sandbox' })!);
  const notifier = new PushNotifier({ db, loop, approvals, registrations, sender, allowedUserId: OWNER, isConnected: () => false,
    log: () => {}, iconOrigin: 'https://natsumi.example.net' });
  try {
    approvals.emit('approval.pending', { approvalId: 'approval-1', text: '下書き', target: { channel: 'work/#dev' } });
    const [request] = await sender.waitFor(1);
    assert.deepEqual(JSON.parse(openPush({ devicePrivateKey: key.privateKey, messageId: 'approval-1', sealed: (request!.payload as any).e })
      .toString()), { text: '下書き', channel: 'work/#dev' });
  } finally { notifier.close(); }
});
