import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { AgentSession, AgentSessionEvent, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { routeReady } from '../pi/auth.ts';
import { COMPATIBLE_PROVIDER } from '../pi/compatible.ts';
import { createPersistedPiSession, openPiSession, PiSessionRestoreError, type PiSessionOptions, type PiTarget } from '../pi/session.ts';
import { SdkA2AClient, type A2AClient } from './a2a-client.ts';
import { AgentRequests } from './agent-requests.ts';
import { STATE_DIRECTORY } from './data-directory.ts';
import { DOVE_NAME } from './dove.ts';
import type { A2AConfig, LoopConfig } from './config.ts';
import { ConversationStore, type EventKind, type EventState, type MessageRow,
  type RotationRow, type Transaction } from './conversation-store.ts';
import { discardImages, IMAGE_DIRECTORY, ImageStore, REPLY_IMAGE_LIMITS, shownImage, type ImageLimits, type ShownImage,
  type TakenImage } from './images.ts';
import { readRouteChoice, writeRouteChoice, writeRouteStatus, type RouteStatus, type RouteView } from './model-routes.ts';
import { createLoopTools, type Expression, type LoopToolHost, type ToolOutcome } from './loop-tools.ts';
import { BASE_INSTRUCTION, COMPACTION_INSTRUCTIONS, NO_WORKSPACE_SECTION, REFLECTION_REQUEST, REVIEW_INSTRUCTIONS,
  WORKSPACE_SECTION } from './prompts.ts';
import { readFoldChoice, writeFoldStatus, type Fold } from './fold-setting.ts';
import { turnFoldExtension } from './turn-fold.ts';
import { TurnStats, type Confusion, type TokenCounts } from './turn-stats.ts';
import { ALWAYS_FILE, HANDOFF_FILE, MemoryRepository, PERSONALITY_FILE, revertNotice } from './memory-repository.ts';
import { WorkspaceShell } from './workspace-shell.ts';
import { WorkspaceSize } from './workspace-size.ts';
import { checkOutgoingText, refusalText } from './output-checks.ts';
import { ReadState, type ReadPosition } from './read-state.ts';
import { isoAt, localDateTime } from './nightly.ts';
import { HOME_DIRECTORY, SOURCES_DIRECTORY, WORK_DIRECTORY } from './paths.ts';
import { SelfChecks } from './scheduler.ts';
import { takeUpdates, type UpdateSource } from './updates.ts';
import { parseView, viewImage } from './view.ts';

/** notify_owner is limited per turn and per rolling hour (ADR 0008). */
export const DEFAULT_NOTIFY_LIMITS = { perTurn: 3, perHour: 12 };
/** The newest messages a snapshot carries. */
export const SNAPSHOT_MESSAGE_LIMIT = 500;
/** The longest the line of thinking sent to the Mac may be; a longer one keeps its newest end (ADR 0017). */
export const THINKING_LINE_MAX_CHARS = 120;
/** The least time between two lines of thinking. What is written in between is thinned out. */
export const THINKING_MIN_INTERVAL_MS = 250;
/** The longest the memo after a turn may take (ADR 0047). It is one short line, asked without thinking. */
export const REFLECTION_TIMEOUT_MS = 120_000;

export type UnavailableCode = 'pi-unavailable' | 'conversation-restore-failed' | 'stopping';
export type { EventKind, EventState };

/** How a nightly switch ended. A failed switch leaves the current session in place. */
export type RotationOutcome =
  | { result: 'switched' }
  | { result: 'skipped'; reason: 'empty-session' }
  | { result: 'failed'; reason: string };

/** An event for clients. `conversation.message`, `avatar.expression` and `conversation.event.completed`. */
export interface LoopClientEvent {
  type: string;
  payload: Record<string, unknown>;
  /** Of the moment: sent to whoever is connected, never numbered on a stream and never kept for replay (ADR 0017). */
  ephemeral?: boolean;
}

export type SendOutcome =
  | { kind: 'accepted'; messageId: string; eventId: string; state: EventState }
  | { kind: 'rejected'; code: 'request-conflict' }
  | { kind: 'unavailable'; code: UnavailableCode };

/** Only a message that does not exist (or, for an acknowledgement, is not a notice) is refused. */
export type ReadOutcome =
  | ({ kind: 'accepted' } & ReadPosition)
  | { kind: 'rejected'; code: 'invalid-request' }
  | { kind: 'unavailable'; code: UnavailableCode };

export type AcknowledgeOutcome =
  | { kind: 'accepted'; notificationId: string; acknowledgedAt: string }
  | { kind: 'rejected'; code: 'invalid-request' }
  | { kind: 'unavailable'; code: UnavailableCode };

/** A message as the owner sees it. */
export interface ShownMessage {
  messageId: string;
  role: 'owner' | 'natsumi';
  kind: 'message' | 'reply' | 'notice';
  text: string;
  createdAt: string;
  /** An owner message's event. */
  eventId?: string;
  /** The event of the newest owner message a reply answered. Absent on a reply that answered none (ADR 0032). */
  replyTo?: string;
  /** The events a notice is about. */
  about?: string[];
  /** The feeling natsumi chose for one of her lines. Absent on the owner's messages and on lines older than ADR 0026. */
  expression?: Expression;
  /** The images a reply shows, in her order (ADR 0045). Absent, rather than empty, on a line that shows none. */
  images?: ShownImage[];
}

/** A type rather than an interface: it is a client event's payload, and is spread into one whole. */
export type LoopSnapshot = {
  messages: ShownMessage[];
  /** Owner messages not handled yet. */
  pendingEvents: { eventId: string; messageId: string; state: EventState }[];
  avatar: { expression: Expression };
  /** The read cursor and the replies after it, including those older than `messages`. */
  readThroughMessageId: string | null;
  unreadReplyCount: number;
  /** Every notice the owner has not checked, oldest first, including those older than `messages`. */
  unacknowledgedNotificationIds: string[];
  /** The model routes, the one in use and the one chosen (ADR 0046). */
  modelRoutes: RouteStatus;
};

/** One model route as the loop uses it (ADR 0046): the model, and when a session on it is compacted. */
export interface LoopRoute {
  name: string;
  target: PiTarget;
  compactionThreshold: number;
  /** Whether it is the owner's own endpoint, reached with a key rather than a login. */
  compatible: boolean;
}

/** The owner asked for a route: what is chosen now, and the route still in use until the next turn. */
export type ChooseRouteOutcome =
  | { kind: 'accepted'; chosen: string; current: string }
  | { kind: 'rejected'; code: 'unknown-route' | 'route-unavailable' }
  | { kind: 'unavailable'; code: UnavailableCode };

export interface LoopOptions {
  /** Handed straight to the stores the loop opens on it; the loop itself never reads a table. */
  db: DatabaseSync;
  dataDirectory: string;
  sessionDirectory: string;
  agentDirectory: string;
  /** The model when there are no `routes`: one route named `default`, compacted at `loop.compactionThreshold`. */
  target: PiTarget;
  /** The routes the owner switches between by hand (ADR 0046); `target` is then unused. */
  routes?: { list: LoopRoute[]; defaultRoute: string };
  thinking: 'on' | 'off';
  runtime: () => Promise<ModelRuntime>;
  /** Called with every Pi session before its first prompt. Tests replace the model stream here. */
  configureSession?: (session: AgentSession) => void;
  /**
   * The `loop` section of the config, as `parseLoop` made it. It arrives complete: every default is already
   * applied there, so nothing here falls back again. `nightlyRotationAt`, `pingIntervalMinutes` and
   * `expressionResetMinutes` are the server's and the scheduler's, and the loop leaves them alone.
   */
  loop: LoopConfig;
  /** The outside agents natsumi may ask (ADR 0035). Without it `ask_agent` is still there, and refuses. */
  a2a?: A2AConfig;
  /** Replaces the SDK client built from `a2a`. */
  a2aClient?: A2AClient;
  /**
   * What natsumi reads besides her memory (ADR 0039). Their `updates` ride on pings and self-checks. The loop knows
   * neither how many there are nor what they read.
   */
  updates?: readonly UpdateSource[];
  /** What a Slack mention event is made of when it is handed to her: its line, and the images beside it. */
  slack?: SlackEvents;
  /**
   * The dove (ADR 0040): `ask_agent` with the agent `poppo` goes here rather than to an outside agent, and its answers
   * come back as `dove-reply` events. Present only when Slack is configured.
   */
  dove?: DoveEvents;
  notifyLimits?: { perTurn: number; perHour: number };
  /** Where the images of her replies are copied and recorded; by default the server's own image directory (ADR 0045). */
  images?: ImageStore;
  /** How large and how many the images of one reply may be. */
  replyImageLimits?: ImageLimits;
  now?: () => number;
  log?: (line: string) => void;
}

/** The side of Slack the loop reads a mention event from (ADR 0039). */
export interface SlackEvents {
  eventLine(eventId: string, receivedAt: string): Record<string, unknown>;
  images(eventId: string): Promise<ImageContent[]>;
}

/** The side of the dove the loop talks to: a request, and the line of each answer. */
export interface DoveEvents {
  ask(message: string): ToolOutcome | Promise<ToolOutcome>;
  takeEventLine(eventId: string, receivedAt: string): Record<string, unknown>;
}

/** The kinds of event something outside the loop may raise. */
export type RaisedKind = 'slack-mention' | 'dove-reply';

type FinishTurn = NonNullable<AgentSession['agent']['finishTurn']>;
type StopContext = Parameters<FinishTurn>[0];

/**
 * An event handed to Pi in the current turn. Only owner messages have a message. `shown` is whether natsumi has it
 * in front of her yet: a steered event waits for the next model-call boundary, and a reply sent before then is not
 * an answer to it (ADR 0024).
 */
interface Handling { eventId: string; messageId?: string; replied: boolean; shown: boolean }
interface Turn {
  kind: 'events' | 'review';
  calls: number; maxCalls: number; limited: boolean; timedOut: boolean; notices: number;
  /** When it started, and her first reply to the owner or request to the dove in it (ADR 0047). */
  startedAt: number; firstOutAt?: number;
  /** Requests the dove turned back in it (ADR 0047). */
  doveRefusals: number;
  /** The review's rotation, whether it wrote its handoff, and what it said about the night (ADR 0020). */
  rotationId?: string; handoffWritten?: true; changeNote?: string;
}

/**
 * The single thinking loop (ADR 0008): one Pi session that takes events one at a time and acts only through tools.
 *
 * Owner messages are recorded before they are acknowledged, shown to every device at once, and handed to Pi as
 * events. A message that arrives while Pi is working is steered into the running turn at the next model-call boundary.
 * What the owner sees is kept in SQLite; the Pi session is the separate record of thinking. The rows themselves
 * belong to `ConversationStore` and `ReadState`: what is left here is the state machine over them.
 *
 * Long-term memory lives in `memory/`, reached through tools, and is a git repository: at the end of every turn the
 * server checks what changed there, puts back what fails, and commits the rest (ADR 0018). Each night the session is
 * reviewed and replaced by a new one that starts from a handoff; in between, a session past its limit is compacted
 * (ADR 0009).
 */
export class ThinkingLoop {
  private readonly options: LoopOptions;
  private readonly now: () => number;
  private readonly memoryRepository: MemoryRepository;
  private readonly store: ConversationStore;
  private readonly images: ImageStore;
  private readonly workspaceSize: WorkspaceSize;
  private readonly readState: ReadState;
  private readonly shell: WorkspaceShell | undefined;
  private readonly listeners = new Set<(event: LoopClientEvent) => void>();
  private readonly queue: string[] = [];
  private readonly handling = new Map<string, Handling>();
  /**
   * Prompt text of steered events → their event IDs, oldest first, to take back steering Pi did not deliver. The
   * lines carry no event ID (ADR 0024), so two messages with the same text in the same millisecond share a key.
   */
  private readonly steered = new Map<string, string[]>();
  private readonly idleWaiters: (() => void)[] = [];
  private readonly rotationWaiters = new Map<string, ((outcome: RotationOutcome) => void)[]>();
  private modelRuntime: ModelRuntime | undefined;
  private session: AgentSession | undefined;
  private unavailableCode: UnavailableCode | undefined;
  private turn: Turn | undefined;
  private running: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  /** After a failed compaction, the context size it waits to exceed before trying again. */
  private compactionRetryAbove: number | undefined;
  private avatar: { expression: Expression; by: 'server' | 'model'; changedAt: number };
  private readonly selfChecks: SelfChecks;
  private readonly agents: AgentRequests;
  /** When something last arrived or was last handled: the quiet interval before a ping counts from here (ADR 0014). */
  private activityAt: number;
  /** A nightly switch is under way; natsumi sleeps through it. */
  private rotating = false;
  /** The line of thinking being written, the one last sent, and when it went (ADR 0017). */
  private readonly thinking = { line: '', sent: '', at: 0 };
  /** Stops watching the Pi session the loop is attached to. */
  private unwatch: (() => void) | undefined;
  /** What the last commit put back, waiting to be told to natsumi in the next prompt (ADR 0018). */
  private memoryNotice = '';
  /** What the persistent places hold, when they are past the warning; it waits for the next prompt (ADR 0019). */
  private workspaceNotice = '';
  /** The routes, the default, the route the session is on (unset until it is open) and the route chosen (ADR 0046). */
  private readonly routes: { list: LoopRoute[]; defaultRoute: string };
  private route: LoopRoute | undefined;
  private chosen: string;
  /** Whether each route could be used when last looked at, for snapshots, which cannot wait. */
  private readiness = new Map<string, boolean>();
  /** The status last told to the devices and written for the command line. */
  private published = '';
  /** A route that was chosen and found not ready, logged once until the choice changes. */
  private refusedRoute: string | undefined;
  /** A choice came in: the next unit of work follows it even when no event is waiting. */
  private routeWanted = false;
  /** Whether ended turns are folded now (ADR 0047). Read before every turn, so it changes only between them. */
  private fold: Fold;
  /** The fold status last written for the command line. */
  private foldPublished = '';
  /** The model call in progress is the memo after a turn: it ends after one call and may use no tool. */
  private reflecting = false;
  private readonly turnStats: TurnStats;

  private constructor(options: LoopOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    const loop = options.loop;
    // One directory, two ways in: the shell writes the files, and the repository is what commits them.
    const memoryDirectory = loop.memoryRepository ?? join(options.dataDirectory, 'memory');
    this.memoryRepository = new MemoryRepository({
      directory: memoryDirectory, dataDirectory: options.dataDirectory, fileMaxChars: loop.memoryFileMaxChars,
      alwaysMaxChars: loop.alwaysMemoryMaxChars,
      log: line => this.log(line),
    });
    this.store = new ConversationStore(options.db, this.now);
    this.images = options.images ?? new ImageStore(options.db, join(options.dataDirectory, STATE_DIRECTORY, IMAGE_DIRECTORY));
    this.readState = new ReadState(options.db, this.now);
    this.shell = loop.workspaceSocket
      ? new WorkspaceShell({
        socketPath: loop.workspaceSocket,
        timeoutMs: loop.shellWaitSeconds * 1000,
        timeZone: loop.timeZone,
        memoryChanges: () => this.memoryRepository.changeSummary(),
      })
      : undefined;
    // The three places that survive a restart, under the names natsumi sees inside the container (ADR 0019).
    this.workspaceSize = new WorkspaceSize({
      places: [{ label: '/memory', path: memoryDirectory },
        { label: '/work', path: join(options.dataDirectory, WORK_DIRECTORY) },
        { label: '/home/natsumi', path: join(options.dataDirectory, HOME_DIRECTORY) }],
      warnBytes: loop.workspaceSizeWarnBytes,
      now: this.now,
    });
    this.selfChecks = new SelfChecks({ db: options.db, now: this.now, timeZone: loop.timeZone,
      limits: loop.selfCheck, awakeHours: loop.awakeHours });
    const { a2a } = options;
    this.agents = new AgentRequests({
      db: options.db, now: this.now, config: a2a,
      client: options.a2aClient ?? (a2a ? new SdkA2AClient({ tokenFile: a2a.tokenFile }) : undefined),
      raise: record => this.raiseAgentReply(record), log: line => this.log(line),
    });
    this.activityAt = this.now();
    this.avatar = { expression: 'neutral', by: 'server', changedAt: this.activityAt };
    this.routes = options.routes ?? { defaultRoute: 'default', list: [{ name: 'default', target: options.target,
      compactionThreshold: loop.compactionThreshold,
      compatible: options.target.provider === COMPATIBLE_PROVIDER || options.target.provider.startsWith(`${COMPATIBLE_PROVIDER}-`) }] };
    this.chosen = this.routes.defaultRoute;
    this.fold = loop.turnFold;
    this.turnStats = new TurnStats(options.db);
  }

  /**
   * Opens or creates the Pi session. Problems leave the loop unavailable instead of throwing or replacing history.
   * The memory repository is the exception: without it nothing natsumi writes could be kept, so it is made first
   * and a failure there stops the server with the reason (ADR 0018).
   */
  static async open(options: LoopOptions): Promise<ThinkingLoop> {
    const loop = new ThinkingLoop(options);
    await loop.memoryRepository.initialize(loop.store.carriedOverHandoff());
    // The repository holds it now, so the copy schema 8 set aside goes: the handoff lives in one place (ADR 0020).
    loop.store.clearCarriedOverHandoff();
    await loop.start();
    return loop;
  }

  get unavailable(): UnavailableCode | undefined {
    return this.unavailableCode ?? (this.closing ? 'stopping' : undefined);
  }

  subscribe(listener: (event: LoopClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Records an owner message and its event, then answers. Client events follow on a microtask, so the caller can
   * deliver `command.accepted` first.
   */
  send(input: { requestId: string; deviceId: string; text: string }): SendOutcome {
    const unavailable = this.unavailable;
    if (unavailable) return { kind: 'unavailable', code: unavailable };
    const existing = this.store.existingByRequest(input.requestId);
    if (existing) {
      if (existing.text !== input.text || existing.device_id !== input.deviceId) return { kind: 'rejected', code: 'request-conflict' };
      return { kind: 'accepted', messageId: existing.message_id, eventId: existing.event_id, state: existing.state };
    }

    const { row, eventId } = this.store.insertOwnerMessage(input);
    this.activityAt = this.now();
    let state: EventState = 'queued';
    const session = this.session!;
    const reviewing = this.turn?.kind === 'review' || this.isRotationQueuedFirst();
    if (this.turn?.kind === 'events' && session.isStreaming) {
      // Steered in at the next model-call boundary; the thought in progress is not interrupted (Q1).
      this.beginHandling(eventId, row.message_id, false);
      const prompt = formatEvents([this.eventLine(eventId)]);
      this.steered.set(prompt, [...this.steered.get(prompt) ?? [], eventId]);
      void session.steer(prompt);
      state = 'processing';
    } else {
      // During the nightly switch or a compaction the message waits, and is handled by the session that follows.
      this.queue.push(eventId);
    }
    queueMicrotask(() => {
      this.emit('conversation.message', shown(row));
      // The server shows that natsumi is thinking without waiting for the model (Q2); asleep, she stays asleep.
      if (!reviewing) this.setAvatar('thinking', 'server');
      this.pump();
    });
    return { kind: 'accepted', messageId: row.message_id, eventId, state };
  }

  /**
   * Marks natsumi's replies read up to a message, for every device (ADR 0013). A position behind the cursor is ignored
   * and the current one returned. Only a move is broadcast, after the answer.
   */
  markRead(input: { throughMessageId: string; deviceId: string }): ReadOutcome {
    const unavailable = this.unavailable;
    if (unavailable) return { kind: 'unavailable', code: unavailable };
    const result = this.readState.markRead(input.throughMessageId, input.deviceId);
    if (!result) return { kind: 'rejected', code: 'invalid-request' };
    const { changed, ...position } = result;
    if (changed) queueMicrotask(() => this.emit('conversation.read', position));
    return { kind: 'accepted', ...position };
  }

  /** Records that the owner checked a notice. Acknowledging it again returns the first record and broadcasts nothing. */
  acknowledgeNotice(input: { notificationId: string; deviceId: string }): AcknowledgeOutcome {
    const unavailable = this.unavailable;
    if (unavailable) return { kind: 'unavailable', code: unavailable };
    const result = this.readState.acknowledge(input.notificationId, input.deviceId);
    if (!result) return { kind: 'rejected', code: 'invalid-request' };
    const acked = { notificationId: input.notificationId, acknowledgedAt: result.acknowledgedAt };
    if (result.changed) queueMicrotask(() => this.emit('notification.acked', acked));
    return { kind: 'accepted', ...acked };
  }

  /**
   * Reviews the day in the current session and switches to a new one that starts from the review's handoff.
   * Resolves once the switch has ended; a switch already waiting or running is joined rather than repeated.
   */
  rotate(): Promise<RotationOutcome> {
    const unavailable = this.unavailable;
    if (unavailable) return Promise.resolve({ result: 'failed', reason: unavailable });
    let eventId = this.store.pendingRotation();
    if (!eventId) {
      eventId = this.store.insertEvent('nightly-review');
      this.queue.push(eventId);
    }
    const id = eventId;
    return new Promise(resolve => {
      this.rotationWaiters.set(id, [...(this.rotationWaiters.get(id) ?? []), resolve]);
      this.pump();
    });
  }

  /** When the current Pi session began: its switch, or the conversation's creation. */
  sessionStartedAt(): number | undefined {
    const row = this.store.conversation();
    if (!row) return undefined;
    return Date.parse(this.store.switchedAt(row.pi_session_id) ?? row.created_at);
  }

  /** The conversation shown to the owner, built from SQLite only. Pi's record never appears here. */
  snapshot(): LoopSnapshot {
    return {
      messages: this.shownRows(this.store.snapshotRows(SNAPSHOT_MESSAGE_LIMIT)),
      pendingEvents: this.store.pendingEvents(),
      avatar: { expression: this.avatar.expression },
      ...this.readState.position(),
      unacknowledgedNotificationIds: this.readState.unacknowledgedNotificationIds(),
      modelRoutes: this.routeStatus(),
    };
  }

  /** The model routes as the owner is shown them (ADR 0046). */
  routeStatus(): RouteStatus {
    return {
      defaultRoute: this.routes.defaultRoute, current: this.route?.name ?? null, chosen: this.chosen,
      routes: this.routes.list.map(({ name, target }): RouteView =>
        ({ name, provider: target.provider, model: target.model, ready: this.readiness.get(name) ?? false })),
    };
  }

  /**
   * The owner chose a route (ADR 0046). It is recorded where the command line records it too, and the session moves
   * to it between turns: at once when idle, otherwise when the turn in progress ends. Never automatically (ADR 0004).
   */
  async chooseRoute(input: { route: string; deviceId: string }): Promise<ChooseRouteOutcome> {
    const unavailable = this.unavailable;
    if (unavailable) return { kind: 'unavailable', code: unavailable };
    const route = this.routes.list.find(candidate => candidate.name === input.route);
    if (!route) return { kind: 'rejected', code: 'unknown-route' };
    if (!(await this.isReady(route))) return { kind: 'rejected', code: 'route-unavailable' };
    await writeRouteChoice(this.options.dataDirectory, route.name, this.now());
    this.chosen = route.name;
    this.routeWanted = true;
    this.pump();
    return { kind: 'accepted', chosen: route.name, current: this.route!.name };
  }

  /**
   * Looks again at the choice the command line may have written and at which routes are ready. A new choice is
   * followed between turns, as `chooseRoute`'s is; waits only for that, never for a turn.
   */
  async refreshRoutes(): Promise<void> {
    if (this.unavailable || !this.session) return;
    const chosen = await this.readChoice();
    if (chosen !== this.chosen || chosen !== this.route?.name) {
      this.routeWanted = true;
      if (!this.running) { this.pump(); await this.running; return; }
    }
    this.chosen = chosen;
    await this.publishRoutes();
  }

  /** Whether a line of the conversation shows the image, so that the devices may fetch it (ADR 0045). */
  showsImage(imageId: string): boolean {
    return this.store.showsImage(imageId);
  }

  private shownRows(rows: MessageRow[]): ShownMessage[] {
    const images = this.store.messageImages(rows.map(row => row.message_id));
    return rows.map(row => shown(row, images.get(row.message_id)));
  }

  /** No turn is running and nothing is waiting: the scheduler may raise an event. */
  get quiet(): boolean {
    return !this.running && this.queue.length === 0 && !this.closing && !this.unavailableCode && this.session !== undefined;
  }

  get lastActivityAt(): number { return this.activityAt; }

  /**
   * Hands every due self-check to the loop as one event, however many there are and however late (ADR 0014).
   * The checks are marked delivered together with the event, so none is handed over twice.
   */
  deliverDueSelfChecks(): boolean {
    if (!this.quiet) return false;
    const due = this.selfChecks.due();
    if (due.length === 0) return false;
    const eventId = this.store.transaction(transaction => {
      const id = this.store.insertEvent('self-check');
      this.selfChecks.deliver(due.map(check => check.checkId), id, transaction);
      return id;
    });
    this.queue.push(eventId);
    this.pump();
    return true;
  }

  /**
   * Fetches once the tasks outside agents are still working on, and hands natsumi each that settled (ADR 0035).
   * The server calls it on the interval `a2a.pollIntervalSeconds` sets, and once on a start, which picks up again what
   * a previous process was waiting for.
   */
  pollAgents(): Promise<void> {
    if (this.unavailable) return Promise.resolve();
    return this.agents.poll();
  }

  /**
   * An agent's answer, as an event of its own. It waits behind whatever is running rather than being steered in:
   * nobody is waiting on it the way the owner waits on a reply (ADR 0036).
   */
  private raiseAgentReply(record: (eventId: string, transaction: Transaction) => void): void {
    this.raise('agent-reply', record);
  }

  /**
   * An event raised from outside the loop, such as a Slack mention (ADR 0039). The caller's own rows are written in
   * the event's transaction, so neither is ever recorded without the other. Like an agent's answer it waits behind
   * whatever is running: it is queued, not steered in.
   */
  raise(kind: RaisedKind | 'agent-reply', record: (eventId: string, transaction: Transaction) => void): void {
    const eventId = this.store.transaction(transaction => {
      const id = this.store.insertEvent(kind);
      record(id, transaction);
      return id;
    });
    this.queue.push(eventId);
    this.pump();
  }

  /** Hands the loop a ping: the "anything you want to do?" of a quiet moment (ADR 0014). */
  ping(): boolean {
    if (!this.quiet) return false;
    this.queue.push(this.store.insertEvent('ping'));
    this.pump();
    return true;
  }

  /**
   * Returns the avatar to neutral once an expression has been shown for `afterMs`. Thinking is released when the
   * handling ends instead, and natsumi stays asleep through the nightly switch.
   */
  relaxExpression(afterMs: number): void {
    const { expression, changedAt } = this.avatar;
    if (expression === 'neutral' || expression === 'thinking' || this.rotating) return;
    if (this.now() - changedAt >= afterMs) this.setAvatar('neutral', 'server');
  }

  /** Resolves when no turn is running and nothing is queued. */
  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  /** Refuses new messages, stops the turn in progress, records its events and releases the Pi session. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.agents.close();
      if (this.running && this.session) {
        this.session.abortCompaction();
        await this.session.abort();
        await this.running;
      }
      this.unwatch?.();
      this.unwatch = undefined;
      this.session?.dispose();
      for (const resolve of this.idleWaiters.splice(0)) resolve();
      for (const [eventId, waiters] of this.rotationWaiters) {
        this.rotationWaiters.delete(eventId);
        for (const resolve of waiters) resolve({ result: 'failed', reason: 'stopped' });
      }
    })();
    return this.closing;
  }

  private async start() {
    const { sessionDirectory } = this.options;
    try { this.modelRuntime = await this.options.runtime(); } catch { return this.fail('pi-unavailable'); }
    // The chosen route, as it was left: a restart does not undo a switch (ADR 0046). One that is not ready is not
    // replaced by another; natsumi cannot talk until it is, or until another is chosen and the server restarted.
    this.chosen = await this.readChoice();
    const route = this.routes.list.find(candidate => candidate.name === this.chosen)!;
    if (!(await this.isReady(route))) {
      this.log(`thinking loop: the model route ${route.name} is not ready`);
      await this.publishRoutes();
      return this.fail('pi-unavailable');
    }
    this.route = route;
    await this.followFold();
    this.closeInterruptedReviews();
    const row = this.store.conversation();
    let created: AgentSession | undefined;
    try {
      if (row) {
        const unfinished = this.store.unfinishedRotation(row.conversation_id, row.pi_session_id);
        if (unfinished) {
          // A switch stopped after its handoff was committed: finish it rather than lose the review or start blank.
          created = await createPersistedPiSession(await this.sessionOptions());
          this.commitSwitch(unfinished, created);
          this.log('thinking loop: an interrupted nightly switch was finished');
          this.session = created;
        } else {
          const file = resolve(sessionDirectory, row.pi_session_file);
          const rel = relative(sessionDirectory, file);
          if (rel.startsWith('..') || isAbsolute(rel)) throw new PiSessionRestoreError('Pi session reference outside the session directory');
          this.session = await openPiSession({ ...await this.sessionOptions(), file, expectedSessionId: row.pi_session_id });
        }
      } else {
        created = await createPersistedPiSession(await this.sessionOptions());
        this.store.insertConversation(created.sessionId, relative(sessionDirectory, created.sessionFile!));
        this.session = created;
      }
    } catch (error) {
      created?.dispose();
      this.session = undefined;
      this.route = undefined;
      await this.publishRoutes();
      return this.fail(error instanceof PiSessionRestoreError ? 'conversation-restore-failed' : 'pi-unavailable');
    }
    this.attach(this.session);
    await this.publishRoutes();
    this.recover();
    this.pump();
  }

  private async sessionOptions(): Promise<Omit<PiSessionOptions, 'file' | 'expectedSessionId'>> {
    const { dataDirectory, sessionDirectory, agentDirectory } = this.options;
    const tools = createLoopTools(this.host());
    return {
      cwd: dataDirectory, agentDir: agentDirectory, sessionDir: sessionDirectory, modelRuntime: this.modelRuntime!, target: this.route!.target,
      systemPrompt: await this.systemPrompt(),
      thinkingLevel: this.thinkingLevel(),
      tools: { names: tools.map(tool => tool.name), definitions: tools },
      keepRecentTokens: this.options.loop.compactionKeepRecent,
      extensions: [turnFoldExtension({ folding: () => this.fold === 'on', reflecting: () => this.reflecting })],
    };
  }

  /** natsumi's thinking level, the one configured, on every route. Only the memo after a turn goes without. */
  private thinkingLevel(): 'medium' | 'off' {
    return this.options.thinking === 'on' ? 'medium' : 'off';
  }

  private attach(session: AgentSession) {
    this.session = session;
    this.options.configureSession?.(session);
    this.unwatch?.();
    // The thinking in progress is read off the session, never out of the record it writes.
    this.unwatch = session.subscribe(event => {
      this.watchSteering(event);
      this.watchThinking(event);
    });
    // Every steered message waiting at a boundary goes in together.
    session.setSteeringMode('all');
    // Pi keeps its own hook here, so the limit is chained after it. Errors and aborts end the run anyway and are not
    // model calls that came back, so they are not counted.
    const finish = session.agent.finishTurn;
    session.agent.finishTurn = async (turn, signal) => {
      const decision = await finish?.(turn, signal) ?? undefined;
      // The memo is one call, whatever it did (ADR 0047).
      if (this.reflecting) return { action: 'end' };
      if (turn.message.stopReason === 'error' || turn.message.stopReason === 'aborted') return decision;
      return this.shouldStop(turn) ? { action: 'end' } : decision;
    };
  }

  private fail(code: UnavailableCode) {
    this.unavailableCode = code;
    this.log(`thinking loop unavailable: ${code}`);
  }

  private log(line: string) { this.options.log?.(line); }

  /**
   * The instructions: natsumi's base, the personality, the always-memory and the handoff. Memories themselves are
   * never included; they are read through tools when needed.
   *
   * The sections stand in the order of how often they move, the steadiest first, so that a change to one of them
   * leaves as much of the prefix as possible in front of it: the personality is rewritten rarely, the always-memory
   * at some nights, the handoff at every one of them.
   *
   * All three are read from the working tree as it stands, including on a restart: the prompt is not rebuilt from
   * the commits a switch recorded, which would buy a rare day's prefix cache with a complication carried every day
   * (ADR 0020). The always-memory's length is never looked at here: the limit is put on the writing instead, so what
   * is in the repository is already short enough — and what the owner put there by hand arrives whole, which is what
   * someone who just edited a file expects.
   */
  private async systemPrompt(): Promise<string> {
    const read = async (file: string) => {
      try { return sectionBody(await readFile(join(this.memoryRepository.directory, file), 'utf8')); } catch { return ''; }
    };
    const personality = await read(PERSONALITY_FILE);
    const always = await read(ALWAYS_FILE);
    const handoff = await read(HANDOFF_FILE);
    const instruction = BASE_INSTRUCTION(this.shell ? WORKSPACE_SECTION : NO_WORKSPACE_SECTION);
    let prompt = personality ? `${instruction}\n\n# 性格・話し方\n\n${personality}` : instruction;
    if (always) prompt += `\n\n# 常時記憶\n\nいつも思い出しておきたいことを書いたメモです。\n\n${always}`;
    if (handoff) prompt += `\n\n# 前の思考の記録からの引き継ぎ\n\n前の自分が、次の自分に残したメモです。\n\n${handoff}`;
    // A review turn has no next turn, so what its commit put back rides in the new session's instructions instead.
    const notice = this.takeMemoryNotice();
    if (notice) prompt += `\n\n# 記憶の検査\n\n${notice}`;
    return prompt;
  }

  /** The note about reverted files, taken once: whoever writes the next prompt carries it. */
  private takeMemoryNotice(): string {
    const notice = this.memoryNotice;
    this.memoryNotice = '';
    return notice;
  }

  /**
   * The note about how much the persistent places hold, taken once. It only ever rides on a turn's prompt, never in
   * the instructions: what changes every turn must stay off the prefix cache (ADR 0019).
   */
  private takeWorkspaceNotice(): string {
    const notice = this.workspaceNotice;
    this.workspaceNotice = '';
    return notice;
  }

  /** Measures the persistent places, at most once every ten minutes, and keeps the line for the next turn. */
  private async checkWorkspaceSize(): Promise<void> {
    try {
      const notice = await this.workspaceSize.check();
      if (notice) {
        this.workspaceNotice = notice;
        this.log('workspace: the persistent directories are past the size warning');
      }
    } catch {
      // Measuring is a courtesy; a directory that cannot be walked never stops a turn.
    }
  }

  /**
   * Events a previous process left behind. Queued ones run again; one that was being handled is never handed to Pi
   * twice: it counts as replied if its reply was recorded, and as failed otherwise.
   */
  private recover() {
    const { closed, queued } = this.store.recover();
    if (closed > 0) this.log(`thinking loop: ${closed} interrupted event(s) closed`);
    this.queue.push(...queued);
  }

  /** Reviews stopped before writing a handoff, and switches that no longer start from the current session, have failed. */
  private closeInterruptedReviews() {
    const row = this.store.conversation();
    if (this.store.closeInterruptedReviews(row?.pi_session_id ?? null) > 0) {
      this.log('thinking loop: an interrupted nightly switch left the session as it was');
    }
  }

  private pump() {
    if (this.running || this.closing || this.unavailableCode || !this.session) { this.settle(); return; }
    const eventId = this.queue.shift();
    if (!eventId && !this.routeWanted) { this.settle(); return; }
    this.routeWanted = false;
    // Every unit of work starts on the chosen route, so a switch always falls between turns (ADR 0046).
    const work = (async () => {
      await this.followRoute();
      await this.followFold();
      if (!eventId) return;
      if (this.store.eventKind(eventId) === 'nightly-review') { await this.runRotation(eventId); return; }
      const turn = await this.runTurn([eventId], 'events');
      const reflection = await this.reflect(turn);
      const compacted = await this.maintain();
      this.recordTurn(turn, reflection, compacted);
    })();
    this.running = work.finally(() => {
      this.running = undefined;
      this.activityAt = this.now();
      this.pump();
    });
  }

  private settle() {
    if (this.running || this.queue.length > 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private isRotationQueuedFirst(): boolean {
    const first = this.queue[0];
    if (!first || this.running) return false;
    return this.store.eventKind(first) === 'nightly-review';
  }

  /** Runs one turn and records how its events ended. Returns the turn, with the failure if it did not end cleanly. */
  private async runTurn(eventIds: string[], kind: Turn['kind'], rotationId?: string): Promise<EndedTurn> {
    const session = this.session!;
    // The review reads and rewrites memory file by file, so it has limits of its own (ADR 0018).
    const { loop } = this.options;
    const maxCalls = kind === 'review' ? loop.reviewModelCalls : loop.eventModelCalls;
    const timeoutMs = (kind === 'review' ? loop.reviewTimeoutMinutes : loop.eventTimeoutMinutes) * 60_000;
    const turn: Turn = { kind, calls: 0, maxCalls, limited: false, timedOut: false, notices: 0, rotationId, startedAt: this.now(), doveRefusals: 0 };
    this.turn = turn;
    for (const eventId of eventIds) this.beginHandling(eventId, this.store.eventMessageId(eventId), true);
    const before = session.messages.length;
    const timer = setTimeout(() => { turn.timedOut = true; void session.abort(); }, timeoutMs);
    const notices = [this.takeMemoryNotice(), this.takeWorkspaceNotice()].filter(Boolean).join('\n\n');
    const prompt = formatEvents(eventIds.map(id => this.eventLine(id))) + (notices ? `\n\n${notices}` : '');
    const images = await this.eventImages(eventIds);
    try {
      await session.prompt(prompt, { expandPromptTemplates: false, ...(images.length > 0 ? { images } : {}) });
    } catch {
      // Judged below from what Pi recorded; the error text never leaves the server.
    } finally { clearTimeout(timer); }
    this.endThinking();
    // A turn cut short is not told apart by its rows once a handoff was written, so the log says which limit did it.
    if (turn.limited) this.log(`thinking loop: the ${kind} turn was stopped at the model-call limit (${turn.calls} calls)`);
    else if (turn.timedOut) this.log(`thinking loop: the ${kind} turn was stopped by the time limit (${timeoutMs / 1000} seconds)`);

    // Steering Pi did not deliver goes back to the front of the queue.
    for (const text of session.clearQueue().steering.reverse()) {
      const eventId = this.steered.get(text)?.pop();
      if (!eventId) continue;
      this.handling.delete(eventId);
      this.store.setEventState(eventId, 'queued');
      this.queue.unshift(eventId);
    }
    this.steered.clear();

    // Whatever ended the turn, what memory holds now is checked and committed before the next event (ADR 0018).
    await this.commitMemory(eventIds, turn);
    await this.checkWorkspaceSize();

    const endedAt = this.now();
    const replies = assistantMessages(session.messages.slice(before));
    const last = replies.at(-1);
    const failure = turn.limited ? 'model-call-limit' : turn.timedOut ? 'timeout' : this.closing ? 'stopped'
      : !last || (last.stopReason !== 'stop' && last.stopReason !== 'toolUse') ? 'model-error' : undefined;
    let unanswered = 0;
    for (const handling of this.handling.values()) {
      if (handling.messageId !== undefined && handling.shown && !handling.replied) unanswered += 1;
      const status: EventState = handling.replied ? 'replied' : !failure ? 'no-reply' : 'failed';
      this.store.setEventState(handling.eventId, status, status === 'failed' ? failure : undefined);
      if (!handling.messageId) continue;
      if (status === 'failed') this.log(`thinking loop: an event failed (${failure})`);
      this.emit('conversation.event.completed', {
        eventId: handling.eventId, messageId: handling.messageId, status, ...(status === 'failed' ? { reason: failure } : {}),
      });
    }
    this.handling.clear();
    this.turn = undefined;
    // Thinking ends with the handling, whoever set it (ADR 0014); other expressions return to neutral with time.
    if (this.avatar.expression === 'thinking' && this.queue.length === 0) this.setAvatar('neutral', 'server');
    const first = replies[0]?.usage;
    const confusion = { repeatedCalls: repeatedCalls(session.messages, before), unansweredMessages: unanswered,
      toolErrors: session.messages.slice(before).filter(message => message.role === 'toolResult' && message.isError).length,
      doveRefusals: turn.doveRefusals };
    return { ...turn, ...(failure ? { failure } : {}), eventIds, endedAt, usage: sumUsage(replies),
      contextTokens: first ? first.input + first.cacheRead + first.cacheWrite : null, confusion };
  }

  /**
   * The memo after a turn (ADR 0047): the same session is asked for one line on what the turn found out and what did
   * not work, which is what stays of the turn once it is folded. It is asked whether folding is on or off, so that the
   * two differ only in the folding, and after a turn cut short at a limit too; not after one that failed or was
   * stopped, nor after the nightly review, which the session ends with.
   *
   * Thinking is turned off for this one call: a line needs none, and the request follows the turn on the prefix.
   * The tools stay declared, since removing them would move the prefix, but a call to one is refused and the memo
   * ends after its one call. Messages arriving meanwhile wait for a turn of their own: no turn is open to steer into.
   */
  private async reflect(turn: EndedTurn): Promise<(TokenCounts & { ms: number }) | undefined> {
    const session = this.session;
    if (!session || this.closing || turn.kind !== 'events') return undefined;
    if (turn.failure && turn.failure !== 'model-call-limit' && turn.failure !== 'timeout') return undefined;
    const startedAt = this.now();
    const before = session.messages.length;
    this.reflecting = true;
    session.setThinkingLevel('off');
    const timer = setTimeout(() => { void session.abort(); }, REFLECTION_TIMEOUT_MS);
    try {
      await session.prompt(REFLECTION_REQUEST, { expandPromptTemplates: false });
    } catch {
      // A memo that fails leaves the turn without one; the fold then waits for the next turn's.
    } finally {
      clearTimeout(timer);
      this.reflecting = false;
      session.setThinkingLevel(this.thinkingLevel());
      this.endThinking();
    }
    const answers = assistantMessages(session.messages.slice(before));
    if (answers.at(-1)?.stopReason !== 'stop') this.log('thinking loop: the memo after a turn was not written');
    return { ms: this.now() - startedAt, ...sumUsage(answers) };
  }

  /** One row of numbers for the turn; a row that cannot be written is logged, never thrown (ADR 0047). */
  private recordTurn(turn: EndedTurn, reflection: (TokenCounts & { ms: number }) | undefined, compacted: boolean) {
    try {
      const rows = turn.eventIds.map(eventId => this.store.eventRow(eventId));
      this.turnStats.record({
        turnId: `turn-${randomUUID()}`, startedAt: turn.startedAt, endedAt: turn.endedAt,
        receivedAt: Math.min(...rows.map(row => Date.parse(row.created_at))),
        ...(turn.firstOutAt === undefined ? {} : { firstOutAt: turn.firstOutAt }),
        fold: this.fold, route: this.route?.name ?? this.chosen, eventKinds: this.eventLabel(turn.eventIds),
        outcome: turn.failure ?? 'ok', modelCalls: turn.calls, usage: turn.usage, contextTokens: turn.contextTokens,
        ...(reflection ? { reflection } : {}), compacted, confusion: turn.confusion,
      });
    } catch {
      this.log('thinking loop: the numbers of a turn could not be recorded');
    }
  }

  /**
   * Between turns: follows the fold the command line chose, or the config's while none was chosen, and writes what is
   * in use for the command line. A change moves the prefix once, from the first turn it folds or unfolds.
   */
  private async followFold() {
    const chosen = await readFoldChoice(this.options.dataDirectory);
    const fold = chosen ?? this.options.loop.turnFold;
    if (fold !== this.fold) this.log(`thinking loop: folding ended turns is now ${fold}`);
    this.fold = fold;
    const status = { inUse: fold, defaultFold: this.options.loop.turnFold, chosen: chosen ?? null };
    const text = JSON.stringify(status);
    if (text === this.foldPublished) return;
    try {
      await writeFoldStatus(this.options.dataDirectory, status, this.now());
      this.foldPublished = text;
    } catch (error) {
      // A data directory without the server's state directory is a test's; the server always has one.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log('thinking loop: the fold status could not be written for the command line');
    }
  }

  /**
   * One commit for the turn, or none when memory did not change. A file that fails the check goes back to the
   * previous commit and its reason waits for the next prompt. A commit that cannot be made is logged, never thrown:
   * the memory is still on disk, and the next turn commits it.
   *
   * A review that wrote a change note commits under it; one that did not gets the machine-made message, because a
   * night is not failed for having left its own commit unexplained (ADR 0020).
   */
  private async commitMemory(eventIds: string[], turn: Turn): Promise<void> {
    try {
      const outcome = await this.memoryRepository.commit({
        event: this.eventLabel(eventIds), night: turn.kind === 'review',
        ...(turn.changeNote ? { message: turn.changeNote } : {}),
      });
      if (outcome.committed) this.log(`memory: committed ${outcome.files.length} file(s)`);
      const notice = revertNotice(outcome.reverted);
      if (notice) this.memoryNotice = this.memoryNotice ? `${this.memoryNotice}\n${notice}` : notice;
    } catch {
      // The error text is the git CLI's and never leaves the server.
      this.log('memory: the commit failed; the changes stay in the working tree');
    }
  }

  /** The event kinds of a turn, in the names the model sees, for the machine-made commit message. */
  private eventLabel(eventIds: string[]): string {
    const kinds = this.store.eventKinds(eventIds).map(kind => (kind ?? 'event').replace(/-/g, '_'));
    return [...new Set(kinds)].join('+');
  }

  /**
   * The nightly switch (ADR 0009): a review turn in the current session writes memories and a handoff, then a new
   * session starts from that handoff. The old session file is kept. The shown conversation is untouched.
   */
  private async runRotation(eventId: string): Promise<void> {
    const { sessionDirectory } = this.options;
    const session = this.session!;
    const finish = (outcome: RotationOutcome) => {
      if (outcome.result === 'failed') this.log(`thinking loop: the nightly switch failed (${outcome.reason})`);
      const waiters = this.rotationWaiters.get(eventId) ?? [];
      this.rotationWaiters.delete(eventId);
      for (const resolve of waiters) resolve(outcome);
    };
    if (session.messages.length === 0) {
      this.store.setEventState(eventId, 'no-reply');
      return finish({ result: 'skipped', reason: 'empty-session' });
    }
    this.rotating = true;
    const conversation = this.store.conversation()!;
    const rotationId = `rotation-${randomUUID()}`;
    this.store.insertRotation({ rotationId, eventId, conversationId: conversation.conversation_id,
      fromSessionId: conversation.pi_session_id, fromSessionFile: conversation.pi_session_file });
    this.setAvatar('sleepy', 'server');

    const outcome = await (async (): Promise<RotationOutcome> => {
      const turn = await this.runTurn([eventId], 'review', rotationId);
      const setRotation = (state: string, reason?: string) => this.store.setRotation(rotationId, state, reason);
      if (!turn.handoffWritten) {
        const reason = this.closing ? 'stopped' : turn.failure ?? 'no-handoff';
        setRotation('failed', reason);
        this.store.setEventState(eventId, 'failed', reason);
        return { result: 'failed', reason };
      }
      // The turn's own commit has just taken the handoff in, so this is the commit the new session is given.
      // Recorded before the session is made: a stop after this point finishes the switch instead of losing the night.
      // Should that commit have failed — logged, with the memory left in the working tree — this names the commit
      // before it, and the next turn commits the handoff. The switch still goes ahead: the new session is given the
      // note either way, and losing a night over a git failure would cost more than the imprecise pointer.
      let handoffCommit: string;
      try { handoffCommit = await this.memoryRepository.head(); } catch {
        setRotation('failed', 'handoff-not-committed');
        this.store.setEventState(eventId, 'failed', 'handoff-not-committed');
        return { result: 'failed', reason: 'handoff-not-committed' };
      }
      this.store.saveHandoffCommit(rotationId, handoffCommit);
      setRotation('switching');
      if (this.closing) {
        // The handoff is kept; the next start finishes this switch.
        this.store.setEventState(eventId, 'failed', 'stopped');
        return { result: 'failed', reason: 'stopped' };
      }
      let created: AgentSession | undefined;
      try {
        created = await createPersistedPiSession(await this.sessionOptions());
        this.commitSwitch({ rotation_id: rotationId, conversation_id: conversation.conversation_id, handoff_commit: handoffCommit }, created);
      } catch {
        created?.dispose();
        setRotation('failed', 'session-create-failed');
        this.store.setEventState(eventId, 'failed', 'session-create-failed');
        return { result: 'failed', reason: 'session-create-failed' };
      }
      this.attach(created);
      session.dispose();
      this.compactionRetryAbove = undefined;
      this.store.setEventState(eventId, 'no-reply');
      this.log(`thinking loop: switched to a new session (the old one is kept as ${relative(sessionDirectory, session.sessionFile!)})`);
      return { result: 'switched' };
    })();
    this.rotating = false;
    if (this.avatar.by === 'server' && this.avatar.expression === 'sleepy') this.setAvatar(this.queue.length > 0 ? 'thinking' : 'neutral', 'server');
    finish(outcome);
  }

  /** Points the conversation at the new session and marks the switch done, together. */
  private commitSwitch(rotation: Pick<RotationRow, 'rotation_id' | 'conversation_id' | 'handoff_commit'>, created: AgentSession) {
    this.store.commitSwitch(rotation,
      { sessionId: created.sessionId, sessionFile: relative(this.options.sessionDirectory, created.sessionFile!) });
  }

  /**
   * Between turns: moves the session to the chosen route (ADR 0046). The same session goes on under the new model,
   * which is handed the conversation so far; a model's own thinking reaches another model as plain text. A route
   * that is not ready is not moved to, and nothing is tried in its place (ADR 0004). A session already past the new
   * route's threshold is compacted on the new route before the next turn.
   */
  private async followRoute() {
    const session = this.session;
    if (this.closing || !session || !this.route) return;
    this.chosen = await this.readChoice();
    if (this.chosen === this.route.name) { this.refusedRoute = undefined; await this.publishRoutes(); return; }
    const next = this.routes.list.find(candidate => candidate.name === this.chosen)!;
    const model = this.modelRuntime!.getModel(next.target.provider, next.target.model);
    if (!model || !(await this.isReady(next))) {
      if (this.refusedRoute !== next.name) this.log(`thinking loop: the model route ${next.name} is not ready; staying on ${this.route.name}`);
      this.refusedRoute = next.name;
      await this.publishRoutes();
      return;
    }
    try {
      await session.setModel(model);
    } catch {
      if (this.refusedRoute !== next.name) this.log(`thinking loop: the model route ${next.name} is not ready; staying on ${this.route.name}`);
      this.refusedRoute = next.name;
      await this.publishRoutes();
      return;
    }
    // Pi picks a thinking level for the model it moves to; natsumi's is the configured one on every route.
    session.setThinkingLevel(this.thinkingLevel());
    this.route = next;
    this.refusedRoute = undefined;
    this.compactionRetryAbove = undefined;
    this.log(`thinking loop: now on the model route ${next.name}`);
    await this.publishRoutes();
    await this.maintain();
  }

  /** The chosen route's name. One no longer in the config gives way to the default, and the record says so (ADR 0046). */
  private async readChoice(): Promise<string> {
    const { dataDirectory } = this.options;
    const { defaultRoute, list } = this.routes;
    const chosen = await readRouteChoice(dataDirectory);
    if (chosen === undefined) return defaultRoute;
    if (list.some(route => route.name === chosen)) return chosen;
    this.log(`thinking loop: the chosen model route ${chosen} is not in the config; back to the default ${defaultRoute}`);
    try { await writeRouteChoice(dataDirectory, defaultRoute, this.now()); } catch { /* read again, and logged again, next time */ }
    return defaultRoute;
  }

  private async isReady(route: LoopRoute): Promise<boolean> {
    let ready = false;
    try { ready = await routeReady(this.modelRuntime!, route.target, route.compatible); } catch { ready = false; }
    this.readiness.set(route.name, ready);
    return ready;
  }

  /** Tells the devices and writes for the command line what changed about the routes, if anything did. */
  private async publishRoutes() {
    if (this.modelRuntime) for (const route of this.routes.list) await this.isReady(route);
    const status = this.routeStatus();
    const text = JSON.stringify(status);
    if (text === this.published) return;
    const first = this.published === '';
    this.published = text;
    // Written before the devices hear of it, so the command line is never behind them.
    try { await writeRouteStatus(this.options.dataDirectory, status, this.now()); } catch (error) {
      // A data directory without the server's state directory is a test's; the server always has one.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log('thinking loop: the model routes could not be written for the command line');
    }
    if (!first) this.emit('model.routes', status);
  }

  /**
   * Between turns: compacts a session past its limit, so compaction never cuts into a turn (ADR 0009). Returns whether
   * it did. The size is Pi's, from the last call's usage, so with folding on it is the folded context's.
   */
  private async maintain(): Promise<boolean> {
    const session = this.session;
    if (this.closing || !session) return false;
    const tokens = session.getContextUsage()?.tokens;
    const limit = this.route!.compactionThreshold;
    if (tokens === undefined || tokens === null || tokens <= limit) return false;
    if (this.compactionRetryAbove !== undefined && tokens <= this.compactionRetryAbove) return false;
    try {
      await session.compact(COMPACTION_INSTRUCTIONS);
      this.compactionRetryAbove = undefined;
      this.log('thinking loop: the session was compacted');
      return true;
    } catch (error) {
      // The session is unchanged; try again once the context has grown further.
      this.compactionRetryAbove = tokens + Math.floor(limit / 10);
      this.log(`thinking loop: compaction failed (${failureReason(error)})`);
      return false;
    }
  }

  /**
   * Pi asks after every completed model call whether the turn ends here. Only the limit is decided here: a turn ends
   * on its own when natsumi stops without calling a tool, and even then Pi first hands her any message steered in
   * meanwhile, so what arrived is never left behind by a turn that looked finished (ADR 0024).
   */
  private shouldStop({ message }: StopContext): boolean {
    const turn = this.turn;
    if (!turn) return false;
    turn.calls += 1;
    if (message.stopReason === 'toolUse' && turn.calls >= turn.maxCalls) {
      turn.limited = true;
      return true;
    }
    return false;
  }

  private beginHandling(eventId: string, messageId: string | undefined, shown: boolean) {
    this.handling.set(eventId, { eventId, messageId, replied: this.store.hasReply(eventId), shown });
    this.store.setEventState(eventId, 'processing');
  }

  /**
   * The line one event becomes inside `<events>`. New event kinds add their own shape here. No line carries its
   * event ID: no tool asks for one, and a column of IDs alike in shape was what she once copied wrong (ADR 0024).
   */
  private eventLine(eventId: string): Record<string, unknown> {
    const row = this.store.eventRow(eventId);
    if (row.kind === 'nightly-review') {
      return { type: 'nightly_review', received_at: row.created_at, instructions: REVIEW_INSTRUCTIONS };
    }
    const timeZone = this.options.loop.timeZone;
    const raisedAt = Date.parse(row.created_at);
    if (row.kind === 'agent-reply') return this.agents.takeEventLine(eventId, row.created_at);
    if (row.kind === 'dove-reply') return this.options.dove?.takeEventLine(eventId, row.created_at) ?? { type: 'agent_reply', received_at: row.created_at, agent: DOVE_NAME };
    if (row.kind === 'slack-mention') return this.options.slack?.eventLine(eventId, row.created_at) ?? { type: 'slack_mention', received_at: row.created_at };
    // What the sources have that she was not shown yet, on the quiet moments only; taken as the line is made (ADR 0039).
    const updates = row.kind === 'ping' || row.kind === 'self-check' ? takeUpdates(this.options.updates ?? []) : undefined;
    const shownUpdates = updates ? { updates } : {};
    if (row.kind === 'self-check') {
      return { type: 'self_check', received_at: row.created_at, local_time: localDateTime(raisedAt, timeZone),
        checks: this.selfChecks.carriedBy(eventId, raisedAt), ...shownUpdates };
    }
    // How many of her notices the owner has not checked, when any: read-only, so she need not send them again.
    const unacknowledged = this.readState.unacknowledgedNotificationIds().length;
    const notices = unacknowledged > 0 ? { unacknowledged_notices: unacknowledged } : {};
    if (row.kind === 'ping') {
      return { type: 'ping', received_at: row.created_at, local_time: localDateTime(raisedAt, timeZone), ...notices, ...shownUpdates };
    }
    return { type: 'mac_message', received_at: row.message_at, text: row.text, ...notices };
  }

  private host(): LoopToolHost {
    return {
      reply: (text, expression, images) => this.reply(text, expression, images),
      notify: (text, expression) => this.notify(text, expression),
      setExpression: expression => {
        this.setAvatar(expression, 'model');
        return { ok: true, text: `アバターの表情を ${expression} にしました。` };
      },
      writeHandoff: text => this.writeHandoff(text),
      writeChangeNote: text => this.writeChangeNote(text),
      scheduleSelfCheck: (reason, when) => this.selfChecks.schedule(reason, when),
      listSelfChecks: () => this.selfChecks.list(),
      cancelSelfCheck: checkId => this.selfChecks.cancel(checkId),
      // The dove is one of the agents she can ask, and lives in the server: its name never reaches A2A (ADR 0040).
      askAgent: (agent, message, goOn) => agent === DOVE_NAME && this.options.dove
        ? this.askDove(message) : this.agents.ask(agent, message, goOn),
      ...(this.shell ? { runShell: (command: string) => this.runShell(command),
        capture: (command: string) => this.shell!.capture(command) } : {}),
    };
  }

  /** A request to the dove; one it took is, for the numbers, the turn's first word out if nothing went before (ADR 0047). */
  private async askDove(message: string): Promise<ToolOutcome> {
    const turn = this.turn;
    const outcome = await this.options.dove!.ask(message);
    if (outcome.ok && turn) turn.firstOutAt ??= this.now();
    if (!outcome.ok && turn) turn.doveRefusals += 1;
    return outcome;
  }

  /**
   * A command in the workspace. `view <path>` alone is the server's own: it answers with the image itself, which the
   * runner could not put into a tool result (ADR 0039).
   */
  private runShell(command: string): Promise<ToolOutcome> {
    const path = parseView(command);
    if (path !== undefined) return viewImage(path, { sources: join(this.options.dataDirectory, SOURCES_DIRECTORY),
      work: join(this.options.dataDirectory, WORK_DIRECTORY) });
    return this.shell!.run(command);
  }

  /** The images a turn's events bring with them, handed to the model beside the prompt. */
  private async eventImages(eventIds: string[]): Promise<ImageContent[]> {
    const images: ImageContent[] = [];
    for (const eventId of eventIds) {
      if (this.store.eventKind(eventId) !== 'slack-mention' || !this.options.slack) continue;
      try { images.push(...await this.options.slack.images(eventId)); } catch { /* the line still goes; the images are a courtesy */ }
    }
    return images;
  }

  /**
   * A line natsumi says to the owner. She may say as many as she has something to say, also in a turn no owner
   * message is waiting in (ADR 0032); only the nightly review is closed to them, like notices.
   *
   * The first reply after owner messages arrive answers every one of them the turn has shown her, however many were
   * steered in (ADR 0024). It is recorded against the newest of them, which is where the owner's side of the
   * conversation stands, and the older ones are marked replied in the same transaction, so a restart before the turn
   * ends answers none of them again: the record says replied, and only messages still being processed are closed on
   * a start. A reply with nothing waiting answers nothing and names no event.
   */
  private async reply(text: string, expression: Expression, paths: string[] = []): Promise<ToolOutcome> {
    if (this.turn?.kind === 'review') {
      return { ok: false, text: '送信していません。夜の振り返りの間は、本人に話しかけません。明日に伝えたいことは write_handoff_note に書いてください。' };
    }
    const check = checkOutgoingText(text);
    if (!check.ok) return { ok: false, text: refusalText(check) };
    // Copied at the call, once the text can no longer turn the line back: what the owner is shown is the copy (ADR 0045).
    let taken: TakenImage[] = [];
    if (paths.length > 0) {
      const workDirectory = join(this.options.dataDirectory, WORK_DIRECTORY);
      const result = await this.images.take(paths, workDirectory, this.options.replyImageLimits ?? REPLY_IMAGE_LIMITS);
      if (!result.ok) return { ok: false, text: `送信していません（セリフも送っていません）。${result.text}直してから、セリフと一緒に送り直してください。` };
      taken = result.images;
    }
    const open = [...this.handling.values()].filter(handling => handling.messageId !== undefined && handling.shown && !handling.replied);
    const target = open.at(-1);
    let row: MessageRow;
    try {
      row = this.store.transaction(() => {
        this.images.record(taken, isoAt(this.now()));
        const inserted = this.store.insertMessage({ role: 'natsumi', kind: 'reply', text, eventId: target?.eventId, expression,
          ...(taken.length > 0 ? { imageIds: taken.map(image => image.imageId) } : {}) });
        for (const handling of open) this.store.setEventState(handling.eventId, 'replied');
        return inserted;
      });
    } catch (error) {
      await discardImages(taken);
      throw error;
    }
    for (const handling of open) handling.replied = true;
    if (this.turn) this.turn.firstOutAt ??= this.now();
    this.emit('conversation.message', shown(row, taken.length > 0 ? taken.map(image => shownImage(image)) : undefined));
    return { ok: true, text: `本人の Mac にセリフ${taken.length > 0 ? `と画像 ${taken.length} 枚` : ''}を送りました。このセリフは確定しました。`
      + (target ? 'ここまでに届いた本人のメッセージには返事を済ませました。' : '')
      + '続けて話してもかまいませんが、同じことを繰り返さないでください。ほかにやることがなければ、ツールを呼ばずに終えてください。' };
  }

  private notify(text: string, expression: Expression): ToolOutcome {
    const turn = this.turn;
    if (turn?.kind === 'review') {
      return { ok: false, text: '送信していません。夜の振り返りの間は、本人に知らせを送りません。明日に伝えたいことは write_handoff_note に書いてください。' };
    }
    const limits = this.options.notifyLimits ?? DEFAULT_NOTIFY_LIMITS;
    if (turn && turn.notices >= limits.perTurn) {
      return { ok: false, text: `送信していません。1 回の処理で本人に送れる知らせの上限（${limits.perTurn} 件）に達しました。` };
    }
    if (this.store.noticesInLastHour() >= limits.perHour) {
      return { ok: false, text: `送信していません。1 時間に本人に送れる知らせの上限（${limits.perHour} 件）に達しました。急ぎでなければ後でまとめて伝えてください。` };
    }
    const check = checkOutgoingText(text);
    if (!check.ok) return { ok: false, text: refusalText(check) };
    const row = this.store.insertMessage({ role: 'natsumi', kind: 'notice', text, expression });
    if (turn) turn.notices += 1;
    this.emit('conversation.message', shown(row));
    return { ok: true, text: '本人に知らせを送りました。返事を待つ必要はありません。同じ内容を繰り返し送らないでください。' };
  }

  /**
   * The handoff, written into `handoff.md` in the memory repository, which is the only place it is kept (ADR 0020).
   * The turn's own commit takes it in like any other change, and the switch then records that commit.
   */
  private async writeHandoff(text: string): Promise<ToolOutcome> {
    const turn = this.turn;
    if (turn?.kind !== 'review' || !turn.rotationId) {
      return { ok: false, text: '書いていません。write_handoff_note は、夜の振り返り（nightly_review）の中でだけ使えます。' };
    }
    const check = checkOutgoingText(text);
    if (!check.ok) return { ok: false, text: refusalText(check).replace('送信していません', '書いていません') };
    try {
      await this.memoryRepository.writeHandoff(text);
    } catch {
      // The git and filesystem errors stay on the server; what she can act on is that the night has no handoff yet.
      this.log('memory: the handoff could not be written');
      return { ok: false, text: '書けませんでした。handoff.md に書き込めなかったので、もう一度試してください。' };
    }
    turn.handoffWritten = true;
    return { ok: true, text: '引き継ぎのメモを handoff.md に書きました。このターンの終わりにコミットされ、明日の新しい思考の記録はこのメモから始まります。書き直すなら、もう一度呼んでください。' };
  }

  /**
   * What the night says about itself, kept for this turn's commit (ADR 0020). Refused outside the review rather
   * than quietly dropped: the day's commit message is the server's, so a note written then would have nowhere to
   * go, and a reason lets her write it at the right time instead.
   */
  private writeChangeNote(text: string): ToolOutcome {
    const turn = this.turn;
    if (turn?.kind !== 'review') {
      return { ok: false, text: '書いていません。write_change_note は、夜の振り返り（nightly_review）の中でだけ使えます。'
        + '日中の記憶のコミットメッセージはサーバーが付けるので、この説明の行き場がありません。' };
    }
    const check = checkOutgoingText(text);
    if (!check.ok) return { ok: false, text: refusalText(check).replace('送信していません', '書いていません') };
    turn.changeNote = text;
    return { ok: true, text: '今夜の記憶のコミットメッセージにします。書き直すなら、もう一度呼んでください。' };
  }

  /** A steered event is shown to natsumi when Pi puts its prompt into the context, at a model-call boundary. */
  private watchSteering(event: AgentSessionEvent) {
    if (event.type !== 'message_start' || event.message.role !== 'user') return;
    const content = event.message.content;
    const text = typeof content === 'string' ? content
      : content.map(part => part.type === 'text' ? part.text : '').join('');
    const waiting = this.steered.get(text)?.map(eventId => this.handling.get(eventId)).find(handling => handling && !handling.shown);
    if (waiting) waiting.shown = true;
  }

  /**
   * The line natsumi is writing, as Pi streams it (ADR 0017). Only the thinking text is read: what a tool was
   * called with or answered is never sent. Nothing here is recorded; it is a sight of the moment for the owner's
   * own devices, and the turn's end clears it.
   */
  private watchThinking(event: AgentSessionEvent) {
    if (event.type !== 'message_update') return;
    const inner = event.assistantMessageEvent;
    if (inner.type === 'thinking_start') { this.thinking.line = ''; return; }
    if (inner.type === 'thinking_delta') {
      const newline = inner.delta.lastIndexOf('\n');
      // Only the newest line is shown; what came before it is behind her already.
      this.thinking.line = newline >= 0 ? inner.delta.slice(newline + 1) : this.thinking.line + inner.delta;
      this.publishThinking(false);
      return;
    }
    // The end of a block of thinking: the line it stopped on goes out whatever the interval says.
    if (inner.type === 'thinking_end') this.publishThinking(true);
  }

  /** Whether the owner is waiting on this turn. Only then is there a balloon to put a line in. */
  private streamsThinking(): boolean {
    if (this.options.thinking !== 'on') return false;
    if (this.turn?.kind !== 'events') return false;
    return [...this.handling.values()].some(handling => handling.messageId !== undefined);
  }

  private publishThinking(force: boolean) {
    if (!this.streamsThinking()) return;
    const line = thinkingLine(this.thinking.line);
    // An empty line is the space between two lines, not the end of the thinking: the one before it stays up.
    if (line === '' || line === this.thinking.sent) return;
    const now = this.now();
    if (!force && now - this.thinking.at < THINKING_MIN_INTERVAL_MS) return;
    this.thinking.sent = line;
    this.thinking.at = now;
    this.emit('conversation.thinking', { line }, true);
  }

  /** Says the thinking is over, so the Mac goes back to the blinking dots without waiting for anything else. */
  private endThinking() {
    this.thinking.line = '';
    if (this.thinking.sent === '') return;
    this.thinking.sent = '';
    this.thinking.at = this.now();
    this.emit('conversation.thinking', { line: '' }, true);
  }

  private setAvatar(expression: Expression, by: 'server' | 'model') {
    this.avatar = { expression, by, changedAt: this.now() };
    this.emit('avatar.expression', { expression });
  }

  private emit(type: string, payload: object, ephemeral = false) {
    for (const listener of this.listeners) {
      try {
        listener({ type, payload: payload as Record<string, unknown>, ...(ephemeral ? { ephemeral } : {}) });
      } catch { /* one listener cannot stop the others */ }
    }
  }
}

/**
 * One line of thinking as the Mac is given it: trimmed, and cut to `THINKING_LINE_MAX_CHARS`. A line that has grown
 * past the limit keeps its newest end, because that is where she is writing.
 */
export function thinkingLine(raw: string): string {
  const trimmed = raw.trim();
  const characters = [...trimmed];
  if (characters.length <= THINKING_LINE_MAX_CHARS) return trimmed;
  return `…${characters.slice(-(THINKING_LINE_MAX_CHARS - 1)).join('')}`;
}

/**
 * A memory file as its section of the prompt takes it. The server writes the heading of every section itself, so a
 * heading the file opens with — the one the template put there, and the one natsumi keeps when she rewrites it —
 * would stand twice, saying the same thing and paying for it in the prefix every turn. Only the opening heading is
 * dropped; the file's own structure below it is hers.
 */
export function sectionBody(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('# ')) return trimmed;
  const newline = trimmed.indexOf('\n');
  return newline < 0 ? '' : trimmed.slice(newline + 1).trim();
}

/** Events handed to Pi: one JSON line per event inside `<events>`, as in the loop evaluation. */
export function formatEvents(lines: Record<string, unknown>[]): string {
  return `<events>\n${lines.map(line => JSON.stringify(line)).join('\n')}\n</events>`;
}

/**
 * Why a compaction failed, as one line for the log: the error's kind and Pi's message, which names the step and the
 * provider's reason, never the conversation. A provider's message is outside our control, so it is kept short.
 */
function failureReason(error: unknown): string {
  const kind = error instanceof Error ? error.name : typeof error;
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  const characters = [...message];
  return `${kind}: ${characters.length <= 200 ? message : `${characters.slice(0, 199).join('')}…`}`;
}

/** A turn once it has ended: its events, how it ended, and what it cost (ADR 0047). */
type EndedTurn = Turn & { failure?: string; eventIds: string[]; endedAt: number; usage: TokenCounts; contextTokens: number | null;
  confusion: Confusion };

/**
 * The run_shell commands and read paths of the turn (from `start`) that were already used before, in the session's
 * context or earlier in the turn (ADR 0047). A command is compared with its spaces normalized; nothing is parsed.
 */
function repeatedCalls(messages: AgentSession['messages'], start: number): number {
  const seen = new Set<string>();
  let repeated = 0;
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    for (const block of message.content) {
      if (block.type !== 'toolCall') continue;
      const args = block.arguments as Record<string, unknown>;
      const key = block.name === 'run_shell' && typeof args.command === 'string' ? `run_shell ${args.command.trim().replace(/\s+/g, ' ')}`
        : block.name === 'read' && typeof args.path === 'string' ? `read ${args.path.trim()}` : undefined;
      if (!key) continue;
      if (index >= start && seen.has(key)) repeated += 1;
      seen.add(key);
    }
  });
  return repeated;
}

type Reply = { stopReason?: string; usage: { input: number; cacheRead: number; cacheWrite: number; output: number } };

function assistantMessages(messages: AgentSession['messages']): Reply[] {
  return messages.filter(message => message.role === 'assistant') as unknown as Reply[];
}

function sumUsage(replies: Reply[]): TokenCounts {
  return replies.reduce((sum, { usage }) => ({ input: sum.input + (usage?.input ?? 0), cacheRead: sum.cacheRead + (usage?.cacheRead ?? 0),
    output: sum.output + (usage?.output ?? 0) }), { input: 0, cacheRead: 0, output: 0 });
}

function shown(row: MessageRow, images?: ShownImage[]): ShownMessage {
  const base = { messageId: row.message_id, role: row.role, kind: row.kind, text: row.text, createdAt: row.created_at,
    ...(row.expression === null ? {} : { expression: row.expression }), ...(images && images.length > 0 ? { images } : {}) };
  if (row.kind === 'message') return { ...base, eventId: row.event_id! };
  if (row.kind === 'reply') return row.event_id === null ? base : { ...base, replyTo: row.event_id };
  const about = row.about_event_ids ? JSON.parse(row.about_event_ids) as string[] : [];
  return about.length > 0 ? { ...base, about } : base;
}
