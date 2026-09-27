import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chooseRotation, CurationRecord, curationBrief, curatorTools, isRewritable } from '../src/server/memory-curator.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { CURATOR_RUN_SHELL_DESCRIPTION, CURATOR_WRITE_CHANGE_NOTE_DESCRIPTION, SEARCH_MEMORY_DESCRIPTION } from '../src/server/prompts.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';

// The memory curator's pieces (ADR 0055): what it is handed, what it may rewrite, and what is kept of its nights.

async function withDb(body: (db: ReturnType<typeof openStateDatabase>, now: { at: number }) => void | Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-curator-')));
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const now = { at: Date.parse('2026-09-27T19:00:00.000Z') };
  try { await body(db, now); } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

test('only topic files are rewritten: never her three files, the index, the diary or what is not Markdown', () => {
  for (const path of ['予定.md', '暮らし/予定.md', 'README.md', '暮らし/README.md']) assert.equal(isRewritable(path), true, path);
  for (const path of ['always.md', 'personality.md', 'handoff.md', 'INDEX.md', 'diary/2026-09-27.md', 'メモ.txt']) {
    assert.equal(isRewritable(path), false, path);
  }
});

test('the files in turn are those left longest, never curated first, leaving out the day\'s changes', () => {
  const curated = new Map([['a.md', '2026-09-20T00:00:00.000Z'], ['b.md', '2026-09-25T00:00:00.000Z'], ['c.md', '2026-09-10T00:00:00.000Z']]);
  const files = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'always.md', 'diary/2026-09-01.md'];
  assert.deepEqual(chooseRotation(files, curated, new Set(['d.md']), 2), ['e.md', 'c.md']);
  assert.deepEqual(chooseRotation(files, curated, new Set(), 3), ['d.md', 'e.md', 'c.md']);
  assert.deepEqual(chooseRotation(files, curated, new Set(), 0), []);
  assert.deepEqual(chooseRotation(['always.md'], curated, new Set(), 2), []);
});

test('the brief maps all of memory with sizes and headings, marks what is not to be changed, and names what may be rewritten', () => {
  const headings = Array.from({ length: 35 }, (_, i) => `## 2026-09-${String(i).padStart(2, '0')}: 出来事`);
  const brief = curationBrief({
    date: '2026-09-28', fileMaxChars: 32000,
    files: [
      { path: 'INDEX.md', chars: 50, headings: ['# 記憶の索引'] },
      { path: 'always.md', chars: 300, headings: ['# 常時記憶'] },
      { path: 'diary/2026-09-26.md', chars: 400, headings: ['# 2026-09-26'] },
      { path: 'diary/2026-09-27.md', chars: 500, headings: ['# 2026-09-27'] },
      { path: 'handoff.md', chars: 100, headings: [] },
      { path: 'personality.md', chars: 200, headings: [] },
      { path: 'Slack連携.md', chars: 13201, headings: ['# Slack連携', ...headings] },
      { path: '予定.md', chars: 80, headings: ['# 予定', `## ${'長'.repeat(200)}`] },
    ],
    changed: ['Slack連携.md'], rotated: ['予定.md'],
  });
  assert.match(brief, /^<curation>\n/);
  assert.match(brief, /2026-09-28/);
  assert.match(brief, /32000 文字/);
  assert.match(brief, /- Slack連携\.md（13201 文字）\n {2}- # Slack連携\n {2}- ## 2026-09-00: 出来事/);
  assert.match(brief, /ほか 6 件の見出し/);
  assert.doesNotMatch(brief, /2026-09-34/);
  assert.doesNotMatch(brief, /長{100}/, 'a heading is cut short');
  for (const fixed of ['always.md', 'handoff.md', 'personality.md']) assert.match(brief, new RegExp(`- ${fixed}（[^\\n]*変えない`));
  assert.match(brief, /- INDEX\.md（50 文字・あなたが書く索引）/);
  assert.match(brief, /- diary\/: 2 ファイル（diary\/2026-09-26\.md 〜 diary\/2026-09-27\.md・日記、変えない）/);
  assert.doesNotMatch(brief, /- # 2026-09-26$/m, 'the diary is not listed file by file');
  const rewritable = brief.slice(brief.indexOf('## 中身を書き直してよいファイル'));
  assert.match(rewritable, /前回の整理から変わったもの\n- Slack連携\.md/);
  assert.match(rewritable, /順番が回ってきたもの\n- 予定\.md/);
  assert.match(brief, /<\/curation>$/);

  const quiet = curationBrief({ date: '2026-09-28', fileMaxChars: 32000, files: [], changed: [], rotated: [] });
  assert.match(quiet, /前回の整理から変わったもの\n（なし）/);
});

test('a night that succeeded moves the base and dates the files it had in hand; one cut off is known at the next start', () => withDb((db, now) => {
  const record = new CurationRecord(db, () => now.at);
  assert.equal(record.base(), undefined);
  assert.equal(record.runningSince(), undefined);
  record.begin();
  assert.equal(record.runningSince(), '2026-09-27T19:00:00.000Z');
  record.succeed('commit-1', ['a.md', 'b.md'], ['a.md', 'b.md', 'c.md']);
  assert.equal(record.runningSince(), undefined);
  assert.equal(record.base(), 'commit-1');
  assert.deepEqual([...record.curatedAt()], [['a.md', '2026-09-27T19:00:00.000Z'], ['b.md', '2026-09-27T19:00:00.000Z']]);

  now.at += 86_400_000;
  record.begin();
  record.end();
  assert.equal(record.runningSince(), undefined);
  assert.equal(record.base(), 'commit-1', 'a night that failed leaves the base where it was');
  // A file no longer in memory is forgotten.
  record.begin();
  record.succeed('commit-2', ['c.md'], ['b.md', 'c.md']);
  assert.deepEqual([...record.curatedAt()], [['b.md', '2026-09-27T19:00:00.000Z'], ['c.md', '2026-09-28T19:00:00.000Z']]);
}));

test('the curator has run_shell, read, search_memory and its own change note, and nothing that speaks to anyone', async () => {
  let note: string | undefined;
  const tools = curatorTools({
    runShell: async () => ({ ok: true, text: 'ran' }),
    capture: async () => ({ ok: true, exitCode: 1, stdout: '', stdoutTruncated: false }),
    writeChangeNote: text => { note = text; return { ok: true, text: 'kept' }; },
  });
  assert.deepEqual(tools.map(tool => tool.name), ['run_shell', 'read', 'search_memory', 'write_change_note']);
  assert.equal(tools[0]!.description, CURATOR_RUN_SHELL_DESCRIPTION);
  assert.equal(tools[2]!.description, SEARCH_MEMORY_DESCRIPTION);
  assert.equal(tools[3]!.description, CURATOR_WRITE_CHANGE_NOTE_DESCRIPTION);
  await tools[3]!.execute('call-1', { text: '整理した' } as never, undefined, undefined, undefined as never);
  assert.equal(note, '整理した');
});
