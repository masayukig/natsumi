// Decides the weekly release (weekly-release.yml): a patch version is tagged and its images pushed only when every
// commit since the last version tag, merges aside, is Renovate's and the changes reach the images. Anything a person
// wrote is left to a release by hand, which says in its tag what changed.
// Run in a checkout as `node scripts/weekly-release.ts`; it writes release, version and message to GITHUB_OUTPUT.
// It is not under tsconfig's include, so as to stay out of the image's build; test/weekly-release.test.ts runs it.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const RENOVATE = 'renovate[bot]';

/** What goes into the images: what the Dockerfile copies, and the Dockerfile itself. Everything else — workflows,
 * renovate.json, the apps under mac/, docs/, the tests — changes nothing in them. */
const RELEASE_FILES = ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'tsconfig.json',
  'scripts/build-web.ts'];
const RELEASE_DIRECTORIES = ['src/', 'docker/', 'runner/', 'manual/', 'assets/'];

interface Commit { author: string; subject: string }
interface History { tag: string | undefined; commits: Commit[]; files: string[] }
type Decision = { release: true; version: string; reason: string } | { release: false; reason: string };

const VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

function versionOf(tag: string): [number, number, number] | undefined {
  const match = VERSION_TAG.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** The highest tag of the form vX.Y.Z, compared by its numbers. Any other tag (v0.17.0.1, v1.0.0-rc.1) is not one. */
function latestVersionTag(tags: string[]): string | undefined {
  const compare = (a: [number, number, number], b: [number, number, number]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  let latest: { tag: string; version: [number, number, number] } | undefined;
  for (const tag of tags) {
    const version = versionOf(tag);
    if (version && (!latest || compare(version, latest.version) > 0)) latest = { tag, version };
  }
  return latest?.tag;
}

function nextPatchVersion(tag: string): string {
  const version = versionOf(tag);
  if (!version) throw new Error(`not a version tag: ${tag}`);
  return `v${version[0]}.${version[1]}.${version[2] + 1}`;
}

function isReleaseFile(path: string): boolean {
  return RELEASE_FILES.includes(path) || RELEASE_DIRECTORIES.some(directory => path.startsWith(directory));
}

function decideRelease({ tag, commits, files }: History): Decision {
  if (!tag) return { release: false, reason: 'there is no vX.Y.Z tag to release after' };
  const others = [...new Set(commits.map(commit => commit.author).filter(author => author !== RENOVATE))];
  if (others.length > 0) {
    return { release: false, reason: `commits since ${tag} by ${others.join(', ')} are left to a release by hand` };
  }
  const changed = files.filter(isReleaseFile);
  if (changed.length === 0) return { release: false, reason: `nothing that goes into the images changed since ${tag}` };
  const version = nextPatchVersion(tag);
  return { release: true, version, reason: `Renovate alone changed ${changed.join(', ')} since ${tag}` };
}

/** The annotated tag's message, in the form of the tags made by hand: the version, then what it carries. */
function releaseMessage(version: string, subjects: string[]): string {
  return `${version}: 依存の更新（Renovate のコミットだけの週次の自動リリース）\n\n${subjects.map(s => `- ${s}\n`).join('')}`;
}

function git(cwd: string, args: string[]): string[] {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).split('\n').filter(line => line !== '');
}

/** The last version tag reachable from HEAD, the commits after it that are not merges, and the files changed since. */
function readHistory(cwd: string): History {
  const tag = latestVersionTag(git(cwd, ['tag', '--merged', 'HEAD', '--list', 'v*']));
  if (!tag) return { tag, commits: [], files: [] };
  const commits = git(cwd, ['log', '--no-merges', '--reverse', '--format=%an%x00%s', `${tag}..HEAD`]).map(line => {
    const [author, subject] = line.split('\0') as [string, string];
    return { author, subject };
  });
  return { tag, commits, files: git(cwd, ['diff', '--name-only', tag, 'HEAD']) };
}

const history = readHistory(process.cwd());
const decision = decideRelease(history);
console.log(decision.release ? `releasing ${decision.version}: ${decision.reason}` : `no release: ${decision.reason}`);
const output = process.env.GITHUB_OUTPUT;
if (output) {
  const lines = [`release=${decision.release}`];
  if (decision.release) {
    const delimiter = `EOF-${randomUUID()}`;
    const message = releaseMessage(decision.version, history.commits.map(commit => commit.subject));
    lines.push(`version=${decision.version}`, `message<<${delimiter}`, message.trimEnd(), delimiter);
  }
  appendFileSync(output, `${lines.join('\n')}\n`);
}
