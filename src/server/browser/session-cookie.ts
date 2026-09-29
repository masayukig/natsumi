import type { IncomingMessage } from 'node:http';
import type { SessionStore, VerifiedSession } from '../sessions.ts';

/**
 * The browser's login (ADR 0058): one cookie, `natsumi_session`, for the whole origin (`Path=/`), read by the dashboard,
 * the chat and settings pages, the images of the conversation, and `/v1/ws` when the Origin is the public origin.
 * HttpOnly and SameSite=Strict always; Secure whenever the public origin is https, which it is everywhere but a
 * loopback test. The session in it is the app's kind (ADR 0030): stored as a hash, checked against `allowedUserId` on
 * every use, and renewed by use, the cookie being set again with each renewal.
 *
 * The dashboard's cookie before it, `natsumi_dashboard` at `Path=/dashboard` (ADR 0049), is read once, under
 * /dashboard only where a browser still sends it, and replaced by this one.
 */

export const SESSION_COOKIE = 'natsumi_session';
export const LEGACY_COOKIE = 'natsumi_dashboard';
const LEGACY_PATH = '/dashboard';

/** A session token as `SessionStore` issues it: 32 random bytes in base64url. Anything else is not looked up. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A live session a browser presented, renewed by this use. `legacy` when it came in the old cookie. */
export interface BrowserSession extends VerifiedSession { token: string; legacy: boolean }

/** How the WebSocket's upgrade stands with the cookie: none presented, one refused for its Origin, or a session. */
export type UpgradeSession = { kind: 'none' } | { kind: 'origin-not-allowed' } | { kind: 'session'; session: VerifiedSession };

export interface BrowserSessionsOptions {
  sessions: SessionStore;
  allowedUserId: number;
  publicOrigin: string;
  now: () => number;
}

export class BrowserSessions {
  private readonly options: BrowserSessionsOptions;
  private readonly secure: boolean;

  constructor(options: BrowserSessionsOptions) {
    this.options = options;
    this.secure = new URL(options.publicOrigin).protocol === 'https:';
  }

  /**
   * The live, allowed session of the request's cookie, renewed by this use; undefined otherwise. The old cookie is read
   * only when `legacy` is asked for and the new one is not there at all.
   */
  session(request: IncomingMessage, { legacy = false } = {}): BrowserSession | undefined {
    const current = cookieValues(request, SESSION_COOKIE);
    const old = legacy && current.length === 0 ? cookieValues(request, LEGACY_COOKIE) : [];
    const values = current.length > 0 ? current : old;
    const token = values.length === 1 ? values[0]! : undefined;
    if (!token || !TOKEN.test(token)) return undefined;
    const { sessions, allowedUserId } = this.options;
    const verified = sessions.verify(token, allowedUserId);
    const expiresAt = verified && sessions.renew(verified.sessionId);
    return verified && expiresAt ? { ...verified, expiresAt, token, legacy: current.length === 0 } : undefined;
  }

  /**
   * `/v1/ws` for a browser: a cookie is taken only with the public origin as the Origin, so that no other site can
   * open the socket with it. A request with no cookie of ours is left to the bearer's check.
   */
  upgrade(request: IncomingMessage): UpgradeSession {
    if (cookieValues(request, SESSION_COOKIE).length === 0) return { kind: 'none' };
    if (request.headers.origin !== this.options.publicOrigin) return { kind: 'origin-not-allowed' };
    const session = this.session(request);
    if (!session) return { kind: 'none' };
    const { token: _token, legacy: _legacy, ...verified } = session;
    return { kind: 'session', session: verified };
  }

  /** Whether the request carries a cookie of ours, dead or alive, so a dead one can be cleared. */
  presented(request: IncomingMessage): boolean {
    return cookieValues(request, SESSION_COOKIE).length > 0 || cookieValues(request, LEGACY_COOKIE).length > 0;
  }

  /** The Set-Cookie lines of a session in use: the cookie again with its new end, and the old one cleared if it came in that. */
  renewed(session: BrowserSession): string[] {
    const line = sessionCookie(session.token, Date.parse(session.expiresAt), this.options.now(), this.secure);
    return session.legacy ? [line, legacyCleared(this.secure)] : [line];
  }

  /** The Set-Cookie line of a session just issued. */
  issued(session: { token: string; expiresAt: string }): string {
    return sessionCookie(session.token, Date.parse(session.expiresAt), this.options.now(), this.secure);
  }

  /** The Set-Cookie lines that clear both cookies. */
  cleared(): string[] {
    return [sessionCookie('', 0, this.options.now(), this.secure), legacyCleared(this.secure)];
  }
}

/** The Set-Cookie line of the browser's session: ends at `endsAt`, or is cleared when that is 0. */
export function sessionCookie(value: string, endsAt: number, now: number, secure: boolean): string {
  return cookieLine(SESSION_COOKIE, '/', value, endsAt, now, secure);
}

function legacyCleared(secure: boolean): string {
  return cookieLine(LEGACY_COOKIE, LEGACY_PATH, '', 0, 0, secure);
}

function cookieLine(name: string, path: string, value: string, endsAt: number, now: number, secure: boolean): string {
  const maxAge = endsAt === 0 ? 0 : Math.max(0, Math.floor((endsAt - now) / 1000));
  const expires = new Date(endsAt === 0 ? 0 : endsAt).toUTCString();
  return [`${name}=${value}`, `Path=${path}`, `Expires=${expires}`, `Max-Age=${maxAge}`, 'HttpOnly', ...(secure ? ['Secure'] : []),
    'SameSite=Strict'].join('; ');
}

/** The values of a cookie by its name, as many as were sent. */
function cookieValues(request: IncomingMessage, name: string): string[] {
  return (request.headers.cookie ?? '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${name}=`)).map(part => part.slice(name.length + 1));
}
