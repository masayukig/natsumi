import type { WebPushSubscription } from '../../shared/protocol/envelope.ts';
import type { AppEvent } from '../core/events.ts';

/**
 * This browser's Web Push subscription (ADR 0065): the service worker at `/app/sw.js` with the scope `/`, and the
 * subscription made with the server's VAPID key, which the page carries. Without the key the server sends none.
 */
const KEY = document.querySelector<HTMLMetaElement>('meta[name="natsumi-push-key"]')?.content;
const WORKER = '/app/sw.js';

type Dispatch = (event: AppEvent) => void;

const supported = () => Boolean(KEY) && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/**
 * The subscription this browser has. One made with another key (the server's key was made anew) is refused by the push
 * service with 401 or 403, which the server does not take as gone: it is ended here and made again with the page's key.
 */
export async function checkPush(dispatch: Dispatch): Promise<void> {
  if (!supported()) { dispatch({ type: 'push-checked', supported: false }); return; }
  try {
    const registration = await navigator.serviceWorker.getRegistration('/');
    let subscription = await registration?.pushManager.getSubscription();
    if (subscription && !sameKey(subscription.options.applicationServerKey, bytes(KEY!))) {
      await subscription.unsubscribe();
      subscription = Notification.permission === 'granted' ? await registration!.pushManager.subscribe(options()) : null;
    }
    dispatch({ type: 'push-checked', supported: true,
      ...(subscription && Notification.permission === 'granted' ? { subscription: plain(subscription) } : {}) });
  } catch {
    dispatch({ type: 'push-checked', supported: true });
  }
}

export async function subscribePush(dispatch: Dispatch): Promise<void> {
  try {
    if (await Notification.requestPermission() !== 'granted') { dispatch({ type: 'push-checked', supported: true, error: 'denied' }); return; }
    await navigator.serviceWorker.register(WORKER, { scope: '/' });
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe(options());
    dispatch({ type: 'push-checked', supported: true, subscription: plain(subscription) });
  } catch {
    dispatch({ type: 'push-checked', supported: true, error: 'failed' });
  }
}

const options = (): PushSubscriptionOptionsInit => ({ userVisibleOnly: true, applicationServerKey: bytes(KEY!) });

function sameKey(held: ArrayBuffer | null, key: Uint8Array): boolean {
  if (!held || held.byteLength !== key.length) return false;
  const bytes = new Uint8Array(held);
  return key.every((byte, index) => byte === bytes[index]);
}

/** Ends the subscription in the browser; the server drops its copy when the push service next answers 404 or 410. */
export async function unsubscribePush(dispatch: Dispatch): Promise<void> {
  try {
    await (await (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription())?.unsubscribe();
  } catch { /* nothing to end */ }
  dispatch({ type: 'push-checked', supported: true });
}

function plain(subscription: PushSubscription): WebPushSubscription {
  const { endpoint, keys } = subscription.toJSON();
  return { endpoint: endpoint!, keys: { p256dh: keys!.p256dh!, auth: keys!.auth! } };
}

function bytes(base64url: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64url.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
}
