# 0058. ブラウザで話し、動いている間に変えられる設定をブラウザから変える

- Date: 2026-09-29
- Status: Accepted（画面から変えられる設定に、ポッポさんの判定の有効・無効と採用する方を加えることは [ADR 0059](0059-two-judges-side-by-side-and-fewer-issues.md) で追加、「ダッシュボードの中は読み取り専用のまま」から予約した確認の取り消しを除くことは [ADR 0064](0064-cancelling-a-self-check-from-the-dashboard.md) で改める、ブラウザに Web Push で通知を送ること・cookie の接続から Web Push の購読を `push.register` で受け付けることは [ADR 0065](0065-web-push-to-the-browser.md) で改める）

## Context

本人は、ウェブのダッシュボードで設定を変え、今は 404 になっているトップページ（`/`）でなつみと話したいと考えた。
設計は grill-me（Q1〜Q12）で詰めた。

手元の事情は次のとおりである。

- ダッシュボード（[ADR 0049](0049-a-read-only-dashboard-in-the-browser.md)、[ADR 0054](0054-her-files-on-the-dashboard.md)）は読み取り専用で、サーバーが HTML を組み、JS は 10 秒ごとのポーリングの小さなファイルだけである。
  ログインは GitHub OAuth で、ブラウザには cookie `natsumi_dashboard`（`HttpOnly`・`Secure`・`SameSite=Strict`・`Path=/dashboard`）を渡す。戻り先は `/dashboard` に固定されている。
  ADR 0049 には「この作り方で足りない、作り込みが要る機能が出てきたら、その時点で作り方を決め直す」とある。
- `config.json` は起動時に 1 度だけ読む。本番の正本は別の private のリポジトリの ConfigMap で、リリースのたびにそこから配られる。
  動いている最中に変えられるのは、モデルの経路（[ADR 0046](0046-named-model-routes-switched-by-hand.md)、data directory の `model-route.json`）と、畳み込み（[ADR 0047](0047-folding-ended-turns-with-a-memo.md)、`turn-fold.json`）の 2 つだけである。どちらもターンの間で効く。
- アプリ（Mac・iPhone）の口は `/v1/ws` で、bearer token が要る。Origin があれば `publicOrigin` と一致しなければ断る（[ADR 0006](0006-github-login-and-transport.md)）。
  ブラウザの WebSocket は Authorization ヘッダーを付けられない。ダッシュボードの cookie は `Path=/dashboard` なので `/v1/ws` には届かない。
- iPhone への通知は、登録があり、いま接続していない端末に送る（[ADR 0029](0029-push-notifications-on-the-iphone.md)）。判定は端末ごとである。
- 思考ループは 1 本である。チャットも同じ入力の経路に乗せる（[ADR 0008](0008-single-thinking-loop-and-mac-conversation.md)）。
  instructions は session の間は変えない。prefix cache を保つためである（[ADR 0019](0019-a-workspace-not-a-memory-tool.md)、[ADR 0056](0056-the-manual-index-and-the-workspace-commands-in-the-prompt.md)）。
- サーバーのコードは `src/server/` に平らに並んでいる。本人から「役割ごとにコンポーネントを分け、依存が循環しないようにレイヤーに分ける」よう求められた。
  調べた時点で、`src/` の import の循環は 1 つだけある（`loop-tools.ts`・`read-tool.ts`・`search-memory.ts`・`workspace-shell.ts`）。型だけの import を通るもので、実行時の循環ではない。

## Decision

### 画面から変えるのは、動いている最中に変えられる設定だけにする

- 画面から変えられるのは次の 4 組である。`config.json` の全体は編集しない。再起動が要り、秘密を含み、正本が 2 か所になるからである。
  1. モデルの経路（`modelRoute`）
  2. 畳み込み（`turnFold`）
  3. ターンの上限: 出来事ごとのターンの呼び出しの回数と時間（`eventModelCalls`・`eventTimeoutMinutes`）、夜の振り返りの呼び出しの回数と時間（`reviewModelCalls`・`reviewTimeoutMinutes`）
  4. 起きている時間帯（`awakeHours`）と、合図の間隔（`pingIntervalMinutes`）
- selfCheck の上限と記憶の整理係は後から足す。サーバーの URL、待ち受け、GitHub、秘密、Slack、A2A、アバター、compaction の閾値は対象外とする。

退けた案:

- **config 全体を画面で編集する**: 再起動、秘密の扱い、正本の二重化のどれにも答えがない。

### 画面で変えた値は、config の値の上書きとして data directory に残す

- config の値は既定値である。画面で変えた値は上書きとして data directory（永続ボリューム）に残り、上書きがあればそれが勝つ。
  リリースや再起動では巻き戻らない。本人の懸念「config は git で管理していて、リリースのたびに巻き戻る」への答えである。
- 画面には、設定ごとに「config の値」と「今の値（上書き中かどうか）」を並べる。「config に戻す」で上書きを消す。
- 置き場は次のとおりとする。
  - 経路と畳み込みは、今のファイル（`model-route.json`・`turn-fold.json`）を形を変えずにそのまま使う。コマンド（`natsumi model use`・`natsumi fold on|off`）も同じファイルを書く。
    今の本番の data directory はこれらを持つので、移し替えをせずに同じ振る舞いで起動できる。「config に戻す」はファイルを消すことである。
  - 3 と 4 は、新しいファイル `runtime-settings.json` に、上書きしているものだけを並べる。書くのはサーバーだけである。
  - 1 つのファイルにまとめない。コマンドとサーバーが同じファイルを読み書きすると、片方の書き込みがもう片方を消す余地が生まれるからである。
    ファイルが分かれていても、読み書きは 1 つの保存の部品を通す（下の「コンポーネントとレイヤー」）。
- 値の検査は config と同じ規則で行う。規則は 1 か所に置き、config の読み込みと画面からの変更の両方がそれを使う。
  - 回数と時間: 1 以上の整数。
  - 合図の間隔: 5 以上の整数、または false（合図しない）。
  - 起きている時間帯: 24 時間制の `HH:MM` の start と end で、同じ時刻は不可。時間帯は config の `loop.timeZone` のまま（画面からは変えない）。
  - 畳み込み: on か off。
  - 経路: config にある名前で、使える状態にあるもの（今の `model.use` と同じ）。
- `runtime-settings.json` に規則に合わない値があれば、その値は無いものとして config の値を使い、ログに残す。起動は止めない。

退けた案:

- **起動のたびに config の値に戻す**: リリースのたびに巻き戻り、本人の懸念に答えない。
- **画面から config の正本のリポジトリに PR を出す**: 反映に人手とリリースが要り、「動いている最中に変える」にならない。

### 効く時は、今の経路・畳み込みと同じくターンの間とする

- 経路と畳み込みは今までどおり、次のターンの前に移る。
- ターンの上限は、次のターンから効く。走っているターンの上限は変えない。
- 起きている時間帯と合図の間隔は、次の見回り（スケジューラーの tick）から効く。自分で予約した確認（self-check）の「時間帯の外なので、実際に届くのは…」の案内も、予約の時点の値を使う。
- prefix cache: 3 と 4 は instructions にもツールの説明にも入っていないので、変えても prefix は動かない。経路と畳み込みを切り替えると、今までどおり 1 回だけ外れる。

### WebSocket のコマンドで読み書きする

- 設定の読み書きは、クライアントの契約（`docs/client-contract.md`）の WebSocket のコマンドとして足す。ダッシュボードのフォームの POST にはしない。後で Mac・iPhone からも同じコマンドで使える。
  - `settings.list`: 今の設定の一覧を返す。
  - `settings.set`: 1 つの設定に上書きを書く。
  - `settings.reset`: 1 つの設定の上書きを消し、config の値に戻す。
  - `settings.changed`: 一覧のどれかが変わったとき、全端末に一覧の全体を届ける。コマンドから変えたとき、経路が実際に移ったとき、コマンドラインがファイルを書き換えたのを見つけたとき（心拍ごとに見る）である。
  - `session.snapshot` にも一覧を載せる。
- `model.list`・`model.use`・`model.routes` は残す。今のアプリが使っているからである。`settings.set` の `modelRoute` は `model.use` と同じ処理を通り、同じ結果の codes（`unknown-route`・`route-unavailable`）を返す。
- 同期の前には受け付けず（`sync-required`）、なつみが話せない間は `service.unavailable` を返す。`model.*` と同じである。

### ログインの cookie を 1 つにまとめて `Path=/` に広げる

- ブラウザのログインの cookie は `natsumi_session` の 1 つにまとめ、`Path=/` とする。`HttpOnly`・`SameSite=Strict` は残し、`publicOrigin` が https なら `Secure` を付ける（今と同じ）。
  中身・寿命・延長は今のダッシュボードの cookie と同じである。
- 移し替え: `Path=/dashboard` の古い `natsumi_dashboard` を持つブラウザが `/dashboard` の下に来たら、そのセッションを 1 度だけ受け付け、同じセッションを `natsumi_session` で渡し直し、古い cookie を消す。
  古い cookie は `/dashboard` の下にしか送られないので、`/` から先に開いたブラウザは、ログインし直すことになる。
  両方があるときは新しいほうだけを見る。
- ブラウザのログインは、始めた入口に戻る。戻り先は `/`・`/settings`・`/dashboard` の 3 つだけで、コードに固定する（open redirect にしないため。ADR 0006・0049 と同じ考え方）。
- ログアウトは今までどおり `/dashboard/logout` への POST（Origin を照合）で、cookie を消す。

### `/v1/ws` は、bearer に加え、Origin が `publicOrigin` のときだけ cookie で受け付ける

- bearer があれば、今までどおり bearer だけで判断する（cookie は見ない）。Mac・iPhone は変わらない。
- bearer が無いときだけ cookie を見る。cookie で受け付けるのは、Origin ヘッダーがあって `publicOrigin` と一致するときだけである。
  Origin が無い、または違う cookie の接続は 403 で断る。別のサイトからブラウザに WebSocket を張らせる攻撃（cross-site WebSocket hijacking）を、`SameSite=Strict` と合わせて防ぐためである。
- ブラウザも Mac・iPhone と同じ「もう 1 台の端末」であり、`session.sync` でサーバーが発行した deviceId を受け取り、手元（localStorage）に控えて次の接続で送る。
  発行と照合の規則は今の端末と同じである（同じアカウントに発行済みの ID だけを使い続ける）。
- 承認（`approval.decide`）はブラウザからも受ける。CSRF は、上の Origin の照合と `SameSite=Strict` で守る。押し間違いの確認は画面の側で持つ。
- cookie でつないだ接続からの `push.register` は断る（`invalid-request`）。ブラウザは通知を受けない端末だからである。

これは ADR 0006 の「cookie は使わない」の例外を、ダッシュボードから `/`・`/settings` と `/v1/ws`、会話の画像の取得（`/v1/images/<id>`）に広げるものである。
ADR 0006 が cookie を避けた理由（ブラウザが自動で付けるので、CSRF と別サイトからの WebSocket の余地が生まれる）には、`SameSite=Strict`、WebSocket の Origin の必須の照合、状態を変える口を WebSocket（Origin を照合する）とログアウトの POST（Origin を照合する）だけに絞ることで応える。

退けた案:

- **入場券（WebSocket 用の短命の token を cookie の口で発行し、URL に載せる）**: 部品が 1 つ増え、URL に載った token がログや履歴に残る。Origin の照合で足りる。
- **token をページの JS に持たせる**: ADR 0049 と同じく、XSS 1 回で token を盗まれる。

### 通知はブラウザには送らず、ブラウザがつながっていても iPhone への通知を止めない

- ブラウザには通知（Web Push）を送らない。ブラウザは開いている間だけの端末である。
- 「つながっている端末には送らない」の判定は端末ごとなので、ブラウザがつながっていても iPhone への通知は止まらない。ブラウザは push の登録を持たない（上のとおり断る）。これをテストで固定する。

### `/` と `/settings` を配る

- `GET /`（チャット）と `GET /settings`（設定）は、同じ HTML を返す。HTML は JS の束（`/app/app.js`）と style（`/app/app.css`）を読み込むだけの最小のもので、画面は JS が組む。
  ダッシュボード（`/dashboard`）は読み取り専用のまま残し、互いにリンクで行き来する。
- 未ログインなら GitHub のログインへ回し、済んだら開こうとしたページに戻す。
- JS の束は `dist/web/`（checkout ではリポジトリの `dist/web/`、image では `/app/dist/web/`）に置き、`/app/<ファイル名>` で配る。束を作るのは次の作業単位（ブラウザのアプリ）である。
  束がまだ無ければ、HTML はその旨の文だけを出し、script を読み込まない。束のファイルはログインしていなくても取れる（中身は公開のリポジトリにあるコードで、秘密を含まない）。
- CSP は `default-src 'self'`、`script-src 'self'`（inline は不可）、`style-src 'self'`、`img-src 'self' data: blob:`、`connect-src 'self'` と `publicOrigin` の wss（http なら ws）、`object-src 'none'`、`base-uri 'none'`、`form-action 'self'`、`frame-ancestors 'none'` とする。
- 返事の画像は、アプリと同じ `/v1/images/<id>` で取る。bearer が無ければ cookie でも受け付ける（GET だけで、状態を変えない。`SameSite=Strict` なので別のサイトの img からは cookie が付かない）。見せてよい画像の条件（会話か承認に出ているもの）は今までどおりである。
- アバターの姿は、セリフの横の表情の顔と見出しの名前だけを `/v1/avatar` から使う（今のまま、ログイン無しで取れる）。

### ブラウザの画面は TypeScript で書き、小さなビルドで 1 本の JS にまとめる

- 画面の TypeScript と esbuild などのビルド、Playwright のテストは次の作業単位で作る。この ADR では、それが前提にする契約（上の WebSocket のコマンド・cookie・配信のパス）だけを決める。
- 偽のサーバー（`npm run fake-server`）も、`settings.*`、cookie での `/v1/ws`、`/` と `/settings` の配信を持つ。次の作業単位の Playwright が、GitHub もモデルも無しにこれにつなぐ。

### コンポーネントとレイヤー

今回足すサーバーのコードは、役割ごとのコンポーネントに分け、下の層への一方向の依存だけを許す。平らな `src/server/` には足さず、ディレクトリで層を示す。

1. `src/server/settings/domain.ts`（ドメイン）: 設定の名前、値の形、検査の規則。何も import しない（Node の組み込みも使わない）。config の読み込みも、ここの規則を使う。
2. `src/server/settings/store.ts`（保存）: 上書きのファイルの読み書き。ドメインと、data directory の場所・原子的な書き込みの小さな部品だけを使う。コマンドライン（`natsumi model`・`natsumi fold`）と思考ループの経路・畳み込みの読み書きも、ここを通す。
3. `src/server/settings/service.ts`（アプリケーションの操作）: 一覧を組む、上書きを書く・消す、変化を知らせる、今の値を渡す。思考ループには自分で定めた狭い口（経路を選ぶ・経路を見直す・畳み込みの今の値）でだけ触れ、思考ループのモジュールを import しない。
4. 口（WebSocket と HTTP）: WebSocket のコマンドは今の `connections.ts` が、アプリケーションの操作を狭い口（`HubSettings`）で受けて扱う。ブラウザの cookie と `/`・`/settings` の配信は `src/server/browser/` に置く。組み立ては `server.ts` だけが行う。

- 思考ループとスケジューラーは、ターンの上限と起きている時間帯・合図の間隔を、自分で定めた口（値を返す関数）から読む。サービスを import しない。
- 依存の向きと循環が無いことを、`src/` の import を読むテストで固定する。
  - 層の向きに反する import（ドメインが何かを import する、保存がサービスや口を import する、サービスが口を import する、口と組み立て以外がサービスを import する、など）があれば落ちる。
  - `src/` のどこかに循環（型だけの import を含む）ができれば落ちる。今ある 1 つは直さずに既知の一覧に載せ、直すかは本人が決める。直したら一覧から外す。
  - 依存を増やさないため、dependency-cruiser などの道具は入れず、テストの中で import の文を読む。

### ADR との関係

- ADR 0006
  - 例外の拡大: cookie は、ダッシュボードに加え、`/`・`/settings`、`/v1/ws`（Origin が `publicOrigin` のときだけ）、`/v1/images/<id>` に使う。名前は `natsumi_session`、`Path=/`。
  - 追加: ブラウザ向けのログインの戻り先を `/`・`/settings`・`/dashboard` の 3 つに広げる（コードに固定）。
  - 変えない: bearer の口（Mac・iPhone）の検証。bearer があれば cookie は見ない。
- ADR 0049
  - 改める: 「足りなくなったら作り方を決め直す」を、ここで決め直した。チャットと設定は JS で組む画面（TypeScript をビルドした 1 本の JS）と WebSocket で作る。
  - 保つ: ダッシュボードの中は読み取り専用のままで、サーバーが HTML を組む。状態を変えるのは `/`・`/settings` の画面から WebSocket を通してである。
  - 置き換え: cookie の名前と Path（`natsumi_dashboard`・`Path=/dashboard` から `natsumi_session`・`Path=/` へ）。
  - 保つ: 自動更新は WebSocket ではなくポーリングで行う（ダッシュボードの中）。
- ADR 0054
  - 変えない: ダッシュボードのファイルの閲覧は cookie の名前が変わるだけである。
- ADR 0046
  - 追加: 経路は `settings.set`（`modelRoute`）・`settings.reset` からも選べる。「config に戻す」は選んだ記録を消すことである。
  - 保つ: 置き場（`model-route.json`）、切り替えの時（ターンの間）、`model.*` のコマンド。
- ADR 0047
  - 追加: 畳み込みは `settings.set`（`turnFold`）・`settings.reset` からも切り替えられる。「config に戻す」は選んだ記録を消すことである。
  - 保つ: 置き場（`turn-fold.json`）と、ターンの間で効くこと。
- ADR 0029
  - 保つ: 送るのは、登録があり、いまつながっていない端末である。ブラウザは登録を持てないので、iPhone への通知に影響しない。
- ADR 0008
  - 保つ: ブラウザからのメッセージも `conversation.send` で同じ 1 本の思考ループに入る。

## Consequences

- 本人は、ブラウザで話し、承認し、経路・畳み込み・ターンの上限・時間帯を変えられる。変えた値は再起動とリリースを越えて残る。config を変えても上書きがあれば効かないので、画面の「config の値」と「今の値」の並びで見分け、「config に戻す」で揃える。
- 状態を変える口がブラウザに開く。守りは、GitHub ログインと許可ユーザー 1 人の照合、`HttpOnly`・`SameSite=Strict` の cookie、WebSocket の Origin の必須の照合、CSP（inline の script を許さない）である。[権限と秘密の一覧](../permissions.md)を改めた。
- ブラウザのセッションは、アプリのセッションと同じ寿命と延長である。
- 今 `Path=/dashboard` の cookie を持つブラウザは、`/dashboard` を開けば移し替えられる。`/` を先に開いたブラウザはログインし直す。
- 本番の image に JS の束を入れるのは次の作業単位である。それまで `/` は束が無い旨の文だけを出す。
- 本番の Ingress は `/` の下を丸ごと通している見込みで、変更は要らない見込みである（WebSocket の upgrade は今も `/v1/ws` で通っている）。
- import のテストがあるので、今回の層の向きに反する依存や循環は、書いた時点でテストが落ちる。

### 進め方

1. この ADR と、サーバー側（上書きの仕組み、`settings.*`、cookie と `/v1/ws`、`/`・`/settings` の配信）、契約の文書、偽のサーバー。
2. ブラウザのアプリ（TypeScript と esbuild、チャットと設定の画面、node のテストと Playwright）と、image への束の同梱。
