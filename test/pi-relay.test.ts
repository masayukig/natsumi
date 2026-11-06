import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { catalogContextWindow, relayFetch, routeReady } from '../src/pi/auth.ts';
import { openPiSession } from '../src/pi/session.ts';
import type { ModelRoute, PiConfig } from '../src/server/config.ts';
import { createModelRuntime } from '../src/server/pi-runtime.ts';

// The subscription through the standard Responses API, through a relay on loopback (ADR 0087). Every value is fictional.

const PLUS = { provider: 'openai', model: 'gpt-6.1-sol' };
const ACCESS = 'fixture-chatgpt-access-token';
const THINKING = 'fixture-encrypted-thinking';

interface Received { method: string; path: string; headers: IncomingHttpHeaders; body: Record<string, any> }

/** A stand-in for the relay, answering every request as the Responses API streams a short reply. */
async function startRelay() {
  const received: Received[] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      let parsed: Record<string, any> = {};
      try { parsed = JSON.parse(body) as Record<string, any>; } catch { /* not JSON */ }
      received.push({ method: request.method!, path: request.url!, headers: request.headers, body: parsed });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (data: Record<string, unknown>) => response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
      // The thinking comes back encrypted, as it does when nothing is stored on the server.
      const reasoning = { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: THINKING };
      const item = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
      event({ type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress' } });
      event({ type: 'response.output_item.added', output_index: 0, item: { ...reasoning, encrypted_content: undefined } });
      event({ type: 'response.output_item.done', output_index: 0, item: reasoning });
      event({ type: 'response.output_item.added', output_index: 1, item: { ...item, status: 'in_progress', content: [] } });
      event({ type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'OK' });
      event({ type: 'response.output_item.done', output_index: 1, item });
      event({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [reasoning, item],
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 } } } });
      response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    received,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-pi-relay-')));
  const paths = { cwd: join(root, 'data'), agentDir: join(root, 'pi', 'agent'), sessionDir: join(root, 'pi', 'sessions') };
  for (const dir of Object.values(paths)) await mkdir(dir, { recursive: true });
  const authPath = join(paths.agentDir, 'auth.json');
  const config = (routes: Omit<ModelRoute, 'compactionThreshold'>[]): PiConfig => ({
    agentDirectory: paths.agentDir, sessionDirectory: paths.sessionDir, authPath,
    routes: routes.map(route => ({ ...route, compactionThreshold: 60000 })), defaultRoute: routes[0]!.name,
    thinking: 'on', voiceEnabled: false,
  });
  /** A login to the subscription as Pi's "Sign in with ChatGPT" stores it. */
  const login = () => writeFile(authPath, JSON.stringify({ openai: { type: 'oauth', access: ACCESS, refresh: 'fixture-refresh',
    expires: Date.now() + 3_600_000 } }), { mode: 0o600 });
  return { root, paths, authPath, config, login, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const relayed = (url: string) => ({ name: 'plus', model: { provider: PLUS.provider, id: PLUS.model }, relay: { url } });

test('through a relay, Pi talks to the loopback address as a Sign in with ChatGPT client with a placeholder key', async () => {
  const relay = await startRelay();
  const f = await setup();
  try {
    // A login on disk is never read for the relayed route: the relay holds the real token.
    await f.login();
    const runtime = await createModelRuntime(f.config([relayed(relay.url)]), {});
    assert.equal(await routeReady(runtime, PLUS, false), true);
    const session = await openPiSession({ ...f.paths, modelRuntime: runtime, target: PLUS, systemPrompt: 'fixture instructions',
      thinkingLevel: 'medium' });
    try {
      for (const text of ['hello', 'again']) {
        await session.prompt(text, { expandPromptTemplates: false });
        const reply = session.messages.at(-1);
        assert.equal(reply?.role === 'assistant' ? reply.stopReason : undefined, 'stop');
      }
    } finally { session.dispose(); }
    const sent = relay.received.filter(request => request.path === '/v1/responses');
    assert.ok(sent.length >= 2, 'both turns went to the relay');
    // The second turn hands back the first one's thinking as it came, and keeps the same cache key.
    const again = sent.find(request => JSON.stringify(request.body.input).includes('again'))!;
    assert.ok(again.body.input.some((entry: Record<string, unknown>) => entry.type === 'reasoning' && entry.encrypted_content === THINKING));
    assert.equal(again.body.prompt_cache_key, sent[0]!.body.prompt_cache_key);
    for (const { method, headers, body } of sent) {
      assert.equal(method, 'POST');
      // Not a secret, and not an API key: Pi treats anything else on the official base as a ChatGPT sign-in.
      assert.equal(headers.authorization, 'Bearer natsumi-relay');
      assert.doesNotMatch(String(headers.authorization), /sk-|fixture-chatgpt/);
      assert.equal(body.model, PLUS.model);
      // The prefix cache: keyed by the session, and the fields a ChatGPT sign-in refuses are left out.
      assert.equal(typeof body.prompt_cache_key, 'string');
      assert.equal(body.prompt_cache_key, headers.session_id);
      assert.equal('prompt_cache_retention' in body, false);
      assert.equal('prompt_cache_options' in body, false);
      assert.doesNotMatch(JSON.stringify(body), /configuration_update/);
      // The thinking carries on from turn to turn without anything stored on the server.
      assert.equal(body.store, false);
      assert.deepEqual(body.include, ['reasoning.encrypted_content']);
      assert.equal(body.reasoning?.effort, 'medium');
      assert.match(JSON.stringify(body.input ?? body.instructions), /fixture instructions/);
    }
    assert.equal(relay.received.every(request => request.path.startsWith('/v1/')), true);
  } finally { await f.cleanup(); await relay.close(); }
});

test('the relay\'s fetch sends only the OpenAI API to the relay and refuses any other address', async () => {
  const relay = await startRelay();
  try {
    const fetch = relayFetch(relay.url);
    const answer = await fetch('https://api.openai.com/v1/responses?fixture=1', { method: 'POST', body: '{}' });
    await answer.text();
    assert.equal(relay.received.at(-1)?.path, '/v1/responses?fixture=1');
    await assert.rejects(fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', body: '{}' }));
    await assert.rejects(fetch('http://api.openai.com/v1/responses', { method: 'POST', body: '{}' }));
    assert.equal(relay.received.length, 1);
  } finally { await relay.close(); }
});

test('directly, an openai route is ready only with its own Sign in with ChatGPT login, never an API key', async () => {
  const relay = await startRelay();
  const f = await setup();
  try {
    const direct = { name: 'plus', model: { provider: PLUS.provider, id: PLUS.model } };
    // Pi reads an API key from its own environment; one there never makes the subscription route ready.
    process.env.OPENAI_API_KEY = 'sk-fixture-environment';
    try {
      const before = await createModelRuntime(f.config([direct]), {});
      assert.equal(await routeReady(before, PLUS, false), false);
    } finally { delete process.env.OPENAI_API_KEY; }
    await f.login();
    const after = await createModelRuntime(f.config([direct]), {});
    assert.equal(await routeReady(after, PLUS, false), true);
    // A relay is only ever the configured one, never a way the direct route is sent.
    assert.deepEqual(relay.received, []);
  } finally { await f.cleanup(); await relay.close(); }
});

test('the window Pi gives the openai model is smaller than the legacy one', async () => {
  const f = await setup();
  try {
    assert.equal(await catalogContextWindow(f.paths.agentDir, PLUS), 272_000);
    assert.equal(await catalogContextWindow(f.paths.agentDir, { provider: 'openai-codex', model: PLUS.model }), 500_000);
  } finally { await f.cleanup(); }
});
