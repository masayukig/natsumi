import { readFile } from 'node:fs/promises';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { routesRuntime } from '../pi/auth.ts';
import type { PiTarget } from '../pi/session.ts';
import { absolutePath, ConfigError, type CompatibleConfig, object, onlyKeys, parseRoute } from '../server/config.ts';
import { readSecret } from '../server/secrets.ts';

/**
 * A model to evaluate, or the judge, written as the `pi` section of the config is for one route (ADR 0051): `pi.model`,
 * and `pi.compatible` with `baseUrl` and `apiKeyFile` (or `apiKeyEnv`) for the owner's own endpoint, or `pi.authPath`
 * for a subscription login. Reading the file never reads the key; only the runtime does, and nothing records it.
 */
export interface ModelFile {
  target: PiTarget;
  compatible: boolean;
  endpoint?: CompatibleConfig;
  authPath?: string;
  thinking: 'on' | 'off';
  /** All a result may say about the model: no endpoint, which may be an internal host, and no key. */
  shown: { provider: string; id: string };
}

export async function readModelFile(file: string): Promise<ModelFile> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(file, 'utf8')); } catch { throw new ConfigError('model file', 'cannot be read as JSON'); }
  const pi = object(object(raw, 'the model file').pi, 'pi');
  onlyKeys(pi, 'pi', ['model', 'compatible', 'authPath', 'thinking']);
  const route = parseRoute(pi, 'pi');
  const thinking = pi.thinking === undefined ? 'on' : pi.thinking;
  if (thinking !== 'on' && thinking !== 'off') throw new ConfigError('pi.thinking', 'must be "on" or "off"');
  if (!route.compatible && pi.authPath === undefined) throw new ConfigError('pi.authPath', `is required for the ${route.model.provider} provider`);
  return {
    target: { provider: route.model.provider, model: route.model.id },
    compatible: route.compatible !== undefined,
    ...(route.compatible ? { endpoint: route.compatible } : { authPath: absolutePath(pi.authPath, 'pi.authPath') }),
    thinking,
    shown: { provider: route.model.provider, id: route.model.id },
  };
}

/**
 * The runtime for one model file, made the way the server makes its routes: a compatible endpoint with its key, or the
 * subscription login. A key that cannot be read stops here, naming the setting only.
 */
export async function modelRuntime(file: ModelFile, root: string, env: Record<string, string | undefined>): Promise<ModelRuntime> {
  if (!file.endpoint) return routesRuntime(root, { authPath: file.authPath!, compatible: [] });
  const apiKey = await readSecret(file.endpoint.apiKey, 'pi.compatible.apiKey', env);
  return routesRuntime(root, { compatible: [{ provider: file.target.provider, apiKey,
    endpoint: { baseUrl: file.endpoint.baseUrl, model: file.target.model, contextWindow: file.endpoint.contextWindow } }] });
}
