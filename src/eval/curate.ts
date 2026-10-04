import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { routesRuntime } from '../pi/auth.ts';
import { CURATOR_DEFAULTS, LOOP_DEFAULTS, type CuratorConfig } from '../server/config.ts';
import { initializeDataDirectory, STATE_DIRECTORY } from '../server/data-directory.ts';
import { gitIdentity, runGit } from '../server/git.ts';
import { CurationRecord, recoverCuratorRun, runCuratorNight } from '../server/memory-curator.ts';
import { MemoryRepository } from '../server/memory-repository.ts';
import { MIGRATIONS } from '../server/migrations.ts';
import { DEFAULT_SELF } from '../server/prompts.ts';
import { migrate, openStateDatabase } from '../server/state-db.ts';
import { WorkspaceShell } from '../server/workspace-shell.ts';
import type { ModelFile } from './model-file.ts';
import { DRY_TARGET, openSnapshot } from './run.ts';
import { scriptedStream, type Answer } from './scripted.ts';
import type { SnapshotInfo } from './snapshot.ts';
import { bwrapAvailable, type Sandbox, type WorkspaceStarter } from './workspace.ts';

/**
 * The memory curator's night on a copy of production (ADR 0068): the snapshot's memory, SQLite and sessions are copied
 * to a place of the night's own, the curator runs there as the server would run it after the nightly review, and what
 * it left — the memory with its commits, the diff from the snapshot's memory, each stage's outcome, calls and time —
 * is kept for the owner to read before the curator goes into production. The snapshot itself never changes.
 */

/** One stage of the night, as the server counts a curator's turn. */
export interface StageRecord {
  name: string;
  outcome: string;
  modelCalls: number;
  ms: number;
  tokens: { input: number; cacheRead: number; output: number };
  toolErrors: number;
  /** The stage's commit, when it kept something. */
  commit?: string;
  /** The change note it wrote, kept or not. */
  note?: string;
  /** What failed the server's check, when the stage was thrown away for it. */
  rejected?: { path: string; reason: string }[];
  /** What failed the check the first time, when the stage was told it and given its one retry. */
  retried?: { path: string; reason: string }[];
  /** The paths the server put right after the stage's commit (ADR 0068), and the curator's table rows it did not take. */
  paths?: { commit?: string; moves: { from: string; to: string }[]; files: string[]; ignored: { from: string; to: string; reason: string }[] };
}

export interface NightRecord {
  label: string;
  snapshot: string;
  model: { provider: string; id: string };
  dryRun: boolean;
  /** The night the curator was told it is: by default when the snapshot was taken. */
  at: string;
  startedAt: string;
  /** The whole night, wall clock. */
  ms: number;
  /** The commit the night started from, and the one it ended at. */
  base: string;
  head: string;
  /** What the snapshot's memory had not committed, committed apart before the night so that it starts clean. */
  uncommitted: string[];
  stages: StageRecord[];
  /** The night's commits, oldest first. */
  commits: { hash: string; message: string }[];
  /** What the night changed, as git's name-status letters (A, M, D) and paths. */
  files: { path: string; change: string }[];
  /** What the server logged about memory and the curator during the night. */
  log?: string[];
  error?: string;
}

export interface CurateSnapshotOptions {
  snapshot: Pick<SnapshotInfo, 'name' | 'directory' | 'takenAt'>;
  /** The night's results go in `<out>/<label>/`. */
  out: string;
  label: string;
  repository: string;
  runner: WorkspaceStarter;
  /** The model the curator runs on; absent in a dry run. */
  model?: { file: ModelFile; runtime: (root: string) => Promise<ModelRuntime> };
  /** A dry run: the curator's calls are answered from this script, in turn, and no model is reached. */
  dryRun?: Answer[];
  /** The curator's limits and rotation, over the defaults of the `curator` section. */
  curator?: Partial<Pick<CuratorConfig, 'modelCalls' | 'timeoutMinutes' | 'rotateFiles'>>;
  /** The night it is, in milliseconds; by default when the snapshot was taken. */
  at?: number;
  timeZone?: string;
  sandbox?: Sandbox;
  log?: (line: string) => void;
}

/** What the night leaves in its directory beside `copy/`, the working copy with the memory it ended at. */
export const NIGHT_FILES = { record: 'night.json', summary: 'summary.md', diff: 'memory.diff' } as const;
const UNCOMMITTED_MESSAGE = 'eval: 写しにコミットされずに残っていた変更';

export async function curateSnapshot(options: CurateSnapshotOptions): Promise<{ record: NightRecord; directory: string }> {
  const directory = join(options.out, options.label);
  await rm(directory, { recursive: true, force: true });
  const copy = join(directory, 'copy');
  const data = join(copy, 'data');
  const memory = join(data, 'memory');
  const sessionDirectory = join(copy, 'pi', 'sessions');
  const agentDirectory = join(copy, 'pi', 'agent');
  const manual = join(copy, 'manual');
  const at = options.at ?? Date.parse(options.snapshot.takenAt);
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const started = Date.now();
  const record: NightRecord = {
    label: options.label, snapshot: options.snapshot.name,
    model: options.model?.file.shown ?? { provider: DRY_TARGET.provider, id: DRY_TARGET.model }, dryRun: options.dryRun !== undefined,
    at: new Date(at).toISOString(), startedAt: new Date(started).toISOString(), ms: 0, base: '', head: '', uncommitted: [],
    stages: [], commits: [], files: [], log: [],
  };
  const git = (args: string[]) => runGit(memory, args, { identity: gitIdentity(DEFAULT_SELF) });
  const closers: (() => Promise<void> | void)[] = [];
  let diff = '';
  try {
    // Only what the curator works on is copied: memory with its history, SQLite and the sessions.
    await mkdir(join(data, STATE_DIRECTORY), { recursive: true });
    await cp(join(options.snapshot.directory, 'data', 'memory'), memory, { recursive: true });
    await cp(join(options.snapshot.directory, 'data', STATE_DIRECTORY, 'state.sqlite'), join(data, STATE_DIRECTORY, 'state.sqlite'));
    await cp(join(options.snapshot.directory, 'pi', 'sessions'), sessionDirectory, { recursive: true });
    await mkdir(agentDirectory, { recursive: true });
    await initializeDataDirectory(data);
    await cp(join(options.repository, 'manual'), manual, { recursive: true });

    const t0 = Date.now();
    const now = () => at + (Date.now() - t0);
    const db = openStateDatabase(join(data, STATE_DIRECTORY, 'state.sqlite'));
    closers.unshift(() => db.close());
    migrate(db, MIGRATIONS);
    await openSnapshot(db, options.snapshot.directory, sessionDirectory, now);

    // In production the nightly review commits just before the curator starts, so memory is clean. A snapshot may
    // hold what was not yet committed; it goes into a commit of its own, so that the night is measured from there.
    // A curator run the snapshot caught half done is left alone: the loop throws its changes away, as a restart would.
    const cutOff = (db.prepare('SELECT running_since FROM memory_curator WHERE owner = 1').get() as { running_since: string | null } | undefined)
      ?.running_since;
    const loose = (await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])).stdout
      .split('\0').filter(entry => entry.length > 3).map(entry => entry.slice(3));
    if (loose.length > 0 && !cutOff) {
      await git(['add', '-A', '--', '.']);
      await git(['commit', '--no-verify', '--quiet', '-m', UNCOMMITTED_MESSAGE]);
      record.uncommitted = loose.sort();
    }
    // The files the server puts in place on start, put there now, so that their commit is not counted as the night's.
    await new MemoryRepository({ directory: memory, dataDirectory: data, identity: gitIdentity(DEFAULT_SELF) }).initialize();
    record.base = (await git(['rev-parse', 'HEAD'])).stdout.trim();

    // A dry run names the model file it was given, if any, but never reads its key or reaches it.
    const real = options.dryRun ? undefined : options.model;
    if (!real && !options.dryRun) throw new Error('a model or a dry run is needed');
    const target = real?.file.target ?? DRY_TARGET;
    const runtime = real ? await real.runtime(agentDirectory)
      : await routesRuntime(agentDirectory, { compatible: [{ provider: DRY_TARGET.provider, apiKey: 'dry-run',
        endpoint: { baseUrl: 'https://dry-run.invalid/v1', model: DRY_TARGET.model } }] });
    const script = options.dryRun ?? [];
    let step = 0;
    const configureSession = (session: AgentSession) => {
      if (!options.dryRun) return;
      session.agent.streamFunction = (model, _context, streamOptions) => scriptedStream(model, script[step++] ?? {}, streamOptions);
    };

    // Under the temporary directory: a Unix socket's path is short, and the results' directory may be deep.
    const socketParent = await mkdtemp(join(tmpdir(), 'natsumi-ws-'));
    closers.push(() => rm(socketParent, { recursive: true, force: true }));
    const socketDirectory = join(socketParent, 'socket');
    const sandbox = options.sandbox ?? ((await bwrapAvailable()) ? 'bwrap' : 'host');
    if (sandbox === 'host' && !options.dryRun) throw new Error('a real model runs the curator only inside bubblewrap');
    const workspace = await options.runner.start({ data, manual, socketDirectory, sandbox, timeZone });
    closers.unshift(() => workspace.close());

    const log = (line: string) => {
      if (line.startsWith('memory')) record.log!.push(line);
      options.log?.(line);
    };
    // The curator's night as the server runs it after the nightly review (ADR 0068), natsumi's review aside: a stage a
    // stop cut off in the snapshot is thrown away first, as a restart would.
    const repository = new MemoryRepository({ directory: memory, dataDirectory: data, fileMaxChars: LOOP_DEFAULTS.memoryFileMaxChars,
      alwaysMaxChars: LOOP_DEFAULTS.alwaysMemoryMaxChars, identity: gitIdentity(DEFAULT_SELF), log });
    const curation = new CurationRecord(db, now);
    await recoverCuratorRun(repository, curation, log);
    const shell = new WorkspaceShell({ socketPath: join(socketDirectory, 'runner.sock'), timeoutMs: LOOP_DEFAULTS.shellWaitSeconds * 1000,
      timeZone, memoryChanges: () => repository.changeSummary() });
    const night = await runCuratorNight({
      repository, shell, modelRuntime: runtime, route: { name: 'eval', target, compatible: real ? real.file.compatible : true },
      config: { ...CURATOR_DEFAULTS, ...options.curator }, record: curation, now, log, name: DEFAULT_SELF.name, timeZone,
      fileMaxChars: LOOP_DEFAULTS.memoryFileMaxChars, dataDirectory: data, agentDirectory, sessionDirectory,
      thinking: (real?.file.thinking ?? 'on') === 'on' ? 'medium' : 'off', configureSession,
    });
    record.stages = night.stages.map(stage => ({ name: stage.stage, outcome: stage.outcome, modelCalls: stage.calls,
      ms: stage.endedAt - stage.startedAt, tokens: stage.usage, toolErrors: stage.toolErrors,
      ...(stage.commit ? { commit: stage.commit } : {}), ...(stage.note ? { note: stage.note } : {}),
      ...(stage.retried.length > 0 ? { retried: stage.retried.map(file => ({ path: file.path, reason: file.reason })) } : {}),
      ...(stage.rejected.length > 0 ? { rejected: stage.rejected.map(file => ({ path: file.path, reason: file.reason })) } : {}),
      ...(stage.paths ? { paths: { ...(stage.paths.commit ? { commit: stage.paths.commit } : {}), moves: stage.paths.moves, files: stage.paths.files,
        ignored: stage.paths.ignored } } : {}) }));

    record.head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    if (record.head !== record.base) {
      const range = `${record.base}..${record.head}`;
      record.commits = (await git(['log', '--reverse', '--format=%H%x00%B%x1e', range])).stdout.split('\x1e')
        .map(entry => entry.replace(/^\n/, '')).filter(Boolean)
        .map(entry => { const [hash, message] = entry.split('\0'); return { hash: hash!, message: message!.trim() }; });
      record.files = (await git(['diff', '--name-status', '--no-renames', '-z', record.base, record.head])).stdout.split('\0')
        .filter(Boolean).reduce<{ path: string; change: string }[]>((files, part, index, parts) => {
          if (index % 2 === 0) files.push({ change: part, path: parts[index + 1]! });
          return files;
        }, []);
      diff = (await git(['diff', '--no-renames', record.base, record.head])).stdout;
    }
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
  } finally {
    for (const close of closers) { try { await close(); } catch { /* the night is over either way */ } }
  }
  record.ms = Date.now() - started;
  await writeFile(join(directory, NIGHT_FILES.record), `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(join(directory, NIGHT_FILES.diff), diff);
  await writeFile(join(directory, NIGHT_FILES.summary), nightMarkdown(record));
  return { record, directory };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const short = (hash: string) => hash.slice(0, 7) || '（なし）';

/** The night for the owner to read: each stage, the commits under their messages, and the files that changed. */
export function nightMarkdown(night: NightRecord): string {
  const lines = [`# 係の一晩: ${night.label}`, '',
    `- 写し: ${night.snapshot}（${night.at} の夜として）`,
    `- モデル: ${night.model.provider}/${night.model.id}${night.dryRun ? '（ドライラン）' : ''}`,
    `- 始めた時刻: ${night.startedAt}・全体の時間: ${seconds(night.ms)}`,
    `- 記憶: ${short(night.base)} → ${short(night.head)}（\`copy/data/memory\` で \`git log\`・\`git diff ${short(night.base)}\`）`];
  if (night.uncommitted.length > 0) lines.push(`- 写しにコミットされずに残っていた変更（夜の前に別にコミットした）: ${night.uncommitted.join('、')}`);
  if (night.error) lines.push(`- 失敗: ${night.error}`);
  lines.push('', '## 工程', '', '| 工程 | 結果 | 呼び出し | 時間 | 入力 | キャッシュ | 出力 | ツールの失敗 |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const stage of night.stages) {
    lines.push(`| ${stage.name} | ${stage.outcome} | ${stage.modelCalls} | ${seconds(stage.ms)} | ${stage.tokens.input} | ${stage.tokens.cacheRead} | ${stage.tokens.output} | ${stage.toolErrors} |`);
  }
  if (night.stages.length === 0) lines.push('| （なし） | | | | | | | |');
  // What each stage kept, under the note it wrote, or why nothing of it was kept.
  if (night.stages.length > 0) lines.push('');
  for (const stage of night.stages) {
    const kept = stage.commit ? `コミット ${short(stage.commit)}` : `残したものなし（${stage.outcome}）`;
    const note = stage.note ? `・変更の説明「${stage.note.split('\n')[0]}」` : '';
    lines.push(`- ${stage.name}: ${kept}${note}`);
    for (const file of stage.retried ?? []) lines.push(`  - 検査に当たってやり直した: ${file.path}: ${file.reason}`);
    for (const file of stage.rejected ?? []) lines.push(`  - 検査に当たった: ${file.path}: ${file.reason}`);
    if (stage.paths) {
      lines.push(`  - パスの置き換え: ${stage.paths.commit ? `コミット ${short(stage.paths.commit)}` : 'コミットなし'}（${
        stage.paths.moves.map(move => `${move.from} → ${move.to}`).join('、')}）`);
      for (const row of stage.paths.ignored) lines.push(`  - 置き換えなかった対応表の行: ${row.from} → ${row.to}: ${row.reason}`);
    }
  }
  lines.push('', `## コミット（${night.commits.length} 件）`);
  for (const commit of night.commits) lines.push('', `### ${short(commit.hash)}`, '', ...commit.message.split('\n').map(line => `> ${line}`.trimEnd()));
  lines.push('', `## 変わったファイル（${night.files.length} 件）`, '', ...night.files.map(file => `- ${file.change} ${file.path}`));
  if (night.log && night.log.length > 0) lines.push('', '## サーバーのログ', '', ...night.log.map(line => `- ${line}`));
  return `${lines.join('\n')}\n`;
}

/** Two nights side by side, to compare the routes on one snapshot (ADR 0068). */
export function compareNightsMarkdown(a: NightRecord, b: NightRecord): string {
  const stage = (stage: StageRecord | undefined) => stage ? `${stage.outcome} / ${stage.modelCalls} / ${seconds(stage.ms)}` : '—';
  const lines = [`# 係の一晩の比較: ${a.label} と ${b.label}`, ''];
  if (a.snapshot !== b.snapshot) lines.push(`写しが違います（${a.snapshot} と ${b.snapshot}）。同じ記憶からの比較ではありません。`, '');
  lines.push(`| | ${a.label} | ${b.label} |`, '| --- | --- | --- |',
    `| モデル | ${a.model.provider}/${a.model.id} | ${b.model.provider}/${b.model.id} |`,
    `| 写し | ${a.snapshot} | ${b.snapshot} |`,
    `| 全体の時間 | ${seconds(a.ms)} | ${seconds(b.ms)} |`,
    `| コミット | ${a.commits.length} | ${b.commits.length} |`,
    `| 変わったファイル | ${a.files.length} | ${b.files.length} |`,
    `| 失敗 | ${a.error ?? '—'} | ${b.error ?? '—'} |`,
    '', '## 工程（結果 / 呼び出し / 時間）', '', `| 工程 | ${a.label} | ${b.label} |`, '| --- | --- | --- |');
  const names = [...new Set([...a.stages, ...b.stages].map(entry => entry.name))];
  for (const name of names) lines.push(`| ${name} | ${stage(a.stages.find(entry => entry.name === name))} | ${stage(b.stages.find(entry => entry.name === name))} |`);
  const paths = [...new Set([...a.files, ...b.files].map(file => file.path))].sort();
  if (paths.length > 0) {
    lines.push('', '## 変わったファイル', '', `| ファイル | ${a.label} | ${b.label} |`, '| --- | --- | --- |');
    const change = (night: NightRecord, path: string) => night.files.find(file => file.path === path)?.change ?? '—';
    for (const path of paths) lines.push(`| ${path} | ${change(a, path)} | ${change(b, path)} |`);
  }
  return `${lines.join('\n')}\n`;
}
