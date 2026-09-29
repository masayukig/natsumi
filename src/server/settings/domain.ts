/**
 * The settings the owner may change while natsumi runs (ADR 0058): their names, the shapes of their values and the
 * rules those keep. The config's parser takes its rules from here too, so a value the settings take is one the config
 * would take, and the other way round.
 *
 * This is the lowest layer of the runtime settings. It imports nothing, not even Node, and keeps no state; the test
 * of the layers holds it to that.
 */

export const SETTING_KEYS = ['modelRoute', 'turnFold', 'eventModelCalls', 'eventTimeoutMinutes', 'reviewModelCalls',
  'reviewTimeoutMinutes', 'awakeHours', 'pingIntervalMinutes'] as const;

export type SettingKey = typeof SETTING_KEYS[number];

export type Fold = 'on' | 'off';
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
}

/** A route as the owner is shown it (ADR 0046): never its endpoint or its key. */
export interface RouteView { name: string; provider: string; model: string; ready: boolean }

/** One setting in the list: the value in force, the config's, and whether it is overridden. */
export interface SettingItem<T> { value: T; config: T; overridden: boolean }

/**
 * The list as every device is shown it (docs/client-contract.md, 実行中の設定). It is here, with the values' shapes,
 * so that the browser's app is written against the same type as the server without taking any of its code.
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
}

/** The limits of one turn, as the thinking loop reads them before it starts one. */
export type TurnLimits = Pick<SettingValues, 'eventModelCalls' | 'eventTimeoutMinutes' | 'reviewModelCalls' | 'reviewTimeoutMinutes'>;

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
    case 'turnFold':
      return isFold(value) ? { ok: true, key, value } : invalid;
    case 'eventModelCalls': case 'eventTimeoutMinutes': case 'reviewModelCalls': case 'reviewTimeoutMinutes':
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
