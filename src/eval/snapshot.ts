import { spawn } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * A copy of natsumi's state in production, taken from what the backup job leaves on its NFS (ADR 0052), for a scene
 * to start from. Only what the allow list names is ever taken: her memory, her sources, /work, the images of her
 * replies, the Pi sessions and a consistent copy of SQLite. The login, the config, the home directory and anything
 * else the volume holds stay where they are.
 */

/** Where snapshots are kept by default: the owner's own, outside every checkout. */
export const DEFAULT_SNAPSHOT_STORE = join(homedir(), '.local', 'share', 'natsumi-eval', 'snapshots');
export const DEFAULT_KEEP = 3;
const MANIFEST = 'snapshot.json';
const NAME = /^\d{8}T\d{6}Z$/;
const SQLITE_COPY = /^state-(\d{8}T\d{6}Z)\.sqlite$/;

/** The allow list: a place in the backup (the mirror of the volume), and where it goes in the snapshot. */
export const ALLOWED: readonly { from: string; to: string }[] = [
  { from: 'mirror/data/memory', to: 'data/memory' },
  { from: 'mirror/data/sources', to: 'data/sources' },
  { from: 'mirror/data/sources.git', to: 'data/sources.git' },
  { from: 'mirror/data/work', to: 'data/work' },
  { from: 'mirror/data/.natsumi/images', to: 'data/.natsumi/images' },
  { from: 'mirror/pi/sessions', to: 'pi/sessions' },
];
/** Where the consistent copy of SQLite goes. */
export const STATE_DATABASE = 'data/.natsumi/state.sqlite';
/** Tables of SQLite that hold what signs in or reaches a device; they are emptied before a snapshot is kept. */
export const SECRET_TABLES = ['push_registrations', 'client_sessions'];

export interface SnapshotInfo {
  name: string;
  directory: string;
  takenAt: string;
  /** `job` when the backup job was run for it, `daily` when a daily backup was taken. */
  source: 'job' | 'daily';
  /** The stamp of the copy of SQLite it holds. */
  sqlite: string;
}

export interface PullOptions {
  kubectl: string;
  /** The kubectl context; kubectl's own choice when absent. */
  context?: string;
  namespace: string;
  cronjob: string;
  /** A daily backup's stamp, or `latest` for the newest; absent runs the backup job now. */
  backup?: string;
  store: string;
  keep: number;
  env?: Record<string, string>;
  now?: () => number;
  log?: (line: string) => void;
  /** How long the job and the reader pod may take to be ready. */
  waitMinutes?: number;
}

/**
 * Pulls a snapshot (ADR 0052): runs the backup job (or picks a daily backup), stands a pod of its own that reads the
 * backup's NFS read-only, streams the allowed places out of it with tar, empties the secret tables of the copy of
 * SQLite, and keeps it under the store, newest `keep` only. natsumi's own pod is never touched; the pod and the job
 * made for the pull are deleted.
 */
export async function pullSnapshot(options: PullOptions): Promise<SnapshotInfo & { removed: string[] }> {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const startedAt = now();
  const name = stamp(startedAt);
  const suffix = name.toLowerCase();
  const kubectl = (args: string[], input?: string) => kubectlRun(options, args, input);
  const wait = `--timeout=${options.waitMinutes ?? 30}m`;

  const cronjob = JSON.parse(await kubectl(['get', 'cronjob', options.cronjob, '-o', 'json'])) as CronJob;
  const reader = readerPod(cronjob, `natsumi-eval-pull-${suffix}`);

  let job: string | undefined;
  if (options.backup === undefined) {
    job = `natsumi-eval-backup-${suffix}`;
    log(`running the backup job ${job}`);
    await kubectl(['create', 'job', job, `--from=cronjob/${options.cronjob}`]);
    try { await kubectl(['wait', '--for=condition=complete', `job/${job}`, wait]); } catch (error) {
      // Left in place, so that its logs can be read.
      throw new Error(`the backup job ${job} did not complete (${(error as Error).message})`);
    }
  }

  await mkdir(options.store, { recursive: true, mode: 0o700 });
  await chmod(options.store, 0o700);
  const staging = join(options.store, `.incoming-${name}`);
  const pod = reader.metadata.name;
  try {
    log(`reading the backup through the pod ${pod}`);
    await kubectl(['apply', '-f', '-'], JSON.stringify(reader));
    await kubectl(['wait', '--for=condition=Ready', `pod/${pod}`, wait]);
    const copies = (await kubectl(['exec', pod, '--', 'ls', '-1', '/backup/sqlite'])).split('\n')
      .map(line => SQLITE_COPY.exec(line.trim())?.[1]).filter((value): value is string => value !== undefined).sort();
    const chosen = options.backup === undefined || options.backup === 'latest' ? copies.at(-1) : copies.find(copy => copy === options.backup);
    if (!chosen) throw new Error(options.backup && options.backup !== 'latest' ? `the backup has no copy of SQLite ${options.backup}` : 'the backup has no copy of SQLite');

    await rm(staging, { recursive: true, force: true });
    await mkdir(join(staging, 'incoming'), { recursive: true, mode: 0o700 });
    await chmod(staging, 0o700);
    await stream(options, ['exec', pod, '--', 'sh', '-c', tarScript([...ALLOWED.map(entry => entry.from), `sqlite/state-${chosen}.sqlite`])],
      join(staging, 'incoming'));

    // Only what the allow list names leaves the incoming directory; whatever else came is dropped with it.
    const snapshot = join(staging, 'snapshot');
    await mkdir(snapshot, { mode: 0o700 });
    for (const { from, to } of ALLOWED) await moveIfThere(join(staging, 'incoming', from), join(snapshot, to));
    await moveIfThere(join(staging, 'incoming', 'sqlite', `state-${chosen}.sqlite`), join(snapshot, STATE_DATABASE));
    await rm(join(staging, 'incoming'), { recursive: true, force: true });
    await scrubStateDatabase(join(snapshot, STATE_DATABASE));

    const info = { name, takenAt: new Date(startedAt).toISOString(), source: options.backup === undefined ? 'job' : 'daily', sqlite: chosen } as const;
    await writeFile(join(snapshot, MANIFEST), `${JSON.stringify({ ...info, namespace: options.namespace, cronjob: options.cronjob }, null, 2)}\n`,
      { mode: 0o600 });
    await chmod(snapshot, 0o700);
    await rename(snapshot, join(options.store, name));
    const removed = await prune(options.store, options.keep);
    log(`snapshot ${name}: SQLite ${chosen}${removed.length ? `, removed ${removed.join(', ')}` : ''}`);
    return { ...info, directory: join(options.store, name), removed };
  } finally {
    await rm(staging, { recursive: true, force: true });
    await kubectl(['delete', 'pod', pod, '--wait=false', '--ignore-not-found']).catch(() => log(`the pod ${pod} could not be deleted; delete it by hand`));
    if (job) await kubectl(['delete', 'job', job, '--ignore-not-found']).catch(() => log(`the job ${job} could not be deleted; delete it by hand`));
  }
}

/** The snapshots in the store, newest first. */
export async function listSnapshots(store: string): Promise<SnapshotInfo[]> {
  let names: string[];
  try { names = await readdir(store); } catch { return []; }
  const found: SnapshotInfo[] = [];
  for (const name of names.filter(entry => NAME.test(entry)).sort().reverse()) {
    try {
      const manifest = JSON.parse(await readFile(join(store, name, MANIFEST), 'utf8')) as Omit<SnapshotInfo, 'directory' | 'name'>;
      found.push({ name, directory: join(store, name), takenAt: manifest.takenAt, source: manifest.source, sqlite: manifest.sqlite });
    } catch { /* not a finished snapshot */ }
  }
  return found;
}

/** The newest snapshot for `latest`, or the one of that name. */
export async function findSnapshot(store: string, pick: string): Promise<SnapshotInfo | undefined> {
  const all = await listSnapshots(store);
  return pick === 'latest' ? all[0] : all.find(snapshot => snapshot.name === pick);
}

/** Empties the tables that hold what signs in or reaches a device, and vacuums their pages away. */
export async function scrubStateDatabase(file: string): Promise<void> {
  const db = new DatabaseSync(file);
  try {
    const tables = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(row => row.name));
    db.exec('PRAGMA foreign_keys = OFF');
    for (const table of SECRET_TABLES) if (tables.has(table)) db.exec(`DELETE FROM ${table}`);
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('VACUUM');
  } finally { db.close(); }
}

interface CronJob {
  spec?: { jobTemplate?: { spec?: { template?: { spec?: {
    nodeSelector?: Record<string, string>;
    initContainers?: { name: string; image: string }[];
    containers?: { name: string; image: string }[];
    volumes?: { name: string; nfs?: { server: string; path: string } }[];
  } } } } };
}

/**
 * The pod that reads the backup: the NFS of the CronJob, read-only, in natsumi's image (which has tar), as root that
 * may only read. It mounts no PVC, has no token and stops itself after an hour if it is left behind.
 */
function readerPod(cronjob: CronJob, name: string) {
  const spec = cronjob.spec?.jobTemplate?.spec?.template?.spec;
  const nfs = spec?.volumes?.find(volume => volume.nfs)?.nfs;
  if (!nfs) throw new Error('the backup CronJob has no NFS volume');
  const image = (spec?.initContainers ?? []).find(container => container.name === 'sqlite')?.image ?? spec?.initContainers?.[0]?.image;
  if (!image) throw new Error('the backup CronJob has no image of natsumi to read with');
  return {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name, labels: { 'app.kubernetes.io/name': 'natsumi-eval', 'app.kubernetes.io/component': 'pull' } },
    spec: {
      restartPolicy: 'Never', activeDeadlineSeconds: 3600, automountServiceAccountToken: false, enableServiceLinks: false,
      ...(spec?.nodeSelector ? { nodeSelector: spec.nodeSelector } : {}),
      containers: [{
        name: 'reader', image, command: ['sleep', 'infinity'],
        securityContext: { runAsUser: 0, runAsGroup: 0, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'], add: ['DAC_READ_SEARCH'] } },
        resources: { limits: { memory: '256Mi' } },
        volumeMounts: [{ name: 'backup', mountPath: '/backup', readOnly: true }],
      }],
      volumes: [{ name: 'backup', nfs: { server: nfs.server, path: nfs.path, readOnly: true } }],
    },
  };
}

/** A tar of the named places under /backup that exist, to stdout. */
function tarScript(paths: string[]): string {
  return ['set -eu', 'cd /backup', 'set --', `for p in ${paths.map(path => `'${path}'`).join(' ')}; do`,
    '  if [ -e "$p" ]; then set -- "$@" "$p"; fi', 'done', 'exec tar -cf - "$@"'].join('\n');
}

function kubectlArgs(options: PullOptions, args: string[]): string[] {
  return [...options.context ? ['--context', options.context] : [], '-n', options.namespace, ...args];
}

async function kubectlRun(options: PullOptions, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.kubectl, kubectlArgs(options, args), { env: { ...process.env, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { if (err.length < 4000) err += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(out)
      : reject(new Error(`kubectl ${args[0]} failed: ${err.trim().split('\n').at(-1) ?? `exit ${code}`}`)));
    child.stdin.end(input ?? '');
  });
}

/** kubectl's stdout, a tar, unpacked into `into` by the tar of this machine. */
async function stream(options: PullOptions, args: string[], into: string): Promise<void> {
  const source = spawn(options.kubectl, kubectlArgs(options, args), { env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const sink = spawn('tar', ['-x', '-f', '-', '-C', into, '--no-same-owner'], { stdio: ['pipe', 'ignore', 'pipe'] });
  source.stdout.pipe(sink.stdin);
  const ended = (child: typeof source | typeof sink, what: string) => new Promise<void>((resolve, reject) => {
    let err = '';
    child.stderr!.setEncoding('utf8').on('data', chunk => { if (err.length < 4000) err += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${what} failed: ${err.trim().split('\n').at(-1) ?? `exit ${code}`}`)));
  });
  await Promise.all([ended(source, 'reading the backup'), ended(sink, 'unpacking the backup')]);
}

async function moveIfThere(from: string, to: string): Promise<void> {
  try { await stat(from); } catch { return; }
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  await rename(from, to);
}

/** Keeps the newest `keep` snapshots and removes the rest, returning the names removed. */
async function prune(store: string, keep: number): Promise<string[]> {
  const all = await listSnapshots(store);
  const removed = all.slice(keep).map(snapshot => snapshot.name);
  for (const name of removed) await rm(join(store, name), { recursive: true, force: true });
  return removed.sort();
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
