import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SdkA2AClient } from '../src/server/a2a-client.ts';
import { startServer } from '../src/server/server.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel, type ScriptedStep } from './support/scripted-model.ts';
import { CLIENT_SECRET, serverConfig } from './support/server-fixture.ts';

/**
 * The way in over A2A as the server serves it (ADR 0089): under `/a2a/` of the same listener only when the config has
 * senders, a request put under /sources/inbox and told to her at once, and her `reply_to_agent` handed back to the
 * sender as the task's answer. The sender here is natsumi's own client.
 */

// Fictional values only.
const PENELOPE_TOKEN = 'fixture-inbox-penelope-6d0b';

async function until<T>(check: () => T | undefined | false | Promise<T | undefined | false>, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function launch(t: test.TestContext, inbox: ((root: string) => Record<string, unknown>) | undefined, steps: ScriptedStep[] = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-server-inbox-')));
  const data = join(root, 'data');
  await mkdir(data);
  await writeFile(join(root, 'penelope-token'), `${PENELOPE_TOKEN}\n`);
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ ...serverConfig(root), ...(inbox ? { inbox: inbox(root) } : {}) }));
  const model = new ScriptedModel();
  model.auto = () => steps.shift() ?? { text: '' };
  const logs: string[] = [];
  const server = await startServer({
    config, dataDir: data, cwd: '/', home: join(root, 'home'), env: { NATSUMI_GITHUB_CLIENT_SECRET: CLIENT_SECRET },
    log: line => { logs.push(line); },
    pi: { runtime: fixtureRuntime, configureSession: session => { session.agent.streamFunction = model.streamFunction; } },
  });
  t.after(async () => {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(await server.listening).port}`;
  await writeFile(join(root, 'client-token'), PENELOPE_TOKEN);
  return { root, data, model, logs, server, base, url: `${base}/a2a/`, client: new SdkA2AClient({ tokenFile: join(root, 'client-token') }) };
}

const section = (root: string) => ({
  publicUrl: 'https://natsumi.example.test/a2a/', card: { name: 'なつみ', description: 'マスターの秘書です。' },
  senders: [{ name: 'penelope', tokenFile: join(root, 'penelope-token') }],
});

test('without the config there is no way in: the card and the calls under /a2a/ are not found', async t => {
  const f = await launch(t, undefined);
  for (const [path, method] of [['/a2a/.well-known/agent-card.json', 'GET'], ['/a2a/', 'POST'], ['/a2a', 'POST']] as const) {
    const response = await fetch(`${f.base}${path}`, { method, headers: { authorization: `Bearer ${PENELOPE_TOKEN}`, 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.deepEqual([response.status, await response.json()], [404, { error: 'not-found' }], path);
  }
});

test('with senders the card is served, and the browser’s cookie lets nothing in', async t => {
  const f = await launch(t, section);
  const card = await fetch(`${f.url}.well-known/agent-card.json`);
  assert.equal(card.status, 200);
  assert.equal((await card.json() as { name: string }).name, 'なつみ');
  const refused = await fetch(f.url, { method: 'POST', headers: { cookie: 'natsumi_session=fixture-anything', 'content-type': 'application/json',
    'a2a-version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } }) });
  assert.deepEqual([refused.status, await refused.json()], [401, { error: 'unauthorized' }]);
});

test('a request is put under /sources/inbox and told to her, and her reply_to_agent is the answer the sender gets', async t => {
  const f = await launch(t, section, [
    { calls: [{ name: 'reply_to_agent', arguments: { to: 'penelope', text: 'こんにちは、ペネロペ。', state: 'completed' } }] },
  ]);
  const sent = await f.client.send(f.url, { text: 'なつみさん、こんにちは' });
  assert.equal(sent.kind, 'task');
  if (sent.kind !== 'task') return;
  assert.equal(sent.state, 'waiting');
  const directories = await readdir(join(f.data, 'sources', 'inbox', 'penelope'));
  assert.equal(directories.length, 1, 'written before the task was handed back');
  const answer = await until(async () => {
    const view = await f.client.getTask(f.url, sent.taskId);
    return view.state === 'completed' ? view : undefined;
  });
  assert.equal(answer.text, 'こんにちは、ペネロペ。');
  const shown = f.model.contexts.flatMap(context => context.messages).filter(message => message.role === 'user')
    .map(message => JSON.stringify(message.content));
  assert.ok(shown.some(text => text.includes('agent_request')), 'the request reached her as an attention');
});

test('a sender whose token file cannot be read stops the start, naming the setting only', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-server-inbox-')));
  try {
    await mkdir(join(root, 'data'));
    const config = join(root, 'config.json');
    await writeFile(config, JSON.stringify({ ...serverConfig(root), inbox: { ...section(root),
      senders: [{ name: 'penelope', tokenFile: join(root, 'missing') }] } }));
    await assert.rejects(startServer({ config, dataDir: join(root, 'data'), cwd: '/', home: join(root, 'home'),
      env: { NATSUMI_GITHUB_CLIENT_SECRET: CLIENT_SECRET }, log: () => {},
      pi: { runtime: fixtureRuntime } }),
    (error: Error) => error.message.includes('inbox.senders[0].tokenFile') && !error.message.includes('missing'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
