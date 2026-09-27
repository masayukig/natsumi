/**
 * One run of one scene, as a line of `runs.jsonl` (ADR 0051). It carries what the turn was handed and what it did, never
 * a key or an endpoint: the model is named by its provider and id alone.
 */
export interface RunRecord {
  scene: string;
  variant: string;
  /** 1-based, per scene and variant. */
  run: number;
  model: { provider: string; id: string };
  /** The model was the scripted stand-in, not a real one. */
  dryRun: boolean;
  startedAt: string;
  /** From the event being handed over to the end of the turn. */
  ms: number;
  /**
   * How the turn ended, as the loop records it (`ok`, `model-call-limit`, `timeout`, `model-error`), or `error` when the
   * run itself could not be made; `error` then says why.
   */
  outcome: string;
  error?: string;
  modelCalls: number;
  tokens: { input: number; cacheRead: number; output: number };
  /** The instructions the model was given, by size and digest, so that two results can tell which prompt they measured. */
  instructions: { chars: number; sha256: string };
  /** The messages the session held before the turn: the prelude, the padding or the copied session. */
  priorMessages: number;
  /** The user message of the turn, and the event lines inside its `<events>`. */
  prompt: string;
  events: Record<string, unknown>[];
  calls: ModelCallRecord[];
  tools: ToolRecord[];
  /**
   * What the owner's devices were shown in the turn, with the model call (1-based) whose tool showed it. Results written
   * before the call was kept have no `call`.
   */
  replies: { kind: 'reply' | 'notice'; text: string; expression: string | null; call?: number }[];
  /** Requests to the dove, whether or not it took them. Nothing was sent anywhere. */
  dove: { message: string; ok: boolean }[];
  checks: CheckResult[];
  /** The run's own copy of the Pi session, outside the repository. */
  session?: string;
}

/** One model call of the turn. */
export interface ModelCallRecord {
  ms: number;
  /** When the call ended, in ms from the event being handed over; absent in results written before it was kept. */
  at?: number;
  stopReason: string;
  input: number;
  cacheRead: number;
  output: number;
  thinkingChars: number;
  text: string;
}

/** One tool call: the model call it was made in (1-based), what it was called with and what came back. */
export interface ToolRecord {
  call: number;
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
}

/**
 * The verdict on one check, and how it was reached: a rule, a function beside the scene or an LLM with a rubric.
 * `pass` is null when it could not be judged; such a run is left out of that check's count.
 */
export interface CheckResult {
  id: string;
  by: 'rule' | 'function' | 'llm';
  pass: boolean | null;
  detail: string;
  /**
   * The model call (1-based) at which a passed rule was first met, and the tokens and the time spent up to the end of
   * it. Only rules met by something done in a call have it: not those met by something not done or by the whole turn,
   * nor functions and rubrics. Absent in results written before it was kept.
   */
  reached?: Reached;
}

export interface Reached {
  call: number;
  /** From the event being handed over to the end of the call. */
  ms: number;
  /** Summed over the calls up to and including it. */
  tokens: { input: number; cacheRead: number; output: number };
}
