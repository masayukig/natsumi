import { runGit } from './git.ts';

/**
 * Goals (ADR 0090): memory's `goals/`, a directory whose name the server fixes as it fixes `postbox/`'s. Each Markdown
 * file directly in it but `today.md` is one lasting goal, named by its file, in four sections; `today.md` is the day's
 * plan, headed by its date. natsumi writes them; the server checks their length at the end of a turn, shows the
 * committed plan on a few pings, keeps the curator off them, and lists for the owner, from git, what changed in the
 * parts that need the owner's consent. Nothing of it is in SQLite.
 */

export const GOALS_DIRECTORY = 'goals';
/** The day's plan. natsumi rewrites it freely; its first line is the date it is for. */
export const TODAY_FILE = `${GOALS_DIRECTORY}/today.md`;

/** The sections of a lasting goal's file, by the `##` headings the manual fixes and the dashboard reads them by. */
export const GOAL_HEADINGS = { why: 'なぜ', routine: '日課', state: '今の様子', short: '短い目標' } as const;
/** What natsumi writes only once the owner has agreed: the goal's words and its routine (with the file made or removed). */
export const CONSENT_HEADINGS: readonly string[] = [GOAL_HEADINGS.why, GOAL_HEADINGS.routine];

/** The longest a lasting goal's file may be, in characters: well below one memory file's (`loop.memoryFileMaxChars`). */
export const DEFAULT_GOAL_FILE_MAX_CHARS = 6000;
/** The longest today's plan may be. It rides on a ping now and then, so it is held smaller still. */
export const DEFAULT_TODAY_PLAN_MAX_CHARS = 3000;

/** The changes the dashboard lists at most, newest first. */
export const GOAL_CHANGES_SHOWN = 30;
/** The commits touching goals/ looked through for them: the latest this many, so that a page is one git command. */
export const GOAL_CHANGES_SCANNED = 100;

export interface GoalLimits { goalFileMaxChars: number; todayPlanMaxChars: number }

/** Whether a path is in goals/, or is goals/ itself. */
export function inGoals(path: string): boolean {
  return path === GOALS_DIRECTORY || path.startsWith(`${GOALS_DIRECTORY}/`);
}

/** Whether a path is a lasting goal's file: Markdown directly in goals/, and not today.md. */
export function isGoalFile(path: string): boolean {
  if (!path.startsWith(`${GOALS_DIRECTORY}/`) || path === TODAY_FILE || !path.endsWith('.md')) return false;
  return !path.slice(GOALS_DIRECTORY.length + 1).includes('/');
}

/**
 * Why a file in goals/ of this length may not be committed, or undefined when it may: no directory under goals/, and
 * each kind of file within its own limit. What every memory file is checked for is checked elsewhere.
 */
export function goalsProblem(path: string, chars: number, limits: GoalLimits): string | undefined {
  if (!inGoals(path)) return undefined;
  if (path.slice(GOALS_DIRECTORY.length + 1).includes('/')) {
    return `${GOALS_DIRECTORY}/ の下にはディレクトリを作れません。長く続く目標のファイルは ${GOALS_DIRECTORY}/ の直下に置きます`;
  }
  if (path === TODAY_FILE && chars > limits.todayPlanMaxChars) {
    return `今日の計画の上限（${limits.todayPlanMaxChars} 文字）を超えています。済んだものを消すか、短くまとめてから書き直してください`;
  }
  if (path !== TODAY_FILE && chars > limits.goalFileMaxChars) {
    return `長く続く目標のファイルの上限（${limits.goalFileMaxChars} 文字）を超えています。古い「${GOAL_HEADINGS.state}」を要約してから書き直してください`;
  }
  return undefined;
}

/**
 * The lines under a `## heading` up to the next heading of level one or two, trimmed of blank lines at either end, or
 * undefined when the text has no such heading. Deeper headings belong to the section.
 */
export function sectionOf(text: string, heading: string): string | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex(line => line.trimEnd() === `## ${heading}`);
  if (start < 0) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2} /.test(line)) break;
    body.push(line);
  }
  return body.join('\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();
}

/** One line of a section's change: kept, removed or added. */
export interface GoalDiffLine { sign: ' ' | '-' | '+'; text: string }
export interface GoalSectionChange { heading: string; lines: GoalDiffLine[] }

/** A change to the parts of a lasting goal that need consent, as one commit made it. */
export interface GoalChange {
  commit: string;
  /** When it was written: the author's time, as git keeps it. */
  at: string;
  /** Who wrote it: natsumi's own name, or the owner's on a commit over ssh. */
  author: string;
  path: string;
  kind: 'created' | 'deleted' | 'changed';
  /** The consent sections that moved; for a file made or removed, all it had. */
  sections: GoalSectionChange[];
}

/**
 * The changes to the parts of the lasting goals that need consent, newest first (ADR 0090): a goal's file made or
 * removed, and its なぜ or 日課 changed. Read from memory's git history alone, in one command over the latest commits
 * that touched goals/; a rename is a removal and a making. today.md and a file under a directory of goals/ are not goals.
 */
export async function readGoalChanges(directory: string, options: { limit?: number; scan?: number } = {}): Promise<GoalChange[]> {
  const limit = options.limit ?? GOAL_CHANGES_SHOWN;
  const { code, stdout } = await runGit(directory, ['log', `-n${options.scan ?? GOAL_CHANGES_SCANNED}`, '--no-renames', '--no-color',
    '--format=%x00%H%x1f%aI%x1f%an', '-p', '--unified=1000000', '--no-ext-diff', '--', `${GOALS_DIRECTORY}/*.md`, `:(exclude)${TODAY_FILE}`],
  { allowFailure: true });
  if (code !== 0) return [];
  const changes: GoalChange[] = [];
  for (const chunk of stdout.split('\0').slice(1)) {
    const newline = chunk.indexOf('\n');
    const [commit, at, author] = (newline < 0 ? chunk : chunk.slice(0, newline)).split('\x1f');
    if (!commit || !at || author === undefined) continue;
    for (const file of patchFiles(newline < 0 ? '' : chunk.slice(newline + 1))) {
      if (!isGoalFile(file.path)) continue;
      const change = consentChange(file);
      if (change) changes.push({ commit, at, author, path: file.path, ...change });
      if (changes.length >= limit) return changes;
    }
  }
  return changes;
}

interface PatchFile { path: string; before?: string; after?: string }

/** The files of one commit's patch with the whole of each file as context: each one's text before and after. */
function patchFiles(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: { path: string; created: boolean; deleted: boolean; before: string[]; after: string[]; inHunk: boolean } | undefined;
  const close = () => {
    if (!current) return;
    files.push({ path: current.path, ...(current.created ? {} : { before: current.before.join('\n') }),
      ...(current.deleted ? {} : { after: current.after.join('\n') }) });
    current = undefined;
  };
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      close();
      current = { path: '', created: false, deleted: false, before: [], after: [], inHunk: false };
      continue;
    }
    if (!current) continue;
    if (!current.inHunk) {
      if (line.startsWith('new file mode')) current.created = true;
      else if (line.startsWith('deleted file mode')) current.deleted = true;
      else if (line.startsWith('--- ') && line !== '--- /dev/null') current.path = unquote(line.slice(4)).replace(/^a\//, '');
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null') current.path = unquote(line.slice(4)).replace(/^b\//, '');
      else if (line.startsWith('@@')) current.inHunk = true;
      continue;
    }
    if (line.startsWith('@@')) continue;
    if (line.startsWith(' ')) { current.before.push(line.slice(1)); current.after.push(line.slice(1)); }
    else if (line.startsWith('-')) current.before.push(line.slice(1));
    else if (line.startsWith('+')) current.after.push(line.slice(1));
  }
  close();
  // A file git shows as binary has no hunk, and no text to read sections from.
  return files.filter(file => file.path !== '');
}

/** A path as git prints it, without the quotes it puts around one with unusual characters. */
function unquote(path: string): string {
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}

function consentChange(file: PatchFile): Pick<GoalChange, 'kind' | 'sections'> | undefined {
  const sections = (text: string | undefined) => CONSENT_HEADINGS.map(heading => ({ heading, text: text === undefined ? undefined : sectionOf(text, heading) }));
  const lines = (text: string | undefined) => text === undefined || text === '' ? [] : text.split('\n');
  if (file.before === undefined || file.after === undefined) {
    const kind = file.before === undefined ? 'created' : 'deleted';
    const sign = kind === 'created' ? '+' : '-';
    return { kind, sections: sections(file.after ?? file.before).filter(section => section.text !== undefined)
      .map(section => ({ heading: section.heading, lines: lines(section.text).map(text => ({ sign, text })) })) };
  }
  const before = sections(file.before);
  const after = sections(file.after);
  const changed = before.flatMap((section, index) => section.text === after[index]!.text ? []
    : [{ heading: section.heading, lines: diffLines(lines(section.text), lines(after[index]!.text)) }]);
  return changed.length === 0 ? undefined : { kind: 'changed', sections: changed };
}

/** A line diff by the longest common subsequence: a section is a few lines, so the square table is small. */
function diffLines(before: string[], after: string[]): GoalDiffLine[] {
  const rows = before.length + 1;
  const columns = after.length + 1;
  const common: number[] = new Array(rows * columns).fill(0);
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      common[i * columns + j] = before[i] === after[j] ? common[(i + 1) * columns + j + 1]! + 1
        : Math.max(common[(i + 1) * columns + j]!, common[i * columns + j + 1]!);
    }
  }
  const lines: GoalDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) { lines.push({ sign: ' ', text: before[i]! }); i++; j++; }
    else if (common[(i + 1) * columns + j]! >= common[i * columns + j + 1]!) lines.push({ sign: '-', text: before[i++]! });
    else lines.push({ sign: '+', text: after[j++]! });
  }
  while (i < before.length) lines.push({ sign: '-', text: before[i++]! });
  while (j < after.length) lines.push({ sign: '+', text: after[j++]! });
  return lines;
}
