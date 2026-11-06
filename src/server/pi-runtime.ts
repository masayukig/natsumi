import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { routesRuntime } from '../pi/auth.ts';
import type { PiConfig } from './config.ts';
import { readSecret } from './secrets.ts';

/**
 * One model runtime for every route in `pi.routes` (ADR 0046). A compatible route uses only its referenced key, and a
 * relayed one only the relay (ADR 0087); every other provider uses only the OAuth login in the dedicated auth file. A key that cannot be read leaves its route not
 * ready rather than stopping the others; no route ever stands in for another (ADR 0004).
 */
export async function createModelRuntime(pi: PiConfig, env: Record<string, string | undefined>): Promise<ModelRuntime> {
  const compatible = await Promise.all(pi.routes.filter(route => route.compatible).map(async ({ name, model, compatible: endpoint }) => {
    // Resolved once at startup from the server's own reference; a rotated key takes effect on restart.
    let apiKey: string | undefined;
    try { apiKey = await readSecret(endpoint!.apiKey, `pi.routes.${name}.compatible.apiKey`, env); } catch { apiKey = undefined; }
    return { provider: model.provider, apiKey,
      endpoint: { baseUrl: endpoint!.baseUrl, model: model.id, contextWindow: endpoint!.contextWindow } };
  }));
  // A relayed route has a placeholder key and the relay adds the token, so it needs no login (ADR 0087).
  const subscription = pi.routes.some(route => !route.compatible && !route.relay);
  const relay = pi.routes.find(route => route.relay)?.relay?.url;
  return routesRuntime(pi.agentDirectory, { compatible, ...(subscription ? { authPath: pi.authPath } : {}), ...(relay ? { relay } : {}) });
}
