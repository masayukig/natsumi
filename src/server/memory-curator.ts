import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Type } from 'typebox';
import { defineTool, type AgentSession, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { routeReady } from '../pi/auth.ts';
import { createPersistedPiSession, type PiTarget } from '../pi/session.ts';
import { withCodemode, type NestedCallCount } from './codemode.ts';
import type { CuratorConfig } from './config.ts';
import { readConversation, type Conversation } from './curator-conversation.ts';
import type { ToolOutcome } from './loop-tools.ts';
import { ARCHIVE_DIRECTORY, DIARY_DIRECTORY, INDEX_FILE, NATSUMI_ONLY_FILES, type ArchivePlan, type MemoryFile, type MemoryRepository,
  type RevertedFile } from './memory-repository.ts';
import { isoAt, localDate, localDateTime } from './nightly.ts';
import { checkOutgoingText, refusalText } from './output-checks.ts';
import { CURATOR_ARCHIVE_INSTRUCTIONS, CURATOR_INDEX_INSTRUCTIONS, CURATOR_KNOWLEDGE_INSTRUCTIONS, CURATOR_RUN_SHELL_DESCRIPTION,
  CURATOR_STRUCTURE_INSTRUCTIONS, CURATOR_WRITE_CHANGE_NOTE_DESCRIPTION, curatorRetryRequest, curatorSystemPrompt } from './prompts.ts';
import { workspaceReadTool, type RunnerCapture } from './read-tool.ts';
import { searchMemoryTool } from './search-memory.ts';
import { markPlace, placeSince, type PlaceMark } from './session-place.ts';
import type { TokenCounts, TurnPlace } from './turn-stats.ts';

/**
 * The memory curator (ADR 0055): what it is handed, the tools it works with, what is kept of its nights, and the
 * night itself, in stages (ADR 0068). The night is a function of what it is given — the repository, the workspace,
 * the route, the record — so the thinking loop calls it inside its switch, and an evaluation can call it on a copy.
 * Putting natsumi to sleep, holding what arrives, and the switch around it stay the thinking loop's.
 */

/** Where the curator's session records go, under the Pi session directory. */
export const CURATOR_SESSION_DIRECTORY = 'curator';
/** The curator's turns, as `turn_stats` and the machine-made commit message name them, each with its stage after a colon. */
export const CURATOR_EVENT_KIND = 'memory_curator';
/** Without a night that succeeded, the conversation handed over begins this long before tonight: the last day. */
export const CONVERSATION_FALLBACK_MS = 24 * 60 * 60 * 1000;
/** Sections shown per file in the brief; a log of dated sections would otherwise fill it. */
export const BRIEF_SECTIONS_PER_FILE = 30;
/** The longest a heading is shown. */
const BRIEF_HEADING_CHARS = 80;

/**
 * Whether the curator may rewrite a file's content: a topic file, never natsumi's own, the index, the diary or the
 * archive, which is only added to (ADR 0068).
 */
export function isRewritable(path: string): boolean {
  return path.endsWith('.md') && !NATSUMI_ONLY_FILES.includes(path) && path !== INDEX_FILE && !inDiary(path) && !inArchive(path);
}

function inDiary(path: string): boolean {
  return path.startsWith(`${DIARY_DIRECTORY}/`);
}

function inArchive(path: string): boolean {
  return path.startsWith(`${ARCHIVE_DIRECTORY}/`);
}

/**
 * The files handed over in turn: rewritable ones not among `exclude`, those never curated first (by path), then those
 * curated longest ago.
 */
export function chooseRotation(files: readonly string[], curated: ReadonlyMap<string, string>, exclude: ReadonlySet<string>,
  count: number): string[] {
  return files.filter(path => isRewritable(path) && !exclude.has(path))
    .sort((a, b) => (curated.get(a) ?? '').localeCompare(curated.get(b) ?? '') || a.localeCompare(b))
    .slice(0, count);
}

/** A month's archive file, `archive/2026-10.md`; a quarter's, `archive/2026-Q3.md`; a year's, `archive/2025.md`. */
const ARCHIVE_MONTH = /^archive\/(\d{4})-(\d{2})\.md$/;
const ARCHIVE_QUARTER = /^archive\/(\d{4})-Q([1-4])\.md$/;

/**
 * What tonight's archiving may do (ADR 0068), from the files memory holds and tonight's local date: add to this
 * month's file, and compact the older ones, the coarser the older. A quarter's months become its file once three
 * months have passed since the quarter's last month; a year's months and quarters become its file once a year has
 * passed since its last quarter. Each is a whole group at once, so a night that fails leaves the group for the next.
 */
export function archivePlan(paths: readonly string[], date: string): ArchivePlan {
  const [year, month] = date.split('-').map(Number) as [number, number];
  const tonightMonth = year * 12 + month - 1;
  const tonightQuarter = year * 4 + Math.floor((month - 1) / 3);
  const yearDone = (of: number) => tonightQuarter - (of * 4 + 3) >= 4;
  const groups = new Map<string, string[]>();
  const add = (into: string, path: string) => groups.set(into, [...(groups.get(into) ?? []), path]);
  for (const path of paths) {
    const asMonth = ARCHIVE_MONTH.exec(path);
    const matched = asMonth ?? ARCHIVE_QUARTER.exec(path);
    if (!matched) continue;
    const of = Number(matched[1]);
    if (yearDone(of)) { add(`${ARCHIVE_DIRECTORY}/${of}.md`, path); continue; }
    if (!asMonth) continue;
    const quarter = Math.floor((Number(asMonth[2]) - 1) / 3);
    if (tonightMonth - (of * 12 + quarter * 3 + 2) >= 3) add(`${ARCHIVE_DIRECTORY}/${of}-Q${quarter + 1}.md`, path);
  }
  return {
    append: `${ARCHIVE_DIRECTORY}/${date.slice(0, 7)}.md`,
    compactions: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([into, from]) => ({ into, from: from.sort() })),
  };
}

/** What a stage is given to make its brief from, read at the moment it begins. */
export interface StageInput {
  name: string;
  /** Tonight's local date. */
  date: string;
  timeZone: string;
  fileMaxChars: number;
  rotateFiles: number;
  rewriteAllMaxChars: number;
  files: readonly MemoryFile[];
  /** When each file last changed, as git's ISO time. */
  lastChanged: ReadonlyMap<string, string>;
  /** When each file was last in the curator's hands (`CurationRecord.curatedAt`). */
  curated: ReadonlyMap<string, string>;
  /** The rewritable files changed since the last night the reorganizing succeeded. */
  changed: readonly string[];
  /** When that night ended (its last commit), or a day before tonight without one: where the day's diary and conversation begin. */
  since: number;
  /** The conversation since then (ADR 0068), read once for the night. */
  conversation: Conversation;
}

/**
 * What begins a stage's turn, the files whose content it was given to rewrite, dated when the night succeeds, and for
 * the archiving stage, what it may do in `archive/`.
 */
export interface StageBrief { text: string; handled: string[]; archive?: ArchivePlan }

/**
 * A stage of the night (ADR 0068). Each is a new session with the shared instructions and its own, a brief of its own,
 * and a check of its own on top of every curator commit's; adding a stage is adding a row here.
 */
export interface CuratorStage {
  /** As the log, `turn_stats` and the machine-made commit message name it. */
  name: string;
  /** What it is told after what every stage is told. */
  instructions: (name: string) => string;
  brief: (input: StageInput) => StageBrief;
  /** Why this stage may not change a path (changed, added or removed), or undefined when it may. */
  refuse: (path: string) => string | undefined;
  /** Whether it rewrites topics: the night's base moves, and the files are dated, only when every such stage succeeded. */
  rewrites: boolean;
}

/** Why a stage before the index's may not change it. */
const indexLater = (path: string) => path === INDEX_FILE ? `${path} は最後の工程で書き直すので、この工程では変えられません` : undefined;

/**
 * From what happened to what is known (ADR 0068), first: the diary and the conversation since the last night that
 * succeeded, written into topics before the stages after it archive and reorganize them. Any topic may be written;
 * the index and the archive are the later stages'.
 */
export const KNOWLEDGE_STAGE: CuratorStage = {
  name: 'knowledge',
  instructions: name => CURATOR_KNOWLEDGE_INSTRUCTIONS(name),
  brief: input => {
    const from = localDate(input.since, input.timeZone);
    const diary = input.files.filter(file => inDiary(file.path) && file.path.slice(DIARY_DIRECTORY.length + 1) >= from).map(file => `- ${file.path}`);
    return { text: wrap([...memoryMap(input), '', `前回の整理（${localDateTime(input.since, input.timeZone)}）から今夜までの日記と会話です。`, '',
      '## 日記', ...(diary.length === 0 ? ['（なし）'] : diary), '', ...conversationLines(input)]), handled: [] };
  },
  refuse: path => indexLater(path) ?? (inArchive(path) ? `${path} は ${ARCHIVE_DIRECTORY}/ の中なので、この工程では変えられません` : undefined),
  rewrites: true,
};

/** The day's conversation as a brief shows it, under its own heading. */
function conversationLines(input: StageInput): string[] {
  const { lines, dropped } = input.conversation;
  return ['## 会話の本文', ...(dropped > 0 ? [`古い ${dropped} 件は、長さの上限で省きました。`] : []), ...(lines.length === 0 ? ['（なし）'] : lines)];
}

/**
 * The archiving (ADR 0068): old facts out of the topics it may rewrite, summarized into this month's file, and on a
 * night that compacts, older files summarized into coarser ones. It comes before the reorganizing, so that what is
 * reorganized is what is still current.
 */
export const ARCHIVE_STAGE: CuratorStage = {
  name: 'archive',
  instructions: () => CURATOR_ARCHIVE_INSTRUCTIONS,
  brief: input => {
    const scope = rewriteScope(input);
    const plan = archivePlan(input.files.map(file => file.path), input.date);
    const compacting = plan.compactions.length === 0 ? []
      : ['', '## 今夜まとめるもの', ...plan.compactions.map(group => `- ${group.into} ← ${group.from.join('、')}`)];
    return {
      text: wrap([...memoryMap(input, true), '', ...scopeLines(input, scope), '', '## 古い記憶の置き場',
        `今夜の古い記憶は ${plan.append} の末尾に足します（まだ無ければ作ります）。`, ...compacting]),
      handled: scope.handled, archive: plan,
    };
  },
  refuse: indexLater,
  rewrites: true,
};

/** The reorganizing: the files, and the sections inside them. Everything but the index, which is the last stage's. */
export const STRUCTURE_STAGE: CuratorStage = {
  name: 'structure',
  instructions: () => CURATOR_STRUCTURE_INSTRUCTIONS,
  brief: input => {
    const scope = rewriteScope(input);
    return { text: wrap([...memoryMap(input), '', ...scopeLines(input, scope)]), handled: scope.handled };
  },
  refuse: indexLater,
  rewrites: true,
};

/** The index, last: written against memory as the stages before left it. */
export const INDEX_STAGE: CuratorStage = {
  name: 'index',
  instructions: () => CURATOR_INDEX_INSTRUCTIONS,
  brief: input => ({ text: wrap([...memoryMap(input), '', '## この工程で書くもの',
    `${INDEX_FILE} と、ディレクトリの中の README.md だけです。`]), handled: [] }),
  refuse: path => path === INDEX_FILE || (path.includes('/') && path.endsWith('/README.md')) ? undefined
    : `${path} は索引ではないので、索引の工程では変えられません`,
  rewrites: false,
};

/** The night's stages, in order. */
export const CURATOR_STAGES: readonly CuratorStage[] = [KNOWLEDGE_STAGE, ARCHIVE_STAGE, STRUCTURE_STAGE, INDEX_STAGE];

/**
 * What may be rewritten tonight (ADR 0068): every topic while the topics together are no bigger than the setting,
 * otherwise those changed and those in turn (ADR 0055).
 */
function rewriteScope(input: StageInput): { all: boolean; topicChars: number; rotated: string[]; handled: string[] } {
  const topics = input.files.filter(file => isRewritable(file.path));
  const topicChars = topics.reduce((sum, file) => sum + file.chars, 0);
  if (topicChars <= input.rewriteAllMaxChars) return { all: true, topicChars, rotated: [], handled: topics.map(file => file.path) };
  const rotated = chooseRotation(input.files.map(file => file.path), input.curated, new Set(input.changed), input.rotateFiles);
  return { all: false, topicChars, rotated, handled: [...input.changed, ...rotated] };
}

/** The part of a brief that names what may be rewritten tonight. */
function scopeLines(input: StageInput, scope: ReturnType<typeof rewriteScope>): string[] {
  const list = (paths: readonly string[]) => paths.length === 0 ? ['（なし）'] : paths.map(path => `- ${path}`);
  return scope.all
    ? ['## 中身を書き直してよいファイル',
      `トピックの合計は ${scope.topicChars} 文字で、${input.rewriteAllMaxChars} 文字以下なので、今夜はすべてのトピックを書き直してかまいません。`]
    : ['## 中身を書き直してよいファイル', '### 前回の整理から変わったもの', ...list(input.changed), '### 順番が回ってきたもの', ...list(scope.rotated)];
}

/**
 * The map of memory every stage starts from: each file with its size, its dates and its sections' lengths. The diary
 * is one line, and so is the archive, unless the stage is the one that writes it.
 */
function memoryMap(input: StageInput, archiving = false): string[] {
  const lines = [`今夜は ${input.date} です。1 ファイルの上限は ${input.fileMaxChars} 文字です。`, '',
    `## 記憶のファイル（${input.files.length} 件）`];
  const day = (iso: string) => localDate(Date.parse(iso), input.timeZone);
  const diary = input.files.filter(file => inDiary(file.path));
  const archive = input.files.filter(file => inArchive(file.path));
  let diaryShown = false;
  let archiveShown = false;
  for (const file of input.files) {
    if (inArchive(file.path)) {
      if (archiving) { lines.push(`- ${file.path}（${file.chars} 文字）`); continue; }
      if (archiveShown) continue;
      archiveShown = true;
      lines.push(`- ${ARCHIVE_DIRECTORY}/: ${archive.length} ファイル（${archive[0]!.path} 〜 ${archive.at(-1)!.path}・古い記憶、この工程では変えない）`);
      continue;
    }
    if (inDiary(file.path)) {
      if (diaryShown) continue;
      diaryShown = true;
      lines.push(`- ${DIARY_DIRECTORY}/: ${diary.length} ファイル（${diary[0]!.path} 〜 ${diary.at(-1)!.path}・日記、変えない）`);
      continue;
    }
    if (NATSUMI_ONLY_FILES.includes(file.path)) { lines.push(`- ${file.path}（${file.chars} 文字・${input.name}のもの、変えない）`); continue; }
    if (file.path === INDEX_FILE) { lines.push(`- ${file.path}（${file.chars} 文字・索引、最後の工程で書き直す）`); continue; }
    const changed = input.lastChanged.get(file.path);
    const curated = input.curated.get(file.path);
    lines.push(`- ${file.path}（${[`${file.chars} 文字`, ...(changed ? [`最後に変わった日 ${day(changed)}`] : []),
      curated ? `最後に整理した日 ${day(curated)}` : 'まだ整理していない'].join('・')}）`);
    for (const section of file.sections.slice(0, BRIEF_SECTIONS_PER_FILE)) {
      lines.push(`  - ${section.heading === '' ? '（見出しの前）' : shorten(section.heading)}（${section.lines} 行）`);
    }
    const more = file.sections.length - BRIEF_SECTIONS_PER_FILE;
    if (more > 0) lines.push(`  - ほか ${more} 件の節`);
  }
  return lines;
}

function wrap(lines: readonly string[]): string {
  return `<curation>\n${lines.join('\n')}\n</curation>`;
}

function shorten(heading: string): string {
  const characters = [...heading];
  return characters.length > BRIEF_HEADING_CHARS ? `${characters.slice(0, BRIEF_HEADING_CHARS - 1).join('')}…` : heading;
}

/** What the curator's tools act on. */
export interface CuratorToolHost {
  runShell(command: string): Promise<ToolOutcome>;
  capture: RunnerCapture;
  writeChangeNote(text: string): ToolOutcome;
}

/** The curator's tools: the workspace, reading and searching memory, and its own change note. Nothing that speaks. */
export function curatorTools(host: CuratorToolHost) {
  const result = (settled: ToolOutcome) => {
    if (!settled.ok) throw new Error(settled.text);
    return { content: [{ type: 'text' as const, text: settled.text }], details: {} };
  };
  return [
    defineTool({
      name: 'run_shell', label: 'Work in the workspace', description: CURATOR_RUN_SHELL_DESCRIPTION,
      parameters: Type.Object({ command: Type.String() }),
      execute: async (_id, params) => result(await host.runShell(params.command)),
    }),
    workspaceReadTool(host.capture),
    searchMemoryTool(host.capture),
    defineTool({
      name: 'write_change_note', label: 'Write the change note', description: CURATOR_WRITE_CHANGE_NOTE_DESCRIPTION,
      parameters: Type.Object({ text: Type.String() }),
      execute: async (_id, params) => result(host.writeChangeNote(params.text)),
    }),
  ];
}

/**
 * What is kept of the curator's nights (schema 22): the commit its last success ended at, which the day's changes are
 * counted from, when each file was last in its hands, and whether a run is under way — a start that finds one knows it
 * was cut off, and throws away what it left.
 */
export class CurationRecord {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number) { this.db = db; this.now = now; }

  base(): string | undefined {
    return (this.db.prepare('SELECT base_commit FROM memory_curator WHERE owner = 1').get() as { base_commit: string | null } | undefined)
      ?.base_commit ?? undefined;
  }

  runningSince(): string | undefined {
    return (this.db.prepare('SELECT running_since FROM memory_curator WHERE owner = 1').get() as { running_since: string | null } | undefined)
      ?.running_since ?? undefined;
  }

  begin(): void {
    this.db.prepare(`INSERT INTO memory_curator (owner, running_since) VALUES (1, ?)
      ON CONFLICT (owner) DO UPDATE SET running_since = excluded.running_since`).run(isoAt(this.now()));
  }

  end(): void {
    this.db.prepare('UPDATE memory_curator SET running_since = NULL WHERE owner = 1').run();
  }

  /** A night that succeeded: the new base, the files it had in hand dated now, and the files no longer in memory forgotten. */
  succeed(base: string, handled: readonly string[], existing: readonly string[]): void {
    const at = isoAt(this.now());
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO memory_curator (owner, base_commit, running_since) VALUES (1, ?, NULL)
        ON CONFLICT (owner) DO UPDATE SET base_commit = excluded.base_commit, running_since = NULL`).run(base);
      const upsert = this.db.prepare(`INSERT INTO memory_curation (path, curated_at) VALUES (?, ?)
        ON CONFLICT (path) DO UPDATE SET curated_at = excluded.curated_at`);
      for (const path of new Set(handled)) upsert.run(path, at);
      const keep = new Set(existing);
      const remove = this.db.prepare('DELETE FROM memory_curation WHERE path = ?');
      for (const path of this.curatedAt().keys()) if (!keep.has(path)) remove.run(path);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Each file's last night in the curator's hands, in path order. */
  curatedAt(): Map<string, string> {
    const rows = this.db.prepare('SELECT path, curated_at FROM memory_curation ORDER BY path').all() as { path: string; curated_at: string }[];
    return new Map(rows.map(row => [row.path, row.curated_at]));
  }
}

/** The route a night runs on (the thinking loop's `LoopRoute` fits). */
export interface CuratorRoute { name: string; target: PiTarget; compatible: boolean }

/** What the curator's night is run with (ADR 0068). */
export interface CuratorNightOptions {
  /** Memory: its files, its checks and its commits. */
  repository: MemoryRepository;
  /** The workspace runner the curator's tools go through. */
  shell: { run(command: string): Promise<ToolOutcome>; capture: RunnerCapture };
  modelRuntime: ModelRuntime;
  route: CuratorRoute;
  config: CuratorConfig;
  record: CurationRecord;
  now: () => number;
  log: (line: string) => void;
  /** natsumi's display name. */
  name: string;
  timeZone: string;
  /** `loop.memoryFileMaxChars`. */
  fileMaxChars: number;
  /** The Pi session's working directory, agent directory, and session directory (records go under `curator/`). */
  dataDirectory: string;
  agentDirectory: string;
  sessionDirectory: string;
  thinking: 'medium' | 'off';
  /** Called on each stage's session once it is made, before its turn: where a test puts its model. */
  configureSession?: (session: AgentSession) => void;
  /** Aborted to stop: the stage in progress is cut off and keeps nothing, and no further stage begins. */
  signal?: AbortSignal;
  /** A stage's session was made and its turn begins: where its record begins, for a turn in progress to be shown. */
  onStageBegin?: (begun: { stage: string; eventKinds: string; turnId: string; startedAt: number; mark: PlaceMark | undefined }) => void;
  /** A stage ended, kept or not. */
  onStageEnd?: (result: CuratorStageResult) => void;
}

/** How a stage went, and what it cost. */
export interface CuratorStageResult {
  stage: string;
  /** `memory_curator:<stage>`. */
  eventKinds: string;
  turnId: string;
  outcome: 'ok' | 'memory-not-clean' | 'route-unavailable' | 'model-call-limit' | 'timeout' | 'stopped' | 'model-error' | 'rejected' | 'failed';
  /** The stage's commit, when it kept something. */
  commit?: string;
  /** The change note it wrote, kept or not. */
  note?: string;
  /** The paths its commit carries. */
  files: string[];
  /** What failed the check, when it was rejected. */
  rejected: RevertedFile[];
  /** What failed the check the first time, when the stage was told it and given its one retry (ADR 0068). */
  retried: RevertedFile[];
  startedAt: number;
  endedAt: number;
  calls: number;
  usage: TokenCounts;
  contextTokens: number | null;
  toolErrors: number;
  place?: TurnPlace;
}

export interface CuratorNightResult { stages: CuratorStageResult[] }

/**
 * The curator's night (ADR 0068): the stages in order, each a session of its own with one turn under the whole of the
 * limits, checked and committed on its own. A stage that fails throws away its own changes only; the next stage
 * still runs on what the earlier ones committed. Each stage begins only on a clean tree, and is marked as running
 * while it runs, so a start after a crash throws away what it left (`recoverCuratorRun`). The night's base moves, and
 * the files handed over are dated, when every stage that rewrites topics succeeded. Never throws.
 */
export async function runCuratorNight(options: CuratorNightOptions): Promise<CuratorNightResult> {
  const stages: CuratorStageResult[] = [];
  const handled: string[] = [];
  let rewritten = true;
  const day = await dayOf(options);
  for (const stage of CURATOR_STAGES) {
    if (options.signal?.aborted) break;
    const result = await runStage(options, stage, handled, day);
    stages.push(result);
    if (stage.rewrites && result.outcome !== 'ok') rewritten = false;
    options.log(result.outcome === 'ok' ? `memory curator: ${stage.name}: done` : `memory curator: ${stage.name}: nothing was kept (${result.outcome})`);
    options.onStageEnd?.(result);
    if (result.outcome === 'stopped') break;
  }
  const finished = stages.length === CURATOR_STAGES.length;
  if (finished && rewritten) {
    try {
      const present = (await options.repository.listFiles()).map(file => file.path);
      const kept = new Set(present);
      options.record.succeed(await options.repository.head(), handled.filter(path => kept.has(path) && isRewritable(path)), present);
    } catch {
      options.log('memory curator: the night could not be recorded');
    }
  }
  return { stages };
}

/** The day the night looks back on: from the end of the last night that succeeded to now, and what was said in it. */
async function dayOf(options: CuratorNightOptions): Promise<Pick<StageInput, 'since' | 'conversation'>> {
  const until = options.now();
  let since = until - CONVERSATION_FALLBACK_MS;
  try { since = (await options.repository.commitTime(options.record.base())) ?? since; } catch { /* the last day */ }
  if (options.config.conversationMaxChars === 0) return { since, conversation: { lines: [], dropped: 0 } };
  try {
    return { since, conversation: await readConversation({ sessionDirectory: options.sessionDirectory, since, until, timeZone: options.timeZone,
      name: options.name, maxChars: options.config.conversationMaxChars }) };
  } catch {
    options.log('memory curator: the day\'s conversation could not be read');
    return { since, conversation: { lines: [], dropped: 0 } };
  }
}

/**
 * A stage a stop or a crash cut off leaves its changes uncommitted: they are thrown away before anything else reads
 * memory (ADR 0055). A stage commits nothing before its end, and runs only on a clean tree, so what is thrown away is
 * its own and nothing else; the stages before it keep their commits.
 */
export async function recoverCuratorRun(repository: MemoryRepository, record: CurationRecord, log: (line: string) => void): Promise<void> {
  let running: string | undefined;
  try { running = record.runningSince(); } catch { return; }
  if (!running) return;
  try {
    await repository.discardChanges();
    record.end();
    log('memory curator: a run was cut off by a stop; its changes were thrown away');
  } catch {
    log('memory curator: the changes of a run cut off by a stop could not be thrown away');
  }
}

/** One stage: never throws, and leaves the tree as the last commit whatever becomes of it. */
async function runStage(options: CuratorNightOptions, stage: CuratorStage, handled: string[],
  day: Pick<StageInput, 'since' | 'conversation'>): Promise<CuratorStageResult> {
  const startedAt = options.now();
  const base = { stage: stage.name, eventKinds: `${CURATOR_EVENT_KIND}:${stage.name}`, turnId: `turn-${randomUUID()}`, startedAt,
    files: [] as string[], rejected: [] as RevertedFile[], retried: [] as RevertedFile[], calls: 0, usage: { input: 0, cacheRead: 0, output: 0 }, contextTokens: null, toolErrors: 0 };
  const ended = (fields: Partial<CuratorStageResult> & Pick<CuratorStageResult, 'outcome'>): CuratorStageResult =>
    ({ ...base, ...fields, endedAt: options.now() });
  try {
    return await turn(options, stage, base, ended, handled, day);
  } catch {
    options.log(`memory curator: ${stage.name}: the run failed`);
    try { await options.repository.discardChanges(); options.record.end(); } catch { /* the next start throws it away */ }
    return ended({ outcome: 'failed' });
  }
}

async function turn(options: CuratorNightOptions, stage: CuratorStage, base: Pick<CuratorStageResult, 'eventKinds' | 'turnId' | 'startedAt'>,
  ended: (fields: Partial<CuratorStageResult> & Pick<CuratorStageResult, 'outcome'>) => CuratorStageResult, handled: string[],
  day: Pick<StageInput, 'since' | 'conversation'>): Promise<CuratorStageResult> {
  const { repository, config, route, record } = options;
  // Everything a stage changes is thrown away on a failure, so it starts only where that throws away nothing else.
  if (!(await repository.isClean())) return ended({ outcome: 'memory-not-clean' });
  let ready = false;
  try { ready = Boolean(options.modelRuntime.getModel(route.target.provider, route.target.model)) && await routeReady(options.modelRuntime, route.target, route.compatible); }
  catch { ready = false; }
  if (!ready) return ended({ outcome: 'route-unavailable' });

  const files = await repository.listFiles();
  const paths = files.map(file => file.path);
  const brief = stage.brief({
    name: options.name, date: localDate(options.now(), options.timeZone), timeZone: options.timeZone, fileMaxChars: options.fileMaxChars,
    rotateFiles: config.rotateFiles, rewriteAllMaxChars: config.rewriteAllMaxChars, files,
    lastChanged: await repository.lastChanged(paths.filter(path => !inDiary(path))), curated: record.curatedAt(),
    changed: (await repository.changedSince(record.base())).filter(isRewritable), ...day,
  });

  let note: string | undefined;
  const count: NestedCallCount = { nestedCalls: 0 };
  const { tools, extensions } = withCodemode(curatorTools({
    runShell: command => options.shell.run(command),
    capture: command => options.shell.capture(command),
    writeChangeNote: text => {
      const check = checkOutgoingText(text);
      if (!check.ok) return { ok: false, text: refusalText(check).replace('送信していません', '書いていません') };
      note = text;
      return { ok: true, text: 'この工程のコミットメッセージにします。書き直すなら、もう一度呼んでください。' };
    },
  }), config.codemode, () => count);
  record.begin();
  const session = await createPersistedPiSession({
    cwd: options.dataDirectory, agentDir: options.agentDirectory, sessionDir: join(options.sessionDirectory, CURATOR_SESSION_DIRECTORY),
    modelRuntime: options.modelRuntime, target: route.target,
    systemPrompt: `${curatorSystemPrompt(options.name)}\n\n${stage.instructions(options.name)}`, thinkingLevel: options.thinking,
    tools, extensions,
  });
  options.configureSession?.(session);
  const mark = await markPlace(session);
  options.onStageBegin?.({ stage: stage.name, eventKinds: base.eventKinds, turnId: base.turnId, startedAt: base.startedAt, mark });
  let calls = 0;
  let limited = false;
  let timedOut = false;
  const finish = session.agent.finishTurn;
  session.agent.finishTurn = async (finished, signal) => {
    const decision = await finish?.(finished, signal) ?? undefined;
    if (finished.message.stopReason === 'error' || finished.message.stopReason === 'aborted') return decision;
    calls += 1;
    if (finished.message.stopReason === 'toolUse' && calls >= config.modelCalls) { limited = true; return { action: 'end' }; }
    return decision;
  };
  const stop = () => { void session.abort(); };
  options.signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => { timedOut = true; void session.abort(); }, config.timeoutMinutes * 60_000);
  const replies = () => session.messages.filter(message => message.role === 'assistant') as unknown as Reply[];
  const cutOff = () => limited ? 'model-call-limit' : timedOut ? 'timeout' : options.signal?.aborted ? 'stopped'
    : replies().at(-1)?.stopReason !== 'stop' ? 'model-error' : undefined;
  const prompt = async (text: string) => {
    try { await session.prompt(text, { expandPromptTemplates: false }); } catch { /* Judged from what Pi recorded. */ }
  };
  const checks = { refuse: stage.refuse, ...(brief.archive ? { archive: brief.archive } : {}) };
  let retried: RevertedFile[] = [];
  try {
    if (!options.signal?.aborted) await prompt(brief.text);
    // What failed the check is told once, in the same session and under the same limits, before it is thrown away.
    if (!cutOff()) {
      const caught = await repository.checkCuration(checks);
      if (caught.length > 0 && calls < config.modelCalls) {
        retried = caught;
        for (const file of caught) options.log(`memory curator: ${stage.name}: ${file.path}: ${file.reason} (told to put it right)`);
        await prompt(curatorRetryRequest(caught));
      }
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop);
  }
  const all = replies();
  const toolErrors = session.messages.filter(message => message.role === 'toolResult' && message.isError).length;
  const first = all[0]?.usage;
  const place = await placeSince(session, mark, options.sessionDirectory);
  session.dispose();
  const counted = { calls, usage: sumUsage(all), contextTokens: first ? first.input + first.cacheRead + first.cacheWrite : null,
    toolErrors, retried, ...(place ? { place } : {}), ...(note === undefined ? {} : { note }) };
  const failure = cutOff();
  if (failure) {
    await repository.discardChanges();
    record.end();
    return ended({ outcome: failure, ...counted });
  }
  const outcome = await repository.commitCuration({ ...(note ? { message: note } : {}), event: base.eventKinds, ...checks });
  if (outcome.rejected.length > 0) {
    for (const file of outcome.rejected) options.log(`memory curator: ${stage.name}: ${file.path}: ${file.reason}`);
    record.end();
    return ended({ outcome: 'rejected', ...counted, rejected: outcome.rejected });
  }
  record.end();
  handled.push(...brief.handled, ...(stage.rewrites ? outcome.files : []));
  return ended({ outcome: 'ok', ...counted, files: outcome.files, ...(outcome.committed ? { commit: await repository.head() } : {}) });
}

type Reply = { stopReason?: string; usage: { input: number; cacheRead: number; cacheWrite: number; output: number } };

function sumUsage(replies: Reply[]): TokenCounts {
  return replies.reduce((sum, { usage }) => ({ input: sum.input + (usage?.input ?? 0), cacheRead: sum.cacheRead + (usage?.cacheRead ?? 0),
    output: sum.output + (usage?.output ?? 0) }), { input: 0, cacheRead: 0, output: 0 });
}
