import type { AvatarManifest } from '../../shared/protocol/avatar.ts';
import type { Approval, Decision, EventState, Expression, Placement, ShownMessage } from '../../shared/protocol/conversation.ts';
import type { Position, WebPushSubscription } from '../../shared/protocol/envelope.ts';
import type { SettingKey, SettingsView } from '../../shared/protocol/settings.ts';

/**
 * Everything the browser's app knows, in one value the mediator alone changes (ADR 0058; mac/CLAUDE.md's mediator).
 * The view is drawn from it through the props, and never keeps any of it.
 */

export type Screen = 'chat' | 'settings';

/**
 * The socket as the owner is told of it: being opened, open and syncing, synced, closed and waiting to open again,
 * closed because a newer tab of this device took over, or closed because the session ended.
 */
export type Link = 'idle' | 'connecting' | 'syncing' | 'synced' | 'waiting' | 'replaced' | 'signed-out';

/** A message the owner wrote that the server has not recorded yet. */
export interface Outgoing { requestId: string; text: string; status: 'sending' | 'failed'; code?: string }

/** A read or a notice's check on this device that the server has not answered yet (shown as done already). */
export interface LocalRead { requestId: string; kind: 'read' | 'ack'; id: string }

/**
 * Where an approval is on its way to a decision. Nothing reaches Slack before `confirming` is confirmed: the one step
 * that keeps a slip of the finger from acting outside (ADR 0058).
 */
export type ApprovalFlow =
  | { step: 'idle'; error?: string }
  | { step: 'editing'; error?: string }
  | { step: 'confirming'; decision: Decision; text?: string; placement?: Placement; editing: boolean }
  | { step: 'sending'; requestId: string };

/** A setting's change or reset the server has not answered, or the words for why the last one did not go through. */
export interface SettingEntry { pending?: string; error?: string }

/**
 * This browser's notifications (ADR 0065): not offered by the browser or the server, off, being asked of the browser,
 * or on with the subscription registered on every sync. `error` is the words for why the last try did not go through.
 */
export interface PushState { status: 'unsupported' | 'off' | 'busy' | 'on'; subscription?: WebPushSubscription; error?: string }

export interface AppState {
  screen: Screen;
  /** The start of this page's request IDs, and the number of the next. */
  idPrefix: string;
  nextId: number;

  link: Link;
  socketOpen: boolean;
  /** The failed opens since the last sync, which the wait before the next grows with. */
  attempts: number;
  /** The request ID of the session.sync on its way. */
  syncRequest?: string;
  /** Why the conversation cannot be used, from `service.unavailable`. */
  unavailable?: string;
  deviceId?: string;
  /** The last event applied: where a resume starts from. */
  cursor?: Position;
  /** Whether the owner can see the page (visible and focused), so replies can be read. */
  visible: boolean;

  avatar?: AvatarManifest;
  avatarRequested: boolean;

  messages: ShownMessage[];
  /** Owner messages natsumi has not finished with, by event ID. */
  pending: Record<string, EventState>;
  expression: Expression;
  thinkingLine?: string;
  outbox: Outgoing[];
  /** How many messages the owner has sent from this page: the view empties its field when this moves. */
  sentCount: number;
  readThrough: string | null;
  unreadReplyCount: number;
  unacknowledged: string[];
  localReads: LocalRead[];

  approvals: Approval[];
  flows: Record<string, ApprovalFlow>;
  /** What became of approvals lately, newest first. */
  results: string[];

  settings?: SettingsView;
  settingEntries: Partial<Record<SettingKey, SettingEntry>>;

  push: PushState;
}
