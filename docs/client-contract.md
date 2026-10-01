# サーバーとクライアント（Mac・iPhone・ブラウザ）の契約 v1

これは後続実装の契約であり、このリポジトリの検証ハーネスが公開 API を提供するわけではない。
日時は UTC の RFC 3339、ID は内容を含まない opaque string とする。
Calendar の予定表現では UTC 時刻に加えて元の IANA timezone を保持する。
未知の protocol version は接続を拒否し、未知のイベント type は無視する。

## 接続と envelope

HTTPS の GitHub OAuth callback 後、セッションで WSS に接続する。
セッション失効・本人以外のアカウントは接続と全コマンドを拒否する。
Mac の `deviceId` はサーバー登録の ID であり、認証を代替しない。
方式の理由は [ADR 0006](adr/0006-github-login-and-transport.md) にある。
ブラウザも同じ約束事を話すもう 1 台の端末で、ログインと接続だけが違う（下記「ブラウザ」、[ADR 0058](adr/0058-settings-and-chat-in-the-browser.md)）。

### ログインとセッション

Mac は `ASWebAuthenticationSession` を callback scheme `natsumi` で使う。

1. Mac が PKCE の verifier（43〜128 文字）と、アプリの state を生成する。
2. `GET /auth/github/start?code_challenge=<S256>&code_challenge_method=S256&state=<アプリの state>` を開く。
   サーバーは GitHub の認可画面へ redirect する。
3. 認可が済むと、サーバーは `natsumi://oauth/callback?code=<login code>&state=<アプリの state>` に redirect する。
   失敗の場合は `code` の代わりに `error` が付く。Mac は state が自分の生成したものと一致することを確かめる。
4. `POST /auth/session` に JSON で `code` と `codeVerifier` を送る。成功すると `token` と `expiresAt` が返る。
   login code は 60 秒で期限が切れ、1 回しか使えない（verifier が誤っていた場合も使えなくなる）。
5. 以後の HTTPS 要求と WSS の upgrade には `Authorization: Bearer <token>` を付ける。
   トークンは Keychain に保存する。期限が切れたら 1 からやり直す。期限は最後に使ってから 30 日で、使うたびに延びる（下記「セッションの延長」）。
6. `POST /auth/logout`（Bearer 付き）でセッションを失効させる。成功すると 204 が返り、そのセッションの WSS は閉じられる。

| 経路 | 失敗時 | エラーコード |
| --- | --- | --- |
| `/auth/github/start` | 400 | `invalid-request`（challenge・method・state の不備）、429 `too-many-logins` |
| `natsumi://oauth/callback` の `error` | — | `login-expired`、`github-denied`、`github-exchange-failed`、`github-unavailable`、`account-not-allowed`、`invalid-request` |
| `/auth/github/callback` | 400 | `invalid-state`（state がない・一致しない・使用済み。アプリには戻らない） |
| `/auth/session` | 400 | `invalid-request`（形式の不備）、`invalid-grant`（未知・使用済み・期限切れ・verifier の不一致） |
| `/auth/logout` | 401 | `unauthorized` |

エラー応答は `{"error": "<コード>"}` だけで、上流の本文や秘密を含まない。

### セッションの延長

セッションは、最後に使ってから 30 日で切れる。理由は [ADR 0030](adr/0030-a-session-that-lasts-while-it-is-used.md) にある。

- WSS の接続が認証を通ったとき、および接続が開いている間、サーバーはセッションを延ばす。期限は「その時刻から 30 日後」になる。
  書き込みは 1 時間に 1 回までなので、期限は最大で 1 時間ぶん手前に見えることがある。
- 延びた期限は、`session.sync` への答え（`session.snapshot`・再送の `command.accepted`・`service.unavailable`）の `sessionExpiresAt` と、
  接続中に期限が動いたときの `session.renewed`（`expiresAt`）で届く。
- クライアントは、これらの値が手元の期限より後のときだけ、保存した期限を置き換える。延長は期限を後ろにしか動かさないので、
  再送で古い値が届いても手元の期限は戻らない。
- `session.renewed` は `conversation.thinking` と同じく、その場限りで採番しない（下記「考えている 1 行」）。
  同期の前にも届き得る。知らないクライアントは捨ててよい。その場合も、30 日で再ログインするだけで壊れない。
- ログアウトは今までどおり即時に効く。期限を過ぎたセッションは延ばせず、その接続は close code 1008 で閉じられる。

### WSS への接続

`wss://<publicOrigin のホスト>/v1/ws` に Bearer 付きで upgrade する。
セッションがない・失効・期限切れ・本人以外なら 401、Origin ヘッダーが `publicOrigin` と一致しなければ 403 を返し、接続を確立しない。
ネイティブクライアントは Origin を省略してよい。
Bearer が無いときだけ、ブラウザのログインの cookie を見る。cookie は Origin が `publicOrigin` のときだけ受け付け、Origin が無い・違えば 403（`origin-not-allowed`）を返す（下記「ブラウザ」）。

クライアントのメッセージは 1 件ごとに `v` を検証する。`v` が 1 でなければ `command.rejected`（`unsupported-version`）を送り、
close code 1002 で閉じる。JSON のオブジェクトでなければ `invalid-envelope` を送り、1007 で閉じる。1 メッセージは 64 KiB までとする。
未知の `type` は無視する。セッションの失効・期限切れでは close code 1008 で閉じる（command を受けるたびと、定期的に期限を確かめる）。
下表のうち `session.sync`・`conversation.send`・`conversation.read`・`notification.ack`・`push.register`・`approval.decide`・`model.list`・`model.use`・`settings.list`・`settings.set`・`settings.reset` は実装済みで、それ以外の command は
`command.rejected`（`not-implemented`）を返す。`session.sync` の前の応答は、その接続だけの一時的な stream で採番する。
会話の扱いの理由は [ADR 0008](adr/0008-single-thinking-loop-and-mac-conversation.md)、
既読と知らせの確認の理由は [ADR 0013](adr/0013-read-state-on-the-server.md) にある。

```json
{"v":1,"requestId":"request-example","deviceId":"device-example","type":"conversation.send","payload":{"text":"架空のメッセージ"}}
```

サーバーイベントはプロセス起動ごとの `epoch`、登録端末ごとの `streamId`、
その stream 内で単調増加する `seq` を持つ。stream は同一 epoch 中の端末再接続をまたいで維持する。
全端末向けイベントにも各 stream で個別に採番し、端末限定イベントはその stream だけで採番する。
他端末への配信で自端末の seq は進まない。通知先の決定に使うサーバー操作順序は別の内部カウンターとする。
例外は `conversation.thinking` と `session.renewed` で、これらは採番せず、その stream がいま出している seq をそのまま付けて送る
（下記「考えている 1 行」、上記「セッションの延長」）。
同じ deviceId から二重接続した場合は、新接続が旧接続を置き換える。
`requestId` は応答の相関に使い、購読者全体へのイベントでは省略できる。
内部のファイルパス、認証情報、Pi の session ファイル参照、任意の Pi SDK 呼び出しをクライアントに転送しない。

```json
{"v":1,"epoch":"epoch-example","streamId":"stream-example","seq":42,"type":"conversation.message","payload":{"messageId":"message-example","role":"natsumi","kind":"reply","text":"こんにちは","replyTo":"event-example","expression":"happy","createdAt":"2026-01-01T00:00:00.000Z"}}
```

`messageId` と `eventId` は natsumi が採番する ID である。Pi の session ID・entry ID・ツールの呼び出し（引数も結果も）はクライアントに渡さない。
思考は、**いま書かれている 1 行だけ**を `conversation.thinking` で流す（[ADR 0017](adr/0017-streaming-the-line-she-is-thinking.md)）。
思考の全文と、その記録は渡さない。返事の途中の文字列は流れない。

| クライアント command | payload | サーバーの結果 |
| --- | --- | --- |
| `session.sync` | `resume`: 前回の epoch/streamId/seq または null | 下記「端末の登録と stream」 |
| `conversation.send` | text（32 KiB まで、空白だけは不可）、requestId | `command.accepted`（messageId、eventId、state）、または request-conflict / invalid-request / `service.unavailable` |
| `conversation.read` | throughMessageId（会話の messageId） | `command.accepted`（readThroughMessageId、unreadReplyCount。手前の位置なら今の位置）、または invalid-request / `service.unavailable`。下記「既読と知らせの確認」 |
| `conversation.interrupt` | — | 受け付けない（`not-implemented`）。進行中の思考は外から止めない |
| `approval.decide` | approvalId、revision（整数）、decision（approve / edit / reject）。edit は text（32 KiB まで、空白だけは不可）。approve と edit は任意で placement（thread / channel / broadcast） | `command.accepted`（approvalId、revision、state）。既に閉じた承認には閉じたときの state。revision が違えば `stale-revision`、形の不備や知らない approvalId は invalid-request。下記「承認と外部実行」 |
| `notification.ack` | notificationId（知らせの messageId） | `command.accepted`（notificationId、acknowledgedAt。2 回目以降も最初の時刻）、または invalid-request / `service.unavailable` |
| `device.activity` | 明示操作の kind のみ | サーバー受理順で通知先更新。画面内容は含めない（未実装） |
| `push.register` | token、publicKey、environment（ブラウザは subscription） | `command.accepted`（environment。ブラウザは中身なし）、または invalid-request。下記「iPhone への通知」「ブラウザへの通知」 |
| `model.list` | — | `command.accepted`（`modelRoutes` と同じ形: defaultRoute、current、chosen、routes）、または `service.unavailable`。下記「モデルの経路」 |
| `model.use` | route（経路の名前） | `command.accepted`（chosen、current）、または unknown-route / route-unavailable / invalid-request / `service.unavailable`。下記「モデルの経路」 |
| `settings.list` | — | `command.accepted`（settings: 設定の一覧）、または `service.unavailable`。下記「実行中の設定」 |
| `settings.set` | key（設定の名前）、value（値） | `command.accepted`（settings: 変えた後の一覧）、または unknown-setting / invalid-value / unknown-route / route-unavailable / judge-unavailable / invalid-request / `service.unavailable`。下記「実行中の設定」 |
| `settings.reset` | key（設定の名前） | `command.accepted`（settings: 戻した後の一覧）、または unknown-setting / invalid-request / `service.unavailable`。下記「実行中の設定」 |

| サーバー event | 内容 |
| --- | --- |
| `session.snapshot` | deviceId、`messages`（本人に見せる会話。古い順で直近 500 件）、`pendingEvents`（処理を待つ・処理中の本人のメッセージ: eventId、messageId、state）、`avatar`（expression）、`readThroughMessageId`（既読カーソル。無ければ null）、`unreadReplyCount`（未読の返事の数。500 件の外も数える）、`unacknowledgedNotificationIds`（未確認の知らせの messageId をすべて古い順に。500 件の外も含む）、`pendingApprovals`（承認待ちの承認をすべて古い順に。Slack の設定が無ければ空）、`modelRoutes`（モデルの経路。下記「モデルの経路」）、`sessionExpiresAt`（接続で延びたセッションの期限。上記「セッションの延長」）、`avatarVersion`（アバターの版。下記「アバター」）、`settings`（実行中の設定の一覧。下記「実行中の設定」）。envelope の seq が snapshot の sequence |
| `conversation.read` | readThroughMessageId、unreadReplyCount。カーソルが進んだときだけ全端末に届く |
| `notification.acked` | notificationId、acknowledgedAt。知らせを初めて確認したときだけ全端末に届く |
| `conversation.message` | messageId、role（owner / natsumi）、kind（message / reply / notice）、text（全文）、createdAt。message は eventId、reply は本人のメッセージに答えたものなら replyTo（答えたメッセージのうち最も新しいもののイベント）、notice は関係するイベントがあれば about。本人のメッセージに答えていない reply（続けて話したセリフや、自分から話しかけたセリフ）には replyTo が無い（ADR 0032）。reply と notice は、natsumi がそのセリフに込めた気持ち expression（`avatar.expression` と同じ候補）を持つ。本人のメッセージと、気持ちを記録する前のセリフには欄が無い（null ではなく省く）。欄が無いこと、知らない値は「不明」と読む。セリフの気持ちはアバターの表情とは別で、`avatar.expression` は届かない（ADR 0026）。reply は、natsumi が画像を添えたときだけ images（画像の一覧。下記「会話の画像」）を持つ。画像の無い行には欄が無い（空の配列も送らない） |
| `avatar.expression` | expression（neutral / happy / laughing / surprised / thinking / worried / sad / sleepy） |
| `conversation.thinking` | line（natsumi がいま書いている思考の 1 行。120 文字まで。空文字は思考が終わったこと）。その場限りで、採番せず、再送もせず、記録もしない。下記「考えている 1 行」 |
| `conversation.event.completed` | eventId、messageId、status（replied / no-reply / failed）。failed には reason（model-call-limit / timeout / model-error / stopped） |
| `approval.pending` | 新しい承認待ち（承認の全体）。全端末に届く。下記「承認と外部実行」 |
| `approval.resolved` | approvalId、revision、state（approved / edited / rejected / expired）、resolvedAt。送ったときは delivery（sent / failed）、sent なら sentText、failed なら reason（mechanical-check / slack-error / target-gone）。全端末に届く |
| `notification.batch` | 未実装で、送られない。知らせは `conversation.message`（kind: notice）で届く。下記「通知と定期処理」 |
| `model.routes` | `modelRoutes` と同じ形。使っている経路・選ばれた経路・経路の一覧・使える状態かのどれかが変わったときに全端末に届く。下記「モデルの経路」 |
| `settings.changed` | settings（実行中の設定の一覧の全体）。一覧のどれかが変わったときに全端末に届く。下記「実行中の設定」 |
| `session.renewed` | expiresAt（延びたセッションの期限）。接続中に期限が動いたときだけ、その接続に届く。その場限りで、採番せず、再送もしない。上記「セッションの延長」 |
| `command.accepted` | command ごとの結果（`conversation.send` は messageId・eventId・state、`session.sync` の再送は deviceId・mode: resume・sessionExpiresAt） |
| `command.rejected` / `service.unavailable` | 安全なエラーコード。上流の生エラー本文は転送しない。`service.unavailable` の code は pi-unavailable / conversation-restore-failed / stopping。`session.sync` への答えのときは deviceId・sessionExpiresAt・avatarVersion も付く |

### 端末の登録と stream

1. 接続後、最初に `session.sync` を送る。envelope の `deviceId` には前回サーバーから受け取った ID を入れる（初回は省略）。
   サーバーは同じアカウントに発行済みの ID だけを使い続け、それ以外なら新しい ID を発行して応答の `deviceId` で返す。
   Mac はこの ID を保存し、以後の command の envelope に付ける。
2. `payload.resume` に前回最後に受け取ったイベントの epoch・streamId・seq を入れる。同じ epoch・streamId で、その seq より後が
   サーバーのバッファに残っていれば、欠けたイベントが元の seq のまま届き、続けて `command.accepted`（mode: resume）が届く。
3. それ以外の場合は `session.snapshot` が届く。Mac は表示をこの snapshot で置き換え、以後はこれより大きい seq のイベントを適用する。
4. 会話が使えない場合は `service.unavailable` が届く（deviceId と sessionExpiresAt も付く）。
5. 同期の前の端末の command（`conversation.send`・`conversation.read`・`notification.ack`・`push.register`・`approval.decide`・`model.list`・`model.use`・`settings.list`・`settings.set`・`settings.reset`）は `sync-required`、
   接続の端末と異なる `deviceId` の command は `device-mismatch` で拒否される。
6. 同じ端末で新しく接続すると古い接続は close code 4001 で閉じられる。受信が大きく遅れた接続は 4002 で閉じられるので、再接続して同期する。

イベントのバッファはサーバーのメモリにあり、既定では stream ごとに直近 256 件である。サーバーの再起動で epoch が変わる。

## 会話の記録と再同期

natsumi は一本の思考ループで、本人のメッセージを 1 件ずつイベントとして処理する（ADR 0008）。

1. `conversation.send` を受けると、サーバーは requestId・端末 ID・本文とイベントを SQLite に記録してから、送信した端末に `command.accepted` を返す。
   同じ requestId の再送には同じ messageId・eventId と現在の state（queued / processing / replied / no-reply / failed）を返し、
   本文か端末が違えば `request-conflict` で拒否する。処理中でも busy にはならず、次の境目で差し込まれるか順番を待つ。
2. 続けて全端末に、本人のメッセージの `conversation.message` と、`avatar.expression`（thinking）が届く。
3. 処理の間、natsumi が書いている思考の 1 行が `conversation.thinking` で届く（下記「考えている 1 行」）。
4. natsumi が返事を確定すると、全文の `conversation.message`（kind: reply）が一度だけ届く。1 つのメッセージに答える返事（replyTo がそのイベント）は最大 1 回である。
   natsumi はその後も続けて話すことがあり、本人のメッセージが無いときに自分から話しかけることもある。どちらも kind: reply で届き、replyTo を持たない（ADR 0032）。
   相談や知らせは kind: notice で届く。**返事の途中の文字列は流れない。**
   返事と知らせにはセリフの気持ち（expression）が付くが、それでアバターの表情は変わらない。
   返事には画像が添えられることがある（images。下記「会話の画像」）。画像も本文と同じ `conversation.message` の中で一度に届く。
5. 処理が終わると `conversation.event.completed` が届く。返事なしで終わることもある（no-reply）。
   表情が thinking のままなら（natsumi が自分で付けたものも含む）、ほかに待っているメッセージがなければ neutral の `avatar.expression` が続く。
6. thinking 以外の表情は、最後に変わってから一定の時間（サーバーの設定、既定 3 分）で neutral に戻り、そのときも `avatar.expression` が届く（ADR 0014）。

`session.snapshot` の `messages` は SQLite の記録から作る。natsumi の思考、内心、ツールの呼び出しは含まれない。
`messages` の各要素は `conversation.message` の payload と同じ形で、natsumi のセリフの expression と返事の images もそのまま載る。
サーバーを再起動しても同じ履歴が返る。再起動の前に処理中だったメッセージは二度処理せず、返事がなければ failed になる。

natsumi は毎晩決まった時刻に一日を振り返り、思考の記録を新しくする（ADR 0009）。Mac から見える変化は次のとおりである。

- 振り返りの間、`avatar.expression` は sleepy になる。
- その間に送ったメッセージも受け付けられ（state は queued）、全端末に表示される。表情は thinking にならない。
  返事は振り返りが終わってから届く。
- 振り返りそのものは会話に出ない。振り返りに対する `conversation.event.completed` も `conversation.thinking` も届かない。
- 終わると、待っているメッセージがあれば thinking、なければ neutral の `avatar.expression` が届く。
- 会話の履歴（snapshot）は、振り返りと記録の切り替えで変わらない。

ライブイベントは端末の stream ごとにメモリ内の有限バッファに保つ（`conversation.thinking` を除く）。
同一 epoch/streamId かつ必要な seq がその stream のバッファに残っていれば差分を再配信できる。
epoch/streamId が変わった、その stream の seq が抜けた、受信が遅くバッファを超えた場合は snapshot を要求する。
stream を破棄・再作成する場合は新しい streamId を発行し、同じ ID で seq をリセットしない。
snapshot はサーバーの一つの同期処理で作るので、その間にイベントは割り込まない。snapshot より大きい seq のイベントをその上に適用する。
Mac 再起動時はサーバーの snapshot を正とし、永続的な独自会話 DB は持たない。

## モデルの経路

natsumi の思考のモデルは、サーバーの設定に名前付きで並べた経路（例: 本人のエンドポイントの `local`、ChatGPT Plus の `plus`）の 1 つを使う。
本人が選んだ経路に、ターンの間で切り替わる。自動では切り替わらない（[ADR 0046](adr/0046-named-model-routes-switched-by-hand.md)）。
同じ経路はサーバーのコマンド（`model use`）でも選べるので、アプリの外で変わることもある。

`modelRoutes`（`session.snapshot` の欄、`model.list` の答え、`model.routes` の payload）は次の形である。

| 欄 | 内容 |
| --- | --- |
| `defaultRoute` | 既定の経路の名前 |
| `current` | いま使っている経路の名前。natsumi が話せない間は null |
| `chosen` | 本人が選んだ経路の名前（選んでいなければ既定）。`current` と違えば、次のターンの前にそちらへ移る。移れない（使える状態にない）間は違ったままである |
| `routes` | 経路の一覧（設定の順）。各要素は `name`（経路の名前）、`provider`・`model`（Pi のモデル。表示用）、`ready`（いま使える状態か。キーが読めない・ログインが無いと false） |

```json
{"defaultRoute":"local","current":"local","chosen":"plus","routes":[{"name":"local","provider":"natsumi-compatible","model":"example-model","ready":true},{"name":"plus","provider":"openai-codex","model":"gpt-5.5","ready":true}]}
```

- 接続先の URL・キー・ログインの情報は渡さない。
- `model.use`（payload `{"route":"plus"}`）は、選んだことを記録して `command.accepted`（`chosen` と、まだ移っていなければ前の経路の `current`）を返す。
  実際に移ったときに、全端末に `model.routes`（`current` が新しい経路）が届く。natsumi が何もしていなければすぐ、考えている途中ならそのターンが終わってから移る。
- 設定に無い名前は `unknown-route`、使える状態にない経路は `route-unavailable`、route が文字列でないか空なら `invalid-request` で拒否する。
  natsumi が話せない間は、`model.list` も `model.use` も `service.unavailable` を返す。
- すでに使っている経路を選び直しても受け付ける。何も変わらなければ `model.routes` は届かない。
- 切り替えても会話の履歴（snapshot の messages）は変わらない。思考の記録も同じ session のまま続く。
- 画面は、`current` を今の経路として示し、`chosen` が違うあいだは「次のターンから」と示すとよい。`ready` が false の経路は選べないように見せる。

## 実行中の設定

natsumi が動いている最中に変えられる設定を、端末から読み書きする（[ADR 0058](adr/0058-settings-and-chat-in-the-browser.md)）。
サーバーの設定ファイル（config）の値が既定で、端末から変えた値はその上書きとしてサーバーに残る。再起動やリリースでは戻らない。
上書きを消す（`settings.reset`）と config の値に戻る。サーバーのコマンド（`natsumi model use`・`natsumi fold on|off`）も同じ上書きを書く。

| key | 値 | 効く時 |
| --- | --- | --- |
| `modelRoute` | 経路の名前（文字列）。config にあり、使える状態のもの | 次のターンの前に移る（上記「モデルの経路」） |
| `turnFold` | `"on"` / `"off"` | 次のターンから |
| `eventModelCalls` | 出来事ごとのターンのモデルの呼び出しの上限。1 以上の整数 | 次のターンから |
| `eventTimeoutMinutes` | 出来事ごとのターンの時間の上限（分）。1 以上の整数 | 次のターンから |
| `reviewModelCalls` | 夜の振り返りのターンの呼び出しの上限。1 以上の整数 | 次の振り返りから |
| `reviewTimeoutMinutes` | 夜の振り返りのターンの時間の上限（分）。1 以上の整数 | 次の振り返りから |
| `awakeHours` | `{"start":"HH:MM","end":"HH:MM"}`（24 時間制、同じ時刻は不可。日をまたいでよい）。時間帯は `timeZone` | 次の見回りから（10 秒ごと） |
| `pingIntervalMinutes` | 静かな時間が続いたときの合図の間隔（分）。5 以上の整数、または `false`（合図しない） | 次の見回りから |
| `judgeLogprobs` | ポッポさんの logprobs の判定を掛けるか。`"on"` / `"off"`。config に接続先が無ければ `"on"` にできない（[ADR 0059](adr/0059-two-judges-side-by-side-and-fewer-issues.md)） | 次の下書きから |
| `judgeJev` | ポッポさんの Jev の判定を掛けるか。`"on"` / `"off"`。config に接続先が無ければ `"on"` にできない | 次の下書きから |
| `judgeAdopted` | 採用する判定。`"logprobs"` / `"jev"`。採用する方が答えなければもう一方で決める | 次の下書きから |
| `judgeLogprobsThresholds` | logprobs の判定のしきい値 `{"owner":0.5,"return":0.9}`。どちらも 0 より大きく 1 以下、owner ≦ return。owner 以上で本人へ回し、return 以上で突き返す | 次の下書きから |
| `judgeJevThresholds` | Jev の判定のしきい値。形と規則は `judgeLogprobsThresholds` と同じ | 次の下書きから |

一覧（`settings`: `session.snapshot` の欄、`settings.list`・`settings.set`・`settings.reset` の答え、`settings.changed` の payload）は、key ごとに次の欄を持つオブジェクトである。

| 欄 | 内容 |
| --- | --- |
| `value` | 今の値（上書きがあればそれ、無ければ config の値） |
| `config` | config の値 |
| `overridden` | 上書きがあるか。config と同じ値で上書きしていても true |
| `inUse` | `modelRoute` と `turnFold` だけ。いま実際に使っているもの。`value` と違えば、次のターンの前にそちらへ移る。`modelRoute` は natsumi が話せない間 null |
| `routes` | `modelRoute` だけ。経路の一覧（上記「モデルの経路」の `routes` と同じ形） |
| `timeZone` | `awakeHours` だけ。時間帯の IANA タイムゾーン（config の値。端末からは変えない） |
| `available` | `judgeLogprobs` と `judgeJev` だけ。config にその判定の接続先があるか。false なら `"on"` にできない |

```json
{"modelRoute":{"value":"plus","config":"local","overridden":true,"inUse":"local","routes":[{"name":"local","provider":"natsumi-compatible","model":"example-model","ready":true},{"name":"plus","provider":"openai-codex","model":"example-plus-model","ready":true}]},"turnFold":{"value":"off","config":"off","overridden":false,"inUse":"off"},"eventModelCalls":{"value":12,"config":8,"overridden":true},"eventTimeoutMinutes":{"value":10,"config":10,"overridden":false},"reviewModelCalls":{"value":40,"config":40,"overridden":false},"reviewTimeoutMinutes":{"value":30,"config":30,"overridden":false},"awakeHours":{"value":{"start":"07:00","end":"23:00"},"config":{"start":"07:00","end":"23:00"},"overridden":false,"timeZone":"Asia/Tokyo"},"pingIntervalMinutes":{"value":false,"config":180,"overridden":true},"judgeLogprobs":{"value":"on","config":"on","overridden":false,"available":true},"judgeJev":{"value":"on","config":"off","overridden":true,"available":true},"judgeAdopted":{"value":"logprobs","config":"logprobs","overridden":false},"judgeLogprobsThresholds":{"value":{"owner":0.5,"return":0.9},"config":{"owner":0.5,"return":0.9},"overridden":false},"judgeJevThresholds":{"value":{"owner":0.6,"return":0.95},"config":{"owner":0.5,"return":0.9},"overridden":true}}
```

- `settings.set`（payload `{"key":"eventModelCalls","value":12}`）は、値を config と同じ規則で確かめてから上書きを書き、変えた後の一覧を `command.accepted` で返す。
  一覧が変われば、全端末（変えた端末も）に `settings.changed` が届く。
  - 知らない key は `unknown-setting`、規則に合わない値は `invalid-value`、key が文字列でない・空・64 文字を超える、または value が無いと `invalid-request`。
  - `modelRoute` は `model.use` と同じ処理を通る。config に無い経路は `unknown-route`、使える状態にない経路は `route-unavailable`。
  - `judgeLogprobs`・`judgeJev` を `"on"` にするとき、config にその判定の接続先が無ければ `judge-unavailable`。`"off"` はいつでも受け付ける。
- `settings.reset`（payload `{"key":"eventModelCalls"}`）は上書きを消し、戻した後の一覧を返す。上書きが無くても受け付ける（何も変わらなければ `settings.changed` は届かない）。
  `modelRoute` を戻すと、既定の経路へ次のターンの前に移る。
- 2 つの端末から同時に変えても、1 つずつ順に書かれ、どちらも失われない。
- `settings.changed` は、端末から変えたときのほか、経路が実際に移ったとき、サーバーのコマンドが経路や畳み込みを書き換えたとき（15 秒ごとに見る）にも届く。
- natsumi が話せない間は、3 つとも `service.unavailable` を返す。
- `model.list`・`model.use`・`model.routes` はそのまま残る。経路だけを扱う画面はそちらを使ってよい。
- 画面は、`value` と `config` を並べ、`overridden` のときに「config に戻す」（`settings.reset`）を出すとよい。`inUse` が `value` と違う間は「次のターンから」と示す。

## 会話の画像

natsumi は返事（kind: reply）に画像を添えることがある（[ADR 0045](adr/0045-showing-the-owner-images-with-a-reply.md)）。
知らせ（kind: notice）と本人のメッセージには画像は付かない。

`conversation.message` と `session.snapshot` の `messages` の要素のうち、画像の添えられた返事だけが `images` を持つ。
`images` は 1 つ以上の要素の配列で、natsumi が並べた順（表示する順）である。1 つの返事に付くのは 4 枚までである。

| 欄 | 内容 |
| --- | --- |
| `imageId` | 画像の ID（文字列。英数字と `-`）。取得の道に使う |
| `mimeType` | `image/png`・`image/jpeg`・`image/webp` のどれか |
| `bytes` | 画像のバイト数（整数）。取得した本文の長さと同じ |
| `width`・`height` | 画像の幅と高さのピクセル数（正の整数）。サーバーが画像の頭から読めたときだけ、2 つそろって付く。無ければ取得してから大きさを知る |

```json
{"messageId":"message-example","role":"natsumi","kind":"reply","text":"猫を描いてみました。","createdAt":"2026-09-26T06:00:00.000Z","expression":"happy","images":[{"imageId":"image-example","mimeType":"image/png","bytes":946870,"width":896,"height":1152}]}
```

- 画像は、natsumi が返事を送った時点でサーバーが写し取ったものである。同じ `imageId` の画像は後から変わらず、消えない。
- 画像そのものは、承認の画像と同じ `GET /v1/images/<imageId>` で取る（下記「承認と外部実行」の「画像」）。ログインが要る。
- 縮小した画像を返す道は無い。取るのは元の画像である。吹き出しや履歴に並べるときは、アプリが表示の大きさに縮める。
  同じ ID の画像は変わらないので、アプリは取った画像（または縮めた画像）を手元に持って使い回してよい。ログアウトしたら捨てる。
  HTTP のキャッシュに残る分は、これとは別である（下記「承認と外部実行」の「画像」）。
- `images` の欄を知らない古いアプリは、欄を読み飛ばして本文だけを出す。
- 画像が取れないとき（404、つながらない）は、画像の場所に取れなかったことを示し、本文はそのまま出す。
- iPhone の通知には画像は載らない。本文の末尾に画像の枚数の印が付く（下記「iPhone への通知」の「e の暗号」）。

## アバター

姿と名前は、サーバーの設定で選ぶアバター（組み込みのものは ID、足すものはディレクトリのパス）から決まる（[ADR 0057](adr/0057-an-avatar-directory-named-in-the-server-config.md)）。
アプリはアバターを同梱せず、サーバーから丸ごと受け取って手元に控える。受け取るものは、今の Mac のアバターのディレクトリと同じ形である。

### 一覧とファイル

どちらも**ログインが要らない**（姿と名前は秘密ではない）。サーバーを設定した直後、ログインの前にも取れる。

- `GET /v1/avatar`: 一覧を JSON で返す。
  - `version`: 版（16 進 32 文字）。配る組の中身のハッシュで、中身が同じならどのサーバーでも同じ。
  - `id`: アバターの ID（英小文字で始まり、英小文字・数字・`-` の 32 文字まで）。手元の控えの置き場所に使える。
  - `name`: 表示名（1〜32 文字）。アプリの表示（メニューバー・会話のウィンドウのタイトル・履歴など）に使う。
  - `files`: ファイルごとの `path`・`bytes`・`sha256`（16 進）。path の順に並ぶ。
- `GET /v1/avatar/<version>/<path>`: ファイルの中身。`Content-Type` は `image/webp`・`image/png`・`application/json`。
  - `version` が今の版でなければ、`path` が一覧に無ければ 404（`{"error":"not-found"}`）。そのときは一覧から取り直す。
  - 版ごとに中身は変わらないので、`cache-control: public, max-age=31536000, immutable` が付く。

```json
{"version":"9591a91aad82f61ecb637fde6430fd75","id":"natsumi","name":"なつみ","files":[{"path":"avatar.json","bytes":1277,"sha256":"<hex>"},{"path":"icons/happy.webp","bytes":25758,"sha256":"<hex>"},{"path":"pet.json","bytes":266,"sha256":"<hex>"},{"path":"spritesheet.webp","bytes":1701104,"sha256":"<hex>"}]}
```

例は一部のファイルだけを載せ、ハッシュは省いた。

配るファイルの path は決まっている。

| path | 中身 |
| --- | --- |
| `pet.json` | Codex pet の定義 |
| `avatar.json` | `id`・`name`・`spritesheet`・`atlas`・`framesPerSecond`（無いことがある）・`animations`・`expressions`（無いことがある）・`icons`。今の Mac の `avatar.json` と同じ形に、`id`・`name` が足されたもの |
| `spritesheet.webp` または `spritesheet.png` | spritesheet。`avatar.json` の `spritesheet` がこの path を指す |
| `icons/<表情>.webp` または `.png` | 表情ごとの顔。8 つの表情（`avatar.expression` と同じ候補）すべてにある。`avatar.json` の `icons` がこの path を指す。アバターの仕様にある `angry` は、サーバーの表情の候補に入るまで配らない |

- アバターに無い素材は、サーバーが名無し（`nanashi`）の、のっぺらぼうの素材で埋めてから配る。アプリはどれが埋めたものかを区別しなくてよい。
- `expressions` が無い、または表情が欠けているときは、今の Mac と同じく既定の対応表で読む。

### 取り直すとき

- 手元の控えの版と、`session.snapshot` の `avatarVersion`（会話が使えないときは `service.unavailable` の `avatarVersion`）が違えば、一覧から取り直す。
- 取り直すときは、一覧の全ファイルを取り、`bytes` と `sha256` を確かめてから、控えを丸ごと置き換える。途中で失敗したら、前の控えを使い続ける。
- **版が変わるのはサーバーの再起動のときだけ**である。サーバーはアバターを起動時に 1 度だけ読む。再起動で epoch が変わるので、再接続では必ず snapshot が届き、そこで新しい版を知る。
  そのため、接続中に版の変化を知らせるイベントは無い。
- アバターは基本的に切り替えない。版が変わるのは主に、サーバーの改修（のっぺらぼうの素材が増えた等）と素材の手直しである。

### Slack のアイコン

`GET /avatar/<表情>.png`（ログイン不要）は Slack がアイコンとして取るもの（ADR 0040）。アプリの本体は使わないが、iPhone の通知の拡張が通知に添える顔として取る（下記「iPhone への通知」の「e の暗号」）。

## 考えている 1 行

本人のメッセージを処理している間、natsumi が書いている思考の **1 行だけ**が `conversation.thinking` で全端末に届く
（[ADR 0017](adr/0017-streaming-the-line-she-is-thinking.md)。ADR 0008 の「思考はクライアントに渡さない」を一部改める）。

- payload は `line` の 1 つだけで、思考の本文の**最後の改行より後ろ**である。改行が来れば次の行に入れ替わる。
  全文は流れない。ツールの呼び出しの引数も結果も流れない。
- 行が育つ途中も流すが、**250 ms に 1 回まで**に間引く。空行は送らない。思考のかたまりが終わったときは、
  間引きに関わらず最後の行を送る。
- **1 行は 120 文字まで。** 超えた行は先頭を落として `…` を付け、新しいほうの端を残す。
- 処理が終わると、`line` が空文字の `conversation.thinking` が 1 度届く。これが「思考は終わった」の合図である。
- 流れるのは、**本人のメッセージを処理しているターンだけ**である。夜の振り返り、合図（ping）、自発的な確認、
  および設定 `pi.thinking` が `off` のときは流れない。
- モデル呼び出しが複数回あるターンでは、呼び出しの境目でも最後の行はそのまま残る。

採番と再送の扱いが、ほかの event と違う。

- **seq を消費しない。** envelope には、その stream がいま出している seq（最後に採番した番号）をそのまま付ける。
- **再送のバッファに入れない。** 受け取れなかった端末に後から届けることはしない。いま書いている行は、
  いま見えることにだけ意味がある。
- この event を知らないクライアントは、すでに受け取った seq として黙って捨てる。次の会話の event は今までどおり
  seq + 1 で届くので、抜けにはならない。
- 知っているクライアントは、**同じ epoch・同じ stream のときだけ適用し、stream の位置を動かさない。**
  同期の前や別の stream のものは、再同期を求めずに捨てる。
- **SQLite に記録しない。`session.snapshot` にも履歴にも入らない。** 再接続しても、前の行は戻らない。

## 既読と知らせの確認

本人が確かめたことはサーバーが持ち、すべての端末で共通である（ADR 0013）。Mac は既読や確認の記録を独自に保存しない。

返事の既読は、会話の位置のカーソル 1 つで表す。

- `conversation.read` の throughMessageId までの返事を読んだことにする。本人のメッセージ・返事・知らせのどれを指してもよい。
- カーソルは戻らない。今の位置より手前を送っても変わらず、`command.accepted` で今の位置が返る。
- 未読の返事は、カーソルより後にある kind: reply のメッセージである。本人のメッセージは数えない。カーソルが null なら、すべての返事が未読である。
- カーソルが snapshot の `messages` の中に無ければ、カーソルは一覧より古い。一覧の返事はすべて未読で、件数は `unreadReplyCount` を使う。
- 本人がメッセージを送っても、カーソルは自動では進まない。

知らせの確認は、知らせ（kind: notice）1 件ずつで表す。

- `notification.ack` の notificationId は、知らせの messageId である。順不同で確認できる。
- 冪等で、2 回目以降は最初に記録した acknowledgedAt が返る。知らせでない ID と存在しない ID は invalid-request になる。
- カーソルが知らせを越えても、知らせは確認済みにならない。

反映の順序は次のとおりである。

1. 送った端末に `command.accepted` が届く。
2. 状態が変わった場合だけ、送った端末を含む全端末に `conversation.read` または `notification.acked` が届く。
   手前の位置や 2 回目の ack では、イベントは届かない。
3. これらのイベントも stream の seq で採番され、差分の再送に含まれる。snapshot を受け取った端末は、snapshot の 3 つの項目で状態を置き換える。

サーバーを更新して既読の記録を初めて持ったとき、それまでの会話はすべて既読・確認済みになる。以後の返事と知らせだけが未読になる。

## iPhone への通知

iPhone は裏に回ると接続を切るので、その間の返事と知らせは APNs で知らせる
（[ADR 0029](adr/0029-push-notifications-on-the-iphone.md)）。本文は端末の公開鍵で暗号化し、Apple のサーバーを平文で通さない。
Mac は登録しない。以下の base64 は、すべて標準の base64（RFC 4648 の 4 節、`+` と `/`、`=` の詰め物あり）である。
URL 用の base64（`-` と `_`）や詰め物のないものは受け付けない。

### 登録

iPhone は接続のたびに、`session.sync` の後で `push.register` を送る。

| payload | 内容 |
| --- | --- |
| `token` | APNs の device token の 16 進（大文字も可。サーバーは小文字にして持つ） |
| `publicKey` | 通知のための P-256 の公開鍵。X9.63 の非圧縮形式（65 バイト、先頭 0x04）の base64。曲線の上の点でなければ断る |
| `environment` | `sandbox`（開発用に署名したもの。アプリは署名の provisioning profile の `aps-environment` で決める）または `production`（配布したもの） |

- 形が合わなければ `command.rejected`（`invalid-request`）になる。受け付けると `command.accepted`（`environment`）が返る。
- 登録は端末ごとに 1 つで、送るたびに上書きする。同じ token を別の端末が登録すると、前の端末の登録は消える（入れ直したアプリ）。
- 送り先になるのは、その端末が最後に同期したセッションが生きている（取り消されておらず期限内の）間だけである。
  ログアウトや期限切れの後は送らない。セッションは最後に使ってから 30 日で切れ、接続するたびに延びる
  （[ADR 0030](adr/0030-a-session-that-lasts-while-it-is-used.md)）。30 日以内に一度でも iPhone のアプリを開いて接続すれば、
  通知は止まらない。30 日まったく開かないと止まり、次に開いてログインし直すと戻る。
- サーバーに `apns` の設定がなくても登録は受け付けて記録する。送るのは設定があるときだけである。
- APNs が `410` か `BadDeviceToken` を返すと、その登録を消す。アプリは次の接続でまた登録する。

### いつ送るか

登録があり、**いま接続していない**端末に送る。接続していれば会話のイベントで届くので送らない。

| きっかけ | 送るもの |
| --- | --- |
| 返事（`conversation.message` の kind: reply）を記録した | alert |
| 知らせ（kind: notice）を記録した | alert |
| 既読のカーソルが進んだ（`conversation.read`） | background（kind: read） |
| 知らせが初めて確認された（`notification.acked`） | background（kind: acked） |
| 承認待ちができた（`approval.pending`） | alert（kind: approval） |
| 承認が閉じた（`approval.resolved`） | background（kind: approval-resolved） |

本人のメッセージは送らない。5xx・429・つながらないときは、同じ `apns-id` で数回（既定では 5 秒・30 秒・2 分の後）送り直し、
だめなら諦める。送り直しはメモリの中だけで、サーバーを再起動すると消える。

### alert

ヘッダーは `apns-push-type: alert`、`apns-priority: 10`、`apns-topic`（アプリの bundle ID）、`apns-id`（UUID）。

```json
{"aps":{"alert":{"title":"なつみ","body":"返事があります"},"mutable-content":1,"badge":3,"sound":"default"},"messageId":"message-example","kind":"reply","position":42,"e":{"v":1,"epk":"BE9p…","nonce":"AAEC…","ct":"RDIz…"}}
```

- `aps.alert` は決まった文である。本文は kind: reply なら「返事があります」、notice なら「知らせがあります」、approval なら「承認待ちがあります」。
  Notification Service Extension が復号に失敗したときは、この文がそのまま出る。
- `aps.badge` は、送る時点の未読の返事の数と未確認の知らせの数と承認待ちの数の和である。
- 平文の `messageId`（会話の messageId。知らせならそのまま notificationId）、`kind`（`reply` / `notice`）、`position`（会話の位置の整数）は、
  会話の中身ではなく片づけに使う。
- `e` はオブジェクトで、`v`（数値の 1）と、base64 の文字列 `epk`・`nonce`・`ct` を持つ。
- kind: approval の alert は、平文に `messageId` と `position` を持たず、`kind` と `approvalId` だけを持つ。
  `e` の平文は `{"text": "…", "channel": "work/#dev"}`（下書きの先頭と、投稿するチャンネル）で、AAD は approvalId の UTF-8 である。text の切り方は下と同じ。

```json
{"aps":{"alert":{"title":"なつみ","body":"承認待ちがあります"},"mutable-content":1,"badge":1,"sound":"default"},"kind":"approval","approvalId":"approval-example","e":{"v":1,"epk":"BE9p…","nonce":"AAEC…","ct":"RDIz…"}}
```

### e の暗号

平文は UTF-8 の JSON `{"text": "…", "expression": "…", "icon": "…"}` である。`expression` はセリフの気持ちで、記録の無い古いセリフでは欄が無い。
`icon` はその気持ちの顔の URL で、Slack のアイコンと同じ認証なしの `<publicOrigin>/avatar/<表情>.png`（上記「アバター」の「Slack のアイコン」）である。
気持ちの記録が無いセリフは `neutral` の顔を指す。アプリは `https` の URL だけを受け、Notification Service Extension が取って通知に添える。
取れない・時間内に取れないときは顔なしで出す（通知そのものは出す）。表情は気持ちなので、URL も暗号の中に入れ、平文の欄には置かない。
ADR 0029 の「顔はアプリに同梱のアイコンから付ける」は、アバターをサーバーから受け取るようになった（ADR 0057）ため、この URL から取る形に置き換わる。
`icon` は切らない。4096 バイトに収めるために切るのは `text` である。承認待ちの平文には `icon` は無い。
`text` は 1000 文字（Unicode のコードポイント）までに切り、切ったときは最後の 1 文字を `…` にする。
全角の文字が多く payload が 4096 バイトを超えるときは、収まるまでさらに短く切る（そのときも末尾は `…`）。

画像の添えられた返事（上記「会話の画像」）では、サーバーが `text` の末尾に `（画像 N 枚）` を付ける（N は画像の枚数、全角の括弧、
「画像」と N と「枚」の間は半角の空白。例 `猫を描いてみました。（画像 1 枚）`）（[ADR 0045](adr/0045-showing-the-owner-images-with-a-reply.md)）。
印は切らない。1000 文字や 4096 バイトに収めるために切るのは印の前の本文で、切ったときは `…（画像 1 枚）` のように終わる。
印は通知の中だけのもので、会話の `text` には付かない。アプリは印を足したり外したりせず、`text` をそのまま出す。
全文はアプリを開けば会話の同期で読める。

1. サーバーは送るたびに P-256 の一時的な鍵ペアを作る。`epk` はその公開鍵（X9.63 の非圧縮、65 バイト）である。
2. 一時的な秘密鍵と端末の公開鍵で ECDH を取り、共有の秘密（32 バイトの x 座標）を得る。
3. HKDF-SHA256 で鍵を導く。入力はその共有の秘密、salt は `epk` と端末の公開鍵（どちらも 65 バイト）をこの順につないだ 130 バイト、
   info は ASCII の `natsumi-push-v1`、長さは 32 バイト。
4. AES-256-GCM で暗号化する。nonce は 12 バイトの乱数（`nonce`）、AAD は messageId の UTF-8 のバイト列、tag は 16 バイト。
5. `ct` は暗号文の後ろに tag の 16 バイトをつないだものである。nonce は `ct` に含めない。

CryptoKit では、`P256.KeyAgreement` で `epk` との共有の秘密を取り、`hkdfDerivedSymmetricKey(using: SHA256.self, salt:, sharedInfo:, outputByteCount: 32)`
で鍵を導き、`AES.GCM.SealedBox(combined: nonce + ct)`（nonce ‖ 暗号文 ‖ tag）を `authenticating: messageId` で開けば同じになる。
手順が 2 つの言語でずれていないことは、共通のテストベクタ [test/fixtures/push/vector-v1.json](../test/fixtures/push/vector-v1.json) で確かめる。
ベクタは固定の鍵と nonce から作った `e` と、途中の値（共有の秘密・salt・鍵）を持つ。中の秘密鍵はテスト専用の使い捨てである。

### background

ヘッダーは `apns-push-type: background`、`apns-priority: 5`、`apns-topic`、`apns-id`。`aps` は `content-available` だけで、
バッジの数は `aps` の外に置く（アプリが自分でバッジを直す）。

```json
{"aps":{"content-available":1},"kind":"read","badge":1,"readThroughPosition":42}
{"aps":{"content-available":1},"kind":"acked","badge":0,"readThroughPosition":42,"notificationId":"message-example"}
```

- `badge` は送る時点の未読の返事と未確認の知らせと承認待ちの和、`readThroughPosition` は既読のカーソルの位置（カーソルが無ければ欄が無い）。
- kind: acked は、確認された知らせの `notificationId` を持つ。
- kind: approval-resolved は `approvalId` と `badge` だけを持つ（`{"aps":{"content-available":1},"kind":"approval-resolved","approvalId":"approval-example","badge":0}`）。
  アプリはその承認の alert を消す。
- アプリはバッジを直し、届いている通知のうち、`position` が `readThroughPosition` 以下の返事と、確認済みの知らせを消す。
- background push は iOS が間引くので確実には届かない。アプリは前に戻ったとき、同期した状態に合わせて通知とバッジを片づける。

## ブラウザへの通知

ブラウザは、閉じている間の返事・知らせ・承認待ちを Web Push で受けられる（[ADR 0065](adr/0065-web-push-to-the-browser.md)）。
送り先を決める規則は iPhone と同じで、購読があり、その端末のセッションが生きていて、**いま接続していない**端末に送る。

### 登録

ブラウザは購読したとき（設定の画面の「通知を受け取る」）と、その後の同期のたびに、`push.register` を送る。

```json
{"subscription":{"endpoint":"https://push.example.test/send/abc","keys":{"p256dh":"BNcR…","auth":"tBHI…"}}}
```

- `subscription` は `PushSubscription.toJSON()` の形のまま送ってよい（`expirationTime` は見ない）。
  `endpoint` は https の URL、`keys.p256dh` は P-256 の公開鍵（非圧縮、65 バイト）、`keys.auth` は 16 バイトで、どちらも base64url である。
- 購読は VAPID の公開鍵（ページの `<meta name="natsumi-push-key">`）を `applicationServerKey` にし、`userVisibleOnly: true` で作る。
- 受け付けると `command.accepted`（中身なし）が返る。形が合わなければ `invalid-request`。bearer の接続（アプリ）からの `subscription` も断る。
- 購読は端末ごとに 1 つで、送るたびに上書きする。同じ endpoint を別の端末が登録すると、前の端末の購読は消える。
- 解除のコマンドは無い。ブラウザで購読を止めると、push service が 404 か 410 を返し、そのときサーバーが購読を消す。
- サーバーの VAPID の鍵が作り直されると、古い鍵の購読への push は 401・403 で断られ、サーバーは消さない。ブラウザはページを開いたときに購読の `applicationServerKey` とページの鍵を比べ、違えば購読し直して登録する。
- タブが開いていてつながっている間は、見えていなくても送らない。

### いつ何を送るか

| きっかけ | 送るもの |
| --- | --- |
| 返事（kind: reply）・知らせ（kind: notice）を記録した | 本文 |
| 承認待ちができた（`approval.pending`） | 承認待ちの見出しと下書き |

既読・確認・承認が閉じたことは送らない（ブラウザは届いた push をすべて通知として出す）。1 回だけ送り、送り直さない。
push service が 404 か 410 を返すと、その購読を消す。

push は RFC 8291 の `aes128gcm` で購読の鍵に暗号化し、VAPID（RFC 8292、ES256。`aud` は endpoint のオリジン、`exp` は 12 時間後、`sub` は `publicOrigin`）を付けて POST する（redirect は追わない）。Apple の push service は https でない・localhost の `sub` を 403 で断る。
ヘッダーは `Authorization: vapid t=<JWT>, k=<公開鍵>`、`Content-Encoding: aes128gcm`、`TTL: 86400`、`Urgency: high`。平文は UTF-8 の JSON である。

```json
{"title":"なつみ","tag":"message-example","text":"猫を描いてみました。（画像 1 枚）","expression":"happy","icon":"https://natsumi.example.net/avatar/happy.png"}
{"title":"なつみ","tag":"approval-example","text":"承認待ちがあります（work/#dev）\n明日は 10 時からなら大丈夫です。"}
```

- `title` はアバターの表示名、`tag` は messageId か approvalId である。
- `text`・`expression`・`icon` は iPhone の `e` の平文と同じ規則で作る（上記「e の暗号」の切り方と画像の印）。1 つの record（平文 3993 バイト）に収まらなければ、さらに短く切る。
- service worker は `title` と `text` と `icon` で通知を出し、`tag` で同じ行の通知をまとめる。押されたら、開いているタブを前に出すか、`/` を開く。

## 承認と外部実行

### Slack の投稿の承認

natsumi が Slack に出したい投稿のうち、ポッポさんの判定で本人に回されたもの（`owner`）、判定できなかったもの（`no-verdict`）、
同じ返信先で 3 回目に突き返されたもの（`rewrite-limit`）が承認待ちになる。判定が通った投稿は承認なしに送られる。
理由は [ADR 0040](adr/0040-the-dove-sends-what-the-judge-passes.md) にある。リアクションは承認を通らない。

承認（`approval.pending` の payload、`pendingApprovals` の各要素）は次を持つ。作った時点の中身で固定され、変わらない。

| 欄 | 中身 |
| --- | --- |
| `approvalId` | 承認の ID |
| `revision` | 整数。今は常に 1（サーバーが作り直すことは無い。修正は本人の決定として扱う） |
| `kind` | `slack-post` |
| `createdAt` / `expiresAt` | 作った時刻と期限（既定 7 日、設定 `slack.approvalExpiryDays`） |
| `target.channel` | `work/#dev`（ワークスペース/チャンネル。DM は `work/@名前`） |
| `target.replyTo` | 返す相手の発言の `speaker`・`at`（本人のタイムゾーンの `2026-09-25 14:32:05`）・`text`（100 文字まで。超えたら末尾に `…`）。チャンネルそのものへの投稿では欄が無い |
| `target.placement` | `thread`・`channel`・`broadcast` のどれか（[ADR 0062](adr/0062-three-placements-for-a-reply.md)）。判定の選択、判定なしならサーバーの決まりの値（`broadcast` にはならない）。`thread` は返す相手の発言のスレッドに返す。`channel` はスレッドを作らずにチャンネルに直接出す。チャンネルそのものへの投稿は `channel`。`broadcast` はスレッドに返し、チャンネルにも出す（Slack の `reply_broadcast`）。画像付きの投稿の `broadcast` はスレッドにだけ置く。クライアントは知らない値でも承認を表示し、決定できるようにする |
| `text` | natsumi の下書き（全文） |
| `expression` | アイコンの表情。無ければ欄が無い |
| `images` | 投稿に付く画像の一覧。natsumi が書いた順。各要素は `imageId`（画像の ID）・`mimeType`（`image/png`・`image/jpeg`・`image/webp`）・`bytes`（大きさ、バイト）。画像が無ければ欄が無い（下記「画像」） |
| `reason.verdict` | `owner`・`no-verdict`・`rewrite-limit` |
| `reason.issues` | 問題点ごとの `name`（英語の識別子）・`label`（日本語の表示名）・`score`（0〜1）。しきい値以上のものに `flagged: true`（それ以外は欄が無い）。判定なしなら空。2 つの判定を掛けたときも、決めた方の判定のものだけ |
| `reason.placement` | 判定の置き場所の `probabilities`。置き場所の値をキーにした 0〜1 の数。キーが 3 つ揃っているとは限らない（判定の種類や、3 つになる前の記録）ので、クライアントは知らないキーを無視し、欠けたキーは無いものとして扱う。判定なし、または判定が確率を返さなかったときは欄が無い |
| `history` | 同じ返信先で突き返された前の下書きの `text` と、そのときの flagged の `issues`。古い順。無ければ空 |

```json
{"approvalId":"approval-example","revision":1,"kind":"slack-post","createdAt":"2026-09-25T06:00:00.000Z","expiresAt":"2026-10-02T06:00:00.000Z","target":{"channel":"work/#dev","placement":"thread","replyTo":{"speaker":"山田","at":"2026-09-25 14:32:05","text":"明日のレビュー大丈夫？"}},"text":"大丈夫です。","expression":"happy","reason":{"verdict":"owner","issues":[{"name":"promise-for-owner","label":"本人に代わる約束・期限","score":0.5,"flagged":true},{"name":"private-matter","label":"私的な事情","score":0.02}],"placement":{"probabilities":{"thread":0.8,"channel":0.15,"broadcast":0.05}}},"history":[]}
```

- 本人は `approval.decide` で承認（approve）・修正（edit）・却下（reject）を選ぶ。承認と修正では placement を変えられる。
  チャンネルそのものへの投稿では placement は無視される。
- 受け付けると `command.accepted`（approvalId・revision・state）が返る。state は approved・edited・rejected のどれか。
  送った結果は、後で `approval.resolved` で全端末に届く。却下はその場で `approval.resolved`（delivery なし）が届く。
- 決定は 1 回だけ受け付ける。既に閉じた承認への決定には、閉じたときの state を `command.accepted` で返し、何もしない（別の端末からの重複も同じ）。
- 期限を過ぎた承認は閉じて `approval.resolved`（state: expired）を送る。期限を過ぎてから届いた決定には、送らずに expired を返す。
- 修正した本文は判定に掛け直さない。送る直前の機械的な検査は、承認した下書きにも修正した本文にも掛け、当たれば送らずに
  `delivery: failed`・`reason: mechanical-check` とする。返す相手の発言が消されていれば `target-gone`、Slack に断られれば `slack-error`。
- 送るのは、承認なら見せた下書き、修正なら本人の本文だけである。`sentText` は実際に送った本文。
- 画像の付いた承認では、承認でも修正でも、`images` の画像が本文と一緒に送られる。画像は選べない（全部送るか、却下するか）。

### 画像

画像の付いた投稿の理由は [ADR 0044](adr/0044-drawing-with-sdctl-and-posting-images.md) にある。
取得の道は、会話の返事に添えられた画像（上記「会話の画像」、[ADR 0045](adr/0045-showing-the-owner-images-with-a-reply.md)）にも使う。

- 画像は、natsumi が依頼した時点でサーバーが写し取ったものである。承認に見せる画像と、送る画像は同じで、後から変わらない。
- 本文の無い、画像だけの投稿は、承認を通らずに送られる。承認に画像が付くのは、本文があって本人に回されたときだけである。
- 画像そのものは `GET /v1/images/<imageId>` で取る。`Authorization: Bearer <token>`（WSS と同じセッション）が要る。
  ブラウザは Bearer の代わりにログインの cookie で取れる（下記「ブラウザ」）。
  - 成功すると 200 で、本文は画像のバイト列、`Content-Type` は一覧の `mimeType`、`Content-Length` は `bytes` と同じ。
  - セッションが無い・失効・期限切れ・本人以外なら 401（`{"error": "unauthorized"}`）。画像があるかどうかは、セッションを確かめてから答える。
  - 知らない imageId、承認にも会話の返事にも載っていない画像（承認を通らずに Slack に送った画像など）、写しが無くなった画像は 404（`{"error": "not-found"}`）。
  - 200 には `Cache-Control: private, max-age=31536000, immutable` が付く。同じ imageId の画像は変わらないので、一度取れば取り直さなくてよい。
    ログインが要る画像なので `private` であり、途中の proxy や CDN には置かせない。401 と 404 には `Cache-Control: no-store` が付く。
  - アプリが自分で持つ画像は、承認の画像なら承認が閉じたら、会話の画像ならログアウトしたら捨てる（上記「会話の画像」）。
    同じ画像が承認と会話の両方に載ることは無い。
  - これとは別に、ブラウザや OS の HTTP のキャッシュ（アプリの URLCache を含む）には、`private` のキャッシュとして
    その端末に残りうる。承認が閉じてもログアウトしても消さない（`Clear-Site-Data` も付けない）。途中の proxy や CDN には残らない。
  - 取るのはセッションの使用であり、WSS の接続と同じくセッションを延ばす（上記「セッションの延長」）。
- 画像の ID は承認に限らない。会話の返事の画像も、同じ形の ID で同じ道から取る。

```json
{"approvalId":"approval-example","revision":1,"kind":"slack-post","createdAt":"2026-09-25T06:00:00.000Z","expiresAt":"2026-10-02T06:00:00.000Z","target":{"channel":"work/#dev","placement":"thread","replyTo":{"speaker":"山田","at":"2026-09-25 14:32:05","text":"猫の絵を描いて"}},"text":"描いてみました。","images":[{"imageId":"image-example","mimeType":"image/png","bytes":946870}],"reason":{"verdict":"no-verdict","issues":[]},"history":[]}
```

### 予定の変更の承認（未実装）

承認レコードは approvalId、revision、対象 calendar/event ID、変更前 ETag、変更後の全項目、
期限、payload hash、状態、実行 operation ID を持つ。
許可画面と実行 payload は同じ immutable revision から生成する。
`pending -> approved/rejected` は transaction の条件付き更新とし、重複回答は確定状態を返す。
実行直前に期限、対象 ETag、hash、操作種別を再確認する。変更があれば再承認へ戻す。
削除、招待、参加者変更、通知メール送信は実行 adapter で拒否する。

Calendar 実行は `approved -> executing -> succeeded/failed/unknown` と進める。
作成では provider が許す決定的 event ID、更新では ETag 条件を使う方針とし、
Google API の制約は adapter 実装時に検証する。
外部実行成功後・ローカル保存前の停止は `unknown` として外部の結果を照合する。
実行要求を無条件で再送して二重作成しない。
Pi の `calendar_propose` ツール呼び出しは承認待ちの作成要求にすぎず、承認や実行の許可として扱わない。

## ブラウザ

ブラウザは、`/` でなつみと話し、`/settings` で実行中の設定を変える、もう 1 台の端末である（[ADR 0058](adr/0058-settings-and-chat-in-the-browser.md)）。
閉じている間の返事と知らせは、Web Push で受けられる（下記「ブラウザへの通知」、[ADR 0065](adr/0065-web-push-to-the-browser.md)）。読み取り専用のダッシュボード（`/dashboard`、[ADR 0049](adr/0049-a-read-only-dashboard-in-the-browser.md)）とはリンクで行き来する。

### ログインと cookie

- ログインは、アプリと同じ GitHub OAuth である。`/`・`/settings`・`/dashboard` を cookie 無しで開くと GitHub のログインへ回され、済むと開こうとしたページに戻る。
  戻り先はこの 3 つだけで、サーバーのコードに固定されている。
  GitHub から戻ったときは redirect ではなく同じオリジンのページが返り、そこから `<meta http-equiv="refresh">` で戻り先へ移る（`SameSite=Strict` の cookie は GitHub から戻る redirect では送られないため）。
- ログインの状態は cookie `natsumi_session` に載る。属性は `Path=/`・`HttpOnly`・`SameSite=Strict`、`publicOrigin` が https なら `Secure`。JS からは読めない。
  寿命はアプリのセッションと同じで、最後に使ってから 30 日で切れ、使うたびに延びる（ページを開く、WSS をつなぐ、画像を取る）。
- 以前のダッシュボードの cookie（`natsumi_dashboard`、`Path=/dashboard`）は、`/dashboard` を開いたときに 1 度だけ受け付けられ、`natsumi_session` に移し替えられる。
- ログアウトは、`/dashboard/logout` に同じオリジンのフォームで POST する（Origin が `publicOrigin` でなければ断る）。303 で `/dashboard/signed-out` に移り、cookie は消える。

### ページと JS の束

- `GET /` と `GET /settings` は同じ HTML を返す。HTML は `<div id="app"></div>` と、JS の束 `/app/app.js`（`<script type="module">`）、あれば `/app/app.css` を読み込むだけである。どちらの画面を出すかは、束が `location.pathname` で決める。
- 束が無いサーバーでは、HTML は束が無い旨の文だけを出し、script を読み込まない。
- 束のファイルは `GET /app/<ファイル名>` で配る。名前は英数字で始まり、英数字と `.`・`_`・`-` だけのもの、拡張子は `.js`・`.css`・`.map` だけで、ディレクトリは持てない。ログインは要らない。
  サーバーは束を checkout の `dist/web/`（image では `/app/dist/web/`）から読む。
- CSP は `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' wss://<publicOrigin のホスト>; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` である。
  inline の script と style、`eval`、ほかのオリジンからの読み込みはできない。
- HTML の head には、Web App Manifest（`<link rel="manifest" href="/app/manifest.webmanifest">`）と、Web Push の VAPID の公開鍵（`<meta name="natsumi-push-key" content="…">`、base64url）が載る。
  manifest はサーバーがアバターから作り（名前は表示名、アイコンは `/avatar/neutral.png`）、ログイン無しで取れる。
- service worker は束の `/app/sw.js` である。サーバーはこのファイルにだけ `Service-Worker-Allowed: /` を付けるので、scope `/` で登録できる。

### WSS への接続

- `new WebSocket("wss://<publicOrigin のホスト>/v1/ws")` でつなぐ。ブラウザが cookie と Origin を付ける。Authorization は付けない（付けると Bearer だけで判断され、cookie は見られない）。
- cookie は Origin が `publicOrigin` のときだけ受け付ける。無い・違うと 403、cookie のセッションが無い・切れていれば 401。
- つないだ後は、上記「端末の登録と stream」と同じである。最初の `session.sync` で deviceId を受け取り、手元（localStorage など）に控えて、次の接続の envelope に付ける。
- 話す（`conversation.send`）、既読（`conversation.read`）、知らせの確認（`notification.ack`）、承認（`approval.decide`）、経路（`model.*`）、設定（`settings.*`）は、Mac・iPhone と同じに使える。
  承認は外に作用するので、押し間違いの確認は画面の側で行う。
- `push.register` は Web Push の購読（`subscription`）だけを受け付け、APNs の登録（`token`・`publicKey`・`environment`）は `command.rejected`（`invalid-request`）で断られる（下記「ブラウザへの通知」）。
  ブラウザがつながっていても、iPhone への通知は止まらない（通知の判定は端末ごとである）。
- 返事の画像（`images`）は `GET /v1/images/<imageId>` を cookie 付きで取る（`<img src>` でよい。同じオリジンなので cookie が付く）。
  URL は imageId だけで決め、クエリを足さない。同じ URL なら、ブラウザは一度取った画像を HTTP のキャッシュから出す（上記「承認と外部実行」の「画像」）。
  このキャッシュはログアウトしても端末に残る。
- セリフの横の顔と見出しの名前は、ログイン無しで取れる `/v1/avatar`（上記「アバター」）から使う。

### 偽のサーバー

`npm run fake-server -- [--bundle <dir>]` は、GitHub もモデルも使わずにブラウザの画面を試すための偽のサーバーである（`http://localhost:8787`）。

- `/`・`/settings` を cookie 無しで開くと `/fake-login?to=<戻り先>` に回され、そこで cookie `natsumi_session=fake-session` が付いて戻る。テストはこの cookie を自分で付けてもよい。
- `/v1/ws` は、cookie があって Origin が `http://localhost:<port>` でなければ 403 を返す。cookie でつないだ接続の `push.register` は、`subscription` なら受け付け（何も送らない）、APNs の登録なら断る。
- `settings.*` は本物と同じ規則で答え、ログアウト（`POST /auth/logout`、または同じオリジンからの `POST /dashboard/logout`）で config の値に戻る。
- 束は `--bundle` のディレクトリ（省略すると本物と同じ場所）から配る。

## 通知と定期処理

通知は、会話の知らせ（`conversation.message` の kind: notice）である（ADR 0008・0013）。

- 知らせは SQLite の会話に記録し、全端末に `conversation.message` で届く。notificationId は知らせの messageId である。
- 本人の確認は `notification.ack` で知らせごとに冪等に記録し、`notification.acked` で全端末へ同期する。古い端末からの遅れた ACK も同じ知らせの確認として扱う。
- 全端末がオフラインでも知らせは残る。次に接続した端末は、snapshot の `unacknowledgedNotificationIds` で未確認の知らせを知る。
- 表示済みかどうかをクライアントが独自に保存する必要はない。確認の状態はサーバーのものを使う。

次は作っておらず、未定である。

- 配信先の決定（最後の明示操作の端末だけに送る）、期限付きの lease、ACK が無いときの別の端末への再配信
- `notification.batch` と `device.activity`
- 時刻に合わせた知らせと、確かめていない知らせの念押し（スケジューラーの作業で決める）

## 後続 PR と検証順

1. **基盤**: 設定 parser、初期化、data directory ロック、SQLite migration、専用 Pi 状態領域
   （agentDir・session・auth）、GitHub 認証、TLS 接続、コンテナ永続化。本人以外の拒否と二重起動拒否を試験する。
   `docker compose config --quiet` / `docker compose build` を実装時に実行する。
2. **会話・記憶・通知**: 単一の思考ループと表示用の会話の記録（ADR 0008、実装済み）、上記同期、
   Markdown 記憶と夜の session の切り替え（ADR 0009、実装済み）、既読と知らせの確認（ADR 0013、実装済み）、スケジューラー。複数端末、切断、プロセス停止、ACK 消失を試験する。
3. **外部連携**: Gmail 読み取り、Calendar 提案・承認・実行、Wiki fixture。
   承認前未実行、revision 不一致、二重承認、外部結果不明の照合、既存 Wiki 差分の保護を試験する。
4. **Mac UI**: SwiftUI/AppKit 常駐、会話、承認表示、通知。Xcode scheme と具体的な
   `xcodebuild` build/test コマンドを決め、対応 Mac 上で実行する。
5. **運用・音声**: コンテナ再作成とバックアップ復旧、複数 Mac の実接続、音声の再検討。
   音声は対応方式・利用条件・課金条件と Mac の録音・再生・中断を確認できた場合だけ別途判断する。
