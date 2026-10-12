import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { JUDGE_ISSUES, type JudgeClient, type Judgement } from '../src/server/judge.ts';
import { openPush } from '../src/server/push-crypto.ts';
import { apnsTestKey, FakeApns } from './support/fake-apns.ts';
import { FakeSlack, PNG, targetFromAttention, tsAt } from './support/fake-slack.ts';
import { login, PUBLIC_ORIGIN, startFixture, type Fixture } from './support/server-fixture.ts';

/**
 * The dove through the running server (ADR 0040, docs/client-contract.md): a draft Jev hands to the owner becomes an
 * approval every device sees, the phone that is away is pushed, and the owner's decision over the socket sends it.
 */

interface Envelope { type: string; requestId?: string; seq: number; payload: Record<string, any> }

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
    const requestId = `request-${++this.counter}`;
    this.ws.send(JSON.stringify({ v: 1, requestId, deviceId: this.deviceId, type, payload }));
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

class OwnerJev implements JudgeClient {
  asked = 0;
  async judge(): Promise<Judgement> {
    this.asked += 1;
    return { issues: JUDGE_ISSUES.map((issue, index) => ({ name: issue.name, label: issue.label, score: index === 1 ? 0.5 : 0.01 })),
      placement: { choice: 'thread', probabilities: { thread: 0.8, channel: 0.15, broadcast: 0.05 } } };
  }
}

const SLACK = { workspaces: { work: { botTokenEnv: 'SLACK_BOT', appTokenEnv: 'SLACK_APP' } }, judge: { method: 'jev', baseUrl: 'https://judge.example.test' } };

async function withDove(fn: (f: Fixture, slack: FakeSlack, apns: FakeApns, jev: OwnerJev) => Promise<void>) {
  const apns = await new FakeApns().start();
  const slack = new FakeSlack();
  slack.addChannel({ id: 'C1', name: 'dev', isIm: false });
  const jev = new OwnerJev();
  const f = await startFixture({ apns: { origin: apns.origin, pem: apnsTestKey().pem, retryDelaysMs: [1] },
    slack: { section: SLACK, api: slack, judge: jev } });
  // natsumi answers a mention by asking the dove to reply to it, with the file and path of the attention (ADR 0074).
  f.model.auto = context => {
    const last = context.messages.at(-1);
    const to = targetFromAttention(last?.role === 'user' ? JSON.stringify(last.content) : '');
    if (!to) return {};
    return { calls: [{ name: 'ask_agent', arguments: { agent: 'poppo', continue: false,
      message: JSON.stringify({ kind: 'post', to, face: 'happy', text: '架空の返事です。' }) } }] };
  };
  try { await fn(f, slack, apns, jev); } finally {
    await f.cleanup();
    await apns.close();
  }
}

function keyPair() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey().toString('base64') };
}

async function until<T>(check: () => T | undefined | false, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('a draft handed to the owner is an approval on every device and a push to the phone that is away, and her approval sends it', () =>
  withDove(async (f, slack, apns) => {
    const { token } = await login(f);
    const phone = await Client.open(f, token);
    await phone.sync();
    const keys = keyPair();
    await phone.command('push.register', { token: 'ab'.repeat(32), publicKey: keys.publicKey, environment: 'sandbox' });
    await phone.close();
    const mac = await Client.open(f, token);
    const early = await mac.command('approval.decide', { approvalId: 'x', revision: 1, decision: 'approve' });
    assert.deepEqual([early.type, early.payload.code], ['command.rejected', 'sync-required']);
    const snapshot = await mac.sync();
    assert.deepEqual(snapshot.payload.pendingApprovals, []);

    await until(() => slack.started === 1);
    assert.ok(f.logs.includes('slack: the judges are jev (on); jev is adopted'), 'the log names the judges, and not where they go');
    assert.ok(!f.logs.some(line => line.includes('judge.example.test')));
    slack.emit({ type: 'message', channel: 'C1', user: 'U1', text: '<@UBOT> 明日のレビュー大丈夫？', ts: tsAt('2026-09-25T05:32:05Z') });
    const pending = await mac.until(message => message.type === 'approval.pending');
    const approval = pending.payload;
    assert.equal(approval.kind, 'slack-post');
    assert.equal(approval.text, '架空の返事です。');
    assert.equal(approval.target.channel, 'work/#dev');
    assert.equal(approval.reason.verdict, 'owner');
    assert.equal(slack.posts.length, 0);

    const [alert] = await apns.waitFor(1);
    assert.equal(alert!.headers['apns-push-type'], 'alert');
    assert.deepEqual(alert!.body.aps.alert, { title: 'なつみ', body: '承認待ちがあります' });
    assert.equal(alert!.body.aps.badge, 1);
    assert.equal(alert!.body.kind, 'approval');
    assert.equal(alert!.body.approvalId, approval.approvalId);
    assert.deepEqual(JSON.parse(openPush({ devicePrivateKey: keys.privateKey, messageId: approval.approvalId, sealed: alert!.body.e }).toString()),
      { text: '架空の返事です。', channel: 'work/#dev' });
    assert.doesNotMatch(JSON.stringify(alert!.body), /架空の返事/, 'the draft is only in the sealed part');

    const again = await mac.sync();
    assert.deepEqual(again.payload.pendingApprovals, [approval]);

    const stale = await mac.command('approval.decide', { approvalId: approval.approvalId, revision: 2, decision: 'approve' });
    assert.deepEqual([stale.type, stale.payload.code], ['command.rejected', 'stale-revision']);
    for (const payload of [{ approvalId: approval.approvalId, revision: 1, decision: 'maybe' },
      { approvalId: approval.approvalId, revision: '1', decision: 'approve' },
      { approvalId: approval.approvalId, revision: 1, decision: 'edit', text: '   ' },
      { approvalId: approval.approvalId, revision: 1, decision: 'approve', placement: 'dm' }]) {
      const invalid = await mac.command('approval.decide', payload);
      assert.deepEqual([invalid.type, invalid.payload.code], ['command.rejected', 'invalid-request'], JSON.stringify(payload));
    }

    const accepted = await mac.command('approval.decide', { approvalId: approval.approvalId, revision: 1, decision: 'approve', placement: 'broadcast' });
    assert.equal(accepted.type, 'command.accepted');
    assert.deepEqual(accepted.payload, { approvalId: approval.approvalId, revision: 1, state: 'approved' });
    const resolved = await mac.until(message => message.type === 'approval.resolved');
    assert.equal(resolved.payload.delivery, 'sent');
    assert.equal(resolved.payload.sentText, '架空の返事です。');
    assert.deepEqual(slack.posts, [{ channel: 'C1', text: '架空の返事です。', threadTs: tsAt('2026-09-25T05:32:05Z'), replyBroadcast: true,
      iconUrl: `${PUBLIC_ORIGIN}/avatar/happy.png` }]);

    const pushes = await apns.waitFor(2);
    const background = pushes[1]!;
    assert.equal(background.headers['apns-push-type'], 'background');
    assert.deepEqual(background.body, { aps: { 'content-available': 1 }, kind: 'approval-resolved', approvalId: approval.approvalId, badge: 0 });

    const twice = await mac.command('approval.decide', { approvalId: approval.approvalId, revision: 1, decision: 'reject' });
    assert.deepEqual(twice.payload, { approvalId: approval.approvalId, revision: 1, state: 'approved' });
    assert.equal(slack.posts.length, 1);

    // What became of it reached her as attentions under /sources/agents/poppo (ADR 0074): handed to the owner, then
    // sent, with her own post's line in the record of Slack.
    const told = () => f.model.contexts.map(context => JSON.stringify(context.messages.at(-1)?.content ?? ''))
      .filter(text => text.includes('\\"agent\\":\\"poppo\\"'));
    const sent = await until(() => told().find(text => text.includes('\\"state\\":\\"sent\\"')));
    assert.match(sent, /\/sources\/agents\/poppo\/\d{8}T\d{6}Z-[0-9a-f]{4}\/results\.jsonl/);
    assert.match(sent, /\\"slack_file\\":\\"\/sources\/slack\/work\/dev\/2026-09-25\.jsonl\\",\\"slack_path\\":\\"\.\[1\]\\"/);
    assert.ok(told().some(text => text.includes('\\"state\\":\\"to_owner\\"')));
    await mac.close();
  }));

test('the icons are served without a login, one per feeling, and nothing else under /avatar', async () => {
  const f = await startFixture();
  try {
    const icon = await fetch(`${f.base}/avatar/happy.png`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/png');
    assert.match(icon.headers.get('cache-control') ?? '', /public/);
    const body = Buffer.from(await icon.arrayBuffer());
    assert.deepEqual([...body.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const path of ['/avatar/angry.png', '/avatar/happy.webp', '/avatar/../package.json', '/avatar/%2e%2e%2fpackage.json', '/avatar/']) {
      assert.equal((await fetch(`${f.base}${path}`)).status, 404, path);
    }
  } finally { await f.cleanup(); }
});

test('without Slack a snapshot still carries an empty list of approvals, and a decision names no approval there is', async () => {
  const f = await startFixture();
  try {
    const { token } = await login(f);
    const mac = await Client.open(f, token);
    const snapshot = await mac.sync();
    assert.deepEqual(snapshot.payload.pendingApprovals, []);
    const unknown = await mac.command('approval.decide', { approvalId: 'approval-none', revision: 1, decision: 'approve' });
    assert.deepEqual([unknown.type, unknown.payload.code], ['command.rejected', 'invalid-request']);
    await mac.close();
  } finally { await f.cleanup(); }
});

// ADR 0044, docs/client-contract.md: an approval lists its images, and each is fetched by its ID over HTTPS with the session.
test('an approval with an image lists it, and the image is fetched only with a live session', () =>
  withDove(async (f, slack) => {
    await mkdir(join(f.data, 'work', 'images'), { recursive: true });
    await writeFile(join(f.data, 'work', 'images', 'cat.png'), PNG);
    f.model.auto = context => {
      const last = context.messages.at(-1);
      const to = targetFromAttention(last?.role === 'user' ? JSON.stringify(last.content) : '');
      if (!to) return {};
      return { calls: [{ name: 'ask_agent', arguments: { agent: 'poppo', continue: false,
        message: JSON.stringify({ kind: 'post', to, images: ['/work/images/cat.png'], text: '描いてみました。' }) } }] };
    };
    const { token } = await login(f);
    const mac = await Client.open(f, token);
    await mac.sync();
    await until(() => slack.started === 1);
    slack.emit({ type: 'message', channel: 'C1', user: 'U1', text: '<@UBOT> 猫の絵を描いて', ts: tsAt('2026-09-25T05:32:05Z') });
    const pending = await mac.until(message => message.type === 'approval.pending');
    const { images } = pending.payload as { images: { imageId: string; mimeType: string; bytes: number }[] };
    assert.deepEqual(images.map(image => [image.mimeType, image.bytes]), [['image/png', PNG.length]]);
    const path = `/v1/images/${images[0]!.imageId}`;

    const image = await fetch(`${f.base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    // The same ID is the same bytes for good (ADR 0045), but only to the owner: never kept by a shared cache.
    assert.equal(image.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);

    const none = await f.fetch(path);
    assert.deepEqual([none.status, none.headers.get('cache-control')], [401, 'no-store'], 'no session');
    assert.deepEqual((await f.fetch(path, { headers: { authorization: 'Bearer not-a-session' } })).json(), { error: 'unauthorized' });
    for (const other of ['/v1/images/image-unknown', '/v1/images/..%2f..%2fstate.sqlite', `/v1/images/${images[0]!.imageId}/x`]) {
      const answer = await f.fetch(other, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(answer.status, 404, other);
      assert.equal(answer.headers.get('cache-control'), 'no-store', other);
      assert.deepEqual(answer.json(), { error: 'not-found' });
    }
    await mac.close();
    await f.fetch('/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    assert.equal((await f.fetch(path, { headers: { authorization: `Bearer ${token}` } })).status, 401, 'not after logging out');
  }));

// ADR 0059: the settings turn a judge off for the next draft, and the list shows which judges the config has.
test('the settings list the judges as the config has them, and a judge turned off is not asked for the next draft', () =>
  withDove(async (f, slack, _apns, jev) => {
    const { token } = await login(f);
    const mac = await Client.open(f, token);
    const snapshot = await mac.sync();
    const { judgeLogprobs, judgeJev, judgeAdopted } = snapshot.payload.settings;
    assert.deepEqual([judgeLogprobs.value, judgeLogprobs.available], ['off', false], 'pi here has no compatible model to lend');
    assert.deepEqual([judgeJev.value, judgeJev.available], ['on', true]);
    assert.equal(judgeAdopted.value, 'jev');
    const refused = await mac.command('settings.set', { key: 'judgeLogprobs', value: 'on' });
    assert.deepEqual([refused.type, refused.payload.code], ['command.rejected', 'judge-unavailable']);
    assert.equal((await mac.command('settings.set', { key: 'judgeJev', value: 'off' })).type, 'command.accepted');

    await until(() => slack.started === 1);
    slack.emit({ type: 'message', channel: 'C1', user: 'U1', text: '<@UBOT> 明日のレビュー大丈夫？', ts: tsAt('2026-09-25T05:32:05Z') });
    const pending = await mac.until(message => message.type === 'approval.pending');
    assert.equal(pending.payload.reason.verdict, 'no-verdict');
    assert.equal(jev.asked, 0);
    await mac.close();
  }));
