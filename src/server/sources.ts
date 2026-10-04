import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ImageContent } from '@earendil-works/pi-ai';
import { runGit, type GitResult } from './git.ts';
import { isoAt, localDate, localDateTime } from './nightly.ts';
import { current, isAwake, type AwakeHours, type Live } from './scheduler.ts';
import { imageType, SOURCES_PATH } from './view.ts';

/**
 * What natsumi reads besides her memory, and how she hears that it changed (ADR 0050, ADR 0053). Every source writes its files
 * under `sources/<name>/` and nothing more; this core knows none of them. It keeps `sources/` as the work tree of one
 * git repository kept outside it, looks now and then at what differs from the last commit, and counts the writes of
 * each directory at the depth its source registered (Slack's is a channel). A directory that changed is shown in a
 * `sources_updated` event once its wait is up: a wait drawn at its first change after the last look, at random around a
 * mean that shortens as it gets busier. Out of the awake hours only what a source marked as for her (an attention)
 * raises one, and the rest wait for the morning.
 *
 * A commit is made only when an event is made (and when a directory is first seen, to take it in silently). Each
 * directory's last look is its ref `refs/seen/<dir>`, and the one before it `refs/before/<dir>`, which is what
 * `sources-diff` shows. The history is cut back to a few days every night.
 */

export const SOURCES_DEFAULTS = {
  /**
   * The mean wait = k ÷ (writes in the window ÷ its minutes), held between the shortest and the quiet mean; the quiet
   * mean with one write or none. A wait is drawn around it and cut at the longest.
   */
  activity: { k: 3, minMinutes: 3, maxMinutes: 60, windowMinutes: 15, quietMeanMinutes: 10 },
  /** The days of history kept when it is cut back at night. */
  historyDays: 7,
};
/** The images of an event's attentions shown beside it, at most. */
export const MAX_ATTENTION_IMAGES = 4;
/** The directories of the last event, one a line, for `sources-diff` without arguments. In the git directory. */
export const LAST_EVENT_FILE = 'natsumi-last-event';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BRANCH = 'refs/heads/main';

export interface ActivitySettings { k: number; minMinutes: number; maxMinutes: number; windowMinutes: number; quietMeanMinutes: number }

/**
 * A wait drawn from the exponential distribution of a mean, cut at the longest: most come sooner than the mean, and
 * now and then one is long. `u` is a draw from [0, 1).
 */
export function drawWait(mean: number, longest: number, u: number): number {
  return Math.min(longest, Math.round(mean * -Math.log1p(-u)));
}

/** A source: its directory under `sources/`, the depth of the directories it is measured by, and what git leaves out. */
export interface SourceRegistration {
  name: string;
  /** 2 for `slack/<workspace>/<channel>`. */
  depth: number;
  /** gitignore patterns relative to the source's directory, such as an index written on every change. */
  exclude?: readonly string[];
}

/**
 * A place in a file that is for natsumi, as a source tells it. `kind` is the source's own word, which the core never
 * reads; `path` is a `jq -s` path into the file; `images` are paths under `/sources` to show her with it.
 */
export interface Attention { source: string; kind: string; file: string; path: string; images?: readonly string[] }

export interface SourcesOptions {
  db: DatabaseSync;
  /** `sources/` in the data directory: the work tree. */
  directory: string;
  /** The git directory, outside the work tree. */
  gitDirectory: string;
  timeZone: string;
  /** Read on every look, so a change made while running is in force from the next (ADR 0058). */
  awakeHours: Live<AwakeHours>;
  activity: ActivitySettings;
  historyDays: number;
  now: () => number;
  /** A draw from [0, 1), for the waits. Math.random unless given. */
  random?: () => number;
  /** Asks the loop for a `sources_updated` event. The loop keeps one waiting at most, so asking again is harmless. */
  raise?: () => void;
  log?: (line: string) => void;
}

interface AttentionRow { attention_id: number; source: string; kind: string; dir: string; file: string; path: string; images: string }

export class Sources {
  private readonly options: SourcesOptions;
  private readonly registrations = new Map<string, SourceRegistration>();
  private raiseEvent: (() => void) | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private prepared = false;
  /** Files differing from the last commit, with the size and time they were last seen with. */
  private readonly dirty = new Map<string, string>();
  /** When each directory was written, over the window. */
  private readonly writes = new Map<string, number[]>();
  /** Writes counted since each directory was last shown. */
  private readonly unshown = new Map<string, number>();
  /** Directories with something not shown yet. */
  private readonly pending = new Set<string>();
  /** Directories with a ref, and when each was last looked at. */
  private readonly checked = new Map<string, number>();
  /**
   * When each directory with something not shown is due: drawn at its first change after the last look, and dropped
   * when it is shown. Kept in memory as `checked` is: a change left unshown by an earlier process draws again.
   */
  private readonly deadlines = new Map<string, number>();
  /** The local date of the last cut, so a night cuts once. */
  private prunedOn: string | undefined;

  constructor(options: SourcesOptions) {
    this.options = options;
    this.raiseEvent = options.raise;
  }

  register(registration: SourceRegistration): void {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(registration.name)) throw new Error(`a source's name must be plain: ${registration.name}`);
    if (!Number.isInteger(registration.depth) || registration.depth < 1) throw new Error('a source is measured at a depth of 1 or more');
    this.registrations.set(registration.name, registration);
  }

  /** Where the events go, when the loop is made after the sources. */
  connect(raise: () => void): void { this.raiseEvent = raise; }

  /**
   * Makes the repository if there is none, and takes in silently whatever is there: a directory seen for the first
   * time gets its ref where it stands now. Then learns what was left unshown by a previous process.
   */
  prepare(): Promise<void> {
    return this.serialize(async () => {
      const { directory, gitDirectory } = this.options;
      await mkdir(directory, { recursive: true, mode: 0o750 });
      if (!await exists(join(gitDirectory, 'HEAD'))) {
        await mkdir(gitDirectory, { recursive: true, mode: 0o750 });
        // Readable by the workspace's group (ADR 0033), which reads it for sources-diff; written by the server alone.
        await this.git(['init', '-q', '--shared=0640', '--initial-branch=main']);
        await this.git(['config', 'gc.auto', '0']);
        await this.git(['config', 'core.logAllRefUpdates', 'false']);
      }
      // The work tree is given on every call, as each reader sees it. One written here would name this server's path,
      // which the workspace does not have: init writes it, and an earlier server left it in place.
      await this.git(['config', '--unset-all', 'core.worktree'], { allowFailure: true });
      await mkdir(join(gitDirectory, 'info'), { recursive: true, mode: 0o750 });
      await writeFile(join(gitDirectory, 'info', 'exclude'), this.excludes(), { mode: 0o640 });
      const refs = await this.refs('refs/seen/');
      const dates = new Map((await this.git(['for-each-ref', '--format=%(refname) %(committerdate:unix)', 'refs/seen/'])).stdout
        .split('\n').filter(Boolean).map(line => line.split(' ') as [string, string]));
      for (const [dir, ref] of refs) this.checked.set(dir, Number(dates.get(ref) ?? 0) * 1000 || this.options.now());
      const head = await this.head();
      // What changed after the last look of each directory, before this process began.
      if (head) {
        for (const [dir, ref] of refs) {
          const { code } = await this.git(['diff', '--quiet', ref, head, '--', literal(dir)], { allowFailure: true });
          if (code === 1) this.mark(dir);
        }
      }
      // What is there as this process begins was written before it: learnt, not counted as writes now.
      await this.scan(false);
      await this.takeInNew(true);
      this.prepared = true;
    });
  }

  /**
   * One look, from the scheduler's tick: what changed and how often, the history cut back once a night, and an
   * event asked for when an attention waits or, in the awake hours, a directory's time has come.
   */
  tick(): Promise<void> {
    return this.serialize(async () => {
      if (!this.prepared) return;
      await this.scan();
      await this.takeInNew(false);
      const now = this.options.now();
      const awake = isAwake(now, current(this.options.awakeHours), this.options.timeZone);
      const today = localDate(now, this.options.timeZone);
      if (!awake && this.prunedOn !== today) {
        this.prunedOn = today;
        try { await this.cut(); } catch { this.log('cutting the history back failed; it is kept as it was'); }
      }
      if (this.waiting().length > 0 || (awake && this.due(now).length > 0)) this.raiseEvent?.();
    });
  }

  /** A place a source says is for her. It waits in the database until an event takes it, and asks for one now. */
  attention(attention: Attention): void {
    const relative = attention.file.startsWith(`${SOURCES_PATH}/`) ? attention.file.slice(SOURCES_PATH.length + 1) : undefined;
    const dir = relative === undefined ? undefined : this.unitOf(posix.normalize(relative));
    if (!dir || attention.source !== dir.split('/')[0]) {
      this.log(`an attention from ${attention.source} was let go: its file is not in one of its directories`);
      return;
    }
    this.options.db.prepare(`INSERT INTO source_attention (source, kind, dir, file, path, images, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(attention.source, attention.kind, dir, attention.file, attention.path, JSON.stringify(attention.images ?? []), isoAt(this.options.now()));
    this.raiseEvent?.();
  }

  /** The mean wait of a directory now, from its writes in the window. */
  mean(dir: string): number {
    const { k, minMinutes, windowMinutes, quietMeanMinutes } = this.options.activity;
    const now = this.options.now();
    const count = (this.writes.get(dir) ?? []).filter(at => at > now - windowMinutes * MINUTE).length;
    if (count <= 1) return quietMeanMinutes * MINUTE;
    return Math.min(quietMeanMinutes * MINUTE, Math.max(minMinutes * MINUTE, k * windowMinutes * MINUTE / count));
  }

  /** When a directory with something not shown is due, if it has a wait drawn. */
  deadline(dir: string): number | undefined { return this.deadlines.get(dir); }

  /**
   * Makes the line of a `sources_updated` event as its turn begins: commits what is there, and shows the directories
   * whose time has come (with those close to theirs, in the awake hours) and those an attention is in, advancing their
   * refs. Returns false when there is nothing to show, and then nothing is recorded.
   */
  take(eventId: string): Promise<boolean> {
    return this.serialize(async () => {
      if (!this.prepared) return false;
      await this.scan();
      const head = await this.commit();
      await this.takeInNew(false, head);
      if (!head) return false;
      const now = this.options.now();
      const awake = isAwake(now, current(this.options.awakeHours), this.options.timeZone);
      const attentions = this.waiting();
      const chosen = new Set(attentions.map(row => row.dir));
      if (awake && this.due(now).length > 0) {
        const soon = now + this.options.activity.minMinutes * MINUTE;
        for (const dir of this.pending) if (this.checked.has(dir) && this.dueAt(dir) <= soon) chosen.add(dir);
      }
      const changed: Record<string, unknown>[] = [];
      const shown: string[] = [];
      for (const dir of [...chosen].sort()) {
        const seen = seenRef(dir);
        const files = this.checked.has(dir)
          ? (await this.git(['diff', '--name-only', '-z', seen, head, '--', literal(dir)])).stdout.split('\0').filter(Boolean) : [];
        const here = attentions.filter(row => row.dir === dir);
        this.pending.delete(dir);
        this.deadlines.delete(dir);
        if (files.length === 0 && here.length === 0) continue;
        if (files.length > 0) {
          await this.git(['update-ref', beforeRef(dir), seen]);
          await this.git(['update-ref', seen, head]);
          shown.push(dir);
        }
        this.checked.set(dir, now);
        const writes = this.unshown.get(dir) ?? 0;
        this.unshown.delete(dir);
        changed.push({
          dir: `${SOURCES_PATH}/${dir}`, files: files.map(file => `${SOURCES_PATH}/${file}`), writes,
          ...(files.length > 0 ? { diff: `sources-diff ${SOURCES_PATH}/${dir}` } : {}),
          ...(here.length > 0 ? { attention: here.map(row => ({ source: row.source, kind: row.kind, file: row.file, path: row.path })) } : {}),
        });
      }
      if (changed.length === 0) return false;
      if (shown.length > 0) await writeFile(join(this.options.gitDirectory, LAST_EVENT_FILE), `${shown.join('\n')}\n`, { mode: 0o640 });
      const images = attentions.flatMap(row => parseList(row.images)).slice(0, MAX_ATTENTION_IMAGES);
      const line = { local_time: localDateTime(now, this.options.timeZone), changed };
      const { db } = this.options;
      db.exec('BEGIN');
      try {
        db.prepare('INSERT INTO source_events (event_id, line, images) VALUES (?, ?, ?)').run(eventId, JSON.stringify(line), JSON.stringify(images));
        const taken = db.prepare('UPDATE source_attention SET event_id = ? WHERE attention_id = ?');
        for (const row of attentions) taken.run(eventId, row.attention_id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return true;
    });
  }

  /** The line of an event `take` made. */
  eventLine(eventId: string, receivedAt: string): Record<string, unknown> {
    const row = this.options.db.prepare('SELECT line FROM source_events WHERE event_id = ?').get(eventId) as { line: string } | undefined;
    return { type: 'sources_updated', received_at: receivedAt, ...(row ? JSON.parse(row.line) as Record<string, unknown> : {}) };
  }

  /** The images of an event's attentions, read now. One that is gone or not an image is left out. */
  async images(eventId: string): Promise<ImageContent[]> {
    const row = this.options.db.prepare('SELECT images FROM source_events WHERE event_id = ?').get(eventId) as { images: string } | undefined;
    const images: ImageContent[] = [];
    for (const path of row ? parseList(row.images) : []) {
      const relative = posix.normalize(path.slice(SOURCES_PATH.length + 1));
      if (!path.startsWith(`${SOURCES_PATH}/`) || relative.startsWith('..')) continue;
      try {
        const data = await readFile(join(this.options.directory, relative));
        const mimeType = imageType(data);
        if (mimeType) images.push({ type: 'image', mimeType, data: data.toString('base64') });
      } catch { /* a file cleared by hand is simply not shown */ }
    }
    return images;
  }

  /**
   * Cuts the history back to `historyDays`: the last commit before then becomes a commit with no parent, the later
   * ones are made again on it, and every ref moves with its commit — to the new start when it pointed before it.
   */
  prune(): Promise<void> { return this.serialize(() => this.cut()); }

  private async cut(): Promise<void> {
    const head = await this.head();
    if (!head) return;
    const cutoff = Math.floor((this.options.now() - this.options.historyDays * DAY) / 1000);
    const base = (await this.git(['rev-list', '-1', `--before=@${cutoff}`, head])).stdout.trim();
    if (!base || (await this.git(['rev-list', '--count', base])).stdout.trim() === '1') return;
    const later = (await this.git(['rev-list', '--reverse', `${base}..${head}`])).stdout.split('\n').filter(Boolean);
    const moved = new Map<string, string>();
    let parent: string | undefined;
    for (const commit of [base, ...later]) {
      const [authored, committed, ...message] = (await this.git(['show', '-s', '--format=%at%n%ct%n%B', commit])).stdout.split('\n');
      const made = (await this.git(['commit-tree', `${commit}^{tree}`, ...(parent ? ['-p', parent] : []), '-m', message.join('\n').trim() || 'sources'],
        { env: { GIT_AUTHOR_DATE: `@${authored} +0000`, GIT_COMMITTER_DATE: `@${committed} +0000` } })).stdout.trim();
      moved.set(commit, made);
      parent = made;
    }
    const start = moved.get(base)!;
    await this.git(['update-ref', BRANCH, parent!]);
    const refs = (await this.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/seen/', 'refs/before/'])).stdout.split('\n').filter(Boolean);
    for (const line of refs) {
      const [name, object] = line.split(' ') as [string, string];
      await this.git(['update-ref', name, moved.get(object) ?? start]);
    }
    await this.git(['reflog', 'expire', '--expire=now', '--all']);
    await this.git(['gc', '--prune=now', '--quiet']);
    this.log(`cut the history back to ${this.options.historyDays} day(s): ${later.length + 1} commit(s) kept`);
  }

  /** Compares the work tree with the last commit, and counts a write for every file that changed since last seen. */
  private async scan(count = true): Promise<void> {
    const roots = await this.roots();
    if (roots.length === 0) return;
    const now = this.options.now();
    const window = this.options.activity.windowMinutes * MINUTE;
    const out = (await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', ...roots])).stdout;
    const seen = new Set<string>();
    for (const entry of out.split('\0')) {
      if (entry.length < 4) continue;
      const path = entry.slice(3);
      const dir = this.unitOf(path);
      if (!dir) continue;
      seen.add(path);
      const signature = await fileSignature(join(this.options.directory, path));
      if (this.dirty.get(path) === signature) continue;
      this.dirty.set(path, signature);
      if (count) {
        this.writes.set(dir, [...(this.writes.get(dir) ?? []).filter(at => at > now - window), now]);
        this.unshown.set(dir, (this.unshown.get(dir) ?? 0) + 1);
      }
      // After the write is counted, so a wait drawn now knows it.
      this.mark(dir);
    }
    for (const path of this.dirty.keys()) if (!seen.has(path)) this.dirty.delete(path);
    for (const [dir, times] of this.writes) {
      const recent = times.filter(at => at > now - window);
      if (recent.length > 0) this.writes.set(dir, recent); else this.writes.delete(dir);
    }
  }

  /**
   * Gives a ref to every directory that has none, at the current commit, so its past is never shown as news. When one
   * waits that is not committed yet, a commit is made for it first.
   */
  private async takeInNew(all: boolean, known?: string): Promise<void> {
    const fresh = [...this.pending].filter(dir => !this.checked.has(dir));
    if (!all && fresh.length === 0) return;
    const head = known ?? await this.commit();
    if (!head) return;
    const dirs = all
      ? new Set((await this.git(['ls-tree', '-r', '-z', '--name-only', head])).stdout.split('\0').flatMap(path => this.unitOf(path) ?? []))
      : new Set(fresh);
    const now = this.options.now();
    for (const dir of dirs) {
      if (this.checked.has(dir)) continue;
      await this.git(['update-ref', seenRef(dir), head]);
      this.checked.set(dir, now);
      this.pending.delete(dir);
      this.deadlines.delete(dir);
      this.unshown.delete(dir);
    }
  }

  /**
   * Commits the work tree when it differs from the last commit, and marks every directory the commit changed as
   * waiting to be shown. Returns the commit the branch is at, if there is one.
   */
  private async commit(): Promise<string | undefined> {
    const head = await this.head();
    const roots = await this.roots();
    if (roots.length === 0) return head;
    await this.git(['add', '-A', '--', ...roots]);
    const tree = (await this.git(['write-tree'])).stdout.trim();
    if (head && (await this.git(['rev-parse', `${head}^{tree}`])).stdout.trim() === tree) return head;
    const made = (await this.git(['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `sources as of ${isoAt(this.options.now())}`]))
      .stdout.trim();
    await this.git(['update-ref', BRANCH, made]);
    if (head) {
      for (const path of (await this.git(['diff', '--name-only', '-z', head, made])).stdout.split('\0')) {
        const dir = path ? this.unitOf(path) : undefined;
        if (dir) this.mark(dir);
      }
    }
    return made;
  }

  private due(now: number): string[] {
    return [...this.pending].filter(dir => this.checked.has(dir) && this.dueAt(dir) <= now);
  }

  private dueAt(dir: string): number {
    return this.deadlines.get(dir) ?? this.options.now();
  }

  /**
   * Marks a directory as having something not shown. The first change after its last look draws its wait; a directory
   * with no ref yet is taken in silently instead, and draws none.
   */
  private mark(dir: string): void {
    this.pending.add(dir);
    if (!this.checked.has(dir) || this.deadlines.has(dir)) return;
    const { maxMinutes } = this.options.activity;
    const wait = drawWait(this.mean(dir), maxMinutes * MINUTE, (this.options.random ?? Math.random)());
    this.deadlines.set(dir, this.options.now() + wait);
  }

  private waiting(): AttentionRow[] {
    return this.options.db.prepare('SELECT * FROM source_attention WHERE event_id IS NULL ORDER BY attention_id').all() as unknown as AttentionRow[];
  }

  /** The directory a path (relative to `sources/`) is measured in, or undefined above the registered depth. */
  private unitOf(path: string): string | undefined {
    const parts = path.split('/');
    const registration = this.registrations.get(parts[0]!);
    if (!registration || parts.length <= registration.depth + 1 || parts.some(part => part === '' || part === '..')) return undefined;
    return parts.slice(0, registration.depth + 1).join('/');
  }

  private async roots(): Promise<string[]> {
    const roots: string[] = [];
    for (const name of [...this.registrations.keys()].sort()) if (await exists(join(this.options.directory, name))) roots.push(literal(name));
    return roots;
  }

  private excludes(): string {
    // A file being written is renamed into place; its temporary never belongs in the history.
    const lines = ['*.tmp'];
    for (const registration of this.registrations.values()) {
      for (const pattern of registration.exclude ?? []) lines.push(`/${registration.name}/${pattern.replace(/^\//, '')}`);
    }
    return `${lines.join('\n')}\n`;
  }

  /** The refs under a prefix, by the directory each names. */
  private async refs(prefix: string): Promise<Map<string, string>> {
    const names = (await this.git(['for-each-ref', '--format=%(refname)', prefix])).stdout.split('\n').filter(Boolean);
    return new Map(names.map(name => [Buffer.from(name.slice(prefix.length), 'hex').toString('utf8'), name]));
  }

  private async head(): Promise<string | undefined> {
    const { code, stdout } = await this.git(['rev-parse', '--verify', '-q', BRANCH], { allowFailure: true });
    return code === 0 ? stdout.trim() : undefined;
  }

  /** git on this repository and work tree. Every commit carries the server's clock, so the history follows it. */
  private git(args: string[], options: { allowFailure?: boolean; env?: Record<string, string> } = {}): Promise<GitResult> {
    const { directory, gitDirectory, now } = this.options;
    const date = `@${Math.floor(now() / 1000)} +0000`;
    return runGit(directory, [`--work-tree=${directory}`, '-c', `safe.directory=${gitDirectory}`, ...args],
      { ...options, gitDirectory, env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, ...options.env } });
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private log(line: string): void { this.options.log?.(`sources: ${line}`); }
}

/** A directory's ref names it in hex: a channel's name may hold what a ref name may not. */
function seenRef(dir: string): string { return `refs/seen/${Buffer.from(dir).toString('hex')}`; }
function beforeRef(dir: string): string { return `refs/before/${Buffer.from(dir).toString('hex')}`; }

/** A pathspec that means the path as written, whatever characters it holds. */
function literal(path: string): string { return `:(literal)${path}`; }

async function fileSignature(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.size}:${info.mtimeMs}`;
  } catch { return 'gone'; }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

function parseList(json: string): string[] {
  try {
    const list = JSON.parse(json) as unknown;
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}
