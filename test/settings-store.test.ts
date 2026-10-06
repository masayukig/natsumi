import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { STATE_DIRECTORY } from '../src/server/data-directory.ts';
import { readFoldChoice } from '../src/server/fold-setting.ts';
import { readRouteChoice, writeRouteChoice } from '../src/server/model-routes.ts';
import { clearOverride, readOverrides, RUNTIME_SETTINGS_FILE, writeOverride } from '../src/server/settings/store.ts';

/**
 * Where the owner's overrides are kept (ADR 0058): the route and the fold in the files they have always had, which the
 * command line writes too, and the rest in one file of their own that only the server writes.
 */

const NOW = Date.parse('2026-09-29T03:00:00.000Z');

async function withData(fn: (data: string, state: string) => Promise<void>) {
  const data = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-settings-store-')));
  const state = join(data, STATE_DIRECTORY);
  await mkdir(state, { mode: 0o700 });
  try { await fn(data, state); } finally { await rm(data, { recursive: true, force: true }); }
}

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

test('a data directory with no overrides has none', () => withData(async data => {
  assert.deepEqual(await readOverrides(data), { values: {}, ignored: [] });
}));

test('the route and the fold chosen before this change are read from the files production already has', () => withData(async (data, state) => {
  await writeFile(join(state, 'model-route.json'), `${JSON.stringify({ route: 'plus', chosenAt: '2026-09-27T01:00:00.000Z' })}\n`);
  await writeFile(join(state, 'turn-fold.json'), `${JSON.stringify({ fold: 'on', chosenAt: '2026-09-27T01:00:00.000Z' })}\n`);
  assert.deepEqual(await readOverrides(data), { values: { modelRoute: 'plus', turnFold: 'on' }, ignored: [] });
}));

test('the route and the fold are written in the same shape as the command line writes them, and it reads them', () => withData(async (data, state) => {
  await writeOverride(data, 'modelRoute', 'spare', NOW);
  await writeOverride(data, 'turnFold', 'off', NOW);
  assert.deepEqual(await readJson(join(state, 'model-route.json')), { route: 'spare', chosenAt: '2026-09-29T03:00:00.000Z' });
  assert.deepEqual(await readJson(join(state, 'turn-fold.json')), { fold: 'off', chosenAt: '2026-09-29T03:00:00.000Z' });
  assert.equal(await readRouteChoice(data), 'spare');
  assert.equal(await readFoldChoice(data), 'off');
  await writeRouteChoice(data, 'plus', NOW);
  assert.equal((await readOverrides(data)).values.modelRoute, 'plus', 'the command line writes through the same store');
}));

test('the other settings share one file, private to the server, and writing one keeps the others', () => withData(async (data, state) => {
  await writeOverride(data, 'eventModelCalls', 12, NOW);
  await writeOverride(data, 'awakeHours', { start: '08:00', end: '22:30' }, NOW);
  await writeOverride(data, 'pingIntervalMinutes', false, NOW);
  const path = join(state, RUNTIME_SETTINGS_FILE);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const file = await readJson(path);
  assert.deepEqual(file.overrides, { eventModelCalls: 12, awakeHours: { start: '08:00', end: '22:30' }, pingIntervalMinutes: false });
  assert.equal(file.updatedAt, '2026-09-29T03:00:00.000Z');
  assert.deepEqual(await readOverrides(data), {
    values: { eventModelCalls: 12, awakeHours: { start: '08:00', end: '22:30' }, pingIntervalMinutes: false }, ignored: [],
  });
}));

test('clearing an override takes back only that one; clearing one that is not there does nothing', () => withData(async (data, state) => {
  await writeOverride(data, 'modelRoute', 'plus', NOW);
  await writeOverride(data, 'turnFold', 'on', NOW);
  await writeOverride(data, 'eventModelCalls', 12, NOW);
  await writeOverride(data, 'reviewTimeoutMinutes', 45, NOW);
  await clearOverride(data, 'modelRoute', NOW);
  await clearOverride(data, 'eventModelCalls', NOW);
  await clearOverride(data, 'pingIntervalMinutes', NOW);
  assert.deepEqual(await readOverrides(data), { values: { turnFold: 'on', reviewTimeoutMinutes: 45 }, ignored: [] });
  assert.equal(await readRouteChoice(data), undefined, 'the choice file is gone, so the default applies');
  await clearOverride(data, 'turnFold', NOW);
  await clearOverride(data, 'turnFold', NOW);
  assert.equal(await readFoldChoice(data), undefined);
  assert.ok((await readJson(join(state, RUNTIME_SETTINGS_FILE))).overrides.reviewTimeoutMinutes === 45);
}));

test('a value in the file that breaks the rules, or a name that is not a setting, is left out and named', () => withData(async (data, state) => {
  await writeFile(join(state, RUNTIME_SETTINGS_FILE), JSON.stringify({
    overrides: { eventModelCalls: 0, awakeHours: { start: '09:00', end: '09:00' }, reviewModelCalls: 50, compactionThreshold: 1, modelRoute: 'x' },
  }));
  await writeFile(join(state, 'turn-fold.json'), JSON.stringify({ fold: 'sometimes' }));
  assert.deepEqual(await readOverrides(data), {
    values: { reviewModelCalls: 50 }, ignored: ['eventModelCalls', 'awakeHours', 'compactionThreshold', 'modelRoute'],
  });
}));

test('a file that cannot be read as JSON is as good as none, and is named', () => withData(async (data, state) => {
  await writeFile(join(state, RUNTIME_SETTINGS_FILE), '{ half');
  assert.deepEqual(await readOverrides(data), { values: {}, ignored: [RUNTIME_SETTINGS_FILE] });
  await writeOverride(data, 'eventTimeoutMinutes', 20, NOW);
  assert.deepEqual(await readOverrides(data), { values: { eventTimeoutMinutes: 20 }, ignored: [] }, 'writing starts it over');
}));

test('the curator\'s route and limits share the server\'s file; null for natsumi\'s route is an override kept like any other (ADR 0068)', () => withData(async (data, state) => {
  await writeOverride(data, 'curatorRoute', null, NOW);
  await writeOverride(data, 'curatorTimeoutMinutes', 45, NOW);
  assert.deepEqual((await readJson(join(state, RUNTIME_SETTINGS_FILE))).overrides, { curatorRoute: null, curatorTimeoutMinutes: 45 });
  assert.deepEqual(await readOverrides(data), { values: { curatorRoute: null, curatorTimeoutMinutes: 45 }, ignored: [] });
  await writeOverride(data, 'curatorModelCalls', 90, NOW);
  assert.deepEqual((await readOverrides(data)).values, { curatorRoute: null, curatorTimeoutMinutes: 45, curatorModelCalls: 90 }, 'writing one keeps the null');
  await clearOverride(data, 'curatorRoute', NOW);
  assert.deepEqual((await readOverrides(data)).values, { curatorTimeoutMinutes: 45, curatorModelCalls: 90 });
  await writeOverride(data, 'curatorRoute', 'plus', NOW);
  assert.equal((await readOverrides(data)).values.curatorRoute, 'plus');
}));
