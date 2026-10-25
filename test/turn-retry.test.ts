import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { LOOP_DEFAULTS, type LoopConfig } from '../src/server/config.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop, type LoopClientEvent } from '../src/server/thinking-loop.ts';
import { hadOutsideEffect, TurnRetries } from '../src/server/turn-retry.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel, type ScriptedStep } from './support/scripted-model.ts';

/** Fork (ADR F08): an event turn whose model call failed with nothing sent is tried once more, then told as F05 does. */

const DELAY_MS = 20;

async function setup(t: test.TestContext, settings: Partial<LoopConfig> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-turn-retry-')));
  const data = join(root, 'data');
  await mkdir(data);
  await mkdir(join(root, 'pi', 'sessions'), { recursive: true });
  await mkdir(join(root, 'pi', 'agent'), { recursive: true });
  await writeFile(join(data, 'personality.md'), '# 性格・話し方\n落ち着いた話し方\n');
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const model = new ScriptedModel();
  const events: LoopClientEvent[] = [];
  const logs: string[] = [];
  const loop = await ThinkingLoop.open({
    db, dataDirectory: data, sessionDirectory: join(root, 'pi', 'sessions'), agentDirectory: join(root, 'pi', 'agent'), target: SUBSCRIPTION_TARGET,
    thinking: 'on', runtime: fixtureRuntime, loop: { ...LOOP_DEFAULTS, ...settings }, tellCutShort: true, retryFailedTurns: { delayMs: DELAY_MS },
    configureSession: session => { session.agent.streamFunction = model.streamFunction; }, log: line => { logs.push(line); },
  });
  loop.subscribe(event => { events.push(event); });
  t.after(async () => {
    await loop.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  /** Sends a message and waits for its turn, and for a retry's, if one comes. */
  const send = async (text: string) => {
    const outcome = loop.send({ requestId: `request-${text}`, deviceId: 'device-1', text });
    assert.equal(outcome.kind, 'accepted');
    await loop.idle();
    await new Promise(resolve => setTimeout(resolve, DELAY_MS * 4));
    await loop.idle();
  };
  const notices = () => events.filter(e => e.type === 'conversation.message' && e.payload.kind === 'notice').map(e => e.payload.text);
  const retries = () => logs.filter(line => line.includes('retrying once')).length;
  const state = () => ({ ...db.prepare('SELECT state, reason FROM loop_events ORDER BY created_at DESC LIMIT 1').get() as { state: string; reason: string | null } });
  return { model, send, notices, retries, state };
}

/** Answers each user turn with `first` and every later call with `then`. */
const script = (first: () => ScriptedStep, then: () => ScriptedStep = () => ({ calls: [] })) =>
  (context: { messages: { role: string }[] }) => context.messages.at(-1)?.role === 'user' ? first() : then();

test('a model error with nothing sent is tried once; when the retry fails too, the owner is told', async t => {
  const f = await setup(t);
  f.model.auto = script(() => ({ finish: 'error' }));
  await f.send('PDF を読んで');
  assert.equal(f.retries(), 1);
  assert.deepEqual(f.notices(), ['マスターのメッセージへの対応が途中で止まりました（モデルの呼び出しが失敗しました）。返事が届いていなければ、もう一度話しかけてください。']);
  assert.deepEqual(f.state(), { state: 'failed', reason: 'model-error' });
});

test('a retry that works answers the message, and the owner is told nothing', async t => {
  const f = await setup(t);
  let failed = false;
  f.model.auto = script(() => {
    if (!failed) { failed = true; return { finish: 'error' }; }
    return { calls: [{ name: 'reply_to_mac', arguments: { text: 'はい', expression: 'neutral' } }] };
  });
  await f.send('元気？');
  assert.deepEqual([f.retries(), f.notices()], [1, []]);
  assert.equal(f.state().state, 'replied');
});

test('a model error after a reply left the server is not tried again; the owner is told', async t => {
  const f = await setup(t);
  f.model.auto = script(() => ({ calls: [{ name: 'reply_to_mac', arguments: { text: '今調べます', expression: 'neutral' } }] }), () => ({ finish: 'error' }));
  await f.send('PDF を読んで');
  assert.equal(f.retries(), 0);
  assert.equal(f.notices().length, 1);
});

test('a turn cut at a limit is not tried again', async t => {
  const f = await setup(t, { eventModelCalls: 2 });
  f.model.auto = () => ({ calls: [{ name: 'set_mac_avatar_expression', arguments: { expression: 'thinking' } }] });
  await f.send('PDF を読んで');
  assert.equal(f.retries(), 0);
  assert.match(String(f.notices()[0]), /考える回数の上限 2 回/);
});

test('each event is tried again once; what reaches someone outside counts as an effect, nested in codemode too', () => {
  const retries = new TurnRetries();
  assert.equal(retries.take('model-error', ['e1', 'e2'], false), true);
  assert.equal(retries.take('model-error', ['e2'], false), false);
  assert.equal(retries.take('timeout', ['e3'], false), false);
  assert.equal(retries.take('model-error', ['e3'], true), false);
  const call = (name: string) => ({ role: 'assistant', content: [{ type: 'toolCall', name }] });
  assert.equal(hadOutsideEffect([call('read'), call('run_shell')], new Set()), false);
  assert.equal(hadOutsideEffect([call('ask_agent')], new Set()), true);
  assert.equal(hadOutsideEffect([call('post_to_wiki')], new Set(['post_to_wiki'])), true);
  assert.equal(hadOutsideEffect([{ role: 'toolResult', toolName: 'codemode', nestedCalls: { calls: [{ name: 'notify_owner' }] } }], new Set()), true);
});
