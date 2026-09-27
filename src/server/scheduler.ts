import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Transaction } from './conversation-store.ts';
import type { ToolOutcome } from './loop-tools.ts';
import { clockMinutes, instant, isoAt, localDateTime, localParts, minutesOfDay, previousOccurrence } from './nightly.ts';

/** The local hours natsumi is up. Pings and self-checks happen only inside them; `end` may be past midnight. */
export interface AwakeHours { start: string; end: string }

/** What the server allows for self-checks (ADR 0014). */
export interface SelfCheckLimits {
  /** The nearest a booking may be. */
  minDelayMinutes: number;
  /** The farthest a booking may be. */
  maxDelayDays: number;
  /** Bookings waiting at once. */
  maxPending: number;
  /** Bookings made in one local day, cancelled ones included. */
  maxPerDay: number;
}

export const DEFAULT_AWAKE_HOURS: AwakeHours = { start: '08:00', end: '23:00' };
export const DEFAULT_PING_INTERVAL_MINUTES = 30;
export const DEFAULT_SELF_CHECK_LIMITS: SelfCheckLimits = { minDelayMinutes: 5, maxDelayDays: 7, maxPending: 5, maxPerDay: 20 };
export const DEFAULT_EXPRESSION_RESET_MINUTES = 3;
/** How often the scheduler looks at the clock. */
export const SCHEDULER_TICK_MS = 10_000;

const MINUTE = 60_000;

export function isAwake(ms: number, hours: AwakeHours, timeZone: string): boolean {
  const now = minutesOfDay(ms, timeZone);
  const start = clockMinutes(hours.start);
  const end = clockMinutes(hours.end);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** A booking that has come due. */
export interface DueCheck { checkId: string; reason: string; dueAt: number }

const LOCAL_TIME = /^(\d{2}):(\d{2})$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;

/**
 * The checks natsumi books for herself (ADR 0014), kept in SQLite so they survive a restart.
 * Every limit is enforced here and a refusal is a sentence she can read; nothing throws at the thinking loop.
 */
export class SelfChecks {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly timeZone: string;
  private readonly limits: SelfCheckLimits;
  private readonly awakeHours: AwakeHours;

  constructor(options: { db: DatabaseSync; now: () => number; timeZone: string; limits: SelfCheckLimits; awakeHours: AwakeHours }) {
    this.db = options.db;
    this.now = options.now;
    this.timeZone = options.timeZone;
    this.limits = options.limits;
    this.awakeHours = options.awakeHours;
  }

  /** Books a check `inMinutes` from now or `at` a local time, resolved to an absolute time before it is saved. */
  schedule(reason: string, when: { inMinutes?: number; at?: string }): ToolOutcome {
    const refuse = (text: string): ToolOutcome => ({ ok: false, text: `予約していません。${text}` });
    const trimmed = reason.trim();
    if (trimmed === '') return refuse('reason に、この予約の理由（何を確かめるか）を書いてください。');
    if ((when.inMinutes === undefined) === (when.at === undefined)) return refuse('in_minutes と at のどちらか一方だけを指定してください。');
    const now = this.now();
    const { minDelayMinutes, maxDelayDays, maxPending, maxPerDay } = this.limits;
    const nearest = `予約は今から最短で ${minDelayMinutes} 分より先にしてください。`;

    let dueAt: number;
    if (when.inMinutes !== undefined) {
      if (!Number.isInteger(when.inMinutes)) return refuse('in_minutes は分の整数で書いてください。');
      if (when.inMinutes < minDelayMinutes) return refuse(nearest);
      dueAt = now + when.inMinutes * MINUTE;
    } else {
      const resolved = this.resolveLocal(when.at!, now);
      if (resolved === undefined) {
        return refuse(`at は本人のタイムゾーン（${this.timeZone}）の "HH:MM" か "YYYY-MM-DD HH:MM" で書いてください。今は ${localDateTime(now, this.timeZone)} です。`);
      }
      dueAt = resolved;
      if (dueAt <= now) return refuse(`${localDateTime(dueAt, this.timeZone)} は過去の時刻です。今は ${localDateTime(now, this.timeZone)}（${this.timeZone}）です。`);
      if (dueAt - now < minDelayMinutes * MINUTE) return refuse(nearest);
    }
    if (dueAt - now > maxDelayDays * 1440 * MINUTE) return refuse(`予約できるのは ${maxDelayDays} 日先までです。`);

    const key = reasonKey(trimmed);
    const same = this.db.prepare(`SELECT check_id, due_at FROM self_checks WHERE state = 'pending' AND reason_key = ?`).get(key) as
      { check_id: string; due_at: string } | undefined;
    if (same) {
      return { ok: true, text: `新しい予約は作らず、同じ理由の予約 ${same.check_id}（${this.local(same.due_at)}）にまとめました。`
        + '時刻を変えるなら、cancel_self_check で取り消してから予約し直してください。' };
    }
    const pending = this.db.prepare(`SELECT COUNT(*) AS n FROM self_checks WHERE state = 'pending'`).get() as { n: number };
    if (pending.n >= maxPending) {
      return refuse(`同時に持てる予約は ${maxPending} 件までです。list_self_checks で確かめ、要らないものは cancel_self_check で取り消せます。`);
    }
    const today = localParts(now, this.timeZone);
    const midnight = instant(today.year, today.month, today.day, 0, 0, this.timeZone);
    const booked = this.db.prepare('SELECT COUNT(*) AS n FROM self_checks WHERE created_at >= ?').get(isoAt(midnight)) as { n: number };
    if (booked.n >= maxPerDay) return refuse(`1 日に予約できるのは ${maxPerDay} 件までです。今日はもう予約できません。`);

    const checkId = `check-${randomUUID()}`;
    const iso = isoAt(now);
    this.db.prepare(`INSERT INTO self_checks (check_id, reason, reason_key, due_at, state, event_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`).run(checkId, trimmed, key, isoAt(dueAt), iso, iso);
    const local = localDateTime(dueAt, this.timeZone);
    const night = isAwake(dueAt, this.awakeHours, this.timeZone) ? ''
      : `起きている時間帯（${this.awakeHours.start}〜${this.awakeHours.end}）の外なので、実際に届くのは ${this.awakeHours.start} 以降です。`;
    return { ok: true, text: `${local}（${this.timeZone}）に確認を予約しました（check_id: ${checkId}）。${night}その時刻に self_check のイベントが届きます。` };
  }

  /** The bookings still waiting, soonest first. */
  list(): ToolOutcome {
    const rows = this.db.prepare(`SELECT check_id, reason, due_at FROM self_checks WHERE state = 'pending' ORDER BY due_at, check_id`).all() as
      { check_id: string; reason: string; due_at: string }[];
    if (rows.length === 0) return { ok: true, text: '予約している確認はありません。' };
    const lines = rows.map(row => `- ${row.check_id} ${this.local(row.due_at)} ${row.reason}`);
    return { ok: true, text: `予約している確認（${this.timeZone}）:\n${lines.join('\n')}` };
  }

  cancel(checkId: string): ToolOutcome {
    const changed = this.db.prepare(`UPDATE self_checks SET state = 'cancelled', updated_at = ? WHERE check_id = ? AND state = 'pending'`)
      .run(isoAt(this.now()), checkId).changes;
    if (Number(changed) === 0) return { ok: false, text: `取り消していません。${checkId} は待っている予約ではありません。` };
    return { ok: true, text: `予約 ${checkId} を取り消しました。` };
  }

  /** Bookings whose time has come, oldest first. */
  due(): DueCheck[] {
    const rows = this.db.prepare(`SELECT check_id, reason, due_at FROM self_checks WHERE state = 'pending' AND due_at <= ? ORDER BY due_at, check_id`)
      .all(isoAt(this.now())) as { check_id: string; reason: string; due_at: string }[];
    return rows.map(row => ({ checkId: row.check_id, reason: row.reason, dueAt: Date.parse(row.due_at) }));
  }

  /**
   * Marks bookings as handed to an event. The event and these rows have to be written together, or a check is
   * handed over twice or never: the `Transaction` the caller must pass is the proof that they are.
   */
  deliver(checkIds: string[], eventId: string, _transaction: Transaction): void {
    const update = this.db.prepare(`UPDATE self_checks SET state = 'delivered', event_id = ?, updated_at = ? WHERE check_id = ? AND state = 'pending'`);
    const iso = isoAt(this.now());
    for (const checkId of checkIds) update.run(eventId, iso, checkId);
  }

  /** The checks an event carried, with how late each was when the event was raised. */
  carriedBy(eventId: string, raisedAt: number): { check_id: string; reason: string; scheduled_for: string; late_minutes?: number }[] {
    const rows = this.db.prepare('SELECT check_id, reason, due_at FROM self_checks WHERE event_id = ? ORDER BY due_at, check_id').all(eventId) as
      { check_id: string; reason: string; due_at: string }[];
    return rows.map(row => {
      const late = Math.floor((raisedAt - Date.parse(row.due_at)) / MINUTE);
      return { check_id: row.check_id, reason: row.reason, scheduled_for: this.local(row.due_at), ...(late >= 1 ? { late_minutes: late } : {}) };
    });
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

function reasonKey(reason: string): string {
  return reason.normalize('NFKC').replace(/\s+/g, ' ').trim();
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
  awakeHours: AwakeHours;
  pingIntervalMinutes: number | false;
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
    if (!loop.quiet || !isAwake(now, awakeHours, timeZone)) return undefined;
    if (loop.deliverDueSelfChecks()) return 'self-check';
    if (pingIntervalMinutes !== false && now - loop.lastActivityAt >= pingIntervalMinutes * MINUTE && loop.ping()) return 'ping';
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
