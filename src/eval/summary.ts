import type { CheckResult, Reached, RunRecord } from './record.ts';
import { newcombe, quantile, wilson } from './stats.ts';

/** A scene that was not run, and why. */
export interface Skipped { scene: string; reason: string }

export interface CheckSummary {
  id: string;
  by: CheckResult['by'];
  passed: number;
  /** Runs with a verdict on this check; `unjudged` ones are left out of the rate. */
  judged: number;
  unjudged: number;
  rate: number | null;
  low: number | null;
  high: number | null;
  /** How far the passed runs went before meeting the check; null when none of them says (see `Reached`). */
  steps: Steps | null;
}

/** Over the passed runs that say where they met a check: the calls it took, and the medians of the time and the tokens. */
export interface Steps {
  runs: number;
  calls: { median: number; p90: number };
  ms: number;
  tokens: { input: number; cacheRead: number; output: number };
}

export interface ConditionSummary {
  scene: string;
  variant: string;
  runs: number;
  /** Runs that could not be made at all. */
  errors: number;
  /** Turns that ended on a failed model call. */
  modelErrors: number;
  /** Why the runs that failed did, grouped: how they ended and the reason recorded. */
  failures: { outcome: string; reason: string; runs: number }[];
  /** Turns stopped by the model-call or the time limit. */
  cutOffs: number;
  meanModelCalls: number | null;
  meanMs: number | null;
  meanTokens: { input: number; cacheRead: number; output: number } | null;
  checks: CheckSummary[];
}

export interface Summary {
  models: { provider: string; id: string }[];
  dryRun: boolean;
  conditions: ConditionSummary[];
  skipped: Skipped[];
}

const CUT_OFF = new Set(['model-call-limit', 'timeout']);

/** Passes per scene, variant and check, with the Wilson interval, and the side measures (ADR 0051). */
export function summarize(records: RunRecord[], skipped: Skipped[] = []): Summary {
  const groups = new Map<string, RunRecord[]>();
  for (const record of records) {
    const key = JSON.stringify([record.scene, record.variant]);
    groups.set(key, [...groups.get(key) ?? [], record]);
  }
  const conditions = [...groups.values()].map((runs): ConditionSummary => {
    const ran = runs.filter(run => run.outcome !== 'error');
    const mean = (values: number[]) => values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
    const ids: { id: string; by: CheckResult['by'] }[] = [];
    for (const run of ran) for (const check of run.checks) if (!ids.some(seen => seen.id === check.id)) ids.push({ id: check.id, by: check.by });
    return {
      scene: runs[0]!.scene, variant: runs[0]!.variant, runs: runs.length,
      errors: runs.length - ran.length,
      modelErrors: ran.filter(run => run.outcome === 'model-error').length,
      failures: failuresOf(runs),
      cutOffs: ran.filter(run => CUT_OFF.has(run.outcome)).length,
      meanModelCalls: mean(ran.map(run => run.modelCalls)),
      meanMs: mean(ran.map(run => run.ms)),
      meanTokens: ran.length === 0 ? null : {
        input: mean(ran.map(run => run.tokens.input))!, cacheRead: mean(ran.map(run => run.tokens.cacheRead))!,
        output: mean(ran.map(run => run.tokens.output))!,
      },
      checks: ids.map(({ id, by }) => {
        const verdicts = ran.map(run => run.checks.find(check => check.id === id)?.pass);
        const passed = verdicts.filter(pass => pass === true).length;
        const judged = verdicts.filter(pass => pass === true || pass === false).length;
        const interval = wilson(passed, judged);
        const reached = ran.map(run => run.checks.find(check => check.id === id))
          .flatMap(check => check?.pass === true && check.reached ? [check.reached] : []);
        return { id, by, passed, judged, unjudged: verdicts.filter(pass => pass === null).length,
          rate: interval?.rate ?? null, low: interval?.low ?? null, high: interval?.high ?? null, steps: steps(reached) };
      }),
    };
  });
  const models: Summary['models'] = [];
  for (const record of records) {
    if (!models.some(model => model.provider === record.model.provider && model.id === record.model.id)) models.push(record.model);
  }
  return { models, dryRun: records.some(record => record.dryRun), conditions, skipped };
}

function failuresOf(runs: RunRecord[]): ConditionSummary['failures'] {
  const failures: ConditionSummary['failures'] = [];
  for (const run of runs.filter(candidate => candidate.outcome === 'error' || candidate.outcome === 'model-error')) {
    const reason = run.error ?? '（理由の記録なし）';
    const same = failures.find(failure => failure.outcome === run.outcome && failure.reason === reason);
    if (same) same.runs += 1; else failures.push({ outcome: run.outcome, reason, runs: 1 });
  }
  return failures;
}

function steps(reached: Reached[]): Steps | null {
  if (reached.length === 0) return null;
  const median = (values: number[]) => quantile(values, 0.5)!;
  return {
    runs: reached.length,
    calls: { median: median(reached.map(item => item.call)), p90: quantile(reached.map(item => item.call), 0.9)! },
    ms: median(reached.map(item => item.ms)),
    tokens: { input: median(reached.map(item => item.tokens.input)), cacheRead: median(reached.map(item => item.tokens.cacheRead)),
      output: median(reached.map(item => item.tokens.output)) },
  };
}

const percent = (value: number | null) => value === null ? '—' : `${Math.round(value * 100)}%`;
const interval = (low: number | null, high: number | null) => low === null || high === null ? '—' : `${percent(low)}–${percent(high)}`;
const number = (value: number | null, digits = 1) => value === null ? '—' : value.toFixed(digits);
/** A count or a median of counts: whole numbers as they are, others to one place. */
const short = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(1);
const cell = (text: string) => text.replace(/\|/g, '\\|');

export function summaryMarkdown(summary: Summary, label: string): string {
  const lines = [`# 評価の集計: ${label}`, ''];
  lines.push(`- モデル: ${summary.models.map(model => `${model.provider}/${model.id}`).join(', ') || '—'}${summary.dryRun ? '（ドライラン）' : ''}`, '');
  lines.push('## 項目ごとの合格', '', '着くまで: 合格した回で、項目を初めて満たしたモデルの呼び出しの番号（中央値 / 90 パーセンタイル）と、そこまでの秒とトークン（中央値）。',
    '', '| 場面 | 変種 | 項目 | 判定 | 合格 | 率 | 95% 区間 | 判定できず | 着くまでの呼び出し | 秒 | input / cache read / output |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const condition of summary.conditions) {
    for (const check of condition.checks) {
      const steps = check.steps;
      lines.push(`| ${cell(condition.scene)} | ${cell(condition.variant)} | ${cell(check.id)} | ${check.by} | ${check.passed}/${check.judged} | `
        + `${percent(check.rate)} | ${interval(check.low, check.high)} | ${check.unjudged} | `
        + (steps === null ? '— | — | — |' : `${short(steps.calls.median)} / ${short(steps.calls.p90)} | ${short(steps.ms / 1000)} | `
          + `${number(steps.tokens.input, 0)} / ${number(steps.tokens.cacheRead, 0)} / ${number(steps.tokens.output, 0)} |`));
    }
  }
  lines.push('', '## 副指標', '', '| 場面 | 変種 | 回数 | 失敗 | 打ち切り | 呼び出し（平均） | 秒（平均） | input | cache read | output |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const condition of summary.conditions) {
    const tokens = condition.meanTokens;
    lines.push(`| ${cell(condition.scene)} | ${cell(condition.variant)} | ${condition.runs} | ${condition.errors + (condition.modelErrors ?? 0)} | ${condition.cutOffs} | `
      + `${number(condition.meanModelCalls)} | ${number(condition.meanMs === null ? null : condition.meanMs / 1000)} | `
      + `${number(tokens?.input ?? null, 0)} | ${number(tokens?.cacheRead ?? null, 0)} | ${number(tokens?.output ?? null, 0)} |`);
  }
  const failed = summary.conditions.filter(condition => (condition.failures ?? []).length > 0);
  if (failed.length > 0) {
    lines.push('', '## 失敗の理由', '', '失敗: 回を作れなかった（error）か、モデルの呼び出しが失敗して終わった（model-error）回。', '',
      '| 場面 | 変種 | 終わり方 | 回数 | 理由 |', '| --- | --- | --- | --- | --- |');
    for (const condition of failed) {
      for (const failure of condition.failures) {
        lines.push(`| ${cell(condition.scene)} | ${cell(condition.variant)} | ${failure.outcome} | ${failure.runs} | ${cell(failure.reason.replace(/\n/g, ' '))} |`);
      }
    }
  }
  if (summary.skipped.length > 0) {
    lines.push('', '## 飛ばした場面', '');
    for (const skipped of summary.skipped) lines.push(`- ${skipped.scene}: ${skipped.reason}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface ComparisonRow {
  scene: string;
  variant: string;
  id: string;
  a: { passed: number; judged: number };
  b: { passed: number; judged: number };
  /** b's rate less a's, with Newcombe's 95% interval; absent when either side has no verdict. */
  difference?: number;
  low?: number;
  high?: number;
  /** The median calls to the check on each side, and b's less a's when both have one. */
  steps: { a: StepSide | null; b: StepSide | null; difference?: number };
}

export interface StepSide { runs: number; median: number }

export interface Comparison { rows: ComparisonRow[] }

/** Two results side by side, per scene, variant and check (ADR 0051). */
export function compare(a: Summary, b: Summary): Comparison {
  const rows: ComparisonRow[] = [];
  const keys: { scene: string; variant: string; id: string }[] = [];
  for (const summary of [a, b]) {
    for (const condition of summary.conditions) {
      for (const check of condition.checks) {
        if (!keys.some(key => key.scene === condition.scene && key.variant === condition.variant && key.id === check.id)) {
          keys.push({ scene: condition.scene, variant: condition.variant, id: check.id });
        }
      }
    }
  }
  const find = (summary: Summary, key: typeof keys[number]) => {
    const check = summary.conditions.find(condition => condition.scene === key.scene && condition.variant === key.variant)
      ?.checks.find(candidate => candidate.id === key.id);
    return { passed: check?.passed ?? 0, judged: check?.judged ?? 0,
      steps: check?.steps ? { runs: check.steps.runs, median: check.steps.calls.median } : null };
  };
  for (const key of keys) {
    const { steps: stepsA, ...left } = find(a, key);
    const { steps: stepsB, ...right } = find(b, key);
    const difference = newcombe({ passed: left.passed, runs: left.judged }, { passed: right.passed, runs: right.judged });
    const steps = { a: stepsA, b: stepsB, ...(stepsA && stepsB ? { difference: stepsB.median - stepsA.median } : {}) };
    rows.push({ ...key, a: left, b: right, ...(difference ?? {}), steps });
  }
  return { rows };
}

export function compareMarkdown(comparison: Comparison, labelA: string, labelB: string): string {
  const signed = (value: number | undefined) => value === undefined ? '—' : `${value >= 0 ? '+' : ''}${Math.round(value * 100)}`;
  const lines = [`# 比較: ${labelA} → ${labelB}`, '', `差は ${labelB} の率 − ${labelA} の率（ポイント）。区間は Newcombe の 95% 区間。`,
    `着くまでは、合格した回で項目を初めて満たした呼び出しの番号の中央値（括弧は数えた回数）。差は ${labelB} − ${labelA}（回）。`, '',
    `| 場面 | 変種 | 項目 | ${cell(labelA)} | ${cell(labelB)} | 差 | 95% 区間 | 着くまで ${cell(labelA)} | 着くまで ${cell(labelB)} | 差（回） |`,
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  const steps = (side: StepSide | null) => side === null ? '—' : `${short(side.median)}（${side.runs} 回）`;
  for (const row of comparison.rows) {
    const side = (count: { passed: number; judged: number }) => count.judged === 0 ? '—'
      : `${count.passed}/${count.judged}（${Math.round(count.passed / count.judged * 100)}%）`;
    lines.push(`| ${cell(row.scene)} | ${cell(row.variant)} | ${cell(row.id)} | ${side(row.a)} | ${side(row.b)} | ${signed(row.difference)} | `
      + `${row.low === undefined ? '—' : `${signed(row.low)}〜${signed(row.high)}`} | ${steps(row.steps.a)} | ${steps(row.steps.b)} | `
      + `${row.steps.difference === undefined ? '—' : `${row.steps.difference > 0 ? '+' : ''}${short(row.steps.difference)}`} |`);
  }
  return `${lines.join('\n')}\n`;
}
