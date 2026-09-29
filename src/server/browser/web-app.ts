import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserReturn, Outcome } from '../github-login.ts';
import { html, type Html } from '../html.ts';
import type { BrowserSessions } from './session-cookie.ts';

/**
 * The chat (`/`) and the settings (`/settings`) in the browser (ADR 0058): one page for both, which loads the bundle the
 * browser's app is built into and nothing else; the screens are the bundle's to draw, and it talks to the server over
 * `/v1/ws` as one more device. The bundle's files are served under `/app/` by name, to anyone: they are the code of a
 * public repository, with no secret in them.
 *
 * Without a live session the page sends the browser to log in, and the login comes back to the page it began at.
 */

export const WEB_APP_PAGES: readonly BrowserReturn[] = ['/', '/settings'];
export const BUNDLE_PATH = '/app/';
export const BUNDLE_SCRIPT = 'app.js';
export const BUNDLE_STYLE = 'app.css';

/** `dist/web/` in a checkout (built beside `src/`), and `/app/dist/web/` in the image (beside `dist/src/`). */
export const BUNDLE_DIRECTORIES = ['../../../dist/web/', '../../../web/'].map(path => fileURLToPath(new URL(path, import.meta.url)));

/** A file of the bundle: a plain name, no directories, no dot in front. */
const BUNDLE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BUNDLE_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export interface WebAppOptions {
  publicOrigin: string;
  browser: BrowserSessions;
  /** The browser's login, going back to the page it began at. */
  login: { startBrowser(returnTo: BrowserReturn): Outcome };
  /** The avatar's display name, for the page's title (ADR 0057). */
  name: string;
  /** Where the bundle is read from; by default the first of BUNDLE_DIRECTORIES that has the script. */
  bundleDirectory?: string;
}

export class WebApp {
  private readonly options: WebAppOptions;
  private readonly csp: string;

  constructor(options: WebAppOptions) {
    this.options = options;
    const socket = new URL(options.publicOrigin);
    socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
    // Nothing inline and nothing from elsewhere; the socket is named too, for the browsers whose 'self' leaves it out.
    this.csp = ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:",
      `connect-src 'self' ${socket.origin}`, "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');
  }

  /** Whether the path is the browser app's to answer. */
  static owns(pathname: string): boolean {
    return (WEB_APP_PAGES as readonly string[]).includes(pathname) || pathname.startsWith(BUNDLE_PATH);
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    response.setHeader('content-security-policy', this.csp);
    response.setHeader('x-frame-options', 'DENY');
    if (request.method !== 'GET') return send(response, 405, message('この方法では受け付けていません'), { allow: 'GET' });
    if (url.pathname.startsWith(BUNDLE_PATH)) return this.bundleFile(response, url.pathname.slice(BUNDLE_PATH.length));

    const page = url.pathname as BrowserReturn;
    const { browser, login } = this.options;
    const session = browser.session(request);
    if (!session) {
      const cleared: Record<string, string[]> = browser.presented(request) ? { 'set-cookie': browser.cleared() } : {};
      const outcome = login.startBrowser(page);
      if ('location' in outcome) {
        response.writeHead(302, { location: outcome.location, ...cleared }).end();
        return;
      }
      return send(response, outcome.status, message('ログインを始められませんでした'), cleared);
    }
    const directory = await this.bundleDirectory();
    const style = directory ? await exists(join(directory, BUNDLE_STYLE)) : false;
    send(response, 200, directory ? appPage(this.options.name, style) : missingPage(this.options.name), { 'set-cookie': browser.renewed(session) });
  }

  private async bundleFile(response: ServerResponse, name: string): Promise<void> {
    const type = BUNDLE_TYPES[name.slice(name.lastIndexOf('.'))];
    const directory = BUNDLE_FILE.test(name) && type ? await this.bundleDirectory() : undefined;
    // Read on every request: a bundle rebuilt while the server runs is served as it is now.
    const file = directory ? await readFile(join(directory, name)).catch(() => undefined) : undefined;
    if (!file) return send(response, 404, message('見つかりません'));
    response.writeHead(200, { 'content-type': type!, 'content-length': file.length }).end(file);
  }

  private async bundleDirectory(): Promise<string | undefined> {
    const candidates = this.options.bundleDirectory ? [this.options.bundleDirectory] : BUNDLE_DIRECTORIES;
    for (const directory of candidates) if (await exists(join(directory, BUNDLE_SCRIPT))) return directory;
    return undefined;
  }
}

const exists = (path: string) => readFile(path).then(() => true, () => false);

function appPage(name: string, style: boolean): Html {
  return html`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
${style ? html`<link rel="stylesheet" href="${BUNDLE_PATH}${BUNDLE_STYLE}">` : ''}
<script type="module" src="${BUNDLE_PATH}${BUNDLE_SCRIPT}"></script>
</head>
<body>
<div id="app"></div>
<noscript><p>この画面には JavaScript が要ります。<a href="/dashboard">ダッシュボード</a>は JavaScript なしでも見られます。</p></noscript>
</body>
</html>
`;
}

function missingPage(name: string): Html {
  return html`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
</head>
<body>
<main><h1>${name}</h1><p>画面の JS がまだありません。ブラウザのアプリをビルドすると、ここで話せます。</p><p><a href="/dashboard">ダッシュボードへ</a></p></main>
</body>
</html>
`;
}

function message(heading: string): Html {
  return html`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${heading}</title></head><body><main><h1>${heading}</h1><p><a href="/">はじめへ</a></p></main></body></html>
`;
}

function send(response: ServerResponse, status: number, body: Html, headers: Record<string, string | string[]> = {}) {
  const text = Buffer.from(body.text, 'utf8');
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': text.length, ...headers }).end(text);
}
