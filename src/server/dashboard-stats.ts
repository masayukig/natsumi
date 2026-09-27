import type { DatabaseSync } from 'node:sqlite';
import { isoAt } from './nightly.ts';
import type { TokenCounts } from './turn-stats.ts';

/**
 * The numbers behind the dashboard's charts (ADR 0049), from `turn_stats` alone and counted by SQLite: the ordinary
 * turns of a period in steps of time. The nightly review is left out, as `natsumi stats` leaves it out: its calls and
 * its length are of another order. Cut short means what `natsumi stats` means by it, the call limit or the time limit;
 * the percentiles are its nearest rank.
 *
 * A request reads only the period's rows, through the index on `started_at`, and gets back at most a row per step and
 * two per step for each percentile: thirty days is the longest period there is.
 */

export type Period = '24h' | '7d' | '30d';

export const PERIODS: Record<Period, { label: string; stepMs: number; steps: number }> = {
  '24h': { label: '24 時間', stepMs: 60 * 60_000, steps: 24 },
  '7d': { label: '7 日', stepMs: 6 * 60 * 60_000, steps: 28 },
  '30d': { label: '30 日', stepMs: 24 * 60 * 60_000, steps: 30 },
};

const isPeriod = (value: string): value is Period => Object.hasOwn(PERIODS, value);

/** The period a page asks for: 24 hours when it names none, undefined when it names one that is not on the list. */
export function statsPeriod(url: URL): Period | undefined {
  const asked = url.searchParams.getAll('period');
  if (asked.length === 0) return '24h';
  return asked.length === 1 && isPeriod(asked[0]!) ? asked[0] : undefined;
}

/** The p50 and p90 of a measure in milliseconds, over the turns that have it; null when none does. */
export interface Spread { p50: number | null; p90: number | null; count: number }

/** A step of time: its turns, and what they add up to. Everything but the count is null when it has no turn. */
export interface StatsStep {
  start: string;
  end: string;
  turns: number;
  /** From the earliest event to her first reply or request to the dove. */
  firstOut: Spread;
  /** The whole turn. */
  turnLength: Spread;
  modelCalls: number | null;
  tokens: TokenCounts | null;
  /** Stopped at the call limit or the time limit. */
  cutShort: number | null;
  /** Any other outcome that is not ok. */
  failed: number | null;
}

export interface StatsView {
  period: Period;
  steps: StatsStep[];
  /** The whole period as one step. */
  whole: StatsStep;
}

const CUT_SHORT = "('model-call-limit', 'timeout')";
/** The measures a percentile is taken of; the column names are fixed here and never come from a request. */
const SPREADS = { firstOut: 'first_out_ms', turnLength: 'turn_ms' } as const;

export function readStats(db: DatabaseSync, options: { period: Period; now: number; timeZone: string }): StatsView {
  const { stepMs, steps: count } = PERIODS[options.period];
  const offset = zoneOffset(options.now, options.timeZone);
  const end = (Math.floor((options.now + offset) / stepMs) + 1) * stepMs - offset;
  const start = end - count * stepMs;
  const empty = (from: number, to: number): StatsStep => ({
    start: isoAt(from), end: isoAt(to), turns: 0, firstOut: { p50: null, p90: null, count: 0 }, turnLength: { p50: null, p90: null, count: 0 },
    modelCalls: null, tokens: null, cutShort: null, failed: null,
  });
  const steps = Array.from({ length: count }, (_, index) => empty(start + index * stepMs, start + (index + 1) * stepMs));
  const whole = empty(start, end);

  // The step of a turn: started_at is ISO with milliseconds, and the steps begin on whole seconds. The bounds are bound as
  // reals, so they are made integers for the division to be one.
  const turns = `SELECT (unixepoch(started_at) * 1000 - CAST(:start AS INTEGER)) / CAST(:step AS INTEGER) AS step, first_out_ms, turn_ms,
    model_calls, input_tokens, cache_read_tokens, output_tokens, outcome FROM turn_stats
    WHERE kind = 'events' AND started_at >= :from AND started_at < :to`;
  const bounds = { start, step: stepMs, from: isoAt(start), to: isoAt(end) };
  const sums = db.prepare(`SELECT step, COUNT(*) AS turns, SUM(model_calls) AS calls, SUM(input_tokens) AS input,
      SUM(cache_read_tokens) AS cache_read, SUM(output_tokens) AS output, SUM(outcome IN ${CUT_SHORT}) AS cut_short,
      SUM(outcome <> 'ok' AND outcome NOT IN ${CUT_SHORT}) AS failed
    FROM (${turns}) GROUP BY step`).all(bounds) as Record<string, number>[];
  for (const row of sums) {
    const step = steps[row.step!];
    if (!step) continue;
    Object.assign(step, { turns: row.turns!, modelCalls: row.calls!, tokens: { input: row.input!, cacheRead: row.cache_read!, output: row.output! },
      cutShort: row.cut_short!, failed: row.failed! });
    whole.turns += row.turns!;
    whole.modelCalls = (whole.modelCalls ?? 0) + row.calls!;
    const tokens = whole.tokens ?? { input: 0, cacheRead: 0, output: 0 };
    whole.tokens = { input: tokens.input + row.input!, cacheRead: tokens.cacheRead + row.cache_read!, output: tokens.output + row.output! };
    whole.cutShort = (whole.cutShort ?? 0) + row.cut_short!;
    whole.failed = (whole.failed ?? 0) + row.failed!;
  }
  // Nearest rank, in each step and over the whole period in the same pass: the value at ceil(p/100 × n), at least the first.
  const nearest = (rank: string, n: string) => `${rank} = MAX(1, (50 * ${n} + 99) / 100) OR ${rank} = MAX(1, (90 * ${n} + 99) / 100)`;
  for (const [measure, column] of Object.entries(SPREADS) as [keyof typeof SPREADS, string][]) {
    const ranked = db.prepare(`SELECT step, value, rank, n, whole_rank, whole_n FROM (
        SELECT step, ${column} AS value,
          ROW_NUMBER() OVER (PARTITION BY step ORDER BY ${column}) AS rank, COUNT(*) OVER (PARTITION BY step) AS n,
          ROW_NUMBER() OVER (ORDER BY ${column}) AS whole_rank, COUNT(*) OVER () AS whole_n
        FROM (${turns}) WHERE ${column} IS NOT NULL)
      WHERE ${nearest('rank', 'n')} OR ${nearest('whole_rank', 'whole_n')}`).all(bounds) as Record<string, number>[];
    for (const row of ranked) {
      const step = steps[row.step!];
      if (step) take(step[measure], row.value!, row.rank!, row.n!);
      take(whole[measure], row.value!, row.whole_rank!, row.whole_n!);
    }
  }
  return { period: options.period, steps, whole };
}

/** Puts a value in its place in the spread, when its rank is the p50's or the p90's among `n`. */
function take(spread: Spread, value: number, rank: number, n: number) {
  spread.count = n;
  if (rank === Math.max(1, Math.ceil(n / 2))) spread.p50 = value;
  if (rank === Math.max(1, Math.ceil((n * 9) / 10))) spread.p90 = value;
}

/** How far the zone's clock is ahead of UTC at `at`, in milliseconds; the steps begin on its hours and midnights. */
function zoneOffset(at: number, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric',
    day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(at).map(part => [part.type, Number(part.value)]));
  const local = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return local - Math.floor(at / 1000) * 1000;
}
