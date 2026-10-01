import {
  isCount, isExpression, isObject, isString, readApproval, readList, readMessage, readPendingEvent, readResolution,
  type Approval, type ApprovalResolution, type Decision, type EventState, type Expression, type PendingEvent, type Placement,
  type ShownMessage,
} from './conversation.ts';
import { readSettingsView, type SettingKey, type SettingsView, type SettingValues } from './settings.ts';

/**
 * The envelopes of the WebSocket (docs/client-contract.md, 接続と envelope): the server's events read into typed values,
 * and the client's commands written out. A device reads with `readEnvelope` and writes with `encodeCommand`.
 *
 * Part of the contract the server and the browser's app share. It imports nothing but the rest of the contract.
 */

/** Where an event stands in its device's stream. */
export interface Position { epoch: string; streamId: string; seq: number }

/** What `session.snapshot` carries, as far as a device shows it. */
export interface Snapshot {
  deviceId: string;
  messages: ShownMessage[];
  pendingEvents: PendingEvent[];
  expression: Expression;
  readThroughMessageId: string | null;
  unreadReplyCount: number;
  unacknowledgedNotificationIds: string[];
  pendingApprovals: Approval[];
  avatarVersion?: string;
  settings?: SettingsView;
}

/** The fields of `command.accepted` a device uses; which of them there are depends on the command. */
export interface Accepted {
  messageId?: string;
  eventId?: string;
  state?: EventState | string;
  readThroughMessageId?: string;
  unreadReplyCount?: number;
  notificationId?: string;
  approvalId?: string;
  settings?: SettingsView;
  deviceId?: string;
  mode?: 'resume';
}

export type ServerEvent =
  | { type: 'session.snapshot'; snapshot: Snapshot }
  | { type: 'conversation.message'; message: ShownMessage }
  | { type: 'avatar.expression'; expression: Expression }
  | { type: 'conversation.thinking'; line: string }
  | { type: 'conversation.event.completed'; eventId: string }
  | { type: 'conversation.read'; readThroughMessageId: string; unreadReplyCount: number }
  | { type: 'notification.acked'; notificationId: string }
  | { type: 'approval.pending'; approval: Approval }
  | { type: 'approval.resolved'; resolution: ApprovalResolution }
  | { type: 'settings.changed'; settings: SettingsView }
  | { type: 'session.renewed' }
  | { type: 'command.accepted'; accepted: Accepted }
  | { type: 'command.rejected'; code: string }
  | { type: 'service.unavailable'; code: string; deviceId?: string }
  /** An event the device does not know, or one whose payload is not the contract's: it still takes its seq. */
  | { type: 'ignored' };

export interface ServerEnvelope { position: Position; requestId?: string; event: ServerEvent }

/** The events that are of the moment: they take no seq of their own and are never sent again (ADR 0017, ADR 0030). */
export const MOMENT_EVENTS: readonly ServerEvent['type'][] = ['conversation.thinking', 'session.renewed'];

export type ClientCommand =
  | { type: 'session.sync'; payload: { resume: Position | null } }
  | { type: 'conversation.send'; payload: { text: string } }
  | { type: 'conversation.read'; payload: { throughMessageId: string } }
  | { type: 'notification.ack'; payload: { notificationId: string } }
  | { type: 'approval.decide'; payload: { approvalId: string; revision: number; decision: Decision; text?: string; placement?: Placement } }
  | { type: 'settings.list'; payload: Record<string, never> }
  | { type: 'settings.set'; payload: { [K in SettingKey]: { key: K; value: SettingValues[K] } }[SettingKey] }
  | { type: 'settings.reset'; payload: { key: SettingKey } }
  | { type: 'push.register'; payload: { subscription: WebPushSubscription } };

/** A browser's Web Push subscription as `PushSubscription.toJSON()` gives it, the keys in base64url (ADR 0065). */
export interface WebPushSubscription { endpoint: string; keys: { p256dh: string; auth: string } }

export function encodeCommand(input: { requestId: string; deviceId?: string; command: ClientCommand }): string {
  const { requestId, deviceId, command } = input;
  return JSON.stringify({ v: 1, requestId, ...(deviceId ? { deviceId } : {}), type: command.type, payload: command.payload });
}

/** An envelope from the server, or undefined when the text is not one at all. */
export function readEnvelope(text: string): ServerEnvelope | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (!isObject(parsed) || parsed.v !== 1 || !isString(parsed.epoch) || !isString(parsed.streamId) || !isCount(parsed.seq) || !isString(parsed.type)) {
    return undefined;
  }
  return {
    position: { epoch: parsed.epoch, streamId: parsed.streamId, seq: parsed.seq },
    ...(isString(parsed.requestId) ? { requestId: parsed.requestId } : {}),
    event: readEvent(parsed.type, parsed.payload) ?? { type: 'ignored' },
  };
}

function readEvent(type: string, payload: unknown): ServerEvent | undefined {
  if (!isObject(payload)) return undefined;
  switch (type) {
    case 'session.snapshot': {
      const snapshot = readSnapshot(payload);
      return snapshot && { type, snapshot };
    }
    case 'conversation.message': {
      const message = readMessage(payload);
      return message && { type, message };
    }
    case 'avatar.expression':
      return isExpression(payload.expression) ? { type, expression: payload.expression } : undefined;
    case 'conversation.thinking':
      return isString(payload.line) ? { type, line: payload.line } : undefined;
    case 'conversation.event.completed':
      return isString(payload.eventId) ? { type, eventId: payload.eventId } : undefined;
    case 'conversation.read':
      return isString(payload.readThroughMessageId) && isCount(payload.unreadReplyCount)
        ? { type, readThroughMessageId: payload.readThroughMessageId, unreadReplyCount: payload.unreadReplyCount } : undefined;
    case 'notification.acked':
      return isString(payload.notificationId) ? { type, notificationId: payload.notificationId } : undefined;
    case 'approval.pending': {
      const approval = readApproval(payload);
      return approval && { type, approval };
    }
    case 'approval.resolved': {
      const resolution = readResolution(payload);
      return resolution && { type, resolution };
    }
    case 'settings.changed': {
      const settings = readSettingsView(payload.settings);
      return settings && { type, settings };
    }
    case 'session.renewed':
      return { type };
    case 'command.accepted':
      return readAccepted(payload);
    case 'command.rejected':
      return isString(payload.code) ? { type, code: payload.code } : undefined;
    case 'service.unavailable':
      return isString(payload.code) ? { type, code: payload.code, ...(isString(payload.deviceId) ? { deviceId: payload.deviceId } : {}) } : undefined;
    default:
      return undefined;
  }
}

function readSnapshot(payload: Record<string, unknown>): Snapshot | undefined {
  const messages = readList(payload.messages, readMessage);
  const pendingEvents = readList(payload.pendingEvents, readPendingEvent);
  const pendingApprovals = readList(payload.pendingApprovals ?? [], readApproval);
  const notices = payload.unacknowledgedNotificationIds;
  const read = payload.readThroughMessageId;
  if (!isString(payload.deviceId) || !messages || !pendingEvents || !pendingApprovals) return undefined;
  if (!Array.isArray(notices) || !notices.every(isString) || !(read === null || isString(read)) || !isCount(payload.unreadReplyCount)) return undefined;
  const settings = payload.settings === undefined ? undefined : readSettingsView(payload.settings);
  if (payload.settings !== undefined && !settings) return undefined;
  const expression = isObject(payload.avatar) && isExpression(payload.avatar.expression) ? payload.avatar.expression : 'neutral';
  return {
    deviceId: payload.deviceId, messages, pendingEvents, expression, readThroughMessageId: read,
    unreadReplyCount: payload.unreadReplyCount, unacknowledgedNotificationIds: notices, pendingApprovals,
    ...(isString(payload.avatarVersion) ? { avatarVersion: payload.avatarVersion } : {}),
    ...(settings ? { settings } : {}),
  };
}

function readAccepted(payload: Record<string, unknown>): ServerEvent | undefined {
  const settings = payload.settings === undefined ? undefined : readSettingsView(payload.settings);
  if (payload.settings !== undefined && !settings) return undefined;
  const strings = ['messageId', 'eventId', 'readThroughMessageId', 'notificationId', 'approvalId', 'deviceId'] as const;
  const accepted: Accepted = {};
  for (const key of strings) if (isString(payload[key])) accepted[key] = payload[key];
  if (isString(payload.state)) accepted.state = payload.state;
  if (isCount(payload.unreadReplyCount)) accepted.unreadReplyCount = payload.unreadReplyCount;
  if (settings) accepted.settings = settings;
  if (payload.mode === 'resume') accepted.mode = 'resume';
  return { type: 'command.accepted', accepted };
}
