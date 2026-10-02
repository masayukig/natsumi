import type { DatabaseSync } from 'node:sqlite';
import type { DecideInput, DecideOutcome } from './dove.ts';
import { outcome, reason, where, type ApprovalRow, type Shown } from './slack-approvals.ts';

/**
 * Fork (ADR F04): the owner talks with her over Signal, through the JSON-RPC and event stream of a signal-cli daemon.
 * Nothing here logs a phone number or what anyone said.
 */

/** What is asked of the daemon. Tests hand in a stand-in. */
export interface SignalApi {
  /** Sends a message to the owner and answers Signal's timestamp of it, which a reaction or a quote points back at. */
  send(message: string, attachments?: string[]): Promise<number>;
  /** The daemon's events, one parsed `data:` each, until the stream ends or `signal` aborts. */
  events(signal: AbortSignal): AsyncIterable<Record<string, unknown>>;
}

export function connectSignal(config: { url: string; account: string; owner: string }): SignalApi {
  let id = 0;
  return {
    async send(message, attachments) {
      const response = await fetch(`${config.url}/api/v1/rpc`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'send',
          params: { account: config.account, recipient: [config.owner], message, ...(attachments?.length ? { attachments } : {}) } }),
      });
      if (!response.ok) throw new Error(`http ${response.status}`);
      const body = await response.json() as { result?: { timestamp?: unknown; results?: { type?: unknown }[] }; error?: { code?: unknown } };
      if (body.error) throw new Error(`rpc error ${String(body.error.code)}`);
      const failed = body.result?.results?.find(result => result.type !== 'SUCCESS');
      if (failed) throw new Error(`send ${String(failed.type)}`);
      if (typeof body.result?.timestamp !== 'number') throw new Error('no timestamp');
      return body.result.timestamp;
    },
    async *events(signal) {
      const response = await fetch(`${config.url}/api/v1/events?account=${encodeURIComponent(config.account)}`,
        { headers: { accept: 'text/event-stream' }, signal });
      if (!response.ok || !response.body) throw new Error(`http ${response.status}`);
      let buffer = '';
      let data: string[] = [];
      for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, '');
          buffer = buffer.slice(end + 1);
          if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          else if (line === '' && data.length > 0) {
            const text = data.join('\n');
            data = [];
            try { yield JSON.parse(text) as Record<string, unknown>; } catch { /* not an event of ours */ }
          }
        }
      }
    },
  };
}

interface Envelope {
  sourceNumber?: unknown;
  timestamp?: unknown;
  dataMessage?: {
    timestamp?: unknown; message?: unknown;
    reaction?: { emoji?: unknown; targetSentTimestamp?: unknown; isRemove?: unknown };
    quote?: { id?: unknown };
  };
}

/** The longest wait between tries to reach the daemon's event stream. */
const MAX_BACKOFF_MS = 60_000;

/**
 * What the owner says on Signal goes to `say` as a message of the conversation; a reaction or a quoted reply to an
 * approval goes to `approvals`. Everything else that arrives (receipts, typing, profile keys, other people) is let go.
 * The stream is reconnected with a growing wait whenever it drops.
 */
export interface SignalOwnerOptions {
  api: SignalApi; owner: string;
  say: (input: { requestId: string; text: string }) => void;
  approvals?: SignalApprovals;
  log?: (line: string) => void;
  /** The first wait before opening the stream again; it doubles up to a minute. */
  backoffMs?: number;
}

export class SignalOwner {
  private readonly options: SignalOwnerOptions;
  private readonly controller = new AbortController();
  private running: Promise<void> | undefined;

  constructor(options: SignalOwnerOptions) { this.options = options; }

  start(): void { this.running ??= this.run(); }

  async stop(): Promise<void> {
    this.controller.abort();
    await this.running;
  }

  /** One event of the stream, as the daemon writes it after `data:`. */
  handle(event: Record<string, unknown>): void {
    const envelope = event.envelope as Envelope | undefined;
    // Early envelopes had no UUID, so the owner is known by the number.
    if (envelope?.sourceNumber !== this.options.owner) return;
    const message = envelope.dataMessage;
    if (!message) return;
    const { approvals } = this.options;
    if (message.reaction) {
      const { emoji, targetSentTimestamp, isRemove } = message.reaction;
      if (approvals && isRemove !== true && typeof emoji === 'string' && typeof targetSentTimestamp === 'number') {
        approvals.react(targetSentTimestamp, emoji);
      }
      return;
    }
    if (typeof message.message !== 'string' || message.message.trim() === '') return;
    const quoted = message.quote?.id;
    if (approvals && typeof quoted === 'number' && approvals.answer(quoted, message.message)) return;
    const timestamp = message.timestamp ?? envelope.timestamp;
    this.options.say({ requestId: `signal:${String(timestamp)}`, text: message.message });
  }

  private async run(): Promise<void> {
    const { signal } = this.controller;
    const first = this.options.backoffMs ?? 1_000;
    let wait = first;
    let up = false;
    while (!signal.aborted) {
      try {
        for await (const event of this.options.api.events(signal)) {
          if (!up) { up = true; wait = first; this.log('the event stream is open'); }
          this.handle(event);
        }
        if (up) this.log('the event stream ended; reconnecting');
      } catch {
        if (signal.aborted) return;
        if (up) this.log('the event stream dropped; reconnecting');
        else if (wait === first) this.log('the event stream could not be opened; trying again');
      }
      up = false;
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, wait);
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      wait = Math.min(wait * 2, MAX_BACKOFF_MS);
    }
  }

  private log(line: string): void { this.options.log?.(`signal: ${line}`); }
}

/**
 * Sends natsumi's lines to the owner on Signal, one at a time: replies to a message asked on Signal, notices, and
 * replies to no message. A reply to a message asked elsewhere is answered there. Images go as data URIs; when the
 * daemon refuses them, the text goes alone.
 */
export function relayToSignal(options: {
  loop: { subscribe(listener: (event: { type: string; payload: Record<string, unknown> }) => void): () => void };
  api: SignalApi;
  images: { read(imageId: string): Promise<{ mimeType: string; data: Buffer } | undefined> };
  askedOnSignal: (eventId: string) => boolean;
  log?: (line: string) => void;
}): () => void {
  let chain: Promise<void> = Promise.resolve();
  return options.loop.subscribe(({ type, payload }) => {
    if (type !== 'conversation.message' || payload.role !== 'natsumi' || typeof payload.text !== 'string') return;
    if (typeof payload.replyTo === 'string' && !options.askedOnSignal(payload.replyTo)) return;
    const text = payload.text;
    const shown = Array.isArray(payload.images) ? payload.images as { imageId: string }[] : [];
    chain = chain.then(async () => {
      const attachments: string[] = [];
      for (const image of shown) {
        const read = await options.images.read(image.imageId);
        if (read) attachments.push(`data:${read.mimeType};base64,${read.data.toString('base64')}`);
      }
      try {
        await options.api.send(text, attachments);
      } catch (error) {
        if (attachments.length === 0) { options.log?.(`signal: sending to the owner failed (${describe(error)})`); return; }
        options.log?.(`signal: sending with images failed (${describe(error)}); sending the text alone`);
        await options.api.send(text).catch(again => { options.log?.(`signal: sending to the owner failed (${describe(again)})`); });
      }
    });
  });
}

/**
 * The dove's drafts handed to the owner (ADR F02's counterpart on Signal). Each approval is sent once; a 👍 on it
 * approves, a 👎 or ❌ declines, and a quoted reply of 送る/ok or 見送る/no does the same. Both go to the dove's own
 * `decide`, which takes the first decision from whichever channel. Signal cannot edit a message, so when the approval
 * closes, a short line says what came of it.
 *
 * Which approval was sent at which timestamp is kept in a table of this fork's own, made here, as F02 does.
 */
export interface SignalApprovalsOptions {
  db: DatabaseSync;
  dove: {
    decide(input: DecideInput): DecideOutcome;
    subscribe(listener: (event: { type: string; payload: Record<string, unknown> }) => void): () => void;
  };
  api: SignalApi;
  /** The expiry is shown in it. */
  timeZone: string;
  log?: (line: string) => void;
}

export class SignalApprovals {
  private readonly options: SignalApprovalsOptions;
  private chain: Promise<void> = Promise.resolve();
  private readonly unsubscribe: () => void;

  constructor(options: SignalApprovalsOptions) {
    this.options = options;
    options.db.exec(`CREATE TABLE IF NOT EXISTS fork_signal_approval_messages (
      approval_id TEXT PRIMARY KEY REFERENCES approvals (approval_id),
      sent_at INTEGER NOT NULL UNIQUE,
      closed INTEGER NOT NULL DEFAULT 0
    ) STRICT`);
    this.unsubscribe = options.dove.subscribe(({ type, payload }) => {
      if (typeof payload.approvalId !== 'string') return;
      if (type === 'approval.pending') this.enqueue(payload.approvalId, id => this.post(id));
      if (type === 'approval.resolved') this.enqueue(payload.approvalId, id => this.close(id));
    });
  }

  /** What changed while the server was stopped: approvals not sent yet, and those closed since. */
  sync(): void {
    const { db } = this.options;
    const unsent = db.prepare(`SELECT approval_id FROM approvals WHERE state = 'pending' AND approval_id NOT IN
      (SELECT approval_id FROM fork_signal_approval_messages) ORDER BY created_at, rowid`).all() as { approval_id: string }[];
    for (const { approval_id } of unsent) this.enqueue(approval_id, id => this.post(id));
    const open = db.prepare('SELECT approval_id FROM fork_signal_approval_messages WHERE closed = 0').all() as { approval_id: string }[];
    for (const { approval_id } of open) this.enqueue(approval_id, id => this.close(id));
  }

  async idle(): Promise<void> {
    let current: Promise<void>;
    do { current = this.chain; await current; } while (current !== this.chain);
  }

  stop(): void { this.unsubscribe(); }

  /** A reaction by the owner on one of our messages. Anything but the three emoji is let go. */
  react(sentAt: number, emoji: string): void {
    const decision = emoji.startsWith('👍') ? 'approve' : emoji.startsWith('👎') || emoji === '❌' ? 'reject' : undefined;
    if (decision) this.decide(sentAt, decision);
  }

  /** A quoted reply. True when it was an answer to an approval, so it is not also said to natsumi. */
  answer(quotedAt: number, text: string): boolean {
    const word = text.trim().toLowerCase();
    const decision = word === '送る' || word === 'ok' ? 'approve' : word === '見送る' || word === 'no' ? 'reject' : undefined;
    return decision !== undefined && this.decide(quotedAt, decision);
  }

  private decide(sentAt: number, decision: 'approve' | 'reject'): boolean {
    const sent = this.options.db.prepare('SELECT approval_id FROM fork_signal_approval_messages WHERE sent_at = ?')
      .get(sentAt) as { approval_id: string } | undefined;
    const approval = sent && this.approval(sent.approval_id);
    if (!approval) return false;
    const result = this.options.dove.decide({ approvalId: approval.approval_id, revision: approval.revision, decision, deviceId: 'signal' });
    if (result.kind === 'rejected') this.log(`an approval from Signal was not taken (${result.code})`);
    return true;
  }

  private async post(approvalId: string): Promise<void> {
    const approval = this.approval(approvalId);
    if (!approval || approval.state !== 'pending' || this.sent(approvalId)) return;
    const shown = JSON.parse(approval.payload) as Shown;
    const { replyTo } = shown.target;
    const expires = new Date(shown.expiresAt).toLocaleString('ja-JP', { timeZone: this.options.timeZone, dateStyle: 'short', timeStyle: 'short' });
    const lines = [
      `承認待ちの投稿: ${where(shown)} への投稿`,
      ...replyTo ? [`返信先: ${replyTo.speaker}（${replyTo.at}）「${replyTo.text}」`] : [],
      '---', shown.text === '' ? '（本文なし）' : shown.text, '---',
      `理由: ${reason(shown)}`,
      ...shown.images?.length ? [`画像 ${shown.images.length} 枚も一緒に送る`] : [],
      `期限: ${expires}`,
      '👍 で送る、👎 か ❌ で見送る（引用して「送る」「見送る」でも）',
    ];
    const sentAt = await this.options.api.send(lines.join('\n'));
    this.options.db.prepare('INSERT INTO fork_signal_approval_messages (approval_id, sent_at) VALUES (?, ?)').run(approvalId, sentAt);
  }

  /** Says what came of a closed approval, once nothing more will. */
  private async close(approvalId: string): Promise<void> {
    const sent = this.sent(approvalId);
    const approval = this.approval(approvalId);
    if (!sent || sent.closed || !approval || approval.state === 'pending') return;
    const { said, final } = outcome(approval);
    if (!final) return;
    await this.options.api.send(`→ ${said}: ${where(JSON.parse(approval.payload) as Shown)} への投稿`);
    this.options.db.prepare('UPDATE fork_signal_approval_messages SET closed = 1 WHERE approval_id = ?').run(approvalId);
  }

  private enqueue(approvalId: string, work: (approvalId: string) => Promise<void>): void {
    this.chain = this.chain.then(() => work(approvalId)).catch(error => {
      this.log(`an approval message could not be sent (${describe(error)})`);
    });
  }

  private sent(approvalId: string) {
    return this.options.db.prepare('SELECT sent_at, closed FROM fork_signal_approval_messages WHERE approval_id = ?')
      .get(approvalId) as { sent_at: number; closed: number } | undefined;
  }

  private approval(approvalId: string): ApprovalRow | undefined {
    return this.options.db.prepare(`SELECT approval_id, revision, payload, state, delivery, delivery_reason FROM approvals
      WHERE approval_id = ?`).get(approvalId) as ApprovalRow | undefined;
  }

  private log(line: string): void { this.options.log?.(`signal: ${line}`); }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}
