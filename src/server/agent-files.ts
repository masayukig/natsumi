import { open, realpath, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { AgentFileError, type A2AClient, type AgentFile, type SentFile } from './a2a-client.ts';
import { binaryLabel, classify } from './dashboard-files.ts';
import { discardImages, imageExtension, keepImage, type ImageLimits, type PostImageType, type TakenImage } from './images.ts';
import { isWithin } from './paths.ts';
import { imageType, SOURCES_PATH, WORK_PATH } from './view.ts';

/**
 * The images an outside agent hands back with its answer (ADR 0048), brought into the reply's `images/` under
 * /sources/agents (ADR 0069) for natsumi to look at with `view` and to show the owner with `reply_to_mac`. Each is
 * fetched from the agent's own origin under the token of the calls, taken only as PNG, JPEG or WebP by its bytes and
 * within the limits, and kept as a copy on the server's side like every image she hands it (ADR 0044).
 */

/** A reply's files, readable by the workspace's group and written by the server alone, as every source's are. */
export const REPLY_FILE_MODE = 0o640;

/** How large and how many the images of one answer may be: the contract with fraction-agents. */
export const AGENT_IMAGE_LIMITS: ImageLimits = { maxBytes: 10 * 1024 * 1024, maxCount: 8 };

/** An image put in a reply, as the workspace names it, with the agent's description of it. */
export interface PlacedImage { path: string; description: string }

/** An image that was not taken, by the agent's name for it, and why in one sentence. */
export interface ImageNotTaken { name: string; reason: string }

export interface BroughtImages {
  /** The server's copies, to record with the reply. */
  taken: TakenImage[];
  images: PlacedImage[];
  notTaken: ImageNotTaken[];
}

export interface BringOptions {
  /** The agent's configured URL: only its origin is asked. */
  url: string;
  files: AgentFile[];
  client: A2AClient;
  /** Where the images are written, as the server sees it: a directory only the server writes. */
  directory: string;
  /** The same directory as the workspace names it. */
  path: string;
  /** Where the server keeps its copies. */
  imageDirectory: string;
  limits?: ImageLimits;
}

const REASONS: Record<AgentFileError['kind'], string> = {
  elsewhere: '相手とは別の場所を指していたので、取りませんでした。',
  'no-token': '画像を取れませんでした（token を読めませんでした）。',
  unauthorized: '画像を取れませんでした（相手に断られました、401）。',
  'not-found': '画像を取れませんでした（相手のところにありません、404。期限が過ぎたのかもしれません）。',
  'too-large': '',
  unavailable: '画像を取れませんでした（相手につながりませんでした）。',
};

/** Brings every file it can, in order, and says of each other one why not. Never throws for one file's sake. */
export async function bringAgentImages(options: BringOptions): Promise<BroughtImages> {
  const limits = options.limits ?? AGENT_IMAGE_LIMITS;
  const brought: BroughtImages = { taken: [], images: [], notTaken: [] };
  for (const [index, file] of options.files.entries()) {
    const name = file.name || `image-${index + 1}`;
    const refuse = (reason: string) => { brought.notTaken.push({ name, reason }); };
    if (index >= limits.maxCount) { refuse(`1 回の返事から取る画像は ${limits.maxCount} 枚までです。`); continue; }
    let data: Buffer;
    try {
      data = await options.client.fetchFile(options.url, file.uri, limits.maxBytes);
    } catch (error) {
      const kind = error instanceof AgentFileError ? error.kind : 'unavailable';
      refuse(kind === 'too-large' ? `画像を取れませんでした（${Math.floor(limits.maxBytes / 1024 / 1024)} MB を超えていました）。` : REASONS[kind]);
      continue;
    }
    const mimeType = imageType(data);
    if (mimeType !== 'image/png' && mimeType !== 'image/jpeg' && mimeType !== 'image/webp') {
      refuse('画像を取れませんでした（PNG・JPEG・WebP のどれでもありませんでした。中身で見分けます）。');
      continue;
    }
    const placed = await place(options, data, mimeType, safeName(file.name, index));
    if (!placed) { refuse(`画像を取れませんでした（${options.path} に置けませんでした）。`); continue; }
    let copy: TakenImage;
    try {
      copy = await keepImage(data, mimeType, placed, options.imageDirectory);
    } catch {
      refuse('画像を取れませんでした（サーバーで写しを残せませんでした）。');
      continue;
    }
    brought.taken.push(copy);
    brought.images.push({ path: placed, description: file.description });
  }
  return brought;
}

/** Removes the server's copies of images that were brought and then not recorded. */
export function discardBrought(brought: BroughtImages): Promise<void> { return discardImages(brought.taken); }

/** Writes one image into the directory, never over another file. Returns its path as the workspace names it. */
async function place(options: BringOptions, data: Buffer, mimeType: PostImageType, stem: string): Promise<string | undefined> {
  const extension = imageExtension(mimeType);
  for (let n = 1; n < 100; n++) {
    const name = `${stem}${n === 1 ? '' : `-${n}`}.${extension}`;
    try {
      // `wx` makes a new file or fails: it never writes over one.
      await writeFile(join(options.directory, name), data, { flag: 'wx', mode: REPLY_FILE_MODE });
      return `${options.path}/${name}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
    }
  }
  return undefined;
}

/** The agent's name for a file as a safe file name without its extension, or `image-<n>` when nothing of it is. */
function safeName(name: string, index: number): string {
  const stem = posix.basename(name.replaceAll('\\', '/')).replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
  return stem || `image-${index + 1}`;
}

/**
 * How large each, how many and how large together the files natsumi sends with one request may be (ADR 0079): the
 * contract with fraction-agents, which refuses a message over them.
 */
export const SENT_FILE_LIMITS = { maxBytes: 20 * 1024 * 1024, maxCount: 8, maxTotalBytes: 50 * 1024 * 1024 };

/** The binaries `classify` names, as media types. Any other binary is sent as `application/octet-stream`. */
const BINARY_TYPES: Record<string, string> = {
  PDF: 'application/pdf', ZIP: 'application/zip', gzip: 'application/gzip', SQLite: 'application/vnd.sqlite3',
};

/** Text whose extension says more than `text/plain`. */
const TEXT_TYPES: Record<string, string> = { '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html' };

/**
 * Reads the files natsumi names in `ask_agent` (ADR 0079), all of them or none: the first that cannot be sent is
 * said in one sentence, and nothing is sent. Only what is under `/work` and `/sources` is read, as `view` reads — a
 * link or `..` that leads out of its place is refused as if it were outside — and only within the limits. Each goes
 * by its base name, typed by its bytes; text by its extension too.
 */
export async function readSentFiles(paths: string[], places: { work: string; sources: string },
  limits = SENT_FILE_LIMITS): Promise<{ ok: true; files: SentFile[] } | { ok: false; text: string }> {
  const refuse = (text: string) => ({ ok: false as const, text });
  if (paths.length > limits.maxCount) return refuse(`送れるファイルは 1 回に ${limits.maxCount} 個までです（${paths.length} 個ありました）。`);
  const megabytes = Math.floor(limits.maxBytes / 1024 / 1024);
  const tooMuch = refuse(`送れるファイルは合わせて ${Math.floor(limits.maxTotalBytes / 1024 / 1024)} MB までです。分けて頼むか、減らしてください。`);
  const files: SentFile[] = [];
  let total = 0;
  for (const path of paths) {
    const outside = refuse(`ファイル「${path}」は送れません。送れるのは ${WORK_PATH}/ か ${SOURCES_PATH}/ の下のファイルだけです。`);
    const source = posix.normalize(path);
    const place = source.startsWith(`${WORK_PATH}/`) ? { prefix: WORK_PATH, directory: places.work }
      : source.startsWith(`${SOURCES_PATH}/`) ? { prefix: SOURCES_PATH, directory: places.sources } : undefined;
    if (!place) return outside;
    let root: string;
    let real: string;
    try {
      root = await realpath(place.directory);
      real = await realpath(join(root, source.slice(place.prefix.length + 1)));
    } catch { return refuse(`ファイル ${source} が見つかりません。`); }
    // A link that leads out of its place is refused as if it were outside, and says nothing of where it leads.
    if (!isWithin(real, root) || real === root) return outside;
    let handle;
    try { handle = await open(real, 'r'); } catch { return refuse(`ファイル ${source} を読めません。`); }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) return refuse(`${source} はファイルではありません。`);
      if (stats.size > limits.maxBytes) return refuse(`ファイル ${source} は大きすぎます（1 個 ${megabytes} MB まで）。`);
      if (total + stats.size > limits.maxTotalBytes) return tooMuch;
      const data = await handle.readFile();
      // Read again rather than trusted: the file may have grown since it was looked at.
      if (data.length > limits.maxBytes) return refuse(`ファイル ${source} は大きすぎます（1 個 ${megabytes} MB まで）。`);
      total += data.length;
      if (total > limits.maxTotalBytes) return tooMuch;
      files.push({ name: posix.basename(source), mediaType: mediaType(data, source), data });
    } catch { return refuse(`ファイル ${source} を読めません。`); } finally { await handle.close(); }
  }
  return { ok: true, files };
}

/** A file's media type: a known binary by its first bytes, before asking whether it reads as text, as a PDF may. */
function mediaType(data: Buffer, path: string): string {
  const binary = BINARY_TYPES[binaryLabel(data) ?? ''];
  if (binary) return binary;
  const content = classify(data, data.length, data.length);
  if (content.type === 'image') return content.mimeType;
  if (content.type === 'text') return TEXT_TYPES[posix.extname(path).toLowerCase()] ?? 'text/plain';
  return 'application/octet-stream';
}
