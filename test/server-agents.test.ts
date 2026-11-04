import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SdkA2AClient } from '../src/server/a2a-client.ts';
import { startServer } from '../src/server/server.ts';
import { openStateDatabase } from '../src/server/state-db.ts';
import { createHash } from 'node:crypto';
import { FakeAgent, type FakeAgentOptions } from './support/fake-agent.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel } from './support/scripted-model.ts';
import { CLIENT_SECRET, serverConfig } from './support/server-fixture.ts';

async function until<T>(check: () => T | undefined | false | Promise<T | undefined | false>, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function launch(t: test.TestContext, a2a: (agent: FakeAgent, root: string) => Record<string, unknown> | undefined,
  options: { pollIntervalMs?: number; agent?: FakeAgentOptions } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-server-agents-')));
  const data = join(root, 'data');
  await mkdir(data);
  await writeFile(join(root, 'a2a-token'), 'fake-agent-token');
  const agent = await FakeAgent.start({ name: 'Fake Wiki Keeper', description: 'Keeps a wiki that is not real.', ...options.agent });
  const section = a2a(agent, root);
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ ...serverConfig(root), ...(section ? { a2a: section } : {}) }));
  const model = new ScriptedModel();
  model.auto = () => ({ text: '' });
  const logs: string[] = [];
  const server = await startServer({
    config, dataDir: data, cwd: '/', home: join(root, 'home'), env: { NATSUMI_GITHUB_CLIENT_SECRET: CLIENT_SECRET },
    log: line => { logs.push(line); },
    pi: { runtime: fixtureRuntime, configureSession: session => { session.agent.streamFunction = model.streamFunction; } },
    a2a: { pollIntervalMs: options.pollIntervalMs ?? 20 },
  });
  t.after(async () => {
    await server.stop();
    await agent.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, data, agent, model, logs, server };
}

// ADR 0036: the server writes who she can ask where the workspace sees it, on every start.
test('on start the server writes the list of agents into agents/ in the data directory', async t => {
  const f = await launch(t, (agent, root) => ({ tokenFile: join(root, 'a2a-token'), agents: { wiki: { url: agent.url } } }));
  const text = await until(() => readFile(join(f.data, 'agents', 'INDEX.md'), 'utf8').catch(() => undefined));
  assert.match(text, /^## wiki$/m);
  assert.match(text, /Fake Wiki Keeper/);
  assert.deepEqual(f.agent.cardRequests, [undefined], 'the card is fetched once, without the token');
  await until(() => f.logs.some(line => line === 'a2a: wrote the list of agents (1 listed, 0 out of reach)'));
});

test('without the a2a section the list says there is nobody, and nothing is fetched', async t => {
  const f = await launch(t, () => undefined);
  const text = await until(() => readFile(join(f.data, 'agents', 'INDEX.md'), 'utf8').catch(() => undefined));
  assert.match(text, /頼める相手はいません/);
  assert.deepEqual(f.agent.cardRequests, []);
});

// ADR 0035: the server fetches the waiting tasks on its own, including those a previous process left. ADR 0069: with no
// Slack configured, the sources are there all the same, for the replies.
test('the server fetches the waiting tasks on its interval and hands a settled one to natsumi under /sources', async t => {
  const f = await launch(t, (agent, root) => ({ tokenFile: join(root, 'a2a-token'), agents: { wiki: { url: agent.url } } }));
  await new SdkA2AClient({ tokenFile: join(f.root, 'a2a-token') }).send(f.agent.url, { text: 'しらべて' });
  const task = f.agent.lastTask();
  // A task recorded as waiting, as a previous process would have left it.
  const db = openStateDatabase(join(f.data, '.natsumi', 'state.sqlite'));
  try {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO agent_tasks (agent, task_id, context_id, state, sent_at, created_at, updated_at)
      VALUES ('wiki', ?, ?, 'waiting', ?, ?, ?)`).run(task.id, task.contextId, now, now, now);
  } finally { db.close(); }
  await until(() => f.agent.polls.length >= 2);
  f.agent.settle(task.id, 'completed', 'しらべました。');
  const seen = await until(() => f.model.contexts.map(context => JSON.stringify(context.messages)).find(text => text.includes('しらべました。')));
  assert.match(seen, /sources_updated/);
  assert.match(seen, /agent_reply/);
  const [reply] = await readdir(join(f.data, 'sources', 'agents', 'wiki'));
  assert.match(await readFile(join(f.data, 'sources', 'agents', 'wiki', reply!, 'README.md'), 'utf8'), /しらべました。/);
});

// ADR 0092: the doorbell an agent rings, `POST /v1/a2a-push`, open only with a2a.pushUrl.
const PUSH_TOKEN = 'fixture-push-token-5f0c9a1e7b2d4c6e8a0b1c2d3e4f5a6b';

/** A task waiting with a push, as a request sent with one leaves it. */
async function waitingWithPush(f: Awaited<ReturnType<typeof launch>>) {
  await new SdkA2AClient({ tokenFile: join(f.root, 'a2a-token') }).send(f.agent.url, { text: 'しらべて' });
  const task = f.agent.lastTask();
  const db = openStateDatabase(join(f.data, '.natsumi', 'state.sqlite'));
  try {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO agent_tasks (agent, task_id, context_id, state, sent_at, created_at, updated_at, push_digest)
      VALUES ('wiki', ?, ?, 'waiting', ?, ?, ?, ?)`).run(task.id, task.contextId, now, now, now,
      createHash('sha256').update(PUSH_TOKEN).digest('hex'));
  } finally { db.close(); }
  return task;
}

function knock(f: Awaited<ReturnType<typeof launch>>, headers: Record<string, string>, body = '{"statusUpdate":{}}') {
  const { host, port } = f.server.address!;
  return fetch(`http://${host.includes(':') ? `[${host}]` : host}:${port}/v1/a2a-push`, { method: 'POST',
    headers: { 'content-type': 'application/a2a+json', ...headers }, body });
}

test('without a2a.pushUrl there is no /v1/a2a-push', async t => {
  const f = await launch(t, (agent, root) => ({ tokenFile: join(root, 'a2a-token'), agents: { wiki: { url: agent.url } } }),
    { pollIntervalMs: 3_600_000 });
  await waitingWithPush(f);
  const res = await knock(f, { authorization: `Bearer ${PUSH_TOKEN}` });
  assert.equal(res.status, 404);
});

test('a push with the token of a waiting task is answered at once, and that task is fetched once', async t => {
  const f = await launch(t, (agent, root) => ({ tokenFile: join(root, 'a2a-token'), agents: { wiki: { url: agent.url } },
    pushUrl: 'http://127.0.0.1:1' }), { pollIntervalMs: 3_600_000, agent: { pushNotifications: true } });
  const task = await waitingWithPush(f);
  const before = f.agent.polls.length;
  // The answer does not wait for the GetTask.
  let release!: () => void;
  f.agent.holdGetTask = new Promise(resolve => { release = resolve; });
  const res = await knock(f, { authorization: `Bearer ${PUSH_TOKEN}` });
  assert.equal(res.status, 204);
  await until(() => f.agent.polls.length === before + 1);
  assert.equal(f.agent.polls.at(-1), task.id);
  f.agent.holdGetTask = undefined;
  release();
  assert.equal(f.logs.some(line => line.includes(PUSH_TOKEN)), false);
});

test('an unknown token, none, one not Bearer and the browser\'s cookie are the same 401; a body past the limit is refused', async t => {
  const f = await launch(t, (agent, root) => ({ tokenFile: join(root, 'a2a-token'), agents: { wiki: { url: agent.url } },
    pushUrl: 'http://127.0.0.1:1' }), { pollIntervalMs: 3_600_000, agent: { pushNotifications: true } });
  await waitingWithPush(f);
  const before = f.agent.polls.length;
  const refused: Record<string, string>[] = [{ authorization: `Bearer ${PUSH_TOKEN}x` }, {}, { authorization: `Basic ${PUSH_TOKEN}` },
    { authorization: PUSH_TOKEN }, { 'x-a2a-notification-token': PUSH_TOKEN }, { cookie: 'natsumi_session=fixture-anything' }];
  for (const headers of refused) {
    const res = await knock(f, headers);
    assert.deepEqual([res.status, await res.text()], [401, '{"error":"unauthorized"}'], JSON.stringify(headers));
  }
  const large = await knock(f, { authorization: `Bearer ${PUSH_TOKEN}` }, 'x'.repeat(1024 * 1024 + 1));
  assert.equal(large.status, 413);
  const unknownLarge = await knock(f, { authorization: `Bearer ${PUSH_TOKEN}x` }, 'x'.repeat(1024 * 1024 + 1));
  assert.equal(unknownLarge.status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${f.server.address!.port}/v1/a2a-push`, { headers: { authorization: `Bearer ${PUSH_TOKEN}` } })).status, 404,
    'a POST only');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.agent.polls.length, before, 'nothing was fetched');
});
