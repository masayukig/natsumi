import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { openAIResponsesApi } from '@earendil-works/pi-ai/compat';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { COMPATIBLE_MAX_TOKENS, type CompatibleEndpoint, DEFAULT_CONTEXT_WINDOW } from './compatible.ts';
import { isLoopbackHost } from './loopback.ts';
import type { PiTarget } from './session.ts';

/** A runtime that uses only the OAuth login stored at `authPath` for `provider`. No API key route exists here. */
export async function subscriptionRuntime(root: string, authPath: string, provider: string): Promise<ModelRuntime> {
  try { await access(authPath); } catch { throw new Error('Pi subscription login required'); }
  const runtime = await ModelRuntime.create({ authPath, modelsPath: null,
    modelsStorePath: join(root, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
  const credentials = await runtime.listCredentials();
  if (!credentials.some(c => c.providerId === provider && c.type === 'oauth')) {
    throw new Error('Pi subscription login required');
  }
  return runtime;
}

/** A compatible route as the runtime registers it: its own provider, its endpoint, and the key the server resolved. */
export interface RouteEndpoint { provider: string; endpoint: CompatibleEndpoint; apiKey: string | undefined }

/**
 * One runtime for every configured route, so that a session can move from one to another (ADR 0046). Each compatible
 * endpoint is registered under its own provider with the key the server already resolved from its own secret
 * reference; the key is handed to Pi as a runtime key, used as given and never interpreted as a `$VAR` template or
 * `!command`. The OAuth login at `authPath` is read only when that file already exists: the server never creates it.
 * A route whose key or login is missing is simply not ready (`routeReady`); nothing stands in for it.
 */
export async function routesRuntime(root: string, options: { authPath?: string; compatible: RouteEndpoint[]; relay?: string }): Promise<ModelRuntime> {
  for (const { endpoint } of options.compatible) checkEndpoint(endpoint);
  let loginFile = false;
  if (options.authPath) { try { await access(options.authPath); loginFile = true; } catch { /* no login yet */ } }
  const runtime = await ModelRuntime.create({ ...(loginFile ? { authPath: options.authPath } : { credentials: new InMemoryCredentialStore() }),
    modelsPath: null, modelsStorePath: join(root, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
  for (const { provider, endpoint, apiKey } of options.compatible) {
    runtime.registerProvider(provider, compatibleProvider(endpoint));
    if (apiKey) await runtime.setRuntimeApiKey(provider, apiKey);
  }
  if (options.relay) await relayProvider(runtime, options.relay);
  return runtime;
}

/** The provider a relay serves, and the base Pi keeps for it so that it treats the key as a ChatGPT sign-in (ADR 0087). */
const RELAY_PROVIDER = 'openai';
const OPENAI_BASE = 'https://api.openai.com/v1';

/**
 * What Pi sends as the key through a relay. It is no secret: the relay drops it and the token is added beyond it. It
 * must not begin with `sk-`, or Pi would take it for an API key and send what a ChatGPT sign-in refuses.
 */
export const RELAY_API_KEY = 'natsumi-relay';

/**
 * Pi's own Responses API for the openai provider, with every request sent to the relay instead (ADR 0087). The base
 * stays the official one, which is what makes Pi treat the key as a ChatGPT sign-in; only the fetch it is handed
 * changes where the request goes. The key is a runtime key, so a login at `authPath` is never used for it.
 */
async function relayProvider(runtime: ModelRuntime, relay: string) {
  const api = openAIResponsesApi();
  const fetch = relayFetch(relay);
  runtime.registerProvider(RELAY_PROVIDER, { api: 'openai-responses',
    streamSimple: (model, context, options) => api.streamSimple(model, context, { ...options, fetch }) });
  await runtime.setRuntimeApiKey(RELAY_PROVIDER, RELAY_API_KEY);
}

/**
 * A fetch that sends a request for the OpenAI API to the same path on the relay, and refuses any other: through a
 * relay nothing reaches the network but the relay itself.
 */
export function relayFetch(relay: string): typeof globalThis.fetch {
  const origin = new URL(relay).origin;
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== new URL(OPENAI_BASE).origin) return Promise.reject(new Error('The relay carries only the OpenAI API'));
    const target = new URL(`${url.pathname}${url.search}`, origin);
    return globalThis.fetch(input instanceof Request ? new Request(target, input) : target, init);
  };
}

/**
 * Whether a route can be used now: Pi knows its model, and it has its own way in — the resolved key of a compatible
 * endpoint, the placeholder key of a relay, or the OAuth login of a subscription. An API key from the environment
 * never counts for a subscription. The login file is read again on every call, so a login made after startup is seen.
 */
export async function routeReady(runtime: ModelRuntime, target: PiTarget, compatible: boolean): Promise<boolean> {
  if (!runtime.getModel(target.provider, target.model)) return false;
  const runtimeKey = runtime.getProviderAuthStatus(target.provider).source === 'runtime';
  if (compatible || runtimeKey) return runtimeKey;
  return (await runtime.listCredentials()).some(c => c.providerId === target.provider && c.type === 'oauth');
}

/** The context window Pi's own model definitions give a model, without any login. */
export async function catalogContextWindow(root: string, target: PiTarget): Promise<number | undefined> {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
  return runtime.getModel(target.provider, target.model)?.contextWindow;
}

/** Exported for the live harness's own variant, which reads the key from the environment instead. */
export async function emptyRuntime(root: string, endpoint: CompatibleEndpoint): Promise<ModelRuntime> {
  checkEndpoint(endpoint);
  return ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
}

function checkEndpoint(endpoint: CompatibleEndpoint) {
  let url: URL;
  try { url = new URL(endpoint.baseUrl); } catch { throw new Error('Compatible endpoint must use https'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error('Compatible endpoint must use https');
  }
}

/** Exported for the same reason as `emptyRuntime`: every route must describe the endpoint identically. */
export function compatibleProvider(endpoint: CompatibleEndpoint): Parameters<ModelRuntime['registerProvider']>[1] {
  return {
    name: 'OpenAI-compatible endpoint', baseUrl: endpoint.baseUrl, api: 'openai-completions',
    models: [{
      // Images too: a Slack mention's pictures ride beside its event, and `view` answers with one (ADR 0039). Pi sends
      // a tool result's image as a user message after it, which Chat Completions takes.
      id: endpoint.model, name: endpoint.model, reasoning: true, input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: endpoint.contextWindow ?? DEFAULT_CONTEXT_WINDOW, maxTokens: COMPATIBLE_MAX_TOKENS,
      // Qwen-style chat templates: Pi's thinking level becomes chat_template_kwargs.enable_thinking (off → false).
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false, maxTokensField: 'max_tokens',
        thinkingFormat: 'qwen-chat-template' },
    }],
  };
}
