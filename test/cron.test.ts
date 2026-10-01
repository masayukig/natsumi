import assert from 'node:assert/strict';
import test from 'node:test';
import { lastRun, nextRun, parseCron, type Cron } from '../src/server/cron.ts';

/** Tokyo is UTC+9 all year, so local times read directly. */
const TZ = 'Asia/Tokyo';
const tokyo = (local: string) => Date.parse(`${local.replace(' ', 'T')}:00+09:00`);
const local = (ms: number | undefined) => ms === undefined ? undefined
  : new Date(ms + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');

function cron(text: string): Cron {
  const parsed = parseCron(text);
  assert.ok(parsed.ok, `${text}: ${parsed.ok ? '' : parsed.reason}`);
  return parsed.cron;
}

test('the next run of a five-field expression is read in the owner\'s time zone and is always after the given time', () => {
  // 2026-09-17 is a Thursday.
  const cases: [string, string, string][] = [
    ['0 16 * * *', '2026-09-17 10:00', '2026-09-17 16:00'],
    ['0 16 * * *', '2026-09-17 16:00', '2026-09-18 16:00'],
    ['*/10 * * * *', '2026-09-17 10:03', '2026-09-17 10:10'],
    ['*/10 * * * *', '2026-09-17 23:55', '2026-09-18 00:00'],
    ['0 9 * * 1-5', '2026-09-18 09:30', '2026-09-21 09:00'],
    ['0 0 1,15 * *', '2026-09-17 10:00', '2026-10-01 00:00'],
    ['0-30/15 8 * * *', '2026-09-17 08:01', '2026-09-17 08:15'],
    ['0-30/15 8 * * *', '2026-09-17 08:30', '2026-09-18 08:00'],
    ['0 18 2 9 *', '2026-09-17 10:00', '2027-09-02 18:00'],
    ['0 0 29 2 *', '2026-09-17 10:00', '2028-02-29 00:00'],
    // Both 0 and 7 are Sunday.
    ['0 8 * * 7', '2026-09-17 10:00', '2026-09-20 08:00'],
    ['0 8 * * 0', '2026-09-17 10:00', '2026-09-20 08:00'],
    // With both the day of the month and the weekday written, either one matches, as cron has it.
    ['0 12 13 * 5', '2026-09-17 10:00', '2026-09-18 12:00'],
    ['0 12 13 * 5', '2026-10-10 10:00', '2026-10-13 12:00'],
    // A day of the month written with a step still counts as "any day" for that rule.
    ['0 12 */1 * 5', '2026-09-17 11:00', '2026-09-18 12:00'],
  ];
  for (const [expression, after, expected] of cases) {
    assert.equal(local(nextRun(cron(expression), tokyo(after), TZ)), expected, `${expression} after ${after}`);
  }
});

test('the last run at or before a time is found the same way', () => {
  const cases: [string, string, string][] = [
    ['*/10 * * * *', '2026-09-17 10:03', '2026-09-17 10:00'],
    ['*/10 * * * *', '2026-09-17 10:10', '2026-09-17 10:10'],
    ['0 16 * * *', '2026-09-17 10:00', '2026-09-16 16:00'],
    ['0 9 * * 1-5', '2026-09-21 08:00', '2026-09-18 09:00'],
  ];
  for (const [expression, before, expected] of cases) {
    assert.equal(local(lastRun(cron(expression), tokyo(before) + 30_000, TZ)), expected, `${expression} at ${before}`);
  }
});

test('the next run can be limited to some minutes of the day, as the awake hours limit a repeating check', () => {
  const awake = (minute: number) => minute >= 8 * 60 && minute < 23 * 60;
  assert.equal(local(nextRun(cron('*/10 * * * *'), tokyo('2026-09-17 22:55'), TZ, awake)), '2026-09-18 08:00');
  assert.equal(local(nextRun(cron('0 7,12 * * *'), tokyo('2026-09-17 22:00'), TZ, awake)), '2026-09-18 12:00');
  assert.equal(nextRun(cron('0 3 * * *'), tokyo('2026-09-17 22:00'), TZ, awake), undefined, 'every run is at night');
});

test('an expression with no day it can ever run on has no next run', () => {
  assert.equal(nextRun(cron('0 0 30 2 *'), tokyo('2026-09-17 10:00'), TZ), undefined);
  assert.equal(lastRun(cron('0 0 31 4 *'), tokyo('2026-09-17 10:00'), TZ), undefined);
});

test('a local time the zone skips is not a run; the next one is the next that exists', () => {
  // New York moves from 02:00 to 03:00 on 2026-03-08.
  const newYork = 'America/New_York';
  const after = Date.parse('2026-03-07T12:00:00-05:00');
  assert.equal(new Date(nextRun(cron('30 2 * * *'), after, newYork)!).toISOString(), '2026-03-09T06:30:00.000Z');
});

test('what is not a five-field expression it can read is refused with a sentence saying what is wrong', () => {
  const refusals: [string, RegExp][] = [
    ['0 16 * *', /5 つ/],
    ['0 16 * * * *', /5 つ/],
    ['', /5 つ/],
    ['60 * * * *', /分.*0〜59/],
    ['* 24 * * *', /時.*0〜23/],
    ['* * 0 * *', /日.*1〜31/],
    ['* * * 13 *', /月.*1〜12/],
    ['* * * * 8', /曜日.*0〜7/],
    ['*/0 * * * *', /間隔/],
    ['5-1 * * * *', /範囲/],
    ['a * * * *', /分/],
    ['0 9 * * MON', /曜日/],
    ['1,,2 * * * *', /分/],
    ['@daily', /5 つ/],
  ];
  for (const [expression, reason] of refusals) {
    const parsed = parseCron(expression);
    assert.equal(parsed.ok, false, expression);
    assert.match(parsed.ok ? '' : parsed.reason, reason, expression);
  }
  // Spaces around and between the fields are not the owner's concern.
  assert.equal(cron('  0   16 * * *  ').text, '0 16 * * *');
});
