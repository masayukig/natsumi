import { execFile } from 'node:child_process';

/**
 * The git CLI, run as a child process (ADR 0018). The memory repository is one the owner also pulls, pushes and
 * edits by hand, so the history the server writes must be what git itself writes; nothing here reimplements git.
 */

/** Who the server records as the author and the committer of every memory commit. */
export const GIT_IDENTITY = { name: 'natsumi', email: 'natsumi@natsumi.invalid' };

export class GitError extends Error {
  readonly code: number;
  readonly stderr: string;
  constructor(args: string[], code: number, stderr: string) {
    super(`git ${args.join(' ')} failed (${code})`);
    this.name = 'GitError';
    this.code = code;
    this.stderr = stderr;
  }
}

export interface GitResult { code: number; stdout: string; stderr: string }

/** stdout of a command is bounded: a memory repository is small, and a runaway answer must not fill memory. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Runs git in `directory`. Hooks never run and no user, system or environment configuration is read, so a file
 * left in the repository cannot change what committing does. A failing command throws unless `allowFailure`. `env`
 * adds to the environment, such as the dates a commit is to carry; it cannot take the identity's place.
 */
export function runGit(directory: string, args: string[], options: { allowFailure?: boolean; env?: Record<string, string> } = {}): Promise<GitResult> {
  const full = ['-C', directory, '-c', 'core.hooksPath=/dev/null', '-c', `safe.directory=${directory}`,
    '-c', 'core.quotePath=false', '-c', 'commit.gpgsign=false', ...args];
  return new Promise((resolve, reject) => {
    execFile('git', full, {
      encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true,
      env: {
        ...options.env,
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        LC_ALL: 'C',
        // Only the identity below decides who commits.
        GIT_AUTHOR_NAME: GIT_IDENTITY.name, GIT_AUTHOR_EMAIL: GIT_IDENTITY.email,
        GIT_COMMITTER_NAME: GIT_IDENTITY.name, GIT_COMMITTER_EMAIL: GIT_IDENTITY.email,
        // No global or system config, and no prompt: the server never waits for a person.
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
      },
    }, (error, stdout, stderr) => {
      const code = error ? Number((error as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
      if (error && !options.allowFailure) {
        reject(error.message.startsWith('spawn') ? error : new GitError(args, code, String(stderr)));
        return;
      }
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
