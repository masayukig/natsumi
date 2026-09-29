import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_DIRECTORY } from './data-directory.ts';
import { writeFileAtomically } from './paths.ts';
import { ROUTE_NAME, type RouteView } from '../shared/protocol/settings.ts';
import { readRouteOverride, writeOverride } from './settings/store.ts';
import { checkHealth, readStatus } from './status.ts';

/**
 * The owner's choice of model route, and what the server says about its routes (ADR 0046). Both are files in the
 * data directory, so the command line reaches a running server without a listener of its own, and a choice made
 * while the server is stopped is there when it starts. Nothing here loads Pi.
 *
 * - `model-route.json` is the choice, kept by the runtime settings' store (ADR 0058). The command line and the clients' command write it; the server reads it before
 *   every turn and now and then between turns.
 * - `model-routes.json` is what the server publishes: the routes, whether each is ready, the one in use and the one
 *   chosen. The command line reads it to list the routes and to check a name before writing it.
 */

/** A route as the owner is shown it: never its endpoint or its key. The contract's type, shared with the browser. */
export type { RouteView };

export interface RouteStatus {
  defaultRoute: string;
  /** The route the session is on, or null while natsumi cannot talk. */
  current: string | null;
  /** The route the owner chose, the default when none was chosen. The session moves to it before its next turn. */
  chosen: string;
  routes: RouteView[];
}

/** The rule the config gives a route's name, so the command line needs no config to check one. */
export { ROUTE_NAME } from '../shared/protocol/settings.ts';

const statusPath = (dataDirectory: string) => join(dataDirectory, STATE_DIRECTORY, 'model-routes.json');

/**
 * The chosen route's name, or undefined when none was chosen or the file cannot be read. The choice is the owner's
 * override of the config's default route, kept by the runtime settings' store (ADR 0058).
 */
export function readRouteChoice(dataDirectory: string): Promise<string | undefined> {
  return readRouteOverride(dataDirectory);
}

export function writeRouteChoice(dataDirectory: string, route: string, now: number): Promise<void> {
  return writeOverride(dataDirectory, 'modelRoute', route, now);
}

export async function readRouteStatus(dataDirectory: string): Promise<RouteStatus | undefined> {
  try { return JSON.parse(await readFile(statusPath(dataDirectory), 'utf8')) as RouteStatus; } catch { return undefined; }
}

export async function writeRouteStatus(dataDirectory: string, status: RouteStatus, now: number): Promise<void> {
  await writeFileAtomically(statusPath(dataDirectory), `${JSON.stringify({ ...status, updatedAt: new Date(now).toISOString() })}\n`, 0o600);
}

export type ModelCommand = { command: 'model'; dataDir: string | undefined } &
  ({ action: 'list' | 'status' } | { action: 'use'; route: string });

/** `natsumi model …`: lines go to `write`, and the exit code is returned. */
export async function runModelCommand(cli: ModelCommand, dataDirectory: string, write: (line: string) => void,
  now: () => number = Date.now): Promise<number> {
  const status = await readRouteStatus(dataDirectory);
  const running = checkHealth(await readStatus(dataDirectory), now()).healthy;
  const when = running ? 'natsumi moves to it before her next turn' : 'natsumi uses it from her next start';
  if (cli.action === 'use') {
    const { route } = cli;
    if (!ROUTE_NAME.test(route)) { write(`${route} is not a route name`); return 1; }
    if (!status) {
      await writeRouteChoice(dataDirectory, route, now());
      write(`chose ${route}: natsumi uses it from her next start (the route list is not known yet)`);
      return 0;
    }
    const known = status.routes.find(view => view.name === route);
    if (!known) { write(`no route named ${route}; the routes are ${status.routes.map(view => view.name).join(', ')}`); return 1; }
    if (!known.ready) { write(`${route} is not ready: log in or provide its API key, then try again`); return 1; }
    await writeRouteChoice(dataDirectory, route, now());
    write(`chose ${route}: ${when}`);
    return 0;
  }
  if (!status) { write('no route list yet: start the server once with this data directory'); return 1; }
  if (cli.action === 'status') {
    write(`in use: ${status.current ?? 'none (natsumi cannot talk now)'}`);
    write(`chosen: ${status.chosen}${status.chosen !== status.current ? ` (${when})` : ''}`);
    write(`default: ${status.defaultRoute}`);
    return 0;
  }
  const width = (pick: (view: RouteView) => string) => Math.max(...status.routes.map(view => pick(view).length));
  const nameWidth = width(view => view.name);
  const modelWidth = width(view => `${view.provider}/${view.model}`);
  for (const view of status.routes) {
    const marks = [view.name === status.defaultRoute ? 'default' : '', view.name === status.current ? 'in use' : '',
      view.name === status.chosen && view.name !== status.current ? 'chosen' : ''].filter(Boolean);
    const line = `${view.name === status.current ? '*' : ' '} ${view.name.padEnd(nameWidth)}  ` +
      `${`${view.provider}/${view.model}`.padEnd(modelWidth)}  ${view.ready ? 'ready' : 'not ready'}${marks.length ? `  (${marks.join(', ')})` : ''}`;
    write(line.trimEnd());
  }
  return 0;
}
