# 0065. ブラウザにも Web Push で通知を届ける

- Date: 2026-10-01
- Status: Accepted

## Context

[ADR 0058](0058-settings-and-chat-in-the-browser.md) は、ブラウザを「開いている間だけの端末」とし、通知（Web Push）を送らないと決めた。
cookie でつないだ接続からの `push.register` は `invalid-request` で断っている。

手元の事情は次のとおりである。

- Mac のアプリはデスクトップに常駐していて、接続したまま知らせを出す。iPhone のアプリは裏に回ると接続を切り、その間は APNs で知らせる（[ADR 0029](0029-push-notifications-on-the-iphone.md)）。
- Android や Linux を使う人には、なつみのアプリが無い。ブラウザを閉じると、次に開くまで返事にも知らせにも気づけない。
  ブラウザの Web Push は、Android の Chrome、Linux の Chrome・Firefox で、ページを閉じていても届く。
- 送り先を決める規則（登録があり、そのセッションが生きていて、いまつながっていない端末に送る）は端末ごとで、ブラウザも deviceId を持つ 1 台の端末である。
- APNs には `node:http2` と `node:crypto` で自分で送っている。依存は増やさない方針である（ADR 0029 の 7）。

## Decision

### 送るものと時は、iPhone の alert と同じにする

- 送るのは、natsumi の返事（kind: reply）と知らせ（kind: notice）、承認待ち（`approval.pending`）である。本人のメッセージは送らない。
- 送り先は、Web Push の購読があり、その端末が最後に同期したセッションが生きていて、いまつながっていない端末である。iPhone の登録と同じ規則で、同じ問い合わせの形を使う。
  ブラウザのタブが開いていてつながっていれば、会話のイベントで届くので送らない。
- iPhone の background push（既読のカーソル・知らせの確認・承認が閉じた）に当たるものは送らない。ブラウザは、届いた push をすべて通知として見せる約束（`userVisibleOnly`）でしか購読できないからである。
- 送り先の endpoint は、ログインした本人（`allowedUserId`）の接続からしか登録できない。サーバーは https であることだけを確かめ、宛先のホストは絞らない。redirect は追わない。
- 1 回だけ送る。送り直しはしない。返事と知らせは会話に残っていて、開けば同期で読める。
- push service が 404 か 410 を返したら、その購読を消す。ほかの失敗は log に残すだけにする。log には端末の ID と HTTP の status だけを出し、本文と endpoint は出さない（endpoint はそれだけで送り先になる）。

### 中身は、ブラウザの鍵で暗号化して、本文ごと載せる

- 本文は Web Push の決まり（RFC 8291、`aes128gcm`）で、購読の公開鍵（`p256dh`）と auth secret で暗号化する。push service は中身を読めない。
- 平文は `{ "title", "tag", "text", "expression", "icon" }` の JSON とする。
  - `title` はアバターの表示名（ADR 0057）、`tag` は messageId か approvalId である（同じ行の通知は 1 つにまとまる）。
  - `text`・`expression`・`icon` は、iPhone の通知が復号して出すものと同じである。本文は 1000 文字で切り、画像があれば末尾に「（画像 N 枚）」を付け、顔は `<publicOrigin>/avatar/<表情>.png` を指す。
  - 承認待ちは `text` を「承認待ちがあります（チャンネル）」と下書きの改行つなぎとし、`expression` と `icon` を持たない。
  - 1 つの record（4096 バイト）に収まらなければ、本文をさらに短く切る。
- iPhone のように決まった文を先に見せる必要はない。Web Push は service worker が復号済みの中身を受け取ってから通知を出すからである。

### VAPID の鍵はサーバーが作り、data directory に置く

- push service への認証は VAPID（RFC 8292）とする。サーバーは初めての起動で P-256 の鍵ペアを作り、`.natsumi/web-push-key.pem`（0600）に置く。ACME のアカウント鍵と同じ扱いである。
  読めない鍵があれば、作り直さずに起動を止める。作り直すと、今までの購読がすべて無効になるからである。
- config には何も足さない。鍵はこのサーバーのもので、外の誰かと分け合うものではないからである。
- JWT の `aud` は endpoint のオリジン、`exp` は 12 時間後、`sub` は `publicOrigin` とする。送るたびに作る。
  Apple の push service は https でない、または localhost の `sub` を 403 で断るので、http の `publicOrigin` で動かす開発の環境では Safari に届かない。
- 公開鍵は、ログインした後の `/`・`/settings` のページに `<meta name="natsumi-push-key">` として載せる。ページの JS がそれで購読する。

### 登録は `push.register` を広げて行う

- ブラウザ（cookie の接続）は、`push.register` に `{ "subscription": { "endpoint", "keys": { "p256dh", "auth" } } }` を送る。`PushSubscription.toJSON()` の形のままである。
  受け付けると `command.accepted`（中身なし）が返る。endpoint が https でない、鍵の形が合わないときは `invalid-request` である。
- cookie の接続からの APNs の登録（`token`・`publicKey`・`environment`）は、今までどおり断る。bearer の接続（Mac・iPhone）からの `subscription` も断る。
- 購読は端末ごとに 1 つとし、新しい migration の表 `web_push_subscriptions` に持つ。同じ endpoint を別の端末が登録したら、前の端末の購読を消す（localStorage を消して deviceId が変わったブラウザ）。
- ブラウザは、iPhone と同じく同期のたびに購読を送り直す。
- 解除のコマンドは足さない。ブラウザで購読を止めると push service がその endpoint に 404 か 410 を返すので、次に送ったときにサーバーが消す。ログアウトとセッションの期限切れでも送らなくなる。

### ブラウザの側

- 設定の画面（`/settings`）の先頭に「このブラウザへの通知」を置き、「通知を受け取る」「通知を止める」で切り替える。受け取るときに、ブラウザの通知の許可を求める。
  ブラウザが Web Push を持たない、またはページに鍵が無いときは、使えない旨だけを出す。
- service worker は JS の束の `/app/sw.js` とし、scope は `/` とする。サーバーはこのファイルにだけ `Service-Worker-Allowed: /` を付ける。
  届いた push を通知として出し、押されたら開いているなつみのタブを前に出すか、無ければ `/` を開く。
- Web App Manifest を `/app/manifest.webmanifest` で配る。名前はアバターの表示名、アイコンはアバターの neutral の顔（`/avatar/neutral.png`）である。ログインは要らない（どちらもすでに公開している）。

退けた案:

- **`web-push` の npm を使う**: VAPID の JWT と aes128gcm は、`node:crypto` で 100 行ほどで書ける。APNs と同じく依存を増やさない。手順の正しさは、RFC 8291 の付録の例をバイト単位で再現するテストで確かめる。
- **公開鍵を `session.snapshot` に載せる**: 契約の型とアプリの読み方に手が入る。使うのはブラウザだけで、ページはログインした後にしか返らないので、ページに載せれば足りる。
- **`push.unregister` を足す**: 購読を止めたブラウザは push service が 404・410 で知らせてくれる。止めた後に 1 回送って消える分の無駄より、コマンドを増やさない方を取る。

### ADR との関係

- ADR 0058
  - 改める: 「ブラウザには通知（Web Push）を送らない」と「cookie でつないだ接続からの `push.register` は断る」を、この ADR の Web Push と、`subscription` だけを受け付ける形に改める。
  - 保つ: 「つながっている端末には送らない」の判定は端末ごとで、ブラウザがつながっていても iPhone への通知は止まらない。これは今までどおりテストで固定する。
- ADR 0029
  - 保つ: iPhone への通知の中身、送り直し、410 のときの削除。APNs の登録の形は変えない。
  - 追加: 送り先を決める規則（登録・生きているセッション・いまつながっていない）を、ブラウザの購読にも使う。

## Consequences

- Android・Linux の本人は、ブラウザで一度「通知を受け取る」を押せば、ブラウザを閉じていても返事・知らせ・承認待ちに気づける。
- 本文は push service（Chrome なら Google、Firefox なら Mozilla）を暗号化されたまま通る。通知があったこと、その時刻と大きさは push service から見える。
- iOS・iPadOS の Safari は、ホーム画面に追加したときだけ Web Push を持つ。iPhone はアプリを使う前提なので、これを目当てにはしない。
- 読んだ後の片づけ（background push に当たるもの）は無いので、Mac で読んだ返事の通知もブラウザには残る。気になるようなら、通知を開いたときにページの側で片づけることを考える。
- 送り直しが無いので、push service が一時的に落ちていると、その間の通知は届かない。
- data directory に `.natsumi/web-push-key.pem` が増える。消すと次の起動で別の鍵が作られ、今までの購読への push は push service に 401 か 403 で断られる。
  サーバーはこれを購読が無くなったとは見ないので、購読は残り、届かないまま送り続ける。
  ブラウザは、ページを開いたときに購読の鍵（`applicationServerKey`）とページの鍵を比べ、違えば購読を止めて、通知が許可されていれば今の鍵で購読し直して登録する（許可が無ければ「off」と出す）。
  つまり、鍵を作り直した後は、各ブラウザでなつみを 1 度開くまで通知が届かない。
- タブを開いたまま裏に回している（見えていない）ブラウザも、つながっている端末なので push は送らない。会話のイベントはそのタブに届いている。
- [権限と秘密の一覧](../permissions.md)に、VAPID の鍵、購読、push service への送信を足した。
