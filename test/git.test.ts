import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, appendFile, chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runGit } from '../src/server/git.ts';
import { ALWAYS_FILE, MemoryRepository } from '../src/server/memory-repository.ts';

// The ssh entry may write memory's .git, save its config (ADR 0067). What it can put there must not make the server's
// git run anything: a `.git/commondir` naming a directory whose config holds a `core.fsmonitor` is the way around the
// read-only config, and the server names the git directory itself so that no config is read through it.

const exists = (path: string) => access(path).then(() => true, () => false);

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-git-')));
  const marker = join(root, 'ran');
  const monitor = join(root, 'monitor.sh');
  await writeFile(monitor, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  await chmod(monitor, 0o755);
  const git = (directory: string, ...args: string[]) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  /** A copy of `gitDirectory` elsewhere, with the monitor in its config, named by `gitDirectory/commondir`. */
  const pointElsewhere = async (gitDirectory: string) => {
    const elsewhere = join(root, 'elsewhere');
    await cp(gitDirectory, elsewhere, { recursive: true });
    await appendFile(join(elsewhere, 'config'), `[core]\n\tfsmonitor = ${monitor}\n`);
    await writeFile(join(gitDirectory, 'commondir'), `${elsewhere}\n`);
    return elsewhere;
  };
  return { root, marker, monitor, git, pointElsewhere, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('a commondir in memory\'s .git is not followed for config: the day\'s commit runs nothing it names', async () => {
  const f = await setup();
  try {
    const directory = join(f.root, 'memory');
    await mkdir(directory);
    const repository = new MemoryRepository({ directory, dataDirectory: f.root });
    await repository.initialize();
    const before = f.git(directory, 'rev-parse', 'HEAD');
    await f.pointElsewhere(join(directory, '.git'));

    // A change that goes back (a checkout) and a new note (an add and a commit).
    await writeFile(join(directory, ALWAYS_FILE), '# 常時記憶\n\n日中に書いた\n');
    await writeFile(join(directory, '予定.md'), '# 予定\n\n- 金曜に歯医者\n');
    const outcome = await repository.commit({ event: 'owner_message' });

    assert.equal(await exists(f.marker), false, 'the monitor named by the other config ran');
    assert.equal(outcome.committed, true);
    assert.deepEqual(outcome.files, ['予定.md']);
    assert.deepEqual(outcome.reverted.map(file => file.path), [ALWAYS_FILE]);
    assert.doesNotMatch(await readFile(join(directory, ALWAYS_FILE), 'utf8'), /日中に書いた/);
    // Committed, as the server reads it. Which ref store the branch moved in is left alone: git's ref store reads a
    // commondir by itself whatever GIT_COMMON_DIR says, and the ssh entry, which can write the refs outright, gains
    // nothing from sending them elsewhere (ADR 0067).
    const own = join(directory, '.git');
    const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_DIR: own, GIT_COMMON_DIR: own } }).trim();
    assert.equal(git('rev-parse', 'HEAD~1'), before);
    assert.equal(git('log', '-1', '--format=%s'), 'owner_message: 予定.md');
  } finally {
    await f.cleanup();
  }
});

test('a commondir in a git directory named apart from its work tree is not followed either, as /sources\'s is', async () => {
  const f = await setup();
  try {
    const directory = join(f.root, 'sources');
    const gitDirectory = join(f.root, 'sources.git');
    await mkdir(directory);
    const git = (args: string[]) => runGit(directory, ['--work-tree', directory, ...args], { gitDirectory });
    await git(['init', '-q', '-b', 'main']);
    await writeFile(join(directory, 'a.md'), 'a\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'first']);
    await f.pointElsewhere(gitDirectory);

    await writeFile(join(directory, 'a.md'), 'b\n');
    for (const args of [['status', '--porcelain'], ['add', '-A'], ['commit', '-q', '-m', 'second'], ['checkout', 'HEAD~1', '--', 'a.md']]) {
      await git(args);
    }

    assert.equal(await exists(f.marker), false, 'the monitor named by the other config ran');
    assert.equal((await git(['log', '-1', '--format=%s'])).stdout.trim(), 'second');
  } finally {
    await f.cleanup();
  }
});

test('a core.fsmonitor written into .git/config itself is still read: keeping that file unwritable is the ssh entry\'s mount\'s job', async () => {
  // Recorded rather than wished away (ADR 0067): the server reads the repository's own config, as git must to work
  // at all, and does not list the settings that run commands to switch them off one by one.
  const f = await setup();
  try {
    const directory = join(f.root, 'memory');
    await mkdir(directory);
    const repository = new MemoryRepository({ directory, dataDirectory: f.root });
    await repository.initialize();
    await appendFile(join(directory, '.git', 'config'), `[core]\n\tfsmonitor = ${f.monitor}\n`);

    await writeFile(join(directory, '予定.md'), '# 予定\n\n- 金曜に歯医者\n');
    await repository.commit({ event: 'owner_message' });

    assert.equal(await exists(f.marker), true);
  } finally {
    await f.cleanup();
  }
});
