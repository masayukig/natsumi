import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { LOOP_DEFAULTS, type LoopConfig } from '../src/server/config.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { THINKING_LINE_MAX_CHARS, THINKING_MIN_INTERVAL_MS, ThinkingLoop,
  type LoopClientEvent, type LoopOptions, type SendOutcome } from '../src/server/thinking-loop.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { PNG, pngOf } from './support/fake-slack.ts';
import { PRIVATE_DETAIL, ScriptedModel } from './support/scripted-model.ts';

/** What a test may replace when it opens a loop: loop settings are overlaid on `LOOP_DEFAULTS`. */
type OpenOptions = Partial<Omit<LoopOptions, 'loop'>> & { loop?: Partial<LoopConfig> };

const PERSONALITY_MARKER = 'FIXTURE-PERSONALITY-5521';
const TOKEN = 'SYNTHETIC-ORCHID-731';

async function until<T>(check: () => T | undefined | false, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** `beforeReadState` runs on a database migrated up to version 5, as an existing server's would be. */
async function setup(beforeReadState?: (db: DatabaseSync) => void) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-loop-')));
  const data = join(root, 'data');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  await mkdir(data);
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(join(data, 'personality.md'), `# 性格・話し方\n${PERSONALITY_MARKER}\n`);
  const db = openStateDatabase(join(root, 'state.sqlite'));
  if (beforeReadState) {
    migrate(db, MIGRATIONS.filter(migration => migration.version <= 5));
    beforeReadState(db);
  }
  migrate(db, MIGRATIONS);
  const model = new ScriptedModel();
  const sessions: AgentSession[] = [];
  const opened: ThinkingLoop[] = [];
  let counter = 0;
  const f = {
    root, data, sessionDirectory, db, model, sessions,
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
    /** Sends an owner message and returns its IDs; fails the test unless it was accepted. */
    send(loop: ThinkingLoop, text: string, requestId = `request-${++counter}`, deviceId = 'device-1') {
      const outcome = loop.send({ requestId, deviceId, text });
      assert.equal(outcome.kind, 'accepted', JSON.stringify(outcome));
      return outcome as Extract<SendOutcome, { kind: 'accepted' }>;
    },
    rows: () => db.prepare('SELECT * FROM conversations').all() as Record<string, unknown>[],
    sessionFiles: async () => (await readdir(sessionDirectory)).filter(name => name.endsWith('.jsonl')),
    async cleanup() {
      for (const loop of opened) await loop.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  return f;
}

const textOf = (message: Context['messages'][number]) => {
  const content = (message as { content: unknown }).content;
  if (typeof content === 'string') return content;
  return (content as { type: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text).join('');
};
const lastUserText = (context: Context) => textOf(context.messages.filter(m => m.role === 'user').at(-1)!);
/** The tool results a model call saw after its previous assistant message, in order. */
const toolResults = (context: Context) => {
  const lastAssistant = context.messages.map(m => m.role).lastIndexOf('assistant');
  return context.messages.slice(lastAssistant + 1).filter(m => m.role === 'toolResult')
    .map(m => ({ text: textOf(m), isError: (m as { isError: boolean }).isError }));
};
const messages = (events: LoopClientEvent[], role?: string) =>
  events.filter(e => e.type === 'conversation.message' && (role === undefined || e.payload.role === role));
const completed = (events: LoopClientEvent[], eventId: string) =>
  until(() => events.find(e => e.type === 'conversation.event.completed' && e.payload.eventId === eventId));
const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });

test('an owner message is shown at once with the thinking expression and gets one reply through reply_to_mac', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const sent = f.send(loop, 'おはよう');
    // Client events follow the acceptance on a microtask, so a connection answers the sender first.
    assert.equal(events.length, 0);
    await until(() => events.length >= 2);
    assert.deepEqual(events.map(e => e.type), ['conversation.message', 'avatar.expression']);
    assert.deepEqual({ ...events[0]!.payload, createdAt: undefined },
      { messageId: sent.messageId, eventId: sent.eventId, role: 'owner', kind: 'message', text: 'おはよう', createdAt: undefined });
    assert.equal(events[1]!.payload.expression, 'thinking');

    const reply = await f.model.next();
    const prompt = lastUserText(reply.context);
    assert.match(prompt, /^<events>\n/);
    assert.match(prompt, /"type":"mac_message"/);
    assert.match(prompt, /おはよう/);
    assert.match(reply.context.systemPrompt ?? '', new RegExp(PERSONALITY_MARKER));
    reply.think('private thinking about the reply');
    reply.delta('（内心）明るく返そう');
    reply.call('reply_to_mac', { text: 'おはようございます', expression: 'neutral' });
    reply.finish();
    // Nothing is left to do, so she stops without a tool and the turn ends (ADR 0024).
    (await f.model.next()).finish();

    assert.equal((await completed(events, sent.eventId)).payload.status, 'replied');
    await loop.idle();
    assert.equal(f.model.calls, 2);
    const replies = messages(events, 'natsumi');
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.payload.kind, 'reply');
    assert.equal(replies[0]!.payload.text, 'おはようございます');
    assert.equal(replies[0]!.payload.replyTo, sent.eventId);

    const snapshot = loop.snapshot();
    assert.deepEqual(snapshot.messages.map(m => [m.role, m.kind, m.text]), [['owner', 'message', 'おはよう'], ['natsumi', 'reply', 'おはようございます']]);
    assert.deepEqual(snapshot.pendingEvents, []);
    // The server's thinking expression is released once the event is done.
    assert.equal(snapshot.avatar.expression, 'neutral');
    // The line she was writing was shown while she wrote it (ADR 0017), and is in nothing that is kept.
    assert.deepEqual(thinkingLines(events), ['private thinking about the reply', '']);
    const shown = JSON.stringify([snapshot, events.filter(e => e.type !== 'conversation.thinking')]);
    for (const hidden of ['private thinking', '内心', 'reply_to_mac', f.rows()[0]!.pi_session_id as string]) {
      assert.equal(shown.includes(hidden), false, hidden);
    }
  } finally { await f.cleanup(); }
});

test('reply_to_mac says where the line went: the Slack channel when the owner is on Slack (fork ADR F01)', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open({ ownerOnSlack: true });
    f.send(loop, 'こんにちは');
    const first = await f.model.next();
    first.call('reply_to_mac', { text: 'はい', expression: 'neutral' });
    first.finish();
    const second = await f.model.next();
    const [result] = toolResults(second.context);
    assert.match(result!.text, /^本人の Slack のチャンネルにセリフを送りました/);
    assert.doesNotMatch(result!.text, /Mac/);
    second.finish();
    await loop.idle();
  } finally {
    await f.cleanup();
  }
});

test('reply_to_mac can be called again in the same turn: the first answers the message, the rest answer none', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const sent = f.send(loop, 'こんにちは');
    const first = await f.model.next();
    first.call('reply_to_mac', { text: '一回目', expression: 'neutral' });
    first.call('reply_to_mac', { text: '二回目', expression: 'happy' });
    first.finish();
    const second = await f.model.next();
    const results = toolResults(second.context);
    assert.deepEqual(results.map(r => r.isError), [false, false]);
    assert.match(results[0]!.text, /送りました/);
    assert.match(results[1]!.text, /送りました/);
    // She may go on talking, but is told not to say the same thing again.
    assert.match(results[1]!.text, /繰り返さない/);
    second.finish();
    assert.equal((await completed(events, sent.eventId)).payload.status, 'replied');

    // A later turn answers its own message first, and what follows answers none.
    const later = f.send(loop, 'もう一件');
    const third = await f.model.next();
    third.call('reply_to_mac', { text: '二件目への返事', expression: 'neutral' });
    third.call('reply_to_mac', { text: '付け足し', expression: 'neutral' });
    third.finish();
    const fourth = await f.model.next();
    assert.deepEqual(toolResults(fourth.context).map(r => r.isError), [false, false]);
    fourth.finish();
    await completed(events, later.eventId);
    await loop.idle();
    // A reply that answered no message carries no replyTo, rather than a null one.
    assert.deepEqual(messages(events, 'natsumi').map(e => [e.payload.text, e.payload.replyTo, 'replyTo' in e.payload]),
      [['一回目', sent.eventId, true], ['二回目', undefined, false], ['二件目への返事', later.eventId, true], ['付け足し', undefined, false]]);
    assert.deepEqual(loop.snapshot().messages.map(m => [m.kind, m.text, m.replyTo]), [
      ['message', 'こんにちは', undefined], ['reply', '一回目', sent.eventId], ['reply', '二回目', undefined],
      ['message', 'もう一件', undefined], ['reply', '二件目への返事', later.eventId], ['reply', '付け足し', undefined],
    ]);
    // Every one of her lines is a reply the owner has not read yet.
    assert.equal(loop.snapshot().unreadReplyCount, 4);
  } finally { await f.cleanup(); }
});

test('text written without a tool stays inside: nothing reaches the owner and the event ends without a reply', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const sent = f.send(loop, 'ねえ');
    const reply = await f.model.next();
    reply.think('hidden reasoning');
    reply.delta('はい、なんでしょう？');
    reply.finish();
    assert.equal((await completed(events, sent.eventId)).payload.status, 'no-reply');
    await loop.idle();
    assert.deepEqual(messages(events, 'natsumi'), []);
    assert.deepEqual(loop.snapshot().messages.map(m => m.role), ['owner']);
    assert.equal(JSON.stringify([loop.snapshot(), events]).includes('なんでしょう'), false);
  } finally { await f.cleanup(); }
});

test('a turn that keeps calling tools stops at the model call limit and the event fails without touching the owner record', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open({ loop: { eventModelCalls: 3 } });
    f.model.auto = () => ({ calls: [call('set_mac_avatar_expression', { expression: 'happy' })] });
    const sent = f.send(loop, '止まらない場面');
    const done = await completed(events, sent.eventId);
    assert.deepEqual([done.payload.status, done.payload.reason], ['failed', 'model-call-limit']);
    await loop.idle();
    assert.equal(f.model.calls, 3);
    assert.deepEqual(loop.snapshot().messages.map(m => [m.role, m.text]), [['owner', '止まらない場面']]);
    assert.ok(events.some(e => e.type === 'avatar.expression' && e.payload.expression === 'happy'));

    // The loop keeps working afterwards.
    f.model.auto = onPrompt(() => ({ calls: [call('reply_to_mac', { text: '戻りました', expression: 'neutral' })] }));
    const next = f.send(loop, '次');
    assert.equal((await completed(events, next.eventId)).payload.status, 'replied');
  } finally { await f.cleanup(); }
});

test('the limits of a turn are read from the runtime settings before each turn, so a change is in force from the next (ADR 0058)', async () => {
  const f = await setup();
  try {
    let limits = { eventModelCalls: 2, eventTimeoutMinutes: 10, reviewModelCalls: 40, reviewTimeoutMinutes: 30 };
    const { loop, events } = await f.open({ settings: { turnLimits: () => limits, awakeHours: () => LOOP_DEFAULTS.awakeHours } });
    f.model.auto = () => ({ calls: [call('set_mac_avatar_expression', { expression: 'thinking' })] });
    const first = f.send(loop, '一回目');
    assert.equal((await completed(events, first.eventId)).payload.reason, 'model-call-limit');
    await loop.idle();
    assert.equal(f.model.calls, 2, 'the settings, not the config (four in this fixture)');
    limits = { ...limits, eventModelCalls: 5 };
    const second = f.send(loop, '二回目');
    assert.equal((await completed(events, second.eventId)).payload.reason, 'model-call-limit');
    await loop.idle();
    assert.equal(f.model.calls, 2 + 5);
  } finally { await f.cleanup(); }
});

test('an ordinary turn has as many model calls as the config gives it, eight unless told otherwise', async () => {
  const f = await setup();
  try {
    const logs: string[] = [];
    // The default comes from the config, not from the loop: the fixture's own shorter limit is set aside here.
    const { loop, events } = await f.open({ loop: { eventModelCalls: LOOP_DEFAULTS.eventModelCalls }, log: line => { logs.push(line); } });
    f.model.auto = () => ({ calls: [call('set_mac_avatar_expression', { expression: 'thinking' })] });
    const sent = f.send(loop, '直し続ける場面');
    assert.equal((await completed(events, sent.eventId)).payload.reason, 'model-call-limit');
    await loop.idle();
    assert.equal(f.model.calls, 8);
    await loop.close();

    // A deployment that raises the limit gets that many calls, and the log says where the turn was cut.
    const raised = await f.open({ loop: { eventModelCalls: 20 }, log: line => { logs.push(line); } });
    const again = f.send(raised.loop, 'もっと直し続ける場面');
    assert.equal((await completed(raised.events, again.eventId)).payload.reason, 'model-call-limit');
    await raised.loop.idle();
    assert.equal(f.model.calls, 8 + 20);
    assert.ok(logs.includes('thinking loop: the events turn was stopped at the model-call limit (20 calls)'), logs.join('\n'));
  } finally { await f.cleanup(); }
});

test('an ordinary turn is cut at the time the config gives it, not a moment sooner', async t => {
  const f = await setup();
  try {
    const logs: string[] = [];
    const { loop, events } = await f.open({ loop: { eventTimeoutMinutes: 3 }, log: line => { logs.push(line); } });
    const settled = (eventId: string) => events.find(e => e.type === 'conversation.event.completed' && e.payload.eventId === eventId);
    const flush = () => new Promise(resolve => setImmediate(resolve));
    f.model.takeOver();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = f.send(loop, '返事のない場面');
    const reply = await f.model.next();
    t.mock.timers.tick(3 * 60_000 - 1);
    await flush();
    assert.equal(settled(sent.eventId), undefined);
    t.mock.timers.tick(1);
    await loop.idle();
    assert.deepEqual([settled(sent.eventId)?.payload.status, settled(sent.eventId)?.payload.reason], ['failed', 'timeout']);
    assert.ok(logs.includes('thinking loop: the events turn was stopped by the time limit (180 seconds)'), logs.join('\n'));
    reply.finish();
  } finally {
    t.mock.timers.reset();
    await f.cleanup();
  }
});

test('a reply carrying template control strings or non-Japanese script is refused before it is sent', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const sent = f.send(loop, '確認');
    const call1 = await f.model.next();
    call1.call('reply_to_mac', { text: '了解です</think> <tool_call> <parameter=reply_to_mac>', expression: 'neutral' });
    call1.finish();
    const call2 = await f.model.next();
    assert.match(toolResults(call2.context)[0]!.text, /制御文字列/);
    call2.call('reply_to_mac', { text: '네 알겠습니다', expression: 'neutral' });
    call2.call('notify_owner', { text: '这个很长', expression: 'neutral' });
    call2.finish();
    const call3 = await f.model.next();
    const refused = toolResults(call3.context);
    assert.deepEqual(refused.map(r => r.isError), [true, true]);
    assert.match(refused[0]!.text, /日本語以外/);
    assert.match(refused[1]!.text, /日本語以外/);
    // A refused reply answers nothing: the one written again answers the message.
    call3.call('reply_to_mac', { text: '了解です', expression: 'neutral' });
    call3.finish();
    (await f.model.next()).finish();
    await completed(events, sent.eventId);
    assert.deepEqual(messages(events, 'natsumi').map(e => e.payload.text), ['了解です']);
  } finally { await f.cleanup(); }
});

test('notify_owner delivers notices up to a per-turn limit, about no event', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const sent = f.send(loop, '相談があるかも');
    const call1 = await f.model.next();
    call1.call('notify_owner', { text: '相談 1', expression: 'neutral' });
    call1.call('notify_owner', { text: '相談 2', expression: 'neutral' });
    call1.call('notify_owner', { text: '相談 3', expression: 'neutral' });
    call1.call('notify_owner', { text: '相談 4', expression: 'neutral' });
    call1.finish();
    const call2 = await f.model.next();
    const results = toolResults(call2.context);
    assert.deepEqual(results.map(r => r.isError), [false, false, false, true]);
    assert.match(results[3]!.text, /上限/);
    call2.finish();
    assert.equal((await completed(events, sent.eventId)).payload.status, 'no-reply');
    const notices = messages(events, 'natsumi');
    assert.deepEqual(notices.map(e => [e.payload.kind, e.payload.text]), [['notice', '相談 1'], ['notice', '相談 2'], ['notice', '相談 3']]);
    // A notice names no event: natsumi is never asked for an ID (ADR 0024).
    assert.equal('about' in notices[0]!.payload, false);
    assert.deepEqual(loop.snapshot().messages.map(m => m.kind), ['message', 'notice', 'notice', 'notice']);
  } finally { await f.cleanup(); }
});

test('a resent requestId is not handled twice; a different body or device is refused', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    f.model.auto = onPrompt(() => ({ calls: [call('reply_to_mac', { text: 'はい', expression: 'neutral' })] }));
    const first = f.send(loop, 'hello', 'request-same');
    const again = f.send(loop, 'hello', 'request-same');
    assert.deepEqual([again.messageId, again.eventId], [first.messageId, first.eventId]);
    assert.deepEqual(loop.send({ requestId: 'request-same', deviceId: 'device-1', text: 'other' }), { kind: 'rejected', code: 'request-conflict' });
    assert.deepEqual(loop.send({ requestId: 'request-same', deviceId: 'device-2', text: 'hello' }), { kind: 'rejected', code: 'request-conflict' });
    await completed(events, first.eventId);
    await loop.idle();
    assert.equal(f.send(loop, 'hello', 'request-same').messageId, first.messageId);
    await loop.idle();
    assert.equal(f.model.calls, 2);
    assert.equal(messages(events, 'owner').length, 1);
  } finally { await f.cleanup(); }
});

test('the conversation shown to the owner survives a restart, the same Pi session continues, and thinking follows the config', async () => {
  const f = await setup();
  try {
    const first = await f.open();
    assert.equal(first.loop.unavailable, undefined);
    assert.notEqual(f.sessions[0]!.thinkingLevel, 'off');
    const [file] = await f.sessionFiles();
    assert.ok(file);
    assert.deepEqual(f.rows().map(row => row.pi_session_file), [file]);
    f.model.auto = onPrompt(context => {
      const earlier = JSON.stringify(context.messages.slice(0, -1)).includes(TOKEN);
      return { calls: [call('reply_to_mac', { text: earlier ? TOKEN : 'OK', expression: 'neutral' })] };
    });
    const sent = f.send(first.loop, `合言葉は ${TOKEN}`);
    await completed(first.events, sent.eventId);
    const snapshot = first.loop.snapshot();
    await first.loop.close();

    const second = await f.open({ thinking: 'off' });
    assert.equal(f.sessions[1]!.thinkingLevel, 'off');
    assert.deepEqual(second.loop.snapshot().messages, snapshot.messages);
    const asked = f.send(second.loop, '合言葉は？');
    await completed(second.events, asked.eventId);
    assert.equal(messages(second.events, 'natsumi').at(-1)?.payload.text, TOKEN);
    assert.deepEqual(await f.sessionFiles(), [file]);
  } finally { await f.cleanup(); }
});

test('a missing, corrupt or mismatched session file makes the loop unavailable instead of replacing it', async () => {
  const f = await setup();
  try {
    const first = await f.open();
    f.model.auto = () => ({});
    const sent = f.send(first.loop, 'hello');
    await completed(first.events, sent.eventId);
    await first.loop.close();
    const rows = f.rows();
    const name = String(rows[0]!.pi_session_file);
    const file = join(f.sessionDirectory, name);
    const original = await readFile(file, 'utf8');
    const damage = [
      () => rm(file),
      () => writeFile(file, `${original}{"type":"message","message":\n`),
      () => writeFile(file, original.replace(String(rows[0]!.pi_session_id), '00000000-0000-4000-8000-000000000000')),
    ];
    let n = 0;
    for (const apply of damage) {
      await apply();
      const { loop } = await f.open();
      assert.equal(loop.unavailable, 'conversation-restore-failed');
      assert.deepEqual(loop.send({ requestId: `request-damaged-${n++}`, deviceId: 'device-1', text: 'hello' }),
        { kind: 'unavailable', code: 'conversation-restore-failed' });
      await loop.close();
      assert.deepEqual(f.rows(), rows);
      for (const seen of await f.sessionFiles()) assert.equal(seen, name);
      await writeFile(file, original);
    }
    assert.equal(f.model.calls, 1);
  } finally { await f.cleanup(); }
});

test('a model runtime that cannot start leaves the loop unavailable without creating a session', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open({ runtime: async () => { throw new Error(PRIVATE_DETAIL); } });
    assert.equal(loop.unavailable, 'pi-unavailable');
    assert.deepEqual(loop.send({ requestId: 'request-1', deviceId: 'device-1', text: 'hello' }), { kind: 'unavailable', code: 'pi-unavailable' });
    assert.deepEqual(loop.markRead({ throughMessageId: 'message-1', deviceId: 'device-1' }), { kind: 'unavailable', code: 'pi-unavailable' });
    assert.deepEqual(loop.acknowledgeNotice({ notificationId: 'message-1', deviceId: 'device-1' }), { kind: 'unavailable', code: 'pi-unavailable' });
    assert.deepEqual(f.rows(), []);
    assert.deepEqual(await f.sessionFiles(), []);
  } finally { await f.cleanup(); }
});

/** A model that answers every event with a notice and a reply, and then stops. */
function noticeAndReply(f: Awaited<ReturnType<typeof setup>>, notices = ['お知らせ']) {
  f.model.auto = onPrompt(() => ({ calls: [...notices.map(text => call('notify_owner', { text, expression: 'neutral' })), call('reply_to_mac', { text: 'はい', expression: 'neutral' })] }));
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const ofType = (events: LoopClientEvent[], type: string) => events.filter(e => e.type === type).map(e => e.payload);

test('the read cursor only moves forward, refuses unknown messages and counts only natsumi replies as unread', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    assert.deepEqual([loop.snapshot().readThroughMessageId, loop.snapshot().unreadReplyCount, loop.snapshot().unacknowledgedNotificationIds], [null, 0, []]);
    noticeAndReply(f);
    const first = f.send(loop, '一件目');
    await completed(events, first.eventId);
    await loop.idle();
    const [owner1, notice1, reply1] = loop.snapshot().messages.map(m => m.messageId);
    assert.deepEqual(loop.snapshot().messages.map(m => m.kind), ['message', 'notice', 'reply']);
    assert.equal(loop.snapshot().unreadReplyCount, 1);

    assert.deepEqual(loop.markRead({ throughMessageId: 'message-missing', deviceId: 'device-1' }), { kind: 'rejected', code: 'invalid-request' });
    // Through the owner's own message: the reply after it is still unread.
    assert.deepEqual(loop.markRead({ throughMessageId: owner1!, deviceId: 'device-1' }),
      { kind: 'accepted', readThroughMessageId: owner1, unreadReplyCount: 1 });
    // The event follows the answer, as with conversation.send.
    assert.deepEqual(ofType(events, 'conversation.read'), []);
    await tick();
    assert.deepEqual(ofType(events, 'conversation.read'), [{ readThroughMessageId: owner1, unreadReplyCount: 1 }]);

    assert.deepEqual(loop.markRead({ throughMessageId: reply1!, deviceId: 'device-2' }),
      { kind: 'accepted', readThroughMessageId: reply1, unreadReplyCount: 0 });
    await tick();
    // Passing a notice does not acknowledge it.
    assert.deepEqual(loop.snapshot().unacknowledgedNotificationIds, [notice1]);

    const second = f.send(loop, '二件目');
    await completed(events, second.eventId);
    await loop.idle();
    // A new owner message and a new reply follow the cursor; only the reply is unread.
    assert.deepEqual([loop.snapshot().readThroughMessageId, loop.snapshot().unreadReplyCount], [reply1, 1]);

    // A late, smaller position from an old device is ignored and the current one returned; nothing is broadcast.
    const before = ofType(events, 'conversation.read').length;
    assert.deepEqual(loop.markRead({ throughMessageId: owner1!, deviceId: 'device-old' }),
      { kind: 'accepted', readThroughMessageId: reply1, unreadReplyCount: 1 });
    assert.deepEqual(loop.markRead({ throughMessageId: reply1!, deviceId: 'device-1' }),
      { kind: 'accepted', readThroughMessageId: reply1, unreadReplyCount: 1 });
    await tick();
    assert.equal(ofType(events, 'conversation.read').length, before);
  } finally { await f.cleanup(); }
});

test('notices are acknowledged one by one, idempotently and apart from the read cursor, and natsumi sees how many are left', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    noticeAndReply(f, ['知らせ 1', '知らせ 2']);
    const sent = f.send(loop, '相談');
    await completed(events, sent.eventId);
    await loop.idle();
    const [ownerId, firstNotice, secondNotice, replyId] = loop.snapshot().messages.map(m => m.messageId);
    assert.deepEqual(loop.snapshot().unacknowledgedNotificationIds, [firstNotice, secondNotice]);

    for (const notificationId of [ownerId!, replyId!, 'message-missing']) {
      assert.deepEqual(loop.acknowledgeNotice({ notificationId, deviceId: 'device-1' }), { kind: 'rejected', code: 'invalid-request' });
    }
    // Out of order: the second one first.
    const acked = loop.acknowledgeNotice({ notificationId: secondNotice!, deviceId: 'device-1' });
    assert.equal(acked.kind, 'accepted');
    const { acknowledgedAt } = acked as { acknowledgedAt: string };
    assert.equal(Number.isNaN(Date.parse(acknowledgedAt)), false);
    await tick();
    assert.deepEqual(ofType(events, 'notification.acked'), [{ notificationId: secondNotice, acknowledgedAt }]);
    // A second ack, from any device, returns the recorded state and broadcasts nothing.
    assert.deepEqual(loop.acknowledgeNotice({ notificationId: secondNotice!, deviceId: 'device-2' }),
      { kind: 'accepted', notificationId: secondNotice, acknowledgedAt });
    await tick();
    assert.equal(ofType(events, 'notification.acked').length, 1);

    // The cursor passing every message leaves the first notice unacknowledged.
    loop.markRead({ throughMessageId: replyId!, deviceId: 'device-1' });
    assert.deepEqual(loop.snapshot().unacknowledgedNotificationIds, [firstNotice]);

    // natsumi sees the count of notices the owner has not checked in the next event.
    f.model.takeOver();
    const next = f.send(loop, '次');
    const turn = await f.model.next();
    assert.match(lastUserText(turn.context), /"unacknowledged_notices":1/);
    assert.match(turn.context.systemPrompt ?? '', /unacknowledged_notices/);
    turn.finish();
    await completed(events, next.eventId);

    loop.acknowledgeNotice({ notificationId: firstNotice!, deviceId: 'device-1' });
    const last = f.send(loop, '最後');
    const lastTurn = await f.model.next();
    assert.doesNotMatch(lastUserText(lastTurn.context), /unacknowledged_notices/);
    lastTurn.finish();
    await completed(events, last.eventId);
  } finally { await f.cleanup(); }
});

test('a snapshot lists unacknowledged notices beyond its newest 500 messages and counts unread replies beyond them', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    noticeAndReply(f);
    const sent = f.send(loop, '古いやりとり');
    await completed(events, sent.eventId);
    await loop.idle();
    const [, oldNotice] = loop.snapshot().messages.map(m => m.messageId);
    const insert = f.db.prepare(`INSERT INTO conversation_messages (message_id, position, role, kind, text, event_id, request_id, device_id, created_at)
      VALUES (?, (SELECT MAX(position) + 1 FROM conversation_messages), 'owner', 'message', 'x', ?, ?, 'device-1', '2026-01-01T00:00:00.000Z')`);
    for (let i = 0; i < 500; i++) insert.run(`message-filler-${i}`, `event-filler-${i}`, `request-filler-${i}`);

    const snapshot = loop.snapshot();
    assert.equal(snapshot.messages.length, 500);
    assert.equal(snapshot.messages.some(m => m.messageId === oldNotice), false);
    assert.deepEqual(snapshot.unacknowledgedNotificationIds, [oldNotice]);
    assert.equal(snapshot.unreadReplyCount, 1);
  } finally { await f.cleanup(); }
});

test('migration 6 treats the conversation that already exists as read and its notices as acknowledged', async () => {
  const f = await setup(db => {
    const insert = db.prepare(`INSERT INTO conversation_messages
      (message_id, position, role, kind, text, event_id, request_id, device_id, created_at) VALUES (?, ?, ?, ?, 'x', ?, ?, ?, '2026-01-01T00:00:00.000Z')`);
    insert.run('message-old-1', 1, 'owner', 'message', 'event-old-1', 'request-old-1', 'device-1');
    insert.run('message-old-2', 2, 'natsumi', 'notice', null, null, null);
    insert.run('message-old-3', 3, 'natsumi', 'reply', 'event-old-1', null, null);
    insert.run('message-old-4', 4, 'owner', 'message', 'event-old-4', 'request-old-4', 'device-1');
  });
  try {
    const { loop, events } = await f.open();
    const snapshot = loop.snapshot();
    assert.deepEqual([snapshot.readThroughMessageId, snapshot.unreadReplyCount, snapshot.unacknowledgedNotificationIds], ['message-old-4', 0, []]);
    assert.equal(loop.acknowledgeNotice({ notificationId: 'message-old-2', deviceId: 'device-1' }).kind, 'accepted');
    await tick();
    assert.deepEqual(ofType(events, 'notification.acked'), []);

    // Only what comes after is unread.
    noticeAndReply(f);
    const sent = f.send(loop, '新しいメッセージ');
    await completed(events, sent.eventId);
    await loop.idle();
    const newNotice = loop.snapshot().messages.find(m => m.kind === 'notice' && m.messageId !== 'message-old-2')!.messageId;
    assert.deepEqual([loop.snapshot().unreadReplyCount, loop.snapshot().unacknowledgedNotificationIds], [1, [newNotice]]);
  } finally { await f.cleanup(); }
});

// MARK: - The line natsumi is writing (ADR 0017)

/** The lines of `conversation.thinking`, in order. */
const thinkingLines = (events: LoopClientEvent[]) =>
  events.filter(e => e.type === 'conversation.thinking').map(e => e.payload.line as string);

test('the line natsumi is thinking reaches the owner while she answers, thinned out and cut to a length', async () => {
  const f = await setup();
  let clock = Date.parse('2026-01-01T09:00:00Z');
  try {
    const { loop, events } = await f.open({ now: () => clock });
    const sent = f.send(loop, '相談したいことがある');
    const reply = await f.model.next();

    reply.think('まず要点を');
    await until(() => thinkingLines(events).length >= 1);
    assert.deepEqual(thinkingLines(events), ['まず要点を']);
    // Every line is ephemeral: it is never kept and never numbered on a stream.
    assert.equal(events.find(e => e.type === 'conversation.thinking')!.ephemeral, true);

    // Within the interval the line grows without being sent again.
    clock += THINKING_MIN_INTERVAL_MS;
    reply.think('整理する');
    await until(() => thinkingLines(events).length >= 2);
    assert.deepEqual(thinkingLines(events), ['まず要点を', 'まず要点を整理する']);

    // The same interval again: these are thinned out, and only the line the thinking ended on is sent.
    reply.think('。それから');
    reply.think('\n次に返事の形を決める');
    reply.delta('（内心）決めた');
    reply.call('reply_to_mac', { text: 'はい、考えました', expression: 'neutral' });
    reply.finish();
    (await f.model.next()).finish();

    assert.equal((await completed(events, sent.eventId)).payload.status, 'replied');
    await loop.idle();
    // The empty line at the end says the thinking is over, whatever the Mac made of the completion.
    assert.deepEqual(thinkingLines(events), ['まず要点を', 'まず要点を整理する', '次に返事の形を決める', '']);

    // It is a passing sight only: nothing of it is recorded, in the snapshot or in the history.
    const snapshot = loop.snapshot();
    assert.deepEqual(snapshot.messages.map(m => m.text), ['相談したいことがある', 'はい、考えました']);
    assert.equal(JSON.stringify(snapshot).includes('次に返事の形'), false);
    const stored = f.db.prepare('SELECT text FROM conversation_messages').all() as { text: string }[];
    assert.equal(stored.some(row => row.text.includes('要点')), false);
  } finally { await f.cleanup(); }
});

test('a line longer than the limit keeps its newest end, and the owner never sees a tool call', async () => {
  const f = await setup();
  let clock = Date.parse('2026-01-01T09:00:00Z');
  try {
    const { loop, events } = await f.open({ now: () => clock });
    const sent = f.send(loop, 'ながい思考');
    const reply = await f.model.next();
    reply.think(`${'あ'.repeat(200)}おわり`);
    await until(() => thinkingLines(events).length >= 1);
    const line = thinkingLines(events)[0]!;
    assert.equal([...line].length, THINKING_LINE_MAX_CHARS);
    assert.ok(line.startsWith('…'));
    assert.ok(line.endsWith('おわり'));

    clock += THINKING_MIN_INTERVAL_MS;
    reply.call('schedule_self_check', { reason: 'SYNTHETIC-TOOL-ARGUMENT-8841' });
    reply.finish();
    const second = await f.model.next();
    second.finish();
    await completed(events, sent.eventId);
    await loop.idle();
    // Only the thinking text is streamed: what a tool was called with or answered is not.
    assert.equal(JSON.stringify(events).includes('SYNTHETIC-TOOL-ARGUMENT-8841'), false);
  } finally { await f.cleanup(); }
});

test('the last line stays across model calls in one turn and is cleared when the turn ends', async () => {
  const f = await setup();
  let clock = Date.parse('2026-01-01T09:00:00Z');
  try {
    const { loop, events } = await f.open({ now: () => clock });
    const sent = f.send(loop, 'ツールを使って考えて');
    const first = await f.model.next();
    first.think('記憶を確かめよう');
    await until(() => thinkingLines(events).length >= 1);
    first.call('list_self_checks', {});
    first.finish();

    const second = await f.model.next();
    // The boundary between model calls sends nothing: the line she wrote last is still what she is on.
    assert.deepEqual(thinkingLines(events), ['記憶を確かめよう']);
    clock += THINKING_MIN_INTERVAL_MS;
    second.think('分かった、返事にしよう');
    await until(() => thinkingLines(events).length >= 2);
    second.call('reply_to_mac', { text: '確かめました', expression: 'neutral' });
    second.finish();
    (await f.model.next()).finish();

    await completed(events, sent.eventId);
    await loop.idle();
    assert.deepEqual(thinkingLines(events), ['記憶を確かめよう', '分かった、返事にしよう', '']);
  } finally { await f.cleanup(); }
});

test('nothing is streamed with thinking off, in the nightly review, or for a turn the owner is not waiting on', async () => {
  const f = await setup();
  try {
    const off = await f.open({ thinking: 'off' });
    const sent = f.send(off.loop, 'こんばんは');
    const reply = await f.model.next();
    reply.think('この思考は流れない');
    reply.call('reply_to_mac', { text: 'こんばんは', expression: 'neutral' });
    reply.finish();
    (await f.model.next()).finish();
    await completed(off.events, sent.eventId);
    await off.loop.idle();
    assert.deepEqual(thinkingLines(off.events), []);
    await off.loop.close();

    const on = await f.open();
    f.model.takeOver();
    // A ping is natsumi's own business: the Mac shows no balloon for it, so no line is sent either.
    assert.equal(on.loop.ping(), true);
    const ping = await f.model.next();
    ping.think('本人は何も待っていない');
    ping.finish();
    await on.loop.idle();
    assert.deepEqual(thinkingLines(on.events), []);

    // The nightly review does not appear in the conversation at all (ADR 0009).
    f.model.auto = onPrompt(() => ({ thinking: '今日を振り返る', calls: [call('write_handoff_note', { text: '明日の引き継ぎ' })] }));
    assert.equal((await on.loop.rotate()).result, 'switched');
    assert.deepEqual(thinkingLines(on.events), []);
  } finally { await f.cleanup(); }
});

// MARK: - Replies without event IDs, and turns that end by themselves (ADR 0024)

/** The events natsumi is shown carry no event ID: she never has to copy one. */
const eventLines = (text: string) => [...text.matchAll(/^\{.*\}$/gm)].map(match => JSON.parse(match[0]) as Record<string, unknown>);
/** Answers a fresh prompt with `step` and stops without a tool once the tools have answered. */
const onPrompt = (step: (context: Context) => ReturnType<NonNullable<ScriptedModel['auto']>>) =>
  (context: Context) => context.messages.at(-1)?.role === 'user' ? step(context) : {};
const eventState = (f: Awaited<ReturnType<typeof setup>>, eventId: string) =>
  (f.db.prepare('SELECT state FROM loop_events WHERE event_id = ?').get(eventId) as { state: string }).state;

test('reply_to_mac names no event, answers the message being handled, and speaks in a turn with no message too', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const sent = f.send(loop, 'こんにちは');
    const first = await f.model.next();
    const lines = eventLines(lastUserText(first.context));
    assert.equal(lines.length, 1);
    assert.equal('event_id' in lines[0]!, false);
    assert.equal(lines[0]!.type, 'mac_message');
    assert.equal(JSON.stringify(first.context).includes(sent.eventId), false);
    assert.doesNotMatch(first.context.systemPrompt ?? "", /finish_event|event_id/);
    first.call('reply_to_mac', { text: '一回目', expression: 'neutral' });
    first.finish();
    const second = await f.model.next();
    const results = toolResults(second.context);
    assert.deepEqual(results.map(r => r.isError), [false]);
    assert.match(results[0]!.text, /送りました/);
    assert.doesNotMatch(results[0]!.text, /event-/);
    second.finish();
    assert.equal((await completed(events, sent.eventId)).payload.status, 'replied');
    await loop.idle();
    assert.equal(f.model.calls, 2);
    assert.deepEqual(messages(events, 'natsumi').map(e => [e.payload.text, e.payload.replyTo]), [['一回目', sent.eventId]]);

    // A ping has no message to answer, and she may still speak to the owner, as often as she has something to say.
    f.model.takeOver();
    assert.equal(loop.ping(), true);
    const ping = await f.model.next();
    assert.equal('event_id' in eventLines(lastUserText(ping.context))[0]!, false);
    ping.call('reply_to_mac', { text: 'そろそろお昼ですね', expression: 'happy' });
    ping.call('reply_to_mac', { text: '何か食べましたか？', expression: 'neutral' });
    ping.finish();
    const after = await f.model.next();
    assert.deepEqual(toolResults(after.context).map(r => r.isError), [false, false]);
    after.finish();
    await loop.idle();
    const spoken = messages(events, 'natsumi').slice(1);
    assert.deepEqual(spoken.map(e => [e.payload.kind, e.payload.text, 'replyTo' in e.payload]),
      [['reply', 'そろそろお昼ですね', false], ['reply', '何か食べましたか？', false]]);
    // A ping was never an owner message, so it tells no device it was answered.
    assert.equal(events.some(e => e.type === 'conversation.event.completed' && e.payload.eventId !== sent.eventId), false);
    assert.deepEqual(loop.snapshot().pendingEvents, []);
  } finally { await f.cleanup(); }
});

test('one reply answers every message steered in before it, and a message steered in after it can be answered again', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open({ loop: { eventModelCalls: 8 } });
    const first = f.send(loop, '一件目');
    const call1 = await f.model.next();
    const second = f.send(loop, '二件目');
    call1.call('list_self_checks', {});
    call1.finish();

    const call2 = await f.model.next();
    assert.equal(eventLines(lastUserText(call2.context))[0]!.text, '二件目');
    call2.call('reply_to_mac', { text: '二件まとめての返事', expression: 'neutral' });
    call2.finish();

    const call3 = await f.model.next();
    // Both are answered the moment the reply is sent, so a restart now would not answer either again.
    assert.deepEqual([eventState(f, first.eventId), eventState(f, second.eventId)], ['replied', 'replied']);
    assert.deepEqual(loop.snapshot().pendingEvents, []);
    const third = f.send(loop, '三件目');
    call3.call('reply_to_mac', { text: '続けてひとこと', expression: 'neutral' });
    call3.finish();

    const call4 = await f.model.next();
    assert.equal(eventLines(lastUserText(call4.context))[0]!.text, '三件目');
    // Sent before the third arrived: nothing was waiting then, so it answers none, and the third still waits.
    assert.deepEqual(toolResults(call4.context).map(r => r.isError), [false]);
    assert.equal(eventState(f, third.eventId), 'processing');
    call4.call('reply_to_mac', { text: '三件目への返事', expression: 'neutral' });
    call4.finish();
    (await f.model.next()).finish();

    await loop.idle();
    for (const sent of [first, second, third]) assert.equal((await completed(events, sent.eventId)).payload.status, 'replied');
    // The reply points at the newest message it answered; the one in between answered none.
    assert.deepEqual(messages(events, 'natsumi').map(e => [e.payload.text, e.payload.replyTo]),
      [['二件まとめての返事', second.eventId], ['続けてひとこと', undefined], ['三件目への返事', third.eventId]]);
  } finally { await f.cleanup(); }
});

test('messages a reply answered stay answered across a restart in the middle of the turn', async () => {
  const f = await setup();
  try {
    const first = await f.open();
    const a = f.send(first.loop, '一件目');
    const call1 = await f.model.next();
    const b = f.send(first.loop, '二件目');
    call1.finish();
    const call2 = await f.model.next();
    call2.call('reply_to_mac', { text: 'まとめて', expression: 'neutral' });
    call2.finish();
    await f.model.next();
    await first.loop.close();
    assert.deepEqual([eventState(f, a.eventId), eventState(f, b.eventId)], ['replied', 'replied']);

    const second = await f.open();
    f.model.auto = () => ({});
    await second.loop.idle();
    assert.deepEqual([eventState(f, a.eventId), eventState(f, b.eventId)], ['replied', 'replied']);
    assert.equal(messages(second.events, 'natsumi').length, 0);
  } finally { await f.cleanup(); }
});

test('the turn ends when the model stops without a tool, and an event left unanswered ends without a reply', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    f.model.auto = onPrompt(() => ({ calls: [call('set_mac_avatar_expression', { expression: 'happy' })] }));
    const sent = f.send(loop, '表情だけ');
    assert.equal((await completed(events, sent.eventId)).payload.status, 'no-reply');
    await loop.idle();
    assert.equal(f.model.calls, 2);

    f.model.auto = onPrompt(() => ({ calls: [call('reply_to_mac', { text: 'はい', expression: 'neutral' })] }));
    const next = f.send(loop, '返事して');
    assert.equal((await completed(events, next.eventId)).payload.status, 'replied');
    await loop.idle();
    assert.equal(f.model.calls, 4);
  } finally { await f.cleanup(); }
});

test('a model that stops while a message waits to be steered in does not end the turn: the message is handled in it', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const first = f.send(loop, '一件目');
    const call1 = await f.model.next();
    const second = f.send(loop, '二件目');
    // No tool at all: Pi would stop here, but the waiting message goes in first.
    call1.finish();
    const call2 = await f.model.next();
    assert.equal(eventLines(lastUserText(call2.context))[0]!.text, '二件目');
    call2.call('reply_to_mac', { text: '両方への返事', expression: 'neutral' });
    call2.finish();
    (await f.model.next()).finish();
    await loop.idle();
    assert.equal(f.model.calls, 3);
    for (const sent of [first, second]) assert.equal((await completed(events, sent.eventId)).payload.status, 'replied');
  } finally { await f.cleanup(); }
});

test('a model call cut off at the output limit still fails the event', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const sent = f.send(loop, '長く考えて');
    const cut = await f.model.next();
    cut.think('event-… event-… event-…');
    cut.finish('length');
    const done = await completed(events, sent.eventId);
    assert.deepEqual([done.payload.status, done.payload.reason], ['failed', 'model-error']);
    await loop.idle();
    assert.equal(f.model.calls, 1);
  } finally { await f.cleanup(); }
});

// ADR 0026: each line she sends carries the feeling she chose for it, kept with the line and shown with it.
test('the expression of a reply and a notice is kept and shown in conversation.message and in the snapshot', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const sent = f.send(loop, 'ただいま');
    const turn = await f.model.next();
    turn.call('notify_owner', { text: '雨が降りそうです', expression: 'worried' });
    turn.call('reply_to_mac', { text: 'おかえりなさい', expression: 'happy' });
    turn.finish();
    (await f.model.next()).finish();
    assert.equal((await completed(events, sent.eventId)).payload.status, 'replied');
    await loop.idle();

    assert.deepEqual(messages(events).map(e => [e.payload.kind, e.payload.expression]),
      [['message', undefined], ['notice', 'worried'], ['reply', 'happy']]);
    // The owner's message has no expression field at all, rather than a null one.
    assert.equal('expression' in messages(events, 'owner')[0]!.payload, false);
    assert.deepEqual(loop.snapshot().messages.map(m => [m.kind, m.expression]),
      [['message', undefined], ['notice', 'worried'], ['reply', 'happy']]);
    assert.deepEqual((f.db.prepare('SELECT kind, expression FROM conversation_messages ORDER BY position').all() as
      { kind: string; expression: string | null }[]).map(row => [row.kind, row.expression]),
      [['message', null], ['notice', 'worried'], ['reply', 'happy']]);
  } finally { await f.cleanup(); }
});

test('a line without an expression, or with one that is not an expression, is not sent and the error goes back to her', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const sent = f.send(loop, 'ねえ');
    const first = await f.model.next();
    first.call('reply_to_mac', { text: '表情のない返事' });
    first.call('reply_to_mac', { text: '怒った返事', expression: 'angry' });
    first.call('notify_owner', { text: '表情のない知らせ' });
    first.call('notify_owner', { text: '怒った知らせ', expression: 'angry' });
    first.finish();
    const second = await f.model.next();
    const results = toolResults(second.context);
    assert.deepEqual(results.map(r => r.isError), [true, true, true, true]);
    for (const result of results) assert.match(result.text, /expression/);
    assert.deepEqual(messages(events, 'natsumi'), []);

    // Nothing was sent, so the message is still waiting for its reply.
    second.call('reply_to_mac', { text: 'はい', expression: 'neutral' });
    second.finish();
    (await f.model.next()).finish();
    assert.equal((await completed(events, sent.eventId)).payload.status, 'replied');
    assert.deepEqual(messages(events, 'natsumi').map(e => [e.payload.text, e.payload.expression]), [['はい', 'neutral']]);
    assert.deepEqual(loop.snapshot().messages.map(m => m.text), ['ねえ', 'はい']);
  } finally { await f.cleanup(); }
});

// ADR 0026 (Q4): the feeling of a line and the avatar's expression are apart. A line never moves the avatar.
test('sending a line with an expression leaves the avatar expression as it was', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const sent = f.send(loop, 'おもしろい話');
    const first = await f.model.next();
    first.call('set_mac_avatar_expression', { expression: 'surprised' });
    first.finish();
    const second = await f.model.next();
    const before = events.filter(e => e.type === 'avatar.expression').length;
    second.call('reply_to_mac', { text: 'あはは', expression: 'laughing' });
    second.call('notify_owner', { text: 'そういえば', expression: 'sad' });
    second.finish();
    const third = await f.model.next();
    assert.equal(events.filter(e => e.type === 'avatar.expression').length, before);
    assert.equal(loop.snapshot().avatar.expression, 'surprised');
    third.finish();
    assert.equal((await completed(events, sent.eventId)).payload.status, 'replied');
    await loop.idle();
    const shownExpressions = events.filter(e => e.type === 'avatar.expression').map(e => e.payload.expression);
    assert.equal(shownExpressions.includes('laughing'), false);
    assert.equal(shownExpressions.includes('sad'), false);
    assert.equal(loop.snapshot().avatar.expression, 'surprised');
  } finally { await f.cleanup(); }
});

// ADR 0045: a reply may carry images from /work. They are copied as she calls the tool, and the line shows them by ID.
const IMAGE_COPIES = (f: { data: string }) => join(f.data, '.natsumi', 'images');
const copies = async (f: { data: string }) => (await readdir(IMAGE_COPIES(f)).catch(() => [])).sort();

async function drawn(f: { data: string }) {
  await mkdir(join(f.data, 'work', 'images'), { recursive: true });
  const tall = pngOf(896, 1152);
  await writeFile(join(f.data, 'work', 'images', 'me.png'), tall);
  await writeFile(join(f.data, 'work', 'images', 'plain.png'), PNG);
  return { tall };
}

test('a reply with images copies them at the call and shows them on the line, in the event and in the snapshot', async () => {
  const f = await setup();
  try {
    const { tall } = await drawn(f);
    const { loop, events } = await f.open();
    const sent = f.send(loop, '絵を描いて');
    const turn = await f.model.next();
    turn.call('reply_to_mac', { text: '描きました', expression: 'happy', images: ['/work/images/me.png', '/work/images/plain.png'] });
    turn.finish();
    const after = await f.model.next();
    const [result] = toolResults(after.context);
    assert.equal(result!.isError, false);
    assert.match(result!.text, /画像 2 枚/);
    // Written over after the call: the owner is shown what was there when she called.
    await writeFile(join(f.data, 'work', 'images', 'me.png'), PNG);
    after.finish();
    assert.equal((await completed(events, sent.eventId)).payload.status, 'replied');
    await loop.idle();

    const [reply] = messages(events, 'natsumi');
    const images = reply!.payload.images as { imageId: string; mimeType: string; bytes: number; width?: number; height?: number }[];
    assert.deepEqual(images.map(({ imageId: _id, ...image }) => image),
      [{ mimeType: 'image/png', bytes: tall.length, width: 896, height: 1152 }, { mimeType: 'image/png', bytes: PNG.length }]);
    assert.equal(reply!.payload.replyTo, sent.eventId);
    assert.deepEqual(loop.snapshot().messages.at(-1)!.images, images);
    // The owner's message and a reply without images have no field at all, rather than an empty list.
    assert.equal('images' in messages(events, 'owner')[0]!.payload, false);
    const files = await copies(f);
    assert.deepEqual(files, images.map(image => `${image.imageId}.png`).sort());
    assert.deepEqual(await readFile(join(IMAGE_COPIES(f), `${images[0]!.imageId}.png`)), tall);
    assert.equal(loop.showsImage(images[0]!.imageId), true);
    assert.equal(loop.showsImage('image-unknown'), false);

    // The images stay with the line across a restart.
    await loop.close();
    const again = await f.open();
    assert.deepEqual(again.loop.snapshot().messages.at(-1)!.images, images);
  } finally { await f.cleanup(); }
});

test('a reply whose images cannot be taken is not sent, text and all, and says how to fix them', async () => {
  const f = await setup();
  try {
    await drawn(f);
    await writeFile(join(f.data, 'outside.png'), PNG);
    const { loop, events } = await f.open({ replyImageLimits: { maxBytes: 1024 * 1024, maxCount: 2 } });
    const sent = f.send(loop, '見せて');
    const turn = await f.model.next();
    turn.call('reply_to_mac', { text: 'これです', expression: 'happy', images: ['/data/outside.png'] });
    turn.call('reply_to_mac', { text: 'これです', expression: 'happy', images: ['/work/images/none.png'] });
    turn.call('reply_to_mac', { text: 'これです', expression: 'happy',
      images: ['/work/images/me.png', '/work/images/plain.png', '/work/images/me.png'] });
    // A line that is refused for its text takes no copies either.
    turn.call('reply_to_mac', { text: '네 알겠습니다', expression: 'happy', images: ['/work/images/me.png'] });
    turn.finish();
    const next = await f.model.next();
    const refused = toolResults(next.context);
    assert.deepEqual(refused.map(r => r.isError), [true, true, true, true]);
    assert.match(refused[0]!.text, /送信していません[\s\S]*\/work\//);
    assert.match(refused[1]!.text, /見つかりません/);
    assert.match(refused[2]!.text, /2 枚まで/);
    assert.match(refused[3]!.text, /日本語以外/);
    next.finish();
    assert.equal((await completed(events, sent.eventId)).payload.status, 'no-reply');
    assert.deepEqual(messages(events, 'natsumi'), []);
    assert.deepEqual(await copies(f), []);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM images').get() as { n: number }).n, 0);
  } finally { await f.cleanup(); }
});

test('the dashboard reads the running turn, the queue, the route, the fold and the context, and changes nothing by reading (ADR 0049)', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open({ now: () => Date.parse('2026-01-01T00:00:00Z') });
    const idle = loop.dashboardState();
    assert.equal(idle.unavailable, null);
    assert.equal(idle.turn, null);
    assert.equal(idle.queueLength, 0);
    assert.equal(idle.fold, 'off');
    assert.equal(idle.routes.current, 'default');
    assert.deepEqual(idle.context, { tokens: null, measuredAt: null, compactionThreshold: LOOP_DEFAULTS.compactionThreshold });
    assert.equal(idle.lastCompactionAt, null);

    const sent = f.send(loop, 'おはよう');
    const reply = await f.model.next();
    loop.raise('dove-reply', () => {});
    const running = loop.dashboardState();
    assert.match(running.turn?.turnId ?? '', /^turn-[0-9a-f-]{36}$/);
    assert.deepEqual(running.turn, { turnId: running.turn!.turnId, startedAt: '2026-01-01T00:00:00.000Z', eventKinds: 'mac_message', phase: 'turn' });
    // Where it began in the record, so the dashboard can read it while it runs; the row with its numbers comes after.
    const inProgress = loop.turnInProgress()!;
    assert.equal(inProgress.turnId, running.turn!.turnId);
    assert.equal(inProgress.kind, 'events');
    assert.deepEqual(inProgress.eventIds, [sent.eventId]);
    assert.deepEqual(inProgress.place, { sessionFile: (await f.sessionFiles())[0], startOffset: inProgress.place!.startOffset });
    assert.ok(inProgress.place!.startOffset > 0, 'after the header');
    assert.equal(running.queueLength, 1, 'what waits behind the turn');

    // Reading is not acting: the answer is a copy, and asking again moves nothing on.
    running.routes.routes.length = 0;
    running.routes.current = 'changed';
    const calls = f.model.calls;
    const again = loop.dashboardState();
    assert.equal(again.routes.current, 'default');
    assert.equal(again.routes.routes.length, 1);
    assert.equal(again.queueLength, 1);
    assert.equal(f.model.calls, calls);

    reply.call('reply_to_mac', { text: 'おはよう', expression: 'neutral' });
    reply.finish();
    f.model.auto = () => 'おわり';
    await completed(events, sent.eventId);
    await loop.idle();
    const after = loop.dashboardState();
    assert.equal(after.turn, null);
    assert.equal(loop.turnInProgress(), undefined);
    assert.equal(after.queueLength, 0);
    assert.equal(typeof after.context.tokens, 'number', 'measured after the turn, not on every read');
    assert.equal(after.context.measuredAt, '2026-01-01T00:00:00.000Z');
  } finally { await f.cleanup(); }
});
