import assert from 'node:assert/strict';
import test from 'node:test';
import { JUDGE_ISSUES, JUDGE_PLACEMENT, JudgeError } from '../src/server/judge.ts';
import { LogprobJudgeClient } from '../src/server/logprob-judge.ts';

/**
 * The logprobs method of the dove's judge (ADR 0040): each question goes to an OpenAI-compatible model on its own, for
 * one token without thinking, and the probabilities of the answers among its top tokens are the score. The state and
 * the questions are the same the Jev method sends.
 */

const STATE = { channel: 'work/#dev', reply_to: { from: '山田', at: '2026-09-25 14:32:05', text: '明日のレビュー大丈夫？' },
  conversation: [{ from: '山田', at: '2026-09-25 14:32:05', text: '明日のレビュー大丈夫？' }], draft: '大丈夫です。' };

type Top = { token: string; logprob: number };
const tops = (probabilities: Record<string, number>): Top[] => Object.entries(probabilities).map(([token, p]) => ({ token, logprob: Math.log(p) }));
const completion = (list: Top[]) => ({ choices: [{ message: { content: list[0]?.token ?? '' },
  logprobs: { content: [{ token: list[0]?.token ?? '', logprob: list[0]?.logprob ?? 0, top_logprobs: list }] } }] });

/** A model that answers each request by what its question asks, and records every request. */
function model(answer: (user: string) => unknown, options: { status?: number; delayMs?: number } = {}) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  let inFlight = 0;
  let most = 0;
  const fetchStub = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    requests.push({ url: String(url), headers: init!.headers as Record<string, string>, body });
    inFlight += 1;
    most = Math.max(most, inFlight);
    try {
      if (options.delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, options.delayMs);
          init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); });
        });
      }
      const user = body.messages.find((message: { role: string }) => message.role === 'user').content as string;
      const value = answer(user);
      return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status: options.status ?? 200, headers: { 'content-type': 'application/json' } });
    } finally { inFlight -= 1; }
  };
  return { requests, fetch: fetchStub as typeof fetch, get most() { return most; } };
}

/** Yes for the second issue (promise), no for the rest, and the thread for the placement. */
const typical = (user: string) => {
  if (user.includes('Options:')) return completion(tops({ A: 0.6, B: 0.2, ' C': 0.01 }));
  if (user.includes(JUDGE_ISSUES[1]!.instructions)) return completion(tops({ ' Yes': 0.72, yes: 0.08, No: 0.2 }));
  return completion(tops({ no: 0.9, 'Yes.': 0.1 }));
};

test('each question is one request for one token, without thinking, asking for the top logprobs', async () => {
  const backend = model(typical);
  const client = new LogprobJudgeClient({ baseUrl: 'https://llm.example.test/v1/', model: 'fixture-model', apiKey: 'fixture-key', fetch: backend.fetch });
  await client.judge(STATE, { placement: true });
  assert.equal(backend.requests.length, JUDGE_ISSUES.length + 1);
  for (const { url, headers, body } of backend.requests) {
    assert.equal(url, 'https://llm.example.test/v1/chat/completions');
    assert.equal(headers.authorization, 'Bearer fixture-key');
    assert.equal(body.model, 'fixture-model');
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 1);
    assert.equal(body.logprobs, true);
    assert.equal(body.top_logprobs, 20);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.messages[0].role, 'system');
    const user = body.messages[1].content as string;
    // The state comes first, the same for every question, so the prefix is shared; the question follows.
    assert.ok(user.startsWith(`<state>\n${JSON.stringify(STATE, null, 2)}\n</state>`));
  }
  const users = backend.requests.map(request => request.body.messages[1].content as string);
  for (const issue of JUDGE_ISSUES) assert.ok(users.some(user => user.includes(issue.instructions)), issue.name);
  const placement = users.find(user => user.includes(JUDGE_PLACEMENT.instructions))!;
  assert.match(placement, /A\) thread: .*\nB\) channel: /);
});

test('a noul is yes over yes and no, and a choice is its labels made to sum to one', async () => {
  const client = new LogprobJudgeClient({ baseUrl: 'https://llm.example.test/v1', model: 'm', fetch: model(typical).fetch });
  const judged = await client.judge(STATE, { placement: true });
  assert.equal(judged.issues.length, JUDGE_ISSUES.length);
  assert.deepEqual(judged.issues.map(issue => issue.name), JUDGE_ISSUES.map(issue => issue.name));
  assert.ok(Math.abs(judged.issues[1]!.score - 0.8) < 1e-9, String(judged.issues[1]!.score));
  assert.ok(Math.abs(judged.issues[0]!.score - 0.1) < 1e-9);
  assert.equal(judged.issues[0]!.label, JUDGE_ISSUES[0]!.label);
  assert.equal(judged.placement!.choice, 'thread');
  assert.ok(Math.abs(judged.placement!.probabilities!.thread - 0.75) < 1e-9);
  assert.ok(Math.abs(judged.placement!.probabilities!.channel - 0.25) < 1e-9);
});

test('without a key no Authorization header is sent, and without a message replied to the placement is not asked', async () => {
  const backend = model(typical);
  const client = new LogprobJudgeClient({ baseUrl: 'http://127.0.0.1:8080/v1', model: 'm', fetch: backend.fetch });
  const judged = await client.judge({ ...STATE, reply_to: null }, { placement: false });
  assert.equal(backend.requests.length, JUDGE_ISSUES.length);
  assert.ok(backend.requests.every(request => request.headers.authorization === undefined));
  assert.equal(judged.placement, undefined);
});

test('no more questions are asked at once than the limit', async () => {
  const backend = model(typical, { delayMs: 10 });
  const client = new LogprobJudgeClient({ baseUrl: 'https://llm.example.test/v1', model: 'm', concurrency: 2, fetch: backend.fetch });
  await client.judge(STATE, { placement: true });
  assert.equal(backend.most, 2);
});

for (const [name, answer, kind, status] of [
  ['no logprobs in the answer', () => ({ choices: [{ message: { content: 'yes' } }] }), 'no-logprobs', 200],
  ['neither answer among the top tokens', () => completion(tops({ maybe: 0.9, perhaps: 0.1 })), 'no-answer-token', 200],
  ['a thinking tag instead of an answer', () => completion(tops({ '<think>': 0.99, '\n': 0.01 })), 'thinking', 200],
  ['a body that is not JSON', () => 'not json', 'malformed', 200],
  ['the endpoint refusing', () => ({ error: 'x' }), 'http-500', 500],
] as const) {
  test(`${name} is no verdict for the whole draft`, async () => {
    const client = new LogprobJudgeClient({ baseUrl: 'https://llm.example.test/v1', model: 'm', apiKey: 'fixture-key',
      fetch: model(user => user.includes(JUDGE_ISSUES[3]!.instructions) ? answer() : typical(user), { status }).fetch });
    await assert.rejects(client.judge(STATE, { placement: true }), (error: unknown) => {
      assert.ok(error instanceof JudgeError);
      assert.equal(error.kind, kind);
      assert.doesNotMatch(error.message, /fixture-key|大丈夫/);
      return true;
    });
  });
}

test('a judgement that takes longer than its limit is cut off as a whole and is no verdict', async () => {
  const client = new LogprobJudgeClient({ baseUrl: 'https://llm.example.test/v1', model: 'm', timeoutMs: 30,
    fetch: model(typical, { delayMs: 1000 }).fetch });
  const started = Date.now();
  await assert.rejects(client.judge(STATE, { placement: true }), (error: unknown) => error instanceof JudgeError && error.kind === 'timeout');
  assert.ok(Date.now() - started < 900);
});

test('told to, the placement is asked with its options the other way round, and the letters are read back to the right place', async () => {
  const backend = model(typical);
  const client = new LogprobJudgeClient({ baseUrl: 'https://llm.example.test/v1', model: 'm', fetch: backend.fetch, placementOrder: ['channel', 'thread'] });
  const judged = await client.judge(STATE, { placement: true });
  const placement = backend.requests.map(request => request.body.messages[1].content as string).find(user => user.includes('Options:'))!;
  assert.match(placement, /A\) channel: .*\nB\) thread: /);
  assert.equal(judged.placement!.choice, 'channel', 'A is the channel now');
  assert.ok(Math.abs(judged.placement!.probabilities!.channel - 0.75) < 1e-9);
  assert.ok(Math.abs(judged.placement!.probabilities!.thread - 0.25) < 1e-9);
});
