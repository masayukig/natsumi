import { posix } from 'node:path';
import markdownIt, { type Token } from 'markdown-it';
import {
  DEFAULT_ORDER, FILES_PATH, filesUrl, locationUrl, PLACES, workspacePath, type Content, type ListedEntry, type ListingView,
  type Location, type RefusalReason, type SortKey,
} from './dashboard-files.ts';
import { localTime, page } from './dashboard-view.ts';
import { html, markdownMarkup, type Html } from './html.ts';

/**
 * The pages of her files (ADR 0054): the places, a directory one level down, and a file — its text escaped, an image
 * by its own URL, a binary by its kind and size — each with a download. Markdown is formatted on the server with no
 * raw HTML let through, and only the links and images that stay inside the place are kept. Nothing runs in the page.
 */

const CURRENT = 'ファイル';

const PLACE_NOTES: Record<string, string> = {
  '/memory': '記憶（git で持つもの）',
  '/work': '手を動かす場所',
  '/home/natsumi': 'なつみのホーム',
  '/manual': 'マニュアル',
  '/manual/agents': '頼める相手の一覧（サーバーが書くもの）',
};

export function filesIndexPage(): Html {
  const places = [...PLACES].sort((a, b) => a.place.localeCompare(b.place));
  const main = html`<section id="files">
<h2>ファイル</h2>
<p><small>なつみの作業環境・記憶・マニュアルの今の中身です。読み取り専用で、symlink はたどりません。</small></p>
<ul class="places">${places.map(({ place }) => html`<li><a href="${FILES_PATH}${place}"><code>${place}</code></a> <small>${PLACE_NOTES[place]}</small></li>`)}</ul>
</section>`;
  return page('ファイル', main, { signedIn: true, current: CURRENT });
}

/** ファイル / /work / notes / a.md, each but the last a link. */
function breadcrumb(location: Location): Html {
  const steps = [{ label: location.place, url: locationUrl({ ...location, segments: [] }) },
    ...location.segments.map((name, index) => ({ label: name, url: locationUrl({ ...location, segments: location.segments.slice(0, index + 1) }) }))];
  const last = steps.length - 1;
  return html`<nav class="crumbs" aria-label="場所"><a href="${FILES_PATH}">ファイル</a>${steps.map((step, index) => index === last
    ? html` / <strong>${step.label}</strong>` : html` / <a href="${step.url}">${step.label}</a>`)}</nav>`;
}

/** The query of a listing: nothing for the default, and each part only when it differs from the default. */
function listingQuery(view: ListingView): string {
  const parts = [...(view.hidden ? ['hidden=1'] : []),
    ...(view.sort === 'name' && view.order === 'asc' ? [] : [`sort=${view.sort}`]),
    ...(view.order === DEFAULT_ORDER[view.sort] ? [] : [`order=${view.order}`])];
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

const HEADINGS: { key: SortKey; label: string }[] = [{ key: 'name', label: '名前' }, { key: 'mtime', label: '更新日時' }, { key: 'size', label: '大きさ' }];

export interface DirectoryView {
  location: Location;
  view: ListingView;
  entries: ListedEntry[];
  hiddenCount: number;
  omitted?: number;
}

export function directoryPage(directory: DirectoryView, timeZone: string): Html {
  const { location, view, entries, hiddenCount } = directory;
  const here = locationUrl(location);
  const heading = ({ key, label }: typeof HEADINGS[number]) => {
    const current = view.sort === key;
    const order = current ? (view.order === 'asc' ? 'desc' : 'asc') : DEFAULT_ORDER[key];
    const mark = current ? (view.order === 'asc' ? ' ↑' : ' ↓') : '';
    return html`<th${current ? html` aria-sort="${view.order === 'asc' ? 'ascending' : 'descending'}"` : ''}><a href="${here}${listingQuery({ ...view, sort: key, order })}">${label}</a>${mark}</th>`;
  };
  const toggle = view.hidden
    ? html`<a href="${here}${listingQuery({ ...view, hidden: false })}">隠しファイルを隠す</a>`
    : html`<a href="${here}${listingQuery({ ...view, hidden: true })}">隠しファイルを表示（${hiddenCount}）</a>`;
  const row = (entry: ListedEntry) => {
    const url = locationUrl({ ...location, segments: [...location.segments, entry.name] });
    const name = entry.type === 'directory' ? html`<a href="${url}${listingQuery(view)}">${entry.name}/</a>`
      : entry.type === 'file' ? html`<a href="${url}">${entry.name}</a>`
      : entry.type === 'symlink' ? html`${entry.name} <small>→ ${entry.target ?? '（読めない）'}</small>`
      : html`${entry.name} <small>（ファイルでもディレクトリでもない）</small>`;
    return html`<tr><td>${name}</td><td>${localTime(new Date(entry.mtimeMs).toISOString(), timeZone)}</td>
<td class="number">${entry.size === null ? '—' : bytes(entry.size)}</td></tr>`;
  };
  const main = html`<section id="directory">
${breadcrumb(location)}
<h2><code>${workspacePath(location)}</code></h2>
<p class="filters">${toggle}</p>
${entries.length === 0 ? html`<p>空のディレクトリです。</p>` : html`<div class="table"><table class="list files">
<thead><tr>${HEADINGS.map(heading)}</tr></thead>
<tbody>${entries.map(row)}</tbody>
</table></div>`}
${(directory.omitted ?? 0) > 0 && html`<p><small>ほか ${directory.omitted} 件は省略しました。</small></p>`}
</section>`;
  return page('ファイル', main, { signedIn: true, current: CURRENT });
}

export interface FileView {
  location: Location;
  size: number;
  mtimeMs: number;
  content: Content;
  /** Markdown as its text rather than formatted. */
  raw: boolean;
}

const MARKDOWN = /\.(md|markdown)$/i;

export function filePage(file: FileView, timeZone: string): Html {
  const { location, size, mtimeMs, content, raw } = file;
  const here = locationUrl(location);
  const name = location.segments.at(-1) ?? location.place;
  const markdown = content.type === 'text' && MARKDOWN.test(name);
  const body = content.type === 'image'
    ? html`<p><img src="${here}?image=1" alt="${name}" class="file"></p>`
    : content.type === 'binary'
      ? html`<p>${content.label}のファイルです（${bytes(size)}）。中身はダウンロードして確かめてください。</p>`
      : html`${markdown && !raw ? html`<div class="markdown">${renderMarkdown(content.text, location)}</div>` : html`<pre class="file">${content.text}</pre>`}
${content.truncated && html`<p class="note">以降は省略（全体 ${bytes(size)}）。続きはダウンロードしてください。</p>`}`;
  const main = html`<section id="file">
${breadcrumb(location)}
<h2><code>${workspacePath(location)}</code></h2>
<p class="filters"><span>${bytes(size)}</span><span>${localTime(new Date(mtimeMs).toISOString(), timeZone)}</span>
<a href="${here}?download=1">ダウンロード</a>
${markdown && (raw ? html`<a href="${here}">整形して表示</a>` : html`<a href="${here}?raw=1">生のテキスト</a>`)}</p>
${body}
</section>`;
  return page('ファイル', main, { signedIn: true, current: CURRENT });
}

const REFUSALS: Record<RefusalReason, string> = {
  missing: '見つかりません',
  symlink: 'symlink はたどりません',
  other: 'ファイルでもディレクトリでもありません',
  unreadable: '読めません',
};

export function refusedFilePage(refused: { location: Location; reason: RefusalReason; target?: string }): Html {
  const { location, reason, target } = refused;
  const main = html`<section id="file">
${breadcrumb(location)}
<h2>${REFUSALS[reason]}</h2>
<p><code>${workspacePath(location)}</code>${target !== undefined && html` <small>→ ${target}</small>`}</p>
${reason === 'symlink' && html`<p><small>このパスには symlink が含まれています。指す先がなつみの場所の中なら、そのパスを開いてください。</small></p>`}
</section>`;
  return page(REFUSALS[reason], main, { signedIn: true, current: CURRENT });
}

const markdown = markdownIt({ html: false, linkify: false, typographer: false });

/**
 * Markdown as HTML: raw HTML escaped; a link kept only to http, https or a relative path inside the place (rewritten to
 * the dashboard's URL of it), and an image only by a relative path inside the place (the dashboard's image URL). Any
 * other link is left as its words, and any other image as its alternative text.
 */
export function renderMarkdown(text: string, location: Location): Html {
  const env = {};
  const tokens = markdown.parse(text, env);
  for (const token of tokens) if (token.children) rewrite(token.children, location);
  return markdownMarkup(markdown.renderer.render(tokens, markdown.options, env));
}

function rewrite(children: Token[], location: Location): void {
  const dropped: boolean[] = [];
  for (const token of children) {
    if (token.type === 'link_open') {
      const href = linkTarget(String(token.attrGet('href') ?? ''), location);
      dropped.push(href === undefined);
      if (href === undefined) toWords(token, '');
      else token.attrs = [['href', href]];
    } else if (token.type === 'link_close') {
      if (dropped.pop()) toWords(token, '');
    } else if (token.type === 'image') {
      const url = relativeUrl(String(token.attrGet('src') ?? ''), location);
      const title = token.attrGet('title');
      if (url === undefined) toWords(token, token.content);
      else token.attrs = [['src', `${url}?image=1`], ['alt', ''], ...(title ? [['title', String(title)] as [string, string]] : [])];
    }
  }
}

/** Makes a token plain text, rendered escaped. */
function toWords(token: Token, words: string): void {
  token.type = 'text';
  token.tag = '';
  token.attrs = null;
  token.children = null;
  token.content = words;
  token.nesting = 0;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function linkTarget(href: string, location: Location): string | undefined {
  if (SCHEME.test(href)) return /^https?:\/\//i.test(href) ? href : undefined;
  return relativeUrl(href, location);
}

/**
 * The dashboard's URL of a relative path from the file at `location`, when it stays inside the file's place (the
 * agents count as inside /manual, where the workspace has them); undefined otherwise. Its query and fragment are
 * dropped, and each name is decoded, so an encoded separator is a name and not a way out.
 */
function relativeUrl(href: string, location: Location): string | undefined {
  if (SCHEME.test(href) || href.startsWith('/')) return undefined;
  const path = href.replace(/[?#].*$/s, '');
  if (path === '') return undefined;
  const names: string[] = [];
  for (const part of path.split('/')) {
    let name: string;
    try { name = decodeURIComponent(part); } catch { return undefined; }
    if (name.includes('/') || name.includes('\u0000')) return undefined;
    names.push(name);
  }
  const scope = location.root === 'agents' ? '/manual' : location.place;
  const from = posix.dirname(workspacePath(location));
  const resolved = posix.join(from, ...names).replace(/\/$/, '');
  if (resolved !== scope && !resolved.startsWith(`${scope}/`)) return undefined;
  return filesUrl(resolved);
}

const oneDecimal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en-US');

/** 999 B, 2.0 KiB, 3.0 MiB, 1.5 GiB. */
export function bytes(size: number): string {
  if (size < 1024) return `${whole.format(size)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${oneDecimal.format(value)} ${units[unit]}`;
}
