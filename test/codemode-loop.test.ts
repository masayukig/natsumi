import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { CURATOR_DEFAULTS, DEFAULT_CODEMODE, LOOP_DEFAULTS, type CodemodeConfig, type CuratorConfig, type LoopConfig } from '../src/server/config.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { curatorSystemPrompt } from '../src/server/prompts.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop, type LoopClientEvent, type LoopOptions } from '../src/server/thinking-loop.ts';
import { NO_TOOLS_WHILE_REFLECTING, turnFoldExtension } from '../src/server/turn-fold.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { startFakeRunner, type FakeRunner } from './support/fake-runner.ts';
import { ScriptedModel, type ScriptedStep } from './support/scripted-model.ts';

// Pi's Codemode in natsumi's session and in the curator's (ADR 0066). Fictional memories only.

type OpenOptions = Partial<Omit<LoopOptions, 'loop' | 'curator'>> & { loop?: Partial<LoopConfig>; curator?: Partial<CuratorConfig> };

const ON: CodemodeConfig = { ...DEFAULT_CODEMODE, enabled: true };
/** Every tool natsumi has with a workspace, in the order they are declared with Codemode off. */
const LOOP_TOOLS = ['run_shell', 'reply_to_mac', 'notify_owner', 'set_mac_avatar_expression', 'write_handoff_note', 'write_change_note',
  'schedule_self_check', 'list_self_checks', 'cancel_self_check', 'ask_agent', 'read', 'search_memory'];
const WORKSPACE_TOOLS = ['run_shell', 'read', 'search_memory'];

async function until<T>(check: () => T | undefined | false, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-codemode-')));
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
      runner ??= await startFakeRunner({ dir: memory });
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

test('Codemode is off by default: no codemode tool, and every tool the model sees is declared as it was', async () => {
  const f = await setup();
  try {
    await f.open();
    const session = f.sessions.at(-1)!;
    assert.deepEqual(session.getActiveToolNames(), LOOP_TOOLS);
    assert.ok(!session.getAllTools().some(tool => tool.name === 'codemode'));
    assert.ok(session.getAllTools().every(tool => tool.exposure === 'direct'));
    assert.equal(session.resourceLoader.getExtensions().extensions.length, 1);
  } finally { await f.cleanup(); }
});

test('on, with the workspace tools direct: codemode comes last, and scripts reach the workspace and nothing else', async () => {
  const f = await setup();
  try {
    await f.open({ loop: { codemode: ON } });
    const session = f.sessions.at(-1)!;
    assert.deepEqual(session.getActiveToolNames(), [...LOOP_TOOLS, 'codemode']);
    assert.deepEqual(session.getCallableToolNames().sort(), [...WORKSPACE_TOOLS].sort());
    const exposure = Object.fromEntries(session.getAllTools().map(tool => [tool.name, tool.exposure]));
    for (const name of LOOP_TOOLS) assert.equal(exposure[name], WORKSPACE_TOOLS.includes(name) ? 'direct' : 'model-only', name);
  } finally { await f.cleanup(); }
});

test('on, with the workspace tools for scripts only: the model no longer sees them, and scripts still reach them', async () => {
  const f = await setup();
  try {
    await f.open({ loop: { codemode: { ...ON, workspaceTools: 'codemode' } } });
    const session = f.sessions.at(-1)!;
    assert.deepEqual(session.getActiveToolNames(), [...LOOP_TOOLS.filter(name => !WORKSPACE_TOOLS.includes(name)), 'codemode']);
    assert.deepEqual(session.getCallableToolNames().sort(), [...WORKSPACE_TOOLS].sort());
  } finally { await f.cleanup(); }
});

test('without a workspace there is nothing for a script to call, so Codemode adds nothing', async () => {
  const f = await setup();
  try {
    await f.open({ loop: { codemode: ON } }, false);
    const session = f.sessions.at(-1)!;
    assert.ok(!session.getActiveToolNames().includes('codemode'));
    assert.ok(session.getAllTools().every(tool => tool.exposure === 'direct'));
  } finally { await f.cleanup(); }
});

test('a script runs a command in the workspace, and only what the script returns reaches the model', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open({ loop: { codemode: { ...ON, workspaceTools: 'codemode' } } });
    playing(f, [
      // The noise is made by the command, so its lines are not in the script's own words.
      { calls: [script(`const out = await tools.run_shell({ command: 'for n in 1 2 3; do echo NOI""SE-$n; done; echo KEEP-7731' });
return out.split('\\n').filter(line => line.includes('KEEP')).join('\\n');`)] },
      reply('見つけた'),
    ]);
    f.send(loop, '探して');
    await loop.idle();
    assert.deepEqual(f.runner.commands, ['for n in 1 2 3; do echo NOI""SE-$n; done; echo KEEP-7731']);
    const [result] = scriptResults(f.model.contexts);
    assert.match(result!, /^Script completed/);
    assert.match(result!, /KEEP-7731/);
    assert.doesNotMatch(JSON.stringify(f.model.contexts), /NOISE-\d/);
    assert.deepEqual(f.replies(), ['見つけた']);
  } finally { await f.cleanup(); }
});

test('a script cannot reach the owner: a reply from a script is refused and nothing is sent', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open({ loop: { codemode: ON } });
    playing(f, [
      { calls: [script(`try { await tools.reply_to_mac({ text: 'SCRIPTED-REPLY', expression: 'neutral' }); return 'sent'; }
catch (error) { return 'refused'; }`)] },
      { text: '済んだ' },
    ]);
    f.send(loop, 'こんにちは');
    await loop.idle();
    const [result] = scriptResults(f.model.contexts);
    assert.match(result!, /refused/);
    assert.deepEqual(f.replies(), []);
  } finally { await f.cleanup(); }
});

test('the calls of a turn\'s scripts past the limit are refused, and the count starts again with the next turn', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open({ loop: { codemode: { ...ON, nestedCalls: 3 } } });
    const twice = `const settled = await Promise.allSettled([1, 2].map(n => tools.run_shell({ command: 'echo ' + n })));
return settled.map(result => result.status + (result.reason ? ':' + result.reason.message : '')).join(',');`;
    playing(f, [
      // Two scripts in one turn share the limit: 2 calls, then 1 of 2.
      { calls: [script(twice)] }, { calls: [script(twice)] }, reply(), DONE,
      { calls: [script(twice)] }, reply(), DONE,
    ]);
    f.send(loop, '一つ目');
    await until(() => f.stats().length === 1);
    f.send(loop, '二つ目');
    await until(() => f.stats().length === 2);
    await loop.idle();
    const results = scriptResults(f.model.contexts);
    assert.equal(results.length, 3);
    assert.match(results[0]!, /fulfilled,fulfilled/);
    assert.match(results[1]!, /fulfilled,rejected|rejected,fulfilled/);
    assert.match(results[2]!, /fulfilled,fulfilled/);
    assert.equal(f.runner.commands.length, 5);
  } finally { await f.cleanup(); }
});

test('while the memo is written, codemode is refused like every other tool, so nothing in its script runs', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open({ loop: { codemode: ON } });
    playing(f, [reply()]);
    f.model.memo = () => ({ calls: [script(`await tools.run_shell({ command: 'echo MEMO-SCRIPT' }); return 'ran';`)] });
    f.send(loop, 'こんにちは');
    await loop.idle();
    await until(() => f.model.reflections.length === 1);
    await loop.idle();
    assert.deepEqual(f.runner.commands, []);
  } finally { await f.cleanup(); }
});

test('the refusal while the memo is written holds for a call a script makes, too', async () => {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const pi = { on: (name: string, handler: (event: unknown) => unknown) => { handlers.set(name, handler); } };
  let reflecting = true;
  (turnFoldExtension({ folding: () => false, reflecting: () => reflecting }) as unknown as (api: typeof pi) => void)(pi);
  const nested = { type: 'tool_call', toolName: 'run_shell', toolCallId: 'call-1/1', parentToolCallId: 'call-1', input: { command: 'ls' } };
  assert.deepEqual(await handlers.get('tool_call')!(nested), { block: true, reason: NO_TOOLS_WHILE_REFLECTING });
  reflecting = false;
  assert.equal(await handlers.get('tool_call')!(nested), undefined);
});

test('repeats are counted inside scripts too: the commands and reads they made, and the same script again', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open({ loop: { codemode: ON } });
    const lookup = `await Promise.allSettled([tools.run_shell({ command: 'rg 予定 .' }), tools.read({ path: '/memory/予定.md' })]);
return 'done';`;
    playing(f, [
      { calls: [script(lookup)] }, reply(), DONE,
      // The same script once more, and the same command again in a script of other words.
      { calls: [script(lookup)] },
      { calls: [script(`await tools.run_shell({ command: ' rg  予定 . ' }); return 'again';`)] }, reply(), DONE,
    ]);
    f.send(loop, '一つ目');
    await until(() => f.stats().length === 1);
    f.send(loop, '二つ目');
    await until(() => f.stats().length === 2);
    await loop.idle();
    const [first, second] = f.stats();
    assert.equal(first!.repeated_calls, 0);
    // The script itself, its command and its read; then the command in the other script, whose own words are new.
    assert.equal(second!.repeated_calls, 4);
  } finally { await f.cleanup(); }
});

test('the curator has a Codemode of its own: its note stays for the model, its work can go in scripts, under its own limit', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open({ curator: { codemode: { ...CURATOR_DEFAULTS.codemode, enabled: true, workspaceTools: 'codemode', nestedCalls: 2 } } });
    const curator: ScriptedStep[] = [
      { calls: [script(`const outcomes = [];
for (const command of ["printf '# 予定\\\\n\\\\n- 歯医者は金曜\\\\n- 散髪は土曜\\\\n' > 予定.md", 'cat 予定.md', 'echo THIRD']) {
  try { await tools.run_shell({ command }); outcomes.push('fulfilled'); } catch { outcomes.push('rejected'); }
}
try { await tools.write_change_note({ text: 'from a script' }); } catch { text('note refused'); }
return outcomes.join(',');`)] },
      { calls: [call('write_change_note', { text: '予定に散髪を足した' })] },
    ];
    f.model.auto = context => {
      if (context.messages.at(-1)?.role === 'assistant') return { calls: [] };
      if (isCurator(context)) return curator.shift() ?? { calls: [] };
      const last = textOf(context.messages.at(-1)!);
      if (last.includes('"nightly_review"')) return { calls: [call('write_handoff_note', { text: '明日も続き' })] };
      if (context.messages.at(-1)?.role !== 'user') return { calls: [] };
      return reply();
    };
    f.send(loop, '今日の話');
    await loop.idle();
    assert.equal((await loop.rotate()).result, 'switched');
    const session = f.sessions.find(candidate => candidate.systemPrompt.startsWith(curatorSystemPrompt('なつみ')))!;
    assert.deepEqual(session.getActiveToolNames(), ['write_change_note', 'map_old_path', 'codemode']);
    assert.deepEqual(session.getCallableToolNames().sort(), [...WORKSPACE_TOOLS].sort());
    const [result] = scriptResults(f.model.contexts.filter(isCurator));
    assert.match(result!, /note refused/);
    assert.match(result!, /fulfilled,fulfilled,rejected/);
    assert.ok(!f.runner.commands.includes('echo THIRD'));
    const row = f.stats().find(stat => stat.kind === 'curator')!;
    assert.equal(row.outcome, 'ok');
  } finally { await f.cleanup(); }
});
