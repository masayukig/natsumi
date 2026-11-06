# 0089. なつみも A2A の受け口を持ち、届いた依頼は /sources に置いて、返事のツールで閉じる

- Date: 2026-10-31
- Status: Accepted

## Context

本人は、自分が直接話す Claude や Pi から、なつみのインスタンスに話しかけられる口を欲しがった。
なつみのインスタンス同士も、互いに話せるようにしたい。

[ADR 0025](0025-talking-to-outside-agents-over-a2a.md) は「なつみの受け口」の節で、なつみも A2A の受け口（Agent Card）を持つと決めていた。
届いたメッセージは、送り手の名前を付けた出来事 `agent_message` としてキューに入れる形だった。
上限と公開先は、受け口を開く前に決めるとして残していた。受け口はまだ作っていない。

その後、次のことが決まり、手元にそろった。

- 外から届くものは、可能な限り `/sources` の下のファイルにし、`sources_updated` で知らせる方針がある（[ADR 0069](0069-agent-replies-as-files-in-sources.md)）。
  専用の出来事を作る前に、まずこの形で足りないかを考える。外のエージェントの返事と、Alertmanager の通知（[ADR 0086](0086-alertmanager-notifications-as-sources.md)）がこの形になった。
- `sources_updated` は、変わったディレクトリ、なつみ宛ての印（`attention`）、差分の見方を載せる（[ADR 0050](0050-telling-of-source-updates-with-one-event.md)）。
  印の無い変化は、最初の変化で引いたランダムな待ちの後に知らせ、awake hours の外では起こさない。印はすぐ、夜でも知らせる（[ADR 0053](0053-waiting-at-random-for-source-updates.md)）。
- 機械から呼ばれる受け口は、Alertmanager の受け口が最初である。送り手ごとの bearer token で守り、ブラウザのログインの cookie では通さない（ADR 0086）。
- なつみが外の係を頼むツールは `ask_agent` で、返事はサーバーが取りに行く（[ADR 0035](0035-asking-outside-agents-and-hearing-back.md)）。
  token は設定の `a2a.tokenFile` の 1 つで、すべての係に同じものを送る。
  係ごとに token を持たせる設定は無い（ADR 0084 の Consequences が「混ぜられない」と書いたとおり）。
- クラスタの入口の gated は、ServiceAccount の token を確かめると、`Authorization` を落として署名付きの `Gated-Assertion` に置き換えて転送する（[ADR 0084](0084-calling-agents-behind-gated-with-its-audience.md)）。
  `yuanying/fraction-agents` の係は、その assertion を自分で検証している。
- なつみの Ingress では認証を掛けず、`/` の下を丸ごと通している（[ADR 0033](0033-running-on-kubernetes.md)）。
  ADR 0033 は、なつみの ServiceAccount に RBAC の権限を与えない。TokenReview はできない。
- 外に作用する行為の安全は、サーバーの承認記録と強制に依る（[ADR 0012](0012-slack-and-colleagues.md)）。

本人は、gated の無い環境でも受け口を使えるようにしたいと考えた。
また、なつみが返事を出すまで依頼が開いたまま忘れられることを心配した。

## Decision

### 受け口は思考ループの外の HTTP の層で、Task を SQLite に持つ

- なつみのサーバーは、A2A の受け口を持つ。持つのは Agent Card、SendMessage、GetTask の 3 つである。
  - CancelTask、ストリーミング、push 通知は持たない。Agent Card の capabilities にも出さない。
    送り手は GetTask で返事を取りに来る。なつみが `ask_agent` の返事を取りに行くのと同じ形である。
  - A2A の版と transport は、なつみが `ask_agent` で使っている SDK と同じものにする。
- 受け口は HTTP の層で受け、すぐに Task を返す。思考ループ（ADR 0008）は待たない。
- Task は SQLite に持つ。送り手、状態、届いたメッセージ、なつみの返事、時刻、A2A の context を記録する。
  サーバーが再起動しても、開いている Task は残る。
- 受け取ったものを `/sources` に書き終えてから、Task を返す。書けなければ失敗を返し、送り手の送り直しに任せる。

### 届いた依頼は `/sources/inbox` に置き、`sources_updated` で知らせる

- 更新元 `inbox` を足す。深さは 1（`inbox/<送り手の名前>`）で、送り手ごとに活発さを測る。
- Task 1 件を 1 つのディレクトリにする。場所は `/sources/inbox/<送り手の名前>/<日時>-<短い印>/` で、日時は ADR 0069 と同じく UTC の `20261031T013000Z` の形である。
- ディレクトリの中身は次のとおりである。正確な名前と欄は実装の PR で決める。

| ファイル | 中身 | 差分 |
| --- | --- | --- |
| `README.md` | 送り手、届いた時刻、いまの状態、返事の期限、同じ context の前の Task のディレクトリ | 見る |
| `NN-<書き手>.md` | メッセージ 1 つを 1 ファイル。送り手のものも、なつみの返事も、届いた順・返した順に番号を振る | 見る |
| `status.md` | いまの状態、最後に届いた時刻、開いてからの時間、催促の回数 | 見る |

- 送り手が同じ context で新しい Task を送ったら、新しいディレクトリを作る。`README.md` に、同じ context の前の Task のディレクトリを書く。
- 最初の版で受けるのは文章（TextPart）だけである。ほかの部分（FilePart・DataPart）を含むメッセージは断る。
- 印（`attention`）を付けるのは、新しい依頼が届いたときと、聞き返しに送り手が答えたときだけである。どちらも、なつみが動くのを送り手が待っている。
  - 印の場所は、届いたメッセージのファイルである。種類の意味は更新元のマニュアルに書く。
  - 印はすぐ、夜でも知らせる（ADR 0050・0053）。
- 印の無い変化（催促、期限切れ、なつみ自身の返事の書き込み）は、ふつうの変化として ADR 0053 の待ちの後に知らせる。
- 届いたものの中身は、出来事には載せない（ADR 0069）。なつみはファイルを読む。

退けた案:

- **ADR 0025 の出来事 `agent_message` でキューに入れる**: 出来事の種類と system prompt の説明が増える。
  本文が出来事としてそのまま session に入り、長い依頼で文脈が膨らむ。ADR 0069 の方針に反する。
- **届いたメッセージを日付の JSON Lines に足す**（ADR 0086 の形）: Task には開いてから閉じるまでの一続きがあり、状態が変わる。
  Task ごとのディレクトリなら、聞き返しと答えと返事が 1 か所に並ぶ。

### 返事は `reply_to_agent` で返し、Task を閉じるのはなつみ

- ツール `reply_to_agent` を足す。引数は次の 3 つである。

| 引数 | 意味 |
| --- | --- |
| `to` | 宛先。送り手の名前（次の節） |
| `text` | 返事の本文 |
| `state` | `completed` か `input-required` |

- `completed` は Task を閉じる。本文は任意である。A2A でも、completed の Task に本文は要らない。
- `input-required` は聞き返しである。本文は必須とする。聞き返しの間は催促しない。
  - 送り手は同じ Task に答えを送る。答えが届いたら、Task は `working` に戻り、印が付く。
  - 聞き返しの間でない開いた Task に、送り手が続けてメッセージを送ることは断る。足したいことがあれば、新しい Task にする。
- 途中経過だけの返事（`working` のまま本文を返す）は作らない。返事を出せば、閉じるか聞き返すかのどちらかである。
- なつみの返事も、Task のディレクトリに `NN-<書き手>.md` として書く。後から一続きを読める。
- 閉じた Task への返事は断る結果を返す。宛先の送り手に開いた Task が無ければ、それも断る。
- ツールはいつも定義に置き、説明は固定の文にする（[ADR 0019](0019-a-workspace-not-a-memory-tool.md)）。
  送り手の一覧をツールの説明に書かない。受け口が閉じていれば、断る結果を返す（設定の無い `ask_agent` と同じ）。

### 宛先は送り手の名前で、開いた Task が複数あるときだけディレクトリまで書く

- `to` は、送り手の名前（`claude` など）とする。その送り手に開いた Task が 1 つなら、それに返す。
- 開いた Task が 2 つ以上あるときは、`<送り手の名前>/<日時>-<短い印>` と、Task のディレクトリまで書く。
  なつみは、印や催促のたびに、そのディレクトリのパスを `sources_updated` で見ている。
- 送り手の名前だけで、開いた Task が 2 つ以上あれば、サーバーは返さずに断る。結果の文には、開いている Task のディレクトリを並べる。
  どれに返すかを、サーバーが推し量らない。

退けた案:

- **いちばん古い（または新しい）開いた Task に返す**: 送り手が並べて頼んだとき、取り違えた返事が黙って届く。
- **Task の ID を写させる**: 形の似た ID を並べて写させる設計は、返事を落とした（[ADR 0024](0024-no-event-ids-for-the-model.md)）。
  ディレクトリの名前は、なつみが読む場所そのものであり、開いた Task は送り手ごとに上限（3）までしか並ばない。

### 開いている Task は、サーバーが状態のファイルを書き換えて催促する

- 開いている Task（`working`）を、サーバーは決まった間隔で催促する。催促は、その Task の `status.md` を書き換えることである。
  書き換えは、ふつうの変化として `sources_updated` に出る。なつみは、閉じるか、聞き返すか、まだ置いておくかを判断する。
  - 催促には印を付けない。ADR 0053 の待ちに乗る。
  - awake hours の外では催促しない（書き換えない）。朝の最初の催促にまとまる。
  - 聞き返しの間（`input-required`）は催促しない。
- 期限を過ぎた Task は、サーバーが `failed` にする（期限までに返事が無かった）。`status.md` にそう書き、送り手には失敗の理由として返す。
  - 期限は、送り手のメッセージが最後に届いた時刻から数える。聞き返しの間も数える。送り手が答えないまま開いた Task が上限を埋め続けないためである。
- 間隔と期限は config で決める。既定は、催促の間隔 3 時間、期限 24 時間である。

### 上限: 送り手ごとの開いた Task の数と、本文の大きさ

- 送り手ごとに、開いている Task（`working` と `input-required`）の数に上限を置く。既定は 3 である。
  - 上限を超える新しい依頼は、すぐ `rejected` にして返す。`/sources` には置かず、なつみを起こさない。ダッシュボードには残す。
- 1 つのメッセージの本文は 1 MiB までとする。超えたものは断る。
- 頻度の上限は持たない。開いた Task の数の上限と、なつみが閉じるまで次が開かないことで、キューが埋まることは止まる。

### 送り手は config で宣言し、送り手ごとに gated の subject か bearer token で確かめる

- 送り手は config で宣言する。各送り手は、名前と、確かめ方のどちらか 1 つを持つ。
  - `gatedSubject`: gated の assertion の `sub`（`system:serviceaccount:<名前空間>:<名前>` など）。
    サーバーは assertion を検証し（署名、発行元、宛先のホスト、時刻）、`sub` が一致する送り手として受け付ける。
    検証は `yuanying/fraction-agents` の検証と同じ手順をなつみのコードに持ち込む。そのリポジトリのコードには依存しない（ADR 0025）。
    発行元と鍵の場所は config で書き、assertion からは取らない。
  - `tokenFile`: 送り手ごとの bearer token のファイル（ADR 0086 と同じ）。token は config に書かず、起動時に読む。
    照らし方は ADR 0086 と同じく、時間に依らない比べ方で、長さの違いも漏らさない。
- 両方の確かめ方を最初の版から作る。gated のある環境と無い環境の両方で、同じ受け口を使える。
- 名前を知らない送り手、合わない token、検証できない assertion は、同じ 401 で断る。どれが外れたかを返さない。
- 送り手の名前は、確かめた結果だけから決める。メッセージの自己申告は使わない（ADR 0025）。
- ブラウザのログインの cookie では通さない。
- 送り手が 1 つも宣言されていなければ、受け口は閉じる。Agent Card も含め、`/a2a/` の下はほかの知らない道と同じ 404 にする。

退けた案:

- **TokenReview で ServiceAccount の token を確かめる**（ADR 0025 の認証の節）: なつみの ServiceAccount に TokenReview の権限が要る。ADR 0033 は権限を与えない。
  gated のある環境では、gated が確かめた結果を assertion で受け取れば足りる。
- **gated の assertion だけにする**: gated の無い環境で受け口を使えない。
- **bearer token だけにする**: gated のある環境で、送り手ごとに token を配って入れ替える手間が残る。gated の後ろの係を呼ぶのと同じ ServiceAccount の token が使えない。

### 信頼: 送り手は全員、名前付きの第三者

- なつみは、送り手を全員 **名前付きの第三者** として扱う。Claude や Pi も、本人の代理として扱わない（ADR 0025 の「なつみの受け口」のまま）。
  - 考える、返事をする、本人に知らせる、記憶に残すは、なつみの判断でよい。記憶に残すときは「誰々が言っていた」として残す。
  - これは更新元のマニュアルとツールの説明で求める。サーバーでは強制しない。
- 外に作用する行為は、ADR 0012 の強制のままとする。送り手の文に「本人が OK と言った」とあっても、同意の証拠はサーバーの承認記録だけである。

### 見せ方: ダッシュボードだけ

- ダッシュボード（[ADR 0049](0049-a-read-only-dashboard-in-the-browser.md)）に、届いた依頼の一覧を足す。送り手、状態、届いた時刻、最後に動いた時刻、催促の回数を並べる。`rejected` にした依頼も並べる。
- Mac と iPhone の会話には出さない。本人に伝えたいことは、なつみが本人向けのツールで伝える（ADR 0025 の「Mac に見せるか」のまま）。

### 公開: 同じホストの `/a2a` の下

- 受け口は、ブラウザと同じ待ち受けの `/a2a/` の下に置く。Agent Card も `/a2a/` の下（`/a2a/.well-known/agent-card.json`）に置く。
  送り手は、`/a2a/` をなつみの URL として扱えばよい。
- Agent Card の URL の欄には、config に書いた公開の URL を書く。この URL のホスト名は、gated の assertion の宛先と照らすのにも使う。
  Agent Card の名前と説明も config で書く。
- Agent Card は token なしで返す。`ask_agent` と `fraction-agents` のクライアントは、Agent Card を token なしで取る（ADR 0084）。
- 守り方は環境の側で選ぶ。勧めるのは、`/a2a` の道だけに別の Ingress を立て、それだけを gated で守る形である。
  `/` の下の Ingress は、今までどおり認証を掛けない（ADR 0033）。
  gated で守るときに Agent Card の道を未ログインにも開けるか、gated で守らずに bearer token だけで受けるかも、環境の側で決める。
- gated の assertion を検証するには、gated の鍵を取りに行く出口が要る。出口の許可は環境の設定に書く（[ADR 0034](0034-an-allow-list-for-the-way-out.md)）。

### 頼む側: 係ごとに token のファイルを指せるようにする

- `ask_agent` は今、`a2a.tokenFile` の 1 つの token をすべての係に送る。gated の無い環境のなつみが、bearer token で守ったほかのなつみに頼むには、相手ごとの token が要る。
- 設定の `a2a.agents.<名前>` に、任意の `tokenFile` を足す。書いた係にはその token を送り、書かなければ `a2a.tokenFile` を送る。
  すべての係が自分の token を持つなら、`a2a.tokenFile` は省ける。
- token を送る先は、今までどおり、その係の URL と同じ origin だけである（ADR 0025・0036・0048）。
- これで、1 つのなつみの `a2a.agents` に、gated 経由の係と bearer token で守った相手を混ぜられる。

### config

- 最上位に受け口の設定を足す。書かなければ受け口を持たない（404）。正確な名前と細かい既定は実装の PR で決める。
  - 公開の URL、Agent Card の名前と説明
  - 送り手の並び。各送り手は名前（英小文字・数字・`-` で 32 文字まで）と、`gatedSubject` か `tokenFile` のどちらか 1 つ
  - gated の assertion の発行元と鍵の場所（`gatedSubject` の送り手が居るときに必須）
  - 催促の間隔（既定 3 時間）、期限（既定 24 時間）、送り手ごとの開いた Task の上限（既定 3）
- `a2a.agents.<名前>.tokenFile` を足す（前の節）。

### マニュアル

- 更新元 `inbox` のマニュアルを 1 枚足す。ディレクトリの形、印の種類の意味、送り手を名前付きの第三者として扱うこと、
  `reply_to_agent` の使い方（閉じる・聞き返す・宛先の書き方）、催促と期限を書く。
- system prompt と出来事の種類は変えない。ツールの定義に `reply_to_agent` が 1 つ増える。

### 進め方

1. この ADR。
2. natsumi: 受け口（Agent Card・SendMessage・GetTask）、送り手の確かめ方の 2 つ、Task の表、更新元 `inbox`、`reply_to_agent`、催促と期限、上限、ダッシュボードの一覧、`a2a.agents.<名前>.tokenFile`、マニュアル。
3. 環境の設定（private のリポジトリ）: `/a2a` の Ingress と守り方、送り手と相手の config、token の秘密、出口の許可。
4. `yuanying/fraction-agents`: 本人の Claude と Pi が使うスキルに、なつみたちを相手として足す。

### 実装で確かめること

- gated で、同じホストの `/a2a` の Ingress が、`/` の Ingress より優先されるか。
- `completed` で本文の無い返事を、`ask_agent` の取り込み（ADR 0069）と `fraction-agents` のクライアントがどう見せるか。

### 実装で決めたこと

ADR では決めず、実装の PR で決めたものは次のとおりである。

- **config**: 最上位の `inbox` にした。`publicUrl`（パスは `/a2a/` に限る）、`card.name`・`card.description`、`senders`（各送り手は `name` と、`gatedSubject` か `tokenFile` のどちらか 1 つ）、
  `gated.issuer`・`gated.jwksUrl`（`gatedSubject` の送り手が居るときに必須）、`reminderIntervalHours`（既定 3）、`deadlineHours`（既定 24）、`maxOpenTasksPerSender`（既定 3）。
  欄の形は `alertmanager.senders` に揃えた。`tokenFile` は起動時に読み、読めなければ設定の名前だけを示して起動を止める。`config.example.json` には載せない（ADR 0086 と同じ理由）。
- **なつみの書き手の名前**: `NN-me.md` の `me` にした。送り手の名前に `me` は使えない。ほかのなつみが送り手になると、送り手の名前がなつみ自身の名前と重なり得るためである。
- **ディレクトリの中身**: `README.md`（送り手、届いた時刻、状態、期限、前の依頼、返すときの宛先、メッセージの一覧）、`NN-<送り手>.md`・`NN-me.md`（番号は 2 桁から）、`status.md`（状態、最後に届いた時刻、開いてからの時間、催促の回数と最後の時刻、失敗の理由）。
  新しい依頼のディレクトリは、隣の `.tmp` で書いてから移す（ADR 0069 と同じ）。
- **印の欄**: `kind` は新しい依頼が `agent_request`、聞き返しへの答えが `agent_answer`。`file` は届いたメッセージのファイル、`details` は `from`（送り手）・`task`（`<送り手>/<ディレクトリ>`）・`text`（先頭の行、80 字まで）。
- **context**: なつみが採番する。送り手が自分に渡されていない context を送れば断る。`a2a-cli` と fraction-agents の係と同じ扱いである。
- **Task の形**: `completed` の返事の本文は、名前 `response` の artifact の文章にした（fraction-agents の係と同じ）。本文の無い `completed` には artifact が無い。
  聞き返しは `status.message`、`failed` と `rejected` の理由も `status.message` に置く。`history` は届いたメッセージとなつみの返事のすべてで、`historyLength` を渡されればその分だけにする。
- **断り方**: 知らない Task は `TaskNotFound`、聞き返しの間でない開いた Task と閉じた Task への送り直しは `UnsupportedOperation`、
  知らない context・空の本文・1 MiB を超える本文は `InvalidRequest`、TextPart 以外を含むメッセージは `ContentTypeNotSupported`、ストリーミング・CancelTask・push 通知の呼び出しは `UnsupportedOperation` か `PushNotificationNotSupported` にした。
  呼び出しの body は 2 MiB まで読み、超えれば 413 にする（本文の 1 MiB は、JSON の書き方に依らず入るように）。401 の本文は、どの外れ方でも `{"error": "unauthorized"}` である。
- **確かめ方の順**: gated が設定されていて、呼び出しに `Gated-Assertion` があれば、assertion だけで決める（gated は token を落として assertion に置き換えるため）。無ければ bearer token で決める。
  assertion の検証は fraction-agents の `gated-assertion.ts` を移した（鍵は最長 5 分持ち、知らない鍵の ID は 1 分に 1 度まで取り直す）。`sub` が宣言に無いものも 401 にする。
- **催促と期限の数え方**: 1 分ごとに見る。催促は、待ち始めた時刻（届いた時刻か、聞き返しに答えが届いた時刻）か最後の催促から間隔が過ぎた `working` の Task だけ。期限は awake hours に関わらず見る。
- **書く順**: ファイルを書いてから、Task とメッセージ（migration 35 の `inbox_tasks`・`inbox_messages`）と印を 1 つのトランザクションで記録する。記録できなければ、書いたファイルを消す。
- **ツールの並び**: `reply_to_agent` は、すべてのツールの最後（`read`・`search_memory` の後）に置いた。前の定義はプレフィックスの上で動かない。ターンを畳むときも、外へ出した言葉として残す（ADR 0047 の `KEPT_TOOLS`）。
- **ダッシュボード**: 「失敗と待ち」のページに「外のエージェントからの依頼」の表を足した。開いている Task を先に、最後に動いた順で 20 件まで並べる。

### 実装で確かめた結果

- gated の、同じホストの `/a2a` と `/` の Ingress: gated はホストごとに Ingress をまたいで規則を 1 つの表にまとめ、`Exact` の次に長い前方一致から照らす（gated の `internal/routing/table.go`）。`/a2a` の Ingress が `/` より優先される。
- gated で守った Ingress の下で Agent Card の道だけを未ログインに開けること: NetworkRole はパスとメソッドで許し、判定は許可の和である（gated ADR 0002、`internal/authz`）。
  `GET /a2a/.well-known/agent-card.json` だけの NetworkRole を `system:unauthenticated` に束ね、`/a2a*` のすべてのメソッドの NetworkRole を送り手の ServiceAccount に束ねればよい。
- 本文の無い `completed`: `ask_agent` の取り込みでは、`README.md` の要約が「返事に文章はありませんでした。」になり、節は無く、`agent_reply` の印で届く。
  a2a-cli（v0.2.0）では `Status: completed` だけが出て、`Artifacts:` は出ない。

### 置き換える既存の決定

- ADR 0025
  - 置き換え:「なつみの受け口」の節の、届いたメッセージを出来事 `agent_message` としてキューに入れる形。`/sources/inbox` に置き、`sources_updated` で知らせる。
  - 置き換え:「認証」の節の、なつみの受け口を TokenReview で確かめる形。送り手ごとに gated の assertion か bearer token で確かめる。
  - 決定: 受け口の上限（送り手ごとの開いた Task の数と本文の大きさ。頻度の上限は持たない）と、受け口の公開先（同じホストの `/a2a/` の下）。
  - 残す: 送り手を名前付きの第三者として扱うこと、外に作用する行為は ADR 0012 の強制のままであること、Mac の会話に入れないこと。
- ADR 0069
  - 適用:「外から届くものは、可能な限り `sources_updated` に寄せる」の 3 つ目の適用である。新しい出来事の種類は作らない。
- ADR 0050
  - 追加: 更新元 `inbox`（深さ 1）と、その印の種類。
- ADR 0033
  - 追加: Ingress の後ろの待ち受けに、gated の assertion か bearer token で守る A2A の受け口が増える。`/` の Ingress では今までどおり認証を掛けない。
- ADR 0084
  - 置き換え: Consequences の「1 つのなつみの `a2a.agents` には、gated 経由の係と Service を直接呼ぶ係を混ぜられない」。係ごとに `tokenFile` を指せる。

## Consequences

- 本人の Claude と Pi、ほかのなつみが、なつみに頼めるようになる。返事は送り手が取りに来る。なつみが寝ている間に届いた依頼の返事は、印が付いていても、なつみが起きて答えるまで遅れ得る。
- 届いた依頼は、本人以外の文が思考ループに入る入口が 1 つ増えることである。名前付きの第三者として扱うことはモデルに頼るので、
  送り手の言葉を本人の意向と取り違えることは起こり得る。外に作用する行為は ADR 0012 の強制で止まるが、記憶や本人への知らせには混ざり得る。
- 開いた Task は、なつみが閉じるか期限が来るまで残る。催促は 3 時間ごとに文脈を少し使う。期限を過ぎた Task は、送り手には失敗として見える。
- なつみ同士で頼み合うと、互いの開いた Task が上限まで積み上がり得る。止めるのは、送り手ごとの上限と期限である。
- 送り手を足すには config の書き換えと再起動が要る。bearer token の入れ替えも、送り手の側となつみの側の両方を直して再起動する（ADR 0086 と同じ）。
- gated の assertion の検証で、なつみが gated の鍵を取りに行く出口が 1 つ増える。鍵を取れなければ、`gatedSubject` の送り手は受け付けられない。
- Task の記録が SQLite に、依頼のディレクトリが `/sources/inbox` に増える。最初の版では消さない。消すようになるときは、ADR 0086 と同じく、黙って取り込む形と合わせて決める。
