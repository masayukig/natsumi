import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { LOOP_DEFAULTS, type LoopConfig } from '../src/server/config.ts';
import { STATE_DIRECTORY } from '../src/server/data-directory.ts';
import { readFoldStatus, writeFoldChoice } from '../src/server/fold-setting.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { REFLECTION_REQUEST } from '../src/server/prompts.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop, type LoopClientEvent, type LoopOptions } from '../src/server/thinking-loop.ts';
import { MEMO_HEADING } from '../src/server/turn-fold.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel, type ScriptedStep } from './support/scripted-model.ts';

// The memo after every turn and the fold of ended turns, inside the loop (ADR 0047).

type OpenOptions = Partial<Omit<LoopOptions, 'loop'>> & { loop?: Partial<LoopConfig> };

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
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-fold-')));
  const data = join(root, 'data');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  await mkdir(join(data, STATE_DIRECTORY), { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const model = new ScriptedModel();
  const sessions: AgentSession[] = [];
  const opened: ThinkingLoop[] = [];
  let counter = 0;
  return {
    root, data, db, model, sessions,
    async open({ loop: settings, ...options }: OpenOptions = {}) {
      const loop = await ThinkingLoop.open({
        db, dataDirectory: data, sessionDirectory, agentDirectory, target: SUBSCRIPTION_TARGET, thinking: 'on',
        runtime: fixtureRuntime, loop: { ...LOOP_DEFAULTS, eventModelCalls: 4, ...settings },
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
    async sessionText() {
      const files = (await readdir(sessionDirectory)).filter(name => name.endsWith('.jsonl'));
      return (await Promise.all(files.map(file => readFile(join(sessionDirectory, file), 'utf8')))).join('\n');
    },
    stats: () => db.prepare('SELECT * FROM turn_stats ORDER BY started_at, rowid').all() as Record<string, unknown>[],
    async cleanup() {
      for (const loop of opened) await loop.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });
/** Answers every turn the same way: she thinks, replies once, then stops. */
function replying(thinking: string): (context: Context) => ScriptedStep {
  return context => {
    const last = context.messages.at(-1)!;
    if (last.role === 'user') return { thinking, calls: [call('reply_to_mac', { text: `返事: ${thinking}`, expression: 'neutral' })] };
    return { thinking: `${thinking}（終わり）`, text: '済んだ' };
  };
}
const serialized = (context: Context) => JSON.stringify(context.messages);

test('after a turn the same session is asked for a one-line memo, with thinking as configured and without tools', async () => {
  const f = await setup();
  try {
    f.model.auto = replying('考えA');
    f.model.memo = () => ({ thinking: '書かないはずの思考', text: '予定は 15:00。' });
    const { loop } = await f.open();
    f.send(loop, 'こんにちは');
    await until(() => f.model.reflections.length === 1);
    await loop.idle();
    const [reflection] = f.model.reflections;
    // It follows the whole turn, so the request extends what the turn's last call was sent.
    const lastTurnCall = f.model.contexts.at(-1)!;
    assert.deepEqual(reflection!.context.messages.slice(0, lastTurnCall.messages.length), lastTurnCall.messages);
    assert.equal(reflection!.context.messages.at(-1)!.role, 'user');
    assert.equal(reflection!.context.systemPrompt, lastTurnCall.systemPrompt);
    // Thinking stays as configured: turning it off re-renders the turn on a Qwen template and loses the cache.
    assert.deepEqual(f.model.reasonings, ['medium', 'medium']);
    assert.equal(reflection!.reasoning, 'medium');
    assert.equal(f.sessions[0]!.thinkingLevel, 'medium');

    f.send(loop, 'もう一度');
    await until(() => f.model.reflections.length === 2);
    await loop.idle();
    assert.equal(f.model.reasonings.at(-1), 'medium');
  } finally { await f.cleanup(); }
});

test('a memo that calls a tool sends nothing, and the memo is one call', async () => {
  const f = await setup();
  try {
    f.model.auto = replying('考え');
    f.model.memo = () => ({ calls: [call('reply_to_mac', { text: '振り返りから話しかける', expression: 'happy' })] });
    const { loop, events } = await f.open();
    f.send(loop, 'やあ');
    await until(() => f.model.reflections.length === 1);
    await loop.idle();
    const said = events.filter(e => e.type === 'conversation.message' && e.payload.role === 'natsumi').map(e => e.payload.text);
    assert.deepEqual(said, ['返事: 考え']);
    assert.equal(f.model.reflections.length, 1);
  } finally { await f.cleanup(); }
});

test('a turn stopped at its call limit still gets a memo; one that failed on a model error does not', async () => {
  const f = await setup();
  try {
    f.model.auto = () => ({ calls: [call('list_self_checks', {})] });
    const { loop } = await f.open({ loop: { eventModelCalls: 2 } });
    f.send(loop, '一つ目');
    await until(() => f.model.reflections.length === 1);
    await loop.idle();
    f.model.auto = () => ({ finish: 'error' });
    f.send(loop, '二つ目');
    await until(() => f.model.contexts.length === 3);
    await loop.idle();
    assert.equal(f.model.reflections.length, 1);
  } finally { await f.cleanup(); }
});

test('an owner message that arrives during the memo waits for its own turn', async () => {
  const f = await setup();
  try {
    f.model.auto = replying('考え');
    let arrived: string | undefined;
    let loop!: ThinkingLoop;
    f.model.memo = () => {
      if (!arrived) arrived = f.send(loop, '振り返り中に届いた').eventId;
      return 'メモ';
    };
    ({ loop } = await f.open());
    f.send(loop, '最初');
    await until(() => f.model.reflections.length === 2);
    await loop.idle();
    // The memo request is the last thing its call saw; the message came as the prompt of the next turn.
    assert.equal(JSON.stringify(f.model.reflections[0]!.context.messages.at(-1)).includes('振り返り中に届いた'), false);
    const prompts = f.model.contexts.map(context => JSON.stringify(context.messages.at(-1)));
    assert.equal(prompts.filter(prompt => prompt.includes('振り返り中に届いた')).length, 1);
  } finally { await f.cleanup(); }
});

test('folding is off by default: the next turn sees the whole record, the memo request included', async () => {
  const f = await setup();
  try {
    f.model.auto = replying('一つ目の思考');
    const { loop } = await f.open();
    f.send(loop, '一つ目');
    await until(() => f.model.reflections.length === 1);
    await loop.idle();
    f.model.auto = replying('二つ目の思考');
    f.send(loop, '二つ目');
    await until(() => f.model.reflections.length === 2);
    await loop.idle();
    const second = serialized(f.model.contexts[2]!);
    assert.match(second, /"thinking":"一つ目の思考"/);
    assert.ok(second.includes(JSON.stringify(REFLECTION_REQUEST).slice(1, 20)));
    assert.equal(second.includes(MEMO_HEADING), false);
  } finally { await f.cleanup(); }
});

test('folding on: ended turns are folded before each call, the turn in progress is not, and the record keeps everything', async () => {
  const f = await setup();
  try {
    f.model.auto = replying('一つ目の思考');
    f.model.memo = () => '一つ目で分かったこと。';
    const { loop } = await f.open({ loop: { turnFold: 'on' } });
    f.send(loop, '一つ目');
    await until(() => f.model.reflections.length === 1);
    await loop.idle();
    f.model.auto = replying('二つ目の思考');
    f.send(loop, '二つ目');
    await until(() => f.model.reflections.length === 2);
    await loop.idle();
    const [, , secondStart, secondEnd] = f.model.contexts.map(serialized);
    assert.doesNotMatch(secondStart!, /"thinking":"一つ目の思考/);
    assert.match(secondStart!, /返事: 一つ目の思考/);
    assert.ok(secondStart!.includes(`${MEMO_HEADING}一つ目で分かったこと。`));
    // Within the turn she is working on, her own thinking stays.
    assert.match(secondEnd!, /"thinking":"二つ目の思考"/);
    // The memo request follows the unfolded turn, so the second turn's own calls are a prefix of it.
    assert.match(serialized(f.model.reflections[1]!.context), /"thinking":"二つ目の思考"/);
    // The session file is never rewritten: it still holds the first turn's thinking.
    assert.match(await f.sessionText(), /"thinking":"一つ目の思考"/);
  } finally { await f.cleanup(); }
});

test('the fold is switched between turns by the choice the command line writes, and off gives the record back', async () => {
  const f = await setup();
  try {
    f.model.auto = replying('一つ目の思考');
    const { loop } = await f.open();
    assert.deepEqual(await readFoldStatus(f.data), { inUse: 'off', defaultFold: 'off', chosen: null });
    f.send(loop, '一つ目');
    await until(() => f.model.reflections.length === 1);
    await loop.idle();

    await writeFoldChoice(f.data, 'on', Date.now());
    f.send(loop, '二つ目');
    await until(() => f.model.reflections.length === 2);
    await loop.idle();
    assert.doesNotMatch(serialized(f.model.contexts[2]!), /"thinking":"一つ目の思考"/);
    assert.deepEqual(await readFoldStatus(f.data), { inUse: 'on', defaultFold: 'off', chosen: 'on' });

    await writeFoldChoice(f.data, 'off', Date.now());
    f.send(loop, '三つ目');
    await until(() => f.model.reflections.length === 3);
    await loop.idle();
    assert.match(serialized(f.model.contexts[4]!), /"thinking":"一つ目の思考"/);
    assert.deepEqual(await readFoldStatus(f.data), { inUse: 'off', defaultFold: 'off', chosen: 'off' });
  } finally { await f.cleanup(); }
});

test('the nightly review is held on the folded context when folding is on', async () => {
  const f = await setup();
  try {
    f.model.auto = replying('昼の思考');
    const { loop } = await f.open({ loop: { turnFold: 'on' } });
    f.send(loop, '昼');
    await until(() => f.model.reflections.length === 1);
    await loop.idle();
    f.model.auto = context => JSON.stringify(context.messages.at(-1)).includes('nightly_review')
      ? { calls: [call('write_handoff_note', { text: '引き継ぎ' })] } : '済んだ';
    const rotation = loop.rotate();
    assert.equal((await rotation).result, 'switched');
    const review = f.model.contexts.find(context => JSON.stringify(context.messages.at(-1)).includes('nightly_review'))!;
    assert.doesNotMatch(serialized(review), /"thinking":"昼の思考/);
    assert.ok(serialized(review).includes(MEMO_HEADING));
    // The review is not asked for a memo: the session ends with it.
    assert.equal(f.model.reflections.length, 1);
  } finally { await f.cleanup(); }
});

test('every turn leaves one row of numbers, never a word of what was said', async () => {
  const f = await setup();
  try {
    let clock = Date.parse('2026-09-26T01:00:00Z');
    const reply = replying('考え');
    f.model.auto = context => {
      clock += 2_000;
      return { ...reply(context), usage: { input: 100, cacheRead: 900, output: 50 } };
    };
    f.model.memo = () => { clock += 500; return { text: '秘密のメモ本文', usage: { input: 20, cacheRead: 1_000, output: 10 } }; };
    const { loop } = await f.open({ now: () => clock });
    f.send(loop, '秘密の質問');
    await until(() => f.model.reflections.length === 1);
    await loop.idle();
    const [row] = f.stats();
    assert.equal(f.stats().length, 1);
    assert.equal(row!.fold, 'off');
    assert.equal(row!.route, 'default');
    assert.equal(row!.event_kinds, 'mac_message');
    assert.equal(row!.outcome, 'ok');
    assert.equal(row!.model_calls, 2);
    // The reply was the first call's: two seconds after the message arrived.
    assert.equal(row!.first_out_ms, 2_000);
    assert.equal(row!.turn_ms, 4_000);
    assert.equal(row!.input_tokens, 200);
    assert.equal(row!.cache_read_tokens, 1_800);
    assert.equal(row!.output_tokens, 100);
    assert.equal(row!.context_tokens, 1_000);
    assert.equal(row!.reflection_ms, 500);
    assert.equal(row!.reflection_input_tokens, 20);
    assert.equal(row!.reflection_cache_read_tokens, 1_000);
    assert.equal(row!.reflection_output_tokens, 10);
    assert.equal(row!.compacted, 0);
    assert.doesNotMatch(JSON.stringify(f.stats()), /秘密/);
  } finally { await f.cleanup(); }
});

test('a turn with no reply records no time to it, and a failed turn records its reason and no memo', async () => {
  const f = await setup();
  try {
    f.model.auto = () => '何もしない';
    const { loop } = await f.open();
    f.send(loop, '一つ目');
    await until(() => f.model.reflections.length === 1);
    await loop.idle();
    f.model.auto = () => ({ finish: 'error' });
    f.send(loop, '二つ目');
    await until(() => f.stats().length === 2);
    const [quiet, failed] = f.stats();
    assert.equal(quiet!.first_out_ms, null);
    assert.equal(failed!.outcome, 'model-error');
    assert.equal(failed!.reflection_ms, null);
  } finally { await f.cleanup(); }
});

test('the fold in use is published for the command line, and a choice file left by hand is read on start', async () => {
  const f = await setup();
  try {
    await writeFile(join(f.data, STATE_DIRECTORY, 'turn-fold.json'), '{"fold":"on"}\n');
    const { loop } = await f.open();
    assert.deepEqual(await readFoldStatus(f.data), { inUse: 'on', defaultFold: 'off', chosen: 'on' });
    await loop.idle();
  } finally { await f.cleanup(); }
});

test('signs of her losing her way are counted per turn: repeats, tool errors, refusals and messages left unanswered', async () => {
  const f = await setup();
  try {
    const script: ScriptedStep[] = [
      // Turn 1: runs a command and reads a file, then replies. With no runner here both fail as unknown tools, which
      // still counts: what is measured is that she asked again.
      { calls: [call('run_shell', { command: 'rg 予定  /memory' }), call('read', { path: '/memory/a.md' })] },
      { calls: [call('reply_to_mac', { text: 'はい', expression: 'neutral' })] },
      { text: '済んだ' },
      // Turn 2: the same lookups again, one tool error, and no reply to the owner.
      { calls: [call('run_shell', { command: ' rg 予定 /memory ' }), call('read', { path: '/memory/a.md' }),
        call('cancel_self_check', { check_id: 'none' })] },
      { text: '返事をしないで終わる' },
    ];
    f.model.auto = () => script.shift() ?? '済んだ';
    const { loop } = await f.open();
    f.send(loop, '一つ目');
    await until(() => f.stats().length === 1);
    f.send(loop, '二つ目');
    await until(() => f.stats().length === 2);
    await loop.idle();
    const [first, second] = f.stats();
    assert.deepEqual([first!.repeated_calls, first!.tool_errors, first!.unanswered_messages], [0, 2, 0]);
    // The command differs only in its spaces, so it is the same one.
    assert.deepEqual([second!.repeated_calls, second!.tool_errors, second!.unanswered_messages], [2, 3, 1]);
    assert.equal(second!.dove_refusals, 0);
  } finally { await f.cleanup(); }
});

test('the memo request asks for one or two sentences, and for "なし" alone when there is nothing', () => {
  assert.match(REFLECTION_REQUEST, /1〜2 文/);
  assert.match(REFLECTION_REQUEST, /100 字/);
  assert.match(REFLECTION_REQUEST, /「なし」/);
});
