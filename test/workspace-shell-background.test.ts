import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SHELL_OUTPUT_CHARS, WorkspaceShell, type BackgroundJobs, type JobEnd } from '../src/server/workspace-shell.ts';

/**
 * natsumi's run_shell with a wait of her choosing (ADR 0094): a command still running when it is over goes to the
 * background, the connection to the runner is kept open, and its end, written by the runner as a second line, is put
 * under /sources/jobs. The number of commands waited for is bounded; past it a command is left as one nobody waits for.
 */

const finished = {
  exitCode: 0, signal: null, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
  stillRunning: false, responseLimitMs: 60000, waitedMs: 60000, running: 0, following: 0,
};
const running = { ...finished, exitCode: null, stillRunning: true, processGroup: 4242, running: 1, following: 1 };

interface Request { command: string; timeZone?: string; waitSeconds?: number; follow?: boolean }

/** A runner that answers each request with `first`, and keeps a still-running followed one open for the test. */
async function fakeRunner(first: (request: Request) => object) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-shell-bg-'));
  const path = join(root, 'runner.sock');
  const requests: Request[] = [];
  const held: { socket: Socket; closed: Promise<void> }[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer(socket => {
    sockets.add(socket);
    const closed = new Promise<void>(resolve => socket.on('close', () => { sockets.delete(socket); resolve(); }));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end)) as Request;
      buffer = '';
      requests.push(request);
      const reply = first(request) as { stillRunning?: boolean };
      if (request.follow && reply.stillRunning) {
        socket.write(`${JSON.stringify(reply)}\n`);
        held.push({ socket, closed });
      } else socket.end(`${JSON.stringify(reply)}\n`);
    });
    socket.on('error', () => {});
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  return {
    path, requests, held,
    second(index: number, line: object) { held[index]!.socket.end(`${JSON.stringify(line)}\n`); },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A stand-in for the jobs under /sources: records what is opened and how it ended. */
function fakeJobs(options: { failOpen?: boolean } = {}) {
  const opened: { command: string; processGroup: number }[] = [];
  const ends: { path: string; end: JobEnd }[] = [];
  const waiters: (() => void)[] = [];
  const jobs: BackgroundJobs = {
    async open(job) {
      if (options.failOpen) throw new Error('disk full');
      opened.push(job);
      return `/sources/jobs/20261106T000000Z-${String(opened.length).padStart(4, '0')}`;
    },
    async end(path, end) {
      ends.push({ path, end });
      for (const wake of waiters.splice(0)) wake();
    },
  };
  const nextEnd = async (count: number) => {
    while (ends.length < count) await new Promise<void>(resolve => waiters.push(resolve));
    return ends[count - 1]!;
  };
  return { jobs, opened, ends, nextEnd };
}

test('wait_seconds goes to the runner with the request to follow, and leaving it out waits the limit', async () => {
  const runner = await fakeRunner(() => finished);
  const { jobs } = fakeJobs();
  try {
    const shell = new WorkspaceShell({ socketPath: runner.path, jobs });
    await shell.runFollowed('ls', 5);
    await shell.runFollowed('ls', undefined);
    assert.deepEqual(runner.requests, [{ command: 'ls', waitSeconds: 5, follow: true }, { command: 'ls', follow: true }]);
  } finally { await runner.close(); }
});

test('the curator\'s commands are neither waited for by choice nor followed', async () => {
  const runner = await fakeRunner(() => ({ ...running, following: 0 }));
  const { jobs, opened } = fakeJobs();
  try {
    const outcome = await new WorkspaceShell({ socketPath: runner.path, jobs }).run('sleep 100');
    assert.deepEqual(runner.requests, [{ command: 'sleep 100' }]);
    assert.equal(opened.length, 0);
    assert.match(outcome.text, /まだ動いています/);
    assert.match(outcome.text, /kill -- -4242/);
    assert.doesNotMatch(outcome.text, /sources_updated/);
  } finally { await runner.close(); }
});

test('a wait out of its range is kept within it, the command still runs, and the result says so', async () => {
  const runner = await fakeRunner(request => ({ ...finished, waitedMs: Math.min(60, request.waitSeconds ?? 60) * 1000 }));
  const { jobs } = fakeJobs();
  try {
    const shell = new WorkspaceShell({ socketPath: runner.path, jobs });
    const negative = await shell.runFollowed('ls', -3);
    assert.equal(runner.requests[0]!.waitSeconds, 0);
    assert.equal(negative.ok, true);
    assert.match(negative.text, /wait_seconds.*-3.*0 秒に丸めました/);
    const long = await shell.runFollowed('ls', 600);
    assert.match(long.text, /wait_seconds.*600.*60 秒に丸めました/);
    const odd = await shell.runFollowed('ls', Number.NaN);
    assert.equal(runner.requests[2]!.waitSeconds, undefined);
    assert.match(odd.text, /60 秒に丸めました/);
    const fine = await shell.runFollowed('ls', 10);
    assert.doesNotMatch(fine.text, /丸めました/);
  } finally { await runner.close(); }
});

test('a command going to the background says where its end will be put, how to stop it, and that it need not be watched', async () => {
  const runner = await fakeRunner(() => ({ ...running, waitedMs: 0, stdout: '途中まで\n' }));
  const { jobs, opened, nextEnd } = fakeJobs();
  try {
    const outcome = await new WorkspaceShell({ socketPath: runner.path, jobs }).runFollowed('python3 /work/count.py', 0);
    assert.equal(outcome.ok, true);
    assert.deepEqual(opened, [{ command: 'python3 /work/count.py', processGroup: 4242 }]);
    assert.match(outcome.text, /途中まで/);
    assert.match(outcome.text, /\/sources\/jobs\/20261106T000000Z-0001/);
    assert.match(outcome.text, /sources_updated/);
    assert.match(outcome.text, /4242/);
    assert.match(outcome.text, /kill -- -4242/);
    assert.match(outcome.text, /ps や sleep/);
    assert.match(outcome.text, /ターンを終え/);
    assert.match(outcome.text, /ほかにすること/);
    assert.doesNotMatch(outcome.text, /wait_for_events/, 'the tool to wait with comes in the next change');
    assert.doesNotMatch(outcome.text, /読み捨て/);
    // Not counted among the ones she is told to look after with ps.
    assert.doesNotMatch(outcome.text, /まだ動いているコマンドが/);
    runner.second(0, { ...finished, exitCode: 3, stdout: '途中まで\n最後\n', stderr: 'warn\n', processGroup: 4242 });
    const { path, end } = await nextEnd(1);
    assert.equal(path, '/sources/jobs/20261106T000000Z-0001');
    assert.equal(end.kind, 'exited');
    assert.equal(end.kind === 'exited' && end.exitCode, 3);
    assert.deepEqual(end.kind === 'exited' && end.output, { stdout: '途中まで\n最後\n', stderr: 'warn\n' });
  } finally { await runner.close(); }
});

test('a followed command ended by a signal, one past the runner\'s longest wait, and one whose connection went, each end as such', async () => {
  const runner = await fakeRunner(() => running);
  const { jobs, nextEnd } = fakeJobs();
  try {
    const shell = new WorkspaceShell({ socketPath: runner.path, jobs, backgroundJobs: 5 });
    await shell.runFollowed('a', 0);
    await shell.runFollowed('b', 0);
    await shell.runFollowed('c', 0);
    runner.second(0, { ...finished, exitCode: null, signal: 'killed', stdout: 'x', stdoutTail: 'z', stdoutOmitted: 10 });
    const signaled = (await nextEnd(1)).end;
    assert.deepEqual(signaled, { kind: 'signaled', signal: 'killed',
      output: { stdout: 'x', stdoutTail: 'z', stdoutOmitted: 10, stderr: '' } });
    runner.second(1, { ...running });
    assert.equal((await nextEnd(2)).end.kind, 'gave-up');
    runner.held[2]!.socket.destroy();
    assert.deepEqual((await nextEnd(3)).end, { kind: 'lost' });
  } finally { await runner.close(); }
});

test('the server stops waiting at its own limit too, and lets go of the connection', async () => {
  const runner = await fakeRunner(() => running);
  const { jobs, nextEnd } = fakeJobs();
  try {
    await new WorkspaceShell({ socketPath: runner.path, jobs, followLimitMs: 50 }).runFollowed('tail -f /dev/null', 0);
    assert.equal((await nextEnd(1)).end.kind, 'gave-up');
    await runner.held[0]!.closed;
  } finally { await runner.close(); }
});

test('past the number of commands waited for, a command is left as one nobody waits for, and the result says so', async () => {
  const runner = await fakeRunner(() => running);
  const { jobs, opened, nextEnd } = fakeJobs();
  try {
    const shell = new WorkspaceShell({ socketPath: runner.path, jobs, backgroundJobs: 1 });
    await shell.runFollowed('first', 0);
    const over = await shell.runFollowed('second', 0);
    assert.equal(opened.length, 1);
    assert.equal(over.ok, true);
    assert.match(over.text, /上限/);
    assert.match(over.text, /1 個/);
    assert.match(over.text, /知らせません/);
    assert.match(over.text, /kill -- -4242/);
    assert.match(over.text, /ps/);
    // The runner is let go of, so it stops keeping the output.
    await runner.held[1]!.closed;
    // Once the first has ended, there is room again.
    runner.second(0, { ...finished, exitCode: 0 });
    await nextEnd(1);
    await shell.runFollowed('third', 0);
    assert.equal(opened.length, 2);
  } finally { await runner.close(); }
});

test('with no number allowed, nothing is followed', async () => {
  const runner = await fakeRunner(() => running);
  const { jobs, opened } = fakeJobs();
  try {
    const outcome = await new WorkspaceShell({ socketPath: runner.path, jobs, backgroundJobs: 0 }).runFollowed('x', 0);
    assert.equal(opened.length, 0);
    assert.match(outcome.text, /知らせません/);
  } finally { await runner.close(); }
});

test('a job whose directory cannot be made is let go, and the result says nobody will be told', async () => {
  const runner = await fakeRunner(() => running);
  const { jobs } = fakeJobs({ failOpen: true });
  try {
    const outcome = await new WorkspaceShell({ socketPath: runner.path, jobs }).runFollowed('x', 0);
    assert.match(outcome.text, /知らせません/);
    await runner.held[0]!.closed;
  } finally { await runner.close(); }
});

test('without a place for the jobs, nothing is asked to be followed', async () => {
  const runner = await fakeRunner(() => running);
  try {
    const outcome = await new WorkspaceShell({ socketPath: runner.path }).runFollowed('x', 0);
    assert.deepEqual(runner.requests, [{ command: 'x', waitSeconds: 0 }]);
    assert.match(outcome.text, /知らせません/);
  } finally { await runner.close(); }
});

test('only the commands nobody waits for are counted for ps', async () => {
  const runner = await fakeRunner(request => request.command === 'ls' ? { ...finished, running: 3, following: 2 } : { ...finished, running: 2, following: 2 });
  const { jobs } = fakeJobs();
  try {
    const shell = new WorkspaceShell({ socketPath: runner.path, jobs });
    const left = await shell.runFollowed('ls', undefined);
    assert.match(left.text, /まだ動いているコマンドが 1 個/);
    assert.doesNotMatch((await shell.runFollowed('pwd', undefined)).text, /まだ動いているコマンドが/);
  } finally { await runner.close(); }
});

test('a long output shows its head and its tail, and how much was left out between them', async () => {
  const head = 'あ'.repeat(SHELL_OUTPUT_CHARS);
  const runner = await fakeRunner(request => request.command === 'server-cut'
    ? { ...finished, stdout: `${'a'.repeat(SHELL_OUTPUT_CHARS)}${'z'.repeat(SHELL_OUTPUT_CHARS)}` }
    : { ...finished, stdout: head, stdoutTail: 'い'.repeat(100) + 'END', stdoutOmitted: 5000, stdoutTruncated: true });
  const { jobs } = fakeJobs();
  try {
    const shell = new WorkspaceShell({ socketPath: runner.path, jobs });
    const cut = await shell.runFollowed('server-cut', undefined);
    assert.match(cut.text, /^標準出力:\na{10}/m);
    assert.match(cut.text, /z{10}\n/);
    assert.match(cut.text, /8000 バイトを省きました/);
    assert.ok([...cut.text].length < SHELL_OUTPUT_CHARS * 1.5);
    assert.match(cut.text, /先頭と末尾/);
    const runnerCut = await shell.runFollowed('runner-cut', undefined);
    assert.match(runnerCut.text, /いEND/);
    // 4000 characters of the head dropped here (3 bytes each), the tail kept whole, and the runner's 5000 bytes.
    assert.match(runnerCut.text, /17000 バイトを省きました/);
    assert.match(runnerCut.text, /\/work/);
  } finally { await runner.close(); }
});
