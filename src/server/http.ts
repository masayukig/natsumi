import { createReadStream } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { InboxEndpoint } from './a2a-server.ts';
import { MAX_ALERTMANAGER_BODY_BYTES, parseNotification, type AlertNotification } from './alertmanager.ts';
import { avatarManifest, type Avatar } from './avatar.ts';
import { A2A_PUSH_PATH, ConfigError, GITHUB_CALLBACK_PATH, type ListenConfig } from './config.ts';
import type { ConnectionHub } from './connections.ts';
import type { BrowserSessions } from './browser/session-cookie.ts';
import { WebApp } from './browser/web-app.ts';
import { Dashboard } from './dashboard.ts';
import type { GitHubLogin, Outcome } from './github-login.ts';
import type { SessionStore, VerifiedSession } from './sessions.ts';
import type { Received } from './uploads.ts';

const MAX_BODY_BYTES = 8 * 1024;
/** `/v1/images/<imageId>`: the ID is the server's own, of letters, digits and hyphens. */
const IMAGE_PATH = /^\/v1\/images\/([A-Za-z0-9-]{1,128})$/;
/** The files of the chat (ADR 0071): `POST /v1/uploads` takes one, `GET /v1/uploads/<uploadId>` gives back one sent. */
const UPLOADS_PATH = '/v1/uploads';
const UPLOAD_PATH = /^\/v1\/uploads\/(upload-[0-9a-f-]{36})$/;
/** The Slack icon of a feeling (ADR 0040): `/avatar/<feeling>.png`. */
const SLACK_ICON_PATH = /^\/avatar\/([a-z]+)\.png$/;
/** One file of the avatar's bundle under its version (ADR 0057): `/v1/avatar/<version>/<path>`. */
const AVATAR_FILE_PATH = /^\/v1\/avatar\/([0-9a-f]{32})\/(.+)$/;
/** One sender of Alertmanager's notifications (ADR 0086): `POST /v1/alertmanager/<sender>`. */
const ALERTMANAGER_PATH = /^\/v1\/alertmanager\/([^/]*)$/;
/**
 * The most of a push's body taken in (ADR 0092). It is never read, only drained: what an agent pushes is a whole task,
 * artifacts and all, at its largest, and the push that ends a task is far smaller.
 */
export const MAX_A2A_PUSH_BODY_BYTES = 1024 * 1024;

export interface ListenerOptions {
  listen: ListenConfig;
  tlsFiles: { cert: Buffer; key: Buffer } | undefined;
  login: GitHubLogin;
  sessions: SessionStore;
  hub: ConnectionHub;
  allowedUserId: number;
  log: (line: string) => void;
  /** The images the server took from /work (ADR 0044), which the devices fetch by ID with the session. */
  images: { read(imageId: string): Promise<{ mimeType: string; data: Buffer } | undefined> };
  /** The read-only dashboard in the browser (ADR 0049). */
  dashboard: Dashboard;
  /** The chat and the settings in the browser, and the bundle they load (ADR 0058). */
  webApp: WebApp;
  /** The browser's cookie, which the images of the conversation take as the app's bearer (ADR 0058). */
  browser: BrowserSessions;
  /** The avatar read at start (ADR 0057): its bundle for the apps and its Slack icons, all served without a login. */
  avatar: Avatar;
  /** The files attached in the chat (ADR 0071): taken one by one, and given back once a message carries them. */
  uploads: {
    readonly limits: { maxFileBytes: number };
    receive(body: AsyncIterable<Buffer>, input: { name: string; githubUserId: number }): Promise<Received>;
    read(uploadId: string): Promise<{ name: string; bytes: number; mimeType?: string; file: string } | undefined>;
  };
  /** Alertmanager's notifications (ADR 0086), when the config has senders: who may send, and where it is written. */
  alertmanager?: {
    allowed(sender: string, token: string | undefined): boolean;
    receive(sender: string, notification: AlertNotification): Promise<{ recorded: number }>;
  };
  /** The way in over A2A under /a2a/ (ADR 0089), when the config has senders; without it, /a2a/ is not found. */
  a2a?: Pick<InboxEndpoint, 'handle'>;
  /**
   * The pushes of the agents natsumi asked (ADR 0092), when `a2a.pushUrl` is set; without it, `/v1/a2a-push` is not
   * found. `push` says whether a token is one of a waiting task, and with `ring` asks for that task's GetTask.
   */
  a2aPush?: { push(token: string, ring: boolean): boolean };
}

export interface Listener {
  address: { host: string; port: number };
  /** Serves a new certificate to new TLS connections without a restart; open connections keep theirs. */
  updateCertificate(files: { cert: Buffer; key: Buffer }): void;
  close(): Promise<void>;
}

/** The bearer token of `Authorization: Bearer <token>`, if well formed. */
export function bearerToken(request: IncomingMessage): string | undefined {
  return /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(request.headers.authorization ?? '')?.[1];
}

/** HTTPS (or loopback HTTP, as the config allows) with the login routes and the WebSocket upgrade. */
export async function openListener(options: ListenerOptions): Promise<Listener> {
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    route(request, response, options).catch(() => {
      options.log('http: internal-error');
      if (response.headersSent) response.destroy(); else json(response, 500, { error: 'internal-error' });
    });
  };
  let server: Server;
  let secure: HttpsServer | undefined;
  if (options.tlsFiles) {
    try {
      server = secure = createHttpsServer({ ...options.tlsFiles, minVersion: 'TLSv1.2' }, handle);
    } catch {
      throw new ConfigError('listen.tls', 'the certificate and key cannot be used');
    }
  } else {
    server = createHttpServer(handle);
  }
  server.on('upgrade', (request: IncomingMessage, socket, head: Buffer) => options.hub.upgrade(request, socket, head));
  server.on('clientError', (_error, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    const failed = (error: NodeJS.ErrnoException) => reject(new Error(`listen: cannot listen on the configured address (${error.code ?? 'error'})`));
    server.once('error', failed);
    server.listen({ host: options.listen.host, port: options.listen.port }, () => { server.off('error', failed); resolve(); });
  });
  const { address, port } = server.address() as AddressInfo;
  return {
    address: { host: address, port },
    updateCertificate(files) {
      if (!secure) throw new Error('listen: the listener does not use TLS');
      try {
        secure.setSecureContext({ ...files, minVersion: 'TLSv1.2' });
      } catch {
        throw new ConfigError('listen.tls', 'the certificate and key cannot be used');
      }
    },
    async close() {
      await options.hub.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}

async function route(request: IncomingMessage, response: ServerResponse, options: ListenerOptions) {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  if (options.tlsFiles) response.setHeader('strict-transport-security', 'max-age=31536000');
  const url = new URL(request.url ?? '/', 'http://request.invalid');
  const method = request.method;

  // The avatar is the character's public art and name, and nothing else is reachable under these paths (ADR 0057).
  const icon = method === 'GET' ? SLACK_ICON_PATH.exec(url.pathname) : null;
  if (icon) {
    const image = options.avatar.slack(icon[1]!);
    if (!image) return json(response, 404, { error: 'not-found' });
    // Slack fetches and keeps it; the art changes with a restart, not by the minute.
    response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400', 'content-length': image.length }).end(image);
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/avatar') return json(response, 200, avatarManifest(options.avatar));
  const bundled = method === 'GET' ? AVATAR_FILE_PATH.exec(url.pathname) : null;
  if (bundled) {
    const file = bundled[1] === options.avatar.version ? options.avatar.files.get(bundled[2]!) : undefined;
    if (!file) return json(response, 404, { error: 'not-found' });
    // A version names one content for good, so what was fetched under it never needs fetching again.
    response.writeHead(200, { 'content-type': file.contentType, 'cache-control': 'public, max-age=31536000, immutable',
      'content-length': file.data.length }).end(file.data);
    return;
  }
  if (method === 'GET' && url.pathname.startsWith('/v1/images/')) {
    // The session first, so that nothing about an image is told to whoever has none. A fetch is a use and renews it.
    // A browser shows its cookie instead: a GET changes nothing, and a Strict cookie is not sent from another site.
    const token = bearerToken(request);
    const session = token ? options.sessions.verify(token, options.allowedUserId) : undefined;
    const allowed = token ? session !== undefined && options.sessions.renew(session.sessionId) !== undefined
      : options.browser.session(request) !== undefined;
    if (!allowed) return json(response, 401, { error: 'unauthorized' });
    const id = IMAGE_PATH.exec(url.pathname)?.[1];
    const image = id ? await options.images.read(id) : undefined;
    if (!image) return json(response, 404, { error: 'not-found' });
    // An ID names one copy for good (ADR 0045), so the owner's browser keeps it; a shared cache never does.
    response.writeHead(200, { 'content-type': image.mimeType, 'cache-control': 'private, max-age=31536000, immutable',
      'content-length': image.data.length }).end(image.data);
    return;
  }
  if (method === 'POST' && url.pathname === UPLOADS_PATH) return receiveUpload(request, response, url, options);
  const uploadId = method === 'GET' ? UPLOAD_PATH.exec(url.pathname)?.[1] : undefined;
  if (uploadId) {
    // As an image of the conversation: the session first, a bearer or, for a GET, the cookie.
    if (!readerSession(request, options)) return json(response, 401, { error: 'unauthorized' });
    const file = await options.uploads.read(uploadId);
    if (!file) return json(response, 404, { error: 'not-found' });
    // An image is shown in its place; anything else only ever downloads, never runs as a page of this origin.
    const kind = file.mimeType ? { 'content-type': file.mimeType, 'cache-control': 'private, max-age=31536000, immutable' }
      : { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` };
    const stream = createReadStream(file.file);
    const opened = await new Promise<boolean>(resolve => { stream.once('open', () => resolve(true)); stream.once('error', () => resolve(false)); });
    // A file taken away by hand is as one never sent.
    if (!opened) return json(response, 404, { error: 'not-found' });
    response.writeHead(200, { ...kind, 'content-security-policy': "sandbox; default-src 'none'", 'content-length': file.bytes });
    stream.pipe(response);
    return;
  }
  const sender = method === 'POST' && options.alertmanager ? ALERTMANAGER_PATH.exec(url.pathname)?.[1] : undefined;
  if (sender !== undefined) return receiveAlerts(request, response, sender, options.alertmanager!, options.log);
  if (method === 'POST' && url.pathname === A2A_PUSH_PATH && options.a2aPush) return receivePush(request, response, options.a2aPush);
  // The senders' own token or gated's assertion, never the browser's cookie (ADR 0089).
  if (options.a2a && InboxEndpoint.owns(url.pathname)) return options.a2a.handle(request, response, url);
  if (method === 'GET' && url.pathname === '/auth/github/start') return answer(response, options.login.start(url.searchParams));
  if (Dashboard.owns(url.pathname)) return options.dashboard.handle(request, response, url);
  if (WebApp.owns(url.pathname)) return options.webApp.handle(request, response, url);
  if (method === 'GET' && url.pathname === GITHUB_CALLBACK_PATH) {
    const outcome = await options.login.callback(url.searchParams);
    return Dashboard.isBrowser(outcome) ? options.dashboard.finishLogin(response, outcome) : answer(response, outcome);
  }
  if (method === 'POST' && url.pathname === '/auth/session') {
    const body = await readJson(request);
    return body === undefined ? json(response, 400, { error: 'invalid-request' }) : answer(response, options.login.redeem(body));
  }
  if (method === 'POST' && url.pathname === '/auth/logout') {
    const token = bearerToken(request);
    const session = token ? options.sessions.verify(token, options.allowedUserId) : undefined;
    if (!token || !session) return json(response, 401, { error: 'unauthorized' });
    options.sessions.revoke(token);
    options.hub.closeSession(session.sessionId);
    response.writeHead(204).end();
    return;
  }
  json(response, 404, { error: 'not-found' });
}

/** The live session of a GET that reads: the bearer, renewed by the use, or without one the browser's cookie. */
function readerSession(request: IncomingMessage, options: ListenerOptions): VerifiedSession | undefined {
  const token = bearerToken(request);
  if (!token) return options.browser.session(request);
  const session = options.sessions.verify(token, options.allowedUserId);
  const expiresAt = session && options.sessions.renew(session.sessionId);
  return session && expiresAt ? { ...session, expiresAt } : undefined;
}

/**
 * One file of the chat (ADR 0071), its bytes the body and its name `?name=`. It changes state, so a cookie is taken only
 * with the public origin as the Origin, as `/v1/ws` takes it (ADR 0058); a bearer decides alone. A body past the limit
 * is refused as soon as that is known, and the connection is not kept for the rest of it.
 */
async function receiveUpload(request: IncomingMessage, response: ServerResponse, url: URL, options: ListenerOptions) {
  let session: VerifiedSession | undefined;
  if (bearerToken(request)) session = readerSession(request, options);
  else {
    const cookie = options.browser.upgrade(request);
    if (cookie.kind === 'origin-not-allowed') return json(response, 403, { error: 'origin-not-allowed' });
    if (cookie.kind === 'session') session = cookie.session;
  }
  if (!session) return json(response, 401, { error: 'unauthorized' });
  const tooLarge = () => { response.setHeader('connection', 'close'); json(response, 413, { error: 'too-large' }); };
  if (Number(request.headers['content-length'] ?? 0) > options.uploads.limits.maxFileBytes) return tooLarge();
  const received = await options.uploads.receive(request.iterator({ destroyOnReturn: false }),
    { name: url.searchParams.get('name') ?? '', githubUserId: session.githubUserId });
  if (!received.ok) return tooLarge();
  json(response, 201, { ...received.upload });
}

/**
 * A notification of Alertmanager (ADR 0086). The sender's own bearer token only, never the browser's cookie; an unknown
 * sender is refused as a wrong token is. The body is read up to its limit, and answered with a 2xx only once it is
 * written: a 5xx has Alertmanager send it again, which the state kept of every alert makes harmless.
 */
async function receiveAlerts(request: IncomingMessage, response: ServerResponse, sender: string,
  alertmanager: NonNullable<ListenerOptions['alertmanager']>, log: (line: string) => void) {
  const refuse = (status: number, error: string) => { response.setHeader('connection', 'close'); json(response, status, { error }); };
  if (!alertmanager.allowed(sender, bearerToken(request))) return refuse(401, 'unauthorized');
  if (Number(request.headers['content-length'] ?? 0) > MAX_ALERTMANAGER_BODY_BYTES) return refuse(413, 'too-large');
  const body = await readBody(request, MAX_ALERTMANAGER_BODY_BYTES);
  if (body === undefined) return refuse(413, 'too-large');
  let notification: AlertNotification | undefined;
  try { notification = parseNotification(JSON.parse(body.toString('utf8'))); } catch { /* answered below */ }
  if (!notification) return json(response, 400, { error: 'invalid-request' });
  try {
    json(response, 200, await alertmanager.receive(sender, notification));
  } catch {
    log(`alertmanager: a notification of ${sender} could not be written; it is refused for Alertmanager to send again`);
    json(response, 503, { error: 'not-recorded' });
  }
}

/**
 * A push of an agent natsumi asked (ADR 0092): a doorbell for the task its bearer token names, and nothing more. The
 * token is the only way in, never the browser's cookie; an unknown one, none, and one not a bearer are the same 401.
 * A known one is answered at once, before the body and before the GetTask it rings for; the body is drained unread up
 * to its limit. One that says it is larger is refused without ringing.
 */
function receivePush(request: IncomingMessage, response: ServerResponse, push: NonNullable<ListenerOptions['a2aPush']>) {
  const token = bearerToken(request);
  const large = Number(request.headers['content-length'] ?? 0) > MAX_A2A_PUSH_BODY_BYTES;
  response.setHeader('connection', 'close');
  if (!token || !push.push(token, !large)) return json(response, 401, { error: 'unauthorized' });
  if (large) return json(response, 413, { error: 'too-large' });
  let size = 0;
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_A2A_PUSH_BODY_BYTES) request.destroy();
  });
  request.on('error', () => {});
  response.writeHead(204).end();
}

function answer(response: ServerResponse, outcome: Outcome) {
  if ('location' in outcome) response.writeHead(302, { location: outcome.location }).end();
  else json(response, outcome.status, outcome.body);
}

function json(response: ServerResponse, status: number, body: Record<string, unknown>) {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request, MAX_BODY_BYTES);
  if (body === undefined) return undefined;
  try { return JSON.parse(body.toString('utf8')); } catch { return undefined; }
}

/** The body, or undefined as soon as it is past the limit. */
async function readBody(request: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
