import type { DatabaseSync } from 'node:sqlite';
import type { DecideInput, DecideOutcome } from './dove.ts';
import { describeFailure, type SlackApi, type SlackSocket } from './slack-api.ts';

/**
 * Fork (ADR F02): the owner approves the dove's drafts in their DM with the bot. Each approval is posted there once,
 * with two buttons; a press by the owner goes to the dove's own `decide`, as `approval.decide` does, and the message
 * is rewritten to what came of it, however it was decided.
 *
 * Which approval was posted where is kept in a table of this fork's own, made here rather than by a numbered
 * migration, so that upstream's next migration never meets one of the fork's.
 */

const APPROVE = 'fork-approval-approve';
const REJECT = 'fork-approval-reject';
/** Slack's limit on a section's text. A longer draft is shown in several. */
const SECTION_CHARS = 3000;

const VERDICT_WORDS: Record<string, string> = {
  owner: '判定が本人に回した',
  'no-verdict': '判定できなかった',
  'rewrite-limit': '同じ返信先で 3 回突き返された',
};
const FAILURE_WORDS: Record<string, string> = {
  'mechanical-check': '本文が送る前の検査に通らなかった',
  'slack-error': 'Slack に断られた',
  'target-gone': '返信先の発言かチャンネルが無くなっていた',
};

export interface ApprovalRow { approval_id: string; revision: number; payload: string; state: string; delivery: string | null; delivery_reason: string | null }
export interface Shown {
  text: string; expiresAt: string; images?: unknown[];
  target: { channel: string; placement: string; replyTo?: { speaker: string; at: string; text: string } };
  reason: { verdict: string; issues: { label: string; score: number; flagged?: true }[] };
  history: unknown[];
}

export interface SlackApprovalsOptions {
  db: DatabaseSync;
  dove: {
    decide(input: DecideInput): DecideOutcome;
    subscribe(listener: (event: { type: string; payload: Record<string, unknown> }) => void): () => void;
  };
  api: SlackApi;
  socket: SlackSocket;
  workspace: string;
  ownerUserId: string;
  log?: (line: string) => void;
}

export class SlackApprovals {
  private readonly options: SlackApprovalsOptions;
  private chain: Promise<void> = Promise.resolve();
  private dm: string | undefined;
  private readonly unsubscribe: () => void;

  constructor(options: SlackApprovalsOptions) {
    this.options = options;
    options.db.exec(`CREATE TABLE IF NOT EXISTS fork_slack_approval_messages (
      approval_id TEXT PRIMARY KEY REFERENCES approvals (approval_id),
      channel_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      closed INTEGER NOT NULL DEFAULT 0
    ) STRICT`);
    this.unsubscribe = options.dove.subscribe(({ type, payload }) => {
      if (typeof payload.approvalId !== 'string') return;
      if (type === 'approval.pending') this.enqueue(payload.approvalId, id => this.post(id));
      if (type === 'approval.resolved') this.enqueue(payload.approvalId, id => this.refresh(id));
    });
    // The socket is this workspace's own: a press arriving on it is from this workspace.
    options.socket.onInteractive(payload => { this.pressed(payload); });
  }

  /** What changed while the server was stopped: approvals not posted yet, and messages whose approval has closed. */
  sync(): void {
    const { db } = this.options;
    const unposted = db.prepare(`SELECT approval_id FROM approvals WHERE state = 'pending' AND approval_id NOT IN
      (SELECT approval_id FROM fork_slack_approval_messages) ORDER BY created_at, rowid`).all() as { approval_id: string }[];
    for (const { approval_id } of unposted) this.enqueue(approval_id, id => this.post(id));
    const open = db.prepare('SELECT approval_id FROM fork_slack_approval_messages WHERE closed = 0').all() as { approval_id: string }[];
    for (const { approval_id } of open) this.enqueue(approval_id, id => this.refresh(id));
  }

  /** Resolves once everything posted or rewritten so far is done. */
  async idle(): Promise<void> {
    let current: Promise<void>;
    do { current = this.chain; await current; } while (current !== this.chain);
  }

  stop(): void { this.unsubscribe(); }

  private pressed(payload: Record<string, unknown>): void {
    if (payload.type !== 'block_actions') return;
    const user = payload.user as { id?: unknown } | undefined;
    const action = (Array.isArray(payload.actions) ? payload.actions[0] : undefined) as { action_id?: unknown; value?: unknown } | undefined;
    if (action?.action_id !== APPROVE && action?.action_id !== REJECT) return;
    if (user?.id !== this.options.ownerUserId) {
      this.log('an approval button was pressed by someone other than the owner; ignored');
      return;
    }
    const container = payload.container as { message_ts?: unknown } | undefined;
    const posted = this.posted(String(action.value));
    if (!posted || posted.ts !== container?.message_ts) return;
    const approval = this.approval(posted.approval_id)!;
    const outcome = this.options.dove.decide({ approvalId: approval.approval_id, revision: approval.revision,
      decision: action.action_id === APPROVE ? 'approve' : 'reject', deviceId: 'slack' });
    if (outcome.kind === 'rejected') this.log(`an approval from Slack was not taken (${outcome.code})`);
    // Already closed, or approved and on its way: the message says so now. What comes of it is rewritten later.
    this.enqueue(approval.approval_id, id => this.refresh(id));
  }

  private async post(approvalId: string): Promise<void> {
    const approval = this.approval(approvalId);
    if (!approval || approval.state !== 'pending' || this.posted(approvalId)) return;
    const { api, ownerUserId, db } = this.options;
    this.dm ??= await api.openDm(ownerUserId);
    const shown = JSON.parse(approval.payload) as Shown;
    const ts = await api.postBlocks(this.dm, summary(shown), [...blocks(shown), {
      type: 'actions', elements: [
        { type: 'button', action_id: APPROVE, value: approvalId, style: 'primary', text: { type: 'plain_text', text: '送る' } },
        { type: 'button', action_id: REJECT, value: approvalId, text: { type: 'plain_text', text: '見送る' } },
      ],
    }]);
    db.prepare('INSERT INTO fork_slack_approval_messages (approval_id, channel_id, ts) VALUES (?, ?, ?)').run(approvalId, this.dm, ts);
  }

  /** Rewrites the message without its buttons once the approval is decided, and marks it closed once nothing more comes. */
  private async refresh(approvalId: string): Promise<void> {
    const posted = this.posted(approvalId);
    const approval = this.approval(approvalId);
    if (!posted || posted.closed || !approval || approval.state === 'pending') return;
    const { said, final } = outcome(approval);
    const shown = JSON.parse(approval.payload) as Shown;
    await this.options.api.updateBlocks(posted.channel_id, posted.ts, `${said}: ${summary(shown)}`,
      [...blocks(shown), { type: 'context', elements: [{ type: 'mrkdwn', text: `*→ ${said}*` }] }]);
    if (final) this.options.db.prepare('UPDATE fork_slack_approval_messages SET closed = 1 WHERE approval_id = ?').run(approvalId);
  }

  /** One at a time, in order; a failure is logged and the next goes on. */
  private enqueue(approvalId: string, work: (approvalId: string) => Promise<void>): void {
    this.chain = this.chain.then(() => work(approvalId)).catch(error => {
      this.log(`an approval message could not be posted or rewritten (${describeFailure(error)})`);
    });
  }

  private posted(approvalId: string) {
    return this.options.db.prepare('SELECT approval_id, channel_id, ts, closed FROM fork_slack_approval_messages WHERE approval_id = ?')
      .get(approvalId) as { approval_id: string; channel_id: string; ts: string; closed: number } | undefined;
  }

  private approval(approvalId: string): ApprovalRow | undefined {
    return this.options.db.prepare(`SELECT approval_id, revision, payload, state, delivery, delivery_reason FROM approvals
      WHERE approval_id = ?`).get(approvalId) as ApprovalRow | undefined;
  }

  private log(line: string): void { this.options.log?.(`slack (${this.options.workspace}): ${line}`); }
}

/** What came of a closed approval, and whether anything more will. */
export function outcome(approval: ApprovalRow): { said: string; final: boolean } {
  if (approval.state === 'rejected') return { said: '見送った', final: true };
  if (approval.state === 'expired') return { said: '期限切れで送らなかった', final: true };
  if (approval.delivery === 'sent') return { said: '送った', final: true };
  if (approval.delivery === 'failed') {
    return { said: `送れなかった（${FAILURE_WORDS[approval.delivery_reason ?? ''] ?? approval.delivery_reason}）`, final: true };
  }
  return { said: '承認した。送っているところ', final: false };
}

function summary(shown: Shown): string {
  return `承認待ちの投稿: ${escape(where(shown))}`;
}

export function where(shown: Shown): string {
  // The three placements of ADR 0062; one this fork does not know is shown as the channel alone.
  if (!shown.target.replyTo) return shown.target.channel;
  if (shown.target.placement === 'thread') return `${shown.target.channel} のスレッド`;
  if (shown.target.placement === 'broadcast') return `${shown.target.channel} のスレッド（チャンネルにも表示）`;
  return shown.target.channel;
}

/** The approval as the iPhone shows it, in the few words a DM has room for. Everything from Slack or natsumi is plain text. */
function blocks(shown: Shown): unknown[] {
  const plain = (text: string) => ({ type: 'plain_text', text, emoji: true });
  const { replyTo } = shown.target;
  const expires = Math.floor(Date.parse(shown.expiresAt) / 1000);
  return [
    { type: 'section', text: plain(`${where(shown)} への投稿`) },
    ...(replyTo ? [{ type: 'context', elements: [plain(`返信先: ${replyTo.speaker}（${replyTo.at}）「${replyTo.text}」`)] }] : []),
    ...chunks(shown.text === '' ? '（本文なし）' : shown.text).map(text => ({ type: 'section', text: plain(text) })),
    { type: 'context', elements: [
      plain(`理由: ${reason(shown)}`),
      ...(shown.images?.length ? [plain(`画像 ${shown.images.length} 枚も一緒に送る`)] : []),
      { type: 'mrkdwn', text: `期限: <!date^${expires}^{date_short_pretty} {time}|${shown.expiresAt}>` },
    ] },
  ];
}

/** Why the draft came to the owner: the verdict, the flagged issues and how often it was turned back. Shared with Signal (ADR F04). */
export function reason(shown: Shown): string {
  const flagged = shown.reason.issues.filter(issue => issue.flagged).map(issue => `${issue.label} ${issue.score.toFixed(2)}`);
  return [VERDICT_WORDS[shown.reason.verdict] ?? shown.reason.verdict, ...flagged].join(' / ')
    + (shown.history.length > 0 ? `（前に突き返された下書き ${shown.history.length} 件）` : '');
}

function chunks(text: string): string[] {
  const characters = [...text];
  const found: string[] = [];
  for (let at = 0; at < characters.length; at += SECTION_CHARS) found.push(characters.slice(at, at + SECTION_CHARS).join(''));
  return found;
}

/** `&`, `<` and `>` as Slack's mrkdwn takes them literally. */
function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
