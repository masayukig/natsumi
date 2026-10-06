/**
 * The settings the owner may change while natsumi runs (ADR 0058): their names, the shapes of their values and the
 * rules those keep. The config's parser takes its rules from here too, so a value the settings take is one the config
 * would take, and the other way round.
 *
 * It is part of the contract the server and the browser's app share (src/shared/protocol/): the server's settings
 * layers are built on it, and the browser checks a value with the same rules before sending it. It imports nothing,
 * not even Node, and keeps no state; the test of the layers holds it to that.
 */

export const SETTING_KEYS = ['modelRoute', 'turnFold', 'eventModelCalls', 'eventTimeoutMinutes', 'reviewModelCalls',
  'reviewTimeoutMinutes', 'awakeHours', 'pingIntervalMinutes', 'judgeLogprobs', 'judgeJev', 'judgeAdopted', 'judgeLogprobsThresholds', 'judgeJevThresholds',
  'curatorRoute', 'curatorModelCalls', 'curatorTimeoutMinutes'] as const;

export type SettingKey = typeof SETTING_KEYS[number];

export type Fold = 'on' | 'off';
/** The dove's two judges (ADR 0059). */
export type JudgeName = 'logprobs' | 'jev';
/** A judge's thresholds: at or over `owner` the draft goes to the owner, at or over `return` back to natsumi. */
export interface JudgeThresholds { owner: number; return: number }
export interface AwakeHours { start: string; end: string }

/** A value of each setting, as it is kept and shown. */
export interface SettingValues {
  /** The model route (ADR 0046): one of the config's by name. */
  modelRoute: string;
  /** Whether ended turns are folded (ADR 0047). */
  turnFold: Fold;
  eventModelCalls: number;
  eventTimeoutMinutes: number;
  reviewModelCalls: number;
  reviewTimeoutMinutes: number;
  /** Local hours natsumi is up, in the config's time zone (ADR 0014). */
  awakeHours: AwakeHours;
  /** Quiet minutes before a ping, or false for none. */
  pingIntervalMinutes: number | false;
  /** Whether the dove's logprobs judge is asked (ADR 0059). */
  judgeLogprobs: Fold;
  /** Whether the dove's Jev judge is asked (ADR 0059). */
  judgeJev: Fold;
  /** The judge whose verdict decides while it has one (ADR 0059). */
  judgeAdopted: JudgeName;
  /** Each judge's thresholds (ADR 0059). */
  judgeLogprobsThresholds: JudgeThresholds;
  judgeJevThresholds: JudgeThresholds;
  /** The memory curator's route (ADR 0068): one of the config's by name, or null for the route natsumi is on. */
  curatorRoute: string | null;
  /** Model calls and minutes each stage of the curator's night may take (ADR 0068). */
  curatorModelCalls: number;
  curatorTimeoutMinutes: number;
}

/** A route as the owner is shown it (ADR 0046): never its endpoint or its key. */
export interface RouteView { name: string; provider: string; model: string; ready: boolean }

/** One setting in the list: the value in force, the config's, and whether it is overridden. */
export interface SettingItem<T> { value: T; config: T; overridden: boolean }

/**
 * The list as every device is shown it (docs/client-contract.md, 実行中の設定).
 */
export interface SettingsView {
  modelRoute: SettingItem<string> & { inUse: string | null; routes: RouteView[] };
  turnFold: SettingItem<Fold> & { inUse: Fold };
  eventModelCalls: SettingItem<number>;
  eventTimeoutMinutes: SettingItem<number>;
  reviewModelCalls: SettingItem<number>;
  reviewTimeoutMinutes: SettingItem<number>;
  awakeHours: SettingItem<AwakeHours> & { timeZone: string };
  pingIntervalMinutes: SettingItem<number | false>;
  /** `available`: whether the config has an endpoint for the judge; without one it cannot be turned on. */
  judgeLogprobs: SettingItem<Fold> & { available: boolean };
  judgeJev: SettingItem<Fold> & { available: boolean };
  judgeAdopted: SettingItem<JudgeName>;
  judgeLogprobsThresholds: SettingItem<JudgeThresholds>;
  judgeJevThresholds: SettingItem<JudgeThresholds>;
  /**
   * `night`: the route the next night runs on, natsumi's chosen one when the curator has none of its own.
   * `outside`: the routes reached through an outside service rather than the owner's own endpoint (ADR 0068): on one
   * of them, memory and the day's conversation leave for that service every night.
   */
  curatorRoute: SettingItem<string | null> & { night: string; outside: string[] };
  curatorModelCalls: SettingItem<number>;
  curatorTimeoutMinutes: SettingItem<number>;
}

/** The limits of one turn, as the thinking loop reads them before it starts one. */
export type TurnLimits = Pick<SettingValues, 'eventModelCalls' | 'eventTimeoutMinutes' | 'reviewModelCalls' | 'reviewTimeoutMinutes'>;

/** The curator's night as the thinking loop reads it before the night starts (ADR 0068): null for natsumi's route. */
export interface CuratorNight { route: string | null; modelCalls: number; timeoutMinutes: number }

export type SettingCheck =
  | { [K in SettingKey]: { ok: true; key: K; value: SettingValues[K] } }[SettingKey]
  | { ok: false; code: 'unknown-setting' | 'invalid-value' };

/** A route's name, as the config gives it: lowercase letters, digits and hyphens, up to 32, not starting with a hyphen. */
export const ROUTE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** The shortest ping interval, so a typo cannot make natsumi think all day. */
export const MIN_PING_INTERVAL_MINUTES = 5;
const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isSettingKey = (key: unknown): key is SettingKey => (SETTING_KEYS as readonly unknown[]).includes(key);
export const isFold = (value: unknown): value is Fold => value === 'on' || value === 'off';
export const isJudgeName = (value: unknown): value is JudgeName => value === 'logprobs' || value === 'jev';
/** The setting that turns each judge on or off. */
export const JUDGE_SETTINGS = { logprobs: 'judgeLogprobs', jev: 'judgeJev' } as const;
/** A threshold as the config takes it: over 0 and at most 1. */
export const isThreshold = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1;

/** Two thresholds, owner not over return, and nothing else, as the config takes them. */
export function thresholdsOf(value: unknown): JudgeThresholds | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const pair = value as Record<string, unknown>;
  if (Object.keys(pair).some(key => key !== 'owner' && key !== 'return')) return undefined;
  if (!isThreshold(pair.owner) || !isThreshold(pair.return) || pair.owner > pair.return) return undefined;
  return { owner: pair.owner, return: pair.return };
}
/** A limit of a turn: calls or minutes, a positive integer. */
export const isTurnLimit = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1;
export const isPingInterval = (value: unknown): value is number | false =>
  value === false || (typeof value === 'number' && Number.isInteger(value) && value >= MIN_PING_INTERVAL_MINUTES);
/** A 24-hour `HH:MM`. */
export const isClockTime = (value: unknown): value is string => typeof value === 'string' && CLOCK_TIME.test(value);

/** What is wrong with awake hours: the part at fault and why, or undefined when nothing is. */
export function awakeHoursProblem(value: unknown):
  { part: 'shape' | 'keys' } | { part: 'start' | 'end'; reason: 'not-a-time' } | { part: 'end'; reason: 'same-as-start' } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { part: 'shape' };
  const hours = value as Record<string, unknown>;
  if (Object.keys(hours).some(key => key !== 'start' && key !== 'end')) return { part: 'keys' };
  if (!isClockTime(hours.start)) return { part: 'start', reason: 'not-a-time' };
  if (!isClockTime(hours.end)) return { part: 'end', reason: 'not-a-time' };
  if (hours.start === hours.end) return { part: 'end', reason: 'same-as-start' };
  return undefined;
}

/**
 * Whether a value may be given to a setting. A route's name is checked for its shape only: which routes there are,
 * and which of them are ready, is known to the service alone.
 */
export function checkSetting(key: string, value: unknown): SettingCheck {
  if (!isSettingKey(key)) return { ok: false, code: 'unknown-setting' };
  const invalid = { ok: false, code: 'invalid-value' } as const;
  switch (key) {
    case 'modelRoute':
      return typeof value === 'string' && ROUTE_NAME.test(value) ? { ok: true, key, value } : invalid;
    case 'turnFold': case 'judgeLogprobs': case 'judgeJev':
      return isFold(value) ? { ok: true, key, value } : invalid;
    case 'judgeAdopted':
      return isJudgeName(value) ? { ok: true, key, value } : invalid;
    case 'judgeLogprobsThresholds': case 'judgeJevThresholds': {
      const thresholds = thresholdsOf(value);
      return thresholds ? { ok: true, key, value: thresholds } : invalid;
    }
    case 'curatorRoute':
      return value === null || (typeof value === 'string' && ROUTE_NAME.test(value)) ? { ok: true, key, value } : invalid;
    case 'eventModelCalls': case 'eventTimeoutMinutes': case 'reviewModelCalls': case 'reviewTimeoutMinutes':
    case 'curatorModelCalls': case 'curatorTimeoutMinutes':
      return isTurnLimit(value) ? { ok: true, key, value } : invalid;
    case 'awakeHours': {
      if (awakeHoursProblem(value)) return invalid;
      const { start, end } = value as AwakeHours;
      return { ok: true, key, value: { start, end } };
    }
    case 'pingIntervalMinutes':
      return isPingInterval(value) ? { ok: true, key, value } : invalid;
  }
}

const isRouteView = (value: unknown): value is RouteView => typeof value === 'object' && value !== null
  && typeof (value as RouteView).name === 'string' && typeof (value as RouteView).provider === 'string'
  && typeof (value as RouteView).model === 'string' && typeof (value as RouteView).ready === 'boolean';

/**
 * The list as it came over the wire, or undefined when it is not the contract's: every setting there, each value and
 * config's value keeping the setting's rules (a route's name its shape), and the extra fields of the six that have them.
 */
export function readSettingsView(value: unknown): SettingsView | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const list = value as Record<string, unknown>;
  const view: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    const item = list[key];
    if (typeof item !== 'object' || item === null) return undefined;
    const { value: current, config, overridden, inUse, routes, timeZone, available, night, outside } = item as Record<string, unknown>;
    const valueCheck = checkSetting(key, current);
    const configCheck = checkSetting(key, config);
    if (!valueCheck.ok || !configCheck.ok || typeof overridden !== 'boolean') return undefined;
    const read: Record<string, unknown> = { value: valueCheck.value, config: configCheck.value, overridden };
    if (key === 'modelRoute') {
      if (!(inUse === null || (typeof inUse === 'string' && ROUTE_NAME.test(inUse)))) return undefined;
      if (!Array.isArray(routes) || !routes.every(isRouteView)) return undefined;
      Object.assign(read, { inUse, routes: routes.map(({ name, provider, model, ready }) => ({ name, provider, model, ready })) });
    } else if (key === 'turnFold') {
      if (!isFold(inUse)) return undefined;
      read.inUse = inUse;
    } else if (key === 'awakeHours') {
      if (typeof timeZone !== 'string') return undefined;
      read.timeZone = timeZone;
    } else if (key === 'curatorRoute') {
      if (typeof night !== 'string' || !ROUTE_NAME.test(night)) return undefined;
      if (!Array.isArray(outside) || !outside.every(name => typeof name === 'string')) return undefined;
      Object.assign(read, { night, outside: [...outside] as string[] });
    } else if (key === 'judgeLogprobs' || key === 'judgeJev') {
      if (typeof available !== 'boolean') return undefined;
      read.available = available;
    }
    view[key] = read;
  }
  return view as unknown as SettingsView;
}
