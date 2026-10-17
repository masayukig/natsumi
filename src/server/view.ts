import { open, realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { ToolOutcome } from './loop-tools.ts';
import { isWithin } from './paths.ts';

/**
 * `view <path>` in the shell (ADR 0039): the server answers it itself, putting the image into the tool result, so
 * natsumi looks at a picture only when she wants to and no tool is added. Only what is under `/sources`, which she
 * reads and never writes, and `/work`, where she puts the images she draws (ADR 0044), is shown — a link that leads
 * out of its own place is refused, so nothing she makes can point the server anywhere else — only images, and only
 * up to a size.
 */

/** Where the workspace sees the sources, which is `sources/` in the data directory. */
export const SOURCES_PATH = '/sources';
/** Where the workspace sees its working directory, which is `work/` in the data directory. */
export const WORK_PATH = '/work';
/** The largest image `view` shows. */
export const VIEW_MAX_BYTES = 5 * 1024 * 1024;

const LONE_VIEW = /^\s*view\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/;

/** The path of a command that is `view` and one path and nothing else; undefined for anything the runner should run. */
export function parseView(command: string): string | undefined {
  const match = LONE_VIEW.exec(command);
  return match ? match[1] ?? match[2] ?? match[3] : undefined;
}

/** An image's type from its first bytes. The name and what Slack said are not trusted. */
export function imageType(head: Buffer): string | undefined {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 6).toString('latin1') === 'GIF87a' || head.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return undefined;
}

/** A place the workspace names by `prefix`, and where it is on the server. */
export interface WorkspacePlace { prefix: string; directory: string }

/**
 * Where a workspace path under one of `places` really is on the server, with the place's own real path; `outside`
 * when it is under none of them or a link or `..` leads out of its place, `missing` when it cannot be resolved.
 * What is outside says nothing of where it leads.
 */
export async function resolveInPlace(path: string, places: WorkspacePlace[]):
  Promise<{ source: string; real: string; root: string } | 'outside' | 'missing'> {
  const source = posix.normalize(path);
  const place = places.find(candidate => source.startsWith(`${candidate.prefix}/`));
  if (!place) return 'outside';
  let root: string;
  let real: string;
  try {
    root = await realpath(place.directory);
    real = await realpath(posix.join(root, source.slice(place.prefix.length + 1)));
  } catch { return 'missing'; }
  return isWithin(real, root) ? { source, real, root } : 'outside';
}

/** Reads the image at a workspace path under `/sources` or `/work`, mapped onto those directories on the server. */
export async function viewImage(path: string, places: { sources: string; work: string }): Promise<ToolOutcome & { images?: ImageContent[] }> {
  const refuse = (text: string) => ({ ok: false, text: `表示していません。${text}` });
  const outside = 'view で見られるのは /sources/ と /work/ の下のファイルだけです。';
  if (!path.startsWith('/')) return refuse('view には /sources/ か /work/ から始まる絶対パスを書いてください。');
  const normalized = posix.normalize(path);
  const resolved = await resolveInPlace(path, [{ prefix: SOURCES_PATH, directory: places.sources }, { prefix: WORK_PATH, directory: places.work }]);
  if (resolved === 'outside') return refuse(outside);
  if (resolved === 'missing') return refuse(`${normalized} が見つかりません。`);
  const { real } = resolved;
  let handle;
  try { handle = await open(real, 'r'); } catch { return refuse(`${normalized} が見つかりません。`); }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return refuse(`${normalized} はファイルではありません。`);
    if (stats.size > VIEW_MAX_BYTES) {
      return refuse(`${normalized} は大きすぎます（${Math.round(VIEW_MAX_BYTES / 1024 / 1024)} MB まで）。`);
    }
    const data = await handle.readFile();
    const mimeType = imageType(data);
    if (!mimeType) return refuse(`${normalized} は画像ではありません（PNG・JPEG・GIF・WebP を見られます）。`);
    return { ok: true, text: `${normalized} を表示します（${mimeType}、${Math.ceil(data.length / 1024)} KB）。`,
      images: [{ type: 'image', mimeType, data: data.toString('base64') }] };
  } finally { await handle.close(); }
}
