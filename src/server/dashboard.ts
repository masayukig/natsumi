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
import {
  approvalsPage, checkPage, checksPage, devicesPage, dovePage, goalsPage, memosPage, pageNumber, postboxPage, renderWaits, waitsPage,
} from './dashboard-lists.ts';
import {
  APPROVAL_STATES, findSelfCheck, listApprovals, listDovePosts, listSelfChecks, readDevices, readWaits, type ApprovalState,
} from './dashboard-records.ts';
import {
  APPROVALS_PATH, CHECKS_PATH, DEVICES_PATH, DOVE_PATH, GOALS_PATH, LOGOUT_PATH, MEMOS_PATH, messagePage, POSTBOX_PATH, REFRESHED_PATHS, refusedPage, renderStatus, SIGNED_OUT_PATH, SLEEP_PATH,
  signedInPage, signedOutPage, STATIC_FILES, STATS_PATH, STATUS_PATH, statusPage, TURNS_PATH, WAITS_LIVE_PATH, WAITS_PATH, type DashboardStatus,
} from './dashboard-view.ts';
import { statsPage, statsTokens } from './dashboard-charts.ts';
import { sleepPage } from './dashboard-sleep.ts';
import {
  SENTINEL_PATH, SENTINEL_RECORDS_PATH, sentinelApprovalPage, sentinelApprovalPath, sentinelGrantPage, sentinelPage, sentinelRecordPage,
  sentinelRecordsPage, sentinelRefusedPage, sentinelUnreachablePage,
} from './dashboard-sentinel.ts';
import { APPROVAL_ID, GRANT_ID, type SentinelClient, type SentinelResult } from './sentinel-client.ts';
import { readStats, statsPeriod } from './dashboard-stats.ts';
import { turnPage, turnsPage } from './dashboard-turns.ts';
import { DASHBOARD_PATH, type BrowserOutcome, type GitHubLogin, type Outcome } from './github-login.ts';
import type { BrowserSessions } from './browser/session-cookie.ts';
import type { Html } from './html.ts';
import type { ToolOutcome } from './loop-tools.ts';
import { AGENT_LIST_DIRECTORY } from './agent-list.ts';
import { codeManualDirectory } from './manual.ts';
import { AVATAR_MANUAL_DIRECTORY } from './avatar-manual.ts';
import { HOME_DIRECTORY, SOURCES_DIRECTORY, WORK_DIRECTORY } from './paths.ts';
import type { SessionStore } from './sessions.ts';
import { readGoalChanges } from './goals.ts';
import { PostboxLedger } from './postbox.ts';
import { checkHealth, readStatus } from './status.ts';
import type { PillJudgement } from './sleeping-pill.ts';
import type { LoopDashboardState, TakePillOutcome, TurnInProgress } from './thinking-loop.ts';
import { findTurn, listMemoTurns, listTurns, readMemo, readTurn, turnImages } from './turn-log.ts';

/**
 * The read-only dashboard in the browser (ADR 0049), under /dashboard.
 *
 * The login is the app's GitHub login, ending with a session in the browser's cookie (ADR 0058, `browser/`), the one
 * the chat and the settings use too. A browser that still has the dashboard's cookie of before is moved to it here.
 *
 * Nothing here changes state but the POSTs whose Origin must be the public origin: the logout, the owner's cancel
 * of one self-check (ADR 0064), made through the loop's own `SelfChecks.cancel`, the sleeping pill (ADR 0077), given
 * through the loop as the WebSocket's `sleep.take` gives it, and where the config names the sentinel, the owner's answer
 * to one of its approvals and the revoke of one of its grants (ADR 0096), passed to its socket as they are. The chat and
 * the settings change state over the WebSocket, not here (ADR 0058).
 */

/**
 * Only the dashboard's own files, and none of the app's: `default-src 'self'` with nothing inline, and no framing.
 * `img-src` takes `data:` for the icons a later page may draw; no script runs from anywhere but this origin's file.
 */
export const DASHBOARD_CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');

/**
 * The loop as the dashboard uses it: reads of what it keeps, and the two changes it takes, a self-check's cancel
 * (ADR 0064) and the sleeping pill (ADR 0077).
 */
export interface DashboardLoop {
  dashboardState(): LoopDashboardState;
  turnInProgress(): TurnInProgress | undefined;
  cancelSelfCheck(checkId: string): ToolOutcome;
  sleepStatus(): Promise<PillJudgement>;
  takeSleepingPill(): Promise<TakePillOutcome>;
}

export interface DashboardOptions {
  publicOrigin: string;
  allowedUserId: number;
  sessions: SessionStore;
  /** The browser's cookie and the session in it (ADR 0058). */
  browser: BrowserSessions;
  login: GitHubLogin;
  loop: DashboardLoop;
  dataDirectory: string;
  /** The memory repository (`loop.memoryRepository`, by default `memory/` in the data directory), seen as /memory (ADR 0054). */
  memoryDirectory: string;
  /** The manual seen as /manual; by default the `manual/` that came with the code (ADR 0054). */
  manualDirectory?: string;
  /** The avatar's display name, in the dashboard's words (ADR 0057). natsumi's when left out. */
  name?: string;
  /** The avatar's ID, heading every page (ADR 0057). natsumi's when left out. */
  avatarId?: string;
  /** The state database, read for the turns' rows and the session files the conversation used (ADR 0049). */
  db: DatabaseSync;
  /** Where the Pi session records are; nothing outside it is opened. */
  sessionDirectory: string;
  timeZone: string;
  /** When the nightly switch runs (ADR 0009), or false when it is off; the failures and waits say when it is next. */
  nightlyRotationAt: string | false;
  /** `curator.pillStopStartingAfterMinutes`, for the sleeping pill's page to say how long she would sleep (ADR 0077). */
  pillStopStartingAfterMinutes?: number | false;
  /** Whether a device has a live connection now; the devices list shows it. */
  isConnected: (deviceId: string) => boolean;
  now: () => number;
  /** The sentinel's approvals socket, where the config names it (ADR 0096). Without it there is nothing under /dashboard/sentinel. */
  sentinel?: DashboardSentinel;
}

/** The sentinel as the dashboard reaches it: its socket, asked on every page, and whether its events are followed now. */
export interface DashboardSentinel {
  client: SentinelClient;
  connected(): boolean;
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
/** A self-check's page, or its cancel; the ID is one `SelfChecks` makes (`check-` and a UUID), or nothing is looked up. */
const CHECK_ID = /^check-[A-Za-z0-9-]{1,80}$/;
const CHECK_ROUTE = /^\/dashboard\/checks\/(check-[A-Za-z0-9-]{1,80})(\/cancel)?$/;
/** The sentinel's POSTs (ADR 0096): an approval's answer, and a grant's revoke. The ids are the sentinel's shapes. */
const SENTINEL_POST = /^\/dashboard\/sentinel\/(?:approvals\/(ap-[A-Za-z0-9_-]{1,100})\/answer|grants\/(gr-[A-Za-z0-9_-]{1,100})\/revoke)$/;
const SENTINEL_APPROVAL = /^\/dashboard\/sentinel\/approvals\/([^/]+)$/;
const SENTINEL_GRANT = /^\/dashboard\/sentinel\/grants\/([^/]+)$/;
const SENTINEL_RECORD = /^\/dashboard\/sentinel\/records\/([1-9][0-9]{0,15})$/;
/** A choice as the sentinel names them (`once`, `1h`, `30d`, `forever`): handed on as it is, never read. */
const CHOICE = /^[A-Za-z0-9_-]{1,32}$/;
/** A form of the answer holds two short fields; anything longer is not one. */
const MAX_FORM_BYTES = 4096;
const RECORDS_PER_PAGE = 50;

type Headers = Record<string, string | string[]>;

export class Dashboard {
  private readonly options: DashboardOptions;

  constructor(options: DashboardOptions) {
    this.options = options;
  }

  /** Whether the path is the dashboard's to answer. */
  static owns(pathname: string): boolean {
    return pathname === DASHBOARD_PATH || pathname.startsWith(`${DASHBOARD_PATH}/`);
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    setSecurityHeaders(response);
    // A form's POST carries its Origin only when its page lets the referrer go to its own origin: under `no-referrer`
    // the Fetch standard sends `Origin: null`, which the checks below refuse. Elsewhere nothing goes out still.
    response.setHeader('referrer-policy', 'same-origin');
    const path = url.pathname;
    const method = request.method;

    const type = STATIC_TYPES[path];
    if (path.startsWith('/dashboard/static/')) {
      const file = type && method === 'GET' ? await staticFile(path) : undefined;
      if (!file) return send(response, 404, this.message('見つかりません'));
      response.writeHead(200, { 'content-type': type, 'content-length': file.length }).end(file);
      return;
    }
    if (path === SIGNED_OUT_PATH && method === 'GET') return send(response, 200, signedOutPage(this.options.avatarId));
    if (path === LOGOUT_PATH) {
      if (method !== 'POST') return send(response, 405, this.message('この方法では受け付けていません'), { allow: 'POST' });
      return this.logout(request, response);
    }
    const sentinelPost = this.options.sentinel ? SENTINEL_POST.exec(path) : null;
    if (sentinelPost) {
      if (method !== 'POST') return send(response, 405, this.message('この方法では受け付けていません'), { allow: 'POST' });
      return sentinelPost[1] ? this.answerSentinel(request, response, sentinelPost[1]) : this.revokeGrant(request, response, sentinelPost[2]!);
    }
    const check = CHECK_ROUTE.exec(path);
    if (check?.[2]) {
      if (method !== 'POST') return send(response, 405, this.message('この方法では受け付けていません'), { allow: 'POST' });
      return this.cancelCheck(request, response, check[1]!);
    }
    // The page asks, and the same path takes the pill (ADR 0077).
    if (path === SLEEP_PATH && method !== 'GET') {
      if (method !== 'POST') return send(response, 405, this.message('この方法では受け付けていません'), { allow: 'GET, POST' });
      return this.takePill(request, response);
    }
    if (method !== 'GET') return send(response, 405, this.message('この方法では受け付けていません'), { allow: 'GET' });

    // The one place the old cookie is still sent, and read, to be replaced by the new one.
    const { browser } = this.options;
    const session = browser.session(request, { legacy: true });
    if (!session) {
      const cleared: Headers = browser.presented(request) ? { 'set-cookie': browser.cleared() } : {};
      // A refreshed section is fetched by the script, which cannot follow a login; it reloads the page instead.
      if (REFRESHED_PATHS.has(path)) return send(response, 401, this.message('ログインが切れました'), cleared);
      const outcome = this.options.login.startBrowser();
      if ('location' in outcome) {
        response.writeHead(302, { location: outcome.location, ...cleared }).end();
        return;
      }
      return send(response, outcome.status, refusedPage(String(outcome.body.error), this.options.avatarId), cleared);
    }
    const renewed: Headers = { 'set-cookie': browser.renewed(session) };
    if (path === DASHBOARD_PATH) return send(response, 200, statusPage(await this.status(), this.options.avatarId), renewed);
    if (path === STATUS_PATH) return send(response, 200, renderStatus(await this.status()), renewed);
    if (path === TURNS_PATH) return this.turns(response, url, renewed);
    if (path === WAITS_PATH) return send(response, 200, waitsPage(this.waits(), this.options.timeZone, this.options.avatarId), renewed);
    if (path === WAITS_LIVE_PATH) return send(response, 200, renderWaits(this.waits(), this.options.timeZone), renewed);
    if (path === CHECKS_PATH) return this.checks(response, url, renewed);
    if (path === SLEEP_PATH) return this.sleep(response, url, renewed);
    if (check) {
      const booked = findSelfCheck(this.options.db, check[1]!);
      if (!booked) return send(response, 404, this.message('待っている予約ではありません', true), renewed);
      return send(response, 200, checkPage(booked, this.options.timeZone, this.options.avatarId), renewed);
    }
    if (path === POSTBOX_PATH) {
      const letters = new PostboxLedger(this.options.db, this.options.now).list();
      return send(response, 200, postboxPage(letters, this.options.timeZone, this.options.avatarId), renewed);
    }
    if (path === GOALS_PATH) {
      const changes = await readGoalChanges(this.options.memoryDirectory);
      return send(response, 200, goalsPage(changes, this.options.timeZone, this.options.avatarId), renewed);
    }
    if (path === MEMOS_PATH) return this.memos(response, url, renewed);
    if (path === DOVE_PATH) return this.dove(response, url, renewed);
    if (path === APPROVALS_PATH) return this.approvals(response, url, renewed);
    if (path === DEVICES_PATH) {
      const view = readDevices(this.options.db, { now: this.options.now(), isConnected: this.options.isConnected });
      return send(response, 200, devicesPage(view, session.sessionId, this.options.timeZone, this.options.avatarId), renewed);
    }
    if (path === STATS_PATH) return this.stats(response, url, renewed);
    if (this.options.sentinel && (path === SENTINEL_PATH || path.startsWith(`${SENTINEL_PATH}/`))) return this.sentinel(response, url, this.options.sentinel, renewed);
    if (path === FILES_PATH) return send(response, 200, filesIndexPage(this.options.name, this.options.avatarId), renewed);
    if (path.startsWith(`${FILES_PATH}/`)) return this.files(response, url, renewed);
    const turn = TURN_ROUTE.exec(path);
    if (turn) return this.turn(response, turn[1]!, turn[2] === undefined ? undefined : Number(turn[2]), renewed);
    send(response, 404, this.message('見つかりません', true), renewed);
  }

  /** The list of turns, from SQLite alone, a page at a time. */
  private turns(response: ServerResponse, url: URL, headers: Headers): void {
    const page = pageNumber(url);
    if (page === 0) return send(response, 404, this.message('見つかりません', true), headers);
    send(response, 200, turnsPage({ ...listTurns(this.options.db, page), page }, this.options.timeZone, this.options.avatarId), headers);
  }

  private waits() {
    const { db, now, nightlyRotationAt, timeZone } = this.options;
    return readWaits(db, { now: now(), nightlyRotationAt, timeZone });
  }

  /** The self-checks still waiting, a page at a time, and a word on the one just cancelled when its ID is one. */
  private checks(response: ServerResponse, url: URL, headers: Headers): void {
    const page = pageNumber(url);
    const cancelled = url.searchParams.getAll('cancelled');
    if (page === 0 || cancelled.length > 1) return send(response, 404, this.message('見つかりません', true), headers);
    const word = cancelled.length === 1 && CHECK_ID.test(cancelled[0]!) ? { cancelled: cancelled[0]! } : {};
    send(response, 200, checksPage({ ...listSelfChecks(this.options.db, page), page, ...word }, this.options.timeZone, this.options.avatarId), headers);
  }

  /**
   * The owner's cancel of one self-check (ADR 0064), guarded as the logout is: the Origin must be the public origin
   * (with the Strict cookie, the CSRF check), and the session must be live. A POST never starts a login.
   */
  private cancelCheck(request: IncomingMessage, response: ServerResponse, checkId: string): void {
    if (request.headers.origin !== this.options.publicOrigin) return send(response, 403, this.message('削除できませんでした'));
    const session = this.options.browser.session(request, { legacy: true });
    if (!session) return send(response, 403, this.message('ログインが切れました。もう一度開いてください'));
    const renewed: Headers = { 'set-cookie': this.options.browser.renewed(session) };
    const outcome = this.options.loop.cancelSelfCheck(checkId);
    if (!outcome.ok) return send(response, 409, this.message(outcome.text, true), renewed);
    response.writeHead(303, { location: `${CHECKS_PATH}?cancelled=${encodeURIComponent(checkId)}`, ...renewed }).end();
  }

  /** What a sleeping pill would do now, and the form that gives it; after a pill, a word on it (ADR 0077). */
  private async sleep(response: ServerResponse, url: URL, headers: Headers): Promise<void> {
    const taken = url.searchParams.get('taken');
    const { loop } = this.options;
    send(response, 200, sleepPage(await loop.sleepStatus(), { timeZone: this.options.timeZone, pillMinutes: this.options.pillStopStartingAfterMinutes ?? 90,
      unavailable: loop.dashboardState().unavailable, ...(taken === 'new' || taken === 'joined' ? { taken } : {}), avatarId: this.options.avatarId }),
    headers);
  }

  /**
   * The owner's sleeping pill (ADR 0077), guarded as a self-check's cancel is: the Origin must be the public origin and
   * the session live, and a POST never starts a login. Taken, it goes back to the page, which says so.
   */
  private async takePill(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.origin !== this.options.publicOrigin) return send(response, 403, this.message('飲ませられませんでした'));
    const session = this.options.browser.session(request, { legacy: true });
    if (!session) return send(response, 403, this.message('ログインが切れました。もう一度開いてください'));
    const renewed: Headers = { 'set-cookie': this.options.browser.renewed(session) };
    const outcome = await this.options.loop.takeSleepingPill();
    if (outcome.kind !== 'accepted') return send(response, 503, this.message('なつみがいま話せないので、飲ませていません', true), renewed);
    response.writeHead(303, { location: `${SLEEP_PATH}?taken=${outcome.joined ? 'joined' : 'new'}`, ...renewed }).end();
  }

  /**
   * A page of memos: the turns from SQLite, and each memo read from the end of its turn's place, one after another, so
   * a page reads at most MEMOS_PER_PAGE bounded windows (ADR 0049).
   */
  private async memos(response: ServerResponse, url: URL, headers: Headers): Promise<void> {
    const page = pageNumber(url);
    if (page === 0) return send(response, 404, this.message('見つかりません', true), headers);
    const { rows, more } = listMemoTurns(this.options.db, page);
    const source = { db: this.options.db, sessionDirectory: this.options.sessionDirectory };
    const memos = [];
    for (const row of rows) memos.push({ row, memo: await readMemo(source, row) });
    send(response, 200, memosPage({ page, more, memos }, this.options.timeZone, this.options.avatarId), headers);
  }

  private dove(response: ServerResponse, url: URL, headers: Headers): void {
    const page = pageNumber(url);
    if (page === 0) return send(response, 404, this.message('見つかりません', true), headers);
    send(response, 200, dovePage({ ...listDovePosts(this.options.db, page), page }, this.options.timeZone, this.options.name, this.options.avatarId), headers);
  }

  /** The charts of a period, from `turn_stats` alone and counted by SQLite (ADR 0049), with the series of tokens chosen. */
  private stats(response: ServerResponse, url: URL, headers: Headers): void {
    const period = statsPeriod(url);
    const tokens = statsTokens(url);
    if (!period || !tokens) return send(response, 404, this.message('見つかりません', true), headers);
    const { db, now, timeZone } = this.options;
    send(response, 200, statsPage(readStats(db, { period, now: now(), timeZone }), timeZone, tokens, this.options.avatarId), headers);
  }

  /** The approvals, all or those of one outcome; an outcome not in the list is not a page. */
  private approvals(response: ServerResponse, url: URL, headers: Headers): void {
    const page = pageNumber(url);
    const asked = url.searchParams.getAll('state');
    const state = asked.length === 1 && (APPROVAL_STATES as readonly string[]).includes(asked[0]!) ? asked[0] as ApprovalState : undefined;
    if (page === 0 || asked.length > 1 || (asked.length === 1 && state === undefined)) return send(response, 404, this.message('見つかりません', true), headers);
    const list = listApprovals(this.options.db, { page, now: this.options.now(), ...(state ? { state } : {}) });
    send(response, 200, approvalsPage({ ...list, page, ...(state ? { state } : {}) }, this.options.timeZone, this.options.avatarId), headers);
  }

  /** A turn read from the session record, recorded or still running; or one of its images. */
  private async turn(response: ServerResponse, turnId: string, image: number | undefined, headers: Headers): Promise<void> {
    const notFound = () => send(response, 404, this.message('見つかりません', true), headers);
    if (!TURN_ID.test(turnId)) return notFound();
    const source = { db: this.options.db, sessionDirectory: this.options.sessionDirectory };
    const row = findTurn(this.options.db, turnId);
    const running = row ? undefined : this.options.loop.turnInProgress();
    const inProgress = running?.turnId === turnId ? running : undefined;
    if (!row && !inProgress) return notFound();
    const reading = await readTurn(source, row ? { row } : { inProgress: inProgress! });
    if (image === undefined) return send(response, 200, turnPage({ ...(row ? { row } : { inProgress }), reading }, this.options.timeZone, this.options.avatarId), headers);
    const picture = reading.found ? turnImages(reading.entries)[image] : undefined;
    if (!picture || !IMAGE_TYPES.has(picture.mimeType)) return notFound();
    const body = Buffer.from(picture.data, 'base64');
    response.writeHead(200, { 'content-type': picture.mimeType, 'content-length': body.length, ...headers }).end(body);
  }

  /**
   * One of her files or directories (ADR 0054): a directory one level down, a file's page with the head of it, its
   * bytes as a download, or its bytes as a picture when they are one.
   */
  private async files(response: ServerResponse, url: URL, headers: Headers): Promise<void> {
    const location = locate(url.pathname);
    const query = fileQuery(url);
    if (!location || !query) return send(response, 404, this.message('見つかりません', true), headers);
    const roots = await this.fileRoots();
    const refused = (reason: Parameters<typeof refusedFilePage>[0]['reason'], target?: string) =>
      send(response, 404, refusedFilePage({ location, reason, ...(target === undefined ? {} : { target }) }, this.options.name, this.options.avatarId), headers);
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
          return send(response, 404, this.message('見つかりません', true), headers);
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
      if (query.raw || !query.listing) return send(response, 404, this.message('見つかりません', true), headers);
      const listed = listDirectory(found, query.listing);
      return send(response, 200, directoryPage({ location, view: query.listing, ...listed }, this.options.timeZone, this.options.avatarId), headers);
    }
    const head = await readHead(roots, location, TEXT_LIMIT);
    if (head.kind === 'refused') return refused(head.reason, head.target);
    const content = classify(head.head, head.size, TEXT_LIMIT);
    send(response, 200, filePage({ location, size: head.size, mtimeMs: head.mtimeMs, content, raw: query.raw }, this.options.timeZone, this.options.avatarId), headers);
  }

  private async fileRoots(): Promise<FileRoots> {
    const { dataDirectory, memoryDirectory, manualDirectory } = this.options;
    return {
      memory: memoryDirectory, work: join(dataDirectory, WORK_DIRECTORY), home: join(dataDirectory, HOME_DIRECTORY),
      agents: join(dataDirectory, AGENT_LIST_DIRECTORY), avatar: join(dataDirectory, AVATAR_MANUAL_DIRECTORY),
      sources: join(dataDirectory, SOURCES_DIRECTORY), manual: manualDirectory ?? await codeManualDirectory(),
    };
  }

  /**
   * The sentinel's pages (ADR 0096), each read from its socket as it is opened: what waits and the grants, one approval,
   * the page that asks before a revoke, and the records a page at a time. A socket that is not there says so.
   */
  private async sentinel(response: ServerResponse, url: URL, sentinel: DashboardSentinel, headers: Headers): Promise<void> {
    const { client } = sentinel;
    const { timeZone, avatarId } = this.options;
    const path = url.pathname;
    const notFound = () => send(response, 404, this.message('見つかりません', true), headers);
    const failed = (result: Exclude<SentinelResult<unknown>, { kind: 'ok' }>) => result.kind === 'unreachable'
      ? send(response, 503, sentinelUnreachablePage(avatarId), headers)
      : result.status === 404 ? notFound()
      : send(response, 502, sentinelRefusedPage('関所が答えませんでした', result.status, result.error, SENTINEL_PATH, avatarId), headers);
    if (path === SENTINEL_PATH) {
      const [approvals, grants] = await Promise.all([client.approvals(), client.grants()]);
      if (approvals.kind !== 'ok') return failed(approvals);
      if (grants.kind !== 'ok') return failed(grants);
      const revoked = url.searchParams.get('revoked');
      return send(response, 200, sentinelPage({ approvals: approvals.value, grants: grants.value,
        ...(revoked && GRANT_ID.test(revoked) ? { revoked } : {}) }, timeZone, avatarId), headers);
    }
    const approval = SENTINEL_APPROVAL.exec(path);
    if (approval) {
      if (!APPROVAL_ID.test(approval[1]!)) return notFound();
      const found = await client.approval(approval[1]!);
      if (found.kind !== 'ok') return failed(found);
      return send(response, 200, sentinelApprovalPage({ approval: found.value, answered: url.searchParams.get('answered') === '1' }, timeZone, avatarId), headers);
    }
    const grant = SENTINEL_GRANT.exec(path);
    if (grant) {
      if (!GRANT_ID.test(grant[1]!)) return notFound();
      const grants = await client.grants();
      if (grants.kind !== 'ok') return failed(grants);
      const found = grants.value.find(candidate => candidate.id === grant[1]);
      return found ? send(response, 200, sentinelGrantPage(found, timeZone, avatarId), headers) : notFound();
    }
    if (path === SENTINEL_RECORDS_PATH) {
      const before = url.searchParams.getAll('before');
      if (before.length > 1 || (before.length === 1 && !/^[1-9][0-9]{0,15}$/.test(before[0]!))) return notFound();
      const from = before.length === 1 ? Number(before[0]) : undefined;
      const records = await client.records({ ...(from === undefined ? {} : { before: from }), limit: RECORDS_PER_PAGE });
      if (records.kind !== 'ok') return failed(records);
      return send(response, 200, sentinelRecordsPage({ ...records.value, ...(from === undefined ? {} : { before: from }) }, timeZone, avatarId), headers);
    }
    const record = SENTINEL_RECORD.exec(path);
    if (record) {
      const found = await client.record(Number(record[1]));
      if (found.kind !== 'ok') return failed(found);
      return send(response, 200, sentinelRecordPage(found.value, timeZone, avatarId), headers);
    }
    notFound();
  }

  /**
   * The owner's answer to one of the sentinel's approvals (ADR 0096), guarded as a self-check's cancel is: the Origin
   * must be the public origin and the session live, and a POST never starts a login. The answer is handed to the
   * sentinel as it is; what the sentinel refuses is told in its own words, and nothing is taken when it is not there.
   */
  private async answerSentinel(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    const { avatarId } = this.options;
    if (request.headers.origin !== this.options.publicOrigin) return send(response, 403, this.message('答えられませんでした'));
    const session = this.options.browser.session(request, { legacy: true });
    if (!session) return send(response, 403, this.message('ログインが切れました。もう一度開いてください'));
    const renewed: Headers = { 'set-cookie': this.options.browser.renewed(session) };
    const form = await readForm(request);
    const answers = form?.getAll('answer') ?? [];
    const choices = form?.getAll('choice') ?? [];
    const answer = answers.length !== 1 ? undefined : answers[0] === 'deny' ? { answer: 'deny' as const }
      : answers[0] === 'allow' && choices.length === 1 && CHOICE.test(choices[0]!) ? { answer: 'allow' as const, choice: choices[0]! } : undefined;
    if (!answer) return send(response, 400, this.message('答えの形が違います', true), renewed);
    const result = await this.options.sentinel!.client.answer(id, answer);
    if (result.kind === 'ok') {
      response.writeHead(303, { location: `${sentinelApprovalPath(id)}?answered=1`, ...renewed }).end();
      return;
    }
    if (result.kind === 'unreachable') return send(response, 503, sentinelUnreachablePage(avatarId), renewed);
    send(response, refusedStatus(result.status), sentinelRefusedPage('関所が答えを受け付けませんでした', result.status, result.error,
      sentinelApprovalPath(id), avatarId), renewed);
  }

  /** The revoke of one of the sentinel's grants (ADR 0096), from the page that asks first, guarded as the answer is. */
  private async revokeGrant(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    const { avatarId } = this.options;
    if (request.headers.origin !== this.options.publicOrigin) return send(response, 403, this.message('取り消せませんでした'));
    const session = this.options.browser.session(request, { legacy: true });
    if (!session) return send(response, 403, this.message('ログインが切れました。もう一度開いてください'));
    const renewed: Headers = { 'set-cookie': this.options.browser.renewed(session) };
    const result = await this.options.sentinel!.client.revoke(id);
    if (result.kind === 'ok') {
      response.writeHead(303, { location: `${SENTINEL_PATH}?revoked=${encodeURIComponent(id)}`, ...renewed }).end();
      return;
    }
    if (result.kind === 'unreachable') return send(response, 503, sentinelUnreachablePage(avatarId), renewed);
    send(response, refusedStatus(result.status), sentinelRefusedPage('関所が取り消しを受け付けませんでした', result.status, result.error,
      SENTINEL_PATH, avatarId), renewed);
  }

  /** The callback's answer to a browser's login, which goes back to the page it began at (ADR 0058). */
  finishLogin(response: ServerResponse, outcome: BrowserOutcome): void {
    setSecurityHeaders(response);
    if (outcome.browser === 'refused') return send(response, outcome.status, refusedPage(outcome.code, this.options.avatarId));
    // Not a redirect: a Strict cookie is not sent on a navigation that began at GitHub, and a redirect carries that
    // navigation on. A page of this origin that moves on starts a navigation of its own, which the cookie goes with.
    send(response, 200, signedInPage(outcome.returnTo, this.options.avatarId), { 'set-cookie': this.options.browser.issued(outcome.session) });
  }

  /** Whether a callback outcome is one of the dashboard's. */
  static isBrowser(outcome: Outcome | BrowserOutcome): outcome is BrowserOutcome {
    return 'browser' in outcome;
  }

  private logout(request: IncomingMessage, response: ServerResponse): void {
    // The CSRF check (ADR 0049): a form of this origin sends its Origin with a POST; anything else is refused.
    if (request.headers.origin !== this.options.publicOrigin) return send(response, 403, this.message('ログアウトできませんでした'));
    const { browser, sessions } = this.options;
    const session = browser.session(request, { legacy: true });
    if (session) sessions.revoke(session.token);
    response.writeHead(303, { location: SIGNED_OUT_PATH, 'set-cookie': browser.cleared() }).end();
  }

  /** A short answer of the dashboard's, headed like its other pages. */
  private message(heading: string, signedIn = false): Html {
    return messagePage(heading, signedIn, this.options.avatarId);
  }

  private async status(): Promise<DashboardStatus> {
    const status = await readStatus(this.options.dataDirectory);
    const health = checkHealth(status, this.options.now());
    return {
      server: { ...health, ...(status ? { startedAt: status.startedAt, updatedAt: status.updatedAt } : {}) },
      loop: this.options.loop.dashboardState(),
      timeZone: this.options.timeZone,
      ...(this.options.sentinel ? { sentinel: { connected: this.options.sentinel.connected() } } : {}),
    };
  }
}

function setSecurityHeaders(response: ServerResponse) {
  response.setHeader('content-security-policy', DASHBOARD_CSP);
  response.setHeader('x-frame-options', 'DENY');
}

/** The sentinel's refusal passed on with its own status when it is one a browser reads as a refusal, or as a bad gateway. */
function refusedStatus(status: number): number {
  return [400, 403, 404, 409, 503].includes(status) ? status : 502;
}

/** The body of a form POST, or undefined when it is not one or is longer than a form of the dashboard's can be. */
async function readForm(request: IncomingMessage): Promise<URLSearchParams | undefined> {
  if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function send(response: ServerResponse, status: number, body: Html, headers: Headers = {}) {
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
