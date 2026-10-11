import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { A2ACallError, type A2AClient, type AgentFile, type AgentTaskState, type SendResult } from './a2a-client.ts';
import { bringAgentImages, discardBrought, type BroughtImages } from './agent-files.ts';
import {
  AGENTS_PATH, AGENTS_SOURCE, checkReplyData, clampSummary, firstLine, makeReplyDirectory, parseReplyData, replyFromText, undoReply,
  writeAgentReply, writeAgentRequest, writeRequestFile, type ReplyData, type ReplyForm, type ReplyPlace, type ReplyState, type RequestKind,
  type RequestPlace, type WrittenReply,
} from './agent-replies.ts';
import type { A2AConfig } from './config.ts';
import type { ImageStore } from './images.ts';
import type { ToolOutcome } from './loop-tools.ts';
import { isoAt, localDateTime } from './nightly.ts';
import { checkOutgoingText, refusalText } from './output-checks.ts';
import { POSTBOX_FAILURES_TOLD, receivedLine, receivedStamp, type PostboxLedger, type PostboxResult, type PostboxSend } from './postbox.ts';

/** The longest answer a legacy event carries. A longer one is cut, and the event says so. */
export const MAX_AGENT_REPLY_CHARS = 8000;

/** Where natsumi reads who she can ask (ADR 0036). Named in refusals, never built from the config. */
export const AGENT_LIST_PATH = '/manual/agents/INDEX.md';

/** How an exchange ended, as `agent_tasks` and the legacy `agent_replies` keep it. */
type TaskEnd = 'completed' | 'failed' | 'input-required' | 'gave-up';

const TASK_END: Record<ReplyState, TaskEnd> = {
  completed: 'completed', failed: 'failed', input_required: 'input-required', gave_up: 'gave-up',
};

/** What a legacy event says of the images an agent handed back, as the `files` column keeps it until the event is taken. */
interface ReplyFiles { images: { path: string; description: string }[]; not_taken: { name: string; reason: string }[] }

interface TaskRow {
  agent: string; task_id: string; context_id: string; state: string; sent_at: string; place: string | null; request: string | null;
  /** The letter a request of the postbox was sent on, and when that run was sent (ADR 0076). */
  postbox: string | null; postbox_sent_at: string | null;
}
const TASK_COLUMNS = 'agent, task_id, context_id, state, sent_at, place, request, postbox, postbox_sent_at';
interface ContextRow { agent: string; context_id: string; task_id: string | null; place: string | null }

/** A request as it was made: where it was put, what it said, and when. */
interface MadeRequest { place: RequestPlace; text: string; at: number }

/** A reply to put, which shape it was put from, and the agent's data as it came when it sent some. */
interface Reply { reply: ReplyData; form: ReplyForm; data?: unknown }

/** A run of a letter as it was sent (ADR 0076): its name, every word sent, and when. */
interface PostboxRun { name: string; text: string; at: number }

/** How a reply is put and told: where, what rows go with it, and whether it is told at once. */
interface Delivery {
  agent: string;
  state: ReplyState;
  reply: Reply;
  handed?: { url: string; files: AgentFile[] | undefined };
  /** The request's directory, made when it was asked; a reply goes into it. */
  made?: MadeRequest;
  /** A run of the postbox, whose directory is made with its reply: one that comes back empty leaves none (ADR 0076). */
  run?: PostboxRun;
  /** Told by an attention at once, or left to the sources as an ordinary update (ADR 0053, ADR 0076). */
  attention: boolean;
  /** The letter a reply of the postbox's came for, which its attention names. */
  postbox?: string;
  /** The caller's rows, written in the same transaction as the attention, with the reply as it was put. */
  rows: (written: WrittenReply) => void;
}

const POSTBOX_RESULT: Record<ReplyState, PostboxResult> = {
  completed: 'received', failed: 'failed', input_required: 'input-required', gave_up: 'gave-up',
};

export interface AgentRequestsOptions {
  db: DatabaseSync;
  now: () => number;
  /** Without it every ask is refused, and the tool is still there (ADR 0036). */
  config: A2AConfig | undefined;
  client: A2AClient | undefined;
  /** Where the replies are put and how she hears of them (ADR 0069). Without it every ask is refused. */
  replies?: ReplyPlace;
  /** Where the images an agent hands back are copied and recorded (ADR 0048). Without it they are not brought. */
  images?: ImageStore;
  /** The owner's time zone, in which the time of a request is written. UTC when omitted. */
  timeZone?: string;
  /** The record of the postbox's letters (ADR 0076), told how each run went. Without it the postbox sends nothing. */
  postbox?: PostboxLedger;
  log?: (line: string) => void;
}

/**
 * What natsumi asks outside agents, and what they answer (ADR 0035, ADR 0036, ADR 0069). `ask` sends and says only that
 * the request was taken; `poll` fetches the waiting tasks, puts each that settled under /sources/agents as a reply of
 * its own, and records an attention for it, which reaches her in a `sources_updated` event.
 *
 * The IDs stay here. natsumi names an agent and says whether she is going on with the last exchange; the context
 * and the task that means are this class's to know, and neither the files nor the attention name them (ADR 0024).
 *
 * The log carries agent names and kinds of failure only, never what was asked or answered.
 */
export class AgentRequests {
  private readonly options: AgentRequestsOptions;
  private readonly db: DatabaseSync;
  private polling: Promise<void> | undefined;
  private closed = false;
  /** Agents whose last fetch failed, so an outage is logged when it starts and when it ends rather than every round. */
  private readonly failing = new Set<string>();

  constructor(options: AgentRequestsOptions) {
    this.options = options;
    this.db = options.db;
  }

  /** Stops writing: a fetch still on its way when the loop closes lands on a database that is going away. */
  close(): void { this.closed = true; }

  async ask(agent: string, message: string, goOn: boolean): Promise<ToolOutcome> {
    const refuse = (text: string): ToolOutcome => ({ ok: false, text: `頼んでいません。${text}` });
    const { config, client } = this.options;
    if (!config || !client) return refuse('外のエージェントに頼む設定がありません。');
    if (!this.options.replies) return refuse('返事を置く場所（/sources/agents）を用意できていないので、返事を受け取れません。急ぎならマスターに伝えてください。');
    const target = config.agents[agent];
    if (!target) return refuse(`「${agent}」という相手はいません。頼める相手と名前は ${AGENT_LIST_PATH} にあります。`);
    const check = checkOutgoingText(message);
    if (!check.ok) return { ok: false, text: refusalText(check).replace('送信していません', '頼んでいません') };

    let to: { contextId?: string; taskId?: string } = {};
    let previous: string | null | undefined;
    if (goOn) {
      const last = this.lastContext(agent);
      if (!last) return refuse(`「${agent}」との続けられるやり取りがありません。新しく頼むなら continue を false にしてください。`);
      const task = last.task_id ? this.task(agent, last.task_id) : undefined;
      if (task?.state === 'waiting') {
        return refuse(`「${agent}」に前に頼んだことの返事を、まだ待っています。返事が sources_updated の attention として届いてから続けてください。`);
      }
      to = task?.state === 'input-required' ? { contextId: last.context_id, taskId: task.task_id } : { contextId: last.context_id };
      previous = last.place;
    }

    // The request's directory is made before it is sent, so its reply has somewhere to go however soon it comes. It
    // tells her nothing: the request is hers.
    const how: RequestKind = to.taskId ? 'answer' : to.contextId ? 'continue' : 'new';
    const at = this.options.now();
    let made: MadeRequest;
    try {
      const place = await writeAgentRequest({ directory: this.options.replies.directory, agent, at, askedAt: this.localTime(at),
        text: message, how, ...(goOn ? { previous: previous ?? null } : {}) });
      made = { place, text: message, at };
    } catch {
      this.log(`a2a: the request to ${agent} could not be put in /sources`);
      return refuse(`依頼を ${AGENTS_PATH} に置けませんでした。急ぎならマスターに伝えてください。`);
    }

    let sent: SendResult;
    try {
      sent = await client.send(target.url, { text: message, ...to });
    } catch (error) {
      await rm(made.place.directory, { recursive: true, force: true });
      const kind = error instanceof A2ACallError ? error.kind : 'unavailable';
      this.log(`a2a: sending to ${agent} failed (${kind})`);
      if (kind === 'refused' && goOn) {
        return { ok: false, text: `頼めませんでした。「${agent}」が前のやり取りに続けることを受け付けませんでした。新しく頼むなら continue を false にしてください。` };
      }
      if (kind === 'refused') return { ok: false, text: `頼めませんでした。「${agent}」が受け付けませんでした。` };
      return { ok: false, text: `頼めませんでした。「${agent}」につながりません。時間をおいてもう一度頼むか、急ぎならマスターに伝えてください。` };
    }
    if (this.closed) return { ok: false, text: '頼んだかどうか分かりません。サーバーが止まるところです。' };
    await this.record(agent, sent, made);
    const done = how === 'answer' ? 'の聞き返しに答えました' : how === 'continue' ? 'との前のやり取りに続けて送りました' : 'に頼みました';
    return { ok: true, text: `「${agent}」${done}。頼んだことは ${made.place.path}/request.md に置きました。`
      + `返事は後で同じ ${made.place.path}/ に置かれ、sources_updated の attention（kind: agent_reply）で届きます。`
      + '待たずに、ほかのことをしてかまいません。' };
  }

  /**
   * One round: every waiting task is fetched once, and each that settled becomes a reply. Rounds never overlap: one
   * asked for while another runs joins it.
   */
  poll(): Promise<void> {
    this.polling ??= this.round().finally(() => { this.polling = undefined; });
    return this.polling;
  }

  /**
   * The line of an `agent-reply` event recorded before the replies moved to /sources (ADR 0069), taken once. None is
   * made any more; one still queued at the upgrade is handed over as it was. The answer is emptied from its row as it
   * goes: from here on it is in the Pi session, and the same record is not kept twice (ADR 0008).
   */
  takeEventLine(eventId: string, receivedAt: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT agent, status, text, files FROM agent_replies WHERE event_id = ?').get(eventId) as
      { agent: string; status: TaskEnd; text: string; files: string } | undefined;
    if (!row) return { type: 'agent_reply', received_at: receivedAt, status: 'failed' };
    this.db.prepare(`UPDATE agent_replies SET text = '', files = '' WHERE event_id = ?`).run(eventId);
    const files = row.files ? JSON.parse(row.files) as ReplyFiles : { images: [], not_taken: [] };
    const characters = [...row.text];
    const cut = characters.length > MAX_AGENT_REPLY_CHARS;
    return {
      type: 'agent_reply', received_at: receivedAt, agent: row.agent, status: row.status.replace('-', '_'),
      ...(row.text ? { text: cut ? characters.slice(0, MAX_AGENT_REPLY_CHARS).join('') : row.text } : {}),
      ...(cut ? { truncated: true } : {}),
      ...(files.images.length > 0 ? { images: files.images } : {}),
      ...(files.not_taken.length > 0 ? { images_not_taken: files.not_taken } : {}),
    };
  }

  private async round(): Promise<void> {
    const { config, client } = this.options;
    if (!config || !client || !this.options.replies || this.closed) return;
    const limitMs = config.giveUpAfterHours * 3_600_000;
    const waiting = this.db.prepare(`SELECT ${TASK_COLUMNS} FROM agent_tasks WHERE state = 'waiting' ORDER BY sent_at`)
      .all() as unknown as TaskRow[];
    for (const task of waiting) {
      if (this.closed) return;
      if (this.options.now() - Date.parse(task.sent_at) >= limitMs) {
        this.log(`a2a: gave up waiting for ${task.agent}`);
        await this.settle(task, 'gave_up', { reply: serverReply(`${config.giveUpAfterHours} 時間待っても返事が来なかったので、サーバーが待つのをやめました。`), form: 'text' });
        continue;
      }
      const target = config.agents[task.agent];
      // An agent taken out of the config cannot be asked any more; what it was doing is lost to her.
      if (!target) {
        await this.settle(task, 'failed', { reply: serverReply('この相手は頼める相手から外されたので、返事を受け取れなくなりました。'), form: 'text' });
        continue;
      }
      let state: AgentTaskState;
      let text: string;
      let files: AgentFile[] | undefined;
      let data: unknown;
      try {
        ({ state, text, files, data } = await client.getTask(target.url, task.task_id));
      } catch (error) {
        const kind = error instanceof A2ACallError ? error.kind : 'unavailable';
        if (kind === 'not-found') {
          this.log(`a2a: ${task.agent} no longer knows a task`);
          await this.settle(task, 'failed', { reply: serverReply('相手がこの頼みごとを覚えていませんでした。頼み直すなら continue を false にします。'), form: 'text' });
          continue;
        }
        if (!this.failing.has(task.agent)) this.log(`a2a: fetching from ${task.agent} failed (${kind}); trying again each round`);
        this.failing.add(task.agent);
        continue;
      }
      if (this.failing.delete(task.agent)) this.log(`a2a: ${task.agent} answers again`);
      if (state === 'waiting') continue;
      const replyState: ReplyState = state === 'input-required' ? 'input_required' : state;
      const reply = state === 'completed' && data !== undefined ? this.dataReply(task.agent, text, data) : fromText(replyState, text);
      await this.settle(task, replyState, reply, state === 'completed' ? { url: target.url, files } : undefined);
    }
  }

  /**
   * A task has ended, or is asking: its reply is put under /sources/agents with the images it handed back, and its
   * state and the attention that tells her are written together. A reply that cannot be put is left for the next
   * round, which fetches the task again.
   *
   * A request of the postbox's that she has not answered gets its directory now, with its reply, and is told as its
   * letter says (ADR 0076); one she answered went on as hers, and is told as every reply to her is. Either way, how the
   * run went is recorded for its letter.
   */
  private async settle(task: TaskRow, state: ReplyState, reply: Reply, handed?: { url: string; files: AgentFile[] | undefined }):
    Promise<void> {
    const update = (path: string | null) => {
      this.db.prepare(`UPDATE agent_tasks SET state = ?, place = coalesce(?, place), updated_at = ? WHERE agent = ? AND task_id = ?`)
        .run(TASK_END[state], path, this.iso(), task.agent, task.task_id);
    };
    const letter = task.postbox !== null && task.postbox_sent_at !== null ? { name: task.postbox, sentAt: Date.parse(task.postbox_sent_at) } : undefined;
    let delivered: boolean;
    if (letter && task.place === null) {
      const run = { name: letter.name, text: task.request ?? '', at: letter.sentAt };
      delivered = await this.deliverRun(run, task.agent, state, reply, handed, written => {
        update(state === 'input_required' ? written.path : null);
        // A question is hers to answer with continue, as every exchange's is: the run becomes her latest one with the agent.
        if (state === 'input_required') this.remember(task.agent, task.context_id, task.task_id, written.path);
      }, () => { update(null); });
    } else {
      const place = task.place ? this.placeOf(task.place) : undefined;
      const made = place && task.request !== null ? { place, text: task.request, at: Date.parse(task.sent_at) } : undefined;
      delivered = await this.deliver({ agent: task.agent, state, reply, ...(handed ? { handed } : {}), ...(made ? { made } : {}), attention: true,
        ...(letter ? { postbox: letter.name } : {}), rows: written => {
          update(null);
          if (letter) this.options.postbox?.record(letter.name, POSTBOX_RESULT[state], this.options.now(), letter.sentAt, written.path);
        } });
    }
    if (!delivered) this.log(`a2a: the reply of ${task.agent} could not be put in /sources; it is fetched again`);
  }

  /**
   * Sends a run of a letter (ADR 0076): the letter's words, a line on when the last run that went well was sent, and
   * the same in the message's metadata. What it starts is fetched by the rounds as any task is; a send that fails is
   * put as a failed reply at once. How it went is recorded for the letter; nothing throws at the postbox.
   */
  async sendPostbox(input: PostboxSend): Promise<void> {
    const { config, client } = this.options;
    const ledger = this.options.postbox;
    if (!ledger) return;
    const timeZone = this.options.timeZone ?? 'UTC';
    const last = input.lastReceivedAt === undefined ? undefined : receivedStamp(input.lastReceivedAt, timeZone);
    const text = input.lastReceivedAt === undefined ? input.body : `${input.body}\n\n${receivedLine(input.lastReceivedAt, timeZone)}`;
    const metadata = { postbox: { name: input.name, ...(last ? { lastReceivedAt: last.iso } : {}) } };
    const run: PostboxRun = { name: input.name, text, at: input.at };
    const target = config?.agents[input.agent];
    const fail = async (summary: string) => {
      if (!await this.deliverRun(run, input.agent, 'failed', { reply: serverReply(summary), form: 'text' }, undefined, () => {}, () => {})) {
        // Nothing could be put; the run is still counted, so a postbox that cannot write is seen to fail.
        ledger.record(input.name, 'failed', this.options.now(), input.at);
      }
    };
    if (!config || !client || !target || !this.options.replies) {
      await fail('定期便を送れませんでした（この相手に頼む設定がありません）。');
      return;
    }
    let sent: SendResult;
    try {
      sent = await client.send(target.url, { text, metadata });
    } catch (error) {
      const kind = error instanceof A2ACallError ? error.kind : 'unavailable';
      this.log(`a2a: the letter ${input.name} could not be sent to ${input.agent} (${kind})`);
      await fail(kind === 'refused' ? `「${input.agent}」が定期便を受け付けませんでした。` : `「${input.agent}」につながらないので、定期便を送れませんでした。`);
      return;
    }
    if (this.closed) return;
    if (sent.kind === 'message') {
      if (!await this.deliverRun(run, input.agent, 'completed', fromText('completed', sent.text), undefined, () => {}, () => {})) {
        this.log(`a2a: the reply of ${input.agent} could not be put in /sources`);
      }
      return;
    }
    const now = this.iso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO agent_tasks (agent, task_id, context_id, state, sent_at, place, request, postbox, postbox_sent_at, created_at,
        updated_at) VALUES (?, ?, ?, 'waiting', ?, NULL, ?, ?, ?, ?, ?)`)
        .run(input.agent, sent.taskId, sent.contextId, isoAt(input.at), text, input.name, isoAt(input.at), now, now);
      ledger.record(input.name, 'waiting', this.options.now(), input.at);
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Puts the reply of a run of a letter, with its request, into a directory made for both, and records how the run
   * went. It is told at once when it asks a question, when its letter says so, or when it is the third failure in a
   * row; otherwise it is left to the sources as an ordinary update. A reply of data with no section is empty: nothing
   * is put, nothing told, and the run counts as one that went well (ADR 0076).
   */
  private async deliverRun(run: PostboxRun, agent: string, state: ReplyState, reply: Reply,
    handed: { url: string; files: AgentFile[] | undefined } | undefined, rows: (written: WrittenReply) => void, empty: () => void): Promise<boolean> {
    const ledger = this.options.postbox;
    const record = (result: PostboxResult, path?: string) => { ledger?.record(run.name, result, this.options.now(), run.at, path); };
    if (state === 'completed' && reply.form === 'data' && reply.reply.sections.length === 0 && (handed?.files ?? []).length === 0) {
      if (this.closed) return false;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        empty();
        record('empty');
        this.db.exec('COMMIT');
      } catch {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
        return false;
      }
      return true;
    }
    const failed = state === 'failed' || state === 'gave_up';
    const attention = state === 'input_required' || (state === 'completed' && (ledger?.notifies(run.name) ?? false))
      || (failed && (ledger?.failures(run.name) ?? 0) + 1 === POSTBOX_FAILURES_TOLD);
    return this.deliver({ agent, state, reply, ...(handed ? { handed } : {}), run, attention, postbox: run.name,
      rows: written => { rows(written); record(POSTBOX_RESULT[state], written.path); } });
  }

  /**
   * Puts a reply under /sources/agents, then records the caller's rows, the images' copies and the attention in one
   * transaction, and asks for the event. Whatever fails leaves nothing behind: no files, no copies, no rows. A reply
   * that is not told at once is left for the sources to show as an ordinary update (ADR 0076).
   */
  private async deliver(delivery: Delivery): Promise<boolean> {
    const { agent, state, reply: { reply, form, data }, handed, made, run } = delivery;
    const place = this.options.replies;
    if (!place || this.closed) return false;
    const { client, images } = this.options;
    let brought: BroughtImages | undefined;
    const files = handed?.files ?? [];
    const bring = files.length > 0 && client && images && handed ? {
      bring: async (directory: string, path: string) => {
        brought = await bringAgentImages({ url: handed.url, files, client, directory, path, imageDirectory: images.directory });
        this.log(`a2a: brought ${brought.images.length} image(s) from ${agent}${brought.notTaken.length ? `, ${brought.notTaken.length} not taken` : ''}`);
        return brought;
      },
    } : {};
    const common = { directory: place.directory, agent, state, at: this.options.now(), reply, form, ...(data !== undefined ? { data } : {}), ...bring };
    let written: WrittenReply;
    try {
      if (run) {
        // A run's request and its reply are made together, so a run that comes back empty leaves nothing behind.
        const askedAt = this.localTime(run.at);
        let inner: WrittenReply | undefined;
        const directory = await makeReplyDirectory(place.directory, agent, run.at, async (temporary, path) => {
          await writeRequestFile(temporary, { agent, askedAt, text: run.text, how: 'new', postbox: run.name });
          inner = await writeAgentReply({ ...common, place: { path, directory: temporary }, request: { text: run.text, askedAt } });
        });
        written = { ...inner!, directory: directory.directory, created: true };
      } else {
        written = await writeAgentReply({ ...common,
          ...(made ? { place: made.place, request: { text: made.text, askedAt: this.localTime(made.at) } } : {}) });
      }
    } catch {
      if (brought) await discardBrought(brought);
      return false;
    }
    const undo = async () => {
      if (brought) await discardBrought(brought);
      await undoReply(written);
    };
    // The task is fetched again after the restart, and is put again.
    if (this.closed) { await undo(); return false; }
    const imageCount = written.images.length;
    const asked = made ?? run;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      delivery.rows(written);
      if (brought) this.options.images?.record(brought.taken, this.iso());
      if (delivery.attention) {
        const recorded = place.record({ source: AGENTS_SOURCE, kind: 'agent_reply', file: written.readme,
          details: { agent, state, summary: clampSummary(reply.summary), ...(imageCount > 0 ? { images: imageCount } : {}),
            ...(asked ? { request: firstLine(asked.text), asked_at: this.localTime(asked.at) } : {}),
            ...(delivery.postbox !== undefined ? { postbox: delivery.postbox } : {}) } });
        if (!recorded) throw new Error('the attention was let go');
      }
      this.db.exec('COMMIT');
    } catch {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      await undo();
      return false;
    }
    if (delivery.attention) place.notify();
    return true;
  }

  /** What a send started: the agent's latest exchange, and the task to fetch or the answer that already came. */
  private async record(agent: string, sent: SendResult, made: MadeRequest): Promise<void> {
    const now = this.iso();
    const remember = () => { this.remember(agent, sent.contextId, sent.kind === 'task' ? sent.taskId : null, made.place.path); };
    if (sent.kind === 'message') {
      if (!await this.deliver({ agent, state: 'completed', reply: fromText('completed', sent.text), made, attention: true, rows: remember })) {
        // The answer is lost, and the exchange is still remembered, so she can go on with it.
        this.log(`a2a: the reply of ${agent} could not be put in /sources`);
        remember();
      }
      return;
    }
    // Whatever the send came back as, the next round reads it: a task never settles here and again there.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      remember();
      // An answer to a question goes on with the same task: the reply after it belongs to the answer, and goes there.
      this.db.prepare(`INSERT INTO agent_tasks (agent, task_id, context_id, state, sent_at, place, request, created_at, updated_at)
        VALUES (?, ?, ?, 'waiting', ?, ?, ?, ?, ?)
        ON CONFLICT (agent, task_id) DO UPDATE SET state = 'waiting', sent_at = excluded.sent_at, place = excluded.place,
          request = excluded.request, updated_at = excluded.updated_at`)
        .run(agent, sent.taskId, sent.contextId, isoAt(made.at), made.place.path, made.text, now, now);
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** The agent's latest exchange, which `continue` goes on with. */
  private remember(agent: string, contextId: string, taskId: string | null, place: string): void {
    this.db.prepare(`INSERT INTO agent_contexts (agent, context_id, task_id, place, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (agent) DO UPDATE SET context_id = excluded.context_id, task_id = excluded.task_id, place = excluded.place,
        updated_at = excluded.updated_at`)
      .run(agent, contextId, taskId, place, this.iso());
  }

  /**
   * A finished task's reply from its data, put as it is when it keeps the reply extension's schema (ADR 0069). Data
   * that does not is kept as it came, and the text is read instead; the log says why, and never what.
   */
  private dataReply(agent: string, text: string, data: unknown): Reply {
    const reply = parseReplyData(data);
    if (reply) return { reply, form: 'data', data };
    this.log(`a2a: the reply data of ${agent} did not fit (${checkReplyData(data)}); read as text`);
    return { ...fromText('completed', text), data };
  }

  private lastContext(agent: string): ContextRow | undefined {
    return this.db.prepare('SELECT agent, context_id, task_id, place FROM agent_contexts WHERE agent = ?').get(agent) as ContextRow | undefined;
  }

  private task(agent: string, taskId: string): TaskRow | undefined {
    return this.db.prepare(`SELECT ${TASK_COLUMNS} FROM agent_tasks WHERE agent = ? AND task_id = ?`)
      .get(agent, taskId) as TaskRow | undefined;
  }

  private iso() { return isoAt(this.options.now()); }

  /** A time as she reads it: in the owner's time zone. */
  private localTime(at: number): string { return localDateTime(at, this.options.timeZone ?? 'UTC'); }

  /** A request's directory by the path it was kept by, or undefined when the path is not one of the replies'. */
  private placeOf(path: string): RequestPlace | undefined {
    const replies = this.options.replies;
    const relative = path.startsWith(`${AGENTS_PATH}/`) ? path.slice(AGENTS_PATH.length + 1) : undefined;
    if (!replies || !relative || relative.split('/').some(part => part === '' || part === '.' || part === '..')) return undefined;
    return { path, directory: join(replies.directory, relative) };
  }

  private log(line: string) { this.options.log?.(line); }
}

/** The agent's text as a reply to put. */
function fromText(state: ReplyState, text: string): Reply {
  return { reply: textReply(state, text), form: 'text' };
}

/** A reply in the server's own words, when the agent said nothing: no section, and the reason as the summary. */
function serverReply(summary: string): ReplyData {
  return { summary, sections: [], sources: [] };
}

/**
 * The agent's text as a reply (ADR 0069): cut into sections by its headings, its first paragraph the summary. A reply
 * with no text says so in the server's words.
 */
function textReply(state: ReplyState, text: string): ReplyData {
  const reply = replyFromText(text);
  if (reply.summary !== '') return reply;
  const said: Record<ReplyState, string> = {
    completed: '返事に文章はありませんでした。',
    input_required: '相手が聞き返していますが、質問は書かれていませんでした。',
    failed: '相手ができなかったと返しました。理由は書かれていませんでした。',
    gave_up: '待つのをやめました。',
  };
  return { ...reply, summary: said[state] };
}
