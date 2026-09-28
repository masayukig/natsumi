import type { DatabaseSync } from 'node:sqlite';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { ToolOutcome } from './loop-tools.ts';
import { DIARY_DIRECTORY, INDEX_FILE, NATSUMI_ONLY_FILES, type MemoryFile } from './memory-repository.ts';
import { isoAt } from './nightly.ts';
import { CURATOR_RUN_SHELL_DESCRIPTION, CURATOR_WRITE_CHANGE_NOTE_DESCRIPTION } from './prompts.ts';
import { workspaceReadTool, type RunnerCapture } from './read-tool.ts';
import { searchMemoryTool } from './search-memory.ts';

/**
 * The memory curator's pieces (ADR 0055): what it is handed each night, the tools it works with, and what is kept of
 * its nights. The night itself — the session, its limits, its commit — is run by the thinking loop, which owns the
 * shell, the repository and the switch the curator runs inside.
 */

/** Where the curator's session records go, under the Pi session directory. */
export const CURATOR_SESSION_DIRECTORY = 'curator';
/** The curator's turn, as `turn_stats` and the machine-made commit message name it. */
export const CURATOR_EVENT_KIND = 'memory_curator';
/** Headings shown per file in the brief; a log of dated sections would otherwise fill it. */
export const BRIEF_HEADINGS_PER_FILE = 30;
/** The longest a heading is shown. */
const BRIEF_HEADING_CHARS = 80;

/** Whether the curator may rewrite a file's content: a topic file, never natsumi's own, the index or the diary. */
export function isRewritable(path: string): boolean {
  return path.endsWith('.md') && !NATSUMI_ONLY_FILES.includes(path) && path !== INDEX_FILE && !inDiary(path);
}

function inDiary(path: string): boolean {
  return path.startsWith(`${DIARY_DIRECTORY}/`);
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

/** What begins the curator's one turn: the map of memory, and the files whose content it may rewrite tonight. */
export function curationBrief(input: { name: string; date: string; fileMaxChars: number; files: readonly MemoryFile[]; changed: readonly string[];
  rotated: readonly string[] }): string {
  const lines = [`今夜は ${input.date} です。1 ファイルの上限は ${input.fileMaxChars} 文字です。`, '',
    `## 記憶のファイル（${input.files.length} 件）`];
  const diary = input.files.filter(file => inDiary(file.path));
  let diaryShown = false;
  for (const file of input.files) {
    if (inDiary(file.path)) {
      if (diaryShown) continue;
      diaryShown = true;
      lines.push(`- ${DIARY_DIRECTORY}/: ${diary.length} ファイル（${diary[0]!.path} 〜 ${diary.at(-1)!.path}・日記、変えない）`);
      continue;
    }
    if (NATSUMI_ONLY_FILES.includes(file.path)) { lines.push(`- ${file.path}（${file.chars} 文字・${input.name}のもの、変えない）`); continue; }
    if (file.path === INDEX_FILE) { lines.push(`- ${file.path}（${file.chars} 文字・あなたが書く索引）`); continue; }
    lines.push(`- ${file.path}（${file.chars} 文字）`);
    for (const heading of file.headings.slice(0, BRIEF_HEADINGS_PER_FILE)) lines.push(`  - ${shorten(heading)}`);
    const more = file.headings.length - BRIEF_HEADINGS_PER_FILE;
    if (more > 0) lines.push(`  - ほか ${more} 件の見出し`);
  }
  const list = (paths: readonly string[]) => paths.length === 0 ? ['（なし）'] : paths.map(path => `- ${path}`);
  lines.push('', '## 中身を書き直してよいファイル', '### 前回の整理から変わったもの', ...list(input.changed),
    '### 順番が回ってきたもの', ...list(input.rotated));
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
