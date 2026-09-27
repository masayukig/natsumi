import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findSnapshot, listSnapshots, pullSnapshot, type PullOptions } from '../src/eval/snapshot.ts';
import { BACKUP_STAMPS, makeFakeBackup, SESSION_FILE } from './support/fake-backup.ts';

const REPOSITORY = join(import.meta.dirname, '..');

interface Logged { args: string[]; stdin?: string }

async function withCluster(body: (context: { root: string; store: string; options: (extra?: Partial<PullOptions>) => PullOptions;
  commands: () => Promise<Logged[]> }) => Promise<void>, fail?: string) {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-pull-'));
  try {
    await makeFakeBackup(join(root, 'backup'));
    const kubectl = join(root, 'kubectl');
    await writeFile(kubectl, `#!/bin/sh\nexec "${process.execPath}" "${join(REPOSITORY, 'test', 'support', 'fake-kubectl.ts')}" "$@"\n`);
    await chmod(kubectl, 0o755);
    const log = join(root, 'kubectl.log');
    await writeFile(log, '');
    const env = { FAKE_KUBECTL_LOG: log, FAKE_KUBECTL_BACKUP: join(root, 'backup'), ...(fail ? { FAKE_KUBECTL_FAIL: fail } : {}) };
    const store = join(root, 'snapshots');
    let clock = Date.parse('2026-09-27T09:15:00Z');
    await body({
      root, store,
      options: extra => ({ kubectl, env, context: 'fixture-context', namespace: 'natsumi', cronjob: 'natsumi-backup', store, keep: 3,
        now: () => (clock += 1000), ...extra }),
      commands: async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Logged),
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** The verbs in order, with what they act on: the shape of what a pull does to the cluster. */
function verbs(commands: Logged[]): string[] {
  return commands.map(({ args }) => {
    const rest = args.slice(4);
    if (rest[0] === 'exec') return `exec ${rest.slice(rest.indexOf('--') + 1)[0]}`;
    return rest.slice(0, 2).join(' ');
  });
}

async function files(root: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await files(root, path)); else found.push(path);
  }
  return found.sort();
}

test('a pull runs the backup job, reads its result through a pod of its own and keeps only what the allow list names', async () => {
  await withCluster(async ({ store, options, commands }) => {
    const pulled = await pullSnapshot(options());
    assert.equal(pulled.name, '20260927T091501Z');
    assert.equal(pulled.sqlite, BACKUP_STAMPS.at(-1));

    const log = await commands();
    assert.deepEqual(verbs(log), ['get cronjob', `create job`, 'wait --for=condition=complete', 'apply -f', 'wait --for=condition=Ready',
      'exec ls', 'exec sh', 'delete pod', 'delete job']);
    // Every command names the context and the namespace; none of them touches natsumi's own pod.
    for (const { args } of log) {
      assert.deepEqual(args.slice(0, 4), ['--context', 'fixture-context', '-n', 'natsumi'], args.join(' '));
      assert.ok(!args.some(arg => arg.startsWith('natsumi-0')), args.join(' '));
    }
    assert.ok(log[1]!.args.includes('--from=cronjob/natsumi-backup'));
    // The reader is made from the CronJob: its NFS and image, read-only, as root that can only read.
    const pod = JSON.parse(log[3]!.stdin!) as { spec: Record<string, any> };
    assert.deepEqual(pod.spec.volumes, [{ name: 'backup', nfs: { server: 'nfs.example.invalid', path: '/natsumi', readOnly: true } }]);
    assert.equal(pod.spec.containers[0].image, 'registry.example/natsumi:v0.0.1');
    assert.equal(pod.spec.containers[0].volumeMounts[0].readOnly, true);
    assert.deepEqual(pod.spec.containers[0].securityContext.capabilities, { drop: ['ALL'], add: ['DAC_READ_SEARCH'] });
    assert.equal(pod.spec.automountServiceAccountToken, false);
    assert.ok(pod.spec.activeDeadlineSeconds > 0);
    assert.deepEqual(pod.spec.nodeSelector, { 'kubernetes.io/arch': 'amd64' });

    const directory = join(store, pulled.name);
    const taken = await files(directory);
    assert.ok(taken.includes('data/memory/.git/HEAD'), 'the history of the memory comes with it');
    assert.deepEqual(taken.filter(path => !path.startsWith('data/memory/.git/')), [
      'data/.natsumi/images/fixture.png', 'data/.natsumi/state.sqlite', 'data/memory/personality.md',
      'data/memory/plans/2026-09.md', 'data/sources/slack/fixture/2026-09-27.md', 'data/work/draft.md',
      `pi/sessions/2026-09-26T04-00-00-000Z_older.jsonl`, `pi/sessions/${SESSION_FILE}`, 'snapshot.json',
    ]);
    // Private: the store and the snapshot are the owner's alone.
    assert.equal((await stat(store)).mode & 0o777, 0o700);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);

    // The newest daily copy, with the push tokens and the login sessions gone and the conversation kept.
    const db = new DatabaseSync(join(directory, 'data', '.natsumi', 'state.sqlite'), { readOnly: true });
    try {
      assert.equal((db.prepare('SELECT count(*) AS n FROM push_registrations').get() as { n: number }).n, 0);
      assert.equal((db.prepare('SELECT count(*) AS n FROM client_sessions').get() as { n: number }).n, 0);
      assert.equal((db.prepare('SELECT text FROM conversation_messages').get() as { text: string }).text, `FIXTURE-SQLITE-${BACKUP_STAMPS.at(-1)}`);
    } finally { db.close(); }
    const bytes = await readFile(join(directory, 'data', '.natsumi', 'state.sqlite'));
    assert.ok(!bytes.includes('fixture-token-hash'), 'the deleted rows are vacuumed away');

    const manifest = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8'));
    assert.equal(manifest.source, 'job');
    assert.equal(manifest.sqlite, BACKUP_STAMPS.at(-1));
    assert.deepEqual((await findSnapshot(store, 'latest'))?.name, pulled.name);
  });
});

test('a pull of a daily backup runs no job and takes the copy of SQLite of that day', async () => {
  await withCluster(async ({ store, options, commands }) => {
    const pulled = await pullSnapshot(options({ backup: BACKUP_STAMPS[0] }));
    assert.equal(pulled.sqlite, BACKUP_STAMPS[0]);
    assert.deepEqual(verbs(await commands()), ['get cronjob', 'apply -f', 'wait --for=condition=Ready', 'exec ls', 'exec sh', 'delete pod']);
    const db = new DatabaseSync(join(store, pulled.name, 'data', '.natsumi', 'state.sqlite'), { readOnly: true });
    try { assert.equal((db.prepare('SELECT text FROM conversation_messages').get() as { text: string }).text, `FIXTURE-SQLITE-${BACKUP_STAMPS[0]}`); } finally { db.close(); }
    assert.equal(JSON.parse(await readFile(join(store, pulled.name, 'snapshot.json'), 'utf8')).source, 'daily');
  });
});

test('a daily backup that is not there stops the pull, and the reader pod is deleted all the same', async () => {
  await withCluster(async ({ store, options, commands }) => {
    await assert.rejects(pullSnapshot(options({ backup: '20200101T000000Z' })), /20200101T000000Z/);
    assert.deepEqual(verbs(await commands()).at(-1), 'delete pod');
    assert.deepEqual(await listSnapshots(store), []);
  });
});

test('a backup job that does not finish stops the pull before any pod is made, and leaves no snapshot', async () => {
  await withCluster(async ({ store, options, commands }) => {
    await assert.rejects(pullSnapshot(options()), /backup job/);
    assert.deepEqual(verbs(await commands()), ['get cronjob', 'create job', 'wait --for=condition=complete']);
    assert.deepEqual(await listSnapshots(store), []);
    assert.deepEqual((await readdir(store).catch(() => [])).filter(name => !name.startsWith('.')), []);
  }, 'wait');
});

test('only the newest three snapshots are kept', async () => {
  await withCluster(async ({ store, options }) => {
    await mkdir(store, { recursive: true, mode: 0o700 });
    for (const name of ['20260901T000000Z', '20260910T000000Z', '20260920T000000Z']) {
      await mkdir(join(store, name));
      await writeFile(join(store, name, 'snapshot.json'), JSON.stringify({ name, takenAt: '2026-09-01T00:00:00Z', source: 'daily', sqlite: 'x' }));
    }
    const pulled = await pullSnapshot(options());
    assert.deepEqual(pulled.removed, ['20260901T000000Z']);
    assert.deepEqual((await listSnapshots(store)).map(snapshot => snapshot.name), [pulled.name, '20260920T000000Z', '20260910T000000Z']);
    assert.equal((await findSnapshot(store, '20260910T000000Z'))?.name, '20260910T000000Z');
    assert.equal(await findSnapshot(store, '20260901T000000Z'), undefined);
  });
});
