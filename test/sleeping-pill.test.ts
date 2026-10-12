import assert from 'node:assert/strict';
import test from 'node:test';
import { judgePill, nightOf, type PillFacts, type RotationRecord } from '../src/server/sleeping-pill.ts';

// What a sleeping pill would do now (ADR 0077): the parts of the last night that are missing, decided from the records alone.

const at = (iso: string) => Date.parse(iso);
const TZ = 'Asia/Tokyo';
/** 12:00 in Tokyo; the last night's switching time, 02:00, was ten hours ago. */
const NOW = at('2026-03-02T03:00:00.000Z');
const NIGHT = at('2026-03-01T17:00:00.000Z');
const BEFORE = NIGHT - 3_600_000;
const AFTER = NIGHT + 600_000;

function rotation(fields: Partial<RotationRecord>): RotationRecord {
  return { kind: 'night', state: 'switched', reason: null, handoffCommit: true, createdAt: AFTER, updatedAt: AFTER + 60_000, ...fields };
}

function facts(fields: Partial<PillFacts> = {}): PillFacts {
  return { now: NOW, nightlyRotationAt: '02:00', timeZone: TZ, sessionEmpty: false, sessionStartedAt: AFTER + 60_000,
    rotations: [rotation({})], latestReviewAt: AFTER, curatorRuns: true, curatorBaseAt: AFTER + 120_000, curatorFailures: [],
    inProgress: null, ...fields };
}

test('the night is the last switching time at or before now, or, with none configured, the newest row that began with a review', () => {
  assert.equal(nightOf(NOW, '02:00', TZ, undefined), NIGHT);
  assert.equal(nightOf(NOW, false, TZ, AFTER), AFTER);
  assert.equal(nightOf(NOW, false, TZ, undefined), undefined);
});

test('a night with no handoff is made up in full: deep', () => {
  const judged = judgePill(facts({ rotations: [rotation({ state: 'failed', reason: 'no-handoff', handoffCommit: false })],
    sessionStartedAt: BEFORE, curatorBaseAt: BEFORE }));
  assert.equal(judged.kind, 'deep');
  assert.equal(judged.night, new Date(NIGHT).toISOString());
  assert.deepEqual(judged.done, { review: false, curator: false, session: false });
  assert.deepEqual(judged.lastFailure, { source: 'rotation', kind: 'night', state: 'failed', reason: 'no-handoff',
    at: new Date(AFTER + 60_000).toISOString() });
});

test('no row since the night at all is a missing review too', () => {
  const judged = judgePill(facts({ rotations: [], sessionStartedAt: BEFORE, curatorBaseAt: BEFORE }));
  assert.equal(judged.kind, 'deep');
  assert.equal(judged.lastFailure, null);
});

test('a handoff with no new session resumes from it: resume, whether the curator ran or not', () => {
  const failed = rotation({ state: 'failed', reason: 'session-create-failed' });
  const judged = judgePill(facts({ rotations: [failed], sessionStartedAt: BEFORE }));
  assert.equal(judged.kind, 'resume');
  assert.deepEqual(judged.done, { review: true, curator: true, session: false });
  assert.equal(judgePill(facts({ rotations: [failed], sessionStartedAt: BEFORE, curatorBaseAt: BEFORE })).kind, 'resume',
    'the curator missing too is done inside resume');
});

test('a new session without the curator sleeps again: resleep, and the curator stage that was not ok is the failure', () => {
  const judged = judgePill(facts({ curatorBaseAt: BEFORE, curatorFailures: [{ stage: 'structure', outcome: 'skipped-deadline', at: AFTER + 30_000 }] }));
  assert.equal(judged.kind, 'resleep');
  assert.deepEqual(judged.done, { review: true, curator: false, session: true });
  assert.deepEqual(judged.lastFailure, { source: 'curator', stage: 'structure', outcome: 'skipped-deadline',
    at: new Date(AFTER + 30_000).toISOString() });
});

test('the newest failure is shown, a row\'s or a curator stage\'s', () => {
  const judged = judgePill(facts({ curatorBaseAt: BEFORE,
    rotations: [rotation({ kind: 'resleep', state: 'failed', reason: 'curator-incomplete', handoffCommit: false, createdAt: AFTER + 7_200_000,
      updatedAt: AFTER + 9_000_000 }), rotation({})],
    curatorFailures: [{ stage: 'knowledge', outcome: 'timeout', at: AFTER + 8_000_000 }] }));
  assert.deepEqual(judged.lastFailure, { source: 'rotation', kind: 'resleep', state: 'failed', reason: 'curator-incomplete',
    at: new Date(AFTER + 9_000_000).toISOString() });
});

test('a night done in full is a nap; so is one whose curator does not run', () => {
  const judged = judgePill(facts());
  assert.equal(judged.kind, 'nap');
  assert.deepEqual(judged.done, { review: true, curator: true, session: true });
  assert.equal(judged.lastFailure, null);
  assert.equal(judgePill(facts({ curatorRuns: false, curatorBaseAt: undefined })).kind, 'nap');
});

test('the curator\'s base counts from the second its commit was made in, as git keeps it', () => {
  // The handoff was committed in the same second the row was made, and git keeps no milliseconds.
  const made = AFTER + 400;
  const off = { nightlyRotationAt: false as const, latestReviewAt: made, rotations: [rotation({ createdAt: made })] };
  assert.equal(judgePill(facts({ ...off, curatorBaseAt: AFTER })).done.curator, true);
  assert.equal(judgePill(facts({ ...off, curatorBaseAt: AFTER - 1000 })).done.curator, false);
});

test('an empty session still sleeps again for a curator the night left: resleep, with no turn of hers to review or nap in', () => {
  const empty = { sessionEmpty: true, curatorBaseAt: BEFORE };
  const switched = judgePill(facts(empty));
  assert.equal(switched.kind, 'resleep', 'just switched, the curator past its deadline');
  assert.deepEqual(switched.done, { review: true, curator: false, session: true });
  const unreviewed = judgePill(facts({ ...empty, rotations: [], sessionStartedAt: BEFORE }));
  assert.equal(unreviewed.kind, 'resleep', 'no review either: still the curator alone');
  assert.deepEqual(unreviewed.done, { review: false, curator: false, session: false });
});

test('an empty session with the curator done does nothing: none, where it would review or nap', () => {
  const done = judgePill(facts({ sessionEmpty: true }));
  assert.equal(done.kind, 'none');
  assert.deepEqual(done.done, { review: true, curator: true, session: true });
  assert.equal(judgePill(facts({ sessionEmpty: true, rotations: [], sessionStartedAt: BEFORE })).kind, 'none', 'no review, curator done');
  assert.equal(judgePill(facts({ sessionEmpty: true, curatorRuns: false, curatorBaseAt: undefined })).kind, 'none', 'no curator to run');
});

test('an empty session still resumes from a handoff left, whether the curator ran or not', () => {
  const failed = rotation({ state: 'failed', reason: 'session-create-failed' });
  assert.equal(judgePill(facts({ sessionEmpty: true, rotations: [failed], sessionStartedAt: BEFORE })).kind, 'resume');
  assert.equal(judgePill(facts({ sessionEmpty: true, rotations: [failed], sessionStartedAt: BEFORE, curatorBaseAt: BEFORE })).kind, 'resume');
});

test('without a switching time, the newest review decides: none at all is deep, a failed one is deep, a whole one is a nap', () => {
  const off = { nightlyRotationAt: false as const };
  const none = judgePill(facts({ ...off, latestReviewAt: undefined, rotations: [], sessionStartedAt: BEFORE }));
  assert.equal(none.kind, 'deep');
  assert.equal(none.night, null);
  const failed = judgePill(facts({ ...off, rotations: [rotation({ state: 'failed', reason: 'timeout', handoffCommit: false })],
    sessionStartedAt: BEFORE }));
  assert.equal(failed.kind, 'deep');
  assert.equal(failed.night, new Date(AFTER).toISOString());
  assert.equal(judgePill(facts(off)).kind, 'nap');
});

test('what is waiting or running is passed through as it is', () => {
  const inProgress = { kind: 'night' as const, state: 'running' as const, since: new Date(AFTER).toISOString() };
  assert.deepEqual(judgePill(facts({ inProgress })).inProgress, inProgress);
});
