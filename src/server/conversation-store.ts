import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { shownImage, type ShownImage } from './images.ts';
import type { Expression } from './loop-tools.ts';
import { isoAt } from './nightly.ts';

/** The kinds of event the loop takes. The column is free text in SQLite; these are the only values written. */
export type EventKind = 'mac-message' | 'nightly-review' | 'ping' | 'self-check' | 'agent-reply' | 'slack-mention' | 'dove-reply'
  | 'sources-updated';

/** How far an event got. Mirrors the CHECK on `loop_events.state`. */
export type EventState = 'queued' | 'processing' | 'replied' | 'no-reply' | 'failed';

export interface MessageRow {
  message_id: string; position: number; role: 'owner' | 'natsumi'; kind: 'message' | 'reply' | 'notice'; text: string;
  event_id: string | null; about_event_ids: string | null; request_id: string | null; device_id: string | null; created_at: string;
  /** The feeling natsumi chose for one of her lines (ADR 0026). NULL on the owner's messages and on lines written before it. */
  expression: Expression | null;
}
export interface ConversationRow { conversation_id: string; pi_session_id: string; pi_session_file: string; created_at: string }
export interface RotationRow {
  rotation_id: string; event_id: string; conversation_id: string; from_session_id: string; from_session_file: string;
  state: string;
  /** The commit of `handoff.md` this switch started its new session from (ADR 0020). */
  handoff_commit: string | null;
}

/** The row `send` finds when the same request arrives twice. */
export interface ExistingMessage {
  message_id: string; device_id: string; text: string; event_id: string; state: EventState;
}

/** An owner message not handled yet, as a snapshot carries it. */
export interface PendingEvent { eventId: string; messageId: string; state: EventState }

/** What one event becomes in the prompt: its kind and time, and the owner message behind it, if any. */
export interface EventRow { kind: EventKind; created_at: string; text: string | null; message_at: string | null }

declare const inTransaction: unique symbol;
/**
 * Proof that the holder runs inside `ConversationStore.transaction`. Only `transaction` makes one, so a method that
 * asks for it cannot be called outside a transaction by mistake.
 */
export interface Transaction { readonly [inTransaction]: true }

const TRANSACTION = Object.freeze({}) as Transaction;

/**
 * Everything the thinking loop keeps in SQLite: the conversation shown to the owner, the events it takes, and the
 * nightly switches of its Pi session. The loop itself holds no SQL; what it knows about the tables is this class
 * (ADR 0008, ADR 0009). `ReadState` is the neighbouring store for what the owner has read (ADR 0013).
 *
 * Nothing here logs or throws for the loop to catch: a method either writes its rows or returns what it found.
 */
export class ConversationStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number) {
    this.db = db;
    this.now = now;
  }

  /**
   * Runs `fn` as one transaction and hands it the proof of that, so what must be written together (an owner message
   * and its event, a switch's two updates, an event and the self-checks it carries) cannot be split apart.
   */
  transaction<T>(fn: (tx: Transaction) => T): T {
    const { db } = this;
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn(TRANSACTION);
      db.exec('COMMIT');
      return value;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  // --- The conversation shown to the owner -------------------------------------------------------------------

  /**
   * An owner message and the event it raises, written together: the two rows point at each other, so one without
   * the other would be a conversation the loop can never answer.
   */
  insertOwnerMessage(input: { requestId: string; deviceId: string; text: string }): { row: MessageRow; eventId: string } {
    const eventId = `event-${randomUUID()}`;
    const row = this.transaction(() => {
      const message = this.insertMessage({ role: 'owner', kind: 'message', text: input.text, eventId,
        requestId: input.requestId, deviceId: input.deviceId });
      const now = this.iso();
      this.db.prepare(`INSERT INTO loop_events (event_id, kind, message_id, state, created_at, updated_at)
        VALUES (?, 'mac-message', ?, 'queued', ?, ?)`).run(eventId, message.message_id, now, now);
      return message;
    });
    return { row, eventId };
  }

  /**
   * What natsumi sent the owner: a reply, naming the event it answered if it answered one (ADR 0032), or a notice
   * about some, with the feeling she chose for it. A reply may show images already recorded, by ID, in her order
   * (ADR 0045).
   */
  insertMessage(message: { role: MessageRow['role']; kind: MessageRow['kind']; text: string; eventId?: string;
    about?: string[]; requestId?: string; deviceId?: string; expression?: Expression; imageIds?: string[] }): MessageRow {
    const { db } = this;
    const messageId = `message-${randomUUID()}`;
    db.prepare(`INSERT INTO conversation_messages
      (message_id, position, role, kind, text, event_id, about_event_ids, request_id, device_id, expression, created_at)
      VALUES (?, (SELECT COALESCE(MAX(position), 0) + 1 FROM conversation_messages), ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      messageId, message.role, message.kind, message.text, message.eventId ?? null,
      message.about && message.about.length > 0 ? JSON.stringify(message.about) : null,
      message.requestId ?? null, message.deviceId ?? null, message.expression ?? null, this.iso());
    const image = db.prepare('INSERT INTO conversation_message_images (message_id, position, image_id) VALUES (?, ?, ?)');
    message.imageIds?.forEach((imageId, position) => image.run(messageId, position, imageId));
    return db.prepare('SELECT * FROM conversation_messages WHERE message_id = ?').get(messageId) as unknown as MessageRow;
  }

  /** The message a request already wrote, so the same send is never recorded twice. */
  existingByRequest(requestId: string): ExistingMessage | undefined {
    return this.db.prepare(`SELECT m.message_id, m.device_id, m.text, m.event_id, e.state FROM conversation_messages m
      JOIN loop_events e ON e.event_id = m.event_id WHERE m.request_id = ?`).get(requestId) as ExistingMessage | undefined;
  }

  /** Whether the event has been answered. One answering reply per event is a unique index, this is what reads it. */
  hasReply(eventId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM conversation_messages WHERE kind = 'reply' AND event_id = ?`).get(eventId) !== undefined;
  }

  /** Notices sent in the rolling hour behind now, for the limit on notify_owner (ADR 0008). */
  noticesInLastHour(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM conversation_messages WHERE kind = 'notice' AND created_at >= ?`)
      .get(isoAt(this.now() - 3_600_000)) as { n: number }).n;
  }

  /** The newest messages, oldest first. */
  snapshotRows(limit: number): MessageRow[] {
    return this.db.prepare('SELECT * FROM (SELECT * FROM conversation_messages ORDER BY position DESC LIMIT ?) ORDER BY position')
      .all(limit) as unknown as MessageRow[];
  }

  /** The images each of these messages shows, in order. A message that shows none is not in the map. */
  messageImages(messageIds: string[]): Map<string, ShownImage[]> {
    const shown = new Map<string, ShownImage[]>();
    if (messageIds.length === 0) return shown;
    const rows = this.db.prepare(`SELECT l.message_id, i.image_id, i.mime_type, i.bytes, i.width, i.height
      FROM conversation_message_images l JOIN images i ON i.image_id = l.image_id
      WHERE l.message_id IN (SELECT value FROM json_each(?)) ORDER BY l.message_id, l.position`).all(JSON.stringify(messageIds)) as
      { message_id: string; image_id: string; mime_type: string; bytes: number; width: number | null; height: number | null }[];
    for (const row of rows) {
      const image = shownImage({ imageId: row.image_id, mimeType: row.mime_type, bytes: row.bytes, width: row.width, height: row.height });
      shown.set(row.message_id, [...shown.get(row.message_id) ?? [], image]);
    }
    return shown;
  }

  /** Whether a line of the conversation shows the image, so that the devices may fetch it (ADR 0045). */
  showsImage(imageId: string): boolean {
    return this.db.prepare('SELECT 1 FROM conversation_message_images WHERE image_id = ?').get(imageId) !== undefined;
  }

  /** Owner messages the loop has not finished with, oldest first. */
  pendingEvents(): PendingEvent[] {
    const rows = this.db.prepare(`SELECT e.event_id, e.message_id, e.state FROM loop_events e
      JOIN conversation_messages m ON m.message_id = e.message_id
      WHERE e.state IN ('queued', 'processing') ORDER BY m.position`).all() as
      { event_id: string; message_id: string; state: EventState }[];
    return rows.map(row => ({ eventId: row.event_id, messageId: row.message_id, state: row.state }));
  }

  // --- The events the loop takes -----------------------------------------------------------------------------

  /** An event of natsumi's own, without an owner message behind it. */
  insertEvent(kind: Exclude<EventKind, 'mac-message'>): string {
    const eventId = `event-${randomUUID()}`;
    const now = this.iso();
    this.db.prepare(`INSERT INTO loop_events (event_id, kind, message_id, state, created_at, updated_at)
      VALUES (?, ?, NULL, 'queued', ?, ?)`).run(eventId, kind, now, now);
    return eventId;
  }

  setEventState(eventId: string, state: EventState, reason?: string): void {
    this.db.prepare('UPDATE loop_events SET state = ?, reason = ?, updated_at = ? WHERE event_id = ?')
      .run(state, reason ?? null, this.iso(), eventId);
  }

  /** The row the prompt's line for one event is built from. */
  eventRow(eventId: string): EventRow {
    return this.db.prepare(`SELECT e.kind, e.created_at, m.text, m.created_at AS message_at FROM loop_events e
      LEFT JOIN conversation_messages m ON m.message_id = e.message_id WHERE e.event_id = ?`).get(eventId) as unknown as EventRow;
  }

  eventKind(eventId: string): EventKind | undefined {
    return (this.db.prepare('SELECT kind FROM loop_events WHERE event_id = ?').get(eventId) as
      { kind: EventKind } | undefined)?.kind;
  }

  /** The kinds of several events, in the order asked for; undefined where there is no such event. */
  eventKinds(eventIds: string[]): (EventKind | undefined)[] {
    return eventIds.map(eventId => this.eventKind(eventId));
  }

  /** The owner message an event carries, if it is one. */
  eventMessageId(eventId: string): string | undefined {
    const row = this.db.prepare('SELECT message_id FROM loop_events WHERE event_id = ?').get(eventId) as
      { message_id: string | null };
    return row.message_id ?? undefined;
  }

  /**
   * Events a previous process left behind. Queued ones come back to the queue; one that was being handled is never
   * handed to Pi twice: it counts as replied if its reply was recorded, and as failed otherwise.
   */
  recover(): { closed: number; queued: string[] } {
    const { db } = this;
    const stopped = db.prepare(`UPDATE loop_events SET
        state = CASE WHEN EXISTS (SELECT 1 FROM conversation_messages r WHERE r.kind = 'reply' AND r.event_id = loop_events.event_id)
          THEN 'replied' ELSE 'failed' END,
        reason = CASE WHEN EXISTS (SELECT 1 FROM conversation_messages r WHERE r.kind = 'reply' AND r.event_id = loop_events.event_id)
          THEN NULL ELSE 'interrupted' END,
        updated_at = ?
      WHERE state = 'processing'`).run(this.iso());
    const queued = db.prepare(`SELECT event_id FROM loop_events WHERE state = 'queued' ORDER BY created_at, event_id`)
      .all() as { event_id: string }[];
    return { closed: Number(stopped.changes), queued: queued.map(row => row.event_id) };
  }

  // --- The conversation's Pi session and its nightly switches --------------------------------------------------

  conversation(): ConversationRow | undefined {
    return this.db.prepare('SELECT conversation_id, pi_session_id, pi_session_file, created_at FROM conversations ORDER BY created_at LIMIT 1')
      .get() as ConversationRow | undefined;
  }

  /** The one conversation, made on the first start. */
  insertConversation(sessionId: string, sessionFile: string): void {
    this.db.prepare('INSERT INTO conversations (conversation_id, pi_session_id, pi_session_file, created_at) VALUES (?, ?, ?, ?)')
      .run(`conversation-${randomUUID()}`, sessionId, sessionFile, this.iso());
  }

  /** The nightly review already waiting or running, so a second call joins it instead of raising another. */
  pendingRotation(): string | undefined {
    return (this.db.prepare(`SELECT event_id FROM loop_events WHERE kind = 'nightly-review' AND state IN ('queued', 'processing')`)
      .get() as { event_id: string } | undefined)?.event_id;
  }

  /**
   * The handoff schema 8 set aside when it took the column away, to seed `handoff.md` with (ADR 0020). Undefined on
   * every start but the first one after that upgrade, and on every database made since.
   */
  carriedOverHandoff(): string | undefined {
    const row = this.db.prepare('SELECT handoff FROM handoff_carryover WHERE carryover = 1').get() as { handoff: string } | undefined;
    return row?.handoff;
  }

  /** Forgets the carried-over handoff, once the repository holds it. The text then lives in one place only. */
  clearCarriedOverHandoff(): void {
    this.db.prepare('DELETE FROM handoff_carryover').run();
  }

  /** When the switch that made this session was committed. Undefined for the session the conversation began with. */
  switchedAt(sessionId: string): string | undefined {
    const row = this.db.prepare(`SELECT updated_at FROM session_rotations WHERE state = 'switched' AND to_session_id = ?`)
      .get(sessionId) as { updated_at: string } | undefined;
    return row?.updated_at;
  }

  /** A switch stopped after its handoff was committed: the next start finishes it rather than lose the review. */
  unfinishedRotation(conversationId: string, sessionId: string): RotationRow | undefined {
    return this.db.prepare(`SELECT * FROM session_rotations WHERE state IN ('reviewing', 'switching')
      AND handoff_commit IS NOT NULL AND conversation_id = ? AND from_session_id = ?`).get(conversationId, sessionId) as
      RotationRow | undefined;
  }

  insertRotation(rotation: { rotationId: string; eventId: string; conversationId: string;
    fromSessionId: string; fromSessionFile: string }): void {
    const now = this.iso();
    this.db.prepare(`INSERT INTO session_rotations (rotation_id, event_id, conversation_id, from_session_id, from_session_file, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'reviewing', ?, ?)`)
      .run(rotation.rotationId, rotation.eventId, rotation.conversationId, rotation.fromSessionId, rotation.fromSessionFile, now, now);
  }

  setRotation(rotationId: string, state: string, reason?: string): void {
    this.db.prepare('UPDATE session_rotations SET state = ?, reason = ?, updated_at = ? WHERE rotation_id = ?')
      .run(state, reason ?? null, this.iso(), rotationId);
  }

  /**
   * The commit that carries the review's handoff, recorded as soon as the turn's commit is made, so a stop after
   * this point finishes the switch instead of losing the review.
   */
  saveHandoffCommit(rotationId: string, commit: string): void {
    this.db.prepare('UPDATE session_rotations SET handoff_commit = ?, updated_at = ? WHERE rotation_id = ?')
      .run(commit, this.iso(), rotationId);
  }

  /**
   * Points the conversation at the new session and marks the switch done, together.
   *
   * A switch with no handoff commit is refused here rather than by a CHECK on the table: the rows written before
   * the handoff was a file have none, and a CHECK would reach back over them (ADR 0020). This is where the
   * invariant is kept instead, so no path can move the conversation onto a session started from nothing.
   */
  commitSwitch(rotation: Pick<RotationRow, 'rotation_id' | 'conversation_id' | 'handoff_commit'>,
    created: { sessionId: string; sessionFile: string }): void {
    if (!rotation.handoff_commit) throw new Error('a switch cannot be finished without the commit of its handoff');
    const { db } = this;
    this.transaction(() => {
      db.prepare('UPDATE conversations SET pi_session_id = ?, pi_session_file = ? WHERE conversation_id = ?')
        .run(created.sessionId, created.sessionFile, rotation.conversation_id);
      db.prepare(`UPDATE session_rotations SET state = 'switched', handoff_commit = ?, to_session_id = ?, to_session_file = ?, reason = NULL, updated_at = ?
        WHERE rotation_id = ?`).run(rotation.handoff_commit, created.sessionId, created.sessionFile, this.iso(), rotation.rotation_id);
    });
  }

  /**
   * Reviews stopped before their handoff was committed, and switches that no longer start from the current session,
   * have failed. Returns how many were closed.
   */
  closeInterruptedReviews(sessionId: string | null): number {
    const closed = this.db.prepare(`UPDATE session_rotations SET state = 'failed', reason = 'interrupted', updated_at = ?
      WHERE state IN ('reviewing', 'switching') AND (handoff_commit IS NULL OR from_session_id IS NOT ?)`).run(this.iso(), sessionId);
    return Number(closed.changes);
  }

  private iso() { return isoAt(this.now()); }
}
