import type { RunRecord } from '../../../src/eval/record.ts';

/** The keeper's answer came back as an event, and a turn handled it. */
export function heardBack(record: RunRecord) {
  const answered = record.events.some(event => event.type === 'agent_reply' && event.agent === 'wiki-keeper');
  return { pass: answered && (record.turns ?? 1) >= 2, detail: `${record.turns ?? 1} ターン、返事の出来事${answered ? 'あり' : 'なし'}` };
}
