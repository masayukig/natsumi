/**
 * What the mediator asks of the outside after an event. main.ts carries each out with an adapter, and what comes of it
 * comes back as an event.
 */
export type Effect =
  /** Open the socket to `/v1/ws`. */
  | { kind: 'connect' }
  /** Send this text on the open socket. */
  | { kind: 'send'; data: string }
  /** Hand back `reconnect-due` after this long. */
  | { kind: 'reconnect-later'; delayMs: number }
  /** Keep the device the server gave, for the next page too. */
  | { kind: 'remember-device'; deviceId: string }
  /** Fetch the avatar's list, and hand back `avatar-loaded` or `avatar-failed`. */
  | { kind: 'fetch-avatar' }
  /** Load the page again: the server sends a browser without a live session to log in. */
  | { kind: 'sign-in-again' }
  /** Look for this browser's Web Push subscription, subscribe it, or end it; each hands back `push-checked`. */
  | { kind: 'check-push' | 'subscribe-push' | 'unsubscribe-push' };
