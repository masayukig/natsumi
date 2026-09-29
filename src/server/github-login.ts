import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { GitHubConfig } from './config.ts';
import type { IssuedSession, SessionStore } from './sessions.ts';

export interface GitHubEndpoints { authorizeUrl: string; tokenUrl: string; userUrl: string }

export const GITHUB_ENDPOINTS: GitHubEndpoints = {
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  userUrl: 'https://api.github.com/user',
};

/** The Mac app's callback (ASWebAuthenticationSession). Fixed in code so it can never become an open redirect. */
export const APP_REDIRECT_URI = 'natsumi://oauth/callback';
/** Where a browser login ends (ADR 0049). Fixed in code for the same reason; nothing in a request or the config moves it. */
export const DASHBOARD_PATH = '/dashboard';
/**
 * The pages a browser login may go back to (ADR 0058): the one it began at, of these three fixed in code. Nothing a
 * request carries is ever used as a place to go.
 */
export const BROWSER_RETURNS = ['/', '/settings', DASHBOARD_PATH] as const;
export type BrowserReturn = typeof BROWSER_RETURNS[number];
export const LOGIN_ATTEMPT_TTL_MS = 10 * 60_000;
export const LOGIN_CODE_TTL_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_PENDING = 64;

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const APP_STATE = /^[\x21-\x7e]{1,256}$/;

/** An HTTP answer: a redirect, or a JSON body carrying only a fixed error code. */
export type Outcome = { status: 302; location: string } | { status: number; body: Record<string, unknown> };

/**
 * How a browser login ended (ADR 0049): a session for the dashboard's cookie, or a fixed code to show with the status.
 * The browser has no app to take a login code to, so the session is issued at the callback itself.
 */
export type BrowserOutcome =
  | { browser: 'signed-in'; session: IssuedSession; returnTo: BrowserReturn }
  | { browser: 'refused'; status: number; code: string; returnTo: BrowserReturn };

type Attempt = { githubVerifier: string; expiresAt: number }
  & ({ kind: 'app'; appChallenge: string; appState: string } | { kind: 'browser'; returnTo: BrowserReturn });
interface LoginCode { githubUserId: number; appChallenge: string; expiresAt: number }

/** The status a refused browser login is shown with: GitHub failing is not the browser's fault. */
const BROWSER_STATUS: Record<string, number> = {
  'github-denied': 403, 'account-not-allowed': 403, 'github-unavailable': 502, 'github-exchange-failed': 502,
  'too-many-logins': 429,
};

const random = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const failure = (status: number, code: string): Outcome => ({ status, body: { error: code } });

export interface GitHubLoginOptions {
  config: GitHubConfig;
  clientSecret: string;
  endpoints: GitHubEndpoints;
  sessions: SessionStore;
  now: () => number;
  log: (line: string) => void;
}

/**
 * GitHub OAuth for a native client (ADR 0006).
 *
 * 1. `start`: the app sends its own PKCE challenge and state. The server keeps them with a fresh GitHub state
 *    and GitHub PKCE verifier, and redirects to GitHub.
 * 2. `callback`: the state is consumed once and checked for expiry, the code is exchanged with the server's verifier,
 *    and the account is matched by numeric user ID. The app receives a one-time login code at APP_REDIRECT_URI.
 * 3. `redeem`: the app proves possession of its verifier and receives a short-lived session token.
 *
 * Pending attempts live in memory only: a restart simply invalidates logins in flight. The GitHub access token is
 * used once to read the user ID and is never stored.
 */
export class GitHubLogin {
  private readonly attempts = new Map<string, Attempt>();
  private readonly codes = new Map<string, LoginCode>();
  private readonly options: GitHubLoginOptions;

  constructor(options: GitHubLoginOptions) {
    this.options = options;
  }

  start(query: URLSearchParams): Outcome {
    const appChallenge = query.get('code_challenge') ?? '';
    const appState = query.get('state') ?? '';
    if (query.get('code_challenge_method') !== 'S256' || !CHALLENGE.test(appChallenge) || !APP_STATE.test(appState)) {
      return failure(400, 'invalid-request');
    }
    return this.toGitHub({ kind: 'app', appChallenge, appState });
  }

  /**
   * A login from the browser (ADR 0049, ADR 0058): the same state, GitHub PKCE and account check as the app's, ending
   * with a session instead of at the app with a login code, and going back to the page it began at.
   */
  startBrowser(returnTo: BrowserReturn = DASHBOARD_PATH): Outcome {
    return this.toGitHub({ kind: 'browser', returnTo });
  }

  private toGitHub(attempt: { kind: 'app'; appChallenge: string; appState: string } | { kind: 'browser'; returnTo: BrowserReturn }): Outcome {
    const now = this.options.now();
    prune(this.attempts, now - LOGIN_ATTEMPT_TTL_MS);
    if (this.attempts.size >= MAX_PENDING) return failure(429, 'too-many-logins');
    const state = random();
    const githubVerifier = random();
    this.attempts.set(digest(state), { ...attempt, githubVerifier, expiresAt: now + LOGIN_ATTEMPT_TTL_MS });
    const url = new URL(this.options.endpoints.authorizeUrl);
    url.search = new URLSearchParams({
      client_id: this.options.config.clientId, redirect_uri: this.options.config.callbackUrl, state,
      code_challenge: s256(githubVerifier), code_challenge_method: 'S256', allow_signup: 'false',
    }).toString();
    return { status: 302, location: url.href };
  }

  async callback(query: URLSearchParams): Promise<Outcome | BrowserOutcome> {
    const state = query.get('state');
    const key = state ? digest(state) : undefined;
    const attempt = key === undefined ? undefined : this.attempts.get(key);
    if (!attempt) return this.refuse(failure(400, 'invalid-state'), 'invalid-state');
    this.attempts.delete(key!); // One use, whatever happens next.

    const verified = await this.verify(query, attempt);
    if (attempt.kind === 'browser') {
      const { returnTo } = attempt;
      if (typeof verified === 'string') {
        return this.refuse({ browser: 'refused', status: BROWSER_STATUS[verified] ?? 400, code: verified, returnTo }, verified);
      }
      const session = this.options.sessions.create(verified);
      this.options.log('github login: browser session issued');
      return { browser: 'signed-in', session, returnTo };
    }

    const toApp = (params: Record<string, string>): Outcome => {
      const url = new URL(APP_REDIRECT_URI);
      url.search = new URLSearchParams({ ...params, state: attempt.appState }).toString();
      return { status: 302, location: url.href };
    };
    const refuseToApp = (code: string) => this.refuse(toApp({ error: code }), code);
    if (typeof verified === 'string') return refuseToApp(verified);
    const userId = verified;

    const issuedAt = this.options.now();
    prune(this.codes, issuedAt);
    if (this.codes.size >= MAX_PENDING) return refuseToApp('too-many-logins');
    const loginCode = random();
    this.codes.set(digest(loginCode), { githubUserId: userId, appChallenge: attempt.appChallenge, expiresAt: issuedAt + LOGIN_CODE_TTL_MS });
    return toApp({ code: loginCode });
  }

  /** The allowed account's numeric ID from GitHub's answer, or the fixed code of why there is none. */
  private async verify(query: URLSearchParams, attempt: Attempt): Promise<number | string> {
    if (attempt.expiresAt <= this.options.now()) return 'login-expired';
    if (query.has('error')) return 'github-denied';
    const code = query.get('code');
    if (!code) return 'invalid-request';
    const exchanged = await this.exchange(code, attempt.githubVerifier);
    if (exchanged.kind !== 'ok') return exchanged.kind === 'rejected' ? 'github-exchange-failed' : 'github-unavailable';
    const userId = await this.fetchUserId(exchanged.accessToken);
    if (userId === undefined) return 'github-unavailable';
    if (userId !== this.options.config.allowedUserId) return 'account-not-allowed';
    return userId;
  }

  redeem(body: unknown): Outcome {
    const { code, codeVerifier } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    if (typeof code !== 'string' || typeof codeVerifier !== 'string' || !VERIFIER.test(codeVerifier)) {
      return failure(400, 'invalid-request');
    }
    const key = digest(code);
    const grant = this.codes.get(key);
    this.codes.delete(key); // A failed attempt burns the code too.
    if (!grant || grant.expiresAt <= this.options.now() || !sameText(s256(codeVerifier), grant.appChallenge)
      || grant.githubUserId !== this.options.config.allowedUserId) {
      return this.refuse(failure(400, 'invalid-grant'), 'invalid-grant');
    }
    const session = this.options.sessions.create(grant.githubUserId);
    this.options.log('github login: session issued');
    return { status: 200, body: { token: session.token, expiresAt: session.expiresAt } };
  }

  private refuse<T extends Outcome | BrowserOutcome>(outcome: T, code: string): T {
    this.options.log(`github login refused: ${code}`);
    return outcome;
  }

  /** Upstream bodies are read only for the fields used here; nothing from them is logged or returned. */
  private async exchange(code: string, verifier: string): Promise<{ kind: 'ok'; accessToken: string } | { kind: 'rejected' | 'unavailable' }> {
    try {
      const res = await fetch(this.options.endpoints.tokenUrl, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'natsumi' },
        body: new URLSearchParams({
          client_id: this.options.config.clientId, client_secret: this.options.clientSecret,
          code, redirect_uri: this.options.config.callbackUrl, code_verifier: verifier,
        }),
      });
      if (!res.ok) { await res.body?.cancel(); return { kind: 'unavailable' }; }
      const body = await res.json() as { access_token?: unknown };
      // GitHub reports a bad code or verifier as 200 with an `error` field.
      return typeof body.access_token === 'string' && body.access_token ? { kind: 'ok', accessToken: body.access_token } : { kind: 'rejected' };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  private async fetchUserId(accessToken: string): Promise<number | undefined> {
    try {
      const res = await fetch(this.options.endpoints.userUrl, {
        redirect: 'error', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${accessToken}`, 'user-agent': 'natsumi', 'x-github-api-version': '2022-11-28' },
      });
      if (!res.ok) { await res.body?.cancel(); return undefined; }
      const { id } = await res.json() as { id?: unknown };
      return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Drops entries that expired before `cutoff`. */
function prune(entries: Map<string, { expiresAt: number }>, cutoff: number) {
  for (const [key, entry] of entries) if (entry.expiresAt <= cutoff) entries.delete(key);
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
