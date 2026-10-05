import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SdkA2AClient } from '../src/server/a2a-client.ts';
import { startServer } from '../src/server/server.ts';
import { openStateDatabase } from '../src/server/state-db.ts';
import { FakeAgent } from './support/fake-agent.ts';
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

async function launch(t: test.TestContext, a2a: (agent: FakeAgent, root: string) => Record<string, unknown> | undefined) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-server-agents-')));
  const data = join(root, 'data');
  await mkdir(data);
  await writeFile(join(root, 'a2a-token'), 'fake-agent-token');
  const agent = await FakeAgent.start({ name: 'Fake Wiki Keeper', description: 'Keeps a wiki that is not real.' });
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
    a2a: { pollIntervalMs: 20 },
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
