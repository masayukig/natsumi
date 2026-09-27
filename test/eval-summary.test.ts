import assert from 'node:assert/strict';
import test from 'node:test';
import type { CheckResult, RunRecord } from '../src/eval/record.ts';
import { compare, compareMarkdown, summarize, summaryMarkdown } from '../src/eval/summary.ts';

function run(variant: string, index: number, checks: [string, boolean | null][], overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    scene: 'greeting', variant, run: index, model: { provider: 'natsumi-compatible', id: 'fixture' }, dryRun: true,
    startedAt: '2026-09-27T00:00:00.000Z', ms: 1000 * index, outcome: 'ok', modelCalls: index,
    tokens: { input: 100, cacheRead: 50, output: 10 * index }, instructions: { chars: 100, sha256: 'a'.repeat(64) }, priorMessages: 0,
    prompt: '', events: [], calls: [], tools: [], replies: [], dove: [],
    checks: checks.map(([id, pass]): CheckResult => ({ id, by: id === 'kind' ? 'llm' : 'rule', pass, detail: '' })),
    ...overrides,
  };
}

test('the summary counts passes per scene, variant and check, with the Wilson interval', () => {
  const summary = summarize([
    run('base', 1, [['replied', true], ['kind', true]]),
    run('base', 2, [['replied', true], ['kind', null]]),
    run('base', 3, [['replied', false], ['kind', false]], { outcome: 'model-call-limit' }),
    run('base', 4, [], { outcome: 'error', error: 'the runner did not start' }),
  ], [{ scene: 'sources-mention', reason: 'requires sources-updated' }]);
  const [condition] = summary.conditions;
  assert.equal(condition!.runs, 4);
  assert.equal(condition!.errors, 1);
  assert.equal(condition!.cutOffs, 1);
  // Means are over the runs that ran: the failed one has nothing to measure.
  assert.equal(condition!.meanModelCalls, 2);
  assert.equal(condition!.meanMs, 2000);
  assert.deepEqual(condition!.meanTokens, { input: 100, cacheRead: 50, output: 20 });
  const [replied, kind] = condition!.checks;
  assert.deepEqual([replied!.id, replied!.by, replied!.passed, replied!.judged], ['replied', 'rule', 2, 3]);
  assert.ok(replied!.low! < 2 / 3 && replied!.high! > 2 / 3);
  assert.deepEqual([kind!.by, kind!.passed, kind!.judged, kind!.unjudged], ['llm', 1, 2, 1]);
  assert.deepEqual(summary.skipped, [{ scene: 'sources-mention', reason: 'requires sources-updated' }]);

  const markdown = summaryMarkdown(summary, 'dry');
  assert.match(markdown, /greeting/);
  assert.match(markdown, /replied/);
  assert.match(markdown, /2\/3/);
  assert.match(markdown, /sources-mention/);
});

test('compare puts two results side by side with the difference of their rates and its interval', () => {
  const a = summarize([1, 2, 3, 4].map(index => run('base', index, [['replied', index <= 1]])));
  const b = summarize([1, 2, 3, 4].map(index => run('base', index, [['replied', true]])));
  const comparison = compare(a, b);
  const [row] = comparison.rows;
  assert.deepEqual([row!.scene, row!.variant, row!.id], ['greeting', 'base', 'replied']);
  assert.deepEqual([row!.a.passed, row!.a.judged, row!.b.passed, row!.b.judged], [1, 4, 4, 4]);
  assert.equal(row!.difference, 0.75);
  assert.ok(row!.low! < 0.75 && row!.high! > 0.75 && row!.high! <= 1);
  const markdown = compareMarkdown(comparison, 'before', 'after');
  assert.match(markdown, /before/);
  assert.match(markdown, /\+75/);
});

test('a check found on one side only is listed without a difference', () => {
  const a = summarize([run('base', 1, [['replied', true]])]);
  const b = summarize([run('base', 1, [['replied', true], ['quiet', true]]), run('other', 1, [['replied', false]])]);
  const rows = compare(a, b).rows;
  const quiet = rows.find(row => row.id === 'quiet')!;
  assert.equal(quiet.a.judged, 0);
  assert.equal(quiet.difference, undefined);
  assert.ok(rows.some(row => row.variant === 'other'));
});

/** A run whose `replied` check was met at `call`, `ms` after the event, with 100 input tokens a call. */
function reached(variant: string, index: number, call: number | null, pass = call !== null): RunRecord {
  return run(variant, index, [], {
    checks: [{ id: 'replied', by: 'rule', pass, detail: '',
      ...(call === null ? {} : { reached: { call, ms: 1000 * call, tokens: { input: 100 * call, cacheRead: 10 * call, output: call } } }) }],
  });
}

test('the steps to a check are counted over the runs that passed it: the median and the 90th percentile of the calls', () => {
  const summary = summarize([reached('base', 1, 1), reached('base', 2, 2), reached('base', 3, 3), reached('base', 4, 6),
    reached('base', 5, null)]);
  const [check] = summary.conditions[0]!.checks;
  assert.deepEqual([check!.passed, check!.judged], [4, 5]);
  const { calls, ...rest } = check!.steps!;
  assert.equal(calls.median, 2.5);
  assert.ok(Math.abs(calls.p90 - 5.1) < 1e-9, String(calls.p90));
  assert.deepEqual(rest, { runs: 4, ms: 2500, tokens: { input: 250, cacheRead: 25, output: 2.5 } });
  const markdown = summaryMarkdown(summary, 'dry');
  assert.match(markdown, /着くまで/);
  assert.match(markdown, /\| replied \| rule \| 4\/5 \| 80% \| [^|]+ \| 0 \| 2\.5 \/ 5\.1 \| 2\.5 \| 250 \/ 25 \/ 3 \|/);
});

test('a result written before the steps were kept reads with the steps left blank', () => {
  const summary = summarize([run('base', 1, [['replied', true]]), run('base', 2, [['replied', true]])]);
  const [check] = summary.conditions[0]!.checks;
  assert.equal(check!.steps, null);
  assert.match(summaryMarkdown(summary, 'old'), /\| replied \| rule \| 2\/2 \| 100% \| [^|]+ \| 0 \| — \| — \| — \|/);
});

test('compare puts the median steps of the two results side by side, with their difference', () => {
  const a = summarize([reached('base', 1, 3), reached('base', 2, 4), reached('base', 3, 5), reached('base', 4, null)]);
  const b = summarize([reached('base', 1, 2), reached('base', 2, 2), reached('base', 3, 3), reached('base', 4, 1)]);
  const [row] = compare(a, b).rows;
  assert.deepEqual(row!.steps, { a: { runs: 3, median: 4 }, b: { runs: 4, median: 2 }, difference: -2 });
  const markdown = compareMarkdown(compare(a, b), 'before', 'after');
  assert.match(markdown, /\| 4（3 回） \| 2（4 回） \| -2 \|/);

  // A side without steps (never passed, or written before they were kept) has no difference.
  const old = summarize([run('base', 1, [['replied', true]])]);
  const [partial] = compare(old, b).rows;
  assert.deepEqual(partial!.steps, { a: null, b: { runs: 4, median: 2 } });
  assert.match(compareMarkdown(compare(old, b), 'old', 'after'), /\| — \| 2（4 回） \| — \|/);
});
