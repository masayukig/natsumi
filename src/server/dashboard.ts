import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  classify, DEFAULT_ORDER, FILES_PATH, imageType, listDirectory, locate, look, openFile, readHead, TEXT_LIMIT, type FileRoots, type ListingView,
  type SortKey,
} from './dashboard-files.ts';
import { directoryPage, filePage, filesIndexPage, refusedFilePage } from './dashboard-files-view.ts';
import { approvalsPage, devicesPage, dovePage, memosPage, pageNumber, renderWaits, waitsPage } from './dashboard-lists.ts';
import { APPROVAL_STATES, listApprovals, listDovePosts, readDevices, readWaits, type ApprovalState } from './dashboard-records.ts';
import {
  APPROVALS_PATH, DEVICES_PATH, DOVE_PATH, LOGOUT_PATH, MEMOS_PATH, messagePage, REFRESHED_PATHS, refusedPage, renderStatus, SIGNED_OUT_PATH,
  signedInPage, signedOutPage, STATIC_FILES, STATS_PATH, STATUS_PATH, statusPage, TURNS_PATH, WAITS_LIVE_PATH, WAITS_PATH, type DashboardStatus,
} from './dashboard-view.ts';
import { statsPage, statsTokens } from './dashboard-charts.ts';
import { readStats, statsPeriod } from './dashboard-stats.ts';
import { turnPage, turnsPage } from './dashboard-turns.ts';
import { DASHBOARD_PATH, type BrowserOutcome, type GitHubLogin, type Outcome } from './github-login.ts';
import type { Html } from './html.ts';
import { AGENT_LIST_DIRECTORY } from './agent-list.ts';
import { codeManualDirectory } from './manual.ts';
import { AVATAR_MANUAL_DIRECTORY } from './avatar-manual.ts';
import { HOME_DIRECTORY, WORK_DIRECTORY } from './paths.ts';
import type { SessionStore } from './sessions.ts';
import { checkHealth, readStatus } from './status.ts';
import type { LoopDashboardState, TurnInProgress } from './thinking-loop.ts';
import { findTurn, listMemoTurns, listTurns, readMemo, readTurn, turnImages } from './turn-log.ts';

/**
 * The read-only dashboard in the browser (ADR 0049), under /dashboard.
 *
 * The login is the app's GitHub login, ending here with a session in a cookie: HttpOnly, SameSite=Strict and
 * Path=/dashboard, so the app's ways in (`/v1/ws`, `/v1/images/`, `/auth/*`) are never sent it and never read it. It is
 * Secure whenever the public origin is https, which it is everywhere but a loopback test: behind a proxy TLS ends in
 * front of the server, and the browser still sees https. The session is the app's kind, stored as a hash, checked
 * against `allowedUserId` on every request and renewed by use (ADR 0030); the cookie is set again with each renewal.
 *
 * Nothing here changes state but the logout, a POST whose Origin must be the public origin.
 */

export const DASHBOARD_COOKIE = 'natsumi_dashboard';

/**
 * Only the dashboard's own files, and none of the app's: `default-src 'self'` with nothing inline, and no framing.
 * `img-src` takes `data:` for the icons a later page may draw; no script runs from anywhere but this origin's file.
 */
export const DASHBOARD_CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');

/** The loop as the dashboard uses it: reads of what it keeps, and no way to change any of it. */
export interface DashboardLoop {
  dashboardState(): LoopDashboardState;
  turnInProgress(): TurnInProgress | undefined;
}

export interface DashboardOptions {
  publicOrigin: string;
  allowedUserId: number;
  sessions: SessionStore;
  login: GitHubLogin;
  loop: DashboardLoop;
  dataDirectory: string;
  /** The memory repository (`loop.memoryRepository`, by default `memory/` in the data directory), seen as /memory (ADR 0054). */
  memoryDirectory: string;
  /** The manual seen as /manual; by default the `manual/` that came with the code (ADR 0054). */
  manualDirectory?: string;
  /** The avatar's display name, in the dashboard's words (ADR 0057). natsumi's when left out. */
  name?: string;
  /** The state database, read for the turns' rows and the session files the conversation used (ADR 0049). */
  db: DatabaseSync;
  /** Where the Pi session records are; nothing outside it is opened. */
  sessionDirectory: string;
  timeZone: string;
  /** When the nightly switch runs (ADR 0009), or false when it is off; the failures and waits say when it is next. */
  nightlyRotationAt: string | false;
  /** Whether a device has a live connection now; the devices list shows it. */
  isConnected: (deviceId: string) => boolean;
  now: () => number;
}

/** `assets/dashboard` beside `src/` in a checkout, and beside `dist/` in the image. */
const STATIC_DIRECTORIES = ['../../assets/dashboard/', '../../../assets/dashboard/'].map(path => fileURLToPath(new URL(path, import.meta.url)));
const STATIC_TYPES: Record<string, string> = {
  [STATIC_FILES.css]: 'text/css; charset=utf-8',
  [STATIC_FILES.js]: 'text/javascript; charset=utf-8',
};
const staticCache = new Map<string, Buffer>();

/**
 * The images a turn's page shows, by their recorded type: those a browser takes as a picture and nothing more. An SVG
 * or anything else recorded is not served, since it could carry script.
 */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** A turn ID as the loop makes them; anything else is not looked up. */
const TURN_ID = /^turn-[A-Za-z0-9-]{1,80}$/;
const TURN_ROUTE = /^\/dashboard\/turns\/([^/]+)(?:\/images\/(0|[1-9][0-9]{0,5}))?$/;

/** A session token as `SessionStore` issues it: 32 random bytes in base64url. Anything else is not looked up. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export class Dashboard {
  private readonly options: DashboardOptions;
  private readonly secure: boolean;

  constructor(options: DashboardOptions) {
    this.options = options;
    this.secure = new URL(options.publicOrigin).protocol === 'https:';
  }

  /** Whether the path is the dashboard's to answer. */
  static owns(pathname: string): boolean {
    return pathname === DASHBOARD_PATH || pathname.startsWith(`${DASHBOARD_PATH}/`);
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    setSecurityHeaders(response);
    const path = url.pathname;
    const method = request.method;

    const type = STATIC_TYPES[path];
    if (path.startsWith('/dashboard/static/')) {
      const file = type && method === 'GET' ? await staticFile(path) : undefined;
      if (!file) return send(response, 404, messagePage('見つかりません'));
      response.writeHead(200, { 'content-type': type, 'content-length': file.length }).end(file);
      return;
    }
    if (path === SIGNED_OUT_PATH && method === 'GET') return send(response, 200, signedOutPage());
    if (path === LOGOUT_PATH) {
      if (method !== 'POST') return send(response, 405, messagePage('この方法では受け付けていません'), { allow: 'POST' });
      return this.logout(request, response);
    }
    if (method !== 'GET') return send(response, 405, messagePage('この方法では受け付けていません'), { allow: 'GET' });

    const session = this.session(request);
    if (!session) {
      const cleared: Record<string, string> = cookieHeader(request) ? { 'set-cookie': this.cookie('', 0) } : {};
      // A refreshed section is fetched by the script, which cannot follow a login; it reloads the page instead.
      if (REFRESHED_PATHS.has(path)) return send(response, 401, messagePage('ログインが切れました'), cleared);
      const outcome = this.options.login.startBrowser();
      if ('location' in outcome) {
        response.writeHead(302, { location: outcome.location, ...cleared }).end();
        return;
      }
      return send(response, outcome.status, refusedPage(String(outcome.body.error)), cleared);
    }
    const renewed = { 'set-cookie': this.cookie(session.token, Date.parse(session.expiresAt)) };
    if (path === DASHBOARD_PATH) return send(response, 200, statusPage(await this.status()), renewed);
    if (path === STATUS_PATH) return send(response, 200, renderStatus(await this.status()), renewed);
    if (path === TURNS_PATH) return this.turns(response, url, renewed);
    if (path === WAITS_PATH) return send(response, 200, waitsPage(this.waits(), this.options.timeZone), renewed);
    if (path === WAITS_LIVE_PATH) return send(response, 200, renderWaits(this.waits(), this.options.timeZone), renewed);
    if (path === MEMOS_PATH) return this.memos(response, url, renewed);
    if (path === DOVE_PATH) return this.dove(response, url, renewed);
    if (path === APPROVALS_PATH) return this.approvals(response, url, renewed);
    if (path === DEVICES_PATH) {
      const view = readDevices(this.options.db, { now: this.options.now(), isConnected: this.options.isConnected });
      return send(response, 200, devicesPage(view, session.sessionId, this.options.timeZone), renewed);
    }
    if (path === STATS_PATH) return this.stats(response, url, renewed);
    if (path === FILES_PATH) return send(response, 200, filesIndexPage(this.options.name), renewed);
    if (path.startsWith(`${FILES_PATH}/`)) return this.files(response, url, renewed);
    const turn = TURN_ROUTE.exec(path);
    if (turn) return this.turn(response, turn[1]!, turn[2] === undefined ? undefined : Number(turn[2]), renewed);
    send(response, 404, messagePage('見つかりません', true), renewed);
  }

  /** The list of turns, from SQLite alone, a page at a time. */
  private turns(response: ServerResponse, url: URL, headers: Record<string, string>): void {
    const page = pageNumber(url);
    if (page === 0) return send(response, 404, messagePage('見つかりません', true), headers);
    send(response, 200, turnsPage({ ...listTurns(this.options.db, page), page }, this.options.timeZone), headers);
  }

  private waits() {
    const { db, now, nightlyRotationAt, timeZone } = this.options;
    return readWaits(db, { now: now(), nightlyRotationAt, timeZone });
  }

  /**
   * A page of memos: the turns from SQLite, and each memo read from the end of its turn's place, one after another, so
   * a page reads at most MEMOS_PER_PAGE bounded windows (ADR 0049).
   */
  private async memos(response: ServerResponse, url: URL, headers: Record<string, string>): Promise<void> {
    const page = pageNumber(url);
    if (page === 0) return send(response, 404, messagePage('見つかりません', true), headers);
    const { rows, more } = listMemoTurns(this.options.db, page);
    const source = { db: this.options.db, sessionDirectory: this.options.sessionDirectory };
    const memos = [];
    for (const row of rows) memos.push({ row, memo: await readMemo(source, row) });
    send(response, 200, memosPage({ page, more, memos }, this.options.timeZone), headers);
  }

  private dove(response: ServerResponse, url: URL, headers: Record<string, string>): void {
    const page = pageNumber(url);
    if (page === 0) return send(response, 404, messagePage('見つかりません', true), headers);
    send(response, 200, dovePage({ ...listDovePosts(this.options.db, page), page }, this.options.timeZone, this.options.name), headers);
  }

  /** The charts of a period, from `turn_stats` alone and counted by SQLite (ADR 0049), with the series of tokens chosen. */
  private stats(response: ServerResponse, url: URL, headers: Record<string, string>): void {
    const period = statsPeriod(url);
    const tokens = statsTokens(url);
    if (!period || !tokens) return send(response, 404, messagePage('見つかりません', true), headers);
    const { db, now, timeZone } = this.options;
    send(response, 200, statsPage(readStats(db, { period, now: now(), timeZone }), timeZone, tokens), headers);
  }

  /** The approvals, all or those of one outcome; an outcome not in the list is not a page. */
  private approvals(response: ServerResponse, url: URL, headers: Record<string, string>): void {
    const page = pageNumber(url);
    const asked = url.searchParams.getAll('state');
    const state = asked.length === 1 && (APPROVAL_STATES as readonly string[]).includes(asked[0]!) ? asked[0] as ApprovalState : undefined;
    if (page === 0 || asked.length > 1 || (asked.length === 1 && state === undefined)) return send(response, 404, messagePage('見つかりません', true), headers);
    const list = listApprovals(this.options.db, { page, now: this.options.now(), ...(state ? { state } : {}) });
    send(response, 200, approvalsPage({ ...list, page, ...(state ? { state } : {}) }, this.options.timeZone), headers);
  }

  /** A turn read from the session record, recorded or still running; or one of its images. */
  private async turn(response: ServerResponse, turnId: string, image: number | undefined, headers: Record<string, string>): Promise<void> {
    const notFound = () => send(response, 404, messagePage('見つかりません', true), headers);
    if (!TURN_ID.test(turnId)) return notFound();
    const source = { db: this.options.db, sessionDirectory: this.options.sessionDirectory };
    const row = findTurn(this.options.db, turnId);
    const running = row ? undefined : this.options.loop.turnInProgress();
    const inProgress = running?.turnId === turnId ? running : undefined;
    if (!row && !inProgress) return notFound();
    const reading = await readTurn(source, row ? { row } : { inProgress: inProgress! });
    if (image === undefined) return send(response, 200, turnPage({ ...(row ? { row } : { inProgress }), reading }, this.options.timeZone), headers);
    const picture = reading.found ? turnImages(reading.entries)[image] : undefined;
    if (!picture || !IMAGE_TYPES.has(picture.mimeType)) return notFound();
    const body = Buffer.from(picture.data, 'base64');
    response.writeHead(200, { 'content-type': picture.mimeType, 'content-length': body.length, ...headers }).end(body);
  }

  /**
   * One of her files or directories (ADR 0054): a directory one level down, a file's page with the head of it, its
   * bytes as a download, or its bytes as a picture when they are one.
   */
  private async files(response: ServerResponse, url: URL, headers: Record<string, string>): Promise<void> {
    const location = locate(url.pathname);
    const query = fileQuery(url);
    if (!location || !query) return send(response, 404, messagePage('見つかりません', true), headers);
    const roots = await this.fileRoots();
    const refused = (reason: Parameters<typeof refusedFilePage>[0]['reason'], target?: string) =>
      send(response, 404, refusedFilePage({ location, reason, ...(target === undefined ? {} : { target }) }, this.options.name), headers);
    if (query.download || query.image) {
      const opened = await openFile(roots, location);
      if (opened.kind === 'refused') return refused(opened.reason, opened.target);
      const { handle, size } = opened;
      let mimeType: string | undefined;
      if (query.image) {
        const head = Buffer.alloc(16);
        const { bytesRead } = await handle.read(head, 0, head.length, 0).catch(() => ({ bytesRead: 0 }));
        mimeType = imageType(head.subarray(0, bytesRead));
        if (!mimeType) {
          await handle.close();
          return send(response, 404, messagePage('見つかりません', true), headers);
        }
      }
      response.writeHead(200, {
        'content-type': mimeType ?? 'application/octet-stream', 'content-length': size, 'x-content-type-options': 'nosniff',
        ...(query.download ? { 'content-disposition': attachment(location.segments.at(-1) ?? 'file') } : {}), ...headers,
      });
      // The file is streamed from the handle that was checked, and closed by the stream when it ends or fails.
      await pipeline(handle.createReadStream({ start: 0 }), response).catch(() => { response.destroy(); });
      return;
    }
    const found = await look(roots, location);
    if (found.kind === 'refused') return refused(found.reason, found.target);
    if (found.kind === 'directory') {
      if (query.raw || !query.listing) return send(response, 404, messagePage('見つかりません', true), headers);
      const listed = listDirectory(found, query.listing);
      return send(response, 200, directoryPage({ location, view: query.listing, ...listed }, this.options.timeZone), headers);
    }
    const head = await readHead(roots, location, TEXT_LIMIT);
    if (head.kind === 'refused') return refused(head.reason, head.target);
    const content = classify(head.head, head.size, TEXT_LIMIT);
    send(response, 200, filePage({ location, size: head.size, mtimeMs: head.mtimeMs, content, raw: query.raw }, this.options.timeZone), headers);
  }

  private async fileRoots(): Promise<FileRoots> {
    const { dataDirectory, memoryDirectory, manualDirectory } = this.options;
    return {
      memory: memoryDirectory, work: join(dataDirectory, WORK_DIRECTORY), home: join(dataDirectory, HOME_DIRECTORY),
      agents: join(dataDirectory, AGENT_LIST_DIRECTORY), avatar: join(dataDirectory, AVATAR_MANUAL_DIRECTORY),
      manual: manualDirectory ?? await codeManualDirectory(),
    };
  }

  /** The callback's answer to a login that began here. */
  finishLogin(response: ServerResponse, outcome: BrowserOutcome): void {
    setSecurityHeaders(response);
    if (outcome.browser === 'refused') return send(response, outcome.status, refusedPage(outcome.code));
    // Not a redirect: a Strict cookie is not sent on a navigation that began at GitHub, and a redirect carries that
    // navigation on. A page of this origin that moves on starts a navigation of its own, which the cookie goes with.
    send(response, 200, signedInPage(), {
      'set-cookie': this.cookie(outcome.session.token, Date.parse(outcome.session.expiresAt)),
    });
  }

  /** Whether a callback outcome is one of the dashboard's. */
  static isBrowser(outcome: Outcome | BrowserOutcome): outcome is BrowserOutcome {
    return 'browser' in outcome;
  }

  /** The live, allowed session of the cookie, renewed by this use; undefined otherwise. */
  private session(request: IncomingMessage): { token: string; sessionId: string; expiresAt: string } | undefined {
    const token = cookieValue(request);
    if (!token || !TOKEN.test(token)) return undefined;
    const { sessions, allowedUserId } = this.options;
    const verified = sessions.verify(token, allowedUserId);
    const expiresAt = verified && sessions.renew(verified.sessionId);
    return verified && expiresAt ? { token, sessionId: verified.sessionId, expiresAt } : undefined;
  }

  private logout(request: IncomingMessage, response: ServerResponse): void {
    // The CSRF check (ADR 0049): a form of this origin sends its Origin with a POST; anything else is refused.
    if (request.headers.origin !== this.options.publicOrigin) return send(response, 403, messagePage('ログアウトできませんでした'));
    const token = cookieValue(request);
    if (token && TOKEN.test(token) && this.options.sessions.verify(token, this.options.allowedUserId)) this.options.sessions.revoke(token);
    response.writeHead(303, { location: SIGNED_OUT_PATH, 'set-cookie': this.cookie('', 0) }).end();
  }

  private async status(): Promise<DashboardStatus> {
    const status = await readStatus(this.options.dataDirectory);
    const health = checkHealth(status, this.options.now());
    return {
      server: { ...health, ...(status ? { startedAt: status.startedAt, updatedAt: status.updatedAt } : {}) },
      loop: this.options.loop.dashboardState(),
      timeZone: this.options.timeZone,
    };
  }

  /** The cookie line; an end of 0 clears it. */
  private cookie(value: string, endsAt: number): string {
    return dashboardCookie(value, endsAt, this.options.now(), this.secure);
  }
}

/** The Set-Cookie line of the dashboard session: ends at `endsAt`, or is cleared when that is 0. */
export function dashboardCookie(value: string, endsAt: number, now: number, secure: boolean): string {
  const maxAge = endsAt === 0 ? 0 : Math.max(0, Math.floor((endsAt - now) / 1000));
  const expires = new Date(endsAt === 0 ? 0 : endsAt).toUTCString();
  return [`${DASHBOARD_COOKIE}=${value}`, `Path=${DASHBOARD_PATH}`, `Expires=${expires}`, `Max-Age=${maxAge}`, 'HttpOnly',
    ...(secure ? ['Secure'] : []), 'SameSite=Strict'].join('; ');
}

function setSecurityHeaders(response: ServerResponse) {
  response.setHeader('content-security-policy', DASHBOARD_CSP);
  response.setHeader('x-frame-options', 'DENY');
}

function cookieHeader(request: IncomingMessage): boolean {
  return (request.headers.cookie ?? '').split(';').some(part => part.trim().startsWith(`${DASHBOARD_COOKIE}=`));
}

/** The dashboard cookie's value, when there is exactly one. */
function cookieValue(request: IncomingMessage): string | undefined {
  const values = (request.headers.cookie ?? '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${DASHBOARD_COOKIE}=`)).map(part => part.slice(DASHBOARD_COOKIE.length + 1));
  return values.length === 1 ? values[0] : undefined;
}

function send(response: ServerResponse, status: number, body: Html, headers: Record<string, string> = {}) {
  const text = Buffer.from(body.text, 'utf8');
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': text.length, ...headers }).end(text);
}

interface FileQuery {
  raw: boolean;
  download: boolean;
  image: boolean;
  /** The listing's view, when the query is one a directory takes. */
  listing?: ListingView;
}

const FLAGS = ['raw', 'download', 'image', 'hidden'] as const;
const SORT_KEYS: readonly SortKey[] = ['name', 'mtime', 'size'];

/** The query of a file or a directory; undefined when a value is not one of those taken, or is given twice. */
function fileQuery(url: URL): FileQuery | undefined {
  const params = url.searchParams;
  const one = (name: string) => {
    const values = params.getAll(name);
    return values.length > 1 ? null : values[0];
  };
  const flags: Record<string, boolean> = {};
  for (const name of FLAGS) {
    const value = one(name);
    if (value === null || (value !== undefined && value !== '1')) return undefined;
    flags[name] = value === '1';
  }
  const sort = one('sort');
  const order = one('order');
  if (sort === null || order === null) return undefined;
  if (sort !== undefined && !(SORT_KEYS as readonly string[]).includes(sort)) return undefined;
  if (order !== undefined && order !== 'asc' && order !== 'desc') return undefined;
  if ([flags.raw, flags.download, flags.image].filter(Boolean).length > 1) return undefined;
  const key = (sort ?? 'name') as SortKey;
  const forFile = flags.raw || flags.download || flags.image;
  const forListing = flags.hidden || sort !== undefined || order !== undefined;
  if (forFile && forListing) return undefined;
  return {
    raw: flags.raw!, download: flags.download!, image: flags.image!,
    ...(forFile ? {} : { listing: { hidden: flags.hidden!, sort: key, order: order ?? DEFAULT_ORDER[key] } }),
  };
}

/** The Content-Disposition of a download: the name in UTF-8 by RFC 6266, and a plain fallback that cannot end the header's quote. */
function attachment(name: string): string {
  const plain = name.replace(/[^A-Za-z0-9._-]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`;
}

async function staticFile(path: string): Promise<Buffer | undefined> {
  const cached = staticCache.get(path);
  if (cached) return cached;
  const name = path.slice('/dashboard/static/'.length);
  for (const directory of STATIC_DIRECTORIES) {
    try {
      const file = await readFile(`${directory}${name}`);
      staticCache.set(path, file);
      return file;
    } catch { /* the other place */ }
  }
  return undefined;
}
