import { parseDoveRequest } from '../server/dove-request.ts';
import type { CheckResult, RunRecord, ToolRecord } from './record.ts';
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
    const result = (pass: boolean | null, detail: string): CheckResult => ({ id: check.id, by: check.by, pass, detail });
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

function rule(spec: Record<string, unknown>, record: RunRecord): [boolean, string] {
  const bounded = (found: number, what: string): [boolean, string] => {
    const min = (spec.min as number | undefined) ?? 1;
    const max = spec.max as number | undefined;
    const pass = found >= min && (max === undefined || found <= max);
    return [pass, `${what}: ${found} 回（${min}〜${max ?? ''}）`];
  };
  const none = (found: number, what: string): [boolean, string] => [found === 0, `${what}: ${found} 回（0 回であること）`];
  const tools = record.tools;
  if (spec.called !== undefined) {
    const args = Object.entries((spec.args ?? {}) as Record<string, string>);
    const found = tools.filter(tool => tool.name === spec.called
      && args.every(([key, pattern]) => new RegExp(pattern, 'u').test(argText(tool.args[key])))).length;
    return bounded(found, String(spec.called));
  }
  if (spec.notCalled !== undefined) return none(tools.filter(tool => tool.name === spec.notCalled).length, String(spec.notCalled));
  if (spec.shell !== undefined) {
    const pattern = new RegExp(spec.shell as string, 'u');
    return bounded(tools.filter(tool => tool.name === SHELL && pattern.test(argText(tool.args.command))).length, `shell /${spec.shell}/`);
  }
  if (spec.output !== undefined) {
    const found = tools.filter(tool => (tool.name === SHELL || tool.name === READ) && tool.result.includes(spec.output as string)).length;
    return bounded(found, `出力に「${spec.output}」`);
  }
  if (spec.read !== undefined) return bounded(reads(tools, spec.read as string), `${spec.read} を読んだ`);
  if (spec.notRead !== undefined) return none(reads(tools, spec.notRead as string), `${spec.notRead} を読んだ`);
  if (spec.asked !== undefined) {
    const asked = spec.asked as { agent?: string; message?: string; replyTo?: string };
    const found = tools.filter(tool => {
      if (tool.name !== 'ask_agent') return false;
      if (asked.agent !== undefined && tool.args.agent !== asked.agent) return false;
      const message = argText(tool.args.message);
      if (asked.message !== undefined && !new RegExp(asked.message, 'u').test(message)) return false;
      if (asked.replyTo !== undefined && replyTo(message) !== asked.replyTo) return false;
      return true;
    }).length;
    return bounded(found, `ask_agent ${JSON.stringify(asked)}`);
  }
  if (spec.reply !== undefined) {
    const pattern = new RegExp(spec.reply as string, 'u');
    return bounded(record.replies.filter(reply => reply.kind === 'reply' && pattern.test(reply.text)).length, `返事 /${spec.reply}/`);
  }
  if (spec.modelCalls !== undefined) {
    const { min = 0, max } = spec.modelCalls as { min?: number; max?: number };
    const pass = record.modelCalls >= min && (max === undefined || record.modelCalls <= max);
    return [pass, `モデルの呼び出し: ${record.modelCalls} 回（${min}〜${max ?? ''}）`];
  }
  if (spec.finished !== undefined) return [record.outcome === 'ok', `終わり方: ${record.outcome}`];
  throw new Error(`unknown rule ${JSON.stringify(spec)}`);
}

/** Calls that read `path`: `read` of it or of a file under it, or a shell command that names it. */
function reads(tools: ToolRecord[], path: string): number {
  return tools.filter(tool => {
    if (tool.name === READ) {
      const target = argText(tool.args.path);
      return target === path || target.startsWith(`${path.replace(/\/$/, '')}/`);
    }
    return tool.name === SHELL && argText(tool.args.command).includes(path);
  }).length;
}

/** Where a request to the dove replies to, as natsumi wrote it; the dove's own reading decides. */
function replyTo(message: string): string | undefined {
  const parsed = parseDoveRequest(message);
  if (!parsed.ok) return undefined;
  const { workspace, channel, at, speaker, begins } = parsed.request.target;
  return [`${workspace}/${channel}`, ...(at ? [at.date, at.time] : []), ...(speaker ? [speaker] : []), ...(begins ? [`「${begins}」`] : [])].join(' ');
}

function argText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}
