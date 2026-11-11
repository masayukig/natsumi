import { localTime, page, SENTINEL_LABEL, SENTINEL_PATH } from './dashboard-view.ts';
import { html, type Html } from './html.ts';
import type { SentinelApproval, SentinelGrant, SentinelItem, SentinelRecord } from './sentinel-client.ts';

/**
 * The pages of the sentinel's approvals (ADR 0096), under /dashboard/sentinel: what waits for the owner's answer, the
 * grants in force, and the sentinel's records. Everything shown is the sentinel's, built by it from facts, and goes
 * through `html` as plain text: a pull request's title in a parameter or a body is never read as HTML, Markdown or a
 * link. The pages only show; the answer and the revoke are form POSTs to the paths below, which the dashboard checks.
 */

export { SENTINEL_PATH };
export const SENTINEL_RECORDS_PATH = `${SENTINEL_PATH}/records`;
export const sentinelApprovalPath = (id: string) => `${SENTINEL_PATH}/approvals/${encodeURIComponent(id)}`;
export const sentinelGrantPath = (id: string) => `${SENTINEL_PATH}/grants/${encodeURIComponent(id)}`;
export const sentinelRecordPath = (id: number) => `${SENTINEL_RECORDS_PATH}/${id}`;

const STATES: Record<string, Html> = {
  open: html`<span class="note">答えを待っている</span>`,
  allowed: html`<span class="ok">許した</span>`,
  denied: html`<span class="bad">断った</span>`,
  expired: html`<span class="bad">答えの無いまま期限が過ぎた</span>`,
};
const KINDS: Record<string, string> = { request: '要求が ask になった', beforehand: '先に頼まれた一覧' };
const SCOPES: Record<string, string> = { once: '1 回', timed: '期限付き' };

function frame(title: string, main: Html, avatarId?: string): Html {
  return page(title, main, { signedIn: true, current: SENTINEL_LABEL, sentinel: true, avatarId });
}

/** A time of the sentinel's (RFC 3339, UTC) in the owner's time zone, or as it came when it is not one. */
function when(iso: string | undefined, timeZone: string): string {
  if (!iso) return '—';
  return Number.isNaN(Date.parse(iso)) ? iso : localTime(iso, timeZone);
}

function table(head: Html, rows: Html[], empty: string): Html {
  return rows.length === 0 ? html`<p><small>${empty}</small></p>`
    : html`<div class="table"><table class="list"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

export interface SentinelOverview {
  approvals: SentinelApproval[];
  grants: SentinelGrant[];
  /** The grant just revoked, for a word on it. */
  revoked?: string;
}

/** What waits for an answer, oldest first, and the grants in force, each with its page; and the way to the records. */
export function sentinelPage(view: SentinelOverview, timeZone: string, avatarId?: string): Html {
  const at = (iso: string | undefined) => when(iso, timeZone);
  const main = html`<section id="sentinel">
<h2>関所</h2>
${view.revoked && html`<p class="note">許し <code>${view.revoked}</code> を取り消しました。</p>`}
<p><small>ペネロペの要求のうち関所が本人に聞いたものと、本人が出した許しです。答えと取り消しはこの画面からだけ出せます。中身の文は関所が事実から組んだものです。</small></p>

<h3>承認待ち</h3>
${table(html`<th>作った時刻</th><th>期限</th><th>中身</th><th>種類</th><th>当たった回数</th>`, view.approvals.map(approval => html`<tr>
<td><a href="${sentinelApprovalPath(approval.id)}">${at(approval.created)}</a></td><td>${at(approval.expires)}</td>
<td class="words"><a href="${sentinelApprovalPath(approval.id)}">${approval.summary || approval.id}</a></td>
<td>${KINDS[approval.kind] ?? approval.kind}<br><small><code>${approval.id}</code></small></td><td>${approval.requests}</td></tr>`),
  '答えを待っている承認待ちはありません。')}

<h3>効いている許し</h3>
${table(html`<th>範囲</th><th>期限</th><th>中身</th><th>出した承認待ち</th><th></th>`, view.grants.map(grant => html`<tr>
<td>${SCOPES[grant.scope] ?? grant.scope}<br><small><code>${grant.id}</code></small></td><td>${grant.expires ? at(grant.expires) : '期限なし'}</td>
<td class="words">${grant.summary}${grant.target && html`<br><small>${grant.destination ?? ''} ${grant.operation ?? ''} ${grant.target}</small>`}</td>
<td>${grant.approval && html`<a href="${sentinelApprovalPath(grant.approval)}"><code>${grant.approval}</code></a>`}</td>
<td><a href="${sentinelGrantPath(grant.id)}">取り消す</a></td></tr>`), '効いている許しはありません。')}

<p><a href="${SENTINEL_RECORDS_PATH}">監査の記録を読む</a></p>
</section>`;
  return frame(SENTINEL_LABEL, main, avatarId);
}

function itemFacts(item: SentinelItem, index: number, total: number): Html {
  return html`<section class="step">
${total > 1 && html`<h3>${index + 1} つ目</h3>`}
<dl class="facts">
<div><dt>宛先</dt><dd><code>${item.destination}</code></dd></div>
${item.operation && html`<div><dt>操作</dt><dd><code>${item.operation}</code></dd></div>`}
${item.targetText && html`<div><dt>対象</dt><dd class="words">${item.targetText}</dd></div>`}
${item.method && html`<div><dt>要求</dt><dd><code>${item.method}</code> <code>${item.path ?? ''}</code>${item.query && html`<br><small>query</small> <code>${item.query}</code>`}</dd></div>`}
${item.params.length > 0 && html`<div><dt>引数</dt><dd><div class="table"><table class="list"><tbody>${item.params.map(param => html`<tr>
<th>${param.name}</th><td class="words">${param.value}</td></tr>`)}</tbody></table></div></dd></div>`}
${item.facts.length > 0 && html`<div><dt>関所が引いた事実</dt><dd><div class="table"><table class="list"><tbody>${item.facts.map(fact => html`<tr>
<th>${fact.name}</th><td class="words">${fact.value}</td></tr>`)}</tbody></table></div></dd></div>`}
${item.body && html`<div><dt>本文</dt><dd>${item.body.binary ? html`<small>文字でない本文</small>` : html`<pre>${item.body.text}</pre>`}
<small>${item.body.size} バイト</small>${item.body.truncated && html`<small class="bad">頭だけ（関所が読む上限まで）</small>`}</dd></div>`}
</dl>
</section>`;
}

export interface SentinelApprovalView {
  approval: SentinelApproval;
  /** Just answered: the sentinel took it. */
  answered?: boolean;
}

/** One approval: its facts as the sentinel gave them, and while it is open, the form of its choices. */
export function sentinelApprovalPage({ approval, answered }: SentinelApprovalView, timeZone: string, avatarId?: string): Html {
  const at = (iso: string | undefined) => when(iso, timeZone);
  const open = approval.state === 'open';
  const chosen = approval.choice === undefined ? undefined : approval.choices.find(choice => choice.id === approval.choice);
  const main = html`<section id="sentinel-approval">
<h2>関所の承認待ち</h2>
${answered && html`<p class="note">答えを関所に渡しました。</p>`}
<p class="words"><strong>${approval.summary}</strong></p>
<dl class="facts">
<div><dt>状態</dt><dd>${STATES[approval.state] ?? approval.state}</dd></div>
${chosen ? html`<div><dt>許した範囲</dt><dd>${chosen.label}</dd></div>`
    : approval.choice && html`<div><dt>許した範囲</dt><dd><code>${approval.choice}</code></dd></div>`}
${approval.grants.length > 0 && html`<div><dt>出した許し</dt><dd>${approval.grants.map(grant => html`<code>${grant}</code> `)}</dd></div>`}
<div><dt>種類</dt><dd>${KINDS[approval.kind] ?? approval.kind}</dd></div>
<div><dt>向け直し元</dt><dd><code>${approval.source}</code></dd></div>
<div><dt>作った時刻</dt><dd>${at(approval.created)}</dd></div>
<div><dt>期限</dt><dd>${at(approval.expires)}</dd></div>
${approval.answered && html`<div><dt>答えた時刻</dt><dd>${at(approval.answered)}</dd></div>`}
<div><dt>当たった回数</dt><dd>${approval.requests}</dd></div>
<div><dt>id</dt><dd><code>${approval.id}</code></dd></div>
</dl>
${approval.items.map((item, index) => itemFacts(item, index, approval.items.length))}
${open && html`<form method="post" action="${sentinelApprovalPath(approval.id)}/answer">
${approval.choices.length > 0 && html`<fieldset><legend>許す範囲</legend>
${approval.choices.map((choice, index) => html`<label><input type="radio" name="choice" value="${choice.id}"${index === 0 ? html` checked` : ''}> ${choice.label}
<small>${SCOPES[choice.scope] ?? choice.scope}</small></label>`)}
</fieldset>`}
${approval.choices.length > 0 && html`<button type="submit" name="answer" value="allow">許す</button>`}
<button type="submit" name="answer" value="deny">断る</button>
<p><small>断るのは、この承認待ちだけです。同じ承認待ちに答えられるのは 1 度だけです。</small></p>
</form>`}
<p><a href="${SENTINEL_PATH}">関所へ戻る</a></p>
</section>`;
  return frame('関所の承認待ち', main, avatarId);
}

/** The page that asks before a grant is revoked; the revoke is a POST to the same path and `/revoke`. */
export function sentinelGrantPage(grant: SentinelGrant, timeZone: string, avatarId?: string): Html {
  const at = (iso: string | undefined) => when(iso, timeZone);
  const main = html`<section id="sentinel-grant">
<h2>この許しを取り消しますか</h2>
<dl class="facts">
<div><dt>中身</dt><dd class="words">${grant.summary}</dd></div>
<div><dt>範囲</dt><dd>${SCOPES[grant.scope] ?? grant.scope}</dd></div>
<div><dt>期限</dt><dd>${grant.expires ? at(grant.expires) : '期限なし'}</dd></div>
${grant.destination && html`<div><dt>宛先</dt><dd><code>${grant.destination}</code></dd></div>`}
${grant.operation && html`<div><dt>操作</dt><dd><code>${grant.operation}</code></dd></div>`}
${grant.target && html`<div><dt>対象</dt><dd class="words">${grant.target}</dd></div>`}
${grant.method && html`<div><dt>要求</dt><dd><code>${grant.method}</code> <code>${grant.path ?? ''}</code></dd></div>`}
<div><dt>向け直し元</dt><dd><code>${grant.source}</code></dd></div>
<div><dt>出した時刻</dt><dd>${at(grant.created)}</dd></div>
${grant.approval && html`<div><dt>出した承認待ち</dt><dd><a href="${sentinelApprovalPath(grant.approval)}"><code>${grant.approval}</code></a></dd></div>`}
<div><dt>id</dt><dd><code>${grant.id}</code></dd></div>
</dl>
<p><small>取り消すと、次に同じ要求が来たときは関所がまた本人に聞きます。取り消したことはペネロペには知らせません。</small></p>
<form method="post" action="${sentinelGrantPath(grant.id)}/revoke"><button type="submit">この許しを取り消す</button></form>
<p><a href="${SENTINEL_PATH}">やめる</a></p>
</section>`;
  return frame('許しの取り消し', main, avatarId);
}

const RECORD_ORDER = ['time', 'source', 'kind', 'treatment', 'verdict', 'reason', 'name', 'address', 'method', 'path', 'query', 'operation',
  'target', 'approval', 'grant', 'status', 'responseBytes', 'bytesUp', 'bytesDown', 'durationNs', 'dnsType', 'dnsRcode', 'error', 'authdReason', 'finished'];

const VERDICTS: Record<string, Html> = {
  allow: html`<span class="ok">allow</span>`, ask: html`<span class="note">ask</span>`, deny: html`<span class="bad">deny</span>`,
};

const value = (record: SentinelRecord, key: string): string => {
  const found = record.fields[key];
  return found === undefined ? '' : String(found);
};

/** A page of the sentinel's records, newest first; the next page is from before the id the sentinel gave. */
export function sentinelRecordsPage(view: { records: SentinelRecord[]; next?: number; before?: number }, timeZone: string, avatarId?: string): Html {
  const main = html`<section id="sentinel-records">
<h2>関所の監査の記録</h2>
<p><small>関所が残した記録を新しい順に読みます。読むだけで、消したり直したりはできません。どこまで残すかは関所が決めます。</small></p>
${table(html`<th>番号</th><th>時刻</th><th>種類</th><th>判定</th><th>宛先</th><th>要求</th><th>操作と対象</th><th>承認待ち</th><th>状態</th>`,
    view.records.map(record => html`<tr>
<td><a href="${sentinelRecordPath(record.id)}">${record.id}</a></td><td>${when(record.time, timeZone)}</td><td><code>${record.kind}</code></td>
<td>${VERDICTS[value(record, 'verdict')] ?? value(record, 'verdict')}</td><td><code>${value(record, 'name')}</code></td>
<td>${value(record, 'method') && html`<code>${value(record, 'method')}</code> `}<code>${value(record, 'path')}</code></td>
<td class="words">${value(record, 'operation')} ${value(record, 'target')}</td>
<td>${value(record, 'approval') && html`<a href="${sentinelApprovalPath(value(record, 'approval'))}"><code>${value(record, 'approval')}</code></a>`}</td>
<td>${value(record, 'status')}${record.fields.finished === false && html` <small class="bad">途中</small>`}</td></tr>`),
    view.before === undefined ? '記録はありません。' : 'これより前の記録はありません。')}
<nav class="pages" aria-label="ページ">${view.before !== undefined && html`<a href="${SENTINEL_RECORDS_PATH}">← 最新</a>`}
${view.next !== undefined && html`<a href="${SENTINEL_RECORDS_PATH}?before=${view.next}">より前 →</a>`}</nav>
<p><a href="${SENTINEL_PATH}">関所へ戻る</a></p>
</section>`;
  return frame('関所の監査の記録', main, avatarId);
}

/** One record whole: every field the sentinel gave, and the head of the request's body as plain text. */
export function sentinelRecordPage(record: SentinelRecord, timeZone: string, avatarId?: string): Html {
  const keys = [...RECORD_ORDER.filter(key => key in record.fields || key === 'time'),
    ...Object.keys(record.fields).filter(key => !RECORD_ORDER.includes(key)).sort()];
  const main = html`<section id="sentinel-record">
<h2>関所の記録 ${record.id}</h2>
<dl class="facts">
${keys.map(key => html`<div><dt><code>${key}</code></dt><dd class="words">${key === 'time' ? when(record.time, timeZone)
    : key === 'verdict' ? VERDICTS[value(record, key)] ?? value(record, key)
    : key === 'approval' ? html`<a href="${sentinelApprovalPath(value(record, key))}"><code>${value(record, key)}</code></a>`
    : value(record, key)}</dd></div>`)}
${record.dnsAnswer && html`<div><dt><code>dnsAnswer</code></dt><dd>${record.dnsAnswer.map(address => html`<code>${address}</code> `)}</dd></div>`}
${record.request && html`<div><dt><code>request</code></dt><dd>${record.request.binary ? html`<small>文字でない本文</small>` : html`<pre>${record.request.text}</pre>`}
<small>${record.request.size} バイト</small>${record.request.truncated && html`<small>頭だけ</small>`}${record.request.sha256 && html` <small>sha256 <code>${record.request.sha256}</code></small>`}</dd></div>`}
</dl>
<p><a href="${SENTINEL_RECORDS_PATH}">記録の一覧へ</a></p>
</section>`;
  return frame(`関所の記録 ${record.id}`, main, avatarId);
}

/** The socket is not there: nothing is shown, and nothing is taken. */
export function sentinelUnreachablePage(avatarId?: string): Html {
  return frame('関所につながらない', html`<section><h2>関所につながらない</h2>
<p>関所の承認の口（socket）につながりません。つながるまで、承認待ちを読むことも、答えることも、許しを取り消すこともできません。</p>
<p><small>承認待ちは関所の側で答えを待ったまま残り、勝手に許されることはありません。サーバーはつなぎ直しを続けています。</small></p>
<p><a href="${SENTINEL_PATH}">開き直す</a></p></section>`, avatarId);
}

/** The sentinel refused: its status and its own words, as they came. */
export function sentinelRefusedPage(heading: string, status: number, error: string, back: string, avatarId?: string): Html {
  return frame(heading, html`<section><h2>${heading}</h2>
<p>関所の答え: <code>${status}</code>${error && html` <span class="words">${error}</span>`}</p>
<p><a href="${back}">戻る</a></p></section>`, avatarId);
}
