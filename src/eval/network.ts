/**
 * The way out of an isolated run (ADR 0052) is the proxy in the environment, which Node turns into its global HTTP
 * dispatcher at startup (`NODE_USE_ENV_PROXY`). Loading Pi loads its own undici, which replaces that dispatcher with
 * one that knows no proxy: a model call would then try to connect straight out, and in a namespace with loopback only
 * it fails at once (`Connection error.`). This module is imported before anything else, keeps the dispatcher Node
 * made, and puts it back once everything is loaded.
 */

const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');
const fromEnvironment = (globalThis as Record<symbol, unknown>)[GLOBAL_DISPATCHER];

/** Puts back the dispatcher Node made from the proxy environment at startup. */
export function useProxyDispatcher(): void {
  if (!fromEnvironment || (fromEnvironment as { constructor?: { name?: string } }).constructor?.name !== 'EnvHttpProxyAgent') {
    throw new Error('no proxy dispatcher was made at startup (NODE_USE_ENV_PROXY and HTTPS_PROXY must be set)');
  }
  (globalThis as Record<symbol, unknown>)[GLOBAL_DISPATCHER] = fromEnvironment;
}
