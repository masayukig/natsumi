import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JudgeClient } from '../../src/server/judge.ts';
import { startServer, type RunningServer } from '../../src/server/server.ts';
import type { SlackApi, SlackSocket } from '../../src/server/slack-api.ts';
import { fixtureRuntime } from './fixture.ts';
import { ScriptedModel } from './scripted-model.ts';

// Fictional values only. Every one of these must stay out of responses and logs.
export const CLIENT_SECRET = 'fixture-client-secret-9f1c2e';
export const UPSTREAM_DETAIL = 'fixture-upstream-private-detail';
export const OWNER = { id: 4242001, login: 'fictional-owner' };
export const PUBLIC_ORIGIN = 'https://natsumi.example.test';
export const APP_REDIRECT = 'natsumi://oauth/callback';
export const MINUTE = 60_000;

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
export const newVerifier = () => randomBytes(32).toString('base64url');

interface Grant { challenge: string; redirectUri: string; user: { id: number; login: string }; used: boolean }

/** A local stand-in for github.com: authorize, token exchange with PKCE, and /user. */
export class GitHubStub {
  user: { id: number; login: string } = OWNER;
  userStatus = 200;
  readonly accessTokens: string[] = [];
  private readonly grants = new Map<string, Grant>();
  private readonly tokens = new Map<string, { id: number; login: string }>();
  private server!: Server;
  url = '';

  async start() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', this.url);
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const json = (status: number, value: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
        };
        if (req.method === 'GET' && url.pathname === '/login/oauth/authorize') {
          const q = url.searchParams;
          if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state')) return json(400, {});
          const code = `fixture-github-code-${randomBytes(6).toString('hex')}`;
          this.grants.set(code, { challenge: q.get('code_challenge')!, redirectUri: q.get('redirect_uri')!, user: this.user, used: false });
          const back = new URL(q.get('redirect_uri')!);
          back.searchParams.set('code', code);
          back.searchParams.set('state', q.get('state')!);
          res.writeHead(302, { location: back.href }).end();
          return;
        }
        if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
          const form = req.headers['content-type']?.includes('json')
            ? new URLSearchParams(JSON.parse(body) as Record<string, string>) : new URLSearchParams(body);
          const grant = this.grants.get(form.get('code') ?? '');
          const fail = () => json(200, { error: 'bad_verification_code', error_description: UPSTREAM_DETAIL });
          if (!grant || grant.used) return fail();
          grant.used = true;
          if (form.get('client_secret') !== CLIENT_SECRET || form.get('redirect_uri') !== grant.redirectUri
            || s256(form.get('code_verifier') ?? '') !== grant.challenge) return fail();
          const token = `fixture-github-access-${randomBytes(6).toString('hex')}`;
          this.tokens.set(token, grant.user);
          this.accessTokens.push(token);
          return json(200, { access_token: token, token_type: 'bearer', scope: '' });
        }
        if (req.method === 'GET' && url.pathname === '/user') {
          const user = this.tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
          if (!user || this.userStatus !== 200) return json(user ? this.userStatus : 401, { message: UPSTREAM_DETAIL });
          return json(200, { ...user, name: 'Fictional Owner' });
        }
        json(404, { message: UPSTREAM_DETAIL });
      });
    });
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  get endpoints() {
    return { authorizeUrl: `${this.url}/login/oauth/authorize`, tokenUrl: `${this.url}/login/oauth/access_token`, userUrl: `${this.url}/user` };
  }

  close() { return new Promise<void>(resolve => this.server.close(() => resolve())); }
}

export interface FixtureOptions {
  allowedUserId?: number;
  env?: Record<string, string | undefined>;
  /** Live events kept per device stream for replay. */
  streamBufferSize?: number;
  /** Turns APNs on, sending to a local stand-in for both environments with this throwaway key (ADR 0029). */
  apns?: { origin: string; pem: string; retryDelaysMs?: number[] };
  /** Turns Slack on with this section, connecting every workspace to the stand-in `api` (ADR 0039, ADR 0040). */
  slack?: { section: Record<string, unknown>; api: SlackApi & SlackSocket; judge?: JudgeClient };
  /** Replaces the single `pi.model` with these settings, such as named routes (ADR 0046). */
  pi?: Record<string, unknown>;
  /** Overlaid on the loop section. */
  loop?: Record<string, unknown>;
  /** The curator section (ADR 0055). */
  curator?: Record<string, unknown>;
  /** Writes an avatar under the fixture's root and gives the `avatar` section naming it (ADR 0057). */
  avatar?: (root: string) => Promise<Record<string, unknown>>;
  /** Fills the data directory before the first start, as one a previous version left behind. */
  prepare?: (data: string) => Promise<void>;
  /** Where the browser's bundle is read from (ADR 0058), under the fixture's root. None by default, so none is found. */
  webBundle?: (root: string) => string;
}

export const APNS_KEY_ENV = 'NATSUMI_APNS_KEY';

/** A running server on loopback plaintext with a stub GitHub, a scripted Pi model, a controllable clock and captured logs. */
export async function startFixture(options: FixtureOptions = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-auth-')));
  const data = join(root, 'data');
  await mkdir(data);
  const stub = await new GitHubStub().start();
  const logs: string[] = [];
  const clock = { now: Date.parse('2026-01-01T00:00:00Z'), advance(ms: number) { this.now += ms; } };
  const configFile = join(root, 'config.json');
  const model = new ScriptedModel();
  await options.prepare?.(data);

  let server: RunningServer;
  const launch = async (allowedUserId: number) => {
    const { apns, slack } = options;
    const config = serverConfig(root, { allowedUserId, apns: apns !== undefined });
    if (options.pi) {
      const { model: _model, ...directories } = config.pi;
      config.pi = { ...directories, ...options.pi } as typeof config.pi;
    }
    const avatar = options.avatar ? await options.avatar(root) : undefined;
    await writeFile(configFile, JSON.stringify({ ...config, ...(slack ? { slack: slack.section } : {}),
      ...(options.loop ? { loop: options.loop } : {}), ...(options.curator ? { curator: options.curator } : {}), ...(avatar ? { avatar } : {}) }));
    server = await startServer({
      config: configFile, dataDir: data, cwd: '/', home: join(root, 'home'),
      env: options.env ?? { NATSUMI_GITHUB_CLIENT_SECRET: CLIENT_SECRET, ...(apns ? { [APNS_KEY_ENV]: apns.pem } : {}),
        ...(slack ? { SLACK_BOT: 'fixture-bot-token', SLACK_APP: 'fixture-app-token' } : {}) },
      github: stub.endpoints, clock: () => clock.now, log: line => { logs.push(line); },
      pi: { runtime: fixtureRuntime, configureSession: session => { session.agent.streamFunction = model.streamFunction; } },
      streamBufferSize: options.streamBufferSize,
      web: { bundleDirectory: options.webBundle ? options.webBundle(root) : join(root, 'no-bundle') },
      ...(apns ? { apns: { origins: { sandbox: apns.origin, production: apns.origin }, retryDelaysMs: apns.retryDelaysMs } } : {}),
      ...(slack ? { slack: { connector: () => ({ api: slack.api, socket: slack.api }) }, ...(slack.judge ? { judge: { clients: { logprobs: slack.judge, jev: slack.judge } } } : {}) } : {}),
    });
  };
  try { await launch(options.allowedUserId ?? OWNER.id); } catch (error) {
    await stub.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  const f = {
    root, data, stub, logs, clock, model,
    get server() { return server; },
    get base() { return `http://127.0.0.1:${server.address!.port}`; },
    get wsUrl() { return `ws://127.0.0.1:${server.address!.port}/v1/ws`; },
    /** Every response body and Location seen, for leak checks. */
    seen: [] as string[],
    async restart(allowedUserId: number) { await server.stop(); await launch(allowedUserId); },
    async cleanup() {
      await server.stop();
      await stub.close();
      await rm(root, { recursive: true, force: true });
    },
    async fetch(path: string, init: RequestInit = {}) {
      const res = await fetch(`${f.base}${path}`, { redirect: 'manual', ...init });
      const text = await res.text();
      f.seen.push(text, res.headers.get('location') ?? '');
      return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) as Record<string, unknown> };
    },
  };
  return f;
}

export type Fixture = Awaited<ReturnType<typeof startFixture>>;

export function serverConfig(root: string, { allowedUserId = OWNER.id, listen, apns = false }:
  { allowedUserId?: number; listen?: unknown; apns?: boolean } = {}) {
  return {
    pi: {
      agentDirectory: join(root, 'pi', 'agent'), sessionDirectory: join(root, 'pi', 'sessions'),
      authPath: join(root, 'pi', 'agent', 'auth.json'), model: { provider: 'openai-codex', id: 'gpt-5.5' }, voiceEnabled: false,
    },
    publicOrigin: PUBLIC_ORIGIN,
    listen: listen ?? { host: '127.0.0.1', port: 0, tls: false },
    github: {
      clientId: 'Iv1.fixtureclient', clientSecretEnv: 'NATSUMI_GITHUB_CLIENT_SECRET',
      callbackUrl: `${PUBLIC_ORIGIN}/auth/github/callback`, allowedUserId,
    },
    ...(apns ? { apns: { teamId: 'TEAM000001', keyId: 'KEY0000001', topic: 'net.example.natsumi', keyEnv: APNS_KEY_ENV } } : {}),
  };
}

// The browser half of the flow, as ASWebAuthenticationSession would drive it.

export async function beginLogin(f: Fixture, verifier = newVerifier(), appState = 'fixture-app-state') {
  const query = new URLSearchParams({ code_challenge: s256(verifier), code_challenge_method: 'S256', state: appState });
  const res = await f.fetch(`/auth/github/start?${query}`);
  assert.equal(res.status, 302, res.text);
  const authorize = new URL(res.headers.get('location')!);
  assert.equal(`${authorize.origin}${authorize.pathname}`, f.stub.endpoints.authorizeUrl);
  return { verifier, appState, authorize };
}

/** Lets the stub GitHub approve and returns the server callback path it redirects to. */
export async function approveAtGitHub(f: Fixture, authorize: URL) {
  const res = await fetch(authorize, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const callback = new URL(res.headers.get('location')!);
  assert.equal(`${callback.origin}${callback.pathname}`, `${PUBLIC_ORIGIN}/auth/github/callback`);
  return `${callback.pathname}${callback.search}`;
}

/** Follows the server callback; returns the app redirect it produced, or the error response. */
export async function finishCallback(f: Fixture, callbackPath: string) {
  const res = await f.fetch(callbackPath);
  const location = res.headers.get('location');
  return { res, app: location?.startsWith(`${APP_REDIRECT}?`) ? new URL(location).searchParams : undefined };
}

export function redeem(f: Fixture, code: string, codeVerifier: string) {
  return f.fetch('/auth/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, codeVerifier }),
  });
}

export async function login(f: Fixture) {
  const { verifier, authorize } = await beginLogin(f);
  const { app } = await finishCallback(f, await approveAtGitHub(f, authorize));
  const code = app?.get('code');
  assert.ok(code, `no login code: ${app}`);
  const res = await redeem(f, code, verifier);
  assert.equal(res.status, 200, res.text);
  return res.json() as { token: string; expiresAt: string };
}
