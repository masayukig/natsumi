import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { STATE_DIRECTORY } from '../src/server/data-directory.ts';
import type { Fold } from '../src/shared/protocol/settings.ts';
import { RuntimeSettings, type RouteControl, type SettingsDefaults } from '../src/server/settings/service.ts';
import { readOverrides, RUNTIME_SETTINGS_FILE } from '../src/server/settings/store.ts';

/**
 * The runtime settings as the ways in use them (ADR 0058): the list with the config's value beside the one in force,
 * an override written or taken back, a change told to every device, and the values the loop and the scheduler read.
 */

const NOW = Date.parse('2026-09-29T03:00:00.000Z');

const DEFAULTS: SettingsDefaults = {
  turnFold: 'off', eventModelCalls: 8, eventTimeoutMinutes: 10, reviewModelCalls: 40, reviewTimeoutMinutes: 30,
  awakeHours: { start: '07:00', end: '23:00' }, pingIntervalMinutes: 180, timeZone: 'Asia/Tokyo',
};

/** The loop's side of the routes and the fold, as a stand-in: what it chose, where it is, and what is ready. */
class FakeRoutes implements RouteControl {
  unavailable: string | undefined;
  current: string | null = 'local';
  chosen = 'local';
  foldNow: Fold = 'off';
  readonly routes = [
    { name: 'local', provider: 'natsumi-compatible', model: 'example-model', ready: true },
    { name: 'plus', provider: 'openai-codex', model: 'example-plus', ready: true },
    { name: 'spare', provider: 'natsumi-spare', model: 'example-spare', ready: false },
  ];
  readonly chosenBy: string[] = [];
  refreshed = 0;
  private readonly data: string;
  constructor(data: string) { this.data = data; }
  routeStatus() { return { defaultRoute: 'local', current: this.current, chosen: this.chosen, routes: this.routes }; }
  async chooseRoute(input: { route: string; deviceId: string }) {
    if (this.unavailable) return { kind: 'unavailable' as const, code: this.unavailable };
    const route = this.routes.find(candidate => candidate.name === input.route);
    if (!route) return { kind: 'rejected' as const, code: 'unknown-route' };
    if (!route.ready) return { kind: 'rejected' as const, code: 'route-unavailable' };
    // The loop records the choice where the command line does, as the real one does.
    await writeFile(join(this.data, STATE_DIRECTORY, 'model-route.json'), JSON.stringify({ route: route.name }));
    this.chosen = route.name;
    this.chosenBy.push(input.deviceId);
    return { kind: 'accepted' as const, chosen: route.name, current: this.current ?? route.name };
  }
  async refreshRoutes() {
    this.refreshed += 1;
    const file = await readFile(join(this.data, STATE_DIRECTORY, 'model-route.json'), 'utf8').catch(() => undefined);
    this.chosen = file ? JSON.parse(file).route : 'local';
  }
  foldInUse() { return this.foldNow; }
}

async function withSettings(fn: (context: { settings: RuntimeSettings; routes: FakeRoutes; data: string; logs: string[];
  events: Record<string, any>[] }) => Promise<void>, prepare?: (state: string) => Promise<void>) {
  const data = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-settings-service-')));
  const state = join(data, STATE_DIRECTORY);
  await mkdir(state, { mode: 0o700 });
  await prepare?.(state);
  const routes = new FakeRoutes(data);
  const logs: string[] = [];
  const settings = await RuntimeSettings.open({ dataDirectory: data, defaults: DEFAULTS, routes, now: () => NOW, log: line => logs.push(line) });
  const events: Record<string, any>[] = [];
  settings.subscribe(event => events.push(event));
  try { await fn({ settings, routes, data, logs, events }); } finally { await rm(data, { recursive: true, force: true }); }
}

test('with no overrides every setting is the config’s, and the loop reads the config’s values', () => withSettings(async ({ settings }) => {
  const view = settings.view();
  assert.deepEqual(view.modelRoute, { value: 'local', config: 'local', overridden: false, inUse: 'local', routes: [
    { name: 'local', provider: 'natsumi-compatible', model: 'example-model', ready: true },
    { name: 'plus', provider: 'openai-codex', model: 'example-plus', ready: true },
    { name: 'spare', provider: 'natsumi-spare', model: 'example-spare', ready: false },
  ] });
  assert.deepEqual(view.turnFold, { value: 'off', config: 'off', overridden: false, inUse: 'off' });
  assert.deepEqual(view.eventModelCalls, { value: 8, config: 8, overridden: false });
  assert.deepEqual(view.reviewTimeoutMinutes, { value: 30, config: 30, overridden: false });
  assert.deepEqual(view.awakeHours, { value: { start: '07:00', end: '23:00' }, config: { start: '07:00', end: '23:00' }, overridden: false,
    timeZone: 'Asia/Tokyo' });
  assert.deepEqual(view.pingIntervalMinutes, { value: 180, config: 180, overridden: false });
  assert.deepEqual(settings.turnLimits(), { eventModelCalls: 8, eventTimeoutMinutes: 10, reviewModelCalls: 40, reviewTimeoutMinutes: 30 });
  assert.deepEqual(settings.awakeHours(), { start: '07:00', end: '23:00' });
  assert.equal(settings.pingIntervalMinutes(), 180);
}));

test('overrides already in the data directory win from the start, the route and the fold of before included', () => withSettings(async ({ settings }) => {
  const view = settings.view();
  assert.equal(view.turnFold.value, 'on');
  assert.equal(view.turnFold.overridden, true);
  assert.equal(view.modelRoute.overridden, true);
  assert.deepEqual(view.eventModelCalls, { value: 12, config: 8, overridden: true });
  assert.equal(settings.turnLimits().eventModelCalls, 12);
  assert.equal(settings.pingIntervalMinutes(), false);
}, async state => {
  await writeFile(join(state, 'model-route.json'), JSON.stringify({ route: 'plus' }));
  await writeFile(join(state, 'turn-fold.json'), JSON.stringify({ fold: 'on' }));
  await writeFile(join(state, RUNTIME_SETTINGS_FILE), JSON.stringify({ overrides: { eventModelCalls: 12, pingIntervalMinutes: false } }));
}));

test('an override that breaks the rules is left out at the start, with its name in the log', () => withSettings(async ({ settings, logs }) => {
  assert.equal(settings.turnLimits().reviewModelCalls, 40);
  assert.ok(logs.some(line => line.includes('reviewModelCalls')), logs.join('\n'));
}, async state => {
  await writeFile(join(state, RUNTIME_SETTINGS_FILE), JSON.stringify({ overrides: { reviewModelCalls: -3 } }));
}));

test('setting a value writes the override, answers with the list and tells every device once', () => withSettings(async ({ settings, data, events }) => {
  const outcome = await settings.set({ key: 'eventModelCalls', value: 16, deviceId: 'device-a' });
  assert.equal(outcome.kind, 'accepted');
  assert.deepEqual(outcome.kind === 'accepted' && outcome.settings.eventModelCalls, { value: 16, config: 8, overridden: true });
  assert.equal(settings.turnLimits().eventModelCalls, 16, 'the next turn reads it');
  assert.deepEqual((await readOverrides(data)).values, { eventModelCalls: 16 });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'settings.changed');
  assert.deepEqual(events[0]!.payload.settings.eventModelCalls, { value: 16, config: 8, overridden: true });
  await settings.set({ key: 'awakeHours', value: { start: '09:00', end: '01:00' }, deviceId: 'device-a' });
  assert.deepEqual(settings.awakeHours(), { start: '09:00', end: '01:00' });
  await settings.set({ key: 'pingIntervalMinutes', value: false, deviceId: 'device-a' });
  assert.equal(settings.pingIntervalMinutes(), false);
}));

test('a value the config would refuse is refused, and nothing is written or told', () => withSettings(async ({ settings, data, events }) => {
  assert.deepEqual(await settings.set({ key: 'eventModelCalls', value: 0, deviceId: 'd' }), { kind: 'rejected', code: 'invalid-value' });
  assert.deepEqual(await settings.set({ key: 'pingIntervalMinutes', value: 2, deviceId: 'd' }), { kind: 'rejected', code: 'invalid-value' });
  assert.deepEqual(await settings.set({ key: 'compactionThreshold', value: 1, deviceId: 'd' }), { kind: 'rejected', code: 'unknown-setting' });
  assert.deepEqual(await settings.reset({ key: 'listen', deviceId: 'd' }), { kind: 'rejected', code: 'unknown-setting' });
  assert.deepEqual((await readOverrides(data)).values, {});
  assert.equal(events.length, 0);
}));

test('setting the same value as the config is still an override, until it is reset', () => withSettings(async ({ settings }) => {
  await settings.set({ key: 'reviewModelCalls', value: 40, deviceId: 'd' });
  assert.deepEqual(settings.view().reviewModelCalls, { value: 40, config: 40, overridden: true });
  const outcome = await settings.reset({ key: 'reviewModelCalls', deviceId: 'd' });
  assert.equal(outcome.kind, 'accepted');
  assert.deepEqual(settings.view().reviewModelCalls, { value: 40, config: 40, overridden: false });
}));

test('resetting takes the override away and the config’s value is in force again', () => withSettings(async ({ settings, data, events }) => {
  await settings.set({ key: 'eventTimeoutMinutes', value: 25, deviceId: 'd' });
  await settings.reset({ key: 'eventTimeoutMinutes', deviceId: 'd' });
  assert.equal(settings.turnLimits().eventTimeoutMinutes, 10);
  assert.deepEqual((await readOverrides(data)).values, {});
  assert.equal(events.length, 2);
  await settings.reset({ key: 'eventTimeoutMinutes', deviceId: 'd' });
  assert.equal(events.length, 2, 'nothing changed, so nothing is told');
}));

test('a route goes through the loop’s choice, with its codes; resetting clears the choice and asks the loop to look again', () => withSettings(async ({ settings, routes, events }) => {
  assert.deepEqual(await settings.set({ key: 'modelRoute', value: 'spare', deviceId: 'd' }), { kind: 'rejected', code: 'route-unavailable' });
  assert.deepEqual(await settings.set({ key: 'modelRoute', value: 'nowhere', deviceId: 'd' }), { kind: 'rejected', code: 'unknown-route' });
  assert.deepEqual(await settings.set({ key: 'modelRoute', value: 'Plus!', deviceId: 'd' }), { kind: 'rejected', code: 'invalid-value' });
  const chosen = await settings.set({ key: 'modelRoute', value: 'plus', deviceId: 'device-b' });
  assert.equal(chosen.kind, 'accepted');
  assert.deepEqual(routes.chosenBy, ['device-b']);
  assert.deepEqual(settings.view().modelRoute.value, 'plus');
  assert.equal(settings.view().modelRoute.overridden, true);
  assert.equal(settings.view().modelRoute.inUse, 'local', 'it moves between turns');
  const reset = await settings.reset({ key: 'modelRoute', deviceId: 'd' });
  assert.equal(reset.kind, 'accepted');
  assert.equal(routes.refreshed, 1);
  assert.deepEqual(settings.view().modelRoute.value, 'local');
  assert.equal(settings.view().modelRoute.overridden, false);
  assert.equal(events.length, 2);
}));

test('the fold is written for the loop to follow before its next turn; in use stays what the loop says', () => withSettings(async ({ settings, routes, data }) => {
  await settings.set({ key: 'turnFold', value: 'on', deviceId: 'd' });
  assert.deepEqual(settings.view().turnFold, { value: 'on', config: 'off', overridden: true, inUse: 'off' });
  assert.deepEqual((await readOverrides(data)).values, { turnFold: 'on' });
  routes.foldNow = 'on';
  await settings.refresh();
  assert.equal(settings.view().turnFold.inUse, 'on');
}));

test('a change made outside (the command line, the route moving) is found by a refresh and told once', () => withSettings(async ({ settings, routes, data, events }) => {
  await settings.refresh();
  assert.equal(events.length, 0, 'nothing changed');
  await writeFile(join(data, STATE_DIRECTORY, 'turn-fold.json'), JSON.stringify({ fold: 'on' }));
  routes.current = 'plus';
  await settings.refresh();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.payload.settings.turnFold.value, 'on');
  assert.equal(events[0]!.payload.settings.modelRoute.inUse, 'plus');
  await settings.refresh();
  assert.equal(events.length, 1);
}));

test('while natsumi cannot talk, the list and every change answer that she cannot', () => withSettings(async ({ settings, routes }) => {
  routes.unavailable = 'pi-unavailable';
  assert.deepEqual(settings.list(), { kind: 'unavailable', code: 'pi-unavailable' });
  assert.deepEqual(await settings.set({ key: 'eventModelCalls', value: 9, deviceId: 'd' }), { kind: 'unavailable', code: 'pi-unavailable' });
  assert.deepEqual(await settings.reset({ key: 'eventModelCalls', deviceId: 'd' }), { kind: 'unavailable', code: 'pi-unavailable' });
  routes.unavailable = undefined;
  const listed = settings.list();
  assert.equal(listed.kind, 'accepted');
}));

test('changes from two devices at once are written one after the other, and neither is lost', () => withSettings(async ({ settings, data }) => {
  await Promise.all([
    settings.set({ key: 'eventModelCalls', value: 11, deviceId: 'a' }),
    settings.set({ key: 'reviewModelCalls', value: 44, deviceId: 'b' }),
    settings.set({ key: 'pingIntervalMinutes', value: 60, deviceId: 'c' }),
  ]);
  assert.deepEqual((await readOverrides(data)).values, { eventModelCalls: 11, reviewModelCalls: 44, pingIntervalMinutes: 60 });
}));
