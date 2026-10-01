import { instant, localDateTime, localParts, minutesOfDay } from './nightly.ts';

/**
 * Five-field cron expressions (minute, hour, day of the month, month, weekday) for the self-checks that repeat
 * (ADR 0063), read on the owner's wall clock. Numbers, `*`, ranges, lists and steps are read; names and the `@` forms
 * are not. When both the day of the month and the weekday are restricted, either one matching is enough, as in
 * Vixie cron; a field beginning with `*` counts as unrestricted for that rule.
 */
export interface Cron {
  /** The expression as written, its fields joined by one space. */
  readonly text: string;
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** 0 is Sunday; a 7 written is read as 0. */
  readonly weekdays: ReadonlySet<number>;
  readonly anyDay: boolean;
  readonly anyWeekday: boolean;
}

export type CronParse = { ok: true; cron: Cron } | { ok: false; reason: string };

interface Field { label: string; min: number; max: number }
const FIELDS: readonly Field[] = [
  { label: '分', min: 0, max: 59 },
  { label: '時', min: 0, max: 23 },
  { label: '日', min: 1, max: 31 },
  { label: '月', min: 1, max: 12 },
  { label: '曜日', min: 0, max: 7 },
];

const SHAPE = '5 つの項目（分 時 日 月 曜日）を空白で区切って書いてください。例: "0 16 * * *"（毎日 16:00）、"*/10 * * * *"（10 分ごと）。';
const ITEM = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/;
/** The longest gap between two runs: a 29 February can be eight years from the next. */
const SEARCH_DAYS = 8 * 366 + 1;
const DAY_MS = 86_400_000;
/** More than any clock is moved back or forward at once. */
const MARGIN_MINUTES = 180;

class CronError extends Error {}

export function parseCron(text: string): CronParse {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== FIELDS.length) return { ok: false, reason: SHAPE };
  try {
    const [minutes, hours, days, months, weekdays] = parts.map((part, i) => values(part, FIELDS[i]!));
    return { ok: true, cron: {
      text: parts.join(' '),
      minutes: minutes!, hours: hours!, days: new Set(days), months: new Set(months),
      weekdays: new Set(weekdays!.map(day => day % 7)),
      anyDay: parts[2]!.startsWith('*'), anyWeekday: parts[4]!.startsWith('*'),
    } };
  } catch (error) {
    if (error instanceof CronError) return { ok: false, reason: error.message };
    throw error;
  }
}

/** The values one field allows, ascending. */
function values(part: string, field: Field): number[] {
  const { label, min, max } = field;
  const allowed = new Set<number>();
  for (const item of part.split(',')) {
    const match = ITEM.exec(item);
    if (!match) {
      throw new CronError(`${label}の "${item}" は読めません。数字・*・範囲（1-5）・リスト（1,15）・間隔（*/10）で書いてください。`);
    }
    const [, , first, last, step] = match;
    const outOfRange = (value: number) => value < min || value > max;
    const from = first === undefined ? min : Number(first);
    // `5/15` runs from 5 to the end of the field, as `5-59/15` would.
    const to = first === undefined ? max : last !== undefined ? Number(last) : step !== undefined ? max : from;
    if (outOfRange(from) || outOfRange(to)) {
      throw new CronError(`${label}は ${min}〜${max} で書いてください（"${item}"）。${label === '曜日' ? '0 と 7 が日曜日です。' : ''}`);
    }
    if (from > to) throw new CronError(`範囲は小さい方から書いてください（${label}の "${item}"）。`);
    const every = step === undefined ? 1 : Number(step);
    if (every < 1) throw new CronError(`間隔（/ の後）は 1 以上の整数で書いてください（${label}の "${item}"）。`);
    for (let value = from; value <= to; value += every) allowed.add(value);
  }
  return [...allowed].sort((a, b) => a - b);
}

/** A local calendar day `offset` days from the given one. */
function dayAt(start: { year: number; month: number; day: number }, offset: number) {
  const date = new Date(Date.UTC(start.year, start.month - 1, start.day) + offset * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
}

function runsOn(cron: Cron, date: { month: number; day: number; weekday: number }): boolean {
  if (!cron.months.has(date.month)) return false;
  const day = cron.days.has(date.day);
  const weekday = cron.weekdays.has(date.weekday);
  return cron.anyDay || cron.anyWeekday ? day && weekday : day || weekday;
}

/** The instant of a local time, or undefined when the zone skips it (a clock moved forward). */
function exists(date: { year: number; month: number; day: number }, hour: number, minute: number, timeZone: string): number | undefined {
  const ms = instant(date.year, date.month, date.day, hour, minute, timeZone);
  const expected = `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')} `
    + `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return localDateTime(ms, timeZone) === expected ? ms : undefined;
}

/**
 * The first run after `after`, or undefined when there is none within eight years. `accept` limits the runs to some
 * minutes of the local day, as the awake hours limit a repeating self-check.
 */
export function nextRun(cron: Cron, after: number, timeZone: string, accept?: (minuteOfDay: number) => boolean): number | undefined {
  const start = localParts(after, timeZone);
  // On the first day, the times well before `after` are passed over without asking the zone; the margin covers a
  // clock moved back.
  const from = minutesOfDay(after, timeZone) - MARGIN_MINUTES;
  for (let offset = 0; offset <= SEARCH_DAYS; offset += 1) {
    const date = dayAt(start, offset);
    if (!runsOn(cron, date)) continue;
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        if (offset === 0 && hour * 60 + minute < from) continue;
        if (accept && !accept(hour * 60 + minute)) continue;
        const ms = exists(date, hour, minute, timeZone);
        if (ms !== undefined && ms > after) return ms;
      }
    }
  }
  return undefined;
}

/** The latest run at or before `atOrBefore`, or undefined when there is none within eight years. */
export function lastRun(cron: Cron, atOrBefore: number, timeZone: string): number | undefined {
  const start = localParts(atOrBefore, timeZone);
  const to = minutesOfDay(atOrBefore, timeZone) + MARGIN_MINUTES;
  for (let offset = 0; offset <= SEARCH_DAYS; offset += 1) {
    const date = dayAt(start, -offset);
    if (!runsOn(cron, date)) continue;
    for (const hour of [...cron.hours].reverse()) {
      for (const minute of [...cron.minutes].reverse()) {
        if (offset === 0 && hour * 60 + minute > to) continue;
        const ms = exists(date, hour, minute, timeZone);
        if (ms !== undefined && ms <= atOrBefore) return ms;
      }
    }
  }
  return undefined;
}
