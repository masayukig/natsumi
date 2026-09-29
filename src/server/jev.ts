import { DEFAULT_JUDGE_TIMEOUT_MS, JUDGE_ISSUES, JUDGE_PLACEMENT, JudgeError, PLACEMENT_ORDER, probability, type JudgeClient, type JudgeState,
  type Judgement, type Placement } from './judge.ts';

/**
 * The dove's judge through TypeSafe AI's Jev API (ADR 0039, ADR 0040), or a server of the owner's own that answers the
 * same API. One call asks a Noul for every issue and, when natsumi answers a message, a Choice of where the reply goes.
 * The questions and the state are `judge.ts`'s, the same the logprobs method asks.
 */

/** TypeSafe's own. A Jev-compatible server answers the same path at another base (ADR 0040). */
export const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai';
const JEV_PATH = '/v1/systemone';
export const DEFAULT_JEV_MODEL = 'jev-latest';

export interface HttpJevClientOptions {
  /** `https://api.typesafe.ai` unless another server that speaks the same API is named. */
  baseUrl?: string;
  /** Without it no Authorization header is sent: a server of the owner's own may need none. */
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  /** The order the placement's options are sent in; only the evaluation changes it. */
  placementOrder?: readonly Placement[];
  /** Replaced by the tests; nothing here ever reaches the network in them. */
  fetch?: typeof fetch;
}

export class HttpJevClient implements JudgeClient {
  private readonly options: HttpJevClientOptions;
  constructor(options: HttpJevClientOptions) { this.options = options; }

  async judge(state: JudgeState, options: { placement: boolean }): Promise<Judgement> {
    const questions: Record<string, unknown> = Object.fromEntries(JUDGE_ISSUES.map(issue => [issue.name, { type: 'noul', instructions: issue.instructions }]));
    if (options.placement) {
      const criteria = Object.fromEntries((this.options.placementOrder ?? PLACEMENT_ORDER).map(name => [name, JUDGE_PLACEMENT.criteria[name]]));
      questions.placement = { type: 'choice', instructions: JUDGE_PLACEMENT.instructions, criteria };
    }
    const fetching = this.options.fetch ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS);
    let text: string;
    try {
      const base = (this.options.baseUrl ?? DEFAULT_JEV_BASE_URL).replace(/\/+$/, '');
      const response = await fetching(`${base}${JEV_PATH}`, {
        method: 'POST', signal: controller.signal,
        headers: { ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}), 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.options.model, state, questions }),
      });
      if (!response.ok) throw new JudgeError(`http-${response.status}`);
      text = await response.text();
    } catch (error) {
      if (error instanceof JudgeError) throw error;
      throw new JudgeError(controller.signal.aborted ? 'timeout' : 'unreachable');
    } finally { clearTimeout(timer); }
    return parseAnswer(text, options.placement);
  }
}

function parseAnswer(text: string, placement: boolean): Judgement {
  let body: { answers?: Record<string, { noul?: unknown; choice?: unknown; probabilities?: Record<string, unknown> }> };
  try { body = JSON.parse(text); } catch { throw new JudgeError('malformed'); }
  const answers = body?.answers;
  if (!answers || typeof answers !== 'object') throw new JudgeError('malformed');
  const issues = JUDGE_ISSUES.map(issue => {
    const score = answers[issue.name]?.noul;
    if (!probability(score)) throw new JudgeError('malformed');
    return { name: issue.name, label: issue.label, score };
  });
  if (!placement) return { issues };
  const answer = answers.placement;
  if (answer?.choice !== 'thread' && answer?.choice !== 'channel') throw new JudgeError('malformed');
  const thread = answer.probabilities?.thread;
  const channel = answer.probabilities?.channel;
  // The probabilities are shown to the owner when there are any; a compatible server may not give them.
  const probabilities = probability(thread) && probability(channel) ? { probabilities: { thread, channel } } : {};
  return { issues, placement: { choice: answer.choice, ...probabilities } };
}
