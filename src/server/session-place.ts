import { stat } from 'node:fs/promises';
import { relative } from 'node:path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { TurnPlace } from './turn-stats.ts';

/** Where a unit of work began in the session record: its file, the entry before it, and the file's size then. */
export interface PlaceMark { file: string; afterEntryId: string | null; offset: number }

/** Where the next entry of the session will be written. Undefined when it cannot be told; the turn then has no place. */
export async function markPlace(session: AgentSession): Promise<PlaceMark | undefined> {
  const file = session.sessionFile;
  if (!file) return undefined;
  try {
    return { file, afterEntryId: session.sessionManager.getLeafId(), offset: (await stat(file)).size };
  } catch { return undefined; }
}

/**
 * The entries the session wrote since the mark, as a place in its file named from `sessionDirectory`; undefined when
 * it wrote none.
 */
export async function placeSince(session: AgentSession, mark: PlaceMark | undefined, sessionDirectory: string): Promise<TurnPlace | undefined> {
  if (!mark || session.sessionFile !== mark.file) return undefined;
  const entries = session.sessionManager.getEntries();
  const index = mark.afterEntryId === null ? 0 : entries.findIndex(entry => entry.id === mark.afterEntryId) + 1;
  const first = entries[index];
  const last = entries.at(-1);
  if ((mark.afterEntryId !== null && index === 0) || !first || !last) return undefined;
  try {
    const endOffset = (await stat(mark.file)).size;
    if (endOffset <= mark.offset) return undefined;
    return { sessionFile: relative(sessionDirectory, mark.file), firstEntryId: first.id, lastEntryId: last.id,
      startOffset: mark.offset, endOffset };
  } catch { return undefined; }
}
