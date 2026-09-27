import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { bwrapAvailable, goAvailable } from '../src/eval/workspace.ts';
import type { RunRecord } from '../src/eval/record.ts';
import { pullFakeSnapshot } from './support/fake-backup.ts';

const run = promisify(execFile);
const REPOSITORY = join(import.meta.dirname, '..');
const skip = !(await goAvailable()) ? 'go is not installed' : !(await bwrapAvailable()) ? 'bubblewrap cannot make a sandbox here' : false;

const SCENE = (port: number) => `
start: { snapshot: latest }
setup: probe
follow: true
actors:
  wiki-keeper: { replies: [FIXTURE-KEEPER] }
event: { mac_message: 続きをお願い }
dryRun:
  - calls:
      - { tool: run_shell, args: { command: "cat /work/probe.txt /memory/personality.md" } }
      - { tool: ask_agent, args: { agent: wiki-keeper, message: 調べて, continue: false } }
  - text: 待つ
  - text: 返事が来た
checks:
  - { id: isolated, output: "isolated ECONNREFUSED" }
  - { id: snapshot, output: FIXTURE-SNAPSHOT-PERSONALITY }
`;

// The setup runs in the evaluation's own process: it says whether that process is isolated, and whether it reaches a
// server listening on this machine's loopback.
const PROBE = (port: number) => `
import { connect } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function probe({ data }) {
  const reached = await new Promise(done => {
    const socket = connect({ host: '127.0.0.1', port: ${port} });
    socket.on('connect', () => { socket.destroy(); done('REACHED'); });
    socket.on('error', error => done(error.code));
  });
  await writeFile(join(data, 'work', 'probe.txt'), (process.env.NATSUMI_EVAL_ISOLATED ? 'isolated ' : 'open ') + reached + '\\n');
}
`;

async function withSetup(body: (context: { root: string; store: string; scenes: string; cli: (args: string[], env?: Record<string, string>) =>
  Promise<{ code: number; stdout: string; stderr: string }> }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-replay-cli-'));
  const listener = createServer(socket => socket.end('LISTENING'));
  await new Promise<void>(done => listener.listen(0, '127.0.0.1', () => done()));
  const port = (listener.address() as { port: number }).port;
  try {
    const { store } = await pullFakeSnapshot(root);
    const scenes = join(root, 'scenes');
    await mkdir(join(scenes, 'replay'), { recursive: true });
    await writeFile(join(scenes, 'replay', 'scene.yaml'), SCENE(port));
    await writeFile(join(scenes, 'replay', 'scene.ts'), PROBE(port));
    // This machine's own Slack or APNs settings, if any, would rightly stop the run; the tests start from none.
    const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/SLACK|APNS|A2A/i.test(name)));
    const cli = async (args: string[], env: Record<string, string> = {}) => {
      try {
        const { stdout, stderr } = await run(process.execPath, [join(REPOSITORY, 'src', 'eval', 'cli.ts'), ...args],
          { cwd: REPOSITORY, encoding: 'utf8', env: { ...clean, ...env } });
        return { code: 0, stdout, stderr };
      } catch (error) {
        const failed = error as { code: number; stdout: string; stderr: string };
        return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
      }
    };
    await body({ root, store, scenes, cli });
  } finally {
    listener.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('a run on a snapshot is isolated, reaches the runner and the actors, and keeps its results private', { skip }, async () => {
  await withSetup(async ({ root, store, scenes, cli }) => {
    const out = join(root, 'private-results');
    const result = await cli(['run', '--dry-run', '--scenes', scenes, '--snapshots', store, '--out', out, '--label', 'dry', '--runs', '1']);
    assert.equal(result.code, 0, result.stderr);
    const [record] = (await readFile(join(out, 'dry', 'runs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as RunRecord);
    assert.equal(record!.outcome, 'ok', record!.error);
    assert.deepEqual(record!.checks.map(check => [check.id, check.pass]), [['isolated', true], ['snapshot', true]],
      JSON.stringify(record!.tools.map(tool => tool.result)));
    assert.equal(record!.turns, 2);
    assert.equal(record!.actors![0]!.reply, 'FIXTURE-KEEPER');
    assert.equal((await stat(out)).mode & 0o777, 0o700);
  });
});

test('a run on a snapshot refuses to start with a token in the environment or in the snapshot, or with results in the repository', { skip }, async () => {
  await withSetup(async ({ root, store, scenes, cli }) => {
    const args = ['run', '--dry-run', '--scenes', scenes, '--snapshots', store, '--out', join(root, 'out'), '--runs', '1'];
    const named = await cli(args, { SLACK_APP_TOKEN: 'fixture-value-never-shown' });
    assert.equal(named.code, 1);
    assert.match(named.stderr, /SLACK_APP_TOKEN/);
    assert.ok(!named.stderr.includes('fixture-value-never-shown'));
    await assert.rejects(stat(join(root, 'out')));

    const inside = await cli(['run', '--dry-run', '--scenes', scenes, '--snapshots', store, '--out', join(REPOSITORY, 'eval', 'results'), '--runs', '1']);
    assert.equal(inside.code, 1);
    assert.match(inside.stderr, /outside the repository/);

    const [snapshot] = (await cli(['snapshots', '--snapshots', store])).stdout.trim().split('\n').map(line => line.split('\t'));
    await writeFile(join(snapshot![3]!, 'data', 'work', 'leak.txt'), `xoxb-${'1'.repeat(12)}-${'2'.repeat(12)}-fixturefixture`);
    const leaked = await cli(args);
    assert.equal(leaked.code, 1);
    assert.match(leaked.stderr, /data\/work\/leak\.txt/);
    assert.ok(!leaked.stderr.includes('xoxb-'));
  });
});
