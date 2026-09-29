import assert from 'node:assert/strict';
import test from 'node:test';
import { chatProps } from '../src/web/core/props.ts';
import { Driver, notice, owner, reply, server } from './web-core-fixtures.ts';

/** The chat (`/`) as the core decides it: sending, her replies and her thinking, reading, and checking notices. */

const manifest = { version: 'v1', name: 'なつみ', files: ['avatar.json', 'icons/happy.webp', 'icons/laughing.webp', 'icons/neutral.webp', 'icons/thinking.png'] };

test('a message is sent at once when synced, shown as sending until the server has it, and the field is emptied', () => {
  const driver = new Driver().synced();
  const [send] = Driver.sent(driver.dispatch({ type: 'send', text: '  やあ  ' }));
  assert.deepEqual(send?.payload, { text: '  やあ  ' });
  assert.equal(chatProps(driver.state).composer.sentCount, 1);
  assert.deepEqual(chatProps(driver.state).outbox.map(item => item.text), ['  やあ  ']);
  driver.dispatch(server('conversation.message', owner('m2', '  やあ  ', 'e2'), { seq: 2 }));
  driver.dispatch(server('command.accepted', { messageId: 'm2', eventId: 'e2', state: 'processing' }, { seq: 3, requestId: send!.requestId }));
  assert.deepEqual(chatProps(driver.state).outbox, []);
  assert.equal(chatProps(driver.state).rows.at(-1)?.text, '  やあ  ');
});

test('a blank message is not sent', () => {
  const driver = new Driver().synced();
  assert.deepEqual(driver.dispatch({ type: 'send', text: ' \n ' }), []);
  assert.equal(chatProps(driver.state).composer.sentCount, 0);
});

test('a message the server turns away says why, and can be sent again or put away', () => {
  const driver = new Driver().synced();
  const [send] = Driver.sent(driver.dispatch({ type: 'send', text: 'やあ' }));
  driver.dispatch(server('command.rejected', { code: 'invalid-request' }, { seq: 2, requestId: send!.requestId }));
  const [item] = chatProps(driver.state).outbox;
  assert.equal(item?.failed, true);
  assert.match(item?.note ?? '', /受け付けられませんでした/);
  const [again] = Driver.sent(driver.dispatch({ type: 'retry-send', requestId: send!.requestId }));
  assert.equal(again?.requestId, send!.requestId, 'the same request, so the server answers it the same');
  driver.dispatch(server('command.rejected', { code: 'invalid-request' }, { seq: 3, requestId: send!.requestId }));
  driver.dispatch({ type: 'dismiss-send', requestId: send!.requestId });
  assert.deepEqual(chatProps(driver.state).outbox, []);
});

test('while she thinks the header says so with her line, and her reply ends it', () => {
  const driver = new Driver().synced();
  driver.dispatch({ type: 'avatar-loaded', manifest });
  driver.dispatch(server('conversation.message', owner('m2', 'ねえ', 'e2'), { seq: 2 }));
  driver.dispatch(server('avatar.expression', { expression: 'thinking' }, { seq: 3 }));
  driver.dispatch(server('conversation.thinking', { line: 'メモを読み返してる' }));
  let props = chatProps(driver.state);
  assert.equal(props.thinking, 'メモを読み返してる');
  assert.equal(props.status.text, '考え中…');
  assert.equal(props.face, '/v1/avatar/v1/icons/thinking.png');
  driver.dispatch(server('conversation.message', reply('r2', 'うん', { replyTo: 'e2', expression: 'laughing' }), { seq: 4 }));
  driver.dispatch(server('conversation.event.completed', { eventId: 'e2', messageId: 'm2', status: 'replied' }, { seq: 5 }));
  props = chatProps(driver.state);
  assert.equal(props.thinking, undefined);
  assert.notEqual(props.status.text, '考え中…');
});

test('each of her lines has her name and the face of its feeling, and a reply shows its images', () => {
  const driver = new Driver().synced({ messages: [owner('m1', 'おはよう'), reply('r1', '描いたよ', {
    expression: 'laughing', images: [{ imageId: 'image-1', mimeType: 'image/png', bytes: 5, width: 40, height: 30 }] }), notice('n1', '定例です')] });
  driver.dispatch({ type: 'avatar-loaded', manifest });
  const props = chatProps(driver.state);
  assert.equal(props.name, 'なつみ');
  const [mine, hers, told] = props.rows;
  assert.deepEqual([mine?.side, mine?.speaker, mine?.face], ['owner', 'あなた', undefined]);
  assert.deepEqual([hers?.side, hers?.speaker, hers?.face], ['natsumi', 'なつみ', '/v1/avatar/v1/icons/laughing.webp']);
  assert.deepEqual(hers?.images, [{ src: '/v1/images/image-1', alt: '画像 1 / 1', width: 40, height: 30 }]);
  assert.equal(told?.face, '/v1/avatar/v1/icons/neutral.webp', 'a feeling without a face of its own is shown as neutral');
  assert.equal(told?.label, 'お知らせ');
});

test('without the avatar the lines still read, with no face', () => {
  const props = chatProps(new Driver().synced().state);
  assert.equal(props.face, undefined);
  assert.equal(props.rows[1]?.face, undefined);
  assert.equal(props.name, 'なつみ');
});

test('replies are read when the page is in sight, and not before', () => {
  const driver = new Driver().synced({ readThroughMessageId: 'm1', unreadReplyCount: 1 });
  assert.equal(chatProps(driver.state).unreadCount, 1);
  const [read] = Driver.sent(driver.dispatch({ type: 'visibility', visible: true }));
  assert.deepEqual([read?.type, read?.payload], ['conversation.read', { throughMessageId: 'r1' }]);
  assert.equal(chatProps(driver.state).unreadCount, 0, 'read at once, before the server answers');
  assert.deepEqual(Driver.sent(driver.dispatch(server('conversation.message', reply('r2', 'ねえ'), { seq: 2 }))).map(c => c.type), ['conversation.read']);
  driver.dispatch({ type: 'visibility', visible: false });
  assert.deepEqual(Driver.sent(driver.dispatch(server('conversation.message', reply('r3', 'おーい'), { seq: 3 }))), []);
  assert.equal(chatProps(driver.state).rows.at(-1)?.unread, true);
});

test('the settings screen does not read the chat', () => {
  const driver = new Driver({ screen: 'settings' }).synced({ readThroughMessageId: 'm1', unreadReplyCount: 1 });
  assert.deepEqual(Driver.sent(driver.dispatch({ type: 'visibility', visible: true })), []);
});

test('a notice is checked by the owner’s hand, and another device’s check is taken too', () => {
  const driver = new Driver().synced({ messages: [notice('n1', '定例です'), notice('n2', '祝日です')], unacknowledgedNotificationIds: ['n1', 'n2'] });
  assert.deepEqual(chatProps(driver.state).rows.map(row => row.ack?.label), ['確認した', '確認した']);
  const [ack] = Driver.sent(driver.dispatch({ type: 'ack-notice', notificationId: 'n1' }));
  assert.deepEqual([ack?.type, ack?.payload], ['notification.ack', { notificationId: 'n1' }]);
  assert.equal(chatProps(driver.state).rows[0]?.ack, undefined);
  driver.dispatch(server('notification.acked', { notificationId: 'n2', acknowledgedAt: 't' }, { seq: 2 }));
  assert.equal(chatProps(driver.state).rows[1]?.ack, undefined);
});

test('the status says when the socket is away, and when a newer tab took the device', () => {
  const driver = new Driver().synced();
  driver.dispatch({ type: 'socket-closed', code: 1006 });
  assert.match(chatProps(driver.state).status.text, /つなぎ直/);
  driver.dispatch({ type: 'reconnect-due' }, { type: 'socket-opened' });
  driver.dispatch({ type: 'socket-closed', code: 4001 });
  const props = chatProps(driver.state);
  assert.match(props.status.text, /別のタブ/);
  assert.equal(props.reconnect?.label, 'ここでつなぎ直す');
});
