import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import type { FoldCommand } from './fold-setting.ts';
import type { ModelCommand } from './model-routes.ts';
import { STATS_TIME, type StatsCommand } from './turn-stats.ts';

export class UsageError extends Error {
  constructor(message: string) { super(message); this.name = 'UsageError'; }
}

export type Command =
  | { command: 'serve'; config: string; dataDir: string | undefined }
  | { command: 'health'; dataDir: string | undefined }
  | ModelCommand
  | FoldCommand
  | StatsCommand;

export const USAGE = `usage: natsumi serve [--config <file>] [--data-dir <dir>]
       natsumi health [--data-dir <dir>]
       natsumi model list|status [--data-dir <dir>]
       natsumi model use <route> [--data-dir <dir>]
       natsumi fold on|off|status [--data-dir <dir>]
       natsumi stats [--since <YYYY-MM-DD>] [--until <YYYY-MM-DD>] [--data-dir <dir>]
       natsumi stats --memos <count> [--config <file>]`;

export function parseCli(argv: string[]): Command {
  const [command, ...rest] = argv;
  if (command !== 'serve' && command !== 'health' && command !== 'model' && command !== 'fold' && command !== 'stats') {
    throw new UsageError(USAGE);
  }
  const options: ParseArgsOptionsConfig = { 'data-dir': { type: 'string' } };
  if (command === 'serve') options.config = { type: 'string' };
  if (command === 'stats') {
    options.since = { type: 'string' }; options.until = { type: 'string' };
    options.memos = { type: 'string' }; options.config = { type: 'string' };
  }
  let values: { config?: string; 'data-dir'?: string; since?: string; until?: string; memos?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: rest, options, strict: true,
      allowPositionals: command === 'model' || command === 'fold' }));
  } catch (error) {
    throw new UsageError(`${error instanceof Error ? error.message : error}\n${USAGE}`);
  }
  const dataDir = values['data-dir'];
  if (command === 'model') {
    const [action, ...names] = positionals;
    if ((action === 'list' || action === 'status') && names.length === 0) return { command, action, dataDir };
    if (action === 'use' && names.length === 1) return { command, action, route: names[0]!, dataDir };
    throw new UsageError(USAGE);
  }
  if (command === 'fold') {
    const [action, ...extra] = positionals;
    if ((action === 'on' || action === 'off' || action === 'status') && extra.length === 0) return { command, action, dataDir };
    throw new UsageError(USAGE);
  }
  if (command === 'stats') {
    const { since, until, memos, config } = values;
    if (memos !== undefined) {
      if (!/^[1-9]\d{0,3}$/.test(memos) || since !== undefined || until !== undefined) throw new UsageError(USAGE);
      return { command, memos: Number(memos), config: config ?? 'config.local.json', dataDir };
    }
    if (config !== undefined) throw new UsageError(USAGE);
    for (const time of [since, until]) {
      if (time !== undefined && (!STATS_TIME.test(time) || Number.isNaN(Date.parse(time)))) throw new UsageError(`not a date: ${time}\n${USAGE}`);
    }
    return { command, dataDir, ...(since ? { since } : {}), ...(until ? { until } : {}) };
  }
  return command === 'serve' ? { command, config: values.config ?? 'config.local.json', dataDir } : { command, dataDir };
}
