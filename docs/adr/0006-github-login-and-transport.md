# 0006. GitHub ログイン・セッション・HTTPS/WSS の待ち受け

- Date: 2026-09-14
- Status: Accepted（ACME による証明書の取得・更新と tcp 80 の例外を [0007](0007-acme-and-fixed-ipv6.md) で追加、セッションの寿命を「最後に使ってから 30 日」に延ばす形へ [0030](0030-a-session-that-lasts-while-it-is-used.md) で置き換え、平文の待ち受けを明示の設定で loopback 以外にも許す（Ingress の後ろに置くための例外）点は [ADR 0033](0033-running-on-kubernetes.md) で置き換え、ブラウザのダッシュボードに限り、ログインの状態を cookie（`HttpOnly`・`Secure`・`SameSite=Strict`・`Path=/dashboard`）に載せる例外と、ブラウザ向けの固定の戻り先 `/dashboard` を [ADR 0049](0049-a-read-only-dashboard-in-the-browser.md) で追加）

## Context

ADR 0002 で、Mac とサーバーの接続を HTTPS/WSS とし、GitHub 認証（state・PKCE・短期セッション）で
設定した単一アカウントだけを許可すると決めた。ADR 0005 の段階では認証がないため listener を開かなかった。
listener を開くにあたり、次を決める必要がある。

- TLS をどこで終端するか。平文の待ち受けを誤って外部に晒さない方法
- ブラウザを持たない Mac のネイティブアプリが、どうやって GitHub ログインの結果を受け取るか
- セッションの形式・保存・寿命・失効
- WebSocket の接続時に何を検証し、v1 envelope の入口で何を拒否するか

## Decision

### TLS の終端と待ち受け

TLS は Node 自身で終端する。証明書と鍵は `listen.tls` の `certFile` / `keyFile` で secret mount から読む。

- 1 つのコンテナで完結し、IPv6 で直接到達でき、サーバーまでの間に平文の区間がない。
  リバースプロキシを別コンテナに置くと、プロキシからサーバーまでが bridge ネットワーク上の平文になる。
- 平文（`tls: false`）は、待ち受けアドレスが loopback（`127.0.0.0/8`・`::1`・`localhost`）のときだけ受け付ける。
  同じホストのリバースプロキシで TLS を終端する構成のための、明示的な例外である。
  それ以外のアドレスで `tls: false` を指定するか `tls` を省略すると、設定エラーとして起動を止める。
- 待ち受けアドレスは IP アドレスか `localhost` とする。`::` を指定すると IPv4 と IPv6 の両方で待ち受ける。
- クライアントが使う URL を `publicOrigin` に設定する。https に限り、http は loopback のホストだけ許す。
- 証明書の更新は再起動で反映する。ホットリロードは実装しない。
- TLS 1.2 以上とし、HTTPS の応答には HSTS を付ける。応答はすべて `Cache-Control: no-store` とする。

### GitHub OAuth

サーバーを GitHub OAuth App のクライアントとし、client secret はサーバーだけが持つ（`clientSecretEnv` か `clientSecretFile`）。

- 認可要求には、サーバーが生成した state（256 ビット）と PKCE（S256）を付ける。
  state は 1 回だけ使え、10 分で期限が切れる。callback では state を先に消費してから検証するため、
  同じ callback の再送は state 不一致として拒否する。
- callback URL は `publicOrigin` に固定のパス `/auth/github/callback` を付けたものに限る。
- scope は要求しない。得たアクセストークンは `/user` から数値 ID を読むためだけに使い、保存しない。
- 許可はアカウントの数値 ID（`github.allowedUserId`）1 つとの一致で判定する。ログイン名は判定に使わない。
  ログイン名は変更や再取得が可能で、別人を指し得るためである。
- 上流のエラー本文やアカウント情報は、応答にもログにも含めない。クライアントには固定のエラーコードだけを返す。
- ログイン途中の状態はメモリに置く。再起動すると進行中のログインは無効になり、やり直せばよい。
  同時に保持する件数には上限を設ける。

### Mac アプリのログイン方法

`ASWebAuthenticationSession` と、カスタム URL scheme の callback `natsumi://oauth/callback` を使う。
アプリ自身も PKCE を行う（RFC 8252 の、ネイティブアプリの OAuth と同じ形）。

1. アプリが verifier を生成し、その S256 challenge とアプリの state を付けて `/auth/github/start` を開く。
2. サーバーが GitHub での認可・code の交換・数値 ID の照合を行い、成功すれば 60 秒で期限の切れる 1 回限りの
   login code を付けて `natsumi://oauth/callback` に redirect する。失敗の場合は `error` にコードを付ける。
3. アプリは login code と verifier を `/auth/session` に送り、セッションを受け取る。

カスタム URL scheme は他のアプリに横取りされ得るため、redirect ではセッションを渡さない。
login code を奪われても、verifier を持たなければセッションに交換できない。
verifier の照合に失敗した login code も、その時点で使えなくする。
redirect 先はコードに固定し、設定にもリクエストにも依存させない。open redirect にしないためである。

loopback redirect（アプリがローカルのポートで待つ方式）は採らない。GitHub OAuth App に登録できる
callback はサーバーのものなので、結局サーバーの callback を経由する必要がある。
そのうえで Mac 側にもポートの待ち受け・ファイアウォール・サンドボックスの扱いが加わるからである。
`ASWebAuthenticationSession` は macOS 標準で、GitHub にログイン済みならブラウザの Cookie によって
ほぼ操作なしで完了する。

### セッション

- セッションは 256 ビットの乱数から作る bearer token とし、`Authorization: Bearer` で送る。
  Cookie は使わない。ブラウザが自動で付けないため、CSRF や、別サイトから WebSocket を張られる攻撃の余地が小さい。
- SQLite の `client_sessions` にはトークンの SHA-256 だけを保存し、平文は保存しない。
  DB の複製からセッションを再利用されないためである。
- 寿命は 12 時間とし、refresh は持たない。切れたら再ログインする。
- ログアウトで失効させ、そのセッションで開いている WebSocket を閉じる（close code 1008）。
  期限切れの接続も定期的に閉じる。
- 検証のたびに、保存した数値 ID が現在の `allowedUserId` と一致するかを確かめる。
  設定で許可するアカウントを変えると、それ以前のセッションは使えなくなる。

### WebSocket の接続と v1 envelope の入口

- WebSocket は `/v1/ws` だけで受け付ける。upgrade の時点でパス、Origin、セッションの順に検証し、
  失敗したら握手をせず、HTTP の 404 / 403 / 401 を返して切断する。
- Origin ヘッダーがある場合は `publicOrigin` と完全に一致しなければ拒否する。ない場合はネイティブクライアントとして許可する。
  ブラウザは必ず Origin を付けるうえ、ブラウザの WebSocket API では Authorization ヘッダーを付けられない。
- 受信したメッセージごとに `v` を確認し、1 以外なら `command.rejected`（`unsupported-version`）を送って close code 1002 で閉じる。
  JSON のオブジェクトでなければ `invalid-envelope` を送って 1007 で閉じる。1 メッセージは 64 KiB までとする。
- 未知の `type` は応答せずに無視する。契約にある command は未実装のため、`command.rejected`（`not-implemented`）を返す。
- `deviceId` は認証に使わない。
- 端末の登録は後続の実装で入る。それまでは接続ごとに新しい `streamId` を発行する。
  クライアントから見ると再接続のたびに stream が変わるので、client-contract の既存の規則どおり snapshot を要求することになる。
- WebSocket のプロトコル処理には `ws` パッケージを使う。Node にはサーバー側の実装がなく、
  RFC 6455 のフレーム処理を自作するより、広く使われている実装に任せる方が安全である。

### コンテナ

- コンテナは 8443 番で待ち受け、Compose でポートを公開する。
- 証明書・鍵・GitHub client secret は Compose の file secrets として `/run/secrets` にマウントし、設定の `...File` から参照する。

これにより、ADR 0005 の「ネットワークの listener は開かない」「ポートは公開しない」を置き換える。

## Consequences

- 証明書を更新したら、サーバーの再起動が必要になる。
- Mac アプリは URL scheme `natsumi` の登録、`ASWebAuthenticationSession`、verifier の生成と保持を実装する。
  セッショントークンは Keychain に保存し、12 時間で切れたら再ログインする。
- 12 時間ごとの再ログインが煩わしければ、後で寿命や refresh を見直す。その場合も平文のトークンを DB に保存しない。
- 実際の GitHub との疎通は、GitHub OAuth App を作ってからユーザーの操作で確認する。
  自動テストは GitHub を模したローカルのサーバーで行う。
- IPv6 でのポート公開は Docker daemon の IPv6 設定に依存する。
- ログインのレート制限や WebSocket の ping による死活監視は、まだ実装していない。
- Compose の file secrets はホストのファイル権限のままマウントされるため、コンテナの `node` ユーザー（UID 1000）が読める権限にする必要がある。
