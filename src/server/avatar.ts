import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { ConfigError, type AvatarConfig } from './config.ts';
import { EXPRESSIONS } from './loop-tools.ts';
import { isWithin } from './paths.ts';

/**
 * The avatar the server is pointed at (ADR 0057): a directory of `avatar.json` (its ID and display name, and how its
 * sheet is laid out), the sheet, the face of each feeling, the Slack icons, the look she draws herself with and the
 * sdctl params. It is read once, at start, and what it lacks is filled in from the faceless pictures the server
 * carries, never from natsumi's. What is written but broken stops the start; what is missing does not.
 *
 * The apps are handed one bundle under fixed names (`pet.json`, `avatar.json`, `spritesheet.<ext>`,
 * `icons/<feeling>.<ext>`), whose version is its content, so they need not know which parts were filled in.
 */

/** The avatars built into the image, one directory each, named by its ID. */
export const BUILT_IN_DIRECTORY = await firstDirectory();
/** natsumi, used when the config names no avatar. */
export const DEFAULT_AVATAR_ID = 'natsumi';
export const DEFAULT_AVATAR_DIRECTORY = join(BUILT_IN_DIRECTORY, DEFAULT_AVATAR_ID);
/** 名無し: a built-in avatar that lacks nothing, and where what another avatar lacks is taken from. */
export const FALLBACK_AVATAR_ID = 'nanashi';
export const FALLBACK_DIRECTORY = join(BUILT_IN_DIRECTORY, FALLBACK_AVATAR_ID);

/** `assets/avatars` of the code: beside `src/` in a checkout, beside `dist/` in the image. */
async function firstDirectory(): Promise<string> {
  const places = ['../../assets/avatars', '../../../assets/avatars'].map(path => fileURLToPath(new URL(path, import.meta.url)));
  for (const directory of places) {
    if (await stat(directory).then(found => found.isDirectory(), () => false)) return directory;
  }
  return places[0]!;
}

/** The IDs of the built-in avatars, in order. */
export async function builtInAvatars(): Promise<string[]> {
  const entries = await readdir(BUILT_IN_DIRECTORY, { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
}

/** Her own look, from `appearance.yaml`: what goes at the head of every picture she is in. */
export interface Appearance {
  /** The LoRA's name, checked for as `<lora:<name>`. */
  lora?: string;
  /** The lines copied as they are into every picture of her. */
  body: string;
  /** The line of her default clothes, and what they are called. */
  outfit: string;
  outfitName?: string;
  /** Words she must not drop when the clothes change. */
  keep: string[];
  examples: { title: string; outfit: string; scene: string }[];
}

export interface AvatarFile { data: Buffer; contentType: string; sha256: string }

export interface Avatar {
  id: string;
  name: string;
  /** The directory it was read from. */
  directory: string;
  /** The bundle the apps are given, by its fixed paths. */
  files: ReadonlyMap<string, AvatarFile>;
  /** The content's hash: the same files give the same version on any server. */
  version: string;
  appearance?: Appearance;
  /** The sdctl params, as YAML text. */
  sdctlParams: string;
  /** What was filled in from the faceless pictures: `spritesheet`, `icons/<feeling>`, `slack/<feeling>`. */
  filled: string[];
  /** What the server's default stands in for: `pet.json`, `appearance.yaml`, `sdctl-params.yaml`. */
  defaults: string[];
  /** The Slack icon of a feeling, or undefined for anything that is not one. */
  slack(expression: string): Buffer | undefined;
}

export interface AvatarInspection {
  /** Present only when there are no errors. */
  avatar?: Avatar;
  errors: string[];
  filled: string[];
  defaults: string[];
}

/**
 * The feelings an avatar may draw (ADR 0057): the server's, and `angry`, which the spec has and the server does not
 * use yet. What an avatar gives for a feeling the server does not use is checked for its shape and otherwise left
 * alone: it is neither handed to the apps nor filled in, until the server's list has it.
 */
export const AVATAR_EXPRESSIONS = [...EXPRESSIONS, 'angry'] as const;

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_NAME_CHARS = 32;
const IMAGE_TYPES: Record<string, string> = { '.webp': 'image/webp', '.png': 'image/png' };
const APPEARANCE_KEYS = ['lora', 'body', 'outfit', 'outfitName', 'keep', 'examples'];

/**
 * The avatar the config names: a built-in one by its ID, or one added by its directory; natsumi when it names none.
 * An unknown ID or a broken avatar stops the start as a config error on the setting that named it.
 */
export async function loadAvatar(choice: AvatarConfig | undefined): Promise<Avatar> {
  const chosen = choice ?? { id: DEFAULT_AVATAR_ID };
  const setting = 'id' in chosen ? 'avatar.id' : 'avatar.directory';
  const directory = 'id' in chosen ? await builtInDirectory(chosen.id) : chosen.directory;
  if (directory === undefined) throw new ConfigError(setting, await notBuiltIn((chosen as { id: string }).id));
  const inspected = await inspectAvatar(directory);
  if (!inspected.avatar) throw new ConfigError(setting, inspected.errors.join('; '));
  return inspected.avatar;
}

/** The directory of a built-in avatar, or undefined when the image has none of that ID. */
async function builtInDirectory(id: string): Promise<string | undefined> {
  return (await builtInAvatars()).includes(id) ? join(BUILT_IN_DIRECTORY, id) : undefined;
}

async function notBuiltIn(id: string): Promise<string> {
  return `${id} is not a built-in avatar (${(await builtInAvatars()).join(', ')})`;
}

/** What the apps are told of the bundle: its version, names, and each file's path, size and hash, by path. */
export function avatarManifest(avatar: Avatar) {
  return {
    version: avatar.version, id: avatar.id, name: avatar.name,
    files: [...avatar.files.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([path, file]) => ({ path, bytes: file.data.length, sha256: file.sha256 })),
  };
}

type Found = { kind: 'ok'; data: Buffer } | { kind: 'missing' } | { kind: 'outside' };

/** A file under `root` by a relative path, refusing one that resolves outside it (a symlink included). */
async function readInside(root: string, path: string): Promise<Found> {
  let real: string;
  try { real = await realpath(join(root, path)); } catch { return { kind: 'missing' }; }
  if (!isWithin(real, root)) return { kind: 'outside' };
  if (!(await stat(real)).isFile()) return { kind: 'missing' };
  return { kind: 'ok', data: await readFile(real) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, least = 1): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= least;
}

/** A path inside the directory, to a WebP or a PNG. */
function imagePath(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !isAbsolute(value) && !value.includes('\\')
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..') && extname(value).toLowerCase() in IMAGE_TYPES;
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const jsonFile = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/**
 * Runs every check the start runs, and sorts what it finds: what stops the start, what is filled in from the faceless
 * pictures, and what the server's default stands in for. `natsumi avatar check` prints the three.
 */
export async function inspectAvatar(directory: string): Promise<AvatarInspection> {
  const errors: string[] = [];
  const filled: string[] = [];
  const defaults: string[] = [];
  const failed = () => ({ errors, filled, defaults });

  const found = await stat(directory).catch(() => undefined);
  if (!found) return { ...failed(), errors: ['does not exist'] };
  if (!found.isDirectory()) return { ...failed(), errors: ['is not a directory'] };
  const root = await realpath(directory);

  const manifestFile = await readInside(root, 'avatar.json');
  if (manifestFile.kind !== 'ok') return { ...failed(), errors: [manifestFile.kind === 'outside' ? 'avatar.json leads outside the directory' : 'avatar.json is missing'] };
  let manifest: unknown;
  try { manifest = JSON.parse(manifestFile.data.toString('utf8')); } catch { return { ...failed(), errors: ['avatar.json: not valid JSON'] }; }
  if (!isObject(manifest)) return { ...failed(), errors: ['avatar.json: must be an object'] };

  // The fields, each checked for its shape whether or not the files it names are there.
  const { id, name } = manifest;
  if (typeof id !== 'string' || !ID.test(id)) errors.push('avatar.json: id must be lowercase letters, digits and "-", starting with a letter, up to 32');
  if (typeof name !== 'string' || name === '' || [...name].length > MAX_NAME_CHARS || /\p{Cc}/u.test(name)) {
    errors.push(`avatar.json: name must be 1 to ${MAX_NAME_CHARS} characters without control characters`);
  }
  const sheet = manifest.spritesheet;
  if (sheet !== undefined && !imagePath(sheet)) errors.push('avatar.json: spritesheet must be a WebP or PNG inside the directory');
  const atlas = manifest.atlas;
  if (atlas !== undefined) {
    if (!isObject(atlas)) errors.push('avatar.json: atlas must be an object');
    else for (const key of ['columns', 'rows', 'cellWidth', 'cellHeight']) {
      if (!positiveInteger(atlas[key])) errors.push(`avatar.json: atlas.${key} must be a positive integer`);
    }
  }
  const fps = manifest.framesPerSecond;
  if (fps !== undefined && (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0)) {
    errors.push('avatar.json: framesPerSecond must be a number above 0');
  }
  const animations = manifest.animations;
  if (animations !== undefined) {
    if (!isObject(animations)) errors.push('avatar.json: animations must be an object');
    else for (const [key, animation] of Object.entries(animations)) {
      if (!isObject(animation) || !positiveInteger(animation.row, 0) || !positiveInteger(animation.frames)) {
        errors.push(`avatar.json: animations.${key} must have a row from 0 and frames from 1`);
      }
    }
  }
  const expressions = manifest.expressions;
  if (expressions !== undefined) {
    if (!isObject(expressions)) errors.push('avatar.json: expressions must be an object');
    else for (const [key, animation] of Object.entries(expressions)) {
      if (typeof animation !== 'string' || !isObject(animations) || !(animation in animations)) {
        errors.push(`avatar.json: expressions.${key} names no animation`);
      }
    }
  }
  const icons = manifest.icons;
  if (icons !== undefined) {
    if (!isObject(icons)) errors.push('avatar.json: icons must be an object');
    else for (const [key, path] of Object.entries(icons)) {
      if (!imagePath(path)) errors.push(`avatar.json: icons.${key} must be a WebP or PNG inside the directory`);
    }
  }
  if (sheet !== undefined) {
    if (atlas === undefined) errors.push('avatar.json: a spritesheet needs its atlas');
    if (animations === undefined) errors.push('avatar.json: a spritesheet needs its animations');
  }

  const fallback = await readFallback();
  const files = new Map<string, AvatarFile>();
  const put = (path: string, data: Buffer, contentType: string) => { files.set(path, { data, contentType, sha256: sha256(data) }); };

  // The sheet and its animations go together: one never comes from the avatar and the other from the fallback.
  const served: Record<string, unknown> = {};
  const ownSheet = imagePath(sheet) ? await readInside(root, sheet) : { kind: 'missing' as const };
  if (ownSheet.kind === 'outside') errors.push('avatar.json: spritesheet leads outside the directory');
  if (ownSheet.kind === 'ok') {
    const extension = extname(sheet as string).toLowerCase();
    put(`spritesheet${extension}`, ownSheet.data, IMAGE_TYPES[extension]!);
    served.spritesheet = `spritesheet${extension}`;
    served.atlas = atlas;
    if (fps !== undefined) served.framesPerSecond = fps;
    served.animations = animations;
    // Only the feelings the server uses: a mapping for angry waits until the server has it.
    if (isObject(expressions)) {
      served.expressions = Object.fromEntries(Object.entries(expressions)
        .filter(([key]) => (EXPRESSIONS as readonly string[]).includes(key)));
    }
  } else {
    filled.push('spritesheet');
    put('spritesheet.webp', fallback.spritesheet, 'image/webp');
    served.spritesheet = 'spritesheet.webp';
    served.atlas = fallback.manifest.atlas;
    served.framesPerSecond = fallback.manifest.framesPerSecond;
    served.animations = fallback.manifest.animations;
    served.expressions = Object.fromEntries(Object.entries(fallback.manifest.expressions as Record<string, string>)
      .filter(([key]) => (EXPRESSIONS as readonly string[]).includes(key)));
  }

  const servedIcons: Record<string, string> = {};
  for (const expression of EXPRESSIONS) {
    const path = isObject(icons) ? icons[expression] : undefined;
    const own = imagePath(path) ? await readInside(root, path) : { kind: 'missing' as const };
    if (own.kind === 'outside') errors.push(`avatar.json: icons.${expression} leads outside the directory`);
    if (own.kind === 'ok') {
      const extension = extname(path as string).toLowerCase();
      put(`icons/${expression}${extension}`, own.data, IMAGE_TYPES[extension]!);
      servedIcons[expression] = `icons/${expression}${extension}`;
    } else {
      filled.push(`icons/${expression}`);
      put(`icons/${expression}.webp`, fallback.icons.get(expression)!, 'image/webp');
      servedIcons[expression] = `icons/${expression}.webp`;
    }
  }
  served.icons = servedIcons;

  const slack = new Map<string, Buffer>();
  for (const expression of EXPRESSIONS) {
    const own = await readInside(root, `slack/${expression}.png`);
    if (own.kind === 'outside') errors.push(`slack/${expression}.png leads outside the directory`);
    if (own.kind === 'ok') slack.set(expression, own.data);
    else {
      filled.push(`slack/${expression}`);
      slack.set(expression, fallback.slack.get(expression)!);
    }
  }

  const pet = await readInside(root, 'pet.json');
  if (pet.kind === 'outside') errors.push('pet.json leads outside the directory');
  if (pet.kind === 'ok') {
    let parsed: unknown;
    try { parsed = JSON.parse(pet.data.toString('utf8')); } catch { /* reported below */ }
    if (!isObject(parsed)) errors.push('pet.json: must be a JSON object');
  } else defaults.push('pet.json');

  let appearance: Appearance | undefined;
  const look = await readInside(root, 'appearance.yaml');
  if (look.kind === 'outside') errors.push('appearance.yaml leads outside the directory');
  if (look.kind === 'ok') appearance = parseAppearance(look.data.toString('utf8'), errors);
  else defaults.push('appearance.yaml');

  let sdctlParams = fallback.sdctlParams;
  const params = await readInside(root, 'sdctl-params.yaml');
  if (params.kind === 'outside') errors.push('sdctl-params.yaml leads outside the directory');
  if (params.kind === 'ok') {
    sdctlParams = params.data.toString('utf8');
    let parsed: unknown;
    try { parsed = parse(sdctlParams); } catch { errors.push('sdctl-params.yaml: not valid YAML'); parsed = {}; }
    if (!isObject(parsed)) errors.push('sdctl-params.yaml: must be a mapping');
  } else defaults.push('sdctl-params.yaml');

  if (errors.length > 0) return failed();
  const own = { id: id as string, name: name as string };
  put('avatar.json', jsonFile({ ...own, ...served }), 'application/json');
  put('pet.json', pet.kind === 'ok' ? pet.data : jsonFile({ id: own.id, displayName: own.name, spritesheetPath: served.spritesheet }),
    'application/json');
  const version = createHash('sha256')
    .update([...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => `${path}\0${file.sha256}\n`).join(''))
    .digest('hex').slice(0, 32);
  const avatar: Avatar = {
    ...own, directory: root, files, version, ...(appearance ? { appearance } : {}), sdctlParams, filled, defaults,
    slack: expression => (EXPRESSIONS as readonly string[]).includes(expression) ? slack.get(expression) : undefined,
  };
  return { avatar, errors, filled, defaults };
}

/** `appearance.yaml`, checked; every problem is added to `errors`. The trailing newline of a block is dropped. */
function parseAppearance(text: string, errors: string[]): Appearance | undefined {
  let raw: unknown;
  try { raw = parse(text); } catch { errors.push('appearance.yaml: not valid YAML'); return undefined; }
  if (!isObject(raw)) { errors.push('appearance.yaml: must be a mapping'); return undefined; }
  const before = errors.length;
  for (const key of Object.keys(raw)) if (!APPEARANCE_KEYS.includes(key)) errors.push(`appearance.yaml: ${key} is not a known setting`);
  const given = (value: unknown) => typeof value === 'string' && value.trim() !== '';
  const lines = (value: string) => value.replace(/\n+$/, '');
  if (!given(raw.body)) errors.push('appearance.yaml: body must be text');
  if (!given(raw.outfit)) errors.push('appearance.yaml: outfit must be text');
  if (raw.lora !== undefined && !given(raw.lora)) errors.push('appearance.yaml: lora must be text');
  if (raw.outfitName !== undefined && !given(raw.outfitName)) errors.push('appearance.yaml: outfitName must be text');
  const keep = raw.keep ?? [];
  if (!Array.isArray(keep) || !keep.every(given)) errors.push('appearance.yaml: keep must be a list of words');
  const examples = raw.examples ?? [];
  if (!Array.isArray(examples) || !examples.every(example => isObject(example) && given(example.title) && given(example.outfit) && given(example.scene))) {
    errors.push('appearance.yaml: examples must be a list of title, outfit and scene');
  }
  if (errors.length > before) return undefined;
  return {
    ...(raw.lora !== undefined ? { lora: (raw.lora as string).trim() } : {}),
    body: lines(raw.body as string), outfit: lines(raw.outfit as string),
    ...(raw.outfitName !== undefined ? { outfitName: raw.outfitName as string } : {}),
    keep: keep as string[],
    examples: (examples as Record<string, string>[]).map(example => ({ title: example.title!, outfit: lines(example.outfit!), scene: lines(example.scene!) })),
  };
}

interface Fallback {
  manifest: Record<string, unknown>;
  spritesheet: Buffer;
  icons: Map<string, Buffer>;
  slack: Map<string, Buffer>;
  sdctlParams: string;
}

let fallbackRead: Promise<Fallback> | undefined;

/** The server's own fill-ins, read once. A missing one is a broken image, not a broken avatar, and throws. */
function readFallback(): Promise<Fallback> {
  fallbackRead ??= (async () => {
    const at = (path: string) => readFile(join(FALLBACK_DIRECTORY, path));
    const icons = new Map<string, Buffer>();
    const slack = new Map<string, Buffer>();
    for (const expression of EXPRESSIONS) {
      icons.set(expression, await at(`icons/${expression}.webp`));
      slack.set(expression, await at(`slack/${expression}.png`));
    }
    return {
      manifest: JSON.parse((await at('avatar.json')).toString('utf8')) as Record<string, unknown>,
      spritesheet: await at('spritesheet.webp'), icons, slack, sdctlParams: (await at('sdctl-params.yaml')).toString('utf8'),
    };
  })();
  return fallbackRead;
}

/** `natsumi avatar check <directory or ID>` asks for this. A target without a slash is a built-in avatar's ID. */
export interface AvatarCommand { command: 'avatar'; action: 'check'; target: string }

/**
 * `natsumi avatar check`: the start's own checks on a directory or a built-in avatar, printed as what stops the start, what the faceless pictures fill in,
 * and what the server's defaults stand in for. The exit code is 1 when the server would not start with it.
 */
export async function runAvatarCheck(target: string, write: (line: string) => void): Promise<number> {
  const builtIn = target.includes('/') ? target : await builtInDirectory(target);
  const { avatar, errors, filled, defaults } = builtIn === undefined
    ? { avatar: undefined, errors: [await notBuiltIn(target)], filled: [], defaults: [] }
    : await inspectAvatar(builtIn);
  const list = (heading: string, items: string[]) => {
    if (items.length === 0) write(`${heading}: none`);
    else { write(`${heading}:`); for (const item of items) write(`- ${item}`); }
  };
  if (!avatar) {
    list('errors (the server does not start)', errors);
    return 1;
  }
  write(`avatar: ${avatar.id} (${avatar.name})`);
  write(`version: ${avatar.version}`);
  list('errors (the server does not start)', errors);
  list('filled in with the faceless pictures', filled);
  list('the server\'s defaults', defaults);
  return 0;
}
