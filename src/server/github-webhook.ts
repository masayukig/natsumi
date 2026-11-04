import type { IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isoAt, localDate } from './nightly.ts';
import type { Sources } from './sources.ts';
import { DayLines, localSeconds, WEBHOOK_ATTENTION, WEBHOOKS_PATH, WEBHOOKS_SOURCE, type WebhookFormat } from './webhooks.ts';

/**
 * The webhook format `github` (ADR 0093). A GitHub App sends every event of every repository it is installed on to one
 * URL; of them this reads only what a reviewer needs of a pull request whose review was asked of them. A pull request
 * by one of the `authors` is remembered, by the webhook's name, its repository and its number, once a
 * `review_requested` names one of the `reviewers` (a person, never a team); from then on its pushes (`synchronize`),
 * the check suites completed on it, a request of one of the reviewers taken off and its closing are each a line of the
 * day's file under `sources/webhooks/<name>/`. It is forgotten only when it is closed. Anything else is passed over
 * with a 2xx and leaves nothing; a call without `X-GitHub-Event`, or of an event it reads but not of its shape, is a 400.
 *
 * A line has fixed fields and never the body: the body of a pull request and its comments are written by others, and
 * the review reads the changes on GitHub all the same. A delivery whose `X-GitHub-Delivery` wrote a line is not read
 * again: GitHub sends nothing again by itself, and its Redeliver keeps the ID.
 *
 * As with the other formats, what is taken is in the database before any file is written, and every file is written
 * whole from it, so a delivery answered with a 5xx because its file could not be written is written by the next one or
 * at the next start; that delivery, sent again, is not taken twice.
 */

/** The events read, by `X-GitHub-Event`, and of each the actions read. */
const PULL_REQUEST_ACTIONS = new Set(['review_requested', 'review_request_removed', 'synchronize', 'closed']);
const CHECK_SUITE_ACTIONS = new Set(['completed']);
const EVENT_HEADER = 'x-github-event';
const DELIVERY_HEADER = 'x-github-delivery';
/** GitHub's delivery ID is a GUID; anything plain and short is taken. */
const DELIVERY = /^[A-Za-z0-9._-]{1,128}$/;

export interface GithubWebhookOptions {
  db: DatabaseSync;
  /** The webhook's name, its directory and the key of what it remembers. */
  name: string;
  /** `sources/webhooks` in the data directory. */
  directory: string;
  timeZone: string;
  /** The authors of the pull requests it remembers, as the config names them; matched without regard to case. */
  authors: readonly string[];
  /** The reviewers whose review asked makes a pull request remembered; matched without regard to case. */
  reviewers: readonly string[];
  /** Whether every line is an attention, told at once. */
  attention: boolean;
  now: () => number;
  /** Where the attentions go. Without it (the history could not be kept) the files are written all the same. */
  sources?: Pick<Sources, 'recordAttention' | 'notify'>;
  log?: (line: string) => void;
}

/** A pull request as a `pull_request` event has it, as far as a line needs it. */
interface PullRequest {
  repositoryId: number;
  repository: string;
  number: number;
  title: string;
  url: string;
  author: string;
  headSha: string;
  headRef: string;
  baseRef: string;
}

type Delivery =
  | { event: 'pull_request'; action: string; pull: PullRequest; reviewer?: string; merged?: boolean }
  | { event: 'check_suite'; action: string; headSha: string; conclusion: string | null;
    pulls: { repositoryId: number; number: number; headRef: string; baseRef: string }[] };

interface RememberedRow {
  repository: string;
  title: string;
  url: string;
  author: string;
  head_ref: string;
  base_ref: string;
}

export class GithubWebhook implements WebhookFormat {
  private readonly options: GithubWebhookOptions;
  private readonly lines: DayLines;
  private readonly authors: Set<string>;
  private readonly reviewers: Set<string>;

  constructor(options: GithubWebhookOptions) {
    this.options = options;
    this.lines = new DayLines(options.db, options.name, join(options.directory, options.name));
    this.authors = new Set(options.authors.map(login => login.toLowerCase()));
    this.reviewers = new Set(options.reviewers.map(login => login.toLowerCase()));
  }

  prepare(): Promise<void> {
    return this.lines.prepare(() => this.log('the files could not be written'));
  }

  /**
   * A body as GitHub delivers it, read by its `X-GitHub-Event`: undefined when that is missing, or when an event it reads
   * is not of its shape or has no `X-GitHub-Delivery`; nothing recorded for anything else. Resolves once what it wrote
   * is written, with how many lines.
   */
  receive(body: unknown, headers: IncomingHttpHeaders): Promise<{ recorded: number }> | undefined {
    const event = headers[EVENT_HEADER];
    if (typeof event !== 'string' || event === '') return undefined;
    const read = readDelivery(event, body);
    if (read === 'invalid') return undefined;
    if (read === 'passed') return Promise.resolve({ recorded: 0 });
    const delivery = headers[DELIVERY_HEADER];
    if (typeof delivery !== 'string' || !DELIVERY.test(delivery)) return undefined;
    return this.take(read, delivery);
  }

  private take(read: Delivery, delivery: string): Promise<{ recorded: number }> {
    return this.lines.serialize(async () => {
      const { db, name, timeZone, now, sources, attention } = this.options;
      const at = now();
      const date = localDate(at, timeZone);
      let recorded = 0;
      let marked = false;
      db.exec('BEGIN');
      try {
        const known = db.prepare('SELECT 1 FROM webhook_deliveries WHERE webhook = ? AND delivery = ?').get(name, delivery);
        const lines = known ? [] : this.linesOf(read, at);
        for (const fields of lines) {
          const line = { at: localSeconds(at, timeZone), event: read.event, action: read.action, delivery, ...fields };
          const index = this.lines.append(date, JSON.stringify(line), at);
          recorded += 1;
          if (attention && sources) {
            marked = sources.recordAttention({ source: WEBHOOKS_SOURCE, kind: WEBHOOK_ATTENTION,
              file: `${WEBHOOKS_PATH}/${name}/${date}.jsonl`, path: `.[${index}]` }) || marked;
          }
        }
        if (recorded > 0) db.prepare('INSERT INTO webhook_deliveries (webhook, delivery, received_at) VALUES (?, ?, ?)').run(name, delivery, isoAt(at));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      if (recorded > 0) this.lines.unwritten.add(date);
      // What an earlier delivery left unwritten is written now, a delivery sent again among them.
      await this.lines.write();
      if (marked) sources?.notify();
      return { recorded };
    });
  }

  /**
   * The lines a delivery makes, in the caller's transaction, remembering and forgetting as it goes: the fields after
   * `at`, `event`, `action` and `delivery`.
   */
  private linesOf(read: Delivery, at: number): Record<string, unknown>[] {
    if (read.event === 'check_suite') {
      const lines: Record<string, unknown>[] = [];
      for (const pull of read.pulls) {
        const row = this.remembered(pull.repositoryId, pull.number);
        if (!row) continue;
        lines.push({ repository: row.repository, number: pull.number, title: row.title, url: row.url, author: row.author,
          head_sha: read.headSha, head_ref: pull.headRef, base_ref: pull.baseRef, conclusion: read.conclusion });
      }
      return lines;
    }
    const { pull, action } = read;
    const fields = { repository: pull.repository, number: pull.number, title: pull.title, url: pull.url, author: pull.author,
      head_sha: pull.headSha, head_ref: pull.headRef, base_ref: pull.baseRef };
    const ofReviewer = read.reviewer !== undefined && this.reviewers.has(read.reviewer.toLowerCase());
    if (action === 'review_requested') {
      if (!ofReviewer || !this.authors.has(pull.author.toLowerCase())) return [];
      this.remember(pull, at);
      return [{ ...fields, reviewer: read.reviewer }];
    }
    if (!this.remembered(pull.repositoryId, pull.number)) return [];
    if (action === 'review_request_removed') {
      if (!ofReviewer) return [];
      this.remember(pull, at);
      return [{ ...fields, reviewer: read.reviewer }];
    }
    if (action === 'closed') {
      this.options.db.prepare('DELETE FROM webhook_pull_requests WHERE webhook = ? AND repository_id = ? AND number = ?')
        .run(this.options.name, pull.repositoryId, pull.number);
      return [{ ...fields, merged: read.merged }];
    }
    this.remember(pull, at);
    return [fields];
  }

  private remembered(repositoryId: number, number: number): RememberedRow | undefined {
    return this.options.db.prepare(`SELECT repository, title, url, author, head_ref, base_ref FROM webhook_pull_requests
      WHERE webhook = ? AND repository_id = ? AND number = ?`).get(this.options.name, repositoryId, number) as RememberedRow | undefined;
  }

  /** Remembers a pull request, or keeps what a check suite's line is written with as the pull request has it now. */
  private remember(pull: PullRequest, at: number): void {
    this.options.db.prepare(`INSERT INTO webhook_pull_requests (webhook, repository_id, number, repository, title, url, author, head_ref,
      base_ref, remembered_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (webhook, repository_id, number)
      DO UPDATE SET repository = excluded.repository, title = excluded.title, url = excluded.url, author = excluded.author,
      head_ref = excluded.head_ref, base_ref = excluded.base_ref, updated_at = excluded.updated_at`)
      .run(this.options.name, pull.repositoryId, pull.number, pull.repository, pull.title, pull.url, pull.author, pull.headRef, pull.baseRef,
        isoAt(at), isoAt(at));
  }

  private log(line: string): void { this.options.log?.(`webhooks: ${this.options.name}: ${line}`); }
}

/**
 * A body by its event: what it is when the event and its action are read, `passed` when they are not, and `invalid`
 * when they are but the body is not of their shape (GitHub's payloads, as far as a line needs them).
 */
export function readDelivery(event: string, body: unknown): Delivery | 'passed' | 'invalid' {
  if (event !== 'pull_request' && event !== 'check_suite') return 'passed';
  if (!isRecord(body) || typeof body.action !== 'string') return 'invalid';
  const { action } = body;
  if (event === 'check_suite') {
    if (!CHECK_SUITE_ACTIONS.has(action)) return 'passed';
    const suite = body.check_suite;
    if (!isRecord(suite) || typeof suite.head_sha !== 'string' || !(suite.conclusion === null || typeof suite.conclusion === 'string')
      || !Array.isArray(suite.pull_requests)) return 'invalid';
    const pulls: { repositoryId: number; number: number; headRef: string; baseRef: string }[] = [];
    for (const item of suite.pull_requests as unknown[]) {
      if (!isRecord(item) || !isNumber(item.number) || !isRecord(item.head) || typeof item.head.ref !== 'string'
        || !isRecord(item.base) || typeof item.base.ref !== 'string' || !isRecord(item.base.repo) || !isNumber(item.base.repo.id)) return 'invalid';
      pulls.push({ repositoryId: item.base.repo.id, number: item.number, headRef: item.head.ref, baseRef: item.base.ref });
    }
    return { event, action, headSha: suite.head_sha, conclusion: suite.conclusion as string | null, pulls };
  }
  if (!PULL_REQUEST_ACTIONS.has(action)) return 'passed';
  const pull = pullRequestOf(body);
  if (!pull) return 'invalid';
  if (action === 'review_requested' || action === 'review_request_removed') {
    // A person's request names the reviewer; a team's names the team, which is matched against no reviewer.
    const { requested_reviewer: reviewer, requested_team: team } = body;
    if (isRecord(reviewer) && typeof reviewer.login === 'string') return { event, action, pull, reviewer: reviewer.login };
    if (isRecord(team)) return { event, action, pull };
    return 'invalid';
  }
  if (action === 'closed') {
    const merged = (body.pull_request as Record<string, unknown>).merged;
    return typeof merged === 'boolean' ? { event, action, pull, merged } : 'invalid';
  }
  return { event, action, pull };
}

function pullRequestOf(body: Record<string, unknown>): PullRequest | undefined {
  const { pull_request: pull, repository } = body;
  if (!isRecord(pull) || !isRecord(repository) || !isNumber(repository.id) || typeof repository.full_name !== 'string') return undefined;
  const { number, html_url: url, title, user, head, base } = pull;
  if (!isNumber(number) || typeof url !== 'string' || typeof title !== 'string' || !isRecord(user) || typeof user.login !== 'string'
    || !isRecord(head) || typeof head.sha !== 'string' || typeof head.ref !== 'string' || !isRecord(base) || typeof base.ref !== 'string') return undefined;
  return { repositoryId: repository.id, repository: repository.full_name, number, title, url, author: user.login,
    headSha: head.sha, headRef: head.ref, baseRef: base.ref };
}

function isNumber(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
