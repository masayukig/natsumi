import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listDovePosts, DOVE_POSTS_PER_PAGE, readDevices, readWaits, WAIT_ROWS } from '../src/server/dashboard-records.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { TurnStats, type TurnRecord } from '../src/server/turn-stats.ts';

// What the dashboard lists from SQLite alone (ADR 0049): the failures and the waits, the dove's posts and the devices.
// Nothing here writes, and no token, hash or key is ever read out.

const T0 = Date.parse('2026-01-01T09:00:00.000Z');
const iso = (offset = 0) => new Date(T0 + offset).toISOString();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-dashboard-records-')));
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const stats = new TurnStats(db);
  let serial = 0;
  const run = (sql: string, ...values: (string | number | null | Uint8Array)[]) => { db.prepare(sql).run(...values); };
  return {
    db, run,
    event(eventId: string, state: string, overrides: { kind?: string; reason?: string | null; at?: number } = {}) {
      run(`INSERT INTO loop_events (event_id, kind, state, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        eventId, overrides.kind ?? 'mac_message', state, overrides.reason ?? null, iso(overrides.at ?? 0), iso((overrides.at ?? 0) + 1_000));
    },
    turn(overrides: Partial<TurnRecord> = {}) {
      const startedAt = overrides.startedAt ?? T0;
      stats.record({
        turnId: `turn-${++serial}`, startedAt, endedAt: startedAt + 2_000, receivedAt: startedAt, fold: 'off', route: 'local',
        eventKinds: 'mac_message', outcome: 'ok', modelCalls: 2, usage: { input: 20, cacheRead: 180, output: 10 },
        contextTokens: 100, compacted: false, confusion: { repeatedCalls: 0, toolErrors: 0, doveRefusals: 0, unansweredMessages: 0 },
        ...overrides,
      });
      return `turn-${serial}`;
    },
    async cleanup() { db.close(); await rm(root, { recursive: true, force: true }); },
  };
}

const options = { now: T0, nightlyRotationAt: '04:00' as string | false, timeZone: 'Asia/Tokyo' };

test('the failed events are listed newest first with their reason, each linked to the turn that handled it when one is known', async () => {
  const f = await setup();
  try {
    f.event('event-old', 'failed', { reason: 'model-error', at: -MINUTE });
    f.event('event-new', 'failed', { reason: 'timeout' });
    f.event('event-unknown', 'failed', { reason: 'stopped', at: -2 * MINUTE });
    f.event('event-fine', 'replied');
    const turn = f.turn({ eventIds: ['event-other', 'event-new'], outcome: 'timeout' });
    const waits = readWaits(f.db, options);
    assert.deepEqual(waits.failedEvents.map(event => [event.eventId, event.reason, event.turnId]),
      [['event-new', 'timeout', turn], ['event-old', 'model-error', null], ['event-unknown', 'stopped', null]]);
    assert.equal(waits.failedEvents[0]!.kind, 'mac_message');
  } finally { await f.cleanup(); }
});

test('the turns that did not end cleanly are listed with their outcome, newest first', async () => {
  const f = await setup();
  try {
    f.turn({ outcome: 'ok' });
    const limited = f.turn({ outcome: 'model-call-limit', startedAt: T0 - MINUTE });
    const review = f.turn({ outcome: 'no-handoff', kind: 'review', eventKinds: 'nightly_review', startedAt: T0 });
    const waits = readWaits(f.db, options);
    assert.deepEqual(waits.cutTurns.map(turn => [turn.turnId, turn.outcome, turn.kind]),
      [[review, 'no-handoff', 'review'], [limited, 'model-call-limit', 'events']]);
  } finally { await f.cleanup(); }
});

test('each list of failures keeps to its latest rows', async () => {
  const f = await setup();
  try {
    for (let i = 0; i < WAIT_ROWS + 5; i++) {
      f.event(`event-${i}`, 'failed', { reason: 'model-error', at: i * MINUTE });
      f.turn({ outcome: 'model-error', startedAt: T0 + i * MINUTE });
    }
    const waits = readWaits(f.db, options);
    assert.equal(waits.failedEvents.length, WAIT_ROWS);
    assert.equal(waits.failedEvents[0]!.eventId, `event-${WAIT_ROWS + 4}`);
    assert.equal(waits.cutTurns.length, WAIT_ROWS);
  } finally { await f.cleanup(); }
});

function post(f: Awaited<ReturnType<typeof setup>>, postId: string, overrides: Record<string, string | null> = {}, at = 0) {
  const row = {
    kind: 'post', workspace: 'fixture-space', channel_id: 'C0FIXTURE', target_ts: '1.0', target_thread_ts: null, reference: '#架空 の発言',
    text: '架空の下書き', expression: null, verdict: 'owner', scores: JSON.stringify([{ name: 'tone', label: '口調', score: 0.7, flagged: true },
      { name: 'facts', label: '事実', score: 0.1, flagged: false }]), placement_probabilities: null, placement: 'thread', state: 'pending',
    sent_text: null, sent_placement: null, failure: null, ...overrides,
  };
  f.run(`INSERT INTO dove_posts (post_id, kind, workspace, channel_id, target_ts, target_thread_ts, reference, text, expression, verdict,
    scores, placement_probabilities, placement, state, sent_text, sent_placement, failure, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, postId, row.kind, row.workspace, row.channel_id, row.target_ts,
  row.target_thread_ts, row.reference, row.text, row.expression, row.verdict, row.scores, row.placement_probabilities, row.placement, row.state,
  row.sent_text, row.sent_placement, row.failure, iso(at), iso(at + 1_000));
}

function approval(f: Awaited<ReturnType<typeof setup>>, approvalId: string, postId: string, state: string, expiresIn: number, payload?: string) {
  f.run(`INSERT INTO approvals (approval_id, revision, kind, post_id, payload, state, created_at, expires_at)
    VALUES (?, 1, 'slack-post', ?, ?, ?, ?, ?)`, approvalId, postId, payload ?? JSON.stringify({
    approvalId, revision: 1, kind: 'slack-post', target: { channel: '#架空のチャンネル', placement: 'thread' }, text: '架空の下書き',
    reason: { verdict: 'owner', issues: [{ name: 'tone', label: '口調', score: 0.7, flagged: true }, { name: 'facts', label: '事実', score: 0.1, flagged: false }] },
  }), state, iso(-DAY), iso(expiresIn));
}

test('the approvals waiting for the owner show what is to be approved and when it runs out, soonest first', async () => {
  const f = await setup();
  try {
    post(f, 'post-1'); post(f, 'post-2'); post(f, 'post-3', { state: 'sent' }); post(f, 'post-4');
    approval(f, 'approval-later', 'post-1', 'pending', 2 * DAY);
    approval(f, 'approval-sooner', 'post-2', 'pending', DAY);
    approval(f, 'approval-done', 'post-3', 'approved', DAY);
    approval(f, 'approval-garbled', 'post-4', 'pending', 3 * DAY, '{not json');
    const { approvals } = readWaits(f.db, options);
    assert.deepEqual(approvals.map(item => item.approvalId), ['approval-sooner', 'approval-later', 'approval-garbled']);
    const [first] = approvals;
    assert.equal(first!.kind, 'slack-post');
    assert.equal(first!.channel, '#架空のチャンネル');
    assert.equal(first!.placement, 'thread');
    assert.equal(first!.text, '架空の下書き');
    assert.equal(first!.verdict, 'owner');
    assert.deepEqual(first!.flagged, ['口調']);
    assert.equal(first!.expiresAt, iso(DAY));
    assert.equal(first!.expired, false);
    assert.equal(approvals[2]!.text, undefined, 'a payload that does not parse still lists the approval');
  } finally { await f.cleanup(); }
});

test('an approval past its end but not yet settled is listed as run out', async () => {
  const f = await setup();
  try {
    post(f, 'post-1');
    approval(f, 'approval-1', 'post-1', 'pending', -MINUTE);
    assert.equal(readWaits(f.db, options).approvals[0]!.expired, true);
  } finally { await f.cleanup(); }
});

test('the self-checks she booked are listed by when they are due, with the next nightly switch', async () => {
  const f = await setup();
  try {
    const check = (id: string, state: string, due: number, eventId: string | null = null) => f.run(`INSERT INTO self_checks
      (check_id, reason, reason_key, due_at, state, event_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, `架空の理由 ${id}`, id, iso(due), state, eventId, iso(-DAY), iso(-DAY));
    f.event('event-check', 'no-reply', { kind: 'self_check' });
    check('check-later', 'pending', 2 * 60 * MINUTE);
    check('check-sooner', 'pending', 30 * MINUTE);
    check('check-gone', 'cancelled', 10 * MINUTE);
    check('check-done', 'delivered', -10 * MINUTE, 'event-check');
    const waits = readWaits(f.db, options);
    assert.deepEqual(waits.checks.map(item => [item.checkId, item.reason, item.dueAt]),
      [['check-sooner', '架空の理由 check-sooner', iso(30 * MINUTE)], ['check-later', '架空の理由 check-later', iso(2 * 60 * MINUTE)]]);
    // 09:00 UTC is 18:00 in Tokyo; the next 04:00 there is 19:00 UTC.
    assert.equal(waits.nextRotationAt, '2026-01-01T19:00:00.000Z');
    assert.equal(readWaits(f.db, { ...options, nightlyRotationAt: false }).nextRotationAt, null);
  } finally { await f.cleanup(); }
});

test('the tasks of outside agents are listed with the ones still open first, then by the latest change', async () => {
  const f = await setup();
  try {
    const task = (agent: string, taskId: string, state: string, at: number) => f.run(`INSERT INTO agent_tasks
      (agent, task_id, context_id, state, sent_at, created_at, updated_at) VALUES (?, ?, 'context', ?, ?, ?, ?)`,
    agent, taskId, state, iso(at), iso(at - MINUTE), iso(at + MINUTE));
    task('wiki', 'task-done', 'completed', 0);
    task('wiki', 'task-waiting', 'waiting', -DAY);
    task('artist', 'task-asking', 'input-required', -2 * DAY);
    task('artist', 'task-failed', 'failed', -MINUTE);
    task('artist', 'task-gave-up', 'gave-up', -2 * MINUTE);
    const { agentTasks } = readWaits(f.db, options);
    assert.deepEqual(agentTasks.map(item => [item.agent, item.taskId, item.state]), [
      ['wiki', 'task-waiting', 'waiting'], ['artist', 'task-asking', 'input-required'],
      ['wiki', 'task-done', 'completed'], ['artist', 'task-failed', 'failed'], ['artist', 'task-gave-up', 'gave-up'],
    ]);
    assert.equal(agentTasks[0]!.sentAt, iso(-DAY));
    assert.equal(agentTasks[0]!.updatedAt, iso(-DAY + MINUTE));
  } finally { await f.cleanup(); }
});

test('the nightly switches are listed newest first with how each ended and why it failed', async () => {
  const f = await setup();
  try {
    f.run(`INSERT INTO conversations (conversation_id, pi_session_id, pi_session_file, created_at) VALUES ('conversation-1', 's', 'b.jsonl', 'x')`);
    const rotation = (id: string, state: string, at: number, reason: string | null, to: string | null) => {
      f.event(`event-${id}`, state === 'failed' ? 'failed' : 'no-reply', { kind: 'nightly-review' });
      f.run(`INSERT INTO session_rotations (rotation_id, event_id, conversation_id, from_session_id, from_session_file, state,
        to_session_id, to_session_file, reason, created_at, updated_at) VALUES (?, ?, 'conversation-1', 'from', 'a.jsonl', ?, ?, ?, ?, ?, ?)`,
      id, `event-${id}`, state, to && `id-${to}`, to, reason, iso(at), iso(at + MINUTE));
    };
    rotation('rotation-old', 'switched', -DAY, null, 'b.jsonl');
    rotation('rotation-new', 'failed', 0, 'handoff-not-committed', null);
    const { rotations } = readWaits(f.db, options);
    assert.deepEqual(rotations.map(item => [item.rotationId, item.state, item.reason, item.toSessionFile]),
      [['rotation-new', 'failed', 'handoff-not-committed', null], ['rotation-old', 'switched', null, 'b.jsonl']]);
  } finally { await f.cleanup(); }
});

test('the dove’s posts are listed newest first with the judgement, the scores, the state, where they went and the words', async () => {
  const f = await setup();
  try {
    f.run(`INSERT INTO slack_channels (workspace, channel_id, directory, label, is_im, created_at)
      VALUES ('fixture-space', 'C0FIXTURE', 'fixture', '#架空のチャンネル', 0, 'x')`);
    post(f, 'post-old', { state: 'sent', verdict: 'send', sent_text: '送った文', sent_placement: 'channel' }, -MINUTE);
    post(f, 'post-new', { kind: 'reaction', text: 'tada', verdict: null, scores: null, placement: null, state: 'failed', failure: 'not_in_channel',
      channel_id: 'C0UNKNOWN' });
    const { rows, more } = listDovePosts(f.db, 1);
    assert.equal(more, false);
    assert.deepEqual(rows.map(row => row.postId), ['post-new', 'post-old']);
    const [reaction, sent] = rows;
    assert.equal(reaction!.kind, 'reaction');
    assert.equal(reaction!.state, 'failed');
    assert.equal(reaction!.failure, 'not_in_channel');
    assert.equal(reaction!.channel, 'C0UNKNOWN', 'a channel not in the files is shown by its ID');
    assert.deepEqual(reaction!.scores, []);
    assert.equal(sent!.channel, '#架空のチャンネル');
    assert.equal(sent!.verdict, 'send');
    assert.deepEqual(sent!.scores, [{ label: '口調', score: 0.7, flagged: true }, { label: '事実', score: 0.1, flagged: false }]);
    assert.equal(sent!.text, '架空の下書き');
    assert.equal(sent!.sentText, '送った文');
    assert.equal(sent!.placement, 'thread');
    assert.equal(sent!.sentPlacement, 'channel');
    assert.equal(sent!.reference, '#架空 の発言');
    assert.equal(sent!.createdAt, iso(-MINUTE));
  } finally { await f.cleanup(); }
});

test('the dove’s posts go a page at a time', async () => {
  const f = await setup();
  try {
    for (let i = 0; i < DOVE_POSTS_PER_PAGE + 1; i++) post(f, `post-${i}`, {}, i * MINUTE);
    const first = listDovePosts(f.db, 1);
    assert.equal(first.rows.length, DOVE_POSTS_PER_PAGE);
    assert.equal(first.more, true);
    assert.equal(first.rows[0]!.postId, `post-${DOVE_POSTS_PER_PAGE}`);
    assert.deepEqual(listDovePosts(f.db, 2).rows.map(row => row.postId), ['post-0']);
  } finally { await f.cleanup(); }
});

test('the devices show when each was last seen, whether it is connected, its push registration and its session, and no token or key', async () => {
  const f = await setup();
  try {
    const session = (id: string, created: number, expires: number, revoked: number | null = null) => f.run(`INSERT INTO client_sessions
      (session_id, token_hash, github_user_id, created_at, expires_at, revoked_at) VALUES (?, ?, 1, ?, ?, ?)`,
    id, `hash-of-${id}`, iso(created), iso(expires), revoked === null ? null : iso(revoked));
    session('session-app', -10 * DAY, 29 * DAY);
    session('session-browser', -DAY, 30 * DAY - MINUTE);
    session('session-old', -40 * DAY, -5 * DAY);
    session('session-revoked', -3 * DAY, 20 * DAY, -2 * DAY);
    const device = (id: string, sessionId: string, seen: number) => f.run(`INSERT INTO devices (device_id, github_user_id, client_session_id,
      created_at, last_seen_at) VALUES (?, 1, ?, ?, ?)`, id, sessionId, iso(-10 * DAY), iso(seen));
    device('device-phone', 'session-app', -MINUTE);
    device('device-mac', 'session-old', -6 * DAY);
    f.run(`INSERT INTO push_registrations (device_id, token, public_key, environment, created_at, updated_at) VALUES (?, ?, ?, 'production', ?, ?)`,
      'device-phone', 'fixture-apns-token-secret', new Uint8Array(65).fill(4), iso(-10 * DAY), iso(-DAY));

    const { devices, sessions } = readDevices(f.db, { now: T0, isConnected: id => id === 'device-phone' });
    assert.deepEqual(devices.map(item => [item.deviceId, item.connected, item.lastSeenAt]),
      [['device-phone', true, iso(-MINUTE)], ['device-mac', false, iso(-6 * DAY)]]);
    assert.deepEqual(devices[0]!.push, { environment: 'production', createdAt: iso(-10 * DAY), updatedAt: iso(-DAY) });
    assert.equal(devices[1]!.push, null);
    assert.equal(devices[0]!.sessionState, 'live');
    assert.equal(devices[1]!.sessionState, 'expired');

    assert.deepEqual(sessions.rows.map(item => [item.sessionId, item.state, item.devices]), [
      ['session-browser', 'live', 0], ['session-app', 'live', 1], ['session-revoked', 'revoked', 0], ['session-old', 'expired', 1],
    ]);
    // The end slides thirty days past the last use (ADR 0030), so the last use is read back from it.
    assert.equal(sessions.rows[0]!.lastUsedAt, iso(-MINUTE));
    assert.deepEqual(sessions.counts, { live: 2, ended: 2 });
    const text = JSON.stringify({ devices, sessions });
    for (const secret of ['hash-of-', 'fixture-apns-token-secret', 'token', 'public']) assert.ok(!text.includes(secret), secret);
  } finally { await f.cleanup(); }
});
