import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath, type FileHandle } from 'node:fs/promises';
import { join, posix } from 'node:path';

/**
 * Her files as the dashboard reads them (ADR 0054): /memory, /work, /home/natsumi, /manual and /manual/agents, each
 * at `/dashboard/files` followed by the path she knows it by. Nothing is ever written, and nothing is read but through
 * here, one level of a directory or the head of a file at a time, all of it asynchronously.
 *
 * A symlink is never followed, at the end of a path or in the middle of one, whatever it points at: a listing says
 * where it points and no more. Every element of a path is checked with `lstat` before a file is opened, the file is
 * opened without following a last symlink, and after it is open its real path must still be the place's own and its
 * inode the one that was checked. The memory's `.git` is neither listed nor opened.
 */

export const FILES_PATH = '/dashboard/files';

/** Where each place really is: the memory repository, `work/`, `home/` and `agents/` of the data directory, and the code's `manual/`. */
export interface FileRoots {
  memory: string;
  work: string;
  home: string;
  manual: string;
  agents: string;
}
export type RootName = keyof FileRoots;

/** The places by the path she knows them by, the longest first, so /manual/agents is found before /manual. */
export const PLACES: readonly { root: RootName; place: string }[] = [
  { root: 'agents', place: '/manual/agents' },
  { root: 'home', place: '/home/natsumi' },
  { root: 'memory', place: '/memory' },
  { root: 'manual', place: '/manual' },
  { root: 'work', place: '/work' },
];

/** A place and the names below it, each one checked to be a plain name. */
export interface Location {
  root: RootName;
  place: string;
  segments: string[];
}

/** The most of a text file shown on its page; the rest is downloaded. */
export const TEXT_LIMIT = 1024 * 1024;
/** The most entries of one directory listed; a larger one says how many more there are. */
export const LIST_LIMIT = 2_000;
/** How many entries are looked at together. */
const STAT_BATCH = 64;

/** The place and names a dashboard URL's path names, or undefined when it names none or would leave its place. */
export function locate(pathname: string): Location | undefined {
  if (!pathname.startsWith(`${FILES_PATH}/`)) return undefined;
  const rest = pathname.slice(FILES_PATH.length);
  for (const { root, place } of PLACES) {
    if (rest !== place && !rest.startsWith(`${place}/`)) continue;
    const below = rest.slice(place.length);
    if (below === '') return { root, place, segments: [] };
    const segments: string[] = [];
    for (const raw of below.slice(1).split('/')) {
      let name: string;
      try { name = decodeURIComponent(raw); } catch { return undefined; }
      if (!plainName(name)) return undefined;
      segments.push(name);
    }
    return { root, place, segments };
  }
  return undefined;
}

/** The path she knows a location by: `/memory/notes/a.md`. */
export function workspacePath(location: Location): string {
  return [location.place, ...location.segments].join('/');
}

/** The dashboard's URL of a location, each name encoded. */
export function locationUrl(location: Location): string {
  return `${FILES_PATH}${location.place}${location.segments.map(name => `/${encodeURIComponent(name)}`).join('')}`;
}

/**
 * The dashboard's URL of a path in the workspace, when it is one of her places; undefined otherwise. The path must be
 * absolute and already normal, as `posix.resolve` leaves it.
 */
export function filesUrl(path: string): string | undefined {
  if (!path.startsWith('/') || posix.normalize(path) !== path) return undefined;
  for (const { root, place } of PLACES) {
    if (path !== place && !path.startsWith(`${place}/`)) continue;
    const segments = path.slice(place.length).split('/').filter(name => name !== '');
    if (!segments.every(plainName) || hiddenGit({ root, segments })) return undefined;
    return locationUrl({ root, place, segments });
  }
  return undefined;
}

function plainName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\u0000');
}

/** The memory's `.git`, and anything below it. */
function hiddenGit(location: Pick<Location, 'root' | 'segments'>): boolean {
  return location.root === 'memory' && location.segments[0] === '.git';
}

export type RefusalReason = 'missing' | 'symlink' | 'other' | 'unreadable';
export interface Refused {
  kind: 'refused';
  reason: RefusalReason;
  /** Where a symlink at the end of the path points, as it is written. */
  target?: string;
}

export interface ListedEntry {
  name: string;
  type: 'directory' | 'file' | 'symlink' | 'other';
  /** Bytes of a file; null for a directory, which is never summed, and a symlink. */
  size: number | null;
  mtimeMs: number;
  target?: string;
}

export interface DirectoryLook {
  kind: 'directory';
  entries: ListedEntry[];
}
export interface FileLook {
  kind: 'file';
  size: number;
  mtimeMs: number;
}
export type Look = DirectoryLook | FileLook | Refused;

type Checked = { kind: 'checked'; path: string; stats: Awaited<ReturnType<typeof lstat>> } | Refused;

/**
 * Walks from the place's real path down the names, each checked with `lstat`: a name missing, a symlink or a
 * non-directory in the middle of the path refuses it.
 */
async function check(roots: FileRoots, location: Location): Promise<Checked> {
  if (hiddenGit(location)) return { kind: 'refused', reason: 'missing' };
  let path: string;
  try { path = await realpath(roots[location.root]); } catch (error) { return refusal(error); }
  let stats: Awaited<ReturnType<typeof lstat>>;
  try { stats = await lstat(path); } catch (error) { return refusal(error); }
  if (!stats.isDirectory()) return { kind: 'refused', reason: 'missing' };
  for (const [index, name] of location.segments.entries()) {
    if (!stats.isDirectory()) return { kind: 'refused', reason: 'missing' };
    path = join(path, name);
    try { stats = await lstat(path); } catch (error) { return refusal(error); }
    if (stats.isSymbolicLink()) {
      if (index < location.segments.length - 1) return { kind: 'refused', reason: 'symlink' };
      const target = await readlink(path).catch(() => undefined);
      return { kind: 'refused', reason: 'symlink', ...(target === undefined ? {} : { target }) };
    }
  }
  return { kind: 'checked', path, stats };
}

function refusal(error: unknown): Refused {
  const code = (error as NodeJS.ErrnoException).code;
  return { kind: 'refused', reason: code === 'EACCES' || code === 'EPERM' ? 'unreadable' : 'missing' };
}

/** Whether nothing on the checked path became a symlink since: its real path is still the one walked. */
async function stillThere(path: string): Promise<boolean> {
  try { return await realpath(path) === path; } catch { return false; }
}

/** A directory's entries, one level down, or a file's size and time; never what either holds. */
export async function look(roots: FileRoots, location: Location): Promise<Look> {
  const checked = await check(roots, location);
  if (checked.kind === 'refused') return checked;
  const { path, stats } = checked;
  if (stats.isFile()) return { kind: 'file', size: Number(stats.size), mtimeMs: Number(stats.mtimeMs) };
  if (!stats.isDirectory()) return { kind: 'refused', reason: 'other' };
  let names: string[];
  try { names = await readdir(path); } catch (error) { return refusal(error); }
  if (!(await stillThere(path))) return { kind: 'refused', reason: 'symlink' };
  const atTop = location.segments.length === 0;
  if (atTop && location.root === 'memory') names = names.filter(name => name !== '.git');
  // The agents are a place of their own over /manual/agents, as the workspace mounts them.
  if (atTop && location.root === 'manual') names = names.filter(name => name !== 'agents');
  const entries: ListedEntry[] = [];
  for (let start = 0; start < names.length; start += STAT_BATCH) {
    entries.push(...(await Promise.all(names.slice(start, start + STAT_BATCH).map(name => listed(path, name)))).filter(entry => entry !== undefined));
  }
  if (atTop && location.root === 'manual') {
    const agents = await lstat(roots.agents).catch(() => undefined);
    if (agents) entries.push({ name: 'agents', type: 'directory', size: null, mtimeMs: Number(agents.mtimeMs) });
  }
  return { kind: 'directory', entries };
}

async function listed(directory: string, name: string): Promise<ListedEntry | undefined> {
  const path = join(directory, name);
  let stats: Awaited<ReturnType<typeof lstat>>;
  try { stats = await lstat(path); } catch { return undefined; }
  const mtimeMs = Number(stats.mtimeMs);
  if (stats.isSymbolicLink()) {
    const target = await readlink(path).catch(() => undefined);
    return { name, type: 'symlink', size: null, mtimeMs, ...(target === undefined ? {} : { target }) };
  }
  if (stats.isDirectory()) return { name, type: 'directory', size: null, mtimeMs };
  return { name, type: stats.isFile() ? 'file' : 'other', size: stats.isFile() ? Number(stats.size) : null, mtimeMs };
}

export type SortKey = 'name' | 'mtime' | 'size';
export type SortOrder = 'asc' | 'desc';
export interface ListingView {
  hidden: boolean;
  sort: SortKey;
  order: SortOrder;
}
/** The order a column is sorted in when its heading is first chosen: names A to Z, the newest and the largest first. */
export const DEFAULT_ORDER: Record<SortKey, SortOrder> = { name: 'asc', mtime: 'desc', size: 'desc' };

const collator = new Intl.Collator('ja', { numeric: true });

/** The entries as the page shows them: dotfiles hidden unless asked, directories first, then in the chosen order. */
export function listDirectory(listing: DirectoryLook, view: ListingView): { entries: ListedEntry[]; hiddenCount: number; omitted: number } {
  const shown = view.hidden ? listing.entries : listing.entries.filter(entry => !entry.name.startsWith('.'));
  const direction = view.order === 'asc' ? 1 : -1;
  const byName = (a: ListedEntry, b: ListedEntry) => collator.compare(a.name, b.name);
  const byKey = (a: ListedEntry, b: ListedEntry) => {
    if (view.sort === 'mtime') return a.mtimeMs - b.mtimeMs;
    if (view.sort === 'size') return (a.size ?? 0) - (b.size ?? 0);
    return byName(a, b);
  };
  const sorted = [...shown].sort((a, b) => {
    const directories = Number(b.type === 'directory') - Number(a.type === 'directory');
    return directories || direction * byKey(a, b) || byName(a, b);
  });
  return { entries: sorted.slice(0, LIST_LIMIT), hiddenCount: listing.entries.length - shown.length, omitted: Math.max(0, sorted.length - LIST_LIMIT) };
}

export type Opened = { kind: 'file'; handle: FileHandle; size: number; mtimeMs: number } | Refused;

/**
 * A file opened for reading, once it is known to be a plain file inside its place: opened without following a last
 * symlink, and without waiting on a pipe, and refused unless it is still the file that was checked and nothing on its
 * path has become a symlink since. The caller closes it.
 */
export async function openFile(roots: FileRoots, location: Location): Promise<Opened> {
  const checked = await check(roots, location);
  if (checked.kind === 'refused') return checked;
  const { path, stats } = checked;
  if (stats.isDirectory()) return { kind: 'refused', reason: 'missing' };
  if (!stats.isFile()) return { kind: 'refused', reason: 'other' };
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ELOOP' ? { kind: 'refused', reason: 'symlink' } : refusal(error);
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stats.ino || opened.dev !== stats.dev || !(await stillThere(path))) {
      await handle.close();
      return { kind: 'refused', reason: 'symlink' };
    }
    return { kind: 'file', handle, size: opened.size, mtimeMs: opened.mtimeMs };
  } catch (error) {
    await handle.close();
    return refusal(error);
  }
}

export type Head = { kind: 'file'; head: Buffer; size: number; mtimeMs: number } | Refused;

/** The first `limit` bytes of a file, and how big it is. */
export async function readHead(roots: FileRoots, location: Location, limit: number): Promise<Head> {
  const opened = await openFile(roots, location);
  if (opened.kind === 'refused') return opened;
  try {
    const buffer = Buffer.alloc(Math.min(limit, opened.size));
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await opened.handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return { kind: 'file', head: buffer.subarray(0, filled), size: opened.size, mtimeMs: opened.mtimeMs };
  } catch (error) {
    return refusal(error);
  } finally {
    await opened.handle.close();
  }
}

export type Content =
  | { type: 'text'; text: string; truncated: boolean }
  | { type: 'image'; mimeType: ImageType }
  | { type: 'binary'; label: string };

export type ImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** The images shown as pictures, by their first bytes: what a browser takes as a picture and nothing more. */
export function imageType(head: Buffer): ImageType | undefined {
  const starts = (bytes: number[] | string, at = 0) => {
    const expected = typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : Buffer.from(bytes);
    return head.length >= at + expected.length && head.subarray(at, at + expected.length).equals(expected);
  };
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts('GIF87a') || starts('GIF89a')) return 'image/gif';
  if (starts('RIFF') && starts('WEBP', 8)) return 'image/webp';
  return undefined;
}

/** Binaries named by their first bytes; any other is only a binary. */
const BINARIES: { label: string; bytes: number[] | string }[] = [
  { label: 'PDF', bytes: '%PDF-' },
  { label: 'ZIP', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { label: 'gzip', bytes: [0x1f, 0x8b] },
  { label: 'SQLite', bytes: 'SQLite format 3\u0000' },
  { label: 'ELF', bytes: [0x7f, 0x45, 0x4c, 0x46] },
];

const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * What the head of a file of `size` bytes is: an image by its first bytes; text when it has no NUL and reads as
 * UTF-8, cut back to a whole character where the head was cut at `limit`; otherwise a binary.
 */
export function classify(head: Buffer, size: number, limit: number): Content {
  const image = imageType(head);
  if (image) return { type: 'image', mimeType: image };
  const truncated = size > limit;
  const shown = truncated ? wholeCharacters(head.subarray(0, limit)) : head;
  if (!shown.includes(0)) {
    try { return { type: 'text', text: decoder.decode(shown), truncated }; } catch { /* not UTF-8 */ }
  }
  const known = BINARIES.find(({ bytes }) => {
    const expected = typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : Buffer.from(bytes);
    return head.length >= expected.length && head.subarray(0, expected.length).equals(expected);
  });
  return { type: 'binary', label: known?.label ?? 'バイナリ' };
}

/** The bytes less a character cut in half at the end. */
function wholeCharacters(bytes: Buffer): Buffer {
  // Back over at most three continuation bytes to the lead byte, and drop it when its character does not fit.
  for (let back = 1; back <= Math.min(4, bytes.length); back++) {
    const byte = bytes[bytes.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return length > back ? bytes.subarray(0, bytes.length - back) : bytes;
  }
  return bytes;
}
