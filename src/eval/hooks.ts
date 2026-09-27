import type { CheckFunction } from './checks.ts';

/**
 * What a scene's `scene.ts` may export (ADR 0051): a setup function, named by the scene's `setup`, and check functions,
 * named by its `function` checks. Both are plain exports of the module.
 */
export interface SetupContext {
  /** The run's data directory, laid out as the server's: `memory/`, `work/`, `home/`, `sources/`, `agents/`. */
  data: string;
  /** The run's copy of the manual, seen as /manual. */
  manual: string;
  scene: string;
  /** The variant being run, its axis values joined by `/`. */
  variant: string;
}

export type SetupFunction = (context: SetupContext) => void | Promise<void>;

export interface SceneModule {
  setup?: SetupFunction;
  functions: Record<string, CheckFunction>;
}

/** Loads `scene.ts`, keeping every exported function: which is the setup and which are checks is the scene's to say. */
export async function loadSceneModule(file: string | undefined, setup: string | undefined): Promise<SceneModule> {
  if (!file) {
    if (setup) throw new Error(`the scene names the setup ${setup}, but has no scene.ts`);
    return { functions: {} };
  }
  const module = await import(file) as Record<string, unknown>;
  const functions: Record<string, CheckFunction> = {};
  for (const [name, value] of Object.entries(module)) if (typeof value === 'function') functions[name] = value as CheckFunction;
  if (setup && !functions[setup]) throw new Error(`scene.ts has no function ${setup} for the setup`);
  return { ...(setup ? { setup: functions[setup] as unknown as SetupFunction } : {}), functions };
}
