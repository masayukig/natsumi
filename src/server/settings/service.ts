import { checkSetting, isSettingKey, type AwakeHours, type Fold, type SettingKey, type SettingValues, type TurnLimits } from './domain.ts';
import { clearOverride, readOverrides, writeOverride, type Overrides } from './store.ts';

/**
 * The runtime settings (ADR 0058): what the owner may change while natsumi runs, each an override of the config's
 * value kept in the data directory. This is what the ways in (the WebSocket's `settings.*`) and the loop and the
 * scheduler use: the list with the config's value beside the one in force, a change or a reset, the news of a change
 * for every device, and the values in force now.
 *
 * The loop is reached through `RouteControl` alone, a port this module defines; nothing here imports the loop. The
 * route is the loop's to choose and move to (ADR 0046), so a change of route goes through it. The other settings are
 * read by the loop and the scheduler from here, between turns and on every tick, so a change needs nothing more.
 */

/** A route as the owner is shown it, as the loop reports it (ADR 0046). */
export interface RouteView { name: string; provider: string; model: string; ready: boolean }

/** The loop's side of the route and the fold: what the settings need of it, and nothing more. */
export interface RouteControl {
  /** The code the clients are turned away with while natsumi cannot talk, or undefined. */
  readonly unavailable: string | undefined;
  routeStatus(): { defaultRoute: string; current: string | null; chosen: string; routes: RouteView[] };
  /** Records the choice and moves to it between turns, or says why not. */
  chooseRoute(input: { route: string; deviceId: string }): Promise<{ kind: 'accepted' } | { kind: 'rejected' | 'unavailable'; code: string }>;
  /** Looks again at the choice on file; a cleared choice is the default route. */
  refreshRoutes(): Promise<void>;
  /** The fold the turns are folded with now, which follows the choice before each turn (ADR 0047). */
  foldInUse(): Fold;
}

/** The config's values of the settings, and the time zone the awake hours are in. The route's is the loop's default. */
type Configured = Omit<SettingValues, 'modelRoute'>;
export type SettingsDefaults = Configured & { timeZone: string };

interface Item<T> { value: T; config: T; overridden: boolean }

/** The list as every device is shown it: for each setting, the value in force, the config's, and whether it is overridden. */
export interface SettingsView {
  modelRoute: Item<string> & { inUse: string | null; routes: RouteView[] };
  turnFold: Item<Fold> & { inUse: Fold };
  eventModelCalls: Item<number>;
  eventTimeoutMinutes: Item<number>;
  reviewModelCalls: Item<number>;
  reviewTimeoutMinutes: Item<number>;
  awakeHours: Item<AwakeHours> & { timeZone: string };
  pingIntervalMinutes: Item<number | false>;
}

export type SettingsOutcome =
  | { kind: 'accepted'; settings: SettingsView }
  | { kind: 'rejected'; code: string }
  | { kind: 'unavailable'; code: string };

export type SettingsEvent = { type: 'settings.changed'; payload: { settings: SettingsView } };

export interface RuntimeSettingsOptions {
  dataDirectory: string;
  defaults: SettingsDefaults;
  routes: RouteControl;
  now: () => number;
  log: (line: string) => void;
}

export class RuntimeSettings {
  private readonly options: RuntimeSettingsOptions;
  private overrides: Overrides = {};
  private readonly listeners = new Set<(event: SettingsEvent) => void>();
  /** The list as last told, so a refresh that changed nothing tells nothing. */
  private published = '';
  /** The names last found broken on file, so the log says so once until they change. */
  private ignored = '';
  /** Changes, one after the other: two devices at once must not lose either's. */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(options: RuntimeSettingsOptions) {
    this.options = options;
  }

  /** Reads the overrides on file. What breaks the rules is left out, and logged. */
  static async open(options: RuntimeSettingsOptions): Promise<RuntimeSettings> {
    const settings = new RuntimeSettings(options);
    await settings.load();
    settings.published = JSON.stringify(settings.view());
    return settings;
  }

  subscribe(listener: (event: SettingsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  view(): SettingsView {
    const { defaults, routes } = this.options;
    const status = routes.routeStatus();
    const o = this.overrides;
    const configured: Configured = defaults;
    const item = <K extends keyof Configured>(key: K): Item<Configured[K]> => {
      const config = configured[key];
      return { value: o[key] ?? config, config, overridden: o[key] !== undefined };
    };
    return {
      modelRoute: { value: status.chosen, config: status.defaultRoute, overridden: o.modelRoute !== undefined, inUse: status.current,
        routes: status.routes.map(({ name, provider, model, ready }) => ({ name, provider, model, ready })) },
      turnFold: { ...item('turnFold'), inUse: routes.foldInUse() },
      eventModelCalls: item('eventModelCalls'),
      eventTimeoutMinutes: item('eventTimeoutMinutes'),
      reviewModelCalls: item('reviewModelCalls'),
      reviewTimeoutMinutes: item('reviewTimeoutMinutes'),
      awakeHours: { ...item('awakeHours'), timeZone: defaults.timeZone },
      pingIntervalMinutes: item('pingIntervalMinutes'),
    };
  }

  /** `settings.list`. */
  list(): SettingsOutcome {
    const unavailable = this.options.routes.unavailable;
    return unavailable ? { kind: 'unavailable', code: unavailable } : { kind: 'accepted', settings: this.view() };
  }

  /** `settings.set`: an override for one setting, checked by the config's rules. It is in force from the next turn or tick. */
  set(input: { key: string; value: unknown; deviceId: string }): Promise<SettingsOutcome> {
    return this.serialize(async () => {
      const unavailable = this.options.routes.unavailable;
      if (unavailable) return { kind: 'unavailable', code: unavailable };
      const checked = checkSetting(input.key, input.value);
      if (!checked.ok) return { kind: 'rejected', code: checked.code };
      if (checked.key === 'modelRoute') {
        const chosen = await this.options.routes.chooseRoute({ route: checked.value, deviceId: input.deviceId });
        if (chosen.kind !== 'accepted') return chosen;
      } else {
        await writeOverride(this.options.dataDirectory, checked.key, checked.value, this.options.now());
      }
      return this.changed();
    });
  }

  /** `settings.reset`: takes the override of one setting away, so the config's value is in force again. */
  reset(input: { key: string; deviceId: string }): Promise<SettingsOutcome> {
    return this.serialize(async () => {
      const unavailable = this.options.routes.unavailable;
      if (unavailable) return { kind: 'unavailable', code: unavailable };
      if (!isSettingKey(input.key)) return { kind: 'rejected', code: 'unknown-setting' };
      await clearOverride(this.options.dataDirectory, input.key, this.options.now());
      if (input.key === 'modelRoute') await this.options.routes.refreshRoutes();
      return this.changed();
    });
  }

  /**
   * Reads the overrides on file again and tells every device if the list changed: the command line may have written
   * the route or the fold, and the loop may have moved to another route. Runs with the heartbeat and after a move.
   */
  refresh(): Promise<void> {
    return this.serialize(async () => { await this.load(); this.publish(); });
  }

  turnLimits(): TurnLimits {
    const { eventModelCalls, eventTimeoutMinutes, reviewModelCalls, reviewTimeoutMinutes } = this.inForce();
    return { eventModelCalls, eventTimeoutMinutes, reviewModelCalls, reviewTimeoutMinutes };
  }

  awakeHours(): AwakeHours { return { ...this.inForce().awakeHours }; }

  pingIntervalMinutes(): number | false { return this.inForce().pingIntervalMinutes; }

  private inForce(): Omit<Configured, 'turnFold'> {
    const { defaults } = this.options;
    const o = this.overrides;
    return {
      eventModelCalls: o.eventModelCalls ?? defaults.eventModelCalls, eventTimeoutMinutes: o.eventTimeoutMinutes ?? defaults.eventTimeoutMinutes,
      reviewModelCalls: o.reviewModelCalls ?? defaults.reviewModelCalls, reviewTimeoutMinutes: o.reviewTimeoutMinutes ?? defaults.reviewTimeoutMinutes,
      awakeHours: o.awakeHours ?? defaults.awakeHours, pingIntervalMinutes: o.pingIntervalMinutes ?? defaults.pingIntervalMinutes,
    };
  }

  private async changed(): Promise<SettingsOutcome> {
    await this.load();
    this.publish();
    return { kind: 'accepted', settings: this.view() };
  }

  private async load() {
    const { values, ignored } = await readOverrides(this.options.dataDirectory);
    this.overrides = values;
    const names = ignored.join(', ');
    if (names !== this.ignored && names) this.options.log(`settings: left out what breaks the rules or is no setting: ${names}`);
    this.ignored = names;
  }

  private publish() {
    const settings = this.view();
    const text = JSON.stringify(settings);
    if (text === this.published) return;
    this.published = text;
    for (const listener of this.listeners) listener({ type: 'settings.changed', payload: { settings } });
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
}
