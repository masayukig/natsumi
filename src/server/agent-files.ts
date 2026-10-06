import { writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { AgentFileError, type A2AClient, type AgentFile } from './a2a-client.ts';
import { discardImages, imageExtension, keepImage, type ImageLimits, type PostImageType, type TakenImage } from './images.ts';
import { imageType } from './view.ts';

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
