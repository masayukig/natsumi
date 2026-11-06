import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { COMPATIBLE_PROVIDER } from '../src/pi/compatible.ts';
import { catalogContextWindow, routeReady } from '../src/pi/auth.ts';
import { openPiSession } from '../src/pi/session.ts';
import type { ModelRoute, PiConfig } from '../src/server/config.ts';
import { createModelRuntime } from '../src/server/pi-runtime.ts';

// `$HOME` and a leading `!` would be expanded or executed if the key were treated as a Pi config template.
const KEY = '!fixture-$HOME-key';

/** A local stand-in for an OpenAI-compatible Chat Completions endpoint that records the Authorization header and body. */
async function startEndpoint() {
  const authorizations: (string | undefined)[] = [];
  const bodies: Record<string, any>[] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      authorizations.push(request.headers.authorization);
      try { bodies.push(JSON.parse(body) as Record<string, any>); } catch { bodies.push({}); }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({
        id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
        choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.write(chunk({ role: 'assistant', content: 'OK' }, null));
      response.write(chunk({}, 'stop'));
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    authorizations, bodies,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-pi-runtime-')));
  const paths = { cwd: join(root, 'data'), agentDir: join(root, 'pi', 'agent'), sessionDir: join(root, 'pi', 'sessions') };
  for (const dir of Object.values(paths)) await mkdir(dir, { recursive: true });
  const config = (routes: Omit<ModelRoute, 'compactionThreshold'>[]): PiConfig => ({
    agentDirectory: paths.agentDir, sessionDirectory: paths.sessionDir, authPath: join(paths.agentDir, 'auth.json'),
    routes: routes.map(route => ({ ...route, compactionThreshold: 60000 })), defaultRoute: routes[0]!.name,
    thinking: 'on', voiceEnabled: false,
  });
  /** One compatible route named `name` on `baseUrl`, registered under `provider`. */
  const compatible = (baseUrl: string, apiKey: { env: string } | { file: string } = { env: 'FIXTURE_PI_API_KEY' },
    { name = 'local', provider = COMPATIBLE_PROVIDER, model = 'fixture-model', contextWindow = 128_000 } = {}) =>
    ({ name, model: { provider, id: model }, compatible: { baseUrl, apiKey, contextWindow } });
  const subscription = { name: 'plus', model: { provider: 'openai-codex', id: 'gpt-5.6-sol' } };
  return { root, paths, config, compatible, subscription, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const LOCAL = { provider: COMPATIBLE_PROVIDER, model: 'fixture-model' };

test('an OpenAI-compatible endpoint receives exactly the referenced key, from an environment variable or a secret file', async () => {
  const endpoint = await startEndpoint();
  const f = await setup();
  try {
    const keyFile = join(f.root, 'pi-api-key');
    await writeFile(keyFile, `${KEY}\n`, { mode: 0o600 });
    for (const apiKey of [{ env: 'FIXTURE_PI_API_KEY' }, { file: keyFile }]) {
      const runtime = await createModelRuntime(f.config([f.compatible(endpoint.baseUrl, apiKey)]), { FIXTURE_PI_API_KEY: KEY });
      assert.equal(await routeReady(runtime, LOCAL, true), true);
      const session = await openPiSession({ ...f.paths, modelRuntime: runtime, target: LOCAL, systemPrompt: 'fixture', thinkingLevel: 'off' });
      try {
        await session.prompt('hello', { expandPromptTemplates: false });
        const reply = session.messages.at(-1);
        assert.equal(reply?.role === 'assistant' ? reply.stopReason : undefined, 'stop');
      } finally { session.dispose(); }
    }
    assert.deepEqual(endpoint.authorizations, [`Bearer ${KEY}`, `Bearer ${KEY}`]);
  } finally { await f.cleanup(); await endpoint.close(); }
});

test('thinking is requested from a compatible endpoint only when it is switched on', async () => {
  const endpoint = await startEndpoint();
  const f = await setup();
  try {
    const runtime = await createModelRuntime(f.config([f.compatible(endpoint.baseUrl)]), { FIXTURE_PI_API_KEY: KEY });
    for (const thinkingLevel of ['medium', 'off'] as const) {
      const session = await openPiSession({ ...f.paths, modelRuntime: runtime, target: LOCAL, systemPrompt: 'fixture', thinkingLevel });
      try { await session.prompt('hello', { expandPromptTemplates: false }); } finally { session.dispose(); }
    }
    assert.deepEqual(endpoint.bodies.map(body => body.chat_template_kwargs?.enable_thinking), [true, false]);
  } finally { await f.cleanup(); await endpoint.close(); }
});

test('a route without its key or login is not ready, and no other route\'s credentials stand in for it', async () => {
  const endpoint = await startEndpoint();
  const f = await setup();
  try {
    const plus = { provider: 'openai-codex', model: 'gpt-5.6-sol' };
    const notReady = async (routes: Omit<ModelRoute, 'compactionThreshold'>[], target: typeof plus, compatible: boolean,
      env: Record<string, string | undefined> = {}) => {
      const runtime = await createModelRuntime(f.config(routes), env);
      assert.equal(await routeReady(runtime, target, compatible), false);
    };
    await notReady([f.compatible(endpoint.baseUrl)], LOCAL, true);
    await notReady([f.compatible(endpoint.baseUrl, { file: join(f.root, 'missing-key') })], LOCAL, true);
    // The subscription route needs its own OAuth login; an API key in the environment is never used instead.
    await notReady([f.subscription], plus, false, { FIXTURE_PI_API_KEY: KEY, OPENAI_API_KEY: KEY });
    await notReady([f.compatible(endpoint.baseUrl), f.subscription], plus, false, { FIXTURE_PI_API_KEY: KEY, OPENAI_API_KEY: KEY });
    // The server never creates the login file; the owner logs in to it separately.
    await assert.rejects(access(join(f.paths.agentDir, 'auth.json')));
    await writeFile(join(f.paths.agentDir, 'auth.json'), '{}', { mode: 0o600 });
    await notReady([f.subscription], plus, false, { OPENAI_API_KEY: KEY });
    // A model Pi does not know is never ready, whatever the login.
    await notReady([{ name: 'plus', model: { provider: 'openai-codex', id: 'fixture-unknown-model' } }],
      { provider: 'openai-codex', model: 'fixture-unknown-model' }, false);
    assert.deepEqual(endpoint.authorizations, []);
  } finally { await f.cleanup(); await endpoint.close(); }
});

test('a login made after the runtime was built counts once the login file exists at startup', async () => {
  const f = await setup();
  try {
    const plus = { provider: 'openai-codex', model: 'gpt-5.6-sol' };
    const authPath = join(f.paths.agentDir, 'auth.json');
    await writeFile(authPath, '{}', { mode: 0o600 });
    const runtime = await createModelRuntime(f.config([f.subscription]), {});
    assert.equal(await routeReady(runtime, plus, false), false);
    await writeFile(authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh',
      expires: Date.now() + 3_600_000, accountId: 'fixture-account' } }), { mode: 0o600 });
    assert.equal(await routeReady(runtime, plus, false), true);
  } finally { await f.cleanup(); }
});

test('one runtime carries every route, so the session can move between them and each endpoint gets only its own key', async () => {
  const first = await startEndpoint();
  const second = await startEndpoint();
  const f = await setup();
  try {
    const other = { provider: `${COMPATIBLE_PROVIDER}-other`, model: 'fixture-other' };
    const runtime = await createModelRuntime(f.config([f.compatible(first.baseUrl),
      f.compatible(second.baseUrl, { env: 'FIXTURE_OTHER_KEY' }, { name: 'other', provider: other.provider, model: other.model })]),
    { FIXTURE_PI_API_KEY: KEY, FIXTURE_OTHER_KEY: 'fixture-other-key' });
    assert.equal(await routeReady(runtime, other, true), true);
    const session = await openPiSession({ ...f.paths, modelRuntime: runtime, target: LOCAL, systemPrompt: 'fixture', thinkingLevel: 'off' });
    try {
      await session.prompt('hello', { expandPromptTemplates: false });
      await session.setModel(runtime.getModel(other.provider, other.model)!);
      await session.prompt('again', { expandPromptTemplates: false });
    } finally { session.dispose(); }
    assert.deepEqual(first.authorizations, [`Bearer ${KEY}`]);
    assert.deepEqual(second.authorizations, ['Bearer fixture-other-key']);
    assert.equal(second.bodies[0]?.model, 'fixture-other');
    // The same session: the second model is handed what was said to the first.
    assert.match(JSON.stringify(second.bodies[0]?.messages), /hello/);
  } finally { await f.cleanup(); await first.close(); await second.close(); }
});

test('a compaction summary from a compatible endpoint may use all of Pi\'s summary budget, not only a turn\'s share', async () => {
  const endpoint = await startEndpoint();
  const f = await setup();
  try {
    const runtime = await createModelRuntime(f.config([f.compatible(endpoint.baseUrl)]), { FIXTURE_PI_API_KEY: KEY });
    const session = await openPiSession({ ...f.paths, modelRuntime: runtime, target: LOCAL, systemPrompt: 'fixture', thinkingLevel: 'medium',
      keepRecentTokens: 1_000 });
    try {
      for (let i = 0; i < 4; i++) await session.prompt(`fictional ${i} ${'x'.repeat(4_000)}`, { expandPromptTemplates: false });
      await session.compact();
    } finally { session.dispose(); }
    const summary = endpoint.bodies.find(body => JSON.stringify(body.messages?.[0]).includes('summar'));
    assert.ok(summary, 'a summary was asked for');
    // Pi gives a summary the model's whole output limit. Thinking spends the same budget, and on a slow local model a
    // summary cut at 4096 tokens stopped at the cap every time, so no compaction ever succeeded.
    assert.equal(summary.max_tokens, 16_384);
  } finally { await f.cleanup(); await endpoint.close(); }
});

test('Pi measures a compatible model against the configured context window', async () => {
  const endpoint = await startEndpoint();
  const f = await setup();
  try {
    const runtime = await createModelRuntime(f.config([f.compatible(endpoint.baseUrl, undefined, { contextWindow: 262_144 })]),
      { FIXTURE_PI_API_KEY: KEY });
    assert.equal(runtime.getModel(LOCAL.provider, LOCAL.model)?.contextWindow, 262_144);
    const session = await openPiSession({ ...f.paths, modelRuntime: runtime, target: LOCAL, systemPrompt: 'fixture', thinkingLevel: 'off' });
    try { assert.equal(session.getContextUsage()?.contextWindow, 262_144); } finally { session.dispose(); }
  } finally { await f.cleanup(); await endpoint.close(); }
});

test('the window of a subscription model is the one in Pi\'s own model definitions', async () => {
  const f = await setup();
  try {
    assert.equal(await catalogContextWindow(f.paths.agentDir, { provider: 'openai-codex', model: 'gpt-5.6-sol' }), 272_000);
    assert.equal(await catalogContextWindow(f.paths.agentDir, { provider: 'openai-codex', model: 'fixture-unknown-model' }), undefined);
  } finally { await f.cleanup(); }
});
