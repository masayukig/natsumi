import assert from 'node:assert/strict';
import test from 'node:test';
import { newcombe, quantile, wilson } from '../src/eval/stats.ts';

const near = (actual: number, expected: number, digits = 4) =>
  assert.ok(Math.abs(actual - expected) < 10 ** -digits, `${actual} is not ${expected}`);

test('the Wilson interval of 8 successes in 10 is about 0.490 to 0.943', () => {
  const interval = wilson(8, 10)!;
  near(interval.rate, 0.8);
  near(interval.low, 0.4902, 3);
  near(interval.high, 0.9433, 3);
});

test('the Wilson interval stays inside 0 and 1 at the ends', () => {
  const none = wilson(0, 10)!;
  near(none.low, 0);
  near(none.high, 0.2775, 3);
  const all = wilson(10, 10)!;
  near(all.low, 0.7225, 3);
  near(all.high, 1);
});

test('there is no interval without a single run', () => {
  assert.equal(wilson(0, 0), undefined);
});

test('the difference of two rates has the Newcombe interval (56/70 against 48/80: 0.052 to 0.334)', () => {
  // Newcombe (1998), example (a): the second rate less the first, turned around here as b − a.
  const difference = newcombe({ passed: 48, runs: 80 }, { passed: 56, runs: 70 })!;
  near(difference.difference, 56 / 70 - 48 / 80);
  near(difference.low, 0.0524, 3);
  near(difference.high, 0.3339, 3);
});

test('no difference is given when either side has no runs', () => {
  assert.equal(newcombe({ passed: 0, runs: 0 }, { passed: 3, runs: 5 }), undefined);
});

test('a quantile lies between the two values around it (the median of 1 to 4 is 2.5, the 90th percentile of 1 to 10 is 9.1)', () => {
  near(quantile([4, 1, 3, 2], 0.5)!, 2.5);
  near(quantile([10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 0.9)!, 9.1);
  assert.equal(quantile([3], 0.9), 3);
});

test('there is no quantile of nothing', () => {
  assert.equal(quantile([], 0.5), undefined);
});
