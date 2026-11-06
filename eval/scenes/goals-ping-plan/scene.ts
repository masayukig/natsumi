import type { RunRecord } from '../../../src/eval/record.ts';

/** The plan rode on the ping (ADR 0090): the first ping of a session carries today.md as committed. */
export function planShown(record: RunRecord): { pass: boolean; detail: string } {
  const ping = record.events.find(event => event.type === 'ping');
  const plan = ping?.today_plan;
  if (typeof plan !== 'string') return { pass: false, detail: 'today_plan が無い' };
  return /home-notes/.test(plan) ? { pass: true, detail: '載っている' } : { pass: false, detail: '中身が違う' };
}
