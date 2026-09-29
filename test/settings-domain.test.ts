import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigError, parseConfig } from '../src/server/config.ts';
import { checkSetting, ROUTE_NAME, SETTING_KEYS } from '../src/shared/protocol/settings.ts';

/** The settings the owner may change while natsumi runs (ADR 0058), and the rules their values keep: the config's. */

test('the settings are the route, the fold, the four limits of a turn, the awake hours and the ping interval', () => {
  assert.deepEqual([...SETTING_KEYS], ['modelRoute', 'turnFold', 'eventModelCalls', 'eventTimeoutMinutes', 'reviewModelCalls',
    'reviewTimeoutMinutes', 'awakeHours', 'pingIntervalMinutes']);
});

test('a name that is not one of them is an unknown setting, whatever its value', () => {
  for (const key of ['compactionThreshold', 'selfCheck', '', 'toString', '__proto__']) {
    assert.deepEqual(checkSetting(key, 1), { ok: false, code: 'unknown-setting' }, key);
  }
});

test('the limits of a turn are positive integers', () => {
  for (const key of ['eventModelCalls', 'eventTimeoutMinutes', 'reviewModelCalls', 'reviewTimeoutMinutes']) {
    assert.deepEqual(checkSetting(key, 1), { ok: true, key, value: 1 });
    assert.deepEqual(checkSetting(key, 120), { ok: true, key, value: 120 });
    for (const value of [0, -1, 1.5, '8', null, true, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(checkSetting(key, value), { ok: false, code: 'invalid-value' }, `${key} ${String(value)}`);
    }
  }
});

test('the ping interval is an integer of at least five minutes, or false for no pings', () => {
  assert.deepEqual(checkSetting('pingIntervalMinutes', 5), { ok: true, key: 'pingIntervalMinutes', value: 5 });
  assert.deepEqual(checkSetting('pingIntervalMinutes', false), { ok: true, key: 'pingIntervalMinutes', value: false });
  for (const value of [4, 0, 30.5, true, '30', null]) {
    assert.deepEqual(checkSetting('pingIntervalMinutes', value), { ok: false, code: 'invalid-value' }, String(value));
  }
});

test('the awake hours are two different 24-hour times, and nothing else', () => {
  assert.deepEqual(checkSetting('awakeHours', { start: '07:30', end: '23:00' }),
    { ok: true, key: 'awakeHours', value: { start: '07:30', end: '23:00' } });
  assert.deepEqual(checkSetting('awakeHours', { start: '22:00', end: '02:00' }),
    { ok: true, key: 'awakeHours', value: { start: '22:00', end: '02:00' } }, 'across midnight');
  for (const value of [{ start: '07:00', end: '07:00' }, { start: '7:00', end: '23:00' }, { start: '24:00', end: '23:00' },
    { start: '07:00' }, { start: '07:00', end: '23:00', zone: 'UTC' }, '07:00-23:00', null, []]) {
    assert.deepEqual(checkSetting('awakeHours', value), { ok: false, code: 'invalid-value' }, JSON.stringify(value));
  }
});

test('the fold is on or off', () => {
  assert.deepEqual(checkSetting('turnFold', 'on'), { ok: true, key: 'turnFold', value: 'on' });
  assert.deepEqual(checkSetting('turnFold', 'off'), { ok: true, key: 'turnFold', value: 'off' });
  for (const value of ['ON', true, '', null]) assert.deepEqual(checkSetting('turnFold', value), { ok: false, code: 'invalid-value' });
});

test('a route is checked for the shape of a name here; whether the config has it is for the service to say', () => {
  assert.deepEqual(checkSetting('modelRoute', 'plus'), { ok: true, key: 'modelRoute', value: 'plus' });
  for (const value of ['', 'Plus', '-plus', 'a'.repeat(33), 3, null]) {
    assert.deepEqual(checkSetting('modelRoute', value), { ok: false, code: 'invalid-value' }, String(value));
  }
  assert.ok(ROUTE_NAME.test('local-2'));
});

test('the config keeps the same rules: what the settings refuse, the config refuses too', () => {
  const config = (loop: Record<string, unknown>) => ({
    publicOrigin: 'https://natsumi.example.test',
    listen: { host: '::', port: 8443, tls: { certFile: '/run/secrets/natsumi-tls-cert', keyFile: '/run/secrets/natsumi-tls-key' } },
    github: { clientId: 'Iv1.fixtureclient', clientSecretEnv: 'NATSUMI_GITHUB_CLIENT_SECRET',
      callbackUrl: 'https://natsumi.example.test/auth/github/callback', allowedUserId: 4242001 },
    pi: { agentDirectory: '/srv/natsumi-pi/agent', sessionDirectory: '/srv/natsumi-pi/sessions', authPath: '/srv/natsumi-pi/agent/auth.json',
      model: { provider: 'openai-codex', id: 'gpt-5.5' }, voiceEnabled: false },
    loop,
  });
  const refused = (loop: Record<string, unknown>, path: string) =>
    assert.throws(() => parseConfig(config(loop)), (error: unknown) => error instanceof ConfigError && error.path === path);
  refused({ eventModelCalls: 0 }, 'loop.eventModelCalls');
  refused({ reviewTimeoutMinutes: 1.5 }, 'loop.reviewTimeoutMinutes');
  refused({ pingIntervalMinutes: 4 }, 'loop.pingIntervalMinutes');
  refused({ awakeHours: { start: '07:00', end: '07:00' } }, 'loop.awakeHours.end');
  refused({ awakeHours: { start: '7:00', end: '23:00' } }, 'loop.awakeHours.start');
  refused({ turnFold: 'ON' }, 'loop.turnFold');
  const parsed = parseConfig(config({ pingIntervalMinutes: false, awakeHours: { start: '22:00', end: '02:00' } }));
  assert.equal(parsed.loop.pingIntervalMinutes, false);
});
