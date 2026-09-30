import { FILES_PATH } from './dashboard-files.ts';
import { html, type Html } from './html.ts';
import { DEFAULT_SELF } from './prompts.ts';
import type { LoopDashboardState } from './thinking-loop.ts';

/**
 * The dashboard's pages (ADR 0049), built on the server with no build step. Every value goes through `html`, so
 * nothing shown is read as markup. There is no inline script or style: the CSP forbids both, and the page takes its
 * look and its refreshing from the two static files.
 */

export const STATIC_FILES = { css: '/dashboard/static/dashboard.css', js: '/dashboard/static/dashboard.js' } as const;
export const STATUS_PATH = '/dashboard/status';
export const LOGOUT_PATH = '/dashboard/logout';
export const SIGNED_OUT_PATH = '/dashboard/signed-out';
export const TURNS_PATH = '/dashboard/turns';
export const WAITS_PATH = '/dashboard/waits';
/** The failures and waits alone, for the script to put in place; like STATUS_PATH it answers 401, never a login. */
export const WAITS_LIVE_PATH = '/dashboard/waits/live';
export const MEMOS_PATH = '/dashboard/memos';
export const DOVE_PATH = '/dashboard/dove';
export const DEVICES_PATH = '/dashboard/devices';
export const STATS_PATH = '/dashboard/stats';
export const APPROVALS_PATH = '/dashboard/approvals';
/** The fragments the script refreshes: without a live session they answer 401, as the script cannot follow a login. */
export const REFRESHED_PATHS: ReadonlySet<string> = new Set([STATUS_PATH, WAITS_LIVE_PATH]);

/** A turn's page, recorded or in progress (ADR 0049). */
export const turnPath = (turnId: string) => `${TURNS_PATH}/${encodeURIComponent(turnId)}`;

/** The sections of the dashboard. Those not built yet are listed as coming, so the frame does not move when they are. */
const SECTIONS: { label: string; href?: string }[] = [
  { label: 'いまの状態', href: '/dashboard' },
  { label: 'ターン', href: TURNS_PATH },
  { label: '失敗と待ち', href: WAITS_PATH },
  { label: '一行メモ', href: MEMOS_PATH },
  { label: 'ポッポさん', href: DOVE_PATH },
  { label: '承認の履歴', href: APPROVALS_PATH },
  { label: '端末', href: DEVICES_PATH },
  { label: '統計', href: STATS_PATH },
  { label: 'ファイル', href: FILES_PATH },
];

export interface DashboardStatus {
  /** The heartbeat in `.natsumi/status.json`, as `checkHealth` reads it. */
  server: { healthy: boolean; reason: string; startedAt?: string; updatedAt?: string };
  loop: LoopDashboardState;
  timeZone: string;
}

/**
 * A whole page: the header, the navigation, the logout and `main`. Pages before login have no navigation. The header and
 * the title carry the ID of the avatar the server started with (ADR 0057); natsumi's when left out.
 */
export function page(title: string, main: Html, options: { signedIn: boolean; current?: string; avatarId?: string } = { signedIn: true }): Html {
  const avatarId = options.avatarId ?? DEFAULT_SELF.id;
  return html`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${title} — ${avatarId}</title>
<link rel="stylesheet" href="${STATIC_FILES.css}">
<script src="${STATIC_FILES.js}" defer></script>
</head>
<body>
<header class="top">
<h1>${avatarId}</h1>
${options.signedIn && html`<nav aria-label="ダッシュボード"><ul>${SECTIONS.map(section => html`<li>${section.href
    ? html`<a href="${section.href}"${section.label === options.current ? html` aria-current="page"` : ''}>${section.label}</a>`
    : html`<span class="soon">${section.label}<small>準備中</small></span>`}</li>`)}</ul></nav>
<nav aria-label="ほかの画面"><ul><li><a href="/">話す</a></li><li><a href="/settings">設定</a></li></ul></nav>
<form method="post" action="${LOGOUT_PATH}"><button type="submit">ログアウト</button></form>`}
</header>
<main>
${main}
</main>
</body>
</html>
`;
}

/** The dashboard's first page: the current state, refreshed in place by the script. */
export function statusPage(status: DashboardStatus, avatarId?: string): Html {
  return page('いまの状態', renderStatus(status), { signedIn: true, current: 'いまの状態', avatarId });
}

/** The current-state section, also served alone for the script to put in place. */
export function renderStatus({ server, loop, timeZone }: DashboardStatus): Html {
  const at = (iso: string | null | undefined) => iso ? localTime(iso, timeZone) : '';
  const { routes, context, turn } = loop;
  const inUse = routes.routes.find(route => route.name === routes.current);
  const share = context.tokens === null ? undefined : Math.round((context.tokens / context.compactionThreshold) * 100);
  return html`<section id="status" data-refresh="${STATUS_PATH}" aria-live="polite">
<h2>いまの状態</h2>
<dl class="facts">
<div><dt>サーバー</dt><dd>${server.healthy
    ? html`<span class="ok">動いている</span>`
    : html`<span class="bad">応答がない</span> <code>${server.reason}</code>`}
${server.updatedAt && html`<small>最後の heartbeat ${at(server.updatedAt)}</small>`}
${server.startedAt && html`<small>起動 ${at(server.startedAt)}</small>`}</dd></div>
<div><dt>思考ループ</dt><dd>${loop.unavailable
    ? html`<span class="bad">話せない</span> <code>${loop.unavailable}</code>`
    : html`<span class="ok">話せる</span>`}</dd></div>
<div><dt>経路</dt><dd>${routes.current === null ? html`<span class="bad">使っていない</span>`
    : html`<strong>${routes.current}</strong>${inUse && html` <small>${inUse.provider} / ${inUse.model}</small>`}`}
${routes.chosen !== routes.current && html`<small class="note">次のターンから ${routes.chosen}</small>`}
${routes.routes.length > 0 && html`<ul class="routes">${routes.routes.map(route => html`<li>${route.name}
<small>${route.provider} / ${route.model}</small>${route.name === routes.defaultRoute && html` <small>既定</small>`}
${route.ready ? html` <span class="ok">使える</span>` : html` <span class="bad">準備ができていない</span>`}</li>`)}</ul>`}</dd></div>
<div><dt>畳み込み</dt><dd><strong>${loop.fold}</strong></dd></div>
<div><dt>文脈</dt><dd>${context.tokens === null ? 'まだ測っていない' : html`<strong>${number(context.tokens)}</strong> tokens
（compaction の閾値 ${number(context.compactionThreshold)} の ${share}%）${context.measuredAt && html` <small>${at(context.measuredAt)} に測った</small>`}`}
${context.tokens === null && html` <small>compaction の閾値 ${number(context.compactionThreshold)}</small>`}</dd></div>
<div><dt>最後の compaction</dt><dd>${loop.lastCompactionAt ? at(loop.lastCompactionAt) : 'まだない'}</dd></div>
<div><dt>実行中のターン</dt><dd>${turn === null ? 'なし' : html`<a href="${turnPath(turn.turnId)}"><strong>${PHASES[turn.phase]}</strong></a>
<code>${turn.eventKinds}</code> <small>${at(turn.startedAt)} から</small>`}</dd></div>
<div><dt>キュー</dt><dd><strong>${loop.queueLength}</strong> 件</dd></div>
</dl>
</section>`;
}

const PHASES: Record<NonNullable<LoopDashboardState['turn']>['phase'], string> = {
  turn: 'ターン中', memo: '一行メモを書いている', compaction: 'compaction 中',
};

/** The callback's own answer: a same-origin page that moves on, so the Strict cookie is sent to /dashboard (ADR 0049). */
export function signedInPage(returnTo: '/' | '/settings' | '/dashboard' = '/dashboard', avatarId = DEFAULT_SELF.id): Html {
  return html`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0; url=${returnTo}">
<title>ログインしました — ${avatarId}</title>
<link rel="stylesheet" href="${STATIC_FILES.css}">
</head>
<body>
<main><p>ログインしました。<a href="${returnTo}">${returnTo === '/dashboard' ? 'ダッシュボードへ進む' : '開いていたページへ進む'}</a></p></main>
</body>
</html>
`;
}

export function signedOutPage(avatarId?: string): Html {
  return page('ログアウトしました', html`<p>ログアウトしました。</p><p><a href="/dashboard">もう一度ログインする</a></p>`, { signedIn: false, avatarId });
}

/** A login that did not end in a session; only the fixed code is shown. */
export function refusedPage(code: string, avatarId?: string): Html {
  return page('ログインできませんでした', html`<h2>ログインできませんでした</h2><p><code>${code}</code></p>
<p><a href="/dashboard">もう一度ログインする</a></p>`, { signedIn: false, avatarId });
}

/** A short answer with no content of its own: not found, a method not taken, a request refused. */
export function messagePage(heading: string, signedIn = false, avatarId?: string): Html {
  return page(heading, html`<h2>${heading}</h2><p><a href="/dashboard">いまの状態へ</a></p>`, { signedIn, avatarId });
}

const numberFormat = new Intl.NumberFormat('en-US');
const number = (value: number) => numberFormat.format(value);

const timeFormats = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM-DD HH:MM:SS` in the configured time zone. */
export function localTime(iso: string, timeZone: string): string {
  let format = timeFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('sv-SE', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' });
    timeFormats.set(timeZone, format);
  }
  return format.format(new Date(iso));
}
