/** The z of a two-sided 95% interval. */
const Z = 1.959963984540054;

export interface Interval { rate: number; low: number; high: number }

/** The Wilson score interval of `passed` in `runs` (ADR 0051); undefined without a run. */
export function wilson(passed: number, runs: number): Interval | undefined {
  if (runs <= 0) return undefined;
  const rate = passed / runs;
  const z2 = Z * Z;
  const denominator = 1 + z2 / runs;
  const center = (rate + z2 / (2 * runs)) / denominator;
  const half = (Z * Math.sqrt(rate * (1 - rate) / runs + z2 / (4 * runs * runs))) / denominator;
  return { rate, low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export interface Count { passed: number; runs: number }

/**
 * The difference of two rates, b less a, with Newcombe's interval built from the two Wilson intervals (his method 10).
 * Undefined when either side has no run.
 */
export function newcombe(a: Count, b: Count): { difference: number; low: number; high: number } | undefined {
  const first = wilson(a.passed, a.runs);
  const second = wilson(b.passed, b.runs);
  if (!first || !second) return undefined;
  const difference = second.rate - first.rate;
  const low = difference - Math.sqrt((second.rate - second.low) ** 2 + (first.high - first.rate) ** 2);
  const high = difference + Math.sqrt((second.high - second.rate) ** 2 + (first.rate - first.low) ** 2);
  return { difference, low: Math.max(-1, low), high: Math.min(1, high) };
}

/** The `q` quantile of the values, interpolated between the two around it (type 7 of Hyndman and Fan); undefined without one. */
export function quantile(values: number[], q: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const above = Math.min(below + 1, sorted.length - 1);
  return sorted[below]! + (sorted[above]! - sorted[below]!) * (position - below);
}
