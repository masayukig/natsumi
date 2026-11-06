import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { ConversationStore } from '../src/server/conversation-store.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { JOBS_PATH, JOBS_REGISTRATION, SHELL_FINISHED, ShellJobs, type JobsPlace } from '../src/server/shell-jobs.ts';
import { SOURCES_DEFAULTS, Sources, type Attention } from '../src/server/sources.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';

/**
 * A command natsumi left running in the background (ADR 0094): one directory under /sources/jobs, made when it went
 * there and taken in as not news, and filled with how it ended and its output when it does. An exit code is told at
 * once by an attention; a signal, the end of the wait and a lost wait are ordinary updates.
 */

const run = promisify(execFile);
/** 2026-11-06 12:34:56 in Tokyo. */
const AT = Date.parse('2026-11-06T03:34:56Z');

async function setup(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-jobs-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'sources', 'jobs');
  const attentions: Attention[] = [];
  const takenIn: string[] = [];
  let notified = 0;
  const place: JobsPlace = {
    recordAttention: attention => { attentions.push(attention); return true; },
    notify: () => { notified += 1; },
    takeIn: async path => { takenIn.push(path); },
  };
  let clock = AT;
  let draws = 0;
  const jobs = new ShellJobs({ directory, timeZone: 'Asia/Tokyo', now: () => clock, random: () => [0.5, 0.25][draws++ % 2]!, place });
  const read = (path: string, file: string) => readFile(join(directory, path.slice(JOBS_PATH.length + 1), file), 'utf8');
  return { root, directory, jobs, attentions, takenIn, notified: () => notified, read, advance: (ms: number) => { clock += ms; } };
}

const output = { stdout: 'done\n', stderr: '' };

test('a command going to the background gets a directory named by the time and a mark, taken in as not news', async t => {
  const f = await setup(t);
  const path = await f.jobs.open({ command: 'python3 /work/count.py > /work/out.txt', processGroup: 4242 });
  assert.equal(path, `${JOBS_PATH}/20261106T033456Z-8000`);
  assert.deepEqual(f.takenIn, [path]);
  const readme = await f.read(path, 'README.md');
  assert.match(readme, /python3 \/work\/count\.py > \/work\/out\.txt/);
  assert.match(readme, /2026-11-06 12:34/);
  assert.match(readme, /4242/);
  assert.match(readme, /kill -- -4242/);
  assert.match(readme, /動いています/);
  assert.equal(f.attentions.length, 0);
  assert.equal(f.notified(), 0);
  // The second gets another mark even in the same second.
  const second = await f.jobs.open({ command: 'sleep 100', processGroup: 4243 });
  assert.equal(second, `${JOBS_PATH}/20261106T033456Z-4000`);
});

test('a command that exits is told at once by an attention that carries its exit code and no output', async t => {
  const f = await setup(t);
  const path = await f.jobs.open({ command: 'make test', processGroup: 77 });
  f.advance(90_000);
  await f.jobs.end(path, { kind: 'exited', exitCode: 2, output: { stdout: 'ok 1\nnot ok 2\n', stderr: 'FAIL\n' } });
  assert.deepEqual(f.attentions, [{ source: 'jobs', kind: SHELL_FINISHED, file: `${path}/README.md`, details: { exit_code: 2 } }]);
  assert.equal(SHELL_FINISHED, 'shell_finished');
  assert.equal(f.notified(), 1);
  assert.equal(await f.read(path, 'stdout.txt'), 'ok 1\nnot ok 2\n');
  assert.equal(await f.read(path, 'stderr.txt'), 'FAIL\n');
  const readme = await f.read(path, 'README.md');
  assert.match(readme, /終了コード 2/);
  assert.match(readme, /2026-11-06 12:36/);
  assert.match(readme, /make test/);
  assert.match(readme, /stdout\.txt/);
  assert.doesNotMatch(readme, /not ok 2/, 'the output is in its files, not in the README');
});

test('an output the runner cut keeps its head and tail in the file, and the README says how much was left out', async t => {
  const f = await setup(t);
  const path = await f.jobs.open({ command: 'seq 1 1000000', processGroup: 9 });
  await f.jobs.end(path, { kind: 'exited', exitCode: 0,
    output: { stdout: '1\n2\n', stdoutTail: '999999\n1000000\n', stdoutOmitted: 6_888_000, stderr: '' } });
  const stdout = await f.read(path, 'stdout.txt');
  assert.match(stdout, /^1\n2\n/);
  assert.match(stdout, /999999\n1000000\n$/);
  assert.match(stdout, /6888000 バイト/);
  assert.match(await f.read(path, 'README.md'), /6888000 バイト/);
});

test('a command ended by a signal is an ordinary update that names the signal', async t => {
  const f = await setup(t);
  const path = await f.jobs.open({ command: 'python3 big.py', processGroup: 5 });
  await f.jobs.end(path, { kind: 'signaled', signal: 'killed', output });
  assert.equal(f.attentions.length, 0);
  assert.equal(f.notified(), 0);
  assert.match(await f.read(path, 'README.md'), /シグナル（killed）/);
  assert.equal(await f.read(path, 'stdout.txt'), 'done\n');
});

test('past the longest wait, the README says it is no longer waited for and how to stop it, as an ordinary update', async t => {
  const f = await setup(t);
  const path = await f.jobs.open({ command: 'tail -f /dev/null', processGroup: 31 });
  await f.jobs.end(path, { kind: 'gave-up', output: { stdout: 'so far\n', stderr: '' } });
  assert.equal(f.attentions.length, 0);
  const readme = await f.read(path, 'README.md');
  assert.match(readme, /24 時間/);
  assert.match(readme, /もう待ちません/);
  assert.match(readme, /kill -- -31/);
  assert.equal(await f.read(path, 'stdout.txt'), 'so far\n');
});

test('a wait cut off by the runner is an ordinary update that says the end will not be known', async t => {
  const f = await setup(t);
  const path = await f.jobs.open({ command: 'sleep 1000', processGroup: 8 });
  await f.jobs.end(path, { kind: 'lost' });
  assert.equal(f.attentions.length, 0);
  assert.match(await f.read(path, 'README.md'), /待てなくなりました/);
});

test('as the server starts, a directory with no end written says the restart cut its wait off; ended ones are left', async t => {
  const f = await setup(t);
  const running = await f.jobs.open({ command: 'sleep 1000', processGroup: 1 });
  const ended = await f.jobs.open({ command: 'true', processGroup: 2 });
  await f.jobs.end(ended, { kind: 'exited', exitCode: 0, output });
  const before = await f.read(ended, 'README.md');
  const again = new ShellJobs({ directory: f.directory, timeZone: 'Asia/Tokyo', now: () => AT });
  assert.equal(await again.giveUpOnRunning(), 1);
  assert.match(await f.read(running, 'README.md'), /サーバーが再起動/);
  assert.equal(await f.read(ended, 'README.md'), before);
  assert.equal(await again.giveUpOnRunning(), 0, 'once told, it is not told again');
});

test('with no directory yet, the start has nothing to do', async t => {
  const f = await setup(t);
  assert.equal(await f.jobs.giveUpOnRunning(), 0);
  await assert.rejects(readdir(f.directory));
});

test('the history keeps the README alone, and the attention reaches the event', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-jobs-')));
  const db = openStateDatabase(join(root, 'state.sqlite'));
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  migrate(db, MIGRATIONS);
  const store = new ConversationStore(db, () => AT);
  const directory = join(root, 'sources');
  const gitDirectory = join(root, 'sources.git');
  const sources = new Sources({ db, directory, gitDirectory, timeZone: 'Asia/Tokyo', awakeHours: { start: '08:00', end: '23:00' },
    activity: SOURCES_DEFAULTS.activity, historyDays: 7, now: () => AT, random: () => 0.5 });
  sources.register(JOBS_REGISTRATION);
  await sources.prepare();
  const jobs = new ShellJobs({ directory: join(directory, 'jobs'), timeZone: 'Asia/Tokyo', now: () => AT,
    place: { recordAttention: a => sources.recordAttention(a), notify: () => sources.notify(), takeIn: p => sources.takeIn(p) } });
  const path = await jobs.open({ command: 'make', processGroup: 3 });
  // Taken in: nothing to show.
  assert.equal(await sources.take(store.insertEvent('sources-updated')), false);
  await jobs.end(path, { kind: 'exited', exitCode: 0, output });
  const eventId = store.insertEvent('sources-updated');
  assert.equal(await sources.take(eventId), true);
  const line = JSON.stringify(sources.eventLine(eventId, 'received'));
  assert.match(line, /shell_finished/);
  assert.match(line, /"exit_code":0/);
  const files = (await run('git', ['--git-dir', gitDirectory, 'ls-tree', '-r', '--name-only', 'HEAD'])).stdout.trim().split('\n');
  const name = path.slice(JOBS_PATH.length + 1);
  assert.deepEqual(files, [`jobs/${name}/README.md`]);
});
