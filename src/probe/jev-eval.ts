import { pathToFileURL } from 'node:url';
import { DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL, HttpJevClient } from '../server/jev.ts';
import { DEFAULT_JUDGE_TIMEOUT_MS, JudgeError, type JudgeClient, type Judgement, type Placement } from '../server/judge.ts';
import { DEFAULT_JUDGE_CONCURRENCY, LogprobJudgeClient } from '../server/logprob-judge.ts';
import { JEV_CASES, type JevCase } from './jev-cases.ts';

/**
 * Evaluates one of the dove's judges before its thresholds are set (ADR 0040, ADR 0059): every made-up case in
 * `jev-cases.ts` is judged once, and for each threshold the report counts the drafts that should be stopped and were,
 * and those that should pass and were stopped. A draft counts as stopped at a threshold when any issue scores at or
 * over it, which is where the server would hand it to the owner or turn it back. Each case's time is given, to set the
 * judgement's time limit. Where each reply went is counted against where its scene says it should go; with
 * `--order-check` every reply is asked again with the placement's options the other way round, to see how much the
 * order sways the answer.
 *
 *   JUDGE_BASE_URL=https://llm.example.net/v1 JUDGE_MODEL=my-model JUDGE_API_KEY_ENV=MY_KEY npm run probe:jev -- --thresholds 0.5,0.9
 *
 * The environment names the method (`JUDGE_METHOD`: logprobs by default, or jev), the endpoint (`JUDGE_BASE_URL`,
 * required for logprobs, TypeSafe's by default for jev), the model (`JUDGE_MODEL`, required for logprobs), the questions
 * asked at once (`JUDGE_CONCURRENCY`) and the time limit (`JUDGE_TIMEOUT_SECONDS`). The key is given by the name of the
 * variable that holds it (`JUDGE_API_KEY_ENV`), so its value is never typed on a command line nor printed. It calls the
 * real endpoint, so the tests never run it; they run `evaluate`.
 */

export interface EvalArgs {
  method: 'logprobs' | 'jev'; baseUrl: string; model: string; apiKeyEnv?: string; apiKey?: string;
  concurrency: number; timeoutSeconds: number; thresholds: number[];
  /** Asks every reply again with the placement's options the other way round. */
  orderCheck?: true;
}

export function parseEvalArgs(argv: string[], env: Record<string, string | undefined>): EvalArgs {
  let thresholds = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  let orderCheck = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--order-check') orderCheck = true;
    if (argv[index] === '--thresholds') {
      thresholds = (argv[index + 1] ?? '').split(',').map(Number);
      index += 1;
    }
  }
  if (thresholds.length === 0 || !thresholds.every(value => Number.isFinite(value) && value > 0 && value <= 1)) {
    throw new Error('--thresholds takes numbers over 0 and at most 1, separated by commas');
  }
  const method = env.JUDGE_METHOD || 'logprobs';
  if (method !== 'logprobs' && method !== 'jev') throw new Error('JUDGE_METHOD is logprobs or jev');
  const baseUrl = env.JUDGE_BASE_URL || (method === 'jev' ? DEFAULT_JEV_BASE_URL : undefined);
  if (!baseUrl) throw new Error('JUDGE_BASE_URL is required for the logprobs method');
  const model = env.JUDGE_MODEL || (method === 'jev' ? DEFAULT_JEV_MODEL : undefined);
  if (!model) throw new Error('JUDGE_MODEL is required for the logprobs method');
  const apiKeyEnv = env.JUDGE_API_KEY_ENV || undefined;
  const apiKey = apiKeyEnv ? env[apiKeyEnv] : undefined;
  if (apiKeyEnv && !apiKey) throw new Error(`${apiKeyEnv} (named by JUDGE_API_KEY_ENV) is empty`);
  const concurrency = Number(env.JUDGE_CONCURRENCY || DEFAULT_JUDGE_CONCURRENCY);
  const timeoutSeconds = Number(env.JUDGE_TIMEOUT_SECONDS || DEFAULT_JUDGE_TIMEOUT_MS / 1000);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('JUDGE_CONCURRENCY is a positive integer');
  if (!(timeoutSeconds > 0)) throw new Error('JUDGE_TIMEOUT_SECONDS is a positive number');
  return { method, baseUrl, model, ...(apiKeyEnv ? { apiKeyEnv, apiKey } : {}), concurrency, timeoutSeconds, thresholds,
    ...(orderCheck ? { orderCheck: true as const } : {}) };
}

/** What the run is against, as the report says it: everything but the key's value. */
export function describeRun(args: EvalArgs): Record<string, unknown> {
  const { apiKey: _key, thresholds: _thresholds, orderCheck: _orderCheck, ...shown } = args;
  return shown;
}

type Placed = { choice: Placement; probabilities?: { thread: number; channel: number } };

export interface EvalReport {
  cases: {
    name: string; category: string; expect: JevCase['expect']; issue?: string; max: number | null; ms: number; scores?: Record<string, number>;
    error?: string;
    /** Where the reply went, where it should go, and where it went with the options the other way round. */
    placement?: Placed & { expected?: Placement; reversed?: Placed | { error: string } };
  }[];
  /** The longest a case took: what the judgement's time limit has to allow. */
  slowestMs: number;
  thresholds: { owner: number; stopped: number; shouldStop: number; wronglyStopped: number; shouldPass: number }[];
  /** Cases with no verdict: left out of the counts above. */
  noVerdict: number;
  /** The replies placed; those whose scene says where, and how many of these went there; and how many went each way. */
  placement: { asked: number; expected: number; agreed: number; thread: number; channel: number };
  /** With the options the other way round: the replies compared, those that went the other way, and the largest change. */
  order?: { compared: number; flips: number; maxDifference: number };
}

const placed = (judged: Judgement): Placed | undefined =>
  judged.placement ? { choice: judged.placement.choice, ...(judged.placement.probabilities ? { probabilities: judged.placement.probabilities } : {}) } : undefined;

export async function evaluate(client: JudgeClient, cases: readonly JevCase[], thresholds: number[],
  options: { reversed?: JudgeClient } = {}): Promise<EvalReport> {
  const results: EvalReport['cases'] = [];
  for (const example of cases) {
    const started = Date.now();
    const asked = { placement: example.state.reply_to !== null && example.state.reply_to !== undefined };
    const head = { name: example.name, category: example.category, expect: example.expect, ...(example.issue ? { issue: example.issue } : {}) };
    try {
      const judged = await client.judge(example.state, asked);
      const ms = Date.now() - started;
      const scores = Object.fromEntries(judged.issues.map(issue => [issue.name, issue.score]));
      const placement = placed(judged);
      let reversed: Placed | { error: string } | undefined;
      if (placement && options.reversed) {
        try { reversed = placed(await options.reversed.judge(example.state, asked)); } catch (error) {
          reversed = { error: error instanceof JudgeError ? error.kind : 'error' };
        }
      }
      results.push({ ...head, max: Math.max(...judged.issues.map(issue => issue.score)), ms, scores,
        ...(placement ? { placement: { ...(example.placement ? { expected: example.placement } : {}), ...placement, ...(reversed ? { reversed } : {}) } } : {}) });
    } catch (error) {
      results.push({ ...head, max: null, ms: Date.now() - started, error: error instanceof JudgeError ? error.kind : 'error' });
    }
  }
  const judged = results.filter(result => result.max !== null);
  const placements = results.flatMap(result => result.placement ? [result.placement] : []);
  const compared = placements.flatMap(one => one.reversed && 'choice' in one.reversed ? [{ one, reversed: one.reversed }] : []);
  return {
    cases: results,
    slowestMs: Math.max(0, ...results.map(result => result.ms)),
    thresholds: thresholds.map(owner => ({
      owner,
      stopped: judged.filter(result => result.expect === 'stop' && result.max! >= owner).length,
      shouldStop: judged.filter(result => result.expect === 'stop').length,
      wronglyStopped: judged.filter(result => result.expect === 'pass' && result.max! >= owner).length,
      shouldPass: judged.filter(result => result.expect === 'pass').length,
    })),
    noVerdict: results.length - judged.length,
    placement: {
      asked: placements.length, expected: placements.filter(one => one.expected).length,
      agreed: placements.filter(one => one.expected && one.expected === one.choice).length,
      thread: placements.filter(one => one.choice === 'thread').length, channel: placements.filter(one => one.choice === 'channel').length,
    },
    ...(options.reversed ? { order: {
      compared: compared.length,
      flips: compared.filter(({ one, reversed }) => one.choice !== reversed.choice).length,
      maxDifference: Math.max(0, ...compared.map(({ one, reversed }) => one.probabilities && reversed.probabilities
        ? Math.abs(one.probabilities.channel - reversed.probabilities.channel) : 0)),
    } } : {}),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = parseEvalArgs(process.argv.slice(2), process.env);
  const common = { baseUrl: args.baseUrl, model: args.model, timeoutMs: args.timeoutSeconds * 1000, ...(args.apiKey ? { apiKey: args.apiKey } : {}) };
  const make = (placementOrder?: readonly Placement[]) => {
    const options = { ...common, ...(placementOrder ? { placementOrder } : {}) };
    return args.method === 'jev' ? new HttpJevClient(options) : new LogprobJudgeClient({ ...options, concurrency: args.concurrency });
  };
  const report = await evaluate(make(), JEV_CASES, args.thresholds, args.orderCheck ? { reversed: make(['channel', 'thread']) } : {});
  // The cases are made up, so the report may carry their names and scores; never the key.
  process.stdout.write(`${JSON.stringify({ ...describeRun(args), ...report }, null, 2)}\n`);
}
