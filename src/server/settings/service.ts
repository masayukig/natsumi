import {
  checkSetting, isSettingKey, JUDGE_SETTINGS, type AwakeHours, type CuratorNight, type Fold, type JudgeName, type JudgeThresholds, type RouteView, type SettingItem,
  type SettingKey, type SettingsView, type SettingValues, type TurnLimits,
} from '../../shared/protocol/settings.ts';
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

/** The list and the routes as the devices are shown them; their shapes are the contract's, shared with the browser's app. */
export type { RouteView, SettingsView } from '../../shared/protocol/settings.ts';

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

/**
 * The config's values of the settings, the time zone the awake hours are in, which of the dove's judges the config
 * has an endpoint for (ADR 0059), and which routes are reached through an outside service (ADR 0068). The route's is
 * the loop's default.
 */
type Configured = Omit<SettingValues, 'modelRoute'>;
export type SettingsDefaults = Configured & { timeZone: string; judgeAvailable: Record<JudgeName, boolean>; outsideRoutes: string[] };

/** The dove's judges as they are in force: on only when turned on and there is an endpoint to ask (ADR 0059). */
export interface JudgesInForce { logprobs: boolean; jev: boolean; adopted: JudgeName; thresholds: Record<JudgeName, JudgeThresholds> }

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

  /**
   * Reads the overrides on file. What breaks the rules is left out, and logged. The loop is not asked anything yet, so
   * the settings may be opened before it, and the loop's first turn already reads the overrides.
   */
  static async open(options: RuntimeSettingsOptions): Promise<RuntimeSettings> {
    const settings = new RuntimeSettings(options);
    await settings.load();
    return settings;
  }

  /** The first listener takes the list as it is then as the one already told. */
  subscribe(listener: (event: SettingsEvent) => void): () => void {
    if (this.published === '') this.published = JSON.stringify(this.view());
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  view(): SettingsView {
    const { defaults, routes } = this.options;
    const status = routes.routeStatus();
    const o = this.overrides;
    const configured: Configured = defaults;
    const item = <K extends keyof Configured>(key: K): SettingItem<Configured[K]> => {
      const config = configured[key];
      // The curator's route may be overridden with null, for natsumi's: an override is one that is there at all.
      return { value: o[key] !== undefined ? o[key] as Configured[K] : config, config, overridden: o[key] !== undefined };
    };
    const curatorRoute = this.curatorRoute();
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
      judgeLogprobs: { ...item('judgeLogprobs'), available: defaults.judgeAvailable.logprobs },
      judgeJev: { ...item('judgeJev'), available: defaults.judgeAvailable.jev },
      judgeAdopted: item('judgeAdopted'),
      judgeLogprobsThresholds: item('judgeLogprobsThresholds'),
      judgeJevThresholds: item('judgeJevThresholds'),
      curatorRoute: { value: curatorRoute, config: defaults.curatorRoute, overridden: o.curatorRoute !== undefined,
        night: curatorRoute ?? status.chosen, outside: [...defaults.outsideRoutes] },
      curatorModelCalls: item('curatorModelCalls'),
      curatorTimeoutMinutes: item('curatorTimeoutMinutes'),
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
      // A judge with no endpoint in the config has nothing to ask: the settings cannot add one (ADR 0059).
      const judge = (Object.keys(JUDGE_SETTINGS) as JudgeName[]).find(name => JUDGE_SETTINGS[name] === checked.key);
      if (judge && checked.value === 'on' && !this.options.defaults.judgeAvailable[judge]) return { kind: 'rejected', code: 'judge-unavailable' };
      if (checked.key === 'curatorRoute' && checked.value !== null) {
        // The curator's route is the owner's choice of the config's routes, as natsumi's is; it is not moved to until the night.
        const route = this.options.routes.routeStatus().routes.find(candidate => candidate.name === checked.value);
        if (!route) return { kind: 'rejected', code: 'unknown-route' };
        if (!route.ready) return { kind: 'rejected', code: 'route-unavailable' };
      }
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

  /** Which of the dove's judges it asks for the next draft, and which one decides (ADR 0059). */
  judges(): JudgesInForce {
    const { judgeLogprobs, judgeJev, judgeAdopted, judgeLogprobsThresholds, judgeJevThresholds } = this.inForce();
    const { judgeAvailable } = this.options.defaults;
    return { logprobs: judgeLogprobs === 'on' && judgeAvailable.logprobs, jev: judgeJev === 'on' && judgeAvailable.jev, adopted: judgeAdopted,
      thresholds: { logprobs: { ...judgeLogprobsThresholds }, jev: { ...judgeJevThresholds } } };
  }

  /** What the next night of the curator runs on and with (ADR 0068); its route null for the one natsumi is on then. */
  curator(): CuratorNight {
    const { curatorModelCalls, curatorTimeoutMinutes } = this.inForce();
    return { route: this.curatorRoute(), modelCalls: curatorModelCalls, timeoutMinutes: curatorTimeoutMinutes };
  }

  /**
   * The curator's route in force: the override, else the config's. An override naming a route the config no longer has
   * is passed over for the config's, as a route on file the config lost is for natsumi's (ADR 0046).
   */
  private curatorRoute(): string | null {
    const known = (name: string | null | undefined) =>
      name === null || (name !== undefined && this.options.routes.routeStatus().routes.some(route => route.name === name));
    const chosen = this.overrides.curatorRoute;
    if (chosen !== undefined && known(chosen)) return chosen;
    return known(this.options.defaults.curatorRoute) ? this.options.defaults.curatorRoute : null;
  }

  private inForce(): Omit<Configured, 'turnFold' | 'curatorRoute'> {
    const { defaults } = this.options;
    const o = this.overrides;
    return {
      judgeLogprobs: o.judgeLogprobs ?? defaults.judgeLogprobs, judgeJev: o.judgeJev ?? defaults.judgeJev,
      judgeAdopted: o.judgeAdopted ?? defaults.judgeAdopted,
      judgeLogprobsThresholds: o.judgeLogprobsThresholds ?? defaults.judgeLogprobsThresholds,
      judgeJevThresholds: o.judgeJevThresholds ?? defaults.judgeJevThresholds,
      eventModelCalls: o.eventModelCalls ?? defaults.eventModelCalls, eventTimeoutMinutes: o.eventTimeoutMinutes ?? defaults.eventTimeoutMinutes,
      reviewModelCalls: o.reviewModelCalls ?? defaults.reviewModelCalls, reviewTimeoutMinutes: o.reviewTimeoutMinutes ?? defaults.reviewTimeoutMinutes,
      awakeHours: o.awakeHours ?? defaults.awakeHours, pingIntervalMinutes: o.pingIntervalMinutes ?? defaults.pingIntervalMinutes,
      curatorModelCalls: o.curatorModelCalls ?? defaults.curatorModelCalls,
      curatorTimeoutMinutes: o.curatorTimeoutMinutes ?? defaults.curatorTimeoutMinutes,
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
    if (this.listeners.size === 0) return;
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
