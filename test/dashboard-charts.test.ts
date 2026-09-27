import assert from 'node:assert/strict';
import test from 'node:test';
import { statsPage, statsTokens } from '../src/server/dashboard-charts.ts';
import { PERIODS, type Period, type StatsStep, type StatsView } from '../src/server/dashboard-stats.ts';

// The statistics page (ADR 0049): charts drawn on the server as SVG, with no script and no inline style, each point's
// value in its <title> and the same numbers in a table below. A step with no turn has no value: the line breaks there
// and the table says so, instead of drawing a zero.

const ZONE = 'Asia/Tokyo';
const HOUR = 60 * 60_000;
/** 00:00 in Tokyo. */
const START = Date.parse('2026-01-01T15:00:00.000Z');

function step(index: number, stepMs: number, values: Partial<StatsStep> | null): StatsStep {
  const base: StatsStep = {
    start: new Date(START + index * stepMs).toISOString(), end: new Date(START + (index + 1) * stepMs).toISOString(), turns: 0,
    firstOut: { p50: null, p90: null, count: 0 }, turnLength: { p50: null, p90: null, count: 0 },
    modelCalls: null, tokens: null, cutShort: null, failed: null,
  };
  if (values === null) return base;
  return {
    ...base, turns: 3, firstOut: { p50: 4_200, p90: 9_800, count: 3 }, turnLength: { p50: 12_000, p90: 30_500, count: 3 },
    modelCalls: 7, tokens: { input: 1_200, cacheRead: 45_000, output: 800 }, cutShort: 1, failed: 0, ...values,
  };
}

/** A view whose steps are given: an object for a step with turns, null for one without. */
function view(period: Period, given: (Partial<StatsStep> | null)[] = []): StatsView {
  const { stepMs, steps } = PERIODS[period];
  const all = Array.from({ length: steps }, (_, index) => step(index, stepMs, given[index] ?? null));
  const turns = all.reduce((sum, s) => sum + s.turns, 0);
  const whole = { ...step(0, stepMs * steps, turns === 0 ? null : {}), turns };
  return { period, steps: all, whole };
}

test('the page is the statistics of the navigation, and offers the three periods with the chosen one marked', () => {
  const text = statsPage(view('7d', [{}]), ZONE).text;
  assert.match(text, /aria-current="page">統計/);
  assert.ok(!text.includes('統計<small>準備中'));
  for (const period of ['24h', '7d', '30d']) assert.match(text, new RegExp(`href="/dashboard/stats\\?period=${period}"`));
  assert.match(text, /<a href="\/dashboard\/stats\?period=7d" aria-current="true">7 日<\/a>/);
  assert.doesNotMatch(text, /period=24h" aria-current/);
});

test('six charts are drawn by default, each an SVG that scales to the width, with a table of the same numbers below it', () => {
  const text = statsPage(view('24h', [{}, {}, {}]), ZONE).text;
  for (const heading of ['返事までの時間', 'ターンの長さ', 'モデルの呼び出し', 'tokens（input・output）', 'tokens（cache read）', '打ち切り']) {
    assert.match(text, new RegExp(`<h3[^>]*>${heading}`), heading);
  }
  assert.equal(text.match(/<svg /g)?.length, 6);
  assert.equal(text.match(/<table /g)?.length, 6);
  for (const svg of text.match(/<svg [^>]*>/g)!) {
    assert.match(svg, /viewBox="0 0 \d+ \d+"/);
    assert.match(svg, /role="img"/);
    assert.doesNotMatch(svg, /\swidth=|\sheight=/, 'the style sheet sizes it, so it follows the page’s width');
  }
  // Each chart comes before its table.
  const chartAt = text.indexOf('<svg ');
  assert.ok(chartAt < text.indexOf('<table '));
});

test('nothing on the page needs an inline style or a script, and the colours come from classes', () => {
  const text = statsPage(view('30d', [{}, null, {}]), ZONE).text;
  assert.doesNotMatch(text, /<style|\sstyle=|\son[a-z]+=/i);
  assert.equal(text.match(/<script/g)?.length, 1, 'only the page’s own static script');
  assert.doesNotMatch(text, /(fill|stroke)="#/, 'no colour is written into the markup');
  assert.match(text, /class="[^"]*\bs1\b/);
  assert.match(text, /class="[^"]*\bs2\b/);
  assert.match(text, /class="[^"]*\bs3\b/);
});

test('each point carries its step and its value in a <title>', () => {
  const text = statsPage(view('24h', [null, null, null, null, null, null, null, null, null, null, { firstOut: { p50: 4_200, p90: 9_800, count: 3 } }]), ZONE).text;
  assert.match(text, /<title>10:00–11:00 p50 4\.2 秒（3 ターン）<\/title>/);
  assert.match(text, /<title>10:00–11:00 p90 9\.8 秒（3 ターン）<\/title>/);
  assert.match(text, /<title>10:00–11:00 呼び出し 7<\/title>/);
  assert.match(text, /<title>10:00–11:00 cache read 45,000<\/title>/);
  assert.match(text, /<title>10:00–11:00 上限・時間切れ 1<\/title>/);
});

test('a step with no turn breaks the line and shows no value, rather than a zero', () => {
  const text = statsPage(view('24h', [{}, null, {}]), ZONE).text;
  const reply = text.slice(text.indexOf('返事までの時間'), text.indexOf('ターンの長さ'));
  const p50 = reply.match(/<path [^>]*class="line s1"[^>]*>/)?.[0] ?? reply.match(/<path class="line s1"[^>]*>/)?.[0];
  assert.ok(p50, 'the p50 line');
  assert.equal(p50.match(/M/g)?.length, 2, 'two pieces, broken at the empty step');
  assert.doesNotMatch(reply, /<title>01:00–02:00/, 'no point for the empty step');
  // In the table the empty step has its count and no values.
  assert.match(reply, /<tr><th scope="row">2026-01-02 01:00<\/th><td>0<\/td><td>—<\/td><td>—<\/td><\/tr>/);
  const calls = text.slice(text.indexOf('モデルの呼び出し'), text.indexOf('tokens'));
  assert.match(calls, /<tr><th scope="row">2026-01-02 01:00<\/th><td>0<\/td><td>—<\/td><\/tr>/);
  assert.doesNotMatch(calls, /<title>01:00–02:00/);
  assert.match(text, /ターンの無い刻みは値なし/);
});

test('a single point between gaps is still shown, as a marker', () => {
  const text = statsPage(view('24h', [null, {}, null]), ZONE).text;
  const reply = text.slice(text.indexOf('返事までの時間'), text.indexOf('ターンの長さ'));
  assert.match(reply, /<circle [^>]*class="point s1"[^>]*><title>01:00–02:00 p50/);
});

test('the axis labels follow the period: hours for a day, days for a week and a month, in the time zone', () => {
  assert.match(statsPage(view('24h'), ZONE).text, /<text [^>]*>06:00<\/text>/);
  assert.match(statsPage(view('7d'), ZONE).text, /<text [^>]*>01-03<\/text>/);
  assert.match(statsPage(view('30d'), ZONE).text, /<text [^>]*>01-07<\/text>/);
  assert.match(statsPage(view('7d', [{}]), ZONE).text, /<th scope="row">2026-01-02 00:00<\/th>/);
});

test('the whole period is summed up above the charts, and an empty period says so', () => {
  const text = statsPage(view('24h', [{}, {}]), ZONE).text;
  assert.match(text, /ターン <strong>6<\/strong>/);
  assert.match(text, /返事まで p50 <strong>4\.2<\/strong> 秒/);
  const empty = statsPage(view('24h'), ZONE).text;
  assert.match(empty, /この期間のターンはありません/);
  assert.equal(empty.match(/<svg /g)?.length, 6, 'the frames are drawn all the same');
});

test('the y axis runs from zero to a round number above the largest value', () => {
  const text = statsPage(view('24h', [{ modelCalls: 7 }, { modelCalls: 13 }]), ZONE).text;
  const calls = text.slice(text.indexOf('モデルの呼び出し'), text.indexOf('tokens'));
  assert.match(calls, /<text [^>]*>0<\/text>/);
  assert.match(calls, /<text [^>]*>20<\/text>/);
  assert.doesNotMatch(calls, /<text [^>]*>25<\/text>/);
  const tokens = statsPage(view('24h', [{ tokens: { input: 0, cacheRead: 1_800_000, output: 0 } }]), ZONE).text;
  assert.match(tokens, /<text [^>]*>2M<\/text>/);
});

test('a chart of counts has whole numbers on its axis', () => {
  const text = statsPage(view('24h', [{ cutShort: 1, failed: 0 }]), ZONE).text;
  const cut = text.slice(text.indexOf('<h3 id="chart-cut"'));
  assert.doesNotMatch(cut, /<text [^>]*>0\.\d<\/text>/);
  assert.match(cut, /<text [^>]*>4<\/text>/);
});

test('the hours are labelled on round local times, wherever the day begins', () => {
  const { stepMs, steps } = PERIODS['24h'];
  const shifted = view('24h');
  shifted.steps = Array.from({ length: steps }, (_, index) => step(index + 13, stepMs, null));
  const labels = [...statsPage(shifted, ZONE).text.slice(0, statsPage(shifted, ZONE).text.indexOf('</svg>')).matchAll(/text-anchor="middle">([^<]+)</g)].map(m => m[1]);
  assert.deepEqual(labels, ['18:00', '00:00', '06:00', '12:00']);
});

test('a count is never split into halves on the axis', () => {
  const text = statsPage(view('24h', [{ modelCalls: 9 }]), ZONE).text;
  const calls = text.slice(text.indexOf('<h3 id="chart-calls"'), text.indexOf('<h3 id="chart-tokens'));
  assert.doesNotMatch(calls, /<text [^>]*>\d+\.5<\/text>/);
  assert.match(calls, /<text [^>]*>20<\/text>/);
});

// The tokens (差し戻し 1): cache read is of another order than input and output, so by default they are two charts, each
// with an axis of its own; a form with no script picks the series to draw together instead.

/** The part of the page from one heading to the next. */
function section(text: string, id: string): string {
  const start = text.indexOf(`<h3 id="${id}"`);
  assert.ok(start >= 0, id);
  const end = text.indexOf('<h3 ', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

test('by default input and output share a chart and an axis of their own, and cache read has its own', () => {
  const text = statsPage(view('24h', [{ tokens: { input: 1_200, cacheRead: 45_000, output: 800 } }]), ZONE).text;
  const io = section(text, 'chart-tokens-io');
  assert.match(io, /class="line s1"/);
  assert.match(io, /class="line s3"/);
  assert.doesNotMatch(io, /\bs2\b/);
  assert.match(io, /<text [^>]*>2k<\/text>/, 'the axis fits input and output');
  assert.doesNotMatch(io, /<text [^>]*>80k<\/text>/);
  assert.match(io, /<title>00:00–01:00 input 1,200<\/title>/);
  const cache = section(text, 'chart-tokens-cache');
  assert.match(cache, /class="line s2"/, 'cache read keeps its colour');
  assert.doesNotMatch(cache, /\bs[13]\b/);
  assert.match(cache, /<text [^>]*>80k<\/text>/);
  assert.doesNotMatch(text, /id="chart-tokens"/);
});

test('the chosen series are drawn in one chart on an axis fitted to them, each in its own colour', () => {
  const text = statsPage(view('24h', [{ tokens: { input: 1_200, cacheRead: 45_000, output: 800 } }]), ZONE, ['output']).text;
  assert.doesNotMatch(text, /id="chart-tokens-(io|cache)"/);
  const chosen = section(text, 'chart-tokens');
  assert.match(chosen, /<h3 id="chart-tokens">tokens（output）/);
  assert.match(chosen, /class="line s3"/);
  assert.doesNotMatch(chosen, /\bs[12]\b/);
  assert.match(chosen, /<text [^>]*>800<\/text>/);
  assert.equal(text.match(/<svg /g)?.length, 5);
  const both = section(statsPage(view('24h', [{}]), ZONE, ['input', 'cache-read']).text, 'chart-tokens');
  assert.match(both, /tokens（input・cache read）/);
  assert.match(both, /class="line s1"/);
  assert.match(both, /class="line s2"/);
  assert.match(both, /<th scope="col">input<\/th><th scope="col">cache read<\/th><\/tr>/);
});

test('the series are chosen with a form of checkboxes sent by GET, keeping the period, with no script', () => {
  const text = statsPage(view('7d', [{}]), ZONE, ['input', 'output']).text;
  const form = text.match(/<form method="get" action="\/dashboard\/stats"[\s\S]*?<\/form>/)?.[0];
  assert.ok(form, 'a GET form to this page');
  assert.match(form, /<input type="hidden" name="period" value="7d">/);
  assert.match(form, /<input type="checkbox" name="show" value="input" checked>/);
  assert.match(form, /<input type="checkbox" name="show" value="cache-read">/);
  assert.match(form, /<input type="checkbox" name="show" value="output" checked>/);
  assert.match(form, /<button type="submit">/);
  assert.match(text, /<a href="\/dashboard\/stats\?period=7d">既定の 2 つのグラフに戻す<\/a>/);
  assert.doesNotMatch(text, /<style|\sstyle=|\son[a-z]+=/i);
  // The period links keep the choice.
  assert.match(text, /href="\/dashboard\/stats\?period=30d&amp;show=input&amp;show=output"/);
  // With nothing chosen, the form shows every box unchecked and the links carry no choice.
  const plain = statsPage(view('7d', [{}]), ZONE).text;
  assert.doesNotMatch(plain, /name="show" value="[a-z-]+" checked/);
  assert.match(plain, /href="\/dashboard\/stats\?period=30d"/);
  assert.doesNotMatch(plain, /既定の 2 つのグラフに戻す/);
});

test('the chosen series are read from the query against a list, in a fixed order, and anything else is no choice', () => {
  const at = (query: string) => statsTokens(new URL(`https://natsumi.example/dashboard/stats${query}`));
  assert.deepEqual(at(''), []);
  assert.deepEqual(at('?period=7d'), []);
  assert.deepEqual(at('?show=output&show=input'), ['input', 'output'], 'as the form sends them, in the fixed order');
  assert.deepEqual(at('?show=input,output'), ['input', 'output'], 'or joined with commas');
  assert.deepEqual(at('?show=cache-read&show=cache-read'), ['cache-read']);
  for (const query of ['?show=', '?show=bogus', '?show=input,bogus', '?show=cacheRead', '?show=%3Cscript%3E']) assert.equal(at(query), undefined, query);
});
