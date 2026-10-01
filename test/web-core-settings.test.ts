import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsProps } from '../src/web/core/props.ts';
import { parseSettingInput } from '../src/web/core/settings.ts';
import { Driver, server, settingsView, snapshot } from './web-core-fixtures.ts';

/**
 * The settings (`/settings`) as the core decides them (ADR 0058, docs/client-contract.md 実行中の設定): the config's value
 * beside the one in force, a change checked by the contract's rules before it is sent, a reset, and the words for the
 * server's refusals.
 */

const onSettings = (view = settingsView()) => new Driver({ screen: 'settings' }).synced({ settings: view });
const row = (driver: Driver, key: string) => settingsProps(driver.state).rows.find(item => item.key === key)!;

test('every runtime setting is listed with the config’s value and the one in force', () => {
  const driver = onSettings(settingsView({ eventModelCalls: { value: 12, config: 8, overridden: true },
    pingIntervalMinutes: { value: false, config: 180, overridden: true } }));
  const rows = settingsProps(driver.state).rows;
  assert.deepEqual(rows.map(item => item.key), ['modelRoute', 'turnFold', 'eventModelCalls', 'eventTimeoutMinutes',
    'reviewModelCalls', 'reviewTimeoutMinutes', 'awakeHours', 'pingIntervalMinutes', 'judgeLogprobs', 'judgeJev', 'judgeAdopted',
    'judgeLogprobsThresholds', 'judgeJevThresholds']);
  assert.deepEqual([row(driver, 'eventModelCalls').valueText, row(driver, 'eventModelCalls').configText], ['12 回', '8 回']);
  assert.equal(row(driver, 'eventModelCalls').overridden, true);
  assert.equal(row(driver, 'eventModelCalls').canReset, true);
  assert.equal(row(driver, 'eventTimeoutMinutes').canReset, false);
  assert.deepEqual([row(driver, 'pingIntervalMinutes').valueText, row(driver, 'pingIntervalMinutes').configText], ['合図しない', '180 分']);
  assert.equal(row(driver, 'awakeHours').valueText, '07:00〜23:00（Asia/Tokyo）');
});

test('a route or a fold not in use yet says it takes effect from the next turn', () => {
  const driver = onSettings(settingsView({
    modelRoute: { ...settingsView().modelRoute, value: 'plus', overridden: true, inUse: 'local' },
    turnFold: { value: 'on', config: 'off', overridden: true, inUse: 'off' },
  }));
  assert.equal(row(driver, 'modelRoute').note, '次のターンから（いまは local）');
  assert.equal(row(driver, 'turnFold').note, '次のターンから（いまは off）');
  assert.equal(row(driver, 'eventModelCalls').note, undefined);
  driver.dispatch(server('settings.changed', { settings: settingsView({
    modelRoute: { ...settingsView().modelRoute, value: 'plus', overridden: true, inUse: 'plus' } }) }, { seq: 2 }));
  assert.equal(row(driver, 'modelRoute').note, undefined, 'another device’s change, or the move itself, is taken');
});

test('a route that is not ready cannot be chosen', () => {
  const control = row(onSettings(), 'modelRoute').control;
  assert.equal(control.kind, 'select');
  assert.deepEqual(control.kind === 'select' && control.options.map(option => [option.value, option.disabled]),
    [['local', false], ['plus', false], ['spare', true]]);
});

test('the dove’s judges are on or off, one without an endpoint in the config cannot be turned on, and one is adopted (ADR 0059)', () => {
  const driver = onSettings();
  assert.deepEqual([row(driver, 'judgeLogprobs').valueText, row(driver, 'judgeJev').valueText], ['on', 'off']);
  const jev = row(driver, 'judgeJev').control;
  assert.deepEqual(jev.kind === 'select' && jev.options.map(option => [option.value, option.disabled]), [['on', true], ['off', false]]);
  assert.match(row(driver, 'judgeJev').note ?? '', /config に接続先がありません/);
  const logprobs = row(driver, 'judgeLogprobs').control;
  assert.deepEqual(logprobs.kind === 'select' && logprobs.options.map(option => [option.value, option.disabled]), [['on', false], ['off', false]]);
  const adopted = row(driver, 'judgeAdopted').control;
  assert.deepEqual(adopted.kind === 'select' && adopted.options.map(option => option.value), ['logprobs', 'jev']);
  assert.deepEqual(parseSettingInput({ key: 'judgeJev', choice: 'off' }), { ok: true, key: 'judgeJev', value: 'off' });
  assert.deepEqual(parseSettingInput({ key: 'judgeAdopted', choice: 'jev' }), { ok: true, key: 'judgeAdopted', value: 'jev' });
  assert.equal(parseSettingInput({ key: 'judgeAdopted', choice: 'both' }).ok, false);
  const [set] = Driver.sent(driver.dispatch({ type: 'setting-submit', input: { key: 'judgeJev', choice: 'on' } }));
  driver.dispatch(server('command.rejected', { code: 'judge-unavailable' }, { seq: 2, requestId: set!.requestId }));
  assert.match(row(driver, 'judgeJev').error ?? '', /接続先/);
});

test('the input is checked by the contract’s rules before anything is sent', () => {
  assert.deepEqual(parseSettingInput({ key: 'eventModelCalls', text: '12' }), { ok: true, key: 'eventModelCalls', value: 12 });
  for (const text of ['0', '1.5', '', 'たくさん']) {
    const parsed = parseSettingInput({ key: 'eventModelCalls', text });
    assert.ok(!parsed.ok && /1 以上の整数/.test(parsed.message), text);
  }
  assert.deepEqual(parseSettingInput({ key: 'pingIntervalMinutes', text: '', off: true }), { ok: true, key: 'pingIntervalMinutes', value: false });
  assert.deepEqual(parseSettingInput({ key: 'pingIntervalMinutes', text: '30', off: false }), { ok: true, key: 'pingIntervalMinutes', value: 30 });
  const short = parseSettingInput({ key: 'pingIntervalMinutes', text: '4', off: false });
  assert.ok(!short.ok && /5 以上/.test(short.message));
  assert.deepEqual(parseSettingInput({ key: 'awakeHours', start: '22:00', end: '06:30' }), { ok: true, key: 'awakeHours', value: { start: '22:00', end: '06:30' } });
  const same = parseSettingInput({ key: 'awakeHours', start: '07:00', end: '07:00' });
  assert.ok(!same.ok && /同じ時刻/.test(same.message));
  const bad = parseSettingInput({ key: 'awakeHours', start: '7:00', end: '23:00' });
  assert.ok(!bad.ok && /始まり/.test(bad.message));
  assert.deepEqual(parseSettingInput({ key: 'turnFold', fold: 'on' }), { ok: true, key: 'turnFold', value: 'on' });
});

test('a change is sent as settings.set, shown as saving, and the answer’s list is taken', () => {
  const driver = onSettings();
  const [set] = Driver.sent(driver.dispatch({ type: 'setting-submit', input: { key: 'eventModelCalls', text: '12' } }));
  assert.deepEqual([set?.type, set?.payload], ['settings.set', { key: 'eventModelCalls', value: 12 }]);
  assert.equal(row(driver, 'eventModelCalls').busy, true);
  driver.dispatch(server('command.accepted', { settings: settingsView({ eventModelCalls: { value: 12, config: 8, overridden: true } }) },
    { seq: 2, requestId: set!.requestId }));
  assert.equal(row(driver, 'eventModelCalls').busy, false);
  assert.equal(row(driver, 'eventModelCalls').valueText, '12 回');
});

test('a value against the rules is not sent, and says why beside the setting', () => {
  const driver = onSettings();
  assert.deepEqual(Driver.sent(driver.dispatch({ type: 'setting-submit', input: { key: 'eventModelCalls', text: '0' } })), []);
  assert.match(row(driver, 'eventModelCalls').error ?? '', /1 以上の整数/);
  assert.equal(row(driver, 'eventTimeoutMinutes').error, undefined);
});

test('the server’s refusals are said in words', () => {
  const driver = onSettings();
  const [set] = Driver.sent(driver.dispatch({ type: 'setting-submit', input: { key: 'modelRoute', route: 'plus' } }));
  driver.dispatch(server('command.rejected', { code: 'route-unavailable' }, { seq: 2, requestId: set!.requestId }));
  assert.match(row(driver, 'modelRoute').error ?? '', /使える状態にありません/);
  assert.equal(row(driver, 'modelRoute').busy, false);
  const [again] = Driver.sent(driver.dispatch({ type: 'setting-submit', input: { key: 'eventModelCalls', text: '9' } }));
  driver.dispatch(server('service.unavailable', { code: 'pi-unavailable' }, { seq: 3, requestId: again!.requestId }));
  assert.match(row(driver, 'eventModelCalls').error ?? '', /話せない/);
});

test('putting back the config’s value is settings.reset', () => {
  const driver = onSettings(settingsView({ eventModelCalls: { value: 12, config: 8, overridden: true } }));
  const [reset] = Driver.sent(driver.dispatch({ type: 'setting-reset', key: 'eventModelCalls' }));
  assert.deepEqual([reset?.type, reset?.payload], ['settings.reset', { key: 'eventModelCalls' }]);
  driver.dispatch(server('command.accepted', { settings: settingsView() }, { seq: 2, requestId: reset!.requestId }));
  assert.equal(row(driver, 'eventModelCalls').overridden, false);
  assert.equal(row(driver, 'eventModelCalls').valueText, '8 回');
});

test('before the list has come, the settings say they are waiting for it', () => {
  const driver = new Driver({ screen: 'settings' });
  driver.dispatch({ type: 'started' });
  const props = settingsProps(driver.state);
  assert.deepEqual(props.rows, []);
  assert.match(props.status.text, /つない/);
});

test('each judge\'s thresholds are shown and changed as two numbers, checked by the contract\'s rules (ADR 0059)', () => {
  const driver = onSettings();
  assert.deepEqual([row(driver, 'judgeJevThresholds').valueText, row(driver, 'judgeJevThresholds').configText],
    ['本人へ 0.6・突き返す 0.95', '本人へ 0.5・突き返す 0.9']);
  const control = row(driver, 'judgeJevThresholds').control;
  assert.deepEqual(control, { kind: 'thresholds', owner: '0.6', return: '0.95' });
  assert.deepEqual(parseSettingInput({ key: 'judgeJevThresholds', owner: '0.7', return: '0.99' }),
    { ok: true, key: 'judgeJevThresholds', value: { owner: 0.7, return: 0.99 } });
  for (const [owner, returnAt] of [['0.9', '0.5'], ['0', '0.9'], ['0.5', ''], ['x', '0.9']]) {
    const parsed = parseSettingInput({ key: 'judgeJevThresholds', owner: owner!, return: returnAt! });
    assert.equal(parsed.ok, false, `${owner} ${returnAt}`);
  }
  const [set] = Driver.sent(driver.dispatch({ type: 'setting-submit', input: { key: 'judgeLogprobsThresholds', owner: '0.4', return: '0.8' } }));
  assert.deepEqual([set?.type, set?.payload], ['settings.set', { key: 'judgeLogprobsThresholds', value: { owner: 0.4, return: 0.8 } }]);
});

test('this browser’s notifications are turned on and off here, and the subscription is registered on every sync (ADR 0065)', () => {
  const driver = onSettings();
  const notifications = () => settingsProps(driver.state).notifications;
  assert.deepEqual(notifications(), { status: 'unsupported' }, 'until the browser has been looked at');
  driver.dispatch({ type: 'push-checked', supported: true });
  assert.deepEqual(notifications(), { status: 'off' });

  assert.deepEqual(driver.dispatch({ type: 'push-toggle', on: true }), [{ kind: 'subscribe-push' }]);
  assert.deepEqual(notifications(), { status: 'busy' });
  assert.deepEqual(driver.dispatch({ type: 'push-toggle', on: true }), [], 'not asked twice');
  driver.dispatch({ type: 'push-checked', supported: true, error: 'denied' });
  assert.equal(notifications().status, 'off');
  assert.match(notifications().error ?? '', /許可されていません/);

  driver.dispatch({ type: 'push-toggle', on: true });
  const subscription = { endpoint: 'https://push.example.test/one', keys: { p256dh: 'BKey', auth: 'auth' } };
  const [registered] = Driver.sent(driver.dispatch({ type: 'push-checked', supported: true, subscription }));
  assert.deepEqual([registered?.type, registered?.payload], ['push.register', { subscription }]);
  assert.deepEqual(notifications(), { status: 'on' });

  // Again after the socket comes back and syncs.
  driver.dispatch({ type: 'socket-closed', code: 1006 }, { type: 'reconnect-due' }, { type: 'socket-opened' });
  const sync = Driver.sent(driver.effects).filter(command => command.type === 'session.sync').at(-1)!;
  const [again] = Driver.sent(driver.dispatch(server('session.snapshot', snapshot(), { seq: 1, requestId: sync.requestId })))
    .filter(command => command.type === 'push.register');
  assert.deepEqual(again?.payload, { subscription });

  assert.deepEqual(driver.dispatch({ type: 'push-toggle', on: false }), [{ kind: 'unsubscribe-push' }]);
  assert.deepEqual(Driver.sent(driver.dispatch({ type: 'push-checked', supported: true })), []);
  assert.deepEqual(notifications(), { status: 'off' });
});
