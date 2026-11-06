import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { CURATOR_DEFAULTS, LOOP_DEFAULTS } from '../src/server/config.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop, type LoopOptions } from '../src/server/thinking-loop.ts';
import type { BackgroundJobs } from '../src/server/workspace-shell.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { startFakeRunner } from './support/fake-runner.ts';
import { ScriptedModel, type ScriptedStep } from './support/scripted-model.ts';

// natsumi's run_shell with a wait of her choosing (ADR 0094), from the model's call to the runner's request.

async function setup(t: test.TestContext, options: Partial<LoopOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-background-loop-')));
  const data = join(root, 'data');
  const memory = join(data, 'memory');
  await mkdir(memory, { recursive: true });
  await mkdir(join(root, 'pi', 'sessions'), { recursive: true });
  await mkdir(join(root, 'pi', 'agent'), { recursive: true });
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const model = new ScriptedModel();
  const runner = await startFakeRunner({ dir: memory });
  const loop = await ThinkingLoop.open({
    db, dataDirectory: data, sessionDirectory: join(root, 'pi', 'sessions'), agentDirectory: join(root, 'pi', 'agent'),
    target: SUBSCRIPTION_TARGET, thinking: 'on', runtime: fixtureRuntime,
    loop: { ...LOOP_DEFAULTS, timeZone: 'Asia/Tokyo', workspaceSocket: runner.path },
    curator: { ...CURATOR_DEFAULTS, stopStartingAt: false },
    configureSession: session => { session.agent.streamFunction = model.streamFunction; },
    ...options,
  });
  t.after(async () => {
    await loop.close();
    await runner.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const play = async (steps: ScriptedStep[]) => {
    model.auto = () => steps.shift() ?? { text: '済んだ' };
    const outcome = loop.send({ requestId: 'request-1', deviceId: 'device-1', text: '集計して' });
    assert.equal(outcome.kind, 'accepted');
    await loop.idle();
  };
  return { runner, play };
}

const call = (name: string, args: Record<string, unknown>) => ({ calls: [{ name, arguments: args }] });
const jobs: BackgroundJobs = { open: async () => '/sources/jobs/x', end: async () => {} };

test('her run_shell carries the wait she chose to the runner and asks for the end to be followed', async t => {
  const f = await setup(t, { jobs });
  await f.play([call('run_shell', { command: 'echo one', wait_seconds: 0 }), call('run_shell', { command: 'echo two' })]);
  assert.deepEqual(f.runner.requests.map(({ command, waitSeconds, follow }) => ({ command, waitSeconds, follow })), [
    { command: 'echo one', waitSeconds: 0, follow: true },
    { command: 'echo two', waitSeconds: undefined, follow: true },
  ]);
});

test('with nowhere to put the jobs, her commands are not asked to be followed', async t => {
  const f = await setup(t);
  await f.play([call('run_shell', { command: 'echo one', wait_seconds: 3 })]);
  assert.deepEqual(f.runner.requests.map(({ waitSeconds, follow }) => ({ waitSeconds, follow })), [{ waitSeconds: 3, follow: undefined }]);
});
