/**
 * The service worker (ADR 0070): shows each Web Push as a notification, and on a click brings the app forward, or
 * opens `/`. The push is `{ title, tag, text, icon }` (docs/client-contract.md, ブラウザへの通知). A push with a `url`
 * of the sentinel's approvals window (ADR 0096) opens that page instead.
 */

interface ExtendableEvent extends Event { waitUntil(promise: Promise<unknown>): void }
interface PushEvent extends ExtendableEvent { data: { json(): unknown } | null }
interface NotificationEvent extends ExtendableEvent { notification: Notification }
interface WindowClient { url: string; focus(): Promise<unknown> }
declare const self: {
  addEventListener(type: 'push', listener: (event: PushEvent) => void): void;
  addEventListener(type: 'notificationclick', listener: (event: NotificationEvent) => void): void;
  registration: { showNotification(title: string, options: NotificationOptions): Promise<void> };
  clients: { matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClient[]>; openWindow(url: string): Promise<unknown> };
};

self.addEventListener('push', event => {
  let push: { title?: string; tag?: string; text?: string; icon?: string; url?: unknown } = {};
  // A push that cannot be read still shows, with the title alone: a browser must show every push it gets.
  try { push = (event.data?.json() ?? {}) as typeof push; } catch { /* the title alone */ }
  event.waitUntil(self.registration.showNotification(push.title ?? 'natsumi', {
    body: push.text ?? '', ...(push.tag ? { tag: push.tag } : {}), ...(push.icon ? { icon: push.icon } : {}),
    ...(windowPath(push.url) ? { data: { url: push.url } } : {}),
  }));
});

/** Only a page of the sentinel's approvals window, a path of this origin, is opened from a push. */
function windowPath(url: unknown): url is string {
  return typeof url === 'string' && /^\/dashboard\/sentinel\/approvals\/ap-[A-Za-z0-9_-]{1,100}$/.test(url);
}

/**
 * A click brings the chat or the settings forward, or opens the chat: a tab of the dashboard is left as it is. A
 * sentinel's approval opens its page, where it is answered.
 */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data as { url?: unknown } | null)?.url;
  if (windowPath(url)) {
    event.waitUntil(self.clients.openWindow(url));
    return;
  }
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    const app = windows.find(client => ['/', '/settings'].includes(new URL(client.url).pathname));
    return app ? app.focus() : self.clients.openWindow('/');
  }));
});

export {};
