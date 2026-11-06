/**
 * How natsumi names and describes an OpenAI-compatible endpoint. The config parser and the Pi runtime must agree on
 * both, and the parser must not have to load Pi's SDK to check a config file, so they live here rather than in
 * `auth.ts`. Nothing here imports.
 */

/** The provider a compatible endpoint is registered under. Configured models name it; no other provider is accepted. */
export const COMPATIBLE_PROVIDER = 'natsumi-compatible';

/** The context window Pi is told the model has, unless the config says otherwise. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * The longest reply one model call may ask for. Pi gives a compaction summary the model's whole output limit, which is
 * this, and thinking spends the same tokens. At 4096 a summary stopped at the cap and no compaction ever succeeded.
 */
export const COMPATIBLE_MAX_TOKENS = 16_384;

/** An explicitly chosen Chat Completions endpoint, the one model it serves, and that model's context window. */
export interface CompatibleEndpoint { baseUrl: string; model: string; contextWindow?: number }

/** Pi sizes each request's reply to fit what is left of the window less this margin (pi-ai `clampMaxTokensToContext`). */
export const PI_CONTEXT_SAFETY_TOKENS = 4096;
