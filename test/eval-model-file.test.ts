import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { routeReady } from '../src/pi/auth.ts';
import { modelRuntime, readModelFile } from '../src/eval/model-file.ts';

const SECRET = 'fixture-secret-key-4471';

async function withFiles(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-model-file-'));
  try { await body(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('a model file is written like the pi section of the config, and its key is read only into the runtime', async () => {
  await withFiles(async root => {
    await writeFile(join(root, 'key'), `${SECRET}\n`);
    await writeFile(join(root, 'model.json'), JSON.stringify({ pi: {
      model: { provider: 'natsumi-compatible', id: 'example-model' },
      compatible: { baseUrl: 'https://llm.example.net/v1', apiKeyFile: join(root, 'key'), contextWindow: 65536 },
    } }));
    const file = await readModelFile(join(root, 'model.json'));
    assert.deepEqual(file.target, { provider: 'natsumi-compatible', model: 'example-model' });
    assert.equal(file.compatible, true);
    assert.equal(file.thinking, 'on');
    // What a result may carry: never the endpoint, never the key.
    assert.deepEqual(file.shown, { provider: 'natsumi-compatible', id: 'example-model' });
    assert.ok(!JSON.stringify(file).includes(SECRET));
    const runtime = await modelRuntime(file, root, {});
    assert.equal(await routeReady(runtime, file.target, true), true);
  });
});

test('a subscription model needs the login file, and thinking may be turned off', async () => {
  await withFiles(async root => {
    await writeFile(join(root, 'judge.json'), JSON.stringify({ pi: {
      model: { provider: 'openai-codex', id: 'gpt-6-sol' }, authPath: join(root, 'auth.json'), thinking: 'off',
    } }));
    const file = await readModelFile(join(root, 'judge.json'));
    assert.deepEqual(file.target, { provider: 'openai-codex', model: 'gpt-6-sol' });
    assert.equal(file.compatible, false);
    assert.equal(file.thinking, 'off');
    const runtime = await modelRuntime(file, root, {});
    // No login file: the route exists but is not ready, and nothing stands in for it.
    assert.equal(await routeReady(runtime, file.target, false), false);
  });
});

test('a model file out of shape names the setting and never echoes a value', async () => {
  await withFiles(async root => {
    const cases: [unknown, RegExp][] = [
      [{ pi: { model: { provider: 'openai-codex', id: 'x' } } }, /pi\.authPath/],
      [{ pi: { model: { provider: 'natsumi-compatible', id: 'x' } } }, /pi\.compatible/],
      [{ pi: { model: { provider: 'natsumi-compatible', id: 'x' }, compatible: { baseUrl: 'http://llm.example.net/v1', apiKeyFile: '/k' } } }, /baseUrl/],
      [{ pi: { model: { provider: 'openai-codex', id: 'x' }, authPath: '/a', extra: 'hidden-value' } }, /pi/],
    ];
    for (const [content, message] of cases) {
      await writeFile(join(root, 'bad.json'), JSON.stringify(content));
      await assert.rejects(readModelFile(join(root, 'bad.json')), (error: Error) => {
        assert.match(error.message, message);
        assert.ok(!error.message.includes('hidden-value'));
        return true;
      });
    }
  });
});
