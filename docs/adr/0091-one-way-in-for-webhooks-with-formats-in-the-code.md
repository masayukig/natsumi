# 0091. webhook の受け口を 1 つにし、届いたものの読み方は型としてコードに持つ

- Date: 2026-11-04
- Status: Accepted（型の集合に `github`（レビューを頼まれた PR の出来事だけを通す）を [ADR 0093](0093-a-github-format-for-pull-requests-asked-to-review.md) で追加）

## Context

本人は、外の仕組みからなつみに `sources_updated` を起こせる、汎用の webhook の受け口を欲しがった。
最初の利用者はクラスタの Alertmanager で、その後に GitHub などの webhook を足したい。
受け口を送り手の種類ごとに作り足すのではなく、1 つの仕組みに寄せたいと考えた。

手元には次のものがあった。

- 外から届くものは、可能な限り `/sources` の下のファイルにし、`sources_updated` で知らせる方針がある（[ADR 0069](0069-agent-replies-as-files-in-sources.md)）。
  出来事の種類も system prompt も増やさずに済む。
- `sources_updated` は、変わったディレクトリ、なつみ宛ての印（`attention`）、差分の見方を載せる（[ADR 0050](0050-telling-of-source-updates-with-one-event.md)）。
  印の無い変化は、最初の変化で引いたランダムな待ちの後に知らせ、awake hours の外では起こさない。印はすぐ、夜でも知らせる（[ADR 0053](0053-waiting-at-random-for-source-updates.md)）。
  更新元は、名前・活発さを測るディレクトリの深さ・差分から外すファイルを登録する（ADR 0050 の「コアは Slack を知らない」）。
- Alertmanager の受け口は、すでにある（[ADR 0086](0086-alertmanager-notifications-as-sources.md)）。
  - 受け口は `POST /v1/alertmanager/<送り手の名前>` で、送り手ごとの bearer token で守る。名前を知らない送り手と合わない token は、同じ 401 で断る。
  - 届いたアラートは、送り手と `fingerprint` ごとに最後の状態を SQLite に覚え、状態が変わったときだけ日付の JSON Lines に 1 行を書く。
    いま firing のものは `firing.jsonl` に書き直す。`severity` が config の `attentionSeverities` にあるアラートが firing になったら、印 `alert` を付ける。
  - 更新元は `alertmanager`（深さ 1）で、config は最上位の `alertmanager`（送り手の並びと `attentionSeverities`）である。
  - この受け口を config に書いて使っている環境は無い。
- Alertmanager は bearer token を付けて送れる。GitHub の webhook は bearer token を付けられない。
  代わりに、共有の秘密で本文全体の HMAC-SHA256 を取り、`X-Hub-Signature-256: sha256=<16 進>` のヘッダーで送る。
  イベントの種類と配送の ID は、`X-GitHub-Event`・`X-GitHub-Delivery` のヘッダーで送る。
- サーバーはクラスタの Ingress の後ろにいる。`/` の下の Ingress では認証を掛けず、丸ごと通している（[ADR 0033](0033-running-on-kubernetes.md)）。
  機械から呼ばれる受け口は、Alertmanager の受け口と A2A の受け口（[ADR 0089](0089-hearing-from-agents-over-a2a.md)）の 2 つで、どちらもブラウザのログインの cookie では通さない。
- A2A の受け口は、gated の assertion を検証する部品を持っている（ADR 0089）。`/` の下の Ingress は gated で守っていない。
- 外に作用する行為の安全は、サーバーの承認記録と強制に依る（[ADR 0012](0012-slack-and-colleagues.md)）。届いた文に何が書いてあっても、同意の証拠にはならない。

本人は、Alertmanager を騙ったものに、なつみが騙されないかを心配した。

## Decision

### 受け口は `POST /v1/webhooks/<名前>` の 1 つで、webhook ごとに型を選ぶ

- サーバーに受け口 `POST /v1/webhooks/<名前>` を足す。`<名前>` は config で宣言した webhook の名前である。
- webhook は、config の最上位 `webhooks` に並べる。各 webhook は次のものを持つ。

| 欄 | 意味 |
| --- | --- |
| 名前 | 受け口のパスとディレクトリに使う。英小文字・数字・`-` で 32 文字まで（ADR 0086 の送り手の名前と同じ）。重ねられない |
| `format` | 届いたものの型。`raw` か `alertmanager` |
| 認証 | `tokenFile` か `secretFile` のどちらか 1 つ（次の節） |
| `description` | この webhook が何を送ってくるか、どう読むか。必須（「webhook ごとの読み方」の節） |
| 型ごとの欄 | `raw` は `headers`・`attention`、`alertmanager` は `attentionSeverities`。ほかの型の欄は書けない |

- 型は natsumi のコードで持つ閉じた集合である。型を足すのは natsumi 本体の変更で行う。
  外から型を差し込む plugin の仕組み（スクリプトや変換の式を config で渡す形）は作らない。
- 同じ型の webhook を複数持てる。Alertmanager が 2 つあれば、型 `alertmanager` の webhook を 2 つ宣言する。
- 受け取ったものを書き終えてから 2xx を返す。書けなければ 5xx を返し、送り手の送り直しに任せる（ADR 0086 と同じ）。
- 本文の上限は、どの型でも 1 MiB とする（ADR 0086 のまま）。
- JSON として読めない本文は、どの型でも 415 で断る。JSON だが型の形でない本文は、400 で断る。
- `webhooks` を書かなければ、受け口は持たない。`/v1/webhooks/` の下は、ほかの知らない道と同じ 404 にする。POST 以外も 404 にする。

退けた案:

- **`raw` だけを持ち、Alertmanager の通知も届いたまま置いてなつみに読ませる**: Alertmanager は同じグループを `repeat_interval` ごとに送り直す。
  届いたまま置くと、差分が送り直しで埋まる（ADR 0086 が「届いた JSON をそのまま置く」を退けた理由と同じ）。
  状態の差分を取り、重いものだけに印を付けるには、送り手の形を知るコードが要る。
- **型を外から差し込む plugin の仕組み**: 受け口の処理は、認証を通った外の本文を読み、`/sources` に書き、印を付ける。
  ここに外のコードを差し込むと、サーバーの中で動くものの範囲と、試す範囲が広がる。型は少なく、足すたびに natsumi の変更でよい。
  GitHub も、まず `raw` で受け、困ってから型 `github` を足す。

### 認証は webhook ごとに bearer token か GitHub 形の HMAC

- 各 webhook は、次のどちらか 1 つで呼び出しを認める。両方を書くことも、どちらも書かないこともできない（起動を止める）。
  - `tokenFile`: `Authorization: Bearer <token>`。ADR 0086 の送り手の token と同じ。
  - `secretFile`: GitHub 形の HMAC。届いた本文全体（受け取ったバイト列のまま）の HMAC-SHA256 を秘密で取り、`X-Hub-Signature-256: sha256=<16 進>` と照らす。
- 認証は型と独立に選ぶ。`raw` の webhook を bearer token で守っても、`alertmanager` の webhook を HMAC で守ってもよい。
- token と秘密は、webhook ごとに別にする。config には書かず、ファイルで渡して起動時に読む。読めなければ、設定の名前だけを示して起動を止める。
- 照らし方と断り方は、ADR 0086 の決まりを引き継ぐ。
  - 時間に依らない比べ方で照らす。長さの違いも漏らさない。
  - 名前を知らない webhook、合わない token や署名、ヘッダーの無い呼び出しは、同じ 401 で断る。どれが外れたかを返さない。
  - ブラウザのログインの cookie では通さない。
- HMAC の webhook は、本文を読み終えるまで認証できない。本文は上限まで読んでから照らし、上限を超えたものは認証の前に 413 で断る。
  このため、HMAC の webhook の名前は、413 が返るかどうかで外から分かる。webhook の名前は URL に出るものであり、秘密として扱わない。秘密は token と HMAC の秘密だけである。
- 設定が読めないとき、認証の方式が決まらないときは、起動を止める側に倒す。認証を掛けずに受ける設定は作らない。
- 送り手からの道は、環境の設定の側で選ぶ。勧めるのは公開の入口（Ingress、HTTPS）を通す道である（ADR 0086 と同じ）。

退けた案:

- **gated の assertion で認める**（ADR 0089 の `gatedSubject`）: `/` の下の Ingress は gated で守っていない。受け口のために別の Ingress を立てて gated で守ることになる。
  GitHub は ServiceAccount の token を持たず、gated を通れない。Alertmanager も、bearer token で足りる。
  gated で確かめる送り手が要るようになったら、型と独立の 3 つ目の認証として足す。ADR 0089 の検証の部品がある。
- **URL に秘密を入れる**（`/v1/webhooks/<名前>/<秘密>` やクエリ）: URL は Ingress やプロキシのアクセスログ、送り手の設定画面に残る。
  Alertmanager も GitHub も、ヘッダーで秘密を送れる。

### 置き場所は `/sources/webhooks/<名前>/`

- 更新元の名前は `webhooks`、深さは 1（`webhooks/<名前>`）。webhook ごとに活発さを測る。
- 各 webhook のディレクトリには、型の書くファイルと `README.md` を置く。
- `README.md` には、サーバーが config の `description` と型を書く。起動のたびに書き直す。差分から外す。
  - config の書き換えは変化ではないので、`sources_updated` に出さない。
- 型が差分から外すファイル（`alertmanager` の `firing.jsonl`）も、登録で外す。
- 日付と時刻は、Slack の日付ファイルと同じく、なつみのタイムゾーンで書く（時刻は秒まで）。
- 古いファイルは、最初の版では消さない（ADR 0086 のまま）。config から外した webhook のディレクトリも消さない。

### 型 `raw`: 届いた 1 回を、日付の JSON Lines の 1 行に

- 届いた本文 1 つを、その日の `<日付>.jsonl` に 1 行で足す。行の欄は次のとおりである。正確な名前は実装の PR で決める。
  - 受け取った時刻
  - config の `headers` で名指したヘッダー（例: `["X-GitHub-Event", "X-GitHub-Delivery"]`）。届かなかったヘッダーは置かない
  - JSON として読んだ本文
- 送り直しの重複は除かない。同じ配送が 2 回届けば、2 行になる。GitHub の送り直しは、人が手で Redeliver したときだけである。困ったら型で扱う。
- 印は、webhook ごとの `attention: true | false` で決める。既定は `false` である。
  - `true` の webhook は、行を書くたびに印を付ける。印の種類は `webhook`、場所はその日付のファイルの、その行（`jq -s` のパス）である。
  - `false` の webhook の行は、ふつうの変化として、ADR 0053 の待ちの後に知らせる。awake hours の外では起こさない。
  - 急ぐものと急がないものは、webhook を分けて受ける。どのイベントをどちらに送るかは、送り手の側で選ぶ。
  - 印の欄に、本文とヘッダーの中身は載せない。外の文章を出来事に入れないためである（ADR 0086 が annotation を載せなかったのと同じ）。

退けた案:

- **届いた 1 回を 1 ファイルにする**: Slack と Alertmanager は日付の JSON Lines で、`sources-diff` と `tail` で並びが読める。同じ形に揃える。
- **ヘッダーをすべて残す**: 経路の Ingress やプロキシが足したヘッダーが混ざり、署名などの秘密に近いものも残る。要るものだけを名指しする。
- **ヘッダーや本文の値で印を付けるかを決める**: 条件の書き方が要り、plugin の仕組みに近づく。webhook を分ければ足りる。

### 型 `alertmanager`: ADR 0086 の処理をそのまま型にする

- 型 `alertmanager` は、ADR 0086 の処理をそのまま持つ。変わるのは受け口・置き場所・config だけである。
  - 本文は Alertmanager の webhook の形として読む。
  - `fingerprint` ごとに最後に書いた状態を覚え、状態が変わったときだけ日付のファイルに行を書く（ADR 0086 の Decision「状態が変わったときだけ行を書く」）。
  - `firing.jsonl` に、いま firing のアラートを書き直す。差分から外す。
  - `severity` が `attentionSeverities` にあるアラートが firing になったら、印 `alert` を付ける。既定は `["critical"]` である（ADR 0086 の Decision「印（attention）は、重いアラートが firing になったときだけ」）。
  - 行の欄は、ADR 0086 の「実装で決めたこと」のままとする。
- 置き場所は `/sources/alertmanager/<送り手の名前>/` から `/sources/webhooks/<名前>/` に変わる。
- SQLite に覚える状態は、送り手の名前ではなく webhook の名前を鍵にする。

### 移し方: 旧い受け口と config は消し、互換の層を持たない

- 旧い受け口 `POST /v1/alertmanager/<送り手の名前>` は消す。ほかの知らない道と同じ 404 になる。
- config の最上位の `alertmanager` は消す。旧い config が残っていれば、起動を止める。
  そのとき、型 `alertmanager` の webhook として `webhooks` に書き直すことを、エラーの文で示す。
- 旧い形を新しい形として読み替える互換の層は持たない。旧い受け口を使っている環境が無いからである。
- 旧い表の行は引き継がなくてよい。旧い置き場所 `/sources/alertmanager/` が data directory に残っていても、サーバーは読まず、消さない。

### webhook ごとの読み方と、マニュアル

- webhook ごとの読み方（何が送られてくるか、何を見ればよいか）は、config の `description` に書く。なつみは `README.md` で読む。
- 型ごとの読み方（ファイルの形、行の欄、印の種類 `webhook` と `alert` の意味、`README.md` を読むこと）は、更新元のマニュアル 1 枚に書く。
  Alertmanager のマニュアルは、このマニュアルの型 `alertmanager` の節に移す。
- system prompt、ツールの定義、出来事の種類は変えない（ADR 0050）。

退けた案:

- **webhook ごとにマニュアルを足す**: マニュアルは image に入るので、webhook を足すたびに natsumi の変更が要る。webhook は環境ごとに違う。

### A2A の push とは別

- 頼んだ係が返事を push で知らせる口は、この受け口を使わない。`ask_agent` の拡張として、ADR 0092 で別に扱う。

### 本 ADR で決定しないこと

- 行の欄・config の欄の正確な名前、応答の本文の形（委譲先: 実装の PR と README の設定の節）。
- 型 `github` などの新しい型（委譲先: その型を足すときの ADR）。
- 古いファイルを消すこと（委譲先: ADR 0086 の Decision「古いファイルは、最初の版では消さない」と同じく、黙って取り込む形と合わせて決める ADR）。
- 頻度の上限（委譲先: 要るようになったときの ADR。最初の版では持たない）。

### 置き換える既存の決定

- ADR 0086
  - 置き換え: 受け口 `POST /v1/alertmanager/<送り手の名前>`、置き場所 `/sources/alertmanager/<送り手の名前>/`、更新元 `alertmanager`、config の最上位 `alertmanager`。
    `POST /v1/webhooks/<名前>`、`/sources/webhooks/<名前>/`、更新元 `webhooks`、`webhooks` の型 `alertmanager` の webhook になる。
  - 置き換え: JSON として読めない本文の 400。415 にする。
  - 残す: 状態の差分、`firing.jsonl`、印 `alert` と `attentionSeverities`、本文の上限、送り直しの扱い、古いファイルを消さないこと、token の照らし方と 401 の返し方。
- ADR 0050
  - 置き換え: 更新元 `alertmanager`（ADR 0086 で追加）を、更新元 `webhooks`（深さ 1、`README.md` と `firing.jsonl` を差分から外す）にする。
  - 追加: 印の種類 `webhook`。`alert` は更新元 `webhooks` の型 `alertmanager` の印になる。
- ADR 0069
  - 適用:「外から届くものは、可能な限り `sources_updated` に寄せる」を、型を選べる汎用の受け口として適用する。新しい出来事の種類は作らない。
- ADR 0033
  - 追加: Ingress の後ろの待ち受けの Alertmanager の受け口は、bearer token か HMAC で守る webhook の受け口になる。`/` の Ingress では今までどおり認証を掛けない。

### 実装で決めたこと

ADR では決めず、実装の PR で決めたものは次のとおりである。

- **config の形**: `webhooks` は webhook の並び（1 つ以上）で、各要素は `name`・`format`・`tokenFile` か `secretFile`・`description` と型ごとの欄を持つ。
  `raw` は `headers`（既定 `[]`）と `attention`（既定 `false`）、`alertmanager` は `attentionSeverities`（既定 `["critical"]`）。
- **`raw` の行の欄**: `at`（受け取った時刻、`loop.timeZone` の `YYYY-MM-DD HH:MM:SS`）・`headers`・`body`。
  `headers` は config で名指したヘッダーのうち届いたものを、config に書いた綴りの名前で置く。名指していない webhook では欄を置かない。
- **残せないヘッダー**: `Authorization`・`Proxy-Authorization`・`Cookie`・`Set-Cookie`・`X-Hub-Signature`・`X-Hub-Signature-256` は `headers` に書けない（起動を止める）。秘密に近いものを行に残さないためである。
- **応答**: 書き終えたら 200（本文は `{"recorded": <足した行の数>}`）。401 は `unauthorized`、413 は `too-large`、JSON として読めなければ 415 `not-json`、
  型の形でなければ 400 `invalid-request`、書けなければ 503 `not-recorded`。名前を知らない webhook は、token の webhook と同じく本文を読む前に 401 にする。
- **署名の照らし方**: 届いた `X-Hub-Signature-256` の値と、本文から計算した `sha256=<16 進の小文字>` を、それぞれ SHA-256 にしてから時間に依らない比べ方をする。
- **SQLite の表**: migration 36 で `alertmanager_alerts`・`alertmanager_lines` を消し、`webhook_alerts`（webhook の名前と `fingerprint` が鍵）と、
  どの型も使う `webhook_lines`（日付のファイルの行）を作る。`raw` の行も表に持ち、日付のファイルはそこから書き直す（`alertmanager` と同じく、書けなかった行は次に届いたときか次の起動で書く）。
- **`README.md`**: 型、型ごとの設定（残すヘッダー、印の付く条件）、`description` を書く。token や秘密のファイルの場所は書かない。書けなくても起動は止めない。

## Consequences

- 外の仕組みからなつみに知らせる道が、config だけで足せる。JSON を POST できて、bearer token か GitHub 形の HMAC を付けられる送り手なら、`raw` で受けられる。
- 型を足すには natsumi の変更とリリースが要る。`raw` で足りない送り手（送り直しが多い、状態を持つ）は、型ができるまで差分が読みにくい。
- `raw` は送り直しの重複を除かない。送り手の自動の送り直しが多ければ、同じ中身の行が増える。
- `README.md` を差分から外すので、`description` を書き換えても、なつみには知らされない。次に読んだときに分かる。
- 旧い Alertmanager の受け口と config は使えなくなる。旧い config のままでは起動しない。使っている環境が無いので、移す相手はいない。
- HMAC の webhook は、認証の前に本文を上限まで読む。認証の無い呼び出しにも、1 回あたり最大 1 MiB を読ませられる。
- Alertmanager を騙るものへの答えは、次のとおりである。
  - token や秘密を知らなければ、書き込めない。token と秘密は webhook ごとに別なので、1 つが漏れても、ほかの webhook には書けない。
  - 残る穴は、token や秘密の漏洩と、平文の道（クラスタの中の Service を直接叩く道）で見られた呼び出しの再送である。
    bearer token も HMAC も時刻を含まないので、見られた呼び出しはそのまま送り直せる。型 `alertmanager` では状態が変わらない再送は行にならないが、`raw` では行が増える。
  - 被害は、その webhook のディレクトリに書けることと、なつみのターンを動かせることである。印の付く webhook なら、夜でも起こせる。
  - 本物の Alertmanager 経由でも、Prometheus の規則（PrometheusRule）を書けるものは、annotation で任意の文をなつみに読ませられる。これは認証では防げない。
    GitHub の webhook の本文も、issue やコメントを書ける人の文を含む。
  - なつみは、届いた本文を外の文章、送り手を名前付きの第三者として扱う。これはマニュアルで求め、サーバーでは強制しない。
    外に作用する行為は ADR 0012 の強制で止まる。届いた文に「本人が OK と言った」とあっても、同意の証拠にはならない。
    印はラベルや config で決め、annotation や本文の中身を印に載せない。
- token と秘密は、送り手の側と natsumi の側の 2 か所に置く。入れ替えるときは両方を直して、natsumi を再起動する（ADR 0086 と同じ）。
- 日付のファイルを消さないので、`/sources/webhooks` は少しずつ増える。`raw` で頻繁に届く送り手では、Alertmanager より速く増える。

作業は次の単位で進める。

1. natsumi: 受け口、認証の 2 つ、型 `raw` と `alertmanager`、更新元 `webhooks`、`README.md`、旧い config の検出、SQLite の表の持ち直し、マニュアル、README の設定の節。
2. 環境の設定（private のリポジトリ）: Alertmanager の webhook の config と token の秘密、Alertmanager の receiver と route。
3. GitHub の webhook は、`raw` が本番で動いてから足す。
