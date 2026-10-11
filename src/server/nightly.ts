/**
 * Times: the UTC form every stored instant takes, and wall-clock times in the owner's time zone, for the nightly
 * session switch (ADR 0009) and the scheduler (ADR 0014). Nothing here keeps state, and nothing here imports.
 */

/** An instant in the form every stored time takes: UTC, milliseconds, `Z`. */
export function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timeZone, format);
  }
  return format;
}

interface LocalTime { year: number; month: number; day: number; hour: number; minute: number; second: number }

function local(ms: number, timeZone: string): LocalTime {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(ms).map(part => [part.type, part.value]));
  return { year: +parts.year!, month: +parts.month!, day: +parts.day!, hour: +parts.hour!, minute: +parts.minute!, second: +parts.second! };
}

/** How far the zone's wall clock is ahead of UTC at this instant. */
function offset(ms: number, timeZone: string): number {
  const t = local(ms, timeZone);
  return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second) - Math.floor(ms / 1000) * 1000;
}

/** The instant a local date and time happens. Day overflow (such as day 0) rolls into the neighbouring month. */
export function instant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - offset(wall, timeZone);
  return wall - offset(first, timeZone);
}

export function isValidTimeZone(timeZone: string): boolean {
  try { formatter(timeZone); return true; } catch { return false; }
}

/** `HH:MM`, 24-hour. */
export const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

function clock(at: string): [number, number] {
  const match = TIME_OF_DAY.exec(at);
  if (!match) throw new Error('time of day must be HH:MM');
  return [Number(match[1]), Number(match[2])];
}

/** The latest time `at` happened at or before `now`. */
export function previousOccurrence(now: number, at: string, timeZone: string): number {
  const [hour, minute] = clock(at);
  const today = local(now, timeZone);
  const candidate = instant(today.year, today.month, today.day, hour, minute, timeZone);
  return candidate <= now ? candidate : instant(today.year, today.month, today.day - 1, hour, minute, timeZone);
}

/** The first time `at` happens after `now`. */
export function nextOccurrence(now: number, at: string, timeZone: string): number {
  const [hour, minute] = clock(at);
  const today = local(now, timeZone);
  const candidate = instant(today.year, today.month, today.day, hour, minute, timeZone);
  return candidate > now ? candidate : instant(today.year, today.month, today.day + 1, hour, minute, timeZone);
}

/** `YYYY-MM-DD` in the time zone. */
export function localDate(ms: number, timeZone: string): string {
  const t = local(ms, timeZone);
  return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
}

/** `YYYY-MM-DD HH:MM` in the time zone. */
export function localDateTime(ms: number, timeZone: string): string {
  const t = local(ms, timeZone);
  return `${localDate(ms, timeZone)} ${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

/** Minutes since local midnight. */
export function minutesOfDay(ms: number, timeZone: string): number {
  const t = local(ms, timeZone);
  return t.hour * 60 + t.minute;
}

/** Minutes since midnight of an `HH:MM` time of day. */
export function clockMinutes(at: string): number {
  const [hour, minute] = clock(at);
  return hour * 60 + minute;
}

/** The local calendar date of an instant, as numbers. */
export function localParts(ms: number, timeZone: string): { year: number; month: number; day: number } {
  const t = local(ms, timeZone);
  return { year: t.year, month: t.month, day: t.day };
}

/** An instant in the time zone to the second, with its offset: `2026-10-11T07:00:00+09:00` (ISO 8601). */
export function localIso(ms: number, timeZone: string): string {
  const t = local(ms, timeZone);
  const pad = (value: number) => String(value).padStart(2, '0');
  const minutes = Math.round(offset(ms, timeZone) / 60_000);
  const sign = minutes < 0 ? '-' : '+';
  const away = Math.abs(minutes);
  return `${localDate(ms, timeZone)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}${sign}${pad(Math.floor(away / 60))}:${pad(away % 60)}`;
}
