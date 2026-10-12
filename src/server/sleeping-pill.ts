import { isoAt, previousOccurrence } from './nightly.ts';

/**
 * The sleeping pill (ADR 0077): what it would do now, decided from the records alone. The thinking loop gathers the
 * facts and runs what this decides; the dashboard and the client contract only show it. Nothing here keeps state, reads
 * a table or looks at the clock.
 */

/** What a pill does: the night in full, its new session, its curator alone, a nap, or nothing left for an empty session. */
export type PillKind = 'deep' | 'resume' | 'resleep' | 'nap' | 'none';

/** The kinds of row in `session_rotations`: the scheduled night (and the server's own `rotateSession`), or a pill's. */
export type RotationKind = 'night' | Exclude<PillKind, 'none'>;

/** Rows of these kinds began with a review: without a switching time, the newest of them is the night (ADR 0077). */
export const REVIEWED_KINDS: readonly RotationKind[] = ['night', 'deep'];

/** One row of `session_rotations` as the judgement reads it. Times in milliseconds. */
export interface RotationRecord {
  kind: RotationKind;
  state: string;
  reason: string | null;
  /** Whether it names the commit of a handoff: its review wrote one, or it resumed from one. */
  handoffCommit: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A stage of the curator that did not end ok, as its turn was recorded. */
export interface CuratorFailure { stage: string; outcome: string; at: number }

/** A night's switch or a pill, waiting or under way. A pill still waiting has not been decided yet. */
export interface PillInProgress {
  kind: 'night' | 'sleeping-pill' | Exclude<PillKind, 'none'>;
  state: 'queued' | 'running';
  since: string;
}

export interface PillFacts {
  now: number;
  nightlyRotationAt: string | false;
  timeZone: string;
  /** Whether the session in use holds no message yet. */
  sessionEmpty: boolean;
  /** When the session in use began: its switch, or the conversation's creation. */
  sessionStartedAt: number | undefined;
  /** The rows since the night, or more; those older than the night are not looked at. */
  rotations: RotationRecord[];
  /** When the newest row that began with a review was made; the night when there is no switching time. */
  latestReviewAt: number | undefined;
  /** Whether the curator runs at all: enabled, with a workspace to work in. Without it, its part counts as done. */
  curatorRuns: boolean;
  /** When the commit the curator last succeeded at was made. */
  curatorBaseAt: number | undefined;
  /** The curator's stages that did not end ok, since the night or more. */
  curatorFailures: CuratorFailure[];
  inProgress: PillInProgress | null;
}

export type LastFailure =
  | { source: 'rotation'; kind: RotationKind; state: string; reason: string | null; at: string }
  | { source: 'curator'; stage: string; outcome: string; at: string };

/** What a pill would do now, and what that was decided from. Times are ISO strings. */
export interface PillJudgement {
  kind: PillKind;
  /** The night the parts are counted from; null with no switching time and no review on record. */
  night: string | null;
  /** The night's three parts: the review (its handoff), the curator, and the new session. */
  done: { review: boolean; curator: boolean; session: boolean };
  /** The newest failure since the night: a row's, or a curator stage's. */
  lastFailure: LastFailure | null;
  inProgress: PillInProgress | null;
}

/** The night a pill makes up for: the last switching time, or without one the newest row that began with a review. */
export function nightOf(now: number, nightlyRotationAt: string | false, timeZone: string, latestReviewAt: number | undefined): number | undefined {
  return nightlyRotationAt === false ? latestReviewAt : previousOccurrence(now, nightlyRotationAt, timeZone);
}

/**
 * The night's parts that are missing decide the pill (ADR 0077): no handoff is the night in full, no new session is
 * that session (with the curator first if it is missing too), no curator is the curator alone, and nothing missing is a
 * nap. An empty session has no turn of hers to review or nap in: there, the curator alone if it is missing, or nothing.
 */
export function judgePill(facts: PillFacts): PillJudgement {
  const night = nightOf(facts.now, facts.nightlyRotationAt, facts.timeZone, facts.latestReviewAt);
  const since = night === undefined ? [] : facts.rotations.filter(row => row.createdAt >= night);
  const review = since.some(row => row.handoffCommit);
  const session = night !== undefined && facts.sessionStartedAt !== undefined && facts.sessionStartedAt >= night;
  // git keeps a commit's time to the second, so a base made in the night's own second counts.
  const curator = !facts.curatorRuns
    || (night !== undefined && facts.curatorBaseAt !== undefined && facts.curatorBaseAt >= Math.floor(night / 1000) * 1000);
  const kind: PillKind = !review ? 'deep' : !session ? 'resume' : !curator ? 'resleep' : 'nap';
  // An empty session gives her no turn to review or nap in; what the night left for the curator is still there.
  const empty: PillKind = kind !== 'deep' && kind !== 'nap' ? kind : curator ? 'none' : 'resleep';
  return { kind: facts.sessionEmpty ? empty : kind, night: night === undefined ? null : isoAt(night), done: { review, curator, session },
    lastFailure: night === undefined ? null : lastFailure(since, facts.curatorFailures.filter(failure => failure.at >= night)),
    inProgress: facts.inProgress };
}

function lastFailure(rotations: RotationRecord[], stages: CuratorFailure[]): LastFailure | null {
  const failures: (LastFailure & { ms: number })[] = [
    ...rotations.filter(row => row.state === 'failed').map(row => ({ source: 'rotation' as const, kind: row.kind, state: row.state,
      reason: row.reason, at: isoAt(row.updatedAt), ms: row.updatedAt })),
    ...stages.map(stage => ({ source: 'curator' as const, stage: stage.stage, outcome: stage.outcome, at: isoAt(stage.at), ms: stage.at })),
  ];
  const newest = failures.reduce<(LastFailure & { ms: number }) | undefined>((best, failure) => !best || failure.ms > best.ms ? failure : best,
    undefined);
  if (!newest) return null;
  const { ms: _ms, ...failure } = newest;
  return failure;
}
