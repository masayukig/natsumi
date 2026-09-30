import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigError, parseConfig } from '../src/server/config.ts';

// Named model routes in the config (ADR 0046). Every value here is fictional.

const directories = () => ({
  agentDirectory: '/srv/natsumi-pi/agent',
  sessionDirectory: '/srv/natsumi-pi/sessions',
  authPath: '/srv/natsumi-pi/agent/auth.json',
  voiceEnabled: false,
});
const endpoint = (extra: Record<string, unknown> = {}) =>
  ({ baseUrl: 'https://llm.example.test/v1', apiKeyEnv: 'NATSUMI_PI_API_KEY', ...extra });
const local = (extra: Record<string, unknown> = {}) =>
  ({ model: { provider: 'natsumi-compatible', id: 'fixture-local' }, compatible: endpoint(), ...extra });
const plus = (extra: Record<string, unknown> = {}) => ({ model: { provider: 'openai-codex', id: 'gpt-5.5' }, ...extra });
const base = (pi: Record<string, unknown>, rest: Record<string, unknown> = {}) => ({
  pi: { ...directories(), ...pi },
  publicOrigin: 'https://natsumi.example.test',
  listen: { host: '127.0.0.1', port: 8443, tls: false },
  github: { clientId: 'Iv1.fixtureclient', clientSecretEnv: 'NATSUMI_GITHUB_CLIENT_SECRET',
    callbackUrl: 'https://natsumi.example.test/auth/github/callback', allowedUserId: 4242001 },
  ...rest,
});
const slack = () => ({ workspaces: { work: { botTokenEnv: 'SLACK_BOT', appTokenEnv: 'SLACK_APP' } } });
// Room above the threshold: a turn's growth (32768), the longest reply (16384) and Pi's margin (4096).
const ROOM = 32768 + 16384 + 4096;

function rejects(raw: unknown, path: string, reason?: RegExp) {
  assert.throws(() => parseConfig(raw), (error: unknown) => {
    assert.ok(error instanceof ConfigError, String(error));
    assert.equal(error.path, path);
    if (reason) assert.match(error.message, reason);
    return true;
  });
}

test('a config with only pi.model is one route named default, under the loop\'s threshold', () => {
  const config = parseConfig(base({ model: { provider: 'openai-codex', id: 'gpt-5.5' } }));
  assert.deepEqual(config.pi.routes, [{ name: 'default', model: { provider: 'openai-codex', id: 'gpt-5.5' }, compactionThreshold: 60000 }]);
  assert.equal(config.pi.defaultRoute, 'default');
  const compatible = parseConfig(base(local(), { loop: { compactionThreshold: 50000 } }));
  assert.deepEqual(compatible.pi.routes, [{ name: 'default', model: { provider: 'natsumi-compatible', id: 'fixture-local' },
    compatible: { baseUrl: 'https://llm.example.test/v1', apiKey: { env: 'NATSUMI_PI_API_KEY' }, contextWindow: 128000 },
    compactionThreshold: 50000 }]);
});

test('named routes keep their order, name the default, and each may set its own threshold', () => {
  const config = parseConfig(base({ routes: { local: local(), plus: plus({ compactionThreshold: 150000 }) }, defaultRoute: 'local' }));
  assert.equal(config.pi.defaultRoute, 'local');
  assert.deepEqual(config.pi.routes.map(route => [route.name, route.model.provider, route.model.id, route.compactionThreshold]),
    [['local', 'natsumi-compatible', 'fixture-local', 60000], ['plus', 'openai-codex', 'gpt-5.5', 150000]]);
  assert.equal(config.pi.routes[0]!.compatible?.baseUrl, 'https://llm.example.test/v1');
  assert.equal('compatible' in config.pi.routes[1]!, false);
});

test('the routes and the single model are one or the other, and the default must be one of the routes', () => {
  rejects(base({ ...plus(), routes: { plus: plus() }, defaultRoute: 'plus' }), 'pi.routes', /pi\.model/);
  rejects(base({}), 'pi.routes', /required/);
  rejects(base({ routes: {}, defaultRoute: 'plus' }), 'pi.routes', /at least one/);
  rejects(base({ routes: { plus: plus() } }), 'pi.defaultRoute', /required/);
  rejects(base({ routes: { plus: plus() }, defaultRoute: 'local' }), 'pi.defaultRoute', /routes/);
  rejects(base({ ...plus(), defaultRoute: 'default' }), 'pi.defaultRoute', /routes/);
  rejects(base({ routes: { 'Plus Route': plus() }, defaultRoute: 'Plus Route' }), 'pi.routes.Plus Route', /name/);
  rejects(base({ routes: { plus: plus({ window: 1 }) }, defaultRoute: 'plus' }), 'pi.routes.plus.window', /unknown/);
  rejects(base({ routes: { plus: { model: { provider: 'openai-codex' } } }, defaultRoute: 'plus' }), 'pi.routes.plus.model.id', /required/);
  rejects(base({ routes: { plus: plus({ compactionThreshold: 5000 }) }, defaultRoute: 'plus' }), 'pi.routes.plus.compactionThreshold');
});

test('each compatible route has an endpoint under a provider of its own', () => {
  const routes = (b: Record<string, unknown>) => base({ routes: { a: local(), b }, defaultRoute: 'a' });
  const second = parseConfig(routes(local({ model: { provider: 'natsumi-compatible-b', id: 'fixture-other' },
    compatible: endpoint({ baseUrl: 'https://other.example.test/v1' }) })));
  assert.deepEqual(second.pi.routes.map(route => route.model.provider), ['natsumi-compatible', 'natsumi-compatible-b']);
  rejects(routes(local()), 'pi.routes.b.model.provider', /another route/);
  rejects(routes(plus({ compatible: endpoint() })), 'pi.routes.b.model.provider', /natsumi-compatible/);
  rejects(routes({ model: { provider: 'natsumi-compatible-b', id: 'x' } }), 'pi.routes.b.compatible', /required/);
  rejects(routes(local({ compatible: endpoint({ baseUrl: 'http://llm.example.test/v1' }) })), 'pi.routes.b.compatible.baseUrl', /https/);
});

test('the threshold of every route is checked against its window when the config is read', () => {
  const config = (route: Record<string, unknown>, loop: Record<string, unknown> = {}) =>
    base({ routes: { plus: plus(), local: route }, defaultRoute: 'plus' }, { loop });
  assert.equal(parseConfig(config(local({ compactionThreshold: 128000 - ROOM }))).pi.routes[1]!.compactionThreshold, 128000 - ROOM);
  rejects(config(local({ compactionThreshold: 128000 - ROOM + 1 })), 'pi.routes.local.compactionThreshold',
    /pi\.routes\.local\.compatible\.contextWindow/);
  // A route without its own threshold is held to the loop's.
  rejects(config(local(), { compactionThreshold: 100000 }), 'loop.compactionThreshold', /pi\.routes\.local\.compatible\.contextWindow/);
  assert.equal(parseConfig(config(local({ compactionThreshold: 60000 }), { compactionThreshold: 100000 })).loop.compactionThreshold, 100000);
  assert.equal(parseConfig(config(local({ compatible: endpoint({ contextWindow: 262144 }) }), { compactionThreshold: 150000 }))
    .pi.routes[1]!.compactionThreshold, 150000);
  // What is kept at a compaction must be smaller than every route's threshold.
  rejects(config(local({ compactionThreshold: 20000 })), 'pi.routes.local.compactionThreshold', /compactionKeepRecent/);
});

test('the dove\'s judge borrows the default route\'s compatible model, whichever route is in use', () => {
  const judge = (pi: Record<string, unknown>) => parseConfig(base(pi, { slack: slack() })).slack?.judge?.logprobs;
  const other = local({ model: { provider: 'natsumi-compatible-b', id: 'fixture-other' },
    compatible: endpoint({ baseUrl: 'https://other.example.test/v1', apiKeyEnv: 'OTHER_KEY' }) });
  const borrowed = judge({ routes: { other, local: local(), plus: plus() }, defaultRoute: 'local' });
  assert.equal(borrowed?.baseUrl, 'https://llm.example.test/v1');
  assert.equal(borrowed?.model, 'fixture-local');
  assert.deepEqual(borrowed?.apiKey, { env: 'NATSUMI_PI_API_KEY' });
  // A default without a compatible model has nothing to lend, even when another route has one.
  assert.equal(judge({ routes: { local: local(), plus: plus() }, defaultRoute: 'plus' }), undefined);
});
