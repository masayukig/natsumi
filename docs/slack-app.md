# Slack App の作り方

natsumi は、ワークスペースごとに専用の Slack App（bot）を持ちます（[ADR 0039](adr/0039-slack-as-files-and-a-scored-dove.md)）。
ここでは、受け取りに要る App を 1 つのワークスペースに作る手順を書きます。ワークスペースが複数あるなら、それぞれで繰り返します。
Slack の画面の名前は変わることがあります。見当たらないときは、同じ役割の項目を探してください。

## マニフェストでまとめて作る

下の 1〜4 の設定（表示名、Socket Mode、bot の scope、イベント、DM を受け取る Messages Tab）は、App のマニフェストでまとめて入れられます。

1. <https://api.slack.com/apps> で「Create New App」→「From a manifest」を選び、入れるワークスペースを選びます。
2. YAML のタブに、次のマニフェストを貼ります。`name` と `display_name` は好みに変えてかまいません。

   ```yaml
   display_information:
     name: natsumi
   features:
     bot_user:
       display_name: natsumi
       always_online: true
     app_home:
       messages_tab_enabled: true
       messages_tab_read_only_enabled: false
   oauth_config:
     scopes:
       bot:
         - channels:history
         - groups:history
         - im:history
         - channels:read
         - groups:read
         - im:read
         - users:read
         - files:read
         - reactions:write
         - reactions:read
         - app_mentions:read
         - chat:write
         - chat:write.customize
         - emoji:read
         - files:write
   settings:
     event_subscriptions:
       bot_events:
         - message.channels
         - message.groups
         - message.im
         - app_mention
         - reaction_added
         - reaction_removed
     org_deploy_enabled: false
     socket_mode_enabled: true
     token_rotation_enabled: false
   ```

3. app-level token はマニフェストでは作れません。「Basic Information」の「App-Level Tokens」で、scope に `connections:write` を選んで作ります（2 の手順の 2〜3 と同じ）。
4. 5 の「ワークスペースに入れる」から続けます。

既にある App に scope やイベントを足すときも、「App Manifest」の画面でこの形に直して保存し、入れ直します。
下の 1〜4 は、画面から 1 つずつ設定する手順と、それぞれの項目が何のためにあるかの説明です。

## 1. App を作る

1. <https://api.slack.com/apps> で「Create New App」→「From scratch」を選び、名前（例: natsumi）と、入れるワークスペースを選びます。
2. 「Basic Information」の「Display Information」で、表示名とアイコンを好みに設定します。

## 2. Socket Mode を有効にする

1. 「Socket Mode」を開き、「Enable Socket Mode」を有効にします。
2. app-level token の作成を求められるので、名前（例: natsumi-socket）を付け、scope に `connections:write` を選んで作ります。
3. できた `xapp-` で始まる token が、設定の `appTokenEnv` / `appTokenFile` で指す token です。

Socket Mode は natsumi から Slack へ外向きにつなぐので、公開する URL（Request URL）は要りません。

## 3. bot の scope を足す

「OAuth & Permissions」の「Bot Token Scopes」に、次を足します。

| scope | 何に使うか |
| --- | --- |
| `channels:history` | 公開チャンネルの発言を読む |
| `groups:history` | 招待された非公開チャンネルの発言を読む |
| `im:history` | DM を読む |
| `channels:read` / `groups:read` / `im:read` | 参加しているチャンネルと DM の一覧と名前を知る |
| `users:read` | 発言者の表示名を知る |
| `files:read` | 添付の画像と PDF を取ってくる |
| `reactions:write` | 受け取ったときに 👀 を付ける。ポッポさんに頼まれたリアクションを付ける |
| `reactions:read` | 発言に付いたリアクションを受け取り、チャンネルのファイルに書く（[ADR 0043](adr/0043-reactions-in-the-channel-files.md)） |
| `app_mentions:read` | メンションを受け取る |
| `chat:write` | ポッポさんが投稿する |
| `chat:write.customize` | 投稿ごとに、なつみの表情のアイコン（`icon_url`）を使う |
| `emoji:read` | ポッポさんに頼まれたリアクションが、ワークスペースのカスタム絵文字にあるか確かめる（`emoji.list`）。無ければ標準の絵文字だけを付けます |
| `files:write` | ポッポさんが画像を投稿する（`files.getUploadURLExternal`・`files.completeUploadExternal`）。無ければ画像付きの投稿は Slack に断られ、なつみには届けられなかったと伝わります |

User Token Scopes には何も足しません。natsumi は本人の user token を使いません。

## 4. イベントを購読する

1. 「Event Subscriptions」を開き、「Enable Events」を有効にします（Socket Mode なので Request URL は求められません）。
2. 「Subscribe to bot events」に、次を足します。

| イベント | 何を受け取るか |
| --- | --- |
| `message.channels` | 公開チャンネルの発言 |
| `message.groups` | 非公開チャンネルの発言 |
| `message.im` | DM |
| `app_mention` | メンション |
| `reaction_added` | 発言にリアクションが付いた |
| `reaction_removed` | 発言からリアクションが外された |

3. DM を受け取るには、「App Home」の「Show Tabs」で「Messages Tab」を有効にし、
   「Allow users to send Slash commands and messages from the messages tab」にも印を付けます。

## 5. ワークスペースに入れる

1. 「Install App」から、ワークスペースにインストールします（scope を変えたら入れ直します）。
2. できた `xoxb-` で始まる Bot User OAuth Token が、設定の `botTokenEnv` / `botTokenFile` で指す token です。
3. 読ませたいチャンネルで、bot を招待します（例: チャンネルで `/invite @natsumi`）。
   招待したチャンネルだけを読みます。中身が外に漏れても困らないチャンネルだけに招待してください（ADR 0039 のテストの段階の前提）。

## 6. token を置く

token は秘密です。設定ファイルに値を書かず、次のどちらかで渡します。

- ファイル: コンテナのユーザーだけが読めるファイルに置き、`botTokenFile` / `appTokenFile` に絶対パスを書きます。
  Docker なら `secrets/` の下（Git の追跡対象外）に置いて、コンテナにマウントします。Kubernetes なら Secret をマウントします。
- 環境変数: `botTokenEnv` / `appTokenEnv` に環境変数の名前を書き、その変数に token を入れます。

token は natsumi のコンテナにだけ渡し、作業環境（natsumi-workspace）には渡しません。

## 7. 確かめる

natsumi を起動すると、ログに `slack (<名前>): connecting` が出ます。
token が違うか App の設定が足りないと `could not start` が出ます。
つながると、招待したチャンネルが data directory の `sources/slack/<名前>/` に書かれ、`sources/slack/INDEX.md` に並びます。
初めて見るチャンネルは、既定で 90 日前から埋めます（`slack.backfillDays`、1〜365 日）。発言の多いチャンネルでは最初の接続に時間がかかるので、必要なら短くします。
bot にメンションすると 👀 が付き、natsumi に出来事として届きます。
natsumi が返事をポッポさんに頼むと、判定が通れば bot の発言として投稿されます。アイコンは natsumi のサーバーの `/avatar/<表情>.png` で、
Slack がそこへ取りに行くので、`publicOrigin` は Slack から届く公開のホストである必要があります。
アイコンが bot の既定のものになるときは、`chat:write.customize` があるかと、`https://<publicOrigin のホスト>/avatar/neutral.png` が外から開けるかを確かめます。
