import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { MemoryRepository } from '../src/server/memory-repository.ts';
import { memoryPath, rewriteBarePaths, rewriteLinks, rewriteMovedPaths } from '../src/server/memory-paths.ts';

// The server puts right the paths a curator stage moved (ADR 0068): in natsumi's own files and the index, every
// mention of a path; everywhere, the targets of Markdown links. Fictional memories only.

const moves = (...pairs: [string, string][]) => new Map(pairs);

test('a path is read from memory\'s root, with or without /memory/, and nothing outside memory is one', () => {
  assert.equal(memoryPath('予定.md'), '予定.md');
  assert.equal(memoryPath('/memory/life/予定.md'), 'life/予定.md');
  assert.equal(memoryPath('./life/../予定.md'), '予定.md');
  assert.equal(memoryPath('../予定.md'), undefined);
  assert.equal(memoryPath('/etc/passwd'), undefined);
  assert.equal(memoryPath(''), undefined);
});

test('a link to a moved file is pointed at where it went, from where the linking file is', () => {
  const text = '- [予定](予定.md) と [旅行](旅/旅行.md#持ち物)\n- [外](https://example.com/予定.md) と [ここ](#節) と [そのまま](本人.md)\n';
  const exists = new Set(['life/予定.md', 'life/旅行.md', '本人.md', 'people/家族.md']);
  assert.equal(rewriteLinks(text, { file: '本人.md', oldFile: '本人.md', moves: moves(['予定.md', 'life/予定.md'], ['旅/旅行.md', 'life/旅行.md']),
    exists: path => exists.has(path) }),
  '- [予定](life/予定.md) と [旅行](life/旅行.md#持ち物)\n- [外](https://example.com/予定.md) と [ここ](#節) と [そのまま](本人.md)\n');
  // From a file in a directory, the new target is relative to it.
  assert.equal(rewriteLinks('[予定](../予定.md)', { file: 'people/家族.md', oldFile: 'people/家族.md', moves: moves(['予定.md', 'life/予定.md']),
    exists: path => exists.has(path) }), '[予定](../life/予定.md)');
});

test('a moved file\'s own links follow it, and a link that already works is left alone', () => {
  const exists = new Set(['life/予定.md', '本人.md']);
  assert.equal(rewriteLinks('[本人](本人.md) と [直してある](../本人.md) と [無い](無い.md)',
    { file: 'life/予定.md', oldFile: '予定.md', moves: moves(['予定.md', 'life/予定.md']), exists: path => exists.has(path) }),
  '[本人](../本人.md) と [直してある](../本人.md) と [無い](無い.md)');
});

test('a link keeps its form: percent-encoded, in angle brackets, under /memory/, with a title, or an image', () => {
  const exists = new Set(['life/予定.md', '旅/記録.md']);
  const context = { file: 'a.md', oldFile: 'a.md', moves: moves(['予定.md', 'life/予定.md'], ['旅 の 記録.md', '旅/記録.md']), exists: (path: string) => exists.has(path) };
  assert.equal(rewriteLinks('[予定](%E4%BA%88%E5%AE%9A.md)', context), '[予定](life/%E4%BA%88%E5%AE%9A.md)');
  assert.equal(rewriteLinks('[記録](<旅 の 記録.md>)', context), '[記録](<旅/記録.md>)');
  assert.equal(rewriteLinks('[予定](/memory/予定.md)', context), '[予定](/memory/life/予定.md)');
  assert.equal(rewriteLinks('[予定](予定.md "近い予定")', context), '[予定](life/予定.md "近い予定")');
  assert.equal(rewriteLinks('![図](予定.md)', context), '![図](life/予定.md)');
  assert.equal(rewriteLinks('[外](../予定.md)', context), '[外](../予定.md)');
});

test('in natsumi\'s files a path is put right wherever it is written, but never inside a longer path', () => {
  const known = ['予定.md', '本人.md', '家族/本人.md', '旅/旅行.md'];
  const map = moves(['予定.md', 'life/予定.md'], ['本人.md', 'people/本人.md'], ['旅/旅行.md', 'life/旅行.md']);
  assert.equal(rewriteBarePaths('- 予定は 予定.md に書く。/memory/本人.md も見る。家族/本人.md は別。予定.mdx は違う。`旅/旅行.md`\n- メモは予定.mdに\n', map, known),
    '- 予定は life/予定.md に書く。/memory/people/本人.md も見る。家族/本人.md は別。予定.mdx は違う。`life/旅行.md`\n- メモはlife/予定.mdに\n');
  assert.equal(rewriteBarePaths('old/予定.md と x予定.md', map, known), 'old/予定.md と x予定.md');
});

async function setup(options: { alwaysMaxChars?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-memory-paths-')));
  const data = join(root, 'data');
  const directory = join(data, 'memory');
  await mkdir(directory, { recursive: true });
  const repository = new MemoryRepository({ directory, dataDirectory: data, ...options });
  const git = (...args: string[]) => execFileSync('git', ['-C', directory, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8' }).trim();
  const write = async (name: string, text: string) => {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), text);
  };
  return { root, directory, repository, git, write, read: (name: string) => readFile(join(directory, name), 'utf8'),
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

const LONG = (topic: string) => `# ${topic}\n\n${Array.from({ length: 12 }, (_, i) => `- ${topic}について覚えておくこと その${i + 1}`).join('\n')}\n`;

test('after a stage, the server rewrites the old paths in its own commit, in natsumi\'s files, the index, the diary and the archive', async () => {
  const f = await setup();
  try {
    await f.write('予定.md', `${LONG('予定')}\n## 関連\n- [本人](本人.md)\n`);
    await f.write('本人.md', `${LONG('本人')}\n## 関連\n- [予定](予定.md)\n- [旅行メモ](旅行メモ.md)\n`);
    await f.write('旅行.md', LONG('旅行'));
    await f.write('旅行メモ.md', '# 旅行メモ\n\n- 京都に行きたい\n');
    await f.write('diary/2026-10-03.md', '# 2026-10-03\n\n- [予定](../予定.md) に歯医者を書いた\n');
    await f.write('INDEX.md', '# 記憶の索引\n\n- 予定.md: 近い予定\n- [本人](本人.md)\n');
    await f.write('archive/2026-10.md', '# 2026-10\n\n## 旅行メモ\n- 去年の旅行は [旅行メモ](../旅行メモ.md)\n');
    await f.repository.initialize(undefined);
    await f.write('always.md', '# 常時記憶\n\n- 予定は 予定.md、旅行は /memory/旅行メモ.md を見る\n');
    await f.write('handoff.md', '# 引き継ぎ\n\n- 予定.md の歯医者を確かめる\n');
    await f.repository.commit({ event: 'nightly_review', night: true });
    const before = f.git('rev-parse', 'HEAD');

    // The curator's stage: moves 予定.md, merges 旅行メモ.md into 旅行.md, and commits.
    await mkdir(join(f.directory, 'life'));
    await rename(join(f.directory, '予定.md'), join(f.directory, 'life/予定.md'));
    await f.write('旅行.md', `${LONG('旅行')}- 京都に行きたい\n`);
    await rm(join(f.directory, '旅行メモ.md'));
    assert.equal((await f.repository.commitCuration({ message: '予定を life/ に、旅行メモを旅行にまとめた' })).committed, true);
    const curated = f.git('rev-parse', 'HEAD');

    const rewrite = await rewriteMovedPaths(f.repository, { before, merged: moves(['/memory/旅行メモ.md', '旅行.md']), event: 'memory_curator:structure:paths' });

    assert.ok(rewrite);
    assert.deepEqual(rewrite.moves, [{ from: '予定.md', to: 'life/予定.md' }, { from: '旅行メモ.md', to: '旅行.md' }]);
    assert.deepEqual(rewrite.ignored, []);
    assert.deepEqual(rewrite.reverted, []);
    assert.equal(await f.read('always.md'), '# 常時記憶\n\n- 予定は life/予定.md、旅行は /memory/旅行.md を見る\n');
    assert.equal(await f.read('handoff.md'), '# 引き継ぎ\n\n- life/予定.md の歯医者を確かめる\n');
    assert.equal(await f.read('INDEX.md'), '# 記憶の索引\n\n- life/予定.md: 近い予定\n- [本人](本人.md)\n');
    assert.match(await f.read('本人.md'), /- \[予定\]\(life\/予定\.md\)\n- \[旅行メモ\]\(旅行\.md\)\n$/);
    assert.match(await f.read('life/予定.md'), /- \[本人\]\(\.\.\/本人\.md\)\n$/);
    assert.equal(await f.read('diary/2026-10-03.md'), '# 2026-10-03\n\n- [予定](../life/予定.md) に歯医者を書いた\n');
    assert.match(await f.read('archive/2026-10.md'), /\[旅行メモ\]\(\.\.\/旅行\.md\)/);
    // Its own commit after the curator's, named for the stage, saying what went where.
    assert.equal(f.git('rev-parse', 'HEAD~1'), curated);
    assert.equal(rewrite.commit, f.git('rev-parse', 'HEAD'));
    assert.match(f.git('log', '-1', '--format=%s'), /^memory_curator:structure:paths: /);
    const body = f.git('log', '-1', '--format=%b');
    assert.match(body, /予定\.md → life\/予定\.md/);
    assert.match(body, /旅行メモ\.md → 旅行\.md/);
    assert.deepEqual([...rewrite.files].sort(), ['INDEX.md', 'always.md', 'archive/2026-10.md', 'diary/2026-10-03.md', 'handoff.md', 'life/予定.md', '本人.md'].sort());
    assert.equal(f.git('status', '--porcelain'), '');
  } finally {
    await f.cleanup();
  }
});

// ADR 0073: the curator never touches her skills, but a link in one still follows a topic it moved.
test('a link in her skill follows a moved topic, and the skill keeps its shape', async () => {
  const f = await setup();
  try {
    await f.write('予定.md', LONG('予定'));
    const skill = (to: string) => `---\nname: dentist\ndescription: 歯医者の予約を取るときの手順\n---\n\n# 歯医者\n\n- [予定](${to}) を見る\n`;
    await f.write('skills/dentist/SKILL.md', skill('../../予定.md'));
    await f.repository.initialize(undefined);
    const before = f.git('rev-parse', 'HEAD');
    await mkdir(join(f.directory, 'life'));
    await rename(join(f.directory, '予定.md'), join(f.directory, 'life/予定.md'));
    assert.equal((await f.repository.commitCuration({ message: '予定を life/ に動かした' })).committed, true);

    const rewrite = await rewriteMovedPaths(f.repository, { before, merged: moves(), event: 'memory_curator:structure:paths' });

    assert.ok(rewrite);
    assert.deepEqual(rewrite.reverted, []);
    assert.equal(await f.read('skills/dentist/SKILL.md'), skill('../../life/予定.md'));
    assert.deepEqual(rewrite.files, ['skills/dentist/SKILL.md']);
  } finally { await f.cleanup(); }
});

test('a stage that moved nothing rewrites nothing and makes no commit', async () => {
  const f = await setup();
  try {
    await f.write('予定.md', '# 予定\n\n- 歯医者は金曜\n');
    await f.repository.initialize(undefined);
    const before = f.git('rev-parse', 'HEAD');
    await f.write('予定.md', '# 予定\n\n## 通院\n- 歯医者は金曜\n');
    await f.repository.commitCuration({});
    assert.equal(await rewriteMovedPaths(f.repository, { before, merged: new Map(), event: 'memory_curator:structure:paths' }), undefined);
    assert.equal(f.git('rev-list', '--count', 'HEAD'), '2');
  } finally {
    await f.cleanup();
  }
});

test('a merge the curator named wrongly is left out and told, and a rewrite that fails a check goes back', async () => {
  const f = await setup({ alwaysMaxChars: 60 });
  try {
    await f.write('予定.md', LONG('予定'));
    await f.write('本人.md', '# 本人\n\n- 名前はハル\n');
    await f.repository.initialize(undefined);
    await f.write('always.md', '# 常時記憶\n\n- 予定.md 予定.md 予定.md 予定.md\n');
    await f.repository.commit({ event: 'nightly_review', night: true });
    const before = f.git('rev-parse', 'HEAD');
    await mkdir(join(f.directory, 'とても長いディレクトリの名前'));
    await rename(join(f.directory, '予定.md'), join(f.directory, 'とても長いディレクトリの名前/予定.md'));
    await f.repository.commitCuration({});

    const rewrite = await rewriteMovedPaths(f.repository, {
      before, event: 'memory_curator:structure:paths',
      merged: moves(['本人.md', '予定.md'], ['無い.md', '本人.md'], ['予定.md', '無い先.md']),
    });

    assert.ok(rewrite);
    // A path still there, a path that was never there, and a destination that is not there are not merges.
    assert.deepEqual(rewrite.ignored.map(entry => entry.from), ['本人.md', '無い.md', '予定.md']);
    // git's rename stands where the curator's table was wrong.
    assert.deepEqual(rewrite.moves, [{ from: '予定.md', to: 'とても長いディレクトリの名前/予定.md' }]);
    // always.md would pass its limit with the longer paths, so it is left as it was.
    assert.deepEqual(rewrite.reverted.map(entry => entry.path), ['always.md']);
    assert.equal(await f.read('always.md'), '# 常時記憶\n\n- 予定.md 予定.md 予定.md 予定.md\n');
    assert.equal(rewrite.commit, undefined);
    assert.equal(f.git('status', '--porcelain'), '');
  } finally {
    await f.cleanup();
  }
});
