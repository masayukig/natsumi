import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { compareNightsMarkdown, curateSnapshot, nightMarkdown, type NightRecord } from '../src/eval/curate.ts';
import { findSnapshot } from '../src/eval/snapshot.ts';
import { bwrapAvailable, goAvailable, WorkspaceRunner } from '../src/eval/workspace.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { pullFakeSnapshot } from './support/fake-backup.ts';

const exec = promisify(execFile);
const REPOSITORY = join(import.meta.dirname, '..');
const skip = !(await goAvailable()) ? 'go is not installed' : !(await bwrapAvailable()) ? 'bubblewrap cannot make a sandbox here' : false;

/** The curator gives the plans a heading and says so, as a model would through its tools. */
const TIDY = [
  { calls: [{ tool: 'run_shell', args: { command: "printf '# 予定\\n\\n## 2026-09\\n- 9/28（日）10:00 架空の打ち合わせ\\n' > /memory/plans/2026-09.md" } }] },
  { calls: [{ tool: 'write_change_note', args: { text: 'FIXTURE-NOTE 予定に見出しを付けた' } }] },
  { text: '終わりました' },
];

async function withSnapshot(body: (context: { root: string; store: string; snapshot: { name: string; directory: string; takenAt: string };
  runner: WorkspaceRunner }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-curate-'));
  try {
    const { store } = await pullFakeSnapshot(root);
    const snapshot = (await findSnapshot(store, 'latest'))!;
    const runner = await WorkspaceRunner.prepare({ repository: REPOSITORY, cache: join(root, 'cache') });
    await body({ root, store, snapshot, runner });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function git(directory: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', directory, '-c', `safe.directory=${directory}`, ...args], { encoding: 'utf8' })).stdout;
}

async function fingerprint(snapshot: string): Promise<string[]> {
  const digest = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
  const memory = join(snapshot, 'data', 'memory');
  return [await digest(join(snapshot, 'data', '.natsumi', 'state.sqlite')), await digest(join(memory, 'plans', '2026-09.md')),
    await git(memory, 'rev-parse', 'HEAD'), await git(memory, 'status', '--porcelain')];
}

test('a curator\'s night runs on a working copy of a snapshot and leaves its memory, its commits and its numbers to read', { skip }, async () => {
  await withSnapshot(async ({ root, snapshot, runner }) => {
    const before = await fingerprint(snapshot.directory);
    const { record, directory } = await curateSnapshot({ snapshot, out: join(root, 'results'), label: 'tidy', repository: REPOSITORY,
      runner, dryRun: TIDY });

    assert.equal(record.error, undefined);
    assert.equal(record.snapshot, snapshot.name);
    assert.equal(record.dryRun, true);
    // Every stage of the night, in order, with the server's own numbers: the structure stage did the work, and the
    // index stage, answered with nothing, kept nothing.
    assert.deepEqual(record.stages.map(stage => [stage.name, stage.outcome]), [['structure', 'ok'], ['index', 'ok']]);
    const [stage] = record.stages;
    assert.equal(stage!.modelCalls, 3);
    assert.ok(stage!.ms >= 0);
    assert.equal(stage!.note, 'FIXTURE-NOTE 予定に見出しを付けた');
    assert.equal(stage!.commit, record.head);
    assert.equal(record.stages[1]!.commit, undefined);
    // What it committed, under the note it wrote, and what that changed.
    assert.equal(record.commits.length, 1);
    assert.match(record.commits[0]!.message, /FIXTURE-NOTE 予定に見出しを付けた/);
    assert.deepEqual(record.files, [{ path: 'plans/2026-09.md', change: 'M' }]);
    assert.notEqual(record.head, record.base);
    assert.deepEqual(record.uncommitted, []);

    // The memory after the night is a repository the owner can read, beside the diff from the snapshot's memory.
    const memory = join(directory, 'copy', 'data', 'memory');
    assert.match(await readFile(join(memory, 'plans', '2026-09.md'), 'utf8'), /^# 予定\n\n## 2026-09\n/);
    assert.equal((await git(memory, 'rev-parse', 'HEAD')).trim(), record.head);
    const diff = await readFile(join(directory, 'memory.diff'), 'utf8');
    assert.match(diff, /\+## 2026-09/);
    const saved = JSON.parse(await readFile(join(directory, 'night.json'), 'utf8')) as NightRecord;
    assert.deepEqual(saved.stages, record.stages);
    const summary = await readFile(join(directory, 'summary.md'), 'utf8');
    assert.match(summary, /FIXTURE-NOTE/);
    assert.match(summary, /plans\/2026-09\.md/);
    assert.match(summary, /\| structure \| ok \| 3 \|/);
    // The curator's own session records, one for each stage, are kept for reading.
    assert.equal((await readdir(join(directory, 'copy', 'pi', 'sessions', 'curator'))).filter(name => name.endsWith('.jsonl')).length, 2);
    // The copy of SQLite was migrated and knows the night; the snapshot did not change at all.
    const copy = new DatabaseSync(join(directory, 'copy', 'data', '.natsumi', 'state.sqlite'), { readOnly: true });
    try {
      assert.equal((copy.prepare('SELECT max(version) AS v FROM schema_migrations').get() as { v: number }).v, MIGRATIONS.at(-1)!.version);
      assert.equal((copy.prepare('SELECT base_commit FROM memory_curator WHERE owner = 1').get() as { base_commit: string }).base_commit, record.head);
    } finally { copy.close(); }
    assert.deepEqual(await fingerprint(snapshot.directory), before);
  });
});

test('a night whose change fails the server\'s check keeps nothing, and says so', { skip }, async () => {
  await withSnapshot(async ({ root, snapshot, runner }) => {
    const { record } = await curateSnapshot({ snapshot, out: join(root, 'results'), label: 'refused', repository: REPOSITORY, runner,
      dryRun: [{ calls: [{ tool: 'run_shell', args: { command: 'echo changed > /memory/personality.md' } }] }, { text: '終わり' }] });
    assert.equal(record.stages[0]!.outcome, 'rejected');
    assert.deepEqual(record.stages[0]!.rejected!.map(file => file.path), ['personality.md']);
    assert.equal(record.stages[0]!.commit, undefined);
    assert.deepEqual(record.commits, []);
    assert.deepEqual(record.files, []);
    assert.equal(record.head, record.base);
  });
});

test('what the snapshot\'s memory had not committed is committed first, apart from the night, and named', { skip }, async () => {
  await withSnapshot(async ({ root, snapshot, runner }) => {
    await writeFile(join(snapshot.directory, 'data', 'memory', 'loose.md'), '# 書きかけ\n');
    const { record, directory } = await curateSnapshot({ snapshot, out: join(root, 'results'), label: 'loose', repository: REPOSITORY, runner,
      dryRun: [{ text: '変えることはありません' }] });
    assert.equal(record.stages[0]!.outcome, 'ok');
    assert.deepEqual(record.uncommitted, ['loose.md']);
    // The base is after that commit: the night's own commits and diff hold none of it.
    assert.deepEqual(record.commits, []);
    assert.equal(await readFile(join(directory, 'memory.diff'), 'utf8'), '');
    const memory = join(directory, 'copy', 'data', 'memory');
    assert.match(await git(memory, 'log', '--format=%s', record.base), /^eval: /m);
    assert.match(await readFile(join(directory, 'summary.md'), 'utf8'), /loose\.md/);
  });
});

const NIGHT: NightRecord = {
  label: 'qwen', snapshot: '20261001T124102Z', model: { provider: 'natsumi-compatible', id: 'fixture-model' }, dryRun: false,
  at: '2026-10-01T12:41:02.000Z', startedAt: '2026-10-04T00:00:00.000Z', ms: 125_000, base: 'a'.repeat(40), head: 'b'.repeat(40),
  uncommitted: [],
  stages: [{ name: 'structure', outcome: 'ok', modelCalls: 12, ms: 120_000, tokens: { input: 1000, cacheRead: 500, output: 200 }, toolErrors: 1,
    commit: 'b'.repeat(40), note: '節を組み直した' },
  { name: 'index', outcome: 'rejected', modelCalls: 3, ms: 5_000, tokens: { input: 10, cacheRead: 0, output: 5 }, toolErrors: 0,
    rejected: [{ path: 'INDEX.md', reason: 'FIXTURE-REASON' }] }],
  commits: [{ hash: 'b'.repeat(40), message: '節を組み直した\n\n- 本人.md の「いま」を話題ごとに分けた' }],
  files: [{ path: '本人.md', change: 'M' }, { path: 'old.md', change: 'D' }],
};

test('the summary of a night names each stage\'s outcome, calls and time, the commits and the files', () => {
  const text = nightMarkdown(NIGHT);
  assert.match(text, /qwen/);
  assert.match(text, /fixture-model/);
  assert.match(text, /\| structure \| ok \| 12 \| 120\.0 s \|/);
  // Each stage's commit and note, and what failed the check of one that kept nothing.
  assert.match(text, /\| index \| rejected \| 3 \|/);
  assert.match(text, /INDEX\.md: FIXTURE-REASON/);
  assert.match(text, /節を組み直した/);
  assert.match(text, /本人\.md/);
  assert.match(text, /old\.md/);
  assert.ok(!text.includes('undefined'));
});

test('two nights on one snapshot are put side by side', () => {
  const other: NightRecord = { ...NIGHT, label: 'plus', model: { provider: 'openai-codex', id: 'fixture-plus' },
    stages: [{ ...NIGHT.stages[0]!, outcome: 'timeout', modelCalls: 40 }], commits: [], files: [] };
  const text = compareNightsMarkdown(NIGHT, other);
  assert.match(text, /qwen/);
  assert.match(text, /plus/);
  assert.match(text, /\| structure \| ok \/ 12 \/ 120\.0 s \| timeout \/ 40 \/ 120\.0 s \|/);
  assert.match(text, /\| index \| rejected \/ 3 \/ 5\.0 s \| — \|/);
  // Comparing nights on different snapshots is allowed but said.
  assert.match(compareNightsMarkdown(NIGHT, { ...other, snapshot: '20261002T000000Z' }), /写しが違います/);
});

async function cli(args: string[], env: Record<string, string> = {}) {
  // This machine's own Slack or APNs settings, if any, would rightly stop the run; the tests start from none.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/SLACK|APNS|A2A/i.test(name)));
  try {
    const { stdout, stderr } = await exec(process.execPath, [join(REPOSITORY, 'src', 'eval', 'cli.ts'), ...args],
      { cwd: REPOSITORY, encoding: 'utf8', env: { ...clean, ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

test('`curate` runs a night isolated, keeps it private, and refuses with a token around or without a model', { skip }, async () => {
  await withSnapshot(async ({ root, store }) => {
    const script = join(root, 'script.yaml');
    await writeFile(script, `- calls:\n    - { tool: run_shell, args: { command: "cat /memory/personality.md" } }\n- text: 変えることはありません\n`);
    const out = join(root, 'private');
    const ran = await cli(['curate', '--dry-run', '--script', script, '--snapshots', store, '--out', out, '--label', 'dry']);
    assert.equal(ran.code, 0, ran.stderr);
    const record = JSON.parse(await readFile(join(out, 'dry', 'night.json'), 'utf8')) as NightRecord;
    assert.equal(record.error, undefined);
    assert.equal(record.stages[0]!.outcome, 'ok');
    assert.equal(record.stages[0]!.modelCalls, 2);
    assert.match(ran.stdout, /\| structure \| ok \|/);
    assert.equal((await stat(out)).mode & 0o777, 0o700);

    const compared = await cli(['curate-compare', join(out, 'dry'), join(out, 'dry')]);
    assert.equal(compared.code, 0, compared.stderr);
    assert.match(compared.stdout, /\| structure \| ok \/ 2 \//);

    const named = await cli(['curate', '--dry-run', '--snapshots', store, '--out', join(root, 'never')], { SLACK_BOT_TOKEN: 'fixture-value-never-shown' });
    assert.equal(named.code, 1);
    assert.match(named.stderr, /SLACK_BOT_TOKEN/);
    assert.ok(!named.stderr.includes('fixture-value-never-shown'));
    await assert.rejects(stat(join(root, 'never')));

    const inside = await cli(['curate', '--dry-run', '--snapshots', store, '--out', join(REPOSITORY, 'eval', 'results')]);
    assert.equal(inside.code, 1);
    assert.match(inside.stderr, /outside the repository/);

    const modelless = await cli(['curate', '--snapshots', store, '--out', join(root, 'never')]);
    assert.equal(modelless.code, 1);
    assert.match(modelless.stderr, /--model/);

    const missing = await cli(['curate', '--dry-run', '--snapshot', '20990101T000000Z', '--snapshots', store, '--out', join(root, 'never')]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /20990101T000000Z/);
  });
});
