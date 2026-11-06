import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The weekly release's decision (weekly-release.yml), and the one made when a vulnerability fix is merged, run as the
 * workflow runs it: in a checkout, writing to GITHUB_OUTPUT and GITHUB_STEP_SUMMARY. The script is run and not
 * imported, since the image's build stage compiles test/ without it.
 */

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'weekly-release.ts');
const RENOVATE = 'renovate[bot]';
const VULN_RESPONDER = 'fraction-vuln-responder[bot]';
const PERSON = 'OTSUKA, Yuanying';

/** git with no configuration of the machine's (no identity on CI, signing on a laptop), committing as GitHub does. */
function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: {
      ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'GitHub', GIT_AUTHOR_EMAIL: 'noreply@example.invalid',
      GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@example.invalid', ...env,
    },
  });
}

function repository(t: TestContext): string {
  const repo = mkdtempSync(join(tmpdir(), 'weekly-release-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q', '-b', 'main']);
  commit(repo, PERSON, 'Start', { 'Dockerfile': 'FROM node\n', 'README.md': 'natsumi\n' });
  return repo;
}

function commit(repo: string, author: string, subject: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', subject], { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: 'author@example.invalid' });
}

/** A Renovate branch merged into main by a merge commit of the person's, as the pull requests are merged. */
function mergeRenovate(repo: string, branch: string, subject: string, files: Record<string, string>): void {
  mergeBot(repo, RENOVATE, branch, subject, files);
}

/** A bot's branch (Renovate's, the vulnerability responder's) merged into main by a merge commit of the person's. */
function mergeBot(repo: string, author: string, branch: string, subject: string, files: Record<string, string>): void {
  git(repo, ['checkout', '-q', '-b', branch]);
  commit(repo, author, subject, files);
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['merge', '-q', '--no-ff', '-m', `Merge pull request from yuanying/${branch}`, branch],
    { GIT_AUTHOR_NAME: 'O. Yuanying', GIT_AUTHOR_EMAIL: 'merger@example.invalid' });
}

function tag(repo: string, name: string): void {
  git(repo, ['tag', '-a', name, '-m', `${name}: by hand`]);
}

/** The script's log, what it wrote to GITHUB_OUTPUT (name=value lines and name<<delimiter blocks), and its summary.
 * The weekly release runs it with no argument, the release of a vulnerability fix with `vuln-fix`. */
function decide(repo: string, args: string[] = []): { log: string; outputs: Record<string, string>; summary: string } {
  const output = join(repo, '.git', 'github-output');
  const summaryFile = join(repo, '.git', 'github-step-summary');
  writeFileSync(output, '');
  writeFileSync(summaryFile, '');
  const log = execFileSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summaryFile } });
  const outputs: Record<string, string> = {};
  const lines = readFileSync(output, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const heredoc = /^([^=<]+)<<(.+)$/.exec(lines[i]!);
    if (heredoc) {
      const end = lines.indexOf(heredoc[2]!, i + 1);
      outputs[heredoc[1]!] = lines.slice(i + 1, end).join('\n');
      i = end;
    } else if (lines[i]!.includes('=')) {
      const [name, ...value] = lines[i]!.split('=');
      outputs[name!] = value.join('=');
    }
  }
  return { log, outputs, summary: readFileSync(summaryFile, 'utf8') };
}

test('Renovate commits alone that change the images are released as the next patch, with their subjects in the tag', t => {
  const repo = repository(t);
  tag(repo, 'v0.1.9');
  commit(repo, PERSON, 'Serve the dashboard', { 'src/server/main.ts': 'serve\n' });
  tag(repo, 'v0.1.51');
  mergeRenovate(repo, 'renovate/ws', 'Update dependency ws to v8.22.1', { 'package.json': '{"ws":"8.22.1"}\n' });
  mergeRenovate(repo, 'renovate/node', 'Update node to v24.21.1', { 'Dockerfile': 'FROM node:24.21.1\n' });

  const { log, outputs } = decide(repo);
  assert.deepEqual(outputs, {
    release: 'true',
    version: 'v0.1.52',
    message: 'v0.1.52: 依存の更新（bot のコミットだけの週次の自動リリース）\n\n'
      + '- Update dependency ws to v8.22.1\n- Update node to v24.21.1',
  });
  assert.match(log, /v0\.1\.52/);
});

test('a commit of anyone but Renovate leaves the release to a person', t => {
  const repo = repository(t);
  tag(repo, 'v0.1.51');
  mergeRenovate(repo, 'renovate/pi', 'Update pi to v1.2.1', { 'package.json': '{"pi":"1.2.1"}\n' });
  commit(repo, PERSON, 'Update the Codemode prefix fixtures', { 'test/fixtures/codemode.json': '{}\n' });

  const { log, outputs } = decide(repo);
  assert.deepEqual(outputs, { release: 'false' });
  assert.match(log, /OTSUKA, Yuanying/);
});

test('Renovate commits that change only workflows or the Renovate config are not released', t => {
  const repo = repository(t);
  tag(repo, 'v0.1.51');
  mergeRenovate(repo, 'renovate/github-actions', 'Update github-actions', { '.github/workflows/ci.yml': 'on: push\n' });
  mergeRenovate(repo, 'renovate/config', 'Migrate the Renovate config', { 'renovate.json': '{}\n' });

  const { log, outputs } = decide(repo);
  assert.deepEqual(outputs, { release: 'false' });
  assert.match(log, /nothing that goes into the images/);
});

test('a tag that is not vX.Y.Z is not the last release', t => {
  const repo = repository(t);
  tag(repo, 'v0.1.51');
  mergeRenovate(repo, 'renovate/ws', 'Update dependency ws to v8.22.1', { 'package.json': '{"ws":"8.22.1"}\n' });
  tag(repo, 'v0.1.51.1');
  tag(repo, 'v0.2.0-rc.1');

  assert.deepEqual(decide(repo).outputs.version, 'v0.1.52');
});

test('nothing since the last tag is not released', t => {
  const repo = repository(t);
  tag(repo, 'v0.1.51');

  assert.deepEqual(decide(repo).outputs, { release: 'false' });
});

test('without a version tag nothing is released', t => {
  const repo = repository(t);
  mergeRenovate(repo, 'renovate/ws', 'Update dependency ws to v8.22.1', { 'package.json': '{"ws":"8.22.1"}\n' });

  const { log, outputs } = decide(repo);
  assert.deepEqual(outputs, { release: 'false' });
  assert.match(log, /no vX\.Y\.Z tag/);
});

test('only the files that go into the images are counted, whatever else Renovate changed', t => {
  for (const path of ['.dockerignore', 'package-lock.json', 'tsconfig.json', 'scripts/build-web.ts', 'docker/sdctl/sdctl',
    'runner/go.mod', 'manual/index.md', 'assets/avatars/natsumi/avatar.yaml']) {
    const repo = repository(t);
    tag(repo, 'v0.1.51');
    mergeRenovate(repo, 'renovate/x', 'Update x', { [path]: 'x\n' });
    assert.equal(decide(repo).outputs.release, 'true', path);
  }
  for (const path of ['mac/Natsumi/App.swift', 'docs/adr/0079.md', 'test/args.test.ts', 'scripts/weekly-release.ts',
    'README.md', 'compose.yaml', 'eval/cases.json']) {
    const repo = repository(t);
    tag(repo, 'v0.1.51');
    mergeRenovate(repo, 'renovate/x', 'Update x', { [path]: 'x\n' });
    assert.equal(decide(repo).outputs.release, 'false', path);
  }
});

test('the vulnerability responder\'s commits count as Renovate\'s in the weekly release', t => {
  const repo = repository(t);
  tag(repo, 'v0.1.51');
  mergeBot(repo, VULN_RESPONDER, 'vuln-responder/ws', 'Update ws to v8.22.2 for CVE-2026-1234', { 'package.json': '{"ws":"8.22.2"}\n' });
  mergeRenovate(repo, 'renovate/node', 'Update node to v24.21.1', { 'Dockerfile': 'FROM node:24.21.1\n' });

  const { outputs, summary } = decide(repo);
  assert.deepEqual(outputs, {
    release: 'true',
    version: 'v0.1.52',
    message: 'v0.1.52: 依存の更新（bot のコミットだけの週次の自動リリース）\n\n'
      + '- Update ws to v8.22.2 for CVE-2026-1234\n- Update node to v24.21.1',
  });
  assert.equal(summary, '');
});

test('a merged vulnerability fix alone is released at once as the next patch, said to be a fix in the tag', t => {
  const repo = repository(t);
  tag(repo, 'v0.1.51');
  mergeBot(repo, VULN_RESPONDER, 'vuln-responder/ws', 'Update ws to v8.22.2 for CVE-2026-1234', { 'package.json': '{"ws":"8.22.2"}\n' });

  const { log, outputs } = decide(repo, ['vuln-fix']);
  assert.deepEqual(outputs, {
    release: 'true',
    version: 'v0.1.52',
    message: 'v0.1.52: 脆弱性の直し（脆弱性対応の係の PR のマージですぐに出す自動リリース）\n\n'
      + '- Update ws to v8.22.2 for CVE-2026-1234',
  });
  assert.match(log, /v0\.1\.52/);
});

test('a vulnerability fix merged after Renovate\'s updates is released with them', t => {
  const repo = repository(t);
  tag(repo, 'v0.1.51');
  mergeRenovate(repo, 'renovate/node', 'Update node to v24.21.1', { 'Dockerfile': 'FROM node:24.21.1\n' });
  mergeBot(repo, VULN_RESPONDER, 'vuln-responder/ws', 'Update ws to v8.22.2 for CVE-2026-1234', { 'package.json': '{"ws":"8.22.2"}\n' });

  const { outputs, summary } = decide(repo, ['vuln-fix']);
  assert.equal(outputs.release, 'true');
  assert.equal(outputs.version, 'v0.1.52');
  assert.match(outputs.message!, /- Update node to v24\.21\.1\n- Update ws to v8\.22\.2 for CVE-2026-1234$/);
  assert.equal(summary, '');
});

test('a person\'s commit holds back a vulnerability fix, and the summary lists it with the commands to release by hand', t => {
  const repo = repository(t);
  tag(repo, 'v0.1.51');
  commit(repo, PERSON, 'Serve the dashboard', { 'src/server/main.ts': 'serve\n' });
  const held = git(repo, ['rev-parse', '--short', 'HEAD']).trim();
  mergeBot(repo, VULN_RESPONDER, 'vuln-responder/ws', 'Update ws to v8.22.2 for CVE-2026-1234', { 'package.json': '{"ws":"8.22.2"}\n' });
  const head = git(repo, ['rev-parse', 'HEAD']).trim();

  const { log, outputs, summary } = decide(repo, ['vuln-fix']);
  assert.deepEqual(outputs, { release: 'false' });
  assert.match(log, /OTSUKA, Yuanying/);
  assert.match(summary, /v0\.1\.51/);
  assert.ok(summary.includes(`\`${held}\` Serve the dashboard（OTSUKA, Yuanying）`), summary);
  assert.ok(!summary.includes('Update ws to v8.22.2 for CVE-2026-1234（'), summary);
  assert.ok(summary.includes(`git tag -a v0.1.52 -m "v0.1.52: <変更の中身>" ${head}`), summary);
  assert.ok(summary.includes('git push origin refs/tags/v0.1.52'), summary);
});

test('a vulnerability fix that changes nothing in the images is not released, and the summary says why', t => {
  const repo = repository(t);
  tag(repo, 'v0.1.51');
  mergeBot(repo, VULN_RESPONDER, 'vuln-responder/docs', 'Note CVE-2026-1234', { 'docs/security.md': 'x\n' });

  const { outputs, summary } = decide(repo, ['vuln-fix']);
  assert.deepEqual(outputs, { release: 'false' });
  assert.match(summary, /nothing that goes into the images/);
  assert.ok(!summary.includes('git tag'), summary);
});

test('the weekly release writes no summary when it releases nothing', t => {
  const repo = repository(t);
  tag(repo, 'v0.1.51');
  commit(repo, PERSON, 'Serve the dashboard', { 'src/server/main.ts': 'serve\n' });

  assert.equal(decide(repo).summary, '');
});
