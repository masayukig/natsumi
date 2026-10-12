import assert from 'node:assert/strict';
import test from 'node:test';
import { sleepPage } from '../src/server/dashboard-sleep.ts';
import type { PillJudgement } from '../src/server/sleeping-pill.ts';

// The sleeping pill's page (ADR 0077): what a pill would do now and what that is decided from, and the one form that
// gives it. Every value is escaped, and the page does not refresh itself.

const HOSTILE = '<img src=x onerror=alert(1)>';
const ZONE = 'Asia/Tokyo';

function judgement(fields: Partial<PillJudgement> = {}): PillJudgement {
  return { kind: 'resleep', night: '2026-10-04T17:00:00.000Z', done: { review: true, curator: false, session: true },
    lastFailure: { source: 'curator', stage: 'structure', outcome: 'skipped-deadline', at: '2026-10-04T20:30:00.000Z' },
    inProgress: null, ...fields };
}

const page = (fields: Partial<PillJudgement> = {}, options: Partial<Parameters<typeof sleepPage>[1]> = {}) =>
  sleepPage(judgement(fields), { timeZone: ZONE, pillMinutes: 90, unavailable: null, ...options }).text;

test('the page says what a pill would do now, how long she would sleep, and that messages wait meanwhile', () => {
  const text = page();
  assert.match(text, /<h2>睡眠薬<\/h2>/);
  assert.match(text, /寝直し/);
  assert.match(text, /<code>resleep<\/code>/);
  assert.match(text, /最長 90 分と工程 1 つ分/);
  assert.match(text, /メッセージは待たせ/);
  assert.match(text, /<form method="post" action="\/dashboard\/sleep"><button type="submit">睡眠薬を飲ませる<\/button><\/form>/);
  assert.ok(!text.includes('data-refresh'), 'it does not refresh itself, so what is about to be given does not move');
  assert.match(text, /aria-current="page">睡眠薬/);
  assert.match(text, /<a href="\/dashboard\/checks">予約<\/a><\/li><li><a href="\/dashboard\/sleep" aria-current="page">睡眠薬/, 'next to the bookings');
});

test('the night, its three parts, and the newest failure are shown, every value escaped', () => {
  const text = page({ lastFailure: { source: 'rotation', kind: 'night', state: 'failed', reason: HOSTILE, at: '2026-10-04T17:01:00.000Z' } });
  assert.match(text, /2026-10-05 02:00/, 'the night in the time zone');
  assert.match(text, /振り返り（引き継ぎ）[\s\S]*済み[\s\S]*記憶の整理係[\s\S]*まだ[\s\S]*新しい session[\s\S]*済み/);
  assert.match(text, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!text.includes('<img src=x'));
  assert.match(page(), /structure[\s\S]*skipped-deadline/);
  assert.match(page({ lastFailure: null }), /失敗はありません/);
});

test('each kind has its own words; with no deadline the curator runs to its limits', () => {
  assert.match(page({ kind: 'deep', done: { review: false, curator: false, session: false } }), /ガッツリ寝る[\s\S]*夜と同じ/);
  assert.match(page({ kind: 'resume', done: { review: true, curator: false, session: false } }), /残りを済ませる[\s\S]*先に記憶の整理係/);
  assert.doesNotMatch(page({ kind: 'resume', done: { review: true, curator: true, session: false } }), /先に記憶の整理係/);
  assert.match(page({ kind: 'nap', done: { review: true, curator: true, session: true } }), /昼寝[\s\S]*整理係は走りません/);
  assert.match(page({ kind: 'none' }), /何もしません/);
  assert.match(page({}, { pillMinutes: false }), /締め切りなし/);
  assert.match(page({ night: null, kind: 'deep' }), /まだ振り返りの記録がありません/);
});

test('what is running or waiting is shown, and so is a pill just taken or joined', () => {
  assert.match(page({ inProgress: { kind: 'night', state: 'running', since: '2026-10-04T17:00:00.000Z' } }), /<code>night<\/code>[\s\S]*寝ています/);
  assert.match(page({ inProgress: { kind: 'sleeping-pill', state: 'queued', since: '2026-10-05T03:00:00.000Z' } }), /順番を待っています/);
  assert.match(page({}, { taken: 'new' }), /睡眠薬を飲ませました/);
  assert.match(page({}, { taken: 'joined' }), /合流しました/);
});

test('while natsumi cannot talk the page says so and offers no form', () => {
  const text = page({}, { unavailable: 'pi-unavailable' });
  assert.match(text, /いまは飲ませられません[\s\S]*<code>pi-unavailable<\/code>/);
  assert.ok(!text.includes('action="/dashboard/sleep"'));
});
