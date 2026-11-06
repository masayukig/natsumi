import { copyFile, lstat, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import { runGit, type GitIdentity } from './git.ts';
import { DEFAULT_GOAL_FILE_MAX_CHARS, DEFAULT_TODAY_PLAN_MAX_CHARS, GOALS_DIRECTORY, goalsProblem, inGoals, TODAY_FILE } from './goals.ts';
import { DEFAULT_SELF } from './prompts.ts';
import { findControlStrings, findForeignScript, hasControlCharacters } from './output-checks.ts';
import { makeSharedDirectory, SHARED_FILE_MODE } from './permissions.ts';
import { inPostbox, POSTBOX_DIRECTORY, type CommittedLetterFile } from './postbox.ts';
import { SKILL_MAX_CHARS, SKILLS_DIRECTORY, skillFileProblem } from './skills.ts';

/**
 * Memory as a git repository (ADR 0018): everything natsumi is made of — her memories, the always-memory, her
 * personality and the nightly handoff — is Markdown in one repository the owner can read, diff and put right.
 *
 * The model writes into the working tree through the memory shell (ADR 0011). The server owns the history: at the
 * end of every turn it checks what changed, puts back what fails a check, and commits the rest. It never pushes or
 * pulls; a remote, a backup and encryption are the owner's to arrange.
 */

/** The always-memory: what goes into every prompt. Written by natsumi at night. */
export const ALWAYS_FILE = 'always.md';
/** Personality and manner of speaking, put into the prompt when a session is made. */
export const PERSONALITY_FILE = 'personality.md';
/** The note the nightly review leaves for the next session. */
export const HANDOFF_FILE = 'handoff.md';
/** The way into memory, a list of its files. Only the curator writes it (ADR 0055). */
export const INDEX_FILE = 'INDEX.md';
/** The names the server fixes. Everything else in the repository is natsumi's, and the curator's, to arrange. */
export const FIXED_FILES = [ALWAYS_FILE, PERSONALITY_FILE, HANDOFF_FILE, INDEX_FILE] as const;
/** These ride in every prompt, so only the nightly review may change them: a day turn's change is put back. */
export const NIGHT_ONLY_FILES: readonly string[] = [ALWAYS_FILE, PERSONALITY_FILE];
/** natsumi's own: the curator may read them and never change them (ADR 0055). */
export const NATSUMI_ONLY_FILES: readonly string[] = [ALWAYS_FILE, PERSONALITY_FILE, HANDOFF_FILE];
/** The day by day story, kept as history: the curator reads it and never changes it (ADR 0055). */
export const DIARY_DIRECTORY = 'diary';
/**
 * Old memory (ADR 0068): facts the curator took out of the topics, summarized into a file a month. Only the curator's
 * archiving stage writes it, and only by adding to this month's file, save on a night that compacts older files.
 */
export const ARCHIVE_DIRECTORY = 'archive';

/**
 * What a night's archiving may do in `archive/` (ADR 0068): add to this month's file, and compact each group's files
 * into the one it names — removing every file it summarizes and writing the one it becomes, or touching none of them.
 */
export interface ArchivePlan {
  /** This month's file, which may be made or added to. */
  append: string;
  compactions: { into: string; from: string[] }[];
}

/** Who changed the working tree: a turn of the day, the nightly review, or the curator after it. */
export type Writer = 'day' | 'night' | 'curator';

/** The longest one memory file may be, in characters. */
export const DEFAULT_FILE_MAX_CHARS = 32000;
/**
 * The longest the always-memory may be. It rides in every prompt, so it is held far below one memory file (ADR 0018),
 * and the limit is put on the writing rather than on the reading: the state where it is too long is never made,
 * so whoever builds the prompt need not look at the length at all (ADR 0020).
 */
export const DEFAULT_ALWAYS_MAX_CHARS = 2000;

const ALWAYS_TEMPLATE = `# 常時記憶

毎回のプロンプトに入る短いメモです。マスターとの話し方、いま続いていること、よく使う事実など、
毎回思い出したいことだけを書きます。夜の再構成のときに見直し、長くなりすぎたら削ります。
`;

/** For an avatar without a `personality.md` of its own (ADR 0060), named by the avatar's name. */
const personalityTemplate = (name: string) => `# 性格・話し方

${name}の性格と話し方をここに書きます。夜の再構成のときだけ書き換えられます。
`;

const HANDOFF_TEMPLATE = `# 引き継ぎ

まだ引き継ぎはありません。
`;

const INDEX_TEMPLATE = `# 記憶の索引

記憶のファイルの一覧と、それぞれに何が書いてあるかを書く場所です。夜に記憶の整理係が書きます。
まだ索引はありません。
`;

/** The handoff as the file holds it: the fixed heading, then what was written. Nothing, when nothing was. */
const handoffText = (handoff: string | undefined) =>
  handoff?.trim() ? `# 引き継ぎ\n\n${handoff.trim()}\n` : undefined;

/** The longest a machine-made commit subject gets. */
const MAX_SUBJECT_CHARS = 120;
/** File names a machine-made commit subject lists before it says how many more there are. */
const SUBJECT_FILES = 5;
/** File names the line about what changed lists before it says how many more there are (ADR 0019). */
const SUMMARY_FILES = 5;

export interface MemoryRepositoryOptions {
  /** The repository: `loop.memoryRepository`, by default `memory/` in the data directory. */
  directory: string;
  /** Where an older layout left `personality.md`; the first start moves it into the repository. */
  dataDirectory: string;
  /** `loop.memoryFileMaxChars`. */
  fileMaxChars?: number;
  /** `loop.alwaysMemoryMaxChars`, for `always.md` alone. */
  alwaysMaxChars?: number;
  /** `loop.goalFileMaxChars`, for each lasting goal's file in `goals/` (ADR 0090). */
  goalFileMaxChars?: number;
  /** `loop.todayPlanMaxChars`, for `goals/today.md` alone (ADR 0090). */
  todayPlanMaxChars?: number;
  /** Who commits: the avatar (ADR 0057). The server's fixed identity when left out. */
  identity?: GitIdentity;
  /**
   * The avatar's `personality.md` (ADR 0060): written when the repository has no personality and no older layout left
   * one, and never over one that is there. The template, named by the identity, when left out.
   */
  personality?: string;
  /**
   * Why a file of hers in `postbox/` is not a letter the server can send, or undefined when it is (ADR 0076). Without
   * it the postbox's files are checked as any other file of memory.
   */
  checkLetter?: (path: string, text: string) => string | undefined;
  log?: (line: string) => void;
}

/** A file the check caught, put back to the previous commit (or removed when it was new). */
export interface RevertedFile { path: string; reason: string }

export interface CommitOutcome {
  committed: boolean;
  /** The paths the commit carries, empty when nothing was committed. */
  files: string[];
  reverted: RevertedFile[];
}

/** A curator stage's commit (ADR 0055, ADR 0068): all or nothing, so what failed is named and nothing of the stage is kept. */
export interface CurationOutcome {
  committed: boolean;
  /** The paths the commit carries, empty when nothing was committed. */
  files: string[];
  /** Every change that failed a check. Any at all, and the whole stage was thrown away. */
  rejected: RevertedFile[];
}

/** What a curator stage's changes are checked against besides every curator commit's checks. */
export interface CurationChecks {
  /** Why this stage may not change a path, or undefined when it may. */
  refuse?: (path: string) => string | undefined;
  /** What tonight's archiving may do in `archive/`; without it, a stage may not change `archive/` at all. */
  archive?: ArchivePlan;
}

/** A file of memory, as the curator is shown it: its size and its sections. */
export interface MemoryFile { path: string; chars: number; sections: MemorySection[] }

/**
 * A heading (`#` to `###`) and the lines under it before the next heading, blank ones not counted (ADR 0068). Lines
 * before the first heading are a section with an empty heading, so a file with no headings is one flat section.
 */
export interface MemorySection { heading: string; lines: number }

/** git's empty tree: what a repository had before its first commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

type Change = 'added' | 'modified' | 'deleted';

interface StatusEntry { path: string; deleted: boolean; change: Change }

const CHANGE_WORDS: Record<Change, string> = { added: '追加', modified: '変更', deleted: '削除' };

export class MemoryRepository {
  readonly directory: string;
  private readonly options: MemoryRepositoryOptions;

  constructor(options: MemoryRepositoryOptions) {
    this.options = options;
    this.directory = options.directory;
  }

  /** git in the repository, as the avatar. */
  private git(args: string[], options: { allowFailure?: boolean; env?: Record<string, string> } = {}) {
    return runGit(this.directory, args, { ...options, ...(this.options.identity ? { identity: this.options.identity } : {}) });
  }

  private get fileMaxChars(): number { return this.options.fileMaxChars ?? DEFAULT_FILE_MAX_CHARS; }

  private get alwaysMaxChars(): number { return this.options.alwaysMaxChars ?? DEFAULT_ALWAYS_MAX_CHARS; }

  private get goalLimits() {
    return { goalFileMaxChars: this.options.goalFileMaxChars ?? DEFAULT_GOAL_FILE_MAX_CHARS,
      todayPlanMaxChars: this.options.todayPlanMaxChars ?? DEFAULT_TODAY_PLAN_MAX_CHARS };
  }

  /**
   * Makes the repository if it is not one yet, on `main`, taking whatever Markdown is already there into the first
   * commit under its own name and contents. An existing repository keeps its history: only the three fixed files
   * that are missing are written, and only those are committed.
   *
   * `handoff` is what SQLite carried over when the text moved into this repository (ADR 0020). It is written when
   * `handoff.md` is missing, and also when the file is still the template nobody has written over: a repository made
   * before that change already has the template, so the carried-over handoff would otherwise have nowhere to land
   * and the first session after the upgrade would begin from nothing. A handoff somebody has written is left alone.
   */
  async initialize(handoff?: string): Promise<void> {
    await makeSharedDirectory(this.directory, { recursive: true });
    const fresh = !(await this.isRepository());
    if (fresh) await this.git(['init', '-b', 'main']);
    const placed = await this.placeFixedFiles(handoff);
    if (fresh) await this.git(['add', '-A', '--', '.']);
    else if (placed.length > 0) await this.git(['add', '--', ...placed]);
    else return;
    const staged = (await this.git(['diff', '--cached', '--name-only', '-z'])).stdout.split('\0').filter(Boolean);
    if (staged.length === 0) return;
    await this.commitStaged('start', staged);
    this.log(`memory: ${fresh ? 'made the repository' : 'wrote the missing files'} (${staged.length} file(s))`);
  }

  /**
   * The end of a turn: what changed is checked file by file, what fails goes back to the previous commit (a new file
   * is removed), and what is left becomes one commit. A turn that changed nothing commits nothing.
   * Removing and renaming is natsumi's to do, save for the three fixed files, which come back.
   *
   * `message` is what natsumi wrote about the night (ADR 0020). Without one the server makes the message itself, so
   * a night that never explained itself still commits.
   */
  async commit(input: { event: string; night?: boolean; message?: string }): Promise<CommitOutcome> {
    const writer: Writer = input.night === true ? 'night' : 'day';
    const reverted: RevertedFile[] = [];
    for (const entry of await this.status()) {
      const reason = entry.deleted ? this.inspectRemoval(entry.path, writer) : await this.inspect(entry.path, writer);
      if (!reason) continue;
      await this.restore(entry.path);
      reverted.push({ path: entry.path, reason });
    }
    const files = (await this.status()).map(entry => entry.path);
    if (files.length === 0) return { committed: false, files: [], reverted };
    await this.git(['add', '-A', '--', '.']);
    await this.commitStaged(input.event, files, input.message);
    if (reverted.length > 0) this.log(`memory: ${reverted.length} changed file(s) went back to the previous commit`);
    return { committed: true, files, reverted };
  }

  /**
   * A stage of the curator's night as one commit, under the note it wrote, or under a line the server makes from
   * `event` when it wrote none (ADR 0055, ADR 0068). Every change is checked as natsumi's are, the curator is further
   * kept off her three files and off the diary, and `refuse` names what this stage may not change. Unlike a turn's
   * commit, one change that fails throws the whole stage away: the curator moves and merges files, and a merge whose
   * result alone went back would leave its sources gone and nothing in their place.
   */
  async commitCuration(input: CurationChecks & { message?: string; event?: string }): Promise<CurationOutcome> {
    const entries = await this.status();
    const rejected = await this.inspectCuration(entries, input);
    if (rejected.length > 0) {
      await this.discardChanges();
      this.log(`memory: the curator's changes were thrown away (${rejected.length} failed the check)`);
      return { committed: false, files: [], rejected };
    }
    const files = entries.map(entry => entry.path);
    if (files.length === 0) return { committed: false, files: [], rejected };
    await this.git(['add', '-A', '--', '.']);
    await this.commitStaged(input.event ?? 'memory_curator', files, input.message);
    return { committed: true, files, rejected };
  }

  /**
   * What of a curator stage's changes would fail its commit, changing nothing: what the stage is told when it is given
   * the one chance to put it right before its changes are thrown away (ADR 0068).
   */
  async checkCuration(input: CurationChecks): Promise<RevertedFile[]> {
    return this.inspectCuration(await this.status(), input);
  }

  private async inspectCuration(entries: StatusEntry[], input: CurationChecks): Promise<RevertedFile[]> {
    const rejected: RevertedFile[] = [];
    for (const entry of entries) {
      const reason = (inArchive(entry.path) ? await this.inspectArchive(entry, entries, input.archive) : undefined)
        ?? (entry.deleted ? this.inspectRemoval(entry.path, 'curator') : await this.inspect(entry.path, 'curator'))
        ?? input.refuse?.(entry.path);
      if (reason) rejected.push({ path: entry.path, reason });
    }
    return rejected;
  }

  /**
   * Why the curator may not make a change in `archive/`, or undefined when it may (ADR 0068): only a stage with the
   * night's plan writes there, it adds to this month's file without changing a line already in it, and it removes or
   * rewrites an older file only to compact a whole group as the plan names it.
   */
  private async inspectArchive(entry: StatusEntry, entries: readonly StatusEntry[], plan: ArchivePlan | undefined): Promise<string | undefined> {
    const { path } = entry;
    if (!plan) return `${path} は古い記憶（${ARCHIVE_DIRECTORY}/）なので、古い記憶の工程でだけ変えられます`;
    const group = plan.compactions.find(candidate => candidate.into === path || (entry.deleted && candidate.from.includes(path)));
    if (group) {
      const removed = new Set(entries.filter(other => other.deleted).map(other => other.path));
      const made = !removed.has(group.into) && await this.exists(group.into);
      if (made && group.from.every(source => removed.has(source))) return undefined;
      return `まとめる夜は、まとめる元のファイル（${group.from.join('、')}）をすべて消して、まとめた先の ${group.into} を作ります`;
    }
    if (path === plan.append && !entry.deleted) {
      const before = await this.committedText(path);
      if (before === undefined || (await this.readOrEmpty(path)).startsWith(before)) return undefined;
      return `${path} の既にある行が変わっています。今月の古い記憶のファイルには、末尾に追記だけができます`;
    }
    if (entry.deleted) return `${path} は古い記憶なので消せません（まとめる夜に、まとめる元のファイルだけを消せます）`;
    return `${path} は変えられません。古い記憶は今月のファイル（${plan.append}）に追記するだけで、ほかのファイルは変えられません`;
  }

  /** What the last commit holds at a path, or undefined when it holds nothing there. */
  private async committedText(path: string): Promise<string | undefined> {
    const shown = await this.git(['show', `HEAD:${path}`], { allowFailure: true });
    return shown.code === 0 ? shown.stdout : undefined;
  }

  /**
   * The server's own commit of what it rewrote in the working tree: the paths a curator stage moved, put right after
   * it (ADR 0068). No writer's rules apply — the server may change natsumi's files, the index, the diary and the
   * archive — but every file still passes the checks on its contents, and one that fails goes back to the last commit.
   * The subject is made from `event` and the files, and `body` follows it.
   */
  async commitRewrite(event: string, body: string): Promise<CommitOutcome> {
    const reverted: RevertedFile[] = [];
    for (const entry of await this.status()) {
      const reason = entry.deleted ? 'サーバーの置き換えはファイルを消しません' : await this.inspectContent(entry.path);
      if (!reason) continue;
      await this.restore(entry.path);
      reverted.push({ path: entry.path, reason });
    }
    for (const file of reverted) this.log(`memory: ${file.path} was left as it was: ${file.reason}`);
    const files = (await this.status()).map(entry => entry.path);
    if (files.length === 0) return { committed: false, files: [], reverted };
    await this.git(['add', '-A', '--', '.']);
    await this.commitStaged(event, files, `${subject(event, files)}\n\n${body}`);
    return { committed: true, files, reverted };
  }

  /** Every file a commit holds, in path order. */
  async filesAt(commit: string): Promise<string[]> {
    const { stdout } = await this.git(['ls-tree', '-r', '-z', '--name-only', commit]);
    return stdout.split('\0').filter(Boolean).sort();
  }

  /** The files git sees renamed between `base` and the last commit (ADR 0068), each from its old path to its new one. */
  async renamesSince(base: string): Promise<{ from: string; to: string }[]> {
    const { stdout } = await this.git(['diff', '-M', '--name-status', '-z', '--diff-filter=R', base, 'HEAD']);
    const fields = stdout.split('\0');
    const renames: { from: string; to: string }[] = [];
    for (let i = 0; i + 2 < fields.length; i += 3) {
      if (!fields[i]!.startsWith('R')) break;
      renames.push({ from: fields[i + 1]!, to: fields[i + 2]! });
    }
    return renames;
  }

  /** Throws away whatever the last commit does not hold: changes, removals, and new files and folders alike. */
  async discardChanges(): Promise<void> {
    await this.git(['reset', '--hard', '--quiet', 'HEAD']);
    await this.git(['clean', '-f', '-d', '--quiet']);
  }

  /** Whether the working tree is what the last commit holds. */
  async isClean(): Promise<boolean> {
    return (await this.status()).length === 0;
  }

  /**
   * Every file memory holds, in path order, with its length in characters and its sections: the map of memory the
   * curator starts from (ADR 0055, ADR 0068). Read straight from the working tree; `.git` is not memory.
   */
  async listFiles(): Promise<MemoryFile[]> {
    const { stdout } = await this.git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    const paths = [...new Set(stdout.split('\0').filter(Boolean))].sort();
    const files: MemoryFile[] = [];
    for (const path of paths) {
      let text: string;
      try { text = await readFile(join(this.directory, path), 'utf8'); } catch { continue; }
      files.push({ path, chars: [...text].length, sections: sectionsOf(text) });
    }
    return files;
  }

  /**
   * When the last commit that changed each of `paths` was made, as git's ISO time (ADR 0068). A path the history does
   * not hold has no date.
   */
  async lastChanged(paths: readonly string[]): Promise<Map<string, string>> {
    const dates = new Map<string, string>();
    for (const path of paths) {
      const date = (await this.git(['log', '-1', '--format=%cI', '--', path])).stdout.trim();
      if (date) dates.set(path, date);
    }
    return dates;
  }

  /** When `commit` was made, or undefined when there is none or the history does not hold it. */
  async commitTime(commit: string | undefined): Promise<number | undefined> {
    if (!commit) return undefined;
    const { code, stdout } = await this.git(['log', '-1', '--format=%cI', `${commit}^{commit}`, '--'], { allowFailure: true });
    const at = Date.parse(stdout.trim());
    return code === 0 && Number.isFinite(at) ? at : undefined;
  }

  /**
   * The files still in memory that changed between `base` and the last commit, in path order. A base the history
   * does not hold (none yet, or one the owner rewrote away) stands for the last day: the last commit made more than
   * a day ago, or the empty tree when there is none.
   */
  async changedSince(base: string | undefined): Promise<string[]> {
    let from = base;
    if (!from || (await this.git(['cat-file', '-e', `${from}^{commit}`], { allowFailure: true })).code !== 0) {
      const older = (await this.git(['rev-list', '-1', '--before=24 hours ago', 'HEAD'])).stdout.trim();
      from = older || EMPTY_TREE;
    }
    const { stdout } = await this.git(['diff', '--name-only', '-z', '--no-renames', '--diff-filter=AM', from, 'HEAD']);
    return stdout.split('\0').filter(Boolean).sort();
  }

  /**
   * What memory holds that the last commit does not, as one line, or an empty string when nothing differs. It rides
   * on the result of every shell command: the working places are never inspected, so without this natsumi could
   * write a memory into `/work` and have nothing tell her it was not kept (ADR 0019).
   */
  async changeSummary(): Promise<string> {
    let entries: StatusEntry[];
    try { entries = await this.status(); } catch { return ''; }
    if (entries.length === 0) return '';
    const shown = entries.slice(0, SUMMARY_FILES).map(entry => `${entry.path}（${CHANGE_WORDS[entry.change]}）`);
    const more = entries.length > SUMMARY_FILES ? [`ほか ${entries.length - SUMMARY_FILES} 件`] : [];
    return [...shown, ...more].join('、').replace(/\s+/g, ' ');
  }

  /**
   * The handoff the nightly review wrote, put into the working tree under its fixed name (ADR 0020). It is written
   * here and nowhere else; the turn's own commit takes it in like any other change, and the new session reads it
   * back out of the working tree. Unlike `always.md` and `personality.md` it may be written on any day.
   */
  async writeHandoff(text: string): Promise<void> {
    await writeFile(join(this.directory, HANDOFF_FILE), handoffText(text) ?? HANDOFF_TEMPLATE, { mode: SHARED_FILE_MODE });
  }

  /** The last commit, or undefined when there is none or it cannot be read: what the postbox looks at (ADR 0076). */
  async headCommit(): Promise<string | undefined> {
    const { code, stdout } = await this.git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true });
    return code === 0 ? stdout.trim() : undefined;
  }

  /**
   * Every file the last commit holds in `postbox/`, as it was committed, never as the working tree has it (ADR 0076):
   * the server sends only what passed a turn's check or what the owner committed. A symlink, or anything else that is
   * not a file, is named with why it is no letter.
   */
  async committedPostbox(): Promise<CommittedLetterFile[]> {
    const listed = await this.git(['ls-tree', '-r', '-z', 'HEAD', '--', POSTBOX_DIRECTORY], { allowFailure: true });
    if (listed.code !== 0) return [];
    const files: CommittedLetterFile[] = [];
    for (const entry of listed.stdout.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      const [mode, type, object] = entry.slice(0, tab).split(' ');
      const path = entry.slice(tab + 1);
      if (mode === '120000') { files.push({ path, problem: 'symlink は記憶に置けません' }); continue; }
      if (type !== 'blob') { files.push({ path, problem: '通常のファイルではありません' }); continue; }
      const blob = await this.git(['cat-file', 'blob', object!], { allowFailure: true });
      // git's text is read as UTF-8, and what was not is replaced: a letter is text, or it is no letter.
      const text = blob.code === 0 && !/[\0\uFFFD]/.test(blob.stdout) ? blob.stdout : undefined;
      files.push(text === undefined ? { path, problem: 'テキストのファイル（UTF-8）として読めません' } : { path, text });
    }
    return files;
  }

  /**
   * Today's plan as the last commit holds it (ADR 0090), never as the working tree has it: what passed a turn's check
   * or what the owner committed. Undefined when there is none, when it is no regular file, or when it is blank.
   */
  async committedTodayPlan(): Promise<string | undefined> {
    const listed = await this.git(['ls-tree', '-z', 'HEAD', '--', TODAY_FILE], { allowFailure: true });
    const entry = listed.code === 0 ? listed.stdout.split('\0').find(Boolean) : undefined;
    if (!entry) return undefined;
    const [mode, type, object] = entry.slice(0, entry.indexOf('\t')).split(' ');
    if (type !== 'blob' || mode === '120000') return undefined;
    const blob = await this.git(['cat-file', 'blob', object!], { allowFailure: true });
    if (blob.code !== 0 || /[\0\uFFFD]/.test(blob.stdout) || blob.stdout.trim() === '') return undefined;
    return blob.stdout;
  }

  /** The commit the working tree was last brought level with: what a switch records as the handoff it started from. */
  async head(): Promise<string> {
    return (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
  }

  /** True when the directory is a repository of its own, rather than a directory inside somebody else's. */
  private async isRepository(): Promise<boolean> {
    try { await lstat(join(this.directory, '.git')); return true; } catch { return false; }
  }

  /** Writes the fixed files that are missing and returns their paths. */
  private async placeFixedFiles(handoff: string | undefined): Promise<string[]> {
    const placed: string[] = [];
    if (!(await this.exists(PERSONALITY_FILE))) {
      const previous = join(this.options.dataDirectory, PERSONALITY_FILE);
      const moved = await this.move(previous, join(this.directory, PERSONALITY_FILE));
      if (!moved) {
        const text = this.options.personality ?? personalityTemplate(this.options.identity?.name ?? DEFAULT_SELF.name);
        await writeFile(join(this.directory, PERSONALITY_FILE), text, { mode: SHARED_FILE_MODE });
      }
      placed.push(PERSONALITY_FILE);
    }
    if (!(await this.exists(ALWAYS_FILE))) {
      await writeFile(join(this.directory, ALWAYS_FILE), ALWAYS_TEMPLATE, { mode: SHARED_FILE_MODE });
      placed.push(ALWAYS_FILE);
    }
    if (!(await this.exists(INDEX_FILE))) {
      await writeFile(join(this.directory, INDEX_FILE), INDEX_TEMPLATE, { mode: SHARED_FILE_MODE });
      placed.push(INDEX_FILE);
    }
    if (!(await this.exists(HANDOFF_FILE))) {
      await writeFile(join(this.directory, HANDOFF_FILE), handoffText(handoff) ?? HANDOFF_TEMPLATE, { mode: SHARED_FILE_MODE });
      placed.push(HANDOFF_FILE);
    } else {
      const text = handoffText(handoff);
      if (text && (await this.readOrEmpty(HANDOFF_FILE)) === HANDOFF_TEMPLATE) {
        await writeFile(join(this.directory, HANDOFF_FILE), text, { mode: SHARED_FILE_MODE });
        placed.push(HANDOFF_FILE);
      }
    }
    return placed;
  }

  /** Moves a file, falling back to a copy when the two are on different filesystems. False when there was none. */
  private async move(from: string, to: string): Promise<boolean> {
    try {
      const info = await lstat(from);
      if (!info.isFile()) return false;
    } catch { return false; }
    try { await rename(from, to); } catch {
      await copyFile(from, to);
      await rm(from, { force: true });
    }
    return true;
  }

  private async exists(name: string): Promise<boolean> {
    try { await lstat(join(this.directory, name)); return true; } catch { return false; }
  }

  private async readOrEmpty(name: string): Promise<string> {
    try { return await readFile(join(this.directory, name), 'utf8'); } catch { return ''; }
  }

  private async commitStaged(event: string, files: string[], message?: string): Promise<void> {
    await this.git(['commit', '--no-verify', '--quiet', '-m', message?.trim() || subject(event, files)]);
  }

  /** What differs from the last commit, one entry per path. Renames come back as a removal and an addition. */
  private async status(): Promise<StatusEntry[]> {
    const { stdout } = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
    return stdout.split('\0').filter(entry => entry.length > 3).map(entry => {
      const code = entry.slice(0, 2);
      const deleted = code[0] === 'D' || code[1] === 'D';
      return {
        path: entry.slice(3),
        deleted,
        change: deleted ? 'deleted' : code === '??' || code[0] === 'A' ? 'added' : 'modified',
      } as StatusEntry;
    });
  }

  /**
   * Why a removal may not be committed, or undefined when it may. Only the three names the server fixes are kept:
   * everything else in the repository is natsumi's, and what she deletes the history still holds. The three are
   * the server's own footing — the prompt reads them every turn — so losing one would quietly break what the server
   * assumes, with nobody told. A rename reaches here as the removal half, and is put back the same way.
   */
  private inspectRemoval(path: string, writer: Writer): string | undefined {
    if (writer === 'curator' && inSkills(path)) return skillsRefusal(path);
    if (writer === 'curator' && inPostbox(path)) return postboxRefusal(path);
    if (writer === 'curator' && inGoals(path)) return goalsRefusal(path);
    if (writer !== 'curator' && inArchive(path)) return archiveRefusal(path);
    if (writer === 'curator' && inDiary(path)) return `${path} は日記なので、整理係は消すことも動かすこともできません`;
    if (!FIXED_FILES.includes(path as typeof FIXED_FILES[number])) return undefined;
    return `${path} はサーバーが名前と置き場所を固定しているファイルなので、消すことも改名することもできません`;
  }

  /** Why the changed file may not be committed, or undefined when it may. A removal goes through inspectRemoval. */
  private async inspect(path: string, writer: Writer): Promise<string | undefined> {
    if (writer === 'curator' && inSkills(path)) return skillsRefusal(path);
    if (writer === 'curator' && inPostbox(path)) return postboxRefusal(path);
    if (writer === 'curator' && inGoals(path)) return goalsRefusal(path);
    if (writer !== 'curator' && inArchive(path)) return archiveRefusal(path);
    if (writer !== 'curator' && path === INDEX_FILE) {
      return `${path} は記憶の整理係だけが書くファイルなので、あなたは書き換えられません（夜に整理係が書き直します）`;
    }
    if (writer === 'day' && NIGHT_ONLY_FILES.includes(path)) {
      return `${path} は毎回のプロンプトに入るので、夜の再構成のターンでだけ書き換えられます`;
    }
    if (writer === 'curator' && NATSUMI_ONLY_FILES.includes(path)) return `${path} は${this.options.identity?.name ?? DEFAULT_SELF.name}自身のファイルなので、整理係は変えられません`;
    if (writer === 'curator' && inDiary(path)) return `${path} は日記なので、整理係は変えられません`;
    const content = await this.inspectContent(path);
    if (content || !inPostbox(path) || !this.options.checkLetter) return content;
    // A letter goes back as any file does when it would not be sent: the server sends only what is committed (ADR 0076).
    let text: string;
    try { text = await readFile(join(this.directory, path), 'utf8'); } catch { return '読めないファイルです'; }
    return this.options.checkLetter(path, text);
  }

  /** Why a changed file's contents may not be committed, whoever wrote it, or undefined when they may. */
  private async inspectContent(path: string): Promise<string | undefined> {
    let info;
    try { info = await lstat(join(this.directory, path)); } catch { return undefined; }
    if (info.isSymbolicLink()) return 'symlink は記憶に置けません';
    if (!info.isFile()) return '通常のファイルではありません';
    // A skill of hers may carry scripts and data as well, inside its own directory and as text (ADR 0073).
    const skill = skillDirectoryOf(path);
    const markdown = path.endsWith('.md');
    if (!markdown && !inSkills(path)) return '.md 以外のファイルは記憶に置けません';
    if (!markdown && !(skill && await this.isFile(posixJoin(skill, 'SKILL.md')))) {
      return `.md 以外のファイルは、skill のディレクトリ（SKILL.md のある ${SKILLS_DIRECTORY}/<名前>/）の中にだけ置けます`;
    }
    let text: string;
    if (markdown) {
      try { text = await readFile(join(this.directory, path), 'utf8'); } catch { return '読めないファイルです'; }
    } else {
      let bytes: Buffer;
      try { bytes = await readFile(join(this.directory, path)); } catch { return '読めないファイルです'; }
      const decoded = textOf(bytes);
      if (decoded === undefined) return 'テキストのファイル（UTF-8）ではありません。バイナリは置けません';
      text = decoded;
    }
    if (text.trim() === '') return '中身が空です';
    if (path === ALWAYS_FILE && [...text].length > this.alwaysMaxChars) {
      return `毎回のプロンプトに入る常時記憶の上限（${this.alwaysMaxChars} 文字）を超えています`;
    }
    if ([...text].length > this.fileMaxChars) return `1 ファイルの上限（${this.fileMaxChars} 文字）を超えています`;
    const goals = goalsProblem(path, [...text].length, this.goalLimits);
    if (goals) return goals;
    const control = findControlStrings(text);
    if (control.length > 0) return `テンプレートの制御文字列（${control.join(' ')}）が含まれています`;
    if (hasControlCharacters(text)) return '制御文字が含まれています';
    const foreign = findForeignScript(text);
    if (foreign.length > 0) return `日本語以外の文字（${foreign.join(' ')}）が含まれています`;
    // A skill Pi would not load is one she would never see listed, and never hear why (ADR 0073).
    if (inSkills(path) && basename(path) === 'SKILL.md') {
      const problem = skillFileProblem(join(this.directory, path));
      if (problem) return problem;
    }
    // SKILL.md itself is spared, so that the skill's own page never goes back for the files beside it.
    if (skill && basename(path) !== 'SKILL.md' && await this.charsUnder(skill) > SKILL_MAX_CHARS) {
      return `skill 全体（${skill}/ の下のファイルの合計）の上限（${SKILL_MAX_CHARS} 文字）を超えています`;
    }
    return undefined;
  }

  private async isFile(path: string): Promise<boolean> {
    try { return (await lstat(join(this.directory, path))).isFile(); } catch { return false; }
  }

  /** The characters of every regular file under a directory of the working tree, as text. */
  private async charsUnder(directory: string): Promise<number> {
    let total = 0;
    let entries;
    try { entries = await readdir(join(this.directory, directory), { withFileTypes: true }); } catch { return 0; }
    for (const entry of entries) {
      const path = posixJoin(directory, entry.name);
      if (entry.isDirectory()) total += await this.charsUnder(path);
      else if (entry.isFile()) {
        try { total += [...(await readFile(join(this.directory, path), 'utf8'))].length; } catch { /* unreadable counts as nothing */ }
      }
    }
    return total;
  }

  /** Back to the last commit, or removed when the last commit did not have it. */
  private async restore(path: string): Promise<void> {
    const known = await this.git(['cat-file', '-e', `HEAD:${path}`], { allowFailure: true });
    if (known.code === 0) {
      await this.git(['checkout', 'HEAD', '--', path]);
      return;
    }
    await rm(join(this.directory, path), { force: true, recursive: true });
  }

  private log(line: string) { this.options.log?.(line); }
}

/** A file's sections: every `#` to `###` heading, with the lines under it until the next one. Deeper headings are lines. */
function sectionsOf(text: string): MemorySection[] {
  const sections: MemorySection[] = [];
  let current: MemorySection = { heading: '', lines: 0 };
  for (const line of text.split('\n')) {
    if (/^#{1,3} /.test(line)) {
      if (current.heading !== '' || current.lines > 0) sections.push(current);
      current = { heading: line.trim(), lines: 0 };
    } else if (line.trim() !== '') current.lines += 1;
  }
  if (current.heading !== '' || current.lines > 0) sections.push(current);
  return sections;
}

/** Whether a path is in the archive, or is the archive itself. */
function inArchive(path: string): boolean {
  return path === ARCHIVE_DIRECTORY || path.startsWith(`${ARCHIVE_DIRECTORY}/`);
}

/** Why natsumi's change to the archive goes back. */
const archiveRefusal = (path: string) =>
  `${path} は古い記憶（${ARCHIVE_DIRECTORY}/）なので、記憶の整理係だけが書きます。あなたは書き換えられません`;

/** Whether a path is in her skills, or is their directory itself (ADR 0073). */
export function inSkills(path: string): boolean {
  return path === SKILLS_DIRECTORY || path.startsWith(`${SKILLS_DIRECTORY}/`);
}

/** The skill directory a path is inside, `skills/<name>`, or undefined for one directly in `skills/` or outside it. */
function skillDirectoryOf(path: string): string | undefined {
  const parts = path.split('/');
  return parts[0] === SKILLS_DIRECTORY && parts.length >= 3 ? `${parts[0]}/${parts[1]}` : undefined;
}

/** A file's bytes as UTF-8 text, or undefined for what is not: a NUL byte, or bytes UTF-8 cannot read. */
function textOf(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return undefined; }
}

/** Why the curator's change to a skill is refused. */
const posixJoin = posix.join;

const skillsRefusal = (path: string) => `${path} は ${SKILLS_DIRECTORY}/ の中の skill なので、整理係は変えることも動かすこともできません`;

/** Why the curator's change to a letter is refused (ADR 0076). */
const postboxRefusal = (path: string) => `${path} は ${POSTBOX_DIRECTORY}/ の中の定期便なので、整理係は変えることも動かすこともできません`;

/**
 * Why the curator's change to goals/ is refused (ADR 0090): a goal's file name is its ID, and parts of it are written
 * only once the owner has agreed.
 */
const goalsRefusal = (path: string) => `${path} は ${GOALS_DIRECTORY}/ の中の目標と今日の計画なので、整理係は変えることも動かすこともできません`;

/** Whether a path is in the diary, or is the diary itself. */
function inDiary(path: string): boolean {
  return path === DIARY_DIRECTORY || path.startsWith(`${DIARY_DIRECTORY}/`);
}

/** The sentence the next turn reads about what went back, or an empty string when nothing did. */
export function revertNotice(reverted: readonly RevertedFile[]): string {
  if (reverted.length === 0) return '';
  return ['記憶の検査に当たったので、次のファイルを直前のコミットの状態に戻しました（新しく作ったファイルは消えています）。',
    ...reverted.map(file => `- ${file.path}: ${file.reason}`),
    '理由を直してから書き直してください。'].join('\n');
}

/** The commit message the server makes during the day: the kind of event, and what changed. */
export function subject(event: string, files: readonly string[]): string {
  const shown = files.slice(0, SUBJECT_FILES).join(', ');
  const more = files.length > SUBJECT_FILES ? `, ほか ${files.length - SUBJECT_FILES} 件` : '';
  const line = `${event}: ${shown}${more}`.replace(/\s+/g, ' ');
  return [...line].length > MAX_SUBJECT_CHARS ? `${[...line].slice(0, MAX_SUBJECT_CHARS - 1).join('')}…` : line;
}
