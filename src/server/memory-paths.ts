import { readFile, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { ALWAYS_FILE, HANDOFF_FILE, INDEX_FILE, PERSONALITY_FILE, type MemoryRepository, type RevertedFile } from './memory-repository.ts';
import { SHARED_FILE_MODE } from './permissions.ts';

/**
 * The paths a curator stage moved, put right by the server after it (ADR 0068). The curator may rename, move and merge
 * files, and is never let into natsumi's own: so where her files, or any link, still name a path the stage took away,
 * the server rewrites that path — mechanically, and in a commit of its own after the stage's.
 *
 * Where a path went is read from git's renames in the stage's commit, and, for the files a merge took away (which git
 * cannot pair with anything), from the table the curator gave with `map_old_path`.
 */

/** Where memory is mounted in the workspace: a path may be written from there as well as from memory's root. */
const MEMORY_ROOT = '/memory/';

/** Files where a path is put right wherever it is written, not only as a link: natsumi's three and the index. */
export const BARE_PATH_FILES: readonly string[] = [ALWAYS_FILE, HANDOFF_FILE, PERSONALITY_FILE, INDEX_FILE];

/** A file a stage took away, and where it went. */
export interface PathMove { from: string; to: string }

/** What the server put right after a stage. */
export interface PathRewrite {
  /** The server's commit, when anything was rewritten. */
  commit?: string;
  /** Where each path went, git's renames first, then the curator's table, in path order within each. */
  moves: PathMove[];
  /** The files the commit carries. */
  files: string[];
  /** Files whose rewrite failed a check (a file grown past its limit), left as they were. */
  reverted: RevertedFile[];
  /** Rows of the curator's table that were not a merge, and why. */
  ignored: (PathMove & { reason: string })[];
}

/**
 * A path as memory's root names it: `/memory/` taken off, `.` and `..` resolved. Undefined for a path outside memory,
 * an absolute path elsewhere, or nothing at all.
 */
export function memoryPath(path: string): string | undefined {
  let rest = path.trim();
  if (rest.startsWith(MEMORY_ROOT)) rest = rest.slice(MEMORY_ROOT.length);
  else if (rest.startsWith('/')) return undefined;
  if (rest === '') return undefined;
  const normal = posix.normalize(rest);
  if (normal === '.' || normal === '..' || normal.startsWith('../') || normal.endsWith('/')) return undefined;
  return normal;
}

/** Where a link is read from, and what is there now. */
export interface LinkContext {
  /** The file the link is in, as it is now. */
  file: string;
  /** Where that file was before the stage: itself, unless the stage moved it. */
  oldFile: string;
  /** Path taken away → where it went. */
  moves: ReadonlyMap<string, string>;
  /** Whether a path is in memory now. */
  exists: (path: string) => boolean;
}

/** An inline Markdown link or image: the text, the target (bare or in angle brackets), and an optional title. */
const INLINE_LINK = /(!?\[[^\]\n]*\]\()(<[^>\n]*>|[^)\s]+)((?:\s+"[^"\n]*")?\))/g;

/**
 * Every inline link in `text` whose target the stage took away, pointed at where it went, written relative to the
 * linking file as before (or under `/memory/` when it was). A link that leads somewhere now is left alone, so links the
 * curator already put right stay as it wrote them; a moved file's own relative links are read from where it was.
 */
export function rewriteLinks(text: string, context: LinkContext): string {
  return text.replace(INLINE_LINK, (whole, open: string, raw: string, close: string) => {
    const angled = raw.startsWith('<');
    const target = angled ? raw.slice(1, -1) : raw;
    const rewritten = rewriteTarget(target, context);
    if (rewritten === undefined) return whole;
    return `${open}${angled ? `<${rewritten}>` : rewritten}${close}`;
  });
}

function rewriteTarget(target: string, context: LinkContext): string | undefined {
  if (target === '' || target.startsWith('#') || target.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined;
  const hash = target.indexOf('#');
  const location = hash < 0 ? target : target.slice(0, hash);
  const fragment = hash < 0 ? '' : target.slice(hash);
  const encoded = location.includes('%');
  let decoded: string;
  try { decoded = encoded ? decodeURI(location) : location; } catch { return undefined; }
  const encode = (path: string) => encoded ? encodeURI(path) : path;

  if (decoded.startsWith(MEMORY_ROOT)) {
    const path = memoryPath(decoded);
    if (!path || context.exists(path)) return undefined;
    const to = context.moves.get(path);
    return to === undefined ? undefined : `${encode(`${MEMORY_ROOT}${to}`)}${fragment}`;
  }
  if (decoded.startsWith('/')) return undefined;
  const here = memoryPath(posix.join(posix.dirname(context.file), decoded));
  if (here !== undefined && context.exists(here)) return undefined;
  const before = memoryPath(posix.join(posix.dirname(context.oldFile), decoded));
  if (before === undefined) return undefined;
  const to = context.moves.get(before) ?? (context.exists(before) ? before : undefined);
  if (to === undefined) return undefined;
  const relative = posix.relative(posix.dirname(context.file), to);
  return `${encode(relative)}${fragment}`;
}

/** Characters that may sit right next to a path inside a longer one: a path is never cut out of these. */
const PATH_CHARACTER = /[A-Za-z0-9._\-/]/;

/**
 * Every path the stage took away, wherever it is written in `text` — bare, in code, under `/memory/` — put right.
 * `known` is every file memory held before the stage; at each place the longest of them is read, so a path is never
 * cut out of a longer one that was there (`家族/本人.md` is not `本人.md`). A path must not run on into ASCII letters,
 * digits, `.`, `-`, `_` or `/` either side; Japanese may run on, as Japanese is written without spaces.
 */
export function rewriteBarePaths(text: string, moves: ReadonlyMap<string, string>, known: readonly string[]): string {
  const candidates = [...new Set([...known, ...moves.keys()])].sort((a, b) => b.length - a.length);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const starts = text.startsWith(MEMORY_ROOT, i) ? [i + MEMORY_ROOT.length, i] : [i];
    const boundary = i === 0 || !PATH_CHARACTER.test(text[i - 1]!);
    let matched: { at: number; path: string } | undefined;
    if (boundary) {
      for (const at of starts) {
        const path = candidates.find(candidate => text.startsWith(candidate, at) && !PATH_CHARACTER.test(text[at + candidate.length] ?? ' '));
        if (path) { matched = { at, path }; break; }
      }
    }
    if (!matched) { out += text[i]; i += 1; continue; }
    out += text.slice(i, matched.at) + (moves.get(matched.path) ?? matched.path);
    i = matched.at + matched.path.length;
  }
  return out;
}

/**
 * After a stage's commit: where every path the stage took away went (git's renames, and the curator's table for the
 * rest), and those paths put right — in natsumi's three files and the index wherever they are written, and in every
 * file's links, the diary's and the archive's included — as one commit of the server's own named `event`. Undefined
 * when the stage took no path away that went somewhere.
 */
export async function rewriteMovedPaths(repository: MemoryRepository, input: { before: string; merged: ReadonlyMap<string, string>; event: string }):
Promise<PathRewrite | undefined> {
  const old = await repository.filesAt(input.before);
  const now = await repository.filesAt('HEAD');
  const oldSet = new Set(old);
  const nowSet = new Set(now);
  const moves = new Map<string, string>();
  const movedFrom = new Map<string, string>();
  for (const rename of await repository.renamesSince(input.before)) {
    if (nowSet.has(rename.from)) continue;
    moves.set(rename.from, rename.to);
    movedFrom.set(rename.to, rename.from);
  }
  const ignored: PathRewrite['ignored'] = [];
  const mapped: PathMove[] = [];
  for (const [rawFrom, rawTo] of input.merged) {
    const from = memoryPath(rawFrom) ?? rawFrom;
    const to = memoryPath(rawTo) ?? rawTo;
    const reason = !oldSet.has(from) ? 'この工程の前に無かったパスです' : nowSet.has(from) ? 'まだ残っているパスです'
      : !nowSet.has(to) ? '行き先のファイルがありません' : undefined;
    if (reason) { ignored.push({ from, to, reason }); continue; }
    if (moves.has(from)) moves.delete(from);
    mapped.push({ from, to });
  }
  const renamed = [...moves].map(([from, to]) => ({ from, to })).sort((a, b) => a.from.localeCompare(b.from));
  for (const move of mapped) moves.set(move.from, move.to);
  const list = [...renamed, ...mapped.sort((a, b) => a.from.localeCompare(b.from))];
  if (list.length === 0) return undefined;

  for (const file of now.filter(path => path.endsWith('.md'))) {
    const absolute = join(repository.directory, file);
    let text: string;
    try { text = await readFile(absolute, 'utf8'); } catch { continue; }
    let next = rewriteLinks(text, { file, oldFile: movedFrom.get(file) ?? file, moves, exists: path => nowSet.has(path) || isDirectory(path, now) });
    if (BARE_PATH_FILES.includes(file)) next = rewriteBarePaths(next, moves, old);
    if (next !== text) await writeFile(absolute, next, { mode: SHARED_FILE_MODE });
  }
  const outcome = await repository.commitRewrite(input.event, list.map(move => `- ${move.from} → ${move.to}`).join('\n'));
  return { ...(outcome.committed ? { commit: await repository.head() } : {}), moves: list, files: outcome.files, reverted: outcome.reverted, ignored };
}

function isDirectory(path: string, files: readonly string[]): boolean {
  return files.some(file => file.startsWith(`${path}/`));
}
