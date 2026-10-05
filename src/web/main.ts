import { h, render } from 'preact';
import { fetchAvatar } from './adapters/avatar.ts';
import { checkPush, subscribePush, unsubscribePush } from './adapters/push.ts';
import { openSocket, socketUrl, type Socket } from './adapters/socket.ts';
import { readDevice, rememberDevice } from './adapters/storage.ts';
import type { Effect } from './core/effects.ts';
import type { AppEvent } from './core/events.ts';
import { initialState, mediate } from './core/mediator.ts';
import { screenProps } from './core/props.ts';
import type { AppState } from './core/state.ts';
import { App } from './view/App.tsx';

/**
 * The browser's app put together (ADR 0058): the one module that knows the real socket, the storage and the DOM. Every
 * event goes to the mediator; its effects are carried out here with the adapters, and the view is drawn again from the
 * props of the new state.
 */

const root = document.getElementById('app')!;
let state: AppState = initialState({
  screen: location.pathname === '/settings' ? 'settings' : 'chat',
  idPrefix: crypto.randomUUID().slice(0, 8),
  ...(readDevice() ? { deviceId: readDevice()! } : {}),
});
let socket: Socket | undefined;
let drawing = false;

function dispatch(event: AppEvent): void {
  const result = mediate(state, event);
  state = result.state;
  for (const effect of result.effects) perform(effect);
  if (!drawing) {
    drawing = true;
    queueMicrotask(() => { drawing = false; draw(); });
  }
}

function perform(effect: Effect): void {
  switch (effect.kind) {
    case 'connect': {
      socket?.close();
      // Only the socket in use speaks: one closed by the page says nothing more.
      const opened = openSocket(socketUrl(location), event => { if (socket === opened) dispatch(event); });
      socket = opened;
      return;
    }
    case 'send': socket?.send(effect.data); return;
    case 'reconnect-later': setTimeout(() => dispatch({ type: 'reconnect-due' }), effect.delayMs); return;
    case 'remember-device': rememberDevice(effect.deviceId); return;
    case 'fetch-avatar': void fetchAvatar(dispatch); return;
    case 'sign-in-again': location.reload(); return;
    case 'check-push': void checkPush(dispatch); return;
    case 'subscribe-push': void subscribePush(dispatch); return;
    case 'unsubscribe-push': void unsubscribePush(dispatch); return;
  }
}

function draw(): void {
  render(h(App, { props: screenProps(state), dispatch }), root);
}

/** In sight: the tab shown and the window focused, so that replies are read only when the owner can see them. */
const seen = () => dispatch({ type: 'visibility', visible: document.visibilityState === 'visible' && document.hasFocus() });
document.addEventListener('visibilitychange', seen);
window.addEventListener('focus', seen);
window.addEventListener('blur', seen);

/**
 * The height the page can use, which on a phone shrinks while the keyboard is up: the field to write in stays above
 * it (iOS Safari keeps the layout viewport as it was, and only the visual one shrinks).
 */
function fitViewport(): void {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);
}
window.visualViewport?.addEventListener('resize', fitViewport);
window.addEventListener('resize', fitViewport);
fitViewport();

draw();
dispatch({ type: 'started' });
seen();
