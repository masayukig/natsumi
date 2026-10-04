import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, readFile, readlink, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * natsumi's workspace for a turn evaluation (ADR 0051): the real runner, built from `runner/`, answering on a Unix socket
 * the server side reaches through the real `WorkspaceShell`. In `bwrap` it runs inside bubblewrap, laid out as the
 * workspace container (compose.yaml, Dockerfile): /memory with its .git read-only, /work and /home/natsumi writable,
 * /manual, /manual/agents, /manual/avatar and /sources read-only, the image's /usr/local/bin scripts, and no network. In `host` it
 * runs unconfined in the run's work directory, with none of those paths: only for the scripted model of a dry run
 * where bubblewrap cannot make a sandbox (CI).
 */

export type Sandbox = 'bwrap' | 'host';

export interface RunningWorkspace {
  socketPath: string;
  sandbox: Sandbox;
  close(): Promise<void>;
}

export interface StartOptions {
  /** The run's data directory: memory/, work/, home/, sources/, agents/ and, when there is one, sources.git/. */
  data: string;
  /** The run's copy of the manual. */
  manual: string;
  /** Where the socket is made; it must not exist yet or be empty. */
  socketDirectory: string;
  sandbox: Sandbox;
  timeZone: string;
  /** The runner's own response limit (the production one is 60 seconds). */
  responseLimitSeconds?: number;
}

const RUNNER_NAME = 'natsumi-workspace-runner';
const SOCKET_NAME = 'runner.sock';
/** Only what a command needs of /etc: no hosts, no resolver, nothing about the machine it runs on. */
const ETC = ['alternatives', 'ld.so.cache', 'ld.so.conf', 'ld.so.conf.d', 'localtime', 'ssl', 'ca-certificates', 'passwd', 'group',
  'nsswitch.conf', 'bash.bashrc', 'inputrc', 'profile', 'mime.types', 'magic'];
/** The image's system git config, in place of the host's: it trusts /memory and nothing else. */
const GITCONFIG = 'docker/workspace/gitconfig';
/** The image copies these into /usr/local/bin; the list is read from the Dockerfile so that it follows the image. */
const LOCAL_BIN = /^COPY\s+(?:--chmod=\S+\s+)?(docker\/\S+)\s+\/usr\/local\/bin\/([A-Za-z0-9._-]+)\s*$/;

export async function goAvailable(): Promise<boolean> {
  try { await run('go', ['version']); return true; } catch { return false; }
}

/** Whether bubblewrap can make a sandbox here: installed, and allowed to make a user namespace. */
export async function bwrapAvailable(): Promise<boolean> {
  try {
    await run('bwrap', ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', '--dev', '/dev', 'true'], { timeout: 10_000 });
    return true;
  } catch { return false; }
}

let pidNamespace: Promise<boolean> | undefined;

/**
 * Whether bubblewrap may also give the sandbox a pid namespace with its own /proc. Inside some containers it may not;
 * the sandbox then sees the host's /proc, read-only, and commands left running outlive the run.
 */
function pidNamespaceAvailable(): Promise<boolean> {
  pidNamespace ??= run('bwrap', ['--unshare-user', '--unshare-pid', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', 'true'],
    { timeout: 10_000 }).then(() => true, () => false);
  return pidNamespace;
}

/** What starts a workspace for a run: the runner itself, or a stand-in that asks another process to start it. */
export interface WorkspaceStarter {
  start(options: StartOptions): Promise<RunningWorkspace>;
}

export class WorkspaceRunner implements WorkspaceStarter {
  private readonly binary: string;
  private readonly tools: string;
  private readonly gitconfig: string;

  private constructor(binary: string, tools: string, gitconfig: string) { this.binary = binary; this.tools = tools; this.gitconfig = gitconfig; }

  /** Builds the runner from the repository's source and gathers the image's /usr/local/bin scripts into `cache`. */
  static async prepare(options: { repository: string; cache: string }): Promise<WorkspaceRunner> {
    await mkdir(options.cache, { recursive: true });
    const binary = join(options.cache, RUNNER_NAME);
    try {
      await run('go', ['build', '-trimpath', '-o', binary, '.'], { cwd: join(options.repository, 'runner'),
        env: { ...process.env, CGO_ENABLED: '0' } });
    } catch (error) {
      throw new Error(`the runner could not be built with go (${String((error as { stderr?: string }).stderr ?? error).trim().split('\n')[0]})`);
    }
    const tools = join(options.cache, 'bin');
    await rm(tools, { recursive: true, force: true });
    await mkdir(tools);
    const dockerfile = await readFile(join(options.repository, 'Dockerfile'), 'utf8').catch(() => '');
    for (const line of dockerfile.split('\n')) {
      const match = LOCAL_BIN.exec(line.trim());
      if (!match) continue;
      try {
        await copyFile(join(options.repository, match[1]!), join(tools, match[2]!));
        await chmod(join(tools, match[2]!), 0o755);
      } catch { /* a script the branch does not have yet */ }
    }
    return new WorkspaceRunner(binary, tools, join(options.repository, GITCONFIG));
  }

  async start(options: StartOptions): Promise<RunningWorkspace> {
    await mkdir(options.socketDirectory, { recursive: true });
    // The mount points of /manual/agents and /manual/avatar, as the image makes them.
    await mkdir(join(options.manual, 'agents'), { recursive: true });
    await mkdir(join(options.manual, 'avatar'), { recursive: true });
    const socketPath = join(options.socketDirectory, SOCKET_NAME);
    const limit = `${options.responseLimitSeconds ?? 60}s`;
    let child: ChildProcess;
    if (options.sandbox === 'host') {
      child = spawn(this.binary, ['serve', '-socket', socketPath, '-dir', join(options.data, 'work'), '-home', join(options.data, 'home'),
        '-response-limit', limit, '-tz', options.timeZone], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    } else {
      child = spawn('bwrap', [...await this.layout(options), '/run/natsumi-runner/natsumi-workspace-runner', 'serve',
        '-socket', `/run/natsumi-workspace/${SOCKET_NAME}`, '-response-limit', limit, '-max-output', '65536', '-tz', options.timeZone],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    }
    let stderr = '';
    child.stderr!.setEncoding('utf8').on('data', chunk => { if (stderr.length < 4000) stderr += chunk; });
    let exited = false;
    const done = new Promise<void>(resolve => child.on('exit', () => { exited = true; resolve(); }));
    const deadline = Date.now() + 15_000;
    while (!(await answers(socketPath))) {
      if (exited || Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error(`the workspace runner did not start (${stderr.trim().split('\n').at(-1) ?? 'no output'})`);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return {
      socketPath, sandbox: options.sandbox,
      async close() {
        if (!exited) {
          // In bwrap the runner is the first process of its own pid namespace: when it goes, everything it left goes too.
          if (options.sandbox === 'host' && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
          child.kill('SIGKILL');
          await done;
        }
        // The runner leaves its socket's directory read-only, as in the container; the run's directory must go.
        await chmod(options.socketDirectory, 0o755).catch(() => undefined);
      },
    };
  }

  private async layout(options: StartOptions): Promise<string[]> {
    const { data } = options;
    const pid = await pidNamespaceAvailable();
    const args = ['--unshare-user', '--unshare-ipc', ...(pid ? ['--unshare-pid'] : []), '--unshare-uts', '--unshare-net',
      '--unshare-cgroup-try', '--die-with-parent', '--new-session', '--tmpfs', '/', '--ro-bind', '/usr', '/usr'];
    // Merged /usr or not, as the host has it.
    for (const name of ['bin', 'sbin', 'lib', 'lib32', 'lib64', 'libx32']) {
      const path = `/${name}`;
      try {
        const entry = await lstat(path);
        if (entry.isSymbolicLink()) args.push('--symlink', await readlink(path), path);
        else if (entry.isDirectory()) args.push('--ro-bind', path, path);
      } catch { /* not on this host */ }
    }
    for (const name of ETC) {
      try { await lstat(`/etc/${name}`); args.push('--ro-bind', `/etc/${name}`, `/etc/${name}`); } catch { /* not on this host */ }
    }
    try { await lstat(this.gitconfig); args.push('--ro-bind', this.gitconfig, '/etc/gitconfig'); } catch { /* a branch before it */ }
    args.push(...(pid ? ['--proc', '/proc'] : ['--ro-bind', '/proc', '/proc']), '--dev', '/dev', '--tmpfs', '/tmp',
      '--ro-bind', this.tools, '/usr/local/bin',
      '--ro-bind', this.binary, '/run/natsumi-runner/natsumi-workspace-runner',
      '--bind', options.socketDirectory, '/run/natsumi-workspace',
      '--bind', join(data, 'memory'), '/memory');
    try { await lstat(join(data, 'memory', '.git')); args.push('--ro-bind', join(data, 'memory', '.git'), '/memory/.git'); } catch { /* not a repository yet */ }
    args.push('--bind', join(data, 'work'), '/work', '--bind', join(data, 'home'), '/home/natsumi',
      '--ro-bind', options.manual, '/manual', '--ro-bind', join(data, 'agents'), '/manual/agents',
      '--ro-bind', join(data, 'avatar'), '/manual/avatar',
      '--ro-bind', join(data, 'sources'), '/sources');
    try { await lstat(join(data, 'sources.git')); args.push('--ro-bind', join(data, 'sources.git'), '/sources.git'); } catch { /* before ADR 0050 */ }
    args.push('--chdir', '/work', '--clearenv', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'HOME', '/home/natsumi');
    return args;
  }
}

/** Whether something answers on the socket yet. */
function answers(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(path);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}
