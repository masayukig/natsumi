import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SlackDove } from '../src/server/dove.ts';
import { ImageStore } from '../src/server/images.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { startServer } from '../src/server/server.ts';
import { connectSignal, OwnerTyping, relayToSignal, SignalApprovals, SignalOwner, type SignalApi } from '../src/server/signal.ts';
import { SlackArchive } from '../src/server/slack-archive.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { FakeSlack, tsAt } from './support/fake-slack.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel } from './support/scripted-model.ts';
import { CLIENT_SECRET, serverConfig } from './support/server-fixture.ts';

/** Fork (ADR F04): the owner talks with her over Signal and approves the dove's drafts there. */

const OWNER = '+810000000001';
const BOT = '+810000000002';

async function until<T>(check: () => T | undefined | false, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** A stand-in for the daemon: sends are recorded with increasing timestamps, and events are pushed by the test. */
class FakeSignal implements SignalApi {
  sent: { message: string; attachments?: string[]; at: number }[] = [];
  refuseAttachments = false;
  readMarks: number[] = [];
  private at = 1_790_000_000_000;
  async read(timestamp: number) { this.readMarks.push(timestamp); }
  typings: boolean[] = [];
  async typing(stop?: boolean) { this.typings.push(stop === true); }
  files = new Map<string, Buffer>();
  async attachment(id: string) {
    const data = this.files.get(id);
    if (!data) throw new Error('rpc error -3');
    return data;
  }
  private push: ((event: Record<string, unknown>) => void) | undefined;
  async send(message: string, attachments?: string[]) {
    if (attachments?.length && this.refuseAttachments) throw new Error('rpc error -1');
    this.sent.push({ message, ...(attachments?.length ? { attachments } : {}), at: ++this.at });
    return this.at;
  }
  async *events(signal: AbortSignal) {
    const queue: Record<string, unknown>[] = [];
    let wake = () => {};
    this.push = event => { queue.push(event); wake(); };
    while (!signal.aborted) {
      if (queue.length === 0) await new Promise<void>(resolve => { wake = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); });
      while (queue.length > 0) yield queue.shift()!;
    }
  }
  get listening() { return this.push !== undefined; }
  emit(envelope: Record<string, unknown>) { this.push!({ envelope, account: BOT }); }
}

const text = (message: string, extra: Record<string, unknown> = {}, from = OWNER) => ({
  source: from, sourceNumber: from, sourceUuid: null, timestamp: 1_790_940_371_225,
  dataMessage: { timestamp: 1_790_940_371_225, message, expiresInSeconds: 0, isProfileKeyUpdate: false, ...extra },
});
const reaction = (emoji: string, targetSentTimestamp: number, isRemove = false) => ({
  sourceNumber: OWNER, timestamp: 1_790_940_400_000,
  dataMessage: { timestamp: 1_790_940_400_000, message: null, reaction: { emoji, targetAuthorNumber: BOT, targetSentTimestamp, isRemove } },
});

test('what the owner writes goes to say once per message and is marked read; others, receipts, typing and profile keys are let go', () => {
  const said: { requestId: string; text: string }[] = [];
  const api = new FakeSignal();
  const owner = new SignalOwner({ api, owner: OWNER, say: input => { said.push(input); } });
  const event = (envelope: Record<string, unknown>) => owner.handle({ envelope, account: BOT });
  event(text('元気？'));
  event(text('だれ？', {}, '+810000000009'));
  event({ sourceNumber: OWNER, timestamp: 1, receiptMessage: { when: 1, isDelivery: true, timestamps: [1] } });
  event({ sourceNumber: OWNER, timestamp: 2, typingMessage: { action: 'STARTED', timestamp: 2 } });
  event({ sourceNumber: OWNER, timestamp: 3, dataMessage: { timestamp: 3, message: null, isProfileKeyUpdate: true } });
  event(reaction('👍', 123));
  // Without approvals a quoted reply is just something said.
  event(text('こんにちは', { quote: { id: 123, author: BOT, text: '元の発言' } }));
  assert.deepEqual(said, [{ requestId: 'signal:1790940371225', text: '元気？' }, { requestId: 'signal:1790940371225', text: 'こんにちは' }]);
  assert.deepEqual(api.readMarks, [1_790_940_371_225, 1_790_940_371_225]);
});

test('she shows she is typing from a message on Signal until that turn is done, sent again meanwhile, and never past the limit', async () => {
  const api = new FakeSignal();
  let listener!: (event: { type: string; payload: Record<string, unknown> }) => void;
  const typing = new OwnerTyping({ loop: { subscribe: l => { listener = l; return () => {}; } }, send: stop => api.typing(stop),
    asked: eventId => eventId === 'event-signal', intervalMs: 10, maxMs: 1_000 });
  const owner = new SignalOwner({ api, owner: OWNER, typing, say: () => {} });
  owner.handle({ envelope: text('元気？'), account: BOT });
  await until(() => api.typings.length >= 3);
  const completed = (eventId: string) => listener({ type: 'conversation.event.completed', payload: { eventId, status: 'replied' } });
  completed('event-mac');
  assert.ok(!api.typings.includes(true));
  completed('event-signal');
  const shown = api.typings.length;
  assert.equal(api.typings.at(-1), true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(api.typings.length, shown);
  const limited = new OwnerTyping({ loop: { subscribe: () => () => {} }, send: stop => api.typing(stop), asked: () => false, intervalMs: 5, maxMs: 20 });
  api.typings = [];
  limited.start();
  await until(() => api.typings.at(-1) === true);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(api.typings.filter(stop => stop).length, 1);
  limited.stop();
  typing.stop();
});

test('when she asked an agent since the owner\'s message, typing goes on past the turn until her next line once the agent answered', async () => {
  const api = new FakeSignal();
  let listener!: (event: { type: string; payload: Record<string, unknown> }) => void;
  let waiting = 1;
  const typing = new OwnerTyping({ loop: { subscribe: l => { listener = l; return () => {}; } }, send: stop => api.typing(stop),
    asked: () => true, waitingAgents: () => waiting, intervalMs: 10, maxMs: 1_000 });
  typing.start();
  const natsumi = () => listener({ type: 'conversation.message', payload: { role: 'natsumi', text: '…' } });
  natsumi(); // 「聞いています」 within the turn
  listener({ type: 'conversation.event.completed', payload: { eventId: 'e', status: 'replied' } });
  natsumi(); // still waiting on the agent
  assert.ok(!api.typings.includes(true));
  waiting = 0;
  natsumi();
  assert.equal(api.typings.at(-1), true);
  typing.stop();
});

test('files the owner sends are put in /work/signal, never over one another, and natsumi is told where', async t => {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-signal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, 'work');
  await mkdir(work);
  const said: string[] = [];
  const api = new FakeSignal();
  api.files.set('aaa.pdf', Buffer.from('%PDF-1'));
  api.files.set('bbb.pdf', Buffer.from('%PDF-2'));
  api.files.set('ccc.jpg', Buffer.from('jpeg'));
  const owner = new SignalOwner({ api, owner: OWNER, workDirectory: work, say: ({ text }) => { said.push(text); } });
  const pdf = (id: string) => ({ id, contentType: 'application/pdf', filename: 'report.pdf', size: 6 });
  // Two files of one name in one message, then a photo with no words, then one the daemon no longer has.
  await owner.handle({ envelope: text('読める？', { attachments: [pdf('aaa.pdf'), pdf('bbb.pdf')] }), account: BOT });
  await owner.handle({ envelope: text('', { message: null, attachments: [{ id: 'ccc.jpg', contentType: 'image/jpeg', size: 4 }] }), account: BOT });
  await owner.handle({ envelope: text('これも', { attachments: [{ id: 'gone.png', filename: '../../etc/写真.png' }] }), account: BOT });
  assert.deepEqual(said, [
    '読める？\n（添付「report.pdf」: /work/signal/20261002T112611Z-report.pdf、application/pdf、1 KB。本文は pdftotext、ページの画像は pdftoppm -png -r 100 で作って view で見る）\n'
      + '（添付「report.pdf」: /work/signal/20261002T112611Z-report-2.pdf、application/pdf、1 KB。本文は pdftotext、ページの画像は pdftoppm -png -r 100 で作って view で見る）',
    '（添付「添付 1」: /work/signal/20261002T112611Z-ccc.jpg、image/jpeg、1 KB）',
    'これも\n（添付「../../etc/写真.png」は受け取れませんでした: Signal から取り出せませんでした）',
  ]);
  assert.equal((await readFile(join(work, 'signal', '20261002T112611Z-report.pdf'))).toString(), '%PDF-1');
  assert.equal((await readFile(join(work, 'signal', '20261002T112611Z-report-2.pdf'))).toString(), '%PDF-2');
  assert.deepEqual(api.readMarks, [1_790_940_371_225, 1_790_940_371_225, 1_790_940_371_225]);
});

test('her replies go to Signal only when asked on Signal; notices and replies to nothing go too, and images fall back to text', async () => {
  const api = new FakeSignal();
  let listener!: (event: { type: string; payload: Record<string, unknown> }) => void;
  const logs: string[] = [];
  relayToSignal({ loop: { subscribe: l => { listener = l; return () => {}; } }, api, log: line => { logs.push(line); },
    images: { read: async () => ({ mimeType: 'image/png', data: Buffer.from('png') }) },
    askedOnSignal: eventId => eventId === 'event-signal' });
  const say = (payload: Record<string, unknown>) => listener({ type: 'conversation.message', payload: { role: 'natsumi', ...payload } });
  say({ text: 'Signal への返事', replyTo: 'event-signal' });
  say({ text: 'Mac への返事', replyTo: 'event-mac' });
  say({ text: 'お知らせ' });
  listener({ type: 'conversation.message', payload: { role: 'owner', text: 'マスターの発言' } });
  say({ text: '絵です', images: [{ imageId: 'i1' }] });
  await until(() => api.sent.length === 3);
  api.refuseAttachments = true;
  say({ text: 'また絵です', images: [{ imageId: 'i2' }] });
  await until(() => api.sent.length === 4);
  assert.deepEqual(api.sent.map(sent => [sent.message, sent.attachments]), [
    ['Signal への返事', undefined], ['お知らせ', undefined], ['絵です', [`data:image/png;base64,${Buffer.from('png').toString('base64')}`]],
    ['また絵です', undefined],
  ]);
  assert.match(logs.join('\n'), /sending with images failed/);
});

async function doveSetup(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-signal-')));
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const clock = { now: Date.parse('2026-09-25T06:00:00Z') };
  const archive = new SlackArchive({ db, directory: join(root, 'slack'), timeZone: 'Asia/Tokyo', now: () => clock.now });
  archive.addChannel('work', 'C1', { name: 'dev', isIm: false });
  await archive.record('work', 'C1', { ts: tsAt('2026-09-25T05:32:05Z'), speaker: '山田', own: false, text: '明日 OK？', files: [], edited: false });
  const slack = new FakeSlack();
  const logs: string[] = [];
  // No judge: every draft goes to the owner.
  const dove = new SlackDove({
    db, archive, workspaces: { work: slack }, publicOrigin: 'https://natsumi.example.test', workDirectory: join(root, 'work'),
    images: new ImageStore(db, join(root, 'images')), now: () => clock.now, log: line => { logs.push(line); }, raise: () => {},
    judges: {}, judgeChoice: () => ({ logprobs: false, jev: false, adopted: 'jev' }),
    config: { approvalDays: 7, placementFollowing: 2, judgeContext: { messages: 5, chars: 500 }, images: { maxBytes: 1024, maxCount: 2 } },
  });
  const api = new FakeSignal();
  const approvals = new SignalApprovals({ db, dove, api, timeZone: 'Asia/Tokyo', log: line => { logs.push(line); } });
  const owner = new SignalOwner({ api, owner: OWNER, approvals, say: () => { throw new Error('not said'); } });
  t.after(async () => {
    approvals.stop();
    dove.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const draft = async () => {
    await dove.ask('返信先: work/#dev 2026-09-25 14:32:05 山田\n種類: 投稿\n---\n大丈夫です');
    await dove.idle();
    await approvals.idle();
    return dove.pendingApprovals().at(-1)!.approvalId;
  };
  const settle = async () => { await dove.idle(); await approvals.idle(); await dove.idle(); await approvals.idle(); };
  const state = (id: string) => ({ ...db.prepare('SELECT state, device_id FROM approvals WHERE approval_id = ?').get(id) as { state: string; device_id: string } });
  return { db, api, slack, dove, approvals, owner, draft, settle, state, logs };
}

test('a draft is sent to the owner once; a 👍 on it sends the post, and a short line says so', async t => {
  const f = await doveSetup(t);
  const id = await f.draft();
  f.approvals.sync();
  await f.approvals.idle();
  assert.equal(f.api.sent.length, 1);
  assert.match(f.api.sent[0]!.message, /承認待ちの投稿: work\/#dev への投稿\n返信先: 山田.*\n---\n大丈夫です\n---\n理由: 判定できなかった/);
  f.owner.handle({ envelope: reaction('👍', f.api.sent[0]!.at + 1) }); // not our message: nothing
  f.owner.handle({ envelope: reaction('👍', f.api.sent[0]!.at, true) }); // taken off: nothing
  f.owner.handle({ envelope: reaction('🎉', f.api.sent[0]!.at) }); // another emoji: nothing
  await f.settle();
  assert.equal(f.state(id).state, 'pending');
  f.owner.handle({ envelope: reaction('👍', f.api.sent[0]!.at) });
  await f.settle();
  assert.deepEqual(f.state(id), { state: 'approved', device_id: 'signal' });
  assert.equal(f.slack.posts.length, 1, 'the dove sent it');
  await until(() => f.api.sent.length === 2);
  assert.equal(f.api.sent[1]!.message, '→ 送った: work/#dev への投稿');
  // A second decision changes nothing.
  f.owner.handle({ envelope: reaction('👎', f.api.sent[0]!.at) });
  await f.settle();
  assert.equal(f.state(id).state, 'approved');
  assert.equal(f.api.sent.length, 2);
});

test('a 👎, a ❌ or a quoted 見送る declines; a quoted reply that is not an answer goes to natsumi', async t => {
  const f = await doveSetup(t);
  for (const decline of [
    (at: number) => reaction('👎🏻', at), (at: number) => reaction('❌', at),
    (at: number) => text(' 見送る ', { quote: { id: at, author: BOT } }),
  ]) {
    const id = await f.draft();
    const at = f.api.sent.at(-1)!.at;
    f.owner.handle({ envelope: decline(at) });
    await f.settle();
    assert.deepEqual(f.state(id), { state: 'rejected', device_id: 'signal' });
    assert.equal(f.api.sent.at(-1)!.message, '→ 見送った: work/#dev への投稿');
  }
  const id = await f.draft();
  assert.throws(() => f.owner.handle({ envelope: text('どういうこと？', { quote: { id: f.api.sent.at(-1)!.at, author: BOT } }) }), /not said/);
  assert.equal(f.state(id).state, 'pending');
});

test('connectSignal reads the daemon\'s event stream and sends with JSON-RPC; the stream is opened again after it drops', async t => {
  const rpc: Record<string, unknown>[] = [];
  let streams = 0;
  const open: ServerResponse[] = [];
  const server = createServer((request, response) => {
    if (request.url === '/api/v1/rpc') {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        rpc.push(JSON.parse(body));
        response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { results: [{ type: 'SUCCESS' }], timestamp: 42 } }));
      });
      return;
    }
    assert.equal(request.url, `/api/v1/events?account=${encodeURIComponent(BOT)}`);
    streams += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`event:receive\ndata:${JSON.stringify({ envelope: text(`その${streams}`), account: BOT })}\n\n`);
    if (streams === 1) response.end(); else open.push(response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { open.forEach(response => response.end()); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api = connectSignal({ url, account: BOT, owner: OWNER });
  assert.equal(await api.send('やあ'), 42);
  assert.deepEqual(rpc[0]!.params, { account: BOT, recipient: [OWNER], message: 'やあ' });
  assert.equal(rpc[0]!.method, 'send');
  const said: string[] = [];
  const owner = new SignalOwner({ api, owner: OWNER, backoffMs: 10, say: ({ text }) => { said.push(text); } });
  owner.start();
  await until(() => said.length === 2);
  assert.deepEqual(said, ['その1', 'その2']);
  await owner.stop();
});

test('with only a signal section, the owner talks with her over Signal and her reply comes back there', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-server-signal-')));
  const data = join(root, 'data');
  await mkdir(data);
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ ...serverConfig(root),
    signal: { url: 'http://127.0.0.1:1', account: BOT, owner: OWNER, approvals: true } }));
  const model = new ScriptedModel();
  model.auto = context => context.messages.at(-1)?.role === 'user'
    ? { calls: [{ name: 'reply_to_mac', arguments: { text: '元気だよ', expression: 'happy' } }] } : {};
  const api = new FakeSignal();
  const logs: string[] = [];
  const server = await startServer({
    config, dataDir: data, cwd: '/', home: join(root, 'home'), env: { NATSUMI_GITHUB_CLIENT_SECRET: CLIENT_SECRET },
    log: line => { logs.push(line); },
    pi: { runtime: fixtureRuntime, configureSession: session => { session.agent.streamFunction = model.streamFunction; } },
    signal: { api },
  });
  t.after(async () => {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  });
  assert.match(logs.join('\n'), /signal: approvals are on, but there is no dove without slack/);
  await until(() => api.listening);
  api.emit(text('元気？'));
  await until(() => api.sent.length === 1);
  assert.equal(api.sent[0]!.message, '元気だよ');
  assert.match(JSON.stringify(model.contexts[0]), /マスターと Signal/);
});
