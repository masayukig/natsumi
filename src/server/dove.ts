import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Transaction } from './conversation-store.ts';
import { parseDoveRequest } from './dove-request.ts';
import { discardImages, type ImageLimits, type ImageStore, type TakenImage } from './images.ts';
import { decideVerdict, JudgeError, type JudgeClient, type ScoredIssue, type Thresholds } from './judge.ts';
import type { ToolOutcome } from './loop-tools.ts';
import { isoAt } from './nightly.ts';
import { checkOutgoingText, refusalText } from './output-checks.ts';
import { describeFailure, SlackCallError, type SlackApi } from './slack-api.ts';
import type { ResolvedTarget, SlackArchive } from './slack-archive.ts';
import { SlackEmoji } from './slack-emoji.ts';

/**
 * The dove, ポッポさん (ADR 0012, ADR 0039, ADR 0040, ADR 0042): the only way anything natsumi writes reaches Slack.
 *
 * She asks through `ask_agent` with the agent `poppo`, and the tool only says the request was taken. The request is
 * read and its target matched against the record at once, so a request out of shape never goes further. Then, in the
 * background, the draft is judged by Jev over what surrounds its target, and the server's rule on the scores decides:
 * send it now, hand it to the owner, or turn it back to natsumi with the reasons. The third return on the same target
 * goes to the owner instead, with the drafts before it. A reaction with any emoji that exists is put on with neither
 * Jev nor the owner. Whatever happens comes back to her as an `agent_reply` event from `poppo`, in the server's words,
 * naming no ID (ADR 0024).
 *
 * A post may carry images from /work (ADR 0044), copied to the server's side as it is asked, so that the owner approves
 * and Slack is sent the copy. Only the text is judged; images alone go with neither Jev nor the owner, placed by the
 * rule used without a verdict.
 *
 * What the owner decides is final and is taken once: a second answer gets the first one back (ADR 0002). Only what she
 * approved, or her own text, is sent, and the mechanical check comes right before every send, hers included.
 *
 * The log names the workspace, the Slack method and Slack's code, or Jev's kind of failure; never a draft nor an ID.
 */

export const DOVE_NAME = 'poppo';
/** Returns on one target before the next one goes to the owner: two rewrites, as ADR 0012 set. */
export const MAX_RETURNS = 2;
/** How much of the message replied to an approval shows. */
const REPLY_TO_HEAD_CHARS = 100;
/** How much of the draft an event line shows, so she knows which request it is about. */
const DRAFT_HEAD_CHARS = 60;

export interface DoveConfig {
  thresholds: Thresholds;
  /** How long an approval waits for the owner. */
  approvalDays: number;
  /** Without a verdict, a reply to a top-level message goes to the channel while at most this many came after it. */
  placementFollowing: number;
  /** What Jev is shown around the target: how many messages, and the characters each keeps. */
  judgeContext: { messages: number; chars: number };
  /** How large and how many the images of one request may be. */
  images: ImageLimits;
}

export type RaiseDoveReply = (record: (eventId: string, transaction: Transaction) => void) => void;

export interface SlackDoveOptions {
  db: DatabaseSync;
  archive: SlackArchive;
  /** The Web API of each configured workspace, by its name in the config. */
  workspaces: Record<string, SlackApi>;
  /** Without it every draft is "no verdict" and goes to the owner. */
  judge?: JudgeClient;
  config: DoveConfig;
  /** Where Slack fetches the icons from: `<publicOrigin>/avatar/<feeling>.png` (ADR 0040). */
  publicOrigin: string;
  /** natsumi's `/work` as the server sees it: the only place images are taken from. */
  workDirectory: string;
  /** Where the images are copied and recorded, out of the workspace's reach. */
  images: ImageStore;
  now: () => number;
  raise: RaiseDoveReply;
  log?: (line: string) => void;
}

type Placement = 'thread' | 'channel';
type Result = 'sent' | 'reacted' | 'to_owner' | 'returned' | 'rejected' | 'expired' | 'not_sent';
type Failure = 'mechanical-check' | 'slack-error' | 'target-gone' | 'interrupted';

interface PostRow {
  post_id: string; kind: 'post' | 'reaction'; workspace: string; channel_id: string; target_ts: string | null;
  target_thread_ts: string | null; reference: string; text: string; expression: string | null; verdict: string | null;
  scores: string | null; placement: Placement | null; state: string;
}
interface ImageRow { image_id: string; source: string; file: string; mime_type: string; bytes: number }
interface ApprovalRow {
  approval_id: string; revision: number; post_id: string; payload: string; state: string; expires_at: string;
  decision: string | null; decided_text: string | null; decided_placement: Placement | null;
}

/** An approval as the devices are shown it (docs/client-contract.md). */
export type ApprovalPayload = Record<string, unknown> & { approvalId: string; revision: number };

export type DecideInput = {
  approvalId: string; revision: number; decision: 'approve' | 'edit' | 'reject'; text?: string; placement?: Placement; deviceId: string;
};
export type DecideOutcome =
  | { kind: 'accepted'; approvalId: string; revision: number; state: string }
  | { kind: 'rejected'; code: 'invalid-request' | 'stale-revision' };

/** Slack's codes for a target that is not there any more. */
const GONE = new Set(['channel_not_found', 'thread_not_found', 'message_not_found', 'is_archived', 'not_in_channel']);

const FAILURE_WORDS: Record<Failure, string> = {
  'mechanical-check': '本文が送る前の検査に通らなかった',
  'slack-error': 'Slack に断られた',
  'target-gone': '返信先の発言かチャンネルが無くなっていた',
  interrupted: '送る途中でサーバーが止まったので、届いたか分からない',
};

export class SlackDove {
  private readonly options: SlackDoveOptions;
  private readonly db: DatabaseSync;
  private readonly emoji: SlackEmoji;
  private readonly listeners = new Set<(event: { type: string; payload: Record<string, unknown> }) => void>();
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: SlackDoveOptions) {
    this.options = options;
    this.db = options.db;
    this.emoji = new SlackEmoji({ workspaces: options.workspaces, now: options.now, ...(options.log ? { log: options.log } : {}) });
  }

  /** Reads each workspace's custom emoji, so that a missing `emoji:read` shows in the log at the start (ADR 0042). */
  warmEmoji(): Promise<void> { return this.emoji.warm(); }

  /** `approval.pending` and `approval.resolved`, for every device. */
  subscribe(listener: (event: { type: string; payload: Record<string, unknown> }) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close(): void { this.closed = true; }

  /** Resolves once everything asked or decided so far has been carried out. */
  async idle(): Promise<void> {
    let current: Promise<void>;
    do { current = this.chain; await current; } while (current !== this.chain);
  }

  /**
   * A request from natsumi. Refused here, at once, when it is out of shape, names nothing the record has, fails the
   * mechanical check, or asks for a reaction with an emoji Slack does not have; taken otherwise, and carried out in the
   * background.
   */
  async ask(message: string): Promise<ToolOutcome> {
    const refuse = (text: string): ToolOutcome => ({ ok: false, text: text.startsWith('頼んでいません。') ? text : `頼んでいません。${text}` });
    const parsed = parseDoveRequest(message);
    if (!parsed.ok) return refuse(parsed.text);
    const { target, kind, expression, body, images = [] } = parsed.request;
    if (!this.options.workspaces[target.workspace]) {
      return refuse(`ワークスペース「${target.workspace}」は Slack の設定にありません。/sources/slack/INDEX.md にある名前で書いてください。`);
    }
    const resolved = this.options.archive.resolve(target);
    if (!resolved.ok) return refuse(resolved.text);
    if (kind === 'reaction' && !await this.emoji.exists(target.workspace, body)) {
      return refuse(`リアクション「${body}」は付けられません。その名前の絵文字は、標準の絵文字にも ${target.workspace} のカスタム絵文字にもありません。名前の確かめ方は /manual/slack.md にあります。`);
    }
    if (kind === 'post' && body !== '') {
      const check = checkOutgoingText(body);
      if (!check.ok) return refuse(refusalText(check).replace('送信していません。', ''));
    }
    const postId = `post-${randomUUID()}`;
    // Copied last, once nothing else can turn the request back: what is copied is what the owner and Slack are shown.
    let taken: TakenImage[] = [];
    if (images.length > 0) {
      const result = await this.options.images.take(images, this.options.workDirectory, this.options.config.images);
      if (!result.ok) return refuse(result.text);
      taken = result.images;
    }
    const { message: named } = resolved.target;
    const reference = named ? `${resolved.target.label} ${named.at} ${named.speaker}` : resolved.target.label;
    const now = this.iso();
    try {
      this.transaction(() => {
        this.db.prepare(`INSERT INTO dove_posts (post_id, kind, workspace, channel_id, target_ts, target_thread_ts, reference, text,
          expression, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'judging', ?, ?)`)
          .run(postId, kind, target.workspace, resolved.target.channelId, named?.ts ?? null, named?.threadTs ?? null, reference, body,
            expression ?? null, now, now);
        this.options.images.record(taken, now);
        const image = this.db.prepare('INSERT INTO dove_post_images (post_id, position, image_id) VALUES (?, ?, ?)');
        taken.forEach((one, position) => image.run(postId, position, one.imageId));
      });
    } catch (error) {
      await discardImages(taken);
      throw error;
    }
    this.enqueue(() => this.carry(postId));
    const later = 'は、後で agent_reply の出来事（agent: poppo）として届きます。待たずに、ほかのことをしてかまいません。';
    return { ok: true, text: kind === 'reaction'
      ? `ポッポさんがリアクションの依頼を受け付けました。付けたかどうか${later}`
      : body === ''
        ? `ポッポさんが画像 ${taken.length} 枚の投稿の依頼を受け付けました。本文が無いので、判定にも本人にも回さずに届けます。届けたかどうか${later}`
        : `ポッポさんが投稿の依頼${taken.length > 0 ? `（画像 ${taken.length} 枚付き）` : ''}を受け付けました。届けたか、本人に回したか、突き返したか${later}` };
  }

  /**
   * What a previous process left: a draft still being judged is judged now, and one caught in the middle of being sent
   * is never sent again — whether it reached Slack is not known, and a second copy is worse than none.
   */
  resume(): void {
    const sending = this.db.prepare(`SELECT post_id FROM dove_posts WHERE state = 'sending' ORDER BY created_at, rowid`).all() as { post_id: string }[];
    for (const { post_id } of sending) this.fail(this.post(post_id)!, 'interrupted');
    const judging = this.db.prepare(`SELECT post_id FROM dove_posts WHERE state = 'judging' ORDER BY created_at, rowid`).all() as { post_id: string }[];
    for (const { post_id } of judging) this.enqueue(() => this.carry(post_id));
  }

  /** Every approval still waiting and not past its time, oldest first. */
  pendingApprovals(): ApprovalPayload[] {
    return (this.db.prepare(`SELECT payload FROM approvals WHERE state = 'pending' AND expires_at > ? ORDER BY created_at, rowid`)
      .all(this.iso()) as { payload: string }[]).map(row => JSON.parse(row.payload) as ApprovalPayload);
  }

  /** Whether an image belongs to an approval, and so may be shown to the devices (ADR 0044). */
  showsImage(imageId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM dove_post_images p JOIN approvals a ON a.post_id = p.post_id WHERE p.image_id = ?`)
      .get(imageId) !== undefined;
  }

  /**
   * The owner's decision (ADR 0002). Taken once, by a conditional update: an approval already closed answers with the
   * state it closed in, whoever asks. An approval past its time expires here rather than being sent.
   */
  decide(input: DecideInput): DecideOutcome {
    const invalid = { kind: 'rejected', code: 'invalid-request' } as const;
    if (input.decision === 'edit' && (typeof input.text !== 'string' || input.text.trim() === '')) return invalid;
    this.expire();
    const row = this.approval(input.approvalId);
    if (!row) return invalid;
    const accepted = (state: string): DecideOutcome => ({ kind: 'accepted', approvalId: row.approval_id, revision: row.revision, state });
    if (row.state !== 'pending') return accepted(row.state);
    if (input.revision !== row.revision) return { kind: 'rejected', code: 'stale-revision' };
    const state = input.decision === 'approve' ? 'approved' : input.decision === 'edit' ? 'edited' : 'rejected';
    const now = this.iso();
    const text = input.decision === 'edit' ? input.text! : null;
    const placement = input.decision === 'reject' ? null : input.placement ?? null;
    const changed = this.transaction(() => {
      const taken = Number(this.db.prepare(`UPDATE approvals SET state = ?, decision = ?, decided_text = ?, decided_placement = ?,
        device_id = ?, resolved_at = CASE WHEN ? = 'rejected' THEN ? ELSE NULL END WHERE approval_id = ? AND state = 'pending' AND revision = ?`)
        .run(state, input.decision, text, placement, input.deviceId, state, now, row.approval_id, row.revision).changes) > 0;
      if (taken) this.setPost(row.post_id, { state: state === 'rejected' ? 'rejected' : 'sending' });
      return taken;
    });
    if (!changed) return accepted(this.approval(row.approval_id)!.state);
    if (state === 'rejected') {
      this.emit('approval.resolved', { approvalId: row.approval_id, revision: row.revision, state, resolvedAt: now });
      this.tell(row.post_id, 'rejected', 'ポッポ。本人が見送ったから、届けなかったよ。');
    } else {
      this.enqueue(() => this.sendApproved(row.approval_id));
    }
    return accepted(state);
  }

  /** Closes every approval past its time, tells the devices, and tells natsumi. Called on an interval and before a decision. */
  expire(): void {
    const now = this.iso();
    const due = this.db.prepare(`SELECT approval_id, revision, post_id FROM approvals WHERE state = 'pending' AND expires_at <= ?`).all(now) as
      { approval_id: string; revision: number; post_id: string }[];
    for (const row of due) {
      const changed = this.transaction(() => {
        const taken = Number(this.db.prepare(`UPDATE approvals SET state = 'expired', resolved_at = ? WHERE approval_id = ? AND state = 'pending'`)
          .run(now, row.approval_id).changes) > 0;
        if (taken) this.setPost(row.post_id, { state: 'expired' });
        return taken;
      });
      if (!changed) continue;
      this.emit('approval.resolved', { approvalId: row.approval_id, revision: row.revision, state: 'expired', resolvedAt: now });
      this.tell(row.post_id, 'expired', 'ポッポ。本人が決めないまま期限が過ぎたから、届けなかったよ。');
    }
  }

  /**
   * The line one `dove-reply` event becomes inside `<events>`, taken once: the text is emptied from its row as it goes
   * (ADR 0008). Named like an outside agent's answer, from `poppo`, with no ID in it.
   */
  takeEventLine(eventId: string, receivedAt: string): Record<string, unknown> {
    const row = this.db.prepare(`SELECT r.result, r.text, p.reference, p.text AS draft, p.kind FROM dove_replies r
      JOIN dove_posts p ON p.post_id = r.post_id WHERE r.event_id = ?`).get(eventId) as
      { result: Result; text: string; reference: string; draft: string; kind: string } | undefined;
    if (!row) return { type: 'agent_reply', received_at: receivedAt, agent: DOVE_NAME };
    this.db.prepare(`UPDATE dove_replies SET text = '' WHERE event_id = ?`).run(eventId);
    const postId = (this.db.prepare('SELECT post_id FROM dove_replies WHERE event_id = ?').get(eventId) as { post_id: string }).post_id;
    const images = this.images(postId).map(image => image.source);
    return {
      type: 'agent_reply', received_at: receivedAt, agent: DOVE_NAME, result: row.result, reply_to: row.reference,
      ...(row.kind === 'reaction' ? { reaction: row.draft } : row.draft === '' ? {} : { draft: cut(row.draft, DRAFT_HEAD_CHARS) }),
      ...(images.length > 0 ? { images } : {}),
      ...(row.text ? { text: row.text } : {}),
    };
  }

  private enqueue(work: () => Promise<void>): void {
    // After the current tick, so a request is only ever carried out once the tool call that made it has returned.
    this.chain = this.chain.then(() => new Promise<void>(resolve => setImmediate(resolve))).then(async () => {
      if (this.closed) return;
      try { await work(); } catch (error) {
        this.log(`dove: carrying out a request failed (${describeFailure(error)})`);
      }
    });
  }

  /** One request, from judging to what became of it. */
  private async carry(postId: string): Promise<void> {
    const post = this.post(postId);
    if (!post || post.state !== 'judging') return;
    if (post.kind === 'reaction') return this.react(post);
    const target = this.target(post);
    if (post.text === '') return this.sendImagesAlone(post, target);
    const { judgeContext, thresholds } = this.options.config;
    let judged: { verdict: 'send' | 'owner' | 'return'; issues: ScoredIssue[]; placement?: { choice: Placement; probabilities?: Record<string, number> } }
      | undefined;
    const judge = this.options.judge;
    if (judge) {
      const replyTo = target.message;
      try {
        const answer = await judge.judge({
          channel: target.label,
          reply_to: replyTo ? { from: replyTo.speaker, at: replyTo.at, text: cut(replyTo.text, judgeContext.chars) } : null,
          conversation: this.options.archive.around(target, judgeContext.messages, judgeContext.chars),
          draft: post.text,
        }, { placement: replyTo !== undefined && !replyTo.threadTs });
        judged = { ...decideVerdict(answer, thresholds), ...(answer.placement ? { placement: answer.placement } : {}) };
      } catch (error) {
        this.log(`dove: ${error instanceof JudgeError ? error.message : `judge: no verdict (${describeFailure(error)})`}`);
      }
    }
    if (this.closed) return;
    const placement: Placement = !target.message ? 'channel' : judged?.placement?.choice ?? this.defaultPlacement(target);
    const history = this.returnedBefore(post);
    const verdict = !judged ? 'no-verdict' : judged.verdict === 'return' && history.length >= MAX_RETURNS ? 'rewrite-limit' : judged.verdict;
    this.setPost(postId, {
      verdict, placement, ...(judged ? { scores: JSON.stringify(judged.issues) } : {}),
      ...(judged?.placement?.probabilities ? { placement_probabilities: JSON.stringify(judged.placement.probabilities) } : {}),
    });
    const flagged = (judged?.issues ?? []).filter(issue => issue.flagged).map(issue => issue.label);
    if (verdict === 'send') {
      this.setPost(postId, { state: 'sending' });
      const delivered = await this.deliver(post, post.text, placement);
      if (delivered === true) {
        this.setPost(postId, { state: 'sent', sent_text: post.text, sent_placement: placement });
        this.tell(postId, 'sent', `ポッポ！ ${where(target.label, placement)}に${this.withImages(postId)}届けたよ。`);
      } else this.fail(post, delivered);
      return;
    }
    if (verdict === 'return') {
      this.setPost(postId, { state: 'returned' });
      const left = MAX_RETURNS - history.length - 1;
      this.tell(postId, 'returned', `ポッポ、これは届けられないよ。気になったところ: ${flagged.join('・')}。`
        + '直すなら、書き直してもう一度頼んでね。'
        + (left > 0 ? `同じ返信先で突き返せるのはあと ${left} 回で、その次は本人に回すよ。` : '次に突き返すときは、これまでの下書きと一緒に本人に回すよ。'));
      return;
    }
    this.hand(post, target, { verdict, placement, issues: judged?.issues ?? [], probabilities: judged?.placement?.probabilities, history });
    this.tell(postId, 'to_owner', verdict === 'owner'
      ? `ポッポ…気になるところ（${flagged.join('・')}）があるから、本人に見てもらうね。本人が決めたら、また知らせるよ。`
      : verdict === 'rewrite-limit'
        ? `ポッポ…同じ返信先で ${MAX_RETURNS + 1} 回目だから、これまでの下書きと一緒に本人に見てもらうね。本人が決めたら、また知らせるよ。`
        : 'ポッポ…今は判定ができなかったから、本人に見てもらうね。本人が決めたら、また知らせるよ。');
  }

  /** Images with no text (ADR 0044): nothing for Jev to judge, so neither Jev nor the owner; placed as without a verdict. */
  private async sendImagesAlone(post: PostRow, target: ResolvedTarget): Promise<void> {
    const placement: Placement = !target.message ? 'channel' : this.defaultPlacement(target);
    this.setPost(post.post_id, { placement, state: 'sending' });
    const delivered = await this.deliver(post, '', placement);
    if (delivered !== true) return this.fail(post, delivered);
    this.setPost(post.post_id, { state: 'sent', sent_text: '', sent_placement: placement });
    this.tell(post.post_id, 'sent', `ポッポ！ 画像 ${this.images(post.post_id).length} 枚を${where(target.label, placement)}に届けたよ。`);
  }

  /** Makes the approval, fixed as the owner will see it, and tells every device. */
  private hand(post: PostRow, target: ResolvedTarget, reason: {
    verdict: string; placement: Placement; issues: ScoredIssue[]; probabilities: Record<string, number> | undefined;
    history: { text: string; issues: ScoredIssue[] }[];
  }): void {
    const approvalId = `approval-${randomUUID()}`;
    const createdAt = this.iso();
    const expiresAt = isoAt(this.options.now() + this.options.config.approvalDays * 86_400_000);
    const replyTo = target.message;
    const images = this.images(post.post_id);
    const payload: ApprovalPayload = {
      approvalId, revision: 1, kind: 'slack-post', createdAt, expiresAt,
      target: { channel: target.label, placement: reason.placement,
        ...(replyTo ? { replyTo: { speaker: replyTo.speaker, at: replyTo.at, text: cut(replyTo.text, REPLY_TO_HEAD_CHARS) } } : {}) },
      text: post.text,
      ...(post.expression ? { expression: post.expression } : {}),
      ...(images.length > 0 ? { images: images.map(image => ({ imageId: image.image_id, mimeType: image.mime_type, bytes: image.bytes })) } : {}),
      reason: { verdict: reason.verdict, issues: reason.issues, ...(reason.probabilities ? { placement: { probabilities: reason.probabilities } } : {}) },
      history: reason.history.map(entry => ({ text: entry.text, issues: entry.issues.filter(issue => issue.flagged) })),
    };
    this.transaction(() => {
      this.db.prepare(`INSERT INTO approvals (approval_id, revision, kind, post_id, payload, state, created_at, expires_at)
        VALUES (?, 1, 'slack-post', ?, ?, 'pending', ?, ?)`).run(approvalId, post.post_id, JSON.stringify(payload), createdAt, expiresAt);
      this.setPost(post.post_id, { state: 'pending' });
    });
    this.emit('approval.pending', payload);
  }

  /** Sends what the owner approved: the draft as shown to her, or her own text. Never judged again. */
  private async sendApproved(approvalId: string): Promise<void> {
    const approval = this.approval(approvalId);
    if (!approval || (approval.state !== 'approved' && approval.state !== 'edited')) return;
    const post = this.post(approval.post_id)!;
    if (post.state !== 'sending') return;
    const shown = JSON.parse(approval.payload) as { text: string; target: { channel: string; placement: Placement } };
    const text = approval.state === 'edited' ? approval.decided_text! : shown.text;
    const placement: Placement = post.target_ts ? approval.decided_placement ?? shown.target.placement : 'channel';
    const delivered = await this.deliver(post, text, placement);
    const resolvedAt = this.iso();
    if (delivered === true) {
      this.transaction(() => {
        this.db.prepare(`UPDATE approvals SET delivery = 'sent', sent_text = ?, resolved_at = ? WHERE approval_id = ?`).run(text, resolvedAt, approvalId);
        this.setPost(post.post_id, { state: 'sent', sent_text: text, sent_placement: placement });
      });
      this.emit('approval.resolved', { approvalId, revision: approval.revision, state: approval.state, resolvedAt, delivery: 'sent', sentText: text });
      this.tell(post.post_id, 'sent', approval.state === 'edited'
        ? `ポッポ！ 本人が直した本文で、${where(shown.target.channel, placement)}に${this.withImages(post.post_id)}届けたよ。届けた本文:「${text}」`
        : `ポッポ！ 本人が承認したから、${where(shown.target.channel, placement)}に${this.withImages(post.post_id)}届けたよ。`);
      return;
    }
    this.fail(post, delivered);
  }

  /** A reaction: no judge and no owner (ADR 0039, ADR 0042). */
  private async react(post: PostRow): Promise<void> {
    this.setPost(post.post_id, { state: 'sending' });
    const api = this.options.workspaces[post.workspace];
    try {
      if (!api || !post.target_ts) throw new SlackCallError('reactions.add', 'not_configured');
      if (!this.options.archive.isPresent(post.workspace, post.channel_id, post.target_ts)) return this.fail(post, 'target-gone');
      await api.addReaction(post.channel_id, post.target_ts, post.text);
    } catch (error) {
      this.log(`slack (${post.workspace}): reacting failed (${describeFailure(error)})`);
      return this.fail(post, error instanceof SlackCallError && GONE.has(error.reason) ? 'target-gone' : 'slack-error');
    }
    this.setPost(post.post_id, { state: 'sent', sent_text: post.text });
    this.tell(post.post_id, 'reacted', `ポッポ！ :${post.text}: を付けたよ。`);
  }

  /**
   * The last check and the post itself: the text, or the images with the text as their comment. True when Slack took
   * it; otherwise why not. Only images alone go without text, and then there is no text to check.
   */
  private async deliver(post: PostRow, text: string, placement: Placement): Promise<true | Failure> {
    const images = this.images(post.post_id);
    if ((text !== '' || images.length === 0) && !checkOutgoingText(text).ok) return 'mechanical-check';
    if (post.target_ts && !this.options.archive.isPresent(post.workspace, post.channel_id, post.target_ts)) return 'target-gone';
    const api = this.options.workspaces[post.workspace];
    if (!api) return 'slack-error';
    const threadTs = placement === 'thread' && post.target_ts ? post.target_thread_ts ?? post.target_ts : undefined;
    const expression = post.expression ?? 'neutral';
    try {
      if (images.length > 0) {
        // The copies taken when she asked, never /work again. Slack takes no icon with an upload.
        const files = await Promise.all(images.map(async image => ({ filename: basename(image.source),
          data: await readFile(this.options.images.path(image.file)) })));
        await api.uploadFiles(post.channel_id, files, { ...(threadTs ? { threadTs } : {}), ...(text !== '' ? { initialComment: text } : {}) });
        return true;
      }
      await api.postMessage(post.channel_id, text, { ...(threadTs ? { threadTs } : {}),
        iconUrl: `${this.options.publicOrigin}/avatar/${expression}.png` });
      return true;
    } catch (error) {
      this.log(`slack (${post.workspace}): posting failed (${describeFailure(error)})`);
      return error instanceof SlackCallError && GONE.has(error.reason) ? 'target-gone' : 'slack-error';
    }
  }

  /** Not sent: recorded, the owner's devices told when it was hers, and natsumi told. */
  private fail(post: PostRow, failure: Failure): void {
    const resolvedAt = this.iso();
    const approval = this.db.prepare(`SELECT approval_id, revision, state FROM approvals WHERE post_id = ?`).get(post.post_id) as
      { approval_id: string; revision: number; state: string } | undefined;
    const reason = failure === 'interrupted' ? 'slack-error' : failure;
    this.transaction(() => {
      this.setPost(post.post_id, { state: 'failed', failure });
      if (approval) {
        this.db.prepare(`UPDATE approvals SET delivery = 'failed', delivery_reason = ?, resolved_at = ? WHERE approval_id = ?`)
          .run(reason, resolvedAt, approval.approval_id);
      }
    });
    if (approval) {
      this.emit('approval.resolved', { approvalId: approval.approval_id, revision: approval.revision, state: approval.state, resolvedAt,
        delivery: 'failed', reason });
    }
    this.tell(post.post_id, 'not_sent', `ポッポ…届けられなかったよ（${FAILURE_WORDS[failure]}）。`);
  }

  /** The drafts turned back on this target since anything else happened there, oldest first. */
  private returnedBefore(post: PostRow): { text: string; issues: ScoredIssue[] }[] {
    const rows = this.db.prepare(`SELECT text, verdict, scores FROM dove_posts WHERE kind = 'post' AND workspace = ? AND channel_id = ?
      AND IFNULL(target_ts, '') = ? AND state <> 'judging' AND rowid < (SELECT rowid FROM dove_posts WHERE post_id = ?)
      ORDER BY rowid DESC`)
      .all(post.workspace, post.channel_id, post.target_ts ?? '', post.post_id) as
      { text: string; verdict: string | null; scores: string | null }[];
    const streak: { text: string; issues: ScoredIssue[] }[] = [];
    for (const row of rows) {
      if (row.verdict !== 'return') break;
      streak.unshift({ text: row.text, issues: row.scores ? JSON.parse(row.scores) as ScoredIssue[] : [] });
    }
    return streak;
  }

  /** Without Jev's choice: a reply to a top-level message the channel has not moved on from goes to the channel. */
  private defaultPlacement(target: ResolvedTarget): Placement {
    const message = target.message!;
    if (message.threadTs) return 'thread';
    return this.options.archive.following(target.workspace, target.channelId, message.ts) <= this.options.config.placementFollowing
      ? 'channel' : 'thread';
  }

  private target(post: PostRow): ResolvedTarget {
    const channel = this.options.archive.channel(post.workspace, post.channel_id);
    const label = `${post.workspace}/${channel?.label ?? post.reference.split(' ')[0]!.split('/')[1]}`;
    if (!post.target_ts) return { workspace: post.workspace, channelId: post.channel_id, label };
    const [, date, time, ...speaker] = post.reference.split(' ');
    const row = this.db.prepare('SELECT text FROM slack_messages WHERE workspace = ? AND channel_id = ? AND ts = ?')
      .get(post.workspace, post.channel_id, post.target_ts) as { text: string } | undefined;
    return { workspace: post.workspace, channelId: post.channel_id, label, message: { ts: post.target_ts,
      ...(post.target_thread_ts ? { threadTs: post.target_thread_ts } : {}), speaker: speaker.join(' '), at: `${date} ${time}`, text: row?.text ?? '' } };
  }

  /** Tells natsumi, as an event of its own that waits behind whatever she is doing. */
  private tell(postId: string, result: Result, text: string): void {
    if (this.closed) return;
    this.options.raise(eventId => {
      this.db.prepare('INSERT INTO dove_replies (event_id, post_id, result, text, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(eventId, postId, result, text, this.iso());
    });
  }

  private emit(type: string, payload: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      try { listener({ type, payload }); } catch { /* one listener cannot stop the others */ }
    }
  }

  private post(postId: string): PostRow | undefined {
    return this.db.prepare('SELECT * FROM dove_posts WHERE post_id = ?').get(postId) as PostRow | undefined;
  }

  /** A post's images, in the order she named them. */
  private images(postId: string): ImageRow[] {
    return this.db.prepare(`SELECT i.image_id, i.source, i.file, i.mime_type, i.bytes FROM dove_post_images p
      JOIN images i ON i.image_id = p.image_id WHERE p.post_id = ? ORDER BY p.position`).all(postId) as unknown as ImageRow[];
  }

  /** `画像 2 枚と一緒に` when the post has images, for the line that says it was sent. */
  private withImages(postId: string): string {
    const count = this.images(postId).length;
    return count > 0 ? `画像 ${count} 枚と一緒に` : '';
  }

  private approval(approvalId: string): ApprovalRow | undefined {
    return this.db.prepare('SELECT * FROM approvals WHERE approval_id = ?').get(approvalId) as ApprovalRow | undefined;
  }

  private setPost(postId: string, fields: Record<string, string | null>): void {
    const names = Object.keys(fields);
    this.db.prepare(`UPDATE dove_posts SET ${names.map(name => `${name} = ?`).join(', ')}, updated_at = ? WHERE post_id = ?`)
      .run(...names.map(name => fields[name]!), this.iso(), postId);
  }

  private transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private iso(): string { return isoAt(this.options.now()); }

  private log(line: string): void { this.options.log?.(line); }
}

function where(label: string, placement: Placement): string {
  return placement === 'thread' ? `${label} のスレッド` : label;
}

function cut(text: string, max: number): string {
  const characters = [...text];
  return characters.length > max ? `${characters.slice(0, max).join('')}…` : text;
}
