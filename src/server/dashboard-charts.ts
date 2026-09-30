import { PERIODS, type Period, type StatsStep, type StatsView } from './dashboard-stats.ts';
import { localTime, page, STATS_PATH } from './dashboard-view.ts';
import { html, type Html } from './html.ts';

/**
 * The statistics page (ADR 0049): charts drawn here as SVG and put in the page, with no script. Nothing is styled
 * inline, which the CSP forbids: the marks are drawn with SVG attributes and coloured by classes of the style sheet, so
 * light and dark follow the system. The SVG has a viewBox and no size of its own, and scales with the page's width.
 *
 * Each point's value is in its <title>, and the same numbers are in a table below the chart. A step with no turn has no
 * value: its line is broken there and its table row says "—", so that no turns is never drawn as a zero.
 */

const WIDTH = 480;
const HEIGHT = 180;
const LEFT = 40;
const RIGHT = 8;
const TOP = 10;
const BOTTOM = 22;
const PLOT_WIDTH = WIDTH - LEFT - RIGHT;
const PLOT_HEIGHT = HEIGHT - TOP - BOTTOM;
const TICKS = 4;

/** Which steps the x axis labels (round local times), and how. */
const AXES: Record<Period, { labelled: (local: string, index: number) => boolean; label: (local: string) => string; row: (local: string) => string; range: (from: string, to: string) => string }> = {
  '24h': { labelled: local => Number(local.slice(11, 13)) % 6 === 0, label: local => local.slice(11, 16), row: local => local.slice(0, 16), range: (from, to) => `${from.slice(11, 16)}–${to.slice(11, 16)}` },
  '7d': { labelled: local => local.slice(11, 13) === '00', label: local => local.slice(5, 10), row: local => local.slice(0, 16),
    range: (from, to) => `${from.slice(5, 16)}–${to.slice(11, 16)}` },
  '30d': { labelled: (_, index) => index % 5 === 0, label: local => local.slice(5, 10), row: local => local.slice(0, 10), range: from => from.slice(5, 10) },
};

interface Series {
  name: string;
  /** The slot of the categorical palette it is coloured by. */
  slot: 1 | 2 | 3;
  dashed?: boolean;
  value: (step: StatsStep) => number | null;
}

interface Chart {
  id: string;
  heading: string;
  unit?: string;
  form: 'line' | 'bar';
  series: Series[];
  /** A value as the table and the <title>s show it. */
  show: (value: number) => string;
  /** What a point's <title> adds after its value. */
  after?: (step: StatsStep) => string;
}

const count = new Intl.NumberFormat('en-US');
const seconds = (ms: number) => (ms / 1000).toFixed(1);

const CHARTS: Chart[] = [
  { id: 'chart-reply', heading: '返事までの時間', unit: '秒', form: 'line', show: seconds, after: step => `（${step.firstOut.count} ターン）`,
    series: [{ name: 'p50', slot: 1, value: step => step.firstOut.p50 }, { name: 'p90', slot: 2, dashed: true, value: step => step.firstOut.p90 }] },
  { id: 'chart-length', heading: 'ターンの長さ', unit: '秒', form: 'line', show: seconds, after: step => `（${step.turnLength.count} ターン）`,
    series: [{ name: 'p50', slot: 1, value: step => step.turnLength.p50 }, { name: 'p90', slot: 2, dashed: true, value: step => step.turnLength.p90 }] },
  { id: 'chart-calls', heading: 'モデルの呼び出し', unit: '回', form: 'bar', show: value => count.format(value),
    series: [{ name: '呼び出し', slot: 1, value: step => step.modelCalls }] },
];

const CUT_CHART: Chart = { id: 'chart-cut', heading: '打ち切り', unit: '回', form: 'bar', show: value => count.format(value),
  series: [{ name: '上限・時間切れ', slot: 1, value: step => step.cutShort }, { name: 'ほかの失敗', slot: 2, value: step => step.failed }] };

/** A series of tokens as the query names it. */
export type TokenName = 'input' | 'cache-read' | 'output';

/**
 * The series of tokens, in the order they are drawn and listed. Each keeps its colour in every chart it is in, so the
 * colour follows the series and not its place.
 */
const TOKENS: Record<TokenName, Series> = {
  input: { name: 'input', slot: 1, value: step => step.tokens?.input ?? null },
  'cache-read': { name: 'cache read', slot: 2, value: step => step.tokens?.cacheRead ?? null },
  output: { name: 'output', slot: 3, value: step => step.tokens?.output ?? null },
};
const TOKEN_NAMES = Object.keys(TOKENS) as TokenName[];

/**
 * The series of tokens the page is asked to draw together: `show` as the form sends it, once for each box, or joined with
 * commas. None asked for is the default, an empty list; a name not on the list makes it no choice at all.
 */
export function statsTokens(url: URL): TokenName[] | undefined {
  const asked = url.searchParams.getAll('show').flatMap(value => value.split(','));
  if (asked.some(name => !(TOKEN_NAMES as string[]).includes(name))) return undefined;
  return TOKEN_NAMES.filter(name => asked.includes(name));
}

/**
 * The charts of tokens: by default input and output in one and cache read in another, since cache read is of another
 * order and would press the others flat on a shared axis; or the series chosen, in one chart on an axis fitted to them.
 */
function tokenCharts(chosen: readonly TokenName[]): Chart[] {
  const chart = (id: string, names: TokenName[]): Chart => ({ id, heading: `tokens（${names.map(name => TOKENS[name].name).join('・')}）`,
    form: 'line', show: value => count.format(value), series: names.map(name => TOKENS[name]) });
  return chosen.length > 0 ? [chart('chart-tokens', [...chosen])]
    : [chart('chart-tokens-io', ['input', 'output']), chart('chart-tokens-cache', ['cache-read'])];
}

/** The page's address for a period, keeping the series of tokens chosen. */
const statsHref = (period: Period, chosen: readonly TokenName[]) =>
  `${STATS_PATH}?period=${period}${chosen.map(name => `&show=${name}`).join('')}`;

/** The choice of tokens: a form of checkboxes sent by GET to this page, so it needs no script. */
function tokenPicker(period: Period, chosen: readonly TokenName[]): Html {
  return html`<form method="get" action="${STATS_PATH}" class="picker">
<input type="hidden" name="period" value="${period}">
<fieldset><legend>tokens の系列を選んで 1 つのグラフで見る</legend>
${TOKEN_NAMES.map(name => html`<label><input type="checkbox" name="show" value="${name}"${chosen.includes(name) ? html` checked` : ''}> ${TOKENS[name].name}</label>
`)}<button type="submit">描き直す</button>
${chosen.length > 0 && html`<a href="${statsHref(period, [])}">既定の 2 つのグラフに戻す</a>`}</fieldset>
</form>`;
}

export function statsPage(view: StatsView, timeZone: string, chosen: readonly TokenName[] = [], avatarId?: string): Html {
  const { whole } = view;
  const main = html`<section id="stats">
<h2>統計</h2>
<nav class="periods" aria-label="期間">${(Object.keys(PERIODS) as Period[]).map(period => html`<a href="${statsHref(period, chosen)}"${
    period === view.period ? html` aria-current="true"` : ''}>${PERIODS[period].label}</a>`)}</nav>
<p><small>普通のターンだけを数えます（夜の振り返りは数えません）。ターンの無い刻みは値なしです。線を切り、表では「—」と出します。
点に触れるか表で値を確かめられます。</small></p>
${whole.turns === 0 ? html`<p>この期間のターンはありません。</p>` : html`<p class="summary">ターン <strong>${count.format(whole.turns)}</strong>
${whole.firstOut.p50 !== null && html` ・ 返事まで p50 <strong>${seconds(whole.firstOut.p50)}</strong> 秒`}${
    whole.firstOut.p90 !== null && html` ・ p90 <strong>${seconds(whole.firstOut.p90)}</strong> 秒`}
 ・ 呼び出し <strong>${count.format(whole.modelCalls ?? 0)}</strong>
 ・ 打ち切り <strong>${count.format(whole.cutShort ?? 0)}</strong>${(whole.failed ?? 0) > 0 && html` ・ ほかの失敗 <strong>${count.format(whole.failed!)}</strong>`}</p>`}
${CHARTS.map(chart => renderChart(chart, view, timeZone))}
${tokenPicker(view.period, chosen)}
${tokenCharts(chosen).map(chart => renderChart(chart, view, timeZone))}
${renderChart(CUT_CHART, view, timeZone)}
</section>`;
  return page('統計', main, { signedIn: true, current: '統計', avatarId });
}

function renderChart(chart: Chart, view: StatsView, timeZone: string): Html {
  const axis = AXES[view.period];
  const locals = view.steps.map(step => ({ from: localTime(step.start, timeZone), to: localTime(step.end, timeZone) }));
  const values = chart.series.map(series => view.steps.map(step => step.turns === 0 ? null : series.value(step)));
  const top = roundUp(Math.max(0, ...values.flat().filter((value): value is number => value !== null)), chart.unit === '秒' ? 1000 : 1,
    chart.unit !== '秒');
  const band = PLOT_WIDTH / view.steps.length;
  const y = (value: number) => TOP + PLOT_HEIGHT - (value / top) * PLOT_HEIGHT;
  const title = (series: Series, index: number, value: number) =>
    `${axis.range(locals[index]!.from, locals[index]!.to)} ${series.name} ${chart.show(value)}${chart.unit === '秒' ? ' 秒' : ''}${chart.after?.(view.steps[index]!) ?? ''}`;

  const grid = Array.from({ length: TICKS + 1 }, (_, tick) => {
    const value = (top / TICKS) * tick;
    return html`<line class="grid" x1="${LEFT}" x2="${WIDTH - RIGHT}" y1="${fixed(y(value))}" y2="${fixed(y(value))}"/>
<text class="tick" x="${LEFT - 4}" y="${fixed(y(value) + 4)}" text-anchor="end">${compact(chart.unit === '秒' ? value / 1000 : value)}</text>`;
  });
  const ticks = view.steps.flatMap((_, index) => axis.labelled(locals[index]!.from, index) ? [html`<line class="axis" x1="${fixed(LEFT + band * index)}" x2="${fixed(LEFT + band * index)}"
 y1="${TOP + PLOT_HEIGHT}" y2="${TOP + PLOT_HEIGHT + 4}"/><text class="tick" x="${fixed(LEFT + band * index)}" y="${HEIGHT - 6}" text-anchor="middle">${axis.label(locals[index]!.from)}</text>`] : []);

  const marks = chart.series.map((series, s) => {
    const points = values[s]!;
    if (chart.form === 'bar') {
      const group = band * 0.7;
      const width = group / chart.series.length;
      return points.map((value, index) => value === null || value === 0 ? '' : html`<rect class="bar s${series.slot}"
 x="${fixed(LEFT + band * index + (band - group) / 2 + width * s + 1)}" y="${fixed(y(value))}" width="${fixed(Math.max(1, width - 2))}"
 height="${fixed(TOP + PLOT_HEIGHT - y(value))}" rx="1.5"><title>${title(series, index, value)}</title></rect>`);
    }
    const x = (index: number) => LEFT + band * (index + 0.5);
    // A new piece begins after every step with no value, so a gap is never bridged.
    const path = points.map((value, index) => value === null ? '' : `${index === 0 || points[index - 1] === null ? 'M' : 'L'}${fixed(x(index))} ${fixed(y(value))}`).join('');
    return html`${path && html`<path class="line s${series.slot}" d="${path}" fill="none"${series.dashed ? html` stroke-dasharray="5 3"` : ''}/>`}
${points.map((value, index) => value === null ? '' : html`<circle class="point s${series.slot}" cx="${fixed(x(index))}" cy="${fixed(y(value))}" r="3"><title>${title(series, index, value)}</title></circle>`)}`;
  });

  return html`<h3 id="${chart.id}">${chart.heading}${chart.unit && html` <small>${chart.unit}</small>`}</h3>
${chart.series.length > 1 && html`<ul class="legend">${chart.series.map(series => html`<li><span class="swatch s${series.slot}${series.dashed ? ' dashed' : ''}"></span>${series.name}</li>`)}</ul>`}
<svg class="chart" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="${chart.id}">
${grid}
${ticks}
${marks}
</svg>
<details><summary>数値の表</summary><div class="table"><table class="list stats">
<thead><tr><th scope="col">時間帯</th><th scope="col">ターン</th>${chart.series.map(series => html`<th scope="col">${series.name}</th>`)}</tr></thead>
<tbody>${view.steps.map((step, index) => html`<tr><th scope="row">${axis.row(locals[index]!.from)}</th><td>${count.format(step.turns)}</td>${
    values.map(points => { const value = points[index] ?? null; return html`<td>${value === null ? '—' : chart.show(value)}</td>`; })}</tr>`)}</tbody>
</table></div></details>`;
}

/**
 * A round top for the axis above `max`, so each of the TICKS steps is 1, 2, 2.5 or 5 times a power of ten (in `unit`s);
 * for counts, a step is at least 1.
 */
function roundUp(max: number, unit: number, whole: boolean): number {
  if (max <= 0) return whole ? TICKS * unit : unit;
  const raw = whole ? Math.max(1, max / unit / TICKS) : max / unit / TICKS;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(factor => factor * power).filter(candidate => !whole || Number.isInteger(candidate))
    .find(candidate => candidate >= raw)!;
  return step * TICKS * unit;
}

/** An axis label: 1.5k, 2M. */
function compact(value: number): string {
  const trim = (number: number) => String(Number(number.toFixed(1)));
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trim(value / 1_000)}k`;
  return trim(value);
}

const fixed = (value: number) => Number(value.toFixed(1));
