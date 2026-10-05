import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import test from 'node:test';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import {
  findTurn, listMemoTurns, listTurns, MEMO_READ_LIMIT_BYTES, MEMOS_PER_PAGE, readMemo, readTurn, turnImages, TURNS_PER_PAGE, type TurnReading,
} from '../src/server/turn-log.ts';
import { TurnStats, type TurnRecord } from '../src/server/turn-stats.ts';
import { ordinaryTurn, SessionRecord } from './support/session-record.ts';

// Reading a turn back from the session record, by the place its row keeps or, for the turns recorded before the
// places, by the times (ADR 0049).

const T0 = Date.parse('2026-01-01T09:00:00.000Z');
const OLD_FILE = '2026-01-01T00-00-00-000Z_old-session.jsonl';
const NEW_FILE = '2026-01-02T00-00-00-000Z_new-session.jsonl';

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-turn-log-')));
  const sessionDirectory = join(root, 'sessions');
  await mkdir(sessionDirectory);
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const stats = new TurnStats(db);
  let serial = 0;
  return {
    root, sessionDirectory, db, stats,
    source: { db, sessionDirectory },
    write: (name: string, text: string) => writeFile(join(sessionDirectory, name), text),
    /** A row as the loop records it now, or with `place: undefined` as it was recorded before the places. */
    record(overrides: Partial<TurnRecord> = {}) {
      const startedAt = overrides.startedAt ?? T0;
      const turn: TurnRecord = {
        turnId: `turn-${++serial}`, startedAt, endedAt: startedAt + 2_000, receivedAt: startedAt, fold: 'off', route: 'local',
        eventKinds: 'mac_message', outcome: 'ok', modelCalls: 2, usage: { input: 20, cacheRead: 180, output: 10 },
        contextTokens: 100, compacted: false, confusion: { repeatedCalls: 0, toolErrors: 0, doveRefusals: 0, unansweredMessages: 0 },
        ...overrides,
      };
      stats.record(turn);
      return findTurn(db, turn.turnId)!;
    },
    /** The conversation now on NEW_FILE, switched to from OLD_FILE by a nightly review. */
    rotated() {
      db.prepare(`INSERT INTO conversations (conversation_id, pi_session_id, pi_session_file, created_at)
        VALUES ('conversation-1', 'new-session', ?, 'x')`).run(NEW_FILE);
      db.prepare(`INSERT INTO loop_events (event_id, kind, state, created_at, updated_at)
        VALUES ('event-review', 'nightly-review', 'no-reply', 'x', 'x')`).run();
      db.prepare(`INSERT INTO session_rotations (rotation_id, event_id, conversation_id, from_session_id, from_session_file, state,
        to_session_id, to_session_file, created_at, updated_at)
        VALUES ('rotation-1', 'event-review', 'conversation-1', 'old-session', ?, 'switched', 'new-session', ?, 'x', 'x')`)
        .run(OLD_FILE, NEW_FILE);
    },
    async cleanup() { db.close(); await rm(root, { recursive: true, force: true }); },
  };
}

const found = (reading: TurnReading) => {
  assert.ok(reading.found, JSON.stringify(reading));
  return reading;
};
const texts = (reading: TurnReading) => found(reading).entries.map(entry => JSON.stringify(entry));

test('a turn is read from the bytes its row points at, and nothing outside them', async () => {
  const f = await setup();
  try {
    const record = new SessionRecord('new-session');
    ordinaryTurn(record, T0 - 60_000, { message: '一つ前の質問', thought: '一つ前の思考', reply: '一つ前の返事', memo: '一つ前のメモ' });
    const startOffset = record.bytes();
    const turn = ordinaryTurn(record, T0, { message: '今の質問', thought: '今の思考', reply: '今の返事', memo: '今のメモ' });
    const endOffset = record.bytes();
    ordinaryTurn(record, T0 + 60_000, { message: '次の質問', thought: '次の思考', reply: '次の返事', memo: '次のメモ' });
    await f.write(NEW_FILE, record.text());
    const row = f.record({ place: { sessionFile: NEW_FILE, firstEntryId: turn.first, lastEntryId: turn.last, startOffset, endOffset } });
    const reading = found(await readTurn(f.source, { row }));
    assert.equal(reading.estimated, false);
    assert.equal(reading.sessionFile, NEW_FILE);
    assert.equal(reading.entries[0]!.id, turn.first);
    assert.equal(reading.entries.at(-1)!.id, turn.last);
    const text = texts(reading).join('\n');
    assert.match(text, /今の思考/);
    assert.doesNotMatch(text, /一つ前の|次の/);
  } finally { await f.cleanup(); }
});

test('a record rewritten under the row is searched for the turn’s entries by their IDs instead', async () => {
  const f = await setup();
  try {
    const record = new SessionRecord('new-session');
    const turn = ordinaryTurn(record, T0, { message: '質問', thought: '思考', reply: '返事', memo: 'メモ' });
    await f.write(NEW_FILE, record.text());
    // Offsets that no longer start at the turn, as after Pi rewrote the file.
    const row = f.record({ place: { sessionFile: NEW_FILE, firstEntryId: turn.first, lastEntryId: turn.last, startOffset: 3, endOffset: 40 } });
    const reading = found(await readTurn(f.source, { row }));
    assert.equal(reading.entries[0]!.id, turn.first);
    assert.equal(reading.entries.at(-1)!.id, turn.last);
    assert.equal(reading.estimated, false);
  } finally { await f.cleanup(); }
});

test('the turn in progress is read to the end of the file, leaving out a last line still being written', async () => {
  const f = await setup();
  try {
    const record = new SessionRecord('new-session');
    ordinaryTurn(record, T0 - 60_000, { message: '前の質問', thought: '前の思考', reply: '前の返事', memo: '前のメモ' });
    const startOffset = record.bytes();
    record.events(new Date(T0).toISOString(), [{ type: 'mac_message', received_at: 'x', text: '走っている質問' }]);
    await f.write(NEW_FILE, `${record.text()}{"type":"message","id":"half","message":{"role":"assistant","content":[{"type":"thin`);
    const reading = found(await readTurn(f.source, { inProgress: { turnId: 'turn-running', kind: 'events',
      startedAt: new Date(T0).toISOString(), eventKinds: 'mac_message', eventIds: ['event-1'], place: { sessionFile: NEW_FILE, startOffset } } }));
    assert.equal(reading.entries.length, 1);
    assert.match(texts(reading)[0]!, /走っている質問/);
  } finally { await f.cleanup(); }
});

test('a turn from before the places is estimated from its times and the <events> that begin each turn', async () => {
  const f = await setup();
  try {
    f.rotated();
    const old = new SessionRecord('old-session', '2026-01-01T00:00:00.000Z');
    ordinaryTurn(old, T0 - 60_000, { message: '一つ前の質問', thought: '一つ前の思考', reply: '一つ前の返事', memo: '一つ前のメモ' });
    const iso = (offset: number) => new Date(T0 + offset).toISOString();
    old.events(iso(10), [{ type: 'mac_message', received_at: iso(0), text: '一件目' }]);
    old.assistant(iso(1_000), [{ type: 'toolCall', id: 'c1', name: 'list_self_checks', arguments: {} }]);
    old.toolResult(iso(1_100), 'c1', 'list_self_checks', 'なし');
    // Steered in during the turn: an <events> too, but inside the turn's time.
    old.events(iso(1_200), [{ type: 'mac_message', received_at: iso(1_150), text: '差し込み' }]);
    old.assistant(iso(2_000), [{ type: 'text', text: '済んだ' }]);
    old.memoRequest(iso(2_100));
    old.assistant(iso(2_400), [{ type: 'text', text: 'メモ' }]);
    ordinaryTurn(old, T0 + 60_000, { message: '次の質問', thought: '次の思考', reply: '次の返事', memo: '次のメモ' });
    await f.write(OLD_FILE, old.text());
    const fresh = new SessionRecord('new-session', '2026-01-02T00:00:00.000Z');
    ordinaryTurn(fresh, Date.parse('2026-01-02T09:00:00.000Z'), { message: '翌日', thought: '翌日の思考', reply: '返事', memo: 'メモ' });
    await f.write(NEW_FILE, fresh.text());

    const row = f.record({ startedAt: T0, endedAt: T0 + 2_050 });
    assert.equal(row.place, null);
    const reading = found(await readTurn(f.source, { row }));
    assert.equal(reading.estimated, true);
    assert.equal(reading.sessionFile, OLD_FILE, 'the session that was current then, since switched away from');
    const text = texts(reading).join('\n');
    assert.match(text, /一件目/);
    assert.match(text, /差し込み/);
    assert.match(text, /"メモ"/);
    assert.doesNotMatch(text, /一つ前の|次の|翌日/);

    // The day after is in the session current now.
    const later = found(await readTurn(f.source, { row: f.record({ startedAt: Date.parse('2026-01-02T09:00:00.000Z') }) }));
    assert.equal(later.sessionFile, NEW_FILE);
    assert.match(texts(later).join('\n'), /翌日の思考/);
  } finally { await f.cleanup(); }
});

test('a turn whose record is gone, or not where the row says, is reported as not found', async () => {
  const f = await setup();
  try {
    f.rotated();
    const missing = f.record({ place: { sessionFile: NEW_FILE, firstEntryId: 'a', lastEntryId: 'b', startOffset: 0, endOffset: 10 } });
    assert.deepEqual(await readTurn(f.source, { row: missing }), { found: false, reason: 'no-file' });
    const outside = f.record({ place: { sessionFile: '../state.sqlite', firstEntryId: 'a', lastEntryId: 'b', startOffset: 0, endOffset: 10 } });
    assert.deepEqual(await readTurn(f.source, { row: outside }), { found: false, reason: 'no-file' }, 'nothing outside the session directory');
    const record = new SessionRecord('new-session', '2026-01-02T00:00:00.000Z');
    await f.write(NEW_FILE, record.text());
    await f.write(OLD_FILE, new SessionRecord('old-session').text());
    assert.deepEqual(await readTurn(f.source, { row: f.record({ startedAt: T0 }) }), { found: false, reason: 'not-in-file' });
  } finally { await f.cleanup(); }
});

test('the images of a turn are numbered in the order they appear, from the events and the tool results', async () => {
  const f = await setup();
  try {
    const record = new SessionRecord('new-session');
    const start = record.bytes();
    const iso = (offset: number) => new Date(T0 + offset).toISOString();
    const first = record.events(iso(0), [{ type: 'slack_mention', received_at: iso(0) }], '', [{ data: 'QUFB', mimeType: 'image/png' }]);
    record.assistant(iso(10), [{ type: 'toolCall', id: 'v', name: 'view', arguments: { path: '/work/a.jpg' } }]);
    const last = record.toolResult(iso(20), 'v', 'view', [{ type: 'text', text: '見ました' }, { type: 'image', data: 'QkJC', mimeType: 'image/jpeg' }]);
    await f.write(NEW_FILE, record.text());
    const row = f.record({ place: { sessionFile: NEW_FILE, firstEntryId: first, lastEntryId: last, startOffset: start, endOffset: record.bytes() } });
    const images = turnImages(found(await readTurn(f.source, { row })).entries);
    assert.deepEqual(images, [{ data: 'QUFB', mimeType: 'image/png' }, { data: 'QkJC', mimeType: 'image/jpeg' }]);
  } finally { await f.cleanup(); }
});

test('the list is newest first, a page at a time, from SQLite alone', async () => {
  const f = await setup();
  try {
    for (let index = 0; index < TURNS_PER_PAGE + 3; index += 1) f.record({ startedAt: T0 + index * 1_000 });
    f.record({ startedAt: T0 + 999_999, kind: 'review', eventKinds: 'nightly_review', outcome: 'no-handoff' });
    const first = listTurns(f.db, 1);
    assert.equal(first.rows.length, TURNS_PER_PAGE);
    assert.equal(first.more, true);
    assert.equal(first.rows[0]!.kind, 'review');
    assert.equal(first.rows[0]!.outcome, 'no-handoff');
    assert.ok(first.rows[1]!.startedAt > first.rows[2]!.startedAt);
    const second = listTurns(f.db, 2);
    assert.equal(second.rows.length, 4);
    assert.equal(second.more, false);
    assert.equal(findTurn(f.db, 'turn-missing'), undefined);
  } finally { await f.cleanup(); }
});

test('opening a turn in a record of tens of megabytes does not hold up the event loop', async () => {
  const f = await setup();
  try {
    f.rotated();
    // About 30 MB of earlier turns, each with a large tool result, before the turn looked for.
    const record = new SessionRecord('new-session', '2026-01-01T00:00:00.000Z');
    const large = 'あ'.repeat(40_000);
    for (let index = 0; index < 250; index += 1) {
      const at = T0 - (300 - index) * 60_000;
      const turn = ordinaryTurn(record, at, { message: `質問${index}`, thought: '思考', reply: '返事', memo: 'メモ' });
      record.toolResult(new Date(at + 2_050).toISOString(), `call-${turn.first}`, 'read', large);
    }
    const start = record.bytes();
    const turn = ordinaryTurn(record, T0, { message: '探している質問', thought: '思考', reply: '返事', memo: 'メモ' });
    await f.write(NEW_FILE, record.text());
    assert.ok(record.bytes() > 28_000_000, String(record.bytes()));

    // What the reading must not do, timed on this machine: the whole file read and parsed in one synchronous call.
    let started = performance.now();
    for (const line of readFileSync(join(f.sessionDirectory, NEW_FILE), 'utf8').split('\n')) { try { JSON.parse(line); } catch { /* the last */ } }
    const synchronous = performance.now() - started;

    const placed = f.record({ place: { sessionFile: NEW_FILE, firstEntryId: turn.first, lastEntryId: turn.last, startOffset: start, endOffset: record.bytes() } });
    const estimated = f.record({ startedAt: T0 });
    for (const row of [placed, estimated]) {
      // The longest the loop was held at once, the least of three readings: a stall of the machine's own (another test
      // process on a shared CI runner, a collection) does not come back each time; holding the loop for the file does.
      let held = Infinity;
      for (let attempt = 0; attempt < 3 && held >= synchronous / 2; attempt += 1) {
        const delay = monitorEventLoopDelay({ resolution: 10 });
        let ticks = 0;
        const timer = setInterval(() => { ticks += 1; }, 5);
        started = performance.now();
        delay.enable();
        const reading = found(await readTurn(f.source, { row }));
        delay.disable();
        clearInterval(timer);
        assert.match(texts(reading).join('\n'), /探している質問/);
        assert.doesNotMatch(texts(reading).join('\n'), /質問249/);
        if (row === estimated) assert.ok(ticks > 0, 'timers ran while the file was scanned');
        // A reading shorter than the resolution has no delay to show; it held the loop no longer than it took.
        held = Math.min(held, delay.max > 0 ? delay.max / 1e6 : performance.now() - started);
      }
      // A chunk of 256 KiB is under a hundredth of the file, so the reading holds the loop far below half of what
      // the synchronous call does; the half, not a fixed number of milliseconds, follows the speed of the machine.
      assert.ok(held < synchronous / 2, `held up the event loop for ${held.toFixed(0)} ms; reading it at once takes ${synchronous.toFixed(0)} ms`);
    }
  } finally { await f.cleanup(); }
});

// The memos (ADR 0047) as the dashboard lists them: the turns that asked for one, from SQLite, and each memo read from
// the end of the place its row keeps, not from the whole turn.

test('the turns with a memo are listed newest first, a page at a time, leaving out the nightly reviews and turns without one', async () => {
  const f = await setup();
  try {
    for (let i = 0; i < MEMOS_PER_PAGE + 2; i++) {
      f.record({ startedAt: T0 + i * 60_000, reflection: { ms: 500, input: 1, cacheRead: 1, output: 1 } });
    }
    f.record({ startedAt: T0 + 999 * 60_000 });
    f.record({ startedAt: T0 + 998 * 60_000, kind: 'review', reflection: { ms: 500, input: 1, cacheRead: 1, output: 1 } });
    const first = listMemoTurns(f.db, 1);
    assert.equal(first.rows.length, MEMOS_PER_PAGE);
    assert.equal(first.more, true);
    assert.equal(first.rows[0]!.startedAt, new Date(T0 + (MEMOS_PER_PAGE + 1) * 60_000).toISOString());
    assert.ok(first.rows.every(row => row.kind === 'events' && row.reflectionMs !== null));
    const second = listMemoTurns(f.db, 2);
    assert.equal(second.rows.length, 2);
    assert.equal(second.more, false);
  } finally { await f.cleanup(); }
});

test('a memo is read from the end of its turn’s place, with the compaction after it left aside', async () => {
  const f = await setup();
  try {
    const record = new SessionRecord('new-session');
    const startOffset = record.bytes();
    const turn = ordinaryTurn(record, T0, { message: '質問', thought: '思考', reply: '返事', memo: `今のメモ <b>全文</b>\n二行目` });
    const last = record.compaction(new Date(T0 + 3_000).toISOString(), '要約', turn.first);
    const endOffset = record.bytes();
    ordinaryTurn(record, T0 + 60_000, { message: '次', thought: '次', reply: '次', memo: '次のメモ' });
    await f.write(NEW_FILE, record.text());
    const row = f.record({ reflection: { ms: 500, input: 1, cacheRead: 1, output: 1 },
      place: { sessionFile: NEW_FILE, firstEntryId: turn.first, lastEntryId: last, startOffset, endOffset } });
    assert.deepEqual(await readMemo(f.source, row), { found: true, text: '今のメモ <b>全文</b>\n二行目' });
  } finally { await f.cleanup(); }
});

test('a memo far from the end of a large turn is found by reading further back, and never past the turn’s start', async () => {
  const f = await setup();
  try {
    const record = new SessionRecord('new-session');
    ordinaryTurn(record, T0 - 60_000, { message: '前', thought: '前', reply: '前', memo: '前のメモ' });
    const startOffset = record.bytes();
    const turn = ordinaryTurn(record, T0, { message: '質問', thought: '思考', reply: '返事', memo: '遠いメモ' });
    // A long compaction summary after the memo, longer than the first look.
    const last = record.compaction(new Date(T0 + 3_000).toISOString(), 'あ'.repeat(40_000), turn.first);
    const endOffset = record.bytes();
    await f.write(NEW_FILE, record.text());
    const row = f.record({ reflection: { ms: 500, input: 1, cacheRead: 1, output: 1 },
      place: { sessionFile: NEW_FILE, firstEntryId: turn.first, lastEntryId: last, startOffset, endOffset } });
    assert.deepEqual(await readMemo(f.source, row), { found: true, text: '遠いメモ' });

    // A turn whose memo request got no answer: the one before it is not taken for its memo.
    const other = new SessionRecord('other-session');
    ordinaryTurn(other, T0 - 60_000, { message: '前', thought: '前', reply: '前', memo: '前のメモ' });
    const from = other.bytes();
    const first = other.events(new Date(T0).toISOString(), [{ type: 'mac_message', received_at: 'x', text: '質問' }]);
    const end = other.assistant(new Date(T0 + 1_000).toISOString(), [{ type: 'text', text: '済んだ' }]);
    await f.write(OLD_FILE, other.text());
    const bare = f.record({ reflection: { ms: 500, input: 1, cacheRead: 1, output: 1 },
      place: { sessionFile: OLD_FILE, firstEntryId: first, lastEntryId: end, startOffset: from, endOffset: other.bytes() } });
    assert.deepEqual(await readMemo(f.source, bare), { found: false, reason: 'no-memo' });
  } finally { await f.cleanup(); }
});

test('a memo is not looked for in a turn from before the places, a missing file or bytes that moved', async () => {
  const f = await setup();
  try {
    const estimated = f.record({ reflection: { ms: 500, input: 1, cacheRead: 1, output: 1 } });
    assert.deepEqual(await readMemo(f.source, estimated), { found: false, reason: 'estimated' });
    const missing = f.record({ reflection: { ms: 500, input: 1, cacheRead: 1, output: 1 },
      place: { sessionFile: 'missing.jsonl', firstEntryId: 'a', lastEntryId: 'b', startOffset: 0, endOffset: 10 } });
    assert.deepEqual(await readMemo(f.source, missing), { found: false, reason: 'no-file' });
    const outside = f.record({ reflection: { ms: 500, input: 1, cacheRead: 1, output: 1 },
      place: { sessionFile: '../state.sqlite', firstEntryId: 'a', lastEntryId: 'b', startOffset: 0, endOffset: 10 } });
    assert.deepEqual(await readMemo(f.source, outside), { found: false, reason: 'no-file' });

    const record = new SessionRecord('new-session');
    const turn = ordinaryTurn(record, T0, { message: '質問', thought: '思考', reply: '返事', memo: 'メモ' });
    await f.write(NEW_FILE, record.text());
    // The bytes no longer end at the turn's last entry, as after Pi rewrote the file.
    const moved = f.record({ reflection: { ms: 500, input: 1, cacheRead: 1, output: 1 },
      place: { sessionFile: NEW_FILE, firstEntryId: turn.first, lastEntryId: turn.last, startOffset: 0, endOffset: record.bytes() - 30 } });
    assert.deepEqual(await readMemo(f.source, moved), { found: false, reason: 'moved' });
  } finally { await f.cleanup(); }
});

test('a page of memos reads each within a bounded window, however large the turns', async () => {
  const f = await setup();
  try {
    const record = new SessionRecord('new-session');
    const startOffset = record.bytes();
    const first = record.events(new Date(T0).toISOString(), [{ type: 'mac_message', received_at: 'x', text: '質問' }]);
    record.assistant(new Date(T0 + 1_000).toISOString(), [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'x' } }]);
    // A tool result of several megabytes, and no memo request after it.
    record.toolResult(new Date(T0 + 1_100).toISOString(), 'c1', 'read', 'い'.repeat(2_000_000));
    const last = record.assistant(new Date(T0 + 2_000).toISOString(), [{ type: 'text', text: '済んだ' }]);
    await f.write(NEW_FILE, record.text());
    const row = f.record({ reflection: { ms: 500, input: 1, cacheRead: 1, output: 1 },
      place: { sessionFile: NEW_FILE, firstEntryId: first, lastEntryId: last, startOffset, endOffset: record.bytes() } });
    assert.ok(record.bytes() > MEMO_READ_LIMIT_BYTES);
    assert.deepEqual(await readMemo(f.source, row), { found: false, reason: 'too-far' });
  } finally { await f.cleanup(); }
});
