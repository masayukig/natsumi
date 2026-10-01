# 0029. iPhone に通知を届ける

- Date: 2026-09-23
- Status: Accepted（iPhone 側の実装で決めた細部を末尾に追記、画像の付いた返事の本文の末尾に枚数の印を付けることを [ADR 0045](0045-showing-the-owner-images-with-a-reply.md) で追加、同じ送り先の規則でブラウザにも Web Push で送ることを [ADR 0065](0065-web-push-to-the-browser.md) で追加）

## Context

iPhone のアプリは、裏に回ると接続を切る（[ADR 0028](0028-the-iphone-client.md) の 4）。そのため、アプリを開くまで
natsumi の返事にも知らせにも気づけない。ADR 0028 は、裏にいる間の通知（APNs）を範囲外としていた。
[ADR 0013](0013-read-state-on-the-server.md) も、特定の端末だけで目立たせる必要が出たら決め直すとしていた。

これまでの署名は無料の Apple ID だった。APNs の entitlement と、サーバーが APNs に送るための鍵（.p8）には、
有料の Apple Developer Program が要る。今回はそれを使う。

会話の中身は本人とサーバーの間のものである。APNs の payload は Apple のサーバーを通り、ロック画面にも出る。

## Decision

### 1. iPhone に、返事と知らせを通知する

- 通知するのは、natsumi の返事（`reply_to_mac`）と知らせ（`notify_owner`）である。本人のメッセージは通知しない。
- 承認は、まだサーバーに実装されていない（`approval.decide` は断る）。承認待ちの通知は、承認を実装する変更で足す。
  通知の種類は後から足せる形にしておく。
- Mac には送らない。Mac アプリは常駐していて、接続したまま知らせを出している。

### 2. その iPhone がつながっていなければ、送る

- 返事や知らせを記録したとき、登録のある端末のうち、いま接続していない端末へ送る。接続していれば、
  会話のイベントとして届くので送らない。
- Mac で見ていても iPhone は鳴る。本人が Mac で読んだり確かめたりしたら、iPhone の通知を片づける（5）。
  Mac で操作しているかどうか（`device.activity`）では絞らない。単純で、取りこぼしがないからである。
- 音はいつも標準の音にする。サーバーは時間帯を見ない。夜は iOS の集中モードや睡眠に任せる。

### 3. 本文は端末の公開鍵で暗号化し、端末で復号する

- iPhone は、通知のための P-256 の鍵ペアを作り、秘密鍵を Keychain に置く。アプリと Notification Service Extension は、
  Keychain の access group でこの秘密鍵を共有する。
- サーバーは、送るたびに一時的な鍵ペアを作り、次の手順で本文を暗号化する。
  - 一時的な秘密鍵と端末の公開鍵で ECDH を取る。
  - 鍵は HKDF-SHA256 で導く。salt は一時的な公開鍵と端末の公開鍵（どちらも X9.63 の非圧縮形式）をこの順につないだもの、
    info は `natsumi-push-v1`、長さは 32 バイトとする。
  - AES-256-GCM で暗号化する。nonce は 12 バイトの乱数、AAD は messageId とする。
  - 平文は `{ "text", "expression" }` の JSON とする。payload の 4KB に収まるよう、暗号化の前に本文を 1000 文字で切る。
- payload の中身は次のとおりとする。
  - `aps.alert`: 決まった文（タイトル「なつみ」、本文「返事があります」または「知らせがあります」）。
    復号に失敗したときは、この文がそのまま出る。
  - `aps.mutable-content`: 1
  - `aps.badge`、`aps.sound`: default
  - 平文のまま置くもの: `messageId`、`kind`（reply / notice）、`position`。どれも会話の中身ではなく、片づけに使う。
  - 暗号文: `e`。中身は `{ v: 1, epk, nonce, ct }` で、どれも base64 とする。
- Extension は `e` を復号し、本文とセリフの気持ちの顔で通知を書き換える。
- サーバーは端末の秘密を持たない。送るのに要るのは公開鍵だけである。

### 4. 登録は WebSocket の契約で行う

- v1 の契約に command `push.register` を足す。引数は `token`（APNs の device token）、`publicKey`（X9.63 の base64）、
  `environment`（`sandbox` または `production`）とする。
- iPhone は、`session.sync` の後、接続のたびに送る。token は変わり得るので、登録は冪等に上書きする。
- 登録は端末（deviceId）ごとに 1 つとし、SQLite の新しい migration で持つ。その端末のセッションが失効したり
  取り消されたりしたら、送らない。ログアウトもセッションの取り消しなので、同じく送らなくなる。
- `environment` で送り先（`api.sandbox.push.apple.com` か `api.push.apple.com`）を選ぶ。Debug で build したものは
  sandbox、配布したものは production になる。

### 5. バッジは未読の数にし、読んだら片づける

- バッジは、未読の返事の数と未確認の知らせの数の和とする。送るときに数えて `aps.badge` に入れる。
- 既読のカーソルが進んだとき（`conversation.read`）と、知らせを確かめたとき（`notification.acked`）は、
  つながっていない登録済みの端末に background push（`content-available`）を送る。中身はバッジの数、
  `readThroughPosition`、確認した notificationId である。
- アプリはこれを受けて、バッジを直す。さらに、届いている通知のうち、position がカーソル以下の返事と、
  確認済みの知らせを消す。
- background push は iOS が間引くので、確実には届かない。届かなかった分は、次にアプリを開いて同期したときに直す。
  アプリは前に戻ったとき、既読や確認の状態に合わせて、届いている通知とバッジを片づける。

### 6. 通知を押したら、メインの画面を開く

- 通知を押すとアプリが開き、いつもの規則で返事は吹き出しに、知らせは黄色いカードに出る。
- 通知から返事を書く操作や、確認のボタンは作らない。

### 7. サーバーは APNs に自分で送る

- `node:http2` で APNs に送る。依存は増やさない（ACME を自前で実装したのと同じ方針である）。
- 認証には token を使う。.p8 の鍵から ES256 の JWT を作り、50 分ごとに作り直す。
- config に `apns` を足す。中身は `teamId`、`keyId`、`topic`（アプリの bundle ID）、それに鍵の場所 `keyFile` か `keyEnv`
  （既存の SecretReference の形）である。`apns` がなければ通知は送らない。そのときも `push.register` は受け付けて記録する。
- 送れなかったときは、次のように扱う。
  - 5xx・429・接続の失敗は、メモリの中で間を空けて数回だけ送り直す。それでもだめなら log に残して諦める。
    サーバーが再起動すれば、送り直しの予定も消える。
  - `410 Unregistered` と `BadDeviceToken` は、その登録を消す。
  - 通知は、アプリを開かせる合図にすぎない。返事と知らせそのものは SQLite にあり、開けば同期で必ず読める。

### 8. 確かめ方

- サーバーは `node:test` で確かめる。対象は、JWT の生成、暗号化、送り先の選び方、送る payload、ローカルの HTTP/2 の偽の APNs への送信、
  送り直し、410 のときの登録の削除である。
- Node で作った暗号文を、`NatsumiCoreTests` の CryptoKit で復号する。そのための共通のテストベクタを置き、2 つの言語の間で暗号の手順がずれないようにする。
- 最後に、sandbox の APNs で実機に届くことを確かめる。

## Consequences

- 実機に入れるには、Push Notifications と Keychain Sharing の entitlement を付けた、有料のチームの署名が要る。
  ADR 0028 の「各自が自分のチームを選ぶ」は、通知を使うなら有料のチームに限られる。シミュレータは今までどおり動く。
- iPhone のアプリに、Notification Service Extension のターゲットが増える。
- Mac で読んでいても iPhone が鳴る。気になるようなら、`device.activity` を実装して絞る。
- 読んだ後の片づけは background push 頼みなので、アプリを開くまで、読んだはずの通知やバッジが残ることがある。
- 本文は Apple のサーバーを平文では通らない。ただし、通知があったこと、その時刻、返事か知らせかは Apple から見える。
- 送り直しはメモリの中だけなので、サーバーが落ちている間に出た返事の通知は届かないことがある。
- ADR 0028 の 4 の「裏にいる間の通知（APNs）は範囲外」は、この ADR で置き換える。
- ADR 0013 で未定のまま残していた「特定の端末だけで目立たせる」ことは、iPhone についてはこの ADR で決めた。
  配信先を 1 つに絞ることや lease、再配信は、引き続き作らない。

## 追記: サーバーの実装で決めた細部（2026-09-23）

決定を変えるものではなく、2 つの言語でそろえる必要のある細部を定める。形の全体は
[client-contract.md](../client-contract.md) の「iPhone への通知」にある。

- **tag の位置**: `ct` は AES-256-GCM の暗号文の後ろに 16 バイトの tag をつないだものとする。nonce は `ct` に含めない。
  CryptoKit の `AES.GCM.SealedBox(combined:)` には `nonce ‖ ct` を渡せばよい。
- **base64**: `epk`・`nonce`・`ct` と、`push.register` の `publicKey` は、どれも標準の base64（`+` `/`、詰め物あり）とする。
  Foundation の `Data(base64Encoded:)` と `base64EncodedString()` がそのまま使える。
- **`e` の形**: `e` は payload の中のオブジェクト `{ "v": 1, "epk", "nonce", "ct" }` で、`v` は数値である。
- **AAD と info**: AAD は messageId の UTF-8 のバイト列、info は ASCII の `natsumi-push-v1` とする。
- **平文**: `{ "text", "expression" }` の JSON で、気持ちを記録する前の古いセリフには `expression` が無い。
  本文は 1000 文字（コードポイント）で切り、切ったときは末尾を `…` にする。
- **4KB に収まらないとき**: 全角の文字は UTF-8 で 3〜4 バイトになるので、1000 文字でも payload が APNs の上限
  4096 バイトを超える。そのときは収まるまでさらに短く切る。3 の「4KB に収まるよう 1000 文字で切る」の目的を、そのまま満たすためである。
- **background push の中身**: `aps` は `content-available` だけにし、バッジの数（`badge`）・`readThroughPosition`・
  確認した `notificationId` は `aps` の外に置く。`kind` は `read` か `acked` とする。Apple は background の通知の `aps` に
  `content-available` だけを置くよう求めているためである。アプリがバッジを自分で直す。
- **token と登録**: device token は 16 進で受け、小文字にして持つ。1 つの token は 1 つの端末だけのものとし、
  別の端末が同じ token を登録したら前の登録を消す（入れ直したアプリが二重に鳴らないように）。
- **送り直し**: 既定では 5 秒・30 秒・2 分の後の 3 回で、同じ `apns-id` を使う。それ以外の 4xx は送り直さずに log に残す。
- **共通のテストベクタ**: `test/fixtures/push/vector-v1.json` に置く。実装とは別に WebCrypto で作り、Node のテストが
  実装での再現と WebCrypto での復号を確かめる。中の秘密鍵は、公開したラベルから作ったテスト専用の使い捨てである。
- **セッションの期限**: 4 の「セッションが失効したら送らない」は、期限切れも含む。セッションは最後に使ってから 30 日で切れ、
  接続するたびに延びる（[ADR 0030](0030-a-session-that-lasts-while-it-is-used.md)）。30 日以内に一度でも iPhone のアプリを開いて
  接続すれば通知は止まらない。30 日まったく開かないと止まり、次に開いてログインし直すと戻る。

## 追記: iPhone の実装で決めた細部（2026-09-23）

- **Extension**: Notification Service Extension は `NatsumiNotifications`。`NatsumiCore` を link せず、payload の読み方と復号と鍵の保存だけを
  `NatsumiPush/` にまとめて、`NatsumiCore` と Extension の両方で build する。
- **鍵の共有**: アプリの keychain-access-groups は、アプリ自身のグループを先頭に、共有グループ `io.github.yuanying.natsumi.shared` を 2 番目に置く。
  セッションのトークンは今までどおりアプリ自身のグループに残り、共有グループには通知の鍵だけを明示して置く。Extension は共有グループだけを持つ。
  鍵はロック中にも開けるよう、最初のロック解除の後に読めるものにする（この端末だけ）。
- **environment**: Debug かどうかではなく、署名の provisioning profile の `aps-environment` で決める。Xcode から入れたものは Release でも
  development になるためである。profile の無いもの（App Store）は production、シミュレータは sandbox とする。
- **許可**: ログインしているときだけ、通知の許可と device token を求める。許可が無くても token は求め、登録とバッジの片づけに使う。
- **気持ちの顔**: `icons/` の WebP は通知に添えられないので、Extension が PNG に書き出して添える。気持ちの無い古いセリフには neutral の顔を添える。
- **片づけ**: 同期している間は、未読の返事と未確認の知らせの ID に無い通知を消し、バッジをその数にする。background push では、
  `position` が `readThroughPosition` 以下の返事と、確認した知らせを消す。
