import type { AvatarManifest } from '../../shared/protocol/avatar.ts';
import type { WebPushSubscription } from '../../shared/protocol/envelope.ts';
import type { Decision, Placement, ShownAttachment } from '../../shared/protocol/conversation.ts';
import type { SettingKey } from '../../shared/protocol/settings.ts';
import type { SettingInput } from './settings.ts';

/** A file as the page hands it over: a browser's File, of which the core reads these and nothing more. */
export interface UploadFile { readonly name: string; readonly size: number; readonly type: string }

/** Why an upload did not go through: past the server's limit, the session gone, or anything else. */
export type UploadError = 'too-large' | 'unauthorized' | 'failed';

/** Why the notifications were not turned on, or not stopped (ADR 0070). */
export type PushError = 'denied' | 'failed' | 'not-stopped';

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
  | { type: 'push-checked'; supported: boolean; subscription?: WebPushSubscription; error?: PushError }
  // The chat.
  | { type: 'send'; text: string }
  | { type: 'retry-send'; requestId: string }
  | { type: 'dismiss-send'; requestId: string }
  | { type: 'ack-notice'; notificationId: string }
  // The files of the message being written (ADR 0071): chosen, pictured, uploaded or not, and taken back.
  | { type: 'attach'; files: UploadFile[] }
  | { type: 'attachment-preview'; localId: string; url: string }
  | { type: 'upload-done'; localId: string; upload: ShownAttachment }
  | { type: 'upload-failed'; localId: string; code: UploadError }
  | { type: 'remove-attachment'; localId: string }
  // The approvals: choosing, then confirming or taking it back.
  | { type: 'approval-edit'; approvalId: string }
  | { type: 'approval-choose'; approvalId: string; decision: Decision; text?: string; placement?: Placement }
  | { type: 'approval-confirm'; approvalId: string }
  | { type: 'approval-cancel'; approvalId: string }
  // The settings.
  | { type: 'setting-submit'; input: SettingInput }
  | { type: 'setting-reset'; key: SettingKey }
  | { type: 'push-toggle'; on: boolean };
