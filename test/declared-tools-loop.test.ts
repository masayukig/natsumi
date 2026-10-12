import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { CURATOR_DEFAULTS, DEFAULT_CODEMODE, LOOP_DEFAULTS, type CodemodeConfig, type CuratorConfig, type DeclaredToolConfig,
  type LoopConfig } from '../src/server/config.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { curatorSystemPrompt } from '../src/server/prompts.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop, type LoopClientEvent, type LoopOptions } from '../src/server/thinking-loop.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { startFakeRunner, type FakeRunner } from './support/fake-runner.ts';
import { ScriptedModel, type ScriptedStep } from './support/scripted-model.ts';

// The tools the config declares, in natsumi's session (ADR 0075): never in the curator's. Fictional memories only.

type OpenOptions = Partial<Omit<LoopOptions, 'loop' | 'curator'>> & { loop?: Partial<LoopConfig>; curator?: Partial<CuratorConfig> };

const ON: CodemodeConfig = { ...DEFAULT_CODEMODE, enabled: true };
/** Every tool natsumi has with a workspace, in the order they are declared with Codemode off. */
const LOOP_TOOLS = ['run_shell', 'reply_to_mac', 'notify_owner', 'set_mac_avatar_expression', 'write_handoff_note', 'write_change_note',
  'schedule_self_check', 'list_self_checks', 'cancel_self_check', 'ask_agent', 'read', 'search_memory'];

async function until<T>(check: () => T | undefined | false, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** What stands in for /tools: the programs the declarations below name. */
const PROGRAMS: Record<string, string> = {
  '/tools/weather': 'read -r line; echo "WEATHER $* $line"',
  '/tools/count': 'echo COUNT',
};
const tool = (fields: Partial<DeclaredToolConfig>): DeclaredToolConfig => ({
  name: 'weather', description: '天気を調べる。', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  exposure: 'model-only', command: ['/tools/weather', '--metric'], timeoutSeconds: 5, maxOutputChars: 8000, ...fields,
});
const TOOLS = [tool({}), tool({ name: 'count', description: '数える。', parameters: { type: 'object', properties: {} }, command: ['/tools/count'],
  exposure: 'codemode' })];

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-declared-loop-')));
  const data = join(root, 'data');
  const memory = join(data, 'memory');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  await mkdir(memory, { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(join(memory, '予定.md'), '# 予定\n\n- 歯医者は金曜\n');
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const model = new ScriptedModel();
  const sessions: AgentSession[] = [];
  const opened: ThinkingLoop[] = [];
  let runner: FakeRunner | undefined;
  let counter = 0;
  const f = {
    root, data, memory, db, model, sessions,
    get runner() { return runner!; },
    async open({ loop: settings, curator, ...options }: OpenOptions = {}, workspace = true) {
      runner ??= await startFakeRunner({ dir: memory, programs: PROGRAMS });
      const loop = await ThinkingLoop.open({
        db, dataDirectory: data, sessionDirectory, agentDirectory, target: SUBSCRIPTION_TARGET, thinking: 'on',
        runtime: fixtureRuntime,
        loop: { ...LOOP_DEFAULTS, timeZone: 'Asia/Tokyo', ...(workspace ? { workspaceSocket: runner.path } : {}), ...settings },
        // The tests run at the wall clock's time: the morning deadline is only where a test names one.
        curator: { ...CURATOR_DEFAULTS, stopStartingAt: false, ...curator },
        configureSession: session => { session.agent.streamFunction = model.streamFunction; sessions.push(session); },
        ...options,
      });
      opened.push(loop);
      const events: LoopClientEvent[] = [];
      loop.subscribe(event => { events.push(event); });
      return { loop, events };
    },
    send(loop: ThinkingLoop, text: string) {
      const outcome = loop.send({ requestId: `request-${++counter}`, deviceId: 'device-1', text });
      assert.equal(outcome.kind, 'accepted');
      return outcome as Extract<typeof outcome, { kind: 'accepted' }>;
    },
    replies: () => (db.prepare(`SELECT text FROM conversation_messages WHERE kind = 'reply'`).all() as { text: string }[]).map(row => row.text),
    stats: () => db.prepare('SELECT * FROM turn_stats ORDER BY started_at, rowid').all() as Record<string, unknown>[],
    async cleanup() {
      for (const loop of opened) await loop.close();
      await runner?.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  return f;
}

const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });
const script = (code: string) => call('codemode', { code });
/** A turn's last model call: she stops without a tool. */
const DONE: ScriptedStep = { text: '済んだ' };
const reply = (text = 'はい') => ({ calls: [call('reply_to_mac', { text, expression: 'neutral' })] });
const textOf = (message: Context['messages'][number]) => {
  const content = (message as { content: unknown }).content;
  if (typeof content === 'string') return content;
  return (content as { type: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text).join('');
};
/** What the model was handed back for each codemode call, in order. */
const scriptResults = (contexts: Context[]) => {
  const results = new Map<string, string>();
  for (const context of contexts) {
    for (const message of context.messages) {
      if (message.role === 'toolResult' && message.toolName === 'codemode') results.set(message.toolCallId, textOf(message));
    }
  }
  return [...results.values()];
};
/** Plays the steps in order, one per model call, then stops. */
function playing(f: Awaited<ReturnType<typeof setup>>, steps: ScriptedStep[]) {
  f.model.auto = () => steps.shift() ?? { text: '済んだ' };
}
const isCurator = (context: Context) => context.systemPrompt?.startsWith(curatorSystemPrompt('なつみ')) === true;

test('the declared tools come after every built-in one, and a call runs the program with the arguments on stdin', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open({ tools: TOOLS });
    const session = f.sessions.at(-1)!;
    assert.deepEqual(session.getActiveToolNames(), [...LOOP_TOOLS, 'weather', 'count']);
    playing(f, [{ calls: [call('weather', { city: '東京' })] }, reply('晴れ')]);
    f.send(loop, '天気は？');
    await loop.idle();
    assert.deepEqual(f.runner.tools, [{ argv: ['/tools/weather', '--metric'], stdin: '{"city":"東京"}', timeoutSeconds: 5 }]);
    const results = f.model.contexts.flatMap(context => context.messages)
      .filter(message => message.role === 'toolResult' && message.toolName === 'weather').map(textOf);
    assert.equal(results[0], 'WEATHER --metric {"city":"東京"}\n');
    assert.deepEqual(f.replies(), ['晴れ']);
  } finally { await f.cleanup(); }
});

test('without tools in the config, the tools are the ones natsumi always had', async () => {
  const f = await setup();
  try {
    await f.open();
    assert.deepEqual(f.sessions.at(-1)!.getActiveToolNames(), LOOP_TOOLS);
  } finally { await f.cleanup(); }
});

test('a declared tool called again with the same arguments counts as a repeat, as run_shell does', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open({ tools: TOOLS });
    playing(f, [
      { calls: [call('weather', { city: '東京' })] }, { calls: [call('weather', { city: '東京' })] },
      { calls: [call('weather', { city: '大阪' })] }, reply(), DONE,
    ]);
    f.send(loop, '天気は？');
    await until(() => f.stats().length === 1);
    await loop.idle();
    assert.equal(f.runner.tools.length, 3);
    assert.equal(f.stats()[0]!.repeated_calls, 1);
  } finally { await f.cleanup(); }
});

test('while the memo is written, a declared tool is refused like every other tool', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open({ tools: TOOLS });
    playing(f, [reply()]);
    f.model.memo = () => ({ calls: [call('weather', { city: '東京' })] });
    f.send(loop, 'こんにちは');
    await loop.idle();
    await until(() => f.model.reflections.length === 1);
    await loop.idle();
    assert.deepEqual(f.runner.tools, []);
  } finally { await f.cleanup(); }
});

test('with Codemode on, a script reaches the tools declared direct or codemode, and the model does not see the codemode one', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open({ tools: [tool({ exposure: 'direct' }), TOOLS[1]!], loop: { codemode: ON } });
    const session = f.sessions.at(-1)!;
    assert.deepEqual(session.getActiveToolNames(), [...LOOP_TOOLS, 'weather', 'codemode']);
    assert.deepEqual(session.getCallableToolNames().sort(), ['count', 'read', 'run_shell', 'search_memory', 'weather']);
    playing(f, [
      { calls: [script(`const a = await tools.weather({ city: '札幌' }); const b = await tools.count({}); return a + b;`)] },
      reply(),
    ]);
    f.send(loop, '調べて');
    await loop.idle();
    assert.deepEqual(f.runner.tools.map(request => request.argv[0]), ['/tools/weather', '/tools/count']);
    assert.match(scriptResults(f.model.contexts)[0]!, /WEATHER --metric \{"city":"札幌"\}/);
  } finally { await f.cleanup(); }
});

test('a tool declared model-only stays out of scripts with Codemode on', async () => {
  const f = await setup();
  try {
    await f.open({ tools: [tool({})], loop: { codemode: ON } });
    const session = f.sessions.at(-1)!;
    assert.ok(session.getActiveToolNames().includes('weather'));
    assert.ok(!session.getCallableToolNames().includes('weather'));
  } finally { await f.cleanup(); }
});

test('the curator is never given a declared tool', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open({ tools: TOOLS });
    f.model.auto = context => {
      if (context.messages.at(-1)?.role === 'assistant') return { calls: [] };
      if (isCurator(context)) return { calls: [call('write_change_note', { text: '整理した' })] };
      const last = textOf(context.messages.at(-1)!);
      if (last.includes('"nightly_review"')) return { calls: [call('write_handoff_note', { text: '明日も続き' })] };
      if (context.messages.at(-1)?.role !== 'user') return { calls: [] };
      return reply();
    };
    f.send(loop, '今日の話');
    await loop.idle();
    assert.equal((await loop.rotate()).result, 'switched');
    const curator = f.sessions.find(candidate => candidate.systemPrompt.startsWith(curatorSystemPrompt('なつみ')))!;
    const names = curator.getAllTools().map(defined => defined.name);
    assert.ok(!names.includes('weather') && !names.includes('count'), names.join(','));
    // The new session after the switch has them again.
    assert.deepEqual(f.sessions.at(-1)!.getActiveToolNames(), [...LOOP_TOOLS, 'weather', 'count']);
  } finally { await f.cleanup(); }
});
