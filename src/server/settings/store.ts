import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_DIRECTORY } from '../data-directory.ts';
import { writeFileAtomically } from '../paths.ts';
import { checkSetting, isFold, SETTING_KEYS, type SettingKey, type SettingValues } from './domain.ts';

/**
 * Where the owner's overrides of the config are kept (ADR 0058), in the data directory so that a restart or a release
 * leaves them as they were. One of them present wins over the config's value; cleared, the config's applies again.
 *
 * - The route and the fold keep the files they have always had (ADR 0046, ADR 0047), in the same shape, so a data
 *   directory from before reads the same. The command line writes them too, through here.
 * - The rest share `runtime-settings.json`, which only the server writes; the server writes one change at a time.
 *
 * This layer knows files and the domain's rules, and nothing of the loop, the service or the ways in.
 */

export const RUNTIME_SETTINGS_FILE = 'runtime-settings.json';
const ROUTE_FILE = 'model-route.json';
const FOLD_FILE = 'turn-fold.json';
const MODE = 0o600;

export type Overrides = Partial<SettingValues>;

/** The overrides found, and the names of those left out: a value that breaks the rules, a name that is no setting. */
export interface ReadOverrides { values: Overrides; ignored: string[] }

type SharedKey = Exclude<SettingKey, 'modelRoute' | 'turnFold'>;
const SHARED_KEYS = SETTING_KEYS.filter((key): key is SharedKey => key !== 'modelRoute' && key !== 'turnFold');

const statePath = (dataDirectory: string, file: string) => join(dataDirectory, STATE_DIRECTORY, file);
const stamp = (now: number) => new Date(now).toISOString();

async function readJson(path: string): Promise<{ found: false } | { found: true; value: unknown } | { found: true; broken: true }> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { return { found: false }; }
  try { return { found: true, value: JSON.parse(text) as unknown }; } catch { return { found: true, broken: true }; }
}

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;

/** The route the owner chose: any name, as before. One the config does not have is the loop's to fall back from. */
export async function readRouteOverride(dataDirectory: string): Promise<string | undefined> {
  const read = await readJson(statePath(dataDirectory, ROUTE_FILE));
  const route = 'value' in read ? field(read.value, 'route') : undefined;
  return typeof route === 'string' ? route : undefined;
}

export async function readFoldOverride(dataDirectory: string): Promise<SettingValues['turnFold'] | undefined> {
  const read = await readJson(statePath(dataDirectory, FOLD_FILE));
  const fold = 'value' in read ? field(read.value, 'fold') : undefined;
  return isFold(fold) ? fold : undefined;
}

/** The shared file's overrides as they are written, before any is checked. Undefined when there is no file. */
async function readShared(dataDirectory: string): Promise<{ overrides: Record<string, unknown>; broken: boolean } | undefined> {
  const read = await readJson(statePath(dataDirectory, RUNTIME_SETTINGS_FILE));
  if (!read.found) return undefined;
  if ('broken' in read) return { overrides: {}, broken: true };
  const overrides = field(read.value, 'overrides');
  const usable = typeof overrides === 'object' && overrides !== null && !Array.isArray(overrides);
  return { overrides: usable ? { ...overrides as Record<string, unknown> } : {}, broken: !usable };
}

/** Every override there is now. Nothing is thrown: what cannot be read is as good as not there. */
export async function readOverrides(dataDirectory: string): Promise<ReadOverrides> {
  const values: Overrides = {};
  const ignored: string[] = [];
  const route = await readRouteOverride(dataDirectory);
  if (route !== undefined) values.modelRoute = route;
  const fold = await readFoldOverride(dataDirectory);
  if (fold !== undefined) values.turnFold = fold;
  const shared = await readShared(dataDirectory);
  if (shared?.broken) ignored.push(RUNTIME_SETTINGS_FILE);
  for (const [key, value] of Object.entries(shared?.overrides ?? {})) {
    const checked = checkSetting(key, value);
    if (!checked.ok || !(SHARED_KEYS as readonly string[]).includes(checked.key)) { ignored.push(key); continue; }
    Object.assign(values, { [checked.key]: checked.value });
  }
  return { values, ignored };
}

/** Writes one override. The value is taken as already checked against the domain's rules. */
export async function writeOverride<K extends SettingKey>(dataDirectory: string, key: K, value: SettingValues[K], now: number): Promise<void> {
  if (key === 'modelRoute') {
    await writeFileAtomically(statePath(dataDirectory, ROUTE_FILE), `${JSON.stringify({ route: value, chosenAt: stamp(now) })}\n`, MODE);
  } else if (key === 'turnFold') {
    await writeFileAtomically(statePath(dataDirectory, FOLD_FILE), `${JSON.stringify({ fold: value, chosenAt: stamp(now) })}\n`, MODE);
  } else {
    await writeShared(dataDirectory, overrides => { overrides[key] = value; }, now);
  }
}

/** Takes an override away, so the config's value applies. One that is not there is already cleared. */
export async function clearOverride(dataDirectory: string, key: SettingKey, now: number): Promise<void> {
  if (key === 'modelRoute' || key === 'turnFold') {
    await rm(statePath(dataDirectory, key === 'modelRoute' ? ROUTE_FILE : FOLD_FILE), { force: true });
    return;
  }
  const shared = await readShared(dataDirectory);
  if (!shared || !(key in shared.overrides)) return;
  await writeShared(dataDirectory, overrides => { delete overrides[key]; }, now);
}

/** Rewrites the shared file with one change, keeping the overrides that keep the rules. A broken file starts over. */
async function writeShared(dataDirectory: string, change: (overrides: Record<string, unknown>) => void, now: number) {
  const kept = (await readOverrides(dataDirectory)).values;
  const overrides: Record<string, unknown> = {};
  for (const key of SHARED_KEYS) if (kept[key] !== undefined) overrides[key] = kept[key];
  change(overrides);
  await writeFileAtomically(statePath(dataDirectory, RUNTIME_SETTINGS_FILE),
    `${JSON.stringify({ overrides, updatedAt: stamp(now) }, null, 2)}\n`, MODE);
}
