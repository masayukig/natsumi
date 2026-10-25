# F07. fork: Signal のグループにポッポさんが投稿する

- Date: 2026-10-25
- Status: Accepted（この fork だけの決定）

## Context

[ADR F06](F06-fork-listening-in-signal-groups.md) で、本人が参加を認めた Signal のグループの発言を natsumi が読めるようになった（第 1 段）。
第 2 段として、Slack と同じく、natsumi がそのグループに投稿し、リアクションを付けられるようにする。

Slack への投稿は、ポッポさん（`SlackDove`、[ADR 0040](0040-the-dove-sends-what-the-judge-passes.md)・[ADR 0074](0074-asking-poppo-in-json-and-hearing-back-in-sources.md)）だけが行う。
下書きを判定にかけ、そのまま送る・本人に回す・突き返すを決め、本人の承認は端末と、この fork では Slack の DM（F02）と Signal の 1 対 1（F04）でできる。
ただし、ポッポさんは `slack` の設定があるときだけいた。Signal だけのインスタンス（iori-private）には Slack が無い。

## Decision

- **ポッポさんに、行き先として Signal のグループを足す。** 別のポッポさんは作らない。判定・突き返しの回数・本人への承認・期限・結果の書き出しと知らせ（`dove_posts`・`approvals`・`dove_results`）は、そのまま使う。
  - 投稿の `workspace` を、Slack のワークスペースには付けられない名前 `#signal` にし、`channel_id` にグループ ID、`target_ts` に返す発言の Signal の時刻を入れる。表は変えない。
  - Slack に固有のところ（行き先の照合、判定に見せる流れ、送る・リアクション、自分の投稿の行）だけ、`#signal` の投稿を `DoveSignalGroups`（`SignalGroups` が実装する）に渡す。
  - `slack` が無くても `signal` があればポッポさんはいる。設定の値（承認の期限・判定に見せる件数・画像の上限）は Slack の既定値を使い、判定は `signal.judge`（`slack.judge` と同じ書き方、省けば pi の互換モデルを借りる）。
    `slack` があれば `slack.judge` を使い、`signal.judge` も書いてあれば起動時に弾く（黙って無視しない）。
- **頼み方は Slack と同じ JSON**（ADR 0074）。`to.file` が `/sources/signal/` で始まれば Signal のグループ。
  - 発言に返す: `{"file": "/sources/signal/<ディレクトリ>/<日付>.jsonl", "path": ".[N]"}`。グループそのもの: `{"file": "/sources/signal/<ディレクトリ>"}`。
  - 承認されたグループ（設定のものか、本人が 1 対 1 で認めたもの）でなければ、その場で断る。待ち・断ったグループも同じ。
  - 判定には、チャンネル名として `Signal のグループ『<グループ名>』`、返す発言、グループの最新の発言（`judgeContext.messages` 件）、下書きを見せる。スレッドは無いので、置き場所（placement）は聞かず、いつも `channel`。
- **返事は引用として送る。** Signal にはスレッドが無い。JSON-RPC `send` に `groupId`・`quoteTimestamp`・`quoteAuthor`・`quoteMessage` を付ける。
  そのため、記録した行ごとの Signal の時刻と送り主（番号か UUID）を、fork だけの表 `fork_signal_lines` にサーバー側だけで持つ。natsumi が読むファイルには書かない（[ADR 0024](0024-no-event-ids-for-the-model.md)）。
  投稿の `target_ts` には `<Signal の時刻>:<送り主>` を入れる（同じミリ秒に 2 人が送っても取り違えない）。
  この表は F07 の版から書き始めるので、それより前に記録した行には返事もリアクションもできず（その場で断る）、判定に見せる流れも F07 以降の行だけから始まる。
- **リアクション**は `sendReaction`（`groupId`・`emoji`・`targetAuthor`・`targetTimestamp`）。Slack と同じく判定も本人も通さない。絵文字は Unicode の絵文字 1 つ（書記素 1 つで絵文字の性質を持つもの、キーキャップ 1️⃣ も）だけで、Slack の名前は断る。
- **送れなかったときの言い分けと時間切れ**: JSON-RPC は 30 秒で打ち切る（固まった daemon がポッポさんの列を、Slack の投稿ごと止めないように）。
  daemon が断った（`rpc error`・4xx・全員に `SUCCESS` 以外）は「Signal に断られた」。時間切れ・5xx・読めない応答・送信後に時刻が無いは、届いたかどうか分からないので、
  サーバーが途中で止まったとき（`interrupted`）と同じく「届いたかどうか分からない。グループで確かめてから、送り直すか決めて」と伝え、送り直さない。
  ログには fork の決まった短い言葉（`send UNREGISTERED_FAILURE`・`rpc error -1`・`timed out` など）だけを出し、番号や ID は出さない。
  端末に見せる理由（`delivery_reason`）は、端末が知っている 3 つ（docs/client-contract.md）に合わせて `slack-error` のまま記録し、本人への Signal の 1 行だけ「Signal に断られたか、届いたか分からない」と言い換える。
- **画像**は Slack と同じく `/work` から写し取り、data URI の添付で送る（F04 の返事の画像と同じ）。
- 送る直前の検査（`checkOutgoingText`）は Slack と同じ。送れた投稿は、グループの記録に natsumi の行（`from` は natsumi の名前、`mine: true`、引用なら `quote`）として書き、`fork_signal_lines` にも入れる。
  次の判定と、natsumi の発言の引用の検出（`quote.authorNumber` が natsumi の番号）に使う。
- **本人への承認**は、既存の `SignalApprovals`（👍・👎・❌、引用の「送る」「見送る」）。文面の投稿先が `Signal のグループ『<名前>』` になるので、Slack と取り違えない。端末と、Slack の本人の DM（F02）にも同じものが出る。
- **メンションの無い発言にも気づく**（本人の判断）。F06 の `mention`・`quote-reply` に、承認したグループだけ次の 3 つを足す。どれも natsumi が加わるかどうかを決めるためのもので、マニュアルに「役に立つときか、暗に向けられたときだけ、短く。それ以外は返さない。リアクションだけでもよい」と書いた。
  - `name`: メンションは無いが、本文に natsumi の名前（アバターの名前と、設定 `signal.names` に書いた名前。ひらがな・カタカナはどちらでも、英字は大文字小文字を問わない）がある発言。
    Slack では名前だけの言及は数えない（[ADR 0039](0039-slack-as-files-and-a-scored-dove.md)）が、Signal のグループは身内の小さな場なので、本人が数えることにした。
  - `follow-up`: natsumi がそのグループに投稿してから 10 分以内の、ほかの人の発言（Slack のスレッドの `thread-reply` にあたる。スレッドが無いので時間で見る）。
  - `conversation`: どれにも当たらない発言が続き、2 分発言が無くなったら、最新の行を指して 1 度だけ。同じグループに 15 分以内にほかの attention（どの種類でも）があれば出さず、マスターの起きている時間（awakeHours）の外も出さない（朝に回さず捨てる）。
    場の雰囲気を読んで加わってほしい、という本人の希望による。待ち時間はサーバーのメモリだけに持ち、再起動で消える（失ってよい）。
  - 種類の優先は `mention` > `quote-reply` > `name` > `follow-up`。
- **既読**: 承認したグループの発言を記録したら、送り主に既読（`sendReceipt`、`type: read`）を返す（F04 の本人への既読と同じ）。待ち・断ったグループには返さない。失敗はログに出すだけ。
- 外のエージェントの一覧（`/manual/agents/INDEX.md`）のポッポさんに、Signal のグループにも投稿できることを 1 行足す。
- 第 1 段の小さな直し: グループの一覧が取れなくなったら 1 度、また取れるようになったら 1 度ログに出す。

退けた案:

- **Signal のグループ用に別のポッポさんを作る**: 判定・承認・期限・結果の知らせを二重に持つことになる。行き先の違いは数か所に閉じ込められた。
- **行き先を抽象化して Slack 側も作り直す**: upstream のコードを大きく動かすと、upstream との同期のたびにぶつかる。Slack の動きは変えず、`#signal` の分岐だけを足した。
- **見出し付きの書き方で頼む**: ADR 0074 で JSON に変わっている。Slack と同じ書き方にした。

## Consequences

- natsumi は、参加したグループに Slack と同じ手順で投稿・リアクションでき、判定と本人の承認も Slack と同じように効く。
- 判定の問いは Slack 向けの文のまま（「Slack に出してはいけない私的なこと」など）。Signal のグループでも同じ考えで見られる。
- 端末の承認の画面は種類が `slack-post` のまま（投稿先の名前に Signal のグループと出る）。置き場所の選択は Signal では使わない。
- 結果の行の `slack_file`・`slack_path` は、Signal の記録の行を指すときもその名前のまま（マニュアルに書いた）。
- `face`（表情）は Signal では使わない。メンションを付けて投稿することはできない。
- 確かめていないこと: JSON-RPC の `send` の `groupId`・`quoteTimestamp`・`quoteAuthor`・`quoteMessage`、`sendReaction` の `groupId`・`targetAuthor`・`targetTimestamp` の名前と、
  グループへの `send` の応答（`results` がメンバーごとに来る前提で、全員に失敗したときだけ失敗にした）。`quoteAuthor` に番号が無く UUID だけの送り主のとき、UUID で通るか。
