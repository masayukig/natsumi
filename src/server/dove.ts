import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { AGENTS_PATH, type ReplyPlace } from './agent-replies.ts';
import {
  requestLine, resultAttention, targetHead, writeDoveRequest, writeDoveResults, type DoveRequestRecord, type DoveResultLine,
} from './dove-files.ts';
import { parseDoveRequest, type DoveTarget } from './dove-request.ts';
import { discardImages, type ImageLimits, type ImageStore, type TakenImage } from './images.ts';
import { judgeSideBySide, JUDGE_METHODS, SIGNAL_JUDGE_ISSUES, type JudgeChoice, type JudgeMethod, type JudgeSlot, type Placement, type ScoredIssue } from './judge.ts';
import type { ToolOutcome } from './loop-tools.ts';
import { isoAt, localDateTime } from './nightly.ts';
import { checkOutgoingText, refusalText } from './output-checks.ts';
import { describeFailure, SlackCallError, type SlackApi } from './slack-api.ts';
import type { Flow, MessageLine, ResolvedTarget, SlackArchive } from './slack-archive.ts';
import { SlackEmoji } from './slack-emoji.ts';
import { postWithImages } from './slack-images.ts';

/**
 * The dove, ポッポさん (ADR 0012, ADR 0039, ADR 0040, ADR 0042): the only way anything natsumi writes reaches Slack.
 *
 * She asks through `ask_agent` with the agent `poppo`, and the tool only says the request was taken. The request is
 * read and its target matched against the record at once, so a request out of shape never goes further. Then, in the
 * background, the draft is judged over what surrounds its target by the judges that are on, side by side (ADR 0059),
 * and the server's rule on the deciding judge's scores decides: send it now, hand it to the owner, or turn it back to
 * natsumi with the reasons. The third return on the same target
 * goes to the owner instead, with the drafts before it. A reaction with any emoji that exists is put on with neither
 * Jev nor the owner.
 *
 * Each request taken gets a directory under /sources/agents/poppo with what she asked (ADR 0074), and whatever happens
 * to it becomes a line of its results.jsonl, in the server's words and naming no ID (ADR 0024), told to her by an
 * attention of a `sources_updated` event. A result is recorded in the database as it happens, and written and told
 * from there: one the process stopped before telling is told on the next start, and none is told twice.
 *
 * A post may carry images from /work (ADR 0044), copied to the server's side as it is asked, so that the owner approves
 * and Slack is sent the copy. Only the text is judged; images alone go with neither a judge nor the owner, placed by the
 * rule used without a verdict.
 *
 * What the owner decides is final and is taken once: a second answer gets the first one back (ADR 0002). Only what she
 * approved, or her own text, is sent, and the mechanical check comes right before every send, hers included.
 *
 * A reply goes to one of three places (ADR 0062): its thread (`thread`), the channel itself with no thread (`channel`),
 * or its thread shown in the channel too (`broadcast`, Slack's `reply_broadcast`). Slack uploads images with no such
 * choice, so images placed as a broadcast go to the thread alone.
 *
 * The log names the workspace, the Slack method and Slack's code, or a judge's kind of failure; never a draft nor an ID.
 */

export const DOVE_NAME = 'poppo';
/**
 * Fork (ADR F07): the `workspace` of a post to a Signal group, which no Slack workspace can be named (they are plain).
 * Its `channel_id` is the group's ID and its `target_ts` the Signal timestamp of the message replied to.
 */
export const SIGNAL_GROUPS = '#signal';

/** Fork (ADR F07): a send that may or may not have reached Signal (timed out, the daemon failed, no answer to read). */
export class DeliveryUnknown extends Error {
  override name = 'DeliveryUnknown';
}

/**
 * Fork (ADR F07): a Signal failure for the log, in the few words this fork's own errors use, which name no number and
 * no ID; anything else only by its kind.
 */
export function describeSignalFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^(rpc error -?\d+|send [A-Z_]+|http \d{3}|timed out|no timestamp|bad json|fetch failed|not an approved group( or line)?)$/.test(message)
    ? message : error instanceof Error ? error.name : 'error';
}

/**
 * Fork (ADR F07): the Signal groups the owner approved, as a place the dove posts to. A target's `label` names the group
 * as the owner and natsumi read it; a reply is sent as a quote, for Signal has no threads.
 */
export interface DoveSignalGroups {
  /** What natsumi named under /sources/signal, matched against the record, or a sentence saying what to write instead. */
  resolve(to: DoveTarget): { ok: true; target: ResolvedTarget } | { ok: false; text: string };
  /** What the judges are shown of the group: its latest messages. A group has no thread. */
  flows(target: ResolvedTarget, messages: number, chars: number): { now: string; channel: Flow; thread: Flow | null };
  target(groupId: string, ts: string | null): ResolvedTarget;
  lineOf(groupId: string, ts: string): MessageLine | undefined;
  /** Whether an emoji is one Signal can put on: one real emoji, not a Slack name. */
  isEmoji(emoji: string): boolean;
  /** Posts, quoting the message at `quote`, records her line, and answers its key (as `target` takes it). */
  post(groupId: string, text: string, options: { quote?: string; attachments?: string[] }): Promise<string>;
  putReaction(groupId: string, ts: string, emoji: string): Promise<void>;
}
/** Returns on one target before the next one goes to the owner: two rewrites, as ADR 0012 set. */
export const MAX_RETURNS = 2;
/** How much of the message replied to an approval shows. */
const REPLY_TO_HEAD_CHARS = 100;

export interface DoveConfig {
  /** How long an approval waits for the owner. */
  approvalDays: number;
  /** Without a verdict, a reply to a top-level message goes to the channel itself while at most this many came after it. */
  placementFollowing: number;
  /** What the judges are shown of the channel and of the thread, each: how many messages, and the characters each keeps. */
  judgeContext: { messages: number; chars: number };
  /** How large and how many the images of one request may be. */
  images: ImageLimits;
}

/** natsumi's own post as it was sent, for the record of Slack to have it before Slack tells of it. */
export interface OwnPost { ts: string; threadTs?: string; text: string }

export interface SlackDoveOptions {
  db: DatabaseSync;
  /** Absent when only Signal groups are configured (fork, ADR F07). */
  archive?: SlackArchive;
  /** Fork (ADR F07): the Signal groups she may post to. */
  signal?: DoveSignalGroups;
  /** The Web API of each configured workspace, by its name in the config. */
  workspaces: Record<string, SlackApi>;
  /** The judges the config has an endpoint for, each with its thresholds. Without any every draft goes to the owner. */
  judges: Partial<Record<JudgeMethod, JudgeSlot>>;
  /** Which judges are on and which one decides, read as each draft is judged: the settings may change it (ADR 0059). */
  judgeChoice: () => JudgeChoice;
  config: DoveConfig;
  /** Where Slack fetches the icons from: `<publicOrigin>/avatar/<feeling>.png` (ADR 0040). */
  publicOrigin: string;
  /** Fork (ADR F01): where the icons are fetched instead, `<avatarBaseUrl>/<feeling>.png`, when publicOrigin is out of Slack's reach. */
  avatarBaseUrl?: string;
  /** natsumi's `/work` as the server sees it: the only place images are taken from. */
  workDirectory: string;
  /** Where the images are copied and recorded, out of the workspace's reach. */
  images: ImageStore;
  /**
   * Where the requests and their results are put and how she hears of them (ADR 0074): `sources/agents`, and the
   * attentions of the sources. Without it every request is refused, for she would never hear what became of it.
   */
  place?: ReplyPlace;
  /** Records her own post in the record of Slack as it is sent, so a result can name its line (ADR 0074). */
  recordOwn?: (workspace: string, channelId: string, post: OwnPost) => Promise<void>;
  /** The owner's time zone, in which the times of the requests and results are written. */
  timeZone: string;
  now: () => number;
  log?: (line: string) => void;
}

type Result = 'sent' | 'reacted' | 'to_owner' | 'returned' | 'rejected' | 'expired' | 'not_sent';
type Failure = 'mechanical-check' | 'slack-error' | 'signal-error' | 'signal-unknown' | 'target-gone' | 'interrupted';
/** What Slack took: the post's ts when it gave one (an upload gives none). */
interface Delivered { ts?: string }

interface PostRow {
  post_id: string; kind: 'post' | 'reaction'; workspace: string; channel_id: string; target_ts: string | null;
  target_thread_ts: string | null; reference: string; text: string; expression: string | null; verdict: string | null;
  scores: string | null; placement: Placement | null; state: string; place: string | null; created_at: string;
}
interface ResultRow { result_id: number; post_id: string; result: Result; text: string; posted_ts: string | null; told: number; created_at: string }
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
  'signal-error': 'Signal に断られた',
  'signal-unknown': 'Signal から答えが無かった',
  'target-gone': '返信先の発言かチャンネルが無くなっていた',
  interrupted: '送る途中でサーバーが止まったので、届いたか分からない',
};

export class SlackDove {
  private readonly options: SlackDoveOptions;
  private readonly db: DatabaseSync;
  private readonly emoji: SlackEmoji;
  private readonly listeners = new Set<(event: { type: string; payload: Record<string, unknown> }) => void>();
  private chain: Promise<void> = Promise.resolve();
  /** The results being written and told, one round at a time. */
  private telling: Promise<void> = Promise.resolve();
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

  /** Resolves once everything asked or decided so far has been carried out, and told. */
  async idle(): Promise<void> {
    let current: Promise<void>;
    let told: Promise<void>;
    do {
      current = this.chain; told = this.telling;
      await current; await told;
    } while (current !== this.chain || told !== this.telling);
  }

  /**
   * A request from natsumi. Refused here, at once, when it is out of shape, names nothing the record has, fails the
   * mechanical check, or asks for a reaction with an emoji Slack does not have; taken otherwise, and carried out in the
   * background.
   */
  async ask(message: string): Promise<ToolOutcome> {
    const refuse = (text: string): ToolOutcome => ({ ok: false, text: text.startsWith('頼んでいません。') ? text : `頼んでいません。${text}` });
    const place = this.options.place;
    if (!place) return refuse(`結果を置く場所（${AGENTS_PATH}）を用意できていないので、どうなったかを知らせられません。急ぎならマスターに伝えてください。`);
    const parsed = parseDoveRequest(message);
    if (!parsed.ok) return refuse(parsed.text);
    const { to, kind, expression, body, images = [] } = parsed.request;
    // Fork (ADR F07): a Signal group is named under /sources/signal.
    const toSignal = to.file === '/sources/signal' || to.file.startsWith('/sources/signal/');
    const signal = toSignal ? this.options.signal : undefined;
    if (toSignal && !signal) return refuse('Signal のグループには投稿できない設定です。');
    if (!signal && !this.options.archive) return refuse(`to.file「${to.file}」には投稿できません。Signal のグループなら /sources/signal の下のファイルを書いてください（/manual/signal.md）。`);
    const resolved = signal ? signal.resolve(to) : this.options.archive!.resolve(to);
    if (!resolved.ok) return refuse(resolved.text);
    const { workspace } = resolved.target;
    if (signal) {
      if (kind === 'reaction' && !signal.isEmoji(body)) {
        return refuse(`リアクション「${body}」は付けられません。Signal では絵文字そのもの（例: "👍"）を 1 つ書きます。Slack の名前（"+1" など）は使えません。`);
      }
    } else if (!this.options.workspaces[workspace]) {
      return refuse(`ワークスペース「${workspace}」は Slack の設定にありません。/sources/slack/INDEX.md にあるチャンネルを書いてください。`);
    }
    if (!signal && kind === 'reaction' && !await this.emoji.exists(workspace, body)) {
      return refuse(`リアクション「${body}」は付けられません。その名前の絵文字は、標準の絵文字にも ${workspace} のカスタム絵文字にもありません。名前の確かめ方は /manual/slack.md にあります。`);
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
    const at = this.options.now();
    const record: DoveRequestRecord = { kind, to, ...(expression ? { face: expression } : {}),
      ...(kind === 'reaction' ? { emoji: body } : body !== '' ? { text: body } : {}), ...(images.length > 0 ? { images } : {}),
      asked_at: this.local(at), target: targetOf(resolved.target) };
    // The request's directory is made before it is recorded, so its first result always has somewhere to go.
    let made: { path: string; directory: string };
    try { made = await writeDoveRequest(place.directory, DOVE_NAME, at, record); } catch {
      await discardImages(taken);
      this.log('dove: a request could not be put in /sources');
      return refuse(`依頼を ${AGENTS_PATH} に置けませんでした。急ぎならマスターに伝えてください。`);
    }
    // The request is hers and tells her nothing: only its results are news (ADR 0069).
    try { await place.takeIn(made.path); } catch { this.log('dove: a request could not be taken in by the sources; it may be shown as an update'); }
    const now = this.iso();
    try {
      this.transaction(() => {
        this.db.prepare(`INSERT INTO dove_posts (post_id, kind, workspace, channel_id, target_ts, target_thread_ts, reference, text,
          expression, state, place, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'judging', ?, ?, ?)`)
          .run(postId, kind, workspace, resolved.target.channelId, named?.ts ?? null, named?.threadTs ?? null, reference, body,
            expression ?? null, made.path, now, now);
        this.options.images.record(taken, now);
        const image = this.db.prepare('INSERT INTO dove_post_images (post_id, position, image_id) VALUES (?, ?, ?)');
        taken.forEach((one, position) => image.run(postId, position, one.imageId));
      });
    } catch (error) {
      await discardImages(taken);
      await rm(made.directory, { recursive: true, force: true });
      throw error;
    }
    this.enqueue(() => this.carry(postId));
    const later = `は、後で同じディレクトリの results.jsonl に 1 行ずつ足され、sources_updated の attention（kind: agent_reply、agent: poppo）で届きます。`
      + '待たずに、ほかのことをしてかまいません。';
    const asked = `頼んだことは ${made.path}/request.json に置きました。`;
    return { ok: true, text: kind === 'reaction'
      ? `ポッポさんがリアクションの依頼を受け付けました。${asked}付けたかどうか${later}`
      : body === ''
        ? `ポッポさんが画像 ${taken.length} 枚の投稿の依頼を受け付けました。${asked}本文が無いので、判定にもマスターにも回さずに届けます。届けたかどうか${later}`
        : `ポッポさんが投稿の依頼${taken.length > 0 ? `（画像 ${taken.length} 枚付き）` : ''}を受け付けました。${asked}届けたか、マスターに回したか、突き返したか${later}` };
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
    // A result the last process recorded and did not get to tell.
    this.tellLater();
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
      this.tell(row.post_id, 'rejected', 'ポッポ。マスターが見送ったから、届けなかったよ。');
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
      this.tell(row.post_id, 'expired', 'ポッポ。マスターが決めないまま期限が過ぎたから、届けなかったよ。');
    }
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
    const { judgeContext } = this.options.config;
    const replyTo = target.message;
    const choice = this.options.judgeChoice();
    const signal = this.signalOf(post);
    const { now, ...conversation } = (signal ?? this.options.archive!).flows(target, judgeContext.messages, judgeContext.chars);
    const both = await judgeSideBySide(this.options.judges, choice, {
      channel: target.label, now,
      reply_to: replyTo ? { from: replyTo.speaker, at: replyTo.at, text: cut(replyTo.text, judgeContext.chars), in_thread: replyTo.threadTs !== undefined } : null,
      conversation,
      draft: post.text,
      // Fork: a reply to a message inside a thread stays in that thread; the judge is not asked where (fork 8e4b1b1).
    }, { placement: !signal && replyTo !== undefined && replyTo.threadTs === undefined, ...(signal ? { issues: SIGNAL_JUDGE_ISSUES } : {}) });
    for (const method of JUDGE_METHODS) {
      const result = both.results[method];
      if (result && 'error' in result) this.log(`dove: judge (${method}): no verdict (${result.error})`);
    }
    const judged = both.decided;
    if (this.closed) return;
    // A Signal group has no thread: a reply is a quote in the group itself.
    const placement: Placement = !target.message || signal ? 'channel' : judged?.placement?.choice ?? this.defaultPlacement(target);
    const history = this.returnedBefore(post);
    const verdict = !judged ? 'no-verdict' : judged.verdict === 'return' && history.length >= MAX_RETURNS ? 'rewrite-limit' : judged.verdict;
    const kept = (method: JudgeMethod) => { const result = both.results[method]; return result ? JSON.stringify(result) : null; };
    this.setPost(postId, {
      verdict, placement, ...(judged ? { scores: JSON.stringify(judged.issues) } : {}),
      ...(judged?.placement?.probabilities ? { placement_probabilities: JSON.stringify(judged.placement.probabilities) } : {}),
      judge_adopted: both.adopted, judge_decided_by: both.decidedBy, judgement_logprobs: kept('logprobs'), judgement_jev: kept('jev'),
    });
    const flagged = (judged?.issues ?? []).filter(issue => issue.flagged).map(issue => issue.label);
    if (verdict === 'send') {
      this.setPost(postId, { state: 'sending' });
      const delivered = await this.deliver(post, post.text, placement);
      if (typeof delivered === 'object') {
        this.setPost(postId, { state: 'sent', sent_text: post.text, sent_placement: placement });
        this.tell(postId, 'sent', `ポッポ！ ${this.sentTo(post, target.label, placement)}よ。`, delivered.ts);
      } else this.fail(post, delivered);
      return;
    }
    if (verdict === 'return') {
      this.setPost(postId, { state: 'returned' });
      const left = MAX_RETURNS - history.length - 1;
      this.tell(postId, 'returned', `ポッポ、これは届けられないよ。気になったところ: ${flagged.join('・')}。`
        + '直すなら、書き直してもう一度頼んでね。'
        + (left > 0 ? `同じ返信先で突き返せるのはあと ${left} 回で、その次はマスターに回すよ。` : '次に突き返すときは、これまでの下書きと一緒にマスターに回すよ。'));
      return;
    }
    this.hand(post, target, { verdict, placement, issues: judged?.issues ?? [], probabilities: judged?.placement?.probabilities, history });
    this.tell(postId, 'to_owner', verdict === 'owner'
      ? `ポッポ…気になるところ（${flagged.join('・')}）があるから、マスターに見てもらうね。マスターが決めたら、また知らせるよ。`
      : verdict === 'rewrite-limit'
        ? `ポッポ…同じ返信先で ${MAX_RETURNS + 1} 回目だから、これまでの下書きと一緒にマスターに見てもらうね。マスターが決めたら、また知らせるよ。`
        : 'ポッポ…今は判定ができなかったから、マスターに見てもらうね。マスターが決めたら、また知らせるよ。');
  }

  /** Images with no text (ADR 0044): nothing to judge, so neither a judge nor the owner; placed as without a verdict. */
  private async sendImagesAlone(post: PostRow, target: ResolvedTarget): Promise<void> {
    const placement: Placement = !target.message || this.signalOf(post) ? 'channel' : this.defaultPlacement(target);
    this.setPost(post.post_id, { placement, state: 'sending' });
    const delivered = await this.deliver(post, '', placement);
    if (typeof delivered !== 'object') return this.fail(post, delivered);
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
    if (typeof delivered === 'object') {
      this.transaction(() => {
        this.db.prepare(`UPDATE approvals SET delivery = 'sent', sent_text = ?, resolved_at = ? WHERE approval_id = ?`).run(text, resolvedAt, approvalId);
        this.setPost(post.post_id, { state: 'sent', sent_text: text, sent_placement: placement });
      });
      this.emit('approval.resolved', { approvalId, revision: approval.revision, state: approval.state, resolvedAt, delivery: 'sent', sentText: text });
      this.tell(post.post_id, 'sent', approval.state === 'edited'
        ? `ポッポ！ マスターが直した本文で、${this.sentTo(post, shown.target.channel, placement)}よ。届けた本文:「${text}」`
        : `ポッポ！ マスターが承認したから、${this.sentTo(post, shown.target.channel, placement)}よ。`, delivered.ts);
      return;
    }
    this.fail(post, delivered);
  }

  /** A reaction: no judge and no owner (ADR 0039, ADR 0042). */
  private async react(post: PostRow): Promise<void> {
    this.setPost(post.post_id, { state: 'sending' });
    const signal = this.signalOf(post);
    if (signal) {
      try { await signal.putReaction(post.channel_id, post.target_ts!, post.text); } catch (error) {
        this.log(`signal: reacting in a group failed (${describeSignalFailure(error)})`);
        return this.fail(post, error instanceof DeliveryUnknown ? 'signal-unknown' : 'signal-error');
      }
      this.setPost(post.post_id, { state: 'sent', sent_text: post.text });
      this.tell(post.post_id, 'reacted', `ポッポ！ ${post.text} を付けたよ。`);
      return;
    }
    const api = this.options.workspaces[post.workspace];
    try {
      if (!api || !post.target_ts) throw new SlackCallError('reactions.add', 'not_configured');
      if (!this.options.archive!.isPresent(post.workspace, post.channel_id, post.target_ts)) return this.fail(post, 'target-gone');
      await api.addReaction(post.channel_id, post.target_ts, post.text);
    } catch (error) {
      this.log(`slack (${post.workspace}): reacting failed (${describeFailure(error)})`);
      return this.fail(post, error instanceof SlackCallError && GONE.has(error.reason) ? 'target-gone' : 'slack-error');
    }
    this.setPost(post.post_id, { state: 'sent', sent_text: post.text });
    this.tell(post.post_id, 'reacted', `ポッポ！ :${post.text}: を付けたよ。`);
  }

  /**
   * The last check and the post itself: the text, or the images with the text as their comment. What Slack took, with
   * her post recorded when Slack gave its ts; otherwise why not. Only images alone go without text, and then there is
   * no text to check.
   */
  private async deliver(post: PostRow, text: string, placement: Placement): Promise<Delivered | Failure> {
    const images = this.images(post.post_id);
    if ((text !== '' || images.length === 0) && !checkOutgoingText(text).ok) return 'mechanical-check';
    const signal = this.signalOf(post);
    if (signal) {
      try {
        // The copies taken when she asked, as data URIs, which the daemon takes as attachments.
        const attachments = await Promise.all(images.map(async image =>
          `data:${image.mime_type};base64,${(await readFile(this.options.images.path(image.file))).toString('base64')}`));
        return { ts: await signal.post(post.channel_id, text, { ...(post.target_ts ? { quote: post.target_ts } : {}), attachments }) };
      } catch (error) {
        this.log(`signal: posting in a group failed (${describeSignalFailure(error)})`);
        return error instanceof DeliveryUnknown ? 'signal-unknown' : 'signal-error';
      }
    }
    if (post.target_ts && !this.options.archive!.isPresent(post.workspace, post.channel_id, post.target_ts)) return 'target-gone';
    const api = this.options.workspaces[post.workspace];
    if (!api) return 'slack-error';
    const replyThread = post.target_ts ? post.target_thread_ts ?? post.target_ts : undefined;
    const expression = post.expression ?? 'neutral';
    let threadTs: string | undefined;
    let ts: string;
    try {
      if (images.length > 0) {
        // A broadcast of images stays in the thread: Slack's upload cannot show it in the channel too.
        threadTs = placement === 'channel' ? undefined : replyThread;
        // The copies taken when she asked, never /work again. Slack takes no icon with an upload.
        const files = await Promise.all(images.map(async image => ({ filename: basename(image.source),
          data: await readFile(this.options.images.path(image.file)) })));
        // Fork (ADR F03): shown by image blocks under her icon instead, the upload kept as the fallback.
        await postWithImages(api, post.channel_id, text, files, { ...(threadTs ? { threadTs } : {}),
          iconUrl: `${this.options.avatarBaseUrl ?? `${this.options.publicOrigin}/avatar`}/${expression}.png`,
          log: line => this.log(`slack (${post.workspace}): ${line}`) });
        return {};
      }
      // The channel itself takes no thread; a broadcast goes to the thread and is shown in the channel too.
      threadTs = placement === 'channel' ? undefined : replyThread;
      ts = await api.postMessage(post.channel_id, text, { ...(threadTs ? { threadTs } : {}),
        ...(threadTs && placement === 'broadcast' ? { replyBroadcast: true } : {}),
        iconUrl: `${this.options.avatarBaseUrl ?? `${this.options.publicOrigin}/avatar`}/${expression}.png` });
    } catch (error) {
      this.log(`slack (${post.workspace}): posting failed (${describeFailure(error)})`);
      return error instanceof SlackCallError && GONE.has(error.reason) ? 'target-gone' : 'slack-error';
    }
    if (!ts) return {};
    // It was sent whatever comes of this: without it the result names no line of hers.
    try { await this.options.recordOwn?.(post.workspace, post.channel_id, { ts, ...(threadTs ? { threadTs } : {}), text }); } catch (error) {
      this.log(`dove: her own post could not be recorded (${describeFailure(error)})`);
    }
    return { ts };
  }

  /** Not sent: recorded, the owner's devices told when it was hers, and natsumi told. */
  private fail(post: PostRow, failure: Failure): void {
    const resolvedAt = this.iso();
    const approval = this.db.prepare(`SELECT approval_id, revision, state FROM approvals WHERE post_id = ?`).get(post.post_id) as
      { approval_id: string; revision: number; state: string } | undefined;
    // The devices know three reasons (docs/client-contract.md): a Signal failure is recorded as Slack's.
    const reason = failure === 'interrupted' || failure === 'signal-error' || failure === 'signal-unknown' ? 'slack-error' : failure;
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
    this.tell(post.post_id, 'not_sent', failure === 'signal-unknown'
      ? `ポッポ…届いたかどうか分からないよ（${FAILURE_WORDS[failure]}）。グループで確かめてから、送り直すか決めてね。`
      : `ポッポ…届けられなかったよ（${FAILURE_WORDS[failure]}）。`);
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

  /**
   * Without a judge's choice (ADR 0039, ADR 0062): a reply to a top-level message the channel has not moved on from goes
   * to the channel itself, and any other to the thread. Never a broadcast.
   */
  private defaultPlacement(target: ResolvedTarget): Placement {
    const message = target.message!;
    if (message.threadTs) return 'thread';
    return this.options.archive!.following(target.workspace, target.channelId, message.ts) <= this.options.config.placementFollowing
      ? 'channel' : 'thread';
  }

  private target(post: PostRow): ResolvedTarget {
    const signal = this.signalOf(post);
    if (signal) return signal.target(post.channel_id, post.target_ts);
    const channel = this.options.archive!.channel(post.workspace, post.channel_id);
    const label = `${post.workspace}/${channel?.label ?? post.reference.split(' ')[0]!.split('/')[1]}`;
    if (!post.target_ts) return { workspace: post.workspace, channelId: post.channel_id, label };
    const [, date, time, ...speaker] = post.reference.split(' ');
    const row = this.db.prepare('SELECT text FROM slack_messages WHERE workspace = ? AND channel_id = ? AND ts = ?')
      .get(post.workspace, post.channel_id, post.target_ts) as { text: string } | undefined;
    return { workspace: post.workspace, channelId: post.channel_id, label, message: { ts: post.target_ts,
      ...(post.target_thread_ts ? { threadTs: post.target_thread_ts } : {}), speaker: speaker.join(' '), at: `${date} ${time}`, text: row?.text ?? '' } };
  }

  /**
   * Records a result, which is then written to its request's results.jsonl and told to natsumi by an attention
   * (ADR 0074). The row is the record: what is not written and told yet is, from here or on the next start.
   */
  private tell(postId: string, result: Result, text: string, postedTs?: string): void {
    if (this.closed) return;
    this.db.prepare('INSERT INTO dove_results (post_id, result, text, posted_ts, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(postId, result, text, postedTs ?? null, this.iso());
    this.tellLater();
  }

  /** Writes and tells every result not told yet, after whatever is being told now. */
  private tellLater(): void {
    this.telling = this.telling.then(async () => {
      if (this.closed) return;
      try { await this.tellWaiting(); } catch (error) {
        this.log(`dove: a result could not be told (${describeFailure(error)}); it is told on the next start`);
      }
    });
  }

  private async tellWaiting(): Promise<void> {
    const place = this.options.place;
    if (!place) return;
    const posts = (this.db.prepare('SELECT DISTINCT post_id FROM dove_results WHERE told = 0 ORDER BY result_id').all() as { post_id: string }[])
      .map(row => row.post_id);
    let told = false;
    for (const postId of posts) {
      if (this.closed) return;
      const post = this.post(postId);
      if (!post) continue;
      const directory = await this.directoryOf(post, place.directory);
      const rows = this.db.prepare('SELECT * FROM dove_results WHERE post_id = ? ORDER BY result_id').all(postId) as unknown as ResultRow[];
      const lines = rows.map(row => this.resultLine(post, row));
      await writeDoveResults(directory.directory, lines);
      const request = this.requestOf(post);
      this.transaction(() => {
        rows.forEach((row, index) => {
          if (row.told) return;
          if (!place.record(resultAttention(directory.path, DOVE_NAME, index, lines[index]!, request))) {
            throw new Error('the attention was let go');
          }
          this.db.prepare('UPDATE dove_results SET told = 1 WHERE result_id = ?').run(row.result_id);
        });
      });
      told = true;
    }
    if (told) place.notify();
  }

  /**
   * A request's directory: the one made as it was taken, or for one taken before they were kept (ADR 0074), one made
   * now from the record, as near as it can be to what she asked.
   */
  private async directoryOf(post: PostRow, agents: string): Promise<{ path: string; directory: string }> {
    if (post.place) {
      const relative = post.place.slice(AGENTS_PATH.length + 1);
      return { path: post.place, directory: join(agents, relative) };
    }
    const target = this.target(post);
    const line = target.message ? this.options.archive?.lineOf(post.workspace, post.channel_id, target.message.ts) : undefined;
    const channel = this.options.archive?.channel(post.workspace, post.channel_id);
    const to: DoveTarget = line ?? { file: `/sources/slack/${post.workspace}/${channel?.directory ?? ''}` };
    const images = this.images(post.post_id).map(image => image.source);
    const at = Date.parse(post.created_at);
    const made = await writeDoveRequest(agents, DOVE_NAME, this.options.now(), {
      kind: post.kind, to, ...(post.expression ? { face: post.expression } : {}),
      ...(post.kind === 'reaction' ? { emoji: post.text } : post.text !== '' ? { text: post.text } : {}), ...(images.length > 0 ? { images } : {}),
      asked_at: this.local(at), target: targetOf(target), note: '版を上げる前の依頼なので、サーバーが記録から組み立てました。',
    });
    this.db.prepare('UPDATE dove_posts SET place = ? WHERE post_id = ?').run(made.path, post.post_id);
    post.place = made.path;
    return made;
  }

  /** One result as results.jsonl keeps it, with her own post's line when it was sent and is in the record. */
  private resultLine(post: PostRow, row: ResultRow): DoveResultLine {
    const signal = this.signalOf(post);
    const own = !row.posted_ts ? undefined : signal ? signal.lineOf(post.channel_id, row.posted_ts)
      : this.options.archive?.lineOf(post.workspace, post.channel_id, row.posted_ts);
    return { at: this.local(Date.parse(row.created_at)), state: row.result, text: row.text,
      ...(own ? { slack_file: own.file, slack_path: own.path } : {}) };
  }

  /** What a request asked and when, for its attentions. */
  private requestOf(post: PostRow): { line: string; askedAt: string } {
    return { line: requestLine({ kind: post.kind, text: post.text, emoji: post.text, images: this.images(post.post_id).map(image => image.source) }),
      askedAt: this.local(Date.parse(post.created_at)) };
  }

  /** Fork (ADR F07): the Signal groups, when the post goes to one. */
  private signalOf(post: PostRow): DoveSignalGroups | undefined {
    return post.workspace === SIGNAL_GROUPS ? this.options.signal : undefined;
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

  /**
   * Where it went, for the line that says it was sent, up to its verb: into the thread shown in the channel too for a
   * broadcast, or else where it was put, with its images.
   */
  private sentTo(post: PostRow, label: string, placement: Placement): string {
    if (post.target_ts && placement === 'broadcast' && this.images(post.post_id).length === 0) return `${label} のスレッドに返し、チャンネルにも出した`;
    return `${where(label, placement)}に${this.withImages(post.post_id)}届けた`;
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

  private local(at: number): string { return localDateTime(at, this.options.timeZone); }

  private log(line: string): void { this.options.log?.(line); }
}

/** Where a post was put: the channel itself, or the thread, which is where a broadcast of images stays. */
function where(label: string, placement: Placement): string {
  return placement === 'channel' ? label : `${label} のスレッド`;
}

/** What a request answers, as she would read it in the record. */
function targetOf(target: ResolvedTarget): DoveRequestRecord['target'] {
  const { message } = target;
  return { channel: target.label, ...(message ? { at: message.at, from: message.speaker, text: targetHead(message.text) } : {}) };
}

function cut(text: string, max: number): string {
  const characters = [...text];
  return characters.length > max ? `${characters.slice(0, max).join('')}…` : text;
}
