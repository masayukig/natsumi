import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PiConfig } from '../src/server/config.ts';
import { PiStateError, preparePiState } from '../src/server/pi-state.ts';

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-pi-state-')));
  const data = join(root, 'data');
  const home = join(root, 'home');
  await mkdir(data); await mkdir(home);
  const pi = (base = join(root, 'pi')): PiConfig => ({
    agentDirectory: join(base, 'agent'), sessionDirectory: join(base, 'sessions'), authPath: join(base, 'agent', 'auth.json'),
    routes: [{ name: 'default', model: { provider: 'openai-codex', id: 'gpt-5.6-sol' }, compactionThreshold: 60000 }], defaultRoute: 'default',
    thinking: 'on', voiceEnabled: false,
  });
  return { root, data, home, pi, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('the dedicated Pi state area is created privately without inventing credentials', async () => {
  const f = await setup();
  try {
    const config = f.pi();
    await preparePiState(config, { dataDirectory: f.data, home: f.home });
    for (const dir of [config.agentDirectory, config.sessionDirectory]) {
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
    }
    await assert.rejects(access(config.authPath));
    await preparePiState(config, { dataDirectory: f.data, home: f.home });
  } finally { await f.cleanup(); }
});

test('an existing auth file is left untouched', async () => {
  const f = await setup();
  try {
    const config = f.pi();
    await mkdir(config.agentDirectory, { recursive: true, mode: 0o700 });
    await writeFile(config.authPath, '{}', { mode: 0o600 });
    await preparePiState(config, { dataDirectory: f.data, home: f.home });
    assert.equal((await stat(config.authPath)).size, 2);
  } finally { await f.cleanup(); }
});

test('Pi state is kept apart from the data directory', async () => {
  const f = await setup();
  try {
    await assert.rejects(preparePiState(f.pi(join(f.data, 'pi')), { dataDirectory: f.data, home: f.home }),
      (error: unknown) => error instanceof PiStateError && error.path === 'pi.agentDirectory' && /data directory/.test(error.message));
    const nested = { ...f.pi(), authPath: join(f.data, 'auth.json') };
    await assert.rejects(preparePiState(nested, { dataDirectory: f.data, home: f.home }), /pi\.authPath/);
    // The data directory placed inside the Pi area overlaps as well.
    const around = f.pi(f.root);
    await assert.rejects(preparePiState({ ...around, sessionDirectory: f.root }, { dataDirectory: f.data, home: f.home }), /data directory/);
  } finally { await f.cleanup(); }
});

test('the personal Pi or Codex configuration of the user is never shared', async () => {
  const f = await setup();
  try {
    for (const base of [join(f.home, '.pi'), join(f.home, '.codex')]) {
      await assert.rejects(preparePiState(f.pi(base), { dataDirectory: f.data, home: f.home }),
        (error: unknown) => error instanceof PiStateError && /personal/.test(error.message));
    }
  } finally { await f.cleanup(); }
});

test('Pi state inside a natsumi code checkout is refused', async () => {
  const f = await setup();
  try {
    await writeFile(join(f.root, 'package.json'), JSON.stringify({ name: 'natsumi' }));
    await assert.rejects(preparePiState(f.pi(join(f.root, 'pi')), { dataDirectory: f.data, home: f.home }), /code checkout/);
  } finally { await f.cleanup(); }
});
