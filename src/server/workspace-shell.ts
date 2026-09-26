import { createConnection } from 'node:net';
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

/** bash and the C library say this when pids run out; the answer then points at `ps` and `kill`. */
const OUT_OF_PROCESSES = /fork|Resource temporarily unavailable|Cannot allocate memory/i;

interface RunnerAnswer {
  exitCode: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stillRunning: boolean;
  responseLimitMs?: number;
  running?: number;
}

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
}

/** A command the server itself sends, answered with its raw output rather than a sentence for natsumi. */
export type Capture =
  | { ok: true; exitCode: number | null; stdout: string; stdoutTruncated: boolean }
  | { ok: false; text: string };

const RUNNER = '作業環境の実行役（runner）';
const UNREACHABLE = 'いまは記憶も作業場も読み書きできません。';

export class WorkspaceShell {
  private readonly options: WorkspaceShellOptions;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: WorkspaceShellOptions) { this.options = options; }

  /** One command at a time: Pi runs the tools of one model call concurrently. */
  run(command: string): Promise<ToolOutcome> {
    const run = this.tail.then(() => this.runNow(command), () => this.runNow(command));
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

  private async runNow(command: string): Promise<ToolOutcome> {
    if (command.trim() === '') return { ok: false, text: 'コマンドが空です。実行していません。' };
    if ([...command].length > MAX_COMMAND_CHARS) {
      return { ok: false, text: `コマンドが長すぎます（${MAX_COMMAND_CHARS} 文字まで）。実行していません。`
        + '長いものは /work にファイルとして書いてから、bash /work/<名前>.sh で動かしてください。' };
    }
    if (command.includes('\u0000')) return { ok: false, text: 'コマンドに NUL 文字が含まれています。実行していません。' };
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_SHELL_WAIT_SECONDS * 1000;
    const exchange = await ask(this.options.socketPath, command, this.options.timeZone, timeoutMs);
    switch (exchange.kind) {
      case 'answer': {
        const outcome = describe(exchange.answer);
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

function ask(socketPath: string, command: string, timeZone: string | undefined, timeoutMs: number): Promise<Exchange> {
  return new Promise(resolve => {
    let settled = false;
    let connected = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const socket = createConnection(socketPath);
    const finish = (exchange: Exchange) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(exchange);
    };
    const timer = setTimeout(() => finish({ kind: 'no-answer' }), timeoutMs);
    socket.on('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify({ command, ...(timeZone ? { timeZone } : {}) })}\n`);
    });
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_ANSWER_BYTES) { finish({ kind: 'unreadable' }); return; }
      chunks.push(chunk);
      const received = Buffer.concat(chunks);
      const end = received.indexOf(0x0a);
      if (end >= 0) finish(parse(received.subarray(0, end)));
    });
    socket.on('end', () => finish(parse(Buffer.concat(chunks))));
    socket.on('error', () => finish(connected ? { kind: 'unreadable' } : { kind: 'unreachable' }));
  });
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
 * line where the runner answers, not the line where the command dies.
 */
function describe(answer: RunnerAnswer): ToolOutcome {
  const lines: string[] = [];
  let ok = true;
  if (answer.stillRunning) {
    const waited = typeof answer.responseLimitMs === 'number' ? `${Math.round(answer.responseLimitMs / 1000)} 秒` : '応答の上限';
    lines.push(`${waited}待っても終わらなかったので、ここまでの出力を返します。コマンドはまだ動いています（止めていません）。`
      + 'この先の出力は読み捨てられるので、残したいときは /work のファイルへリダイレクトしてください。'
      + '終わったかどうかは ps で確かめ、要らなくなったら kill してください。');
  } else if (answer.exitCode === null) {
    ok = false;
    lines.push(`コマンドはシグナル（${answer.signal ?? '不明'}）で止まりました。メモリやプロセス数の上限に当たった可能性があります。`);
  } else {
    lines.push(`コマンドは終了コード ${answer.exitCode} で終わりました。${answer.exitCode === 1 ? 'rg と grep は、見つからないときも 1 を返します。' : ''}`);
  }
  const stdout = cut(answer.stdout, SHELL_OUTPUT_CHARS);
  lines.push(stdout.text === '' ? '標準出力は空でした。' : `標準出力:\n${stdout.text}`);
  if (stdout.cut || answer.stdoutTruncated) lines.push('（標準出力が長いので先頭だけを返しています。head、rg -m、wc -l などで絞れます）');
  const stderr = cut(answer.stderr, STDERR_CHARS);
  if (stderr.text !== '') lines.push(`標準エラー出力:\n${stderr.text}`);
  if (stderr.cut || answer.stderrTruncated) lines.push('（標準エラー出力が長いので先頭だけを返しています）');
  if (OUT_OF_PROCESSES.test(answer.stderr)) {
    lines.push('プロセス数の上限に当たり、新しいプロセスを作れませんでした。ps で残っているものを見て、要らないものを kill してください。');
  }
  const running = answer.running ?? 0;
  if (running > 0) lines.push(`まだ動いているコマンドが ${running} 個あります。要らなくなったら ps で見て kill してください。`);
  return { ok, text: lines.join('\n') };
}

function cut(text: string, max: number): { text: string; cut: boolean } {
  const characters = [...text];
  return characters.length > max ? { text: characters.slice(0, max).join(''), cut: true } : { text, cut: false };
}
