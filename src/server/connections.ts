import { randomUUID } from 'node:crypto';
import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { DEFAULT_STREAM_BUFFER_SIZE, DeviceStreams, EventStream, PROTOCOL_VERSION } from './device-streams.ts';
import { isPlacement, type Placement } from './judge.ts';
import type { VerifiedSession } from './sessions.ts';

export { PROTOCOL_VERSION };
export const WEBSOCKET_PATH = '/v1/ws';
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 32 * 1024;
/** A client this far behind is disconnected; it reconnects and syncs, falling back to a snapshot. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
export const CLOSE_DEVICE_REPLACED = 4001;
export const CLOSE_TOO_SLOW = 4002;

/** Commands of the v1 client contract. The ones not handled below receive a safe rejection. */
const KNOWN_COMMANDS = new Set(['session.sync', 'conversation.send', 'conversation.read', 'conversation.interrupt', 'approval.decide',
  'notification.ack', 'device.activity', 'push.register', 'model.list', 'model.use', 'settings.list', 'settings.set', 'settings.reset']);
/** Commands that act for a device, and so need `session.sync` first and the connection's own device ID. */
const DEVICE_COMMANDS = new Set(['conversation.send', 'conversation.read', 'notification.ack', 'push.register', 'approval.decide',
  'model.list', 'model.use', 'settings.list', 'settings.set', 'settings.reset']);
const DECISIONS = new Set(['approve', 'edit', 'reject']);

/**
 * How an upgrade was let in: by the app's bearer token, or by the browser's cookie with the public origin as the Origin
 * (ADR 0058). A cookie shown with another Origin, or none, is refused before this.
 */
export type Admission = { session: VerifiedSession; via: 'bearer' | 'cookie' } | { refused: 'origin-not-allowed' };

interface Connection {
  session: VerifiedSession;
  /** A browser (cookie) registers a Web Push subscription, an app an APNs token (ADR 0065). */
  via: 'bearer' | 'cookie';
  /** The session's end as this connection last heard it; renewals move it (ADR 0030). */
  expiresAt: string;
  /** Answers sent before `session.sync` binds the connection to a device stream. */
  local: EventStream;
  deliver: (text: string) => void;
  deviceId?: string;
  stream?: EventStream;
}

/**
 * The outcome of a command the hub only relays: the kind picks the answer's type, and whatever else the loop
 * returns is published with it. The hub reads none of those fields, so it does not name them.
 */
type RelayedOutcome = { kind: 'accepted' | 'rejected' | 'unavailable'; code?: string };

/**
 * The loop as the hub uses it: the six things the client contract needs, and nothing about how a thought is had.
 * Every command a client may send turns into one of these, so a change to the way natsumi thinks is not a change
 * to this file. The scheduler looks at the loop through a narrow interface of its own for the same reason.
 */
export interface HubLoop {
  /** The code clients are turned away with, or undefined while the loop is taking commands. */
  readonly unavailable: string | undefined;
  /** Everything the loop shows the owner, to be broadcast. Returns the way to stop listening. */
  subscribe(listener: (event: { type: string; payload: Record<string, unknown>; ephemeral?: boolean }) => void): () => void;
  /** Records an owner message and answers; the loop's own events follow the answer. */
  send(input: { requestId: string; deviceId: string; text: string }):
    | { kind: 'accepted'; messageId: string; eventId: string; state: string }
    | { kind: 'rejected'; code: string }
    | { kind: 'unavailable'; code: string };
  /** Moves the read cursor for every device (ADR 0013). */
  markRead(input: { throughMessageId: string; deviceId: string }): RelayedOutcome;
  /** Records that the owner checked a notice. */
  acknowledgeNotice(input: { notificationId: string; deviceId: string }): RelayedOutcome;
  /** Everything a device needs to start over from; spread whole into `session.snapshot`. */
  snapshot(): Record<string, unknown>;
  /** The model routes, the one in use and the one chosen (ADR 0046). */
  routeStatus(): object;
  /** Chooses the route the next turn is on (ADR 0046). */
  chooseRoute(input: { route: string; deviceId: string }): Promise<RelayedOutcome>;
}

/** Where a device asks to be pushed while it is away (ADR 0029, ADR 0065). Kept whether or not APNs is configured. */
export interface HubPush {
  register(deviceId: string, payload: Record<string, unknown>): { kind: 'accepted'; environment?: string } | { kind: 'rejected'; code: string };
}

/**
 * What waits for the owner's decision (ADR 0002, ADR 0040), as the hub uses it: the list a snapshot carries, the
 * decision itself, and the events every device is shown. Without Slack there are none, and a decision names nothing.
 */
export interface HubApprovals {
  pending(): unknown[];
  decide(input: { approvalId: string; revision: number; decision: 'approve' | 'edit' | 'reject'; text?: string;
    placement?: Placement; deviceId: string }): RelayedOutcome;
  subscribe(listener: (event: { type: string; payload: Record<string, unknown> }) => void): () => void;
}

/**
 * The runtime settings as the hub uses them (ADR 0058): the list a snapshot carries, the three commands, and the news
 * of a change for every device. The hub checks the envelope's shape; the rules of the values are the settings' own.
 */
export interface HubSettings {
  view(): object;
  list(): RelayedOutcome;
  set(input: { key: string; value: unknown; deviceId: string }): Promise<RelayedOutcome>;
  reset(input: { key: string; deviceId: string }): Promise<RelayedOutcome>;
  subscribe(listener: (event: { type: string; payload: Record<string, unknown> }) => void): () => void;
}

export interface ConnectionHubOptions {
  publicOrigin: string;
  /** The live session presented by an upgrade request and how, a refusal, or undefined. Its use is already recorded. */
  authenticate: (request: IncomingMessage) => Admission | undefined;
  /** Records a use of a live session and returns its end, or undefined once it is revoked or expired. */
  renew: (sessionId: string) => string | undefined;
  now: () => number;
  db: DatabaseSync;
  loop: HubLoop;
  push: HubPush;
  approvals?: HubApprovals;
  /** The settings the owner may change while natsumi runs (ADR 0058). Without them the `settings.*` commands name nothing. */
  settings?: HubSettings;
  /** Events kept per device stream for replay after a reconnect. */
  streamBufferSize?: number;
  /**
   * The version of the avatar the apps fetch (ADR 0057), carried in every answer to `session.sync` that starts over.
   * It changes only with a restart, which a device meets as a new epoch, so no event tells of a change.
   */
  avatarVersion?: string;
}

type Payload = Record<string, unknown>;
const isObject = (value: unknown): value is Payload => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Authenticated WebSocket connections. Every check happens during the HTTP upgrade, so a refused client never
 * gets an open connection. `session.sync` binds a connection to a server-registered device and its stream.
 */
export class ConnectionHub {
  readonly epoch = randomUUID();
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly connections = new Map<WebSocket, Connection>();
  private readonly options: ConnectionHubOptions;
  private readonly devices: DeviceStreams;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeApprovals: () => void;
  private readonly unsubscribeSettings: () => void;

  constructor(options: ConnectionHubOptions) {
    this.options = options;
    this.devices = new DeviceStreams(options.db, this.epoch, options.streamBufferSize ?? DEFAULT_STREAM_BUFFER_SIZE);
    // Everything the loop shows the owner goes to every device alike. An event of the moment (the line of thinking)
    // reaches whoever is connected without taking a number or being kept for replay (ADR 0017).
    this.unsubscribe = options.loop.subscribe(event => {
      if (event.ephemeral) this.devices.broadcastEphemeral(event.type, event.payload);
      else this.devices.broadcast(event.type, event.payload);
    });
    this.unsubscribeApprovals = options.approvals?.subscribe(event => this.devices.broadcast(event.type, event.payload)) ?? (() => {});
    this.unsubscribeSettings = options.settings?.subscribe(event => this.devices.broadcast(event.type, event.payload)) ?? (() => {});
  }

  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    const path = new URL(request.url ?? '/', 'http://upgrade.invalid').pathname;
    if (path !== WEBSOCKET_PATH) return refuse(socket, 404, 'not-found');
    // Browsers always send Origin; native clients may omit it. A present Origin must be ours.
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== this.options.publicOrigin) return refuse(socket, 403, 'origin-not-allowed');
    const admitted = this.options.authenticate(request);
    if (!admitted) return refuse(socket, 401, 'unauthorized');
    if ('refused' in admitted) return refuse(socket, 403, admitted.refused);
    this.server.handleUpgrade(request, socket, head, ws => this.accept(ws, admitted.session, admitted.via));
  }

  /** Whether the device has a synced connection now. A device that has one gets events, not pushes. */
  isConnected(deviceId: string): boolean {
    for (const connection of this.connections.values()) if (connection.deviceId === deviceId) return true;
    return false;
  }

  /** Closes every connection opened with this session (logout). */
  closeSession(sessionId: string): void {
    for (const [ws, connection] of this.connections) if (connection.session.sessionId === sessionId) ws.close(1008, 'session ended');
  }

  /**
   * Called periodically. A connection still open is its session in use, so the session is renewed and the client
   * hears its new end without a number of its own (ADR 0030). A session found revoked or already past its end
   * closes the connection instead.
   */
  expireSessions(): void {
    for (const [ws, connection] of this.connections) {
      const expiresAt = this.options.renew(connection.session.sessionId);
      if (expiresAt === undefined) { ws.close(1008, 'session ended'); continue; }
      if (expiresAt === connection.expiresAt) continue;
      connection.expiresAt = expiresAt;
      (connection.stream ?? connection.local).publishEphemeral('session.renewed', { expiresAt });
    }
  }

  close(): Promise<void> {
    this.unsubscribe();
    this.unsubscribeApprovals();
    this.unsubscribeSettings();
    for (const ws of this.connections.keys()) ws.terminate();
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  private accept(ws: WebSocket, session: VerifiedSession, via: 'bearer' | 'cookie') {
    const deliver = (text: string) => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) { ws.close(CLOSE_TOO_SLOW, 'too far behind; sync again'); return; }
      ws.send(text);
    };
    const local = new EventStream(this.epoch, 0);
    local.sink = deliver;
    const connection: Connection = { session, via, expiresAt: session.expiresAt, local, deliver };
    this.connections.set(ws, connection);
    ws.on('close', () => {
      this.connections.delete(ws);
      // Events keep numbering on the device stream while nobody receives them.
      if (connection.stream?.sink === deliver) connection.stream.sink = undefined;
    });
    ws.on('error', () => ws.terminate());
    ws.on('message', (data, isBinary) => this.receive(ws, connection, data, isBinary));
  }

  private receive(ws: WebSocket, connection: Connection, data: RawData, isBinary: boolean) {
    if (Date.parse(connection.expiresAt) <= this.options.now()) { ws.close(1008, 'session ended'); return; }
    const out = () => connection.stream ?? connection.local;
    let envelope: unknown;
    try { if (!isBinary) envelope = JSON.parse(String(data)); } catch { /* handled below */ }
    if (!isObject(envelope)) {
      out().publish('command.rejected', { code: 'invalid-envelope' });
      ws.close(1007, 'invalid envelope');
      return;
    }
    const { v, type, requestId, deviceId } = envelope;
    const id = typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128 ? requestId : undefined;
    if (v !== PROTOCOL_VERSION) {
      out().publish('command.rejected', { code: 'unsupported-version' }, id);
      ws.close(1002, 'unsupported protocol version');
      return;
    }
    // Unknown types are ignored so newer clients keep working. deviceId is never treated as authentication.
    if (typeof type !== 'string' || !KNOWN_COMMANDS.has(type)) return;
    const payload = isObject(envelope.payload) ? envelope.payload : {};
    const reject = (code: string) => out().publish('command.rejected', { code }, id);

    if (type === 'session.sync') return this.sync(ws, connection, deviceId, payload, id);
    if (DEVICE_COMMANDS.has(type)) {
      if (!connection.stream || !connection.deviceId) return reject('sync-required');
      if (deviceId !== connection.deviceId) return reject('device-mismatch');
    }
    const { stream } = connection;
    switch (type) {
      case 'conversation.send':
        if (id === undefined) return reject('invalid-request');
        return this.send(stream!, connection.deviceId!, payload, id);
      case 'conversation.read': {
        const { throughMessageId } = payload;
        if (!isId(throughMessageId)) return reject('invalid-request');
        return answer(stream!, this.options.loop.markRead({ throughMessageId, deviceId: connection.deviceId! }), id);
      }
      case 'notification.ack': {
        // A notification is a notice in the conversation; its ID is the notice's messageId (ADR 0013).
        const { notificationId } = payload;
        if (!isId(notificationId)) return reject('invalid-request');
        return answer(stream!, this.options.loop.acknowledgeNotice({ notificationId, deviceId: connection.deviceId! }), id);
      }
      case 'approval.decide': {
        const { approvalId, revision, decision, text, placement } = payload;
        if (!isId(approvalId) || !Number.isInteger(revision) || typeof decision !== 'string' || !DECISIONS.has(decision)
          || (placement !== undefined && !isPlacement(placement))
          || (decision === 'edit' && (typeof text !== 'string' || text.trim() === '' || Buffer.byteLength(text) > MAX_TEXT_BYTES))) {
          return reject('invalid-request');
        }
        const approvals = this.options.approvals;
        if (!approvals) return reject('invalid-request');
        return answer(stream!, approvals.decide({ approvalId, revision: revision as number, decision: decision as 'approve' | 'edit' | 'reject',
          ...(decision === 'edit' ? { text: text as string } : {}), ...(placement ? { placement: placement as Placement } : {}),
          deviceId: connection.deviceId! }), id);
      }
      case 'model.list': {
        const { loop } = this.options;
        if (loop.unavailable) return stream!.publish('service.unavailable', { code: loop.unavailable }, id);
        return stream!.publish('command.accepted', { ...loop.routeStatus() }, id);
      }
      case 'model.use': {
        const { route } = payload;
        if (typeof route !== 'string' || route === '' || route.length > 64) return reject('invalid-request');
        void this.options.loop.chooseRoute({ route, deviceId: connection.deviceId! }).then(outcome => answer(stream!, outcome, id),
          () => reject('invalid-request'));
        return;
      }
      case 'settings.list':
      case 'settings.set':
      case 'settings.reset': {
        const { settings } = this.options;
        const { key, value } = payload;
        if (!settings) return reject('invalid-request');
        if (type === 'settings.list') return answer(stream!, settings.list(), id);
        if (!isSettingName(key) || (type === 'settings.set' && value === undefined)) return reject('invalid-request');
        const deviceId = connection.deviceId!;
        const outcome = type === 'settings.set' ? settings.set({ key, value, deviceId }) : settings.reset({ key, deviceId });
        void outcome.then(result => answer(stream!, result, id), () => reject('invalid-request'));
        return;
      }
      case 'push.register':
        // A browser registers a Web Push subscription and nothing else, an app never one (ADR 0065).
        if ((connection.via === 'cookie') !== ('subscription' in payload)) return reject('invalid-request');
        // Independent of the loop: a device registers even while natsumi cannot talk.
        return answer(stream!, this.options.push.register(connection.deviceId!, payload), id);
      default:
        // conversation.interrupt among them: a thought in progress is never stopped from outside (ADR 0008).
        return reject('not-implemented');
    }
  }

  private sync(ws: WebSocket, connection: Connection, requested: unknown, payload: Payload, requestId: string | undefined) {
    if (connection.deviceId && requested !== connection.deviceId) {
      connection.stream!.publish('command.rejected', { code: 'device-mismatch' }, requestId);
      return;
    }
    const { session } = connection;
    const deviceId = this.devices.register(requested, session.githubUserId, session.sessionId);
    const stream = this.devices.stream(deviceId);
    for (const [other, otherConnection] of this.connections) {
      if (other === ws || otherConnection.deviceId !== deviceId) continue;
      otherConnection.deviceId = undefined;
      otherConnection.stream = undefined;
      other.close(CLOSE_DEVICE_REPLACED, 'replaced by a newer connection of this device');
    }
    connection.deviceId = deviceId;
    connection.stream = stream;
    stream.sink = connection.deliver;

    const { loop } = this.options;
    // Every answer to a sync tells the client when its session ends now, as renewed by this connection (ADR 0030).
    const sessionExpiresAt = connection.expiresAt;
    if (loop.unavailable) {
      stream.publish('service.unavailable', { code: loop.unavailable, deviceId, sessionExpiresAt, ...this.avatarVersion() }, requestId);
      return;
    }
    const resume = isObject(payload.resume) ? payload.resume : undefined;
    if (resume && resume.epoch === this.epoch && resume.streamId === stream.streamId) {
      const missed = stream.replayAfter(resume.seq);
      if (missed) {
        for (const text of missed) connection.deliver(text);
        stream.publish('command.accepted', { deviceId, mode: 'resume', sessionExpiresAt }, requestId);
        return;
      }
    }
    // A different epoch or stream, a gap, or events already gone from the buffer: start over from a snapshot.
    // Its own seq is the barrier; events numbered after it apply on top.
    stream.publish('session.snapshot', { deviceId, ...loop.snapshot(), pendingApprovals: this.options.approvals?.pending() ?? [], sessionExpiresAt,
      ...this.avatarVersion(), ...(this.options.settings ? { settings: this.options.settings.view() } : {}) }, requestId);
  }

  private avatarVersion() {
    return this.options.avatarVersion === undefined ? {} : { avatarVersion: this.options.avatarVersion };
  }

  private send(stream: EventStream, deviceId: string, payload: Payload, requestId: string) {
    const { text } = payload;
    if (typeof text !== 'string' || text.trim() === '' || Buffer.byteLength(text) > MAX_TEXT_BYTES) {
      stream.publish('command.rejected', { code: 'invalid-request' }, requestId);
      return;
    }
    const outcome = this.options.loop.send({ requestId, deviceId, text });
    if (outcome.kind === 'unavailable') {
      stream.publish('service.unavailable', { code: outcome.code }, requestId);
    } else if (outcome.kind === 'rejected') {
      stream.publish('command.rejected', { code: outcome.code }, requestId);
    } else {
      // The message is already recorded; the loop's own events follow this answer.
      stream.publish('command.accepted', { messageId: outcome.messageId, eventId: outcome.eventId, state: outcome.state }, requestId);
    }
  }
}

/** A setting's name as the envelope carries it; whether it names a setting is the settings' to say. */
const isSettingName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64;
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;

/** Sends the loop's outcome of a read or an acknowledgement to the device that asked. */
function answer(stream: EventStream, outcome: { kind: 'accepted' | 'rejected' | 'unavailable'; code?: string }, requestId: string | undefined) {
  const { kind, ...result } = outcome;
  if (kind === 'accepted') stream.publish('command.accepted', result, requestId);
  else stream.publish(kind === 'rejected' ? 'command.rejected' : 'service.unavailable', { code: result.code }, requestId);
}

function refuse(socket: Duplex, status: number, code: string) {
  const body = JSON.stringify({ error: code });
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Type: application/json\r\n`
    + `Cache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
