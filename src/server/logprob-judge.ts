import { DEFAULT_JUDGE_TIMEOUT_MS, JUDGE_ISSUES, JUDGE_PLACEMENT, JudgeError, PLACEMENT_ORDER, type JudgeClient, type JudgeState,
  type Judgement, type Placement } from './judge.ts';

/**
 * The dove's judge by the logprobs of an OpenAI-compatible model (ADR 0040): by default pi's own, which the owner runs.
 * Each question is one `chat/completions` request for a single token, with thinking off and the top logprobs asked
 * for. A Noul's score is the probability of "yes" over "yes" and "no" among the first token's candidates; the placement
 * is asked with lettered options, and its probabilities are those of the letters made to sum to one.
 *
 * The state and the questions are `judge.ts`'s, the same the Jev method sends, so the method changes how a draft is
 * judged and not what. The state comes first in every request and the question after it, so the questions about one
 * draft share their prefix and the model's cache.
 *
 * Any question without an answer — no logprobs, neither answer among the candidates, a thinking tag in its place, a
 * refusal — makes the whole judgement "no verdict", as a Jev answer missing a field does. So does the time limit,
 * which covers the judgement as a whole.
 */

export const DEFAULT_JUDGE_CONCURRENCY = 4;
const TOP_LOGPROBS = 20;
const LETTERS = ['A', 'B'] as const;

const SYSTEM_PROMPT = 'You are a careful, impartial judge. You are given a state (text or JSON) and one question about it. '
  + 'Read the state closely and answer the question about the state only. '
  + 'Reply with exactly one word from the allowed answers and nothing else: no explanation, no punctuation.';

export interface LogprobJudgeOptions {
  /** The OpenAI-compatible base, such as `https://llm.example.net/v1`. */
  baseUrl: string;
  model: string;
  /** Without it no Authorization header is sent. */
  apiKey?: string;
  /** Questions asked at once. */
  concurrency?: number;
  /** The limit on the judgement as a whole, every question included. */
  timeoutMs?: number;
  /** The order the placement's options are lettered in; only the evaluation changes it. */
  placementOrder?: readonly Placement[];
  /** Replaced by the tests; nothing here ever reaches the network in them. */
  fetch?: typeof fetch;
}

interface Candidate { token: string; logprob: number }

export class LogprobJudgeClient implements JudgeClient {
  private readonly options: LogprobJudgeOptions;
  constructor(options: LogprobJudgeOptions) { this.options = options; }

  async judge(state: JudgeState, options: { placement: boolean }): Promise<Judgement> {
    const stateText = `<state>\n${JSON.stringify(state, null, 2)}\n</state>\n\n`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS);
    const limit = limiter(this.options.concurrency ?? DEFAULT_JUDGE_CONCURRENCY);
    const ask = (question: string) => limit(() => this.ask(`${stateText}${question}`, controller.signal));
    try {
      const noul = (instructions: string) => ask(`Question: ${instructions}\n\nAnswer with exactly one word: yes or no.`).then(candidates => {
        const { yes, no } = mass(candidates, ['yes', 'no']);
        if (!(yes! + no! > 0)) throw new JudgeError('no-answer-token');
        return yes! / (yes! + no!);
      });
      const order = this.options.placementOrder ?? PLACEMENT_ORDER;
      const placement = options.placement
        ? ask(`Question: ${JUDGE_PLACEMENT.instructions}\n\nOptions:\n${order.map((name, index) => `${LETTERS[index]}) ${name}: ${JUDGE_PLACEMENT.criteria[name]}`).join('\n')}`
          + `\n\nAnswer with exactly one letter: ${LETTERS.join(' or ')}.`).then(candidates => {
          const letters = mass(candidates, LETTERS.map(letter => letter.toLowerCase()));
          const total = LETTERS.reduce((sum, letter) => sum + letters[letter.toLowerCase()]!, 0);
          if (!(total > 0)) throw new JudgeError('no-answer-token');
          const of = (name: Placement) => letters[LETTERS[order.indexOf(name)]!.toLowerCase()]! / total;
          const thread = of('thread');
          const channel = of('channel');
          return { choice: thread >= channel ? 'thread' as const : 'channel' as const, probabilities: { thread, channel } };
        })
        : undefined;
      // Every question is under way before the first answer is looked at; the first failure is the one reported.
      const scores = JUDGE_ISSUES.map(issue => noul(issue.instructions));
      const settled = await Promise.allSettled([...scores, ...placement ? [placement] : []]);
      const failed = settled.find(result => result.status === 'rejected');
      if (failed) throw (failed as PromiseRejectedResult).reason;
      const issues = await Promise.all(scores);
      return { issues: JUDGE_ISSUES.map((issue, index) => ({ name: issue.name, label: issue.label, score: issues[index]! })),
        ...(placement ? { placement: await placement } : {}) };
    } catch (error) {
      if (error instanceof JudgeError) throw error;
      throw new JudgeError(controller.signal.aborted ? 'timeout' : 'unreachable');
    } finally { clearTimeout(timer); }
  }

  /** One question: the candidates for the first token of the answer. */
  private async ask(user: string, signal: AbortSignal): Promise<Candidate[]> {
    if (signal.aborted) throw new JudgeError('timeout');
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}) },
        body: JSON.stringify({
          model: this.options.model,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }],
          temperature: 0, max_tokens: 1, logprobs: true, top_logprobs: TOP_LOGPROBS, stream: false,
          chat_template_kwargs: { enable_thinking: false },
        }),
      });
    } catch {
      throw new JudgeError(signal.aborted ? 'timeout' : 'unreachable');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new JudgeError(`http-${response.status}`);
    }
    let body: unknown;
    try { body = await response.json(); } catch { throw new JudgeError(signal.aborted ? 'timeout' : 'malformed'); }
    const candidates = firstCandidates(body);
    if (candidates.some(candidate => /<\/?think>/.test(candidate.token)) && !candidates.some(candidate => ANSWERS.has(normalize(candidate.token)))) {
      throw new JudgeError('thinking');
    }
    return candidates;
  }
}

const ANSWERS = new Set(['yes', 'no', 'a', 'b']);

/** The candidates for the first generated token, as OpenAI returns them (`choices[0].logprobs.content[0].top_logprobs`). */
function firstCandidates(body: unknown): Candidate[] {
  const first = (body as { choices?: { logprobs?: { content?: { token?: unknown; logprob?: unknown; top_logprobs?: unknown }[] } }[] })
    ?.choices?.[0]?.logprobs?.content?.[0];
  const listed = Array.isArray(first?.top_logprobs) ? first.top_logprobs as { token?: unknown; logprob?: unknown }[] : [];
  const candidates = listed.filter(item => typeof item?.token === 'string' && Number.isFinite(item?.logprob))
    .map(item => ({ token: item.token as string, logprob: item.logprob as number }));
  // The token generated may be missing from the top list; it counts too.
  if (typeof first?.token === 'string' && Number.isFinite(first?.logprob) && !candidates.some(candidate => candidate.token === first.token)) {
    candidates.push({ token: first.token, logprob: first.logprob as number });
  }
  if (candidates.length === 0) throw new JudgeError('no-logprobs');
  return candidates;
}

/** A token as an answer: spaces (with SentencePiece's ▁ and byte-level BPE's Ġ), quotes and punctuation dropped, lower case. */
function normalize(token: string): string {
  return token.replace(/^[\s▁Ġ"'`*([]+|[\s▁Ġ"'`*.,:;!)\]]+$/g, '').toLowerCase();
}

/** The probability of each answer, summed over the spellings of it among the candidates. */
function mass(candidates: Candidate[], answers: readonly string[]): Record<string, number> {
  const found: Record<string, number> = Object.fromEntries(answers.map(answer => [answer, 0]));
  for (const candidate of candidates) {
    const answer = normalize(candidate.token);
    if (answer in found) found[answer]! += Math.exp(candidate.logprob);
  }
  return found;
}

/** Runs at most `limit` of the given tasks at once, in the order they were given. */
function limiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async task => {
    if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve));
    else active += 1;
    try { return await task(); } finally {
      const next = waiting.shift();
      if (next) next(); else active -= 1;
    }
  };
}
