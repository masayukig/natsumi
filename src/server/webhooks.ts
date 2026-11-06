import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { WebhookConfig, WebhookFormatConfig } from './config.ts';
import { isoAt, localDate, localIso } from './nightly.ts';
import { writeFileAtomically } from './paths.ts';
import type { SourceRegistration, Sources } from './sources.ts';
import { SOURCES_PATH } from './view.ts';

/**
 * The webhooks (ADR 0091): one way in, `POST /v1/webhooks/<name>`, for every sender the config names, each checked by a
 * bearer token or by GitHub's HMAC of the body, and each read as its format. What comes is put under
 * `sources/webhooks/<name>/` and told to her with `sources_updated`. The formats are natsumi's own, a closed set: `raw`,
 * here, puts each body as it came as a line of the day's file, and `alertmanager` (`alertmanager.ts`) keeps the state of
 * every alert and writes a line only when it changes, and `github` (`github-webhook.ts`, ADR 0093) only what befalls a
 * pull request whose review was asked.
 */

/** The source's name, its directory under `sources/`. */
export const WEBHOOKS_SOURCE = 'webhooks';
/** Where the webhooks are, as the workspace names it. */
export const WEBHOOKS_PATH = `${SOURCES_PATH}/${WEBHOOKS_SOURCE}`;
/** What the server writes in every webhook's directory from the config. */
export const README_FILE = 'README.md';
/** What fires now, in the directory of a webhook of the format `alertmanager`. */
export const FIRING_FILE = 'firing.jsonl';
/** Measured by the webhook. The README is the config's and what fires now is the day files' lines over again. */
export const WEBHOOKS_REGISTRATION: SourceRegistration = { name: WEBHOOKS_SOURCE, depth: 1, exclude: [`*/${README_FILE}`, `*/${FIRING_FILE}`] };
/** A body at most, of any format. */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
/** The attention's kind of a `raw` webhook told to mark, as the manual names it. */
export const WEBHOOK_ATTENTION = 'webhook';
/** GitHub's signature of the body: `sha256=<hex>`. */
export const SIGNATURE_HEADER = 'x-hub-signature-256';
/** The manual of the source, which every README points to. */
const MANUAL = '/manual/webhooks.md';
export const WEBHOOK_FILE_MODE = 0o640;

/** What a call brings to be checked: its bearer token, its signature header and the body as it came. */
export interface WebhookCall { token?: string; signature?: string; body?: Buffer }
export type WebhookCredential = { token: string } | { secret: string };

export interface WebhookGate {
  /** How a webhook is checked: a bearer before its body is read, or a signature after. An unknown name is a bearer's. */
  scheme(name: string): 'bearer' | 'signature';
  allowed(name: string, call: WebhookCall): boolean;
}

/**
 * Whether a call is a webhook's own. A token is compared by its digest, and a signature by the digest of the one the
 * body would have, in a time that does not depend on where they differ; an unknown name is compared against what no
 * call can have. A caller learns nothing of which part was wrong.
 */
export function webhookGate(credentials: ReadonlyMap<string, WebhookCredential>): WebhookGate {
  const known = new Map<string, { kind: 'bearer'; digest: Buffer } | { kind: 'signature'; secret: string }>();
  for (const [name, credential] of credentials) {
    known.set(name, 'token' in credential ? { kind: 'bearer', digest: digest(credential.token) } : { kind: 'signature', secret: credential.secret });
  }
  const nobody = digest(`no webhook ${Math.random()}`);
  return {
    scheme: name => known.get(name)?.kind ?? 'bearer',
    allowed: (name, call) => {
      const expected = known.get(name);
      if (expected?.kind === 'signature') {
        const signature = `sha256=${createHmac('sha256', expected.secret).update(call.body ?? Buffer.alloc(0)).digest('hex')}`;
        const matches = timingSafeEqual(digest(call.signature ?? ''), digest(signature));
        return call.signature !== undefined && call.body !== undefined && matches;
      }
      const matches = timingSafeEqual(digest(call.token ?? ''), expected?.digest ?? nobody);
      return expected !== undefined && call.token !== undefined && matches;
    },
  };
}

/** One webhook's format, as the way in hands it a body read as JSON. */
export interface WebhookFormat {
  /** As the server starts: writes what the last process could not. */
  prepare(): Promise<void>;
  /**
   * Takes a body: undefined at once when it is not of the format's shape, or a promise that resolves once it is written
   * and rejects when it could not be, which the way in answers with a 5xx for the sender to send it again.
   */
  receive(body: unknown, headers: IncomingHttpHeaders): Promise<{ recorded: number }> | undefined;
}

/** What README.md is written from: the config of a webhook, without how it is checked. */
export type WebhookReadme = Pick<WebhookConfig, 'name' | 'description'> & WebhookFormatConfig;

/**
 * Writes a webhook's README.md from its config: its format, what the format is told to do, and the description, which
 * is how she is to read it. Written afresh on every start and left out of the history: a change of the config is no
 * change of the source.
 */
export async function writeReadme(directory: string, webhook: WebhookReadme): Promise<void> {
  const place = join(directory, webhook.name);
  await mkdir(place, { recursive: true, mode: 0o750 });
  const settings = webhook.format === 'raw'
    ? [
      `- 型: \`raw\`（届いた 1 回が、日付のファイルの 1 行。読み方は \`${MANUAL}\` の「型 raw」）`,
      `- 行に残すヘッダー: ${webhook.headers.length > 0 ? webhook.headers.map(header => `\`${header}\``).join('・') : 'なし'}`,
      `- 印（attention）: ${webhook.attention ? '届くたびに付きます（`kind` は `webhook`）' : '付きません。ふつうの変化として届きます'}`,
    ]
    : webhook.format === 'github'
    ? [
      `- 型: \`github\`（レビューを頼まれた PR の出来事だけが、日付のファイルの 1 行。読み方は \`${MANUAL}\` の「型 github」）`,
      `- 扱う PR の作者: ${webhook.authors.map(login => `\`${login}\``).join('・')}`,
      `- レビューを頼まれる人: ${webhook.reviewers.map(login => `\`${login}\``).join('・')}`,
      `- 印（attention）: ${webhook.attention ? '行を書くたびに付きます（`kind` は `webhook`）' : '付きません。ふつうの変化として届きます'}`,
    ]
    : [
      `- 型: \`alertmanager\`（Alertmanager のアラート。読み方は \`${MANUAL}\` の「型 alertmanager」）`,
      `- 印（attention）: ${webhook.attentionSeverities.length > 0
        ? `\`severity\` が ${webhook.attentionSeverities.map(severity => `\`${severity}\``).join('・')} のアラートが鳴り始めたとき（\`kind\` は \`alert\`）`
        : '付きません。ふつうの変化として届きます'}`,
    ];
  const text = [
    `# webhook \`${webhook.name}\``,
    '',
    'マスターの設定から、サーバーが書いたファイルです。起動のたびに書き直します。差分（`sources-diff`）には出ません。',
    '',
    ...settings,
    '',
    '## この webhook について',
    '',
    webhook.description.trim(),
    '',
  ].join('\n');
  await writeFileAtomically(join(place, README_FILE), text, WEBHOOK_FILE_MODE);
}

export interface RawWebhookOptions {
  db: DatabaseSync;
  /** The webhook's name, its directory. */
  name: string;
  /** `sources/webhooks` in the data directory. */
  directory: string;
  timeZone: string;
  /** The headers kept on each line, as the config names them. */
  headers: readonly string[];
  /** Whether every line is an attention, told at once. */
  attention: boolean;
  now: () => number;
  /** Where the attentions go. Without it (the history could not be kept) the files are written all the same. */
  sources?: Pick<Sources, 'recordAttention' | 'notify'>;
  log?: (line: string) => void;
}

/**
 * The format `raw`: each body, any JSON, is a line of the day's file with when it came and the headers the config
 * names. Nothing is left out as sent again. The line is in the database before the file is written, and every file is
 * written whole from it, so a body answered with a 5xx because its file could not be written is written by the next.
 */
export class RawWebhook implements WebhookFormat {
  private readonly options: RawWebhookOptions;
  private readonly lines: DayLines;

  constructor(options: RawWebhookOptions) {
    this.options = options;
    this.lines = new DayLines(options.db, options.name, join(options.directory, options.name));
  }

  prepare(): Promise<void> {
    return this.lines.prepare(() => this.log('the files could not be written'));
  }

  receive(body: unknown, headers: IncomingHttpHeaders): Promise<{ recorded: number }> {
    return this.lines.serialize(async () => {
      const { db, name, timeZone, now, sources, attention } = this.options;
      const at = now();
      const date = localDate(at, timeZone);
      const kept = this.headersOf(headers);
      const line = JSON.stringify({ at: localSeconds(at, timeZone), ...(kept ? { headers: kept } : {}), body });
      let marked = false;
      db.exec('BEGIN');
      try {
        const index = this.lines.append(date, line, at);
        if (attention && sources) {
          marked = sources.recordAttention({ source: WEBHOOKS_SOURCE, kind: WEBHOOK_ATTENTION,
            file: `${WEBHOOKS_PATH}/${name}/${date}.jsonl`, path: `.[${index}]` });
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      this.lines.unwritten.add(date);
      await this.lines.write();
      if (marked) sources?.notify();
      return { recorded: 1 };
    });
  }

  /** The headers the config names that came, by the config's names; undefined when it names none. */
  private headersOf(headers: IncomingHttpHeaders): Record<string, string> | undefined {
    if (this.options.headers.length === 0) return undefined;
    const kept: Record<string, string> = {};
    for (const header of this.options.headers) {
      const value = headers[header.toLowerCase()];
      if (value !== undefined) kept[header] = Array.isArray(value) ? value.join(', ') : value;
    }
    return kept;
  }

  private log(line: string): void { this.options.log?.(`webhooks: ${this.options.name}: ${line}`); }
}

/**
 * The lines of one webhook's day files, kept in `webhook_lines` and written whole from there, one file at a time, in
 * the order of the work handed to `serialize`.
 */
export class DayLines {
  /** The day files whose lines changed and that are not yet written. */
  readonly unwritten = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly db: DatabaseSync;
  private readonly webhook: string;
  /** The webhook's own directory. */
  readonly place: string;

  constructor(db: DatabaseSync, webhook: string, place: string) {
    this.db = db;
    this.webhook = webhook;
    this.place = place;
  }

  /** As the server starts: the newest day is written again, in case the last process could not. */
  prepare(failed: () => void, more: () => Promise<void> = async () => {}): Promise<void> {
    return this.serialize(async () => {
      const row = this.db.prepare('SELECT MAX(file_date) AS file_date FROM webhook_lines WHERE webhook = ?').get(this.webhook) as
        { file_date: string | null } | undefined;
      if (!row?.file_date) return;
      this.unwritten.add(row.file_date);
      try { await this.write(); await more(); } catch { failed(); }
    });
  }

  /** Adds a line to a day, in the caller's transaction, and gives its place in the file (its `jq -s` index). */
  append(date: string, line: string, at: number): number {
    const { lines } = this.db.prepare('SELECT COUNT(*) AS lines FROM webhook_lines WHERE webhook = ? AND file_date = ?')
      .get(this.webhook, date) as { lines: number };
    this.db.prepare('INSERT INTO webhook_lines (webhook, file_date, line, created_at) VALUES (?, ?, ?, ?)').run(this.webhook, date, line, isoAt(at));
    return lines;
  }

  /** Writes the day files not yet written. */
  async write(): Promise<void> {
    await mkdir(this.place, { recursive: true, mode: 0o750 });
    for (const date of [...this.unwritten].sort()) {
      const lines = (this.db.prepare('SELECT line FROM webhook_lines WHERE webhook = ? AND file_date = ? ORDER BY line_id')
        .all(this.webhook, date) as { line: string }[]).map(row => row.line);
      await writeFileAtomically(join(this.place, `${date}.jsonl`), joinLines(lines), WEBHOOK_FILE_MODE);
      this.unwritten.delete(date);
    }
  }

  serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

/** `2026-10-30 10:00:05`, as the Slack files write their times. */
export function localSeconds(ms: number, timeZone: string): string { return localIso(ms, timeZone).slice(0, 19).replace('T', ' '); }

export function joinLines(lines: string[]): string { return lines.length > 0 ? `${lines.join('\n')}\n` : ''; }

function digest(text: string): Buffer { return createHash('sha256').update(text).digest(); }

export interface WebhooksOptions {
  /** `sources/webhooks` in the data directory. */
  directory: string;
  /** Every webhook of the config, with its format made and the token or secret read from its file. */
  webhooks: { config: WebhookConfig; credential: WebhookCredential; format: WebhookFormat }[];
  log?: (line: string) => void;
}

/** Every webhook of the config, as the way in reaches them: who may call which, and the format each body goes to. */
export class Webhooks {
  readonly gate: WebhookGate;
  private readonly options: WebhooksOptions;
  private readonly formats: Map<string, WebhookFormat>;

  constructor(options: WebhooksOptions) {
    this.options = options;
    this.gate = webhookGate(new Map(options.webhooks.map(({ config, credential }) => [config.name, credential])));
    this.formats = new Map(options.webhooks.map(({ config, format }) => [config.name, format]));
  }

  /** As the server starts: every README.md from the config, and what each format left unwritten. */
  async prepare(): Promise<void> {
    for (const { config, format } of this.options.webhooks) {
      try { await writeReadme(this.options.directory, config); } catch { this.options.log?.(`webhooks: ${config.name}: README.md could not be written`); }
      await format.prepare();
    }
  }

  /** A body of a webhook the gate let in, as {@link WebhookFormat.receive}. */
  receive(name: string, body: unknown, headers: IncomingHttpHeaders): Promise<{ recorded: number }> | undefined {
    const format = this.formats.get(name);
    if (!format) throw new Error(`no webhook ${name}`);
    return format.receive(body, headers);
  }
}
