import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { COMPATIBLE_MAX_TOKENS, COMPATIBLE_PROVIDER, DEFAULT_CONTEXT_WINDOW, PI_CONTEXT_SAFETY_TOKENS } from '../pi/compatible.ts';
import { isLoopbackHost } from '../pi/loopback.ts';
// The only thing this file takes from the server modules above it is their `DEFAULT_*` constants, for LOOP_DEFAULTS below.
// Applying a default is this parser's job alone: nothing downstream falls back again (see LoopOptions.loop).
import { DEFAULT_ALWAYS_MAX_CHARS, DEFAULT_FILE_MAX_CHARS } from './memory-repository.ts';
import { DEFAULT_SHELL_WAIT_SECONDS } from './workspace-shell.ts';
import { DEFAULT_SIZE_WARN_BYTES } from './workspace-size.ts';
import { isValidTimeZone, TIME_OF_DAY } from './nightly.ts';
import { DEFAULT_AWAKE_HOURS, DEFAULT_EXPRESSION_RESET_MINUTES, DEFAULT_PING_INTERVAL_MINUTES, DEFAULT_SELF_CHECK_LIMITS,
  type AwakeHours, type SelfCheckLimits } from './scheduler.ts';

/** A startup-stopping config problem. `path` names the setting (for example `pi.authPath`); values are never echoed. */
export class ConfigError extends Error {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = 'ConfigError';
    this.path = path;
  }
}

export interface PiConfig {
  agentDirectory: string;
  sessionDirectory: string;
  authPath: string;
  /**
   * The model routes the owner may choose between, in the config's order (ADR 0046). A config with only `pi.model` is
   * one route named `default`. Every route is chosen by hand; none is ever tried in place of another (ADR 0004).
   */
  routes: ModelRoute[];
  /** The route used until the owner chooses another, and the one the dove's judge borrows from (ADR 0040). */
  defaultRoute: string;
  /** Whether the model thinks before it acts. On by default (ADR 0008). */
  thinking: 'on' | 'off';
  /** Voice is unsupported until its method and billing terms are verified (ADR 0004). */
  voiceEnabled: false;
}

/** One named way to a model: the model in Pi, its endpoint when it is the owner's own, and when to compact on it. */
export interface ModelRoute {
  name: string;
  model: { provider: string; id: string };
  /** Present only for a `natsumi-compatible` provider. Without it the OAuth login at `authPath` is the only way in. */
  compatible?: CompatibleConfig;
  /** Past this many context tokens the session is compacted between turns: the route's own, or `loop.compactionThreshold`. */
  compactionThreshold: number;
}

/** The name a config with only `pi.model` gives its one route. */
export const SINGLE_ROUTE_NAME = 'default';

export function defaultRoute(pi: PiConfig): ModelRoute {
  return pi.routes.find(route => route.name === pi.defaultRoute)!;
}

/** An OpenAI-compatible Chat Completions endpoint the owner runs (ADR 0004). */
export interface CompatibleConfig {
  baseUrl: string;
  apiKey: SecretReference;
  /** The context window Pi measures the model against. The endpoint's own may be larger; this is what Pi may use. */
  contextWindow: number;
}

export { COMPATIBLE_PROVIDER };

export interface TlsConfig { certFile: string; keyFile: string }

export const LETS_ENCRYPT_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';
export const LETS_ENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

/** Certificates obtained and renewed by the server itself over ACME HTTP-01 for the publicOrigin host (ADR 0007). */
export interface AcmeConfig {
  directoryUrl: string;
  contactEmail?: string;
  /** The plaintext port answering HTTP-01 challenges. CAs validate on port 80. */
  httpPort: number;
}

export interface ListenConfig {
  host: string;
  port: number;
  /**
   * `false` (plaintext) is accepted on a loopback host, for a reverse proxy on the same host (ADR 0006), and beyond
   * loopback only with `behindProxy` (ADR 0033).
   */
  tls: TlsConfig | { acme: AcmeConfig } | false;
  /** TLS ends at a proxy in front, such as a Kubernetes Ingress, so plaintext may listen beyond loopback (ADR 0033). */
  behindProxy?: true;
}

/** A secret named by environment variable or read from a secret mount; never the value itself. */
export type SecretReference = { env: string } | { file: string };

export interface GitHubConfig {
  clientId: string;
  clientSecret: SecretReference;
  callbackUrl: string;
  /** The one GitHub account allowed in, by its numeric user ID. Login names can change hands (ADR 0002). */
  allowedUserId: number;
}

/** How the thinking loop keeps its Pi session in shape (ADR 0009). Token counts are Pi's context estimates. */
export interface LoopConfig {
  /** The owner's IANA time zone: memory dates and the nightly switch use it. */
  timeZone: string;
  /** Local `HH:MM` of the nightly session switch, or false to switch only by hand. */
  nightlyRotationAt: string | false;
  /** Past this many context tokens the session is compacted between turns. */
  compactionThreshold: number;
  /** Recent context tokens a compaction keeps as they are. */
  compactionKeepRecent: number;
  /** The Unix socket of the workspace container's runner (ADR 0019). Without it the model gets no shell. */
  workspaceSocket?: string;
  /** Seconds the server waits for the runner's answer. Longer than the runner's own response limit (ADR 0019). */
  shellWaitSeconds: number;
  /** Past this many bytes across the three persistent places, the next turn is told, with the breakdown (ADR 0019). */
  workspaceSizeWarnBytes: number;
  /** The git repository holding memory (ADR 0018). `memory/` in the data directory when omitted. */
  memoryRepository?: string;
  /** The longest one memory file may be, in characters. A file over it goes back to the previous commit. */
  memoryFileMaxChars: number;
  /** The longest the always-memory may be. It rides in every prompt, so its limit is far below one file's (ADR 0020). */
  alwaysMemoryMaxChars: number;
  /** Local hours natsumi is up. Pings and self-checks come only inside them (ADR 0014). */
  awakeHours: AwakeHours;
  /** Quiet minutes before a ping, or false for no pings. */
  pingIntervalMinutes: number | false;
  /** Limits on the checks natsumi books for herself. */
  selfCheck: SelfCheckLimits;
  /** Minutes an expression other than thinking stays before returning to neutral. */
  expressionResetMinutes: number;
  /** Model calls the nightly review turn may make: it reads and rewrites memory file by file (ADR 0018). */
  reviewModelCalls: number;
  /** Minutes the nightly review turn may take. */
  reviewTimeoutMinutes: number;
  /** Model calls an ordinary turn may make before it is stopped and its open events fail. */
  eventModelCalls: number;
  /** Minutes an ordinary turn may take. */
  eventTimeoutMinutes: number;
  /**
   * Whether ended turns are folded before each model call, until the command line chooses otherwise (ADR 0047). The
   * memo is asked for after every turn either way, so that on and off differ only in the folding.
   */
  turnFold: 'on' | 'off';
}

// The turns' limits live here rather than in the thinking loop, which loads Pi's SDK on import.
export const DEFAULT_REVIEW_MODEL_CALLS = 40;
export const DEFAULT_REVIEW_TIMEOUT_MINUTES = 30;
/** An ordinary turn's limits (the evaluation stopped at 8 calls). */
export const DEFAULT_EVENT_MODEL_CALLS = 8;
export const DEFAULT_EVENT_TIMEOUT_MINUTES = 10;

export const LOOP_DEFAULTS: LoopConfig = {
  timeZone: 'UTC', nightlyRotationAt: '04:00', compactionThreshold: 60000, compactionKeepRecent: 20000,
  memoryFileMaxChars: DEFAULT_FILE_MAX_CHARS, alwaysMemoryMaxChars: DEFAULT_ALWAYS_MAX_CHARS,
  shellWaitSeconds: DEFAULT_SHELL_WAIT_SECONDS,
  workspaceSizeWarnBytes: DEFAULT_SIZE_WARN_BYTES,
  awakeHours: DEFAULT_AWAKE_HOURS, pingIntervalMinutes: DEFAULT_PING_INTERVAL_MINUTES, selfCheck: DEFAULT_SELF_CHECK_LIMITS,
  expressionResetMinutes: DEFAULT_EXPRESSION_RESET_MINUTES,
  reviewModelCalls: DEFAULT_REVIEW_MODEL_CALLS, reviewTimeoutMinutes: DEFAULT_REVIEW_TIMEOUT_MINUTES,
  eventModelCalls: DEFAULT_EVENT_MODEL_CALLS, eventTimeoutMinutes: DEFAULT_EVENT_TIMEOUT_MINUTES,
  turnFold: 'off',
};

/** The shortest ping interval, so a typo cannot make natsumi think all day. */
const MIN_PING_INTERVAL_MINUTES = 5;
/** Below this a memory file could not hold a topic, and every night's work would go back. */
const MIN_MEMORY_FILE_MAX_CHARS = 1000;
/** Under this the always-memory could not hold a line about the owner, and every night's rewrite would go back. */
const MIN_ALWAYS_MEMORY_MAX_CHARS = 200;
/** Under the runner's own response limit (60 seconds, ADR 0019) the answer would never reach the server. */
const MIN_SHELL_WAIT_SECONDS = 10;
/** A warning under a kibibyte would fire on an empty workspace. */
const MIN_SIZE_WARN_BYTES = 1024;

/** Pushes to the iPhone through APNs with token authentication (ADR 0029). Without it nothing is pushed. */
export interface ApnsConfig {
  /** The Apple Developer team that owns the key, the JWT's issuer. */
  teamId: string;
  /** The ID of the .p8 key, the JWT's `kid`. */
  keyId: string;
  /** The app's bundle ID, sent as `apns-topic`. */
  topic: string;
  /** The .p8 key (PKCS#8 PEM). */
  key: SecretReference;
}

/** The outside agents natsumi may ask over A2A (ADR 0025, ADR 0035, ADR 0036). Without it `ask_agent` refuses. */
export interface A2AConfig {
  /** The caller's token: a projected ServiceAccount token on Kubernetes, a file put in place by hand elsewhere. Read afresh for every call. */
  tokenFile: string;
  /** How often a task still waiting for an answer is fetched again. */
  pollIntervalSeconds: number;
  /** How long a task may go unanswered before natsumi is told the server gave up on it. */
  giveUpAfterHours: number;
  /** Name → where the agent answers. natsumi only ever sees the names. */
  agents: Record<string, { url: string }>;
}

export const DEFAULT_A2A_POLL_INTERVAL_SECONDS = 15;
export const DEFAULT_A2A_GIVE_UP_AFTER_HOURS = 24;
/** Under this the server would ask the agents more often than any answer could change. */
const MIN_A2A_POLL_INTERVAL_SECONDS = 5;
/** An agent's name as natsumi writes it in `ask_agent`: short, lower case, no spaces. */
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** One Slack workspace natsumi's own App is installed in (ADR 0039). The channels are the ones its bot is invited to. */
export interface SlackWorkspaceConfig {
  /** The bot token (`xoxb-`), for the Web API. */
  botToken: SecretReference;
  /** The app-level token (`xapp-`) with `connections:write`, for Socket Mode. */
  appToken: SecretReference;
}

/** Slack, received (ADR 0012, ADR 0039). Without it nothing connects to Slack. */
export interface SlackConfig {
  /** Name → tokens. The name is what natsumi reads in paths and references, such as `work/#dev`. */
  workspaces: Record<string, SlackWorkspaceConfig>;
  /** The reaction the server puts on a mention or a DM as it arrives, by Slack's emoji name. */
  reaction: string;
  /** How far back a channel never recorded before is filled in, in days. */
  backfillDays: number;
  /** The largest image fetched; a larger one, or a file that is not an image, is only noted. */
  maxImageBytes: number;
  /** The messages before a mention its event carries, and the characters each keeps. */
  mentionContext: { messages: number; chars: number };
  /** Whether Slack is counted in the `updates` of pings and self-checks. */
  updates: boolean;
  /**
   * The dove's judge (ADR 0040), resolved against `pi`: the logprobs of pi's own compatible model unless told otherwise.
   * Absent when there is nothing to judge with; every draft is then "no verdict" and goes to the owner.
   */
  judge?: JudgeConfig;
  /** How long an approval waits for the owner before it expires. */
  approvalExpiryDays: number;
  /** Without a verdict, a reply to a top-level message goes to the channel while at most this many came after it. */
  placementFollowing: number;
  /** What Jev is shown around a draft's target: how many messages, and the characters each keeps. */
  judgeContext: { messages: number; chars: number };
  /** The images natsumi asks the dove to post (ADR 0044): the largest one taken, and the most in one request. */
  postImages: { maxBytes: number; maxCount: number };
}

/**
 * How the dove judges drafts (ADR 0040). `logprobs` asks an OpenAI-compatible model each question for one token and
 * reads the probabilities of its answers; `jev` calls TypeSafe AI's Jev API, or a server that answers the same API.
 */
export interface JudgeConfig {
  method: 'logprobs' | 'jev';
  /** For `logprobs` the OpenAI-compatible base (`…/v1`); for `jev` the base of `/v1/systemone`. */
  baseUrl: string;
  /** Absent when the endpoint needs none: then no Authorization header is sent. */
  apiKey?: SecretReference;
  model: string;
  /** Questions asked at once by the logprobs method, one request each. */
  concurrency: number;
  /** A judgement not done in this time is "no verdict". */
  timeoutSeconds: number;
  /** A score at or over `owner` hands the draft to the owner; one at or over `return` turns it back to natsumi. */
  thresholds: { owner: number; return: number };
}

export const SLACK_DEFAULTS = {
  reaction: 'eyes', backfillDays: 90, maxImageBytes: 5 * 1024 * 1024, mentionContext: { messages: 5, chars: 500 }, updates: true,
  approvalExpiryDays: 7, placementFollowing: 2,
  judgeContext: { messages: 5, chars: 500 }, postImages: { maxBytes: 10 * 1024 * 1024, maxCount: 4 },
};
export const JUDGE_DEFAULTS = {
  method: 'logprobs' as const, concurrency: 4, timeoutSeconds: 30, thresholds: { owner: 0.5, return: 0.9 },
  jev: { baseUrl: 'https://api.typesafe.ai', model: 'jev-latest' },
};
const MAX_JUDGE_CONCURRENCY = 16;
const MIN_JUDGE_TIMEOUT_SECONDS = 5;
const MAX_JUDGE_TIMEOUT_SECONDS = 300;
const MAX_APPROVAL_EXPIRY_DAYS = 90;
const MAX_PLACEMENT_FOLLOWING = 20;
const MAX_JUDGE_CONTEXT_MESSAGES = 20;
/** The dove's name in ask_agent (ADR 0040). The config's outside agents may not take it. */
const DOVE_NAME = 'poppo';
/**
 * A year: the channels natsumi is invited to are quiet, so a long first fill-in is cheap, and the files are kept
 * rather than cleared anyway. Beyond a year a typo would mean days of paging through history at Slack's rate limit.
 */
const MAX_SLACK_BACKFILL_DAYS = 365;
const MAX_SLACK_IMAGE_BYTES = 20 * 1024 * 1024;
/** Each image the dove posts is copied and kept (ADR 0044); an image generated for chat is a few MB at most. */
const MAX_POST_IMAGE_BYTES = 50 * 1024 * 1024;
/** The most files one message is given here: as many as a Slack message is usually seen with. */
const MAX_POST_IMAGES = 10;
const MAX_MENTION_CONTEXT_MESSAGES = 20;
const MIN_MENTION_CONTEXT_CHARS = 50;
/** Slack's emoji names: lower case, digits and a few marks, without the colons. */
const EMOJI_NAME = /^[a-z0-9_+'-]+$/;

export interface ServerConfig {
  pi: PiConfig;
  /** The origin clients use, such as `https://natsumi.example.net`. WebSocket Origin headers must match it. */
  publicOrigin: string;
  listen: ListenConfig;
  github: GitHubConfig;
  loop: LoopConfig;
  apns?: ApnsConfig;
  a2a?: A2AConfig;
  slack?: SlackConfig;
}

export const GITHUB_CALLBACK_PATH = '/auth/github/callback';

type Section<T> = (value: unknown, path: string) => T;

/**
 * Top-level sections. A later change adds a setting by adding its parser here and its field to ServerConfig.
 * Anything not listed is rejected so a typo cannot silently disable a safety setting.
 */
const SECTIONS = {
  pi: parsePi,
  publicOrigin: parsePublicOrigin,
  listen: parseListen,
  github: parseGitHub,
  loop: parseLoop,
  apns: parseApns,
  a2a: parseA2A,
  slack: parseSlack,
} satisfies { [K in keyof ServerConfig]: Section<unknown> };

/** Settings ADR 0019 renamed. The old name stops startup rather than being ignored: it would switch the shell off. */
const RENAMED_LOOP_KEYS: Record<string, string> = {
  memoryShellSocket: 'workspaceSocket',
};

const MOVED: Record<string, string> = {
  dataDirectory: 'the data directory is chosen with --data-dir or the launch directory, not in the config',
};

export async function loadConfig(file: string): Promise<ServerConfig> {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { throw new ConfigError('config', 'cannot read the config file'); }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new ConfigError('config', 'the config file is not valid JSON'); }
  return parseConfig(raw);
}

export function parseConfig(raw: unknown): ServerConfig {
  const root = object(raw, 'config');
  refuseSecrets(root, '');
  for (const key of Object.keys(root)) {
    if (MOVED[key]) throw new ConfigError(key, MOVED[key]);
    if (!(key in SECTIONS)) throw new ConfigError(key, 'unknown setting');
  }
  const pi = SECTIONS.pi(required(root, 'pi', ''), 'pi');
  const loop = SECTIONS.loop(root.loop ?? {}, 'loop');
  const config: ServerConfig = {
    pi: resolveRoutes(pi, loop),
    publicOrigin: SECTIONS.publicOrigin(required(root, 'publicOrigin', ''), 'publicOrigin'),
    listen: SECTIONS.listen(required(root, 'listen', ''), 'listen'),
    github: SECTIONS.github(required(root, 'github', ''), 'github'),
    loop,
    ...(root.apns === undefined ? {} : { apns: SECTIONS.apns(root.apns, 'apns') }),
    ...(root.a2a === undefined ? {} : { a2a: SECTIONS.a2a(root.a2a, 'a2a') }),
    ...(root.slack === undefined ? {} : { slack: SECTIONS.slack(root.slack, 'slack') }),
  };
  if (config.slack) {
    const judge = parseJudge((root.slack as Record<string, unknown>).judge, 'slack.judge', config.pi);
    if (judge) config.slack.judge = judge;
  }
  if (new URL(config.github.callbackUrl).origin !== config.publicOrigin) {
    throw new ConfigError('github.callbackUrl', 'must be on publicOrigin');
  }
  if (config.listen.tls && 'acme' in config.listen.tls) {
    const host = new URL(config.publicOrigin).hostname.replace(/^\[(.*)\]$/, '$1');
    if (isIP(host) !== 0 || host === 'localhost' || !host.includes('.')) {
      throw new ConfigError('publicOrigin', 'ACME needs a DNS host name, not an IP address or a single label');
    }
  }
  return config;
}

/** Written by the owner; `compactionThreshold` is filled in from the loop once it is known (see parseConfig). */
type ParsedRoute = Omit<ModelRoute, 'compactionThreshold'> & { compactionThreshold?: number; path: string };
type ParsedPi = Omit<PiConfig, 'routes'> & { routes: ParsedRoute[] };

const ROUTE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

function parsePi(value: unknown, path: string): ParsedPi {
  const pi = object(value, path);
  onlyKeys(pi, path, ['agentDirectory', 'sessionDirectory', 'authPath', 'model', 'compatible', 'routes', 'defaultRoute', 'thinking',
    'voiceEnabled']);
  const voice = required(pi, 'voiceEnabled', path);
  if (voice !== false) throw new ConfigError(`${path}.voiceEnabled`, 'voice is not supported; set false');
  const thinking = pi.thinking === undefined ? 'on' : pi.thinking;
  if (thinking !== 'on' && thinking !== 'off') throw new ConfigError(`${path}.thinking`, 'must be "on" or "off"');
  let routes: ParsedRoute[];
  let defaultRoute: string;
  if (pi.routes !== undefined) {
    if (pi.model !== undefined || pi.compatible !== undefined) {
      throw new ConfigError(`${path}.routes`, `cannot be combined with ${path}.model or ${path}.compatible`);
    }
    const routesPath = `${path}.routes`;
    const table = object(pi.routes, routesPath);
    routes = Object.entries(table).map(([name, route]) => {
      const routePath = `${routesPath}.${name}`;
      if (!ROUTE_NAME.test(name)) throw new ConfigError(routePath, 'a route name is lowercase letters, digits and hyphens, up to 32');
      const fields = object(route, routePath);
      onlyKeys(fields, routePath, ['model', 'compatible', 'compactionThreshold']);
      const threshold = fields.compactionThreshold === undefined ? undefined
        : compactionThreshold(fields.compactionThreshold, `${routePath}.compactionThreshold`);
      return { name, ...parseRoute(fields, routePath), ...(threshold === undefined ? {} : { compactionThreshold: threshold }),
        path: routePath };
    });
    if (routes.length === 0) throw new ConfigError(routesPath, 'must name at least one route');
    defaultRoute = nonEmptyString(required(pi, 'defaultRoute', path), `${path}.defaultRoute`);
    if (!routes.some(route => route.name === defaultRoute)) throw new ConfigError(`${path}.defaultRoute`, `must be one of ${routesPath}`);
  } else {
    if (pi.model === undefined) throw new ConfigError(`${path}.routes`, `is required (or ${path}.model for a single route)`);
    if (pi.defaultRoute !== undefined) throw new ConfigError(`${path}.defaultRoute`, `is set only with ${path}.routes`);
    routes = [{ name: SINGLE_ROUTE_NAME, ...parseRoute(pi, path), path }];
    defaultRoute = SINGLE_ROUTE_NAME;
  }
  // Each compatible route is registered in Pi under its own provider, so two of them cannot share one.
  const providers = new Set<string>();
  for (const route of routes) {
    if (!route.compatible) continue;
    if (providers.has(route.model.provider)) {
      throw new ConfigError(`${route.path}.model.provider`, 'is already the provider of another route; give this one its own');
    }
    providers.add(route.model.provider);
  }
  return {
    agentDirectory: absolutePath(required(pi, 'agentDirectory', path), `${path}.agentDirectory`),
    sessionDirectory: absolutePath(required(pi, 'sessionDirectory', path), `${path}.sessionDirectory`),
    authPath: absolutePath(required(pi, 'authPath', path), `${path}.authPath`),
    routes, defaultRoute,
    thinking,
    voiceEnabled: false,
  };
}

/** A compatible route's provider is this one, or this one with a suffix of its own. */
const isCompatibleProvider = (provider: string) => provider === COMPATIBLE_PROVIDER || provider.startsWith(`${COMPATIBLE_PROVIDER}-`);

/** `model` and `compatible` of one route, at `path` (which is `pi` itself for a config with only `pi.model`). */
function parseRoute(fields: Record<string, unknown>, path: string): Pick<ModelRoute, 'model' | 'compatible'> {
  const modelPath = `${path}.model`;
  const model = object(required(fields, 'model', path), modelPath);
  onlyKeys(model, modelPath, ['provider', 'id']);
  const provider = nonEmptyString(required(model, 'provider', modelPath), `${modelPath}.provider`);
  // The route is chosen explicitly and never falls back: the compatible provider and its endpoint come together.
  let compatible: CompatibleConfig | undefined;
  if (fields.compatible !== undefined) {
    if (!isCompatibleProvider(provider)) {
      throw new ConfigError(`${modelPath}.provider`, `must be ${COMPATIBLE_PROVIDER} (or begin with ${COMPATIBLE_PROVIDER}-) when ${path}.compatible is set`);
    }
    compatible = parseCompatible(fields.compatible, `${path}.compatible`);
  } else if (isCompatibleProvider(provider)) {
    throw new ConfigError(`${path}.compatible`, `is required for the ${provider} provider`);
  }
  return {
    model: { provider, id: nonEmptyString(required(model, 'id', modelPath), `${modelPath}.id`) },
    ...(compatible ? { compatible } : {}),
  };
}

function parseCompatible(value: unknown, path: string): CompatibleConfig {
  const compatible = object(value, path);
  onlyKeys(compatible, path, ['baseUrl', 'apiKeyEnv', 'apiKeyFile', 'contextWindow']);
  const baseUrlPath = `${path}.baseUrl`;
  const url = parseUrl(required(compatible, 'baseUrl', path), baseUrlPath);
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError(baseUrlPath, 'must not carry credentials, a query or a fragment');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new ConfigError(baseUrlPath, 'must use https (http is accepted only for a loopback host)');
  }
  const contextWindow = compatible.contextWindow === undefined ? DEFAULT_CONTEXT_WINDOW : compatible.contextWindow;
  if (!positiveInteger(contextWindow, 1)) throw new ConfigError(`${path}.contextWindow`, 'must be a positive integer');
  return { baseUrl: url.href, apiKey: secretReference(compatible, path, 'apiKey'), contextWindow: contextWindow as number };
}

/**
 * Room a turn is given to grow past the compaction threshold: an ordinary turn's model calls with their thinking and
 * shell answers (8000 characters each). A rough allowance, not a bound: the check below is against settings that fail
 * on an ordinary day, not a proof that no turn can overflow.
 */
const TURN_GROWTH_TOKENS = 32_768;

/**
 * Compaction runs only between turns (ADR 0009), so a turn may start just under the threshold and must still fit the
 * window: its own growth, the longest reply it may ask for, and the margin Pi keeps when it sizes a request. Near the
 * window Pi shortens each reply to what is left, so replies and thinking are cut off; Pi's own compaction is off.
 */
export function checkContextRoom(contextWindow: number, threshold: number, where: { threshold: string; window: string }) {
  const room = TURN_GROWTH_TOKENS + COMPATIBLE_MAX_TOKENS + PI_CONTEXT_SAFETY_TOKENS;
  if (threshold + room > contextWindow) {
    throw new ConfigError(where.threshold,
      `must leave ${room} tokens below ${where.window} (${contextWindow}) for a turn to finish; ` +
      `lower it to ${contextWindow - room} or raise the window`);
  }
}

/**
 * Each route's threshold, its own or the loop's, against what is kept at a compaction and against the route's window.
 * Only a compatible route's window is in the config; a subscription model's comes from Pi's own model definition,
 * and the server checks it at startup (see `checkRouteWindow`).
 */
function resolveRoutes(pi: ParsedPi, loop: LoopConfig): PiConfig {
  const routes = pi.routes.map(({ path, compactionThreshold: own, ...route }) => {
    const threshold = own ?? loop.compactionThreshold;
    const thresholdPath = own === undefined ? 'loop.compactionThreshold' : `${path}.compactionThreshold`;
    if (loop.compactionKeepRecent >= threshold) {
      throw new ConfigError(thresholdPath, own === undefined ? 'must be larger than compactionKeepRecent'
        : 'must be larger than loop.compactionKeepRecent');
    }
    if (route.compatible) {
      checkContextRoom(route.compatible.contextWindow, threshold, { threshold: thresholdPath, window: `${path}.compatible.contextWindow` });
    }
    return { ...route, compactionThreshold: threshold };
  });
  return { ...pi, routes };
}

/**
 * The check `resolveRoutes` leaves to the server: a subscription route's threshold against the window Pi gives its
 * model. The window is looked up by the caller, which may load Pi.
 */
export function checkRouteWindow(pi: PiConfig, route: ModelRoute, contextWindow: number) {
  const named = pi.routes.length > 1 || route.name !== SINGLE_ROUTE_NAME;
  checkContextRoom(contextWindow, route.compactionThreshold, {
    threshold: named ? `pi.routes.${route.name}.compactionThreshold` : 'loop.compactionThreshold',
    window: `the context window of ${route.model.provider}/${route.model.id}`,
  });
}

function parsePublicOrigin(value: unknown, path: string): string {
  const url = parseUrl(value, path);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new ConfigError(path, 'must be an origin without a path, query or credentials');
  }
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url.origin;
  throw new ConfigError(path, 'must use https (http is accepted only for a loopback host)');
}

function parseListen(value: unknown, path: string): ListenConfig {
  const listen = object(value, path);
  onlyKeys(listen, path, ['host', 'port', 'tls', 'behindProxy']);
  const host = nonEmptyString(required(listen, 'host', path), `${path}.host`);
  if (host !== 'localhost' && isIP(host) === 0) throw new ConfigError(`${path}.host`, 'must be an IP address or localhost');
  const port = required(listen, 'port', path);
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`${path}.port`, 'must be an integer from 0 to 65535');
  }
  const tlsPath = `${path}.tls`;
  const tls = required(listen, 'tls', path);
  const behindProxy = listen.behindProxy ?? false;
  if (typeof behindProxy !== 'boolean') throw new ConfigError(`${path}.behindProxy`, 'must be true or false');
  if (behindProxy && tls !== false) {
    throw new ConfigError(`${path}.behindProxy`, 'is for tls: false; the server does not terminate TLS behind a proxy');
  }
  if (tls === false) {
    // Plaintext is not exposed by accident: beyond loopback it takes behindProxy, which says a proxy in front
    // terminates TLS and only the stretch from that proxy to here is plaintext (ADR 0033).
    if (!behindProxy && !isLoopbackHost(host)) {
      throw new ConfigError(tlsPath, 'plaintext is accepted only on a loopback host, or with behindProxy; set certFile and keyFile');
    }
    return { host, port, tls: false, ...(behindProxy ? { behindProxy: true as const } : {}) };
  }
  if (typeof tls !== 'object' || tls === null || Array.isArray(tls)) {
    throw new ConfigError(tlsPath, 'must be { certFile, keyFile }, { acme }, or false on a loopback host');
  }
  const files = tls as Record<string, unknown>;
  if ('acme' in files) {
    if (Object.keys(files).length !== 1) throw new ConfigError(tlsPath, 'set either certFile and keyFile, or acme');
    return { host, port, tls: { acme: parseAcme(files.acme, `${tlsPath}.acme`, port) } };
  }
  onlyKeys(files, tlsPath, ['certFile', 'keyFile']);
  return {
    host, port,
    tls: {
      certFile: absolutePath(required(files, 'certFile', tlsPath), `${tlsPath}.certFile`),
      keyFile: absolutePath(required(files, 'keyFile', tlsPath), `${tlsPath}.keyFile`),
    },
  };
}

const EMAIL = /^[^\s@:,;<>()[\]"\\]+@[^\s@:,;<>()[\]"\\]+\.[^\s@:,;<>()[\]"\\]+$/;

function parseAcme(value: unknown, path: string, listenPort: number): AcmeConfig {
  const acme = object(value, path);
  onlyKeys(acme, path, ['directoryUrl', 'contactEmail', 'httpPort']);
  let directoryUrl = LETS_ENCRYPT_PRODUCTION;
  if (acme.directoryUrl !== undefined) {
    const urlPath = `${path}.directoryUrl`;
    const url = parseUrl(acme.directoryUrl, urlPath);
    if (url.username || url.password || url.hash) throw new ConfigError(urlPath, 'must not contain credentials or a fragment');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
      throw new ConfigError(urlPath, 'must use https (http is accepted only for a loopback host)');
    }
    directoryUrl = url.href;
  }
  const email = acme.contactEmail;
  if (email !== undefined && (typeof email !== 'string' || !EMAIL.test(email))) {
    throw new ConfigError(`${path}.contactEmail`, 'must be a single email address without mailto:');
  }
  const httpPort = acme.httpPort ?? 80;
  if (typeof httpPort !== 'number' || !Number.isInteger(httpPort) || httpPort < 0 || httpPort > 65535) {
    throw new ConfigError(`${path}.httpPort`, 'must be an integer from 0 to 65535');
  }
  if (httpPort !== 0 && httpPort === listenPort) throw new ConfigError(`${path}.httpPort`, 'must differ from listen.port');
  return { directoryUrl, ...(email === undefined ? {} : { contactEmail: email }), httpPort };
}

function parseGitHub(value: unknown, path: string): GitHubConfig {
  const github = object(value, path);
  onlyKeys(github, path, ['clientId', 'clientSecretEnv', 'clientSecretFile', 'callbackUrl', 'allowedUserId']);
  const clientSecret = secretReference(github, path, 'clientSecret');
  const callbackPath = `${path}.callbackUrl`;
  const callback = parseUrl(required(github, 'callbackUrl', path), callbackPath);
  if (callback.pathname !== GITHUB_CALLBACK_PATH || callback.search || callback.hash || callback.username || callback.password) {
    throw new ConfigError(callbackPath, `must be publicOrigin followed by ${GITHUB_CALLBACK_PATH}`);
  }
  const id = required(github, 'allowedUserId', path);
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
    throw new ConfigError(`${path}.allowedUserId`, 'must be a numeric GitHub user ID, not a login name');
  }
  return {
    clientId: nonEmptyString(required(github, 'clientId', path), `${path}.clientId`),
    clientSecret, callbackUrl: callback.href, allowedUserId: id,
  };
}

/** Apple's team and key IDs are ten upper-case letters or digits. */
const APPLE_ID = /^[A-Z0-9]{10}$/;
/** A bundle ID: dot-separated parts of letters, digits and hyphens. */
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

function parseApns(value: unknown, path: string): ApnsConfig {
  const apns = object(value, path);
  onlyKeys(apns, path, ['teamId', 'keyId', 'topic', 'keyEnv', 'keyFile']);
  const key = secretReference(apns, path, 'key');
  for (const name of ['teamId', 'keyId']) {
    const id = required(apns, name, path);
    if (typeof id !== 'string' || !APPLE_ID.test(id)) throw new ConfigError(`${path}.${name}`, 'must be ten upper-case letters or digits');
  }
  const topic = required(apns, 'topic', path);
  if (typeof topic !== 'string' || !BUNDLE_ID.test(topic)) throw new ConfigError(`${path}.topic`, 'must be the app\'s bundle ID');
  return { teamId: apns.teamId as string, keyId: apns.keyId as string, topic, key };
}

function parseA2A(value: unknown, path: string): A2AConfig {
  const a2a = object(value, path);
  onlyKeys(a2a, path, ['tokenFile', 'pollIntervalSeconds', 'giveUpAfterHours', 'agents']);
  const interval = a2a.pollIntervalSeconds ?? DEFAULT_A2A_POLL_INTERVAL_SECONDS;
  if (!positiveInteger(interval, MIN_A2A_POLL_INTERVAL_SECONDS)) {
    throw new ConfigError(`${path}.pollIntervalSeconds`, `must be an integer of at least ${MIN_A2A_POLL_INTERVAL_SECONDS}`);
  }
  const giveUp = a2a.giveUpAfterHours ?? DEFAULT_A2A_GIVE_UP_AFTER_HOURS;
  if (!positiveInteger(giveUp, 1)) throw new ConfigError(`${path}.giveUpAfterHours`, 'must be a positive integer');
  const agentsPath = `${path}.agents`;
  const listed = object(required(a2a, 'agents', path), agentsPath);
  const agents: A2AConfig['agents'] = {};
  for (const [name, entry] of Object.entries(listed)) {
    const entryPath = `${agentsPath}.${name}`;
    if (!AGENT_NAME.test(name)) throw new ConfigError(entryPath, 'the name must be lower-case letters, digits and hyphens, at most 32');
    if (name === DOVE_NAME) throw new ConfigError(entryPath, 'the name is the Slack dove\'s own, served by the server itself (ADR 0040)');
    const agent = object(entry, entryPath);
    onlyKeys(agent, entryPath, ['url']);
    // The token rides on every call, so it goes nowhere it could be read on the way.
    const urlPath = `${entryPath}.url`;
    const url = parseUrl(required(agent, 'url', entryPath), urlPath);
    if (url.username || url.password || url.search || url.hash) {
      throw new ConfigError(urlPath, 'must not carry credentials, a query or a fragment');
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
      throw new ConfigError(urlPath, 'must use https (http is accepted only for a loopback host)');
    }
    agents[name] = { url: url.href };
  }
  return {
    tokenFile: absolutePath(required(a2a, 'tokenFile', path), `${path}.tokenFile`),
    pollIntervalSeconds: interval as number, giveUpAfterHours: giveUp as number, agents,
  };
}

function parseSlack(value: unknown, path: string): SlackConfig {
  const slack = object(value, path);
  // `judge` is read by parseJudge once pi is known: by default it borrows pi's compatible endpoint.
  // The list of reactions was dropped (ADR 0042); one still written would promise a limit that is no longer there.
  if ('reactions' in slack) throw new ConfigError(`${path}.reactions`, 'was removed: any emoji that exists may be asked for (ADR 0042); delete it');
  onlyKeys(slack, path, ['workspaces', 'reaction', 'backfillDays', 'maxImageBytes', 'mentionContext', 'updates', 'judge', 'approvalExpiryDays',
    'placementFollowing', 'judgeContext', 'postImages']);
  const workspacesPath = `${path}.workspaces`;
  const listed = object(required(slack, 'workspaces', path), workspacesPath);
  const workspaces: SlackConfig['workspaces'] = {};
  for (const [name, entry] of Object.entries(listed)) {
    const entryPath = `${workspacesPath}.${name}`;
    // The name becomes a directory and the first part of every reference she writes, so it is kept plain.
    if (!AGENT_NAME.test(name)) throw new ConfigError(entryPath, 'the name must be lower-case letters, digits and hyphens, at most 32');
    const workspace = object(entry, entryPath);
    onlyKeys(workspace, entryPath, ['botTokenEnv', 'botTokenFile', 'appTokenEnv', 'appTokenFile']);
    workspaces[name] = { botToken: secretReference(workspace, entryPath, 'botToken'), appToken: secretReference(workspace, entryPath, 'appToken') };
  }
  if (Object.keys(workspaces).length === 0) throw new ConfigError(workspacesPath, 'must name at least one workspace');
  const reaction = slack.reaction ?? SLACK_DEFAULTS.reaction;
  if (typeof reaction !== 'string' || !EMOJI_NAME.test(reaction)) {
    throw new ConfigError(`${path}.reaction`, 'must be an emoji name without colons, such as eyes');
  }
  const days = slack.backfillDays ?? SLACK_DEFAULTS.backfillDays;
  if (!positiveInteger(days, 1) || (days as number) > MAX_SLACK_BACKFILL_DAYS) {
    throw new ConfigError(`${path}.backfillDays`, `must be an integer from 1 to ${MAX_SLACK_BACKFILL_DAYS}`);
  }
  const bytes = slack.maxImageBytes ?? SLACK_DEFAULTS.maxImageBytes;
  if (!positiveInteger(bytes, 1024) || (bytes as number) > MAX_SLACK_IMAGE_BYTES) {
    throw new ConfigError(`${path}.maxImageBytes`, `must be an integer from 1024 to ${MAX_SLACK_IMAGE_BYTES}`);
  }
  const contextPath = `${path}.mentionContext`;
  const context = object(slack.mentionContext ?? {}, contextPath);
  onlyKeys(context, contextPath, ['messages', 'chars']);
  const messages = context.messages ?? SLACK_DEFAULTS.mentionContext.messages;
  if (!(typeof messages === 'number' && Number.isInteger(messages) && messages >= 0 && messages <= MAX_MENTION_CONTEXT_MESSAGES)) {
    throw new ConfigError(`${contextPath}.messages`, `must be an integer from 0 to ${MAX_MENTION_CONTEXT_MESSAGES}`);
  }
  const chars = context.chars ?? SLACK_DEFAULTS.mentionContext.chars;
  if (!positiveInteger(chars, MIN_MENTION_CONTEXT_CHARS)) {
    throw new ConfigError(`${contextPath}.chars`, `must be an integer of at least ${MIN_MENTION_CONTEXT_CHARS}`);
  }
  const updates = slack.updates ?? SLACK_DEFAULTS.updates;
  if (typeof updates !== 'boolean') throw new ConfigError(`${path}.updates`, 'must be true or false');
  const expiry = slack.approvalExpiryDays ?? SLACK_DEFAULTS.approvalExpiryDays;
  if (!positiveInteger(expiry, 1) || (expiry as number) > MAX_APPROVAL_EXPIRY_DAYS) {
    throw new ConfigError(`${path}.approvalExpiryDays`, `must be an integer from 1 to ${MAX_APPROVAL_EXPIRY_DAYS}`);
  }
  const following = slack.placementFollowing ?? SLACK_DEFAULTS.placementFollowing;
  if (!(typeof following === 'number' && Number.isInteger(following) && following >= 0 && following <= MAX_PLACEMENT_FOLLOWING)) {
    throw new ConfigError(`${path}.placementFollowing`, `must be an integer from 0 to ${MAX_PLACEMENT_FOLLOWING}`);
  }
  const judgePath = `${path}.judgeContext`;
  const judge = object(slack.judgeContext ?? {}, judgePath);
  onlyKeys(judge, judgePath, ['messages', 'chars']);
  const judgeMessages = judge.messages ?? SLACK_DEFAULTS.judgeContext.messages;
  if (!positiveInteger(judgeMessages, 1) || (judgeMessages as number) > MAX_JUDGE_CONTEXT_MESSAGES) {
    throw new ConfigError(`${judgePath}.messages`, `must be an integer from 1 to ${MAX_JUDGE_CONTEXT_MESSAGES}`);
  }
  const judgeChars = judge.chars ?? SLACK_DEFAULTS.judgeContext.chars;
  if (!positiveInteger(judgeChars, MIN_MENTION_CONTEXT_CHARS)) {
    throw new ConfigError(`${judgePath}.chars`, `must be an integer of at least ${MIN_MENTION_CONTEXT_CHARS}`);
  }
  const imagesPath = `${path}.postImages`;
  const images = object(slack.postImages ?? {}, imagesPath);
  onlyKeys(images, imagesPath, ['maxBytes', 'maxCount']);
  const imageBytes = images.maxBytes ?? SLACK_DEFAULTS.postImages.maxBytes;
  if (!positiveInteger(imageBytes, 1024) || (imageBytes as number) > MAX_POST_IMAGE_BYTES) {
    throw new ConfigError(`${imagesPath}.maxBytes`, `must be an integer from 1024 to ${MAX_POST_IMAGE_BYTES}`);
  }
  const imageCount = images.maxCount ?? SLACK_DEFAULTS.postImages.maxCount;
  if (!positiveInteger(imageCount, 1) || (imageCount as number) > MAX_POST_IMAGES) {
    throw new ConfigError(`${imagesPath}.maxCount`, `must be an integer from 1 to ${MAX_POST_IMAGES}`);
  }
  return { workspaces, reaction, backfillDays: days as number, maxImageBytes: bytes as number,
    mentionContext: { messages, chars: chars as number }, updates,
    approvalExpiryDays: expiry as number, placementFollowing: following,
    judgeContext: { messages: judgeMessages as number, chars: judgeChars as number },
    postImages: { maxBytes: imageBytes as number, maxCount: imageCount as number } };
}

/**
 * The judge, resolved against pi (ADR 0040). The logprobs method borrows pi's compatible endpoint, key and model for
 * whatever the section leaves out; a key is borrowed only with the endpoint it belongs to. Without a section and
 * without a compatible model there is no judge. A key set here goes over plain http only to a loopback host.
 */
function parseJudge(value: unknown, path: string, pi: PiConfig): JudgeConfig | undefined {
  // The default route's, fixed at startup: switching routes never changes what the dove judges with (ADR 0046).
  const lender = defaultRoute(pi);
  const compatible = lender.compatible;
  if (value === undefined && !compatible) return undefined;
  const judge = object(value ?? {}, path);
  onlyKeys(judge, path, ['method', 'baseUrl', 'apiKeyEnv', 'apiKeyFile', 'model', 'concurrency', 'timeoutSeconds', 'thresholds']);
  const method = judge.method ?? JUDGE_DEFAULTS.method;
  if (method !== 'logprobs' && method !== 'jev') throw new ConfigError(`${path}.method`, 'must be logprobs or jev');
  const ownKey = judge.apiKeyEnv === undefined && judge.apiKeyFile === undefined ? undefined : secretReference(judge, path, 'apiKey');
  const basePath = `${path}.baseUrl`;
  let baseUrl: string;
  let apiKey = ownKey;
  if (judge.baseUrl !== undefined) {
    const base = parseUrl(judge.baseUrl, basePath);
    if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new ConfigError(basePath, 'must be an http or https URL');
    if (base.username || base.password || base.search || base.hash) throw new ConfigError(basePath, 'must not carry credentials, a query or a fragment');
    // Every draft and what surrounds it go there; a key on top of that goes over plain http only to this machine.
    if (ownKey && base.protocol === 'http:' && !isLoopbackHost(base.hostname)) {
      throw new ConfigError(basePath, 'must use https when an API key is sent (http is accepted with a key only for a loopback host)');
    }
    baseUrl = (judge.baseUrl as string).replace(/\/+$/, '');
  } else if (method === 'jev') {
    baseUrl = JUDGE_DEFAULTS.jev.baseUrl;
  } else if (compatible) {
    baseUrl = compatible.baseUrl.replace(/\/+$/, '');
    apiKey ??= compatible.apiKey;
  } else {
    throw new ConfigError(basePath, 'is required when pi has no compatible provider to borrow it from');
  }
  let model: string;
  if (judge.model !== undefined) model = nonEmptyString(judge.model, `${path}.model`);
  else if (method === 'jev') model = JUDGE_DEFAULTS.jev.model;
  else if (compatible) model = lender.model.id;
  else throw new ConfigError(`${path}.model`, 'is required when pi has no compatible provider to borrow it from');
  const concurrency = judge.concurrency ?? JUDGE_DEFAULTS.concurrency;
  if (!positiveInteger(concurrency, 1) || (concurrency as number) > MAX_JUDGE_CONCURRENCY) {
    throw new ConfigError(`${path}.concurrency`, `must be an integer from 1 to ${MAX_JUDGE_CONCURRENCY}`);
  }
  const timeout = judge.timeoutSeconds ?? JUDGE_DEFAULTS.timeoutSeconds;
  if (!positiveInteger(timeout, MIN_JUDGE_TIMEOUT_SECONDS) || (timeout as number) > MAX_JUDGE_TIMEOUT_SECONDS) {
    throw new ConfigError(`${path}.timeoutSeconds`, `must be an integer from ${MIN_JUDGE_TIMEOUT_SECONDS} to ${MAX_JUDGE_TIMEOUT_SECONDS}`);
  }
  const thresholdsPath = `${path}.thresholds`;
  const thresholds = object(judge.thresholds ?? {}, thresholdsPath);
  onlyKeys(thresholds, thresholdsPath, ['owner', 'return']);
  const read = (name: 'owner' | 'return') => {
    const threshold = thresholds[name] ?? JUDGE_DEFAULTS.thresholds[name];
    if (typeof threshold !== 'number' || !(threshold > 0 && threshold <= 1)) throw new ConfigError(`${thresholdsPath}.${name}`, 'must be a number over 0 and at most 1');
    return threshold;
  };
  const owner = read('owner');
  const returnAt = read('return');
  if (owner > returnAt) throw new ConfigError(thresholdsPath, 'owner must not be over return');
  return { method, baseUrl, ...(apiKey ? { apiKey } : {}), model, concurrency: concurrency as number, timeoutSeconds: timeout as number,
    thresholds: { owner, return: returnAt } };
}

function parseLoop(value: unknown, path: string): LoopConfig {
  const loop = object(value, path);
  for (const [old, now] of Object.entries(RENAMED_LOOP_KEYS)) {
    if (old in loop) throw new ConfigError(`${path}.${old}`, `renamed to ${now} (ADR 0019)`);
  }
  onlyKeys(loop, path, ['timeZone', 'nightlyRotationAt', 'compactionThreshold', 'compactionKeepRecent', 'workspaceSocket',
    'shellWaitSeconds', 'workspaceSizeWarnBytes', 'memoryRepository', 'memoryFileMaxChars', 'alwaysMemoryMaxChars', 'awakeHours',
    'pingIntervalMinutes', 'selfCheck', 'expressionResetMinutes', 'reviewModelCalls', 'reviewTimeoutMinutes',
    'eventModelCalls', 'eventTimeoutMinutes', 'turnFold']);
  const timeZone = loop.timeZone ?? LOOP_DEFAULTS.timeZone;
  if (typeof timeZone !== 'string' || !isValidTimeZone(timeZone)) throw new ConfigError(`${path}.timeZone`, 'must be an IANA time zone such as Asia/Tokyo');
  const at = loop.nightlyRotationAt ?? LOOP_DEFAULTS.nightlyRotationAt;
  if (at !== false && (typeof at !== 'string' || !TIME_OF_DAY.test(at))) {
    throw new ConfigError(`${path}.nightlyRotationAt`, 'must be a 24-hour HH:MM time, or false');
  }
  const threshold = compactionThreshold(loop.compactionThreshold ?? LOOP_DEFAULTS.compactionThreshold, `${path}.compactionThreshold`);
  const keep = loop.compactionKeepRecent ?? LOOP_DEFAULTS.compactionKeepRecent;
  if (typeof keep !== 'number' || !Number.isInteger(keep) || keep < 1000) {
    throw new ConfigError(`${path}.compactionKeepRecent`, 'must be an integer of at least 1000');
  }
  if (keep >= threshold) throw new ConfigError(`${path}.compactionKeepRecent`, 'must be smaller than compactionThreshold');
  const socket = loop.workspaceSocket === undefined ? undefined : absolutePath(loop.workspaceSocket, `${path}.workspaceSocket`);
  const wait = loop.shellWaitSeconds ?? LOOP_DEFAULTS.shellWaitSeconds;
  if (!positiveInteger(wait, MIN_SHELL_WAIT_SECONDS)) {
    throw new ConfigError(`${path}.shellWaitSeconds`, `must be an integer of at least ${MIN_SHELL_WAIT_SECONDS}`);
  }
  const warnBytes = loop.workspaceSizeWarnBytes ?? LOOP_DEFAULTS.workspaceSizeWarnBytes;
  if (!positiveInteger(warnBytes, MIN_SIZE_WARN_BYTES)) {
    throw new ConfigError(`${path}.workspaceSizeWarnBytes`, `must be an integer of at least ${MIN_SIZE_WARN_BYTES}`);
  }
  const repository = loop.memoryRepository === undefined ? undefined : absolutePath(loop.memoryRepository, `${path}.memoryRepository`);
  const fileMax = loop.memoryFileMaxChars ?? LOOP_DEFAULTS.memoryFileMaxChars;
  if (!positiveInteger(fileMax, MIN_MEMORY_FILE_MAX_CHARS)) {
    throw new ConfigError(`${path}.memoryFileMaxChars`, `must be an integer of at least ${MIN_MEMORY_FILE_MAX_CHARS}`);
  }
  const alwaysMax = loop.alwaysMemoryMaxChars ?? LOOP_DEFAULTS.alwaysMemoryMaxChars;
  if (!positiveInteger(alwaysMax, MIN_ALWAYS_MEMORY_MAX_CHARS)) {
    throw new ConfigError(`${path}.alwaysMemoryMaxChars`, `must be an integer of at least ${MIN_ALWAYS_MEMORY_MAX_CHARS}`);
  }
  const ping = loop.pingIntervalMinutes ?? LOOP_DEFAULTS.pingIntervalMinutes;
  if (ping !== false && !positiveInteger(ping, MIN_PING_INTERVAL_MINUTES)) {
    throw new ConfigError(`${path}.pingIntervalMinutes`, `must be an integer of at least ${MIN_PING_INTERVAL_MINUTES}, or false`);
  }
  const reset = loop.expressionResetMinutes ?? LOOP_DEFAULTS.expressionResetMinutes;
  if (!positiveInteger(reset, 1)) throw new ConfigError(`${path}.expressionResetMinutes`, 'must be a positive integer');
  const reviewCalls = loop.reviewModelCalls ?? LOOP_DEFAULTS.reviewModelCalls;
  if (!positiveInteger(reviewCalls, 1)) throw new ConfigError(`${path}.reviewModelCalls`, 'must be a positive integer');
  const reviewMinutes = loop.reviewTimeoutMinutes ?? LOOP_DEFAULTS.reviewTimeoutMinutes;
  if (!positiveInteger(reviewMinutes, 1)) throw new ConfigError(`${path}.reviewTimeoutMinutes`, 'must be a positive integer');
  const eventCalls = loop.eventModelCalls ?? LOOP_DEFAULTS.eventModelCalls;
  if (!positiveInteger(eventCalls, 1)) throw new ConfigError(`${path}.eventModelCalls`, 'must be a positive integer');
  const eventMinutes = loop.eventTimeoutMinutes ?? LOOP_DEFAULTS.eventTimeoutMinutes;
  if (!positiveInteger(eventMinutes, 1)) throw new ConfigError(`${path}.eventTimeoutMinutes`, 'must be a positive integer');
  const turnFold = loop.turnFold ?? LOOP_DEFAULTS.turnFold;
  if (turnFold !== 'on' && turnFold !== 'off') throw new ConfigError(`${path}.turnFold`, 'must be "on" or "off"');
  return {
    timeZone, nightlyRotationAt: at, compactionThreshold: threshold, compactionKeepRecent: keep,
    ...(socket ? { workspaceSocket: socket } : {}), shellWaitSeconds: wait as number, workspaceSizeWarnBytes: warnBytes as number,
    ...(repository ? { memoryRepository: repository } : {}), memoryFileMaxChars: fileMax as number,
    alwaysMemoryMaxChars: alwaysMax as number,
    awakeHours: parseAwakeHours(loop.awakeHours ?? LOOP_DEFAULTS.awakeHours, `${path}.awakeHours`),
    pingIntervalMinutes: ping as number | false,
    selfCheck: parseSelfCheck(loop.selfCheck ?? {}, `${path}.selfCheck`),
    expressionResetMinutes: reset as number,
    reviewModelCalls: reviewCalls as number, reviewTimeoutMinutes: reviewMinutes as number,
    eventModelCalls: eventCalls as number, eventTimeoutMinutes: eventMinutes as number, turnFold,
  };
}

function parseAwakeHours(value: unknown, path: string): AwakeHours {
  const hours = object(value, path);
  onlyKeys(hours, path, ['start', 'end']);
  for (const key of ['start', 'end']) {
    const time = hours[key];
    if (typeof time !== 'string' || !TIME_OF_DAY.test(time)) throw new ConfigError(`${path}.${key}`, 'must be a 24-hour HH:MM time');
  }
  if (hours.start === hours.end) throw new ConfigError(`${path}.end`, 'must differ from start');
  return { start: hours.start as string, end: hours.end as string };
}

function parseSelfCheck(value: unknown, path: string): SelfCheckLimits {
  const limits = object(value, path);
  const keys = Object.keys(DEFAULT_SELF_CHECK_LIMITS) as (keyof SelfCheckLimits)[];
  onlyKeys(limits, path, keys);
  const parsed = { ...DEFAULT_SELF_CHECK_LIMITS };
  for (const key of keys) {
    const limit = limits[key] ?? DEFAULT_SELF_CHECK_LIMITS[key];
    if (!positiveInteger(limit, 1)) throw new ConfigError(`${path}.${key}`, 'must be a positive integer');
    parsed[key] = limit as number;
  }
  if (parsed.minDelayMinutes >= parsed.maxDelayDays * 1440) {
    throw new ConfigError(`${path}.minDelayMinutes`, 'must be shorter than maxDelayDays');
  }
  return parsed;
}

function compactionThreshold(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 10000) throw new ConfigError(path, 'must be an integer of at least 10000');
  return value;
}

function positiveInteger(value: unknown, least: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= least;
}

// Helpers for section parsers.

export function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ConfigError(path, 'must be an object');
  return value as Record<string, unknown>;
}

export function required(parent: Record<string, unknown>, key: string, path: string): unknown {
  if (parent[key] === undefined) throw new ConfigError(path ? `${path}.${key}` : key, 'is required');
  return parent[key];
}

export function onlyKeys(value: Record<string, unknown>, path: string, keys: string[]): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new ConfigError(`${path}.${key}`, 'unknown setting');
}

export function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ConfigError(path, 'must be a non-empty string');
  return value;
}

export function absolutePath(value: unknown, path: string): string {
  const text = nonEmptyString(value, path);
  if (!isAbsolute(text)) throw new ConfigError(path, 'must be an absolute path');
  return text;
}

function parseUrl(value: unknown, path: string): URL {
  const text = nonEmptyString(value, path);
  try { return new URL(text); } catch { throw new ConfigError(path, 'must be a URL'); }
}

/** Exactly one of `<name>Env` and `<name>File`. */
function secretReference(parent: Record<string, unknown>, path: string, name: string): SecretReference {
  const env = parent[`${name}Env`];
  const file = parent[`${name}File`];
  if (env !== undefined && file !== undefined) {
    throw new ConfigError(`${path}.${name}File`, `set only one of ${name}Env and ${name}File`);
  }
  if (env !== undefined) return { env: envReference(env, `${path}.${name}Env`) };
  if (file !== undefined) return { file: absolutePath(file, `${path}.${name}File`) };
  throw new ConfigError(`${path}.${name}Env`, `is required (or ${name}File)`);
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** A secret referenced by environment variable name, for settings named `...Env`. */
export function envReference(value: unknown, path: string): string {
  const text = nonEmptyString(value, path);
  if (!ENV_NAME.test(text)) throw new ConfigError(path, 'must be an environment variable name');
  return text;
}

// Secrets are referenced by `...Env` (variable name) or `...File` (secret mount path), never written inline.
const SECRET_KEY = /secret|token|password|passphrase|api[-_]?key|private[-_]?key|credential/i;
const SECRET_VALUE = /^(sk-|gh[pousr]_|github_pat_|xox[abprs]-|AIza|ya29\.)|-----BEGIN /;

function refuseSecrets(value: unknown, path: string): void {
  if (Array.isArray(value)) { value.forEach((item, i) => refuseSecrets(item, `${path}[${i}]`)); return; }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (key.endsWith('Env')) {
        if (typeof child !== 'string' || !ENV_NAME.test(child)) throw leaked(childPath, 'name an environment variable');
      } else if (key.endsWith('File')) {
        if (typeof child !== 'string' || !isAbsolute(child)) throw leaked(childPath, 'give an absolute secret file path');
      } else if (SECRET_KEY.test(key) && typeof child !== 'object') {
        throw leaked(childPath, `use ${key}Env or ${key}File`);
      } else {
        refuseSecrets(child, childPath);
      }
    }
    return;
  }
  if (typeof value === 'string' && SECRET_VALUE.test(value)) throw leaked(path, 'reference it by environment variable or secret file');
}

function leaked(path: string, hint: string): ConfigError {
  return new ConfigError(path, `secrets must not be written in the config; ${hint}`);
}
