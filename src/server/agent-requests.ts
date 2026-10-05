import { rm } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { A2ACallError, type A2AClient, type AgentFile, type AgentTaskState, type SendResult } from './a2a-client.ts';
import { bringAgentImages, discardBrought, type BroughtImages } from './agent-files.ts';
import {
  AGENTS_SOURCE, clampSummary, replyFromText, writeAgentReply, type ReplyData, type ReplyPlace, type ReplyState, type WrittenReply,
} from './agent-replies.ts';
import type { A2AConfig } from './config.ts';
import type { ImageStore } from './images.ts';
import type { ToolOutcome } from './loop-tools.ts';
import { isoAt } from './nightly.ts';
import { checkOutgoingText, refusalText } from './output-checks.ts';

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

interface TaskRow { agent: string; task_id: string; context_id: string; state: string; sent_at: string }
interface ContextRow { agent: string; context_id: string; task_id: string | null }

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
    if (goOn) {
      const last = this.lastContext(agent);
      if (!last) return refuse(`「${agent}」との続けられるやり取りがありません。新しく頼むなら continue を false にしてください。`);
      const task = last.task_id ? this.task(agent, last.task_id) : undefined;
      if (task?.state === 'waiting') {
        return refuse(`「${agent}」に前に頼んだことの返事を、まだ待っています。返事が sources_updated の attention として届いてから続けてください。`);
      }
      to = task?.state === 'input-required' ? { contextId: last.context_id, taskId: task.task_id } : { contextId: last.context_id };
    }

    let sent: SendResult;
    try {
      sent = await client.send(target.url, { text: message, ...to });
    } catch (error) {
      const kind = error instanceof A2ACallError ? error.kind : 'unavailable';
      this.log(`a2a: sending to ${agent} failed (${kind})`);
      if (kind === 'refused' && goOn) {
        return { ok: false, text: `頼めませんでした。「${agent}」が前のやり取りに続けることを受け付けませんでした。新しく頼むなら continue を false にしてください。` };
      }
      if (kind === 'refused') return { ok: false, text: `頼めませんでした。「${agent}」が受け付けませんでした。` };
      return { ok: false, text: `頼めませんでした。「${agent}」につながりません。時間をおいてもう一度頼むか、急ぎならマスターに伝えてください。` };
    }
    if (this.closed) return { ok: false, text: '頼んだかどうか分かりません。サーバーが止まるところです。' };
    await this.record(agent, sent);
    const how = to.taskId ? 'の聞き返しに答えました' : to.contextId ? 'との前のやり取りに続けて送りました' : 'に頼みました';
    return { ok: true, text: `「${agent}」${how}。返事は後で sources_updated の attention（kind: agent_reply）として届きます。`
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
    const waiting = this.db.prepare(`SELECT agent, task_id, context_id, state, sent_at FROM agent_tasks WHERE state = 'waiting'
      ORDER BY sent_at`).all() as unknown as TaskRow[];
    for (const task of waiting) {
      if (this.closed) return;
      if (this.options.now() - Date.parse(task.sent_at) >= limitMs) {
        this.log(`a2a: gave up waiting for ${task.agent}`);
        await this.settle(task, 'gave_up', serverReply(`${config.giveUpAfterHours} 時間待っても返事が来なかったので、サーバーが待つのをやめました。`));
        continue;
      }
      const target = config.agents[task.agent];
      // An agent taken out of the config cannot be asked any more; what it was doing is lost to her.
      if (!target) {
        await this.settle(task, 'failed', serverReply('この相手は頼める相手から外されたので、返事を受け取れなくなりました。'));
        continue;
      }
      let state: AgentTaskState;
      let text: string;
      let files: AgentFile[] | undefined;
      try {
        ({ state, text, files } = await client.getTask(target.url, task.task_id));
      } catch (error) {
        const kind = error instanceof A2ACallError ? error.kind : 'unavailable';
        if (kind === 'not-found') {
          this.log(`a2a: ${task.agent} no longer knows a task`);
          await this.settle(task, 'failed', serverReply('相手がこの頼みごとを覚えていませんでした。頼み直すなら continue を false にします。'));
          continue;
        }
        if (!this.failing.has(task.agent)) this.log(`a2a: fetching from ${task.agent} failed (${kind}); trying again each round`);
        this.failing.add(task.agent);
        continue;
      }
      if (this.failing.delete(task.agent)) this.log(`a2a: ${task.agent} answers again`);
      if (state === 'waiting') continue;
      const replyState: ReplyState = state === 'input-required' ? 'input_required' : state;
      await this.settle(task, replyState, textReply(replyState, text), state === 'completed' ? { url: target.url, files } : undefined);
    }
  }

  /**
   * A task has ended, or is asking: its reply is put under /sources/agents with the images it handed back, and its
   * state and the attention that tells her are written together. A reply that cannot be put is left for the next
   * round, which fetches the task again.
   */
  private async settle(task: TaskRow, state: ReplyState, reply: ReplyData, handed?: { url: string; files: AgentFile[] | undefined }):
    Promise<void> {
    const delivered = await this.deliver(task.agent, state, reply, handed, () => {
      this.db.prepare(`UPDATE agent_tasks SET state = ?, updated_at = ? WHERE agent = ? AND task_id = ?`)
        .run(TASK_END[state], this.iso(), task.agent, task.task_id);
    });
    if (!delivered) this.log(`a2a: the reply of ${task.agent} could not be put in /sources; it is fetched again`);
  }

  /**
   * Puts a reply under /sources/agents, then records the caller's rows, the images' copies and the attention in one
   * transaction, and asks for the event. Whatever fails leaves nothing behind: no files, no copies, no rows.
   */
  private async deliver(agent: string, state: ReplyState, reply: ReplyData, handed: { url: string; files: AgentFile[] | undefined } | undefined,
    rows: () => void): Promise<boolean> {
    const place = this.options.replies;
    if (!place || this.closed) return false;
    const { client, images } = this.options;
    let brought: BroughtImages | undefined;
    const files = handed?.files ?? [];
    let written: WrittenReply;
    try {
      written = await writeAgentReply({ directory: place.directory, agent, state, at: this.options.now(), reply,
        ...(files.length > 0 && client && images && handed ? {
          bring: async (directory: string, path: string) => {
            brought = await bringAgentImages({ url: handed.url, files, client, directory, path, imageDirectory: images.directory });
            this.log(`a2a: brought ${brought.images.length} image(s) from ${agent}${brought.notTaken.length ? `, ${brought.notTaken.length} not taken` : ''}`);
            return brought;
          },
        } : {}) });
    } catch {
      if (brought) await discardBrought(brought);
      return false;
    }
    const undo = async () => {
      if (brought) await discardBrought(brought);
      await rm(written.directory, { recursive: true, force: true });
    };
    // The task is fetched again after the restart, and is put again.
    if (this.closed) { await undo(); return false; }
    const imageCount = written.images.length;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      rows();
      if (brought) this.options.images?.record(brought.taken, this.iso());
      const recorded = place.record({ source: AGENTS_SOURCE, kind: 'agent_reply', file: written.readme,
        details: { agent, state, summary: clampSummary(reply.summary), ...(imageCount > 0 ? { images: imageCount } : {}) } });
      if (!recorded) throw new Error('the attention was let go');
      this.db.exec('COMMIT');
    } catch {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      await undo();
      return false;
    }
    place.notify();
    return true;
  }

  /** What a send started: the agent's latest exchange, and the task to fetch or the answer that already came. */
  private async record(agent: string, sent: SendResult): Promise<void> {
    const now = this.iso();
    const remember = () => {
      this.db.prepare(`INSERT INTO agent_contexts (agent, context_id, task_id, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (agent) DO UPDATE SET context_id = excluded.context_id, task_id = excluded.task_id, updated_at = excluded.updated_at`)
        .run(agent, sent.contextId, sent.kind === 'task' ? sent.taskId : null, now);
    };
    if (sent.kind === 'message') {
      if (!await this.deliver(agent, 'completed', textReply('completed', sent.text), undefined, remember)) {
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
      this.db.prepare(`INSERT INTO agent_tasks (agent, task_id, context_id, state, sent_at, created_at, updated_at)
        VALUES (?, ?, ?, 'waiting', ?, ?, ?)
        ON CONFLICT (agent, task_id) DO UPDATE SET state = 'waiting', sent_at = excluded.sent_at, updated_at = excluded.updated_at`)
        .run(agent, sent.taskId, sent.contextId, now, now, now);
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private lastContext(agent: string): ContextRow | undefined {
    return this.db.prepare('SELECT agent, context_id, task_id FROM agent_contexts WHERE agent = ?').get(agent) as ContextRow | undefined;
  }

  private task(agent: string, taskId: string): TaskRow | undefined {
    return this.db.prepare('SELECT agent, task_id, context_id, state, sent_at FROM agent_tasks WHERE agent = ? AND task_id = ?')
      .get(agent, taskId) as TaskRow | undefined;
  }

  private iso() { return isoAt(this.options.now()); }

  private log(line: string) { this.options.log?.(line); }
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
