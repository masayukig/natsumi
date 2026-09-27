import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { isolatedEnvironment, runIsolated, startRelay } from '../src/eval/isolation.ts';
import { bwrapAvailable, goAvailable } from '../src/eval/workspace.ts';
import type { RunRecord } from '../src/eval/record.ts';
import { pullFakeSnapshot } from './support/fake-backup.ts';
import { FAKE_REPLY, startFakeEndpoint } from './support/fake-https.ts';

const run = promisify(execFile);
const REPOSITORY = join(import.meta.dirname, '..');
const skip = !(await goAvailable()) ? 'go is not installed' : !(await bwrapAvailable()) ? 'bubblewrap cannot make a sandbox here' : false;

/** A login for the subscription provider: its access token only has to carry an account for Pi to call with it. */
function fakeLogin(): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const access = `${part({ alg: 'none' })}.${part({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })}.fixture`;
  return JSON.stringify({ 'openai-codex': { type: 'oauth', access, refresh: 'fixture-refresh', expires: Date.now() + 3_600_000 } });
}

// Inside the sandbox, as the evaluation does: the proxy dispatcher kept first, Pi loaded, then a real call on each
// provider's own path. Prints what each call came back with.
const CALLS = `
import { useProxyDispatcher } from ${JSON.stringify(join(REPOSITORY, 'src', 'eval', 'network.ts'))};
import { routesRuntime } from ${JSON.stringify(join(REPOSITORY, 'src', 'pi', 'auth.ts'))};
import { openPiSession } from ${JSON.stringify(join(REPOSITORY, 'src', 'pi', 'session.ts'))};
import { startBridge } from ${JSON.stringify(join(REPOSITORY, 'src', 'eval', 'isolation.ts'))};
useProxyDispatcher();
const env = JSON.parse(process.env.NATSUMI_EVAL_ISOLATED);
await startBridge(env.relay);
const [root, login] = process.argv.slice(2);
const ask = async (name, runtime, target) => {
  const session = await openPiSession({ cwd: root, agentDir: join(root, name), sessionDir: join(root, name, 's'), modelRuntime: runtime, target,
    systemPrompt: 'fixture', thinkingLevel: 'off' });
  await session.prompt('hello', { expandPromptTemplates: false });
  const last = session.messages.at(-1);
  return { stop: last.stopReason, error: last.errorMessage ?? null, text: last.content.map(part => part.text ?? '').join('') };
};
import { join } from 'node:path';
const result = {
  compatible: await ask('compatible', await routesRuntime(join(root, 'compatible'), { compatible: [{ provider: 'natsumi-compatible', apiKey: 'fixture-key',
    endpoint: { baseUrl: 'https://llm.fixture.test/v1', model: 'fixture-model' } }] }), { provider: 'natsumi-compatible', model: 'fixture-model' }),
  subscription: await ask('subscription', await routesRuntime(join(root, 'subscription'), { authPath: login, compatible: [] }),
    { provider: 'openai-codex', model: 'gpt-6-sol' }),
};
console.log(JSON.stringify(result));
process.exit(0);
`;

test('isolated, a compatible endpoint and the subscription are both reached on their providers\' own paths, through the relay', { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-route-'));
  let fake: Awaited<ReturnType<typeof startFakeEndpoint>> | undefined;
  try {
    fake = await startFakeEndpoint(await mkdirp(join(root, 'tls')), ['llm.fixture.test', 'chatgpt.com', 'auth.openai.com']);
    const work = await mkdirp(join(root, 'work'));
    await writeFile(join(work, 'auth.json'), fakeLogin());
    await writeFile(join(root, 'calls.mjs'), CALLS);
    const at = `127.0.0.1:${fake.port}`;
    // The real names, pointed at the fake endpoint where the relay connects; the sandbox never resolves a name.
    const relay = await startRelay({ socketPath: join(work, 'relay.sock'), allow: ['llm.fixture.test:443', 'chatgpt.com:443', 'auth.openai.com:443'],
      connectTo: { 'llm.fixture.test:443': at, 'chatgpt.com:443': at, 'auth.openai.com:443': at } });
    const out = join(work, 'out.json');
    const code = await runIsolated({ command: ['sh', '-c', `"${process.execPath}" "${join(root, 'calls.mjs')}" "$@" > "${out}"`, 'calls', work,
      join(work, 'auth.json')], writable: [work], cwd: root,
    env: isolatedEnvironment({ relaySocket: join(work, 'relay.sock'), runnerSocket: join(work, 'runner.sock'), tmp: work,
      pass: { NODE_EXTRA_CA_CERTS: fake.ca } }) });
    await relay.close();
    assert.equal(code, 0);
    const result = JSON.parse(await readFile(out, 'utf8'));
    assert.deepEqual(result.compatible, { stop: 'stop', error: null, text: FAKE_REPLY });
    assert.deepEqual(result.subscription, { stop: 'stop', error: null, text: FAKE_REPLY });
    assert.ok(relay.passed.includes('llm.fixture.test:443') && relay.passed.includes('chatgpt.com:443'), relay.passed.join(','));
    assert.deepEqual(relay.refused, []);
    const paths = fake.requests.map(request => `${request.host} ${request.path}`);
    assert.ok(paths.includes('llm.fixture.test /v1/chat/completions'), paths.join(','));
    assert.ok(paths.includes('chatgpt.com /backend-api/codex/responses'), paths.join(','));
  } finally {
    await fake?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a run on a snapshot reaches a compatible endpoint from inside the isolation, and a call that fails leaves its reason', { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-route-cli-'));
  let fake: Awaited<ReturnType<typeof startFakeEndpoint>> | undefined;
  try {
    const { store } = await pullFakeSnapshot(root);
    fake = await startFakeEndpoint(await mkdirp(join(root, 'tls')), ['localhost']);
    const scenes = await mkdirp(join(root, 'scenes', 'reach'));
    await writeFile(join(scenes, 'scene.yaml'), 'start: { snapshot: latest }\nevent: { mac_message: おはよう }\nchecks:\n  - { id: finished, finished: true }\n');
    await writeFile(join(root, 'key'), 'fixture-secret-key-6127\n');
    const model = (port: number) => JSON.stringify({ pi: { model: { provider: 'natsumi-compatible', id: 'fixture-model' },
      compatible: { baseUrl: `https://localhost:${port}/v1`, apiKeyFile: join(root, 'key') } } });
    await writeFile(join(root, 'model.json'), model(fake.port));
    await writeFile(join(root, 'closed.json'), model(1));
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/SLACK|APNS|A2A/i.test(name))), NODE_EXTRA_CA_CERTS: fake.ca };
    const cli = (label: string, file: string) => run(process.execPath, [join(REPOSITORY, 'src', 'eval', 'cli.ts'), 'run', '--scenes', join(root, 'scenes'),
      '--snapshots', store, '--out', join(root, 'results'), '--label', label, '--model', join(root, file), '--no-judge', '--runs', '1'],
    { cwd: REPOSITORY, encoding: 'utf8', env });
    const records = async (label: string) => (await readFile(join(root, 'results', label, 'runs.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as RunRecord);

    await cli('reached', 'model.json');
    const [reached] = await records('reached');
    assert.equal(reached!.outcome, 'ok', reached!.error);
    assert.equal(reached!.calls[0]!.text, FAKE_REPLY);
    assert.ok(fake.requests.some(request => request.path === '/v1/chat/completions' && request.authorization === 'Bearer fixture-secret-key-6127'));

    await cli('closed', 'closed.json');
    const [failed] = await records('closed');
    assert.equal(failed!.outcome, 'model-error');
    assert.match(failed!.error ?? '', /Connection error/);
    assert.match(failed!.calls[0]!.error ?? '', /Connection error/);
    const summary = await readFile(join(root, 'results', 'closed', 'summary.md'), 'utf8');
    assert.match(summary, /失敗の理由[\s\S]*reach[\s\S]*model-error[\s\S]*Connection error/);
    const json = JSON.parse(await readFile(join(root, 'results', 'closed', 'summary.json'), 'utf8'));
    assert.deepEqual(json.conditions[0].failures.map((failure: { outcome: string; runs: number }) => [failure.outcome, failure.runs]), [['model-error', 1]]);

    // Neither the key nor the endpoint is kept anywhere in the results.
    const found = await run('grep', ['-r', '-l', '-e', 'fixture-secret-key-6127', join(root, 'results')]).catch(error => error);
    assert.equal(found.stdout ?? '', '');
  } finally {
    await fake?.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function mkdirp(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}
