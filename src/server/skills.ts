import { realpathSync } from 'node:fs';
import { posix, relative } from 'node:path';
import { loadSkills, type LoadSkillsResult, type Skill } from '@earendil-works/pi-coding-agent';
import type { PiSkills } from '../pi/session.ts';
import { isWithin } from './paths.ts';

/**
 * Skills (ADR 0073): the owner's, from a clone the owner keeps up to date over ssh, and her own, in memory. Pi lists each
 * in the system prompt by name, description and the path of its SKILL.md, and she reads the one a task calls for with
 * `read`. Pi finds them on the server, where the two places are directories of the data directory, while she reads them
 * in the workspace, where they are mounted elsewhere: so the list names each by the workspace's path, and a skill the
 * workspace would not see at that path — one reached through a symlink — is never listed.
 */

/** The directory of the owner's skills in the data directory, and of hers in memory. */
export const SKILLS_DIRECTORY = 'skills';
/** Where the workspace sees the owner's clone, read-only. */
export const OWNER_SKILLS_PLACE = '/skills';
/** Where the workspace sees her own skills: inside memory, which she writes. */
export const OWN_SKILLS_PLACE = `/memory/${SKILLS_DIRECTORY}`;

/**
 * The most characters one skill of hers may hold, all its files together: SKILL.md, its references and its scripts.
 * Each file keeps memory's own limit as well (ADR 0073).
 */
export const SKILL_MAX_CHARS = 100_000;

/** One place skills are loaded from: the server's directory, and the workspace's path for it. */
export interface SkillPlace { directory: string; shownAs: string; whose: 'owner' | 'own' }

/** The owner's place first: Pi keeps the first skill of a name, and the owner's wins (ADR 0073). */
export function skillPlaces(dataDirectory: string, memoryDirectory: string): SkillPlace[] {
  return [
    { directory: posix.join(dataDirectory, SKILLS_DIRECTORY), shownAs: OWNER_SKILLS_PLACE, whose: 'owner' },
    { directory: posix.join(memoryDirectory, SKILLS_DIRECTORY), shownAs: OWN_SKILLS_PLACE, whose: 'own' },
  ];
}

/** What a session is given: the two places, and the list as Pi loaded it turned into what she is shown. */
export function piSkills(places: readonly SkillPlace[], log: (line: string) => void): PiSkills {
  return { directories: places.map(place => place.directory), settle: loaded => settleSkills(loaded, places, log) };
}

/**
 * The skills as she is shown them, each at the workspace's path, and every diagnostic Pi left written to the log. Nothing
 * here stops a session: a missing clone or a broken skill leaves the others, or none.
 */
export function settleSkills(loaded: LoadSkillsResult, places: readonly SkillPlace[], log: (line: string) => void): LoadSkillsResult {
  const shown = (path: string) => shownPath(path, places) ?? path;
  const skills: Skill[] = [];
  const counts = { owner: 0, own: 0 };
  for (const skill of loaded.skills) {
    const place = placeOf(skill.filePath, places);
    if (!place) continue;
    if (!seenAsIs(skill.filePath, place)) {
      log(`skills: ${shown(skill.filePath)} is reached through a symlink and is left out`);
      continue;
    }
    counts[place.whose] += 1;
    skills.push({ ...skill, filePath: shown(skill.filePath), baseDir: shown(skill.baseDir) });
  }
  for (const diagnostic of loaded.diagnostics) {
    if (diagnostic.type === 'collision' && diagnostic.collision) {
      const { name, winnerPath, loserPath } = diagnostic.collision;
      log(`skills: "${name}" in ${shown(loserPath)} is left out; ${shown(winnerPath)} has the same name`);
    } else {
      log(`skills: ${diagnostic.path ? `${shown(diagnostic.path)}: ` : ''}${diagnostic.message}`);
    }
  }
  log(`skills: ${counts.owner} of the owner's and ${counts.own} of her own`);
  return { skills, diagnostics: loaded.diagnostics };
}

/**
 * Why a SKILL.md she wrote may not be committed, or undefined when Pi would load it as it stands: with a description,
 * and without a warning about its name or its description. `file` is its path on the server.
 */
export function skillFileProblem(file: string): string | undefined {
  const { skills, diagnostics } = loadSkills({ cwd: posix.dirname(file), agentDir: posix.dirname(file), skillPaths: [file], includeDefaults: false });
  const problems = diagnostics.map(diagnostic => diagnostic.message);
  if (skills.length === 1 && problems.length === 0) return undefined;
  if (skills.length === 0 && problems.length === 0) problems.push('description is required');
  return `skill として読み込めません（${problems.join('; ')}）。頭の frontmatter に name（小文字の英数字とハイフン）と description を書きます`;
}

function placeOf(path: string, places: readonly SkillPlace[]): SkillPlace | undefined {
  return places.find(place => isWithin(path, place.directory));
}

function shownPath(path: string, places: readonly SkillPlace[]): string | undefined {
  const place = placeOf(path, places);
  if (!place) return undefined;
  const rest = relative(place.directory, path);
  return rest === '' ? place.shownAs : posix.join(place.shownAs, rest);
}

/** Whether the file is where its path says, with no symlink on the way from its place. */
function seenAsIs(path: string, place: SkillPlace): boolean {
  try { return realpathSync(path) === posix.join(realpathSync(place.directory), relative(place.directory, path)); } catch { return false; }
}
