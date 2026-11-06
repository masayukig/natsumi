import { createConnection, type Socket } from 'node:net';
import type { ToolOutcome } from './loop-tools.ts';

/**
 * The model's side of the workspace container (ADR 0019). natsumi holds no Docker socket: the runner behind the Unix
 * socket is the only way in, and the confinement is the container's. This side bounds the request, the wait and the
 * text that goes back to the model, and turns the runner's answer into sentences she can act on.
 */

/**
 * ADR 0018's limit, refused here so a long command never costs a turn in the model (ADR 0019).
 * `RUN_SHELL_DESCRIPTION` in `prompts.ts` states this number to natsumi and must be changed with it. It cannot be
 * built from this constant: the tool description is what the prefix cache holds, and a generated one would be a
 * different string whenever the number moved, undoing the cache for the rest of the session.
 */
export const MAX_COMMAND_CHARS = 8000;
/** The most stdout characters one result carries, whatever the runner sent. */
export const SHELL_OUTPUT_CHARS = 8000;
const STDERR_CHARS = 2000;
/** `loop.shellWaitSeconds`: longer than the runner's own response limit, so its answer always arrives. */
export const DEFAULT_SHELL_WAIT_SECONDS = 75;
const MAX_ANSWER_BYTES = 1024 * 1024;
/** The runner's `MaxRequestBytes`: a request line longer than this is refused there, so it is refused here first. */
const MAX_REQUEST_BYTES = 64 * 1024;
/** How much longer than a declared tool's timeout its answer is waited for: the runner answers once it has stopped it. */
const TOOL_ANSWER_GRACE_MS = 15_000;
/** `loop.backgroundJobs`: how many commands left running are waited for at once (ADR 0094). */
export const DEFAULT_BACKGROUND_JOBS = 5;
/**
 * How long a command left running is waited for. The runner gives up at 24 hours and says so on the connection; this is
 * the server's own line, a little past it, for a runner that never does.
 */
const FOLLOW_LIMIT_MS = 24 * 60 * 60 * 1000 + 10 * 60 * 1000;

/** bash and the C library say this when pids run out; the answer then points at `ps` and `kill`. */
const OUT_OF_PROCESSES = /fork|Resource temporarily unavailable|Cannot allocate memory/i;

interface RunnerAnswer {
  exitCode: number | null;
  /** A declared tool ran past its timeout and was stopped (ADR 0075). */
  timedOut?: boolean;
  signal?: string | null;
  /** The whole output, or its head when the runner left the middle out (ADR 0094). */
  stdout: string;
  stderr: string;
  /** The tail of an output whose middle was left out, and the bytes left out. */
  stdoutTail?: string;
  stderrTail?: string;
  stdoutOmitted?: number;
  stderrOmitted?: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stillRunning: boolean;
  responseLimitMs?: number;
  /** How long the runner waited before this answer. */
  waitedMs?: number;
  /** The command's process group, which `kill -- -<group>` stops whole. */
  processGroup?: number;
  running?: number;
  /** Of those still running, the ones the runner will tell the end of on a connection kept open. */
  following?: number;
}

/** What a command wrote: the whole, or its head and tail with the bytes between them left out (ADR 0094). */
export interface JobOutput {
  stdout: string;
  stdoutTail?: string;
  stdoutOmitted?: number;
  stderr: string;
  stderrTail?: string;
  stderrOmitted?: number;
}

/** How the wait for a command ended. */
export type JobEnd =
  | { kind: 'exited'; exitCode: number; output: JobOutput }
  | { kind: 'signaled'; signal: string; output: JobOutput }
  /** The longest wait was over; the command was left running. */
  | { kind: 'gave-up'; output?: JobOutput }
  /** The connection to the runner was gone before the command ended. */
  | { kind: 'lost' };

/**
 * Where natsumi's commands left running are put, and how she is told of their end (ADR 0094): `ShellJobs`, under
 * /sources/jobs.
 */
export interface BackgroundJobs {
  /** Makes a command's directory as it goes to the background, and returns it as the workspace names it. */
  open(job: { command: string; processGroup: number }): Promise<string>;
  end(path: string, end: JobEnd): Promise<void>;
}

/** How a command that went to the background stands to its end being told. */
type Background =
  | { kind: 'followed'; path: string }
  /** As many are waited for as may be. */
  | { kind: 'full'; limit: number }
  /** Nowhere to put its end: no place for jobs, or its directory could not be made. */
  | { kind: 'unplaced' }
  /** Never asked to be followed: the curator's, and the server's own. */
  | { kind: 'unasked' };

/** A wait natsumi chose that was not in its range, and what it was kept to. */
interface WaitNote { asked: number; used: number }

type Exchange =
  | { kind: 'answer'; answer: RunnerAnswer }
  | { kind: 'refused'; error: string }
  | { kind: 'unreachable' | 'no-answer' | 'unreadable' };

export interface WorkspaceShellOptions {
  /** The runner's Unix socket, shared with the workspace container. */
  socketPath: string;
  timeoutMs?: number;
  /** The owner's time zone, so `date` and what natsumi writes into memory agree (ADR 0019). */
  timeZone?: string;
  /** What changed in the memory repository, as one line, or an empty string. Asked after every command that ran. */
  memoryChanges?: () => Promise<string>;
  /** Where natsumi's commands left running are put (ADR 0094). Without it none is followed. */
  jobs?: BackgroundJobs;
  /** `loop.backgroundJobs`: how many are waited for at once. */
  backgroundJobs?: number;
  /** How long one is waited for; past the runner's own 24 hours unless a test says otherwise. */
  followLimitMs?: number;
  log?: (line: string) => void;
}

/** One call of a declared tool (ADR 0075): its argv as declared, the model's arguments as JSON, and its limits. */
export interface ToolRequest { argv: string[]; input: string; timeoutSeconds: number; maxOutputChars: number }

/** A command the server itself sends, answered with its raw output rather than a sentence for natsumi. */
export type Capture =
  | { ok: true; exitCode: number | null; stdout: string; stdoutTruncated: boolean }
  | { ok: false; text: string };

const RUNNER = '作業環境の実行役（runner）';
const UNREACHABLE = 'いまは記憶も作業場も読み書きできません。';

export class WorkspaceShell {
  private readonly options: WorkspaceShellOptions;
  private tail: Promise<unknown> = Promise.resolve();
  /** Commands left running whose end is waited for now. */
  private following = 0;

  constructor(options: WorkspaceShellOptions) { this.options = options; }

  /** How many of her commands left running are followed now: what `wait_for_events` may wait for (ADR 0094). */
  get followed(): number { return this.following; }

  /**
   * One command at a time: Pi runs the tools of one model call concurrently. Waited for until the runner's response
   * limit, and never followed past it: the curator's (ADR 0094).
   */
  run(command: string): Promise<ToolOutcome> {
    const run = this.tail.then(() => this.runNow(command), () => this.runNow(command));
    this.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * natsumi's own command (ADR 0094): waited for as long as she chose, within 0 and the runner's response limit, or the
   * limit when she did not. One still running then goes on in the background, and when it ends it is put under
   * /sources/jobs and she is told. In the same line as the rest; only the first answer is waited for in it.
   */
  runFollowed(command: string, waitSeconds: number | undefined): Promise<ToolOutcome> {
    const run = this.tail.then(() => this.runNow(command, { waitSeconds }), () => this.runNow(command, { waitSeconds }));
    this.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * A command of the server's own, such as the reads of the `read` tool (ADR 0047): the same way in, in the same line
   * as her commands, but with the output handed back as it came. No memory line is added: nothing it runs writes.
   */
  capture(command: string): Promise<Capture> {
    const run = this.tail.then(() => this.captureNow(command), () => this.captureNow(command));
    this.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * A declared tool (ADR 0075), in the same line as her commands. Its stdout is the result as it came, cut at the tool's
   * limit; anything else — an exit code other than 0, its timeout, a signal — is a failure. No memory line is added: the
   * result is the tool's output and nothing else.
   */
  runTool(request: ToolRequest): Promise<ToolOutcome> {
    const run = this.tail.then(() => this.runToolNow(request), () => this.runToolNow(request));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async runToolNow({ argv, input, timeoutSeconds, maxOutputChars }: ToolRequest): Promise<ToolOutcome> {
    const line = JSON.stringify({ argv, stdin: input, timeoutSeconds, ...(this.options.timeZone ? { timeZone: this.options.timeZone } : {}) });
    if (Buffer.byteLength(line) + 1 > MAX_REQUEST_BYTES) {
      return { ok: false, text: `引数が大きすぎます（JSON で ${MAX_REQUEST_BYTES / 1024} KiB まで）。実行していません。` };
    }
    const exchange = await exchangeLine(this.options.socketPath, line, timeoutSeconds * 1000 + TOOL_ANSWER_GRACE_MS);
    switch (exchange.kind) {
      case 'answer': return describeTool(exchange.answer, timeoutSeconds, maxOutputChars);
      // A runner from before ADR 0075 reads no argv, and finds the command it looks for empty.
      case 'refused': return { ok: false, text: exchange.error === 'command is empty'
        ? `${RUNNER}がこのツールの要求の形を知りません。作業環境の image がサーバーより古いようです。ツールは実行していません。`
        : `${RUNNER}がツールの要求を受け付けませんでした（${exchange.error}）。` };
      case 'unreachable': return { ok: false, text: `${RUNNER}に接続できません。ツールは実行していません。` };
      case 'no-answer': return { ok: false, text: `${RUNNER}から応答がありません。ツールが動いたかは分かりません。` };
      case 'unreadable': return { ok: false, text: `${RUNNER}の応答を読めませんでした。` };
    }
  }

  private async captureNow(command: string): Promise<Capture> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_SHELL_WAIT_SECONDS * 1000;
    const exchange = await ask(this.options.socketPath, command, this.options.timeZone, timeoutMs);
    switch (exchange.kind) {
      case 'answer': {
        const { answer } = exchange;
        if (answer.stillRunning) return { ok: false, text: `${RUNNER}の応答の上限までに読み終わりませんでした。` };
        return { ok: true, exitCode: answer.exitCode, stdout: answer.stdout, stdoutTruncated: answer.stdoutTruncated };
      }
      case 'refused': return { ok: false, text: `${RUNNER}が受け付けませんでした（${exchange.error}）。` };
      case 'unreachable': return { ok: false, text: `${RUNNER}に接続できません。${UNREACHABLE}` };
      case 'no-answer': return { ok: false, text: `${RUNNER}から応答がありません。${UNREACHABLE}` };
      case 'unreadable': return { ok: false, text: `${RUNNER}の応答を読めませんでした。${UNREACHABLE}` };
    }
  }

  private async runNow(command: string, own?: { waitSeconds: number | undefined }): Promise<ToolOutcome> {
    if (command.trim() === '') return { ok: false, text: 'コマンドが空です。実行していません。' };
    if ([...command].length > MAX_COMMAND_CHARS) {
      return { ok: false, text: `コマンドが長すぎます（${MAX_COMMAND_CHARS} 文字まで）。実行していません。`
        + '長いものは /work にファイルとして書いてから、bash /work/<名前>.sh で動かしてください。' };
    }
    if (command.includes('\u0000')) return { ok: false, text: 'コマンドに NUL 文字が含まれています。実行していません。' };
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_SHELL_WAIT_SECONDS * 1000;
    const asked = own?.waitSeconds;
    // Kept within the range here only where the runner cannot: below 0, and not a number at all. The runner keeps it
    // under its own limit, which only it knows.
    const waitSeconds = asked === undefined || !Number.isFinite(asked) ? undefined : Math.max(0, asked);
    const follow = own !== undefined && this.options.jobs !== undefined;
    const request = JSON.stringify({ command, ...(this.options.timeZone ? { timeZone: this.options.timeZone } : {}),
      ...(waitSeconds !== undefined ? { waitSeconds } : {}), ...(follow ? { follow: true } : {}) });
    const { exchange, kept } = await exchangeKept(this.options.socketPath, request, timeoutMs, follow);
    switch (exchange.kind) {
      case 'answer': {
        const { answer } = exchange;
        const background: Background | undefined = !answer.stillRunning ? undefined
          : !own ? { kind: 'unasked' }
          : kept ? await this.background(command, answer, kept)
          : { kind: 'unplaced' };
        // The runner counts this one among those it follows when it was asked to; one let go of here is not.
        const letGo = follow && answer.stillRunning && background?.kind !== 'followed' ? 1 : 0;
        const outcome = describe(answer, { background, note: waitNote(asked, answer), watched: Math.max(0, (answer.following ?? 0) - letGo) });
        const memory = await this.memoryLine();
        return memory ? { ...outcome, text: `${outcome.text}\n${memory}` } : outcome;
      }
      case 'refused': return { ok: false, text: `${RUNNER}がコマンドを受け付けませんでした（${exchange.error}）。` };
      case 'unreachable': return { ok: false, text: `${RUNNER}に接続できません。コマンドは実行していません。${UNREACHABLE}` };
      case 'no-answer': return { ok: false, text: `${RUNNER}から ${Math.round(timeoutMs / 1000)} 秒たっても応答がありません。コマンドが動いたかは分かりません。${UNREACHABLE}` };
      case 'unreadable': return { ok: false, text: `${RUNNER}の応答を読めませんでした。${UNREACHABLE}` };
    }
  }

  /**
   * A command of hers that went to the background on a connection kept open: followed when there is room and its
   * directory can be made, and let go of otherwise, so the runner stops keeping its output.
   */
  private async background(command: string, answer: RunnerAnswer, kept: Kept): Promise<Background> {
    const limit = this.options.backgroundJobs ?? DEFAULT_BACKGROUND_JOBS;
    const jobs = this.options.jobs;
    if (!jobs || typeof answer.processGroup !== 'number') { kept.drop(); return { kind: 'unplaced' }; }
    if (this.following >= limit) { kept.drop(); return { kind: 'full', limit }; }
    // Counted before the directory is made, so two at once cannot both take the last place.
    this.following += 1;
    let path: string;
    try { path = await jobs.open({ command, processGroup: answer.processGroup }); } catch {
      this.following -= 1;
      kept.drop();
      this.log('shell: a job directory could not be made; the command was left running unwatched');
      return { kind: 'unplaced' };
    }
    void this.watch(path, kept, jobs);
    return { kind: 'followed', path };
  }

  /** Waits for the runner's second line, and puts how the command ended into its directory. */
  private async watch(path: string, kept: Kept, jobs: BackgroundJobs): Promise<void> {
    try {
      const second = await kept.next(this.options.followLimitMs ?? FOLLOW_LIMIT_MS);
      const end: JobEnd = second.kind === 'timeout' ? { kind: 'gave-up' }
        : second.kind !== 'answer' ? { kind: 'lost' }
        : second.answer.stillRunning ? { kind: 'gave-up', output: outputOf(second.answer) }
        : second.answer.exitCode === null ? { kind: 'signaled', signal: second.answer.signal ?? 'unknown', output: outputOf(second.answer) }
        : { kind: 'exited', exitCode: second.answer.exitCode, output: outputOf(second.answer) };
      await jobs.end(path, end);
    } catch {
      this.log('shell: how a background command ended could not be put in /sources/jobs');
    } finally {
      this.following -= 1;
    }
  }

  private log(line: string): void { this.options.log?.(line); }

  /**
   * What the memory repository holds that the last commit does not. `/work` and `/home/natsumi` are never inspected,
   * so a memory written there leaves no trace; this line is the only hint that memory itself did move (ADR 0019).
   */
  private async memoryLine(): Promise<string> {
    if (!this.options.memoryChanges) return '';
    try {
      const changes = await this.options.memoryChanges();
      return changes ? `記憶の変更: ${changes}` : '';
    } catch { return ''; }
  }
}

/** A connection kept open past a still-running answer, for the runner's second line (ADR 0094). */
interface Kept {
  /** The second line, a connection that went without one, or none within the limit (and then the connection is let go). */
  next(limitMs: number): Promise<{ kind: 'answer'; answer: RunnerAnswer } | { kind: 'closed' | 'unreadable' | 'timeout' }>;
  /** Lets go of the connection: the runner stops keeping the output. */
  drop(): void;
}

/**
 * One request line to the runner and its answer line. With `keep`, a connection whose answer says the command is still
 * running is kept open and handed back, for the second line the runner writes when the command ends.
 */
function exchangeKept(socketPath: string, request: string, timeoutMs: number, keep: boolean): Promise<{ exchange: Exchange; kept?: Kept }> {
  return new Promise(resolve => {
    let settled = false;
    let connected = false;
    let chunks: Buffer[] = [];
    let size = 0;
    const socket = createConnection(socketPath);
    // After the first line: what came of the second, once it has, and who waits for it.
    let second: Awaited<ReturnType<Kept['next']>> | undefined;
    let waiting: ((value: Awaited<ReturnType<Kept['next']>>) => void) | undefined;
    const settleSecond = (value: Awaited<ReturnType<Kept['next']>>) => {
      if (second) return;
      second = value;
      socket.destroy();
      waiting?.(value);
    };
    const finish = (exchange: Exchange) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (keep && exchange.kind === 'answer' && exchange.answer.stillRunning && !socket.destroyed) {
        // A wait of up to a day holds nothing else up: the server stops whenever it is told to.
        socket.unref();
        resolve({ exchange, kept: keptOf(socket, () => second, wait => { waiting = wait; }, settleSecond) });
        return;
      }
      socket.destroy();
      resolve({ exchange });
    };
    const timer = setTimeout(() => finish({ kind: 'no-answer' }), timeoutMs);
    socket.on('connect', () => {
      connected = true;
      socket.write(`${request}\n`);
    });
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_ANSWER_BYTES) {
        if (settled) settleSecond({ kind: 'unreadable' }); else finish({ kind: 'unreadable' });
        return;
      }
      chunks.push(chunk);
      const received = Buffer.concat(chunks);
      const end = received.indexOf(0x0a);
      if (end < 0) return;
      if (!settled) {
        finish(parse(received.subarray(0, end)));
        // What follows the first line belongs to the second.
        chunks = [received.subarray(end + 1)];
        size = chunks[0]!.length;
        const more = chunks[0]!.indexOf(0x0a);
        if (more >= 0 && !second) settleSecond(secondOf(chunks[0]!.subarray(0, more)));
        return;
      }
      settleSecond(secondOf(received.subarray(0, end)));
    });
    socket.on('end', () => {
      if (!settled) finish(parse(Buffer.concat(chunks)));
      else settleSecond({ kind: 'closed' });
    });
    socket.on('close', () => { if (settled) settleSecond({ kind: 'closed' }); });
    socket.on('error', () => {
      if (!settled) finish(connected ? { kind: 'unreadable' } : { kind: 'unreachable' });
      else settleSecond({ kind: 'closed' });
    });
  });
}

function keptOf(socket: Socket, settledSecond: () => Awaited<ReturnType<Kept['next']>> | undefined,
  onSecond: (wait: (value: Awaited<ReturnType<Kept['next']>>) => void) => void,
  settle: (value: Awaited<ReturnType<Kept['next']>>) => void): Kept {
  return {
    next(limitMs) {
      const already = settledSecond();
      if (already) return Promise.resolve(already);
      return new Promise(resolve => {
        const timer = setTimeout(() => settle({ kind: 'timeout' }), limitMs);
        timer.unref();
        onSecond(value => { clearTimeout(timer); resolve(value); });
      });
    },
    drop() { socket.destroy(); },
  };
}

function secondOf(line: Buffer): { kind: 'answer'; answer: RunnerAnswer } | { kind: 'unreadable' } {
  const exchange = parse(line);
  return exchange.kind === 'answer' ? exchange : { kind: 'unreadable' };
}

function ask(socketPath: string, command: string, timeZone: string | undefined, timeoutMs: number): Promise<Exchange> {
  return exchangeLine(socketPath, JSON.stringify({ command, ...(timeZone ? { timeZone } : {}) }), timeoutMs);
}

/** One request line to the runner and its one answer line. */
async function exchangeLine(socketPath: string, request: string, timeoutMs: number): Promise<Exchange> {
  return (await exchangeKept(socketPath, request, timeoutMs, false)).exchange;
}

function parse(line: Buffer): Exchange {
  let value: unknown;
  try { value = JSON.parse(line.toString('utf8')); } catch { return { kind: 'unreadable' }; }
  if (typeof value !== 'object' || value === null) return { kind: 'unreadable' };
  const answer = value as Record<string, unknown>;
  if (typeof answer.error === 'string') return { kind: 'refused', error: answer.error.slice(0, 200) };
  const exitCode = answer.exitCode;
  if (typeof answer.stdout !== 'string' || typeof answer.stderr !== 'string' || typeof answer.stillRunning !== 'boolean'
    || !(exitCode === null || typeof exitCode === 'number')) {
    return { kind: 'unreadable' };
  }
  return { kind: 'answer', answer: answer as unknown as RunnerAnswer };
}

/**
 * The answer as natsumi reads it. A command still running is not a failure: ADR 0019 made the response limit the
 * line where the runner answers, not the line where the command dies. One of hers still running went to the background,
 * and the answer says where its end will be told, or why it will not be (ADR 0094).
 */
function describe(answer: RunnerAnswer, context: { background?: Background; note?: WaitNote; watched: number }): ToolOutcome {
  const lines: string[] = [];
  let ok = true;
  const { note } = context;
  if (note) lines.push(`wait_seconds の ${note.asked} は待てる範囲の外なので、${seconds(note.used)}に丸めました。`);
  if (answer.stillRunning) {
    const waitedMs = answer.waitedMs ?? answer.responseLimitMs;
    const waited = typeof waitedMs === 'number' ? seconds(waitedMs / 1000) : '応答の上限まで';
    lines.push(`${waited}待っても終わらなかったので、ここまでの出力を返します。`);
    lines.push(...backgroundLines(answer.processGroup, context.background ?? { kind: 'unasked' }));
  } else if (answer.exitCode === null) {
    ok = false;
    lines.push(`コマンドはシグナル（${answer.signal ?? '不明'}）で止まりました。メモリやプロセス数の上限に当たった可能性があります。`);
  } else {
    lines.push(`コマンドは終了コード ${answer.exitCode} で終わりました。${answer.exitCode === 1 ? 'rg と grep は、見つからないときも 1 を返します。' : ''}`);
  }
  const stdout = shown(answer.stdout, answer.stdoutTail, answer.stdoutOmitted, SHELL_OUTPUT_CHARS);
  lines.push(stdout.text === '' ? '標準出力は空でした。' : `標準出力:\n${stdout.text}`);
  if (stdout.cut || answer.stdoutTruncated) {
    lines.push('（標準出力が長いので先頭と末尾だけを返しています。全部が要るときは /work のファイルへリダイレクトしてください。head、rg -m、wc -l などで絞れます）');
  }
  const stderr = shown(answer.stderr, answer.stderrTail, answer.stderrOmitted, STDERR_CHARS);
  if (stderr.text !== '') lines.push(`標準エラー出力:\n${stderr.text}`);
  if (stderr.cut || answer.stderrTruncated) lines.push('（標準エラー出力が長いので先頭と末尾だけを返しています）');
  if (OUT_OF_PROCESSES.test(answer.stderr) || OUT_OF_PROCESSES.test(answer.stderrTail ?? '')) {
    lines.push('プロセス数の上限に当たり、新しいプロセスを作れませんでした。ps で残っているものを見て、要らないものを kill してください。');
  }
  // Those whose end she will be told of are left out: she need not look after them with ps (ADR 0094).
  const unwatched = Math.max(0, (answer.running ?? 0) - context.watched);
  if (unwatched > 0) lines.push(`まだ動いているコマンドが ${unwatched} 個あります（終わりを知らせるものは除きます）。要らなくなったら ps で見て kill してください。`);
  return { ok, text: lines.join('\n') };
}

/** What becomes of a command left running, as its answer says it. */
function backgroundLines(processGroup: number | undefined, background: Background): string[] {
  const group = typeof processGroup === 'number' ? `（プロセスグループ ${processGroup}）` : '';
  const stop = typeof processGroup === 'number' ? `kill -- -${processGroup} でグループごと止められます` : 'kill で止められます';
  if (background.kind === 'followed') {
    return [`コマンドは止めずに裏で動かしています${group}。終わったら sources_updated で知らせ、終わり方と出力を ${background.path}/ に置きます。`,
      'ps や sleep で様子を見に行かなくてかまいません。ほかにすることがあれば続けてください。'
        + '結果を見てこのターンのうちに続けたいなら、wait_for_events で待てます。急がないなら、ターンを終えてもかまいません（終わったら知らせが届きます）。',
      `要らなくなったら ${stop}。`];
  }
  const why = background.kind === 'full' ? `終わりを待っているコマンドがすでに上限の ${background.limit} 個あるので、`
    : background.kind === 'unplaced' ? '終わりを置く場所を用意できなかったので、' : '';
  return [`コマンドはまだ動いています${group}（止めていません）。${why}このコマンドは終わっても知らせません。`
    + 'この先の出力は読み捨てられるので、残したいときは /work のファイルへリダイレクトしてください。'
    + `終わったかどうかは ps で確かめ、要らなくなったら ${stop}。`];
}

/** A wait in seconds, as a result says it. */
function seconds(value: number): string {
  return `${Number.isInteger(value) ? value : Math.round(value * 10) / 10} 秒`;
}

/** A wait she chose that was out of its range: below 0, past the runner's limit, or not a number. */
function waitNote(asked: number | undefined, answer: RunnerAnswer): WaitNote | undefined {
  if (asked === undefined) return undefined;
  const limit = typeof answer.responseLimitMs === 'number' ? answer.responseLimitMs / 1000 : undefined;
  if (!Number.isFinite(asked)) return limit === undefined ? undefined : { asked, used: limit };
  if (asked < 0) return { asked, used: 0 };
  return limit !== undefined && asked > limit ? { asked, used: limit } : undefined;
}

/** The output of a second line, as a job's directory keeps it. */
function outputOf(answer: RunnerAnswer): JobOutput {
  return {
    stdout: answer.stdout, ...(answer.stdoutTail ? { stdoutTail: answer.stdoutTail } : {}),
    ...(answer.stdoutOmitted ? { stdoutOmitted: answer.stdoutOmitted } : {}),
    stderr: answer.stderr, ...(answer.stderrTail ? { stderrTail: answer.stderrTail } : {}),
    ...(answer.stderrOmitted ? { stderrOmitted: answer.stderrOmitted } : {}),
  };
}

/**
 * An output within `max` characters: whole when it fits, or its first and last halves with a line saying how many bytes
 * were left out between them, here and by the runner together (ADR 0094).
 */
function shown(head: string, tail: string | undefined, omitted: number | undefined, max: number): { text: string; cut: boolean } {
  const front = [...head];
  const back = [...(tail ?? '')];
  if (!omitted && back.length === 0 && front.length <= max) return { text: head, cut: false };
  const half = Math.floor(max / 2);
  let first: string[];
  let last: string[];
  let dropped = omitted ?? 0;
  if (back.length === 0 && !omitted) {
    first = front.slice(0, half);
    last = front.slice(front.length - (max - half));
    dropped += Buffer.byteLength(front.slice(half, front.length - (max - half)).join(''));
  } else {
    first = front.slice(0, half);
    last = back.slice(Math.max(0, back.length - (max - half)));
    dropped += Buffer.byteLength(front.slice(half).join('')) + Buffer.byteLength(back.slice(0, back.length - last.length).join(''));
  }
  const top = first.join('');
  return { text: `${top}${top.endsWith('\n') ? '' : '\n'}…（ここで ${dropped} バイトを省きました）…\n${last.join('')}`, cut: true };
}

/** A declared tool's answer: its stdout alone when it succeeded, and what went wrong when it did not (ADR 0075). */
function describeTool(answer: RunnerAnswer, timeoutSeconds: number, maxOutputChars: number): ToolOutcome {
  const stdout = cut(answer.stdout, maxOutputChars);
  const long = stdout.cut || answer.stdoutTruncated ? `（出力が長いので先頭の ${maxOutputChars} 文字だけを返しています）` : '';
  if (!answer.timedOut && !answer.stillRunning && answer.exitCode === 0) {
    if (stdout.text === '') return { ok: true, text: long || '（出力は空でした）' };
    return { ok: true, text: long ? `${stdout.text}\n${long}` : stdout.text };
  }
  const lines = [answer.timedOut || answer.stillRunning ? `ツールが ${timeoutSeconds} 秒で終わらなかったので止めました。`
    : answer.exitCode === null ? `ツールはシグナル（${answer.signal ?? '不明'}）で止まりました。`
    : `ツールは終了コード ${answer.exitCode} で失敗しました。`];
  if (stdout.text !== '') lines.push(`標準出力:\n${stdout.text}`);
  if (long) lines.push(long);
  const stderr = cut(answer.stderr, STDERR_CHARS);
  if (stderr.text !== '') lines.push(`標準エラー出力:\n${stderr.text}`);
  return { ok: false, text: lines.join('\n') };
}

function cut(text: string, max: number): { text: string; cut: boolean } {
  const characters = [...text];
  return characters.length > max ? { text: characters.slice(0, max).join(''), cut: true } : { text, cut: false };
}
