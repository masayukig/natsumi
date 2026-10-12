import { mkdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AGENT_LIST_DIRECTORY } from './agent-list.ts';
import { AVATAR_MANUAL_DIRECTORY } from './avatar-manual.ts';
import { findCodeCheckout, HOME_DIRECTORY, SOURCES_DIRECTORY, SOURCES_GIT_DIRECTORY, WORK_DIRECTORY } from './paths.ts';
import { makeSharedDirectory } from './permissions.ts';
import { SKILLS_DIRECTORY } from './skills.ts';

export class DataDirectoryError extends Error {
  constructor(message: string) { super(`data directory: ${message}`); this.name = 'DataDirectoryError'; }
}

export const STATE_DIRECTORY = '.natsumi';

/** `--data-dir` wins; otherwise the launch cwd. Resolved once to a real absolute path. */
export async function resolveDataDirectory(flag: string | undefined, cwd: string): Promise<string> {
  let dir: string;
  try { dir = await realpath(resolve(cwd, flag ?? '.')); } catch {
    throw new DataDirectoryError('does not exist; create it first');
  }
  if (!(await stat(dir)).isDirectory()) throw new DataDirectoryError('not a directory');
  if (await findCodeCheckout(dir)) {
    throw new DataDirectoryError('is inside the natsumi code checkout; keep personal data outside the code');
  }
  return dir;
}

/**
 * Creates the initial layout. Existing files and directories are never overwritten or re-permissioned.
 * `memory/` is only made here; what goes in it belongs to the memory repository (ADR 0018), personality.md included.
 * `work/` and `home/` are the workspace container's `/work` and `/home/natsumi` (ADR 0019): the server makes them
 * and then looks inside only to copy an image she asks the dove to post from /work (ADR 0044). `agents/` holds the list of agents the
 * server writes on every start, which the workspace sees read-only as `/manual/agents` (ADR 0036), and `avatar/` the page on
 * drawing and the sdctl params it writes from the avatar, seen read-only as `/manual/avatar` (ADR 0057). `sources/` holds
 * what she reads besides memory, such as the Slack channels, which the workspace sees read-only as `/sources` (ADR 0039),
 * and `sources.git/` its history, seen read-only as `/sources.git` (ADR 0050). `skills/` is where the owner keeps a clone
 * of their skills, which the workspace sees read-only as `/skills` and the owner writes over ssh (ADR 0073): it is made
 * whether or not skills are on, so that the workspace has it to mount.
 */
export async function initializeDataDirectory(dir: string): Promise<void> {
  for (const name of ['memory', WORK_DIRECTORY, HOME_DIRECTORY, AGENT_LIST_DIRECTORY, AVATAR_MANUAL_DIRECTORY, SOURCES_DIRECTORY,
    SOURCES_GIT_DIRECTORY, SKILLS_DIRECTORY, STATE_DIRECTORY]) {
    const path = join(dir, name);
    // Those the workspace mounts are shared with its group; the server's own state stays with its owner (ADR 0033).
    const made = name === STATE_DIRECTORY ? await makePrivateDirectory(path) : await makeSharedDirectory(path);
    if (!made && !(await stat(path)).isDirectory()) throw new DataDirectoryError(`${name} exists but is not a directory`);
  }
}

async function makePrivateDirectory(path: string): Promise<boolean> {
  try { await mkdir(path, { mode: 0o700 }); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}
