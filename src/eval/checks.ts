import { parseDoveRequest } from '../server/dove-request.ts';
import type { CheckResult, Reached, RunRecord, ToolRecord } from './record.ts';
import type { Check } from './scene.ts';

/** An LLM judging one rubric on a run (ADR 0051). `pass` null means it answered, but not with a verdict. */
export interface Judge {
  judge(rubric: string, record: RunRecord): Promise<{ pass: boolean | null; detail: string }>;
}

/** A check written in `scene.ts`: a verdict, or a verdict with its reason. */
export type CheckFunction = (record: RunRecord) => boolean | { pass: boolean; detail?: string }
  | Promise<boolean | { pass: boolean; detail?: string }>;

export interface JudgeOptions {
  functions?: Record<string, CheckFunction>;
  judge?: Judge;
}

/** The results of every check on a run, in the scene's order. A check that cannot be judged is null, not failed. */
export async function judgeChecks(record: RunRecord, checks: Check[], options: JudgeOptions = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    const result = (pass: boolean | null, detail: string, reached?: Reached): CheckResult =>
      ({ id: check.id, by: check.by, pass, detail, ...(reached ? { reached } : {}) });
    if (check.by === 'rule') { results.push(result(...rule(check.spec, record))); continue; }
    if (check.by === 'function') {
      const name = check.spec.function as string;
      const fn = options.functions?.[name];
      if (!fn) { results.push(result(null, `判定できません: scene.ts に関数 ${name} がありません`)); continue; }
      try {
        const answer = await fn(record);
        results.push(typeof answer === 'boolean' ? result(answer, '') : result(answer.pass, answer.detail ?? ''));
      } catch (error) {
        results.push(result(null, `判定できません: ${name} が失敗しました（${(error as Error).message}）`));
      }
      continue;
    }
    if (!options.judge) { results.push(result(null, '判定できません: 判定役が指定されていません')); continue; }
    try {
      const answer = await options.judge.judge(check.spec.rubric as string, record);
      results.push(result(answer.pass, answer.detail));
    } catch (error) {
      results.push(result(null, `判定できません: 判定役が答えませんでした（${(error as Error).message}）`));
    }
  }
  return results;
}

/** The files a shell command or a read names are compared as text: a path is read if a command mentions it. */
const SHELL = 'run_shell';
const READ = 'read';

/**
 * A rule's verdict and reason, with where it was met when something done in a call met it: the call that brought the
 * count to its min. A rule met by nothing done (`notCalled`, `notRead`, a min of 0) or by the whole turn has none.
 */
function rule(spec: Record<string, unknown>, record: RunRecord): [boolean, string, Reached?] {
  const bounded = (calls: (number | undefined)[], what: string): [boolean, string, Reached?] => {
    const min = (spec.min as number | undefined) ?? 1;
    const max = spec.max as number | undefined;
    const found = calls.length;
    const pass = found >= min && (max === undefined || found <= max);
    const at = min > 0 ? [...calls].sort((a, b) => (a ?? Infinity) - (b ?? Infinity))[min - 1] : undefined;
    return [pass, `${what}: ${found} 回（${min}〜${max ?? ''}）`, pass && at !== undefined ? reachedAt(at, record) : undefined];
  };
  const none = (found: number, what: string): [boolean, string] => [found === 0, `${what}: ${found} 回（0 回であること）`];
  const calls = (found: { call?: number }[]) => found.map(item => item.call);
  const tools = record.tools;
  if (spec.called !== undefined) {
    const args = Object.entries((spec.args ?? {}) as Record<string, string>);
    const found = tools.filter(tool => tool.name === spec.called
      && args.every(([key, pattern]) => new RegExp(pattern, 'u').test(argText(tool.args[key]))));
    return bounded(calls(found), String(spec.called));
  }
  if (spec.notCalled !== undefined) return none(tools.filter(tool => tool.name === spec.notCalled).length, String(spec.notCalled));
  if (spec.shell !== undefined) {
    const pattern = new RegExp(spec.shell as string, 'u');
    return bounded(calls(tools.filter(tool => tool.name === SHELL && pattern.test(argText(tool.args.command)))), `shell /${spec.shell}/`);
  }
  if (spec.output !== undefined) {
    const found = tools.filter(tool => (tool.name === SHELL || tool.name === READ) && tool.result.includes(spec.output as string));
    return bounded(calls(found), `出力に「${spec.output}」`);
  }
  if (spec.read !== undefined) return bounded(calls(reads(tools, spec.read as string)), `${spec.read} を読んだ`);
  if (spec.notRead !== undefined) return none(reads(tools, spec.notRead as string).length, `${spec.notRead} を読んだ`);
  if (spec.asked !== undefined) {
    const asked = spec.asked as { agent?: string; message?: string; to?: { file: string; path?: string } };
    const found = tools.filter(tool => {
      if (tool.name !== 'ask_agent') return false;
      if (asked.agent !== undefined && tool.args.agent !== asked.agent) return false;
      const message = argText(tool.args.message);
      if (asked.message !== undefined && !new RegExp(asked.message, 'u').test(message)) return false;
      if (asked.to !== undefined && !sameTarget(message, asked.to)) return false;
      return true;
    });
    return bounded(calls(found), `ask_agent ${JSON.stringify(asked)}`);
  }
  if (spec.reply !== undefined) {
    const pattern = new RegExp(spec.reply as string, 'u');
    return bounded(calls(record.replies.filter(reply => reply.kind === 'reply' && pattern.test(reply.text))), `返事 /${spec.reply}/`);
  }
  if (spec.modelCalls !== undefined) {
    const { min = 0, max } = spec.modelCalls as { min?: number; max?: number };
    const pass = record.modelCalls >= min && (max === undefined || record.modelCalls <= max);
    return [pass, `モデルの呼び出し: ${record.modelCalls} 回（${min}〜${max ?? ''}）`];
  }
  if (spec.finished !== undefined) return [record.outcome === 'ok', `終わり方: ${record.outcome}`];
  throw new Error(`unknown rule ${JSON.stringify(spec)}`);
}

/** The tokens and the time up to the end of call `call`. */
function reachedAt(call: number, record: RunRecord): Reached {
  const upTo = record.calls.slice(0, call);
  const sum = (key: 'input' | 'cacheRead' | 'output' | 'ms') => upTo.reduce((total, item) => total + item[key], 0);
  return { call, ms: upTo.at(-1)?.at ?? sum('ms'), tokens: { input: sum('input'), cacheRead: sum('cacheRead'), output: sum('output') } };
}

/** Calls that read `path`: `read` of it or of a file under it, or a shell command that names it. */
function reads(tools: ToolRecord[], path: string): ToolRecord[] {
  return tools.filter(tool => {
    if (tool.name === READ) {
      const target = argText(tool.args.path);
      return target === path || target.startsWith(`${path.replace(/\/$/, '')}/`);
    }
    return tool.name === SHELL && argText(tool.args.command).includes(path);
  });
}

/**
 * Whether a request to the dove goes where the check says (ADR 0074), as natsumi wrote it and the dove's own reading
 * takes it: the same file, a directory with or without its last slash, and the same line.
 */
function sameTarget(message: string, expected: { file: string; path?: string }): boolean {
  const parsed = parseDoveRequest(message);
  if (!parsed.ok) return false;
  const { to } = parsed.request;
  const file = (path: string) => path.replace(/\/+$/, '');
  return file(to.file) === file(expected.file) && to.path === expected.path;
}

function argText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}
