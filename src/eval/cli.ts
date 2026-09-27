import { mkdir, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { routeReady } from '../pi/auth.ts';
import { DEFAULT_JUDGE, PiJudge } from './judge.ts';
import { modelRuntime, readModelFile, type ModelFile } from './model-file.ts';
import type { RunRecord } from './record.ts';
import { detectFeatures, runEvaluation } from './run.ts';
import { conditions, loadScenes } from './scene.ts';
import { compare, compareMarkdown, summarize, summaryMarkdown, type Summary } from './summary.ts';
import type { Sandbox } from './workspace.ts';
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
 *
 * Keys are read from the files the model files name and are never printed or recorded.
 */

const REPOSITORY = resolve(import.meta.dirname, '..', '..');
const SCENES = join(REPOSITORY, 'eval', 'scenes');
const RESULTS = join(REPOSITORY, 'eval', 'results');

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'run') return run(rest);
  if (command === 'summarize') return summarizeCommand(rest);
  if (command === 'compare') return compareCommand(rest);
  if (command === 'list') return list(rest);
  process.stderr.write('usage: npm run eval -- run|summarize|compare|list …（README の「1 ターンの評価」）\n');
  return 2;
}

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: {
    model: { type: 'string' }, judge: { type: 'string' }, 'judge-auth': { type: 'string' }, 'no-judge': { type: 'boolean' },
    scenes: { type: 'string', multiple: true }, scene: { type: 'string', multiple: true }, variant: { type: 'string', multiple: true },
    runs: { type: 'string' }, label: { type: 'string' }, out: { type: 'string' }, concurrency: { type: 'string' },
    'max-calls': { type: 'string' }, minutes: { type: 'string' }, memo: { type: 'string' }, workspace: { type: 'string' },
    'dry-run': { type: 'boolean' },
  } });
  const dryRun = values['dry-run'] === true;
  if (!values.model && !dryRun) throw new Error('--model <file> is required (or --dry-run)');
  const file = values.model ? await readModelFile(resolve(values.model)) : undefined;
  const scratch = join(tmpdir(), `natsumi-eval-${process.pid}`);
  await mkdir(scratch, { recursive: true });
  if (file && !dryRun) {
    const runtime = await modelRuntime(file, scratch, process.env);
    if (!(await routeReady(runtime, file.target, file.compatible))) throw new Error('the model to evaluate is not ready (its key or login is missing)');
  }
  let judge: Judge | undefined;
  if (!dryRun && values['no-judge'] !== true) {
    const judgeFile: ModelFile = values.judge ? await readModelFile(resolve(values.judge)) : {
      target: DEFAULT_JUDGE, compatible: false, thinking: 'on', shown: { provider: DEFAULT_JUDGE.provider, id: DEFAULT_JUDGE.model },
      authPath: resolve(values['judge-auth'] ?? join(homedir(), '.pi', 'agent', 'auth.json')),
    };
    const runtime = await modelRuntime(judgeFile, join(scratch, 'judge'), process.env);
    if (!(await routeReady(runtime, judgeFile.target, judgeFile.compatible))) {
      throw new Error(`the judge ${judgeFile.shown.provider}/${judgeFile.shown.id} is not ready: give --judge <file>, --judge-auth <login file>, or --no-judge`);
    }
    judge = new PiJudge({ file: judgeFile, runtime, root: join(scratch, 'judge') });
  }
  const number = (value: string | undefined, name: string) => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
    return parsed;
  };
  const memo = values.memo;
  if (memo !== undefined && memo !== 'skip' && memo !== 'model') throw new Error('--memo must be skip or model');
  const sandbox = values.workspace;
  if (sandbox !== undefined && sandbox !== 'bwrap' && sandbox !== 'host') throw new Error('--workspace must be bwrap or host');
  const label = values.label ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${file?.shown.id ?? 'dry-run'}`;
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error('--label is letters, digits, dots, hyphens and underscores');
  const limits = { ...(values['max-calls'] ? { modelCalls: number(values['max-calls'], 'max-calls')! } : {}),
    ...(values.minutes ? { minutes: number(values.minutes, 'minutes')! } : {}) };
  const runs = number(values.runs, 'runs');
  const concurrency = number(values.concurrency, 'concurrency');
  const result = await runEvaluation({
    scenes: (values.scenes ?? [SCENES]).map(dir => resolve(dir)), out: resolve(values.out ?? RESULTS), label, dryRun,
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
  const { values } = parseArgs({ args: argv, options: { scenes: { type: 'string', multiple: true } } });
  const features = detectFeatures();
  for (const scene of await loadScenes((values.scenes ?? [SCENES]).map(dir => resolve(dir)))) {
    const missing = scene.requires.filter(feature => !features.has(feature));
    process.stdout.write(`${scene.name}${missing.length > 0 ? `（飛ばす: requires ${missing.join(', ')}）` : ''} — ${scene.description}\n`);
    for (const condition of conditions(scene)) process.stdout.write(`  ${condition.variant}: ${condition.checks.map(check => check.id).join(', ')}\n`);
  }
  return 0;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (error: unknown) => {
  // A config error names the setting and never its value; anything else is ours.
  process.stderr.write(`eval: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
