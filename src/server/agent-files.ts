import { realpath, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { AgentFileError, type A2AClient, type AgentFile } from './a2a-client.ts';
import { discardImages, imageExtension, keepImage, type ImageLimits, type PostImageType, type TakenImage } from './images.ts';
import { isWithin, realPathAllowingMissing } from './paths.ts';
import { makeSharedDirectory, SHARED_FILE_MODE } from './permissions.ts';
import { imageType, WORK_PATH } from './view.ts';

/**
 * The images an outside agent hands back with its answer (ADR 0048), brought into /work for natsumi to look at with
 * `view` and to show the owner with `reply_to_mac`. Each is fetched from the agent's own origin under the token of
 * the calls, taken only as PNG, JPEG or WebP by its bytes and within the limits, kept as a copy on the server's side
 * like every image she hands it (ADR 0044), and put at `/work/agents/<agent>/<time>-<name>`.
 */

/** How large and how many the images of one answer may be: the contract with fraction-agents. */
export const AGENT_IMAGE_LIMITS: ImageLimits = { maxBytes: 10 * 1024 * 1024, maxCount: 8 };

/** Under /work, where each agent's images go, one directory per agent. */
export const AGENT_IMAGE_DIRECTORY = 'agents';

/** An image put in /work, as the event names it. */
export interface PlacedImage { path: string; description: string }

/** An image that was not taken, by the agent's name for it, and why in one sentence. */
export interface ImageNotTaken { name: string; reason: string }

export interface BroughtImages {
  /** The server's copies, to record with the event. */
  taken: TakenImage[];
  images: PlacedImage[];
  notTaken: ImageNotTaken[];
}

export interface BringOptions {
  agent: string;
  /** The agent's configured URL: only its origin is asked. */
  url: string;
  files: AgentFile[];
  client: A2AClient;
  /** `/work` as the server sees it. */
  workDirectory: string;
  /** Where the server keeps its copies. */
  imageDirectory: string;
  /** When the answer was taken, which names the files. */
  at: number;
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
  const stamp = timeStamp(options.at);
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
    const placed = await place(options, data, mimeType, `${stamp}-${safeName(file.name, index)}`);
    if (!placed.ok) { refuse(`画像を取れませんでした（${placed.reason}）。`); continue; }
    let copy: TakenImage;
    try {
      copy = await keepImage(data, mimeType, placed.path, options.imageDirectory);
    } catch {
      refuse('画像を取れませんでした（サーバーで写しを残せませんでした）。');
      continue;
    }
    brought.taken.push(copy);
    brought.images.push({ path: placed.path, description: file.description });
  }
  return brought;
}

/** Removes the server's copies of images that were brought and then not recorded. */
export function discardBrought(brought: BroughtImages): Promise<void> { return discardImages(brought.taken); }

/**
 * Writes one image under /work/agents/<agent>, never over another file and never through a link that leads out of
 * /work: the directory is natsumi's to change, so where it leads is looked at before and after it is made.
 */
async function place(options: BringOptions, data: Buffer, mimeType: PostImageType, stem: string):
  Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const relative = posix.join(AGENT_IMAGE_DIRECTORY, options.agent);
  const outside = { ok: false as const, reason: `${WORK_PATH}/${relative} が ${WORK_PATH} の外を指しています` };
  let root: string;
  try { root = await realpath(options.workDirectory); } catch { return { ok: false, reason: `${WORK_PATH} がありません` }; }
  const directory = join(root, AGENT_IMAGE_DIRECTORY, options.agent);
  try {
    if (!isWithin(await realPathAllowingMissing(directory), root)) return outside;
    await makeSharedDirectory(join(root, AGENT_IMAGE_DIRECTORY));
    await makeSharedDirectory(directory);
    if (!isWithin(await realpath(directory), root)) return outside;
  } catch { return { ok: false, reason: `${WORK_PATH}/${relative} を作れませんでした` }; }
  const extension = imageExtension(mimeType);
  for (let n = 1; n < 100; n++) {
    const name = `${stem}${n === 1 ? '' : `-${n}`}.${extension}`;
    try {
      // `wx` makes a new file or fails: it never writes over one, and never through a link left in its place.
      await writeFile(join(directory, name), data, { flag: 'wx', mode: SHARED_FILE_MODE });
      return { ok: true, path: `${WORK_PATH}/${relative}/${name}` };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') break;
    }
  }
  return { ok: false, reason: `${WORK_PATH}/${relative} に置けませんでした` };
}

/** The agent's name for a file as a safe file name without its extension, or `image-<n>` when nothing of it is. */
function safeName(name: string, index: number): string {
  const stem = posix.basename(name.replaceAll('\\', '/')).replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
  return stem || `image-${index + 1}`;
}

/** The time in UTC as `20260924T030000Z`. */
function timeStamp(at: number): string {
  return new Date(at).toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(/[-:]/g, '');
}
