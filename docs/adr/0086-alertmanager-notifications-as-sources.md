# 0086. Alertmanager の通知を受けて /sources に置き、sources_updated で知らせる

- Date: 2026-10-30
- Status: Accepted（受け口 `POST /v1/alertmanager/<送り手の名前>`、置き場所 `/sources/alertmanager/<送り手の名前>/`、更新元 `alertmanager`、config の最上位 `alertmanager`、JSON として読めない本文の 400 は [ADR 0091](0091-one-way-in-for-webhooks-with-formats-in-the-code.md) で置き換え（`POST /v1/webhooks/<名前>`、`/sources/webhooks/<名前>/`、`webhooks` の型 `alertmanager` の webhook、415）。状態の差分・`firing.jsonl`・印 `alert`・本文の上限・token の照らし方は同 ADR の型 `alertmanager` に引き継ぐ）

## Context

本人は、クラスタの運用を受け持つインスタンスを立てる（[ADR 0085](0085-relays-that-add-the-keys-for-the-workspace.md)）。
そのクラスタには kube-prometheus の Prometheus と Alertmanager があり、アラートは今は Slack に通知している。
本人は、同じアラートをそのインスタンスにも届け、調べて提案させたいと考えた。Slack への通知は残す。

手元には次のものがあった。

- 外から届くものは、可能な限り `/sources` の下のファイルにし、`sources_updated` で知らせる方針がある（[ADR 0069](0069-agent-replies-as-files-in-sources.md)）。
  出来事の種類も system prompt も増やさずに済む。
- `sources_updated` は、変わったディレクトリ、なつみ宛ての印（`attention`）、差分の見方を載せる（[ADR 0050](0050-telling-of-source-updates-with-one-event.md)）。
  印の無い変化は、最初の変化で引いたランダムな待ちの後に知らせ、awake hours の外では起こさない。印はすぐ、夜でも知らせる（[ADR 0053](0053-waiting-at-random-for-source-updates.md)）。
- 更新元を足すときは、登録（名前・深さ・外すファイル）とマニュアルの 1 枚を足す（ADR 0050）。
- natsumi が外から受ける口は、今は本人のブラウザと iPhone だけで、GitHub のログインで守っている。
  Slack は Socket Mode で natsumi から外へつなぐので、受ける口が無い（[ADR 0012](0012-slack-and-colleagues.md)）。
  機械から呼ばれる受け口は、これが初めてである。
- サーバーはクラスタの Ingress の後ろにいる。Ingress では認証を掛けず、`/` の下を丸ごと通している（[ADR 0033](0033-running-on-kubernetes.md)）。
- Alertmanager の webhook は、アラートのグループごとに JSON を POST する。中身は、グループの状態、共通のラベル、
  アラートの並び（各アラートの状態 `firing`・`resolved`、ラベル、annotation、`startsAt`・`endsAt`、`fingerprint`、`generatorURL`）である。
  同じグループは `repeat_interval` ごとに送り直され、2xx 以外の応答は送り直される。
  `authorization` の設定で、ファイルから読んだ bearer token を付けられる。

## Decision

### 更新元 `alertmanager` を足し、受け口は送り手ごとの bearer token で守る

- サーバーに受け口 `POST /v1/alertmanager/<送り手の名前>` を足す。送り手は Alertmanager の 1 つで、config で名前と token のファイルを宣言する。
- 呼び出しは `Authorization: Bearer <token>` で認める。token は送り手ごとに別にし、時間に依らない比べ方で照らす。
  - 名前を知らない送り手と、token の合わない呼び出しは、同じ 401 で断る。どちらが外れたかを返さない。
  - token は秘密として扱い、config には書かない（ファイルで渡す。ほかの秘密と同じ）。
- 送り手の Alertmanager は、`authorization` の `credentials_file` で同じ token を付ける。
- 受け口は、ブラウザと同じ待ち受け（Ingress の後ろ）に置く。ブラウザのログインの cookie では通さない。
- 本文の大きさに上限（1 MiB 程度）を置く。JSON として読めないものは 400 で断る。

退けた案:

- **gated の audience の ServiceAccount の token で認める**（[ADR 0084](0084-calling-agents-behind-gated-with-its-audience.md)）:
  natsumi の Ingress は gated の NetworkRole で守っていないので、natsumi が自分で token を確かめることになる。
  TokenReview の権限をなつみの ServiceAccount に与えるか、gated の assertion を検証するコードが要る。
  ADR 0033 はなつみの ServiceAccount に権限を与えない方針である。送り手は 1〜2 個の見込みで、共有の token で足りる。
- **クラスタの中だけの別の待ち受け（Ingress に出さないポート）で受け、認証を掛けない**:
  NetworkPolicy が効くかはクラスタに依る（[ADR 0034](0034-an-allow-list-for-the-way-out.md)）。Pod の IP に届く誰でも書き込めてしまう。
  受け口の守りは、置き場所ではなく token に預ける。

送り手からの道は、環境の設定の側で選ぶ。勧めるのは公開の入口（Ingress、HTTPS）を通す道である。token が TLS の中に置かれる（ADR 0034 が外のエージェントに公開の入口を使わせたのと同じ理由）。
クラスタの中の Service を直接叩く道でも、natsumi は同じ token で認める。そのときは、token がクラスタの中を平文で流れる。

### 置き場所: 送り手ごとのディレクトリに、日付の JSON Lines と、いま firing の一覧

- 更新元の名前は `alertmanager`、深さは 1（`alertmanager/<送り手の名前>`）。送り手（クラスタ）ごとに活発さを測る。
- ディレクトリの中身は次のとおりである。

| ファイル | 中身 | 差分 |
| --- | --- | --- |
| `<日付>.jsonl` | 状態が変わったアラートを 1 行ずつ。記録した順 | 見る |
| `firing.jsonl` | いま firing のアラートを 1 行ずつ。始まった順 | 外す |

- 日付と時刻は、Slack の日付ファイルと同じく、なつみのタイムゾーンで書く（時刻は秒まで）。
- 行は 1 つのアラートで、欄は次のとおりである。正確な名前は実装の PR で決める。
  - 受け取った時刻、状態（`firing`・`resolved`）、`alertname`、`severity`
  - ラベル、annotation（届いたまま）
  - 始まった時刻、終わった時刻（`resolved` のとき）、`fingerprint`、`generatorURL`
- 行はアラートごとにする。グループごとにしない。グループの分け方は Alertmanager の route の設定で変わり、なつみが読むのは個々のアラートだからである。
  グループの印（`groupKey`）は、行の欄に残してよい（実装で決める）。
- `firing.jsonl` は、いま何が起きているかを 1 回で読むためのものである。受け取るたびに書き直す。
  日付のファイルの行と中身が重なるので、Slack の `INDEX.md` と同じく差分から外す。

退けた案:

- **アラートごとに 1 ファイル（`<fingerprint>.json`）を置き、状態を書き換える**: 差分はファイルの書き換えとして見えるが、
  いつ何が起きたかの並びが、ファイルを開いて回らないと分からない。日付のファイルなら、`sources-diff` と `tail` で並びが読める。
- **届いた JSON をそのまま置く**: 送り直しのたびに同じ中身が増え、差分が送り直しで埋まる。

### 状態が変わったときだけ行を書く

- サーバーは、送り手と `fingerprint` ごとに、最後に書いた状態を覚える（SQLite）。
- 次のときだけ、日付のファイルに行を書く。
  - 初めて見るアラートが `firing` で届いた。
  - `resolved` だったアラートが、また `firing` で届いた。
  - `firing` だったアラートが `resolved` で届いた。
  - 覚えていないアラートが `resolved` で届いた（受け口を作る前に始まったものなど）。
- 状態が同じままの送り直し（`repeat_interval`）と、2xx 以外の応答のあとの送り直しでは、行を書かない。`firing.jsonl` だけを今の中身で書き直す。
- 受け取ったものを書き終えてから 2xx を返す。書けなかったら 5xx を返し、Alertmanager の送り直しに任せる。送り直しで二重に書かないのは、上の状態の覚え方による。

### 印（attention）は、重いアラートが firing になったときだけ

- `firing` の行を書いたとき、その `severity` のラベルが config の `attentionSeverities` にあれば、印を付ける。既定は `["critical"]` である。
  - 印の種類は `alert`、場所はその日付のファイルの、その行（`jq -s` のパス）である。種類の意味は更新元のマニュアルに書く。
  - 印はすぐ、夜でも知らせる（ADR 0050・0053）。
- 印の無い行（`warning` などの `firing`、すべての `resolved`）は、ふつうの変化として、ADR 0053 のランダムな待ちの後に知らせる。awake hours の外では起こさない。
- `severity` のラベルの名前は `severity` に固定する。kube-prometheus の規則はこの名前を使う。

退けた案:

- **すべて印にしてすぐ知らせる**: kube-prometheus の `warning` は数が多く、すぐ消えるものもある。夜も含めて毎回ターンが動く。
- **すべて待ちに乗せる**: 本番の止まりかけに、平均 10 分、最長 60 分の待ちが乗る。awake hours の外では朝まで届かない。
- **`resolved` も印にする**: 片づいた知らせは急がない。印の付いた `firing` を調べている途中なら、差分で分かる。

### 送るものの選び方は Alertmanager の側

- どのアラートを natsumi に送るか（`Watchdog` などの常に firing のアラートを除くなど）は、Alertmanager の route と receiver で決める。natsumi は届いたものを絞らない。
- Slack への今の通知は、別の receiver として残す。

### 古いファイルは、最初の版では消さない

- 日付のファイルは、状態が変わったときの行だけなので、大きくならない見込みである。最初の版では消さない。
- 消すと、消したこと自体が変化として `sources_updated` に出る。消すようになるときは、黙って取り込む形（ADR 0050 の 2026-10-12 の追記）と合わせて決める。
- `sources` の git の履歴は、これまでどおり N 日で刈り込む（ADR 0050）。

### config

- 最上位に `alertmanager` を足す。書かなければ受け口を持たない（404）。
  - `senders`: 送り手の並び。各送り手は `name`（ディレクトリと受け口のパスに使う。英小文字・数字・`-`）と `tokenFile`。
  - `attentionSeverities`: 印を付ける `severity` の並び。既定は `["critical"]`。
- 正確な名前と、上限などの細かい既定は実装の PR で決める。

### マニュアル

- 更新元のマニュアルを 1 枚足す。ファイルの形、行の欄、印 `alert` の意味、`firing.jsonl` で今を見ること、annotation の `runbook_url` などの読み方を書く。
- system prompt、ツールの定義、出来事の種類は変えない（ADR 0050）。

### 実装で決めたこと

ADR では決めず、実装の PR で決めたものは次のとおりである。

- **行の欄の名前**: Slack の日付のファイルに揃えて snake_case にした。`at`（受け取った時刻）・`status`・`alertname`・`severity`・`labels`・`annotations`・
  `starts_at`・`ends_at`（`resolved` のときだけ）・`fingerprint`・`generator_url`・`group_key`。時刻はどれも `loop.timeZone` の `YYYY-MM-DD HH:MM:SS` である。
  ラベルに `alertname`・`severity` が無ければ、その欄を置かない。`firing.jsonl` の行は最後に届いた形で、`at` も最後に届いた時刻である。
- **送り手の名前**: 英小文字・数字・`-` で 32 文字まで（`a2a.agents` の名前と同じ）。重ねられない。
- **token**: `tokenFile` だけを受け、起動時に読む（入れ替えは再起動、と Consequences に書いたとおり）。読めなければ設定の名前だけを示して起動を止める。
  照らすときは、届いた token と覚えた token をそれぞれ SHA-256 にしてから時間に依らない比べ方をする。長さの違いも漏らさない。名前を知らない送り手も、同じ手順で使われない値と照らす。
- **応答**: 書き終えたら 200（本文は `{"recorded": <足した行の数>}`）。401 は `unauthorized`、本文の上限（1 MiB）を超えれば 413 `too-large`、
  webhook の形でない JSON も 400 `invalid-request` にする（`alerts` の並び、各アラートの `status`・文字列のラベルと annotation・RFC 3339 の `startsAt`・`resolved` の `endsAt`・`fingerprint`）。
  書けなければ 503 `not-recorded`。POST 以外は、ほかの知らない道と同じ 404 にする。
- **書き方**: アラートの状態（`alertmanager_alerts`）と日付のファイルの行（`alertmanager_lines`）を 1 つのトランザクションで SQLite（migration 34）に入れ、印もその中で記録する。
  そのあとファイルを丸ごと書き直す。ファイルが書けずに 503 を返したときは、状態はもう変わっているので、送り直しは行を足さずに、書けなかったファイルだけを書く。
  そのまま再起動したときは、起動時に送り手ごとの最新の日付のファイルと `firing.jsonl` を書き直す。
- **印の欄**: 印の `details` に `alertname` と `severity` を載せる。annotation は載せない（外の文章を出来事に入れないため）。
- **差分から外す書き方**: 登録の `exclude` に `*/firing.jsonl` を書く。`firing.jsonl` だけが書き換わっても、更新元の変化にならない。
- **`config.example.json`**: `alertmanager` は載せない。`a2a`・`slack` と同じく秘密のファイルが要る省略可の設定で、写した例が token のファイルの無いところで起動を止めないためである。書き方は README にある。

### 置き換える既存の決定

- ADR 0069
  - 適用:「外から届くものは、可能な限り `sources_updated` に寄せる」の 2 つ目の適用である。新しい出来事の種類は作らない。
- ADR 0050
  - 追加: 更新元 `alertmanager`（深さ 1、`firing.jsonl` を差分から外す）と、印の種類 `alert`。
- ADR 0033
  - 追加: Ingress の後ろの待ち受けに、GitHub のログインではなく bearer token で守る受け口が 1 つ増える。Ingress では今までどおり認証を掛けない。

## Consequences

- 重いアラートは、夜でもすぐなつみのターンを動かす。軽いアラートと解消は、ランダムな待ちの後にまとめて届く。
- アラートの annotation は、Prometheus の規則を書いた人の文章であり、外から届く文章として扱う。規則を書けるのは本人と、クラスタに規則を足せるものだけである。
- 受け口は公開の入口に出るので、token が漏れれば、誰でも偽のアラートを書き込める。書き込めるのは送り手のディレクトリのファイルだけで、なつみのターンを動かせることが被害になる。
  token は Alertmanager の秘密と、natsumi の秘密の 2 か所に置き、入れ替えるときは両方を直してサーバーを再起動する。
- `fingerprint` ごとの状態を SQLite に持つので、data directory に表が 1 つ増える。消したアラートの状態は残り続ける。
  増え方が気になったら、長く `resolved` のままのものを捨てる。
- 送り直しで行が増えないので、日付のファイルは状態の変化の記録になる。逆に、annotation の書き換えのような状態の変わらない更新は、日付のファイルに残らない（`firing.jsonl` には反映される）。
- Alertmanager が `max_alerts` で並びを切ったとき、切られたアラートは届かない。natsumi に送る receiver では `max_alerts` を設けない。
- 日付のファイルを消さないので、`/sources/alertmanager` は少しずつ増える。

作業は次の単位で進める。

1. natsumi: 受け口、更新元の登録、状態の表、`firing.jsonl`、印、config、マニュアル。
2. 環境の設定（private のリポジトリ）: token の秘密を natsumi と Alertmanager の両方に置き、Alertmanager に natsumi への receiver と route を足す。
