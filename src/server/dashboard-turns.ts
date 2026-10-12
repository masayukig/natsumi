import { posix } from 'node:path';
import { filesUrl } from './dashboard-files.ts';
import { localTime, page, TURNS_PATH, turnPath } from './dashboard-view.ts';
import { html, type Html } from './html.ts';
import { isReflectionRequest } from './prompts.ts';
import type { TurnInProgress } from './thinking-loop.ts';
import { contentText, imagesIn, isEvents, type RecordEntry, type TurnReading, type TurnRow } from './turn-log.ts';

/**
 * The turns' pages (ADR 0049): the list, built from `turn_stats` alone, and each turn as the session record has it —
 * the events, the messages steered in, every model call's thinking, words and tool calls with their results, the
 * memo and the compaction — all of it whole and every word escaped. A long tool result is folded in a `<details>`.
 * Images are never put in the page: each is fetched by its own URL under /dashboard, with the cookie.
 */

/** A tool result longer than this, in bytes, is folded by default. */
export const LONG_RESULT_BYTES = 2_048;
const CURRENT = 'ターン';

export const imagePath = (turnId: string, index: number) => `${turnPath(turnId)}/images/${index}`;

const numberFormat = new Intl.NumberFormat('en-US');
const number = (value: number) => numberFormat.format(value);
const seconds = (ms: number | null) => ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`;
const KINDS = { events: 'ターン', review: '夜の振り返り', curator: '記憶の整理' } as const;

function outcome(value: string): Html {
  return value === 'ok' ? html`<span class="ok">ok</span>` : html`<span class="bad">${value}</span>`;
}

export function turnsPage(list: { rows: TurnRow[]; more: boolean; page: number }, timeZone: string, avatarId?: string): Html {
  const { rows, more } = list;
  const previous = list.page === 2 ? TURNS_PATH : `${TURNS_PATH}?page=${list.page - 1}`;
  const main = html`<section id="turns">
<h2>ターン</h2>
<p><small>新しい順。outcome が ok でないターンは赤で出します。<span class="estimated">推定</span> は、記録の位置を持つ前のターンで、時刻から対応付けたものです。</small></p>
${rows.length === 0 ? html`<p>まだ記録されたターンはありません。</p>` : html`<div class="table"><table class="turns">
<thead><tr><th>時刻</th><th>種類</th><th>出来事</th><th>outcome</th><th>返事まで</th><th>長さ</th><th>呼び出し</th>
<th>tokens <small>入力 / cache / 出力</small></th><th>経路</th><th>畳み込み</th><th>compaction</th></tr></thead>
<tbody>
${rows.map(row => html`<tr${row.outcome === 'ok' ? '' : html` class="failed"`}>
<td><a href="${turnPath(row.turnId)}">${localTime(row.startedAt, timeZone)}</a>${row.place === null && html` <span class="estimated">推定</span>`}</td>
<td>${KINDS[row.kind]}</td>
<td><code>${row.eventKinds}</code></td>
<td>${outcome(row.outcome)}</td>
<td class="number">${seconds(row.firstOutMs)}</td>
<td class="number">${seconds(row.turnMs)}</td>
<td class="number">${row.modelCalls}</td>
<td class="number">${number(row.inputTokens)} / ${number(row.cacheReadTokens)} / ${number(row.outputTokens)}</td>
<td>${row.route}</td>
<td>${row.fold}</td>
<td>${row.compacted ? 'compaction' : ''}</td>
</tr>`)}
</tbody>
</table></div>`}
<nav class="pages" aria-label="ページ">${list.page > 1 && html`<a href="${previous}">← 新しいターン</a>`}
${more && html`<a href="${TURNS_PATH}?page=${list.page + 1}">古いターン →</a>`}</nav>
</section>`;
  return page('ターン', main, { signedIn: true, current: CURRENT, avatarId });
}

export interface TurnDetail {
  row?: TurnRow;
  inProgress?: TurnInProgress;
  reading: TurnReading;
}

export function turnPage(detail: TurnDetail, timeZone: string, avatarId?: string): Html {
  const { row, inProgress, reading } = detail;
  const turnId = row?.turnId ?? inProgress!.turnId;
  const startedAt = row?.startedAt ?? inProgress!.startedAt;
  const main = html`<p><a href="${TURNS_PATH}">← ターンの一覧</a></p>
<section id="turn">
<h2>${KINDS[row?.kind ?? inProgress!.kind]} ${localTime(startedAt, timeZone)}${!row && html` <span class="note">実行中</span>`}
${reading.found && reading.estimated && html` <span class="estimated">推定</span>`}</h2>
${reading.found && reading.estimated && html`<p><small>このターンは記録の位置を持つ前のものです。時刻と <code>&lt;events&gt;</code> の区切りから対応付けたので、境目がずれていることがあります。</small></p>`}
${row ? facts(row) : html`<p><small>このターンはまだ終わっていません。数値は終わったときに記録されます。読み直すと続きが出ます。</small></p>`}
${reading.found ? html`<p><small>記録 <code>${reading.sessionFile}</code></small></p>` : ''}
</section>
${reading.found ? steps(turnId, reading.entries, timeZone)
    : html`<section><p class="bad">${reading.reason === 'no-file' ? '記録のファイルが見つかりません。' : 'このターンは記録の中に見つかりません。'}</p></section>`}`;
  return page('ターン', main, { signedIn: true, current: CURRENT, avatarId });
}

function facts(row: TurnRow): Html {
  return html`<dl class="facts">
<div><dt>出来事</dt><dd><code>${row.eventKinds}</code>${row.eventIds && html` <small>${row.eventIds.length} 件</small>`}</dd></div>
<div><dt>outcome</dt><dd>${outcome(row.outcome)}</dd></div>
<div><dt>時間</dt><dd>返事まで ${seconds(row.firstOutMs)} / ターン ${seconds(row.turnMs)}${row.reflectionMs !== null && html` / 一行メモ ${seconds(row.reflectionMs)}`}</dd></div>
<div><dt>呼び出し</dt><dd>${row.modelCalls} 回${row.toolErrors > 0 && html` <small class="bad">ツールのエラー ${row.toolErrors}</small>`}</dd></div>
<div><dt>tokens</dt><dd>入力 ${number(row.inputTokens)} / cache ${number(row.cacheReadTokens)} / 出力 ${number(row.outputTokens)}
${row.contextTokens !== null && html` <small>始めの文脈 ${number(row.contextTokens)}</small>`}</dd></div>
<div><dt>経路</dt><dd>${row.route} <small>畳み込み ${row.fold}</small></dd></div>
<div><dt>compaction</dt><dd>${row.compacted ? 'このターンの後にした' : 'なし'}</dd></div>
</dl>`;
}

type Message = { role?: string; content?: unknown; [key: string]: unknown };
type Block = { type?: string; text?: unknown; thinking?: unknown; redacted?: unknown; id?: unknown; name?: unknown; arguments?: unknown };

/** The steps of the turn in the order they were recorded; a tool result is shown under the call it answers. */
function steps(turnId: string, entries: RecordEntry[], timeZone: string): Html {
  const results = new Map<string, RecordEntry>();
  for (const entry of entries) {
    const message = entry.message as Message | undefined;
    if (entry.type === 'message' && message?.role === 'toolResult' && typeof message.toolCallId === 'string') results.set(message.toolCallId, entry);
  }
  const shown = new Set<RecordEntry>();
  let image = 0;
  const images = (entry: RecordEntry) => imagesIn(entry).map(item => {
    const index = image++;
    return html`<img src="${imagePath(turnId, index)}" alt="画像 ${index + 1}（${item.mimeType}）" loading="lazy">`;
  });
  let calls = 0;
  let eventsSeen = 0;
  let memo = false;
  const parts = entries.map(entry => {
    if (shown.has(entry)) return '';
    const at = html`<small class="at">${localTime(entry.timestamp, timeZone)}</small>`;
    const message = entry.message as Message | undefined;
    if (entry.type === 'message' && message) {
      if (message.role === 'system') {
        return html`<details class="step system"><summary>指示とツールの定義 ${at}</summary><pre>${json(message)}</pre></details>`;
      }
      if (message.role === 'user') {
        const text = contentText(message.content);
        if (isReflectionRequest(text)) {
          memo = true;
          return html`<details class="step memo-request"><summary>一行メモの依頼 ${at}</summary><pre>${text}</pre></details>`;
        }
        if (isEvents(entry)) {
          eventsSeen += 1;
          return events(eventsSeen === 1 ? '届いた出来事' : '差し込まれた出来事', text, at, images(entry));
        }
        return html`<div class="step user"><h3>入力 ${at}</h3><pre>${text}</pre>${images(entry)}</div>`;
      }
      if (message.role === 'assistant') {
        const heading = memo ? '一行メモ' : `モデル呼び出し ${++calls}`;
        const reply = assistant(message, heading, at, block => {
          const result = typeof block.id === 'string' ? results.get(block.id) : undefined;
          if (!result) return html`<p><small>結果はこのターンの記録にありません</small></p>`;
          shown.add(result);
          return toolResult(result, images(result));
        }, block => {
          // What `DECLARED_TOOL_DETAILS` puts in a declared tool's every result, so the mark holds after the config changes.
          const result = typeof block.id === 'string' ? results.get(block.id) : undefined;
          const details = (result?.message as Message | undefined)?.details as { declared?: unknown } | undefined;
          return details?.declared === true;
        });
        return reply;
      }
      if (message.role === 'toolResult') return toolResult(entry, images(entry), true);
      return html`<details class="step"><summary>${String(message.role)} ${at}</summary><pre>${json(message)}</pre></details>`;
    }
    if (entry.type === 'compaction') {
      return html`<div class="step compaction"><h3>compaction ${at}</h3>
<p>${typeof entry.tokensBefore === 'number' ? html`${number(entry.tokensBefore)} tokens から要約した` : ''}</p>
<details><summary>要約</summary><pre>${String(entry.summary ?? '')}</pre></details></div>`;
    }
    if (entry.type === 'model_change') return html`<p class="step minor">モデルを <code>${String(entry.provider)} / ${String(entry.modelId)}</code> に ${at}</p>`;
    if (entry.type === 'thinking_level_change') return html`<p class="step minor">思考の段階を <code>${String(entry.thinkingLevel)}</code> に ${at}</p>`;
    if (entry.type === 'custom_message') {
      return html`<details class="step"><summary>${String(entry.customType)} ${at}</summary><pre>${contentText(entry.content)}</pre>${images(entry)}</details>`;
    }
    return html`<details class="step minor"><summary>${entry.type} ${at}</summary><pre>${json(entry)}</pre></details>`;
  });
  return html`<section id="steps" class="steps">${parts}</section>`;
}

/** An `<events>` prompt: each line an event, then whatever the server put after it (notices). */
function events(heading: string, text: string, at: Html, images: Html[]): Html {
  const close = text.indexOf('</events>');
  const inner = text.slice('<events>'.length, close < 0 ? undefined : close);
  const after = close < 0 ? '' : text.slice(close + '</events>'.length).trim();
  const lines = inner.split('\n').filter(line => line.trim());
  return html`<div class="step events"><h3>${heading} ${at}</h3>
${lines.map(line => {
    let event: Record<string, unknown> | undefined;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { /* shown as it is */ }
    if (!event) return html`<pre>${line}</pre>`;
    const said = typeof event.text === 'string' ? event.text : undefined;
    return html`<div class="event"><p><code>${String(event.type ?? 'event')}</code>${typeof event.received_at === 'string' && html` <small>${event.received_at}</small>`}</p>
${said !== undefined && html`<blockquote>${said}</blockquote>`}
<details${said === undefined ? html` open` : ''}><summary>出来事の全体</summary><pre>${json(event)}</pre></details></div>`;
  })}
${after && html`<p><small>サーバーからの知らせ</small></p><pre>${after}</pre>`}
${images}</div>`;
}

function assistant(message: Message, heading: string, at: Html, resultOf: (block: Block) => Html, declared: (block: Block) => boolean): Html {
  const content = Array.isArray(message.content) ? message.content as Block[] : [];
  const usage = message.usage as { input?: number; cacheRead?: number; cacheWrite?: number; output?: number } | undefined;
  const stop = typeof message.stopReason === 'string' ? message.stopReason : '';
  const failed = stop === 'error' || stop === 'aborted';
  return html`<div class="step assistant${heading === '一行メモ' ? ' memo' : ''}"><h3>${heading} ${at}</h3>
<p class="meta"><small><code>${String(message.provider ?? '')} / ${String(message.model ?? '')}</code>
${stop && html` 終わり方 ${failed ? html`<span class="bad">${stop}</span>` : stop}`}
${usage && html` tokens 入力 ${number(usage.input ?? 0)} / cache ${number(usage.cacheRead ?? 0)} / 出力 ${number(usage.output ?? 0)}`}</small></p>
${typeof message.errorMessage === 'string' && html`<p class="bad">エラー</p><pre class="error">${message.errorMessage}</pre>`}
${content.map(block => {
    if (block.type === 'thinking') {
      return block.redacted ? html`<p><small>思考（伏せられている）</small></p>`
        : html`<details class="thinking" open><summary>思考</summary><div class="prose">${String(block.thinking ?? '')}</div></details>`;
    }
    if (block.type === 'text') return html`<div class="prose said">${String(block.text ?? '')}</div>`;
    if (block.type === 'toolCall') {
      const mark = declared(block) && html` <small class="declared">config で宣言したツール</small>`;
      return html`<div class="call"><p><strong>${String(block.name)}</strong>${mark}</p><pre>${json(block.arguments ?? {})}</pre>${fileLink(block)}${resultOf(block)}</div>`;
    }
    return html`<pre>${json(block)}</pre>`;
  })}</div>`;
}

/** Pi's own file tools, which name a file by `path`; of them only `read` is given to her (ADR 0047). */
const FILE_TOOLS = new Set(['read', 'write', 'edit']);
/** Where the workspace takes a relative path from. */
const WORKSPACE_DIRECTORY = '/work';

/**
 * A file tool's path, when it is inside her places, as a link to the file as it is now (ADR 0054). A shell command's
 * paths and those in a result are not looked for.
 */
function fileLink(block: Block): Html {
  const path = FILE_TOOLS.has(String(block.name)) ? (block.arguments as { path?: unknown } | undefined)?.path : undefined;
  if (typeof path !== 'string' || path.includes('\u0000')) return html``;
  const resolved = posix.resolve(WORKSPACE_DIRECTORY, path);
  const url = filesUrl(resolved);
  return url ? html`<p class="file-link"><a href="${url}">${resolved}</a> <small>今の中身です。このターンの時点のものではありません。</small></p>` : html``;
}

/** A tool's result under its call, or on its own when its call is not in the turn. */
function toolResult(entry: RecordEntry, images: Html[], alone = false): Html {
  const message = entry.message as Message;
  const text = contentText(message.content);
  const error = message.isError === true;
  const status = error ? html`<span class="bad">エラー</span>` : html`<span class="ok">成功</span>`;
  const size = Buffer.byteLength(text);
  const body = size > LONG_RESULT_BYTES
    ? html`<details class="result"><summary>${status} 結果（${number([...text].length)} 文字。開くと全文）</summary><pre>${text}</pre>${images}</details>`
    : html`<div class="result"><p>${status} 結果</p>${text && html`<pre>${text}</pre>`}${images}</div>`;
  return alone ? html`<div class="step"><h3>${String(message.toolName ?? 'ツール')} の結果</h3>${body}</div>` : body;
}

function json(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? ''; } catch { return String(value); }
}
