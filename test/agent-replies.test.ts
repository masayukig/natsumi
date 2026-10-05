import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  clampSummary, MAX_SUMMARY_CHARS, parseReplyData, replyFromText, sectionFileName, writeAgentReply,
} from '../src/server/agent-replies.ts';

/**
 * An outside agent's reply as files under /sources/agents (ADR 0069): one directory a reply, a README with the summary
 * and the list of sections, one file a section, the sources, what was received, and the images. A reply of text only
 * is cut into sections by its Markdown headings, and its first paragraph becomes the summary.
 */

const AT = Date.parse('2026-09-24T03:00:00Z');

async function setup(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'natsumi-agent-replies-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory: join(root, 'sources', 'agents') };
}

test('a text with headings is cut at them, and its first paragraph is the summary', () => {
  const reply = replyFromText([
    'ねこは液体である、という説を調べました。',
    '',
    '## 結論',
    '',
    '液体のようにふるまいます。',
    '',
    '## 詳細',
    '',
    '### 実験',
    '',
    '容器に合わせて形を変えます。',
  ].join('\n'));
  assert.equal(reply.summary, 'ねこは液体である、という説を調べました。');
  assert.deepEqual(reply.sections, [
    { title: 'はじめに', body: 'ねこは液体である、という説を調べました。' },
    { title: '結論', body: '液体のようにふるまいます。' },
    { title: '詳細', body: '### 実験\n\n容器に合わせて形を変えます。' },
  ]);
  assert.deepEqual(reply.sources, []);
});

test('a single title heading over the sections does not swallow them: the level used is the one that repeats', () => {
  const reply = replyFromText([
    '# 調査結果',
    '',
    '要点は二つです。',
    '',
    '## 一つ目',
    'A です。',
    '## 二つ目',
    'B です。',
  ].join('\n'));
  assert.equal(reply.summary, '要点は二つです。');
  assert.deepEqual(reply.sections.map(section => section.title), ['調査結果', '一つ目', '二つ目']);
  assert.equal(reply.sections[0]!.body, '要点は二つです。');
});

test('a text without headings is one section, and a heading inside a code block is not one', () => {
  const plain = replyFromText('すぐ答えます。');
  assert.deepEqual(plain, { summary: 'すぐ答えます。', sections: [{ title: '本文', body: 'すぐ答えます。' }], sources: [] });

  const fenced = replyFromText(['例です。', '', '```sh', '# コメント', 'echo hi', '```'].join('\n'));
  assert.deepEqual(fenced.sections.map(section => section.title), ['本文']);
  assert.equal(fenced.summary, '例です。');
});

test('the summary skips headings, keeps at most three lines, and is cut with an ellipsis past its length', () => {
  assert.equal(replyFromText('## 結論\n\n一行目\n二行目\n三行目\n四行目').summary, '一行目\n二行目\n三行目…');
  const long = replyFromText('あ'.repeat(MAX_SUMMARY_CHARS + 50)).summary;
  assert.equal([...long].length, MAX_SUMMARY_CHARS);
  assert.ok(long.endsWith('…'));
  assert.equal(clampSummary('  短い  '), '短い');
  assert.equal(replyFromText('').summary, '');
  assert.deepEqual(replyFromText('   ').sections, []);
});

test('a section is named by its number and its title, with what a file name cannot hold made plain', () => {
  assert.equal(sectionFileName(0, '結論'), '01-結論.md');
  assert.equal(sectionFileName(11, 'Q&A: よくある質問 / FAQ'), '12-Q-A-よくある質問-FAQ.md');
  assert.equal(sectionFileName(2, '../../etc/passwd'), '03-etc-passwd.md');
  assert.equal(sectionFileName(3, '***'), '04-section.md');
  assert.equal([...sectionFileName(4, 'あ'.repeat(100))].length, '05-'.length + 40 + '.md'.length);
});

test('a DataPart in the shared shape is taken, and anything else is not', () => {
  const good = { summary: '要約', sections: [{ title: '結論', body: '本文' }], sources: [{ title: '出典', url: 'https://example.com/' }] };
  assert.deepEqual(parseReplyData(good), good);
  assert.equal(parseReplyData({ ...good, summary: 3 }), undefined);
  assert.equal(parseReplyData({ ...good, sections: [{ title: '結論' }] }), undefined);
  assert.equal(parseReplyData({ ...good, sources: [{ title: '出典', url: 'javascript:alert(1)' }] }), undefined);
  assert.equal(parseReplyData('text'), undefined);
});

test('a reply is put in a directory of its own, named by the time and a short mark, with every file the ADR names', async t => {
  const f = await setup(t);
  const reply = replyFromText('ねこは液体です。\n\n## 結論\n\n液体です。\n\n## 詳細\n\n形を変えます。');
  const written = await writeAgentReply({ directory: f.directory, agent: 'wiki', state: 'completed', at: AT, reply });
  assert.match(written.path, /^\/sources\/agents\/wiki\/20260924T030000Z-[0-9a-f]{4}$/);
  assert.equal(written.readme, `${written.path}/README.md`);
  const here = join(f.directory, 'wiki', written.path.split('/').at(-1)!);
  assert.deepEqual((await readdir(here)).sort(), ['01-はじめに.md', '02-結論.md', '03-詳細.md', 'README.md', 'result.json', 'sources.json']);
  assert.equal(await readFile(join(here, '02-結論.md'), 'utf8'), '# 結論\n\n液体です。\n');
  assert.deepEqual(JSON.parse(await readFile(join(here, 'sources.json'), 'utf8')), []);
  assert.deepEqual(JSON.parse(await readFile(join(here, 'result.json'), 'utf8')), reply);
  const readme = await readFile(join(here, 'README.md'), 'utf8');
  assert.match(readme, /wiki/);
  assert.match(readme, /completed/);
  assert.match(readme, /ねこは液体です。/);
  assert.match(readme, /02-結論\.md/);
  // Nothing is left half-written beside it.
  assert.deepEqual(await readdir(join(f.directory, 'wiki')), [written.path.split('/').at(-1)]);
});

test('what was received is kept as it came, and a reply with no section says so', async t => {
  const f = await setup(t);
  const received = { summary: '要約', sections: [], sources: [{ title: '出典', url: 'https://example.com/' }], extra: true };
  const written = await writeAgentReply({ directory: f.directory, agent: 'web', state: 'gave_up', at: AT,
    reply: { summary: '待つのをやめました。', sections: [], sources: received.sources }, received });
  const here = join(f.directory, 'web', written.path.split('/').at(-1)!);
  assert.deepEqual(JSON.parse(await readFile(join(here, 'result.json'), 'utf8')), received);
  assert.deepEqual(JSON.parse(await readFile(join(here, 'sources.json'), 'utf8')), received.sources);
  const readme = await readFile(join(here, 'README.md'), 'utf8');
  assert.match(readme, /gave_up/);
  assert.match(readme, /節はありません/);
  assert.match(readme, /1 件/);
});

test('the images are brought into the reply\'s images/, and the README lists them and those not taken', async t => {
  const f = await setup(t);
  const written = await writeAgentReply({ directory: f.directory, agent: 'wiki', state: 'completed', at: AT,
    reply: replyFromText('撮りました。'),
    bring: async (directory, path) => {
      await writeFile(join(directory, 'shot.png'), 'png');
      return { taken: [], images: [{ path: `${path}/shot.png`, description: 'トップページ' }], notTaken: [{ name: 'b.png', reason: '取りませんでした。' }] };
    } });
  assert.deepEqual(written.images, [{ path: `${written.path}/images/shot.png`, description: 'トップページ' }]);
  assert.deepEqual(written.notTaken, [{ name: 'b.png', reason: '取りませんでした。' }]);
  const here = join(f.directory, 'wiki', written.path.split('/').at(-1)!);
  assert.equal(await readFile(join(here, 'images', 'shot.png'), 'utf8'), 'png');
  const readme = await readFile(join(here, 'README.md'), 'utf8');
  assert.match(readme, /images\/shot\.png/);
  assert.match(readme, /トップページ/);
  assert.match(readme, /b\.png/);
  assert.match(readme, /取りませんでした。/);
});

test('two replies of the same agent in the same second get directories of their own', async t => {
  const f = await setup(t);
  const one = await writeAgentReply({ directory: f.directory, agent: 'wiki', state: 'completed', at: AT, reply: replyFromText('一') });
  const two = await writeAgentReply({ directory: f.directory, agent: 'wiki', state: 'completed', at: AT, reply: replyFromText('二') });
  assert.notEqual(one.path, two.path);
  assert.equal((await readdir(join(f.directory, 'wiki'))).length, 2);
});
