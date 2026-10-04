// First, before Pi's undici replaces it: the proxy dispatcher of an isolated run (ADR 0052).
import { useProxyDispatcher } from './network.ts';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { routeReady } from '../pi/auth.ts';
import { isWithin } from '../server/paths.ts';
import { DEFAULT_ACTOR, PiActor, type ActorModel } from './actors.ts';
import { refuseOnSecrets, SECRET_PLACES } from './guard.ts';
import { endpointsOf, isolatedEnvironment, ISOLATED_ENV, RemoteRunner, runIsolated, serveRunner, startBridge, startRelay } from './isolation.ts';
import { DEFAULT_KEEP, DEFAULT_SNAPSHOT_STORE, findSnapshot, listSnapshots, pullSnapshot } from './snapshot.ts';
import { DEFAULT_JUDGE, PiJudge } from './judge.ts';
import { compareNightsMarkdown, curateSnapshot, NIGHT_FILES, nightMarkdown, type NightRecord } from './curate.ts';
import { modelRuntime, readModelFile, type ModelFile } from './model-file.ts';
import type { RunRecord } from './record.ts';
import { detectFeatures, runEvaluation } from './run.ts';
import { conditions, loadScenes, parseScript } from './scene.ts';
import { compare, compareMarkdown, summarize, summaryMarkdown, type Summary } from './summary.ts';
import { bwrapAvailable, WorkspaceRunner, type Sandbox, type WorkspaceStarter } from './workspace.ts';
import type { Judge } from './checks.ts';

/**
 * `npm run eval -- <command>` (ADR 0051):
 *
 *   run --model <file> [--judge <file> | --judge-auth <file> | --no-judge] [--scenes <dir>]… [--scene <name>]…
 *       [--variant <name>]… [--runs N] [--label L] [--out <dir>] [--concurrency N] [--max-calls N] [--minutes N]
 *       [--memo skip|model] [--workspace bwrap|host] [--dry-run]
 *   summarize <result directory>
 *   compare <result directory a> <result directory b>
 *   list [--scenes <dir>]…
 *   pull [--context C] [--namespace N] [--cronjob J] [--backup <stamp>|latest] [--snapshots <dir>] [--keep N] [--kubectl <path>]
 *   snapshots [--snapshots <dir>]
 *   curate --model <file> [--snapshot <name>|latest] [--snapshots <dir>] [--label L] [--out <dir>] [--max-calls N] [--minutes N]
 *       [--rotate-files N] [--at <ISO time>] [--time-zone <zone>] [--dry-run [--script <file>]]
 *   curate-compare <night directory a> <night directory b>
 *
 * A run with a scene that starts from a snapshot (ADR 0052) checks for secrets first, runs isolated from the network
 * but for the models' endpoints, and keeps its results in a private directory outside the repository.
 * `curate` runs the memory curator's night on a snapshot (ADR 0068), isolated in the same way.
 * Keys are read from the files the model files name and are never printed or recorded.
 */

const REPOSITORY = resolve(import.meta.dirname, '..', '..');
const SCENES = join(REPOSITORY, 'eval', 'scenes');
const RESULTS = join(REPOSITORY, 'eval', 'results');
/** The results of runs on a snapshot: private, outside the repository, kept 30 days (ADR 0052). */
const PRIVATE_RESULTS = join(homedir(), '.local', 'share', 'natsumi-eval', 'results');
const KEEP_RESULTS_DAYS = 30;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'run') return run(rest);
  if (command === 'summarize') return summarizeCommand(rest);
  if (command === 'compare') return compareCommand(rest);
  if (command === 'list') return list(rest);
  if (command === 'pull') return pull(rest);
  if (command === 'snapshots') return snapshots(rest);
  if (command === 'curate') return curate(rest);
  if (command === 'curate-compare') return curateCompare(rest);
  process.stderr.write('usage: npm run eval -- run|summarize|compare|list|pull|snapshots|curate|curate-compare …（eval/README.md）\n');
  return 2;
}

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: {
    model: { type: 'string' }, judge: { type: 'string' }, 'judge-auth': { type: 'string' }, 'no-judge': { type: 'boolean' },
    scenes: { type: 'string', multiple: true }, scene: { type: 'string', multiple: true }, variant: { type: 'string', multiple: true },
    runs: { type: 'string' }, label: { type: 'string' }, out: { type: 'string' }, concurrency: { type: 'string' },
    'max-calls': { type: 'string' }, minutes: { type: 'string' }, memo: { type: 'string' }, workspace: { type: 'string' },
    'dry-run': { type: 'boolean' }, actor: { type: 'string' }, 'actor-auth': { type: 'string' }, snapshots: { type: 'string' },
  } });
  const dryRun = values['dry-run'] === true;
  const isolated = process.env[ISOLATED_ENV] ? JSON.parse(process.env[ISOLATED_ENV]) as { relay: string; runner: string } : undefined;
  const sceneDirectories = (values.scenes ?? [SCENES]).map(dir => resolve(dir));
  const snapshotStore = resolve(values.snapshots ?? DEFAULT_SNAPSHOT_STORE);
  // The scenes of this run that start from a snapshot, and the snapshots they will use.
  const onSnapshots = (await loadScenes(sceneDirectories)).filter(scene => scene.start && (!values.scene || values.scene.includes(scene.name)));
  const usedSnapshots = (await Promise.all(onSnapshots.map(scene => findSnapshot(snapshotStore, scene.start!.snapshot))))
    .filter(snapshot => snapshot !== undefined);
  const needsActor = !dryRun && (await loadScenes(sceneDirectories)).some(scene => (!values.scene || values.scene.includes(scene.name))
    && scene.follow && Object.values(scene.actors).some(actor => actor.replies.length === 0));
  if (!values.model && !dryRun) throw new Error('--model <file> is required (or --dry-run)');
  const file = values.model ? await readModelFile(resolve(values.model)) : undefined;
  const judgeFile: ModelFile | undefined = dryRun || values['no-judge'] === true ? undefined : values.judge ? await readModelFile(resolve(values.judge)) : {
    target: DEFAULT_JUDGE, compatible: false, thinking: 'on', shown: { provider: DEFAULT_JUDGE.provider, id: DEFAULT_JUDGE.model },
    authPath: resolve(values['judge-auth'] ?? join(homedir(), '.pi', 'agent', 'auth.json')),
  };
  const actorFile: ModelFile | undefined = !needsActor ? undefined : values.actor ? await readModelFile(resolve(values.actor)) : {
    target: DEFAULT_ACTOR, compatible: false, thinking: 'on', shown: { provider: DEFAULT_ACTOR.provider, id: DEFAULT_ACTOR.model },
    authPath: resolve(values['actor-auth'] ?? join(homedir(), '.pi', 'agent', 'auth.json')),
  };
  // A scene whose snapshot is not there is skipped; only a run that will use a snapshot is guarded and isolated.
  const onSnapshot = usedSnapshots.length > 0;
  const out = resolve(values.out ?? (onSnapshot ? PRIVATE_RESULTS : RESULTS));

  if (onSnapshot && !isolated) {
    return isolatedAgain({ command: 'run', argv, out, outGiven: values.out !== undefined, snapshots: usedSnapshots.map(snapshot => snapshot.directory),
      models: [file, judgeFile, actorFile].filter((model): model is ModelFile => model !== undefined && !dryRun) });
  }
  let runner: WorkspaceStarter | undefined;
  if (isolated) {
    useProxyDispatcher();
    await startBridge(isolated.relay);
    runner = new RemoteRunner(isolated.runner);
  }
  const scratch = join(tmpdir(), `natsumi-eval-${process.pid}`);
  await mkdir(scratch, { recursive: true });
  if (file && !dryRun) {
    const runtime = await modelRuntime(file, scratch, process.env);
    if (!(await routeReady(runtime, file.target, file.compatible))) throw new Error('the model to evaluate is not ready (its key or login is missing)');
  }
  let judge: Judge | undefined;
  if (judgeFile) {
    const runtime = await modelRuntime(judgeFile, join(scratch, 'judge'), process.env);
    if (!(await routeReady(runtime, judgeFile.target, judgeFile.compatible))) {
      throw new Error(`the judge ${judgeFile.shown.provider}/${judgeFile.shown.id} is not ready: give --judge <file>, --judge-auth <login file>, or --no-judge`);
    }
    judge = new PiJudge({ file: judgeFile, runtime, root: join(scratch, 'judge') });
  }
  let actor: ActorModel | undefined;
  if (actorFile) {
    const runtime = await modelRuntime(actorFile, join(scratch, 'actor'), process.env);
    if (!(await routeReady(runtime, actorFile.target, actorFile.compatible))) {
      throw new Error(`the actors' model ${actorFile.shown.provider}/${actorFile.shown.id} is not ready: give --actor <file> or --actor-auth <login file>`);
    }
    actor = new PiActor({ file: actorFile, runtime, root: join(scratch, 'actor') });
  }
  const number = (value: string | undefined, name: string) => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
    return parsed;
  };
  const memo = values.memo;
  if (memo !== undefined && memo !== 'skip' && memo !== 'model') throw new Error('--memo must be skip or model');
  // Isolated, the runner is started outside, where bubblewrap was found to work; it is never tried from inside.
  const sandbox = values.workspace ?? (isolated ? 'bwrap' : undefined);
  if (sandbox !== undefined && sandbox !== 'bwrap' && sandbox !== 'host') throw new Error('--workspace must be bwrap or host');
  const label = values.label ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${file?.shown.id ?? 'dry-run'}`;
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error('--label is letters, digits, dots, hyphens and underscores');
  const limits = { ...(values['max-calls'] ? { modelCalls: number(values['max-calls'], 'max-calls')! } : {}),
    ...(values.minutes ? { minutes: number(values.minutes, 'minutes')! } : {}) };
  const runs = number(values.runs, 'runs');
  const concurrency = number(values.concurrency, 'concurrency');
  const result = await runEvaluation({
    scenes: sceneDirectories, out, label, dryRun, snapshots: snapshotStore,
    ...(runner ? { runner } : {}), ...(actor ? { actor } : {}),
    repository: REPOSITORY, log: line => process.stderr.write(`${line}\n`),
    ...(runs ? { runs } : {}), ...(concurrency ? { concurrency } : {}),
    ...(values.scene || values.variant ? { only: { ...(values.scene ? { scenes: values.scene } : {}), ...(values.variant ? { variants: values.variant } : {}) } } : {}),
    ...(file ? { model: { file, runtime: (root: string) => modelRuntime(file, root, process.env) } } : {}),
    ...(judge ? { judge } : {}), ...(sandbox ? { sandbox: sandbox as Sandbox } : {}), ...(memo ? { memo: memo as 'skip' | 'model' } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  });
  process.stdout.write(summaryMarkdown(result.summary, label));
  process.stderr.write(`results: ${result.directory}\n`);
  return 0;
}

async function pull(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: {
    context: { type: 'string' }, namespace: { type: 'string' }, cronjob: { type: 'string' }, backup: { type: 'string' },
    snapshots: { type: 'string' }, keep: { type: 'string' }, kubectl: { type: 'string' },
  } });
  const keep = values.keep === undefined ? DEFAULT_KEEP : Number(values.keep);
  if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep must be a positive integer');
  const store = resolve(values.snapshots ?? DEFAULT_SNAPSHOT_STORE);
  if (isWithin(store, REPOSITORY)) throw new Error('snapshots are kept outside the repository: give --snapshots elsewhere');
  const pulled = await pullSnapshot({ kubectl: values.kubectl ?? 'kubectl', ...(values.context ? { context: values.context } : {}),
    namespace: values.namespace ?? 'natsumi', cronjob: values.cronjob ?? 'natsumi-backup', ...(values.backup ? { backup: values.backup } : {}),
    store, keep, log: line => process.stderr.write(`${line}\n`) });
  process.stdout.write(`${pulled.name}\t${pulled.directory}\n`);
  return 0;
}

async function snapshots(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { snapshots: { type: 'string' } } });
  for (const snapshot of await listSnapshots(resolve(values.snapshots ?? DEFAULT_SNAPSHOT_STORE))) {
    process.stdout.write(`${snapshot.name}\t${snapshot.source}\tSQLite ${snapshot.sqlite}\t${snapshot.directory}\n`);
  }
  return 0;
}

/** The curator's night on a snapshot (ADR 0068): checked and isolated outside, run inside, its results kept private. */
async function curate(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: {
    model: { type: 'string' }, snapshot: { type: 'string' }, snapshots: { type: 'string' }, label: { type: 'string' }, out: { type: 'string' },
    'max-calls': { type: 'string' }, minutes: { type: 'string' }, 'rotate-files': { type: 'string' }, at: { type: 'string' },
    'time-zone': { type: 'string' }, workspace: { type: 'string' }, 'dry-run': { type: 'boolean' }, script: { type: 'string' },
  } });
  const dryRun = values['dry-run'] === true;
  const isolated = process.env[ISOLATED_ENV] ? JSON.parse(process.env[ISOLATED_ENV]) as { relay: string; runner: string } : undefined;
  if (!values.model && !dryRun) throw new Error('--model <file> is required (or --dry-run)');
  if (values.script && !dryRun) throw new Error('--script is for a dry run');
  const file = values.model ? await readModelFile(resolve(values.model)) : undefined;
  const wanted = values.snapshot ?? 'latest';
  const snapshot = await findSnapshot(resolve(values.snapshots ?? DEFAULT_SNAPSHOT_STORE), wanted);
  if (!snapshot) throw new Error(`no snapshot ${wanted}: take one with \`npm run eval -- pull\``);
  const number = (value: string | undefined, name: string) => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
    return parsed;
  };
  const curator = { ...(values['max-calls'] ? { modelCalls: number(values['max-calls'], 'max-calls')! } : {}),
    ...(values.minutes ? { timeoutMinutes: number(values.minutes, 'minutes')! } : {}),
    ...(values['rotate-files'] ? { rotateFiles: number(values['rotate-files'], 'rotate-files')! } : {}) };
  const at = values.at === undefined ? undefined : Date.parse(values.at);
  if (at !== undefined && Number.isNaN(at)) throw new Error('--at must be a time such as 2026-10-01T23:00:00+09:00');
  const script = dryRun ? values.script ? parseScript(parseYaml(await readFile(resolve(values.script), 'utf8')), 'script')
    : [{ text: '変えることはありません' }] : undefined;
  const label = values.label ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-curator-${file?.shown.id ?? 'dry-run'}`;
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error('--label is letters, digits, dots, hyphens and underscores');
  const out = resolve(values.out ?? PRIVATE_RESULTS);

  if (!isolated) {
    // The zone is the one out here: inside, the sandbox may not see it.
    const zone = values['time-zone'] ? [] : ['--time-zone', Intl.DateTimeFormat().resolvedOptions().timeZone];
    return isolatedAgain({ command: 'curate', argv: [...argv, ...zone], out, outGiven: values.out !== undefined, snapshots: [snapshot.directory],
      models: file && !dryRun ? [file] : [] });
  }
  useProxyDispatcher();
  await startBridge(isolated.relay);
  const runner = new RemoteRunner(isolated.runner);
  const scratch = join(tmpdir(), `natsumi-eval-${process.pid}`);
  await mkdir(scratch, { recursive: true });
  if (file && !dryRun) {
    const runtime = await modelRuntime(file, scratch, process.env);
    if (!(await routeReady(runtime, file.target, file.compatible))) throw new Error('the model to evaluate is not ready (its key or login is missing)');
  }
  // Isolated, the runner is started outside, where bubblewrap was found to work; it is never tried from inside.
  const sandbox = values.workspace ?? 'bwrap';
  if (sandbox !== 'bwrap' && sandbox !== 'host') throw new Error('--workspace must be bwrap or host');
  const { record, directory } = await curateSnapshot({ snapshot, out, label, repository: REPOSITORY, runner, sandbox: sandbox as Sandbox,
    ...(file ? { model: { file, runtime: (root: string) => modelRuntime(file, root, process.env) } } : {}),
    ...(script ? { dryRun: script } : {}), curator, ...(at === undefined ? {} : { at }),
    ...(values['time-zone'] ? { timeZone: values['time-zone'] } : {}),
    log: line => process.stderr.write(`${line}\n`) });
  process.stdout.write(nightMarkdown(record));
  process.stderr.write(`results: ${directory}\n`);
  return record.error ? 1 : 0;
}

async function curateCompare(argv: string[]): Promise<number> {
  const [a, b] = argv;
  if (!a || !b) throw new Error('usage: curate-compare <night directory a> <night directory b>');
  const read = async (directory: string) => JSON.parse(await readFile(join(resolve(directory), NIGHT_FILES.record), 'utf8')) as NightRecord;
  process.stdout.write(compareNightsMarkdown(await read(a), await read(b)));
  return 0;
}

/**
 * Outside the sandbox, for a command on a snapshot (ADR 0052): the results kept private and outside the repository, the
 * checks for secrets, then the same command again inside bubblewrap, with the relay to the models' endpoints its one
 * way out and the workspace runner started out here.
 */
async function isolatedAgain(options: { command: string; argv: string[]; out: string; outGiven: boolean; snapshots: string[];
  models: ModelFile[] }): Promise<number> {
  const { out, models } = options;
  if (isWithin(out, REPOSITORY)) throw new Error('the results of a run on a snapshot are kept outside the repository: give --out elsewhere');
  await refuseOnSecrets({ env: process.env, files: SECRET_PLACES, snapshots: options.snapshots });
  if (!(await bwrapAvailable())) throw new Error('a run on a snapshot is isolated with bubblewrap, which cannot make a sandbox here');
  await mkdir(out, { recursive: true, mode: 0o700 });
  await chmod(out, 0o700);
  await pruneResults(out, KEEP_RESULTS_DAYS);
  const scratch = await mkdtemp(join(tmpdir(), 'natsumi-eval-'));
  try {
    const relaySocket = join(scratch, 'relay.sock');
    const runnerSocket = join(scratch, 'runner.sock');
    const relay = await startRelay({ socketPath: relaySocket, allow: endpointsOf(models) });
    const runner = await WorkspaceRunner.prepare({ repository: REPOSITORY, cache: join(scratch, 'runner') });
    const service = await serveRunner({ socketPath: runnerSocket, runner, roots: [out, scratch] });
    const logins = models.flatMap(model => model.authPath ? [dirname(model.authPath)] : []);
    const keys = Object.fromEntries(models.flatMap(model => model.endpoint && 'env' in model.endpoint.apiKey
      ? [[model.endpoint.apiKey.env, process.env[model.endpoint.apiKey.env]]] : []));
    try {
      return await runIsolated({ command: [process.execPath, ...process.execArgv, join(REPOSITORY, 'src', 'eval', 'cli.ts'), options.command,
        ...options.argv, ...(options.outGiven ? [] : ['--out', out])],
      writable: [out, scratch, ...new Set(logins)], cwd: process.cwd(),
      env: isolatedEnvironment({ relaySocket, runnerSocket, tmp: scratch,
        // A CA the owner trusts for their own endpoint goes in with the keys.
        pass: { ...keys, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS, SSL_CERT_FILE: process.env.SSL_CERT_FILE } }) });
    } finally {
      await service.close();
      await relay.close();
      if (relay.refused.length > 0) process.stderr.write(`the relay turned back: ${[...new Set(relay.refused)].join(', ')}\n`);
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** Removes the results older than `days`, by when they were last written. */
async function pruneResults(root: string, days: number): Promise<void> {
  const limit = Date.now() - days * 86_400_000;
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const path = join(root, name);
    try { if ((await stat(path)).mtimeMs < limit) await rm(path, { recursive: true, force: true }); } catch { /* gone already */ }
  }
}

async function readResult(directory: string): Promise<Summary> {
  const text = await readFile(join(resolve(directory), 'runs.jsonl'), 'utf8').catch(() => '');
  const records = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as RunRecord);
  const saved = await readFile(join(resolve(directory), 'summary.json'), 'utf8').then(json => JSON.parse(json) as Summary, () => undefined);
  return summarize(records, saved?.skipped ?? []);
}

async function summarizeCommand(argv: string[]): Promise<number> {
  const [directory] = argv;
  if (!directory) throw new Error('usage: summarize <result directory>');
  process.stdout.write(summaryMarkdown(await readResult(directory), directory));
  return 0;
}

async function compareCommand(argv: string[]): Promise<number> {
  const [a, b] = argv;
  if (!a || !b) throw new Error('usage: compare <result directory a> <result directory b>');
  process.stdout.write(compareMarkdown(compare(await readResult(a), await readResult(b)), a, b));
  return 0;
}

async function list(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { scenes: { type: 'string', multiple: true }, snapshots: { type: 'string' } } });
  const features = detectFeatures();
  for (const scene of await loadScenes((values.scenes ?? [SCENES]).map(dir => resolve(dir)))) {
    const missing = scene.requires.filter(feature => !features.has(feature));
    const notes = [...missing.length > 0 ? [`飛ばす: requires ${missing.join(', ')}`] : [],
      ...scene.start ? [`写しから: ${scene.start.snapshot}${(await findSnapshot(resolve(values.snapshots ?? DEFAULT_SNAPSHOT_STORE), scene.start.snapshot)) ? '' : '（無いので飛ばす）'}`] : []];
    process.stdout.write(`${scene.name}${notes.length > 0 ? `（${notes.join('、')}）` : ''} — ${scene.description}\n`);
    for (const condition of conditions(scene)) process.stdout.write(`  ${condition.variant}: ${condition.checks.map(check => check.id).join(', ')}\n`);
  }
  return 0;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (error: unknown) => {
  // A config error names the setting and never its value; anything else is ours.
  process.stderr.write(`eval: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
