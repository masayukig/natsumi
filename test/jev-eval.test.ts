import assert from 'node:assert/strict';
import test from 'node:test';
import { JEV_CASES, type JevCase } from '../src/probe/jev-cases.ts';
import { describeRun, evaluate, parseEvalArgs, REVERSED_PLACEMENT_ORDER } from '../src/probe/jev-eval.ts';
import { JUDGE_ISSUES, JudgeError, PLACEMENT_ORDER, type JudgeClient, type Judgement } from '../src/server/judge.ts';

/**
 * The evaluation of the dove's judge before thresholds are chosen (ADR 0040): the failures of the loop evaluation and
 * posts that should pass, all made up, judged once each; then how many would be stopped at each threshold.
 */

test('the cases are made up, cover every failure of the loop evaluation, and include posts that should pass', () => {
  const kinds = new Set(JEV_CASES.map(example => example.expect));
  assert.deepEqual([...kinds].sort(), ['pass', 'stop']);
  const categories = new Set(JEV_CASES.filter(example => example.expect === 'stop').map(example => example.category));
  for (const category of ['hinting', 'false-account', 'promise', 'fabricated-consent', 'private-matter']) {
    assert.ok(categories.has(category), category);
  }
  assert.ok(JEV_CASES.filter(example => example.expect === 'pass').length >= 5);
  const names = new Set<string>();
  for (const example of JEV_CASES) {
    assert.ok(!names.has(example.name), `${example.name} is named once`);
    names.add(example.name);
    assert.equal(typeof example.state.draft, 'string');
    // The shape the dove sends (ADR 0062): the time now, and the channel and the thread up to it.
    assert.match(example.state.now, /^2026-\d\d-\d\d \d\d:\d\d:\d\d$/, example.name);
    assert.ok(Array.isArray(example.state.conversation.channel.messages), example.name);
    assert.equal(example.state.conversation.channel.last_at, example.state.conversation.channel.messages.at(-1)?.at ?? null, example.name);
    if (example.state.reply_to) {
      const thread = example.state.conversation.thread!;
      assert.ok(thread.messages.some(message => message.at === example.state.reply_to!.at && message.text === example.state.reply_to!.text), example.name);
      assert.equal(thread.last_at, thread.messages.at(-1)!.at, example.name);
      assert.ok([thread.last_at!, example.state.conversation.channel.last_at ?? ''].every(last => last <= example.state.now), example.name);
    }
  }
});

// ADR 0059: not-in-thread is no longer asked, so each draft that should be stopped names the issue that should stop it.
test('each draft that should be stopped names one of the five issues asked, and the scenes of not-in-thread are named anew', () => {
  const issues = JUDGE_ISSUES.map(issue => issue.name);
  for (const example of JEV_CASES.filter(one => one.expect === 'stop')) assert.ok(example.issue && issues.includes(example.issue), example.name);
  assert.ok(JEV_CASES.every(example => example.category !== 'not-in-thread'));
  assert.equal(JEV_CASES.find(example => example.name === 'not-in-thread-leak')?.issue, 'private-matter');
  assert.equal(JEV_CASES.find(example => example.name === 'private-health')?.issue, 'private-matter');
});

test('the scenes ADR 0059 adds: her own acts, what her tools found, a private matter told unasked and one asked for, and her devices', () => {
  const of = (category: string) => JEV_CASES.filter(example => example.category === category);
  assert.ok(of('own-act').length >= 2 && of('own-act').every(example => example.expect === 'pass'));
  assert.ok(of('tool-result').length >= 2 && of('tool-result').every(example => example.expect === 'pass'));
  assert.ok(of('private-matter').filter(example => example.expect === 'stop').some(example => /アカウント/.test(example.state.draft)),
    'her personal account told unasked');
  // The owner: devices are no problem. What her machines are is told freely, asked or not.
  assert.equal(JEV_CASES.find(example => example.name === 'private-device')?.expect, 'pass');
  assert.equal(JEV_CASES.find(example => example.name === 'private-device')?.category, 'device');
  assert.ok(of('asked').length >= 2 && of('asked').every(example => example.expect === 'pass'), 'what was asked for, answered');
});

test('where a reply should go is given for the scenes that have a clear answer, a reply inside a thread among them', () => {
  const placed = JEV_CASES.filter(example => example.placement);
  assert.ok(placed.filter(example => example.placement === 'thread').length >= 3);
  assert.ok(placed.filter(example => example.placement === 'channel').length >= 2);
  // ADR 0062: the broadcast for an old thread worth showing the channel, and the channel itself for a message in a thread.
  assert.ok(placed.filter(example => example.placement === 'broadcast').length >= 1);
  assert.ok(placed.some(example => example.placement === 'channel' && example.state.reply_to?.in_thread));
  assert.ok(placed.every(example => example.state.reply_to !== null));
  const inThread = JEV_CASES.filter(example => example.state.reply_to?.in_thread);
  assert.ok(inThread.length >= 3, 'replies to a message inside a thread');
  assert.ok(inThread.every(example => example.placement));
  for (const example of JEV_CASES) {
    if (example.state.reply_to) assert.equal(typeof example.state.reply_to.in_thread, 'boolean', example.name);
  }
});

// 2026-09-30: asked in the channel itself for a reply as a test, Jev put it in the thread. A message in the channel
// itself is answered there, unless the channel has since moved on to another topic.
test('a question or a request in the channel itself is answered in the channel, and an old one the channel has moved on from in its thread', () => {
  const find = (name: string) => JEV_CASES.find(example => example.name === name);
  for (const name of ['place-answer', 'place-thanks', 'place-test-reply', 'own-drew']) {
    assert.equal(find(name)?.placement, 'channel', name);
    assert.equal(find(name)?.state.reply_to?.in_thread, false, name);
  }
  assert.match(find('place-test-reply')!.state.reply_to!.text, /テストなので返事して/);
  const moved = find('place-channel-moved-on')!;
  assert.equal(moved.placement, 'thread');
  assert.equal(moved.state.reply_to?.in_thread, false);
  const after = moved.state.conversation.channel.messages.filter(message => message.at > moved.state.reply_to!.at);
  assert.ok(after.length >= 3, 'the channel went on to another topic after the message');
  const inChannel = JEV_CASES.filter(example => example.placement && !example.state.reply_to?.in_thread);
  assert.deepEqual(inChannel.filter(example => example.placement === 'thread').map(example => example.name), ['place-channel-moved-on'],
    'a message in the channel itself goes to its thread only when the channel has moved on');
});

type Odds = { thread: number; channel: number; broadcast: number };
const THREAD: Odds = { thread: 0.8, channel: 0.1, broadcast: 0.1 };

class ScriptedJev implements JudgeClient {
  private readonly score: (draft: string) => number | Error;
  private readonly odds: (draft: string) => Odds;
  constructor(score: (draft: string) => number | Error, odds: (draft: string) => Odds = () => THREAD) { this.score = score; this.odds = odds; }
  async judge(state: Record<string, unknown>, options: { placement: boolean }): Promise<Judgement> {
    const score = this.score(String(state.draft));
    if (score instanceof Error) throw score;
    const odds = this.odds(String(state.draft));
    const choice = PLACEMENT_ORDER.reduce((best, name) => odds[name] > odds[best] ? name : best);
    return { issues: JUDGE_ISSUES.map((issue, index) => ({ name: issue.name, label: issue.label, score: index === 0 ? score : 0 })),
      ...(options.placement ? { placement: { choice, probabilities: odds } } : {}) };
  }
}

const topLevel = (draft: string) => ({ channel: 'example/#team', now: '2026-09-25 10:05:00', reply_to: null,
  conversation: { channel: { last_at: null, messages: [] }, thread: null }, draft });

test('each case is judged once, and the counts are given for every threshold, with the failures to judge apart', async () => {
  const state = topLevel;
  const cases: JevCase[] = [
    { name: 'a', category: 'hinting', expect: 'stop', state: state('stop-high') },
    { name: 'b', category: 'promise', expect: 'stop', state: state('stop-low') },
    { name: 'c', category: 'ok', expect: 'pass', state: state('pass-mid') },
    { name: 'd', category: 'ok', expect: 'pass', state: state('broken') },
  ];
  const scores: Record<string, number | Error> = { 'stop-high': 0.9, 'stop-low': 0.2, 'pass-mid': 0.5, broken: new JudgeError('http-400') };
  const report = await evaluate(new ScriptedJev(draft => scores[draft]!), cases, [0.3, 0.6]);
  assert.deepEqual(report.cases.map(result => [result.name, result.max]), [['a', 0.9], ['b', 0.2], ['c', 0.5], ['d', null]]);
  assert.deepEqual(report.cases[3]!.error, 'http-400');
  assert.deepEqual(report.thresholds, [
    { owner: 0.3, stopped: 1, shouldStop: 2, wronglyStopped: 1, shouldPass: 1 },
    { owner: 0.6, stopped: 1, shouldStop: 2, wronglyStopped: 0, shouldPass: 1 },
  ]);
  assert.equal(report.noVerdict, 1);
});

test('where each reply went is counted against where it should go, and the other order of the options is compared when asked', async () => {
  const reply = { from: '田中', at: '2026-09-25 10:00:00', text: '質問です', in_thread: false };
  const flow = { last_at: reply.at, messages: [{ from: reply.from, at: reply.at, text: reply.text }] };
  const state = (draft: string) => ({ ...topLevel(draft), reply_to: reply, conversation: { channel: flow, thread: flow } });
  const cases: JevCase[] = [
    { name: 'a', category: 'placement', expect: 'pass', placement: 'thread', state: state('thread') },
    { name: 'b', category: 'placement', expect: 'pass', placement: 'channel', state: state('channel') },
    { name: 'c', category: 'placement', expect: 'pass', placement: 'thread', state: state('wrong') },
    { name: 'e', category: 'placement', expect: 'pass', placement: 'broadcast', state: state('broadcast') },
    { name: 'd', category: 'ok', expect: 'pass', state: topLevel('top') },
  ];
  const odds: Record<string, Odds> = { thread: THREAD, channel: { thread: 0.1, channel: 0.8, broadcast: 0.1 },
    wrong: { thread: 0.3, channel: 0.6, broadcast: 0.1 }, broadcast: { thread: 0.2, channel: 0.1, broadcast: 0.7 }, top: THREAD };
  const flipped: Record<string, Odds> = { ...odds, channel: { thread: 0.5, channel: 0.3, broadcast: 0.2 } };
  const report = await evaluate(new ScriptedJev(() => 0.1, draft => odds[draft]!), cases, [0.5],
    { reversed: new ScriptedJev(() => 0.1, draft => flipped[draft]!) });
  assert.deepEqual(report.cases.map(result => result.placement?.choice), ['thread', 'channel', 'channel', 'broadcast', undefined]);
  assert.deepEqual(report.cases[2]!.placement, { expected: 'thread', choice: 'channel', probabilities: odds.wrong,
    reversed: { choice: 'channel', probabilities: odds.wrong } });
  assert.deepEqual(report.placement, { asked: 4, expected: 4, agreed: 3, thread: 1, channel: 2, broadcast: 1 });
  assert.equal(report.order?.compared, 4);
  assert.equal(report.order?.flips, 1, 'b goes to the thread the other way round');
  assert.ok(Math.abs(report.order!.maxDifference - 0.5) < 1e-9, 'the largest change of any place: the channel of b, 0.8 to 0.3');
  const plain = await evaluate(new ScriptedJev(() => 0.1, draft => odds[draft]!), cases, [0.5]);
  assert.equal(plain.order, undefined);
  assert.equal(plain.cases[0]!.placement?.reversed, undefined);
});

test('the method, the endpoint and the model come from the environment, and the key only by the name of its variable', () => {
  assert.throws(() => parseEvalArgs([], {}), /JUDGE_BASE_URL/, 'the logprobs method needs somewhere to ask');
  assert.deepEqual(parseEvalArgs([], { JUDGE_BASE_URL: 'https://llm.example.test/v1', JUDGE_MODEL: 'fixture-model' }), {
    method: 'logprobs', baseUrl: 'https://llm.example.test/v1', model: 'fixture-model', concurrency: 4, timeoutSeconds: 30,
    thresholds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
  });
  assert.throws(() => parseEvalArgs([], { JUDGE_BASE_URL: 'https://llm.example.test/v1' }), /JUDGE_MODEL/);
  assert.deepEqual(parseEvalArgs(['--thresholds', '0.25,0.5'], { JUDGE_METHOD: 'jev', JUDGE_API_KEY_ENV: 'MY_JEV_KEY', MY_JEV_KEY: 'k',
    JUDGE_CONCURRENCY: '2', JUDGE_TIMEOUT_SECONDS: '60' }), {
    method: 'jev', baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', apiKeyEnv: 'MY_JEV_KEY', apiKey: 'k', concurrency: 2, timeoutSeconds: 60,
    thresholds: [0.25, 0.5],
  });
  assert.throws(() => parseEvalArgs([], { JUDGE_METHOD: 'jev', JUDGE_API_KEY_ENV: 'MISSING_KEY' }), /MISSING_KEY/);
  assert.throws(() => parseEvalArgs([], { JUDGE_METHOD: 'guess' }), /JUDGE_METHOD/);
  assert.throws(() => parseEvalArgs(['--thresholds', '2'], { JUDGE_METHOD: 'jev' }), /thresholds/);
  assert.equal(parseEvalArgs(['--order-check'], { JUDGE_METHOD: 'jev' }).orderCheck, true);
  assert.equal(parseEvalArgs([], { JUDGE_METHOD: 'jev' }).orderCheck, undefined);
});

test('the report says how long each case took, and never the key', async () => {
  const state = topLevel('x');
  const report = await evaluate(new ScriptedJev(() => 0.1), [{ name: 'a', category: 'ok', expect: 'pass', state }], [0.5]);
  assert.equal(typeof report.cases[0]!.ms, 'number');
  assert.equal(report.slowestMs, report.cases[0]!.ms);
  const shown = describeRun(parseEvalArgs([], { JUDGE_METHOD: 'jev', JUDGE_API_KEY_ENV: 'MY_JEV_KEY', MY_JEV_KEY: 'fixture-secret' }));
  assert.deepEqual(shown, { method: 'jev', baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', apiKeyEnv: 'MY_JEV_KEY', concurrency: 4, timeoutSeconds: 30 });
  assert.doesNotMatch(JSON.stringify(shown), /fixture-secret/);
});

test('the order check asks the three places in the reverse order', () => {
  assert.deepEqual(REVERSED_PLACEMENT_ORDER, ['broadcast', 'channel', 'thread']);
});
