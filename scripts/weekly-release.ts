// Decides the weekly release (weekly-release.yml): a patch version is tagged and its images pushed only when every
// commit since the last version tag, merges aside, is a bot's (Renovate's or the vulnerability responder's) and the
// changes reach the images. Anything a person wrote is left to a release by hand, which says in its tag what changed.
// The same decision is made at once when the vulnerability responder's pull request is merged (ADR 0082); when it
// holds the fix back, it writes the commits that held it and the commands to release by hand to the job's summary.
// Run in a checkout as `node scripts/weekly-release.ts`, or `node scripts/weekly-release.ts vuln-fix` for a merged
// fix; it writes release, version and message to GITHUB_OUTPUT.
// It is not under tsconfig's include, so as to stay out of the image's build; test/weekly-release.test.ts runs it.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

/** The authors whose commits alone may be released without a person: Renovate, and the vulnerability responder (the
 * GitHub App fraction-vuln-responder, whose pull requests fix a vulnerability in a dependency or the base image). */
const BOTS = ['renovate[bot]', 'fraction-vuln-responder[bot]'];

/** What goes into the images: what the Dockerfile copies, and the Dockerfile itself. Everything else — workflows,
 * renovate.json, the apps under mac/, docs/, the tests — changes nothing in them. */
const RELEASE_FILES = ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'tsconfig.json',
  'scripts/build-web.ts'];
const RELEASE_DIRECTORIES = ['src/', 'docker/', 'runner/', 'manual/', 'assets/'];

type Trigger = 'weekly' | 'vuln-fix';
interface Commit { hash: string; author: string; subject: string }
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
  const others = [...new Set(heldBy(commits).map(commit => commit.author))];
  if (others.length > 0) {
    return { release: false, reason: `commits since ${tag} by ${others.join(', ')} are left to a release by hand` };
  }
  const changed = files.filter(isReleaseFile);
  if (changed.length === 0) return { release: false, reason: `nothing that goes into the images changed since ${tag}` };
  const version = nextPatchVersion(tag);
  return { release: true, version, reason: `bots alone changed ${changed.join(', ')} since ${tag}` };
}

/** The commits that keep a release from going out without a person: those of anyone but the bots. */
function heldBy(commits: Commit[]): Commit[] {
  return commits.filter(commit => !BOTS.includes(commit.author));
}

/** The annotated tag's message, in the form of the tags made by hand: the version, then what it carries. */
function releaseMessage(trigger: Trigger, version: string, subjects: string[]): string {
  const title = trigger === 'vuln-fix'
    ? '脆弱性の直し（脆弱性対応の係の PR のマージですぐに出す自動リリース）'
    : '依存の更新（bot のコミットだけの週次の自動リリース）';
  return `${version}: ${title}\n\n${subjects.map(s => `- ${s}\n`).join('')}`;
}

/** Why a merged fix was not released, for the job's summary: the commits that held it back, and how to release the
 * commit by hand. A tag pushed by a person starts images.yml, which pushes the images. */
function heldSummary(history: History, head: string, reason: string): string {
  const lines = ['## 脆弱性の直しをすぐにはリリースしなかった', '', `理由: ${reason}`, ''];
  const held = heldBy(history.commits);
  if (history.tag && held.length > 0) {
    const version = nextPatchVersion(history.tag);
    lines.push(`### ${history.tag} 以降の、bot でないコミット`, '',
      ...held.map(commit => `- \`${commit.hash}\` ${commit.subject}（${commit.author}）`), '',
      '### 手でリリースするには', '',
      '変更の中身を確かめ、タグのメッセージに書いて push する（版は変更に合わせて上げる）。', '',
      '```sh', 'git fetch origin --tags', `git tag -a ${version} -m "${version}: <変更の中身>" ${head}`,
      `git push origin refs/tags/${version}`, '```', '');
  }
  return lines.join('\n');
}

function git(cwd: string, args: string[]): string[] {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).split('\n').filter(line => line !== '');
}

/** The last version tag reachable from HEAD, the commits after it that are not merges, and the files changed since. */
function readHistory(cwd: string): History {
  const tag = latestVersionTag(git(cwd, ['tag', '--merged', 'HEAD', '--list', 'v*']));
  if (!tag) return { tag, commits: [], files: [] };
  const commits = git(cwd, ['log', '--no-merges', '--reverse', '--format=%h%x00%an%x00%s', `${tag}..HEAD`]).map(line => {
    const [hash, author, subject] = line.split('\0') as [string, string, string];
    return { hash, author, subject };
  });
  return { tag, commits, files: git(cwd, ['diff', '--name-only', tag, 'HEAD']) };
}

const trigger: Trigger = process.argv[2] === 'vuln-fix' ? 'vuln-fix' : 'weekly';
const history = readHistory(process.cwd());
const decision = decideRelease(history);
console.log(decision.release ? `releasing ${decision.version}: ${decision.reason}` : `no release: ${decision.reason}`);
const output = process.env.GITHUB_OUTPUT;
if (output) {
  const lines = [`release=${decision.release}`];
  if (decision.release) {
    const delimiter = `EOF-${randomUUID()}`;
    const message = releaseMessage(trigger, decision.version, history.commits.map(commit => commit.subject));
    lines.push(`version=${decision.version}`, `message<<${delimiter}`, message.trimEnd(), delimiter);
  }
  appendFileSync(output, `${lines.join('\n')}\n`);
}
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary && trigger === 'vuln-fix' && !decision.release) {
  appendFileSync(summary, heldSummary(history, git(process.cwd(), ['rev-parse', 'HEAD'])[0]!, decision.reason));
}
