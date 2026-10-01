import type { AvatarManifest } from '../../shared/protocol/avatar.ts';
import type { WebPushSubscription } from '../../shared/protocol/envelope.ts';
import type { Decision, Placement } from '../../shared/protocol/conversation.ts';
import type { SettingKey } from '../../shared/protocol/settings.ts';
import type { SettingInput } from './settings.ts';

/**
 * What happens to the browser's app: the owner's doings, handed up by the view, and the outside world's, handed in by
 * the adapters. Each goes to the mediator, which alone decides what follows.
 */
export type AppEvent =
  // The page and its socket.
  | { type: 'started' }
  | { type: 'socket-opened' }
  | { type: 'socket-message'; text: string }
  | { type: 'socket-closed'; code: number }
  | { type: 'reconnect-due' }
  | { type: 'reconnect-now' }
  | { type: 'avatar-loaded'; manifest: AvatarManifest }
  | { type: 'avatar-failed' }
  | { type: 'visibility'; visible: boolean }
  | { type: 'push-checked'; supported: boolean; subscription?: WebPushSubscription; error?: 'denied' | 'failed' }
  // The chat.
  | { type: 'send'; text: string }
  | { type: 'retry-send'; requestId: string }
  | { type: 'dismiss-send'; requestId: string }
  | { type: 'ack-notice'; notificationId: string }
  // The approvals: choosing, then confirming or taking it back.
  | { type: 'approval-edit'; approvalId: string }
  | { type: 'approval-choose'; approvalId: string; decision: Decision; text?: string; placement?: Placement }
  | { type: 'approval-confirm'; approvalId: string }
  | { type: 'approval-cancel'; approvalId: string }
  // The settings.
  | { type: 'setting-submit'; input: SettingInput }
  | { type: 'setting-reset'; key: SettingKey }
  | { type: 'push-toggle'; on: boolean };
