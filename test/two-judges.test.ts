import assert from 'node:assert/strict';
import test from 'node:test';
import { JUDGE_ISSUES, JUDGE_PLACEMENT, JudgeError, judgeSideBySide, type JudgeClient, type Judgement } from '../src/server/judge.ts';

/**
 * The dove's two judges side by side (ADR 0059): both are asked the same about the same draft, both answers are kept,
 * and the one adopted decides, or the other when it has no answer, or neither, and then the owner does.
 */

const STATE = { channel: 'example/#team', reply_to: null, conversation: [], draft: '了解です。' };
const THRESHOLDS = { owner: 0.5, return: 0.9 };

class StandIn implements JudgeClient {
  readonly asked: { state: Record<string, unknown>; placement: boolean }[] = [];
  private readonly answer: Judgement | Error;
  constructor(answer: Judgement | Error) { this.answer = answer; }
  async judge(state: Record<string, unknown>, options: { placement: boolean }): Promise<Judgement> {
    this.asked.push({ state, placement: options.placement });
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

const scored = (score: number, choice?: 'thread' | 'channel'): Judgement => ({
  issues: JUDGE_ISSUES.map((issue, index) => ({ name: issue.name, label: issue.label, score: index === 0 ? score : 0.01 })),
  ...(choice ? { placement: { choice, probabilities: choice === 'thread' ? { thread: 0.7, channel: 0.3 } : { thread: 0.2, channel: 0.8 } } } : {}),
});

test('five issues are asked: not-in-thread is gone, and the other five keep their names', () => {
  assert.deepEqual(JUDGE_ISSUES.map(issue => issue.name),
    ['promise-for-owner', 'hinting-at-secret', 'false-account', 'fabricated-consent', 'private-matter']);
});

test('a promise for the owner binds her time, work or decisions; the secretary\'s own work, deadline and all, is none (ADR 0059)', () => {
  const promise = JUDGE_ISSUES.find(issue => issue.name === 'promise-for-owner')!.instructions;
  assert.match(promise, /owner's time, work or decisions/);
  assert.match(promise, /its own work \(looking up, summarizing, drawing, posting\), even with a deadline/);
  assert.match(promise, /check with the owner/);
});

test('a private matter is one the conversation did not ask about, named with examples, her devices not among them (ADR 0059)', () => {
  const privateMatter = JUDGE_ISSUES.find(issue => issue.name === 'private-matter')!.instructions;
  assert.match(privateMatter, /did not ask about/);
  for (const example of ['hospital visits', 'family', 'moving house', 'transfers and promotions', 'personal plans', 'personal accounts']) {
    assert.match(privateMatter, new RegExp(example));
  }
  assert.doesNotMatch(privateMatter, /device|server|router|setting/i, 'the owner: devices are no problem');
  assert.match(privateMatter, /Answering exactly what was asked is fine/);
});

test('the reply to a message goes to its thread unless it is for everyone or goes on with a short exchange in the channel', () => {
  assert.match(JUDGE_PLACEMENT.criteria.thread, /default, even when that message was posted in the channel itself/);
  assert.match(JUDGE_PLACEMENT.criteria.channel, /also shown in the channel/);
  assert.match(JUDGE_PLACEMENT.criteria.channel, /everyone in the channel/);
  assert.match(JUDGE_PLACEMENT.criteria.channel, /short exchange/);
  assert.match(JUDGE_PLACEMENT.instructions, /in_thread/, 'the judge is told how to see that the message is in a thread');
});

test('both judges are asked the same, both answers are kept with their own thresholds, and the adopted one decides', async () => {
  const logprobs = new StandIn(scored(0.6, 'thread'));
  const jev = new StandIn(scored(0.6, 'channel'));
  const judged = await judgeSideBySide(
    { logprobs: { client: logprobs, thresholds: THRESHOLDS }, jev: { client: jev, thresholds: { owner: 0.7, return: 0.95 } } },
    { logprobs: true, jev: true, adopted: 'jev' }, STATE, { placement: true });
  assert.deepEqual(logprobs.asked, jev.asked, 'the same state and the same question of placement');
  assert.equal(judged.adopted, 'jev');
  assert.equal(judged.decidedBy, 'jev');
  const { logprobs: byLogprobs, jev: byJev } = judged.results;
  assert.ok(byLogprobs && 'verdict' in byLogprobs && byJev && 'verdict' in byJev);
  assert.equal(byLogprobs.verdict, 'owner', '0.6 is over the logprobs judge\'s 0.5');
  assert.equal(byJev.verdict, 'send', '0.6 is under the Jev judge\'s 0.7');
  assert.equal(byJev.placement?.choice, 'channel');
  assert.deepEqual(judged.decided, byJev);
});

test('when the adopted judge has no answer, the other decides, and why the first had none is kept', async () => {
  const judged = await judgeSideBySide(
    { logprobs: { client: new StandIn(new JudgeError('timeout')), thresholds: THRESHOLDS }, jev: { client: new StandIn(scored(0.95)), thresholds: THRESHOLDS } },
    { logprobs: true, jev: true, adopted: 'logprobs' }, STATE, { placement: false });
  assert.equal(judged.decidedBy, 'jev');
  assert.deepEqual(judged.results.logprobs, { error: 'timeout' });
  assert.equal(judged.decided && judged.decided.verdict, 'return');
});

test('when the adopted judge is off, the other decides, and the one off is not asked', async () => {
  const logprobs = new StandIn(scored(0.1));
  const jev = new StandIn(scored(0.2));
  const judged = await judgeSideBySide({ logprobs: { client: logprobs, thresholds: THRESHOLDS }, jev: { client: jev, thresholds: THRESHOLDS } },
    { logprobs: true, jev: false, adopted: 'jev' }, STATE, { placement: false });
  assert.equal(jev.asked.length, 0);
  assert.equal(judged.decidedBy, 'logprobs');
  assert.equal('jev' in judged.results, false, 'a judge that is off leaves nothing');
});

test('when neither has an answer, nothing decides, and both reasons are kept; a failure that is no JudgeError is an error', async () => {
  const judged = await judgeSideBySide(
    { logprobs: { client: new StandIn(new JudgeError('http-429')), thresholds: THRESHOLDS }, jev: { client: new StandIn(new Error('boom')), thresholds: THRESHOLDS } },
    { logprobs: true, jev: true, adopted: 'logprobs' }, STATE, { placement: false });
  assert.equal(judged.decidedBy, null);
  assert.equal(judged.decided, undefined);
  assert.deepEqual(judged.results, { logprobs: { error: 'http-429' }, jev: { error: 'error' } });
});

test('a judge turned on that the config has no endpoint for is as good as off; with both off nothing is asked', async () => {
  const logprobs = new StandIn(scored(0.1));
  const only = await judgeSideBySide({ logprobs: { client: logprobs, thresholds: THRESHOLDS } },
    { logprobs: true, jev: true, adopted: 'jev' }, STATE, { placement: false });
  assert.equal(only.decidedBy, 'logprobs');
  assert.deepEqual(Object.keys(only.results), ['logprobs']);
  const none = await judgeSideBySide({ logprobs: { client: logprobs, thresholds: THRESHOLDS } },
    { logprobs: false, jev: false, adopted: 'logprobs' }, STATE, { placement: false });
  assert.deepEqual(none, { adopted: 'logprobs', results: {}, decidedBy: null });
  assert.equal(logprobs.asked.length, 1);
});
