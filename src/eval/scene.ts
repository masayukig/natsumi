import { access, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * A scene (ADR 0051): the state a turn starts from, the event handed to it, what is checked about it, and the variants
 * that differ a little. One directory holds one, as `scene.yaml`, with an optional `scene.ts` beside it for the setup
 * and the checks the rule parts cannot express.
 */

export class SceneError extends Error {
  constructor(where: string, message: string) { super(`${where}: ${message}`); this.name = 'SceneError'; }
}

/** What a scene may say it needs of the branch; a branch without it skips the scene. */
export const FEATURES = ['sources-updated'] as const;
export type Feature = typeof FEATURES[number];

export type SceneEvent =
  | { kind: 'mac_message'; text: string }
  | { kind: 'ping' }
  /** The event line itself, handed over through the loop's side for outside events. */
  | { kind: 'line'; line: Record<string, unknown> };

/** A file's content, written in the scene or read from a file beside it (an absolute path once loaded). */
export type FileSource = { text: string } | { file: string };
export interface Edit { path: string; replace: string; with: string }
export interface PromptEdit { replace: string; with: string }
export interface ToolStep { tool: string; args: Record<string, unknown> }
/** One answer of the scripted model: its thinking, its text, then its tool calls. */
export interface ScriptedAnswer { thinking?: string; text?: string; calls: ToolStep[] }
/** A turn before the one evaluated: an event, and the calls natsumi is made to answer it with. */
export interface PreludeTurn { event: SceneEvent; calls: ToolStep[] }

export interface Check {
  id: string;
  by: 'rule' | 'function' | 'llm';
  /** The check without its id: one kind (`called`, `shell`, `rubric`…) and its bounds. */
  spec: Record<string, unknown>;
}

/** What the dove answers with (ADR 0040): what became of the request. */
export const DOVE_RESULTS = ['sent', 'reacted', 'to_owner', 'returned', 'rejected', 'expired', 'not_sent'] as const;
export type DoveResult = typeof DOVE_RESULTS[number];
/** One reply of an actor, written in the scene; the dove's also says what became of the request. */
export interface ActorReply { text: string; result?: DoveResult }
/**
 * Who plays an outside agent or the dove (ADR 0052): an LLM given the card and the instructions, or the replies
 * written here, handed back in order (the last one again once they run out).
 */
export interface Actor { name: string; card: string; instructions?: string; replies: ActorReply[] }

/** Everything a variant may change. */
interface Layer {
  event?: SceneEvent;
  files?: Record<string, FileSource>;
  copies?: Record<string, string>;
  edits?: Edit[];
  prompt?: PromptEdit[];
  checks?: Check[];
}

export interface Scene {
  name: string;
  dir: string;
  description: string;
  requires: Feature[];
  runs: number;
  /** The clock when the event arrives, in ms; the real clock when absent. */
  time: number | undefined;
  timeZone: string;
  limits: { modelCalls?: number; minutes?: number };
  /** Requests to the dove (`ask_agent` poppo) are taken and recorded, as when Slack is configured. */
  dove: boolean;
  context: { session?: string; prelude: PreludeTurn[]; padding?: { turns: number; chars: number } };
  /** The state the run starts from: a snapshot of production (ADR 0052), the newest or one by name. */
  start?: { snapshot: string };
  /** The actors' replies are handed back as events, turn after turn, up to `maxTurns` turns in all (ADR 0052). */
  follow?: { maxTurns: number };
  /** Who plays the outside agents and the dove, by the name `ask_agent` uses. */
  actors: Record<string, Actor>;
  /** A function in `scene.ts` run on the data directory before the loop opens. */
  setup?: string;
  /** What the scripted model answers with in a dry run. */
  dryRun: ScriptedAnswer[];
  /** `scene.ts`, when there is one. */
  module?: string;
  base: Required<Omit<Layer, 'event'>> & { event: SceneEvent };
  axes: { name: string; values: { name: string; layer: Layer }[] }[];
}

export type Condition = Required<Omit<Layer, 'event'>> & { event: SceneEvent; scene: Scene; variant: string };

export const DEFAULT_RUNS = 5;
export const DEFAULT_MAX_TURNS = 4;
/** What an outside agent's card says when the scene gives it none. */
export const DEFAULT_CARD = '頼まれたことを調べて答える、外のエージェントです。';
const DOVE = 'poppo';
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TOP_KEYS = ['description', 'requires', 'runs', 'time', 'timeZone', 'limits', 'dove', 'context', 'setup', 'dryRun', 'event',
  'files', 'copy', 'edits', 'prompt', 'checks', 'variants', 'axes', 'start', 'follow', 'actors'];
const LAYER_KEYS = ['event', 'files', 'copy', 'edits', 'prompt', 'checks'];
/** The places of the workspace a scene may write, as natsumi sees them. */
export const PLACES = ['/memory', '/work', '/home/natsumi', '/sources', '/manual'];
const RULES = ['called', 'notCalled', 'shell', 'output', 'read', 'notRead', 'asked', 'reply', 'modelCalls', 'finished'];
const COUNTED = new Set(['called', 'shell', 'output', 'read', 'asked', 'reply']);

type Raw = Record<string, unknown>;

/** Every scene in the directories: a directory with `scene.yaml` is one, any other holds one per subdirectory. */
export async function loadScenes(dirs: string[]): Promise<Scene[]> {
  const scenes: Scene[] = [];
  for (const dir of dirs) {
    const root = resolve(dir);
    if (await exists(join(root, 'scene.yaml'))) { scenes.push(await loadScene(root)); continue; }
    const names = (await readdir(root)).sort();
    for (const name of names) {
      if (await exists(join(root, name, 'scene.yaml'))) scenes.push(await loadScene(join(root, name)));
    }
  }
  const seen = new Set<string>();
  for (const scene of scenes) {
    if (seen.has(scene.name)) throw new SceneError(scene.dir, `another scene is also named ${scene.name}`);
    seen.add(scene.name);
  }
  return scenes;
}

export async function loadScene(dir: string): Promise<Scene> {
  const root = resolve(dir);
  const where = join(root, 'scene.yaml');
  let raw: unknown;
  try { raw = parse(await readFile(where, 'utf8'), { merge: true }); } catch (error) {
    throw new SceneError(where, `cannot be read as YAML (${(error as Error).message.split('\n')[0]})`);
  }
  const scene = object(raw ?? {}, where);
  onlyKeys(scene, where, TOP_KEYS);
  const at = (key: string) => `${where} ${key}`;
  if (scene.event === undefined) throw new SceneError(at('event'), 'is required');
  const base = layer(scene, root, where);
  const requires = list(scene.requires ?? [], at('requires')).map((feature, index) => {
    if (!FEATURES.includes(feature as Feature)) throw new SceneError(at(`requires[${index}]`), `must be one of ${FEATURES.join(', ')}`);
    return feature as Feature;
  });
  if (scene.variants !== undefined && scene.axes !== undefined) throw new SceneError(at('variants'), 'cannot be given with axes');
  const axesRaw = scene.variants !== undefined ? { variant: scene.variants } : scene.axes ?? {};
  const axes = Object.entries(object(axesRaw, at('axes'))).map(([name, values]) => ({
    name,
    values: Object.entries(object(values, at(`axes.${name}`))).map(([value, content]) => {
      const path = `${at(scene.variants !== undefined ? 'variants' : `axes.${name}`)}.${value}`;
      const fields = object(content ?? {}, path);
      onlyKeys(fields, path, LAYER_KEYS);
      return { name: value, layer: layer(fields, root, path) };
    }),
  }));
  for (const axis of axes) if (axis.values.length === 0) throw new SceneError(at(`axes.${axis.name}`), 'must name at least one value');
  const context = object(scene.context ?? {}, at('context'));
  onlyKeys(context, at('context'), ['session', 'prelude', 'padding']);
  const padding = context.padding === undefined ? undefined : (() => {
    const fields = object(context.padding, at('context.padding'));
    onlyKeys(fields, at('context.padding'), ['turns', 'chars']);
    return { turns: count(fields.turns, at('context.padding.turns'), 1), chars: count(fields.chars ?? 2000, at('context.padding.chars'), 1) };
  })();
  const limits = object(scene.limits ?? {}, at('limits'));
  onlyKeys(limits, at('limits'), ['modelCalls', 'minutes']);
  const time = scene.time === undefined ? undefined : Date.parse(text(scene.time, at('time')));
  if (time !== undefined && Number.isNaN(time)) throw new SceneError(at('time'), 'must be an ISO 8601 time');
  const module = await exists(join(root, 'scene.ts')) ? join(root, 'scene.ts') : undefined;
  const start = scene.start === undefined ? undefined : (() => {
    const fields = object(scene.start, at('start'));
    onlyKeys(fields, at('start'), ['snapshot']);
    return { snapshot: text(fields.snapshot, at('start.snapshot')) };
  })();
  if (start && context.session !== undefined) throw new SceneError(at('context.session'), 'cannot be given when the scene starts from a snapshot');
  const follow = scene.follow === undefined ? undefined : scene.follow === true ? { maxTurns: DEFAULT_MAX_TURNS } : (() => {
    const fields = object(scene.follow, at('follow'));
    onlyKeys(fields, at('follow'), ['maxTurns']);
    return { maxTurns: fields.maxTurns === undefined ? DEFAULT_MAX_TURNS : count(fields.maxTurns, at('follow.maxTurns'), 1) };
  })();
  const actors = actorsOf(scene.actors ?? {}, at('actors'));
  return {
    name: basename(root), dir: root,
    description: scene.description === undefined ? '' : text(scene.description, at('description')),
    requires,
    runs: scene.runs === undefined ? DEFAULT_RUNS : count(scene.runs, at('runs'), 1),
    time,
    timeZone: scene.timeZone === undefined ? 'Asia/Tokyo' : text(scene.timeZone, at('timeZone')),
    limits: {
      ...(limits.modelCalls === undefined ? {} : { modelCalls: count(limits.modelCalls, at('limits.modelCalls'), 1) }),
      ...(limits.minutes === undefined ? {} : { minutes: count(limits.minutes, at('limits.minutes'), 1) }),
    },
    dove: DOVE in actors || (scene.dove === undefined ? false : bool(scene.dove, at('dove'))),
    context: {
      ...(context.session === undefined ? {} : { session: resolve(root, text(context.session, at('context.session'))) }),
      prelude: list(context.prelude ?? [], at('context.prelude')).map((turn, index) => {
        const path = at(`context.prelude[${index}]`);
        const fields = object(turn, path);
        onlyKeys(fields, path, ['event', 'calls']);
        return { event: event(fields.event, `${path}.event`), calls: steps(fields.calls ?? [], `${path}.calls`) };
      }),
      ...(padding ? { padding } : {}),
    },
    ...(start ? { start } : {}),
    ...(follow ? { follow } : {}),
    actors,
    ...(scene.setup === undefined ? {} : { setup: text(scene.setup, at('setup')) }),
    dryRun: parseScript(scene.dryRun ?? [], at('dryRun')),
    ...(module ? { module } : {}),
    base: { event: base.event!, files: base.files ?? {}, copies: base.copies ?? {}, edits: base.edits ?? [], prompt: base.prompt ?? [],
      checks: base.checks ?? [] },
    axes,
  };
}

/** Every variant of the scene: the product of its axes, each value laid over the scene in the order of the axes. */
export function conditions(scene: Scene): Condition[] {
  let all: { variant: string[]; layers: Layer[] }[] = [{ variant: [], layers: [] }];
  for (const axis of scene.axes) {
    all = all.flatMap(partial => axis.values.map(value => ({ variant: [...partial.variant, value.name], layers: [...partial.layers, value.layer] })));
  }
  return all.map(({ variant, layers }) => {
    const condition: Condition = { ...structuredClone({ ...scene.base }), scene, variant: variant.length > 0 ? variant.join('/') : 'base' };
    for (const over of layers) {
      if (over.event) condition.event = over.event;
      Object.assign(condition.files, over.files ?? {});
      Object.assign(condition.copies, over.copies ?? {});
      condition.edits.push(...over.edits ?? []);
      condition.prompt.push(...over.prompt ?? []);
      for (const check of over.checks ?? []) {
        const index = condition.checks.findIndex(existing => existing.id === check.id);
        if (index >= 0) condition.checks[index] = check; else condition.checks.push(check);
      }
    }
    return condition;
  });
}

/** One check, as written: an id and exactly one kind, with the bounds that kind takes. */
export function parseCheck(raw: unknown, where: string): Check {
  const fields = object(raw, where);
  const id = text(fields.id, `${where}.id`);
  const kinds = [...RULES, 'rubric', 'function'].filter(kind => fields[kind] !== undefined);
  if (kinds.length !== 1) throw new SceneError(where, `must have exactly one of ${[...RULES, 'rubric', 'function'].join(', ')}`);
  const kind = kinds[0]!;
  const allowed = ['id', kind, ...(COUNTED.has(kind) ? ['min', 'max'] : []), ...(kind === 'called' ? ['args'] : [])];
  onlyKeys(fields, where, allowed);
  const spec: Record<string, unknown> = { ...fields };
  delete spec.id;
  const value = fields[kind];
  const at = `${where}.${kind}`;
  switch (kind) {
    case 'called': case 'notCalled': case 'read': case 'notRead': case 'output': case 'rubric': case 'function':
      text(value, at); break;
    case 'shell': case 'reply': regex(value, at); break;
    case 'finished': if (value !== true) throw new SceneError(at, 'must be true'); break;
    case 'modelCalls': {
      const bounds = object(value, at);
      onlyKeys(bounds, at, ['min', 'max']);
      for (const key of Object.keys(bounds)) count(bounds[key], `${at}.${key}`, 0);
      break;
    }
    case 'asked': {
      const asked = object(value, at);
      onlyKeys(asked, at, ['agent', 'message', 'to']);
      if (asked.agent !== undefined) text(asked.agent, `${at}.agent`);
      if (asked.message !== undefined) regex(asked.message, `${at}.message`);
      if (asked.to !== undefined) {
        const to = object(asked.to, `${at}.to`);
        onlyKeys(to, `${at}.to`, ['file', 'path']);
        text(to.file, `${at}.to.file`);
        if (to.path !== undefined) text(to.path, `${at}.to.path`);
      }
      break;
    }
  }
  for (const bound of ['min', 'max']) if (fields[bound] !== undefined) count(fields[bound], `${where}.${bound}`, 0);
  if (fields.args !== undefined) {
    const args = object(fields.args, `${where}.args`);
    for (const [key, pattern] of Object.entries(args)) regex(pattern, `${where}.args.${key}`);
  }
  return { id, by: kind === 'rubric' ? 'llm' : kind === 'function' ? 'function' : 'rule', spec };
}

function layer(fields: Raw, root: string, where: string): Layer {
  const at = (key: string) => `${where} ${key}`;
  const result: Layer = {};
  if (fields.event !== undefined) result.event = event(fields.event, at('event'));
  if (fields.files !== undefined) {
    result.files = {};
    for (const [path, content] of Object.entries(object(fields.files, at('files')))) {
      place(path, at(`files.${path}`), false);
      if (typeof content === 'string') { result.files[path] = { text: content }; continue; }
      const source = object(content, at(`files.${path}`));
      onlyKeys(source, at(`files.${path}`), ['file']);
      result.files[path] = { file: resolve(root, text(source.file, at(`files.${path}.file`))) };
    }
  }
  if (fields.copy !== undefined) {
    result.copies = {};
    for (const [path, from] of Object.entries(object(fields.copy, at('copy')))) {
      place(path, at(`copy.${path}`), true);
      result.copies[path] = resolve(root, text(from, at(`copy.${path}`)));
    }
  }
  if (fields.edits !== undefined) {
    result.edits = list(fields.edits, at('edits')).map((edit, index) => {
      const path = at(`edits[${index}]`);
      const entry = object(edit, path);
      onlyKeys(entry, path, ['path', 'replace', 'with']);
      const file = text(entry.path, `${path}.path`);
      place(file, `${path}.path`, false);
      return { path: file, replace: nonEmpty(entry.replace, `${path}.replace`), with: stringValue(entry.with, `${path}.with`) };
    });
  }
  if (fields.prompt !== undefined) {
    result.prompt = list(fields.prompt, at('prompt')).map((edit, index) => {
      const path = at(`prompt[${index}]`);
      const entry = object(edit, path);
      onlyKeys(entry, path, ['replace', 'with']);
      return { replace: nonEmpty(entry.replace, `${path}.replace`), with: stringValue(entry.with, `${path}.with`) };
    });
  }
  if (fields.checks !== undefined) {
    const checks = list(fields.checks, at('checks')).map((check, index) => parseCheck(check, at(`checks[${index}]`)));
    const ids = new Set<string>();
    for (const check of checks) {
      if (ids.has(check.id)) throw new SceneError(at('checks'), `the id ${check.id} is used twice`);
      ids.add(check.id);
    }
    result.checks = checks;
  }
  return result;
}

function actorsOf(raw: unknown, where: string): Record<string, Actor> {
  const actors: Record<string, Actor> = {};
  for (const [name, value] of Object.entries(object(raw, where))) {
    const path = `${where}.${name}`;
    if (!AGENT_NAME.test(name)) throw new SceneError(path, 'is not an agent name (lower case letters, digits and hyphens)');
    const fields = object(value ?? {}, path);
    const dove = name === DOVE;
    onlyKeys(fields, path, dove ? ['instructions', 'replies'] : ['card', 'instructions', 'replies']);
    const replies = list(fields.replies ?? [], `${path}.replies`).map((reply, index): ActorReply => {
      const at = `${path}.replies[${index}]`;
      if (typeof reply === 'string') return dove ? { text: nonEmpty(reply, at), result: 'sent' } : { text: nonEmpty(reply, at) };
      if (!dove) throw new SceneError(at, 'must be the text of the reply');
      const entry = object(reply, at);
      onlyKeys(entry, at, ['result', 'text']);
      const result = entry.result === undefined ? 'sent' : text(entry.result, `${at}.result`);
      if (!DOVE_RESULTS.includes(result as DoveResult)) throw new SceneError(`${at}.result`, `must be one of ${DOVE_RESULTS.join(', ')}`);
      return { text: nonEmpty(entry.text, `${at}.text`), result: result as DoveResult };
    });
    actors[name] = {
      name,
      card: dove ? '' : fields.card === undefined ? DEFAULT_CARD : text(fields.card, `${path}.card`),
      ...(fields.instructions === undefined ? {} : { instructions: text(fields.instructions, `${path}.instructions`) }),
      replies,
    };
  }
  return actors;
}

function event(raw: unknown, where: string): SceneEvent {
  const fields = object(raw, where);
  const kinds = ['mac_message', 'ping', 'line'].filter(kind => fields[kind] !== undefined);
  if (kinds.length !== 1 || Object.keys(fields).length !== 1) throw new SceneError(where, 'must be exactly one of mac_message, ping, line');
  if (fields.mac_message !== undefined) return { kind: 'mac_message', text: nonEmpty(fields.mac_message, `${where}.mac_message`) };
  if (fields.ping !== undefined) { object(fields.ping, `${where}.ping`); return { kind: 'ping' }; }
  const line = object(fields.line, `${where}.line`);
  text(line.type, `${where}.line.type`);
  return { kind: 'line', line };
}

/** The answers a scripted model gives in turn, as a scene's `dryRun` writes them; also the curator's script (ADR 0068). */
export function parseScript(raw: unknown, where: string): ScriptedAnswer[] {
  return list(raw, where).map((answer, index) => {
    const path = `${where}[${index}]`;
    const fields = object(answer, path);
    onlyKeys(fields, path, ['thinking', 'text', 'calls']);
    return { ...(fields.thinking === undefined ? {} : { thinking: text(fields.thinking, `${path}.thinking`) }),
      ...(fields.text === undefined ? {} : { text: text(fields.text, `${path}.text`) }),
      calls: steps(fields.calls ?? [], `${path}.calls`) };
  });
}

function steps(raw: unknown, where: string): ToolStep[] {
  return list(raw, where).map((step, index) => {
    const path = `${where}[${index}]`;
    const fields = object(step, path);
    onlyKeys(fields, path, ['tool', 'args']);
    return { tool: text(fields.tool, `${path}.tool`), args: object(fields.args ?? {}, `${path}.args`) };
  });
}

/** A path under one of the places a scene may write; `whole` allows the place itself. */
function place(path: string, where: string, whole: boolean) {
  const ok = PLACES.some(root => path.startsWith(`${root}/`) || (whole && path === root));
  if (!ok || path.split('/').includes('..')) throw new SceneError(where, `must be under ${PLACES.join(', ')}`);
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

function object(value: unknown, where: string): Raw {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SceneError(where, 'must be a mapping');
  return value as Raw;
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new SceneError(where, 'must be a list');
  return value;
}

function onlyKeys(value: Raw, where: string, keys: string[]) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new SceneError(where, `unknown key ${key}`);
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '') throw new SceneError(where, 'must be a non-empty string');
  return value;
}

const nonEmpty = text;

function stringValue(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new SceneError(where, 'must be a string');
  return value;
}

function bool(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') throw new SceneError(where, 'must be true or false');
  return value;
}

function count(value: unknown, where: string, least: number): number {
  if (!Number.isInteger(value) || (value as number) < least) throw new SceneError(where, `must be an integer of at least ${least}`);
  return value as number;
}

function regex(value: unknown, where: string): string {
  const pattern = text(value, where);
  try { new RegExp(pattern, 'u'); } catch { throw new SceneError(where, 'is not a valid regular expression'); }
  return pattern;
}
