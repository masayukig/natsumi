import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppEvent } from '../src/web/core/events.ts';

/**
 * The browser's side of stopping the notifications (ADR 0070), with the browser's objects stood in for. The adapter is
 * left out of the server's typecheck (it is DOM code), so it is loaded by a path the checker does not follow.
 */

const subscription = { endpoint: 'https://push.example.test/one', keys: { p256dh: 'BKey', auth: 'auth' } };

/** A browser whose registration and subscription are as given; `unsubscribe` is what the subscription answers. */
function browser(held: { registration: boolean; subscription: boolean; unsubscribe?: () => Promise<boolean> }): void {
  const pushSubscription = { toJSON: () => subscription, unsubscribe: held.unsubscribe ?? (async () => true) };
  const registration = { pushManager: { getSubscription: async () => (held.subscription ? pushSubscription : null) } };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, value: { serviceWorker: { getRegistration: async () => (held.registration ? registration : undefined) } },
  });
}

Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => ({ content: 'AAAA' }) } });
const adapter = './../src/web/adapters/push.ts';
const { unsubscribePush } = await import(adapter) as { unsubscribePush: (dispatch: (event: AppEvent) => void) => Promise<void> };

async function stop(): Promise<AppEvent[]> {
  const events: AppEvent[] = [];
  await unsubscribePush(event => events.push(event));
  return events;
}

test('notifications stopped in the browser are off', async () => {
  browser({ registration: true, subscription: true });
  assert.deepEqual(await stop(), [{ type: 'push-checked', supported: true }]);
});

test('with no subscription in the browser there is nothing to stop, and they are off', async () => {
  browser({ registration: false, subscription: false });
  assert.deepEqual(await stop(), [{ type: 'push-checked', supported: true }]);
  browser({ registration: true, subscription: false });
  assert.deepEqual(await stop(), [{ type: 'push-checked', supported: true }]);
});

test('a subscription the browser could not end stays on, with why', async () => {
  for (const unsubscribe of [async () => { throw new Error('push service unreachable'); }, async () => false]) {
    browser({ registration: true, subscription: true, unsubscribe });
    assert.deepEqual(await stop(), [{ type: 'push-checked', supported: true, subscription, error: 'not-stopped' }]);
  }
});
