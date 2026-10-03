import { execFile } from 'node:child_process';
import { join } from 'node:path';

/**
 * The git CLI, run as a child process (ADR 0018). The memory repository is one the owner also pulls, pushes and
 * edits by hand, so the history the server writes must be what git itself writes; nothing here reimplements git.
 */

export interface GitIdentity { name: string; email: string }

/** Who the server records as the author and the committer of a commit it is not told otherwise about, such as /sources's. */
export const GIT_IDENTITY: GitIdentity = { name: 'natsumi', email: 'natsumi@natsumi.invalid' };

/** The avatar as the author of her memory commits (ADR 0057): its display name, and an address made from its ID. */
export function gitIdentity(self: { id: string; name: string }): GitIdentity {
  return { name: self.name, email: `${self.id}@natsumi.invalid` };
}

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
 * adds to the environment, such as the dates a commit is to carry; it cannot take the identity's place, which
 * `identity` gives.
 *
 * The git directory is named, never found: `gitDirectory`, by default `.git` in `directory`, is both the git
 * directory and the common one. The owner may write memory's `.git` over ssh, save its config (ADR 0067), and a
 * `commondir` file there would otherwise send git to read another directory's config, one that can run commands.
 */
export function runGit(directory: string, args: string[],
  options: { allowFailure?: boolean; env?: Record<string, string>; identity?: GitIdentity; gitDirectory?: string } = {}): Promise<GitResult> {
  const identity = options.identity ?? GIT_IDENTITY;
  const gitDirectory = options.gitDirectory ?? join(directory, '.git');
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
        GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
        // No global or system config, and no prompt: the server never waits for a person.
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
        // Set by name, so a commondir file in the git directory is never read.
        GIT_DIR: gitDirectory, GIT_COMMON_DIR: gitDirectory,
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
