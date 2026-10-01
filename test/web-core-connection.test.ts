import assert from 'node:assert/strict';
import test from 'node:test';
import { Driver, owner, reply, server, snapshot } from './web-core-fixtures.ts';

/**
 * The browser's connection, as the core decides it (ADR 0058, docs/client-contract.md 端末の登録と stream): it syncs
 * first, keeps the device it is given, follows the stream's numbers, and connects again when the socket goes.
 */

test('starting connects and asks for the avatar; opening syncs from nothing, with the device it remembered', () => {
  const driver = new Driver({ deviceId: 'device-old' });
  assert.deepEqual(driver.dispatch({ type: 'started' }).map(effect => effect.kind), ['connect', 'fetch-avatar', 'check-push']);
  const [sync] = Driver.sent(driver.dispatch({ type: 'socket-opened' }));
  assert.deepEqual(sync, { v: 1, requestId: sync!.requestId, deviceId: 'device-old', type: 'session.sync', payload: { resume: null } });
});

test('the snapshot is the whole of the conversation, and its device is remembered', () => {
  const driver = new Driver();
  driver.synced({ deviceId: 'device-new' });
  assert.equal(driver.state.link, 'synced');
  assert.equal(driver.state.messages.length, 2);
  assert.deepEqual(driver.effects.filter(effect => effect.kind === 'remember-device'), [{ kind: 'remember-device', deviceId: 'device-new' }]);
});

test('events follow one another by their numbers; one already seen is dropped, and a gap asks for the snapshot again', () => {
  const driver = new Driver().synced();
  driver.dispatch(server('conversation.message', owner('m2', 'ねえ'), { seq: 2 }));
  driver.dispatch(server('conversation.message', owner('m2', 'ねえ'), { seq: 2 }));
  assert.equal(driver.state.messages.length, 3);
  const [resync] = Driver.sent(driver.dispatch(server('conversation.message', owner('m9', 'とんだ'), { seq: 9 })));
  assert.equal(resync?.type, 'session.sync');
  assert.deepEqual(resync?.payload, { resume: null });
  assert.equal(driver.state.messages.length, 3, 'the event after the gap is not shown before the snapshot');
});

test('a line of thinking takes no number, and applies only on the stream synced', () => {
  const driver = new Driver().synced();
  driver.dispatch(server('conversation.thinking', { line: 'メモを読み返してる' }));
  assert.equal(driver.state.thinkingLine, 'メモを読み返してる');
  driver.dispatch(server('conversation.message', owner('m2', 'ねえ'), { seq: 2 }));
  assert.equal(driver.state.messages.length, 3, 'the next event is not a gap');
  driver.dispatch(server('conversation.thinking', { line: '別の世界' }, { epoch: 'epoch-other' }));
  assert.equal(driver.state.thinkingLine, 'メモを読み返してる');
});

test('a socket that closes is opened again after a wait that grows, and the next one syncs from where it was', () => {
  const driver = new Driver().synced();
  driver.dispatch(server('conversation.message', owner('m2', 'ねえ'), { seq: 2 }));
  assert.deepEqual(driver.dispatch({ type: 'socket-closed', code: 1006 }), [{ kind: 'reconnect-later', delayMs: 1000 }]);
  assert.equal(driver.state.link, 'waiting');
  assert.deepEqual(driver.dispatch({ type: 'reconnect-due' }), [{ kind: 'connect' }]);
  assert.deepEqual(driver.dispatch({ type: 'socket-closed', code: 1006 }), [{ kind: 'reconnect-later', delayMs: 2000 }]);
  driver.dispatch({ type: 'reconnect-due' });
  const [sync] = Driver.sent(driver.dispatch({ type: 'socket-opened' }));
  assert.deepEqual(sync?.payload, { resume: { epoch: 'epoch-1', streamId: 'stream-1', seq: 2 } });
  driver.dispatch(server('command.accepted', { deviceId: 'device-1', mode: 'resume', sessionExpiresAt: 't' }, { seq: 3, requestId: sync!.requestId }));
  assert.equal(driver.state.link, 'synced');
  assert.deepEqual(driver.dispatch({ type: 'socket-closed', code: 1006 }), [{ kind: 'reconnect-later', delayMs: 1000 }], 'a sync starts the waits over');
});

test('an ended session sends the browser to log in again; a newer tab of the same device is left alone until asked', () => {
  const ended = new Driver().synced();
  assert.deepEqual(ended.dispatch({ type: 'socket-closed', code: 1008 }), [{ kind: 'sign-in-again' }]);
  const replaced = new Driver().synced();
  assert.deepEqual(replaced.dispatch({ type: 'socket-closed', code: 4001 }), []);
  assert.equal(replaced.state.link, 'replaced');
  assert.deepEqual(replaced.dispatch({ type: 'reconnect-now' }), [{ kind: 'connect' }]);
});

test('a message written while the socket is away is kept, and sent once synced again', () => {
  const driver = new Driver().synced();
  driver.dispatch({ type: 'socket-closed', code: 1006 });
  assert.deepEqual(Driver.sent(driver.dispatch({ type: 'send', text: 'まだいる？' })), []);
  assert.equal(driver.state.outbox[0]?.text, 'まだいる？');
  driver.dispatch({ type: 'reconnect-due' }, { type: 'socket-opened' });
  const sync = Driver.sent(driver.effects).filter(command => command.type === 'session.sync').at(-1)!;
  const sent = Driver.sent(driver.dispatch(server('session.snapshot', snapshot(), { seq: 1, requestId: sync.requestId, epoch: 'epoch-2' })));
  assert.deepEqual(sent.map(command => [command.type, command.payload]), [['conversation.send', { text: 'まだいる？' }]]);
});

test('the avatar is fetched again when the snapshot names another version', () => {
  const driver = new Driver().synced({ avatarVersion: 'v1' });
  driver.dispatch({ type: 'avatar-loaded', manifest: { version: 'v1', name: 'なつみ', files: [] } });
  assert.equal(driver.effects.filter(effect => effect.kind === 'fetch-avatar').length, 1);
  driver.dispatch({ type: 'socket-closed', code: 1006 }, { type: 'reconnect-due' }, { type: 'socket-opened' });
  const sync = Driver.sent(driver.effects).filter(command => command.type === 'session.sync').at(-1)!;
  assert.deepEqual(driver.dispatch(server('session.snapshot', snapshot({ avatarVersion: 'v2' }), { seq: 1, requestId: sync.requestId, epoch: 'epoch-2' }))
    .filter(effect => effect.kind === 'fetch-avatar'), [{ kind: 'fetch-avatar' }]);
});

test('a conversation that cannot be used is said so, and synced again later', () => {
  const driver = new Driver();
  driver.dispatch({ type: 'started' }, { type: 'socket-opened' });
  const sync = Driver.sent(driver.effects)[0]!;
  const effects = driver.dispatch(server('service.unavailable', { code: 'pi-unavailable', deviceId: 'device-1' }, { seq: 1, requestId: sync.requestId }));
  assert.equal(driver.state.unavailable, 'pi-unavailable');
  assert.deepEqual(effects.map(effect => effect.kind), ['remember-device', 'reconnect-later']);
  const [again] = Driver.sent(driver.dispatch({ type: 'reconnect-due' }));
  assert.equal(again?.type, 'session.sync', 'the socket is still open, so it syncs on it');
  driver.dispatch(server('session.snapshot', snapshot({ messages: [reply('r5', 'もどった')] }), { seq: 2, requestId: again!.requestId }));
  assert.equal(driver.state.unavailable, undefined);
});
