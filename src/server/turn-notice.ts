import type { DatabaseSync } from 'node:sqlite';
import type { EventKind } from './conversation-store.ts';

/**
 * Fork (ADR F05): when a turn that someone is waiting on is cut short, the server tells the owner in fixed words of
 * its own. She cannot say it herself, since the turn that would have said it is the one that ended. The notice names
 * the limit and what she was handling, never what anyone said.
 */

/** The least time between two such notices: a model that is down fails every turn, and one line says enough. */
export const CUT_SHORT_NOTICE_INTERVAL_MS = 30 * 60_000;

/** The events someone waits on an answer to. Pings, self-checks and sources are her own; a cut there is only logged. */
const WAITED_ON: Partial<Record<EventKind, string>> = {
  'mac-message': 'マスターのメッセージ',
  'slack-mention': 'Slack のメンション',
  'agent-reply': 'エージェントからの返事',
  'dove-reply': 'エージェントからの返事',
};

export interface CutTurn {
  failure: string;
  /** The kinds of the events the turn handled, steered ones included. */
  kinds: (EventKind | undefined)[];
  maxCalls: number;
  timeoutMinutes: number;
}

/** One notice per turn, and none within `CUT_SHORT_NOTICE_INTERVAL_MS` of the last. Held in memory: a restart may send one more. */
export class CutShortNotices {
  private lastAt = -Infinity;

  /** The line to send for a turn that ended with `failure`, or undefined when nothing is sent. */
  take(turn: CutTurn, now: number): string | undefined {
    const text = cutShortText(turn);
    if (!text || now - this.lastAt < CUT_SHORT_NOTICE_INTERVAL_MS) return undefined;
    this.lastAt = now;
    return text;
  }
}

export function cutShortText({ failure, kinds, maxCalls, timeoutMinutes }: CutTurn): string | undefined {
  const what = [...new Set(kinds.flatMap(kind => kind && WAITED_ON[kind] ? [WAITED_ON[kind]] : []))];
  if (what.length === 0) return undefined;
  // A turn stopped because the server is stopping is not cut short; it says nothing.
  const how = failure === 'model-call-limit' ? `途中で打ち切られました（考える回数の上限 ${maxCalls} 回）`
    : failure === 'timeout' ? `途中で打ち切られました（時間の上限 ${timeoutMinutes} 分）`
    : failure === 'model-error' ? '途中で止まりました（モデルの呼び出しが失敗しました）' : undefined;
  if (!how) return undefined;
  return `${what.join('と')}への対応が${how}。返事が届いていなければ、もう一度話しかけてください。`;
}

/**
 * The kinds as `cutShortText` reads them: a Slack mention or DM reaches her as a sources update that carries an
 * attention (ADR 0039, ADR 0050), so a sources update with one is someone waiting, named as a mention.
 */
export function waitedOnKinds(db: DatabaseSync, eventIds: string[], kinds: (EventKind | undefined)[]): (EventKind | undefined)[] {
  const attended = db.prepare('SELECT 1 FROM source_attention WHERE event_id = ? LIMIT 1');
  return kinds.map((kind, index) => kind === 'sources-updated' && attended.get(eventIds[index]!) ? 'slack-mention' : kind);
}
