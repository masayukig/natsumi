import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localDateTime } from './nightly.ts';
import type { Attention, SourceRegistration } from './sources.ts';
import { SOURCES_PATH } from './view.ts';
import type { JobEnd } from './workspace-shell.ts';

/**
 * The commands natsumi left running in the background, as files under /sources/jobs (ADR 0094): one directory a command,
 * `<time>-<mark>/`, made when it went there and taken in as not news, since she started it herself. When it ends, how it
 * ended and its output are put there; an exit code is told at once by an attention (`shell_finished`), and a signal, the
 * end of the longest wait or a wait cut off are ordinary updates. The server alone writes here; the workspace reads it.
 * Nothing is removed (ADR 0069's "replies are kept").
 */

/** The source's name, its directory under `sources/`. */
export const JOBS_SOURCE = 'jobs';
/** Where the jobs are, as the workspace names it. */
export const JOBS_PATH = `${SOURCES_PATH}/${JOBS_SOURCE}`;
/** The attention's kind for a command that ended with an exit code. */
export const SHELL_FINISHED = 'shell_finished';
/** The files a job's directory holds. */
export const JOB_FILES = { readme: 'README.md', stdout: 'stdout.txt', stderr: 'stderr.txt', state: 'job.json' } as const;
/** One directory a command; the history keeps its README alone, and the output is read from its files. */
export const JOBS_REGISTRATION: SourceRegistration = {
  name: JOBS_SOURCE, depth: 1, exclude: [`*/${JOB_FILES.stdout}`, `*/${JOB_FILES.stderr}`, `*/${JOB_FILES.state}`],
};
/** How long a command is waited for, in words, as the runner's follow limit and the server's own hold it. */
export const LONGEST_WAIT_WORDS = '24 時間';

const FILE_MODE = 0o640;

type JobState = 'running' | 'exited' | 'signaled' | 'gave_up' | 'lost' | 'restarted';

/** What `job.json` keeps, for the server to read back as it starts. */
interface JobRecord {
  command: string;
  processGroup: number;
  startedAt: number;
  state: JobState;
  endedAt?: number;
  exitCode?: number;
  signal?: string;
  /** Bytes left out of each output. */
  omitted?: { stdout: number; stderr: number };
}

/** How a job's directory is told: the sources, in the shape their other users have (ADR 0050). */
export interface JobsPlace {
  recordAttention(attention: Attention): boolean;
  notify(): void;
  /** Takes a directory (as the workspace names it) in as it stands, as not news. */
  takeIn(path: string): Promise<void>;
}

export interface ShellJobsOptions {
  /** `sources/jobs` as the server sees it. */
  directory: string;
  /** The owner's time zone, in which the times are written. */
  timeZone: string;
  now: () => number;
  /** A draw from [0, 1), for the mark of a directory's name. Math.random unless given. */
  random?: () => number;
  /** Without it the directories are written and nobody is told. */
  place?: JobsPlace;
  log?: (line: string) => void;
}

export class ShellJobs {
  private readonly options: ShellJobsOptions;

  constructor(options: ShellJobsOptions) { this.options = options; }

  /**
   * Makes the directory of a command going to the background, with what it is, when it went and its process group,
   * and takes it in as not news. Returns the directory as the workspace names it. Throws when it cannot be made.
   */
  async open(job: { command: string; processGroup: number }): Promise<string> {
    const { directory } = this.options;
    await mkdir(directory, { recursive: true, mode: 0o750 });
    const at = this.options.now();
    const record: JobRecord = { command: job.command, processGroup: job.processGroup, startedAt: at, state: 'running' };
    for (let attempt = 0; attempt < 16; attempt++) {
      const name = `${timeStamp(at)}-${this.mark()}`;
      const final = join(directory, name);
      const temporary = `${final}.tmp`;
      try { await mkdir(temporary, { mode: 0o750 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      const path = `${JOBS_PATH}/${name}`;
      try {
        await this.write(temporary, path, record);
        try { await mkdir(final); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') { await rm(temporary, { recursive: true, force: true }); continue; }
          throw error;
        }
        // An empty directory is moved over, never a full one: the name was free a moment ago and is kept free here.
        await rename(temporary, final);
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }
      try { await this.options.place?.takeIn(path); } catch {
        this.log('jobs: a directory could not be taken in by the sources; it may be shown as an update');
      }
      return path;
    }
    throw new Error('no free name for a job');
  }

  /**
   * Puts how a command's wait ended into its directory: the output first, the README last. An exit code is told at
   * once by an attention; anything else is left for the sources to find as an ordinary update.
   */
  async end(path: string, end: JobEnd): Promise<void> {
    const name = path.startsWith(`${JOBS_PATH}/`) ? path.slice(JOBS_PATH.length + 1) : '';
    if (!/^[0-9TZ]+-[0-9a-f]+$/.test(name)) throw new Error('not a job directory');
    const here = join(this.options.directory, name);
    const record = await readRecord(here);
    if (!record) throw new Error('the job directory has no record');
    const ended: JobRecord = { ...record, endedAt: this.options.now(), state: STATE_OF[end.kind] };
    if (end.kind === 'exited') ended.exitCode = end.exitCode;
    if (end.kind === 'signaled') ended.signal = end.signal;
    const output = 'output' in end ? end.output : undefined;
    if (output) {
      await replace(join(here, JOB_FILES.stdout), joined(output.stdout, output.stdoutTail, output.stdoutOmitted));
      await replace(join(here, JOB_FILES.stderr), joined(output.stderr, output.stderrTail, output.stderrOmitted));
      ended.omitted = { stdout: output.stdoutOmitted ?? 0, stderr: output.stderrOmitted ?? 0 };
    }
    await this.write(here, path, ended);
    if (end.kind === 'exited' && this.options.place) {
      const recorded = this.options.place.recordAttention({ source: JOBS_SOURCE, kind: SHELL_FINISHED,
        file: `${path}/${JOB_FILES.readme}`, details: { exit_code: end.exitCode } });
      if (recorded) this.options.place.notify();
    }
  }

  /**
   * As the server starts: every directory whose command was still waited for says the restart cut the wait off. The
   * sources find them as ordinary updates. Returns how many there were.
   */
  async giveUpOnRunning(): Promise<number> {
    let names: string[];
    try { names = await readdir(this.options.directory); } catch { return 0; }
    let count = 0;
    for (const name of names.sort()) {
      if (name.endsWith('.tmp')) continue;
      const here = join(this.options.directory, name);
      const record = await readRecord(here);
      if (record?.state !== 'running') continue;
      try {
        await this.write(here, `${JOBS_PATH}/${name}`, { ...record, state: 'restarted', endedAt: this.options.now() });
        count += 1;
      } catch { this.log('jobs: a directory could not be told that its wait was cut off'); }
    }
    return count;
  }

  /** Writes the record and the README of a job, the README last. */
  private async write(here: string, path: string, record: JobRecord): Promise<void> {
    await replace(join(here, JOB_FILES.state), `${JSON.stringify(record, null, 2)}\n`);
    await replace(join(here, JOB_FILES.readme), readme(record, path, this.options.timeZone));
  }

  private mark(): string {
    const draw = (this.options.random ?? Math.random)();
    return Math.floor(draw * 0x10000).toString(16).padStart(4, '0');
  }

  private log(line: string): void { this.options.log?.(line); }
}

const STATE_OF: Record<JobEnd['kind'], JobState> = { exited: 'exited', signaled: 'signaled', 'gave-up': 'gave_up', lost: 'lost' };

/** An output as its file holds it: the whole, or the head, a line saying how much was left out, and the tail. */
function joined(head: string, tail: string | undefined, omitted: number | undefined): string {
  if (!omitted) return head + (tail ?? '');
  return `${head}${head.endsWith('\n') || head === '' ? '' : '\n'}…（ここで ${omitted} バイトを省きました）…\n${tail ?? ''}`;
}

function readme(record: JobRecord, path: string, timeZone: string): string {
  const group = record.processGroup;
  const lines = ['# 裏で動かしたコマンド', '', `- 状態: ${stateLine(record)}`,
    `- 裏に回った時刻: ${localDateTime(record.startedAt, timeZone)}`];
  if (record.endedAt !== undefined && record.state !== 'running') lines.push(`- 終わった時刻: ${localDateTime(record.endedAt, timeZone)}`);
  lines.push(`- プロセスグループ: ${group}（グループごと止めるときは kill -- -${group}）`);
  if (record.state === 'exited' || record.state === 'signaled' || (record.state === 'gave_up' && record.omitted)) {
    lines.push(`- 標準出力: ${path}/${JOB_FILES.stdout}${omittedNote(record.omitted?.stdout)}`,
      `- 標準エラー出力: ${path}/${JOB_FILES.stderr}${omittedNote(record.omitted?.stderr)}`);
  }
  const after = afterwards(record);
  lines.push('', ...(after.length > 0 ? [...after, ''] : []), '## コマンド', '', ...fenced(record.command), '');
  return lines.join('\n');
}

function stateLine(record: JobRecord): string {
  switch (record.state) {
    case 'running': return '動いています。終わったら、ここに終わり方と出力を置き、sources_updated で知らせます。';
    case 'exited': return `終了コード ${record.exitCode} で終わりました。`;
    case 'signaled': return `シグナル（${record.signal}）で終わりました。kill で止めたか、メモリやプロセス数の上限に当たった可能性があります。`;
    case 'gave_up': return `裏に回ってから ${LONGEST_WAIT_WORDS}たっても終わらないので、もう待ちません。終わっても知らせは届きません。`;
    case 'lost': return '作業環境の実行役（runner）との接続が切れたので、終わりを待てなくなりました。終わっても知らせは届きません。';
    case 'restarted': return 'サーバーが再起動したので、終わりを待てなくなりました。終わっても知らせは届きません。';
  }
}

/** What to do with a command that may still be running, and nobody waits for. */
function afterwards(record: JobRecord): string[] {
  if (record.state !== 'gave_up' && record.state !== 'lost' && record.state !== 'restarted') return [];
  const group = record.processGroup;
  return [`まだ動いているかは ps -o pid,pgid,etime,args -g ${group} で確かめられます。`
    + `要らなければ kill -- -${group} でグループごと止めてください。作業環境ごと作り直されていれば、もう動いていません。`];
}

function omittedNote(omitted: number | undefined): string {
  return omitted ? `（長いので先頭と末尾だけを残し、途中の ${omitted} バイトを省きました）` : '';
}

/** A command in a code block whose fence no run of backticks in it can close. */
function fenced(command: string): string[] {
  const longest = Math.max(2, ...[...command.matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return [`${fence}bash`, command.replace(/\n+$/, ''), fence];
}

async function readRecord(here: string): Promise<JobRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(join(here, JOB_FILES.state), 'utf8')) as JobRecord;
    return typeof value === 'object' && value !== null && typeof value.state === 'string' ? value : undefined;
  } catch { return undefined; }
}

/** Writes a file whole, renamed into place so it is never read half-written. */
async function replace(file: string, text: string): Promise<void> {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, text, { mode: FILE_MODE });
  await rename(temporary, file);
}

/** The time in UTC as `20261106T033456Z`. */
function timeStamp(at: number): string {
  return new Date(at).toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(/[-:]/g, '');
}
