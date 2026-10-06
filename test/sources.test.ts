import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { ConversationStore } from '../src/server/conversation-store.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { drawWait, SOURCES_DEFAULTS, Sources } from '../src/server/sources.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { DECODABLE_PNG } from './support/fake-slack.ts';

/**
 * The core of what natsumi reads (ADR 0050, ADR 0053): `/sources` as one git work tree, a `sources_updated` event when
 * a directory has changed and the wait drawn at its first change is up, sooner on the whole for a busy one, never at
 * night unless something is for her, and `sources-diff` to read what changed. Nothing here knows Slack.
 */

const run = promisify(execFile);
const TIME_ZONE = 'Asia/Tokyo';
const MINUTE = 60_000;
/** 10:00 in Tokyo: awake. */
const MORNING = Date.parse('2026-09-27T01:00:00Z');
/** 02:00 in Tokyo: asleep. */
const NIGHT = Date.parse('2026-09-26T17:00:00Z');
/** A draw that makes the wait exactly its mean: -ln(1 - u) = 1. */
const AT_MEAN = 1 - Math.exp(-1);
const SCRIPT = join(import.meta.dirname, '..', 'docker', 'sources-diff', 'sources-diff');

/**
 * `under` puts the two directories one level down, as the server's data directory holds them (`<under>/sources`,
 * `<under>/sources.git`), so a test can move them where the workspace sees them.
 */
async function setup(t: test.TestContext, start = MORNING,
  options: { historyDays?: number; under?: string; random?: () => number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-sources-')));
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  let clock = start;
  const now = () => clock;
  const store = new ConversationStore(db, now);
  const directory = join(root, options.under ?? '', 'sources');
  const gitDirectory = join(root, options.under ?? '', 'sources.git');
  let raised = 0;
  const sources = new Sources({
    db, directory, gitDirectory, timeZone: TIME_ZONE, awakeHours: { start: '08:00', end: '23:00' },
    activity: SOURCES_DEFAULTS.activity, historyDays: options.historyDays ?? SOURCES_DEFAULTS.historyDays, now,
    raise: () => { raised += 1; }, random: options.random ?? (() => AT_MEAN),
  });
  sources.register({ name: 'chat', depth: 2, exclude: ['INDEX.md', '*/*/files/'] });
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), text);
  };
  const append = (path: string, text: string) => appendFile(join(directory, path), text);
  /** A turn beginning: the event the loop would have queued, and what the sources make of it. */
  const take = async () => {
    const eventId = store.insertEvent('sources-updated');
    const ready = await sources.take(eventId);
    return { ready, eventId, line: ready ? sources.eventLine(eventId, 'received') : undefined };
  };
  const diff = async (...args: string[]) => (await run('sh', [SCRIPT, ...args], {
    env: { ...process.env, SOURCES_GIT_DIR: gitDirectory, SOURCES_ROOT: '/sources', TZ: TIME_ZONE },
  })).stdout;
  return {
    root, db, directory, gitDirectory, sources, write, append, take, diff,
    raised: () => raised, advance: (ms: number) => { clock += ms; }, at: (ms: number) => { clock = ms; },
  };
}

test('a directory seen for the first time is taken in silently: its past is not news', async t => {
  const f = await setup(t);
  await f.write('chat/work/dev/2026-09-26.jsonl', '{"text":"昔の発言"}\n');
  await f.sources.prepare();
  f.advance(90 * MINUTE);
  await f.sources.tick();
  assert.equal(f.raised(), 0);
  // A channel that appears later is placed as silently, however much it brings.
  await f.write('chat/work/new/2026-09-27.jsonl', '{"text":"埋め直した発言"}\n');
  await f.sources.tick();
  f.advance(90 * MINUTE);
  await f.sources.tick();
  assert.equal(f.raised(), 0);
  assert.equal((await f.take()).ready, false);
});

test('the files of the chat under uploads/ are outside the history: never committed, never news (ADR 0071)', async t => {
  const f = await setup(t);
  await f.sources.prepare();
  await f.write('uploads/20261006T000000Z-ab12/報告書.pdf', '%PDF');
  f.advance(90 * MINUTE);
  await f.sources.tick();
  assert.equal(f.raised(), 0);
  assert.equal((await f.take()).ready, false);
  const git = (...args: string[]) => run('git', [`--git-dir=${f.gitDirectory}`, `--work-tree=${f.directory}`, ...args]);
  assert.equal((await git('status', '--porcelain', '--untracked-files=all')).stdout, '', 'left out, not even untracked');
  assert.equal((await git('log', '--all', '--format=%H', '--', 'uploads')).stdout, '');
});

test('a changed directory raises once the wait drawn at its first change is up, and the event names the files', async t => {
  const f = await setup(t);
  await f.write('chat/work/dev/2026-09-27.jsonl', '{"text":"一"}\n');
  await f.write('chat/INDEX.md', '# 目次\n');
  await f.sources.prepare();
  f.advance(MINUTE);
  await f.append('chat/work/dev/2026-09-27.jsonl', '{"text":"秘密の本文"}\n');
  await f.write('chat/INDEX.md', '# 目次が変わった\n');
  await f.sources.tick();
  // One write in the window: the quiet mean, drawn from the first change.
  assert.equal(f.sources.deadline('chat/work/dev'), MORNING + 11 * MINUTE);
  f.advance(9 * MINUTE);
  await f.sources.tick();
  assert.equal(f.raised(), 0);
  f.advance(MINUTE);
  await f.sources.tick();
  assert.equal(f.raised(), 1);
  const { ready, line } = await f.take();
  assert.equal(ready, true);
  assert.equal(line!.type, 'sources_updated');
  // One write counted since the last look; no attention, so no field for it.
  assert.deepEqual(line!.changed, [{ dir: '/sources/chat/work/dev', files: ['/sources/chat/work/dev/2026-09-27.jsonl'], writes: 1,
    diff: 'sources-diff /sources/chat/work/dev' }]);
  assert.equal(line!.attention, undefined);
  assert.doesNotMatch(JSON.stringify(line), /秘密の本文|INDEX/);
  // Shown: no wait is left, and nothing is due again until it changes again.
  assert.equal(f.sources.deadline('chat/work/dev'), undefined);
  f.advance(120 * MINUTE);
  await f.sources.tick();
  assert.equal(f.raised(), 1);
});

test('the wait is drawn once, at the first change after the last look: later writes do not move it', async t => {
  const draws = [AT_MEAN, 0.5];
  const f = await setup(t, MORNING, { random: () => draws.shift() ?? AT_MEAN });
  await f.write('chat/work/dev/a.jsonl', '');
  await f.sources.prepare();
  f.advance(MINUTE);
  await f.append('chat/work/dev/a.jsonl', '{"n":0}\n');
  await f.sources.tick();
  const first = f.sources.deadline('chat/work/dev');
  assert.equal(first, MORNING + 11 * MINUTE);
  for (let n = 1; n < 20; n += 1) {
    f.advance(10_000);
    await f.append('chat/work/dev/a.jsonl', `{"n":${n}}\n`);
    await f.sources.tick();
  }
  assert.equal(f.sources.deadline('chat/work/dev'), first);
  f.at(first!);
  await f.sources.tick();
  await f.take();
  // The next change draws again, now from a busy window: 20 writes in 15 minutes is a mean of the shortest, 3 minutes.
  f.advance(MINUTE);
  await f.append('chat/work/dev/a.jsonl', '{"n":20}\n');
  await f.sources.tick();
  assert.equal(f.sources.deadline('chat/work/dev'), first! + MINUTE + Math.round(3 * MINUTE * Math.LN2));
});

test('the mean wait shortens with the rate of writes over the last 15 minutes, between the shortest and the quiet mean', async t => {
  const f = await setup(t);
  await f.write('chat/work/dev/a.jsonl', '');
  await f.write('chat/work/quiet/a.jsonl', '');
  await f.sources.prepare();
  // No write, or one, in the window: the quiet mean.
  assert.equal(f.sources.mean('chat/work/quiet'), 10 * MINUTE);
  const write = async (n: number, step: number) => {
    f.advance(step);
    await f.append('chat/work/dev/a.jsonl', `{"n":${n}}\n`);
    await f.sources.tick();
  };
  await write(0, MINUTE);
  assert.equal(f.sources.mean('chat/work/dev'), 10 * MINUTE);
  // Two writes in 15 minutes: k ÷ rate = 3 ÷ (2 / 15 min) = 22.5 minutes, held at the quiet mean. Never slower than quiet.
  await write(1, MINUTE);
  assert.equal(f.sources.mean('chat/work/dev'), 10 * MINUTE);
  for (let n = 2; n < 6; n += 1) await write(n, MINUTE);
  // Six: 3 ÷ (6 / 15 min) = 7.5 minutes.
  assert.equal(f.sources.mean('chat/work/dev'), 7.5 * MINUTE);
  for (let n = 6; n < 40; n += 1) await write(n, 10_000);
  // Fifteen and more: held at the shortest.
  assert.equal(f.sources.mean('chat/work/dev'), 3 * MINUTE);
  // Fifteen minutes on with nothing written, the writes have aged out and it is quiet again.
  f.advance(16 * MINUTE);
  await f.sources.tick();
  assert.equal(f.sources.mean('chat/work/dev'), 10 * MINUTE);
});

test('a wait is exponential around its mean and cut at the longest: mostly sooner than the mean, now and then long', () => {
  const mean = 10 * MINUTE;
  const longest = 60 * MINUTE;
  assert.equal(drawWait(mean, longest, 0), 0);
  assert.equal(drawWait(mean, longest, AT_MEAN), mean);
  assert.equal(drawWait(mean, longest, 0.5), Math.round(mean * Math.LN2));
  assert.equal(drawWait(mean, longest, 0.999999), longest);
  // A fixed sequence of draws, many of them.
  let seed = 12345;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const waits = Array.from({ length: 20_000 }, () => drawWait(mean, longest, random()));
  const average = waits.reduce((sum, wait) => sum + wait, 0) / waits.length;
  // The cut barely moves the mean of 10 minutes: 10 × (1 - e^-6) ≈ 9.98.
  assert.ok(Math.abs(average - mean * (1 - Math.exp(-6))) < 0.03 * mean, `average ${average / MINUTE} min`);
  assert.ok(Math.max(...waits) <= longest);
  assert.ok(waits.some(wait => wait === longest), 'never cut at the longest');
  const sooner = waits.filter(wait => wait < mean).length / waits.length;
  // 1 - e^-1 ≈ 63% come sooner than the mean.
  assert.ok(Math.abs(sooner - AT_MEAN) < 0.02, `sooner ${sooner}`);
  assert.ok(waits.filter(wait => wait < 3 * MINUTE).length / waits.length > 0.2, 'a quiet directory is seldom told of early');
});

test('the draw comes from the random source given, and a long draw is cut at the longest', async t => {
  const f = await setup(t, MORNING, { random: () => 0.999999 });
  await f.write('chat/work/dev/a.jsonl', '');
  await f.sources.prepare();
  f.advance(MINUTE);
  await f.append('chat/work/dev/a.jsonl', '{"n":0}\n');
  await f.sources.tick();
  assert.equal(f.sources.deadline('chat/work/dev'), MORNING + 61 * MINUTE);
});

test('a busy directory is looked at sooner, and another close to its time rides along', async t => {
  const f = await setup(t);
  await f.write('chat/work/dev/a.jsonl', '');
  await f.write('chat/work/ops/a.jsonl', '');
  await f.write('chat/work/far/a.jsonl', '');
  await f.sources.prepare();
  // ops changes first: the quiet mean, due at 11 minutes.
  f.advance(MINUTE);
  await f.append('chat/work/ops/a.jsonl', '{"n":0}\n');
  await f.sources.tick();
  // dev is busy, and shown (by an attention) at once.
  for (let n = 0; n < 15; n += 1) {
    f.advance(10_000);
    await f.append('chat/work/dev/a.jsonl', `{"n":${n}}\n`);
    await f.sources.tick();
  }
  f.sources.attention({ source: 'chat', kind: 'dm', file: '/sources/chat/work/dev/a.jsonl', path: '.[0]' });
  const { line: first } = await f.take();
  assert.deepEqual((first!.changed as { dir: string }[]).map(entry => entry.dir), ['/sources/chat/work/dev']);
  // far changes later: due at 16 minutes.
  f.at(MORNING + 6 * MINUTE);
  await f.append('chat/work/far/a.jsonl', '{"n":0}\n');
  await f.sources.tick();
  // dev's next change draws from its busy window: the shortest mean, due at 9.5 minutes.
  f.at(MORNING + 6.5 * MINUTE);
  await f.append('chat/work/dev/a.jsonl', '{"n":15}\n');
  await f.sources.tick();
  assert.equal(f.sources.deadline('chat/work/dev'), MORNING + 9.5 * MINUTE);
  const raised = f.raised();
  f.at(MORNING + 9 * MINUTE);
  await f.sources.tick();
  assert.equal(f.raised(), raised);
  f.at(MORNING + 9.5 * MINUTE);
  await f.sources.tick();
  assert.equal(f.raised(), raised + 1);
  // ops, a minute and a half from its time, rides along; far, six and a half away, does not.
  const { line } = await f.take();
  assert.deepEqual((line!.changed as { dir: string }[]).map(entry => entry.dir), ['/sources/chat/work/dev', '/sources/chat/work/ops']);
  assert.equal(f.sources.deadline('chat/work/far'), MORNING + 16 * MINUTE);
});

test('a change left unshown by an earlier process gets a fresh wait as the server starts', async t => {
  const f = await setup(t);
  await f.write('chat/work/dev/a.jsonl', '');
  await f.sources.prepare();
  f.advance(MINUTE);
  await f.append('chat/work/dev/a.jsonl', '{"n":0}\n');
  const later = MORNING + 30 * MINUTE;
  const again = new Sources({ db: f.db, directory: f.directory, gitDirectory: f.gitDirectory, timeZone: TIME_ZONE,
    awakeHours: { start: '08:00', end: '23:00' }, activity: SOURCES_DEFAULTS.activity, historyDays: 7, now: () => later,
    random: () => AT_MEAN });
  again.register({ name: 'chat', depth: 2 });
  await again.prepare();
  assert.equal(again.deadline('chat/work/dev'), later + 10 * MINUTE);
});

test('at night nothing but what is for her raises; the night comes together in the morning\'s first look', async t => {
  const f = await setup(t, NIGHT);
  await f.write('chat/work/dev/a.jsonl', '');
  await f.sources.prepare();
  f.advance(MINUTE);
  await f.append('chat/work/dev/a.jsonl', '{"text":"夜の発言"}\n');
  await f.sources.tick();
  f.advance(2 * 60 * MINUTE);
  await f.append('chat/work/dev/a.jsonl', '{"text":"もう一つ"}\n');
  await f.sources.tick();
  assert.equal(f.raised(), 0);
  f.at(MORNING);
  await f.sources.tick();
  assert.equal(f.raised(), 1);
  await f.take();
  const shown = await f.diff();
  assert.match(shown, /夜の発言/);
  assert.match(shown, /もう一つ/);
});

test('attention raises at once, even at night, with its images; the other due directories wait for the morning', async t => {
  const f = await setup(t, NIGHT);
  await f.write('chat/work/dev/a.jsonl', '');
  await f.write('chat/work/dm/a.jsonl', '');
  await f.sources.prepare();
  f.advance(90 * MINUTE);
  await f.append('chat/work/dev/a.jsonl', '{"text":"雑談"}\n');
  await f.append('chat/work/dm/a.jsonl', '{"text":"@natsumi 見て"}\n');
  await mkdir(join(f.directory, 'chat/work/dm/files'), { recursive: true });
  await writeFile(join(f.directory, 'chat/work/dm/files/a.png'), DECODABLE_PNG);
  f.sources.attention({ source: 'chat', kind: 'dm', file: '/sources/chat/work/dm/a.jsonl', path: '.[0]',
    images: Array.from({ length: 6 }, () => '/sources/chat/work/dm/files/a.png') });
  assert.equal(f.raised(), 1);
  const { line, eventId } = await f.take();
  // The attention sits inside the directory it is in.
  assert.equal(line!.attention, undefined);
  const changed = line!.changed as { dir: string; attention?: unknown[] }[];
  assert.deepEqual(changed.map(entry => entry.dir), ['/sources/chat/work/dm']);
  assert.deepEqual(changed[0]!.attention, [{ source: 'chat', kind: 'dm', file: '/sources/chat/work/dm/a.jsonl', path: '.[0]' }]);
  // The core adds the images, four at most.
  assert.equal((await f.sources.images(eventId)).length, 4);
  // Handed over once.
  assert.equal((await f.take()).ready, false);
  f.at(MORNING);
  await f.sources.tick();
  const { line: morning } = await f.take();
  const dev = morning!.changed as { dir: string; attention?: unknown[] }[];
  assert.deepEqual(dev.map(entry => entry.dir), ['/sources/chat/work/dev']);
  assert.equal(dev[0]!.attention, undefined);
});

test('attention waiting in the database is handed over after a restart', async t => {
  const f = await setup(t);
  await f.write('chat/work/dm/a.jsonl', '{"text":"x"}\n');
  await f.sources.prepare();
  f.sources.attention({ source: 'chat', kind: 'dm', file: '/sources/chat/work/dm/a.jsonl', path: '.[0]' });
  const again = new Sources({ db: f.db, directory: f.directory, gitDirectory: f.gitDirectory, timeZone: TIME_ZONE,
    awakeHours: { start: '08:00', end: '23:00' }, activity: SOURCES_DEFAULTS.activity, historyDays: 7, now: () => MORNING });
  let raised = 0;
  again.connect(() => { raised += 1; });
  again.register({ name: 'chat', depth: 2 });
  await again.prepare();
  await again.tick();
  assert.equal(raised, 1);
});

test('sources-diff shows what the last event showed, one directory of it, or a range such as since yesterday', async t => {
  const f = await setup(t);
  await f.write('chat/work/dev/a.jsonl', '{"text":"前から"}\n');
  await f.write('chat/work/ops/a.jsonl', '');
  await f.sources.prepare();
  f.advance(61 * MINUTE);
  await f.append('chat/work/dev/a.jsonl', '{"text":"一回目"}\n');
  await f.sources.tick();
  f.advance(10 * MINUTE);
  await f.take();
  f.advance(24 * 60 * MINUTE);
  await f.append('chat/work/dev/a.jsonl', '{"text":"二回目"}\n');
  await f.append('chat/work/ops/a.jsonl', '{"text":"運用"}\n');
  await f.sources.tick();
  f.advance(10 * MINUTE);
  await f.take();
  const last = await f.diff();
  assert.match(last, /^\+\+\+ \/sources\/chat\/work\/dev\/a\.jsonl$/m);
  assert.match(last, /^diff --git \/sources\/chat\/work\/dev\/a\.jsonl \/sources\/chat\/work\/dev\/a\.jsonl$/m);
  assert.doesNotMatch(last, /new file mode/, 'a file that was there is not shown as a new one');
  assert.match(last, /^\+\{"text":"二回目"\}$/m);
  assert.match(last, /運用/);
  assert.doesNotMatch(last, /一回目|前から/);
  const one = await f.diff('/sources/chat/work/ops');
  assert.match(one, /運用/);
  assert.doesNotMatch(one, /二回目/);
  const since = await f.diff('--since', '2026-09-27 00:00', '/sources/chat/work/dev');
  assert.match(since, /一回目/);
  assert.match(since, /二回目/);
  assert.doesNotMatch(since, /前から/);
});

test('sources-diff reads the history where the workspace sees it, though the server made it somewhere else', async t => {
  // The server writes <data>/sources and <data>/sources.git; the workspace sees them as /sources and /sources.git,
  // and has no <data> at all. Here the server's side is <root>/data, and the workspace's is <root>/ws.
  const f = await setup(t, MORNING, { under: 'data' });
  await f.write('chat/work/dev/a.jsonl', '{"text":"前から"}\n');
  await f.write('chat/work/ops/a.jsonl', '');
  await f.sources.prepare();
  f.advance(61 * MINUTE);
  await f.append('chat/work/dev/a.jsonl', '{"text":"一回目"}\n');
  await f.sources.tick();
  f.advance(10 * MINUTE);
  await f.take();
  f.advance(24 * 60 * MINUTE);
  await f.append('chat/work/dev/a.jsonl', '{"text":"二回目"}\n');
  await f.append('chat/work/ops/a.jsonl', '{"text":"運用"}\n');
  await f.sources.tick();
  f.advance(10 * MINUTE);
  await f.take();
  // A history made by an earlier server names the server's work tree in its config; it must read all the same.
  await run('git', ['--git-dir', f.gitDirectory, 'config', 'core.worktree', f.directory]);
  const workspace = join(f.root, 'ws');
  await rename(join(f.root, 'data'), workspace);
  const diff = async (options: { root?: string; cwd?: string }, ...args: string[]) => (await run('sh', [SCRIPT, ...args], {
    cwd: options.cwd,
    env: { ...process.env, SOURCES_GIT_DIR: join(workspace, 'sources.git'), SOURCES_ROOT: options.root ?? '/sources', TZ: TIME_ZONE },
  })).stdout;
  const last = await diff({});
  assert.match(last, /^\+\+\+ \/sources\/chat\/work\/dev\/a\.jsonl$/m);
  assert.match(last, /^\+\{"text":"二回目"\}$/m);
  assert.match(last, /運用/);
  assert.doesNotMatch(last, /一回目|前から/);
  const one = await diff({}, '/sources/chat/work/ops');
  assert.match(one, /運用/);
  assert.doesNotMatch(one, /二回目/);
  const since = await diff({}, '--since', '2026-09-27 00:00', '/sources/chat/work/dev');
  assert.match(since, /一回目/);
  assert.match(since, /二回目/);
  assert.doesNotMatch(since, /前から|運用/);
  // Run from inside the work tree, a directory is still named from its top, not from where she stands.
  const sources = join(workspace, 'sources');
  const inside = await diff({ root: sources, cwd: join(sources, 'chat', 'work') }, `${sources}/chat/work/ops`);
  assert.match(inside, /運用/);
  assert.doesNotMatch(inside, /二回目/);
});

test('the server leaves no work tree in the history\'s config, and takes out one an earlier server left', async t => {
  const f = await setup(t);
  await f.write('chat/work/dev/a.jsonl', '{"text":"x"}\n');
  await f.sources.prepare();
  const worktree = () => run('git', ['--git-dir', f.gitDirectory, 'config', '--get', 'core.worktree']);
  await assert.rejects(worktree(), 'a new history names no work tree');
  await run('git', ['--git-dir', f.gitDirectory, 'config', 'core.worktree', f.directory]);
  let clock = MORNING;
  const again = new Sources({ db: f.db, directory: f.directory, gitDirectory: f.gitDirectory, timeZone: TIME_ZONE,
    awakeHours: { start: '08:00', end: '23:00' }, activity: SOURCES_DEFAULTS.activity, historyDays: 7, now: () => clock });
  let raised = 0;
  again.connect(() => { raised += 1; });
  again.register({ name: 'chat', depth: 2 });
  await again.prepare();
  await assert.rejects(worktree(), 'the one an earlier server left is gone');
  // And the server still sees its own work tree without it: a change there raises as before.
  await f.append('chat/work/dev/a.jsonl', '{"text":"y"}\n');
  await again.tick();
  clock += 61 * MINUTE;
  await again.tick();
  assert.equal(raised, 1);
});

test('sources-diff refuses a path outside /sources with an error and a non-zero exit, and shows nothing', async t => {
  const f = await setup(t);
  await f.write('chat/work/dev/a.jsonl', '{"text":"x"}\n');
  await f.sources.prepare();
  for (const args of [['/etc/passwd'], ['--since', 'yesterday', '/etc'], ['/sources/chat/work/dev', '/tmp']]) {
    await assert.rejects(f.diff(...args), (error: { code: number; stdout: string; stderr: string }) =>
      error.code === 2 && /\/sources の下ではありません/.test(error.stderr) && error.stdout === '', args.join(' '));
  }
});

test('sources-diff says so when there is no history to read', async t => {
  const f = await setup(t);
  await assert.rejects(f.diff(), (error: { stderr: string }) => /履歴/.test(error.stderr));
});

test('the nightly pruning keeps N days, and every ref still works after it', async t => {
  const f = await setup(t, MORNING, { historyDays: 2 });
  await f.write('chat/work/dev/a.jsonl', '');
  await f.write('chat/work/ops/a.jsonl', '');
  await f.sources.prepare();
  for (let day = 0; day < 5; day += 1) {
    f.advance(24 * 60 * MINUTE);
    await f.append('chat/work/dev/a.jsonl', `{"day":${day}}\n`);
    await f.sources.tick();
    f.advance(10 * MINUTE);
    await f.take();
  }
  const count = async () => Number((await run('git', ['--git-dir', f.gitDirectory, 'rev-list', '--count', 'HEAD'])).stdout.trim());
  const before = await count();
  await f.sources.prune();
  assert.ok(await count() < before, 'history was cut');
  assert.ok(await count() <= 3);
  // The last event still reads, and a new change still shows only itself.
  assert.match(await f.diff('/sources/chat/work/dev'), /"day":4/);
  f.advance(24 * 60 * MINUTE);
  await f.append('chat/work/ops/a.jsonl', '{"text":"その後"}\n');
  await f.append('chat/work/dev/a.jsonl', '{"day":5}\n');
  await f.sources.tick();
  f.advance(10 * MINUTE);
  const { line } = await f.take();
  assert.deepEqual((line!.changed as { dir: string }[]).map(entry => entry.dir), ['/sources/chat/work/dev', '/sources/chat/work/ops']);
  const shown = await f.diff();
  assert.match(shown, /"day":5/);
  assert.doesNotMatch(shown, /"day":4/);
  assert.match(shown, /その後/);
  const fsck = await run('git', ['--git-dir', f.gitDirectory, 'fsck', '--no-progress']);
  assert.equal(fsck.stderr.trim(), '');
});

// ADR 0069: a source may put a whole new directory and an attention in it at once, such as an outside agent's reply.
test('an attention in a directory seen for the first time is still shown, with its own fields and no jq path', async t => {
  const f = await setup(t);
  f.sources.register({ name: 'agents', depth: 2, exclude: ['*/*/images/'] });
  await f.sources.prepare();
  f.advance(MINUTE);
  await f.write('agents/wiki/20260927T010000Z-ab12/README.md', '# wiki の返事\n');
  await f.write('agents/wiki/20260927T010000Z-ab12/01-本文.md', '# 本文\n\nねこは液体です。\n');
  await f.write('agents/wiki/20260927T010000Z-ab12/images/a.png', 'png');
  // Recorded in the caller's transaction, and the event asked for afterwards.
  f.db.exec('BEGIN');
  const recorded = f.sources.recordAttention({ source: 'agents', kind: 'agent_reply', file: '/sources/agents/wiki/20260927T010000Z-ab12/README.md',
    details: { agent: 'wiki', state: 'completed', summary: 'ねこは液体です。' } });
  f.db.exec('COMMIT');
  assert.equal(recorded, true);
  assert.equal(f.raised(), 0, 'recording alone asks for nothing');
  f.sources.notify();
  assert.equal(f.raised(), 1);
  // A tick in between takes the new directory in, and the attention still waits.
  await f.sources.tick();
  const { line } = await f.take();
  const changed = line!.changed as Record<string, unknown>[];
  assert.deepEqual(changed.map(entry => entry.dir), ['/sources/agents/wiki/20260927T010000Z-ab12']);
  assert.deepEqual(changed[0]!.attention, [{ source: 'agents', kind: 'agent_reply',
    file: '/sources/agents/wiki/20260927T010000Z-ab12/README.md', agent: 'wiki', state: 'completed', summary: 'ねこは液体です。' }]);
  // The body is not shown as a diff: she reads the README and the sections she needs.
  assert.equal(changed[0]!.diff, undefined);
  // The images are kept out of the history.
  const tracked = (await run('git', ['--git-dir', f.gitDirectory, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'HEAD'])).stdout;
  assert.match(tracked, /01-本文\.md/);
  assert.doesNotMatch(tracked, /images/);
});

test('an attention outside the directories of its source is let go when recorded, and nothing is asked for', async t => {
  const f = await setup(t);
  f.sources.register({ name: 'agents', depth: 2 });
  await f.sources.prepare();
  assert.equal(f.sources.recordAttention({ source: 'agents', kind: 'agent_reply', file: '/sources/agents/wiki' }), false);
  assert.equal(f.sources.recordAttention({ source: 'agents', kind: 'agent_reply', file: '/sources/chat/work/dm/a.jsonl' }), false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_attention').get()!.n, 0);
});
