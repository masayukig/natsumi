import assert from 'node:assert/strict';
import test from 'node:test';
import type { Effect } from '../src/web/core/effects.ts';
import { chatProps } from '../src/web/core/props.ts';
import { Driver, owner, server } from './web-core-fixtures.ts';

/**
 * Files attached in the chat (ADR 0071), as the core decides it: each is uploaded as it is chosen and shown as a chip
 * until it is sent, the message names the uploaded ones by their IDs, and the history shows what a message carried.
 */

const LIMITS = { uploads: { maxFileBytes: 1024, maxFiles: 3 } };
const pdf = { name: '報告書.pdf', size: 1000, type: 'application/pdf' };
const png = { name: 'shot.png', size: 300, type: 'image/png' };

const uploads = (effects: Effect[]) => effects.flatMap(effect => (effect.kind === 'upload' ? [effect] : []));

test('a chosen file is uploaded at once and shown as a chip while it goes, then as ready', () => {
  const driver = new Driver().synced(LIMITS);
  const [one, two] = uploads(driver.dispatch({ type: 'attach', files: [pdf, png] }));
  assert.equal(one?.file, pdf, 'the file itself goes to the adapter');
  assert.equal(two?.file, png);
  let chips = chatProps(driver.state).composer.attachments;
  assert.deepEqual(chips.map(chip => [chip.name, chip.state, chip.size]), [['報告書.pdf', 'uploading', '1000 B'], ['shot.png', 'uploading', '300 B']]);
  driver.dispatch({ type: 'attachment-preview', localId: two!.localId, url: 'blob:preview-1' });
  driver.dispatch({ type: 'upload-done', localId: one!.localId, upload: { uploadId: 'upload-1', name: '報告書.pdf', bytes: 1000 } });
  chips = chatProps(driver.state).composer.attachments;
  assert.deepEqual(chips.map(chip => [chip.state, chip.preview]), [['ready', undefined], ['uploading', 'blob:preview-1']], 'an image is shown small');
  assert.equal(chatProps(driver.state).composer.note, 'ファイルを上げています…');
});

test('a message waits for its files, then names them; the field and the chips are emptied', () => {
  const driver = new Driver().synced(LIMITS);
  const [one, two] = uploads(driver.dispatch({ type: 'attach', files: [pdf, png] }));
  driver.dispatch({ type: 'attachment-preview', localId: two!.localId, url: 'blob:preview-1' });
  assert.deepEqual(Driver.sent(driver.dispatch({ type: 'send', text: '見て' })), [], 'not while a file is still going up');
  assert.equal(chatProps(driver.state).composer.sentCount, 0);
  driver.dispatch({ type: 'upload-done', localId: one!.localId, upload: { uploadId: 'upload-1', name: '報告書.pdf', bytes: 1000 } });
  driver.dispatch({ type: 'upload-done', localId: two!.localId, upload: { uploadId: 'upload-2', name: 'shot.png', bytes: 300, mimeType: 'image/png' } });
  assert.equal(chatProps(driver.state).composer.note, undefined);
  const effects = driver.dispatch({ type: 'send', text: '見て' });
  const [send] = Driver.sent(effects);
  assert.deepEqual(send?.payload, { text: '見て', uploadIds: ['upload-1', 'upload-2'] });
  assert.ok(effects.some(effect => effect.kind === 'forget-preview' && effect.url === 'blob:preview-1'), 'the preview is let go');
  const props = chatProps(driver.state);
  assert.deepEqual(props.composer.attachments, []);
  assert.equal(props.composer.sentCount, 1);
  assert.deepEqual(props.outbox.map(item => item.files), [['報告書.pdf', 'shot.png']]);
  // Sent again after a reconnect, it names the same files.
  driver.dispatch({ type: 'socket-closed', code: 1006 }, { type: 'reconnect-due' }, { type: 'socket-opened' });
  const sync = Driver.sent(driver.effects).filter(command => command.type === 'session.sync').at(-1)!;
  const resent = Driver.sent(driver.dispatch(server('session.snapshot', { deviceId: 'device-1', messages: [], pendingEvents: [], avatar: { expression: 'neutral' },
    readThroughMessageId: null, unreadReplyCount: 0, unacknowledgedNotificationIds: [], pendingApprovals: [] }, { seq: 1, requestId: sync.requestId, epoch: 'epoch-2' })));
  assert.deepEqual(resent.find(command => command.type === 'conversation.send')?.payload, { text: '見て', uploadIds: ['upload-1', 'upload-2'] });
});

test('files alone are a message; nothing at all is not', () => {
  const driver = new Driver().synced(LIMITS);
  const [one] = uploads(driver.dispatch({ type: 'attach', files: [pdf] }));
  driver.dispatch({ type: 'upload-done', localId: one!.localId, upload: { uploadId: 'upload-1', name: '報告書.pdf', bytes: 1000 } });
  assert.deepEqual(Driver.sent(driver.dispatch({ type: 'send', text: '' }))[0]?.payload, { text: '', uploadIds: ['upload-1'] });
  assert.deepEqual(Driver.sent(driver.dispatch({ type: 'send', text: ' ' })), []);
});

test('a chip is taken back with its button, and its preview let go', () => {
  const driver = new Driver().synced(LIMITS);
  const [one] = uploads(driver.dispatch({ type: 'attach', files: [png] }));
  driver.dispatch({ type: 'attachment-preview', localId: one!.localId, url: 'blob:preview-1' });
  const effects = driver.dispatch({ type: 'remove-attachment', localId: one!.localId });
  assert.deepEqual(effects, [{ kind: 'forget-preview', url: 'blob:preview-1' }]);
  assert.deepEqual(chatProps(driver.state).composer.attachments, []);
  // An upload that ends after its chip is gone changes nothing.
  driver.dispatch({ type: 'upload-done', localId: one!.localId, upload: { uploadId: 'upload-1', name: 'shot.png', bytes: 300 } });
  assert.deepEqual(chatProps(driver.state).composer.attachments, []);
});

test('a file too large, or one past the count, is not uploaded and says why; one the server refused says so too', () => {
  const driver = new Driver().synced(LIMITS);
  const big = { name: 'big.zip', size: 2048, type: 'application/zip' };
  const taken = uploads(driver.dispatch({ type: 'attach', files: [big, pdf, png, pdf, png] }));
  assert.deepEqual(taken.map(effect => effect.file.name), ['報告書.pdf', 'shot.png', '報告書.pdf']);
  const chips = chatProps(driver.state).composer.attachments;
  assert.deepEqual(chips.map(chip => [chip.name, chip.state]), [['big.zip', 'failed'], ['報告書.pdf', 'uploading'], ['shot.png', 'uploading'],
    ['報告書.pdf', 'uploading'], ['shot.png', 'failed']]);
  assert.match(chips[0]!.note ?? '', /1 KB まで/);
  assert.match(chips[4]!.note ?? '', /3 個まで/);
  driver.dispatch({ type: 'upload-failed', localId: taken[0]!.localId, code: 'too-large' });
  assert.match(chatProps(driver.state).composer.attachments[1]!.note ?? '', /大きすぎ/);
  // Those that failed do not hold the message back, and do not go with it.
  for (const effect of taken.slice(1)) driver.dispatch({ type: 'upload-done', localId: effect.localId, upload: { uploadId: effect.localId, name: effect.file.name, bytes: 1 } });
  const [send] = Driver.sent(driver.dispatch({ type: 'send', text: 'x' }));
  assert.deepEqual(send?.payload, { text: 'x', uploadIds: [taken[1]!.localId, taken[2]!.localId] });
  assert.deepEqual(chatProps(driver.state).composer.attachments, []);
});

test('the history shows what a message carried: its images in place, its other files by name, both fetched by ID', () => {
  const driver = new Driver().synced({ ...LIMITS, messages: [{ ...owner('m1', '見て'), attachments: [
    { uploadId: 'upload-1', name: '報告書.pdf', bytes: 2_500_000 },
    { uploadId: 'upload-2', name: 'shot.png', bytes: 300, mimeType: 'image/png', width: 4, height: 3 },
  ] }] });
  const [row] = chatProps(driver.state).rows;
  assert.deepEqual(row?.images, [{ src: '/v1/uploads/upload-2', alt: 'shot.png', width: 4, height: 3 }]);
  assert.deepEqual(row?.files, [{ name: '報告書.pdf', size: '2.4 MB', href: '/v1/uploads/upload-1' }]);
});

test('a refusal of a message’s files is said in words', () => {
  const driver = new Driver().synced(LIMITS);
  const [one] = uploads(driver.dispatch({ type: 'attach', files: [pdf] }));
  driver.dispatch({ type: 'upload-done', localId: one!.localId, upload: { uploadId: 'upload-1', name: '報告書.pdf', bytes: 1000 } });
  const [send] = Driver.sent(driver.dispatch({ type: 'send', text: '見て' }));
  driver.dispatch(server('command.rejected', { code: 'upload-not-found' }, { seq: 2, requestId: send!.requestId }));
  assert.match(chatProps(driver.state).outbox[0]?.note ?? '', /ファイルが見つかりません/);
});
