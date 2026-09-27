import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalsPage, devicesPage, dovePage, memosPage, renderWaits, waitsPage } from '../src/server/dashboard-lists.ts';
import type { ApprovalRow, DevicesView, DovePostRow, Waits } from '../src/server/dashboard-records.ts';
import type { TurnRow } from '../src/server/turn-log.ts';

// The pages of the lists (ADR 0049): the failures and the waits, the memos, the dove's posts and the devices. Every
// value is escaped, and nothing on them changes anything.

const HOSTILE = '<img src=x onerror=alert(1)>';
const ZONE = 'Asia/Tokyo';
const AT = '2026-01-01T00:00:00.000Z';

function waits(overrides: Partial<Waits> = {}): Waits {
  return {
    failedEvents: [{ eventId: 'event-1', kind: 'mac_message', reason: 'timeout', createdAt: AT, updatedAt: AT, turnId: 'turn-1' },
      { eventId: 'event-2', kind: 'slack_mention', reason: HOSTILE, createdAt: AT, updatedAt: AT, turnId: null }],
    cutTurns: [{ turnId: 'turn-9', kind: 'events', startedAt: AT, eventKinds: 'mac_message', outcome: 'model-call-limit' }],
    approvals: [{ approvalId: 'approval-1', kind: 'slack-post', createdAt: AT, expiresAt: '2026-01-02T00:00:00.000Z', expired: false,
      channel: '#架空のチャンネル', placement: 'thread', text: `架空の下書き ${HOSTILE}`, verdict: 'owner', flagged: ['口調'] }],
    checks: [{ checkId: 'check-1', reason: `架空の理由 ${HOSTILE}`, dueAt: '2026-01-01T01:00:00.000Z', createdAt: AT }],
    nextRotationAt: '2026-01-01T19:00:00.000Z',
    agentTasks: [{ agent: 'wiki', taskId: 'task-1', state: 'input-required', sentAt: AT, createdAt: AT, updatedAt: AT },
      { agent: 'artist', taskId: 'task-2', state: 'gave-up', sentAt: AT, createdAt: AT, updatedAt: AT }],
    rotations: [{ rotationId: 'rotation-1', state: 'failed', reason: 'handoff-not-committed', fromSessionFile: 'a.jsonl', toSessionFile: null,
      createdAt: AT, updatedAt: AT }],
    ...overrides,
  };
}

test('the failures and waits page has every section, links a failure to its turn and escapes every value', () => {
  const text = waitsPage(waits(), ZONE).text;
  for (const heading of ['失敗した出来事', '打ち切られたターン', '承認待ち', '予約した確認', '外のエージェントへの依頼', '夜の切り替え']) {
    assert.match(text, new RegExp(`<h3>${heading}`), heading);
  }
  assert.match(text, /href="\/dashboard\/turns\/turn-1"/);
  assert.match(text, /href="\/dashboard\/turns\/turn-9"/);
  assert.match(text, /timeout/);
  assert.match(text, /model-call-limit/);
  assert.match(text, /#架空のチャンネル/);
  assert.match(text, /口調/);
  assert.match(text, /2026-01-02 09:00:00/, 'the end of the approval, in the time zone');
  assert.match(text, /次の夜の切り替え[\s\S]*2026-01-02 04:00:00/);
  assert.match(text, /input-required/);
  assert.match(text, /gave-up/);
  assert.match(text, /handoff-not-committed/);
  assert.ok(!text.includes('<img src=x'), 'nothing is read as markup');
  assert.match(text, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(text, /aria-current="page">失敗と待ち/);
  // Read-only: no form but the logout.
  assert.equal(text.match(/<form/g)?.length, 1);
  assert.equal(text.match(/<button/g)?.length, 1);
});

test('the failures and waits refresh themselves, as one section the script puts in place', () => {
  const section = renderWaits(waits(), ZONE).text;
  assert.match(section, /^<section id="waits" data-refresh="\/dashboard\/waits\/live"/);
  assert.ok(!section.includes('<html'));
});

test('empty lists say so, and the nightly switch says when it is off', () => {
  const text = renderWaits(waits({ failedEvents: [], cutTurns: [], approvals: [], checks: [], agentTasks: [], rotations: [], nextRotationAt: null }), ZONE).text;
  assert.match(text, /失敗した出来事はありません/);
  assert.match(text, /承認待ちはありません/);
  assert.match(text, /予約した確認はありません/);
  assert.match(text, /次の夜の切り替え[\s\S]*しない設定/);
});

test('an approval past its end is marked as run out', () => {
  const text = renderWaits(waits({ approvals: [{ approvalId: 'approval-1', kind: 'slack-post', createdAt: AT, expiresAt: AT, expired: true, flagged: [] }] }), ZONE).text;
  assert.match(text, /期限切れ/);
});

function memoRow(overrides: Partial<TurnRow> = {}): TurnRow {
  return {
    turnId: 'turn-1', kind: 'events', startedAt: AT, turnMs: 12_300, fold: 'on', route: 'local', eventKinds: 'mac_message', outcome: 'ok',
    firstOutMs: 4_200, modelCalls: 3, inputTokens: 1, cacheReadTokens: 1, outputTokens: 1, contextTokens: 1, reflectionMs: 800,
    compacted: false, toolErrors: 0, place: { sessionFile: 'a.jsonl', firstEntryId: 'a', lastEntryId: 'b', startOffset: 0, endOffset: 1 },
    eventIds: ['event-1'], ...overrides,
  };
}

test('the memos are listed newest first, each whole, escaped and linked to its turn', () => {
  const text = memosPage({ page: 1, more: true, memos: [
    { row: memoRow(), memo: { found: true, text: `架空のメモ ${HOSTILE}\n二行目` } },
    { row: memoRow({ turnId: 'turn-2', place: null }), memo: { found: false, reason: 'estimated' } },
    { row: memoRow({ turnId: 'turn-3' }), memo: { found: false, reason: 'too-far' } },
    { row: memoRow({ turnId: 'turn-4' }), memo: { found: false, reason: 'no-memo' } },
  ] }, ZONE).text;
  assert.match(text, /架空のメモ &lt;img/);
  assert.match(text, /二行目/);
  assert.ok(!text.includes('<img src=x'));
  for (const turn of ['turn-1', 'turn-2', 'turn-3', 'turn-4']) assert.match(text, new RegExp(`href="/dashboard/turns/${turn}"`));
  assert.match(text, /推定/);
  assert.match(text, /詳細で見られます/);
  assert.match(text, /一行メモはありません/);
  assert.match(text, /href="\/dashboard\/memos\?page=2"/);
  assert.match(text, /aria-current="page">一行メモ/);
  assert.match(memosPage({ page: 1, more: false, memos: [] }, ZONE).text, /まだ一行メモはありません/);
});

function dovePost(overrides: Partial<DovePostRow> = {}): DovePostRow {
  return {
    postId: 'post-1', kind: 'post', channel: '#架空のチャンネル', reference: '#架空 の発言', text: `架空の下書き ${HOSTILE}`, expression: 'smile',
    verdict: 'owner', scores: [{ label: '口調', score: 0.72, flagged: true }, { label: '事実', score: 0.1, flagged: false }], placement: 'thread',
    state: 'sent', sentText: '本人が直した文', sentPlacement: 'channel', failure: null, createdAt: AT, updatedAt: AT, ...overrides,
  };
}

test('the dove’s posts show the judgement, the scores, the state, where they went, when, and the words whole', () => {
  const text = dovePage({ page: 2, more: false, rows: [dovePost(), dovePost({ postId: 'post-2', kind: 'reaction', text: 'tada', verdict: null,
    scores: [], state: 'failed', failure: 'not_in_channel', sentText: null, sentPlacement: null, placement: null })] }, ZONE).text;
  assert.match(text, /owner/);
  assert.match(text, /口調[^<]*0\.72/);
  assert.match(text, /#架空のチャンネル/);
  assert.match(text, /thread/);
  assert.match(text, /架空の下書き &lt;img/);
  assert.match(text, /本人が直した文/);
  assert.match(text, /2026-01-01 09:00:00/);
  assert.match(text, /リアクション/);
  assert.match(text, /not_in_channel/);
  assert.ok(!text.includes('<img src=x'));
  assert.match(text, /href="\/dashboard\/dove"/, 'back to the first page');
  assert.match(text, /aria-current="page">ポッポさん/);
});

test('the devices page shows each device, whether it is connected, its push, and the sessions by count and last use, and no token', () => {
  const view: DevicesView = {
    devices: [
      { deviceId: 'device-phone', createdAt: AT, lastSeenAt: AT, connected: true, push: { environment: 'production', createdAt: AT, updatedAt: AT },
        sessionId: 'session-app', sessionState: 'live' },
      { deviceId: 'device-mac', createdAt: AT, lastSeenAt: AT, connected: false, push: null, sessionId: 'session-old', sessionState: 'expired' },
    ],
    sessions: { counts: { live: 2, ended: 1 }, rows: [
      { sessionId: 'session-browser', createdAt: AT, expiresAt: AT, lastUsedAt: AT, revokedAt: null, state: 'live', devices: 0 },
      { sessionId: 'session-app', createdAt: AT, expiresAt: AT, lastUsedAt: AT, revokedAt: null, state: 'live', devices: 1 },
      { sessionId: 'session-old', createdAt: AT, expiresAt: AT, lastUsedAt: AT, revokedAt: AT, state: 'revoked', devices: 1 },
    ] },
  };
  const text = devicesPage(view, 'session-browser', ZONE).text;
  assert.match(text, /device-phone[\s\S]*つながっている/);
  assert.match(text, /device-mac[\s\S]*つながっていない/);
  assert.match(text, /production/);
  assert.match(text, /有効 2/);
  assert.match(text, /終わった 1/);
  assert.match(text, /このブラウザ/);
  assert.match(text, /失効/);
  assert.match(text, /aria-current="page">端末/);
});

test('the navigation has every list and the statistics, and nothing is still to come', () => {
  const text = memosPage({ page: 1, more: false, memos: [] }, ZONE).text;
  for (const [label, href] of [['失敗と待ち', '/dashboard/waits'], ['一行メモ', '/dashboard/memos'], ['ポッポさん', '/dashboard/dove'],
    ['承認の履歴', '/dashboard/approvals'], ['端末', '/dashboard/devices'], ['統計', '/dashboard/stats']]) {
    assert.match(text, new RegExp(`<a href="${href}"[^>]*>${label}</a>`), label);
  }
  assert.doesNotMatch(text, /準備中/);
});

test('the waiting approvals lead to the history of every approval', () => {
  const text = renderWaits(waits(), ZONE).text;
  assert.match(text, /<h3>承認待ち[\s\S]*href="\/dashboard\/approvals\?state=pending"/);
  assert.match(text, /href="\/dashboard\/approvals"/);
});

test('each of the dove’s posts can be linked to', () => {
  assert.match(dovePage({ page: 1, more: false, rows: [dovePost()] }, ZONE).text, /<article class="card" id="post-1">/);
});

function approvalRow(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    approvalId: 'approval-1', kind: 'slack-post', state: 'edited', createdAt: AT, expiresAt: '2026-01-02T00:00:00.000Z', expired: false,
    decision: 'edit', decidedText: `本人が直した文 ${HOSTILE}`, decidedPlacement: 'channel', deviceId: 'device-0123456789abcdef',
    resolvedAt: '2026-01-01T00:05:00.000Z', delivery: 'sent', deliveryReason: null, sentText: `本人が直した文 ${HOSTILE}`,
    shown: { channel: '#架空のチャンネル', placement: 'thread', text: `架空の下書き ${HOSTILE}`, verdict: 'owner', flagged: ['口調'],
      scores: [{ label: '口調', score: 0.72, flagged: true }, { label: '事実', score: 0.1, flagged: false }],
      replyTo: { speaker: '架空の人', text: `架空の発言 ${HOSTILE}` }, expression: 'smile' },
    post: { postId: 'post-7', state: 'sent', failure: null, sentPlacement: 'channel', page: 3 },
    ...overrides,
  };
}

test('the approvals show what was asked, what the owner decided, where, when and on which device, the judge and the send', () => {
  const text = approvalsPage({ page: 1, more: false, rows: [approvalRow()] }, ZONE).text;
  assert.match(text, /aria-current="page">承認の履歴/);
  assert.match(text, /slack-post/);
  assert.match(text, /修正/);
  assert.match(text, /#架空のチャンネル/);
  assert.match(text, /架空の下書き &lt;img/);
  assert.match(text, /架空の人/);
  assert.match(text, /架空の発言 &lt;img/);
  assert.match(text, /本人が直した文 &lt;img/);
  assert.match(text, /channel/);
  assert.match(text, /口調[^<]*0\.72/);
  assert.match(text, /owner/);
  assert.match(text, /2026-01-01 09:00:00/, 'made, in the time zone');
  assert.match(text, /2026-01-02 09:00:00/, 'its end');
  assert.match(text, /2026-01-01 09:05:00/, 'when it closed');
  assert.match(text, /<code title="device-0123456789abcdef">device-01234567…<\/code>/, 'the device, shortened');
  assert.ok(!text.includes('device-0123456789abcdef<'), 'not the whole ID as text');
  assert.match(text, /送れた/);
  assert.match(text, /href="\/dashboard\/dove\?page=3#post-7"/, 'to the dove’s post on its page');
  assert.ok(!text.includes('<img src=x'), 'nothing is read as markup');
  assert.equal(text.match(/<form/g)?.length, 1, 'read-only: no form but the logout');
  assert.equal(text.match(/<button/g)?.length, 1);
});

test('an approval that failed to send says why, one waiting says so, one run out unsettled says so', () => {
  const text = approvalsPage({ page: 1, more: false, rows: [
    approvalRow({ approvalId: 'approval-failed', state: 'approved', decision: 'approve', decidedText: null, decidedPlacement: null,
      delivery: 'failed', deliveryReason: 'target-gone', sentText: null, post: { postId: 'post-1', state: 'failed', failure: 'target-gone', sentPlacement: null, page: 1 } }),
    approvalRow({ approvalId: 'approval-waiting', state: 'pending', decision: null, decidedText: null, decidedPlacement: null, deviceId: null,
      resolvedAt: null, delivery: null, sentText: null, expired: true, post: null }),
  ] }, ZONE).text;
  assert.match(text, /送れなかった[\s\S]*target-gone/);
  assert.match(text, /href="\/dashboard\/dove#post-1"/, 'the first page of the dove’s posts has no number');
  assert.match(text, /待ち/);
  assert.match(text, /期限切れ/);
});

test('the approvals can be narrowed to an outcome, and the pages keep to it', () => {
  const text = approvalsPage({ page: 2, more: true, state: 'rejected', rows: [approvalRow({ state: 'rejected' })] }, ZONE).text;
  const filters: [string, string][] = [['すべて', '/dashboard/approvals'], ['待ち', '/dashboard/approvals?state=pending'],
    ['承認', '/dashboard/approvals?state=approved'], ['修正', '/dashboard/approvals?state=edited'], ['却下', '/dashboard/approvals?state=rejected'],
    ['期限切れ', '/dashboard/approvals?state=expired']];
  for (const [label, href] of filters) {
    assert.match(text, new RegExp(`<a href="${href.replace('?', '\\?')}"[^>]*>${label}</a>`), label);
  }
  assert.match(text, /<a href="\/dashboard\/approvals\?state=rejected" aria-current="true">却下<\/a>/);
  assert.match(text, /href="\/dashboard\/approvals\?state=rejected"[^>]*>← /, 'back to the first page of the outcome');
  assert.match(text, /href="\/dashboard\/approvals\?state=rejected&amp;page=3"/);
  assert.match(approvalsPage({ page: 1, more: false, rows: [] }, ZONE).text, /まだ承認はありません/);
});
