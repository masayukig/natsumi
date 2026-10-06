import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acceptOldPath, archivePlan, chooseRotation, CURATOR_STAGES, CurationRecord, curatorDeadline, curatorTools, isRewritable,
  type StageInput } from '../src/server/memory-curator.ts';
import { MIGRATIONS } from '../src/server/migrations.ts';
import { CURATOR_MAP_OLD_PATH_DESCRIPTION, CURATOR_RUN_SHELL_DESCRIPTION, CURATOR_WRITE_CHANGE_NOTE_DESCRIPTION, curatorSystemPrompt,
  SEARCH_MEMORY_DESCRIPTION } from '../src/server/prompts.ts';
import { migrate, openStateDatabase } from '../src/server/state-db.ts';

// The memory curator's pieces (ADR 0055): what it is handed, what it may rewrite, and what is kept of its nights.

async function withDb(body: (db: ReturnType<typeof openStateDatabase>, now: { at: number }) => void | Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-curator-')));
  const db = openStateDatabase(join(root, 'state.sqlite'));
  migrate(db, MIGRATIONS);
  const now = { at: Date.parse('2026-09-27T19:00:00.000Z') };
  try { await body(db, now); } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

test('only topic files are rewritten: never her three files, the index, the diary, the archive or what is not Markdown', () => {
  for (const path of ['予定.md', '暮らし/予定.md', 'README.md', '暮らし/README.md']) assert.equal(isRewritable(path), true, path);
  for (const path of ['always.md', 'personality.md', 'handoff.md', 'INDEX.md', 'diary/2026-09-27.md', 'archive/2026-09.md', 'メモ.txt']) {
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

const sections = (...pairs: [string, number][]) => pairs.map(([heading, lines]) => ({ heading, lines }));
const stage = (name: string) => CURATOR_STAGES.find(candidate => candidate.name === name)!;

/** What a stage is given: a fictional memory, dated and curated as a night would find it. */
function input(overrides: Partial<StageInput> = {}): StageInput {
  const many = Array.from({ length: 35 }, (_, i) => [`## 2026-09-${String(i).padStart(2, '0')}: 出来事`, 2] as [string, number]);
  return {
    name: 'なつみ', date: '2026-09-28', timeZone: 'Asia/Tokyo', fileMaxChars: 32000, rotateFiles: 1, rewriteAllMaxChars: 10000,
    files: [
      { path: 'INDEX.md', chars: 50, sections: sections(['# 記憶の索引', 3]) },
      { path: 'always.md', chars: 300, sections: sections(['# 常時記憶', 4]) },
      { path: 'diary/2026-09-26.md', chars: 400, sections: sections(['# 2026-09-26', 5]) },
      { path: 'diary/2026-09-27.md', chars: 500, sections: sections(['# 2026-09-27', 5]) },
      { path: 'handoff.md', chars: 100, sections: [] },
      { path: 'personality.md', chars: 200, sections: [] },
      { path: 'Slack連携.md', chars: 13201, sections: sections(['# Slack連携', 1], ...many) },
      { path: '予定.md', chars: 80, sections: sections(['# 予定', 0], [`## ${'長'.repeat(200)}`, 42]) },
      { path: '本人.md', chars: 60, sections: sections(['', 7]) },
    ],
    lastChanged: new Map([['Slack連携.md', '2026-09-27T21:30:00+09:00'], ['予定.md', '2026-09-20T01:00:00+00:00'], ['本人.md', '2026-09-26T23:30:00Z']]),
    curated: new Map([['Slack連携.md', '2026-09-26T19:00:00.000Z'], ['本人.md', '2026-09-25T00:00:00.000Z']]),
    changed: ['Slack連携.md'],
    since: Date.parse('2026-09-26T19:30:00.000Z'),
    conversation: { lines: ['[09-27 09:00] マスター: 歯医者は金曜の 14 時になった', '[09-27 09:01] なつみが記憶を読んだ: 予定.md'], dropped: 0 },
    ...overrides,
  };
}

test('the night runs in stages, knowledge first, the archiving before the reorganizing and the index last, each with its own instructions', () => {
  assert.deepEqual(CURATOR_STAGES.map(candidate => candidate.name), ['knowledge', 'archive', 'structure', 'index']);
  assert.equal(stage('knowledge').rewrites, true);
  assert.equal(stage('archive').rewrites, true);
  for (const candidate of CURATOR_STAGES) assert.ok(candidate.instructions('なつみ').length > 0, candidate.name);
  assert.equal(new Set(CURATOR_STAGES.map(candidate => candidate.instructions('なつみ'))).size, CURATOR_STAGES.length);
  assert.equal(stage('structure').rewrites, true);
  assert.equal(stage('index').rewrites, false);
});

test('the reorganizing is told to keep a file in sections by topic, split long ones, and lead each with its point', () => {
  const told = stage('structure').instructions('なつみ');
  for (const rule of ['話題ごとに節を立て', '合う節か、合うファイルへ移し', '長い節は ### で分け', '要点から書き']) assert.ok(told.includes(rule), rule);
  assert.match(told, /INDEX\.md は次の工程/);
  assert.match(stage('index').instructions('なつみ'), /INDEX\.md を、今の記憶の構成に合わせて書き直し/);
  // What is thrown away is the stage's, not the night's.
  assert.match(curatorSystemPrompt('なつみ'), /この工程のあなたの変更はすべて捨てられます。前の工程のコミットは残ります。/);
  assert.doesNotMatch(curatorSystemPrompt('なつみ'), /今夜のあなたの変更はすべて/);
});

test('the map of memory shows each file\'s size, when it last changed and was last curated, and its sections\' lengths', () => {
  const { text } = stage('structure').brief(input());
  assert.match(text, /^<curation>\n/);
  assert.match(text, /2026-09-28/);
  assert.match(text, /32000 文字/);
  // Dates are local dates: 21:30 in Tokyo is still the 27th, 23:30 UTC is the 27th in Tokyo.
  assert.match(text, /- Slack連携\.md（13201 文字・最後に変わった日 2026-09-27・最後に整理した日 2026-09-27）\n {2}- # Slack連携（1 行）\n {2}- ## 2026-09-00: 出来事（2 行）/);
  assert.match(text, /- 予定\.md（80 文字・最後に変わった日 2026-09-20・まだ整理していない）/);
  assert.match(text, /- 本人\.md（60 文字・最後に変わった日 2026-09-27・最後に整理した日 2026-09-25）\n {2}- （見出しの前）（7 行）/);
  assert.match(text, /ほか 6 件の節/);
  assert.doesNotMatch(text, /2026-09-34/);
  assert.doesNotMatch(text, /長{100}/, 'a heading is cut short');
  assert.match(text, /長…（42 行）/);
  for (const fixed of ['always.md', 'handoff.md', 'personality.md']) assert.match(text, new RegExp(`- ${fixed}（[^\\n]*変えない`));
  assert.match(text, /- INDEX\.md（50 文字・索引、最後の工程で書き直す）/);
  assert.match(text, /- diary\/: 2 ファイル（diary\/2026-09-26\.md 〜 diary\/2026-09-27\.md・日記、変えない）/);
  assert.doesNotMatch(text, /- # 2026-09-26/, 'the diary is not listed file by file');
  assert.match(text, /<\/curation>$/);
});

test('while the topics are small, every topic may be rewritten; past the size, only what changed and the files in turn', () => {
  const all = stage('structure').brief(input({ rewriteAllMaxChars: 13341 }));
  const allPart = all.text.slice(all.text.indexOf('## 中身を書き直してよいファイル'));
  assert.match(allPart, /トピックの合計は 13341 文字で/);
  assert.match(allPart, /すべてのトピック/);
  assert.deepEqual([...all.handled].sort(), ['Slack連携.md', '予定.md', '本人.md'].sort());

  const some = stage('structure').brief(input({ rewriteAllMaxChars: 13340 }));
  const somePart = some.text.slice(some.text.indexOf('## 中身を書き直してよいファイル'));
  assert.match(somePart, /前回の整理から変わったもの\n- Slack連携\.md/);
  assert.match(somePart, /順番が回ってきたもの\n- 予定\.md/, 'never curated comes first');
  assert.deepEqual(some.handled, ['Slack連携.md', '予定.md']);

  // archive/ is not a topic, and is not counted.
  const archived = stage('structure').brief(input({ rewriteAllMaxChars: 13341, files: [...input().files,
    { path: 'archive/2026-09.md', chars: 5000, sections: [] }] }));
  assert.match(archived.text, /トピックの合計は 13341 文字で/);
  assert.equal(archived.handled.includes('archive/2026-09.md'), false);

  const quiet = stage('structure').brief(input({ rewriteAllMaxChars: 0, changed: [], rotateFiles: 0 }));
  assert.match(quiet.text, /前回の整理から変わったもの\n（なし）/);
});

const ARCHIVED = [
  { path: 'archive/2025-11.md', chars: 300, sections: sections(['# 2025-11', 0], ['## 予定', 3]) },
  { path: 'archive/2026-09.md', chars: 400, sections: sections(['# 2026-09', 0], ['## 暮らし', 4]) },
];

test('the other stages see the archive as one line, and leave it alone', () => {
  for (const name of ['structure', 'index']) {
    const { text } = stage(name).brief(input({ files: [...input().files, ...ARCHIVED] }));
    assert.match(text, /- archive\/: 2 ファイル（[^\n]*古い記憶、この工程では変えない）/, name);
    assert.doesNotMatch(text, /- archive\/2026-09\.md/, name);
  }
});

test('which archive files a night compacts: a quarter three months after it ended, a year once its last quarter is a year old', () => {
  const paths = ['archive/2025-11.md', 'archive/2025-Q3.md', 'archive/2026-06.md', 'archive/2026-07.md', 'archive/2026-08.md',
    'archive/2026-09.md', 'archive/2026-10.md', 'archive/メモ.md', '予定.md'];
  assert.deepEqual(archivePlan(paths, '2026-09-28'), { append: 'archive/2026-09.md', compactions: [
    { into: 'archive/2025-Q4.md', from: ['archive/2025-11.md'] },
    { into: 'archive/2026-Q2.md', from: ['archive/2026-06.md'] },
  ] });
  assert.deepEqual(archivePlan(paths, '2026-10-04').compactions, [
    { into: 'archive/2025.md', from: ['archive/2025-11.md', 'archive/2025-Q3.md'] },
    { into: 'archive/2026-Q2.md', from: ['archive/2026-06.md'] },
  ]);
  assert.deepEqual(archivePlan(paths, '2026-12-01').compactions.find(group => group.into === 'archive/2026-Q3.md'),
    { into: 'archive/2026-Q3.md', from: ['archive/2026-07.md', 'archive/2026-08.md', 'archive/2026-09.md'] });
  // A year whose last quarter is not yet a year old waits, its quarters with it.
  assert.deepEqual(archivePlan(['archive/2025-Q4.md', 'archive/2025-Q3.md'], '2026-09-30').compactions, []);
  assert.deepEqual(archivePlan([], '2026-10-04'), { append: 'archive/2026-10.md', compactions: [] });
});

test('the archiving stage is handed the topics it may rewrite, this month\'s file, and on a night of compacting what to compact', () => {
  const quiet = stage('archive').brief(input({ files: [...input().files, ...ARCHIVED], rewriteAllMaxChars: 100000, date: '2026-10-04' }));
  assert.match(quiet.text, /- Slack連携\.md（13201 文字/);
  assert.match(quiet.text, /- archive\/2026-09\.md（400 文字）/);
  assert.match(quiet.text, /archive\/2026-10\.md/);
  assert.match(quiet.text, /すべてのトピック/);
  assert.deepEqual([...quiet.handled].sort(), ['Slack連携.md', '予定.md', '本人.md'].sort());
  assert.deepEqual(quiet.archive, archivePlan([...input().files, ...ARCHIVED].map(file => file.path), '2026-10-04'));
  assert.match(quiet.text, /## 今夜まとめるもの\n- archive\/2025\.md ← archive\/2025-11\.md/);

  const none = stage('archive').brief(input({ date: '2026-10-04' }));
  assert.doesNotMatch(none.text, /今夜まとめるもの/);
  assert.equal(stage('archive').refuse('予定.md'), undefined);
  assert.match(stage('archive').refuse('INDEX.md') ?? '', /INDEX\.md/);
});

test('the curator judges what is old by reading it, and moves it into the archive rather than deleting it', () => {
  const told = stage('archive').instructions('なつみ');
  for (const rule of ['中身', '時点', '当時のトピック名', '要約', 'write_change_note']) assert.ok(told.includes(rule), rule);
  assert.match(told, /マスターの言葉/);
  // The reorganizing still drops duplicates, and no longer drops what is old.
  const structure = stage('structure').instructions('なつみ');
  assert.match(structure, /重複は消してかまいません/);
  assert.doesNotMatch(structure, /古くなったこと/);
  assert.match(curatorSystemPrompt('なつみ'), /archive\//);
});

test('the archiving stage is handed the day\'s conversation too, as what was used lately (ADR 0068)', () => {
  const { text } = stage('archive').brief(input({ date: '2026-10-04' }));
  assert.match(text, /## 会話の本文\n\[09-27 09:00\] マスター: 歯医者は金曜の 14 時になった\n\[09-27 09:01\] なつみが記憶を読んだ: 予定\.md/);
  assert.match(stage('archive').brief(input({ conversation: { lines: ['[09-27 23:00] マスター: おやすみ'], dropped: 3 } })).text,
    /古い 3 件は、長さの上限で省きました。/);
  assert.match(stage('archive').brief(input({ conversation: { lines: [], dropped: 0 } })).text, /## 会話の本文\n（なし）/);
  // Only the two stages that read the day are handed it.
  for (const name of ['structure', 'index']) assert.doesNotMatch(stage(name).brief(input()).text, /## 会話の本文/, name);
});

test('the archiving keeps what was used or talked about lately, and leans toward keeping it', () => {
  const told = stage('archive').instructions('なつみ');
  assert.match(told, /会話の本文/);
  assert.match(told, /使われた記憶・話題に出た記憶/);
  assert.match(told, /迷ったら移さずに残します/);
  assert.match(stage('archive').instructions('はな'), /マスターとはなのやりとりと、はなが記憶を読んだ・探した記録/);
  assert.doesNotMatch(told, /\$\{/);
});

test('the index stage is handed the map and told what it writes, and rewrites no topic', () => {
  const { text, handled } = stage('index').brief(input());
  assert.match(text, /- Slack連携\.md（13201 文字/);
  assert.doesNotMatch(text, /中身を書き直してよいファイル/);
  assert.match(text, /INDEX\.md/);
  assert.deepEqual(handled, []);
});

test('the knowledge stage is handed the diary and the conversation since the last night that succeeded', () => {
  const { text, handled } = stage('knowledge').brief(input({ files: [...input().files, { path: 'diary/2026-09-25.md', chars: 300, sections: [] }] }));
  assert.match(text, /^<curation>\n/);
  assert.match(text, /- Slack連携\.md（13201 文字/, 'the map of memory comes first');
  // The window began at 04:30 on the 27th in Tokyo: the diary of that day and after, not before.
  assert.match(text, /前回の整理（2026-09-27 04:30）から今夜まで/);
  assert.match(text, /## 日記\n- diary\/2026-09-27\.md\n\n/);
  assert.doesNotMatch(text, /- diary\/2026-09-2[56]\.md/);
  assert.match(text, /## 会話の本文\n\[09-27 09:00\] マスター: 歯医者は金曜の 14 時になった\n\[09-27 09:01\] なつみが記憶を読んだ: 予定\.md/);
  assert.match(text, /<\/curation>$/);
  assert.deepEqual(handled, []);

  const dropped = stage('knowledge').brief(input({ conversation: { lines: ['[09-27 23:00] マスター: おやすみ'], dropped: 12 } })).text;
  assert.match(dropped, /古い 12 件は、長さの上限で省きました。/);
  const quiet = stage('knowledge').brief(input({ conversation: { lines: [], dropped: 0 }, files: input().files.filter(file => !file.path.startsWith('diary/')) })).text;
  assert.match(quiet, /## 日記\n（なし）/);
  assert.match(quiet, /## 会話の本文\n（なし）/);
});

test('the knowledge stage is told to turn what recurs and what is new into topics, and to mend the memory that was used', () => {
  const told = stage('knowledge').instructions('なつみ');
  for (const rule of ['繰り返し', '新しい事実', '使われた記憶', 'search_memory', 'diary/']) assert.ok(told.includes(rule), rule);
  assert.match(told, /INDEX\.md/);
});

test('each stage keeps to its own files: the reorganizing leaves the index alone, the index stage writes only indexes', () => {
  assert.equal(stage('knowledge').refuse('予定.md'), undefined);
  assert.equal(stage('knowledge').refuse('暮らし/予定.md'), undefined);
  assert.match(stage('knowledge').refuse('INDEX.md') ?? '', /INDEX\.md/);
  assert.match(stage('knowledge').refuse('archive/2026-09.md') ?? '', /archive/);
  assert.equal(stage('structure').refuse('予定.md'), undefined);
  assert.equal(stage('structure').refuse('暮らし/README.md'), undefined);
  assert.match(stage('structure').refuse('INDEX.md') ?? '', /INDEX\.md/);
  assert.equal(stage('index').refuse('INDEX.md'), undefined);
  assert.equal(stage('index').refuse('暮らし/README.md'), undefined);
  assert.match(stage('index').refuse('予定.md') ?? '', /予定\.md/);
  assert.match(stage('index').refuse('README.md') ?? '', /README\.md/, 'a README at the top is a topic, not a folder\'s index');
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

test('the curator has run_shell, read, search_memory, its own change note and where merged paths went, and nothing that speaks to anyone', async () => {
  let note: string | undefined;
  const mapped: [string, string][] = [];
  const tools = curatorTools({
    runShell: async () => ({ ok: true, text: 'ran' }),
    capture: async () => ({ ok: true, exitCode: 1, stdout: '', stdoutTruncated: false }),
    writeChangeNote: text => { note = text; return { ok: true, text: 'kept' }; },
    mapOldPath: (from, to) => { mapped.push([from, to]); return { ok: true, text: 'mapped' }; },
  });
  assert.deepEqual(tools.map(tool => tool.name), ['run_shell', 'read', 'search_memory', 'write_change_note', 'map_old_path']);
  assert.equal(tools[0]!.description, CURATOR_RUN_SHELL_DESCRIPTION);
  assert.equal(tools[2]!.description, SEARCH_MEMORY_DESCRIPTION);
  assert.equal(tools[3]!.description, CURATOR_WRITE_CHANGE_NOTE_DESCRIPTION);
  assert.equal(tools[4]!.description, CURATOR_MAP_OLD_PATH_DESCRIPTION);
  await tools[3]!.execute('call-1', { text: '整理した' } as never, undefined, undefined, undefined as never);
  assert.equal(note, '整理した');
  await tools[4]!.execute('call-2', { from: '旅行メモ.md', to: '旅行.md' } as never, undefined, undefined, undefined as never);
  assert.deepEqual(mapped, [['旅行メモ.md', '旅行.md']]);
});

test('the curator is told it may rename and move files, the server puts the old paths right, and how to tell where merged ones went', () => {
  const told = curatorSystemPrompt('なつみ');
  assert.match(told, /ファイルの名前と場所は変えてかまいません/);
  assert.match(told, /always\.md・handoff\.md・personality\.md の中の古いパスと、すべてのファイルのリンクは、この工程の後にサーバーが新しいパスに直します/);
  assert.match(told, /map_old_path/);
  const structure = stage('structure').instructions('なつみ');
  // When to gather files into a directory, and the links and the related section the curator keeps.
  assert.match(structure, /同じ主題のファイルが 3 つ以上/);
  assert.match(structure, /上限の半分を超えた/);
  assert.match(structure, /Markdown のリンク/);
  assert.match(structure, /そのファイルからの相対パス/);
  assert.match(structure, /末尾に「## 関連」の節/);
});

test('map_old_path takes only a Markdown path inside memory, never one of her files, the index, the diary or the archive', () => {
  const merged = new Map<string, string>();
  const accept = (from: string, to: string) => acceptOldPath(merged, from, to);
  assert.equal(accept('/memory/旅行メモ.md', '旅行.md').ok, true);
  assert.deepEqual([...merged], [['旅行メモ.md', '旅行.md']]);
  for (const [from, to] of [['always.md', '旅行.md'], ['旅行メモ.md', 'INDEX.md'], ['diary/2026-10-01.md', '旅行.md'], ['../外.md', '旅行.md'],
    ['旅行メモ.txt', '旅行.md'], ['旅行メモ.md', '旅行メモ.md'], ['archive/2026-09.md', '旅行.md']] as const) {
    assert.equal(accept(from, to).ok, false, `${from} → ${to}`);
  }
  assert.equal(merged.size, 1);
});

test('the morning deadline is the first stopStartingAt after the night\'s switching time, the same morning or the next (ADR 0068)', () => {
  const jst = (iso: string) => Date.parse(`${iso}+09:00`);
  const deadline = (now: string, rotation: string | false, stop: string | false) => curatorDeadline(jst(now), rotation, stop, 'Asia/Tokyo');
  // A night that begins after midnight ends the same morning.
  assert.equal(deadline('2026-10-05T04:10:00', '04:00', '05:30'), jst('2026-10-05T05:30:00'));
  assert.equal(deadline('2026-10-05T02:20:00', '02:00', '05:30'), jst('2026-10-05T05:30:00'));
  // A night that begins before midnight ends the next morning, whether the curator starts before midnight or after.
  assert.equal(deadline('2026-10-04T23:10:00', '23:00', '05:30'), jst('2026-10-05T05:30:00'));
  assert.equal(deadline('2026-10-05T01:00:00', '23:00', '05:30'), jst('2026-10-05T05:30:00'));
  // Across the end of a month and a year.
  assert.equal(deadline('2026-12-31T23:30:00', '23:00', '05:30'), jst('2027-01-01T05:30:00'));
  // A switch made late, at a start after a night natsumi was stopped through, belongs to that night: its deadline has passed.
  assert.equal(deadline('2026-10-05T14:00:00', '02:00', '05:30'), jst('2026-10-05T05:30:00'));
  // Without a deadline, none; without a switching time, the night is counted from now.
  assert.equal(deadline('2026-10-05T02:20:00', '02:00', false), undefined);
  assert.equal(deadline('2026-10-05T14:00:00', false, '05:30'), jst('2026-10-06T05:30:00'));
});
