import { localTime, page, SLEEP_PATH } from './dashboard-view.ts';
import { html, type Html } from './html.ts';
import type { PillJudgement } from './sleeping-pill.ts';

/**
 * The sleeping pill's page (ADR 0077): what a pill would do now, what that is decided from, and the one form that gives
 * it. The page is the asking: opening it changes nothing, and it does not refresh itself, so what is about to be given
 * does not move under the button. What the pill did is seen by opening it again, and in the failures and waits.
 */

export interface SleepPageOptions {
  timeZone: string;
  /** `curator.pillStopStartingAfterMinutes`: how long a pill's curator may go on beginning stages. */
  pillMinutes: number | false;
  /** Why natsumi cannot talk, when she cannot: no pill is given then. */
  unavailable: string | null;
  /** A pill just taken: a new one, or one that joined what was waiting or running. */
  taken?: 'new' | 'joined';
  avatarId?: string;
}

const LABELS = { deep: 'ガッツリ寝る', resume: '残りを済ませる', resleep: '寝直し', nap: '昼寝', none: '何もしません' } as const;

export function sleepPage(judgement: PillJudgement, options: SleepPageOptions): Html {
  const at = (iso: string) => localTime(iso, options.timeZone);
  const curator = options.pillMinutes === false ? '記憶の整理係（締め切りなし。工程ごとの上限まで）'
    : `記憶の整理係（最長 ${options.pillMinutes} 分と工程 1 つ分）`;
  const waits = 'その間、マスターのメッセージは待たせ、起きた後に答えます。';
  const what: Record<PillJudgement['kind'], string> = {
    deep: `直近の夜の振り返りが欠けています。夜と同じに、振り返り（引き継ぎ）→ ${curator} → 新しい session をします。${waits}`,
    resume: `直近の夜の引き継ぎはあり、新しい session が欠けています。なつみのターンはなく、${judgement.done.curator ? ''
      : `先に${curator}を走らせてから、`}夜に書いた引き継ぎから新しい session を作ります。${waits}`,
    resleep: `直近の夜の記憶の整理係が済んでいません。session はそのままで、${curator}だけを走らせます。${waits}`,
    nap: `直近の夜は全部済んでいます。引き継ぎだけを書いて、新しい session に移ります。整理係は走りません。昼寝のターンの間、マスターのメッセージは待たせます。`,
    none: '今の session にはまだ何もないので、飲ませても何もしません。',
  };
  const part = (done: boolean) => done ? html`<span class="ok">済み</span>` : html`<span class="bad">まだ</span>`;
  const failure = judgement.lastFailure;
  const progress = judgement.inProgress;
  const main = html`<section id="sleep">
<h2>睡眠薬</h2>
${options.taken === 'new' && html`<p class="ok">睡眠薬を飲ませました。何をするかは、なつみが順番に処理を始めるときに決まります。</p>`}
${options.taken === 'joined' && html`<p class="ok">待っている・走っている切り替えに合流しました。二重には寝ません。</p>`}

<h3>いま飲ませると</h3>
<p><strong>${LABELS[judgement.kind]}</strong> <code>${judgement.kind}</code></p>
<p>${what[judgement.kind]}</p>
${options.unavailable === null
    ? html`<form method="post" action="${SLEEP_PATH}"><button type="submit">睡眠薬を飲ませる</button></form>`
    : html`<p class="bad">なつみがいま話せないので、いまは飲ませられません（<code>${options.unavailable}</code>）。</p>`}
<p><small>このページは自動では更新しません。飲ませた後の様子は、開き直すか「失敗と待ち」で見てください。</small></p>

<h3>直近の夜</h3>
<dl class="facts">
<div><dt>夜の時刻</dt><dd>${judgement.night === null ? 'まだ振り返りの記録がありません' : html`${at(judgement.night)} <small>${options.timeZone}</small>`}</dd></div>
<div><dt>① 振り返り（引き継ぎ）</dt><dd>${part(judgement.done.review)}</dd></div>
<div><dt>② 記憶の整理係</dt><dd>${part(judgement.done.curator)}</dd></div>
<div><dt>③ 新しい session</dt><dd>${part(judgement.done.session)}</dd></div>
</dl>

<h3>直近の夜からの失敗</h3>
${failure === null ? html`<p><small>失敗はありません。</small></p>` : html`<p>${at(failure.at)} ${failure.source === 'rotation'
    ? html`<code>${failure.kind}</code> の切り替え <span class="bad">${failure.state}</span> <code>${failure.reason ?? ''}</code>`
    : html`記憶の整理係の工程 <code>${failure.stage}</code> <span class="bad">${failure.outcome}</span>`}</p>`}

<h3>走っている・待っている切り替え</h3>
${progress === null ? html`<p><small>ありません。</small></p>` : html`<p><code>${progress.kind}</code> ${progress.state === 'running'
    ? '寝ています' : '順番を待っています'} <small>${at(progress.since)} から</small></p>`}
</section>`;
  return page('睡眠薬', main, { signedIn: true, current: '睡眠薬', avatarId: options.avatarId });
}
