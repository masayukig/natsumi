import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { DeliveryUnknown, SlackDove } from '../src/server/dove.ts';
import { JUDGE_ISSUES, type JudgeClient, type Judgement } from '../src/server/judge.ts';
import { ImageStore } from '../src/server/images.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { startServer } from '../src/server/server.ts';
import { connectSignal, OwnerTyping, relayToSignal, SentLines, SignalApprovals, SignalOwner, type SignalApi } from '../src/server/signal.ts';
import { SignalGroups, type ListedGroup } from '../src/server/signal-groups.ts';
import type { Attention } from '../src/server/sources.ts';
import { SlackArchive } from '../src/server/slack-archive.ts';
import { SlackMentionTyping } from '../src/server/slack.ts';
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
  // Without approvals a quoted reply is just something said.
  event(text('こんにちは', { quote: { id: 123, author: BOT, text: '元の発言' } }));
  assert.deepEqual(said, [{ requestId: 'signal:1790940371225', text: '元気？' }, { requestId: 'signal:1790940371225', text: 'こんにちは' }]);
  assert.deepEqual(api.readMarks, [1_790_940_371_225, 1_790_940_371_225]);
});

test('a reaction on her line is said to natsumi with the head of that line; one taken off is let go', async () => {
  const said: { requestId: string; text: string }[] = [];
  const api = new FakeSignal();
  let listener!: (event: { type: string; payload: Record<string, unknown> }) => void;
  const sent = new SentLines(2);
  relayToSignal({ loop: { subscribe: l => { listener = l; return () => {}; } }, api, images: { read: async () => undefined },
    askedOnSignal: () => true, sent });
  const owner = new SignalOwner({ api, owner: OWNER, sent, say: input => { said.push(input); } });
  for (const line of ['おはよう', 'あ'.repeat(70), '三つ目']) listener({ type: 'conversation.message', payload: { role: 'natsumi', text: line } });
  await until(() => api.sent.length === 3);
  const [first, second] = api.sent.map(entry => entry.at);
  owner.handle({ envelope: reaction('👍', second!) });
  owner.handle({ envelope: reaction('👍', second!, true) });
  owner.handle({ envelope: reaction('❤️', first!) }); // pushed out of the last two
  assert.deepEqual(said, [
    { requestId: `signal:reaction:${String(second)}`, text: `（Signal でリアクション: 「${'あ'.repeat(60)}…」 に 👍）` },
    { requestId: `signal:reaction:${String(first)}`, text: '（Signal でリアクション: 以前のメッセージ に ❤️）' },
  ]);
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
    images: new ImageStore(db, join(root, 'images')), timeZone: 'Asia/Tokyo', now: () => clock.now,
    // Where the results go (ADR 0074); what she hears of them is not what this test is about.
    place: { directory: join(root, 'agents'), record: () => true, notify: () => {}, takeIn: async () => {} }, log: line => { logs.push(line); },
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
    await dove.ask(JSON.stringify({ kind: 'post', to: { file: '/sources/slack/work/dev/2026-09-25.jsonl', path: '.[0]' }, text: '大丈夫です' }));
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
  assert.throws(() => f.owner.handle({ envelope: reaction('👍', f.api.sent[0]!.at + 1) }), /not said/); // not an approval: to natsumi
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
  // Fork (ADR F07): the dove is there for the Signal groups even without Slack.
  assert.doesNotMatch(logs.join('\n'), /no dove without slack/);
  await until(() => api.listening);
  api.emit(text('元気？'));
  await until(() => api.sent.length === 1);
  assert.equal(api.sent[0]!.message, '元気だよ');
  assert.match(JSON.stringify(model.contexts[0]), /マスターと Signal/);
});

/** Fork (ADR F06): what she hears in the Signal groups the owner approved. */

const GROUP = 'pvqsKCycJ38JeLj+Oi61foVl4XQN+EVihKvOUtKpvd0=';
const OTHER_GROUP = 'AAAAKCycJ38JeLj+Oi61foVl4XQN+EVihKvOUtKpvd0=';
const AT = Date.UTC(2026, 9, 25, 3, 4, 5); // 12:04:05 in Tokyo
const inGroup = (message: string | null, extra: Record<string, unknown> = {}, from = '+810000000009', group = GROUP, type = 'DELIVER') => ({
  sourceNumber: from, sourceUuid: `uuid-${from}`, sourceName: from === OWNER ? 'マスター' : '佐藤', timestamp: AT,
  dataMessage: { timestamp: AT, message, groupInfo: { groupId: group, type }, ...extra },
});

/** The daemon, with the groups she is in and what was done to them. */
class FakeGroupSignal extends FakeSignal {
  groups: ListedGroup[] = [];
  done: string[] = [];
  failSends = 0;
  failAccepts = 0;
  hangListing = false;
  failListing = 0;
  async listGroups() {
    if (this.failListing-- > 0) throw new Error('http 500');
    return this.hangListing ? new Promise<ListedGroup[]>(() => {}) : this.groups;
  }
  async quitGroup(groupId: string) { this.done.push(`quit ${groupId}`); }
  async block(groupId: string) { this.done.push(`block ${groupId}`); }
  async acceptGroup(groupId: string) {
    this.done.push(`accept ${groupId}`);
    if (this.failAccepts-- > 0) throw new Error('rpc error -1');
  }
  posted: { groupId: string; message: string; options: Record<string, unknown> }[] = [];
  sendFailure: Error | undefined;
  async sendGroup(groupId: string, message: string, options: Record<string, unknown> = {}) {
    if (this.sendFailure) throw this.sendFailure;
    this.posted.push({ groupId, message, options });
    return AT + 60_000 * this.posted.length;
  }
  receipts: { recipient: string; timestamp: number }[] = [];
  failReceipts = false;
  async receipt(recipient: string, timestamp: number) {
    if (this.failReceipts) throw new Error(`no such user ${recipient}`);
    this.receipts.push({ recipient, timestamp });
  }
  reactions: { groupId: string; emoji: string; target: { timestamp: number; author: string } }[] = [];
  async reactInGroup(groupId: string, emoji: string, target: { timestamp: number; author: string }) { this.reactions.push({ groupId, emoji, target }); }
  override async send(message: string, attachments?: string[]) {
    const at = await super.send(message, attachments);
    if (this.failSends-- > 0) throw new Error('timed out after delivery');
    return at;
  }
}

async function groupsUnderTest(t: { after: (fn: () => Promise<void>) => void }, configured: Record<string, string> = { 'iori-test': GROUP }) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-signal-groups-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const attentions: Attention[] = [];
  const said: { requestId: string; text: string }[] = [];
  const api = new FakeGroupSignal();
  const clock = { now: AT };
  const db = new DatabaseSync(':memory:');
  const make = (groups = configured) => new SignalGroups({ db, api, directory: join(root, 'signal'), groups, account: BOT, selfName: 'いおり',
    timeZone: 'Asia/Tokyo', now: () => clock.now, attention: attention => { attentions.push(attention); } });
  const groups = make();
  const owner = new SignalOwner({ api, owner: OWNER, groups, say: input => { said.push(input); } });
  /** One event, and what it started. */
  const event = async (envelope: Record<string, unknown>) => { owner.handle({ envelope }); await groups.idle(); };
  const lines = async (dir = 'iori-test') => (await readFile(join(root, 'signal', dir, '2026-10-25.jsonl'), 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  return { root, api, clock, db, make, groups, owner, event, said, attentions, lines };
}
const dirOf = (id: string) => `g-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`;
const OTHER_DIR = dirOf(OTHER_GROUP);
const THIRD_GROUP = 'BBBBKCycJ38JeLj+Oi61foVl4XQN+EVihKvOUtKpvd0=';
const QUESTION = /参加しますか？/;

test('a group not approved is asked about once in the owner\'s 1:1; until then nothing from it is written or said', async t => {
  const { api, event, said, attentions, lines } = await groupsUnderTest(t);
  api.groups = [{ id: OTHER_GROUP, name: '飲み会', isMember: true, members: [{}, {}, {}] }];
  await event(inGroup(null, {}, '+810000000009', OTHER_GROUP, 'UPDATE'));
  await event(inGroup('こんにちは', {}, OWNER, OTHER_GROUP));
  assert.deepEqual(api.sent.map(entry => entry.message), ['佐藤さんが Signal のグループ『飲み会』（メンバー 3 人）にいおりを追加しました。参加しますか？\n'
    + '👍 で参加、👎 で退出してブロック（引用して「参加」「見送る」でも）。24 時間答えがなければ退出してブロックします。']);
  assert.deepEqual(await lines(OTHER_DIR), []);
  // The owner's message in an approved group is written, and is not the owner's 1:1 either.
  await event(inGroup('グループでマスターが', {}, OWNER));
  // Without a groups handler, a group message is still never the owner's.
  const bare: { requestId: string; text: string }[] = [];
  new SignalOwner({ api: new FakeSignal(), owner: OWNER, say: input => { bare.push(input); } }).handle({ envelope: inGroup('x', {}, OWNER) });
  assert.deepEqual([said, bare, attentions], [[], [], []]);
  assert.deepEqual((await lines()).map(line => line.text), ['グループでマスターが']);
});

test('a message from an unknown group never holds the owner\'s next message, however long the asking takes', async t => {
  const { api, owner, said } = await groupsUnderTest(t);
  api.hangListing = true;
  assert.equal(owner.handle({ envelope: inGroup('こんにちは', {}, '+810000000009', OTHER_GROUP) }), undefined);
  owner.handle({ envelope: text('元気？') });
  assert.deepEqual(said.map(entry => entry.text), ['元気？']);
});

test('a 👍 approves a group and accepts her invitation; what is said after is written and indexed, and it is not asked again', async t => {
  const { root, api, groups, event, said, lines } = await groupsUnderTest(t);
  api.groups = [{ id: OTHER_GROUP, name: '飲み会', isMember: false, members: [{}], pendingMembers: [{ number: BOT, uuid: 'uuid-bot' }] }];
  await groups.sync();
  assert.match(api.sent[0]!.message, /^誰かが Signal のグループ『飲み会』（メンバー 1 人）にいおりを招待しました/);
  await event(reaction('👍', api.sent[0]!.at));
  assert.deepEqual(api.done, [`accept ${OTHER_GROUP}`]);
  assert.equal(api.sent[1]!.message, `→ 参加しました: 『飲み会』。/sources/signal/${OTHER_DIR} に記録します`);
  await event(inGroup('ようこそ', {}, '+810000000009', OTHER_GROUP));
  assert.deepEqual((await lines(OTHER_DIR)).map(line => line.text), ['ようこそ']);
  assert.match(await readFile(join(root, 'signal', 'INDEX.md'), 'utf8'), new RegExp(`\\| /sources/signal/${OTHER_DIR} \\| 飲み会 \\|`));
  api.groups = [{ id: OTHER_GROUP, name: '飲み会', isMember: true }];
  await groups.sync();
  assert.deepEqual([api.sent.length, said], [2, []]);
});

test('an approved group she is still only invited to is joined on every sweep until it works, and a failure is told once', async t => {
  const { api, groups } = await groupsUnderTest(t);
  // The config's group, which was never asked about.
  api.groups = [{ id: GROUP, name: 'いおりテスト', isMember: false, pendingMembers: [{ number: BOT }] }];
  api.failAccepts = 2;
  await groups.sync();
  await groups.sync();
  await groups.sync();
  assert.deepEqual(api.done, [`accept ${GROUP}`, `accept ${GROUP}`, `accept ${GROUP}`]);
  assert.deepEqual(api.sent.map(entry => entry.message), ['→ 『いおりテスト』の招待を受けられませんでした。毎分試し直します。Signal のアプリでも確かめてください']);
});

test('a listing that fails is logged once, and once again when it works again', async t => {
  const logs: string[] = [];
  const api = new FakeGroupSignal();
  api.failListing = 2;
  const root = await mkdtemp(join(tmpdir(), 'natsumi-signal-list-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const groups = new SignalGroups({ db: new DatabaseSync(':memory:'), api, directory: join(root, 'signal'),
    groups: {}, account: BOT, selfName: 'いおり', timeZone: 'Asia/Tokyo', log: line => { logs.push(line); } });
  for (let n = 0; n < 4; n++) await groups.sync();
  assert.deepEqual(logs, ['signal: the groups could not be listed (http 500); tried again every minute', 'signal: the groups can be listed again']);
});

test('a group she left, or blocked, is never asked about', async t => {
  const { api, groups } = await groupsUnderTest(t);
  api.groups = [{ id: OTHER_GROUP, name: '抜けた', isMember: false, pendingMembers: [{ number: '+810000000009' }] },
    { id: THIRD_GROUP, name: 'blocked', isMember: true, isBlocked: true }];
  await groups.sync();
  assert.deepEqual(api.sent, []);
});

test('a 👎 or no answer within a day makes her leave and block the group, which stays let go; a late answer changes nothing', async t => {
  const { api, clock, groups, event, lines } = await groupsUnderTest(t);
  api.groups = [{ id: OTHER_GROUP, name: 'A', isMember: true }, { id: THIRD_GROUP, name: 'B', isMember: true }];
  await groups.sync();
  assert.equal(api.sent.length, 2);
  await event(text('見送る', { quote: { id: api.sent[0]!.at, author: BOT, text: '…' } }));
  assert.deepEqual(api.done, [`quit ${OTHER_GROUP}`, `block ${OTHER_GROUP}`]);
  assert.equal(api.sent[2]!.message, '→ 『A』から退出してブロックしました');
  clock.now += 23 * 60 * 60 * 1000;
  await groups.expire();
  assert.equal(api.done.length, 2);
  clock.now += 60 * 60 * 1000;
  await groups.expire();
  assert.deepEqual(api.done.slice(2), [`quit ${THIRD_GROUP}`, `block ${THIRD_GROUP}`]);
  assert.equal(api.sent[3]!.message, '→ 24 時間答えがなかったので、『B』から退出してブロックしました');
  await event(reaction('👍', api.sent[1]!.at));
  await event(inGroup('まだいる？', {}, '+810000000009', OTHER_GROUP));
  await groups.sync();
  await groups.idle();
  assert.deepEqual([api.sent.length, api.done.length, await lines(OTHER_DIR)], [4, 4, []]);
});

test('a question is left to expire across a restart, counted from when it was asked', async t => {
  const { api, clock, make, groups } = await groupsUnderTest(t);
  api.groups = [{ id: OTHER_GROUP, name: 'A', isMember: true }];
  await groups.sync();
  clock.now += 25 * 60 * 60 * 1000;
  const again = make();
  await again.sync();
  await again.expire();
  assert.deepEqual(api.done, [`quit ${OTHER_GROUP}`, `block ${OTHER_GROUP}`]);
  assert.equal(api.sent.filter(entry => QUESTION.test(entry.message)).length, 1);
});

test('a question whose send failed is not asked again every minute: it is tried again a few times, and answered as usual once sent', async t => {
  const { api, db, groups, event } = await groupsUnderTest(t);
  api.groups = [{ id: OTHER_GROUP, name: 'A', isMember: true }];
  api.failSends = 1; // delivered, but the answer was lost
  await groups.sync();
  assert.equal(api.sent.length, 1);
  await groups.sync();
  assert.equal(api.sent.length, 2);
  await event(reaction('👍', api.sent[1]!.at));
  assert.equal((db.prepare('SELECT state FROM fork_signal_groups').get() as { state: string }).state, 'approved');
  // One that never goes is given up after three tries; the day still counts.
  api.groups.push({ id: THIRD_GROUP, name: 'B', isMember: true });
  api.failSends = 10;
  for (let n = 0; n < 5; n++) await groups.sync();
  assert.equal(api.sent.filter(entry => entry.message.includes('『B』')).length, 3);
});

test('the config\'s names may be renamed, swapped or taken away; a group taken out of it is asked about', async t => {
  const { api, make } = await groupsUnderTest(t, { foo: GROUP, bar: OTHER_GROUP });
  make({ foo: OTHER_GROUP, bar: GROUP });
  make({ foo: THIRD_GROUP });
  const groups = make({ foo: GROUP });
  api.groups = [{ id: GROUP, name: 'x', isMember: true }, { id: OTHER_GROUP, name: 'y', isMember: true }];
  await groups.sync();
  assert.deepEqual(api.sent.map(entry => /『(.)』/.exec(entry.message)?.[1]), ['y']);
});

test('a malformed group message is written as far as it can be, and never throws', async t => {
  const { event, lines } = await groupsUnderTest(t);
  await event(inGroup('￼ やあ', { mentions: [null, { number: BOT, start: 0, length: 1 }], attachments: [null, 'x'], quote: null }));
  assert.deepEqual(await lines(), [{ at: '2026-10-25 12:04:05', from: '佐藤', text: '@いおり やあ' }]);
});

test('every message in an approved group is written as a line of its local day; a mention or a quote of her is an attention', async t => {
  const { event, said, attentions, lines } = await groupsUnderTest(t);
  await event(inGroup('おはよう'));
  await event(inGroup('￼ 見て', { mentions: [{ number: BOT, uuid: 'uuid-bot', start: 0, length: 1 }],
    attachments: [{ id: 'x', contentType: 'image/jpeg', filename: 'cat.jpg', size: 204_800 }] }, OWNER));
  await event(inGroup('そうだね', { quote: { id: 1, authorNumber: BOT, text: 'いおりの発言' } }));
  await event(inGroup(null, { reaction: { emoji: '👍', targetSentTimestamp: 1, isRemove: false } }));
  assert.deepEqual(await lines(), [
    { at: '2026-10-25 12:04:05', from: '佐藤', text: 'おはよう' },
    { at: '2026-10-25 12:04:05', from: 'マスター', text: '@いおり 見て', attachments: ['cat.jpg (image/jpeg, 200 KB)'] },
    { at: '2026-10-25 12:04:05', from: '佐藤', text: 'そうだね', quote: { from: 'いおり', text: 'いおりの発言', mine: true } },
  ]);
  const file = '/sources/signal/iori-test/2026-10-25.jsonl';
  assert.deepEqual(attentions, [{ source: 'signal', kind: 'mention', file, path: '.[1]' }, { source: 'signal', kind: 'quote-reply', file, path: '.[2]' }]);
  assert.deepEqual(said, []);
});

/** Fork (ADR F07): what in an approved group is for her without a mention, and the read receipts. */

async function hearingSetup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-signal-hearing-'));
  const api = new FakeGroupSignal();
  const clock = { now: AT, awake: true };
  const attentions: Attention[] = [];
  const logs: string[] = [];
  const db = new DatabaseSync(':memory:');
  const typing: string[] = [];
  const make = () => new SignalGroups({ db, api, directory: join(root, 'signal'), groups: { 'iori-test': GROUP },
    typing: { start: (groupId, place) => { typing.push(`start ${groupId === GROUP ? 'iori-test' : groupId} ${place.path}`); },
      end: groupId => { typing.push(`end ${groupId === GROUP ? 'iori-test' : groupId}`); } },
    account: BOT, selfName: 'いおり', names: ['Iori'], timeZone: 'Asia/Tokyo', now: () => clock.now, awake: () => clock.awake,
    timing: { quietMs: 30, conversationEveryMs: 60_000 }, attention: attention => { attentions.push(attention); }, log: line => { logs.push(line); } });
  const groups = make();
  t.after(async () => { groups.stop(); await rm(root, { recursive: true, force: true }); });
  const say = async (message: string, at = AT, group = GROUP) => {
    await groups.handle({ ...inGroup(message, {}, '+810000000009', group), timestamp: at, dataMessage: { ...inGroup(message, {}, '+810000000009', group).dataMessage, timestamp: at } });
    await groups.idle();
  };
  const kinds = () => attentions.map(attention => `${attention.kind} ${attention.path}`);
  const quiet = () => new Promise(resolve => setTimeout(resolve, 80));
  return { root, api, clock, groups, make, say, kinds, quiet, logs, typing };
}

test('a message in an approved group is marked read for its sender; one in a group not approved is not', async t => {
  const { api, say } = await hearingSetup(t);
  await say('おはよう');
  await say('だれ？', AT, OTHER_GROUP);
  assert.deepEqual(api.receipts, [{ recipient: '+810000000009', timestamp: AT }]);
});

test('her name without a mention is a name, in kana either way, NFKC and the names configured; mention still comes first', async t => {
  const { clock, groups, say, kinds } = await hearingSetup(t);
  for (const text of ['いおりちゃんはどう思う？', 'イオリに聞いてみよう', 'iori, are you there?', 'ｲｵﾘはどこ', 'ＩＯＲＩ！']) {
    await say(text, clock.now);
    clock.now += 61_000;
  }
  clock.now -= 30_000;
  await say('いおりもいおりも', clock.now); // a burst: within a minute of the last
  await groups.handle({ ...inGroup('￼ いおり', { mentions: [{ number: BOT, start: 0, length: 1 }] }), timestamp: clock.now,
    dataMessage: { ...inGroup('￼ いおり', { mentions: [{ number: BOT, start: 0, length: 1 }] }).dataMessage, timestamp: clock.now } });
  await groups.idle();
  groups.stop();
  assert.deepEqual(kinds(), ['name .[0]', 'name .[1]', 'name .[2]', 'name .[3]', 'name .[4]', 'mention .[6]']);
});

test('a backlog raises no name, follow-up or conversation; a mention only within six hours; all of it is written', async t => {
  const { root, clock, groups, say, kinds, quiet, typing } = await hearingSetup(t);
  clock.now = AT + 7 * 60 * 60_000;
  await say('いおりは？', clock.now - 11 * 60_000);
  await say('ただの話', clock.now - 11 * 60_000);
  const mention = async (at: number) => {
    const envelope = inGroup('￼', { mentions: [{ number: BOT, start: 0, length: 1 }] });
    await groups.handle({ ...envelope, timestamp: at, dataMessage: { ...envelope.dataMessage, timestamp: at } });
    await groups.idle();
  };
  await mention(clock.now - 60 * 60_000);
  await mention(AT);
  await quiet();
  assert.deepEqual(kinds(), ['mention .[2]']);
  assert.deepEqual(typing, [], 'no typing for a backlog');
  const lines = (await readFile(join(root, 'signal', 'iori-test', '2026-10-25.jsonl'), 'utf8'))
    .split('\n').filter(Boolean);
  assert.equal(lines.length, 4);
});

test('her own post ends the wait for the talk to settle, and a follow-up is known across a restart', async t => {
  const { groups, make, say, kinds, quiet } = await hearingSetup(t);
  await say('今日は寒いね');
  const sent = Number((await groups.post(GROUP, 'ほんとですね', {})).split(':')[0]);
  await quiet();
  assert.deepEqual(kinds(), []);
  groups.stop();
  const again = make();
  t.after(() => { again.stop(); });
  const envelope = inGroup('どう？');
  await again.handle({ ...envelope, timestamp: sent + 3 * 60_000, dataMessage: { ...envelope.dataMessage, timestamp: sent + 3 * 60_000 } });
  await again.idle();
  again.stop();
  assert.deepEqual(kinds(), ['follow-up .[2]']);
});

test('a receipt is not sent without a timestamp, and a failed one is logged in fixed words only', async t => {
  const { api, groups, logs } = await hearingSetup(t);
  const envelope = inGroup('a');
  await groups.handle({ ...envelope, timestamp: undefined, dataMessage: { ...envelope.dataMessage, timestamp: undefined } });
  assert.equal(api.receipts.length, 0);
  api.failReceipts = true;
  await groups.handle(inGroup('b'));
  await groups.idle();
  await new Promise(resolve => setImmediate(resolve));
  groups.stop();
  assert.deepEqual(logs, ['signal: a read receipt could not be sent (Error)']);
});

test('what people say within ten minutes of her own post is a follow-up; later it is not', async t => {
  const { groups, say, kinds } = await hearingSetup(t);
  const sent = Number((await groups.post(GROUP, '集合は 10 時です', {})).split(':')[0]);
  await say('了解', sent + 5 * 60_000);
  await say('ところで', sent + 11 * 60_000);
  groups.stop();
  assert.deepEqual(kinds(), ['follow-up .[1]']);
});

test('talk that raised nothing is a conversation once it settles, at most once a window, only while the owner is awake', async t => {
  const { clock, say, kinds, quiet } = await hearingSetup(t);
  await say('今日は寒いね');
  await say('ほんと、雪かも');
  await quiet();
  assert.deepEqual(kinds(), ['conversation .[1]']);
  await say('積もるかな');
  await quiet();
  assert.equal(kinds().length, 1, 'not again within the window');
  clock.now += 60_000;
  clock.awake = false;
  await say('明日は電車が心配');
  await quiet();
  assert.equal(kinds().length, 1, 'not out of the awake hours');
  clock.awake = true;
  await say('早めに出よう');
  await quiet();
  assert.deepEqual(kinds(), ['conversation .[1]', 'conversation .[4]']);
  // An attention of another kind counts too.
  clock.now += 60_000;
  await say('いおりは雪好き？');
  await say('どうだろうね');
  await quiet();
  assert.deepEqual(kinds().slice(2), ['name .[5]']);
  // A group not approved raises none.
  clock.now += 60_000;
  await say('こんにちは', AT, OTHER_GROUP);
  await quiet();
  assert.equal(kinds().length, 3);
});

test('typing is started for what asks for an answer, not for a conversation nor a group not approved, and ended by her post', async t => {
  const { clock, groups, say, quiet, typing, kinds } = await hearingSetup(t);
  await say('いおりは来る？');
  await say('こんにちは', AT, OTHER_GROUP);
  clock.now += 61_000;
  await say('雑談です', clock.now);
  clock.now += 15 * 60_000;
  await quiet();
  await groups.post(GROUP, '行きます', {});
  groups.stop();
  assert.deepEqual(kinds(), ['name .[0]', 'conversation .[1]']);
  assert.deepEqual(typing, ['start iori-test .[0]', 'end iori-test']);
});

test('in a group, typing is sent again every interval, taken away when the turn is done or her post went, and never past the limit', async () => {
  const sent: string[] = [];
  const done = new Set<string>();
  let listener = () => {};
  const typing = new SlackMentionTyping({ loop: { subscribe: l => { listener = l as () => void; return () => {}; } }, intervalMs: 5, maxMs: 200,
    done: place => done.has(place.path),
    api: { setStatus: async (groupId, _ts, status) => { sent.push(`${groupId} ${status === '' ? 'stop' : 'on'}`); } } });
  typing.start('g1', '', { file: 'f', path: '.[0]' });
  typing.start('g2', '', { file: 'f', path: '.[1]' });
  await until(() => sent.filter(line => line === 'g1 on').length >= 3);
  done.add('.[0]');
  listener();
  typing.end('g2', '');
  const at = sent.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(sent.slice(at - 2), ['g1 stop', 'g2 stop']);
  typing.stop();
});

/** Fork (ADR F07): the dove posts to the Signal groups the owner approved. */

/** A judge that answers the scores queued, and records what it was asked. */
class QueuedJudge implements JudgeClient {
  readonly asked: { state: Record<string, unknown>; placement: boolean }[] = [];
  readonly answers: number[][] = [];
  async judge(state: Record<string, unknown>, options: { placement: boolean }): Promise<Judgement> {
    this.asked.push({ state, placement: options.placement });
    const values = this.answers.shift() ?? [];
    return { issues: JUDGE_ISSUES.map((issue, index) => ({ name: issue.name, label: issue.label, score: values[index] ?? 0.01 })) };
  }
}

async function groupDoveSetup(t: test.TestContext, options: { judge?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-signal-dove-')));
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const api = new FakeGroupSignal();
  api.groups = [{ id: GROUP, name: 'いおりテスト', isMember: true }, { id: OTHER_GROUP, name: 'まだ', isMember: true }];
  const groups = new SignalGroups({ db, api, directory: join(root, 'signal'), groups: { 'iori-test': GROUP }, account: BOT, selfName: 'いおり',
    timeZone: 'Asia/Tokyo', now: () => AT });
  await groups.sync(); // titles the group, and asks about the other one
  await groups.handle(inGroup('明日の集合は何時？'));
  const judge = new QueuedJudge();
  const logs: string[] = [];
  const dove = new SlackDove({ log: line => { logs.push(line); },
    db, signal: groups, workspaces: {}, publicOrigin: 'https://natsumi.example.test', workDirectory: join(root, 'work'),
    images: new ImageStore(db, join(root, 'images')), timeZone: 'Asia/Tokyo', now: () => AT,
    place: { directory: join(root, 'agents'), record: () => true, notify: () => {}, takeIn: async () => {} },
    judges: options.judge ? { jev: { client: judge, thresholds: { owner: 0.3, return: 0.7 } } } : {},
    judgeChoice: () => ({ logprobs: false, jev: options.judge === true, adopted: 'jev' }),
    config: { approvalDays: 7, placementFollowing: 2, judgeContext: { messages: 5, chars: 500 }, images: { maxBytes: 1024, maxCount: 2 } },
  });
  const approvals = new SignalApprovals({ db, dove, api, timeZone: 'Asia/Tokyo' });
  const owner = new SignalOwner({ api, owner: OWNER, approvals, groups, say: () => { throw new Error('not said'); } });
  t.after(async () => {
    approvals.stop();
    dove.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const ask = async (request: Record<string, unknown>) => {
    const outcome = await dove.ask(JSON.stringify(request));
    await dove.idle(); await approvals.idle(); await groups.idle();
    return outcome;
  };
  const settle = async () => { await dove.idle(); await approvals.idle(); await groups.idle(); await dove.idle(); };
  const lines = async () => (await readFile(join(root, 'signal', 'iori-test', '2026-10-25.jsonl'), 'utf8')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
  const results = () => (db.prepare('SELECT text FROM dove_results ORDER BY result_id').all() as { text: string }[]).map(row => row.text);
  return { api, judge, dove, owner, ask, settle, lines, logs, results };
}
const LINE = { file: '/sources/signal/iori-test/2026-10-25.jsonl', path: '.[0]' };

test('a reply the judge lets through is sent to the group as a quote, and her line is written as hers', async t => {
  const f = await groupDoveSetup(t, { judge: true });
  const outcome = await f.ask({ kind: 'post', to: LINE, text: '10 時です' });
  assert.equal(outcome.ok, true);
  assert.equal(f.judge.asked[0]!.placement, false);
  assert.deepEqual(f.judge.asked[0]!.state.channel, 'Signal のグループ『いおりテスト』');
  assert.deepEqual((f.judge.asked[0]!.state.reply_to as Record<string, unknown>).text, '明日の集合は何時？');
  assert.deepEqual(f.api.posted, [{ groupId: GROUP, message: '10 時です',
    options: { quote: { timestamp: AT, author: '+810000000009', text: '明日の集合は何時？' } } }]);
  assert.deepEqual((await f.lines())[1], { at: '2026-10-25 12:05:05', from: 'いおり', mine: true, text: '10 時です',
    quote: { from: '佐藤', text: '明日の集合は何時？' } });
  // A post to the group itself quotes nothing.
  await f.ask({ kind: 'post', to: { file: '/sources/signal/iori-test' }, text: 'おはようございます' });
  assert.deepEqual(f.api.posted[1], { groupId: GROUP, message: 'おはようございます', options: {} });
});

test('a draft with no verdict goes to the owner on Signal, named as the Signal group; a 👍 sends it there', async t => {
  const f = await groupDoveSetup(t);
  await f.ask({ kind: 'post', to: LINE, text: '10 時です' });
  const shown = f.api.sent.at(-1)!;
  assert.match(shown.message, /^承認待ちの投稿: Signal のグループ『いおりテスト』 への投稿\n返信先: 佐藤（2026-10-25 12:04:05）「明日の集合は何時？」/);
  assert.equal(f.api.posted.length, 0);
  f.owner.handle({ envelope: reaction('👍', shown.at) });
  await f.settle();
  assert.equal(f.api.posted[0]!.message, '10 時です');
});

test('a group not approved, or not a group, is refused as it is asked; a reaction takes a real emoji alone', async t => {
  const f = await groupDoveSetup(t, { judge: true });
  const pending = await f.ask({ kind: 'post', to: { file: `/sources/signal/${OTHER_DIR}` }, text: 'やあ' });
  assert.match(pending.text, /参加しているグループではありません/);
  assert.equal(pending.ok, false);
  assert.match((await f.ask({ kind: 'post', to: { file: '/sources/signal/iori-test/2026-10-25.jsonl', path: '.[5]' }, text: 'x' })).text, /行はありません/);
  assert.match((await f.ask({ kind: 'reaction', to: LINE, emoji: '+1' })).text, /絵文字そのもの/);
  assert.match((await f.ask({ kind: 'post', to: { file: '/sources/signal' }, text: 'x' })).text, /\/sources\/signal の下のグループのディレクトリ/);
  assert.equal((await f.ask({ kind: 'reaction', to: LINE, emoji: '1️⃣' })).ok, true);
  f.api.reactions.length = 0;
  const reacted = await f.ask({ kind: 'reaction', to: LINE, emoji: '👍🏻' });
  assert.equal(reacted.ok, true);
  assert.deepEqual(f.api.reactions, [{ groupId: GROUP, emoji: '👍🏻', target: { timestamp: AT, author: '+810000000009' } }]);
  assert.deepEqual(f.api.posted, []);
});

test('a send Signal refused is told as refused; one whose outcome is unknown is told as unknown, never as refused', async t => {
  const f = await groupDoveSetup(t, { judge: true });
  f.api.sendFailure = new Error('send UNREGISTERED_FAILURE');
  await f.ask({ kind: 'post', to: LINE, text: '10 時です' });
  f.api.sendFailure = new DeliveryUnknown('timed out');
  await f.ask({ kind: 'post', to: LINE, text: '10 時です' });
  const told = f.results().filter(text => text.startsWith('ポッポ…'));
  assert.deepEqual(told, ['ポッポ…届けられなかったよ（Signal に断られた）。',
    'ポッポ…届いたかどうか分からないよ（Signal から答えが無かった）。グループで確かめてから、送り直すか決めてね。']);
  assert.deepEqual(f.logs.filter(line => line.startsWith('signal:')),
    ['signal: posting in a group failed (send UNREGISTERED_FAILURE)', 'signal: posting in a group failed (timed out)']);
});

test('a JSON-RPC call that hangs is given up as of unknown outcome; the daemon\'s refusal is a refusal', async t => {
  let answer: 'hang' | 'refuse' = 'hang';
  const server = createServer((request, response) => {
    if (answer === 'hang') return;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'nope' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address() as { port: number };
  const api = connectSignal({ url: `http://127.0.0.1:${port}`, account: BOT, owner: OWNER, timeoutMs: 100 });
  await assert.rejects(api.sendGroup!(GROUP, 'x'), (error: Error) => error instanceof DeliveryUnknown && error.message === 'timed out');
  answer = 'refuse';
  await assert.rejects(api.sendGroup!(GROUP, 'x'), (error: Error) => !(error instanceof DeliveryUnknown) && error.message === 'rpc error -1');
});

test('with groups listed, the server writes what is said in them under sources/signal and never says it to natsumi as the owner\'s', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-server-signal-groups-')));
  const data = join(root, 'data');
  await mkdir(data);
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ ...serverConfig(root),
    signal: { url: 'http://127.0.0.1:1', account: BOT, owner: OWNER, groups: { 'iori-test': GROUP } } }));
  const model = new ScriptedModel();
  const api = new FakeSignal();
  const server = await startServer({
    config, dataDir: data, cwd: '/', home: join(root, 'home'), env: { NATSUMI_GITHUB_CLIENT_SECRET: CLIENT_SECRET }, log: () => {},
    pi: { runtime: fixtureRuntime, configureSession: session => { session.agent.streamFunction = model.streamFunction; } },
    signal: { api },
  });
  t.after(async () => {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  });
  await until(() => api.listening);
  api.emit(inGroup('グループで', {}, OWNER));
  const file = join(data, 'sources', 'signal', 'iori-test', '2026-10-25.jsonl');
  await until(() => existsSync(file) && readFileSync(file, 'utf8').includes('グループで'));
  assert.equal(JSON.stringify(model.contexts).includes('グループで'), false);
});
