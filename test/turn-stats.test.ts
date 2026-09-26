import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseCli, UsageError } from '../src/server/cli.ts';
import { STATE_DIRECTORY } from '../src/server/data-directory.ts';
import { readFoldChoice, runFoldCommand, writeFoldStatus } from '../src/server/fold-setting.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { REFLECTION_REQUEST } from '../src/server/prompts.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { writeStatus } from '../src/server/status.ts';
import { percentile, runStatsCommand, TurnStats, type TurnRecord } from '../src/server/turn-stats.ts';

// The numbers each turn leaves, and the command lines that switch the fold and read the numbers back (ADR 0047).

const NOW = Date.parse('2026-09-26T12:00:00Z');

async function setup() {
  const data = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-stats-')));
  await mkdir(join(data, STATE_DIRECTORY), { mode: 0o700 });
  const db = openStateDatabase(join(data, STATE_DIRECTORY, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const out: string[] = [];
  return {
    data, db, out,
    async run(argv: string[]) {
      const cli = parseCli(argv);
      out.length = 0;
      if (cli.command === 'fold') return runFoldCommand(cli, data, line => { out.push(line); }, () => NOW);
      assert.equal(cli.command, 'stats');
      return runStatsCommand(cli as Extract<typeof cli, { command: 'stats' }>, data, line => { out.push(line); });
    },
    async cleanup() { db.close(); await rm(data, { recursive: true, force: true }); },
  };
}

let serial = 0;
function record(overrides: Partial<TurnRecord> = {}): TurnRecord {
  const startedAt = overrides.startedAt ?? Date.parse('2026-09-25T10:00:00Z');
  return {
    turnId: `turn-${++serial}`, startedAt, endedAt: startedAt + 10_000, receivedAt: startedAt - 1_000, firstOutAt: startedAt + 4_000,
    fold: 'off', route: 'local', eventKinds: 'mac_message', outcome: 'ok', modelCalls: 3,
    usage: { input: 300, cacheRead: 2_700, output: 150 }, contextTokens: 1_000,
    reflection: { ms: 800, input: 30, cacheRead: 3_000, output: 20 }, compacted: false,
    confusion: { repeatedCalls: 0, toolErrors: 0, doveRefusals: 0, unansweredMessages: 0 },
    ...overrides,
  };
}

test('the command line has fold on, off and status, and stats with an optional period', () => {
  assert.deepEqual(parseCli(['fold', 'on', '--data-dir', '/d']), { command: 'fold', action: 'on', dataDir: '/d' });
  assert.deepEqual(parseCli(['fold', 'status']), { command: 'fold', action: 'status', dataDir: undefined });
  assert.deepEqual(parseCli(['stats']), { command: 'stats', dataDir: undefined });
  assert.deepEqual(parseCli(['stats', '--since', '2026-09-20', '--until', '2026-09-27', '--data-dir', '/d']),
    { command: 'stats', since: '2026-09-20', until: '2026-09-27', dataDir: '/d' });
  assert.deepEqual(parseCli(['stats', '--memos', '20', '--config', 'c.json']), { command: 'stats', memos: 20, config: 'c.json', dataDir: undefined });
  assert.deepEqual(parseCli(['stats', '--memos', '5']), { command: 'stats', memos: 5, config: 'config.local.json', dataDir: undefined });
  for (const argv of [['fold'], ['fold', 'maybe'], ['fold', 'on', 'off'], ['stats', 'extra'], ['stats', '--since', 'yesterday'],
    ['stats', '--config', 'c.json'], ['stats', '--memos', '0'], ['stats', '--memos', 'many'], ['stats', '--memos', '3', '--since', '2026-09-20']]) {
    assert.throws(() => parseCli(argv), UsageError, argv.join(' '));
  }
});

test('fold on and off write the choice privately; status says what is in use and what was chosen', async () => {
  const f = await setup();
  try {
    assert.equal(await f.run(['fold', 'status']), 1);
    assert.match(f.out.join('\n'), /unknown/);
    assert.equal(await f.run(['fold', 'on']), 0);
    assert.equal(await readFoldChoice(f.data), 'on');
    assert.match(f.out[0]!, /next start/);
    const file = join(f.data, STATE_DIRECTORY, 'turn-fold.json');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).fold, 'on');
    await writeFoldStatus(f.data, { inUse: 'off', defaultFold: 'off', chosen: 'on' }, NOW);
    await writeStatus(f.data, { state: 'running', pid: 1, startedAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), schemaVersion: 1 });
    assert.equal(await f.run(['fold', 'status']), 0);
    assert.deepEqual(f.out, ['in use: off', 'chosen: on (from her next turn)', 'default: off']);
    assert.equal(await f.run(['fold', 'off']), 0);
    assert.match(f.out[0]!, /next turn/);
    assert.equal(await readFoldChoice(f.data), 'off');
  } finally { await f.cleanup(); }
});

test('a turn is one row of numbers', async () => {
  const f = await setup();
  try {
    const stats = new TurnStats(f.db);
    stats.record(record({ firstOutAt: undefined, reflection: undefined, compacted: true, outcome: 'timeout' }));
    const [row] = f.db.prepare('SELECT * FROM turn_stats').all() as Record<string, unknown>[];
    assert.equal(row!.first_out_ms, null);
    assert.equal(row!.reflection_ms, null);
    assert.equal(row!.compacted, 1);
    assert.equal(row!.outcome, 'timeout');
    assert.equal(row!.turn_ms, 10_000);
    assert.equal(row!.started_at, '2026-09-25T10:00:00.000Z');
  } finally { await f.cleanup(); }
});

test('percentiles are taken by nearest rank', () => {
  assert.equal(percentile([], 50), undefined);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([4, 1, 3, 2, 5], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});

test('stats compares the turns folded and not, by median and p90, inside the period', async () => {
  const f = await setup();
  try {
    const stats = new TurnStats(f.db);
    const day = Date.parse('2026-09-25T00:00:00Z');
    for (let index = 0; index < 10; index += 1) {
      stats.record(record({ startedAt: day + index * 60_000, fold: 'off', firstOutAt: day + index * 60_000 + (index + 1) * 1_000 }));
      stats.record(record({ startedAt: day + index * 60_000 + 30_000, fold: 'on', firstOutAt: day + index * 60_000 + 30_000 + 500,
        contextTokens: 400, compacted: index === 0 }));
    }
    // Outside the period.
    stats.record(record({ startedAt: Date.parse('2026-09-20T00:00:00Z'), fold: 'on', contextTokens: 999_999 }));
    assert.equal(await f.run(['stats', '--since', '2026-09-25', '--until', '2026-09-26']), 0);
    const text = f.out.join('\n');
    assert.match(text, /turns: 20 \(off 10, on 10\)/);
    const line = (label: string) => f.out.find(candidate => candidate.startsWith(label))!;
    // Time to the first reply: off 2..11 s after arrival (received a second before the start), on 1.5 s.
    assert.match(line('first reply or post (s)'), /\s6\.0\s+10\.0\s+1\.5\s+1\.5$/);
    assert.match(line('context at start (tokens)'), /\s1000\s+1000\s+400\s+400$/);
    assert.match(line('compactions'), /\s0\s+1$/);
    assert.doesNotMatch(text, /999999/);
  } finally { await f.cleanup(); }
});

test('stats says so when there is nothing to show', async () => {
  const f = await setup();
  try {
    assert.equal(await f.run(['stats']), 0);
    assert.match(f.out.join('\n'), /no turns/);
  } finally { await f.cleanup(); }
});

test('stats shows the signs of confusion per turn, folded and not, and the turns cut short', async () => {
  const f = await setup();
  try {
    const stats = new TurnStats(f.db);
    stats.record(record({ fold: 'off', confusion: { repeatedCalls: 2, toolErrors: 1, doveRefusals: 1, unansweredMessages: 1 } }));
    stats.record(record({ fold: 'off', outcome: 'model-call-limit' }));
    stats.record(record({ fold: 'on' }));
    assert.equal(await f.run(['stats']), 0);
    const line = (label: string) => f.out.find(candidate => candidate.startsWith(label))!;
    assert.match(line('repeated calls / turn'), /\s1\.00\s+0\.00$/);
    assert.match(line('tool errors / turn'), /\s0\.50\s+0\.00$/);
    assert.match(line('dove refusals / turn'), /\s0\.50\s+0\.00$/);
    assert.match(line('unanswered messages / turn'), /\s0\.50\s+0\.00$/);
    assert.match(line('cut short (%)'), /\s50\s+0$/);
  } finally { await f.cleanup(); }
});

test('stats --memos lists the latest memos from the session files the config points at', async () => {
  const f = await setup();
  try {
    const sessions = join(f.data, 'sessions');
    await mkdir(sessions);
    const entry = (role: string, text: string, at: string) => JSON.stringify({ type: 'message', timestamp: at,
      message: role === 'user' ? { role, content: [{ type: 'text', text }] }
        : { role, content: [{ type: 'thinking', thinking: '考え' }, { type: 'text', text }] } });
    await writeFile(join(sessions, 'a.jsonl'), [JSON.stringify({ type: 'session', id: 's' }),
      entry('user', '<events>…</events>', '2026-09-25T10:00:00.000Z'), entry('assistant', '地の文', '2026-09-25T10:00:01.000Z'),
      entry('user', REFLECTION_REQUEST, '2026-09-25T10:00:02.000Z'), entry('assistant', '予定は 15:00。', '2026-09-25T10:00:03.000Z'),
      entry('user', REFLECTION_REQUEST, '2026-09-25T11:00:02.000Z'), entry('assistant', '特になし', '2026-09-25T11:00:03.000Z'),
    ].join('\n'));
    const config = join(f.data, 'config.json');
    await writeFile(config, JSON.stringify({ pi: { sessionDirectory: sessions } }));
    assert.equal(await f.run(['stats', '--memos', '1', '--config', config]), 0);
    assert.deepEqual(f.out, ['2026-09-25T11:00:03.000Z  特になし']);
    assert.equal(await f.run(['stats', '--memos', '5', '--config', config]), 0);
    assert.deepEqual(f.out, ['2026-09-25T10:00:03.000Z  予定は 15:00。', '2026-09-25T11:00:03.000Z  特になし']);
  } finally { await f.cleanup(); }
});
