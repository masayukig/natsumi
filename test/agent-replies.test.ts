import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  checkReplyData, clampSummary, firstLine, MAX_SUMMARY_CHARS, parseReplyData, replyFromText, sectionFileName, writeAgentReply, writeAgentRequest,
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

// The reply extension's JSON Schema (fraction-agents docs/extensions/reply/v1/reply.schema.json), kept as it says.
test('a DataPart is taken only as the reply extension\'s schema has it, and anything else is not', () => {
  const good = { summary: '要約', sections: [{ title: '結論', body: '本文' }], sources: [{ title: '出典', url: 'https://example.com/' }] };
  assert.deepEqual(parseReplyData(good), good);
  assert.deepEqual(parseReplyData({ summary: '一\n二\n三', sections: [], sources: [] }), { summary: '一\n二\n三', sections: [], sources: [] });
  assert.deepEqual(parseReplyData({ ...good, summary: 'あ'.repeat(500) }), { ...good, summary: 'あ'.repeat(500) }, 'counted in characters');
  const section = (fields: Record<string, unknown>) => ({ ...good, sections: [{ title: '結論', body: '本文', ...fields }] });
  const source = (fields: Record<string, unknown>) => ({ ...good, sources: [{ title: '出典', url: 'https://example.com/', ...fields }] });
  const bad: [string, unknown][] = [
    ['not an object', 'text'],
    ['an array', [good]],
    ['a summary that is not a string', { ...good, summary: 3 }],
    ['an empty summary', { ...good, summary: '' }],
    ['a summary of four lines', { ...good, summary: '一\n二\n三\n四' }],
    ['a summary over 500 characters', { ...good, summary: 'あ'.repeat(501) }],
    ['a field outside the shape', { ...good, extra: true }],
    ['no sources', { summary: good.summary, sections: good.sections }],
    ['sections that are not a list', { ...good, sections: {} }],
    ['over 50 sections', { ...good, sections: Array.from({ length: 51 }, () => good.sections[0]) }],
    ['a section without a body', { ...good, sections: [{ title: '結論' }] }],
    ['an empty title', section({ title: '' })],
    ['a title of two lines', section({ title: '結\n論' })],
    ['a title with a carriage return', section({ title: '結\r論' })],
    ['a title over 200 characters', section({ title: 'あ'.repeat(201) })],
    ['an empty body', section({ body: '' })],
    ['a body over 50000 characters', section({ body: 'あ'.repeat(50_001) })],
    ['a field outside a section', section({ note: 'x' })],
    ['over 100 sources', { ...good, sources: Array.from({ length: 101 }, () => good.sources[0]) }],
    ['a URL that is not http(s)', source({ url: 'javascript:alert(1)' })],
    ['a URL with a space', source({ url: 'https://example.com/a b' })],
    ['a URL over 2000 characters', source({ url: `https://example.com/${'a'.repeat(2000)}` })],
    ['an empty source title', source({ title: '' })],
    ['a source title over 300 characters', source({ title: 'あ'.repeat(301) })],
    ['a field outside a source', source({ note: 'x' })],
  ];
  for (const [why, value] of bad) assert.equal(parseReplyData(value), undefined, why);
  assert.equal(checkReplyData(good), undefined);
  assert.match(checkReplyData({ ...good, extra: true })!, /extra/, 'what is wrong is said, for the log');
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
  assert.deepEqual(JSON.parse(await readFile(join(here, 'result.json'), 'utf8')), { form: 'text', reply });
  const readme = await readFile(join(here, 'README.md'), 'utf8');
  assert.match(readme, /wiki/);
  assert.match(readme, /completed/);
  assert.match(readme, /ねこは液体です。/);
  assert.match(readme, /02-結論\.md/);
  // Nothing is left half-written beside it.
  assert.deepEqual(await readdir(join(f.directory, 'wiki')), [written.path.split('/').at(-1)]);
});

// ADR 0069: which shape a reply was put from is kept for the owner and Claude, not shown to natsumi in the README.
test('result.json keeps which shape the reply was put from and the data as it came, and a reply with no section says so', async t => {
  const f = await setup(t);
  const data = { summary: '要約', sections: [], sources: [{ title: '出典', url: 'https://example.com/' }] };
  const written = await writeAgentReply({ directory: f.directory, agent: 'web', state: 'completed', at: AT, reply: data, form: 'data', data });
  const here = join(f.directory, 'web', written.path.split('/').at(-1)!);
  assert.deepEqual(JSON.parse(await readFile(join(here, 'result.json'), 'utf8')), { form: 'data', reply: data, data });
  const misfit = { ...data, extra: true };
  const fallen = await writeAgentReply({ directory: f.directory, agent: 'web', state: 'completed', at: AT,
    reply: replyFromText('要約'), form: 'text', data: misfit });
  assert.deepEqual(JSON.parse(await readFile(join(fallen.directory, 'result.json'), 'utf8')),
    { form: 'text', reply: replyFromText('要約'), data: misfit }, 'data that did not fit is kept as it came');
  assert.deepEqual(JSON.parse(await readFile(join(here, 'sources.json'), 'utf8')), data.sources);
  const readme = await readFile(join(here, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /form|DataPart/);
  assert.match(readme, /completed/);
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

// Sent back on #153: which request a reply answers, and what was asked, are in its directory.
test('a request is put in a directory of its own when it is made, with what was asked in request.md', async t => {
  const f = await setup(t);
  const placed = await writeAgentRequest({ directory: f.directory, agent: 'wiki', at: AT, askedAt: '2026-09-24 12:00',
    text: 'ねこの記事を要約して。\n箇条書きで。', how: 'new' });
  assert.match(placed.path, /^\/sources\/agents\/wiki\/20260924T030000Z-[0-9a-f]{4}$/);
  assert.deepEqual(await readdir(placed.directory), ['request.md']);
  const request = await readFile(join(placed.directory, 'request.md'), 'utf8');
  assert.match(request, /2026-09-24 12:00/);
  assert.match(request, /wiki/);
  assert.match(request, /新しい依頼/);
  assert.match(request, /ねこの記事を要約して。\n箇条書きで。/);

  const next = await writeAgentRequest({ directory: f.directory, agent: 'wiki', at: AT, askedAt: '2026-09-24 12:05', text: '続き',
    how: 'continue', previous: placed.path });
  assert.notEqual(next.path, placed.path);
  assert.match(await readFile(join(next.directory, 'request.md'), 'utf8'), new RegExp(`続き[\\s\\S]*${placed.path}`));
  const answer = await writeAgentRequest({ directory: f.directory, agent: 'wiki', at: AT, askedAt: '2026-09-24 12:06', text: 'index です',
    how: 'answer', previous: null });
  assert.match(await readFile(join(answer.directory, 'request.md'), 'utf8'), /聞き返しへの答え[\s\S]*分かりません/);
});

test('a reply goes into the directory of its request beside request.md, and the README begins with what was asked', async t => {
  const f = await setup(t);
  const text = '一行目の依頼\n二行目\n三行目\n四行目';
  const place = await writeAgentRequest({ directory: f.directory, agent: 'wiki', at: AT, askedAt: '2026-09-24 12:00', text, how: 'new' });
  // What a failed earlier attempt left is cleared first.
  await writeFile(join(place.directory, '01-古い.md'), 'old');
  const written = await writeAgentReply({ directory: f.directory, agent: 'wiki', state: 'completed', at: AT + 60_000,
    reply: replyFromText('答えです。'), place, request: { text, askedAt: '2026-09-24 12:00' } });
  assert.equal(written.path, place.path);
  assert.equal(written.created, false);
  assert.deepEqual((await readdir(place.directory)).sort(), ['01-本文.md', 'README.md', 'request.md', 'result.json', 'sources.json']);
  const readme = await readFile(join(place.directory, 'README.md'), 'utf8');
  const asked = readme.indexOf('## 頼んだこと');
  assert.ok(asked > 0 && asked < readme.indexOf('## 要約'), readme);
  assert.match(readme, /2026-09-24 12:00/);
  assert.match(readme, /> 一行目の依頼\n> 二行目\n> 三行目/);
  assert.doesNotMatch(readme, /四行目/);
  assert.match(readme, /request\.md/);
});

test('a reply of a request made before requests were kept gets a directory of its own, and says nothing was kept', async t => {
  const f = await setup(t);
  const written = await writeAgentReply({ directory: f.directory, agent: 'wiki', state: 'completed', at: AT, reply: replyFromText('答え') });
  assert.equal(written.created, true);
  assert.match(await readFile(join(written.directory, 'README.md'), 'utf8'), /## 頼んだこと\n\n頼んだことの記録はありません/);
  assert.equal(await stat(join(written.directory, 'request.md')).catch(() => undefined), undefined);
});

test('the first line of a request is kept short for the attention', () => {
  assert.equal(firstLine('\n  ねこの記事を要約して  \n二行目'), 'ねこの記事を要約して');
  const long = firstLine('あ'.repeat(100));
  assert.equal([...long].length, 80);
  assert.ok(long.endsWith('…'));
});
