import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sectionBody } from './thinking-loop.ts';

/**
 * natsumi's manual as the server has it: the `manual/` that came with the code, the same that the workspace image
 * holds at /manual (ADR 0036). The dashboard shows it (ADR 0054), and its index goes into the prompt (ADR 0056).
 */

/** `manual/` beside `src/` in a checkout, and beside `dist/` in the image, as the workspace has it at /manual (ADR 0054). */
const MANUAL_DIRECTORIES = ['../../manual/', '../../../manual/'].map(path => fileURLToPath(new URL(path, import.meta.url)));

/** The code's own manual: the first of its places that is there. */
export async function codeManualDirectory(): Promise<string> {
  for (const directory of MANUAL_DIRECTORIES) {
    if (await stat(directory).then(found => found.isDirectory(), () => false)) return directory;
  }
  return MANUAL_DIRECTORIES[0]!;
}

/**
 * The manual's `INDEX.md` without its opening heading, as the prompt holds it (ADR 0056); undefined when it cannot be
 * read or says nothing. Only the index: the list of agents under `agents/` is rewritten on every start and stays out.
 */
export async function readManualIndex(directory: string): Promise<string | undefined> {
  try {
    return sectionBody(await readFile(join(directory, 'INDEX.md'), 'utf8')) || undefined;
  } catch {
    return undefined;
  }
}
