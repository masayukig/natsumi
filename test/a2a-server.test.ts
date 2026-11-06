import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { A2ACallError, SdkA2AClient } from '../src/server/a2a-client.ts';
import { InboxEndpoint, inboxSenders } from '../src/server/a2a-server.ts';
import { AGENTS_REGISTRATION, replyPlaceOf } from '../src/server/agent-replies.ts';
import { AgentRequests } from '../src/server/agent-requests.ts';
import { AssertionVerifier, audienceOf } from '../src/server/gated-assertion.ts';
import { INBOX_REGISTRATION, Inbox } from '../src/server/inbox.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { SOURCES_DEFAULTS, Sources } from '../src/server/sources.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';

/**
 * natsumi's way in over A2A (ADR 0089): the Agent Card under `/a2a/` without a token, and SendMessage and GetTask with a
 * sender's own bearer token or gated's assertion of its subject; anything else is the same 401. Only text is taken, and
 * the tasks are kept by the inbox. The other side here is natsumi's own client, as another natsumi's `ask_agent` uses it.
 */

const TIME_ZONE = 'Asia/Tokyo';
const ISSUER = 'https://auth.example.test';
const CLAUDE = 'system:serviceaccount:agents:claude';
// Fictional values only.
const NATSUMI_TOKEN = 'fixture-inbox-natsumi-4f2a';
const PI_TOKEN = 'fixture-inbox-pi-9c1e';

interface Gated { url: string; key: { privateKey: KeyObject; publicKey: KeyObject }; close(): Promise<void> }

/** gated's keys, published as it publishes them (gated ADR 0034). */
async function gatedKeys(): Promise<Gated> {
  const key = generateKeyPairSync('ed25519');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig', alg: 'EdDSA' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks.json`, key,
    close: () => new Promise(resolve => server.close(() => resolve())) };
}

/** An assertion of gated for a subject, to the audience given. */
function assertion(gated: Gated, subject: string, audience: string): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const seconds = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'EdDSA', typ: 'gated-assertion+jwt', kid: 'key-1' });
  const body = b64({ iss: ISSUER, sub: subject, aud: audience, iat: seconds, exp: seconds + 60 });
  return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), gated.key.privateKey).toString('base64url')}`;
}

async function setup(t: test.TestContext, limits: { maxOpenTasks?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-a2a-server-')));
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const clock = { now: Date.parse('2026-10-31T01:00:05Z') };
  const now = () => clock.now;
  const sources = new Sources({ db, directory: join(root, 'sources'), gitDirectory: join(root, 'sources.git'), timeZone: TIME_ZONE,
    awakeHours: { start: '08:00', end: '23:00' }, activity: SOURCES_DEFAULTS.activity, historyDays: SOURCES_DEFAULTS.historyDays, now });
  sources.register(INBOX_REGISTRATION);
  await sources.prepare();
  const inbox = new Inbox({ db, directory: join(root, 'sources', 'inbox'), timeZone: TIME_ZONE, awakeHours: { start: '08:00', end: '23:00' },
    limits: { reminderIntervalHours: 3, deadlineHours: 24, maxOpenTasks: limits.maxOpenTasks ?? 3 }, now, sources });
  const gated = await gatedKeys();
  let endpoint: InboxEndpoint | undefined;
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (endpoint && InboxEndpoint.owns(url.pathname)) { void endpoint.handle(request, response, url); return; }
    response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not-found"}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const publicUrl = `${base}/a2a/`;
  const logs: string[] = [];
  endpoint = new InboxEndpoint({
    publicUrl, card: { name: 'ペネロペ', description: 'マスターの秘書。返事は遅くなることがあります。' }, inbox,
    senders: inboxSenders({ tokens: new Map([['natsumi', NATSUMI_TOKEN], ['pi', PI_TOKEN]]), subjects: new Map([[CLAUDE, 'claude']]),
      verifier: new AssertionVerifier({ issuer: ISSUER, jwksUrl: gated.url, audience: audienceOf(publicUrl), allowedSubjects: [CLAUDE] }) }),
    log: line => { logs.push(line); },
  });
  const tokenFile = join(root, 'token');
  await writeFile(tokenFile, `${NATSUMI_TOKEN}\n`);
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await gated.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  /** A JSON-RPC call as any client makes it, with the headers given. */
  const rpc = async (method: string, params: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(publicUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'a2a-version': '1.0', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return { root, db, clock, inbox, sources, gated, base, publicUrl, tokenFile, logs, rpc,
    client: new SdkA2AClient({ tokenFile }),
    read: (path: string) => readFile(join(root, path.slice(1)), 'utf8') };
}

const message = (text: string, more: Record<string, unknown> = {}) =>
  ({ message: { messageId: `m-${Math.random()}`, role: 'ROLE_USER', parts: [{ text }], ...more } });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test('the Agent Card is served under /a2a/ without a token, naming the public URL over JSON-RPC and text only', async t => {
  const f = await setup(t);
  const response = await fetch(`${f.publicUrl}.well-known/agent-card.json`);
  assert.equal(response.status, 200);
  const card = await response.json() as Record<string, any>;
  assert.equal(card.name, 'ペネロペ');
  assert.equal(card.description, 'マスターの秘書。返事は遅くなることがあります。');
  assert.deepEqual(card.supportedInterfaces, [{ url: f.publicUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]);
  assert.equal(card.capabilities.streaming ?? false, false);
  assert.equal(card.capabilities.pushNotifications ?? false, false);
  assert.deepEqual(card.defaultInputModes, ['text/plain']);
  assert.deepEqual(card.defaultOutputModes, ['text/plain']);
  const summary = await f.client.card(f.publicUrl);
  assert.equal(summary.name, 'ペネロペ', 'natsumi’s own list of agents reads it');
});

test('a sender is one with its own token or gated’s assertion of its subject; anything else is the same 401', async t => {
  const f = await setup(t);
  const params = message('こんにちは');
  const audience = audienceOf(f.publicUrl);
  const refusals = [
    await f.rpc('SendMessage', params),
    await f.rpc('SendMessage', params, bearer('fixture-wrong-token')),
    await f.rpc('SendMessage', params, bearer(`${NATSUMI_TOKEN}x`)),
    await f.rpc('SendMessage', params, { cookie: 'natsumi_session=fixture-cookie' }),
    await f.rpc('SendMessage', params, { 'gated-assertion': `${assertion(f.gated, CLAUDE, audience)}x` }),
    await f.rpc('SendMessage', params, { 'gated-assertion': assertion(f.gated, 'system:serviceaccount:agents:stranger', audience) }),
    await f.rpc('SendMessage', params, { 'gated-assertion': assertion(f.gated, CLAUDE, 'elsewhere.example.test') }),
    await f.rpc('GetTask', { id: 'any' }),
  ];
  for (const refusal of refusals) assert.deepEqual([refusal.status, refusal.body], [401, { error: 'unauthorized' }]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM inbox_tasks').get()!.count, 0);

  const byToken = await f.rpc('SendMessage', params, bearer(PI_TOKEN));
  assert.equal(byToken.status, 200, JSON.stringify(byToken.body));
  assert.equal(byToken.body.result.task.status.state, 'TASK_STATE_WORKING');
  const byAssertion = await f.rpc('SendMessage', params, { 'gated-assertion': assertion(f.gated, CLAUDE, audience) });
  assert.equal(byAssertion.body.result.task.status.state, 'TASK_STATE_WORKING');
  const senders = f.db.prepare('SELECT sender FROM inbox_tasks ORDER BY created_at, rowid').all().map(row => row.sender);
  assert.deepEqual(senders, ['pi', 'claude'], 'the name is the one the check gave, not one the message claims');
});

test('another natsumi asks with ask_agent, and what she replies comes back into its /sources/agents', async t => {
  const f = await setup(t);
  // The natsumi who asks: a data directory, a database and sources of her own.
  const asker = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-asker-')));
  const db = openStateDatabase(join(asker, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  t.after(async () => { db.close(); await rm(asker, { recursive: true, force: true }); });
  const now = () => f.clock.now;
  const sources = new Sources({ db, directory: join(asker, 'sources'), gitDirectory: join(asker, 'sources.git'), timeZone: TIME_ZONE,
    awakeHours: { start: '08:00', end: '23:00' }, activity: SOURCES_DEFAULTS.activity, historyDays: SOURCES_DEFAULTS.historyDays, now });
  sources.register(AGENTS_REGISTRATION);
  await sources.prepare();
  const requests = new AgentRequests({ db, now, timeZone: TIME_ZONE, client: f.client, replies: replyPlaceOf(sources, join(asker, 'sources')),
    config: { tokenFile: f.tokenFile, pollIntervalSeconds: 15, giveUpAfterHours: 24, agents: { penelope: { url: f.publicUrl } } } });
  const readAsker = (path: string) => readFile(join(asker, path.slice(1)), 'utf8');

  const asked = await requests.ask('penelope', '明日の天気を調べて', false);
  assert.equal(asked.ok, true, asked.text);
  const [task] = f.db.prepare('SELECT sender, task_id FROM inbox_tasks').all() as { sender: string; task_id: string }[];
  assert.equal(task!.sender, 'natsumi');
  await requests.poll();
  assert.equal(db.prepare(`SELECT state FROM agent_tasks`).get()!.state, 'waiting', 'still working on it');

  // Her question, and the answer the asker sends on with continue.
  assert.equal((await f.inbox.reply('natsumi', 'どこの天気ですか？', 'input-required')).ok, true);
  await requests.poll();
  const question = db.prepare(`SELECT place FROM agent_tasks`).get() as { place: string };
  assert.match(await readAsker(`${question.place}/README.md`), /input_required[\s\S]*どこの天気ですか？/);
  const answered = await requests.ask('penelope', '東京です', true);
  assert.equal(answered.ok, true, answered.text);
  assert.equal(f.inbox.task('natsumi', task!.task_id)!.state, 'working', 'the same task goes on');

  assert.equal((await f.inbox.reply('natsumi', '# 東京の天気\n\n明日は晴れです。', 'completed')).ok, true);
  await requests.poll();
  const done = db.prepare(`SELECT state, place FROM agent_tasks ORDER BY rowid DESC`).get() as { state: string; place: string };
  assert.equal(done.state, 'completed');
  const readme = await readAsker(`${done.place}/README.md`);
  assert.match(readme, /completed/);
  assert.match(readme, /明日は晴れです。/);

  // A reply with no words closes the task all the same, and the asker says the reply had none.
  assert.equal((await requests.ask('penelope', '覚えておいて', false)).ok, true);
  assert.equal((await f.inbox.reply('natsumi', undefined, 'completed')).ok, true);
  await requests.poll();
  const empty = db.prepare(`SELECT state, place FROM agent_tasks ORDER BY rowid DESC`).get() as { state: string; place: string };
  assert.equal(empty.state, 'completed');
  assert.match(await readAsker(`${empty.place}/README.md`), /返事に文章はありませんでした。/);
});

test('a task is the sender’s own: another sender asking for it finds none, and the tasks it may not take are refused', async t => {
  const f = await setup(t);
  const sent = await f.client.send(f.publicUrl, { text: '私の依頼' });
  assert.equal(sent.kind, 'task');
  if (sent.kind !== 'task') return;
  const asOther = await f.rpc('GetTask', { id: sent.taskId }, bearer(PI_TOKEN));
  assert.equal(asOther.body.error?.code, -32001, 'TaskNotFound');
  assert.deepEqual(await f.client.getTask(f.publicUrl, sent.taskId), { state: 'waiting', text: '' });
  await assert.rejects(f.client.getTask(f.publicUrl, 'no-such-task'), (error: A2ACallError) => error.kind === 'not-found');

  const cancel = await f.rpc('CancelTask', { id: sent.taskId }, bearer(NATSUMI_TOKEN));
  assert.ok(cancel.body.error, 'no CancelTask');
  const stream = await f.rpc('SendStreamingMessage', message('流して'), bearer(NATSUMI_TOKEN));
  assert.ok(stream.body.error, 'no streaming');
  const more = await f.rpc('SendMessage', message('追加', { taskId: sent.taskId, contextId: sent.contextId }), bearer(NATSUMI_TOKEN));
  assert.ok(more.body.error, 'an open task not asking takes nothing more');
});

test('a message with anything but text is refused, and so is a body past the limit; nothing is written', async t => {
  const f = await setup(t);
  const file = await f.rpc('SendMessage', { message: { messageId: 'm-file', role: 'ROLE_USER',
    parts: [{ text: '読んで' }, { raw: Buffer.from('%PDF-1.7').toString('base64'), filename: 'a.pdf', mediaType: 'application/pdf' }] } },
  bearer(NATSUMI_TOKEN));
  assert.ok(file.body.error, JSON.stringify(file.body));
  const data = await f.rpc('SendMessage', { message: { messageId: 'm-data', role: 'ROLE_USER', parts: [{ data: { a: 1 } }] } }, bearer(NATSUMI_TOKEN));
  assert.ok(data.body.error, JSON.stringify(data.body));
  const large = await fetch(f.publicUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...bearer(NATSUMI_TOKEN) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: message('a'.repeat(3 * 1024 * 1024)) }) });
  assert.equal(large.status, 413);
  const text = await f.rpc('SendMessage', message('あ'.repeat(400_000)), bearer(NATSUMI_TOKEN));
  assert.ok(text.body.error, 'over 1 MiB of text');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM inbox_tasks').get()!.count, 0);
});

test('past the open tasks of a sender a request is rejected, which the asker sees as a failure with the reason', async t => {
  const f = await setup(t, { maxOpenTasks: 1 });
  await f.client.send(f.publicUrl, { text: '一つ目' });
  const second = await f.client.send(f.publicUrl, { text: '二つ目' });
  assert.equal(second.kind, 'task');
  if (second.kind !== 'task') return;
  assert.equal(second.state, 'failed');
  assert.match(second.text, /1/);
  const raw = await f.rpc('GetTask', { id: second.taskId }, bearer(NATSUMI_TOKEN));
  assert.equal(raw.body.result.status.state, 'TASK_STATE_REJECTED');
});

test('only the card and the calls are under /a2a/; any other path there is not found', async t => {
  const f = await setup(t);
  assert.equal((await fetch(`${f.base}/a2a/tasks`, { headers: bearer(NATSUMI_TOKEN) })).status, 404);
  assert.equal((await fetch(`${f.publicUrl}.well-known/agent-card.json`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(f.publicUrl, { headers: bearer(NATSUMI_TOKEN) })).status, 404, 'a GET of the calls');
});
