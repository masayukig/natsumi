import { APPROVAL_STATES, type ApprovalRow, type ApprovalState, type DevicesView, type DovePostRow, type SessionState, type Waits } from './dashboard-records.ts';
import { APPROVALS_PATH, DOVE_PATH, localTime, MEMOS_PATH, page, turnPath, WAITS_LIVE_PATH } from './dashboard-view.ts';
import { html, type Html } from './html.ts';
import type { MemoReading, TurnRow } from './turn-log.ts';

/**
 * The dashboard's lists (ADR 0049): the failures and what waits, the memos, the dove's posts and the devices. Like the
 * other pages they only read, every value goes through `html`, and a failure or a memo links to its turn. The
 * failures and waits refresh themselves; the other lists are read again by reloading.
 */

const KINDS = { events: 'ターン', review: '夜の振り返り' } as const;

/** A page of a list, keeping the list's other query values; the first page has no number. */
function pageHref(path: string, page: number, query: Record<string, string> = {}): string {
  const search = new URLSearchParams(query);
  if (page > 1) search.set('page', String(page));
  const text = search.toString();
  return text === '' ? path : `${path}?${text}`;
}

/** The navigation between pages of a list: newer to the left, older to the right. */
function pages(path: string, current: number, more: boolean, newer: string, older: string, query: Record<string, string> = {}): Html {
  return html`<nav class="pages" aria-label="ページ">${current > 1 && html`<a href="${pageHref(path, current - 1, query)}">← ${newer}</a>`}
${more && html`<a href="${pageHref(path, current + 1, query)}">${older} →</a>`}</nav>`;
}

function table(head: Html, rows: Html[], empty: string): Html {
  return rows.length === 0 ? html`<p><small>${empty}</small></p>`
    : html`<div class="table"><table class="list"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function waitsPage(waits: Waits, timeZone: string): Html {
  return page('失敗と待ち', renderWaits(waits, timeZone), { signedIn: true, current: '失敗と待ち' });
}

/** The failures and what waits, as one section the script refreshes in place. */
export function renderWaits(waits: Waits, timeZone: string): Html {
  const at = (iso: string) => localTime(iso, timeZone);
  const turnLink = (turnId: string | null, label: string) => turnId ? html`<a href="${turnPath(turnId)}">${label}</a>` : label;
  return html`<section id="waits" data-refresh="${WAITS_LIVE_PATH}" aria-live="polite">
<h2>失敗と待ち</h2>
<p><small>それぞれ新しいもの（待っているものは近いもの）から最大 20 件です。承認などの操作はアプリで行います。</small></p>

<h3>失敗した出来事</h3>
${table(html`<th>時刻</th><th>出来事</th><th>理由</th><th>ターン</th>`, waits.failedEvents.map(event => html`<tr>
<td>${at(event.updatedAt)}</td><td><code>${event.kind}</code></td><td><span class="bad">${event.reason ?? '—'}</span></td>
<td>${event.turnId ? turnLink(event.turnId, '詳細') : html`<small>不明</small>`}</td></tr>`), '失敗した出来事はありません。')}

<h3>打ち切られたターン</h3>
${table(html`<th>時刻</th><th>種類</th><th>出来事</th><th>outcome</th>`, waits.cutTurns.map(turn => html`<tr>
<td>${turnLink(turn.turnId, at(turn.startedAt))}</td><td>${KINDS[turn.kind]}</td><td><code>${turn.eventKinds}</code></td>
<td><span class="bad">${turn.outcome}</span></td></tr>`), 'outcome が ok でないターンはありません。')}

<h3>承認待ち</h3>
<p><small><a href="${pageHref(APPROVALS_PATH, 1, { state: 'pending' })}">承認待ちの一覧</a> ・ <a href="${APPROVALS_PATH}">これまでの承認</a></small></p>
${waits.approvals.length === 0 ? html`<p><small>承認待ちはありません。</small></p>` : html`<div class="cards">${waits.approvals.map(item => html`<article class="card">
<p><code>${item.kind}</code>${item.channel && html` ${item.channel}`}${item.placement && html` <small>${item.placement}</small>`}
${item.verdict && html` <small>判定 ${item.verdict}</small>`}${item.flagged.length > 0 && html` <small class="bad">${item.flagged.join('、')}</small>`}</p>
${item.text !== undefined && html`<div class="prose">${item.text}</div>`}
<p><small>${at(item.createdAt)} から</small> ${item.expired ? html`<span class="bad">期限切れ</span> <small>${at(item.expiresAt)}</small>`
    : html`<small>期限 ${at(item.expiresAt)}</small>`}</p></article>`)}</div>`}

<h3>予約した確認</h3>
<dl class="facts"><div><dt>次の夜の切り替え</dt><dd>${waits.nextRotationAt === null ? 'しない設定' : at(waits.nextRotationAt)}</dd></div></dl>
${table(html`<th>予定</th><th>理由</th><th>予約した時刻</th>`, waits.checks.map(check => html`<tr>
<td>${at(check.dueAt)}</td><td class="words">${check.reason}</td><td>${at(check.createdAt)}</td></tr>`), '予約した確認はありません。')}

<h3>外のエージェントへの依頼</h3>
${table(html`<th>相手</th><th>状態</th><th>送った時刻</th><th>最後の変化</th><th>task</th>`, waits.agentTasks.map(task => html`<tr>
<td>${task.agent}</td><td>${agentState(task.state)}</td><td>${at(task.sentAt)}</td><td>${at(task.updatedAt)}</td>
<td><code>${task.taskId}</code></td></tr>`), '外のエージェントへの依頼はありません。')}

<h3>夜の切り替え</h3>
${table(html`<th>時刻</th><th>結果</th><th>理由</th><th>記録</th>`, waits.rotations.map(rotation => html`<tr>
<td>${at(rotation.createdAt)}</td><td>${rotation.state === 'switched' ? html`<span class="ok">switched</span>`
    : rotation.state === 'failed' ? html`<span class="bad">failed</span>` : rotation.state}</td>
<td>${rotation.reason ?? ''}</td><td><code>${rotation.fromSessionFile}</code>${rotation.toSessionFile && html` → <code>${rotation.toSessionFile}</code>`}</td>
</tr>`), 'まだ夜の切り替えはありません。')}
</section>`;
}

function agentState(state: string): Html {
  if (state === 'completed') return html`<span class="ok">${state}</span>`;
  if (state === 'failed' || state === 'gave-up') return html`<span class="bad">${state}</span>`;
  return html`<span class="note">${state}</span>`;
}

const MEMO_MISSING: Record<Exclude<MemoReading, { found: true }>['reason'], string> = {
  estimated: '記録の位置を持つ前のターンなので、ここでは読みません。一行メモは詳細で見られます。',
  'no-file': '記録のファイルが見つかりません。',
  moved: '記録の中の位置がずれています。一行メモは詳細で見られます。',
  'too-far': '一行メモがターンの終わりから遠いので、ここでは読みません。詳細で見られます。',
  'no-memo': 'このターンに一行メモはありません。',
};

export function memosPage(list: { page: number; more: boolean; memos: { row: TurnRow; memo: MemoReading }[] }, timeZone: string): Html {
  const main = html`<section id="memos">
<h2>一行メモ</h2>
<p><small>ターンの終わりに書いた一行メモを、新しい順に 20 件ずつ出します。時刻を押すとそのターンの詳細です。</small></p>
${list.memos.length === 0 ? html`<p>まだ一行メモはありません。</p>` : html`<div class="cards">${list.memos.map(({ row, memo }) => html`<article class="card memo">
<p><a href="${turnPath(row.turnId)}">${localTime(row.startedAt, timeZone)}</a> <code>${row.eventKinds}</code>
${row.place === null && html` <span class="estimated">推定</span>`}${row.outcome !== 'ok' && html` <span class="bad">${row.outcome}</span>`}</p>
${memo.found ? html`<div class="prose">${memo.text}</div>` : html`<p><small>${MEMO_MISSING[memo.reason]}</small></p>`}
</article>`)}</div>`}
${pages(MEMOS_PATH, list.page, list.more, '新しいメモ', '古いメモ')}
</section>`;
  return page('一行メモ', main, { signedIn: true, current: '一行メモ' });
}

export function dovePage(list: { page: number; more: boolean; rows: DovePostRow[] }, timeZone: string): Html {
  const at = (iso: string) => localTime(iso, timeZone);
  const main = html`<section id="dove">
<h2>ポッポさん</h2>
<p><small>なつみがポッポさんに頼んだ投稿とリアクションを、新しい順に 50 件ずつ出します。点数は問題点ごとの判定で、赤は引っかかったものです。</small></p>
${list.rows.length === 0 ? html`<p>まだ依頼はありません。</p>` : html`<div class="cards">${list.rows.map(post => html`<article class="card" id="${post.postId}">
<p><strong>${post.kind === 'reaction' ? 'リアクション' : '投稿'}</strong> ${post.channel} <small>${post.reference}</small>
<small>${at(post.createdAt)}</small></p>
<dl class="facts">
<div><dt>状態</dt><dd>${doveState(post.state)}${post.failure && html` <code>${post.failure}</code>`} <small>${at(post.updatedAt)} に更新</small></dd></div>
<div><dt>判定</dt><dd>${post.verdict ?? '—'}${post.scores.length > 0 && html` ${post.scores.map(score => html`<small${score.flagged ? html` class="bad"` : ''}>${score.label} ${score.score.toFixed(2)}</small> `)}`}</dd></div>
<div><dt>投稿先</dt><dd>${post.placement ?? '—'}${post.sentPlacement && post.sentPlacement !== post.placement && html` <small>送った先 ${post.sentPlacement}</small>`}</dd></div>
${post.expression && html`<div><dt>表情</dt><dd>${post.expression}</dd></div>`}
</dl>
<div class="prose">${post.text}</div>
${post.sentText && post.sentText !== post.text && html`<p><small>送った文</small></p><div class="prose">${post.sentText}</div>`}
</article>`)}</div>`}
${pages(DOVE_PATH, list.page, list.more, '新しい依頼', '古い依頼')}
</section>`;
  return page('ポッポさん', main, { signedIn: true, current: 'ポッポさん' });
}

function doveState(state: string): Html {
  if (state === 'sent') return html`<span class="ok">${state}</span>`;
  if (state === 'failed' || state === 'expired' || state === 'rejected' || state === 'returned') return html`<span class="bad">${state}</span>`;
  return html`<span class="note">${state}</span>`;
}

const APPROVAL_LABELS: Record<ApprovalState, string> = { pending: '待ち', approved: '承認', edited: '修正', rejected: '却下', expired: '期限切れ' };
const DECISIONS: Record<string, string> = { approve: 'そのまま承認', edit: '直して承認', reject: '却下' };
/** How much of a device's ID is shown: `device-` and the first 8 of its UUID, enough to tell the owner's few devices apart. */
const DEVICE_ID_SHOWN = 'device-'.length + 8;

/** The approvals, all or one outcome's (ADR 0040, ADR 0041), each with its post in the dove's list. */
export function approvalsPage(list: { page: number; more: boolean; rows: ApprovalRow[]; state?: ApprovalState }, timeZone: string): Html {
  const at = (iso: string) => localTime(iso, timeZone);
  const query: Record<string, string> = list.state ? { state: list.state } : {};
  const filters = [{ label: 'すべて', href: APPROVALS_PATH, current: list.state === undefined },
    ...APPROVAL_STATES.map(state => ({ label: APPROVAL_LABELS[state], href: pageHref(APPROVALS_PATH, 1, { state }), current: list.state === state }))];
  const main = html`<section id="approvals">
<h2>承認の履歴</h2>
<p><small>本人に承認を求めた投稿を、新しい順に 20 件ずつ出します。承認などの操作はアプリで行います。</small></p>
<nav class="filters" aria-label="結果で絞る">${filters.map(filter => html`<a href="${filter.href}"${filter.current ? html` aria-current="true"` : ''}>${filter.label}</a> `)}</nav>
${list.rows.length === 0 ? html`<p>${list.state ? `${APPROVAL_LABELS[list.state]}の承認はありません。` : 'まだ承認はありません。'}</p>`
    : html`<div class="cards">${list.rows.map(item => approvalCard(item, at))}</div>`}
${pages(APPROVALS_PATH, list.page, list.more, '新しい承認', '古い承認', query)}
</section>`;
  return page('承認の履歴', main, { signedIn: true, current: '承認の履歴' });
}

function approvalCard(item: ApprovalRow, at: (iso: string) => string): Html {
  const { shown, post } = item;
  const label = APPROVAL_LABELS[item.state as ApprovalState] ?? item.state;
  const device = item.deviceId && (item.deviceId.length > DEVICE_ID_SHOWN
    ? html`<code title="${item.deviceId}">${item.deviceId.slice(0, DEVICE_ID_SHOWN)}…</code>` : html`<code>${item.deviceId}</code>`);
  return html`<article class="card" id="${item.approvalId}">
<p><strong>${approvalState(item.state, label)}</strong> <code>${item.kind}</code>${shown.channel && html` ${shown.channel}`}${shown.placement && html` <small>${shown.placement}</small>`}
<small>${at(item.createdAt)}</small></p>
<dl class="facts">
<div><dt>期限</dt><dd>${at(item.expiresAt)}${item.expired && html` <span class="bad">期限切れ</span> <small>まだ閉じていません</small>`}</dd></div>
<div><dt>決めたこと</dt><dd>${item.decision ? DECISIONS[item.decision] ?? item.decision : '—'}${item.decidedPlacement && html` <small>置き場所 ${item.decidedPlacement}</small>`}
${device && html` <small>端末</small> ${device}`}</dd></div>
<div><dt>閉じた時刻</dt><dd>${item.resolvedAt ? at(item.resolvedAt) : '—'}</dd></div>
<div><dt>送った結果</dt><dd>${item.delivery === 'sent' ? html`<span class="ok">送れた</span>` : item.delivery === 'failed'
    ? html`<span class="bad">送れなかった</span>${item.deliveryReason && html` <code>${item.deliveryReason}</code>`}` : '—'}</dd></div>
<div><dt>判定</dt><dd>${shown.verdict ?? '—'}${shown.scores.length > 0 && html` ${shown.scores.map(score => html`<small${score.flagged ? html` class="bad"` : ''}>${score.label} ${score.score.toFixed(2)}</small> `)}`}</dd></div>
${shown.expression && html`<div><dt>表情</dt><dd>${shown.expression}</dd></div>`}
<div><dt>ポッポさん</dt><dd>${post ? html`<a href="${`${pageHref(DOVE_PATH, post.page)}#${encodeURIComponent(post.postId)}`}">${doveState(post.state)}</a>${post.failure && html` <code>${post.failure}</code>`}`
    : html`<small>投稿が見つかりません</small>`}</dd></div>
</dl>
${shown.replyTo && html`<p><small>返信先${shown.replyTo.speaker && html` ${shown.replyTo.speaker}`}</small></p>${shown.replyTo.text !== undefined && html`<blockquote class="prose">${shown.replyTo.text}</blockquote>`}`}
<p><small>承認を求めた文</small></p>${shown.text !== undefined ? html`<div class="prose">${shown.text}</div>` : html`<p><small>読めません</small></p>`}
${item.decidedText !== null && html`<p><small>本人が直した文</small></p><div class="prose">${item.decidedText}</div>`}
${item.sentText !== null && item.sentText !== item.decidedText && item.sentText !== shown.text && html`<p><small>送った文</small></p><div class="prose">${item.sentText}</div>`}
</article>`;
}

function approvalState(state: string, label: string): Html {
  if (state === 'approved' || state === 'edited') return html`<span class="ok">${label}</span>`;
  if (state === 'rejected' || state === 'expired') return html`<span class="bad">${label}</span>`;
  return html`<span class="note">${label}</span>`;
}

const SESSION_STATES: Record<SessionState | 'gone', string> = { live: '有効', revoked: '失効', expired: '期限切れ', gone: 'もう無い' };

/** The devices and the login sessions; `currentSessionId` is this browser's own. */
export function devicesPage(view: DevicesView, currentSessionId: string, timeZone: string): Html {
  const at = (iso: string) => localTime(iso, timeZone);
  const { counts, rows } = view.sessions;
  const main = html`<section id="devices">
<h2>端末</h2>
${table(html`<th>端末</th><th>接続</th><th>最後に接続</th><th>push</th><th>セッション</th><th>登録</th>`, view.devices.map(device => html`<tr>
<td><code>${device.deviceId}</code></td>
<td>${device.connected ? html`<span class="ok">つながっている</span>` : html`<small>つながっていない</small>`}</td>
<td>${at(device.lastSeenAt)}</td>
<td>${device.push ? html`${device.push.environment} <small>${at(device.push.updatedAt)} に登録</small>` : html`<small>なし</small>`}</td>
<td>${SESSION_STATES[device.sessionState]}</td>
<td>${at(device.createdAt)}</td></tr>`), 'まだ端末はありません。')}
</section>
<section id="sessions">
<h2>ログインのセッション</h2>
<p>有効 ${counts.live} ・ 終わった ${counts.ended} <small>ダッシュボードのセッションも含みます。最後の利用は、使うたびに 30 日先へ延びる期限から逆算したものです（1 時間の幅があります）。</small></p>
${table(html`<th>セッション</th><th>状態</th><th>最後の利用</th><th>期限</th><th>作成</th><th>端末</th>`, rows.map(session => html`<tr>
<td><code>${session.sessionId}</code>${session.sessionId === currentSessionId && html` <span class="note">このブラウザ</span>`}</td>
<td>${session.state === 'live' ? html`<span class="ok">${SESSION_STATES.live}</span>` : SESSION_STATES[session.state]}</td>
<td>${at(session.lastUsedAt)}</td><td>${at(session.expiresAt)}</td><td>${at(session.createdAt)}</td>
<td>${session.devices}</td></tr>`), 'セッションはありません。')}
</section>`;
  return page('端末', main, { signedIn: true, current: '端末' });
}

/** The first page of a list, a later one, or 0 for a page asked for that is not a page. */
export function pageNumber(url: URL): number {
  const asked = url.searchParams.get('page');
  return asked === null ? 1 : /^[1-9][0-9]{0,5}$/.test(asked) ? Number(asked) : 0;
}

