import { copyFile, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runGit, type GitIdentity } from './git.ts';
import { DEFAULT_SELF } from './prompts.ts';
import { findControlStrings, findForeignScript, hasControlCharacters } from './output-checks.ts';
import { makeSharedDirectory, SHARED_FILE_MODE } from './permissions.ts';

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
  /** Who commits: the avatar (ADR 0057). The server's fixed identity when left out. */
  identity?: GitIdentity;
  /**
   * The avatar's `personality.md` (ADR 0060): written when the repository has no personality and no older layout left
   * one, and never over one that is there. The template, named by the identity, when left out.
   */
  personality?: string;
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
  async commitCuration(input: { message?: string; event?: string; refuse?: (path: string) => string | undefined }): Promise<CurationOutcome> {
    const rejected: RevertedFile[] = [];
    const entries = await this.status();
    for (const entry of entries) {
      const reason = (entry.deleted ? this.inspectRemoval(entry.path, 'curator') : await this.inspect(entry.path, 'curator'))
        ?? input.refuse?.(entry.path);
      if (reason) rejected.push({ path: entry.path, reason });
    }
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
    if (writer === 'curator' && inDiary(path)) return `${path} は日記なので、整理係は消すことも動かすこともできません`;
    if (!FIXED_FILES.includes(path as typeof FIXED_FILES[number])) return undefined;
    return `${path} はサーバーが名前と置き場所を固定しているファイルなので、消すことも改名することもできません`;
  }

  /** Why the changed file may not be committed, or undefined when it may. A removal goes through inspectRemoval. */
  private async inspect(path: string, writer: Writer): Promise<string | undefined> {
    if (writer !== 'curator' && path === INDEX_FILE) {
      return `${path} は記憶の整理係だけが書くファイルなので、あなたは書き換えられません（夜に整理係が書き直します）`;
    }
    if (writer === 'day' && NIGHT_ONLY_FILES.includes(path)) {
      return `${path} は毎回のプロンプトに入るので、夜の再構成のターンでだけ書き換えられます`;
    }
    if (writer === 'curator' && NATSUMI_ONLY_FILES.includes(path)) return `${path} は${this.options.identity?.name ?? DEFAULT_SELF.name}自身のファイルなので、整理係は変えられません`;
    if (writer === 'curator' && inDiary(path)) return `${path} は日記なので、整理係は変えられません`;
    let info;
    try { info = await lstat(join(this.directory, path)); } catch { return undefined; }
    if (info.isSymbolicLink()) return 'symlink は記憶に置けません';
    if (!info.isFile()) return '通常のファイルではありません';
    if (!path.endsWith('.md')) return '.md 以外のファイルは記憶に置けません';
    let text: string;
    try { text = await readFile(join(this.directory, path), 'utf8'); } catch { return '読めないファイルです'; }
    if (text.trim() === '') return '中身が空です';
    if (path === ALWAYS_FILE && [...text].length > this.alwaysMaxChars) {
      return `毎回のプロンプトに入る常時記憶の上限（${this.alwaysMaxChars} 文字）を超えています`;
    }
    if ([...text].length > this.fileMaxChars) return `1 ファイルの上限（${this.fileMaxChars} 文字）を超えています`;
    const control = findControlStrings(text);
    if (control.length > 0) return `テンプレートの制御文字列（${control.join(' ')}）が含まれています`;
    if (hasControlCharacters(text)) return '制御文字が含まれています';
    const foreign = findForeignScript(text);
    if (foreign.length > 0) return `日本語以外の文字（${foreign.join(' ')}）が含まれています`;
    return undefined;
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
