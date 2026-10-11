import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { CURATOR_DEFAULTS, LOOP_DEFAULTS, type CuratorConfig, type LoopConfig } from '../src/server/config.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { CURATOR_STAGES } from '../src/server/memory-curator.ts';
import { curatorSystemPrompt, NAP_INSTRUCTIONS, REVIEW_INSTRUCTIONS } from '../src/server/prompts.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop, type LoopClientEvent, type LoopOptions } from '../src/server/thinking-loop.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { startFakeRunner, type FakeRunner } from './support/fake-runner.ts';
import { ScriptedModel, type ScriptedStep } from './support/scripted-model.ts';

// The sleeping pill (ADR 0077): the owner puts natsumi to sleep, and she makes up what the last night left out, or naps.
// Fictional memories only. The clock is the test's: the night is 02:00 in Tokyo, and the curator's morning ends at 05:30.

const HANDOFF = 'HANDOFF-MARKER-6120';
const NAP_HANDOFF = 'NAP-HANDOFF-MARKER-7731';
const TZ = 'Asia/Tokyo';

type OpenOptions = Partial<Omit<LoopOptions, 'loop' | 'curator'>> & { loop?: Partial<LoopConfig>; curator?: Partial<CuratorConfig> | false };

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-pill-loop-')));
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
  const git = (...args: string[]) => execFileSync('git', ['-C', memory, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8' }).trim();
  const opened: ThinkingLoop[] = [];
  let runner: FakeRunner | undefined;
  const logs: string[] = [];
  let counter = 0;
  /** 12:00 in Tokyo, ten hours after the night's switching time and past the curator's morning deadline. */
  const clock = { at: Date.parse('2026-10-05T12:00:00+09:00') };
  const f = {
    root, data, memory, sessionDirectory, db, model, git, logs, clock,
    async open({ loop: settings, curator, ...options }: OpenOptions = {}) {
      runner ??= await startFakeRunner({ dir: memory });
      const loop = await ThinkingLoop.open({
        db, dataDirectory: data, sessionDirectory, agentDirectory, target: SUBSCRIPTION_TARGET, thinking: 'on', runtime: fixtureRuntime,
        loop: { ...LOOP_DEFAULTS, timeZone: TZ, nightlyRotationAt: '02:00', workspaceSocket: runner.path, ...settings },
        ...(curator === false ? {} : { curator: { ...CURATOR_DEFAULTS, stopStartingAt: '05:30', ...curator } }),
        configureSession: session => { session.agent.streamFunction = model.streamFunction; },
        now: () => clock.at, log: line => logs.push(line), ...options,
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
    rotations: () => f.db.prepare('SELECT kind, state, reason, handoff_commit, to_session_id FROM session_rotations ORDER BY created_at, rowid')
      .all().map(row => ({ ...row as Record<string, unknown> })),
    turns: () => db.prepare('SELECT * FROM turn_stats ORDER BY started_at, rowid').all() as Record<string, unknown>[],
    curatorTurns: () => f.turns().filter(turn => turn.kind === 'curator').map(turn => [turn.event_kinds, turn.outcome]),
    sessionId: () => (db.prepare('SELECT pi_session_id FROM conversations').get() as { pi_session_id: string }).pi_session_id,
    async cleanup() {
      for (const loop of opened) await loop.close();
      await runner?.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  return f;
}

type Fixture = Awaited<ReturnType<typeof setup>>;

const textOf = (message: Context['messages'][number]) => {
  const content = (message as { content: unknown }).content;
  if (typeof content === 'string') return content;
  return (content as { type: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text).join('');
};
const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });
const isCurator = (context: Context) => context.systemPrompt?.startsWith(curatorSystemPrompt('なつみ')) === true;
const stageOf = (context: Context) => CURATOR_STAGES.find(stage => context.systemPrompt?.includes(stage.instructions('なつみ')))?.name;
const lastUser = (context: Context) => textOf([...context.messages].reverse().find(message => message.role === 'user')!);

interface Behaviour {
  /** What natsumi does when she is told to nap; by default she writes her handoff. */
  nap?: ScriptedStep[];
  /** What each stage of the curator does, a call at a time; by default each ends at once. */
  curator?: Partial<Record<string, ScriptedStep[]>>;
}

/**
 * natsumi answers owner messages and writes her handoff at night and at a nap; the curator's stages end at once unless
 * told otherwise. Every context is kept, natsumi's and the curator's apart.
 */
function behave(f: Fixture, behaviour: Behaviour = {}) {
  const seen = { natsumi: [] as Context[], curator: [] as Context[] };
  f.model.auto = context => {
    if (isCurator(context)) {
      seen.curator.push(context);
      if (context.messages.at(-1)?.role === 'assistant') return { calls: [] };
      const calls = context.messages.filter(message => message.role === 'assistant').length;
      return behaviour.curator?.[stageOf(context) ?? '']?.[calls] ?? { calls: [] };
    }
    seen.natsumi.push(context);
    const user = lastUser(context);
    const answered = context.messages.at(-1)?.role !== 'user';
    if (user.includes('"type":"nap"')) {
      // The nap's own steps, a model call at a time, counted from the event that began it.
      const begun = context.messages.findLastIndex(message => message.role === 'user');
      const calls = context.messages.slice(begun).filter(message => message.role === 'assistant').length;
      return (behaviour.nap ?? [{ calls: [call('write_handoff_note', { text: `${NAP_HANDOFF} 昼寝の前の続き` })] }])[calls] ?? { calls: [] };
    }
    if (answered) return { calls: [] };
    if (user.includes('"nightly_review"')) return { calls: [call('write_handoff_note', { text: `${HANDOFF} 明日も続き` })] };
    return { calls: [call('reply_to_mac', { text: 'はい', expression: 'neutral' })] };
  };
  return seen;
}

async function aDay(f: Fixture, loop: ThinkingLoop, text = '今日の話') {
  f.send(loop, text);
  await loop.idle();
}

/** Takes the pill and waits until natsumi is awake again. */
async function pill(loop: ThinkingLoop) {
  const taken = await loop.takeSleepingPill();
  assert.equal(taken.kind, 'accepted');
  await loop.idle();
  return taken as Extract<typeof taken, { kind: 'accepted' }>;
}

const ALL_OK = [['memory_curator:knowledge', 'ok'], ['memory_curator:archive', 'ok'], ['memory_curator:structure', 'ok'],
  ['memory_curator:index', 'ok']];
const ALL_SKIPPED = ALL_OK.map(([stage]) => [stage, 'skipped-deadline']);

test('a pill after a night with no review sleeps deep: the night itself, with the pill\'s deadline for the curator', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const seen = behave(f);
    await aDay(f, loop);
    const before = f.sessionId();
    assert.equal((await loop.sleepStatus()).kind, 'deep');

    const taken = await pill(loop);

    assert.equal(taken.pill, 'deep');
    assert.equal(taken.joined, false);
    // natsumi is told what the night tells her, word for word.
    const review = seen.natsumi.find(context => lastUser(context).includes('"type":"nightly_review"'));
    assert.ok(review);
    assert.ok(lastUser(review).includes(JSON.stringify(REVIEW_INSTRUCTIONS).slice(1, -1)));
    // The night's deadline, 05:30, has passed; the pill's is 90 minutes from now, so the stages run.
    assert.deepEqual(f.curatorTurns(), ALL_OK);
    assert.notEqual(f.sessionId(), before);
    assert.deepEqual(f.rotations().map(row => [row.kind, row.state]), [['deep', 'switched']]);
    assert.ok(f.rotations()[0]!.handoff_commit);
    const reviewTurn = f.turns().find(turn => turn.kind === 'review');
    assert.equal(reviewTurn?.event_kinds, 'nightly_review');
    assert.deepEqual(events.filter(event => event.type === 'avatar.expression').map(event => event.payload.expression).slice(-2),
      ['sleepy', 'neutral']);

    // A new session with nothing in it yet: a pill would do nothing.
    assert.equal((await loop.sleepStatus()).kind, 'none');
    // Everything the night does is done now: once she has talked, the next pill is a nap.
    await aDay(f, loop, '昼の話');
    const status = await loop.sleepStatus();
    assert.equal(status.kind, 'nap');
    assert.deepEqual(status.done, { review: true, curator: true, session: true });
    assert.equal(status.night, '2026-10-04T17:00:00.000Z');
    assert.equal(status.inProgress, null);
  } finally { await f.cleanup(); }
});

test('a nap writes the handoff alone in a turn of its own, runs no curator, and moves to a new session', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const seen = behave(f);
    await aDay(f, loop);
    await pill(loop);
    await aDay(f, loop, '昼の話');
    const before = f.sessionId();
    const curatorCalls = seen.curator.length;
    const sent = events.filter(event => event.type === 'conversation.message').length;

    const taken = await pill(loop);

    assert.equal(taken.pill, 'nap');
    const nap = seen.natsumi.find(context => lastUser(context).includes('"type":"nap"'));
    assert.ok(nap, 'the nap is an event of its own');
    assert.ok(lastUser(nap).includes(JSON.stringify(NAP_INSTRUCTIONS).slice(1, -1)));
    assert.equal(seen.curator.length, curatorCalls, 'the curator does not run in a nap');
    assert.notEqual(f.sessionId(), before);
    assert.deepEqual(f.rotations().map(row => [row.kind, row.state]), [['deep', 'switched'], ['nap', 'switched']]);
    assert.equal(f.turns().at(-1)?.event_kinds, 'nap');
    assert.equal(f.turns().at(-1)?.kind, 'review');
    assert.equal(events.filter(event => event.type === 'conversation.message').length, sent, 'nothing is said to the owner');

    // The new session begins from the nap's handoff.
    let morning: Context | undefined;
    f.model.auto = context => { if (!morning && context.messages.at(-1)?.role === 'user') morning = context; return { calls: [] }; };
    await aDay(f, loop, '起きた？');
    assert.match(morning!.systemPrompt ?? '', new RegExp(NAP_HANDOFF));
  } finally { await f.cleanup(); }
});

test('a nap that writes no handoff fails and keeps the session; replying in it is refused, and so is a handoff outside one', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open();
    const seen = behave(f, { nap: [{ calls: [call('reply_to_mac', { text: 'おやすみ', expression: 'sleepy' })] }] });
    await aDay(f, loop);
    await pill(loop);
    await aDay(f, loop, '昼の話');
    const before = f.sessionId();

    await pill(loop);

    assert.equal(f.sessionId(), before, 'no handoff, no new session');
    assert.deepEqual(f.rotations().at(-1), { kind: 'nap', state: 'failed', reason: 'no-handoff', handoff_commit: null, to_session_id: null });
    const refused = seen.natsumi.at(-1)!.messages.at(-1)!;
    assert.equal(refused.role, 'toolResult');
    assert.match(textOf(refused), /送信していません。昼寝の間は、マスターに話しかけません/);
    assert.equal(f.db.prepare(`SELECT count(*) AS n FROM conversation_messages WHERE role = 'natsumi' AND text = 'おやすみ'`).get()!.n, 0);

    // In a turn of the day, the handoff is refused with words that name both places it may be written.
    f.model.auto = context => context.messages.at(-1)?.role === 'user'
      ? { calls: [call('write_handoff_note', { text: '日中の引き継ぎ' })] } : { calls: [] };
    const contexts = f.model.contexts.length;
    await aDay(f, loop, '引き継ぎを書いて');
    const result = f.model.contexts.slice(contexts).map(context => context.messages.at(-1)!).find(message => message.role === 'toolResult');
    assert.match(textOf(result!), /夜の振り返り（nightly_review）か昼寝（nap）の中でだけ使えます/);
  } finally { await f.cleanup(); }
});

test('a pill after a night whose curator did not finish sleeps again: the curator alone, the session kept, and the row ends curated', async () => {
  const f = await setup();
  try {
    // natsumi was stopped through the night and switches at 06:00: past the morning deadline, the curator begins nothing.
    f.clock.at = Date.parse('2026-10-05T06:00:00+09:00');
    const { loop } = await f.open();
    const seen = behave(f);
    await aDay(f, loop);
    assert.equal((await loop.rotate()).result, 'switched');
    assert.deepEqual(f.curatorTurns(), ALL_SKIPPED);
    await aDay(f, loop, '朝の話');
    const session = f.sessionId();
    const natsumiCalls = seen.natsumi.length;
    const status = await loop.sleepStatus();
    assert.equal(status.kind, 'resleep');
    assert.deepEqual(status.done, { review: true, curator: false, session: true });
    assert.deepEqual(status.lastFailure, { source: 'curator', stage: 'index', outcome: 'skipped-deadline', at: '2026-10-04T21:00:00.000Z' });

    f.clock.at += 60_000;
    const taken = await pill(loop);

    assert.equal(taken.pill, 'resleep');
    assert.equal(seen.natsumi.length, natsumiCalls, 'natsumi has no turn');
    assert.equal(f.sessionId(), session, 'the session is kept');
    assert.deepEqual(f.curatorTurns().slice(4), ALL_OK);
    assert.deepEqual(f.rotations().map(row => [row.kind, row.state]), [['night', 'switched'], ['resleep', 'curated']]);
    await aDay(f, loop, '昼の話');
    assert.equal((await loop.sleepStatus()).kind, 'nap');
  } finally { await f.cleanup(); }
});

test('a resleep whose curator leaves a topic stage undone fails as curator-incomplete; the pill\'s deadline counts from the pill', async () => {
  const f = await setup();
  try {
    f.clock.at = Date.parse('2026-10-05T06:00:00+09:00');
    const { loop } = await f.open({ curator: { pillStopStartingAfterMinutes: 1 } });
    // The first stage takes two minutes, past the pill's one: no stage after it begins.
    const seen = behave(f);
    const auto = f.model.auto!;
    f.model.auto = context => {
      if (isCurator(context) && stageOf(context) === 'knowledge') f.clock.at += 120_000;
      return auto(context);
    };
    void seen;
    await aDay(f, loop);
    await loop.rotate();
    await aDay(f, loop, '朝の話');
    f.clock.at += 60_000;

    await pill(loop);

    assert.deepEqual(f.curatorTurns().slice(4), [['memory_curator:knowledge', 'ok'], ['memory_curator:archive', 'skipped-deadline'],
      ['memory_curator:structure', 'skipped-deadline'], ['memory_curator:index', 'skipped-deadline']]);
    assert.deepEqual(f.rotations().at(-1), { kind: 'resleep', state: 'failed', reason: 'curator-incomplete', handoff_commit: null,
      to_session_id: null });
    assert.equal((await loop.sleepStatus()).kind, 'resleep', 'the curator is still missing');
  } finally { await f.cleanup(); }
});

test('a pill after a night that could not make its new session resumes from the handoff left, running the curator first', async () => {
  const f = await setup();
  try {
    // The day began before the night's time; natsumi was stopped through it and switches at 06:00.
    f.clock.at = Date.parse('2026-10-05T01:00:00+09:00');
    let refuse = false;
    const { loop } = await f.open({ reviseSystemPrompt: prompt => { if (refuse) throw new Error('synthetic refusal'); return prompt; } });
    const seen = behave(f);
    await aDay(f, loop);
    f.clock.at = Date.parse('2026-10-05T06:00:00+09:00');
    refuse = true;
    assert.deepEqual(await loop.rotate(), { result: 'failed', reason: 'session-create-failed' });
    refuse = false;
    const session = f.sessionId();
    const natsumiCalls = seen.natsumi.length;
    const status = await loop.sleepStatus();
    assert.equal(status.kind, 'resume');
    assert.deepEqual(status.lastFailure, { source: 'rotation', kind: 'night', state: 'failed', reason: 'session-create-failed',
      at: '2026-10-04T21:00:00.000Z' });

    f.clock.at += 60_000;
    const taken = await pill(loop);

    assert.equal(taken.pill, 'resume');
    assert.equal(seen.natsumi.length, natsumiCalls, 'natsumi has no turn');
    assert.deepEqual(f.curatorTurns().slice(4), ALL_OK, 'the curator the night left out runs first');
    assert.notEqual(f.sessionId(), session);
    const [, resumed] = f.rotations();
    assert.equal(resumed!.kind, 'resume');
    assert.equal(resumed!.state, 'switched');
    assert.equal(resumed!.handoff_commit, f.git('rev-parse', 'HEAD'), 'the commit in hand when the session was made');

    let morning: Context | undefined;
    f.model.auto = context => { if (!morning && context.messages.at(-1)?.role === 'user') morning = context; return { calls: [] }; };
    await aDay(f, loop, 'おはよう');
    assert.match(morning!.systemPrompt ?? '', new RegExp(HANDOFF), 'from the night\'s handoff');
    assert.equal((await loop.sleepStatus()).kind, 'nap');
  } finally { await f.cleanup(); }
});

test('a pill on an empty session does nothing, and leaves no row', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open();
    behave(f);
    assert.equal((await loop.sleepStatus()).kind, 'none');
    const taken = await pill(loop);
    assert.equal(taken.pill, 'none');
    assert.deepEqual(f.rotations(), []);
    assert.equal(f.db.prepare('SELECT state FROM loop_events WHERE event_id = ?').get(taken.eventId)!.state, 'no-reply');
  } finally { await f.cleanup(); }
});

test('without a switching time, a pill with no review on record sleeps deep, and one after it naps', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open({ loop: { nightlyRotationAt: false } });
    behave(f);
    await aDay(f, loop);
    const status = await loop.sleepStatus();
    assert.equal(status.kind, 'deep');
    assert.equal(status.night, null);
    await pill(loop);
    await aDay(f, loop, '昼の話');
    assert.equal((await loop.sleepStatus()).kind, 'nap');
  } finally { await f.cleanup(); }
});

test('a pill joins a night that is waiting or running, and a second pill joins the first: nothing sleeps twice', async () => {
  const f = await setup();
  try {
    f.clock.at = Date.parse('2026-10-05T02:00:00+09:00');
    const { loop } = await f.open();
    behave(f);
    await aDay(f, loop);

    const night = loop.rotate();
    const joined = await loop.takeSleepingPill();
    assert.equal(joined.kind, 'accepted');
    assert.equal((joined as { joined: boolean }).joined, true);
    assert.equal((await night).result, 'switched');
    await loop.idle();
    assert.deepEqual(f.rotations().map(row => row.kind), ['night']);

    await aDay(f, loop, '昼の話');
    const first = await loop.takeSleepingPill();
    const second = await loop.takeSleepingPill();
    assert.equal((second as { joined: boolean }).joined, true);
    assert.equal((second as { eventId: string }).eventId, (first as { eventId: string }).eventId);
    await loop.idle();
    assert.deepEqual(f.rotations().map(row => row.kind), ['night', 'nap']);
  } finally { await f.cleanup(); }
});

test('the night\'s time joins a pill still waiting, which, judged as it begins, sleeps deep', async () => {
  const f = await setup();
  try {
    f.clock.at = Date.parse('2026-10-05T01:30:00+09:00');
    const { loop } = await f.open();
    behave(f);
    await aDay(f, loop);
    // Yesterday's night is done: a pill now would be a nap.
    await pill(loop);
    await aDay(f, loop, '夜ふかし');
    assert.equal((await loop.sleepStatus()).kind, 'nap');

    // A turn is running when the pill is taken; it waits behind it, and the night's time comes meanwhile.
    f.model.takeOver();
    f.send(loop, 'まだ起きてる？');
    const turn = await f.model.next();
    const taken = await loop.takeSleepingPill();
    assert.equal((taken as { joined: boolean }).joined, false);
    const status = await loop.sleepStatus();
    assert.deepEqual(status.inProgress && { kind: status.inProgress.kind, state: status.inProgress.state }, { kind: 'sleeping-pill', state: 'queued' });
    f.clock.at = Date.parse('2026-10-05T02:00:00+09:00');
    const night = loop.rotate();
    behave(f);
    turn.call('reply_to_mac', { text: 'うん', expression: 'neutral' });
    turn.finish();

    assert.equal((await night).result, 'switched', 'the night waits for the pill it joined');
    await loop.idle();
    assert.deepEqual(f.rotations().map(row => [row.kind, row.state]).slice(-1), [['deep', 'switched']]);
  } finally { await f.cleanup(); }
});

test('a message sent while she sleeps waits, and the new session answers it after she wakes', async () => {
  const f = await setup();
  try {
    const { loop, events } = await f.open();
    const seen = behave(f);
    await aDay(f, loop);
    await loop.takeSleepingPill();
    const sent = f.send(loop, 'ねてる？');
    await loop.idle();

    const review = seen.natsumi.find(context => lastUser(context).includes('"type":"nightly_review"'))!;
    assert.doesNotMatch(JSON.stringify(review.messages), /ねてる？/, 'not steered into the review');
    const answer = seen.natsumi.find(context => lastUser(context).includes('ねてる？'))!;
    assert.match(answer.systemPrompt ?? '', new RegExp(HANDOFF));
    assert.equal(f.db.prepare('SELECT state FROM loop_events WHERE event_id = ?').get(sent.eventId)!.state, 'replied');
    const expressions = events.filter(event => event.type === 'avatar.expression').map(event => event.payload.expression);
    assert.ok(expressions.indexOf('sleepy') >= 0);
    assert.ok(!expressions.slice(expressions.indexOf('sleepy') + 1, expressions.lastIndexOf('sleepy') + 1).includes('thinking'),
      'asleep, she does not look like thinking');
  } finally { await f.cleanup(); }
});

test('a pill is refused while natsumi cannot talk', async () => {
  const f = await setup();
  try {
    const { loop } = await f.open({ runtime: () => Promise.reject(new Error('synthetic')) });
    assert.deepEqual(await loop.takeSleepingPill(), { kind: 'unavailable', code: 'pi-unavailable' });
  } finally { await f.cleanup(); }
});

test('the night\'s time during a pill already under way does not join it: the night runs after it, and is not skipped', async () => {
  const f = await setup();
  try {
    f.clock.at = Date.parse('2026-10-05T06:00:00+09:00');
    const { loop } = await f.open();
    behave(f);
    await aDay(f, loop);
    await loop.rotate();
    await aDay(f, loop, '夜ふかし');
    f.clock.at = Date.parse('2026-10-06T01:30:00+09:00');
    // Last night's curator is still missing: a resleep. While its first stage runs, the next night's time comes.
    let night: Promise<{ result: string }> | undefined;
    const auto = f.model.auto!;
    f.model.auto = context => {
      if (!night && isCurator(context)) {
        f.clock.at = Date.parse('2026-10-06T02:00:00+09:00');
        night = loop.rotate();
      }
      return auto(context);
    };
    assert.equal((await loop.sleepStatus()).kind, 'resleep');

    await pill(loop);

    assert.ok(night);
    assert.equal((await night).result, 'switched', 'the night ran a review of its own');
    assert.deepEqual(f.rotations().map(row => [row.kind, row.state]), [['night', 'switched'], ['resleep', 'curated'], ['night', 'switched']]);
  } finally { await f.cleanup(); }
});
