# 0093. webhook の型 `github` を足し、レビューを頼まれた PR の出来事だけを通す

- Date: 2026-11-04
- Status: Accepted

## Context

[ADR 0091](0091-one-way-in-for-webhooks-with-formats-in-the-code.md) で、外から届く webhook を `POST /v1/webhooks/<名前>` の 1 つの受け口で受け、webhook ごとに型を選ぶことにした。
型は natsumi のコードで持つ閉じた集合で、`raw`（届いた 1 回を日付の JSON Lines の 1 行に）と `alertmanager`（状態が変わったときだけ行に）の 2 つである。
GitHub は「まず `raw` で受け、困ってから型 `github` を足す」としていた（ADR 0091 の Decision「受け口は `POST /v1/webhooks/<名前>` の 1 つで、webhook ごとに型を選ぶ」の退けた案）。

本人は、クラスタの運用を受け持つなつみのインスタンスに、レビューを頼まれた PR が来たことを webhook で知らせたいと考えた。
このインスタンスは、自分の machine account で依存の更新の PR をレビューして承認している。
natsumi などのリポジトリでは、Renovate の PR に GitHub の auto-merge が予約され、コードオーナーの承認と `ci.yml` の `test` が揃うと GitHub がマージする。
コードオーナーは持ち主とこの machine account で、承認のあとに push されると承認は取り消される（[ADR 0079](0079-dependency-updates-with-renovate.md) の「追記（2026-11-04）」）。
いまはこのインスタンスが、週に一度、開いている PR を見て回る日課（[ADR 0090](0090-goals-and-a-plan-for-the-day.md)）で拾っており、PR が開いてから承認まで最長で 1 週間かかる。

`raw` で受けると困ることは次のとおりである。

- GitHub App の webhook は、1 つの URL に、インストールしたすべてのリポジトリの、購読したすべてのイベントを送る。持ち主は個人のアカウントなので、organization の webhook は無い。
  レビューを頼まれた PR に関わるのはその一部で、`raw` ではほかの PR の push や CI の結果がすべて行になる。
- レビューに要るのは、頼まれたこと・CI の結果・push・閉じたことである。CI の結果の `check_suite` には PR の作者もレビュアーも載っておらず、届いた 1 回だけでは、頼まれた PR のものかを決められない。
- 本文は大きく、PR の本文など外の人が書いた文章を含む。`raw` は本文を丸ごと `/sources` の履歴に残し、差分（`sources-diff`）は行を丸ごと出す。

GitHub の webhook について確かめた事実は次のとおりである（References）。

- イベントの種類は `X-GitHub-Event`、配送の ID（GUID）は `X-GitHub-Delivery` のヘッダーで届く。HMAC の署名 `X-Hub-Signature-256` は本文だけに掛かる。
- `pull_request` の action に `review_requested`・`review_request_removed`・`synchronize`（head のブランチが更新された）・`closed` がある。
  `review_requested` と `review_request_removed` の本文は、人への依頼なら `requested_reviewer`、チームへの依頼なら `requested_team` を持つ。`closed` は `merged` でマージされたかが分かる。
- `check_suite` の `completed` は、suite のすべての check run が済んで `conclusion` が出たときに届く。本文の `check_suite.pull_requests` に、その suite の head に当たる PR の番号が並ぶ。
  fork のブランチへの push は検出されず、`pull_requests` は空、`head_branch` は null になる。
- App が `pull_request` を受けるには Pull requests の read、`check_suite` を受けるには Checks の read が要る。webhook を作ると `ping` が届く。
- GitHub は、失敗した配送を自動では送り直さない。人が Redeliver したときだけで、そのときの `X-GitHub-Delivery` は元の配送と同じである。応答は 10 秒以内に 2xx を返すことを求めている。

## Decision

### 型 `github` を足す。最初の版は PR のレビューだけを扱う

- ADR 0091 の型の集合に `github` を足す。届いた本文を、`X-GitHub-Event` で読み分ける。
- 型の名前は `github-pr` のように絞らず `github` とする。GitHub App の webhook は 1 つの URL に全部のイベントを送るので、1 つの webhook の中で読み分ける型になる。扱うイベントを後で広げても、型と config は変わらない。
- 最初の版で読むのは、`pull_request` の `review_requested`・`review_request_removed`・`synchronize`・`closed` と、`check_suite` の `completed` だけである。
  ほかのイベントと action（`ping` を含む）は、読まずに 2xx を返し、行も印も作らない。送り手は、購読するイベントを Pull request と Check suite に絞る。
- `X-GitHub-Event` の無い呼び出しと、読むイベントなのに形の合わない本文は、400 で断る（ADR 0091 の「型の形でない本文」）。

### config の欄

型 `github` の webhook は、ADR 0091 の共通の欄（名前・`format`・認証・`description`）に、次の欄を持つ。

| 欄 | 意味 |
| --- | --- |
| `authors` | 扱う PR の作者のログインの並び。必須で 1 つ以上 |
| `reviewers` | 依頼を受けるレビュアーのログインの並び。必須で 1 つ以上 |
| `attention` | `raw` と同じ。`true` なら、行を書くたびに印を付ける。既定は `false` |

- `headers` は持たない。型が `X-GitHub-Event` と `X-GitHub-Delivery` を自分で読み、行の決まった欄に入れる。ほかのヘッダーは残さない。
- 認証は、ADR 0091 の Decision「認証は webhook ごとに bearer token か GitHub 形の HMAC」のまま、型と独立に選ぶ。GitHub から直接受けるなら `secretFile` である。
- `authors` と `reviewers` が空、または書かれていなければ、起動を止める。絞らずにすべての PR を通す設定は作らない。
- 照らすのは人への依頼（`requested_reviewer` のログイン）だけである。チームへの依頼（`requested_team`）は `reviewers` に照らさない。

### 覚える PR と、通すイベント

- 型は、webhook ごとに「レビューを頼まれた PR」を SQLite に覚える。鍵は webhook の名前・リポジトリ・PR の番号である。
- 覚えるのは、`review_requested` が届き、依頼の相手が `reviewers` のどれかで、PR の作者が `authors` のどれかであるときだけである。この `review_requested` は行にする。
- 覚えた PR について、次のものを行にする。
  - `pull_request` の `synchronize`。
  - `check_suite` の `completed` のうち、`pull_requests` に覚えた PR が載っているもの。1 つの suite に覚えた PR が複数載っていれば、PR ごとに 1 行にする。
  - `pull_request` の `closed`。行にしてから忘れる。
  - `pull_request` の `review_request_removed` のうち、外された相手が `reviewers` のどれかであるもの。行にするだけで、覚えた PR は忘れない。
- 覚えた PR を忘れるのは、`closed` のときだけである。
- 覚えていない PR のイベント、覚えた PR のほかの action は、読み捨てて 2xx を返す。
- 同じ配送の ID が届いたものは、2 回目以後は行にも、覚える・忘れるにも使わず、2xx を返す。GitHub の送り直しは人の Redeliver だけで、そのときの配送の ID は同じである。
- `closed` が届かずに残った PR（届いたときに natsumi が落ちていた、など）は、最初の版では消さない。その PR のイベントが通り続けるだけである。
- `closed` の後に開き直された PR は、新しい `review_requested` が届くまで覚えない。

退けた案:

- **`review_request_removed` で忘れる**: レビューを出したとき（承認を含む）に GitHub が `review_request_removed` を送るかは、文書から分からない。
  送るなら、承認した PR はその時点で忘れられる。承認のあとに push されるとルールセットが承認を取り消すが（ADR 0079 の「追記（2026-11-04）」）、その `synchronize` が通らず、受け手は承認をやり直す機会を知らない。
  `closed` だけで忘れれば、GitHub がどちらの振る舞いでも、承認のあとの push と CI の結果は届く。

### 1 行に残すもの

- 行は、ADR 0091 の `raw` と同じく、その日の `<日付>.jsonl` に、通した 1 回を 1 行で足す。置き場所は `/sources/webhooks/<名前>/` である。
- 行には、イベントごとに決まった欄だけを書く。本文は残さない。
  - 受け取った時刻、イベントと action、配送の ID。
  - リポジトリ、PR の番号・題・URL・作者、head の SHA とブランチ、base のブランチ。
  - `review_requested`・`review_request_removed` では、依頼の相手のログイン。
  - `check_suite` の `completed` では `conclusion`。`closed` ではマージされたか。
- PR の本文、コメント、差分は行に残さない。レビューでは、差分と CI の詳しい結果を読みに、必ず GitHub へ行くからである。
- 差分から外すファイルは、最初の版では持たない。更新元の登録（ADR 0091 の Decision「置き場所は `/sources/webhooks/<名前>/`」）は変えない。
  決まった欄より多くを残すことが要るようになったら、`alertmanager` の `firing.jsonl` と同じく、差分から外すファイルに置く形で足す。
- 印は、`attention: true` の webhook で行を書くたびに付ける。印の種類は `raw` と同じ `webhook` で、場所はその行である。印の欄に PR の題などの中身は載せない（ADR 0091 の型 `raw` の印と同じ）。
- `README.md` には、型、`authors`・`reviewers`、印の付く条件、`description` を書く（ADR 0091 のまま）。
- 型ごとの読み方（行の欄、イベントと action の意味）は、更新元のマニュアルの型 `github` の節に書く。system prompt、ツールの定義、出来事の種類は変えない。

### 入れる前から開いている PR は扱わない。型は GitHub に問い合わせない

- 型は、webhook で届いたものだけから覚える PR を決める。webhook を入れる前に依頼が出ていた PR は、覚えない。
- 型は GitHub の token を持たず、GitHub の API に問い合わせない。覚えた PR の今の状態を確かめ直すことも、取りこぼした出来事を埋め直すこともしない。
  開いている PR の見直しは、受け手のインスタンスの日課（ADR 0090）に任せる。

### 守る対象と、失敗のときに倒す側

- 守る対象は、受け手のなつみの `/sources` と、なつみのターンである。認証と断り方は ADR 0091 のまま変えない。
- 許す範囲は、署名の合う配送のうち、`authors` の作者の PR で、`reviewers` に依頼が出たものの出来事を行にすることだけである。
- 設定の誤り（`authors` か `reviewers` が無い・空）は、起動を止める。読み分けられないもの（知らないイベント、知らない action、覚えていない PR）は、行にしない側に倒す。
- 行を書けなければ 5xx を返す（ADR 0091 のまま）。GitHub は自動では送り直さないので、その配送は人が Redeliver しない限り失われる。

### 運用として前提にすること

次のことは型の決定ではなく、この型を使う運用の前提である。

- 持ち主の PR をレビューしてほしいときは、webhook ではなく A2A で頼む（[ADR 0089](0089-hearing-from-agents-over-a2a.md)）。
  webhook では、手で出した依頼と CODEOWNERS による自動の依頼が見分けにくい。`authors` には、Renovate のような bot の作者を名指しする。
- 環境の設定を持つリポジトリ（auto-merge を使わず、コードオーナーが持ち主だけのもの）でも PR はレビューし承認するが、マージは持ち主が行う。そこでのマージは、そのまま本番に入るからである。
- 受け手の webhook は、最初は `attention: false` で受ける。依存の更新の PR は急がず、ADR 0053 の待ちの間に、同じ PR の依頼・CI・push が 1 回の出来事にまとまりやすい。急ぐものは A2A で頼む。
- 受け手の週ごとの日課は、開いている PR のうち、まだ自分の承認が無いものだけを見る保険に変える（ADR 0090 の同意の流れで、文言は持ち主がうなずいたもの）。

### 本 ADR で決定しないこと

- 行の欄と config の欄の正確な名前、応答の本文、覚える PR の SQLite の表と migration、配送の ID の覚え方（委譲先: 実装の PR と README の設定の節）。
- `pull_request` のレビューのほかのイベント（issue、コメント、`pull_request_review` など）を読むこと（委譲先: 要るようになったときに、この型を広げる ADR）。
- 残った PR を消すこと、古い日付のファイルを消すこと（委譲先: ADR 0091 の「本 ADR で決定しないこと」の古いファイルの扱いと合わせて決める ADR）。
- GitHub App の作成、秘密の置き場所、受け手のインスタンスの config と記憶の中身（委譲先: 環境の設定を持つ private のリポジトリと、受け手の記憶）。

### 実装で確かめること

- レビュアーがレビューを出したとき（承認を含む）に、GitHub が `review_request_removed` を送るか。忘れ方には効かないが、行の読み方に要る。
  送るなら、承認のたびに `review_request_removed` の行が書かれ、手で依頼を外された行と見分けられない。どちらであっても、マニュアルの型 `github` の節には、
  この行だけで外されたと決めず、後の行が届いたら GitHub で今の依頼と自分のレビューの状態を見て決める、という読み方を書く（Consequences と同じ）。
- Renovate の PR で CODEOWNERS による自動の依頼が、`requested_reviewer` を持つ `review_requested` として届くこと。

### 置き換える既存の決定

- ADR 0091
  - 追加: 型の集合（`raw`・`alertmanager`）に `github` を足す。型ごとの欄に `authors`・`reviewers`・`attention` を足す。
  - 適用: Decision「受け口は `POST /v1/webhooks/<名前>` の 1 つで、webhook ごとに型を選ぶ」の退けた案の「GitHub も、まず `raw` で受け、困ってから型 `github` を足す」。
  - 残す: 受け口、認証、本文の上限、断り方、置き場所、`README.md`、更新元 `webhooks` の登録、印の種類 `webhook`。
- ADR 0050
  - 変えない。更新元の登録も印の種類も足さない。型 `github` の印は、ADR 0091 で足した `webhook` を使う。

## Consequences

- レビューを頼まれた PR が、開いてから待ちの後に受け手に届く。週に一度の見回りを待たずにレビューと承認が進み、auto-merge のリポジトリでは承認のあとすぐにマージされる。
- 受け手が見るのは、頼まれた PR の依頼・CI の結果・push・閉じたことだけである。ほかの PR の出来事は `/sources` に残らない。
- 行に本文を残さないので、外の人が書いた PR の本文やコメントが `/sources` の履歴に入らない。その代わり、受け手は中身を読むたびに GitHub へ行く。行だけでは、何の更新かを題からしか判断できない。
- fork のブランチの PR は、`check_suite` の `pull_requests` が空になるので、CI の結果が通らない。依頼・push・閉じたことだけが通る。受け手自身が fork から出した直しの PR は、作者が `authors` に入らないので、もともと覚えない。
- 型は GitHub に問い合わせないので、取りこぼした出来事は埋まらない。natsumi が落ちていた間の配送や 5xx を返した配送は、人が Redeliver しない限り失われる。webhook を入れる前に開いていた PR も届かない。どちらも週ごとの日課が拾う。
- 消さない残った PR の行が、表に少しずつ溜まる。数は扱う PR の数を超えない。
- 依頼を手で外された PR も、`closed` まで覚えたままになる。その PR の push・CI の結果・閉じたことは、外された後も受け手に届き続ける。
  受け手は、`review_request_removed` の行だけで外されたと決めない。承認のたびにこの行が届くかもしれず、そのときに後の行を読み流すと、承認が取り消されたあとの push と CI の結果を見落とす。
  その PR の後の行（push・CI の結果）が届いたら、GitHub で今の依頼と自分のレビューの状態を見て、まだ自分が見るべき PR か（承認が取り消された、など）を決める。
- `X-GitHub-Event` は署名の外にある。署名の合う本文を見た者は、イベントの種類を変えて送り直せる。本文の形がイベントごとに違うので、多くは 400 か読み捨てになる。
  秘密が漏れていなければ、新しい本文は作れない（ADR 0091 の Consequences の「騙るものへの答え」のまま）。
- PR の題、ブランチの名前は外の人が書いた文字列で、行に入る。なつみはそれを外の文章として読む（ADR 0091 のまま）。
- 型を広げてほかのイベントを読むには、natsumi の変更とリリースが要る。それまでは、購読しても読み捨てられる。

## Alternatives Considered

- **`raw` のまま受け、届いた本文をなつみに読み分けさせる**: `check_suite` だけでは頼まれた PR かを決められず、ほかの PR の出来事と本文がすべて履歴に残る。状態を覚えて絞るには型が要る。
- **型の名前を `github-pr` にする**: GitHub App の webhook は 1 つの URL に全部のイベントを送るので、扱うイベントを広げるたびに型を分けると、同じ URL を複数の webhook に分けられない。
- **作者を絞らず、`reviewers` への依頼が届いた PR をすべて扱う**: 持ち主が手で出した依頼と CODEOWNERS の自動の依頼が見分けにくい。持ち主の PR は A2A で頼めば、何を見てほしいかも一緒に伝えられる。
- **PR の本文も行に残し、マニュアルで jq で絞らせる**: 出来事の `diff`（`sources-diff`）は jq を通らず行を丸ごと出す。レビューでは差分と CI を読みに必ず GitHub へ行く。外の文章を `/sources` の履歴に残さない。
  出来事の差分の見方を更新元ごとに持たせる案は、更新元全体の変更になるので採らなかった。
- **入れる前から開いている PR を、起動時に GitHub に問い合わせて覚える**: 型に GitHub の token と API の道が要る。開いている PR は週ごとの日課で拾える。
- **印の種類を型ごとに足す（`pull_request` など）**: 意味は「印を付けるように設定された webhook で行が書かれた」で `raw` の `webhook` と同じである。種類を足すと ADR 0050 の登録とマニュアルの表が増えるだけになる。

## Related ADRs

- Related: ADR-0091 webhook の受け口を 1 つにし、届いたものの読み方は型としてコードに持つ（型 `github` を足す）
- Related: ADR-0050 読みものの更新を 1 種類のイベントで知らせ、差分は git で見せる（変えない。印の種類 `webhook` を使う）
- Related: ADR-0053 読みものの更新は、最初の変化で引いたランダムな待ちの後に知らせる
- Related: ADR-0069 外のエージェントの返事は /sources にファイルで置き、sources_updated で知らせる
- Related: ADR-0079 依存の更新は Renovate に追わせ、公開から 7 日経った版だけを受け取る（コードオーナーの承認で GitHub がマージする）
- Related: ADR-0089 なつみも A2A の受け口を持ち、届いた依頼は /sources に置いて、返事のツールで閉じる
- Related: ADR-0090 目標を記憶の `goals/` に置き、ping は今日の計画を進める合図にする

## References

- GitHub Docs「Webhook events and payloads」の `pull_request`（action の一覧、`requested_reviewer`・`requested_team`、`synchronize` の `before`・`after`、`closed` の `merged`、App の権限）・`check_suite`（`completed`、fork の `pull_requests` が空）・`ping`・Delivery headers（https://docs.github.com/en/webhooks/webhook-events-and-payloads 、2026-11-04 確認）
- GitHub Docs「REST API endpoints for check suites」の `pull_requests` の要素（`number`・`head`・`base`）と `conclusion` の値（https://docs.github.com/en/rest/checks/suites 、2026-11-04 確認）
- GitHub Docs「Handling failed webhook deliveries」（自動では送り直さない、10 秒の応答。https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries 、2026-11-04 確認）
- GitHub Docs「Best practices for using webhooks」（Redeliver でも `X-GitHub-Delivery` は同じ。https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks 、2026-11-04 確認）
- natsumi `src/server/webhooks.ts` の `RawWebhook`・`DayLines`・`WEBHOOKS_REGISTRATION`、`src/server/alertmanager.ts` の `AlertmanagerWebhook`、`src/server/config.ts` の `WebhookFormatConfig`・`parseWebhook`、`manual/webhooks.md`（2026-11-04 確認）
