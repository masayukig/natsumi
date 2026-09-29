import type { AppEvent } from '../core/events.ts';

/**
 * The socket to `/v1/ws` (docs/client-contract.md, ブラウザ): the browser sends the login's cookie and its Origin by
 * itself, and no Authorization. What happens on it comes back as events; what to send is the mediator's to say.
 */
export interface Socket { send(data: string): void; close(): void }

/** `wss://` on an https page, and `ws://` on the fake server's http one. */
export function socketUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/v1/ws`;
}

export function openSocket(url: string, dispatch: (event: AppEvent) => void): Socket {
  const socket = new WebSocket(url);
  let closed = false;
  socket.addEventListener('open', () => dispatch({ type: 'socket-opened' }));
  socket.addEventListener('message', message => {
    if (typeof message.data === 'string') dispatch({ type: 'socket-message', text: message.data });
  });
  socket.addEventListener('close', event => {
    if (closed) return;
    closed = true;
    dispatch({ type: 'socket-closed', code: event.code });
  });
  return {
    send: data => { if (socket.readyState === WebSocket.OPEN) socket.send(data); },
    // Closed by the page: its end is not news to the mediator, which asked for a new one already.
    close: () => { closed = true; socket.close(); },
  };
}
