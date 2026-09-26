# 権限と秘密の一覧

natsumi のサーバーが外に対して持つ権限・秘密・外への出口と、サーバーが受け付ける認証を 1 か所にまとめます。
設定の書き方と手順は README の各節にあり、ここはその索引です。項目を足すとき（新しい秘密の参照、新しい接続先、新しい受け口）は、この一覧も直します。

- Slack の scope とイベントは [Slack App の作り方](slack-app.md) が正です。ここでは要約だけを書きます。
- 本番（Kubernetes）での置き場所（Secret の名前、ServiceAccount、出口の許可リストのファイル）は、環境のリポジトリの文書を見てください。
  この公開のリポジトリには書きません（[ADR 0034](adr/0034-an-allow-list-for-the-way-out.md)）。
- 表の中のホスト名のうち、設定の値で決まるものは「`pi.routes.<名前>.compatible.baseUrl` のホスト」のように設定のキーで書きます。
- モデルの経路を `pi.routes` に並べたとき（[ADR 0046](adr/0046-named-model-routes-switched-by-hand.md)）は、経路ごとに下の行のどちらかに当たります。
  `pi.model` だけの設定では、`pi.routes.<名前>.` を `pi.` と読み替えます。
  出口の許可リストには、切り替えて使う経路の接続先をすべて入れておきます。

## 秘密の渡し方

- 秘密は設定ファイルに書きません。`...Env`（環境変数の名前）か `...File`（secret mount の絶対パス）で指します。
  例外は `a2a.tokenFile` で、ファイルだけを受け付けます（呼ぶたびに読み直すため）。
- 設定の中に秘密らしいキー（`secret`・`token`・`apiKey` など）に値が直接書いてあったり、token の形の値（`xoxb-`、`ghp_`、PEM など）があれば、起動を止めます。
- 参照した秘密は、起動時に読みます（`a2a.tokenFile` と、思考ループのモデルの認証・API キーを除く）。読めなければ、その設定の名前だけを示して起動を止めます。変数名・パス・値はエラーにもログにも出しません。
- 秘密は natsumi のコンテナにだけ渡します。作業環境（natsumi-workspace）には、秘密も、SQLite も、Pi の状態領域も見せません（[ADR 0019](adr/0019-a-workspace-not-a-memory-tool.md)、[ADR 0033](adr/0033-running-on-kubernetes.md)）。

## 外へ出るもの

なつみのサーバーが外へつなぐ先と、そのとき使う権限です。どれも HTTPS（APNs は HTTP/2、Slack の Socket Mode は WSS）です。
このほかに名前解決（DNS）が要ります。

| 機能と相手 | 権限の中身 | 設定のキー | 出口 | 無いとき | ADR |
| --- | --- | --- | --- | --- | --- |
| 思考ループのモデル（Pi のサブスクリプション。例: ChatGPT Plus の `openai-codex`） | 本人が専用の Pi 領域で `/login` した OAuth の credential。置き場所は `pi.authPath`（`<pi.agentDirectory>/auth.json` にしておくと、Pi の CLI のログインがそこに書きます）。Pi が通常の refresh でそのファイルを更新します。サーバーはこのファイルを作りません | `pi.routes.<名前>.model.provider`、`pi.authPath`（秘密: credential のファイル。Pi の状態領域に置き、設定にはパスだけ） | provider の接続先（Pi の SDK が決めます。`openai-codex` なら OpenAI の接続先） | その経路は使える状態になりません。選んでも移らず、選ばれたまま起動すると natsumi は話せません。API キーや別の経路に切り替えません。起動したときにファイルが無ければ、ログインしたあとに起動し直すまで使えません | [0004](adr/0004-pi-tool-and-voice-boundaries.md)、[0046](adr/0046-named-model-routes-switched-by-hand.md) |
| 思考ループのモデル（本人が動かす OpenAI 互換のエンドポイント） | エンドポイントの API キー（`Authorization: Bearer`）。経路ごとに別のキーを指せ、キーはその経路の接続先にしか送りません | `pi.routes.<名前>.model.provider` = `natsumi-compatible`（または `natsumi-compatible-<何か>`）、`pi.routes.<名前>.compatible.baseUrl`、`pi.routes.<名前>.compatible.apiKeyEnv` / `apiKeyFile`（秘密） | `pi.routes.<名前>.compatible.baseUrl` のホスト（https。http は loopback だけ） | 同上。キーは起動時ではなく、思考ループがモデルの runtime を作るときに読みます。差し替えは再起動で効きます | [0004](adr/0004-pi-tool-and-voice-boundaries.md)、[0046](adr/0046-named-model-routes-switched-by-hand.md) |
| Mac・iPhone のログイン（GitHub） | GitHub の OAuth App。scope は要求しません。GitHub のアクセストークンは数値 ID の確認にだけ使い、保存しません。入れるのは `allowedUserId` の 1 人だけです | `github.clientId`、`github.clientSecretEnv` / `clientSecretFile`（秘密）、`github.callbackUrl`、`github.allowedUserId` | `github.com`（code の交換）、`api.github.com`（数値 ID の取得） | `github` は必須です。無い・secret が読めないと起動を止めます | [0002](adr/0002-client-events-and-approvals.md)、[0006](adr/0006-github-login-and-transport.md) |
| iPhone への通知（APNs） | APNs の token 認証の鍵（.p8、P-256）。サーバーが JWT を作ります（発行者はチームの ID、`kid` は鍵の ID）。`apns-topic` はアプリの bundle ID です | `apns.teamId`、`apns.keyId`、`apns.topic`、`apns.keyEnv` / `keyFile`（秘密） | `api.push.apple.com`（配布したアプリ）、`api.sandbox.push.apple.com`（開発用に署名したアプリ）。iPhone が登録した環境で決まります | `apns` が無ければ送りません（iPhone の登録は受け付けて記録します）。`apns` があって鍵が読めない・P-256 でなければ起動を止めます | [0029](adr/0029-push-notifications-on-the-iphone.md) |
| 外のエージェントに頼む（A2A） | 呼び出しの token（相手が確かめる ServiceAccount の token、audience `a2a`）。Kubernetes では Pod に差し込まれる projected token です。token は `a2a.agents` の URL にだけ送り、Agent Card は token なしで取ります | `a2a.tokenFile`（秘密。ファイルだけ）、`a2a.agents.<名前>.url` | 各 `a2a.agents.<名前>.url` のホスト（https。http は loopback だけ） | `a2a` が無ければ `ask_agent` は頼まずに断ります。token が読めなければ、その呼び出しは何も送らずに失敗します | [0025](adr/0025-talking-to-outside-agents-over-a2a.md)、[0033](adr/0033-running-on-kubernetes.md)、[0035](adr/0035-asking-outside-agents-and-hearing-back.md)、[0036](adr/0036-a-manual-to-read-and-a-limit-on-waiting.md) |
| Slack を受け取る | ワークスペースごとの bot token（`xoxb-`）と app-level token（`xapp-`、`connections:write`）。bot の scope は発言・チャンネル・DM・利用者・添付・リアクションを読むもの、メンションの受け取り、👀 を付ける `reactions:write` です（下の「Slack の scope」） | `slack.workspaces.<名前>.botTokenEnv` / `botTokenFile`、`appTokenEnv` / `appTokenFile`（どれも秘密） | `slack.com`（Web API と Socket Mode の接続先の取得）、Socket Mode の WebSocket（`wss-primary.slack.com` など、Slack が接続のたびに返すホスト）、`files.slack.com`（添付の画像。bot token を付けて取ります） | `slack` が無ければ Slack にはつなぎません。token の参照が読めなければ起動を止めます。token が違う・App の設定が足りないと、そのワークスペースだけ `could not start` をログに出して動きません。`reactions:read` とリアクションのイベントが無ければ、リアクションは埋め直しで取れた分だけがファイルに書かれます | [0012](adr/0012-slack-and-colleagues.md)、[0039](adr/0039-slack-as-files-and-a-scored-dove.md)、[0043](adr/0043-reactions-in-the-channel-files.md) |
| Slack に投稿する（ポッポさん） | 上と同じ bot token。`chat:write`、`chat:write.customize`（表情のアイコン）、`reactions:write`、`emoji:read`（カスタム絵文字の一覧）、`files:write`（画像の投稿） | 上と同じ。画像の大きさと枚数の上限は `slack.postImages` | `slack.com`。画像の中身は、Slack が `files.getUploadURLExternal` で返すアップロード先（`files.slack.com`）へ送ります。そこへは bot token を付けません。アイコンは Slack が `/avatar/<表情>.png` を取りに来ます（下の「入ってくるもの」） | `emoji:read` が無ければ標準の絵文字だけで確かめます。`chat:write.customize` が無ければ bot の既定のアイコンになります。`files:write` が無ければ画像付きの投稿は届きません | [0040](adr/0040-the-dove-sends-what-the-judge-passes.md)、[0041](adr/0041-approving-slack-posts-on-the-iphone.md)、[0042](adr/0042-any-emoji-that-exists.md)、[0044](adr/0044-drawing-with-sdctl-and-posting-images.md) |
| ポッポさんの判定（`logprobs`） | OpenAI 互換のエンドポイントの API キー（任意）。下書きと返信先の周りの発言を送ります。書かなければ既定の経路（`pi.defaultRoute`）の互換の接続先・キー・モデルを使い回し、pi のキーは pi の接続先にしか送りません。経路を切り替えても変わりません | `slack.judge.method`、`slack.judge.baseUrl`、`slack.judge.apiKeyEnv` / `apiKeyFile`（秘密）、`slack.judge.model` | `slack.judge.baseUrl` のホスト（書かなければ既定の経路の `compatible.baseUrl` のホスト）。キーを送るなら https（http は loopback だけ） | 判定する相手が無ければ、すべての下書きが本人の承認に回ります。キーの参照（pi から借りたものを含む）が読めなければ起動を止めます | [0040](adr/0040-the-dove-sends-what-the-judge-passes.md)、[0046](adr/0046-named-model-routes-switched-by-hand.md) |
| ポッポさんの判定（`jev`） | TypeSafe AI の Jev の API キー（任意）。下書きと返信先の周りの発言を送ります | `slack.judge.method` = `jev`、`slack.judge.baseUrl`、`slack.judge.apiKeyEnv` / `apiKeyFile`（秘密） | `api.typesafe.ai`（既定）か `slack.judge.baseUrl` のホスト | 同上 | [0040](adr/0040-the-dove-sends-what-the-judge-passes.md) |
| 証明書の取得（ACME） | サーバーが作る ACME のアカウント鍵。CA の利用規約に同意して登録します | `listen.tls.acme.directoryUrl`、`listen.tls.acme.contactEmail`、`listen.tls.acme.httpPort` | `listen.tls.acme.directoryUrl` のホスト（既定 `acme-v02.api.letsencrypt.org`） | `acme` を使わないなら要りません（証明書ファイルか、手前のプロキシで TLS を終端）。取得できるまで HTTPS の待ち受けを開きません | [0007](adr/0007-acme-and-fixed-ipv6.md)、[0033](adr/0033-running-on-kubernetes.md) |

サーバーは記憶の git を push しません（push するのは本人です）。Google などほかの外部サービスには、今はつなぎません。

### Slack の scope

正は [Slack App の作り方](slack-app.md) です（すべての scope とイベントを入れたマニフェストもそこにあります）。要約すると次のとおりです。

- app-level token: `connections:write`（Socket Mode）。
- bot の scope: 読むもの（`channels:history`・`groups:history`・`im:history`、`channels:read`・`groups:read`・`im:read`、`users:read`、`files:read`、`reactions:read`、`app_mentions:read`）、
  書くもの（`reactions:write`、`chat:write`、`chat:write.customize`、`files:write`）、`emoji:read`。
- イベント: `message.channels`・`message.groups`・`message.im`・`app_mention`・`reaction_added`・`reaction_removed`。
- user token は使いません。bot は招待されたチャンネルだけを読みます。

## 秘密のうち、サーバーが自分で持つもの

設定で指すものとは別に、サーバーが作り、data directory と Pi の状態領域に置く秘密があります。バックアップには含めますが、公開の場所には置きません。

| もの | 置き場所 | 中身 | ADR |
| --- | --- | --- | --- |
| Pi の認証 | `pi.authPath` | モデルの OAuth の credential。Pi が refresh で書き換えます | [0004](adr/0004-pi-tool-and-voice-boundaries.md) |
| ACME のアカウント鍵と証明書の鍵 | data directory の `.natsumi/acme/`（ディレクトリ 0700、ファイル 0600） | `acme` を使うときだけ | [0007](adr/0007-acme-and-fixed-ipv6.md) |
| ログインのセッション | `.natsumi/state.sqlite` | bearer token の SHA-256 だけを持ちます。token そのものは持ちません | [0006](adr/0006-github-login-and-transport.md)、[0030](adr/0030-a-session-that-lasts-while-it-is-used.md) |
| なつみが渡した画像の写し | data directory の `.natsumi/images/`（ディレクトリ 0700、ファイル 0600）と `.natsumi/state.sqlite` | ポッポさんへの依頼と `reply_to_mac` の `images` で `/work` から写し取った画像。承認に見せ、Slack に送り、会話の返事で本人に見せるのはこれです。会話と同じく消しません。作業環境からは見えません | [0044](adr/0044-drawing-with-sdctl-and-posting-images.md)・[0045](adr/0045-showing-the-owner-images-with-a-reply.md) |
| iPhone の device token | `.natsumi/state.sqlite` | APNs に送る宛先。ログには出しません | [0029](adr/0029-push-notifications-on-the-iphone.md) |
| TLS の鍵（ファイルで渡すとき） | `listen.tls.keyFile` | 読めないと起動を止めます。Ingress の後ろでは要りません | [0006](adr/0006-github-login-and-transport.md)、[0033](adr/0033-running-on-kubernetes.md) |

## 入ってくるもの

なつみのサーバーが受け付ける口と、そこでの認証です。ここに無い道は 404 を返します。

| 口 | 相手 | 認証 | 返すもの | ADR |
| --- | --- | --- | --- | --- |
| `GET /auth/github/start` | Mac・iPhone のアプリ（ブラウザの画面） | なし。アプリの state と PKCE の challenge を受け取り、サーバーの state（1 回限り、10 分）と PKCE を付けて GitHub へ送ります | GitHub の認可画面への redirect | [0006](adr/0006-github-login-and-transport.md) |
| `GET /auth/github/callback` | GitHub から戻るブラウザ | サーバーの state。code を交換し、数値 ID が `github.allowedUserId` と一致するときだけ通します | 60 秒で切れる 1 回限りの login code を付けた、アプリの URL scheme への redirect | [0002](adr/0002-client-events-and-approvals.md)、[0006](adr/0006-github-login-and-transport.md) |
| `POST /auth/session` | アプリ | login code と PKCE の verifier | セッション（256 ビットの bearer token。最後に使ってから 30 日で切れ、使うたびに延びます） | [0006](adr/0006-github-login-and-transport.md)、[0030](adr/0030-a-session-that-lasts-while-it-is-used.md) |
| `POST /auth/logout` | アプリ | bearer token | セッションを失効させ、そのセッションの WebSocket を閉じます | [0006](adr/0006-github-login-and-transport.md) |
| `/v1/ws`（WebSocket） | アプリ | bearer token（`allowedUserId` のセッションだけ）。Origin があれば `publicOrigin` と一致すること | 会話、承認、iPhone の通知の登録。つなぐたびにセッションが延びます | [0006](adr/0006-github-login-and-transport.md)、[0029](adr/0029-push-notifications-on-the-iphone.md)、[0041](adr/0041-approving-slack-posts-on-the-iphone.md) |
| `GET /v1/images/<imageId>` | アプリ | bearer token（`allowedUserId` のセッションだけ）。セッションを確かめてから画像を探します | サーバーが写し取った画像（承認待ちの `images` の画像）。使うたびにセッションが延びます | [0044](adr/0044-drawing-with-sdctl-and-posting-images.md) |
| `GET /avatar/<表情>.png` | Slack（投稿のアイコンを取りに来る） | なし | 同梱の表情の画像だけ | [0040](adr/0040-the-dove-sends-what-the-judge-passes.md) |
| ACME の HTTP-01（`listen.tls.acme.httpPort`、既定 80） | CA | なし | 発行中の challenge への応答（`/.well-known/acme-challenge/`）と、`publicOrigin` の https への redirect だけ。ログイン・API・WebSocket にはつながりません | [0007](adr/0007-acme-and-fixed-ipv6.md) |

Slack は Socket Mode で natsumi から外へつなぐので、Slack から届く公開の入口はありません。外のエージェントの返事も、サーバーが取りに行きます。

## 作業環境

作業環境（natsumi-workspace）は、秘密を持たず、外へ出られません。サーバーとは Unix ソケットの runner だけでつながり、つなぐのはサーバーの側です
（[ADR 0019](adr/0019-a-workspace-not-a-memory-tool.md)、[ADR 0034](adr/0034-an-allow-list-for-the-way-out.md)）。
Docker では `network_mode: none`、Kubernetes では作業環境の UID の外向きを全部拒否します。

なつみのツールのうち作業環境に届くのは `run_shell` と `read` の 2 つで、どちらもこの runner を通ります（[ADR 0047](adr/0047-folding-ended-turns-with-a-memo.md)）。
`read` は Pi の組み込みの read ですが、読む手段を runner に差し替え、`/manual` と `/memory` の下だけを読みます。
サーバーのコンテナのファイル（ログインのファイルや secret）は、どちらからも見えません。Pi の組み込みの bash・edit・write・grep・find・ls は有効にしません。

例外は画像の生成です（[ADR 0044](adr/0044-drawing-with-sdctl-and-posting-images.md)）。

- 作業環境の sdctl は、image の `/etc/sdctl/config.yaml` の指す loopback の中継（`127.0.0.1:17860`、同じ Pod の出口の proxy）にだけ、平文の HTTP で話します。名前解決は要りません。
- 中継は行き先の画像生成サーバーを 1 つに固定し、TLS の証明書を確かめ、`Authorization: Bearer` の token を付けて送ります。
  通すのは生成（txt2img・img2img）、進み具合、一覧の GET と設定の読み取り（GET options）だけで、設定の書き換え（POST options）は断ります。
- **token は中継（proxy のコンテナ）だけが持ちます。** 作業環境にも natsumi のサーバーにも渡しません。なつみは中継の通す API の外で、画像生成サーバーやその前の認証を使えません。
- 中継・token と、コンテナのシェル向けの `SDCTL_URL` は環境の設定（公開しないリポジトリ）にあります。Docker（`compose.yaml`）の作業環境には中継が無いので、sdctl はつながらずに失敗します。
