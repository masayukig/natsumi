import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { subscriptionRuntime } from '../src/pi/auth.ts';
import { COMPATIBLE_PROVIDER } from '../src/pi/compatible.ts';
import { COMPATIBLE_KEY_ENV, compatibleRuntime } from '../src/probe/auth.ts';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';

test('missing auth does not create credentials or fall back to environment API keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-auth-fixture-'));
  try {
    const path = join(root, 'auth.json');
    await assert.rejects(subscriptionRuntime(root, path, SUBSCRIPTION_TARGET.provider), /login required/);
    await assert.rejects(access(path));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an API-key credential is rejected before any model call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-auth-fixture-'));
  try {
    const path = join(root, 'auth.json');
    await writeFile(path, JSON.stringify({ 'openai-codex': { type: 'api_key', key: 'fixture-only' } }));
    await assert.rejects(subscriptionRuntime(root, path, SUBSCRIPTION_TARGET.provider), /login required/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const endpoint = { baseUrl: 'https://llm.example.invalid/v1', model: 'fixture-model' };

test('compatible endpoint requires its key in the environment and writes no credential file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-compat-fixture-'));
  try {
    await assert.rejects(compatibleRuntime(root, endpoint, {}), /API key required/);
    await assert.rejects(compatibleRuntime(root, endpoint, { [COMPATIBLE_KEY_ENV]: '' }), /API key required/);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compatible endpoint rejects plaintext remote URLs but allows loopback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-compat-fixture-'));
  const env = { [COMPATIBLE_KEY_ENV]: 'fixture-key' };
  try {
    await assert.rejects(compatibleRuntime(root, { ...endpoint, baseUrl: 'http://llm.example.invalid/v1' }, env), /https/);
    await assert.rejects(compatibleRuntime(root, { ...endpoint, baseUrl: 'not a url' }, env), /https/);
    const local = await compatibleRuntime(root, { ...endpoint, baseUrl: 'http://127.0.0.1:8080/v1' }, env);
    assert.ok(local.getModel(COMPATIBLE_PROVIDER, 'fixture-model'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compatible endpoint registers one thinking-capable chat-completions model and references the key by env name only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-compat-fixture-'));
  try {
    const runtime = await compatibleRuntime(root, endpoint, { [COMPATIBLE_KEY_ENV]: 'fixture-secret-value' });
    const model = runtime.getModel(COMPATIBLE_PROVIDER, 'fixture-model');
    assert.equal(model?.api, 'openai-completions');
    assert.equal(model?.baseUrl, endpoint.baseUrl);
    // Thinking is switched per session through Pi's thinking level (ADR 0008); the model itself can think.
    assert.equal(model?.reasoning, true);
    assert.equal((model?.compat as { thinkingFormat?: string } | undefined)?.thinkingFormat, 'qwen-chat-template');
    assert.deepEqual(runtime.getModels(COMPATIBLE_PROVIDER).map(m => m.id), ['fixture-model']);
    const config = runtime.getRegisteredProviderConfig(COMPATIBLE_PROVIDER);
    assert.equal(config?.apiKey, `$${COMPATIBLE_KEY_ENV}`);
    assert.doesNotMatch(JSON.stringify(config), /fixture-secret-value/);
    assert.equal(runtime.getModel('openai-codex', 'gpt-5.6-sol') !== undefined && runtime.hasConfiguredAuth('openai-codex'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
