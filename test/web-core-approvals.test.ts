import assert from 'node:assert/strict';
import test from 'node:test';
import { chatProps } from '../src/web/core/props.ts';
import { approval, Driver, server } from './web-core-fixtures.ts';

/**
 * Approvals in the browser (ADR 0058): a decision acts outside, on Slack, so none is sent on the first press. The owner
 * chooses, the screen asks once more with what will happen, and only the confirmation sends `approval.decide`.
 */

const waiting = () => new Driver().synced({ pendingApprovals: [approval('a1')] });

test('an approval shows where it goes, what it answers, the draft and why it was handed to the owner', () => {
  const [card] = chatProps(waiting().state).approvals;
  assert.equal(card?.channel, 'work/#dev');
  assert.deepEqual(card?.replyTo, { speaker: '山田', at: '2026-09-25 14:32:05', text: '明日は？' });
  assert.equal(card?.text, '明日は 10 時からなら大丈夫です。');
  assert.deepEqual(card?.flagged, ['本人に代わる約束・期限']);
  assert.equal(card?.mode, 'idle');
  assert.deepEqual(card?.placement?.selected, 'thread');
  assert.deepEqual(card?.placement?.options.map(option => option.value), ['thread', 'channel', 'broadcast']);
});

test('approving asks first; only the confirmation sends it, with the placement chosen', () => {
  const driver = waiting();
  assert.deepEqual(Driver.sent(driver.dispatch({ type: 'approval-choose', approvalId: 'a1', decision: 'approve', placement: 'channel' })), []);
  const card = chatProps(driver.state).approvals[0]!;
  assert.equal(card.mode, 'confirming');
  assert.match(card.confirm!.question, /work\/#dev/);
  assert.match(card.confirm!.question, /チャンネルに出します/);
  assert.doesNotMatch(card.confirm!.question, /スレッド/, 'the channel itself, with no thread');
  assert.equal(card.confirm!.text, '明日は 10 時からなら大丈夫です。');
  assert.equal(card.confirm!.confirmLabel, '送る');
  const [decide] = Driver.sent(driver.dispatch({ type: 'approval-confirm', approvalId: 'a1' }));
  assert.deepEqual([decide?.type, decide?.payload], ['approval.decide', { approvalId: 'a1', revision: 1, decision: 'approve', placement: 'channel' }]);
  assert.equal(chatProps(driver.state).approvals[0]?.mode, 'sending');
});

test('the broadcast says it goes to the thread and to the channel too, and with images to the thread alone (ADR 0062)', () => {
  const driver = new Driver().synced({ pendingApprovals: [approval('a1'),
    approval('a4', { images: [{ imageId: 'image-1', mimeType: 'image/png', bytes: 3 }] })] });
  driver.dispatch({ type: 'approval-choose', approvalId: 'a1', decision: 'approve', placement: 'broadcast' });
  assert.match(chatProps(driver.state).approvals[0]!.confirm!.question, /スレッドに返し、チャンネルにも出します/);
  driver.dispatch({ type: 'approval-choose', approvalId: 'a4', decision: 'approve', placement: 'broadcast' });
  const images = chatProps(driver.state).approvals[1]!.confirm!.question;
  assert.match(images, /スレッドに返します/);
  assert.doesNotMatch(images, /チャンネルにも/);
  const [decide] = Driver.sent(driver.dispatch({ type: 'approval-confirm', approvalId: 'a1' }));
  assert.deepEqual(decide?.payload, { approvalId: 'a1', revision: 1, decision: 'approve', placement: 'broadcast' });
});

test('taking the confirmation back sends nothing and leaves the approval as it was', () => {
  const driver = waiting();
  driver.dispatch({ type: 'approval-choose', approvalId: 'a1', decision: 'reject' });
  assert.equal(chatProps(driver.state).approvals[0]?.confirm?.confirmLabel, '却下する');
  assert.deepEqual(Driver.sent(driver.dispatch({ type: 'approval-cancel', approvalId: 'a1' })), []);
  assert.equal(chatProps(driver.state).approvals[0]?.mode, 'idle');
});

test('editing opens the draft, and the edited text is what the confirmation shows and sends', () => {
  const driver = waiting();
  driver.dispatch({ type: 'approval-edit', approvalId: 'a1' });
  assert.equal(chatProps(driver.state).approvals[0]?.mode, 'editing');
  driver.dispatch({ type: 'approval-choose', approvalId: 'a1', decision: 'edit', text: '  ' });
  assert.match(chatProps(driver.state).approvals[0]?.error ?? '', /本文/);
  assert.equal(chatProps(driver.state).approvals[0]?.mode, 'editing', 'a blank text is not confirmed');
  driver.dispatch({ type: 'approval-choose', approvalId: 'a1', decision: 'edit', text: '11 時からでお願いします。', placement: 'thread' });
  const card = chatProps(driver.state).approvals[0]!;
  assert.equal(card.confirm?.text, '11 時からでお願いします。');
  assert.equal(card.confirm?.confirmLabel, '直して送る');
  const [decide] = Driver.sent(driver.dispatch({ type: 'approval-confirm', approvalId: 'a1' }));
  assert.deepEqual(decide?.payload, { approvalId: 'a1', revision: 1, decision: 'edit', text: '11 時からでお願いします。', placement: 'thread' });
});

test('a post to the channel itself has no placement to choose', () => {
  const driver = new Driver().synced({ pendingApprovals: [approval('a2', { target: { channel: 'work/#random', placement: 'channel' } })] });
  assert.equal(chatProps(driver.state).approvals[0]?.placement, undefined);
  driver.dispatch({ type: 'approval-choose', approvalId: 'a2', decision: 'approve', placement: 'thread' });
  const [decide] = Driver.sent(driver.dispatch({ type: 'approval-confirm', approvalId: 'a2' }));
  assert.deepEqual(decide?.payload, { approvalId: 'a2', revision: 1, decision: 'approve' });
});

test('the approval goes when it is resolved, and the outcome is told', () => {
  const driver = waiting();
  driver.dispatch({ type: 'approval-choose', approvalId: 'a1', decision: 'approve' });
  const [decide] = Driver.sent(driver.dispatch({ type: 'approval-confirm', approvalId: 'a1' }));
  driver.dispatch(server('command.accepted', { approvalId: 'a1', revision: 1, state: 'approved' }, { seq: 2, requestId: decide!.requestId }));
  driver.dispatch(server('approval.resolved', { approvalId: 'a1', revision: 1, state: 'approved', resolvedAt: 't', delivery: 'sent', sentText: 'x' }, { seq: 3 }));
  const props = chatProps(driver.state);
  assert.deepEqual(props.approvals, []);
  assert.match(props.results[0] ?? '', /work\/#dev.*送りました/);
});

test('a decision the server turns away is said in words, and can be made again', () => {
  const driver = waiting();
  driver.dispatch({ type: 'approval-choose', approvalId: 'a1', decision: 'approve' });
  const [decide] = Driver.sent(driver.dispatch({ type: 'approval-confirm', approvalId: 'a1' }));
  driver.dispatch(server('command.rejected', { code: 'stale-revision' }, { seq: 2, requestId: decide!.requestId }));
  const card = chatProps(driver.state).approvals[0]!;
  assert.equal(card.mode, 'idle');
  assert.match(card.error ?? '', /中身が変わりました/);
});

test('an approval arriving later is added; one resolved elsewhere goes, even mid-confirmation', () => {
  const driver = waiting();
  driver.dispatch(server('approval.pending', approval('a3'), { seq: 2 }));
  assert.deepEqual(chatProps(driver.state).approvals.map(card => card.id), ['a1', 'a3']);
  driver.dispatch({ type: 'approval-choose', approvalId: 'a1', decision: 'approve' });
  driver.dispatch(server('approval.resolved', { approvalId: 'a1', revision: 1, state: 'rejected', resolvedAt: 't' }, { seq: 3 }));
  assert.deepEqual(chatProps(driver.state).approvals.map(card => card.id), ['a3']);
  assert.match(chatProps(driver.state).results[0] ?? '', /却下/);
});
