import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Transaction } from './conversation-store.ts';
import type { ToolOutcome } from './loop-tools.ts';
import { lastRun, nextRun, parseCron } from './cron.ts';
import { clockMinutes, instant, isoAt, localDateTime, localParts, minutesOfDay, previousOccurrence } from './nightly.ts';

/** The local hours natsumi is up. Pings and self-checks happen only inside them; `end` may be past midnight. */
export interface AwakeHours { start: string; end: string }

/**
 * A setting the owner may change while natsumi runs (ADR 0058): a value that stays, or a function read each time it is
 * needed, so a change is in force from the next tick or booking.
 */
export type Live<T> = T | (() => T);
export const current = <T>(value: Live<T>): T => typeof value === 'function' ? (value as () => T)() : value;

export const DEFAULT_AWAKE_HOURS: AwakeHours = { start: '08:00', end: '23:00' };
export const DEFAULT_PING_INTERVAL_MINUTES = 30;
export const DEFAULT_EXPRESSION_RESET_MINUTES = 3;
/** How often the scheduler looks at the clock. */
export const SCHEDULER_TICK_MS = 10_000;

const MINUTE = 60_000;

export function isAwake(ms: number, hours: AwakeHours, timeZone: string): boolean {
  return awakeAt(minutesOfDay(ms, timeZone), hours);
}

/** Whether a local minute of the day is inside the awake hours. */
function awakeAt(minute: number, hours: AwakeHours): boolean {
  const start = clockMinutes(hours.start);
  const end = clockMinutes(hours.end);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** A booking that has come due: for a repeating one, the run it is delivered for. */
export interface DueCheck { checkId: string; reason: string; dueAt: number; cron?: string }

const LOCAL_TIME = /^(\d{2}):(\d{2})$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;

/**
 * The checks natsumi books for herself (ADR 0014, ADR 0063), kept in SQLite so they survive a restart. A booking is a
 * one-off at an absolute time, or repeats by a cron expression read on the owner's clock. A refusal is a sentence she
 * can read; nothing throws at the thinking loop.
 */
export class SelfChecks {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly timeZone: string;
  private readonly awakeHours: Live<AwakeHours>;

  constructor(options: { db: DatabaseSync; now: () => number; timeZone: string; awakeHours: Live<AwakeHours> }) {
    this.db = options.db;
    this.now = options.now;
    this.timeZone = options.timeZone;
    this.awakeHours = options.awakeHours;
  }

  /**
   * Books a check `inMinutes` from now or `at` a local time, resolved to an absolute time before it is saved, or one
   * that repeats by `cron`. There is no limit on how soon, how far or how many (ADR 0063).
   */
  schedule(reason: string, when: { inMinutes?: number; at?: string; cron?: string }): ToolOutcome {
    const refuse = (text: string): ToolOutcome => ({ ok: false, text: `予約していません。${text}` });
    const trimmed = reason.trim();
    if (trimmed === '') return refuse('reason に、この予約の理由（何を確かめるか）を書いてください。');
    const given = [when.inMinutes, when.at, when.cron].filter(value => value !== undefined).length;
    if (given !== 1) return refuse('cron・at・in_minutes のどれか 1 つだけを指定してください。');
    const now = this.now();
    const hours = current(this.awakeHours);
    const awake = `起きている時間帯（${hours.start}〜${hours.end}）`;

    if (when.cron !== undefined) {
      const parsed = parseCron(when.cron);
      if (!parsed.ok) return refuse(`cron の式を読めません。${parsed.reason}`);
      const { cron } = parsed;
      if (nextRun(cron, now, this.timeZone) === undefined) return refuse(`cron "${cron.text}" に当てはまる時刻がありません。`);
      const next = nextRun(cron, now, this.timeZone, minute => awakeAt(minute, hours));
      if (next === undefined) return refuse(`cron "${cron.text}" の時刻はどれも${awake}の外なので、一度も届きません。`);
      const checkId = this.insert(trimmed, cron.text, next, now);
      return { ok: true, text: `cron "${cron.text}"（${this.timeZone}）で繰り返しの確認を予約しました（check_id: ${checkId}）。`
        + `次は ${localDateTime(next, this.timeZone)} です。${awake}の外の回は飛ばします。`
        + '時刻が来るたびに self_check のイベントが届き、取り消すまで続きます。' };
    }

    let dueAt: number;
    if (when.inMinutes !== undefined) {
      if (!Number.isInteger(when.inMinutes)) return refuse('in_minutes は分の整数で書いてください。');
      if (when.inMinutes < 1) return refuse('in_minutes は 1 以上にしてください。');
      dueAt = now + when.inMinutes * MINUTE;
    } else {
      const resolved = this.resolveLocal(when.at!, now);
      if (resolved === undefined) {
        return refuse(`at はマスターのタイムゾーン（${this.timeZone}）の "HH:MM" か "YYYY-MM-DD HH:MM" で書いてください。今は ${localDateTime(now, this.timeZone)} です。`);
      }
      dueAt = resolved;
      if (dueAt <= now) return refuse(`${localDateTime(dueAt, this.timeZone)} は過去の時刻です。今は ${localDateTime(now, this.timeZone)}（${this.timeZone}）です。`);
    }
    const checkId = this.insert(trimmed, null, dueAt, now);
    const night = isAwake(dueAt, hours, this.timeZone) ? '' : `${awake}の外なので、実際に届くのは ${hours.start} 以降です。`;
    return { ok: true, text: `${localDateTime(dueAt, this.timeZone)}（${this.timeZone}）に確認を予約しました（check_id: ${checkId}）。${night}その時刻に self_check のイベントが届きます。` };
  }

  /** The bookings still waiting, soonest first; a repeating one with its expression, at its next run. */
  list(): ToolOutcome {
    const rows = this.db.prepare(`SELECT check_id, reason, cron, due_at FROM self_checks WHERE state = 'pending' ORDER BY due_at, check_id`).all() as
      { check_id: string; reason: string; cron: string | null; due_at: string }[];
    if (rows.length === 0) return { ok: true, text: '予約している確認はありません。' };
    const lines = rows.map(row => `- ${row.check_id} ${this.local(row.due_at)} ${row.reason}${row.cron === null ? '' : `（繰り返し: ${row.cron}）`}`);
    return { ok: true, text: `予約している確認（${this.timeZone}。繰り返しは次の時刻）:\n${lines.join('\n')}` };
  }

  cancel(checkId: string): ToolOutcome {
    const changed = this.db.prepare(`UPDATE self_checks SET state = 'cancelled', updated_at = ? WHERE check_id = ? AND state = 'pending'`)
      .run(isoAt(this.now()), checkId).changes;
    if (Number(changed) === 0) return { ok: false, text: `取り消していません。${checkId} は待っている予約ではありません。` };
    return { ok: true, text: `予約 ${checkId} を取り消しました。` };
  }

  /**
   * Bookings whose time has come, oldest first. A one-off comes however late. A repeating one comes once for its
   * latest run, however many passed, and only when that run is inside the awake hours and after they last began: a run
   * outside them, or one left behind by a night, is passed over and the booking moves to its next run (ADR 0063).
   */
  due(): DueCheck[] {
    const now = this.now();
    const rows = this.db.prepare(`SELECT check_id, reason, cron, due_at FROM self_checks WHERE state = 'pending' AND due_at <= ? ORDER BY due_at, check_id`)
      .all(isoAt(now)) as { check_id: string; reason: string; cron: string | null; due_at: string }[];
    const hours = current(this.awakeHours);
    const woke = previousOccurrence(now, hours.start, this.timeZone);
    const due: DueCheck[] = [];
    for (const row of rows) {
      if (row.cron === null) {
        due.push({ checkId: row.check_id, reason: row.reason, dueAt: Date.parse(row.due_at) });
        continue;
      }
      const parsed = parseCron(row.cron);
      const run = parsed.ok ? lastRun(parsed.cron, now, this.timeZone) : undefined;
      if (run !== undefined && isAwake(run, hours, this.timeZone) && run >= woke) {
        due.push({ checkId: row.check_id, reason: row.reason, dueAt: run, cron: row.cron });
      } else {
        this.advance(row.check_id, row.cron, now);
      }
    }
    return due;
  }

  /**
   * Marks bookings as handed to an event: a one-off is done, a repeating one moves to its next run. The event and these
   * rows have to be written together, or a check is handed over twice or never: the `Transaction` the caller must pass
   * is the proof that they are.
   */
  deliver(checks: DueCheck[], eventId: string, _transaction: Transaction): void {
    const now = this.now();
    const iso = isoAt(now);
    const record = this.db.prepare('INSERT INTO self_check_deliveries (event_id, check_id, due_at) VALUES (?, ?, ?)');
    const done = this.db.prepare(`UPDATE self_checks SET state = 'delivered', updated_at = ? WHERE check_id = ? AND state = 'pending'`);
    for (const check of checks) {
      record.run(eventId, check.checkId, isoAt(check.dueAt));
      if (check.cron === undefined) done.run(iso, check.checkId);
      else this.advance(check.checkId, check.cron, now);
    }
  }

  /** The checks an event carried, with how late each was when the event was raised, and a repeating one's expression. */
  carriedBy(eventId: string, raisedAt: number): { check_id: string; reason: string; scheduled_for: string; late_minutes?: number; cron?: string }[] {
    const rows = this.db.prepare(`SELECT d.check_id, c.reason, c.cron, d.due_at FROM self_check_deliveries d
      JOIN self_checks c ON c.check_id = d.check_id WHERE d.event_id = ? ORDER BY d.due_at, d.check_id`).all(eventId) as
      { check_id: string; reason: string; cron: string | null; due_at: string }[];
    return rows.map(row => {
      const late = Math.floor((raisedAt - Date.parse(row.due_at)) / MINUTE);
      return { check_id: row.check_id, reason: row.reason, scheduled_for: this.local(row.due_at), ...(late >= 1 ? { late_minutes: late } : {}),
        ...(row.cron === null ? {} : { cron: row.cron }) };
    });
  }

  private insert(reason: string, cron: string | null, dueAt: number, now: number): string {
    const checkId = `check-${randomUUID()}`;
    const iso = isoAt(now);
    this.db.prepare(`INSERT INTO self_checks (check_id, reason, cron, due_at, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)`).run(checkId, reason, cron, isoAt(dueAt), iso, iso);
    return checkId;
  }

  /**
   * Moves a repeating booking to its next run after now inside the awake hours, or to its next run at all when the
   * hours in force leave none. One with no run left, which a booking never starts as, is cancelled.
   */
  private advance(checkId: string, text: string, now: number): void {
    const parsed = parseCron(text);
    const hours = current(this.awakeHours);
    const next = parsed.ok
      ? nextRun(parsed.cron, now, this.timeZone, minute => awakeAt(minute, hours)) ?? nextRun(parsed.cron, now, this.timeZone)
      : undefined;
    if (next === undefined) {
      this.db.prepare(`UPDATE self_checks SET state = 'cancelled', updated_at = ? WHERE check_id = ?`).run(isoAt(now), checkId);
    } else {
      this.db.prepare('UPDATE self_checks SET due_at = ?, updated_at = ? WHERE check_id = ?').run(isoAt(next), isoAt(now), checkId);
    }
  }

  private local(iso: string): string { return localDateTime(Date.parse(iso), this.timeZone); }

  /** `HH:MM` today or `YYYY-MM-DD HH:MM`, local. Undefined for any other shape or a time the zone skips. */
  private resolveLocal(at: string, now: number): number | undefined {
    const text = at.trim();
    const time = LOCAL_TIME.exec(text);
    const full = LOCAL_DATE_TIME.exec(text);
    let date: { year: number; month: number; day: number };
    let clock: [string, string];
    if (time) {
      date = localParts(now, this.timeZone);
      clock = [time[1]!, time[2]!];
    } else if (full) {
      date = { year: Number(full[1]), month: Number(full[2]), day: Number(full[3]) };
      clock = [full[4]!, full[5]!];
    } else {
      return undefined;
    }
    const [hour, minute] = clock;
    const ms = instant(date.year, date.month, date.day, Number(hour), Number(minute), this.timeZone);
    const expected = `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')} ${hour}:${minute}`;
    return localDateTime(ms, this.timeZone) === expected ? ms : undefined;
  }
}

/** What the scheduler needs from the thinking loop. */
export interface ScheduledLoop {
  readonly unavailable: string | undefined;
  /** No turn is running and nothing is queued. */
  readonly quiet: boolean;
  /** When the loop last received or finished handling something. */
  readonly lastActivityAt: number;
  /** Returns an expression other than thinking to neutral once it has been shown this long. */
  relaxExpression(afterMs: number): void;
  /** Hands every due self-check to the loop as one event. False when none is due. */
  deliverDueSelfChecks(): boolean;
  /** Hands the loop a ping. */
  ping(): boolean;
  /** When the current session began: its last switch, or the conversation's creation (ADR 0009). */
  sessionStartedAt(): number | undefined;
  /** Reviews the day and switches to a new session. Queues the review and resolves once the switch has ended. */
  rotate(): Promise<{ result: string; reason?: string }>;
}

export interface SchedulerOptions {
  loop: ScheduledLoop;
  now?: () => number;
  timeZone: string;
  awakeHours: Live<AwakeHours>;
  pingIntervalMinutes: Live<number | false>;
  expressionResetMinutes: number;
  /** The local time of the nightly session switch, or false to leave the session alone (ADR 0009). */
  nightlyRotationAt: string | false;
  /** What natsumi reads (ADR 0050): looked at on every tick, whatever the hour; it raises its own events. */
  sources?: { tick(): Promise<void> };
  tickMs?: number;
  log?: (line: string) => void;
}

/**
 * Looks at the clock and raises the loop's own events: the nightly session switch (ADR 0009) whatever the hour, then
 * due self-checks and a ping after a quiet interval (ADR 0014), those two only in the awake hours and only when the
 * loop is quiet.
 */
export class Scheduler {
  private readonly options: SchedulerOptions;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  /** The switching time a switch was last asked for, so one night asks once however many ticks pass. */
  private switchedFor: number | undefined;
  /** A switch resolves only once its review turn is over; until then nothing asks for another. */
  private switching = false;
  /** A look at the sources still going is not joined by another. */
  private lookingAtSources = false;

  constructor(options: SchedulerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.safeTick(), this.options.tickMs ?? SCHEDULER_TICK_MS);
    this.timer.unref();
    this.safeTick();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One look at the clock. Returns what it raised for the owner's stream, if anything. */
  tick(): 'self-check' | 'ping' | undefined {
    const { loop, awakeHours, timeZone, pingIntervalMinutes, expressionResetMinutes } = this.options;
    if (loop.unavailable) return undefined;
    loop.relaxExpression(expressionResetMinutes * MINUTE);
    const now = this.now();
    // The switch happens in the night, outside the awake hours, and waits for no quiet: it is looked at before both.
    this.switchSession(now);
    this.lookAtSources();
    if (!loop.quiet || !isAwake(now, current(awakeHours), timeZone)) return undefined;
    if (loop.deliverDueSelfChecks()) return 'self-check';
    const interval = current(pingIntervalMinutes);
    if (interval !== false && now - loop.lastActivityAt >= interval * MINUTE && loop.ping()) return 'ping';
    return undefined;
  }

  /**
   * The nightly switch (ADR 0009). A session that began before the last switching time is switched: at the time itself,
   * or at the next start after a night passed while natsumi was stopped. One switching time asks for one switch, so a
   * switch that changed nothing (an empty session) or failed waits for the next night, as the timer it replaced did.
   */
  private switchSession(now: number): void {
    const { loop, nightlyRotationAt, timeZone, log } = this.options;
    if (nightlyRotationAt === false || this.switching) return;
    const at = previousOccurrence(now, nightlyRotationAt, timeZone);
    const started = loop.sessionStartedAt();
    if (at === this.switchedFor || started === undefined || started >= at) return;
    this.switchedFor = at;
    this.switching = true;
    void loop.rotate().then(
      outcome => { log?.(`thinking loop: nightly switch ${outcome.result}${'reason' in outcome ? ` (${outcome.reason})` : ''}`); },
      () => {},
    ).finally(() => { this.switching = false; });
  }

  /** The sources decide for themselves what the hour allows; a failure is logged and the next tick looks again. */
  private lookAtSources(): void {
    const { sources, log } = this.options;
    if (!sources || this.lookingAtSources) return;
    this.lookingAtSources = true;
    void sources.tick().catch(() => { log?.('sources: a look failed'); }).finally(() => { this.lookingAtSources = false; });
  }

  private safeTick() {
    try { this.tick(); } catch { this.options.log?.('scheduler: a tick failed'); }
  }
}
