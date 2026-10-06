import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { ShownAttachment } from '../shared/protocol/conversation.ts';
import { imageSize, type PostImageType } from './images.ts';
import { isoAt } from './nightly.ts';
import { imageType, SOURCES_PATH } from './view.ts';

/**
 * The files the owner hands natsumi from the chat (ADR 0071). Each is taken over HTTP when it is chosen, written where
 * the server keeps its own things and then moved whole to `sources/uploads/<UTC time>-<4 hex>/<name>`, which the
 * workspace sees read-only as `/sources/uploads`. It is the account's that sent it until an owner message takes it;
 * then it belongs to that message for good, and one not taken within a day is cleared away.
 *
 * `sources/uploads` is not a source: nothing registers it, so the history of `/sources` never looks at it, and no
 * `sources_updated` tells of it (ADR 0050). She hears of a file through the message that carries it, by its place;
 * the upload's ID is between the devices and the server only (ADR 0024).
 */

/** The directory under `sources/`. */
export const UPLOADS_DIRECTORY = 'uploads';
export const UPLOADS_PATH = `${SOURCES_PATH}/${UPLOADS_DIRECTORY}`;

/** One file, and the files of one message, at most (ADR 0071); `uploads.maxFileBytes` and `uploads.maxFiles` change them. */
export const UPLOAD_DEFAULTS = { maxFileBytes: 25 * 1024 * 1024, maxFiles: 10 };

/** How long a file waits to be sent before it is cleared away. */
export const UNSENT_UPLOAD_MS = 24 * 60 * 60 * 1000;

/** The images of a message shown beside it, at most: as many as an event's attentions (ADR 0050, ADR 0071). */
export const MAX_SHOWN_UPLOAD_IMAGES = 4;
/** An image larger than this is told by its place only: the model is handed what Slack's images are held to. */
export const MAX_SHOWN_IMAGE_BYTES = 5 * 1024 * 1024;

/** A name kept within this many bytes, which leaves a file system's 255 room. */
const MAX_NAME_BYTES = 200;
const DIRECTORY_MODE = 0o750;
/** Read by the workspace's group, written by nobody (ADR 0033): the original stays as it was handed over. */
const FILE_MODE = 0o640;

export interface UploadLimits { maxFileBytes: number; maxFiles: number }

export type Received = { ok: true; upload: ShownAttachment } | { ok: false; code: 'too-large' };
export type Checked = { ok: true } | { ok: false; code: 'invalid-request' | 'upload-not-found' | 'too-many-uploads' };

/** One file as the line of its message names it to her. */
export interface LineEntry { path: string; bytes: number; shown_as_image?: true }

export interface UploadsOptions {
  db: DatabaseSync;
  /** `sources/` in the data directory. */
  sourcesDirectory: string;
  /** Where a file is written while it comes, in the server's own state directory. */
  stagingDirectory: string;
  limits: UploadLimits;
  now: () => number;
}

interface Row {
  upload_id: string; github_user_id: number; name: string; path: string; bytes: number; mime_type: string | null;
  width: number | null; height: number | null; message_id: string | null; position: number | null; created_at: string;
}

/**
 * The name a file is kept under: the last part of what was given, composed (a Mac sends decomposed names), with no
 * control character, no dot in front and no more than 200 bytes, the extension kept. What is left of nothing is `file`.
 */
export function safeFileName(given: string): string {
  const last = given.split(/[/\\]/).at(-1) ?? '';
  let name = last.normalize('NFC').replaceAll(/[\u0000-\u001f\u007f]/g, '_').trim();
  if (name === '' || name === '.' || name === '..') return 'file';
  if (name.startsWith('.')) name = `_${name.slice(1)}`;
  if (Buffer.byteLength(name) <= MAX_NAME_BYTES) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && Buffer.byteLength(name.slice(dot)) <= 16 ? name.slice(dot) : '';
  let stem = [...name.slice(0, name.length - extension.length)];
  while (Buffer.byteLength(stem.join('') + extension) > MAX_NAME_BYTES) stem = stem.slice(0, -1);
  return stem.join('') + extension;
}

export class Uploads {
  readonly limits: UploadLimits;
  private readonly options: UploadsOptions;

  constructor(options: UploadsOptions) {
    this.options = options;
    this.limits = options.limits;
  }

  /**
   * Takes one file as it comes, up to the limit. It is written aside and moved into place whole, so the workspace
   * never sees half of it; one past the limit is dropped, and nothing of it is kept.
   */
  async receive(body: AsyncIterable<Buffer>, input: { name: string; githubUserId: number }): Promise<Received> {
    const { db, sourcesDirectory, stagingDirectory, limits, now } = this.options;
    const uploadId = `upload-${randomUUID()}`;
    const name = safeFileName(input.name);
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
    const staged = join(stagingDirectory, uploadId);
    const hash = createHash('sha256');
    let bytes = 0;
    let head = Buffer.alloc(0);
    const handle = await open(staged, 'wx', FILE_MODE);
    try {
      for await (const chunk of body) {
        bytes += chunk.length;
        if (bytes > limits.maxFileBytes) {
          await handle.close();
          await rm(staged, { force: true });
          return { ok: false, code: 'too-large' };
        }
        if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(staged, { force: true });
      throw error;
    }
    try {
      const type = imageType(head);
      const mimeType = type === 'image/png' || type === 'image/jpeg' || type === 'image/webp' ? type : undefined;
      const size = mimeType ? imageSize(await readFile(staged), mimeType as PostImageType) : undefined;
      const directory = await this.makeDirectory();
      const path = `${UPLOADS_DIRECTORY}/${directory}/${name}`;
      await rename(staged, join(sourcesDirectory, path));
      // The umask may have taken the group's read away from the file as it was opened.
      await chmod(join(sourcesDirectory, path), FILE_MODE);
      db.prepare(`INSERT INTO uploads (upload_id, github_user_id, name, path, bytes, sha256, mime_type, width, height, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uploadId, input.githubUserId, name, path, bytes, hash.digest('hex'),
        mimeType ?? null, size?.width ?? null, size?.height ?? null, isoAt(now()));
      return { ok: true, upload: shown({ upload_id: uploadId, name, bytes, mime_type: mimeType ?? null, width: size?.width ?? null,
        height: size?.height ?? null }) };
    } finally {
      await rm(staged, { force: true });
    }
  }

  /**
   * Whether a message may take these files: each named once, no more than the limit, and every one of the account's
   * own and not sent yet. Synchronous, so nothing comes between this and `attach` in the same call.
   */
  check(uploadIds: readonly string[], githubUserId: number): Checked {
    if (new Set(uploadIds).size !== uploadIds.length) return { ok: false, code: 'invalid-request' };
    if (uploadIds.length > this.limits.maxFiles) return { ok: false, code: 'too-many-uploads' };
    const found = this.options.db.prepare(`SELECT COUNT(*) AS n FROM uploads WHERE upload_id IN (SELECT value FROM json_each(?))
      AND github_user_id = ? AND message_id IS NULL`).get(JSON.stringify(uploadIds), githubUserId) as { n: number };
    return found.n === uploadIds.length ? { ok: true } : { ok: false, code: 'upload-not-found' };
  }

  /** Gives the files to a message, in this order. Called inside the transaction that records the message. */
  attach(uploadIds: readonly string[], messageId: string): void {
    const update = this.options.db.prepare('UPDATE uploads SET message_id = ?, position = ? WHERE upload_id = ? AND message_id IS NULL');
    uploadIds.forEach((uploadId, position) => {
      if (Number(update.run(messageId, position, uploadId).changes) !== 1) throw new Error('an upload was taken by another message');
    });
  }

  /** The IDs of a message's files, in order: a request sent again must name the same. */
  idsOf(messageId: string): string[] {
    return this.rowsOf(messageId).map(row => row.upload_id);
  }

  /** The files each of these messages carries, as the devices are shown them. A message with none is not in the map. */
  shown(messageIds: readonly string[]): Map<string, ShownAttachment[]> {
    const map = new Map<string, ShownAttachment[]>();
    if (messageIds.length === 0) return map;
    const rows = this.options.db.prepare(`SELECT * FROM uploads WHERE message_id IN (SELECT value FROM json_each(?))
      ORDER BY message_id, position`).all(JSON.stringify(messageIds)) as unknown as Row[];
    for (const row of rows) map.set(row.message_id!, [...map.get(row.message_id!) ?? [], shown(row)]);
    return map;
  }

  /** The files of a message as its line tells her of them: where each is, how large, and whether it is shown beside. */
  lineEntries(messageId: string): LineEntry[] {
    const rows = this.rowsOf(messageId);
    const showing = new Set(this.shownImages(rows).map(row => row.upload_id));
    return rows.map(row => ({ path: `${SOURCES_PATH}/${row.path}`, bytes: row.bytes, ...(showing.has(row.upload_id) ? { shown_as_image: true as const } : {}) }));
  }

  /** Whether any of a message's files is shown to her as an image. */
  hasImages(messageId: string): boolean {
    return this.shownImages(this.rowsOf(messageId)).length > 0;
  }

  /** The images handed to the model beside a message's line. A file gone by hand is simply not shown. */
  async images(messageId: string): Promise<ImageContent[]> {
    const images: ImageContent[] = [];
    for (const row of this.shownImages(this.rowsOf(messageId))) {
      try {
        const data = await readFile(join(this.options.sourcesDirectory, row.path));
        images.push({ type: 'image', mimeType: row.mime_type!, data: data.toString('base64') });
      } catch { /* the line still names its place */ }
    }
    return images;
  }

  /** A file a message carries, for the devices to fetch: its name, its type when it is an image, and where it is. */
  async read(uploadId: string): Promise<{ name: string; bytes: number; mimeType?: string; file: string } | undefined> {
    const row = this.options.db.prepare('SELECT * FROM uploads WHERE upload_id = ? AND message_id IS NOT NULL').get(uploadId) as
      Row | undefined;
    if (!row) return undefined;
    return { name: row.name, bytes: row.bytes, ...(row.mime_type ? { mimeType: row.mime_type } : {}),
      file: join(this.options.sourcesDirectory, row.path) };
  }

  /** Clears away the files not sent within their time, rows first, so no message can take one being removed. */
  async sweep(): Promise<number> {
    const { db, sourcesDirectory, now } = this.options;
    const gone = db.prepare('DELETE FROM uploads WHERE message_id IS NULL AND created_at < ? RETURNING path')
      .all(isoAt(now() - UNSENT_UPLOAD_MS)) as { path: string }[];
    for (const { path } of gone) await rm(join(sourcesDirectory, path, '..'), { recursive: true, force: true });
    return gone.length;
  }

  private rowsOf(messageId: string): Row[] {
    return this.options.db.prepare('SELECT * FROM uploads WHERE message_id = ? ORDER BY position').all(messageId) as unknown as Row[];
  }

  private shownImages(rows: Row[]): Row[] {
    return rows.filter(row => row.mime_type !== null && row.bytes <= MAX_SHOWN_IMAGE_BYTES).slice(0, MAX_SHOWN_UPLOAD_IMAGES);
  }

  /** A new directory `<UTC time>-<4 hex>` under `sources/uploads`, its name tried again while it is taken. */
  private async makeDirectory(): Promise<string> {
    const parent = join(this.options.sourcesDirectory, UPLOADS_DIRECTORY);
    await mkdir(parent, { recursive: true, mode: DIRECTORY_MODE });
    const stamp = new Date(this.options.now()).toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(/[-:]/g, '');
    for (let attempt = 0; attempt < 16; attempt++) {
      const name = `${stamp}-${randomBytes(2).toString('hex')}`;
      try {
        await mkdir(join(parent, name), { mode: DIRECTORY_MODE });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      await chmod(join(parent, name), DIRECTORY_MODE);
      return name;
    }
    throw new Error('no free name for an upload');
  }
}

function shown(row: Pick<Row, 'upload_id' | 'name' | 'bytes' | 'mime_type' | 'width' | 'height'>): ShownAttachment {
  return { uploadId: row.upload_id, name: row.name, bytes: row.bytes, ...(row.mime_type ? { mimeType: row.mime_type } : {}),
    ...(row.width !== null && row.height !== null ? { width: row.width, height: row.height } : {}) };
}
