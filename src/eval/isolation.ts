import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { isWithin } from '../server/paths.ts';
import type { ModelFile } from './model-file.ts';
import type { RunningWorkspace, StartOptions, WorkspaceStarter } from './workspace.ts';

/**
 * The second of the guarantees that a run on a snapshot acts on nothing outside (ADR 0052): the whole evaluation runs
 * in a network namespace of its own, with loopback only, and its one way out is a relay outside that lets through
 * HTTP CONNECT to the model endpoints alone. Inside, a bridge on loopback carries the proxy's port to the relay's Unix
 * socket, and Node sends every request through it (`NODE_USE_ENV_PROXY`). The workspace runner, itself in bubblewrap,
 * is started outside and handed in by its socket, so that no sandbox is made inside another.
 */

/** The proxy's port inside the namespace: nothing else listens there, so any fixed port is free. */
export const BRIDGE_PORT = 3128;
/** Set inside the sandbox, naming the relay's and the runner service's sockets. */
export const ISOLATED_ENV = 'NATSUMI_EVAL_ISOLATED';
/** Where the subscription providers answer, for the providers a model file may name without an endpoint of its own. */
const PROVIDER_ENDPOINTS: Record<string, string[]> = {
  'openai-codex': ['chatgpt.com:443', 'auth.openai.com:443'],
};

/** The hosts and ports the models of a run are reached at: a compatible endpoint's own, or its provider's. */
export function endpointsOf(files: ModelFile[]): string[] {
  const found = new Set<string>();
  for (const file of files) {
    if (file.endpoint) {
      const url = new URL(file.endpoint.baseUrl);
      found.add(`${url.hostname.replace(/^\[|\]$/g, '')}:${url.port || (url.protocol === 'http:' ? '80' : '443')}`);
      continue;
    }
    const known = PROVIDER_ENDPOINTS[file.target.provider];
    if (!known) throw new Error(`the way out for the provider ${file.target.provider} is not known; give it as a compatible endpoint`);
    for (const endpoint of known) found.add(endpoint);
  }
  return [...found].sort();
}

export interface Relay {
  /** Every CONNECT asked for and turned back, as `host:port`. */
  readonly refused: string[];
  /** Every CONNECT let through, as `host:port`. */
  readonly passed: string[];
  close(): Promise<void>;
}

/**
 * The relay: an HTTP proxy on a Unix socket that knows only CONNECT, and only to the hosts and ports in `allow`.
 * Anything else is answered 403 and closed; the names are resolved here, outside, never inside the sandbox.
 */
export async function startRelay(options: {
  socketPath: string; allow: string[];
  /** Where to connect for an allowed `host:port`, as `host:port`; by default the name itself. Tests point real names at fakes. */
  connectTo?: Record<string, string>;
}): Promise<Relay> {
  const allow = new Set(options.allow.map(entry => entry.toLowerCase()));
  const refused: string[] = [];
  const passed: string[] = [];
  const open = new Set<Socket>();
  const server = createServer(client => {
    open.add(client);
    client.on('close', () => open.delete(client));
    client.on('error', () => client.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) { if (head.length > 16_384) client.destroy(); return; }
      client.off('data', onData);
      const request = /^CONNECT ([^\s:]+|\[[0-9a-fA-F:]+\]):(\d+) HTTP\/1\.[01]\r\n/.exec(head.subarray(0, end + 4).toString('latin1'));
      const target = request ? `${request[1]!.replace(/^\[|\]$/g, '')}:${request[2]}`.toLowerCase() : undefined;
      if (!request || !target || !allow.has(target)) {
        refused.push(target ?? head.subarray(0, Math.min(end, 200)).toString('latin1').split('\r\n')[0]!);
        client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        return;
      }
      passed.push(target);
      const rest = head.subarray(end + 4);
      const [host, port] = splitTarget(options.connectTo?.[target] ?? target);
      const upstream = connect({ host, port });
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => {
        if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      });
      client.on('close', () => upstream.destroy());
    };
    client.on('data', onData);
  });
  await listen(server, options.socketPath);
  return { refused, passed, close: () => { for (const socket of open) socket.destroy(); return closeServer(server, options.socketPath); } };
}

function splitTarget(target: string): [string, number] {
  const index = target.lastIndexOf(':');
  return [target.slice(0, index), Number(target.slice(index + 1))];
}

/** Inside the sandbox: loopback's proxy port, carried to the relay's socket. */
export async function startBridge(relaySocket: string, port = BRIDGE_PORT): Promise<{ close(): Promise<void> }> {
  const server = createServer(client => {
    const upstream = connect(relaySocket);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', () => done()); });
  server.unref();
  return { close: () => new Promise(done => server.close(() => done())) };
}

/** The environment of the sandboxed process: the proxy, the sockets, and nothing of the caller's but what is named. */
export function isolatedEnvironment(options: { relaySocket: string; runnerSocket: string; tmp: string; pass: Record<string, string | undefined> }):
  Record<string, string> {
  const proxy = `http://127.0.0.1:${BRIDGE_PORT}`;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '/', LANG: process.env.LANG ?? 'C.UTF-8',
    TMPDIR: options.tmp, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: '', no_proxy: '',
    NODE_USE_ENV_PROXY: '1', [ISOLATED_ENV]: JSON.stringify({ relay: options.relaySocket, runner: options.runnerSocket }),
  };
  for (const [name, value] of Object.entries(options.pass)) if (value !== undefined) env[name] = value;
  return env;
}

/**
 * The bubblewrap command around `command`: its own user, network, IPC and UTS namespaces, the machine read-only, and
 * `writable` the only places it may write, each at its own path.
 */
export function isolatedArgs(options: { command: string[]; writable: string[]; env: Record<string, string>; cwd: string }): string[] {
  const args = ['--unshare-user', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev'];
  for (const path of options.writable) args.push('--bind', path, path);
  args.push('--clearenv');
  for (const [name, value] of Object.entries(options.env)) args.push('--setenv', name, value);
  args.push('--chdir', options.cwd, '--', ...options.command);
  return args;
}

/** Runs `command` isolated, with the caller's stdout and stderr; resolves with its exit code. */
export function runIsolated(options: Parameters<typeof isolatedArgs>[0]): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn('bwrap', isolatedArgs(options), { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', fail);
    child.on('exit', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}

/**
 * The runner service, outside: starts a workspace for each connection that asks, with the given starter, and closes it
 * when asked or when the connection goes. Only places under `roots` may be handed to it.
 */
export async function serveRunner(options: { socketPath: string; runner: WorkspaceStarter; roots: string[] }): Promise<{ close(): Promise<void> }> {
  const roots = options.roots.map(root => resolve(root));
  const inside = (path: string) => roots.some(root => isWithin(resolve(path), root));
  const server = createServer(socket => {
    let workspace: RunningWorkspace | undefined;
    let buffer = '';
    const answer = (value: unknown) => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
    socket.on('error', () => undefined);
    socket.on('close', () => { void workspace?.close(); });
    socket.setEncoding('utf8').on('data', chunk => {
      buffer += chunk;
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        void (async () => {
          try {
            const request = JSON.parse(line) as { op: 'start'; options: StartOptions } | { op: 'close' };
            if (request.op === 'start') {
              const { data, manual, socketDirectory } = request.options;
              if (![data, manual, socketDirectory].every(inside)) throw new Error('a workspace is started only on the run\'s own places');
              workspace = await options.runner.start(request.options);
              answer({ ok: true, socketPath: workspace.socketPath, sandbox: workspace.sandbox });
            } else {
              await workspace?.close();
              workspace = undefined;
              answer({ ok: true });
            }
          } catch (error) { answer({ ok: false, error: (error as Error).message }); }
        })();
      }
    });
  });
  await listen(server, options.socketPath);
  return { close: () => closeServer(server, options.socketPath) };
}

/** Inside: a workspace starter that asks the runner service outside. */
export class RemoteRunner implements WorkspaceStarter {
  private readonly socketPath: string;
  constructor(socketPath: string) { this.socketPath = socketPath; }

  async start(options: StartOptions): Promise<RunningWorkspace> {
    const socket = connect(this.socketPath);
    socket.setEncoding('utf8');
    const answers: string[] = [];
    const waiting: ((line: string) => void)[] = [];
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const next = waiting.shift();
        if (next) next(line); else answers.push(line);
      }
    });
    const closed = new Promise<void>(done => socket.on('close', () => done()));
    socket.on('close', () => { for (const next of waiting.splice(0)) next(JSON.stringify({ ok: false, error: 'the runner service went away' })); });
    const ask = (request: unknown) => new Promise<{ ok: boolean; error?: string; socketPath?: string; sandbox?: RunningWorkspace['sandbox'] }>((done, fail) => {
      socket.once('error', fail);
      waiting.push(line => done(JSON.parse(line)));
      const early = answers.shift();
      if (early) waiting.shift()!(early);
      socket.write(`${JSON.stringify(request)}\n`);
    });
    await new Promise<void>((done, fail) => { socket.once('connect', () => done()); socket.once('error', fail); });
    const started = await ask({ op: 'start', options });
    if (!started.ok) { socket.destroy(); throw new Error(started.error ?? 'the workspace did not start'); }
    return {
      socketPath: started.socketPath!, sandbox: started.sandbox!,
      async close() {
        if (socket.destroyed) return;
        await ask({ op: 'close' }).catch(() => undefined);
        socket.end();
        await closed;
      },
    };
  }
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await rm(socketPath, { force: true });
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(socketPath, () => done()); });
}

async function closeServer(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>(done => server.close(() => done()));
  await rm(socketPath, { force: true });
}
