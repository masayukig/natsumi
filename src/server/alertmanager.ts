import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isoAt, localDate } from './nightly.ts';
import { writeFileAtomically } from './paths.ts';
import type { Sources } from './sources.ts';
import { DayLines, FIRING_FILE, joinLines, localSeconds, WEBHOOK_FILE_MODE, WEBHOOKS_PATH, WEBHOOKS_SOURCE, type WebhookFormat } from './webhooks.ts';

/**
 * The webhook format `alertmanager` (ADR 0091, which made it of ADR 0086's way in). A webhook of it is one
 * Alertmanager, which POSTs a group of alerts. Each alert is kept by the webhook's name and its fingerprint with the
 * state it was last written in, and a line goes into the day's file under `sources/webhooks/<name>/` only when that
 * state changes: a group sent again on its repeat interval, or again after an answer that was not a 2xx, writes none.
 * `firing.jsonl` beside them is what fires now, written afresh on every notification and left out of the history. An
 * alert of a severity the config marks that begins to fire is an attention, told at once.
 *
 * What is received is in the database before any file is written, and every file is written whole from it, so a
 * notification answered with a 5xx because a file could not be written has its lines written by the next one.
 */

/** The attention's kind, as the manual names it. */
export const ALERT_ATTENTION = 'alert';

/** The label whose value is matched against `attentionSeverities`; kube-prometheus's rules name it so. */
const SEVERITY_LABEL = 'severity';
/** Alertmanager's fingerprint is 16 hex digits; anything plain is taken, since it is never a path. */
const FINGERPRINT = /^[A-Za-z0-9]{1,64}$/;

export type AlertStatus = 'firing' | 'resolved';

/** One alert of a notification, as far as natsumi reads it. */
export interface ReceivedAlert {
  status: AlertStatus;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  /** Milliseconds since the epoch. */
  startsAt: number;
  /** Only when resolved. */
  endsAt?: number;
  fingerprint: string;
  generatorURL?: string;
}

export interface AlertNotification {
  groupKey?: string;
  alerts: ReceivedAlert[];
}

/** A notification in the shape of Alertmanager's webhook (version 4), or undefined when it is not one. */
export function parseNotification(value: unknown): AlertNotification | undefined {
  if (!isRecord(value) || !Array.isArray(value.alerts)) return undefined;
  if (value.groupKey !== undefined && typeof value.groupKey !== 'string') return undefined;
  const alerts: ReceivedAlert[] = [];
  for (const item of value.alerts as unknown[]) {
    if (!isRecord(item)) return undefined;
    const { status, labels, annotations = {}, startsAt, endsAt, fingerprint, generatorURL } = item;
    if (status !== 'firing' && status !== 'resolved') return undefined;
    if (!stringMap(labels) || !stringMap(annotations)) return undefined;
    if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) return undefined;
    const started = instant(startsAt);
    if (started === undefined) return undefined;
    const ended = status === 'resolved' ? instant(endsAt) : undefined;
    if (status === 'resolved' && ended === undefined) return undefined;
    if (generatorURL !== undefined && typeof generatorURL !== 'string') return undefined;
    alerts.push({ status, labels, annotations, startsAt: started, ...(ended === undefined ? {} : { endsAt: ended }), fingerprint,
      ...(generatorURL ? { generatorURL } : {}) });
  }
  return { ...(typeof value.groupKey === 'string' ? { groupKey: value.groupKey } : {}), alerts };
}

export interface AlertmanagerWebhookOptions {
  db: DatabaseSync;
  /** The webhook's name, its directory and the key of its alerts. */
  name: string;
  /** `sources/webhooks` in the data directory. */
  directory: string;
  timeZone: string;
  attentionSeverities: readonly string[];
  now: () => number;
  /** Where the attentions go. Without it (the history could not be kept) the files are written all the same. */
  sources?: Pick<Sources, 'recordAttention' | 'notify'>;
  log?: (line: string) => void;
}

interface AlertRow { status: AlertStatus }

export class AlertmanagerWebhook implements WebhookFormat {
  private readonly options: AlertmanagerWebhookOptions;
  private readonly lines: DayLines;

  constructor(options: AlertmanagerWebhookOptions) {
    this.options = options;
    this.lines = new DayLines(options.db, options.name, join(options.directory, options.name));
  }

  /** As the server starts: writes the newest day and what fires, in case the last process could not. */
  prepare(): Promise<void> {
    return this.lines.prepare(() => this.log('the files could not be written'), () => this.writeFiring());
  }

  /** A body in Alertmanager's shape, taken as {@link receiveNotification}; undefined when it is not one. */
  receive(body: unknown): Promise<{ recorded: number }> | undefined {
    const notification = parseNotification(body);
    return notification && this.receiveNotification(notification);
  }

  /**
   * Takes one notification: the alerts whose state changed are lines of today's file, and every alert's state and
   * latest form are kept. Resolves once the files are written; rejects when they could not be, and what was taken is
   * then written by the next notification. Returns how many lines were written.
   */
  receiveNotification(notification: AlertNotification): Promise<{ recorded: number }> {
    return this.lines.serialize(async () => {
      const { db, name, timeZone, now, sources } = this.options;
      const at = now();
      const date = localDate(at, timeZone);
      const file = `${WEBHOOKS_PATH}/${name}/${date}.jsonl`;
      let recorded = 0;
      let marked = false;
      db.exec('BEGIN');
      try {
        const known = db.prepare('SELECT status FROM webhook_alerts WHERE webhook = ? AND fingerprint = ?');
        const keep = db.prepare(`INSERT INTO webhook_alerts (webhook, fingerprint, status, starts_at, line, updated_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (webhook, fingerprint)
          DO UPDATE SET status = excluded.status, starts_at = excluded.starts_at, line = excluded.line, updated_at = excluded.updated_at`);
        for (const alert of notification.alerts) {
          const line = JSON.stringify(this.line(alert, at, notification.groupKey));
          const before = known.get(name, alert.fingerprint) as AlertRow | undefined;
          keep.run(name, alert.fingerprint, alert.status, isoAt(alert.startsAt), line, isoAt(at));
          if (before?.status === alert.status) continue;
          const index = this.lines.append(date, line, at);
          recorded += 1;
          const severity = alert.labels[SEVERITY_LABEL];
          if (alert.status === 'firing' && severity !== undefined && this.options.attentionSeverities.includes(severity) && sources) {
            marked = sources.recordAttention({ source: WEBHOOKS_SOURCE, kind: ALERT_ATTENTION, file, path: `.[${index}]`,
              details: { ...(alert.labels.alertname ? { alertname: alert.labels.alertname } : {}), severity } }) || marked;
          }
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      if (recorded > 0) this.lines.unwritten.add(date);
      await this.lines.write();
      await this.writeFiring();
      if (marked) sources?.notify();
      return { recorded };
    });
  }

  /** What fires now. */
  private async writeFiring(): Promise<void> {
    const firing = (this.options.db.prepare(`SELECT line FROM webhook_alerts WHERE webhook = ? AND status = 'firing'
      ORDER BY starts_at, fingerprint`).all(this.options.name) as { line: string }[]).map(row => row.line);
    await writeFileAtomically(join(this.lines.place, FIRING_FILE), joinLines(firing), WEBHOOK_FILE_MODE);
  }

  /**
   * One alert as its line: when it was received (natsumi's time, to the second), its state, its name and severity
   * lifted out of the labels, the labels and annotations as they came, when it began and ended, and how to find it.
   */
  private line(alert: ReceivedAlert, at: number, groupKey: string | undefined): Record<string, unknown> {
    const { alertname, [SEVERITY_LABEL]: severity } = alert.labels;
    const local = (ms: number) => localSeconds(ms, this.options.timeZone);
    return {
      at: local(at), status: alert.status, ...(alertname !== undefined ? { alertname } : {}), ...(severity !== undefined ? { severity } : {}),
      labels: alert.labels, annotations: alert.annotations, starts_at: local(alert.startsAt),
      ...(alert.endsAt !== undefined ? { ends_at: local(alert.endsAt) } : {}), fingerprint: alert.fingerprint,
      ...(alert.generatorURL ? { generator_url: alert.generatorURL } : {}), ...(groupKey ? { group_key: groupKey } : {}),
    };
  }

  private log(line: string): void { this.options.log?.(`webhooks: ${this.options.name}: ${line}`); }
}

/** An RFC 3339 time as milliseconds, or undefined. */
function instant(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function stringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
