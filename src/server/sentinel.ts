import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isoAt } from './nightly.ts';
import { writeFileAtomically } from './paths.ts';
import type { PushEvent } from './push.ts';
import { APPROVAL_ID, type SentinelApproval, type SentinelClient, type SentinelGrant } from './sentinel-client.ts';
import type { Attention, SourceRegistration } from './sources.ts';
import { SOURCES_PATH } from './view.ts';

/**
 * The sentinel's events, followed for as long as the server runs (ADR 0096). The stream is opened on the approvals
 * socket and opened again whenever it ends, fails, or goes quiet past its pings. Each time it opens, the open approvals
 * are read from the list, so what opened while it was down is told too.
 *
 * - An approval that opens is told once, as a Web Push to the browsers (`sentinel.approval` to the listeners).
 * - An approval that closes — allowed, denied, or expired by the sentinel — is put as a file under
 *   `/sources/sentinel/approvals/<id>.json`, with an attention of the source `sentinel`. Penelope reads it and asks again.
 *
 * Which were told is the one thing kept here, in `sentinel_approvals`; the approvals are the sentinel's. A revoke is
 * never told: the sentinel does not stream it, and she learns of it from its next 403.
 */

export const SENTINEL_SOURCE = 'sentinel';
/** Measured by the directory under it: `approvals`. */
export const SENTINEL_REGISTRATION: SourceRegistration = { name: SENTINEL_SOURCE, depth: 1 };
/** The attention's kind of an approval that closed, as the manual names it. */
export const SENTINEL_ATTENTION = 'approval_closed';
/** Where the closed approvals are, as the workspace names it. */
export const SENTINEL_APPROVALS_PATH = `${SOURCES_PATH}/${SENTINEL_SOURCE}/approvals`;
/** The event the listeners are given for an approval that opened. */
export const SENTINEL_PUSH_EVENT = 'sentinel.approval';

/** The sentinel pings every 30 seconds; two missed and a half is a stream gone quiet. */
const PING_TIMEOUT_MS = 75_000;
/** The waits before each try to open the stream again, the last one repeated. */
const RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];
const FILE_MODE = 0o640;

export interface SentinelPlace {
  recordAttention(attention: Attention): boolean;
  notify(): void;
}

export interface SentinelWatcherOptions {
  client: SentinelClient;
  db: DatabaseSync;
  /** `sources/sentinel` in the data directory. */
  directory: string;
  /** Where the attentions go. Without it the files are still put, and she hears of them as ordinary changes, or not at all. */
  sources?: SentinelPlace;
  now: () => number;
  /** Fixed lines and ids only: never a summary or a parameter, which may be anyone's words. */
  log: (line: string) => void;
  reconnectDelaysMs?: readonly number[];
  pingTimeoutMs?: number;
}

export class SentinelWatcher {
  private readonly options: SentinelWatcherOptions;
  private readonly listeners = new Set<(event: PushEvent) => void>();
  private current: AbortController | undefined;
  private wake: (() => void) | undefined;
  private closed = false;
  private live = false;

  constructor(options: SentinelWatcherOptions) {
    this.options = options;
  }

  /** Whether the stream of events is open now. */
  get connected(): boolean { return this.live; }

  subscribe(listener: (event: PushEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Begins following, in the background; a socket that is not there is tried again, and never stops the server. */
  start(): void {
    void this.run().catch(() => { this.options.log('sentinel: following the events stopped'); });
  }

  close(): void {
    this.closed = true;
    this.current?.abort();
    this.wake?.();
  }

  private async run(): Promise<void> {
    const delays = this.options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
    let failures = 0;
    while (!this.closed) {
      const controller = this.current = new AbortController();
      const opened = await this.options.client.events(controller.signal);
      if (opened.kind === 'ok') {
        let quiet: NodeJS.Timeout | undefined;
        const arm = () => {
          clearTimeout(quiet);
          quiet = setTimeout(() => { controller.abort(); }, this.options.pingTimeoutMs ?? PING_TIMEOUT_MS);
        };
        arm();
        try {
          for await (const event of opened.value) {
            arm();
            if (this.closed) break;
            if (event.type === 'hello') {
              this.live = true;
              failures = 0;
              this.options.log('sentinel: connected to the events');
              await this.catchUp();
            } else if (event.type === 'approval.created') await this.opened(event.approval);
            else if (event.type === 'approval.closed') await this.closedOne(event.approval);
          }
        } finally { clearTimeout(quiet); }
        if (this.live) {
          this.live = false;
          if (!this.closed) this.options.log('sentinel: the events stream ended; connecting again');
        }
      } else if (failures === 0 && !this.closed) {
        this.options.log(opened.kind === 'unreachable' ? 'sentinel: the approvals socket cannot be reached; trying again'
          : `sentinel: the events were refused with ${opened.status}; trying again`);
      }
      if (this.closed) break;
      const delay = delays[Math.min(failures, delays.length - 1)] ?? 1_000;
      failures += 1;
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
      this.wake = undefined;
    }
  }

  /**
   * As the stream opens: the open approvals not told yet are told, and those told that are no longer open are read
   * one by one, so one that closed while the stream was down is put too.
   */
  private async catchUp(): Promise<void> {
    const open = await this.options.client.approvals();
    if (open.kind !== 'ok') {
      this.options.log('sentinel: the open approvals could not be read');
      return;
    }
    for (const approval of open.value) await this.opened(approval);
    const stillOpen = new Set(open.value.map(approval => approval.id));
    const waiting = this.options.db.prepare('SELECT approval_id FROM sentinel_approvals WHERE closed_at IS NULL ORDER BY approval_id')
      .all() as { approval_id: string }[];
    for (const { approval_id: id } of waiting) {
      if (stillOpen.has(id) || this.closed) continue;
      const found = await this.options.client.approval(id);
      if (found.kind === 'ok' && found.value.state !== 'open') await this.closedOne(found.value);
      else if (found.kind === 'refused' && found.status === 404) {
        this.options.db.prepare('UPDATE sentinel_approvals SET closed_at = ? WHERE approval_id = ?').run(isoAt(this.options.now()), id);
        this.options.log(`sentinel: ${id} is no longer known to the sentinel; it is not put`);
      }
    }
  }

  private async opened(approval: SentinelApproval): Promise<void> {
    if (approval.state !== 'open') return this.closedOne(approval);
    const inserted = this.options.db.prepare('INSERT INTO sentinel_approvals (approval_id, notified_at) VALUES (?, ?) ON CONFLICT DO NOTHING')
      .run(approval.id, isoAt(this.options.now()));
    if (Number(inserted.changes) === 0) return;
    const event: PushEvent = { type: SENTINEL_PUSH_EVENT, payload: { approvalId: approval.id, summary: approval.summary } };
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* one listener's failure is not another's */ }
    }
  }

  /** Puts a closed approval's file and marks it for her, once. */
  private async closedOne(approval: SentinelApproval): Promise<void> {
    if (approval.state === 'open' || !APPROVAL_ID.test(approval.id)) return;
    const { db, directory, now, log } = this.options;
    const row = db.prepare('SELECT closed_at FROM sentinel_approvals WHERE approval_id = ?').get(approval.id) as { closed_at: string | null } | undefined;
    if (row?.closed_at) return;
    const grants = approval.grants.length > 0 ? await this.options.client.grants() : undefined;
    const known = new Map((grants?.kind === 'ok' ? grants.value : []).map(grant => [grant.id, grant]));
    try {
      await mkdir(join(directory, 'approvals'), { recursive: true, mode: 0o750 });
      await writeFileAtomically(join(directory, 'approvals', `${approval.id}.json`), `${JSON.stringify(closedFile(approval, known), null, 2)}\n`, FILE_MODE);
    } catch {
      log(`sentinel: the file of ${approval.id} could not be written; it is tried again when the stream opens`);
      db.prepare('INSERT INTO sentinel_approvals (approval_id) VALUES (?) ON CONFLICT DO NOTHING').run(approval.id);
      return;
    }
    const file = `${SENTINEL_APPROVALS_PATH}/${approval.id}.json`;
    const marked = this.options.sources?.recordAttention({ source: SENTINEL_SOURCE, kind: SENTINEL_ATTENTION, file,
      details: { approval: approval.id, state: approval.state, summary: approval.summary } }) ?? false;
    db.prepare(`INSERT INTO sentinel_approvals (approval_id, closed_at) VALUES (?, ?)
      ON CONFLICT (approval_id) DO UPDATE SET closed_at = excluded.closed_at`).run(approval.id, isoAt(now()));
    if (marked) this.options.sources?.notify();
    else log(`sentinel: ${approval.id} was put with no attention`);
  }
}

/**
 * The file of a closed approval: the facts the sentinel gave of it — what was asked and what its connector looked up,
 * how it ended, the choice and the grants it made with their ends — without the request's body or fingerprint, which
 * she sent herself.
 */
function closedFile(approval: SentinelApproval, grants: ReadonlyMap<string, SentinelGrant>): Record<string, unknown> {
  const choice = approval.choice === undefined ? undefined : approval.choices.find(candidate => candidate.id === approval.choice);
  return {
    id: approval.id, kind: approval.kind, state: approval.state, source: approval.source, created: approval.created, expires: approval.expires,
    ...(approval.answered ? { answered: approval.answered } : {}), summary: approval.summary,
    items: approval.items.map(item => ({
      destination: item.destination, ...(item.method ? { method: item.method } : {}), ...(item.path ? { path: item.path } : {}),
      ...(item.query ? { query: item.query } : {}), ...(item.operation ? { operation: item.operation } : {}),
      ...(item.params.length > 0 ? { params: item.params } : {}), ...(item.target.length > 0 ? { target: item.target } : {}),
      ...(item.targetText ? { targetText: item.targetText } : {}), ...(item.facts.length > 0 ? { facts: item.facts } : {}),
    })),
    ...(choice ? { choice } : approval.choice ? { choice: { id: approval.choice } } : {}),
    grants: approval.grants.map(id => {
      const grant = grants.get(id);
      return grant ? { id, scope: grant.scope, ...(grant.expires ? { expires: grant.expires } : {}), summary: grant.summary } : { id };
    }),
  };
}
