import assert from 'node:assert/strict';
import test from 'node:test';
import { locate, type ListedEntry } from '../src/server/dashboard-files.ts';
import { directoryPage, filePage, filesIndexPage, refusedFilePage, renderMarkdown } from '../src/server/dashboard-files-view.ts';

// The pages of her files (ADR 0054): every name and every word escaped, Markdown without raw HTML, and links and
// images only where they stay inside the place.

const HOSTILE = '<img src=x onerror=alert(1)>';
const ZONE = 'Asia/Tokyo';
const at = (path: string) => locate(`/dashboard/files${path}`)!;

function entry(overrides: Partial<ListedEntry>): ListedEntry {
  return { name: 'a.txt', type: 'file', size: 999, mtimeMs: Date.parse('2026-01-01T00:00:00Z'), ...overrides };
}

test('the first page lists the five places', () => {
  const text = filesIndexPage().text;
  for (const href of ['/dashboard/files/memory', '/dashboard/files/work', '/dashboard/files/home/natsumi', '/dashboard/files/manual',
    '/dashboard/files/manual/agents']) {
    assert.match(text, new RegExp(`href="${href}"`), href);
  }
  assert.match(text, /aria-current="page"[^>]*>ファイル/, 'the navigation has the files');
});

test('a directory shows a breadcrumb, sortable headings, and each entry with its size and time, escaped', () => {
  const text = directoryPage({
    location: at('/work/notes'), view: { hidden: false, sort: 'name', order: 'asc' }, hiddenCount: 1,
    entries: [entry({ name: 'sub dir', type: 'directory', size: null }), entry({ name: HOSTILE }), entry({ name: 'big.bin', size: 5 * 1024 * 1024 }),
      entry({ name: 'link', type: 'symlink', size: null, target: '/etc/<passwd>' })],
  }, ZONE).text;
  assert.doesNotMatch(text, /<img src=x/);
  assert.match(text, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(text, /href="\/dashboard\/files\/work">\/work<\/a>/, 'the breadcrumb goes back up');
  assert.match(text, /href="\/dashboard\/files">ファイル<\/a>/);
  assert.match(text, /href="\/dashboard\/files\/work\/notes\/sub%20dir"/);
  assert.match(text, /href="\/dashboard\/files\/work\/notes\/%3Cimg%20src%3Dx%20onerror%3Dalert\(1\)%3E"/);
  assert.match(text, /999 B/);
  assert.match(text, /5\.0 MiB/);
  assert.match(text, /2026-01-01 09:00:00/);
  assert.match(text, /→ \/etc\/&lt;passwd&gt;/, 'a symlink shows where it points');
  assert.doesNotMatch(text, /href="\/dashboard\/files\/work\/notes\/link"/, 'and is not a link');
  assert.match(text, /href="\/dashboard\/files\/work\/notes\?sort=name&amp;order=desc"[^>]*>名前/, 'the sorted column turns the order');
  assert.match(text, /href="\/dashboard\/files\/work\/notes\?sort=mtime"[^>]*>更新日時/);
  assert.match(text, /href="\/dashboard\/files\/work\/notes\?sort=size"[^>]*>大きさ/);
  assert.match(text, /href="\/dashboard\/files\/work\/notes\?hidden=1"[^>]*>隠しファイルを表示（1）/);
});

test('with the dotfiles shown, the links keep them shown and offer to hide them again', () => {
  const text = directoryPage({ location: at('/home/natsumi'), view: { hidden: true, sort: 'mtime', order: 'desc' }, hiddenCount: 0,
    entries: [entry({ name: '.config', type: 'directory', size: null })] }, ZONE).text;
  assert.match(text, /href="\/dashboard\/files\/home\/natsumi\/\.config\?hidden=1&amp;sort=mtime"/);
  assert.match(text, /href="\/dashboard\/files\/home\/natsumi\?sort=mtime"[^>]*>隠しファイルを隠す/);
  assert.match(text, /href="\/dashboard\/files\/home\/natsumi\?hidden=1&amp;sort=mtime&amp;order=asc"[^>]*>更新日時/);
  assert.match(text, /まだ何もありません|\.config/);
});

test('an empty directory says so', () => {
  assert.match(directoryPage({ location: at('/work'), view: { hidden: false, sort: 'name', order: 'asc' }, hiddenCount: 0, entries: [] }, ZONE).text,
    /空のディレクトリです/);
});

const file = (path: string, content: Parameters<typeof filePage>[0]['content'], extra: { raw?: boolean; size?: number } = {}) =>
  filePage({ location: at(path), size: extra.size ?? 10, mtimeMs: Date.parse('2026-01-01T00:00:00Z'), content, raw: extra.raw ?? false }, ZONE).text;

test('a text file is shown escaped, with its size, time and a download', () => {
  const text = file('/work/a.html', { type: 'text', text: `<script>alert(1)</script>${HOSTILE}`, truncated: false });
  assert.doesNotMatch(text, /<script>alert/);
  assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(text, /<pre[^>]*>/);
  assert.match(text, /href="\/dashboard\/files\/work\/a\.html\?download=1"[^>]*>ダウンロード/);
  assert.match(text, /href="\/dashboard\/files\/work">\/work<\/a>/);
});

test('text past the limit says it was cut, and how big the whole is', () => {
  const text = file('/work/log.txt', { type: 'text', text: 'first part', truncated: true }, { size: 3 * 1024 * 1024 });
  assert.match(text, /以降は省略（全体 3\.0 MiB）/);
});

test('an image is shown by its own URL under the dashboard, and a binary by its kind and size only', () => {
  const image = file('/work/images/a b.png', { type: 'image', mimeType: 'image/png' });
  assert.match(image, /<img src="\/dashboard\/files\/work\/images\/a%20b\.png\?image=1" alt="a b\.png"/);
  const binary = file('/work/x.pdf', { type: 'binary', label: 'PDF' }, { size: 2048 });
  assert.match(binary, /PDF/);
  assert.match(binary, /2\.0 KiB/);
  assert.match(binary, /ダウンロード/);
  assert.doesNotMatch(binary, /<pre/);
});

test('Markdown is formatted by default, with a switch to the raw text; the raw text is escaped', () => {
  const source = `# 見出し\n\n- 項目 ${HOSTILE}\n`;
  const shaped = file('/memory/a.md', { type: 'text', text: source, truncated: false });
  assert.match(shaped, /<h1>見出し<\/h1>/);
  assert.match(shaped, /<li>項目 &lt;img src=x onerror=alert\(1\)&gt;<\/li>/);
  assert.match(shaped, /href="\/dashboard\/files\/memory\/a\.md\?raw=1"[^>]*>生のテキスト/);
  const raw = file('/memory/a.md', { type: 'text', text: source, truncated: false }, { raw: true });
  assert.match(raw, /<pre[^>]*># 見出し/);
  assert.doesNotMatch(raw, /<h1>見出し/);
  assert.match(raw, /href="\/dashboard\/files\/memory\/a\.md"[^>]*>整形して表示/);
});

test('Markdown lets no raw HTML through', () => {
  const text = renderMarkdown('<script>alert(1)</script>\n\n<div onclick="x">a</div> <b>b</b> <!-- c -->', at('/memory/a.md')).text;
  assert.doesNotMatch(text, /<script|<div|<b>|<!--/);
  assert.match(text, /&lt;script&gt;/);
  assert.match(text, /&lt;b&gt;b&lt;\/b&gt;/);
});

test('Markdown keeps links to http and https and to relative paths inside the place, rewritten to the viewer', () => {
  const text = renderMarkdown([
    '[web](https://example.test/a?b=1)', '[plain](http://example.test/)', '[sibling](b.md)', '[up](../top.md#part)',
    '[deep](sub/c%20d.md)', '[agents](agents/INDEX.md)',
  ].join('\n\n'), at('/manual/notes/a.md')).text;
  assert.match(text, /<a href="https:\/\/example\.test\/a\?b=1"[^>]*>web<\/a>/);
  assert.match(text, /<a href="http:\/\/example\.test\/"[^>]*>plain<\/a>/);
  assert.match(text, /<a href="\/dashboard\/files\/manual\/notes\/b\.md">sibling<\/a>/);
  assert.match(text, /<a href="\/dashboard\/files\/manual\/top\.md">up<\/a>/);
  assert.match(text, /<a href="\/dashboard\/files\/manual\/notes\/sub\/c%20d\.md">deep<\/a>/);
  assert.match(text, /<a href="\/dashboard\/files\/manual\/notes\/agents\/INDEX\.md">agents<\/a>/);
});

test('Markdown turns any other link into its words alone', () => {
  const text = renderMarkdown([
    '[js](javascript:alert(1))', '[data](data:text/html,<b>x</b>)', '[abs](/etc/passwd)', '[net](//evil.test/x)',
    '[out](../../../etc/passwd)', '[mail](mailto:a@example.test)', '[file](file:///etc/passwd)', '[frag](#here)',
    '[vb](VBScript:msgbox)', '<javascript:alert(1)>', '[ws](ws://example.test)',
  ].join('\n\n'), at('/memory/notes/a.md')).text;
  assert.doesNotMatch(text, /<a /, text);
  for (const words of ['js', 'data', 'abs', 'net', 'out', 'mail', 'file', 'frag', 'vb', 'ws']) assert.match(text, new RegExp(`>${words}<|${words}`));
});

test('Markdown shows only images inside the place, by the viewer’s image URL; any other is left as its words', () => {
  const text = renderMarkdown([
    '![inside](images/a.png)', '![up](../pic.webp "t")', '![outside](https://example.test/x.png)', '![escape](../../x.png)',
    '![abs](/work/x.png)', '![data](data:image/png;base64,AAAA)',
  ].join('\n\n'), at('/memory/notes/a.md')).text;
  assert.match(text, /<img src="\/dashboard\/files\/memory\/notes\/images\/a\.png\?image=1" alt="inside"/);
  assert.match(text, /<img src="\/dashboard\/files\/memory\/pic\.webp\?image=1" alt="up"/);
  assert.equal(text.match(/<img /g)?.length, 2, text);
  for (const words of ['outside', 'escape', 'abs', 'data']) assert.match(text, new RegExp(words));
  assert.doesNotMatch(text, /example\.test|base64/);
});

test('a refused path says why without showing anything of it', () => {
  assert.match(refusedFilePage({ location: at('/work/out/x'), reason: 'symlink' }).text, /symlink はたどりません/);
  const pointing = refusedFilePage({ location: at('/work/out'), reason: 'symlink', target: HOSTILE }).text;
  assert.match(pointing, /→ &lt;img/);
  assert.match(refusedFilePage({ location: at('/work/none'), reason: 'missing' }).text, /見つかりません/);
  assert.match(refusedFilePage({ location: at('/work/pipe'), reason: 'other' }).text, /ファイルでもディレクトリでもありません/);
  assert.match(refusedFilePage({ location: at('/work/locked'), reason: 'unreadable' }).text, /読めません/);
});

// ADR 0057: the avatar's pages are one more place, and the words name her by the avatar's display name.
test('the first page lists the avatar\'s pages and names her by the display name', () => {
  const text = filesIndexPage('はな').text;
  assert.match(text, /href="\/dashboard\/files\/manual\/avatar"/);
  assert.match(text, /はなの作業環境・記憶・マニュアル/);
  assert.match(text, /はなのホーム/);
  assert.doesNotMatch(text, /なつみ/);
  assert.match(filesIndexPage().text, /なつみのホーム/);
  assert.match(refusedFilePage({ location: at('/work/out/x'), reason: 'symlink' }, 'はな').text, /指す先がはなの場所の中なら/);
});
