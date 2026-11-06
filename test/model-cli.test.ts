import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseCli, UsageError } from '../src/server/cli.ts';
import { STATE_DIRECTORY } from '../src/server/data-directory.ts';
import { readRouteChoice, runModelCommand, writeRouteChoice, writeRouteStatus, type RouteStatus } from '../src/server/model-routes.ts';
import { writeStatus } from '../src/server/status.ts';

// The server's command line for the model routes (ADR 0046): what it reads and writes in the data directory.

const NOW = Date.parse('2026-09-26T00:00:00Z');

async function setup() {
  const data = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-model-cli-')));
  await mkdir(join(data, STATE_DIRECTORY), { mode: 0o700 });
  const out: string[] = [];
  const run = (argv: string[]) => {
    const cli = parseCli(argv);
    assert.equal(cli.command, 'model');
    out.length = 0;
    return runModelCommand(cli as Extract<typeof cli, { command: 'model' }>, data, line => { out.push(line); }, () => NOW);
  };
  return { data, out, run, cleanup: () => rm(data, { recursive: true, force: true }) };
}

const STATUS: RouteStatus = {
  defaultRoute: 'local', current: 'local', chosen: 'local',
  routes: [{ name: 'local', provider: 'natsumi-compatible', model: 'fixture-local', ready: true },
    { name: 'plus', provider: 'openai-codex', model: 'gpt-5.6-sol', ready: true },
    { name: 'spare', provider: 'openai-codex', model: 'gpt-5.4', ready: false }],
};

async function running(data: string) {
  await writeStatus(data, { state: 'running', pid: 1, startedAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    schemaVersion: 1 });
}

test('the command line has model list, status and use, beside serve and health', () => {
  assert.deepEqual(parseCli(['model', 'list', '--data-dir', '/d']), { command: 'model', action: 'list', dataDir: '/d' });
  assert.deepEqual(parseCli(['model', 'status']), { command: 'model', action: 'status', dataDir: undefined });
  assert.deepEqual(parseCli(['model', 'use', 'plus', '--data-dir', '/d']), { command: 'model', action: 'use', route: 'plus', dataDir: '/d' });
  for (const argv of [['model'], ['model', 'switch'], ['model', 'use'], ['model', 'use', 'a', 'b'], ['model', 'list', 'extra'],
    ['model', 'list', '--config', 'c.json']]) {
    assert.throws(() => parseCli(argv), UsageError, argv.join(' '));
  }
});

test('the choice is kept in the data directory, privately, and read back', async () => {
  const f = await setup();
  try {
    assert.equal(await readRouteChoice(f.data), undefined);
    await writeRouteChoice(f.data, 'plus', NOW);
    assert.equal(await readRouteChoice(f.data), 'plus');
    const file = join(f.data, STATE_DIRECTORY, 'model-route.json');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { route: 'plus', chosenAt: '2026-09-26T00:00:00.000Z' });
  } finally { await f.cleanup(); }
});

test('model list and status show the routes the server published, which one is in use and which is chosen', async () => {
  const f = await setup();
  try {
    assert.equal(await f.run(['model', 'list']), 1);
    assert.match(f.out.join('\n'), /no route list yet/);
    await writeRouteStatus(f.data, { ...STATUS, chosen: 'plus' }, NOW);
    await running(f.data);
    assert.equal(await f.run(['model', 'list']), 0);
    assert.deepEqual(f.out, [
      '* local  natsumi-compatible/fixture-local  ready  (default, in use)',
      '  plus   openai-codex/gpt-5.6-sol          ready  (chosen)',
      '  spare  openai-codex/gpt-5.4              not ready',
    ]);
    assert.equal(await f.run(['model', 'status']), 0);
    assert.deepEqual(f.out, ['in use: local', 'chosen: plus (natsumi moves to it before her next turn)', 'default: local']);
  } finally { await f.cleanup(); }
});

test('model use writes the choice for a route that exists and is ready, and says when it takes effect', async () => {
  const f = await setup();
  try {
    await writeRouteStatus(f.data, STATUS, NOW);
    await running(f.data);
    assert.equal(await f.run(['model', 'use', 'plus']), 0);
    assert.deepEqual(f.out, ['chose plus: natsumi moves to it before her next turn']);
    assert.equal(await readRouteChoice(f.data), 'plus');

    assert.equal(await f.run(['model', 'use', 'nowhere']), 1);
    assert.match(f.out.join('\n'), /no route named nowhere.*local, plus, spare/);
    assert.equal(await f.run(['model', 'use', 'spare']), 1);
    assert.match(f.out.join('\n'), /spare is not ready/);
    assert.equal(await readRouteChoice(f.data), 'plus');

    // Stopped: the choice waits for the next start.
    await writeStatus(f.data, { state: 'stopped', pid: 1, startedAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
      schemaVersion: 1 });
    assert.equal(await f.run(['model', 'use', 'local']), 0);
    assert.deepEqual(f.out, ['chose local: natsumi uses it from her next start']);
  } finally { await f.cleanup(); }
});

test('before the server ever ran, model use still records the choice for the first start', async () => {
  const f = await setup();
  try {
    assert.equal(await f.run(['model', 'use', 'plus']), 0);
    assert.deepEqual(f.out, ['chose plus: natsumi uses it from her next start (the route list is not known yet)']);
    assert.equal(await readRouteChoice(f.data), 'plus');
    assert.equal(await f.run(['model', 'use', 'Not A Name']), 1);
  } finally { await f.cleanup(); }
});
