import { MOMENT_EVENTS, type Position, type ServerEnvelope } from '../../shared/protocol/envelope.ts';

/**
 * Where an event falls in the stream (docs/client-contract.md, 端末の登録と stream): applied as the next one, applied
 * without moving the stream (a line of thinking), dropped (seen already, or of another stream), or a sign that some
 * were missed and the snapshot must be asked for again.
 */
export type Placing = 'apply' | 'moment' | 'skip' | 'resync';

const ANSWERS: readonly string[] = ['command.accepted', 'command.rejected', 'service.unavailable'];

export function place(cursor: Position | undefined, envelope: ServerEnvelope): Placing {
  const { position, event } = envelope;
  const same = cursor !== undefined && cursor.epoch === position.epoch && cursor.streamId === position.streamId;
  if (MOMENT_EVENTS.includes(event.type)) return same ? 'moment' : 'skip';
  if (event.type === 'session.snapshot') return 'apply';
  // Before a snapshot there is nothing to follow; only the answers to this device's commands mean anything.
  if (!cursor) return ANSWERS.includes(event.type) ? 'moment' : 'skip';
  if (!same) return 'resync';
  if (position.seq <= cursor.seq) return 'skip';
  return position.seq === cursor.seq + 1 ? 'apply' : 'resync';
}
