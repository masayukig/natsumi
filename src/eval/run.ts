import { createHash } from 'node:crypto';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { routesRuntime } from '../pi/auth.ts';
import { COMPATIBLE_PROVIDER } from '../pi/compatible.ts';
import { readSessionId, type PiTarget } from '../pi/session.ts';
import { AGENT_LIST_DIRECTORY, writeAgentList } from '../server/agent-list.ts';
import { LOOP_DEFAULTS } from '../server/config.ts';
import { ConversationStore } from '../server/conversation-store.ts';
import { initializeDataDirectory, STATE_DIRECTORY } from '../server/data-directory.ts';
import { DOVE_NAME } from '../server/dove.ts';
import { parseDoveRequest } from '../server/dove-request.ts';
import type { ToolOutcome } from '../server/loop-tools.ts';
import { MIGRATIONS } from '../server/migrations.ts';
import { HOME_DIRECTORY, SOURCES_DIRECTORY, WORK_DIRECTORY } from '../server/paths.ts';
import { REFLECTION_REQUEST } from '../server/prompts.ts';
import { migrate, openStateDatabase } from '../server/state-db.ts';
import { ThinkingLoop, type LoopClientEvent, type LoopOptions } from '../server/thinking-loop.ts';
import { judgeChecks, type Judge } from './checks.ts';
import { loadSceneModule } from './hooks.ts';
import { DRY_JUDGE } from './judge.ts';
import type { ModelFile } from './model-file.ts';
import type { ModelCallRecord, RunRecord, ToolRecord } from './record.ts';
import { conditions, loadScenes, type Condition, type Feature, type Scene, type SceneEvent } from './scene.ts';
import { scriptedStream, type Answer } from './scripted.ts';
import { summarize, summaryMarkdown, type Skipped, type Summary } from './summary.ts';
import { bwrapAvailable, WorkspaceRunner, type Sandbox } from './workspace.ts';

/** The model of a dry run: a route to nowhere, whose every call the scene's script answers. */
export const DRY_TARGET: PiTarget = { provider: COMPATIBLE_PROVIDER, model: 'dry-run' };
/** A memo nobody reads: the turn is what is evaluated (ADR 0051). */
const MEMO = 'メモ: 特になし';
/** Compaction would cost a model call after the turn and is not what is measured, so it never comes. */
const NO_COMPACTION = 1e12;

export interface RunOptions {
  run: number;
  dryRun: boolean;
  repository: string;
  /** Where the run's own directory is made. */
  work: string;
  runner: WorkspaceRunner;
  /** The model evaluated; absent in a dry run. */
  model?: { file: ModelFile; runtime: (root: string) => Promise<ModelRuntime> };
  judge?: Judge;
  sandbox?: Sandbox;
  /** `model` hands the memo after the turn to the model evaluated; by default it is answered without one. */
  memo?: 'skip' | 'model';
  limits?: { modelCalls?: number; minutes?: number };
  log?: (line: string) => void;
}

/** What the branch can do that a scene may need, found on the code itself. */
export function detectFeatures(): Set<Feature> {
  const features = new Set<Feature>();
  if (typeof (ThinkingLoop.prototype as unknown as Record<string, unknown>).raiseSourcesUpdated === 'function') features.add('sources-updated');
  return features;
}

/**
 * One run of one condition (ADR 0051): a fresh data directory, SQLite and Pi session; the scene's state; the loop the
 * server runs, with the real runner behind its shell; the turns before; then the event, handed over as the server would,
 * and the turn it makes, recorded and checked. Nothing leaves the machine but the model's own requests.
 */
export async function runCondition(condition: Condition, options: RunOptions): Promise<RunRecord> {
  const { scene } = condition;
  const root = join(options.work, scene.name, condition.variant.replace(/\//g, '+'), `run-${options.run}`);
  await rm(root, { recursive: true, force: true });
  const data = join(root, 'data');
  const manual = join(root, 'manual');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  const record: RunRecord = {
    scene: scene.name, variant: condition.variant, run: options.run,
    model: options.model?.file.shown ?? { provider: DRY_TARGET.provider, id: DRY_TARGET.model }, dryRun: options.dryRun,
    startedAt: new Date().toISOString(), ms: 0, outcome: 'error', modelCalls: 0, tokens: { input: 0, cacheRead: 0, output: 0 },
    instructions: { chars: 0, sha256: '' }, priorMessages: 0, prompt: '', events: [], calls: [], tools: [], replies: [], dove: [], checks: [],
  };
  const closers: (() => Promise<void> | void)[] = [];
  try {
    await mkdir(sessionDirectory, { recursive: true });
    await mkdir(agentDirectory, { recursive: true });
    await mkdir(data);
    await initializeDataDirectory(data);
    await cp(join(options.repository, 'manual'), manual, { recursive: true });
    await placeState(condition, data, manual);
    const module = await loadSceneModule(scene.module, scene.setup);
    await module.setup?.({ data, manual, scene: scene.name, variant: condition.variant });
    const t0 = Date.now();
    const now = scene.time === undefined ? Date.now : () => scene.time! + (Date.now() - t0);
    // What the server writes on every start, as it would with Slack configured or not (ADR 0036, ADR 0040).
    await writeAgentList({ directory: join(data, AGENT_LIST_DIRECTORY), config: undefined, client: undefined, now: now(),
      timeZone: scene.timeZone, dove: scene.dove });

    const db = openStateDatabase(join(data, STATE_DIRECTORY, 'state.sqlite'));
    closers.unshift(() => db.close());
    migrate(db, MIGRATIONS);
    if (scene.context.session) {
      // The copy is the conversation the loop opens, as a restart would open the server's own.
      const file = join(sessionDirectory, basename(scene.context.session));
      await cp(scene.context.session, file);
      new ConversationStore(db, now).insertConversation(await readSessionId(file), relative(sessionDirectory, file));
    }

    // A dry run names the model file it was given, if any, but never reads its key or reaches it.
    const real = options.dryRun ? undefined : options.model;
    const target = real?.file.target ?? DRY_TARGET;
    const runtime = real ? await real.runtime(agentDirectory)
      : await routesRuntime(agentDirectory, { compatible: [{ provider: DRY_TARGET.provider, apiKey: 'dry-run',
        endpoint: { baseUrl: 'https://dry-run.invalid/v1', model: DRY_TARGET.model } }] });

    // Under the temporary directory rather than the run's: a Unix socket's path is short (about 100 bytes), and the
    // run's directory is as deep as the results are.
    const socketParent = await mkdtemp(join(tmpdir(), 'natsumi-ws-'));
    closers.push(() => rm(socketParent, { recursive: true, force: true }));
    const socketDirectory = join(socketParent, 'socket');
    const sandbox = options.sandbox ?? ((await bwrapAvailable()) ? 'bwrap' : 'host');
    if (sandbox === 'host' && !options.dryRun) throw new Error('a real model is evaluated only inside bubblewrap');

    // What the model is handed, and by whom: the script before the turn and for the memo, the model (or a dry run's
    // script) in the turn.
    const phase: { now: 'prelude' | 'turn' | 'after'; answer: Answer; turnCalls: number } = { now: 'prelude', answer: {}, turnCalls: 0 };
    let promptError: string | undefined;
    let session: AgentSession | undefined;
    const callTimes: number[] = [];
    const callEnds: number[] = [];
    let callStarted = 0;
    const configureSession = (created: AgentSession) => {
      session = created;
      const original = created.agent.streamFunction;
      created.agent.streamFunction = (model, context, streamOptions) => {
        const last = context.messages.at(-1);
        const lastText = last?.role === 'user' ? (typeof last.content === 'string' ? last.content
          : last.content.map(part => part.type === 'text' ? part.text : '').join('')) : '';
        if (lastText === REFLECTION_REQUEST && (phase.now !== 'turn' || options.memo !== 'model')) {
          return scriptedStream(model, { text: MEMO }, streamOptions);
        }
        if (phase.now === 'prelude') {
          return scriptedStream(model, last?.role === 'toolResult' ? {} : phase.answer, streamOptions);
        }
        if (options.dryRun) {
          const step = scene.dryRun[phase.turnCalls++] ?? {};
          return scriptedStream(model, step, streamOptions);
        }
        return original(model, context, streamOptions);
      };
      created.subscribe(event => {
        if (phase.now !== 'turn') return;
        if (event.type === 'message_start' && event.message.role === 'assistant') callStarted = Date.now();
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          callTimes.push(Date.now() - callStarted);
          callEnds.push(Date.now());
        }
      });
    };
    const reviseSystemPrompt = (prompt: string) => {
      let revised = prompt;
      for (const edit of condition.prompt) {
        if (!revised.includes(edit.replace)) { promptError ??= `the instructions have no「${edit.replace}」to replace`; continue; }
        revised = revised.replace(edit.replace, edit.with);
      }
      record.instructions = { chars: [...revised].length, sha256: createHash('sha256').update(revised).digest('hex') };
      return revised;
    };

    // An event line written in the scene goes in through the loop's side for outside events, as the branch has it.
    let rawLine: Record<string, unknown> = {};
    const lineOf = (receivedAt: string) => ({ received_at: receivedAt, ...rawLine });
    const features = detectFeatures();
    const outside = features.has('sources-updated')
      ? { sources: { take: async () => true, eventLine: (_id: string, receivedAt: string) => lineOf(receivedAt), images: async (): Promise<ImageContent[]> => [] } }
      : { slack: { eventLine: (_id: string, receivedAt: string) => lineOf(receivedAt), images: async (): Promise<ImageContent[]> => [] } };
    const dove = {
      ask(message: string): ToolOutcome {
        const parsed = parseDoveRequest(message);
        record.dove.push({ message, ok: parsed.ok });
        if (!parsed.ok) return { ok: false, text: parsed.text };
        const later = 'は、後で agent_reply の出来事（agent: poppo）として届きます。待たずに、ほかのことをしてかまいません。';
        return { ok: true, text: parsed.request.kind === 'reaction' ? `ポッポさんがリアクションの依頼を受け付けました。付けたかどうか${later}`
          : `ポッポさんが投稿の依頼を受け付けました。届けたか、本人に回したか、突き返したか${later}` };
      },
      takeEventLine: (_id: string, receivedAt: string) => ({ type: 'agent_reply', received_at: receivedAt, agent: DOVE_NAME }),
    };

    const logs: string[] = [];
    const limits = { modelCalls: options.limits?.modelCalls ?? scene.limits.modelCalls, minutes: options.limits?.minutes ?? scene.limits.minutes };
    const loopOptions = {
      db, dataDirectory: data, sessionDirectory, agentDirectory, target, thinking: real?.file.thinking ?? 'on',
      runtime: async () => runtime, configureSession, reviseSystemPrompt, now, log: (line: string) => logs.push(line),
      loop: { ...LOOP_DEFAULTS, timeZone: scene.timeZone, workspaceSocket: join(socketDirectory, 'runner.sock'),
        compactionThreshold: NO_COMPACTION,
        ...(limits.modelCalls === undefined ? {} : { eventModelCalls: limits.modelCalls }),
        ...(limits.minutes === undefined ? {} : { eventTimeoutMinutes: limits.minutes }) },
      ...(scene.dove ? { dove } : {}),
      ...outside,
    } as LoopOptions;
    const loop = await ThinkingLoop.open(loopOptions);
    closers.unshift(() => loop.close());
    if (promptError) throw new Error(promptError);
    if (loop.unavailable) throw new Error(`the thinking loop is unavailable (${loop.unavailable}; ${logs.at(-1) ?? 'no log'})`);
    const workspace = await options.runner.start({ data, manual, socketDirectory, sandbox, timeZone: scene.timeZone });
    closers.unshift(() => workspace.close());

    const hand = async (event: SceneEvent) => {
      let handed = true;
      if (event.kind === 'mac_message') loop.send({ requestId: `eval-${Math.random()}`, deviceId: 'eval', text: event.text });
      else if (event.kind === 'ping') handed = loop.ping();
      else {
        rawLine = event.line;
        if ('sources' in outside) handed = (loop as unknown as { raiseSourcesUpdated(): boolean }).raiseSourcesUpdated();
        // Before ADR 0050 a Slack mention was the kind raised from outside with a line of its own.
        else (loop as unknown as { raise(kind: string, record: () => void): void }).raise('slack-mention', () => undefined);
      }
      if (!handed) throw new Error(`the loop did not take the ${event.kind} event`);
      await loop.idle();
    };
    for (const turn of scene.context.prelude) {
      phase.answer = { calls: turn.calls };
      await hand(turn.event);
    }
    for (let index = 0; index < (scene.context.padding?.turns ?? 0); index += 1) {
      phase.answer = { thinking: padding(scene.context.padding!.chars, index) };
      await hand({ kind: 'ping' });
    }

    const shown: RunRecord['replies'] = [];
    loop.subscribe((event: LoopClientEvent) => {
      if (phase.now !== 'turn' || event.type !== 'conversation.message' || event.payload.role !== 'natsumi') return;
      // Shown by a tool of the call that last ended.
      shown.push({ kind: event.payload.kind === 'notice' ? 'notice' : 'reply', text: String(event.payload.text),
        expression: typeof event.payload.expression === 'string' ? event.payload.expression : null, call: callTimes.length });
    });
    const before = session!.messages.length;
    record.priorMessages = before;
    record.dove = [];
    phase.now = 'turn';
    const started = Date.now();
    await hand(condition.event);
    phase.now = 'after';
    record.ms = Date.now() - started;

    const row = db.prepare(`SELECT outcome, model_calls, input_tokens, cache_read_tokens, output_tokens, turn_ms FROM turn_stats
      ORDER BY rowid DESC LIMIT 1`).get() as { outcome: string; model_calls: number; input_tokens: number; cache_read_tokens: number;
        output_tokens: number; turn_ms: number } | undefined;
    if (!row) throw new Error(`the turn left no numbers (${logs.at(-1) ?? 'no log'})`);
    Object.assign(record, { outcome: row.outcome, modelCalls: row.model_calls, ms: row.turn_ms,
      tokens: { input: row.input_tokens, cacheRead: row.cache_read_tokens, output: row.output_tokens }, replies: shown });
    readTurn(session!.messages.slice(before), record, callTimes, callEnds.map(end => end - started));
    record.session = session!.sessionFile;
  } catch (error) {
    record.outcome = 'error';
    record.error = error instanceof Error ? error.message : String(error);
  } finally {
    for (const close of closers) { try { await close(); } catch { /* the run is over either way */ } }
  }
  if (record.outcome !== 'error') {
    try {
      const module = await loadSceneModule(scene.module, undefined);
      const judge = options.judge ?? (options.dryRun ? DRY_JUDGE : undefined);
      record.checks = await judgeChecks(record, condition.checks, { functions: module.functions, ...(judge ? { judge } : {}) });
    } catch (error) {
      record.outcome = 'error';
      record.error = `the checks could not be run (${(error as Error).message})`;
    }
  }
  return record;
}

/** The scene's copies, then its files, then its edits, each into the place the workspace shows it as. */
async function placeState(condition: Condition, data: string, manual: string): Promise<void> {
  const host = (path: string) => {
    const places: [string, string][] = [['/manual/agents', join(data, AGENT_LIST_DIRECTORY)], ['/manual', manual],
      ['/memory', join(data, 'memory')], ['/work', join(data, WORK_DIRECTORY)], ['/home/natsumi', join(data, HOME_DIRECTORY)],
      ['/sources', join(data, SOURCES_DIRECTORY)]];
    for (const [place, directory] of places) {
      if (path === place) return directory;
      if (path.startsWith(`${place}/`)) return join(directory, path.slice(place.length + 1));
    }
    throw new Error(`${path} is not a place of the workspace`);
  };
  for (const [path, from] of Object.entries(condition.copies)) await cp(from, host(path), { recursive: true });
  for (const [path, source] of Object.entries(condition.files)) {
    const file = host(path);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, 'text' in source ? source.text : await readFile(source.file));
  }
  for (const edit of condition.edits) {
    const file = host(edit.path);
    const text = await readFile(file, 'utf8').catch(() => { throw new Error(`${edit.path} is not there to edit`); });
    if (!text.includes(edit.replace)) throw new Error(`${edit.path} has no「${edit.replace}」to replace`);
    await writeFile(file, text.replace(edit.replace, edit.with));
  }
}

/** Thinking of a padding turn: filler of the length asked, different each turn so that nothing is repeated verbatim. */
function padding(chars: number, index: number): string {
  const line = `（水増し ${index + 1}）今日のことを思い返している。特に変わったことはない。`;
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}

/** The turn as the session recorded it, up to the memo request: its prompt, its calls and its tools. */
function readTurn(messages: AgentSession['messages'], record: RunRecord, callTimes: number[], callEnds: number[]): void {
  const end = messages.findIndex((message, index) => index > 0 && message.role === 'user' && textOf(message.content) === REFLECTION_REQUEST);
  const turn = end < 0 ? messages : messages.slice(0, end);
  const first = turn.find(message => message.role === 'user');
  record.prompt = first && first.role === 'user' ? textOf(first.content) : '';
  const block = /<events>\n([\s\S]*?)\n<\/events>/.exec(record.prompt)?.[1] ?? '';
  record.events = block.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return { line }; } });
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const message of turn) {
    if (message.role === 'toolResult') results.set(message.toolCallId, { text: textOf(message.content), isError: message.isError });
  }
  const calls: ModelCallRecord[] = [];
  const tools: ToolRecord[] = [];
  for (const message of turn) {
    if (message.role !== 'assistant') continue;
    const number = calls.length + 1;
    let thinkingChars = 0;
    let text = '';
    for (const part of message.content) {
      if (part.type === 'thinking') thinkingChars += [...part.thinking].length;
      if (part.type === 'text') text += part.text;
      if (part.type === 'toolCall') {
        const result = results.get(part.id);
        tools.push({ call: number, name: part.name, args: part.arguments as Record<string, unknown>, result: result?.text ?? '', isError: result?.isError ?? false });
      }
    }
    calls.push({ ms: callTimes[number - 1] ?? 0, ...(callEnds[number - 1] === undefined ? {} : { at: callEnds[number - 1] }), stopReason: message.stopReason, input: message.usage.input, cacheRead: message.usage.cacheRead,
      output: message.usage.output, thinkingChars, text });
  }
  record.calls = calls;
  record.tools = tools;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (part as { type: string; text?: string }).type === 'text' ? (part as { text: string }).text : '').join('');
}

export interface EvaluationOptions {
  scenes: string[];
  out: string;
  label: string;
  dryRun: boolean;
  repository: string;
  /** Overrides every scene's own count. */
  runs?: number;
  only?: { scenes?: string[]; variants?: string[] };
  model?: RunOptions['model'];
  judge?: Judge;
  sandbox?: Sandbox;
  memo?: RunOptions['memo'];
  limits?: RunOptions['limits'];
  concurrency?: number;
  /** What the branch has; found on the code when absent. */
  features?: Set<Feature>;
  log?: (line: string) => void;
}

/**
 * Every run of every condition, a round of each condition at a time so that a drifting endpoint weighs on all of them
 * alike, into `<out>/<label>/runs.jsonl`, with the summary beside it (ADR 0051).
 */
export async function runEvaluation(options: EvaluationOptions): Promise<{ records: RunRecord[]; summary: Summary; directory: string }> {
  const directory = join(options.out, options.label);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const log = options.log ?? (() => undefined);
  const features = options.features ?? detectFeatures();
  const skipped: Skipped[] = [];
  const chosen: { scene: Scene; conditions: Condition[] }[] = [];
  for (const scene of await loadScenes(options.scenes)) {
    if (options.only?.scenes && !options.only.scenes.includes(scene.name)) continue;
    const missing = scene.requires.filter(feature => !features.has(feature));
    if (missing.length > 0) { skipped.push({ scene: scene.name, reason: `requires ${missing.join(', ')}` }); continue; }
    const picked = conditions(scene).filter(condition => !options.only?.variants || options.only.variants.includes(condition.variant));
    if (picked.length > 0) chosen.push({ scene, conditions: picked });
  }
  const runner = await WorkspaceRunner.prepare({ repository: options.repository, cache: join(directory, 'runner') });
  const jobs: { condition: Condition; run: number }[] = [];
  const rounds = Math.max(0, ...chosen.map(({ scene }) => options.runs ?? scene.runs));
  for (let run = 1; run <= rounds; run += 1) {
    for (const { scene, conditions: list } of chosen) {
      if (run > (options.runs ?? scene.runs)) continue;
      for (const condition of list) jobs.push({ condition, run });
    }
  }
  const records: RunRecord[] = new Array(jobs.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      const job = jobs[index];
      if (!job) return;
      const record = await runCondition(job.condition, { run: job.run, dryRun: options.dryRun, repository: options.repository,
        work: join(directory, 'work'), runner, ...(options.model ? { model: options.model } : {}), ...(options.judge ? { judge: options.judge } : {}),
        ...(options.sandbox ? { sandbox: options.sandbox } : {}), ...(options.memo ? { memo: options.memo } : {}),
        ...(options.limits ? { limits: options.limits } : {}) });
      records[index] = record;
      done += 1;
      const passed = record.checks.filter(check => check.pass === true).length;
      log(`[${done}/${jobs.length}] ${record.scene} ${record.variant} #${record.run}: ${record.outcome}${record.error ? ` (${record.error})` : ''}`
        + ` ${passed}/${record.checks.length} checks, ${record.modelCalls} calls, ${(record.ms / 1000).toFixed(1)}s`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 1) }, worker));
  // Written in the order of the jobs, whatever order they finished in.
  for (const record of records) await appendFile(join(directory, 'runs.jsonl'), `${JSON.stringify(record)}\n`);
  const summary = summarize(records, skipped);
  await writeFile(join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(join(directory, 'summary.md'), summaryMarkdown(summary, options.label));
  return { records, summary, directory };
}
