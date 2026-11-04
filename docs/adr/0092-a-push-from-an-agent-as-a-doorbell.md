# 0092. 頼んだ係からの A2A の push は呼び鈴として受け、poll は保険に残す

- Date: 2026-11-04
- Status: Accepted

## Context

なつみが外の係に頼むツールは `ask_agent` である（[ADR 0035](0035-asking-outside-agents-and-hearing-back.md)）。
返事はサーバーが取りに行く。返事を待っている Task を SQLite の `agent_tasks` に記録し、設定の `a2a.pollIntervalSeconds`（既定 15 秒）ごとに、待っているすべての Task へ GetTask を 1 回ずつ送る。
Task が済む・聞き返す・失敗する・待ちの上限（[ADR 0036](0036-a-manual-to-read-and-a-limit-on-waiting.md)、既定 24 時間）を過ぎると、返事を `/sources/agents/` の依頼のディレクトリに置き、
`sources_updated` の印（`attention`）で知らせる（[ADR 0069](0069-agent-replies-as-files-in-sources.md)）。
定期便（[ADR 0076](0076-a-postbox-for-requests-sent-on-a-schedule.md)）が始めた Task も、同じ表と同じ取りに行き方で待つ。

ADR 0035 は、取りに行く形を選んだ理由を「相手がストリーミングも push 通知も出していないので、相手を変えずに使える唯一の方法」とし、
相手が push 通知を出すようになったら受け取り方をそのときに決めるとしていた。
ADR 0069 は、受け取り方（ポーリング・SSE・webhook）を相談したうえで、どれを選んでも文脈に入る量は変わらないので、今のポーリングのままとした。

本人は、頼んだ係の返事を受ける口を、A2A の push 通知で持つことにした。困りごとは次の 2 つである。

- 返事は、取りに行く間隔の分だけ遅れて届く（ADR 0035 の Consequences）。
- 調べものの係のように何時間も掛かる Task でも、待っている間は 15 秒ごとに GetTask を送り続ける。待っている Task が多いほど、係への問い合わせが増える。

手元の事実は次のとおりである。

- A2A の SendMessage は、`configuration.taskPushNotificationConfig` に push の送り先を載せられる。送り先の `url` と、送るときの認証 `authentication`（`scheme` と `credentials`）を持つ。
  ほかに legacy の `token` の欄があるが、`@a2a-js/sdk` 1.3.0 では非推奨である。
- `@a2a-js/sdk` 1.3.0 の送り手（`DefaultPushNotificationSender`）は、`authentication` があれば `Authorization: <scheme> <credentials>` を付けて、Task の状態が変わるたびに `url` へ POST する。
  `authentication` が無く `token` だけがあるときは、`X-A2A-Notification-Token` に入れる。本文は v1.0 の `StreamResponse` である。
- なつみの `ask_agent` は、いま `taskPushNotificationConfig` を付けずに送っている（`src/server/a2a-client.ts` の `SdkA2AClient.send`）。
- `yuanying/fraction-agents` の係の Agent Card は、`capabilities.pushNotifications` を `false` にしている。係の側で push の送り手を持つことは、同リポジトリの ADR 0032 で決める。
- なつみの公開の道は 2 つある。`/` の下の Ingress は認証を掛けずに通す（[ADR 0033](0033-running-on-kubernetes.md)）。
  `/a2a` の下の Ingress は、gated で守るのを勧める形である（[ADR 0089](0089-hearing-from-agents-over-a2a.md)）。gated は呼び出しの `Authorization` の ServiceAccount の token を確かめ、`Authorization` を落として署名付きの assertion に置き換える（[ADR 0084](0084-calling-agents-behind-gated-with-its-audience.md)）。
- 機械から呼ばれるなつみの受け口は、Alertmanager の受け口（[ADR 0086](0086-alertmanager-notifications-as-sources.md)）と A2A の受け口（ADR 0089）がある。どちらも送り手ごとの秘密を config に持つ。
- `ask_agent` は、相手の Agent Card を起動時に読んで頼める相手の一覧を書き（ADR 0036）、同じ Agent Card で返事の拡張を名乗るかを見ている（ADR 0069 の「作業単位 4 で決めたこと」）。

用語: この ADR で **push** は、頼んだ係が Task の状態の変化をなつみの受け口に POST することを指す。
なつみが iPhone やブラウザへ送る通知（[ADR 0029](0029-push-notifications-on-the-iphone.md)・[ADR 0070](0070-web-push-to-the-browser.md)）とは別のものである。

## Decision

### push は呼び鈴で、本文は読まずに、その Task の GetTask を 1 回すぐ走らせる

- push が届いたら、サーバーは送り先の認証で、どの待っている Task の push かを照らす。照らせたら、その Task の GetTask をすぐ 1 回走らせる。
  GetTask から後（返事の置き方、印、待ちの上限）は、ADR 0069 の取りに行く形と同じ処理を通す。
- **push の本文は読まない。** 大きさの上限だけを掛けて読み捨てる。Task の状態と返事は、なつみが係の URL に送る GetTask の答えだけから決める。
  - 本文を読まないので、push は「その Task を今見に行け」という合図以上の意味を持たない。push を騙っても、なつみが係から受け取る返事は変えられない。
  - 本文の形（v1.0 の `StreamResponse` など）に、なつみは依存しない。係の側は送り手の既定の形のままでよい。
- 照らせたら、GetTask を待たずに 2xx を返す。GetTask は応答の後に走る。係の送り手の時間の上限に、なつみの GetTask を含めない。
- 同じ Task の GetTask は、push と poll のどちらから始まっても同時に 1 つまでとする。走っている間に届いた push は、走っている GetTask に合流させる。同じ返事を二重に置かない。
- 照らした Task が既に待っていない（済んだ、聞き返しで止まっている、上限を過ぎた）ときは、何もしない。

### poll は保険として残し、push を付けた Task は間隔を長くする

- 取りに行く形（ADR 0035）は残す。push が届かなくても、poll で拾う。push は、係の側で送り損ねても送り直しを求めない。
- push を付けて送った Task は、今の `a2a.pollIntervalSeconds` より長い間隔で取りに行く。push の届かない係の Task は、今の間隔のままとする。
  - 長い間隔は、push が落ちたときにだけ効く遅れの上限である。値と、設定で変えられるようにするかは実装の PR で決める。
- 待ちの上限（ADR 0036）は、push の有無で変えない。

### push の認証は、依頼ごとのランダムな token で、Task が済んだら捨てる

- サーバーは、push を付けて送る依頼ごとに、推し量れない長さのランダムな token を作る。SendMessage の `taskPushNotificationConfig.authentication` に `scheme: Bearer` と、その token を入れる。
  legacy の `token`（`X-A2A-Notification-Token`）は使わず、受けもしない。
- サーバーは、token そのものを残さない。token の digest を、待っている Task の記録（`agent_tasks`）に並べて SQLite に持つ。届いた `Authorization: Bearer` の token の digest で、待っている Task を引く。
  - token は推し量れない長さのランダムな値なので、digest で引いても、比べ方の時間から token は漏れない。
  - 再起動しても、待っている Task の token は SQLite に残り、push を受け続けられる。
- 送り手ごとの秘密は config に持たない。係を足しても、なつみの config に書き足す秘密は無い。
- Task が待つのをやめたら（済んだ、失敗した、聞き返しの返事を取り込んだ、待ちの上限を過ぎた、相手が設定から外れた）、その Task の token の digest を消す。以後、その token の push は知らない token として 401 になる。
- 知らない token、`Authorization` の無い呼び出し、Bearer でない呼び出しは、同じ 401 で断る。どれが外れたかを返さない（ADR 0086・ADR 0089 と同じ）。
- token は、ログにも `/sources` にもなつみにも出さない。

退けた案:

- **token を HMAC で Task から導く**: サーバーの鍵を 1 つ持ち、Task の識別子から token を作り直せる。SQLite に token の欄が要らない。
  ただし、鍵の置き場所と入れ替えが新しく要り、Task ごとに token を捨てるには結局「捨てた」記録が要る。ランダムな値の digest を持てば、捨てるのは記録を消すことで済む。
- **送り手（係）ごとの秘密を config に持つ**（ADR 0086・ADR 0089 の形）: 係を足すたびに、なつみと係の両方に秘密を配って再起動する手間が増える。
  push の秘密が漏れたときの被害は次の節のとおり小さく、送り手ごとに守り分ける価値が無い。Task ごとの token なら、配る手間が無く、漏れても効くのはその Task が待っている間だけである。

### 受け口は `/` の下の `POST /v1/a2a-push` に 1 つ置く

- 受け口は `POST /v1/a2a-push` の 1 つで、ブラウザと同じ待ち受けの `/` の下に置く。URL は依頼によらず固定で、どの Task の push かは token だけで決める。
- `/` の Ingress は、今までどおり認証を掛けずに通す（ADR 0033）。受け口を守るのは、なつみのサーバーが照らす token である。
- ブラウザのログインの cookie では通さない。ほかの機械の受け口と同じである。
- 本文の大きさに上限を置く。値は実装の PR で決める。上限を超えたものは、照らせても読み捨てて断る。

退けた案:

- **`/a2a` の Ingress（gated で守る道）に置く**: gated は呼び出しの `Authorization` に ServiceAccount の token を求め、確かめたら落として assertion に置き換える（ADR 0084）。
  係の送り手が `Authorization` に入れるのは、なつみが渡した依頼ごとの token であり、gated はこれを通さない。通したとしても、なつみには token が届かない。
  push の送り手を gated の NetworkRole で通すには、係ごとの ServiceAccount を束ねる環境の設定が要り、gated の無い環境では使えない。
- **URL に Task の ID や token を入れる**（`/v1/a2a-push/<Task>` など）: Task の ID は SendMessage の答えで初めて分かるので、送る時点で URL に入れられない。
  token を URL に入れると、Ingress やプロキシのアクセスログに残る。
- **A2A の受け口（ADR 0089）に、係を送り手として宣言する**: 受け口は、なつみへの依頼を受けて `/sources/inbox` に置くためのものである。返事の合図は依頼ではなく、送り手の宣言と秘密を config に持つことになる。

### 汎用の webhook とは別の、`ask_agent` の拡張として扱う

- push の受け口は、外から届くものを `/sources` に置く汎用の webhook の受け口（[ADR 0091](0091-one-way-in-for-webhooks-with-formats-in-the-code.md)）の仲間にしない。push は `/sources` に何も書かず、`ask_agent` の取りに行く形を早めるだけである。
  返事を置くのは、今までどおり GetTask の答えからである（ADR 0069）。
- 受け口は、`a2a` の設定がある（`ask_agent` が使える）ときだけ開く。

退けた案:

- **汎用の webhook の受け口で受け、届いた本文を `/sources` に置く**: 返事が `/sources/agents/` と webhook の置き場所の 2 か所に分かれる。送り手ごとの秘密を config に持つ形になり、前の節の理由で要らない。
- **push の本文を返事として取り込む**（GetTask を走らせない）: 本文を信じるには送り手の確かさが今より要る。返事の取り込みが GetTask と push の本文の 2 つの道になり、DataPart の検証（ADR 0069）も 2 か所に要る。
  GetTask を 1 回足すだけで、本文を読まなくても遅れは消える。

### 有効にするのは `a2a.pushUrl` と、相手の Agent Card の `pushNotifications: true`

- 設定 `a2a.pushUrl` に、係から見たなつみの公開の基底 URL を書く。書かなければ push を付けず、受け口も開かない（ほかの知らない道と同じ 404）。
  - push の送り先の `url` は、`a2a.pushUrl` に `/v1/a2a-push` を足したものである。
  - `publicOrigin`（ブラウザとクライアントの origin）とは別の設定にする。係からなつみに届く道は、ブラウザの道と同じとは限らないからである。また、`a2a.pushUrl` を書くことが push を使うことの宣言になる。
- 相手の Agent Card が `capabilities.pushNotifications: true` を名乗るときだけ、push を付けて送る。名乗らない相手には今までどおり付けずに送り、今の間隔で取りに行く。
  - Agent Card は、返事の拡張と同じく、起動時に読んだものを使う（ADR 0069 の「作業単位 4 で決めたこと」）。起動時に読めなかった相手は頼むときに読み直し、それでも読めなければ push を付けずに頼む。依頼そのものは止めない。
- 係ごとに push を入れ切りするスイッチは持たない。
  - 間違って有効になっても害が無いからである。push が届かなければ poll で拾う。届いても、なつみは本文を読まずに GetTask を 1 回足すだけである。
  - 係は、許していない送り先の push の設定を含む依頼を断らず、push だけを外して受け、そのことをログに出す（`yuanying/fraction-agents` の ADR 0032）。
    なつみの `a2a.pushUrl` が係の許す送り先と食い違っていても、依頼は通り、なつみの側は poll で拾う。誤った設定で `ask_agent` が失敗することは無い。
- 定期便（ADR 0076）の依頼も、`ask_agent` と同じ条件で push を付ける。

### 聞き返しから続けるときは、新しい token で push を付け直す

- 聞き返し（`input-required`）の返事を取り込んだら、その Task の token は捨てる（前の節）。聞き返しの間、なつみは取りに行かず（ADR 0036）、push も要らない。
- なつみが `ask_agent` の `continue` で答えを同じ Task に送るときは、新しい token を作り、その SendMessage に `taskPushNotificationConfig` を付け直す。答えの後の返事は、新しい token の push で知る。
  - 係が答えの SendMessage の push の設定を使わず、前の設定のまま送ってきても、前の token は捨ててあるので 401 になる。そのときは poll で拾う。返事は落ちず、遅れるだけである。
- 前のやり取りに続けて新しい Task を始めるとき（`continue` で聞き返しでないとき）も、新しい依頼として新しい token を付ける。

### 守る対象と、失敗のときに倒す側

- 守る対象は、なつみが係に送る GetTask の回数と、待っている Task の返事が正しい Task に取り込まれることである。push で守るものはこれだけで、返事の中身は push からは入らない。
- 許す範囲は、待っている Task の token を持つ者が、その Task の GetTask を早めることだけである。
- 失敗のときは、push を受けない側に倒す。
  - `a2a.pushUrl` が無い、相手の Agent Card が読めない・名乗らない: push を付けずに頼み、今の間隔で取りに行く。
  - token を記録できない: その依頼には push を付けずに送り、今の間隔で取りに行く。
  - 照らせない push: 401 で断り、何もしない。照らせた push の GetTask が失敗した: poll の失敗と同じ扱いで、次の poll に任せる。

### 本 ADR で決定しないこと

- push を付けた Task の poll の間隔の値と、設定で変えられるようにするか（委譲先: この ADR の実装の PR）。
- token の長さ、digest の算法、`agent_tasks` に足す欄と migration の形（委譲先: この ADR の実装の PR）。
- 受け口の本文の大きさの上限の値（委譲先: この ADR の実装の PR）。
- 係の側の push の送り先の URL を許す範囲（委譲先: `yuanying/fraction-agents` の ADR 0032）。
- 係からなつみの公開の host へ出る出口の許可と、`a2a.pushUrl` の値（委譲先: 環境の設定。[ADR 0034](0034-an-allow-list-for-the-way-out.md) の出口の許可と同じく環境のリポジトリに書く）。
- 外から届くものを `/sources` に置く汎用の webhook の受け口（委譲先: [ADR 0091](0091-one-way-in-for-webhooks-with-formats-in-the-code.md)。ADR 0086 の受け口を置き換える）。

### 実装で確かめること

- `@a2a-js/sdk` の client が、`taskPushNotificationConfig` の `authentication` を JSON-RPC でそのまま送るか。
- 係が聞き返しの後に同じ Task を続けたとき、答えの SendMessage の push の設定を使うか、前の設定を引き継ぐか。どちらでも返事は落ちないが、前の設定を引き継ぐ係では、答えの後の返事が poll の長い間隔の分だけ遅れる。

### 置き換える既存の決定

- ADR 0035
  - 決定:「返事はサーバーが取りに行く」の、相手が push 通知を出すようになったら受け取り方を変えるかはそのときに決める点。push を呼び鈴として受け、取りに行く形は保険として残す。
- ADR 0069
  - 置き換え: Context の「受け取り方は今のポーリングのままとする」。push を名乗る係の Task は、push で早めに取りに行き、poll の間隔を長くする。返事の置き方と知らせ方は変えない。
- ADR 0033
  - 追加: `/` の Ingress の後ろの待ち受けに、依頼ごとの bearer token で守る push の受け口 `POST /v1/a2a-push` が増える。`/` の Ingress では今までどおり認証を掛けない。

## Consequences

- push を名乗る係の返事は、取りに行く間隔を待たずに届く。係への GetTask は、push を付けた Task の分だけ減る。
- push が届かない（係が送り損ねる、出口が閉じている、聞き返しの後に前の設定のまま送る）と、返事は長い poll の間隔の分だけ遅れる。今の 15 秒より遅れ得ることを受け入れる。
- token が漏れたときの被害は、その Task が待っている間、なつみに GetTask を早めに走らせることだけである。返事の中身は変えられず、同じ Task の GetTask は同時に 1 つまでなので、係への問い合わせが際限なく増えることもない。
  Task が待つのをやめれば、その token は効かなくなる。
- 認証を掛けない `/` の Ingress に、機械から呼ばれる受け口が 1 つ増える。誰でも POST でき、知らない token は 401 になる。本文の大きさの上限までは、なつみが受けて読み捨てる。
- 待っている Task の記録に、token の digest の欄が増える。依頼の数だけ作り、Task が待つのをやめれば消すので、溜まり続けない。
- 係の Agent Card の `pushNotifications` を見て push を付けるので、push を使い始めるには、なつみの `a2a.pushUrl`、係の送り手、係からなつみへの出口の 3 つが揃う必要がある。どれかが欠けても、今の poll のまま動く。
- 係が push を名乗るようになったことは、返事の拡張と同じく、なつみの再起動までは知らない。

## Related ADRs

- Related: ADR-0035 外のエージェントに頼むツールと、返事の受け取り方（受け取り方の未決の点を決める）
- Related: ADR-0036 読み取り専用のマニュアルと、返事を待ち続ける上限
- Related: ADR-0069 外のエージェントの返事は /sources にファイルで置き、sources_updated で知らせる（Context の「受け取り方は今のポーリングのまま」を置き換える）
- Related: ADR-0033 本番を Kubernetes に置く（`/` の Ingress の後ろの受け口を追加する）
- Related: ADR-0025 外のエージェントと A2A で話す
- Related: ADR-0034 出口を許可リストで絞る
- Related: ADR-0076 郵便ポスト: 記憶に投函した定期便を、サーバーが cron で外のエージェントに送る
- Related: ADR-0084 gated の後ろの係は、gated の audience の token で呼ぶ
- Related: ADR-0029 iPhone に通知を届ける（用語の区別）
- Related: ADR-0070 ブラウザにも Web Push で通知を届ける（用語の区別）
- Related: ADR-0086 Alertmanager の通知を受けて /sources に置き、sources_updated で知らせる
- Related: ADR-0091 webhook の受け口を 1 つにし、届いたものの読み方は型としてコードに持つ（push の受け口はこの仲間にしない）
- Related: ADR-0089 なつみも A2A の受け口を持ち、届いた依頼は /sources に置いて、返事のツールで閉じる

## References

- `@a2a-js/sdk` 1.3.0 の `DefaultPushNotificationSender`（`dist/server/index.js`、`dist/default_push_notification_sender-*.d.ts`。`authentication` を `Authorization` に、legacy の `token` を `X-A2A-Notification-Token` に入れる、既定の時間の上限 5 秒。2026-11-04 確認）
- `@a2a-js/sdk` 1.3.0 の型 `TaskPushNotificationConfig`・`AuthenticationInfo`（`dist/extensions-*.d.ts`、2026-11-04 確認）
- `yuanying/fraction-agents` の `src/agent-card.ts`（`capabilities.pushNotifications: false`、2026-11-04 確認）
- `yuanying/fraction-agents` の ADR 0032（push の送り手。許していない送り先の push の設定は外して依頼を受ける。2026-11-04 に境目として合意）
- natsumi `src/server/a2a-client.ts` の `SdkA2AClient.send`（`taskPushNotificationConfig: undefined`）、`src/server/agent-requests.ts` の `AgentRequests.poll`、`src/server/config.ts` の `A2AConfig`（2026-11-04 確認）
