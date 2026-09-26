import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_DIRECTORY } from './data-directory.ts';
import { writeFileAtomically } from './paths.ts';
import { checkHealth, readStatus } from './status.ts';

/**
 * Whether ended turns are folded (ADR 0047), switched by hand the way the model routes are (ADR 0046): two files in the
 * data directory, so the command line reaches a running server without a listener of its own and a choice outlives
 * a restart. Nothing here loads Pi.
 *
 * - `turn-fold.json` is the choice. The command line writes it; the server reads it before every turn.
 * - `turn-fold-status.json` is what the server says: the fold in use, the config's default, and the choice.
 */

export type Fold = 'on' | 'off';

export interface FoldStatus {
  /** What the turns are folded with now. */
  inUse: Fold;
  /** `loop.turnFold` in the config: what applies while nothing was chosen. */
  defaultFold: Fold;
  /** The command line's choice, or null when none was made. */
  chosen: Fold | null;
}

const choicePath = (dataDirectory: string) => join(dataDirectory, STATE_DIRECTORY, 'turn-fold.json');
const statusPath = (dataDirectory: string) => join(dataDirectory, STATE_DIRECTORY, 'turn-fold-status.json');
const isFold = (value: unknown): value is Fold => value === 'on' || value === 'off';

/** The choice, or undefined when none was made or the file cannot be read. */
export async function readFoldChoice(dataDirectory: string): Promise<Fold | undefined> {
  try {
    const { fold } = JSON.parse(await readFile(choicePath(dataDirectory), 'utf8')) as { fold?: unknown };
    return isFold(fold) ? fold : undefined;
  } catch { return undefined; }
}

export async function writeFoldChoice(dataDirectory: string, fold: Fold, now: number): Promise<void> {
  await writeFileAtomically(choicePath(dataDirectory), `${JSON.stringify({ fold, chosenAt: new Date(now).toISOString() })}\n`, 0o600);
}

export async function readFoldStatus(dataDirectory: string): Promise<FoldStatus | undefined> {
  try {
    const { inUse, defaultFold, chosen } = JSON.parse(await readFile(statusPath(dataDirectory), 'utf8')) as Record<string, unknown>;
    if (!isFold(inUse) || !isFold(defaultFold) || !(chosen === null || isFold(chosen))) return undefined;
    return { inUse, defaultFold, chosen };
  } catch { return undefined; }
}

export async function writeFoldStatus(dataDirectory: string, status: FoldStatus, now: number): Promise<void> {
  await writeFileAtomically(statusPath(dataDirectory), `${JSON.stringify({ ...status, updatedAt: new Date(now).toISOString() })}\n`, 0o600);
}

export type FoldCommand = { command: 'fold'; dataDir: string | undefined; action: 'on' | 'off' | 'status' };

/** `natsumi fold on|off|status`: lines go to `write`, and the exit code is returned. */
export async function runFoldCommand(cli: FoldCommand, dataDirectory: string, write: (line: string) => void,
  now: () => number = Date.now): Promise<number> {
  const running = checkHealth(await readStatus(dataDirectory), now()).healthy;
  const when = running ? 'from her next turn' : 'from her next start';
  if (cli.action !== 'status') {
    await writeFoldChoice(dataDirectory, cli.action, now());
    write(`folding ${cli.action}: ${when}`);
    return 0;
  }
  const status = await readFoldStatus(dataDirectory);
  const chosen = await readFoldChoice(dataDirectory);
  if (!status) {
    write(`in use: unknown (start the server once with this data directory)`);
    write(`chosen: ${chosen ?? 'none (the config decides)'}`);
    return 1;
  }
  write(`in use: ${status.inUse}`);
  write(`chosen: ${chosen ?? 'none'}${chosen && chosen !== status.inUse ? ` (${when})` : ''}`);
  write(`default: ${status.defaultFold}`);
  return 0;
}
