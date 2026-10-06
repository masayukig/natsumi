import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { FAKE_SESSION_COOKIE, startFakeServer, type FakeServer } from '../../src/fake-server/main.ts';

/**
 * The browser's app put together and run in headless Chromium against the fake server (ADR 0058): open the chat and
 * send, see her reply with her face and her images, approve a post through its confirmation, and change a setting and
 * put it back. Each runs at a phone's size and at a desktop's.
 *
 *   npm run test:browser                          (builds dist/web first)
 *   NATSUMI_SCREENSHOTS=<dir> npm run test:browser   (also saves screenshots there)
 */

const BUNDLE = fileURLToPath(new URL('../../dist/web/', import.meta.url));
const SCREENSHOTS = process.env.NATSUMI_SCREENSHOTS;
const [COOKIE_NAME, COOKIE_VALUE] = FAKE_SESSION_COOKIE.split('=') as [string, string];
/** A whole 1×1 PNG, base64, for a picture the browser can draw. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const SIZES = [
  { name: 'phone', options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
  { name: 'desktop', options: { viewport: { width: 1280, height: 860 } } },
] as const;

let browser: Browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

/** A fresh fake server and a logged-in page on it, with every console error and CSP refusal kept. */
async function open(size: typeof SIZES[number], path = '/'): Promise<{ page: Page; server: FakeServer; context: BrowserContext; errors: string[]; done: () => Promise<void> }> {
  const server = await startFakeServer({ port: 0, replyDelayMs: 400, short: true, approvalDelayMs: 0, sendDelayMs: 200,
    switchDelayMs: 400, log: false, bundleDirectory: BUNDLE });
  const base = `http://localhost:${server.port}`;
  const context = await browser.newContext({ ...size.options, baseURL: base, colorScheme: 'light' });
  await context.addCookies([{ name: COOKIE_NAME, value: COOKIE_VALUE, url: base }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(path);
  await page.getByRole('status').filter({ hasText: 'つながっています' }).waitFor();
  return { page, server, context, errors, done: async () => { await context.close(); await server.close(); } };
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

for (const size of SIZES) {
  describe(`at a ${size.name}'s size`, () => {
    test('the chat opens logged in, shows her name and face, and a message sent is answered with her face', async () => {
      const { page, errors, done } = await open(size);
      try {
        await assert.doesNotReject(page.locator('.head .name', { hasText: 'なつみ' }).waitFor());
        assert.match(await page.locator('.head img.face').getAttribute('src') ?? '', /^\/v1\/avatar\/[0-9a-f]+\/icons\/\w+\.(webp|png)$/);
        await page.getByLabel('メッセージ').fill('こんにちは');
        await page.getByRole('button', { name: '送る', exact: true }).click();
        // The field is emptied once sent, when the view is drawn next.
        await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.value === '');
        await page.locator('.row.owner .text', { hasText: 'こんにちは' }).waitFor();
        const reply = page.locator('.row.natsumi', { hasText: '「こんにちは」だね。' });
        await reply.waitFor();
        assert.match(await reply.locator('img.face').getAttribute('src') ?? '', /icons\/laughing\.(webp|png)$/);
        assert.equal(await page.locator('.head img.face').evaluate((image: HTMLImageElement) => image.naturalWidth > 0), true);
        await shoot(page, `chat-${size.name}`);
        await page.emulateMedia({ colorScheme: 'dark' });
        assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(246, 245, 242)', 'dark follows the system');
        await shoot(page, `chat-dark-${size.name}`);
        assert.deepEqual(errors, []);
      } finally { await done(); }
    });

    test('her images are shown, the ones in the history and one she draws now', async () => {
      const { page, errors, done } = await open(size);
      try {
        const drawn = page.locator('.row.natsumi img[src="/v1/images/image-fake-happy"]').first();
        await drawn.waitFor();
        await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.images img')].every(image => image.complete && image.naturalWidth > 0));
        await page.getByLabel('メッセージ').fill('絵を描いて');
        await page.getByRole('button', { name: '送る', exact: true }).click();
        const reply = page.locator('.row.natsumi', { hasText: '「絵を描いて」だね。' });
        await reply.locator('.images img').waitFor();
        assert.equal(await reply.locator('.images img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), true);
        assert.deepEqual(errors, []);
      } finally { await done(); }
    });

    test('files are attached by the clip, a paste and a drop, shown as chips, and go with the message (ADR 0071)', async () => {
      const { page, errors, done } = await open(size);
      try {
        await page.locator('.composer input[type="file"]').setInputFiles([
          { name: '報告書.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 fake') },
        ]);
        // A picture pasted into the field, and a file dropped on the chat.
        await page.evaluate(async png => {
          const bytes = Uint8Array.from(atob(png), character => character.charCodeAt(0));
          const pasted = new DataTransfer();
          pasted.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
          document.querySelector('.composer textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: pasted, bubbles: true, cancelable: true }));
          const dropped = new DataTransfer();
          dropped.items.add(new File(['memo'], 'memo.txt', { type: 'text/plain' }));
          const chat = document.querySelector('.chat')!;
          chat.dispatchEvent(new DragEvent('dragover', { dataTransfer: dropped, bubbles: true, cancelable: true }));
          chat.dispatchEvent(new DragEvent('drop', { dataTransfer: dropped, bubbles: true, cancelable: true }));
        }, PNG);
        const chips = page.locator('.composer .chip');
        await page.waitForFunction(() => document.querySelectorAll('.composer .chip.ready').length === 3);
        assert.deepEqual(await chips.locator('.chip-name').allTextContents(), ['報告書.pdf', 'shot.png', 'memo.txt']);
        assert.equal(await chips.nth(1).locator('img.thumb').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), true,
          'an image is shown small');
        await shoot(page, `attachments-${size.name}`);
        await page.getByRole('button', { name: 'memo.txt を取り消す' }).click();
        await page.waitForFunction(() => document.querySelectorAll('.composer .chip').length === 2);
        await page.getByLabel('メッセージ').fill('これ見て');
        await page.getByRole('button', { name: '送る', exact: true }).click();
        const own = page.locator('.row.owner', { hasText: 'これ見て' }).last();
        await own.locator('.file a', { hasText: '報告書.pdf' }).waitFor();
        assert.match(await own.locator('.file a').getAttribute('href') ?? '', /^\/v1\/uploads\/upload-/);
        await own.locator('.images img').waitFor();
        await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.row.owner .images img')].every(image => image.complete && image.naturalWidth > 0));
        assert.equal(await page.locator('.composer .chip').count(), 0, 'the chips go with the message');
        await shoot(page, `attachments-sent-${size.name}`);
        assert.deepEqual(errors, []);
      } finally { await done(); }
    });

    test('an approval goes only after its confirmation; taking it back sends nothing', async () => {
      const { page, errors, done } = await open(size);
      try {
        const card = page.locator('[data-approval-id="approval-review"]');
        await card.scrollIntoViewIfNeeded();
        await card.getByRole('button', { name: '承認…' }).click();
        const confirm = card.getByRole('alertdialog');
        await confirm.waitFor();
        assert.match(await confirm.textContent() ?? '', /work\/#dev/);
        await card.scrollIntoViewIfNeeded();
        await shoot(page, `approval-confirm-${size.name}`);
        await confirm.getByRole('button', { name: 'やめる' }).click();
        await card.getByRole('button', { name: '承認…' }).waitFor();

        await card.getByRole('button', { name: '直す' }).click();
        await card.getByLabel('送る本文').fill('11 時からでお願いします。');
        await card.getByRole('button', { name: 'この本文で送る…' }).click();
        assert.match(await card.getByRole('alertdialog').textContent() ?? '', /11 時からでお願いします。/);
        await card.getByRole('button', { name: '直して送る' }).click();
        await card.waitFor({ state: 'detached' });
        await page.locator('.result', { hasText: 'work/#dev に送りました。' }).waitFor();

        const lunch = page.locator('[data-approval-id="approval-lunch"]');
        await lunch.getByRole('button', { name: '却下…' }).click();
        await lunch.getByRole('button', { name: '却下する' }).click();
        await page.locator('.result', { hasText: 'work/#random への投稿を却下しました。' }).waitFor();
        assert.deepEqual(errors, []);
      } finally { await done(); }
    });

    test('a setting is changed, checked by its rules, shown overridden, and put back to the config’s value', async () => {
      const { page, errors, done } = await open(size, '/settings');
      try {
        const calls = page.locator('[data-setting="eventModelCalls"]');
        await calls.getByLabel(/新しい値/).fill('0');
        await calls.getByRole('button', { name: '変える' }).click();
        await calls.getByRole('alert').filter({ hasText: '1 以上の整数' }).waitFor();
        await calls.getByLabel(/新しい値/).fill('12');
        await calls.getByRole('button', { name: '変える' }).click();
        await calls.locator('.value', { hasText: '12 回' }).waitFor();
        assert.equal(await calls.locator('.badge').textContent(), '上書き中');
        assert.equal(await calls.locator('.config').textContent(), '8 回');

        const route = page.locator('[data-setting="modelRoute"]');
        await route.getByLabel('新しい値').selectOption('plus');
        await route.getByRole('button', { name: '変える' }).click();
        await route.locator('.next-turn', { hasText: '次のターンから' }).waitFor();
        assert.equal(await route.getByLabel('新しい値').inputValue(), 'plus', 'the choice shown is the value in force');
        assert.equal(await page.locator('[data-setting="turnFold"]').getByLabel('新しい値').inputValue(), 'off');
        await shoot(page, `settings-${size.name}`);
        await route.locator('.next-turn').waitFor({ state: 'detached' });

        await calls.getByRole('button', { name: 'config に戻す' }).click();
        await calls.locator('.value', { hasText: '8 回' }).waitFor();
        assert.equal(await calls.locator('.badge').count(), 0);
        assert.deepEqual(errors, []);
      } finally { await done(); }
    });
  });
}

test('the pages link to one another, and logging out is a form posted to the dashboard', async () => {
  const { page, done } = await open(SIZES[0]);
  try {
    await page.getByRole('link', { name: '設定' }).click();
    await page.waitForURL('**/settings');
    await page.locator('[data-setting="modelRoute"]').waitFor();
    assert.equal(await page.getByRole('link', { name: 'ダッシュボード' }).getAttribute('href'), '/dashboard');
    await page.getByRole('link', { name: 'チャット' }).click();
    await page.waitForURL(url => url.pathname === '/');
    const form = page.locator('form.logout');
    assert.deepEqual([await form.getAttribute('method'), await form.getAttribute('action')], ['post', '/dashboard/logout']);
    await form.getByRole('button', { name: 'ログアウト' }).click();
    await page.waitForURL(url => url.pathname === '/fake-login' || url.pathname === '/');
  } finally { await done(); }
});

test('the socket is opened again when the server comes back, and the conversation carries on', async () => {
  const { page, server, context, done } = await open(SIZES[1]);
  let again: FakeServer | undefined;
  try {
    // The server restarts: its sockets are closed, and a new one (a new epoch) listens on the same port a moment later.
    await server.close();
    await page.getByRole('status').filter({ hasText: 'つなぎ直しています' }).waitFor();
    again = await startFakeServer({ port: server.port, replyDelayMs: 400, short: true, approvalDelayMs: 0, sendDelayMs: 200,
      switchDelayMs: 400, log: false, bundleDirectory: BUNDLE });
    await page.getByRole('status').filter({ hasText: 'つながっています' }).waitFor({ timeout: 15_000 });
    await page.getByLabel('メッセージ').fill('もどった？');
    await page.getByRole('button', { name: '送る', exact: true }).click();
    await page.locator('.row.natsumi', { hasText: '「もどった？」だね。' }).waitFor();
  } finally {
    await context.close();
    await again?.close();
  }
  void done;
});
