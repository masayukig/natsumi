import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PERIODS, readStats, statsPeriod } from '../src/server/dashboard-stats.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { percentile, TurnStats, type TurnRecord } from '../src/server/turn-stats.ts';

// The numbers behind the dashboard's charts (ADR 0049): the ordinary turns of a period, in steps of time, counted and
// summed by SQLite. The nightly review is left out, as `natsumi stats` leaves it out; a step with no turn has no values.

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** 10:30 in Tokyo on 2026-01-02. */
const NOW = Date.parse('2026-01-02T01:30:00.000Z');
const ZONE = 'Asia/Tokyo';

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-dashboard-stats-')));
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const stats = new TurnStats(db);
  let serial = 0;
  return {
    db,
    turn(startedAt: number, overrides: Partial<TurnRecord> = {}) {
      stats.record({
        turnId: `turn-${++serial}`, startedAt, endedAt: startedAt + 10_000, receivedAt: startedAt, firstOutAt: startedAt + 2_000,
        fold: 'on', route: 'local', eventKinds: 'mac_message', outcome: 'ok', modelCalls: 2, usage: { input: 20, cacheRead: 180, output: 10 },
        contextTokens: 100, compacted: false, confusion: { repeatedCalls: 0, toolErrors: 0, doveRefusals: 0, unansweredMessages: 0 },
        ...overrides,
      });
    },
    async cleanup() { db.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test('the period is taken from an allowed list: 24 hours by default, and anything else is no period', () => {
  const at = (query: string) => statsPeriod(new URL(`https://natsumi.example/dashboard/stats${query}`));
  assert.equal(at(''), '24h');
  assert.equal(at('?period=24h'), '24h');
  assert.equal(at('?period=7d'), '7d');
  assert.equal(at('?period=30d'), '30d');
  for (const query of ['?period=', '?period=1y', '?period=24H', '?period=7d&period=30d', '?period=%3Cscript%3E']) {
    assert.equal(at(query), undefined, query);
  }
});

test('each period has steps of its own: hours for a day, six hours for a week, days for thirty days', () => {
  assert.deepEqual(PERIODS['24h'], { label: '24 時間', stepMs: HOUR, steps: 24 });
  assert.deepEqual(PERIODS['7d'], { label: '7 日', stepMs: 6 * HOUR, steps: 28 });
  assert.deepEqual(PERIODS['30d'], { label: '30 日', stepMs: DAY, steps: 30 });
});

test('the steps line up with the local clock and end with the one now is in', async () => {
  const f = await setup();
  try {
    const day = readStats(f.db, { period: '24h', now: NOW, timeZone: ZONE });
    assert.equal(day.steps.length, 24);
    assert.equal(day.steps.at(-1)!.start, '2026-01-02T01:00:00.000Z', '10:00 in Tokyo');
    assert.equal(day.steps.at(-1)!.end, '2026-01-02T02:00:00.000Z');
    assert.equal(day.steps[0]!.start, '2026-01-01T02:00:00.000Z');
    const week = readStats(f.db, { period: '7d', now: NOW, timeZone: ZONE });
    assert.equal(week.steps.length, 28);
    assert.equal(week.steps.at(-1)!.start, '2026-01-01T21:00:00.000Z', '06:00 in Tokyo: the steps of six hours begin at local midnight');
    assert.equal(week.steps[0]!.start, '2025-12-26T03:00:00.000Z');
    const month = readStats(f.db, { period: '30d', now: NOW, timeZone: ZONE });
    assert.equal(month.steps.length, 30);
    assert.equal(month.steps.at(-1)!.start, '2026-01-01T15:00:00.000Z', 'midnight in Tokyo');
    assert.equal(month.steps.at(-1)!.end, '2026-01-02T15:00:00.000Z');
  } finally { await f.cleanup(); }
});

test('a step counts its turns, sums their calls and tokens, and counts those cut short and those failed otherwise', async () => {
  const f = await setup();
  try {
    const step = Date.parse('2026-01-02T00:00:00.000Z');
    f.turn(step + 60_000, { modelCalls: 3, usage: { input: 5, cacheRead: 100, output: 7 } });
    f.turn(step + 120_000, { modelCalls: 4, usage: { input: 6, cacheRead: 200, output: 8 }, outcome: 'model-call-limit' });
    f.turn(step + 180_000, { modelCalls: 1, usage: { input: 1, cacheRead: 0, output: 0 }, outcome: 'timeout' });
    f.turn(step + 240_000, { modelCalls: 1, usage: { input: 1, cacheRead: 0, output: 0 }, outcome: 'model-error' });
    const { steps } = readStats(f.db, { period: '24h', now: NOW, timeZone: ZONE });
    const nine = steps.find(s => s.start === '2026-01-02T00:00:00.000Z')!;
    assert.equal(nine.turns, 4);
    assert.equal(nine.modelCalls, 9);
    assert.deepEqual(nine.tokens, { input: 13, cacheRead: 300, output: 15 });
    assert.equal(nine.cutShort, 2, 'the call limit and the time limit, as `natsumi stats` counts them');
    assert.equal(nine.failed, 1, 'any other outcome that is not ok');
  } finally { await f.cleanup(); }
});

test('a step with no turn has no values rather than zeros, and a step with no reply has no reply times', async () => {
  const f = await setup();
  try {
    const step = Date.parse('2026-01-02T00:00:00.000Z');
    f.turn(step + 60_000, { firstOutAt: undefined });
    const { steps } = readStats(f.db, { period: '24h', now: NOW, timeZone: ZONE });
    const empty = steps.find(s => s.start === '2026-01-01T23:00:00.000Z')!;
    assert.deepEqual({ ...empty, start: undefined, end: undefined }, {
      start: undefined, end: undefined, turns: 0, modelCalls: null, tokens: null, cutShort: null, failed: null,
      firstOut: { p50: null, p90: null, count: 0 }, turnLength: { p50: null, p90: null, count: 0 },
    });
    const nine = steps.find(s => s.start === '2026-01-02T00:00:00.000Z')!;
    assert.equal(nine.turns, 1);
    assert.deepEqual(nine.firstOut, { p50: null, p90: null, count: 0 });
    assert.deepEqual(nine.turnLength, { p50: 10_000, p90: 10_000, count: 1 });
  } finally { await f.cleanup(); }
});

test('the percentiles of a step are the nearest rank, as `natsumi stats` takes them', async () => {
  const f = await setup();
  try {
    const step = Date.parse('2026-01-02T00:00:00.000Z');
    const replies = [4_000, 1_000, 9_000, 2_000, 7_000, 3_000, 30_000];
    replies.forEach((ms, index) => f.turn(step + index * 1_000, { firstOutAt: step + index * 1_000 + ms, endedAt: step + index * 1_000 + ms * 2 }));
    const { steps, whole } = readStats(f.db, { period: '24h', now: NOW, timeZone: ZONE });
    const nine = steps.find(s => s.start === '2026-01-02T00:00:00.000Z')!;
    assert.deepEqual(nine.firstOut, { p50: percentile(replies, 50), p90: percentile(replies, 90), count: 7 });
    assert.deepEqual(nine.turnLength, { p50: percentile(replies.map(ms => ms * 2), 50), p90: percentile(replies.map(ms => ms * 2), 90), count: 7 });
    assert.equal(whole.turns, 7);
    assert.deepEqual(whole.firstOut, nine.firstOut, 'the whole period, here one step');
  } finally { await f.cleanup(); }
});

test('only ordinary turns inside the period are counted: the nightly review and turns before or after are not', async () => {
  const f = await setup();
  try {
    f.turn(NOW - 60_000);
    f.turn(NOW - 60_000, { kind: 'review', modelCalls: 50 });
    f.turn(NOW - 25 * HOUR);
    f.turn(NOW + 20 * HOUR);
    const day = readStats(f.db, { period: '24h', now: NOW, timeZone: ZONE });
    assert.equal(day.whole.turns, 1);
    assert.equal(day.whole.modelCalls, 2);
    assert.equal(day.steps.reduce((sum, s) => sum + s.turns, 0), 1);
    const month = readStats(f.db, { period: '30d', now: NOW, timeZone: ZONE });
    assert.equal(month.whole.turns, 2);
  } finally { await f.cleanup(); }
});

test('thirty days of a busy server are read in one bounded pass', async () => {
  const f = await setup();
  try {
    const insert = f.db.prepare('BEGIN');
    insert.run();
    for (let index = 0; index < 30 * 1_000; index++) f.turn(NOW - (index * 30 * DAY) / 30_000, { firstOutAt: NOW + (index % 97) * 100 });
    f.db.prepare('COMMIT').run();
    const started = performance.now();
    const month = readStats(f.db, { period: '30d', now: NOW, timeZone: ZONE });
    const took = performance.now() - started;
    assert.equal(month.steps.length, 30);
    assert.ok(month.whole.turns > 29_000, 'the first step begins at a midnight less than thirty days back');
    assert.equal(month.steps.reduce((sum, s) => sum + s.turns, 0), month.whole.turns);
    assert.ok(took < 1_000, `took ${took.toFixed(0)} ms`);
  } finally { await f.cleanup(); }
});
