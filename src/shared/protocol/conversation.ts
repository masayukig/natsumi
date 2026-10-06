/**
 * The conversation and the approvals as the devices are shown them (docs/client-contract.md): the lines, their images,
 * the owner's messages waiting for natsumi, and the Slack posts waiting for the owner. Each type has its reader, which
 * takes JSON as it came over the wire and gives the value only when it has the contract's shape.
 *
 * Part of the contract the server and the browser's app share. It imports nothing but the rest of the contract.
 */

export const EXPRESSIONS = ['neutral', 'happy', 'laughing', 'surprised', 'thinking', 'worried', 'sad', 'sleepy'] as const;
export type Expression = typeof EXPRESSIONS[number];

/** An image as the devices are told of it: by ID, with what they need to lay it out before fetching it. */
export interface ShownImage {
  imageId: string;
  mimeType: string;
  bytes: number;
  /** Present only when the image's header said it. */
  width?: number;
  height?: number;
}

/**
 * A file the owner attached to a message (ADR 0071), by its upload's ID, which the devices fetch it by. `mimeType` and
 * the size are there only for a PNG, JPEG or WebP, told by its bytes.
 */
export interface ShownAttachment {
  uploadId: string;
  name: string;
  bytes: number;
  mimeType?: string;
  width?: number;
  height?: number;
}

/** One line of the conversation: the owner's message, natsumi's reply or her notice. */
export interface ShownMessage {
  messageId: string;
  role: 'owner' | 'natsumi';
  kind: 'message' | 'reply' | 'notice';
  text: string;
  createdAt: string;
  eventId?: string;
  replyTo?: string;
  about?: string[];
  /** The feeling she put in the line; missing when not recorded or not one the contract knows. */
  expression?: Expression;
  images?: ShownImage[];
  /** The files an owner message carries, in the order they were sent (ADR 0071). */
  attachments?: ShownAttachment[];
}

export type EventState = 'queued' | 'processing' | 'replied' | 'no-reply' | 'failed';
export interface PendingEvent { eventId: string; messageId: string; state: EventState }

/** Where a reply goes (ADR 0062): its thread, the channel itself, or its thread shown in the channel too. */
export type Placement = 'thread' | 'channel' | 'broadcast';
export const PLACEMENTS: readonly Placement[] = ['thread', 'channel', 'broadcast'];
export interface Issue { name: string; label: string; score: number; flagged?: true }

/** A Slack post waiting for the owner (承認と外部実行). */
export interface Approval {
  approvalId: string;
  revision: number;
  kind: 'slack-post';
  createdAt: string;
  expiresAt: string;
  target: { channel: string; placement: Placement; replyTo?: { speaker: string; at: string; text: string } };
  text: string;
  expression?: Expression;
  images?: ShownImage[];
  reason: { verdict: 'owner' | 'no-verdict' | 'rewrite-limit'; issues: Issue[]; placement?: { probabilities: Partial<Record<Placement, number>> } };
  history: { text: string; issues: Issue[] }[];
}

export type Decision = 'approve' | 'edit' | 'reject';
export type ApprovalOutcome = 'approved' | 'edited' | 'rejected' | 'expired';

/** How an approval closed, and for a post, whether it went out. */
export interface ApprovalResolution {
  approvalId: string;
  state: ApprovalOutcome;
  delivery?: 'sent' | 'failed';
  sentText?: string;
  reason?: string;
}

type Json = Record<string, unknown>;

export const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
export const isString = (value: unknown): value is string => typeof value === 'string';
export const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T => (values as readonly unknown[]).includes(value);
export const isExpression = (value: unknown): value is Expression => isOneOf(EXPRESSIONS, value);

/** Every element read, or undefined when the value is not an array or any element is not the contract's. */
export function readList<T>(value: unknown, read: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(read);
  return items.every((item): item is T => item !== undefined) ? items : undefined;
}

export function readImage(value: unknown): ShownImage | undefined {
  if (!isObject(value) || !isString(value.imageId) || !isString(value.mimeType) || !isCount(value.bytes)) return undefined;
  const { imageId, mimeType, bytes, width, height } = value;
  return { imageId, mimeType, bytes, ...(isCount(width) && isCount(height) ? { width, height } : {}) };
}

export function readAttachment(value: unknown): ShownAttachment | undefined {
  if (!isObject(value) || !isString(value.uploadId) || !isString(value.name) || !isCount(value.bytes)) return undefined;
  const { uploadId, name, bytes, mimeType, width, height } = value;
  return { uploadId, name, bytes, ...(isString(mimeType) ? { mimeType } : {}), ...(isCount(width) && isCount(height) ? { width, height } : {}) };
}

export function readMessage(value: unknown): ShownMessage | undefined {
  if (!isObject(value) || !isString(value.messageId) || !isString(value.text) || !isString(value.createdAt)) return undefined;
  if (!isOneOf(['owner', 'natsumi'] as const, value.role) || !isOneOf(['message', 'reply', 'notice'] as const, value.kind)) return undefined;
  const images = value.images === undefined ? undefined : readList(value.images, readImage);
  if (value.images !== undefined && !images) return undefined;
  const attachments = value.attachments === undefined ? undefined : readList(value.attachments, readAttachment);
  if (value.attachments !== undefined && !attachments) return undefined;
  const about = Array.isArray(value.about) && value.about.every(isString) ? value.about : undefined;
  return {
    messageId: value.messageId, role: value.role, kind: value.kind, text: value.text, createdAt: value.createdAt,
    ...(isString(value.eventId) ? { eventId: value.eventId } : {}),
    ...(isString(value.replyTo) ? { replyTo: value.replyTo } : {}),
    ...(about ? { about } : {}),
    ...(isExpression(value.expression) ? { expression: value.expression } : {}),
    ...(images ? { images } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

const EVENT_STATES = ['queued', 'processing', 'replied', 'no-reply', 'failed'] as const;
export const isEventState = (value: unknown): value is EventState => isOneOf(EVENT_STATES, value);

export function readPendingEvent(value: unknown): PendingEvent | undefined {
  if (!isObject(value) || !isString(value.eventId) || !isString(value.messageId) || !isEventState(value.state)) return undefined;
  return { eventId: value.eventId, messageId: value.messageId, state: value.state };
}

function readIssue(value: unknown): Issue | undefined {
  if (!isObject(value) || !isString(value.name) || !isString(value.label) || typeof value.score !== 'number') return undefined;
  return { name: value.name, label: value.label, score: value.score, ...(value.flagged === true ? { flagged: true } : {}) };
}

export function readApproval(value: unknown): Approval | undefined {
  if (!isObject(value) || !isString(value.approvalId) || !isCount(value.revision) || value.kind !== 'slack-post') return undefined;
  if (!isString(value.createdAt) || !isString(value.expiresAt) || !isString(value.text)) return undefined;
  const { target, reason } = value;
  if (!isObject(target) || !isString(target.channel) || !isOneOf(PLACEMENTS, target.placement)) return undefined;
  const replyTo = target.replyTo;
  if (replyTo !== undefined && !(isObject(replyTo) && isString(replyTo.speaker) && isString(replyTo.at) && isString(replyTo.text))) return undefined;
  if (!isObject(reason) || !isOneOf(['owner', 'no-verdict', 'rewrite-limit'] as const, reason.verdict)) return undefined;
  const issues = readList(reason.issues, readIssue);
  const history = readList(value.history, (item) => {
    if (!isObject(item) || !isString(item.text)) return undefined;
    const itemIssues = readList(item.issues, readIssue);
    return itemIssues ? { text: item.text, issues: itemIssues } : undefined;
  });
  const images = value.images === undefined ? undefined : readList(value.images, readImage);
  if (!issues || !history || (value.images !== undefined && !images)) return undefined;
  // The odds of each place the judge was asked about; not every place need be there, and what is no place is dropped.
  const given = isObject(reason.placement) && isObject(reason.placement.probabilities) ? reason.placement.probabilities : {};
  const probabilities = Object.fromEntries(PLACEMENTS.flatMap(name => typeof given[name] === 'number' ? [[name, given[name]]] : []));
  return {
    approvalId: value.approvalId, revision: value.revision, kind: 'slack-post', createdAt: value.createdAt, expiresAt: value.expiresAt,
    target: {
      channel: target.channel, placement: target.placement,
      ...(isObject(replyTo) ? { replyTo: { speaker: replyTo.speaker as string, at: replyTo.at as string, text: replyTo.text as string } } : {}),
    },
    text: value.text,
    ...(isExpression(value.expression) ? { expression: value.expression } : {}),
    ...(images ? { images } : {}),
    reason: {
      verdict: reason.verdict, issues,
      ...(Object.keys(probabilities).length > 0 ? { placement: { probabilities } } : {}),
    },
    history,
  };
}

export function readResolution(value: unknown): ApprovalResolution | undefined {
  if (!isObject(value) || !isString(value.approvalId) || !isOneOf(['approved', 'edited', 'rejected', 'expired'] as const, value.state)) return undefined;
  return {
    approvalId: value.approvalId, state: value.state,
    ...(isOneOf(['sent', 'failed'] as const, value.delivery) ? { delivery: value.delivery } : {}),
    ...(isString(value.sentText) ? { sentText: value.sentText } : {}),
    ...(isString(value.reason) ? { reason: value.reason } : {}),
  };
}
