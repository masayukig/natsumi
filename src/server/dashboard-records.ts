import type { DatabaseSync } from 'node:sqlite';
import { PLACEMENT_ORDER, type Placement } from './judge.ts';
import { isoAt, nextOccurrence } from './nightly.ts';
import { SESSION_TTL_MS } from './sessions.ts';
import { turnKind, type TurnKind } from './turn-stats.ts';

/**
 * What the dashboard lists from the state database alone (ADR 0049): the failures and what waits, the dove's posts and
 * the devices. Everything here reads; nothing writes. No token, hash or key is read out: the columns that hold them are
 * never selected.
 */

/** The latest rows each list of failures and waits keeps to. */
export const WAIT_ROWS = 20;
export const DOVE_POSTS_PER_PAGE = 50;
/** The latest sessions listed; the counts cover them all. */
export const SESSION_ROWS = 50;

export interface FailedEvent {
  eventId: string; kind: string; reason: string | null; createdAt: string; updatedAt: string;
  /** The turn that handled it, when its row names its events (ADR 0049). */
  turnId: string | null;
}
export interface CutTurn { turnId: string; kind: TurnKind; startedAt: string; eventKinds: string; outcome: string }
export interface PendingApproval {
  approvalId: string; kind: string; createdAt: string; expiresAt: string;
  /** Past its end, and not settled yet. */
  expired: boolean;
  /** What the owner is shown, from the payload fixed when it was made; missing when the payload cannot be read. */
  channel?: string; placement?: string; text?: string; verdict?: string;
  /** The labels of the issues the judge flagged. */
  flagged: string[];
}
export interface BookedCheck { checkId: string; reason: string; dueAt: string; createdAt: string }
export interface AgentTask { agent: string; taskId: string; state: string; sentAt: string; createdAt: string; updatedAt: string }
export interface Rotation {
  rotationId: string; state: string; reason: string | null; fromSessionFile: string; toSessionFile: string | null; createdAt: string; updatedAt: string;
}

export interface Waits {
  failedEvents: FailedEvent[];
  cutTurns: CutTurn[];
  approvals: PendingApproval[];
  checks: BookedCheck[];
  /** When the nightly switch runs next; null when it is off. */
  nextRotationAt: string | null;
  agentTasks: AgentTask[];
  rotations: Rotation[];
}

export function readWaits(db: DatabaseSync, options: { now: number; nightlyRotationAt: string | false; timeZone: string }): Waits {
  const all = <T>(sql: string, ...values: (string | number)[]) => db.prepare(sql).all(...values) as T[];
  const failedEvents = all<Record<string, string | null>>(`SELECT e.event_id, e.kind, e.reason, e.created_at, e.updated_at,
      (SELECT t.turn_id FROM turn_stats t, json_each(t.event_ids) j WHERE t.event_ids IS NOT NULL AND j.value = e.event_id
        ORDER BY t.started_at DESC LIMIT 1) AS turn_id
    FROM loop_events e WHERE e.state = 'failed' ORDER BY e.updated_at DESC, e.rowid DESC LIMIT ?`, WAIT_ROWS)
    .map(row => ({ eventId: row.event_id!, kind: row.kind!, reason: row.reason ?? null, createdAt: row.created_at!, updatedAt: row.updated_at!,
      turnId: row.turn_id ?? null }));
  const cutTurns = all<Record<string, string>>(`SELECT turn_id, kind, started_at, event_kinds, outcome FROM turn_stats
    WHERE outcome <> 'ok' ORDER BY started_at DESC, rowid DESC LIMIT ?`, WAIT_ROWS)
    .map(row => ({ turnId: row.turn_id!, kind: turnKind(row.kind), startedAt: row.started_at!,
      eventKinds: row.event_kinds!, outcome: row.outcome! }));
  const now = isoAt(options.now);
  const approvals = all<Record<string, string>>(`SELECT approval_id, kind, payload, created_at, expires_at FROM approvals
    WHERE state = 'pending' ORDER BY expires_at, rowid`).map(row => ({
    approvalId: row.approval_id!, kind: row.kind!, createdAt: row.created_at!, expiresAt: row.expires_at!, expired: row.expires_at! <= now,
    ...shown(row.payload!),
  }));
  const checks = all<Record<string, string>>(`SELECT check_id, reason, due_at, created_at FROM self_checks WHERE state = 'pending'
    ORDER BY due_at, rowid`).map(row => ({ checkId: row.check_id!, reason: row.reason!, dueAt: row.due_at!, createdAt: row.created_at! }));
  const agentTasks = all<Record<string, string>>(`SELECT agent, task_id, state, sent_at, created_at, updated_at FROM agent_tasks
    ORDER BY state IN ('waiting', 'input-required') DESC, updated_at DESC, rowid DESC LIMIT ?`, WAIT_ROWS)
    .map(row => ({ agent: row.agent!, taskId: row.task_id!, state: row.state!, sentAt: row.sent_at!, createdAt: row.created_at!, updatedAt: row.updated_at! }));
  const rotations = all<Record<string, string | null>>(`SELECT rotation_id, state, reason, from_session_file, to_session_file, created_at, updated_at
    FROM session_rotations ORDER BY created_at DESC, rowid DESC LIMIT ?`, WAIT_ROWS)
    .map(row => ({ rotationId: row.rotation_id!, state: row.state!, reason: row.reason ?? null, fromSessionFile: row.from_session_file!,
      toSessionFile: row.to_session_file ?? null, createdAt: row.created_at!, updatedAt: row.updated_at! }));
  const nextRotationAt = options.nightlyRotationAt === false ? null
    : isoAt(nextOccurrence(options.now, options.nightlyRotationAt, options.timeZone));
  return { failedEvents, cutTurns, approvals, checks, nextRotationAt, agentTasks, rotations };
}

/** What an approval's payload shows the owner; nothing when it cannot be read. */
function shown(payload: string): Pick<PendingApproval, 'channel' | 'placement' | 'text' | 'verdict' | 'flagged'> {
  let value: { target?: { channel?: unknown; placement?: unknown }; text?: unknown; reason?: { verdict?: unknown; issues?: unknown } };
  try { value = JSON.parse(payload) as typeof value; } catch { return { flagged: [] }; }
  if (!value || typeof value !== 'object') return { flagged: [] };
  const text = (item: unknown) => typeof item === 'string' ? item : undefined;
  const issues = Array.isArray(value.reason?.issues) ? value.reason.issues as { label?: unknown; flagged?: unknown }[] : [];
  return {
    ...optional('channel', text(value.target?.channel)), ...optional('placement', text(value.target?.placement)),
    ...optional('text', text(value.text)), ...optional('verdict', text(value.reason?.verdict)),
    flagged: issues.flatMap(issue => issue?.flagged === true && typeof issue.label === 'string' ? [issue.label] : []),
  };
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : { [key]: value } as Record<K, string>;
}

export interface DoveScore { label: string; score: number; flagged: boolean }
/** What one judge made of a draft (ADR 0059): its verdict by its own thresholds, its scores and placement, or why it had none. */
export type DoveJudgement =
  | { verdict: string; scores: DoveScore[]; placement: string | null; probabilities?: Partial<Record<Placement, number>> }
  | { error: string };
export interface DoveJudges {
  adopted: 'logprobs' | 'jev';
  /** The judge that decided; null when neither had an answer. */
  decidedBy: 'logprobs' | 'jev' | null;
  /** Null for a judge that was off. */
  logprobs: DoveJudgement | null;
  jev: DoveJudgement | null;
}
export interface DovePostRow {
  postId: string; kind: 'post' | 'reaction';
  /** The channel's label from the channel files, or its ID when it is not there. */
  channel: string;
  reference: string; text: string; expression: string | null; verdict: string | null; scores: DoveScore[];
  placement: string | null; state: string; sentText: string | null; sentPlacement: string | null; failure: string | null;
  createdAt: string; updatedAt: string;
  /** Both judges side by side; null for a post from before them, or one no judge was asked about (ADR 0059). */
  judges: DoveJudges | null;
  /** What the owner made of it when it was handed to her: the approval's state. */
  ownerDecision: string | null;
}

export function listDovePosts(db: DatabaseSync, page: number): { rows: DovePostRow[]; more: boolean } {
  const rows = db.prepare(`SELECT p.*, c.label, a.state AS approval_state FROM dove_posts p
    LEFT JOIN slack_channels c ON c.workspace = p.workspace AND c.channel_id = p.channel_id
    LEFT JOIN approvals a ON a.post_id = p.post_id
    ORDER BY p.created_at DESC, p.rowid DESC LIMIT ? OFFSET ?`).all(DOVE_POSTS_PER_PAGE + 1, (page - 1) * DOVE_POSTS_PER_PAGE) as Record<string, string | null>[];
  return {
    rows: rows.slice(0, DOVE_POSTS_PER_PAGE).map(row => ({
      postId: row.post_id!, kind: row.kind === 'reaction' ? 'reaction' : 'post', channel: row.label ?? row.channel_id!, reference: row.reference!,
      text: row.text!, expression: row.expression ?? null, verdict: row.verdict ?? null, scores: scores(row.scores ?? null),
      placement: row.placement ?? null, state: row.state!, sentText: row.sent_text ?? null, sentPlacement: row.sent_placement ?? null,
      failure: row.failure ?? null, createdAt: row.created_at!, updatedAt: row.updated_at!,
      judges: judgesOf(row), ownerDecision: row.approval_state ?? null,
    })),
    more: rows.length > DOVE_POSTS_PER_PAGE,
  };
}

const judgeName = (value: string | null | undefined) => value === 'logprobs' || value === 'jev' ? value : null;

/** Both judges as a post keeps them (migration 23); null for a post from before, whose columns are all empty. */
function judgesOf(row: Record<string, string | null>): DoveJudges | null {
  const adopted = judgeName(row.judge_adopted);
  if (!adopted) return null;
  return { adopted, decidedBy: judgeName(row.judge_decided_by), logprobs: judgement(row.judgement_logprobs ?? null), jev: judgement(row.judgement_jev ?? null) };
}

function judgement(value: string | null): DoveJudgement | null {
  if (!value) return null;
  let kept: { verdict?: unknown; issues?: unknown; placement?: { choice?: unknown; probabilities?: Record<string, unknown> }; error?: unknown };
  try { kept = JSON.parse(value) as typeof kept; } catch { return { error: 'unreadable' }; }
  if (typeof kept?.error === 'string') return { error: kept.error };
  if (typeof kept?.verdict !== 'string') return { error: 'unreadable' };
  // The odds of each place asked about (ADR 0062): the three, or two from before, and nothing that is no place.
  const given = kept.placement?.probabilities ?? {};
  const probabilities = Object.fromEntries(PLACEMENT_ORDER.flatMap(name => typeof given[name] === 'number' ? [[name, given[name]]] : []));
  return { verdict: kept.verdict, scores: scoresOf(kept.issues), placement: typeof kept.placement?.choice === 'string' ? kept.placement.choice : null,
    ...(Object.keys(probabilities).length > 0 ? { probabilities } : {}) };
}

/** The judge's score per issue (ADR 0039); none when there were none or they cannot be read. */
function scores(value: string | null): DoveScore[] {
  if (!value) return [];
  let issues: unknown;
  try { issues = JSON.parse(value); } catch { return []; }
  return scoresOf(issues);
}

function scoresOf(issues: unknown): DoveScore[] {
  if (!Array.isArray(issues)) return [];
  return issues.flatMap(issue => {
    const item = issue as { name?: unknown; label?: unknown; score?: unknown; flagged?: unknown };
    const label = typeof item?.label === 'string' ? item.label : typeof item?.name === 'string' ? item.name : undefined;
    return label !== undefined && typeof item.score === 'number' ? [{ label, score: item.score, flagged: item.flagged === true }] : [];
  });
}

export type SessionState = 'live' | 'revoked' | 'expired';
export interface DeviceRow {
  deviceId: string; createdAt: string; lastSeenAt: string; connected: boolean;
  /** Where it is pushed when away (ADR 0029): which APNs and when, not the token nor the key. */
  push: { environment: string; createdAt: string; updatedAt: string } | null;
  sessionId: string;
  /** The session it last synced with; missing when that session is gone from the table. */
  sessionState: SessionState | 'gone';
}
export interface SessionRow {
  sessionId: string; createdAt: string; expiresAt: string;
  /** Read back from the end, which slides SESSION_TTL_MS past each use (ADR 0030). */
  lastUsedAt: string;
  revokedAt: string | null; state: SessionState;
  /** The devices that last synced with it. None for the dashboard's sessions and an app's before its first sync. */
  devices: number;
}
export interface DevicesView {
  devices: DeviceRow[];
  sessions: { counts: { live: number; ended: number }; rows: SessionRow[] };
}

export function readDevices(db: DatabaseSync, options: { now: number; isConnected: (deviceId: string) => boolean }): DevicesView {
  const now = isoAt(options.now);
  const state = (expiresAt: string, revokedAt: string | null): SessionState => revokedAt !== null ? 'revoked' : expiresAt <= now ? 'expired' : 'live';
  const devices = (db.prepare(`SELECT d.device_id, d.created_at, d.last_seen_at, d.client_session_id,
      p.environment, p.created_at AS push_created_at, p.updated_at AS push_updated_at, s.expires_at, s.revoked_at, s.session_id
    FROM devices d LEFT JOIN push_registrations p ON p.device_id = d.device_id LEFT JOIN client_sessions s ON s.session_id = d.client_session_id
    ORDER BY d.last_seen_at DESC, d.rowid DESC`).all() as Record<string, string | null>[]).map(row => ({
    deviceId: row.device_id!, createdAt: row.created_at!, lastSeenAt: row.last_seen_at!, connected: options.isConnected(row.device_id!),
    push: row.environment ? { environment: row.environment, createdAt: row.push_created_at!, updatedAt: row.push_updated_at! } : null,
    sessionId: row.client_session_id!, sessionState: row.session_id ? state(row.expires_at!, row.revoked_at ?? null) : 'gone' as const,
  }));
  const counts = db.prepare(`SELECT
      COUNT(*) FILTER (WHERE revoked_at IS NULL AND expires_at > ?) AS live,
      COUNT(*) FILTER (WHERE revoked_at IS NOT NULL OR expires_at <= ?) AS ended FROM client_sessions`).get(now, now) as { live: number; ended: number };
  const rows = (db.prepare(`SELECT s.session_id, s.created_at, s.expires_at, s.revoked_at,
      (SELECT COUNT(*) FROM devices d WHERE d.client_session_id = s.session_id) AS devices
    FROM client_sessions s ORDER BY s.expires_at DESC, s.rowid DESC LIMIT ?`).all(SESSION_ROWS) as Record<string, string | number | null>[])
    .map(row => ({
      sessionId: row.session_id as string, createdAt: row.created_at as string, expiresAt: row.expires_at as string,
      lastUsedAt: isoAt(Date.parse(row.expires_at as string) - SESSION_TTL_MS), revokedAt: row.revoked_at as string | null,
      state: state(row.expires_at as string, row.revoked_at as string | null), devices: row.devices as number,
    }));
  return { devices, sessions: { counts: { live: counts.live, ended: counts.ended }, rows } };
}

/** The outcomes an approval can be in, as the `approvals` table keeps them (ADR 0040). */
export const APPROVAL_STATES = ['pending', 'approved', 'edited', 'rejected', 'expired'] as const;
export type ApprovalState = typeof APPROVAL_STATES[number];
export const APPROVALS_PER_PAGE = 20;

export interface ApprovalRow {
  approvalId: string; kind: string; state: string; createdAt: string; expiresAt: string;
  /** Pending past its end, and not settled yet. */
  expired: boolean;
  /** What she chose, the text and placement she gave when she edited, and the device she chose on. */
  decision: string | null; decidedText: string | null; decidedPlacement: string | null; deviceId: string | null;
  /** When it closed: rejected or run out, or when the send it led to came to something. None while it waits or sends. */
  resolvedAt: string | null;
  delivery: string | null; deliveryReason: string | null; sentText: string | null;
  /** What the owner was shown, from the payload fixed when it was made; empty when the payload cannot be read. */
  shown: Pick<PendingApproval, 'channel' | 'placement' | 'text' | 'verdict' | 'flagged'> & {
    scores: DoveScore[]; replyTo?: { speaker?: string; text?: string }; expression?: string;
  };
  /** The dove's post it was for, and the page of the dove's list that shows it. */
  post: { postId: string; state: string; failure: string | null; sentPlacement: string | null; page: number } | null;
}

/** The approvals, all or those of one outcome, newest first, a page at a time. */
export function listApprovals(db: DatabaseSync, options: { page: number; now: number; state?: ApprovalState }): { rows: ApprovalRow[]; more: boolean } {
  const filter = options.state === undefined ? '' : 'WHERE a.state = ?';
  const values = options.state === undefined ? [] : [options.state];
  // The post's place in the dove's list, ordered as `listDovePosts` orders it.
  const rows = db.prepare(`SELECT a.approval_id, a.kind, a.state, a.created_at, a.expires_at, a.decision, a.decided_text, a.decided_placement,
      a.device_id, a.resolved_at, a.delivery, a.delivery_reason, a.sent_text, a.payload,
      p.post_id, p.state AS post_state, p.failure, p.sent_placement,
      (SELECT COUNT(*) FROM dove_posts q WHERE q.created_at > p.created_at OR (q.created_at = p.created_at AND q.rowid > p.rowid)) AS newer_posts
    FROM approvals a LEFT JOIN dove_posts p ON p.post_id = a.post_id ${filter}
    ORDER BY a.created_at DESC, a.rowid DESC LIMIT ? OFFSET ?`)
    .all(...values, APPROVALS_PER_PAGE + 1, (options.page - 1) * APPROVALS_PER_PAGE) as Record<string, string | number | null>[];
  const now = isoAt(options.now);
  const text = (value: string | number | null | undefined) => typeof value === 'string' ? value : null;
  return {
    rows: rows.slice(0, APPROVALS_PER_PAGE).map(row => ({
      approvalId: row.approval_id as string, kind: row.kind as string, state: row.state as string, createdAt: row.created_at as string,
      expiresAt: row.expires_at as string, expired: row.state === 'pending' && (row.expires_at as string) <= now,
      decision: text(row.decision), decidedText: text(row.decided_text), decidedPlacement: text(row.decided_placement), deviceId: text(row.device_id),
      resolvedAt: text(row.resolved_at), delivery: text(row.delivery), deliveryReason: text(row.delivery_reason), sentText: text(row.sent_text),
      shown: shownInFull(row.payload as string),
      post: row.post_id === null ? null : { postId: row.post_id as string, state: row.post_state as string, failure: text(row.failure),
        sentPlacement: text(row.sent_placement), page: Math.floor((row.newer_posts as number) / DOVE_POSTS_PER_PAGE) + 1 },
    })),
    more: rows.length > APPROVALS_PER_PAGE,
  };
}

/** All an approval's payload shows the owner: what `shown` reads, with the judge's scores and what the post answers. */
function shownInFull(payload: string): ApprovalRow['shown'] {
  let value: { target?: { replyTo?: { speaker?: unknown; text?: unknown } }; expression?: unknown; reason?: { issues?: unknown } };
  try { value = JSON.parse(payload) as typeof value; } catch { return { flagged: [], scores: [] }; }
  if (!value || typeof value !== 'object') return { flagged: [], scores: [] };
  const text = (item: unknown) => typeof item === 'string' ? item : undefined;
  const replyTo = value.target?.replyTo;
  return {
    ...shown(payload), scores: scoresOf(value.reason?.issues),
    ...(replyTo && typeof replyTo === 'object' ? { replyTo: { ...optional('speaker', text(replyTo.speaker)), ...optional('text', text(replyTo.text)) } } : {}),
    ...optional('expression', text(value.expression)),
  };
}
