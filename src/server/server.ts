import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { SdkA2AClient } from './a2a-client.ts';
import { AGENT_LIST_DIRECTORY, writeAgentList } from './agent-list.ts';
import { ApnsClient, parseApnsKey, type ApnsEnvironment } from './apns.ts';
import { loadAvatar } from './avatar.ts';
import { AVATAR_MANUAL_DIRECTORY, writeAvatarManual } from './avatar-manual.ts';
import { CertificateManager, type Certificate } from './certificates.ts';
import { openChallengeListener, type ChallengeListener } from './challenge.ts';
import { catalogContextWindow } from '../pi/auth.ts';
import { checkRouteWindow, ConfigError, defaultRoute, JUDGE_DEFAULTS, loadConfig, type JudgesConfig,
  type ServerConfig } from './config.ts';
import { BrowserSessions } from './browser/session-cookie.ts';
import { WebApp } from './browser/web-app.ts';
import { ConnectionHub } from './connections.ts';
import { Dashboard } from './dashboard.ts';
import { initializeDataDirectory, resolveDataDirectory, STATE_DIRECTORY } from './data-directory.ts';
import { GITHUB_ENDPOINTS, GitHubLogin, type GitHubEndpoints } from './github-login.ts';
import { bearerToken, openListener, type Listener } from './http.ts';
import { acquireProcessLock, type ProcessLock } from './lock.ts';
import { codeManualDirectory, readManualIndex } from './manual.ts';
import { MIGRATIONS } from './migrations.ts';
import { isoAt } from './nightly.ts';
import { createModelRuntime } from './pi-runtime.ts';
import { preparePiState } from './pi-state.ts';
import { parseRegistration, PushNotifier, PushRegistrations } from './push.ts';
import { readSecret, readTlsFiles } from './secrets.ts';
import { SessionStore } from './sessions.ts';
import { SlackDove } from './dove.ts';
import { IMAGE_DIRECTORY, ImageStore } from './images.ts';
import { HttpJevClient } from './jev.ts';
import { LogprobJudgeClient } from './logprob-judge.ts';
import { JUDGE_METHODS, type JudgeClient, type JudgeMethod, type JudgeSlot } from './judge.ts';
import { SLACK_REGISTRATION, SLACK_SOURCE, SlackArchive } from './slack-archive.ts';
import { connectSlack, type SlackConnector } from './slack-api.ts';
import { SlackWorkspace } from './slack.ts';
import { SOURCES_DIRECTORY, SOURCES_GIT_DIRECTORY, WORK_DIRECTORY } from './paths.ts';
import { Sources } from './sources.ts';
import { RuntimeSettings, type RouteControl } from './settings/service.ts';
import { migrate, openStateDatabase } from './state-db.ts';
import { HEARTBEAT_MS, writeStatus, type ServerStatus } from './status.ts';
import { Scheduler } from './scheduler.ts';
import { ThinkingLoop, type RotationOutcome } from './thinking-loop.ts';

const SESSION_SWEEP_MS = 30_000;
/** How often approvals past their time are closed. A minute late is nothing against a week (ADR 0040). */
const APPROVAL_SWEEP_MS = 60_000;

export interface StartOptions {
  config: string;
  dataDir: string | undefined;
  cwd: string;
  home: string;
  /** Where `...Env` secret references are looked up. */
  env: Record<string, string | undefined>;
  /** GitHub's endpoints. Tests point these at a local stub. */
  github?: GitHubEndpoints;
  clock?: () => number;
  /** Receives fixed event lines only: never secrets, tokens or upstream response bodies. */
  log?: (line: string) => void;
  /** ACME polling interval. Tests shorten it. */
  acme?: { pollIntervalMs?: number };
  /** Replaces the configured model route. Tests supply a synthetic runtime and model stream here. */
  pi?: {
    runtime?: () => Promise<ModelRuntime>;
    configureSession?: (session: AgentSession) => void;
  };
  /** Events kept per device stream for replay after a reconnect. */
  streamBufferSize?: number;
  /** Replaces the APNs hosts and the waits between tries. Tests point them at a local stand-in. */
  apns?: { origins?: Record<ApnsEnvironment, string>; retryDelaysMs?: number[] };
  /** Replaces `a2a.pollIntervalSeconds`, whose floor is too long for a test. */
  a2a?: { pollIntervalMs?: number };
  /** Replaces the Slack SDKs. Tests hand in a stand-in for the Web API and Socket Mode. */
  slack?: { connector?: SlackConnector };
  /**
   * Replaces the judges built from `slack.judge`, each where the config has one. Tests hand in stand-ins; nothing reaches
   * a model or TypeSafe from them.
   */
  judge?: { clients?: Partial<Record<JudgeMethod, JudgeClient>> };
  /** Where the browser's bundle is read from (ADR 0058). Tests point it at a directory of their own. */
  web?: { bundleDirectory?: string };
}

type Address = { host: string; port: number };

export interface RunningServer {
  dataDirectory: string;
  config: ServerConfig;
  schemaVersion: number;
  /** The HTTPS (or loopback HTTP) listener; undefined while ACME is still obtaining the first certificate. */
  readonly address: Address | undefined;
  /** Resolves once that listener is open. */
  listening: Promise<Address>;
  /** The plaintext ACME challenge listener; undefined without ACME. */
  readonly challengeAddress: Address | undefined;
  /** Closes connections whose session has expired (also runs periodically). */
  expireSessions(): void;
  /** Obtains or renews the ACME certificate when due and serves it (also runs periodically). Nothing to do without ACME. */
  checkCertificate(): Promise<void>;
  /** Runs the nightly session switch now, as the schedule would. For operation checks. */
  rotateSession(): Promise<RotationOutcome>;
  /** Looks for a route chosen on the command line and follows it between turns (also runs with the heartbeat). */
  refreshRoutes(): Promise<void>;
  /** Reads the runtime settings on file again and tells the devices of a change (also runs with the heartbeat). */
  refreshSettings(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Config and secrets → data directory → lock → migration → Pi state → authenticated listener.
 * No listener opens without GitHub authentication in front of it; the ACME challenge listener has no route to it.
 */
export async function startServer(options: StartOptions): Promise<RunningServer> {
  const config = await loadConfig(resolve(options.cwd, options.config));
  const clientSecret = await readSecret(config.github.clientSecret, 'github.clientSecret', options.env);
  // A key that cannot sign stops startup here, not at the first push.
  const apnsKey = config.apns ? parseApnsKey(await readSecret(config.apns.key, 'apns.key', options.env)) : undefined;
  if (config.apns && !apnsKey) {
    throw new ConfigError('file' in config.apns.key ? 'apns.keyFile' : 'apns.keyEnv',
      'the referenced key is not an EC P-256 private key in PEM (the .p8 file)');
  }
  // Every token is read now, so a missing one stops startup with its setting's name rather than failing later.
  const slackTokens = config.slack ? await Promise.all(Object.entries(config.slack.workspaces).map(async ([name, workspace]) => ({
    name,
    botToken: await readSecret(workspace.botToken, `slack.workspaces.${name}.botToken`, options.env),
    appToken: await readSecret(workspace.appToken, `slack.workspaces.${name}.appToken`, options.env),
  }))) : [];
  const judgeKeys: Partial<Record<JudgeMethod, string>> = {};
  for (const method of JUDGE_METHODS) {
    const reference = config.slack?.judge?.[method]?.apiKey;
    if (reference) judgeKeys[method] = await readSecret(reference, `slack.judge.${method}.apiKey`, options.env);
  }
  const tls = config.listen.tls;
  const tlsFiles = tls && 'certFile' in tls ? await readTlsFiles(tls, 'listen.tls') : undefined;
  const now = options.clock ?? Date.now;
  const log = options.log ?? (() => {});
  // The avatar is read once, here (ADR 0057): what is broken in it stops the start like any other setting, and what it
  // lacks is filled in with the faceless pictures. Everything below takes its name and pictures from this one reading.
  const avatar = await loadAvatar(config.avatar);
  const self = { id: avatar.id, name: avatar.name };
  log(`avatar: ${avatar.id} (${avatar.name}), version ${avatar.version}`);
  for (const item of avatar.filled) log(`avatar: filled with the faceless ${item}`);
  const dataDirectory = await resolveDataDirectory(options.dataDir, options.cwd);
  await initializeDataDirectory(dataDirectory);
  const lock = acquireProcessLock(dataDirectory);
  let db: DatabaseSync | undefined;
  let hub: ConnectionHub | undefined;
  let notifier: PushNotifier | undefined;
  let apns: ApnsClient | undefined;
  let loop: ThinkingLoop | undefined;
  let listener: Listener | undefined;
  let challenge: ChallengeListener | undefined;
  let certificates: CertificateManager | undefined;
  let scheduler: Scheduler | undefined;
  let dove: SlackDove | undefined;
  const slackWorkspaces: SlackWorkspace[] = [];
  const timers: NodeJS.Timeout[] = [];
  // Everything opened above, closed in the reverse order.
  const closeAll = async () => {
    timers.forEach(clearInterval); // The status heartbeat and the session sweep: nothing else waits on them.
    scheduler?.stop(); // Before the listener, so no self-check, ping or nightly switch starts a turn on the way out.
    await Promise.all(slackWorkspaces.map(workspace => workspace.stop())); // Before the loop: no new mention is raised into it.
    dove?.close(); // Nothing more is judged or sent; what was on its way is carried on by the next start.
    notifier?.close(); // Drops the pushes waiting to be tried again: they are kept in memory only (ADR 0029).
    apns?.close();
    await certificates?.close(); // Abandons an ACME order in flight: no certificate arrives at a listener being closed.
    try {
      if (listener) await listener.close(); else await hub?.close(); // Stops serving clients; closing the listener closes the hub with it.
    } finally {
      // The challenge listener answers an order that is already abandoned, so it goes next; the loop is last because
      // a turn in flight still needs its Pi session, and closing it ends that turn rather than cutting it off.
      try { await challenge?.close(); } finally { await loop?.close(); }
    }
  };
  try {
    db = openStateDatabase(join(dataDirectory, STATE_DIRECTORY, 'state.sqlite'));
    const { version } = migrate(db, MIGRATIONS);
    await preparePiState(config.pi, { dataDirectory, home: options.home });
    // What the owner may change while natsumi runs, over the config's values (ADR 0058). Opened before the loop, so its
    // first turn reads the overrides; the loop is reached through this port once it is open.
    const routeControl: RouteControl = {
      get unavailable() { return loop ? loop.unavailable : 'pi-unavailable'; },
      routeStatus: () => loop!.routeStatus(),
      chooseRoute: input => loop!.chooseRoute(input),
      refreshRoutes: () => loop!.refreshRoutes(),
      foldInUse: () => loop?.dashboardState().fold ?? config.loop.turnFold,
    };
    const { turnFold, eventModelCalls, eventTimeoutMinutes, reviewModelCalls, reviewTimeoutMinutes, awakeHours, pingIntervalMinutes,
      timeZone } = config.loop;
    const judges = config.slack?.judge;
    const settings = await RuntimeSettings.open({ dataDirectory, routes: routeControl, now, log, defaults: { turnFold, eventModelCalls,
      eventTimeoutMinutes, reviewModelCalls, reviewTimeoutMinutes, awakeHours, pingIntervalMinutes, timeZone,
      // The dove's judges (ADR 0059): on as the config has them, and only those it has an endpoint for can be turned on.
      judgeLogprobs: judges?.logprobs?.enabled ? 'on' : 'off', judgeJev: judges?.jev?.enabled ? 'on' : 'off',
      judgeAdopted: judges?.adopted ?? JUDGE_DEFAULTS.adopted,
      judgeLogprobsThresholds: judges?.logprobs?.thresholds ?? JUDGE_DEFAULTS.thresholds,
      judgeJevThresholds: judges?.jev?.thresholds ?? JUDGE_DEFAULTS.jev.thresholds, judgeAvailable: { logprobs: judges?.logprobs !== undefined, jev: judges?.jev !== undefined },
      // The curator's night (ADR 0068). A route without the owner's own endpoint reaches an outside service, such as Plus.
      curatorRoute: config.curator.route ?? null, curatorModelCalls: config.curator.modelCalls, curatorTimeoutMinutes: config.curator.timeoutMinutes,
      outsideRoutes: config.pi.routes.filter(route => route.compatible === undefined).map(route => route.name) } });
    // The page on drawing and the sdctl params, for the workspace to read as /manual/avatar (ADR 0057).
    await writeAvatarManual(join(dataDirectory, AVATAR_MANUAL_DIRECTORY), avatar);
    // A subscription model's window is Pi's, not the config's, so its route's threshold is checked here (ADR 0046).
    for (const route of config.pi.routes.filter(candidate => !candidate.compatible)) {
      const window = await catalogContextWindow(config.pi.agentDirectory, { provider: route.model.provider, model: route.model.id });
      if (window !== undefined) checkRouteWindow(config.pi, route, window);
    }

    // One client for the loop and the list: the token file is read afresh on every call either makes (ADR 0033).
    const a2aClient = config.a2a ? new SdkA2AClient({ tokenFile: config.a2a.tokenFile }) : undefined;
    // What she reads of Slack, written under sources/slack (ADR 0039, ADR 0050).
    const slackConfig = config.slack;
    for (const key of slackConfig?.ignored ?? []) log(`config: ${key} is no longer read (ADR 0050); it can be deleted`);
    for (const key of config.loop.ignored ?? []) log(`config: ${key} is no longer read (ADR 0063); it can be deleted`);
    // The images she hands the server from /work (ADR 0044), fetched by the devices by their IDs.
    const images = new ImageStore(db, join(dataDirectory, STATE_DIRECTORY, IMAGE_DIRECTORY));
    const archive = slackConfig ? new SlackArchive({ db, directory: join(dataDirectory, SOURCES_DIRECTORY, SLACK_SOURCE),
      timeZone: config.loop.timeZone, now }) : undefined;
    await archive?.prepare();
    // The core that tells her what changed in them (ADR 0050), when there is anything to read. A history that cannot be
    // kept leaves her the files and no events; the server still starts.
    let sources: Sources | undefined = archive ? new Sources({ db, directory: join(dataDirectory, SOURCES_DIRECTORY),
      gitDirectory: join(dataDirectory, SOURCES_GIT_DIRECTORY), timeZone: config.loop.timeZone, awakeHours: () => settings.awakeHours(),
      activity: config.sources.activity, historyDays: config.sources.historyDays, now, log }) : undefined;
    sources?.register(SLACK_REGISTRATION);
    try { await sources?.prepare(); } catch {
      log('sources: the history could not be prepared; no sources_updated event will be raised');
      sources = undefined;
    }
    const connector = options.slack?.connector ?? connectSlack;
    const slackConnections = archive ? slackTokens.map(({ name, botToken, appToken }) => ({ name, ...connector({ botToken, appToken }) })) : [];

    // The dove (ADR 0040): what natsumi asks to post is judged and sent, or handed to the owner, from here. Its answers
    // are raised into the loop, which is opened next with the dove as one of the agents she can ask.
    let raiseInto: ThinkingLoop | undefined;
    const theDove = dove = archive && slackConfig ? new SlackDove({
      db, archive, workspaces: Object.fromEntries(slackConnections.map(({ name, api }) => [name, api])),
      judges: judgeSlots(slackConfig.judge, judgeKeys, options.judge?.clients), judgeChoice: () => settings.judges(),
      config: { approvalDays: slackConfig.approvalExpiryDays, placementFollowing: slackConfig.placementFollowing,
        judgeContext: slackConfig.judgeContext, images: slackConfig.postImages },
      publicOrigin: config.publicOrigin, workDirectory: join(dataDirectory, WORK_DIRECTORY),
      images,
      now, log, raise: record => raiseInto?.raise('dove-reply', record),
    }) : undefined;
    if (slackConfig) {
      const configured = JUDGE_METHODS.filter(method => slackConfig.judge?.[method]);
      log(slackConfig.judge ? `slack: the judges are ${configured.map(method => `${method} (${slackConfig.judge![method]!.enabled ? 'on' : 'off'})`).join(', ')}; `
        + `${slackConfig.judge.adopted} is adopted` : 'slack: no judge is configured; every draft goes to the owner');
    }

    // The manual's index goes into her instructions (ADR 0056). Without it she is pointed at /manual/INDEX.md instead,
    // which the workspace still holds: a guide that is missing never stops the start.
    const manualIndex = await readManualIndex(await codeManualDirectory());
    if (!manualIndex) log('manual: INDEX.md could not be read; the instructions point at /manual/INDEX.md instead');

    // A missing login or a lost session leaves the loop unavailable; the server still starts so clients can see why.
    const thinkingLoop = loop = await ThinkingLoop.open({
      db, dataDirectory, sessionDirectory: config.pi.sessionDirectory, agentDirectory: config.pi.agentDirectory,
      target: { provider: defaultRoute(config.pi).model.provider, model: defaultRoute(config.pi).model.id }, thinking: config.pi.thinking,
      routes: { defaultRoute: config.pi.defaultRoute, list: config.pi.routes.map(route => ({ name: route.name,
        target: { provider: route.model.provider, model: route.model.id }, compactionThreshold: route.compactionThreshold,
        compatible: route.compatible !== undefined })) },
      runtime: options.pi?.runtime ?? (() => createModelRuntime(config.pi, options.env)),
      configureSession: options.pi?.configureSession, now, log, loop: config.loop, curator: config.curator, self,
      ...(avatar.personality !== undefined ? { personality: avatar.personality } : {}),
      settings: { turnLimits: () => settings.turnLimits(), awakeHours: () => settings.awakeHours(), curator: () => settings.curator() },
      ...(manualIndex ? { manualIndex } : {}),
      ...(config.a2a ? { a2a: config.a2a, a2aClient } : {}),
      ...(sources ? { sources } : {}), ...(theDove ? { dove: theDove } : {}), images,
    });
    raiseInto = thinkingLoop;
    sources?.connect(() => { thinkingLoop.raiseSourcesUpdated(); });
    if (theDove) {
      // What a previous process left on its way, and the approvals whose time ran out while it was stopped.
      theDove.resume();
      theDove.expire();
      void theDove.warmEmoji();
      timers.push(setInterval(() => theDove.expire(), APPROVAL_SWEEP_MS));
    }

    // Each workspace connects in the background: Slack being out of reach, or a token it refuses, must not hold the
    // server's start. The socket reconnects on its own, and every connection fills in what was missed.
    if (archive && slackConfig && !thinkingLoop.unavailable) {
      for (const { name, api, socket } of slackConnections) {
        const workspace = new SlackWorkspace({
          name, api, socket, archive, reaction: slackConfig.reaction, backfillDays: slackConfig.backfillDays,
          maxImageBytes: slackConfig.maxImageBytes, now, log,
          attention: attention => { sources?.attention(attention); },
        });
        slackWorkspaces.push(workspace);
        void workspace.start().then(
          () => { log(`slack (${name}): connecting`); },
          () => { log(`slack (${name}): could not start; check the tokens and the App's settings`); },
        );
      }
    }

    // Who she can ask, for the workspace to show her as /manual/agents (ADR 0036). The cards are fetched in the
    // background: an agent that is down must not hold the server's start.
    void writeAgentList({ directory: join(dataDirectory, AGENT_LIST_DIRECTORY), config: config.a2a, client: a2aClient,
      now: now(), timeZone: config.loop.timeZone, dove: theDove !== undefined }).then(
      ({ listed, unreachable }) => { log(`a2a: wrote the list of agents (${listed.length} listed, ${unreachable.length} out of reach)`); },
      () => { log('a2a: the list of agents could not be written'); },
    );

    // The nightly switch (ADR 0009), self-checks natsumi booked, pings in quiet moments and expressions
    // returning to neutral (ADR 0014). A night missed while stopped is caught up on the first tick.
    if (!thinkingLoop.unavailable) {
      scheduler = new Scheduler({
        loop: thinkingLoop, now, log, timeZone: config.loop.timeZone, awakeHours: () => settings.awakeHours(),
        nightlyRotationAt: config.loop.nightlyRotationAt, pingIntervalMinutes: () => settings.pingIntervalMinutes(),
        expressionResetMinutes: config.loop.expressionResetMinutes, ...(sources ? { sources } : {}),
      });
      scheduler.start();
      // The tasks outside agents are working on, fetched now and then on the interval (ADR 0035). The first round
      // picks up what a previous process was waiting for.
      if (config.a2a) {
        const poll = () => { void thinkingLoop.pollAgents().catch(() => { log('a2a: a round of fetching failed'); }); };
        poll();
        timers.push(setInterval(poll, options.a2a?.pollIntervalMs ?? config.a2a.pollIntervalSeconds * 1000));
      }
    }

    const sessions = new SessionStore(db, now);
    const allowedUserId = config.github.allowedUserId;
    const registrations = new PushRegistrations(db, now);
    // The browser's cookie (ADR 0058): the dashboard, the chat and the settings, the images, and /v1/ws with our Origin.
    const browser = new BrowserSessions({ sessions, allowedUserId, publicOrigin: config.publicOrigin, now });
    const connections = hub = new ConnectionHub({
      publicOrigin: config.publicOrigin, now, db, loop: thinkingLoop, streamBufferSize: options.streamBufferSize, avatarVersion: avatar.version,
      ...(theDove ? { approvals: { pending: () => theDove.pendingApprovals(), decide: input => theDove.decide(input),
        subscribe: listener => theDove.subscribe(listener) } } : {}),
      settings: { view: () => settings.view(), list: () => settings.list(), set: input => settings.set(input), reset: input => settings.reset(input),
        subscribe: listener => settings.subscribe(listener) },
      // Connecting is a use of the session and renews it (ADR 0030). A bearer decides alone; without one, the browser's
      // cookie is taken with the public origin as the Origin only (ADR 0058).
      authenticate: request => {
        const token = bearerToken(request);
        if (token) {
          const session = sessions.verify(token, allowedUserId);
          const expiresAt = session && sessions.renew(session.sessionId);
          return expiresAt ? { session: { ...session!, expiresAt }, via: 'bearer' } : undefined;
        }
        const cookie = browser.upgrade(request);
        if (cookie.kind === 'origin-not-allowed') return { refused: 'origin-not-allowed' };
        return cookie.kind === 'session' ? { session: cookie.session, via: 'cookie' } : undefined;
      },
      renew: sessionId => sessions.renew(sessionId),
      push: {
        register: (deviceId, payload) => {
          const registration = parseRegistration(payload);
          if (!registration) return { kind: 'rejected', code: 'invalid-request' };
          registrations.save(deviceId, registration);
          return { kind: 'accepted', environment: registration.environment };
        },
      },
    });

    // Pushes to the iPhones that are away (ADR 0029). Registrations are kept either way, so adding apns later needs
    // no new registration from the devices.
    if (config.apns && apnsKey) {
      apns = new ApnsClient({ teamId: config.apns.teamId, keyId: config.apns.keyId, topic: config.apns.topic, key: apnsKey, now,
        origins: options.apns?.origins });
      notifier = new PushNotifier({
        db, loop: thinkingLoop, ...(theDove ? { approvals: theDove } : {}), registrations, sender: apns, allowedUserId, isConnected: deviceId => connections.isConnected(deviceId),
        log, retryDelaysMs: options.apns?.retryDelaysMs, name: avatar.name, iconOrigin: config.publicOrigin,
      });
    } else {
      log('push: apns is not configured; registrations are kept and nothing is sent');
    }
    const login = new GitHubLogin({ config: config.github, clientSecret, endpoints: options.github ?? GITHUB_ENDPOINTS, sessions, now, log });
    const dashboard = new Dashboard({ publicOrigin: config.publicOrigin, allowedUserId, sessions, browser, login, loop: thinkingLoop, dataDirectory,
      name: avatar.name, avatarId: avatar.id,
      memoryDirectory: config.loop.memoryRepository ?? join(dataDirectory, 'memory'),
      db, sessionDirectory: config.pi.sessionDirectory, timeZone: config.loop.timeZone, nightlyRotationAt: config.loop.nightlyRotationAt,
      isConnected: deviceId => connections.isConnected(deviceId), now });
    const open = (files: { cert: Buffer; key: Buffer } | undefined) =>
      openListener({ listen: config.listen, tlsFiles: files, login, sessions, hub: connections, allowedUserId, log, dashboard, avatar, browser,
        webApp: new WebApp({ publicOrigin: config.publicOrigin, browser, login, name: avatar.name, bundleDirectory: options.web?.bundleDirectory }),
        // Only what an approval or a line of the conversation shows (ADR 0044, ADR 0045).
        images: { read: async imageId => theDove?.showsImage(imageId) || thinkingLoop.showsImage(imageId) ? images.read(imageId) : undefined } });

    const started = isoAt(Date.now());
    const status: ServerStatus = { state: 'running', pid: process.pid, startedAt: started, updatedAt: started, schemaVersion: version };
    let opened!: (address: Address) => void;
    const listening = new Promise<Address>(resolve => { opened = resolve; });

    // All the certificate manager asks of the server: put a new certificate into the running listener,
    // or open HTTPS with the first one. When it opens is what `status.state` follows.
    const serve = async (certificate: Certificate) => {
      const files = { cert: certificate.cert, key: certificate.key };
      if (listener) return listener.updateCertificate(files);
      listener = await open(files);
      status.state = 'running';
      await writeStatus(dataDirectory, { ...status, updatedAt: isoAt(Date.now()) }).catch(() => {});
      log('listen: HTTPS is open');
      opened(listener.address);
    };

    if (tls && 'acme' in tls) {
      certificates = await CertificateManager.open({
        stateDirectory: join(dataDirectory, STATE_DIRECTORY), hostname: new URL(config.publicOrigin).hostname,
        acme: tls.acme, now, log, pollIntervalMs: options.acme?.pollIntervalMs,
      });
      challenge = await openChallengeListener({
        host: config.listen.host, port: tls.acme.httpPort, publicOrigin: config.publicOrigin, challenges: certificates.challenges,
      });
      // Without a certificate HTTPS stays closed: no self-signed stand-in (ADR 0007).
      if (!certificates.current) status.state = 'waiting-for-certificate';
      await certificates.start(serve);
    } else {
      listener = await open(tlsFiles);
      opened(listener.address);
    }

    const manager = certificates;
    await writeStatus(dataDirectory, status);
    timers.push(setInterval(() => {
      void writeStatus(dataDirectory, { ...status, updatedAt: isoAt(Date.now()) }).catch(() => {});
      // A choice written by the command line while natsumi is idle is followed without waiting for a turn (ADR 0046).
      void thinkingLoop.refreshRoutes().catch(() => { log('thinking loop: the model routes could not be looked at'); });
      // A route or a fold written by the command line, told to the devices as a change of the settings (ADR 0058).
      void settings.refresh().catch(() => { log('settings: the overrides could not be read'); });
    }, HEARTBEAT_MS));
    // A move to another route changes what the settings show in use.
    const unsubscribeRoutes = thinkingLoop.subscribe(event => {
      if (event.type === 'model.routes') void settings.refresh().catch(() => { log('settings: the overrides could not be read'); });
    });
    timers.push(setInterval(() => connections.expireSessions(), SESSION_SWEEP_MS));

    let stopping: Promise<void> | undefined;
    const database = db;
    return {
      dataDirectory, config, schemaVersion: version, listening,
      get address() { return listener?.address; },
      get challengeAddress() { return challenge?.address; },
      expireSessions: () => connections.expireSessions(),
      checkCertificate: () => manager?.checkCertificate() ?? Promise.resolve(),
      rotateSession: () => thinkingLoop.rotate(),
      refreshRoutes: () => thinkingLoop.refreshRoutes(),
      refreshSettings: () => settings.refresh(),
      stop() {
        unsubscribeRoutes();
        stopping ??= (async () => {
          try {
            await closeAll();
            await writeStatus(dataDirectory, { ...status, state: 'stopped', updatedAt: isoAt(Date.now()) });
          } finally { shutdown(database, lock); }
        })();
        return stopping;
      },
    };
  } catch (error) {
    try { await closeAll(); } finally { shutdown(db, lock); }
    throw error;
  }
}

function shutdown(db: DatabaseSync | undefined, lock: ProcessLock) {
  try { db?.close(); } finally { lock.release(); }
}

/** The dove's judges the config has an endpoint for (ADR 0040, ADR 0059), each with its own thresholds. */
function judgeSlots(judges: JudgesConfig | undefined, keys: Partial<Record<JudgeMethod, string>>,
  replaced: Partial<Record<JudgeMethod, JudgeClient>> | undefined): Partial<Record<JudgeMethod, JudgeSlot>> {
  const slots: Partial<Record<JudgeMethod, JudgeSlot>> = {};
  for (const method of JUDGE_METHODS) {
    const judge = judges?.[method];
    if (!judge) continue;
    const apiKey = keys[method];
    const common = { baseUrl: judge.baseUrl, model: judge.model, timeoutMs: judge.timeoutSeconds * 1000, ...(apiKey ? { apiKey } : {}) };
    const client = replaced?.[method] ?? (method === 'jev' ? new HttpJevClient(common)
      : new LogprobJudgeClient({ ...common, concurrency: judge.concurrency ?? JUDGE_DEFAULTS.concurrency }));
    slots[method] = { client, thresholds: judge.thresholds };
  }
  return slots;
}
