import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isWithin } from './paths.ts';
import { imageType, WORK_PATH } from './view.ts';

/**
 * Images natsumi hands the server from /work (ADR 0044), such as those she names under `画像:` in a request to the
 * dove. Only what is under `/work` is taken — a link or `..` that leads out of it is refused as if it were outside —
 * only PNG, JPEG and WebP by their bytes, and only within the limits. What passes is copied at once to the server's
 * side, where the workspace cannot write, and given an ID: the owner is shown the copy and the copy is what is sent,
 * whatever becomes of the file in /work. The copies do not belong to the dove: each is one image of the server's,
 * which the devices fetch by its ID with the session, whatever shows it to them.
 */

/** Where the copies are kept, under the server's own state directory. */
export const IMAGE_DIRECTORY = 'images';

export type PostImageType = 'image/png' | 'image/jpeg' | 'image/webp';
const EXTENSIONS: Record<PostImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export interface ImageLimits {
  /** The largest image taken. */
  maxBytes: number;
  /** The most images in one request. */
  maxCount: number;
}

export interface TakenImage {
  imageId: string;
  /** The path as the workspace names it, normalized. */
  source: string;
  /** Where the copy is. */
  file: string;
  mimeType: PostImageType;
  bytes: number;
  sha256: string;
  /** The size in pixels, when the header says it. */
  width?: number;
  height?: number;
}

/**
 * How large and how many the images of one reply may be (ADR 0045): the same as a post to Slack's defaults. They are
 * not in the config, since the owner is the only one they are shown to.
 */
export const REPLY_IMAGE_LIMITS: ImageLimits = { maxBytes: 10 * 1024 * 1024, maxCount: 4 };

/** An image as the devices are told of it: by ID, with what they need to lay it out before fetching it. */
export interface ShownImage {
  imageId: string;
  mimeType: string;
  bytes: number;
  /** Present only when the image's header said it. */
  width?: number;
  height?: number;
}

/** How an image is shown, without the fields it does not have. */
export function shownImage(image: { imageId: string; mimeType: string; bytes: number; width?: number | null; height?: number | null }):
  ShownImage {
  const { imageId, mimeType, bytes, width, height } = image;
  return { imageId, mimeType, bytes, ...(width != null && height != null ? { width, height } : {}) };
}

export type TakenImages = { ok: true; images: TakenImage[] } | { ok: false; text: string };

/**
 * Checks every image and copies them all into `destination`, each named by its new ID, or copies none and says in one
 * sentence what to fix. `workDirectory` is `/work` as the server sees it.
 */
export async function takeImages(paths: string[], options: { workDirectory: string; destination: string; limits: ImageLimits }):
  Promise<TakenImages> {
  const { limits } = options;
  if (paths.length > limits.maxCount) return { ok: false, text: `画像は 1 回に ${limits.maxCount} 枚までです（${paths.length} 枚ありました）。` };
  const read: { source: string; data: Buffer; mimeType: PostImageType }[] = [];
  for (const path of paths) {
    const one = await readImage(path, options.workDirectory, limits.maxBytes);
    if (!one.ok) return one;
    read.push(one);
  }
  const images = read.map(({ source, data, mimeType }) => {
    const imageId = `image-${randomUUID()}`;
    return { imageId, source, file: join(options.destination, `${imageId}.${EXTENSIONS[mimeType]}`), mimeType, bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'), ...imageSize(data, mimeType), data };
  });
  try {
    await mkdir(options.destination, { recursive: true, mode: 0o700 });
    for (const image of images) await writeFile(image.file, image.data, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await discardImages(images);
    throw error;
  }
  return { ok: true, images: images.map(({ data: _data, ...image }) => image) };
}

/**
 * Copies one image the server already holds in memory, such as one an outside agent handed back (ADR 0048), into
 * `destination` under a new ID. `source` is the path the workspace knows it by.
 */
export async function keepImage(data: Buffer, mimeType: PostImageType, source: string, destination: string): Promise<TakenImage> {
  const imageId = `image-${randomUUID()}`;
  const file = join(destination, `${imageId}.${EXTENSIONS[mimeType]}`);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await writeFile(file, data, { flag: 'wx', mode: 0o600 });
  return { imageId, source, file, mimeType, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'),
    ...imageSize(data, mimeType) };
}

/** The extension a copy of this type is given. */
export function imageExtension(mimeType: PostImageType): string { return EXTENSIONS[mimeType]; }

/** Removes copies that were taken and then not kept. */
export async function discardImages(images: { file: string }[]): Promise<void> {
  await Promise.all(images.map(image => rm(image.file, { force: true })));
}

/**
 * The images the server has taken, recorded in the state database (the `images` table) with their copies in
 * `directory`. Whatever shows an image — an approval now — names it by `imageId` only.
 */
export class ImageStore {
  readonly directory: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, directory: string) {
    this.db = db;
    this.directory = directory;
  }

  take(paths: string[], workDirectory: string, limits: ImageLimits): Promise<TakenImages> {
    return takeImages(paths, { workDirectory, destination: this.directory, limits });
  }

  /** Records taken images. Called inside the transaction that records what they belong to. */
  record(images: TakenImage[], createdAt: string): void {
    const insert = this.db.prepare(`INSERT INTO images (image_id, source, file, mime_type, bytes, sha256, width, height, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const image of images) {
      insert.run(image.imageId, image.source, basename(image.file), image.mimeType, image.bytes, image.sha256,
        image.width ?? null, image.height ?? null, createdAt);
    }
  }

  /** An image's copy by its ID, or undefined when there is no such image or its copy is gone. */
  async read(imageId: string): Promise<{ mimeType: string; data: Buffer } | undefined> {
    const row = this.db.prepare('SELECT file, mime_type FROM images WHERE image_id = ?').get(imageId) as
      { file: string; mime_type: string } | undefined;
    if (!row) return undefined;
    try { return { mimeType: row.mime_type, data: await readFile(join(this.directory, row.file)) }; } catch { return undefined; }
  }

  /** Where an image's copy is, for sending it. */
  path(file: string): string { return join(this.directory, file); }
}

async function readImage(path: string, workDirectory: string, maxBytes: number):
  Promise<{ ok: true; source: string; data: Buffer; mimeType: PostImageType } | { ok: false; text: string }> {
  const refuse = (text: string) => ({ ok: false as const, text });
  const outside = refuse(`画像「${path}」は使えません。画像にできるのは /work/ の下のファイルだけです。`);
  const source = posix.normalize(path);
  if (!source.startsWith(`${WORK_PATH}/`)) return outside;
  let root: string;
  let real: string;
  try {
    root = await realpath(workDirectory);
    real = await realpath(join(root, source.slice(WORK_PATH.length + 1)));
  } catch { return refuse(`画像 ${source} が見つかりません。`); }
  // A link that leads out of /work is refused as if it were outside, and says nothing of where it leads.
  if (!isWithin(real, root) || real === root) return outside;
  let handle;
  try { handle = await open(real, 'r'); } catch { return refuse(`画像 ${source} が見つかりません。`); }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return refuse(`画像 ${source} はファイルではありません。`);
    if (stats.size > maxBytes) return refuse(`画像 ${source} は大きすぎます（${size(maxBytes)} まで）。`);
    const data = await handle.readFile();
    // Read again rather than trusted: the file may have grown since it was looked at.
    if (data.length > maxBytes) return refuse(`画像 ${source} は大きすぎます（${size(maxBytes)} まで）。`);
    const mimeType = imageType(data);
    if (mimeType !== 'image/png' && mimeType !== 'image/jpeg' && mimeType !== 'image/webp') {
      return refuse(`画像 ${source} は PNG・JPEG・WebP のどれでもありません（中身で見分けます）。`);
    }
    return { ok: true, source, data, mimeType };
  } finally { await handle.close(); }
}

/**
 * The width and height a PNG, JPEG or WebP header gives, for the devices to lay the picture out before it arrives
 * (ADR 0045). Undefined when the header does not say, which leaves the image as good as any other.
 */
export function imageSize(data: Buffer, mimeType: PostImageType): { width: number; height: number } | undefined {
  const size = mimeType === 'image/png' ? pngSize(data) : mimeType === 'image/jpeg' ? jpegSize(data) : webpSize(data);
  return size && size.width > 0 && size.height > 0 ? size : undefined;
}

/** The IHDR chunk, which comes first. */
function pngSize(data: Buffer) {
  if (data.length < 24 || data.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** The first start-of-frame marker, found by walking the segments before it. */
function jpegSize(data: Buffer) {
  let at = 2;
  while (at + 4 <= data.length) {
    if (data[at] !== 0xff) return undefined;
    const marker = data[at + 1]!;
    // Fill bytes, and markers that stand alone without a length.
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue; }
    const length = data.readUInt16BE(at + 2);
    // SOF0 to SOF15, less DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > data.length) return undefined;
      return { width: data.readUInt16BE(at + 7), height: data.readUInt16BE(at + 5) };
    }
    if (length < 2) return undefined;
    at += 2 + length;
  }
  return undefined;
}

/** The first chunk: VP8X for an extended file, VP8 for a lossy one, VP8L for a lossless one. */
function webpSize(data: Buffer) {
  if (data.length < 30) return undefined;
  const chunk = data.toString('latin1', 12, 16);
  if (chunk === 'VP8X') return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
  if (chunk === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
    return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.floor(bytes / 1024 / 1024)} MB` : `${Math.floor(bytes / 1024)} KB`;
}
