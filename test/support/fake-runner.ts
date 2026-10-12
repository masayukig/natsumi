import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A stand-in for the runner of the workspace container (ADR 0019), speaking the same one-JSON-line protocol over a
 * Unix socket. It runs each command with `bash -c` on the host, in the directory given, so a test can exercise the
 * whole path from the model's tool call to a file in the memory repository without Docker. Nothing else about the
 * container is imitated: the confinement is the container's, and it is measured by scripts/check-workspace-sandbox.sh.
 */
export interface FakeRunner {
  path: string;
  commands: string[];
  /** The declared tools' requests (ADR 0075), as they came: the program and its arguments, the input and the timeout. */
  tools: { argv: string[]; stdin: string; timeoutSeconds: number | undefined }[];
  timeZones: (string | undefined)[];
  close(): Promise<void>;
}

/**
 * `programs` stands in for /tools: an argv's program is looked up there by its path and run with bash, the way the
 * runner would start it. `commandOnly` answers an argv request as a runner from before ADR 0075 did.
 */
export async function startFakeRunner(options: { dir: string; responseLimitMs?: number; programs?: Record<string, string>;
  commandOnly?: boolean }): Promise<FakeRunner> {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-runner-'));
  const path = join(root, 'runner.sock');
  const commands: string[] = [];
  const tools: FakeRunner['tools'] = [];
  const timeZones: (string | undefined)[] = [];
  const sockets = new Set<Socket>();
  const responseLimitMs = options.responseLimitMs ?? 10_000;
  const server: Server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end)) as { command?: string; timeZone?: string; argv?: string[]; stdin?: string;
        timeoutSeconds?: number };
      if (request.argv && options.commandOnly) { socket.end(`${JSON.stringify({ error: 'command is empty' })}\n`); return; }
      if (request.argv) { runTool(socket, request as { argv: string[] }); return; }
      commands.push(request.command!);
      timeZones.push(request.timeZone);
      execFile('bash', ['-c', request.command!], {
        cwd: options.dir, timeout: responseLimitMs, encoding: 'utf8', maxBuffer: 1 << 20,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: options.dir, LANG: 'C.UTF-8', TZ: request.timeZone ?? 'UTC' },
      }, (error, stdout, stderr) => {
        const killed = Boolean(error && (error as { killed?: boolean }).killed);
        socket.end(`${JSON.stringify({
          exitCode: killed ? null : Number((error as { code?: number } | null)?.code ?? 0),
          stdout: String(stdout), stderr: String(stderr), stdoutTruncated: false, stderrTruncated: false,
          stillRunning: killed, responseLimitMs, running: killed ? 1 : 0,
        })}\n`);
      });
    });
  });
  const runTool = (socket: Socket, request: { argv: string[]; stdin?: string; timeoutSeconds?: number; timeZone?: string }) => {
    const stdin = request.stdin ?? '';
    tools.push({ argv: request.argv, stdin, timeoutSeconds: request.timeoutSeconds });
    timeZones.push(request.timeZone);
    const body = options.programs?.[request.argv[0]!];
    if (body === undefined) {
      socket.end(`${JSON.stringify({ exitCode: 127, stdout: '', stderr: 'the program could not be started: no such file\n',
        stdoutTruncated: false, stderrTruncated: false, stillRunning: false, timedOut: false, responseLimitMs: 0, running: 0 })}\n`);
      return;
    }
    const limitMs = Math.min((request.timeoutSeconds ?? 60) * 1000, responseLimitMs);
    const child = spawn('bash', ['-c', body, request.argv[0]!, ...request.argv.slice(1)], {
      cwd: options.dir, detached: true,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: options.dir, LANG: 'C.UTF-8', TZ: request.timeZone ?? 'UTC' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } }, limitMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      socket.end(`${JSON.stringify({
        exitCode: timedOut || signal ? null : code, ...(signal && !timedOut ? { signal } : {}),
        stdout, stderr, stdoutTruncated: false, stderrTruncated: false, stillRunning: false, timedOut,
        responseLimitMs: limitMs, running: 0,
      })}\n`);
    });
  };
  await new Promise<void>(resolve => server.listen(path, resolve));
  return {
    path, commands, tools, timeZones,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}
