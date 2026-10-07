import { realpath, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DecideInput, DecideOutcome } from './dove.ts';
import { isWithin, realPathAllowingMissing } from './paths.ts';
import { makeSharedDirectory, SHARED_FILE_MODE } from './permissions.ts';
import { outcome, reason, where, type ApprovalRow, type Shown } from './slack-approvals.ts';
import { WORK_PATH } from './view.ts';

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
  /** Tells the owner that the message sent at `timestamp` was read. signal-cli sends delivery receipts only. */
  read?(timestamp: number): Promise<void>;
  /** The bytes of a file the owner sent, by the id the daemon gave it. */
  attachment?(id: string): Promise<Buffer>;
  /** Shows the owner that she is typing, or, with `stop`, that she has stopped. */
  typing?(stop?: boolean): Promise<void>;
}

export function connectSignal(config: { url: string; account: string; owner: string }): SignalApi {
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const response = await fetch(`${config.url}/api/v1/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: { account: config.account, ...params } }),
    });
    if (!response.ok) throw new Error(`http ${response.status}`);
    const body = await response.json() as {
      result?: { timestamp?: unknown; results?: { type?: unknown }[]; data?: unknown }; error?: { code?: unknown };
    };
    if (body.error) throw new Error(`rpc error ${String(body.error.code)}`);
    return body;
  };
  return {
    async attachment(attachmentId) {
      const body = await rpc('getAttachment', { id: attachmentId });
      if (typeof body.result?.data !== 'string') throw new Error('no data');
      return Buffer.from(body.result.data, 'base64');
    },
    async typing(stop) {
      await rpc('sendTyping', { recipient: [config.owner], ...(stop ? { stop: true } : {}) });
    },
    async read(timestamp) {
      await rpc('sendReceipt', { recipient: config.owner, targetTimestamp: [timestamp], type: 'read' });
    },
    async send(message, attachments) {
      const body = await rpc('send', { recipient: [config.owner], message, ...(attachments?.length ? { attachments } : {}) });
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
    attachments?: { id?: unknown; contentType?: unknown; filename?: unknown; size?: unknown }[];
  };
}

/** Under /work, where the files the owner sends on Signal go. */
export const SIGNAL_FILE_DIRECTORY = 'signal';

/** The largest file taken from one message, and how many. Signal itself allows 100 MB. */
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

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
  /** Started for each message said to natsumi. */
  typing?: OwnerTyping;
  log?: (line: string) => void;
  /** `/work` as the server sees it. Files the owner sends are put under it, and natsumi is told where. */
  workDirectory?: string;
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

  /**
   * One event of the stream, as the daemon writes it after `data:`. A message with files is said once they are put in
   * /work, so what it returns then is to be awaited; anything else is done at once.
   */
  handle(event: Record<string, unknown>): void | Promise<void> {
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
    const text = typeof message.message === 'string' && message.message.trim() !== '' ? message.message : undefined;
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    if (text === undefined && attachments.length === 0) return;
    const quoted = message.quote?.id;
    if (text !== undefined && attachments.length === 0 && approvals && typeof quoted === 'number' && approvals.answer(quoted, text)) return;
    const timestamp = message.timestamp ?? envelope.timestamp;
    if (typeof timestamp === 'number') this.options.api.read?.(timestamp).catch(() => { /* only a read mark */ });
    this.options.typing?.start();
    const say = (lines: string[]) => { this.options.say({ requestId: `signal:${String(timestamp)}`, text: [...text === undefined ? [] : [text], ...lines].join('\n') }); };
    if (attachments.length === 0) { say([]); return; }
    return this.bring(attachments, typeof timestamp === 'number' ? timestamp : Date.now()).then(say);
  }

  /** Puts each file in /work/signal and answers one line per file: where it is, or why it is not. Never throws. */
  private async bring(attachments: NonNullable<NonNullable<Envelope['dataMessage']>['attachments']>, at: number): Promise<string[]> {
    const { api, workDirectory } = this.options;
    const lines: string[] = [];
    for (const [index, attachment] of attachments.entries()) {
      const name = typeof attachment.filename === 'string' && attachment.filename !== '' ? attachment.filename : `添付 ${index + 1}`;
      const refuse = (why: string) => { lines.push(`（添付「${name}」は受け取れませんでした: ${why}）`); };
      if (index >= MAX_ATTACHMENTS) { refuse(`1 通から受け取るのは ${MAX_ATTACHMENTS} 個までです`); continue; }
      if (typeof attachment.id !== 'string' || !api.attachment || workDirectory === undefined) { refuse('サーバーが受け取れない形でした'); continue; }
      if (typeof attachment.size === 'number' && attachment.size > MAX_ATTACHMENT_BYTES) {
        refuse(`${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB を超えています`);
        continue;
      }
      let data: Buffer;
      try { data = await api.attachment(attachment.id); } catch (error) {
        this.log(`a file from the owner could not be fetched (${describe(error)})`);
        refuse('Signal から取り出せませんでした');
        continue;
      }
      const placed = await placeFile(workDirectory, data, fileName(attachment.filename, attachment.id, at));
      if (!placed.ok) { refuse(placed.reason); continue; }
      const type = typeof attachment.contentType === 'string' ? `、${attachment.contentType}` : '';
      const pdf = attachment.contentType === 'application/pdf' || placed.path.endsWith('.pdf')
        ? '。本文は pdftotext、ページの画像は pdftoppm -png -r 100 で作って view で見る' : '';
      lines.push(`（添付「${name}」: ${placed.path}${type}、${size(data.length)}${pdf}）`);
    }
    return lines;
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
          await this.handle(event);
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
 * "typing…" while natsumi works on what the owner said on Signal or in their Slack channel, so the owner can tell she
 * has not stopped. The app lets it go after a while (Signal about 15 seconds, Slack 2 minutes), so it is sent again
 * every `intervalMs`. It stops when the turn asked there is done (replied, not replied or failed), unless she asked an
 * agent since the owner's message and the agent has not answered: then it goes on until her next line once no agent is
 * waiting. After 30 minutes it stops whatever happens.
 */
export class OwnerTyping {
  private readonly options: { send: (stop?: boolean) => Promise<unknown> | undefined; waitingAgents: (since: string) => number; intervalMs: number; maxMs: number };
  private readonly unsubscribe: () => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private until = 0;
  private since = '';
  private forAgents = false;

  constructor(options: {
    loop: { subscribe(listener: (event: { type: string; payload: Record<string, unknown> }) => void): () => void };
    /** Shows "typing…", or with `stop` takes it away. A failure is only a hint lost. */
    send: (stop?: boolean) => Promise<unknown> | undefined;
    /** Whether the owner message of an event was asked where this shows. */
    asked: (eventId: string) => boolean;
    /** How many agents asked at or after `since` (an ISO time) have not answered yet. */
    waitingAgents?: (since: string) => number;
    intervalMs?: number; maxMs?: number;
  }) {
    this.options = { send: options.send, waitingAgents: options.waitingAgents ?? (() => 0),
      intervalMs: options.intervalMs ?? 10_000, maxMs: options.maxMs ?? 1_800_000 };
    // ponytail: agents are not told apart by the message that asked them; tie agent_tasks to the event if that shows.
    this.unsubscribe = options.loop.subscribe(({ type, payload }) => {
      if (!this.timer) return;
      if (type === 'conversation.event.completed' && typeof payload.eventId === 'string' && options.asked(payload.eventId)) {
        if (this.waiting()) this.forAgents = true; else this.end();
      }
      if (type === 'conversation.message' && payload.role === 'natsumi' && this.forAgents && !this.waiting()) this.end();
    });
  }

  start(): void {
    this.until = Date.now() + this.options.maxMs;
    this.forAgents = false;
    if (this.timer) return;
    this.since = new Date().toISOString();
    this.send();
    this.timer = setInterval(() => { if (Date.now() >= this.until) this.end(); else this.send(); }, this.options.intervalMs);
  }

  stop(): void {
    this.unsubscribe();
    this.end();
  }

  private waiting(): boolean {
    try { return this.options.waitingAgents(this.since) > 0; } catch { return false; }
  }

  private end(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.forAgents = false;
    this.send(true);
  }

  private send(stop?: boolean): void {
    this.options.send(stop)?.catch(() => { /* only a hint */ });
  }
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

/** `20261002T132440Z-<the sender's name, or the daemon's id>.<extension>`, of safe characters only. */
function fileName(filename: unknown, id: string, at: number): { stem: string; extension: string } {
  const pick = (value: unknown) => typeof value === 'string' ? posix.basename(value.replaceAll('\\', '/')) : '';
  const stemOf = (value: string) => value.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
  const extensionOf = (value: string) => /\.([A-Za-z0-9]{1,8})$/.exec(value)?.[1]?.toLowerCase();
  const stamp = new Date(at).toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(/[-:]/g, '');
  const given = pick(filename);
  return {
    stem: `${stamp}-${stemOf(given) || stemOf(pick(id)) || 'file'}`,
    extension: extensionOf(given) ?? extensionOf(pick(id)) ?? 'bin',
  };
}

/**
 * Writes one file under /work/signal, as agent-files.ts does for an agent's images: never over another file (a name
 * taken gets -2, -3, …) and never through a link that leads out of /work, since the directory is natsumi's to change.
 */
async function placeFile(workDirectory: string, data: Buffer, name: { stem: string; extension: string }):
  Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const outside = { ok: false as const, reason: `${WORK_PATH}/${SIGNAL_FILE_DIRECTORY} が ${WORK_PATH} の外を指しています` };
  let root: string;
  try { root = await realpath(workDirectory); } catch { return { ok: false, reason: `${WORK_PATH} がありません` }; }
  const directory = join(root, SIGNAL_FILE_DIRECTORY);
  try {
    if (!isWithin(await realPathAllowingMissing(directory), root)) return outside;
    await makeSharedDirectory(directory);
    if (!isWithin(await realpath(directory), root)) return outside;
  } catch { return { ok: false, reason: `${WORK_PATH}/${SIGNAL_FILE_DIRECTORY} を作れませんでした` }; }
  for (let n = 1; n < 100; n++) {
    const file = `${name.stem}${n === 1 ? '' : `-${n}`}.${name.extension}`;
    try {
      // `wx` makes a new file or fails: it never writes over one, and never through a link left in its place.
      await writeFile(join(directory, file), data, { flag: 'wx', mode: SHARED_FILE_MODE });
      return { ok: true, path: `${WORK_PATH}/${SIGNAL_FILE_DIRECTORY}/${file}` };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') break;
    }
  }
  return { ok: false, reason: `${WORK_PATH}/${SIGNAL_FILE_DIRECTORY} に置けませんでした` };
}

function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}
