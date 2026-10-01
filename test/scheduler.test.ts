import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { SUBSCRIPTION_TARGET } from '../src/probe/session.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { isAwake, Scheduler, SelfChecks, type ScheduledLoop } from '../src/server/scheduler.ts';
import { LOOP_DEFAULTS, type LoopConfig } from '../src/server/config.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';
import { ThinkingLoop, type LoopClientEvent, type LoopOptions, type SendOutcome } from '../src/server/thinking-loop.ts';
import { fixtureRuntime } from './support/fixture.ts';
import { ScriptedModel } from './support/scripted-model.ts';

/** What a test may replace when it opens a loop: loop settings are overlaid on `LOOP_DEFAULTS`. */
type OpenOptions = Partial<Omit<LoopOptions, 'loop'>> & { loop?: Partial<LoopConfig> };

const MINUTE = 60_000;
/** Tokyo is UTC+9 all year, so local times read directly. */
const TZ = 'Asia/Tokyo';
const tokyo = (local: string) => Date.parse(`${local.replace(' ', 'T')}:00+09:00`);
const AWAKE = { start: '08:00', end: '23:00' };

async function until<T>(check: () => T | undefined | false, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function setup(start: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-scheduler-')));
  const data = join(root, 'data');
  const sessionDirectory = join(root, 'pi', 'sessions');
  const agentDirectory = join(root, 'pi', 'agent');
  await mkdir(join(data, 'memory'), { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(join(data, 'personality.md'), '# 性格・話し方\n落ち着いた話し方\n');
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const model = new ScriptedModel();
  const opened: ThinkingLoop[] = [];
  let counter = 0;
  const f = {
    db, model,
    clock: tokyo(start),
    at(local: string) { f.clock = tokyo(local); },
    advance(minutes: number) { f.clock += minutes * MINUTE; },
    async open({ loop: settings, ...options }: OpenOptions = {}) {
      const loop = await ThinkingLoop.open({
        db, dataDirectory: data, sessionDirectory, agentDirectory, target: SUBSCRIPTION_TARGET, thinking: 'on',
        runtime: fixtureRuntime, now: () => f.clock,
        loop: { ...LOOP_DEFAULTS, timeZone: TZ, awakeHours: AWAKE, eventModelCalls: 6, ...settings },
        configureSession: (session: AgentSession) => { session.agent.streamFunction = model.streamFunction; },
        ...options,
      });
      opened.push(loop);
      const events: LoopClientEvent[] = [];
      loop.subscribe(event => { events.push(event); });
      const scheduler = new Scheduler({ loop, now: () => f.clock, timeZone: TZ, awakeHours: AWAKE, pingIntervalMinutes: 30,
        expressionResetMinutes: 3, nightlyRotationAt: false });
      return { loop, events, scheduler };
    },
    send(loop: ThinkingLoop, text: string) {
      const outcome = loop.send({ requestId: `request-${++counter}`, deviceId: 'device-1', text });
      assert.equal(outcome.kind, 'accepted', JSON.stringify(outcome));
      return outcome as Extract<SendOutcome, { kind: 'accepted' }>;
    },
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
const eventLines = (text: string) => [...text.matchAll(/^\{.*\}$/gm)].map(match => JSON.parse(match[0]) as Record<string, any>);
const toolResults = (context: Context) => {
  const lastAssistant = context.messages.map(m => m.role).lastIndexOf('assistant');
  return context.messages.slice(lastAssistant + 1).filter(m => m.role === 'toolResult')
    .map(m => ({ text: textOf(m), isError: (m as { isError: boolean }).isError }));
};
const expressions = (events: LoopClientEvent[]) => events.filter(e => e.type === 'avatar.expression').map(e => e.payload.expression);
const completed = (events: LoopClientEvent[], eventId: string) =>
  until(() => events.find(e => e.type === 'conversation.event.completed' && e.payload.eventId === eventId));

/** Takes the next model call, which must carry exactly one event, and returns that event with the call. */
async function nextEvent(f: Awaited<ReturnType<typeof setup>>) {
  const reply = await f.model.next();
  const lines = eventLines(lastUserText(reply.context));
  assert.equal(lines.length, 1, lastUserText(reply.context));
  return { reply, event: lines[0]! };
}

/** Answers an owner message with the given tool calls, then shows the results to the test and stops, which ends the turn. */
async function ownerTurn(f: Awaited<ReturnType<typeof setup>>, loop: ThinkingLoop, events: LoopClientEvent[], text: string,
  calls: [string, Record<string, unknown>][]) {
  const sent = f.send(loop, text);
  const { reply } = await nextEvent(f);
  for (const [name, args] of calls) reply.call(name, args);
  reply.finish();
  const after = await f.model.next();
  const results = toolResults(after.context);
  after.finish();
  await completed(events, sent.eventId);
  await loop.idle();
  return results;
}

test('the awake hours are read in the owner\'s time zone and may run past midnight', () => {
  assert.equal(isAwake(tokyo('2026-09-17 07:59'), AWAKE, TZ), false);
  assert.equal(isAwake(tokyo('2026-09-17 08:00'), AWAKE, TZ), true);
  assert.equal(isAwake(tokyo('2026-09-17 22:59'), AWAKE, TZ), true);
  assert.equal(isAwake(tokyo('2026-09-17 23:00'), AWAKE, TZ), false);
  const late = { start: '22:00', end: '06:00' };
  assert.equal(isAwake(tokyo('2026-09-17 23:30'), late, TZ), true);
  assert.equal(isAwake(tokyo('2026-09-17 05:59'), late, TZ), true);
  assert.equal(isAwake(tokyo('2026-09-17 12:00'), late, TZ), false);
});

test('a self-check is booked relative or at a local time and saved as an absolute time; what cannot be read is refused with the reason', async () => {
  const f = await setup('2026-09-17 10:00');
  try {
    const checks = new SelfChecks({ db: f.db, now: () => f.clock, timeZone: TZ, awakeHours: AWAKE });
    const due = () => (f.db.prepare(`SELECT reason, due_at FROM self_checks WHERE state = 'pending' ORDER BY due_at`).all() as { reason: string; due_at: string }[])
      .map(row => [row.reason, row.due_at]);

    const relative = checks.schedule('洗濯物を取り込んだか確認する', { inMinutes: 30 });
    assert.equal(relative.ok, true, relative.text);
    assert.match(relative.text, /2026-09-17 10:30/);
    const today = checks.schedule('会議の準備を聞く', { at: '15:00' });
    assert.equal(today.ok, true, today.text);
    assert.match(today.text, /2026-09-17 15:00/);
    const dated = checks.schedule('週末の予定を聞く', { at: '2026-09-18T09:00' });
    assert.equal(dated.ok, true, dated.text);
    assert.deepEqual(due(), [
      ['洗濯物を取り込んだか確認する', '2026-09-17T01:30:00.000Z'],
      ['会議の準備を聞く', '2026-09-17T06:00:00.000Z'],
      ['週末の予定を聞く', '2026-09-18T00:00:00.000Z'],
    ]);

    const refusals: [string, ReturnType<SelfChecks['schedule']>, RegExp][] = [
      ['past', checks.schedule('朝の確認', { at: '09:00' }), /過去/],
      ['now', checks.schedule('今の確認', { at: '10:00' }), /過去/],
      ['zero', checks.schedule('すぐの確認', { inMinutes: 0 }), /1 以上/],
      ['fraction', checks.schedule('すぐの確認', { inMinutes: 1.5 }), /整数/],
      ['both', checks.schedule('両方', { inMinutes: 30, at: '15:00' }), /どれか 1 つ/],
      ['cron and at', checks.schedule('両方', { cron: '0 16 * * *', at: '15:00' }), /どれか 1 つ/],
      ['neither', checks.schedule('なし', {}), /どれか 1 つ/],
      ['bad time', checks.schedule('形が違う', { at: '3pm' }), /HH:MM/],
      ['bad cron', checks.schedule('形が違う', { cron: '0 16 * *' }), /cron.*5 つ/],
      ['never', checks.schedule('来ない日', { cron: '0 0 30 2 *' }), /当てはまる/],
      ['only at night', checks.schedule('夜中', { cron: '0 3 * * *' }), /08:00〜23:00.*外/],
      ['no reason', checks.schedule('  ', { inMinutes: 30 }), /理由/],
    ];
    for (const [name, outcome, reason] of refusals) {
      assert.equal(outcome.ok, false, name);
      assert.match(outcome.text, reason, name);
    }
    assert.equal(due().length, 3);

    // The list reads the bookings; a cancelled one is gone from it.
    const listed = checks.list();
    assert.equal(listed.ok, true);
    const id = /(check-[0-9a-f-]+)[^\n]*洗濯物/.exec(listed.text)?.[1];
    assert.ok(id, listed.text);
    assert.match(listed.text, /2026-09-17 15:00.*会議の準備を聞く/);
    assert.equal(checks.cancel('check-missing').ok, false);
    assert.equal(checks.cancel(id!).ok, true);
    assert.equal(checks.cancel(id!).ok, false);
    assert.doesNotMatch(checks.list().text, /洗濯物/);
  } finally { await f.cleanup(); }
});

test('there is no limit on how soon, how far, how many or how many a day, and the same reason may be booked twice', async () => {
  const f = await setup('2026-09-17 10:00');
  try {
    const checks = new SelfChecks({ db: f.db, now: () => f.clock, timeZone: TZ, awakeHours: AWAKE });
    assert.match(checks.schedule('すぐの確認', { inMinutes: 1 }).text, /2026-09-17 10:01/);
    assert.match(checks.schedule('遠い確認', { at: '2027-09-02 18:00' }).text, /2027-09-02 18:00/);
    for (let i = 0; i < 30; i += 1) assert.equal(checks.schedule(`確認 ${i}`, { inMinutes: 10 + i }).ok, true, `booking ${i}`);
    // A repeating and a one-off booking for the same reason are two bookings, and so are two one-offs.
    const repeating = checks.schedule('水を飲んだか聞く', { cron: '0 16 * * *' });
    const once = checks.schedule('水を飲んだか聞く', { at: '12:00' });
    const again = checks.schedule(' 水を飲んだか聞く　', { at: '13:00' });
    for (const outcome of [repeating, once, again]) assert.equal(outcome.ok, true, outcome.text);
    assert.doesNotMatch(once.text + again.text, /まとめ/);
    const count = f.db.prepare(`SELECT COUNT(*) AS n FROM self_checks WHERE state = 'pending'`).get() as { n: number };
    assert.equal(count.n, 35);
    assert.equal(checks.list().text.match(/水を飲んだか聞く/g)?.length, 3);
  } finally { await f.cleanup(); }
});

test('a repeating booking is written as cron in the owner\'s time zone, and the list shows its expression and next run', async () => {
  const f = await setup('2026-09-17 10:03');
  try {
    const checks = new SelfChecks({ db: f.db, now: () => f.clock, timeZone: TZ, awakeHours: AWAKE });
    const daily = checks.schedule('今日の予定を確かめる', { cron: '0 16 * * *' });
    assert.equal(daily.ok, true, daily.text);
    assert.match(daily.text, /0 16 \* \* \*/);
    assert.match(daily.text, /2026-09-17 16:00/);
    assert.match(daily.text, /繰り返し/);
    const often = checks.schedule('様子を見る', { cron: '*/10 * * * *' });
    assert.match(often.text, /2026-09-17 10:10/);
    assert.equal(checks.schedule('昼の確認', { at: '12:00' }).ok, true);

    const listed = checks.list().text;
    assert.match(listed, /check-[0-9a-f-]+ 2026-09-17 10:10 様子を見る（繰り返し: \*\/10 \* \* \* \*）/);
    assert.match(listed, /check-[0-9a-f-]+ 2026-09-17 12:00 昼の確認\n/);
    assert.match(listed, /check-[0-9a-f-]+ 2026-09-17 16:00 今日の予定を確かめる（繰り返し: 0 16 \* \* \*）/);

    // The next run shown is the next inside the awake hours: late at night, it is the morning's.
    f.at('2026-09-17 22:55');
    const night = checks.schedule('夜も見る', { cron: '*/10 * * * *' });
    assert.match(night.text, /2026-09-18 08:00/);
    assert.match(night.text, /08:00〜23:00.*外の回は飛ばします/);
    // A repeating booking can be cancelled like any other.
    const id = /(check-[0-9a-f-]+) [^\n]*今日の予定を確かめる/.exec(checks.list().text)![1]!;
    assert.equal(checks.cancel(id).ok, true);
    assert.doesNotMatch(checks.list().text, /今日の予定を確かめる/);
  } finally { await f.cleanup(); }
});

test('a booking outside the awake hours is accepted with a note that it waits for the morning', async () => {
  const f = await setup('2026-09-17 21:00');
  try {
    const checks = new SelfChecks({ db: f.db, now: () => f.clock, timeZone: TZ, awakeHours: AWAKE });
    const night = checks.schedule('寝る前の確認', { at: '23:30' });
    assert.equal(night.ok, true, night.text);
    assert.match(night.text, /08:00/);
    assert.deepEqual(checks.due().map(check => check.reason), []);
    f.at('2026-09-17 23:31');
    assert.deepEqual(checks.due().map(check => check.reason), ['寝る前の確認']);
  } finally { await f.cleanup(); }
});

test('the ping comes only in the awake hours after a quiet interval, and carries the count of unchecked notices', async () => {
  const f = await setup('2026-09-17 07:00');
  try {
    const { loop, events, scheduler } = await f.open();
    // Night: quiet for 40 minutes, but no ping.
    f.at('2026-09-17 07:40');
    assert.equal(scheduler.tick(), undefined);
    assert.equal(f.model.calls, 0);

    f.at('2026-09-17 08:00');
    assert.equal(scheduler.tick(), 'ping');
    const ping = await nextEvent(f);
    assert.equal(ping.event.type, 'ping');
    assert.equal(ping.event.local_time, '2026-09-17 08:00');
    assert.equal('unacknowledged_notices' in ping.event, false);
    assert.match(ping.reply.context.systemPrompt ?? '', /ping/);
    ping.reply.finish();
    await loop.idle();
    // Nothing reaches the owner for a ping on its own.
    assert.equal(events.filter(e => e.type === 'conversation.event.completed' || e.type === 'conversation.message').length, 0);

    // The ping's own handling restarted the quiet clock.
    assert.equal(scheduler.tick(), undefined);
    f.at('2026-09-17 08:20');
    assert.equal(scheduler.tick(), undefined);

    // A conversation restarts it too.
    const sent = f.send(loop, '相談');
    const turn = await nextEvent(f);
    turn.reply.call('notify_owner', { text: 'あとで確認してほしいことがあります', expression: 'neutral' });
    turn.reply.call('reply_to_mac', { text: 'はい', expression: 'neutral' });
    turn.reply.finish();
    (await f.model.next()).finish();
    await completed(events, sent.eventId);
    await loop.idle();
    f.at('2026-09-17 08:40');
    assert.equal(scheduler.tick(), undefined);
    f.at('2026-09-17 08:50');
    assert.equal(scheduler.tick(), 'ping');
    const second = await nextEvent(f);
    assert.equal(second.event.type, 'ping');
    assert.equal(second.event.unacknowledged_notices, 1);

    // While the ping is being handled, time passing raises nothing more.
    f.at('2026-09-17 10:00');
    assert.equal(scheduler.tick(), undefined);
    second.reply.finish();
    await loop.idle();
    assert.equal(f.model.calls, 4);

    // Late at night the quiet goes on without a ping.
    f.at('2026-09-17 23:30');
    assert.equal(scheduler.tick(), undefined);
    assert.equal(f.model.calls, 4);
  } finally { await f.cleanup(); }
});

test('natsumi books a self-check with the tools, sees it arrive as an event with its reason, and can list and cancel', async () => {
  const f = await setup('2026-09-17 10:00');
  try {
    const { loop, events, scheduler } = await f.open();
    const results = await ownerTurn(f, loop, events, '30 分後に洗濯物のことを聞いて', [
      ['schedule_self_check', { reason: '洗濯物を取り込んだか聞く', in_minutes: 30 }],
      ['schedule_self_check', { reason: 'すぐ聞く', in_minutes: 0 }],
      ['schedule_self_check', { reason: '取り消す予定', at: '12:00' }],
      ['list_self_checks', {}],
    ]);
    assert.deepEqual(results.map(r => r.isError), [false, true, false, false]);
    assert.match(results[0]!.text, /2026-09-17 10:30/);
    assert.match(results[1]!.text, /1 以上/);
    const cancelId = /(check-[0-9a-f-]+)[^\n]*取り消す予定/.exec(results[3]!.text)?.[1];
    assert.ok(cancelId, results[3]!.text);
    const cancelled = await ownerTurn(f, loop, events, 'お昼のは要らない', [['cancel_self_check', { check_id: cancelId }]]);
    assert.deepEqual(cancelled.map(r => r.isError), [false]);

    f.at('2026-09-17 10:29');
    assert.equal(scheduler.tick(), undefined);
    f.at('2026-09-17 10:30');
    // The check is due at the same moment as the ping would be: the check goes first and the ping waits.
    assert.equal(scheduler.tick(), 'self-check');
    const check = await nextEvent(f);
    assert.equal(check.event.type, 'self_check');
    assert.equal(check.event.checks.length, 1);
    assert.equal(check.event.checks[0].reason, '洗濯物を取り込んだか聞く');
    assert.equal(check.event.checks[0].scheduled_for, '2026-09-17 10:30');
    assert.equal('late_minutes' in check.event.checks[0], false);
    assert.match(check.reply.context.systemPrompt ?? '', /self_check/);
    check.reply.call('list_self_checks', {});
    check.reply.finish();
    const after = await f.model.next();
    assert.doesNotMatch(toolResults(after.context)[0]!.text, /check-/);
    after.finish();
    await loop.idle();
    assert.equal(scheduler.tick(), undefined);
    f.at('2026-09-17 12:30');
    // The cancelled one never comes; only the ping does.
    assert.equal(scheduler.tick(), 'ping');
    const ping = await nextEvent(f);
    assert.equal(ping.event.type, 'ping');
    ping.reply.finish();
    await loop.idle();
  } finally { await f.cleanup(); }
});

test('bookings survive a restart, and those that passed while stopped or asleep arrive together in one event with how late they are', async () => {
  const f = await setup('2026-09-17 10:00');
  try {
    const first = await f.open();
    await ownerTurn(f, first.loop, first.events, '予定を覚えておいて', [
      ['schedule_self_check', { reason: 'お昼を食べたか聞く', in_minutes: 60 }],
      ['schedule_self_check', { reason: '午後の会議の準備を聞く', at: '12:00' }],
      ['schedule_self_check', { reason: '寝る前に明日の予定を聞く', at: '23:30' }],
    ]);
    await first.loop.close();

    f.at('2026-09-17 13:30');
    const second = await f.open();
    assert.equal(second.scheduler.tick(), 'self-check');
    const late = await nextEvent(f);
    assert.equal(late.event.type, 'self_check');
    assert.deepEqual(late.event.checks.map((check: Record<string, unknown>) => [check.reason, check.scheduled_for, check.late_minutes]), [
      ['お昼を食べたか聞く', '2026-09-17 11:00', 150],
      ['午後の会議の準備を聞く', '2026-09-17 12:00', 90],
    ]);
    // No second event follows while the first is handled.
    assert.equal(second.scheduler.tick(), undefined);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.model.calls, 3);
    late.reply.finish();
    await second.loop.idle();
    assert.equal(second.scheduler.tick(), undefined);

    // The night one waits through the night and comes in the morning.
    f.at('2026-09-17 23:31');
    assert.equal(second.scheduler.tick(), undefined);
    f.at('2026-09-18 07:59');
    assert.equal(second.scheduler.tick(), undefined);
    f.at('2026-09-18 08:00');
    assert.equal(second.scheduler.tick(), 'self-check');
    const morning = await nextEvent(f);
    assert.deepEqual(morning.event.checks.map((check: Record<string, unknown>) => [check.reason, check.late_minutes]), [['寝る前に明日の予定を聞く', 510]]);
    morning.reply.finish();
    await second.loop.idle();
    assert.equal(f.model.calls, 4);
  } finally { await f.cleanup(); }
});

test('a repeating booking comes at each run, says which booking it is and that it repeats, and stays booked until cancelled', async () => {
  const f = await setup('2026-09-17 10:00');
  try {
    const { loop, events, scheduler } = await f.open();
    const booked = await ownerTurn(f, loop, events, '毎時ちょうどに様子を見て', [
      ['schedule_self_check', { reason: '部屋の様子を見る', cron: '0 * * * *' }],
      ['schedule_self_check', { reason: '両方', cron: '0 * * * *', in_minutes: 30 }],
    ]);
    assert.deepEqual(booked.map(r => r.isError), [false, true]);
    const checkId = /check-[0-9a-f-]+/.exec(booked[0]!.text)![0];

    f.at('2026-09-17 11:00');
    assert.equal(scheduler.tick(), 'self-check');
    const first = await nextEvent(f);
    assert.deepEqual(first.event.checks, [
      { check_id: checkId, reason: '部屋の様子を見る', scheduled_for: '2026-09-17 11:00', cron: '0 * * * *' },
    ]);
    first.reply.call('list_self_checks', {});
    first.reply.finish();
    const after = await f.model.next();
    assert.match(toolResults(after.context)[0]!.text, new RegExp(`${checkId} 2026-09-17 12:00 部屋の様子を見る（繰り返し: 0 \\* \\* \\* \\*）`));
    after.finish();
    await loop.idle();
    assert.equal(scheduler.tick(), undefined, 'one run comes once');

    f.at('2026-09-17 12:00');
    assert.equal(scheduler.tick(), 'self-check');
    const second = await nextEvent(f);
    assert.deepEqual(second.event.checks.map((c: Record<string, unknown>) => [c.check_id, c.scheduled_for, c.cron]),
      [[checkId, '2026-09-17 12:00', '0 * * * *']]);
    second.reply.finish();
    await loop.idle();

    await ownerTurn(f, loop, events, 'もういいよ', [['cancel_self_check', { check_id: checkId }]]);
    f.at('2026-09-17 13:00');
    assert.equal(scheduler.tick(), 'ping', 'a cancelled repeating booking comes no more');
    (await nextEvent(f)).reply.finish();
    await loop.idle();
  } finally { await f.cleanup(); }
});

test('the runs of a repeating booking outside the awake hours are skipped and it starts again in the morning, while a one-off waits for the morning', async () => {
  const f = await setup('2026-09-17 22:00');
  try {
    const { loop, events, scheduler } = await f.open();
    const booked = await ownerTurn(f, loop, events, '予定を入れて', [
      ['schedule_self_check', { reason: '30 分ごとに見る', cron: '*/30 * * * *' }],
      ['schedule_self_check', { reason: '七時と正午に見る', cron: '0 7,12 * * *' }],
      ['schedule_self_check', { reason: '寝る前に聞く', at: '23:30' }],
    ]);
    assert.deepEqual(booked.map(r => r.isError), [false, false, false]);
    assert.match(booked[1]!.text, /2026-09-18 12:00/);

    f.at('2026-09-17 22:30');
    assert.equal(scheduler.tick(), 'self-check');
    const evening = await nextEvent(f);
    assert.deepEqual(evening.event.checks.map((c: Record<string, unknown>) => c.reason), ['30 分ごとに見る']);
    evening.reply.finish();
    await loop.idle();

    // The night passes; the runs at 23:00 and after pile up nowhere.
    for (const at of ['2026-09-17 23:00', '2026-09-17 23:30', '2026-09-18 03:00', '2026-09-18 07:00', '2026-09-18 07:59']) {
      f.at(at);
      assert.equal(scheduler.tick(), undefined, at);
    }
    f.at('2026-09-18 08:00');
    assert.equal(scheduler.tick(), 'self-check');
    const morning = await nextEvent(f);
    assert.deepEqual(morning.event.checks.map((c: Record<string, unknown>) => [c.reason, c.scheduled_for, c.late_minutes]), [
      ['寝る前に聞く', '2026-09-17 23:30', 510],
      ['30 分ごとに見る', '2026-09-18 08:00', undefined],
    ]);
    morning.reply.finish();
    await loop.idle();
    f.at('2026-09-18 08:30');
    assert.equal(scheduler.tick(), 'self-check');
    const next = await nextEvent(f);
    assert.deepEqual(next.event.checks.map((c: Record<string, unknown>) => [c.reason, c.scheduled_for]), [['30 分ごとに見る', '2026-09-18 08:30']]);
    next.reply.finish();
    await loop.idle();
  } finally { await f.cleanup(); }
});

test('the runs of a repeating booking missed while the server was stopped come once, as the latest of them', async () => {
  const f = await setup('2026-09-17 10:00');
  try {
    const first = await f.open();
    await ownerTurn(f, first.loop, first.events, '毎時聞いて', [['schedule_self_check', { reason: '毎時の確認', cron: '0 * * * *' }]]);
    await first.loop.close();

    f.at('2026-09-17 13:30');
    const second = await f.open();
    assert.equal(second.scheduler.tick(), 'self-check');
    const late = await nextEvent(f);
    assert.deepEqual(late.event.checks.map((c: Record<string, unknown>) => [c.reason, c.scheduled_for, c.late_minutes]),
      [['毎時の確認', '2026-09-17 13:00', 30]]);
    late.reply.finish();
    await second.loop.idle();
    assert.equal(second.scheduler.tick(), undefined);
    f.at('2026-09-17 14:00');
    assert.equal(second.scheduler.tick(), 'self-check');
    const next = await nextEvent(f);
    assert.deepEqual(next.event.checks.map((c: Record<string, unknown>) => c.scheduled_for), ['2026-09-17 14:00']);
    next.reply.finish();
    await second.loop.idle();
  } finally { await f.cleanup(); }
});

test('a self-check or a ping that comes due during the nightly switch waits for it and goes to the new session', async () => {
  const f = await setup('2026-09-17 10:00');
  try {
    const { loop, events, scheduler } = await f.open();
    await ownerTurn(f, loop, events, '10 分後に聞いて', [['schedule_self_check', { reason: '水を飲んだか聞く', in_minutes: 10 }]]);
    const rotating = loop.rotate();
    const review = await nextEvent(f);
    assert.equal(review.event.type, 'nightly_review');
    f.at('2026-09-17 11:00');
    assert.equal(scheduler.tick(), undefined);
    review.reply.call('write_handoff_note', { text: '引き継ぎ HANDOFF-SCHEDULER-31' });
    review.reply.finish();
    (await f.model.next()).finish();
    assert.equal((await rotating).result, 'switched');
    await loop.idle();

    assert.equal(scheduler.tick(), 'self-check');
    const check = await nextEvent(f);
    assert.match(check.reply.context.systemPrompt ?? '', /HANDOFF-SCHEDULER-31/);
    assert.deepEqual(check.event.checks.map((c: Record<string, unknown>) => [c.reason, c.late_minutes]), [['水を飲んだか聞く', 50]]);
    check.reply.finish();
    await loop.idle();
  } finally { await f.cleanup(); }
});

test('thinking ends with the handling whoever set it; other expressions return to neutral after a while, but not sleepy during the review', async () => {
  const f = await setup('2026-09-17 10:00');
  try {
    const { loop, events, scheduler } = await f.open();
    const sent = f.send(loop, '考えて');
    const first = await nextEvent(f);
    // Thinking set by the server stays while the turn runs, however long.
    f.advance(10);
    assert.equal(scheduler.tick(), undefined);
    assert.equal(loop.snapshot().avatar.expression, 'thinking');
    first.reply.call('set_mac_avatar_expression', { expression: 'thinking' });
    first.reply.call('reply_to_mac', { text: 'うーん', expression: 'neutral' });
    first.reply.finish();
    (await f.model.next()).finish();
    await completed(events, sent.eventId);
    await loop.idle();
    // The model's own thinking is released at the end too.
    assert.equal(loop.snapshot().avatar.expression, 'neutral');
    assert.equal(expressions(events).at(-1), 'neutral');

    const happy = f.send(loop, 'いい知らせ');
    const second = await nextEvent(f);
    second.reply.call('set_mac_avatar_expression', { expression: 'happy' });
    second.reply.finish();
    (await f.model.next()).finish();
    await completed(events, happy.eventId);
    await loop.idle();
    assert.equal(loop.snapshot().avatar.expression, 'happy');
    f.advance(2);
    scheduler.tick();
    assert.equal(loop.snapshot().avatar.expression, 'happy');
    f.advance(1);
    scheduler.tick();
    assert.equal(loop.snapshot().avatar.expression, 'neutral');
    assert.equal(expressions(events).at(-1), 'neutral');
    const count = expressions(events).length;
    f.advance(10);
    scheduler.tick();
    assert.equal(expressions(events).length, count);

    // Asleep for the review: sleepy stays however long it takes, then the switch releases it.
    const rotating = loop.rotate();
    const review = await nextEvent(f);
    f.advance(30);
    assert.equal(scheduler.tick(), undefined);
    assert.equal(loop.snapshot().avatar.expression, 'sleepy');
    review.reply.call('write_handoff_note', { text: '引き継ぎ' });
    review.reply.finish();
    (await f.model.next()).finish();
    assert.equal((await rotating).result, 'switched');
    assert.equal(loop.snapshot().avatar.expression, 'neutral');
  } finally { await f.cleanup(); }
});

/** A loop the scheduler can drive on its own: it counts the switches asked of it and ends them when the test says so. */
class FakeLoop implements ScheduledLoop {
  unavailable: string | undefined = undefined;
  quiet = true;
  lastActivityAt = 0;
  startedAt: number | undefined = undefined;
  rotations = 0;
  private waiting: ((outcome: { result: string; reason?: string }) => void)[] = [];
  relaxExpression(): void {}
  deliverDueSelfChecks(): boolean { return false; }
  ping(): boolean { return false; }
  sessionStartedAt(): number | undefined { return this.startedAt; }
  rotate(): Promise<{ result: string; reason?: string }> {
    this.rotations += 1;
    return new Promise(resolve => { this.waiting.push(resolve); });
  }
  /** Ends every switch in flight, as the thinking loop does once the review turn is over. */
  async settle(outcome: { result: string; reason?: string }): Promise<void> {
    for (const resolve of this.waiting.splice(0)) resolve(outcome);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

function nightly(start: string, at: string | false = '04:00') {
  const loop = new FakeLoop();
  const logs: string[] = [];
  const clock = { now: tokyo(start), at(local: string) { this.now = tokyo(local); } };
  const scheduler = new Scheduler({ loop, now: () => clock.now, timeZone: TZ, awakeHours: AWAKE, pingIntervalMinutes: false,
    expressionResetMinutes: 3, nightlyRotationAt: at, log: line => { logs.push(line); } });
  return { loop, logs, clock, scheduler };
}

test('the nightly switch is asked for when the session began before the last switching time, whatever the hour and however busy the loop is', () => {
  const f = nightly('2026-09-18 10:00');
  // A session from after this morning's switching time has nothing to catch up.
  f.loop.startedAt = tokyo('2026-09-18 08:00');
  assert.equal(f.scheduler.tick(), undefined);
  assert.equal(f.loop.rotations, 0);

  // One from before it is switched, even in the middle of a turn and outside the awake hours.
  f.loop.startedAt = tokyo('2026-09-17 20:00');
  f.loop.quiet = false;
  f.clock.at('2026-09-18 05:00');
  f.scheduler.tick();
  assert.equal(f.loop.rotations, 1);
});

test('one switch is asked for per night: none while it runs, none again afterwards, and one more the next night', async () => {
  const f = nightly('2026-09-18 10:00');
  f.loop.startedAt = tokyo('2026-09-17 20:00');
  f.scheduler.tick();
  assert.equal(f.loop.rotations, 1);

  // A switch queues an event and resolves only once the review turn is over; until then nothing more is asked for.
  f.clock.at('2026-09-18 10:01');
  f.scheduler.tick();
  f.scheduler.tick();
  assert.equal(f.loop.rotations, 1);

  // A switch that changed nothing leaves the session where it was, and is still not repeated for the same night.
  await f.loop.settle({ result: 'skipped', reason: 'empty-session' });
  assert.deepEqual(f.logs, ['thinking loop: nightly switch skipped (empty-session)']);
  f.clock.at('2026-09-18 23:00');
  f.scheduler.tick();
  assert.equal(f.loop.rotations, 1);

  // The next night asks once more.
  f.clock.at('2026-09-19 04:00');
  f.scheduler.tick();
  f.scheduler.tick();
  assert.equal(f.loop.rotations, 2);
  await f.loop.settle({ result: 'switched' });
  assert.deepEqual(f.logs.at(-1), 'thinking loop: nightly switch switched');
});

test('no nightly switch is asked for when it is turned off, or while the loop is unavailable', () => {
  const off = nightly('2026-09-18 10:00', false);
  off.loop.startedAt = tokyo('2026-09-17 20:00');
  off.scheduler.tick();
  off.clock.at('2026-09-19 04:00');
  off.scheduler.tick();
  assert.equal(off.loop.rotations, 0);

  const down = nightly('2026-09-18 10:00');
  down.loop.startedAt = tokyo('2026-09-17 20:00');
  down.loop.unavailable = 'pi-unavailable';
  down.scheduler.tick();
  assert.equal(down.loop.rotations, 0);
});

test('the sources are looked at on every tick, at night and in the middle of a turn too, one look at a time (ADR 0050)', async () => {
  const loop = new FakeLoop();
  const clock = { now: tokyo('2026-09-18 02:00') };
  let looks = 0;
  let finish: (() => void) | undefined;
  const sources = { tick: () => { looks += 1; return new Promise<void>(resolve => { finish = resolve; }); } };
  const logs: string[] = [];
  const scheduler = new Scheduler({ loop, now: () => clock.now, timeZone: TZ, awakeHours: AWAKE, pingIntervalMinutes: false,
    expressionResetMinutes: 3, nightlyRotationAt: false, sources, log: line => { logs.push(line); } });
  loop.quiet = false;
  scheduler.tick();
  assert.equal(looks, 1);
  // Still looking: the next tick does not start another.
  scheduler.tick();
  assert.equal(looks, 1);
  finish!();
  await new Promise(resolve => setTimeout(resolve, 0));
  scheduler.tick();
  assert.equal(looks, 2);
  // A failed look is logged, and the next tick looks again.
  const failing = new Scheduler({ loop, now: () => clock.now, timeZone: TZ, awakeHours: AWAKE, pingIntervalMinutes: false,
    expressionResetMinutes: 3, nightlyRotationAt: false, sources: { tick: () => Promise.reject(new Error('git')) },
    log: line => { logs.push(line); } });
  failing.tick();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(logs, ['sources: a look failed']);
  // Nothing looks while the loop is unavailable.
  loop.unavailable = 'pi-unavailable';
  scheduler.tick();
  assert.equal(looks, 2);
});

test('the awake hours and the ping interval are read on every tick, so a change made while running is in force from the next (ADR 0058)', () => {
  const loop = new FakeLoop();
  let pinged = 0;
  loop.ping = () => { pinged += 1; return true; };
  const clock = { now: tokyo('2026-09-18 07:30') };
  let hours = AWAKE;
  let interval: number | false = 60;
  const scheduler = new Scheduler({ loop, now: () => clock.now, timeZone: TZ, awakeHours: () => hours, pingIntervalMinutes: () => interval,
    expressionResetMinutes: 3, nightlyRotationAt: false });
  loop.lastActivityAt = tokyo('2026-09-18 06:00');
  assert.equal(scheduler.tick(), undefined, 'before 08:00 she is asleep');
  hours = { start: '07:00', end: '23:00' };
  assert.equal(scheduler.tick(), 'ping', 'up from 07:00 now');
  interval = false;
  loop.lastActivityAt = tokyo('2026-09-18 06:00');
  assert.equal(scheduler.tick(), undefined, 'no pings now');
  interval = 120;
  clock.now = tokyo('2026-09-18 07:59');
  assert.equal(scheduler.tick(), undefined, 'not two hours quiet yet');
  clock.now = tokyo('2026-09-18 08:00');
  assert.equal(scheduler.tick(), 'ping');
  assert.equal(pinged, 2);
});

test('a booking reads the awake hours in force when it is made (ADR 0058)', async () => {
  const f = await setup('2026-09-17 21:00');
  try {
    let hours = AWAKE;
    const checks = new SelfChecks({ db: f.db, now: () => f.clock, timeZone: TZ, awakeHours: () => hours });
    assert.match(checks.schedule('一件目', { at: '23:30' }).text, /08:00 以降/);
    hours = { start: '09:00', end: '23:45' };
    const inside = checks.schedule('二件目', { at: '23:30' });
    assert.doesNotMatch(inside.text, /以降/);
    assert.match(checks.schedule('三件目', { at: '23:50' }).text, /09:00 以降/);
    f.at('2026-09-17 23:31');
    assert.deepEqual(checks.due().map(check => check.reason).sort(), ['一件目', '二件目'], 'what is due is the same whatever the hours');
  } finally { await f.cleanup(); }
});
