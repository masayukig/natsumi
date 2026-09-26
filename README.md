# natsumi

Pi Coding Agent を使う個人アシスタント。現在はサーバー基盤（設定の検証、data directory の初期化、
二重起動の拒否、状態 DB の migration、専用の Pi 状態領域、コンテナ）、GitHub ログインと短期セッション、
HTTPS/WSS の待ち受けと v1 envelope の入口、Let's Encrypt（ACME HTTP-01）による証明書の自動取得、
固定 IPv6 で公開するコンテナ構成、Pi SDK の隔離検証ハーネス、単一の思考ループによる Mac との会話
（端末の登録と同期、表情、表示用の会話の記録）、git で持つ Markdown の長期記憶、閉じ込めたコンテナの中の作業環境と、
夜の思考の記録の切り替えを提供しています。
Mac アプリは土台（ログイン、会話の同期、デスクトップに常駐するキャラクター、その上の吹き出し、話しかけて読み返す会話のウインドウ）ができています。
Slack は受け取り（招待されたチャンネルをファイルに書き、メンションと DM を出来事にする）と、ポッポさんによる投稿
（下書きの判定、本人に回した投稿の承認の API と iPhone への通知）ができています。承認の画面、画像の投稿、Google 連携は後続の実装です。

Node.js 24.12.0 以降を使用します。通常の検証は外部認証・ネットワーク接続を必要としません
（初回の npm 依存取得を除く）。Pi は `@earendil-works/pi-coding-agent` の SDK を npm 依存として固定しています。

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` は Node 標準 test runner で、サーバー基盤の試験、GitHub を模したローカルサーバーを使うログインと WSS の試験、
モデル応答を合成 stream に差し替えた Pi SDK の fixture を実行します。TLS の試験は `openssl` で一時的な証明書を作ります
（`openssl` がなければその試験だけ skip します）。
build 結果は `dist/` に生成されます。実際のモデルへ接続する検証は `npm run probe:live` で明示的に行います
（[実行方法](docs/probe-results.md)）。

## サーバーの起動

サーバーは 1 つの data directory を専有し、HTTPS/WSS で待ち受けます。以下のホスト名・ID は架空の例です。

1. data directory をコード checkout の外に作ります。checkout の中を指定すると起動を拒否します。
2. 下記の手順で GitHub OAuth App と TLS 証明書を用意します。
3. [config.example.json](config.example.json) を `config.local.json` などにコピーし、実環境に合わせます。
   - `pi`: Pi 状態領域のパス。data directory ともホームの `.pi` / `.codex` とも別の場所にします。
     `model` でモデルを選びます。専用領域で login した Pi のサブスクリプション（例: `openai-codex`）か、
     `"provider": "natsumi-compatible"` と `compatible`（自分で動かす OpenAI 互換エンドポイントの `baseUrl` と、
     API key の参照 `apiKeyEnv` か `apiKeyFile`）の組です。両者の間で自動の切り替えはしません。
     `compatible.contextWindow` は、Pi に伝えるそのモデルの context の大きさ（tokens、既定 128000）です。
     エンドポイントの 1 スロットの大きさ以下にします。サブスクリプションのモデルでは、Pi のモデル定義の値を使います。
     経路を複数並べて切り替えたいときは、`model` と `compatible` の代わりに `routes`（名前付きの経路）と
     `defaultRoute`（既定の経路の名前）を書きます。下記「モデルの経路を切り替える」を見てください。
     `thinking` は既定で `"on"`（思考あり）で、`"off"` にもできます。
   - `publicOrigin`: クライアントが使う origin（例: `https://natsumi.example.net:8443`）。https に限ります。
   - `listen`: 待ち受けアドレス・ポート・TLS。`"host": "::"` で IPv4 と IPv6 の両方で待ち受けます。
     `tls` には証明書と鍵のファイル、または Let's Encrypt から自動取得する `acme` を指定します。
     Kubernetes の Ingress のように手前のプロキシで TLS を終端するときは、`"tls": false` と `"behindProxy": true` を指定します。
   - `github`: OAuth App の client ID、client secret の参照（`clientSecretEnv` か `clientSecretFile`）、callback URL、
     許可するアカウントの数値 ID（`allowedUserId`）。
   - `loop`（省略可）: 本人のタイムゾーン `timeZone`（例: `Asia/Tokyo`、既定 `UTC`）、夜の切り替えの時刻 `nightlyRotationAt`
     （既定 `"04:00"`、`false` で自動では切り替えない）、compaction の上限 `compactionThreshold`（既定 60000 tokens）と、
     要約せずに残す直近の量 `compactionKeepRecent`（既定 20000 tokens）。
     compaction はターンの間にしか走らないので、互換エンドポイントでは `compactionThreshold` に 53248 tokens
     （1 ターンの伸び 32768、1 回の返事の上限 16384、Pi が窓の手前に空ける 4096）を足した量が `contextWindow` を超えると
     起動を拒みます。上限を上げるときは窓も上げてください（例: 上限 128000 には窓 181248 以上）。
     起きている時間帯 `awakeHours`（既定 `{ "start": "08:00", "end": "23:00" }`）、合図までの静かな時間 `pingIntervalMinutes`
     （既定 30 分、`false` で合図を出さない）、自分で予約する確認の上限 `selfCheck`（最短の先 `minDelayMinutes` 既定 5 分、
     最も遠い先 `maxDelayDays` 既定 7 日、同時に待たせる件数 `maxPending` 既定 5 件、1 日の件数 `maxPerDay` 既定 20 件）、
     表情が neutral に戻るまでの時間 `expressionResetMinutes`（既定 3 分）。
     夜の振り返りのターンの上限 `reviewModelCalls`（モデル呼び出しの回数。既定 40 回）と `reviewTimeoutMinutes`
     （時間。既定 30 分）。昼のふつうのターンの上限 `eventModelCalls`（既定 8 回）と `eventTimeoutMinutes`（既定 10 分）。
     回数を上げるときは、1 回の呼び出しにかかる時間を掛けても時間の上限に収まるかを確かめてください。
     上限で打ち切られたターンはログに残ります。
     記憶のリポジトリの場所 `memoryRepository`（絶対パス。既定は data directory の `memory/`）と、
     記憶 1 ファイルの上限 `memoryFileMaxChars`（既定 32000 文字）、常時記憶の上限 `alwaysMemoryMaxChars`
     （既定 2000 文字。毎回のプロンプトに入るので、1 ファイルの上限より小さくします）。
     作業環境の runner のソケット `workspaceSocket`（絶対パス。これがあるときだけ `run_shell` が使えます）、
     runner の応答を待つ秒数 `shellWaitSeconds`（既定 75 秒。runner 側の応答の上限 60 秒より長くします）、
     永続する書き場所の合計の目安 `workspaceSizeWarnBytes`（既定 1 GiB。超えると次のターンで natsumi に知らせます）。
   - `apns`（省略可）: iPhone に通知を送るための APNs の設定です。下記「iPhone に通知を送る」を見てください。
   - `a2a`（省略可）: 外のエージェントに A2A で頼むための設定です。下記「外のエージェントに頼む」を見てください。
   - `slack`（省略可）: Slack を受け取るための設定です。下記「Slack を受け取る」を見てください。
4. ビルドして起動します。

```sh
npm run build
node dist/src/server/main.js serve --config config.local.json --data-dir <data directory>
```

`--data-dir` を省略すると起動 cwd を data directory とします。初回起動で `memory/`（記憶のリポジトリ）、
`work/` と `home/`（作業環境の `/work` と `/home/natsumi`）、`agents/`（作業環境の `/manual/agents`。頼める相手の一覧）、
`.natsumi/`（状態 DB・ロック・状態ファイル）を作ります。既存のファイルは上書きしません。
同じ data directory で 2 つ目のサーバーを起動すると拒否します。異常終了後のロックは OS が解放するため、そのまま再起動できます。
SIGTERM / SIGINT で停止します。

会話は、一本の Pi session が思考ループとして本人のメッセージを 1 件ずつ処理し、ツールで返事や表情を出す形です
（[ADR 0008](docs/adr/0008-single-thinking-loop-and-mac-conversation.md)）。本人のメッセージと natsumi の返事・知らせは
`.natsumi/state.sqlite` に、思考の記録は Pi の session に保存されます。
natsumi の返事と知らせには、セリフごとに選んだ気持ち（表情と同じ候補）が付いて残ります。キャラクターの表情とは別です
（[ADR 0026](docs/adr/0026-a-feeling-on-each-line.md)）。どちらも個人データとして一緒にバックアップしてください。
Pi の session ファイルが消えた・壊れた場合は新しい session を作らず、会話を使えない状態で起動します。

長期記憶は 1 つの git リポジトリです（[ADR 0018](docs/adr/0018-memory-in-git-and-the-nightly-rebuild.md)）。
場所は `loop.memoryRepository`、既定は data directory の `memory/` で、初回起動でそこが git のリポジトリになります
（ブランチは `main`）。すでにあった Markdown は、名前も中身も変えずに最初のコミットに入ります。
記憶そのものは、これまでどおりトピックごとの Markdown ファイルで、見出しと日付付きの箇条書きの行でできています
（[ADR 0009](docs/adr/0009-long-term-memory-and-nightly-session-switch.md)）。natsumi はこのファイルを `run_shell` で
読み書きします（[ADR 0019](docs/adr/0019-a-workspace-not-a-memory-tool.md)。専用の記憶のツールはもうありません）。
手で読んで直すこともできますし、直下に手で置いた `.md` ファイルも natsumi が探す対象になります。

サーバーが名前と置き場所を決めるのは、リポジトリ直下の 3 つだけです。

| ファイル | 中身 |
| --- | --- |
| `always.md` | 常時記憶。session を作るときにプロンプトに入ります。夜のターンでだけ書き換えられます |
| `personality.md` | 性格・話し方。session を作るときにプロンプトに入ります。夜のターンでだけ書き換えられます |
| `handoff.md` | 夜の引き継ぎ。初回起動で、そのときの最新の引き継ぎを写します（引き継ぎ自体を SQLite からこのファイルへ移すのは後続の実装） |

記憶に変更があったターンの終わりごとに、サーバーが 1 回コミットします。順序は、ターンが終わる → 変わったファイルを
検査 → 当たったものを直前のコミットの状態に戻す（新しいファイルは消す）→ 残りをコミット、です。ターンがモデル呼び出しの
上限や時間切れで終わったときも同じように検査してコミットします。検査は `.md` 以外・symlink・空・
`loop.memoryFileMaxChars`（既定 32000 文字）超過・テンプレートの制御文字列・制御文字・日本語以外の文字と、
日中のターンでの `always.md`・`personality.md` の変更です。`always.md` にはこれに加えて
`loop.alwaysMemoryMaxChars`（既定 2000 文字）の上限が掛かります。戻した理由は次のターンで natsumi に伝わります。

上限を掛けるのは書くときだけです（[ADR 0020](docs/adr/0020-limits-at-write-time-and-a-nightly-menu.md)）。
プロンプトを組む側は長さを見ないので、オーナーが自分で git に直接コミットした長い `always.md` は、そのまま
プロンプトに入ります。サーバーが書いたものは必ず上限の中にあります。

natsumi が作ったファイルは、削除も改名も検査しません。全部消しても履歴から戻せます。上の 3 つだけは別で、
消すことも改名することもできません（戻したうえで理由を伝えます）。サーバーはこの 3 つが直下にある前提で動くので、
黙って消えるとその前提が崩れます。

**サーバーは commit だけを行い、push も pull もしません。** リモートを設定するか、外へ出すかはオーナーが決めます。
リポジトリには本人の私的なことがそのまま残るので、リモートを作るなら private にしてください。
author と committer はサーバーが固定し、リポジトリに置かれた git の hook は実行しません。

毎晩 `loop.nightlyRotationAt` に、natsumi はその日を振り返り、引き継ぎのメモを持って新しい Pi session に切り替えます。
夜のターンに必ず求めるのは、引き継ぎを書くこととターンを終えることの 2 つだけで、記憶の組み直し、常時記憶と性格の見直し、
作業場の片づけなどは候補として渡し、その夜に何をするかは natsumi が選びます
（[ADR 0020](docs/adr/0020-limits-at-write-time-and-a-nightly-menu.md)）。やらなかったことは引き継ぎに残ります。
その夜のコミットメッセージは natsumi 自身の説明で、書かれなかった夜はサーバーが機械的に付けます。
古い session ファイルは消さずに残るので、Pi の session 領域は日ごとに増えます。日中に context が `loop.compactionThreshold` を超えると、
イベントの合間に古い部分を要約します。記憶のリポジトリ、`.natsumi/state.sqlite`、Pi の session 領域は一組でバックアップしてください。

natsumi は自分から動くこともあります（[ADR 0014](docs/adr/0014-self-checks-and-pings.md)）。
`loop.awakeHours` の間、会話や処理のない時間が `loop.pingIntervalMinutes` 続くと、サーバーが「何かしたいことは？」の合図を送ります。
また natsumi は「30 分後」「15:00」のように、後で自分から確かめる予約を入れられます。予約は `.natsumi/state.sqlite` に残り、
サーバーの停止や夜で時刻を過ぎたものは、起動後（夜なら朝）にまとめて 1 回で届きます。予約の件数と間隔は `loop.selfCheck` でサーバーが制限します。
どちらもモデルを使うので、静かな時間にもモデルの利用が発生します。

稼働状態は `node dist/src/server/main.js health --data-dir <data directory>` で確認できます（稼働中なら終了コード 0）。

### モデルの経路を切り替える

思考ループのモデルの経路に名前を付けて設定に並べ、動いているサーバーのまま手で切り替えられます
（[ADR 0046](docs/adr/0046-named-model-routes-switched-by-hand.md)）。自動の切り替えはしません。

```json
"pi": {
  "agentDirectory": "/var/lib/natsumi-pi/agent",
  "sessionDirectory": "/var/lib/natsumi-pi/sessions",
  "authPath": "/var/lib/natsumi-pi/agent/auth.json",
  "routes": {
    "local": {
      "model": { "provider": "natsumi-compatible", "id": "example-model" },
      "compatible": { "baseUrl": "https://llm.example.net/v1", "apiKeyEnv": "NATSUMI_PI_API_KEY", "contextWindow": 131072 }
    },
    "plus": {
      "model": { "provider": "openai-codex", "id": "gpt-5.5" },
      "compactionThreshold": 150000
    }
  },
  "defaultRoute": "local",
  "voiceEnabled": false
}
```

- 経路の名前は小文字の英字・数字・ハイフン（32 文字まで）です。経路ごとに `model` と、互換なら `compatible` を書きます。
  互換の経路を 2 つ以上並べるときは、provider を `natsumi-compatible-<何か>` のように経路ごとに変えます。
  1 つ目は `natsumi-compatible` のままにしておくと、これまでの session の記録と同じモデルとして続きます。
- `compactionThreshold` は省けます。書かなければ `loop.compactionThreshold` を使います。上限と窓の組み合わせは経路ごとに検査します。
  互換の経路は `compatible.contextWindow` で、サブスクリプションの経路は Pi のモデル定義の窓（`gpt-5.5` は 272000）で検査します。
- `pi.model`（と `pi.compatible`）だけの設定は、`default` という名前の経路 1 つとして読みます。
- ポッポさんの判定が使い回すのは、既定の経路の互換のモデルだけです。切り替えても判定は変わりません。

切り替えはサーバーのコマンドで行います。サーバーが動いているときも止まっているときも、同じ data directory を指せば効きます。

```sh
node dist/src/server/main.js model list --data-dir <data directory>     # 経路の一覧（* が使っている経路）
node dist/src/server/main.js model status --data-dir <data directory>   # 使っている経路・選んだ経路・既定の経路
node dist/src/server/main.js model use plus --data-dir <data directory> # plus を選ぶ
```

Kubernetes では `kubectl exec natsumi-0 -c server -- node /app/dist/src/server/main.js model use plus --data-dir /data` のように打ちます。

- 選んだ経路は data directory の `.natsumi/model-route.json` に残り、再起動しても続きます。
  動いているサーバーは、次のターンの前に読んで移ります。何もしていなければ 15 秒以内に移ります。止まっているなら次の起動で使います。
  同じ session のまま、次のターンからモデルだけが変わります。移った時点で新しい経路の上限を超えていれば、次のターンの前に要約します。
- サーバーは経路の一覧と、それぞれが使える状態か（キーが読めるか、ログインがあるか）を `.natsumi/model-routes.json` に書きます。
  `model use` は、この一覧に無い経路と、使える状態にない経路を断ります（サーバーを一度も起動していなければ、確かめずに書きます）。
- 設定から消えた経路が選ばれていたら、既定の経路に戻してログに残します。
- 使える状態にない経路が選ばれたまま起動すると、natsumi は話せない状態で起動します。ほかの経路には落としません。
  `model use` で別の経路を選び、起動し直してください。
- Mac・iPhone のアプリからも、`model.list` と `model.use` のコマンドで読んで選べます（[契約](docs/client-contract.md)）。
  画面での選び方は下の「Mac アプリ」の「使い方」と「iPhone アプリ」にあります。

サブスクリプションの経路（例: ChatGPT Plus の `openai-codex`）は、`pi.authPath` の OAuth のログインを使います。
サーバーはこのファイルを作りません。本人が Pi の CLI で、その Pi 領域にログインします。`authPath` は
`<agentDirectory>/auth.json` にしておきます（Pi の CLI はそこに書きます）。

```sh
PI_CODING_AGENT_DIR=<pi.agentDirectory> node node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
# Pi の画面で /login を打ち、provider を選んでログインします。
```

image の中では `/app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` です。
Pi の CLI が起動時に探す `rg` と `fd`（`fdfind` の名前）は image に入れてあるので、`--offline` で起動しても
それらが無いという警告は出ません。思考ループでは、Pi の組み込みの grep・find のツールは使いません。
起動したときにログインのファイルが無かった場合は、ログインしたあとに一度起動し直してください。
ファイルがあれば、ログインのし直しは起動し直さなくても効きます。

設定の不備（未知の項目、相対パス、秘密の直書き、外部アドレスでの平文の待ち受けなど）は、該当する設定名を示して起動を止めます。
秘密は設定ファイルに書かず、`...Env`（環境変数名）や `...File`（secret mount のパス）で参照します。

### 終わったターンを畳む・統計を見る

終わったターンの思考と途中のツールを、モデルに送る直前に畳めます（[ADR 0047](docs/adr/0047-folding-ended-turns-with-a-memo.md)）。
畳んだターンには、届いた出来事・本人への返事と知らせ・外のエージェントへの依頼・`read` で読んだものと、
ターンの後にサーバーが頼んだ一行の振り返りだけが残ります。session の記録は書き換えないので、切ればすぐ元に戻ります。
振り返りは、畳み込みが off の間も毎ターン頼みます。

既定は設定の `loop.turnFold`（`"on"` か `"off"`、書かなければ `"off"`）です。動いているサーバーは、コマンドで切り替えます。

```sh
node dist/src/server/main.js fold status --data-dir <data directory>  # 使っている値・選んだ値・設定の既定
node dist/src/server/main.js fold on --data-dir <data directory>      # 次のターンから畳む
node dist/src/server/main.js fold off --data-dir <data directory>     # 次のターンから畳まない
```

- 選んだ値は `.natsumi/turn-fold.json` に残り、再起動しても続きます。サーバーはターンの前に読みます。
- 切り替えた直後のターンは、prefix cache が 1 回外れます。

ターンごとの数（本文は含みません）が `.natsumi/state.sqlite` の `turn_stats` に残ります。on と off を比べるには:

```sh
node dist/src/server/main.js stats --since 2026-09-20 --until 2026-09-27 --data-dir <data directory>
node dist/src/server/main.js stats --memos 20 --config <config file>   # 直近の一行メモ（session のファイルから読みます）
```

- `stats` は、最初の返事（またはポッポさんへの依頼）までの時間、ターンの長さ、呼び出しの回数、最初の呼び出しの文脈の大きさ、
  キャッシュに乗った割合、出力の tokens、振り返りの時間を on と off に分けて中央値と p90 で並べ、compaction の回数と、
  迷いの指標（読み直し・ツールのエラー・ポッポさんの突き返し・答えなかったメッセージの 1 ターンあたりの平均、打ち切りの割合）を続けます。
- `--since` と `--until` は `YYYY-MM-DD`（UTC の 0 時）か、`Z` 付きの時刻です。`--until` の時刻は含みません。
- `--memos` は `pi.sessionDirectory` を読むために設定ファイルを読みます（既定は `config.local.json`）。

### GitHub OAuth App を作る

1. GitHub の Settings → Developer settings → OAuth Apps → New OAuth App を開きます。
2. Homepage URL に `publicOrigin`（例: `https://natsumi.example.net:8443`）を、
   Authorization callback URL に `publicOrigin` + `/auth/github/callback`
   （例: `https://natsumi.example.net:8443/auth/github/callback`）を入力して登録します。
   この callback URL を設定の `github.callbackUrl` にも書きます。
3. 表示された Client ID を `github.clientId` に書きます。
4. Generate a new client secret で secret を作り、ファイル（例: `secrets/github-client-secret`）か環境変数に保存します。
   設定には `clientSecretFile` でファイルのパスを、または `clientSecretEnv` で環境変数名を書きます。secret 自体は書きません。
5. 許可する自分のアカウントの数値 ID を調べ、`github.allowedUserId` に数値で書きます。
   `https://api.github.com/users/<ログイン名>` の `id`、または `gh api user --jq .id` で確認できます。
   ログイン名は判定に使いません。ログイン名を変えても ID は変わりません。

サーバーは scope を要求せず、GitHub のアクセストークンは数値 ID の確認にだけ使って保存しません。
ログインの流れと Mac アプリ側の契約は [client-contract.md](docs/client-contract.md) の「ログインとセッション」にあります。

### TLS を設定する

Docker で動かすときは、TLS はサーバー自身で終端します（[ADR 0006](docs/adr/0006-github-login-and-transport.md)）。
Ingress の後ろに置くときは、TLS は Ingress で終端し、サーバーは平文で待ち受けます（[ADR 0033](docs/adr/0033-running-on-kubernetes.md)）。

- `publicOrigin` のホスト名に対する証明書と秘密鍵を PEM で用意し、`listen.tls.certFile` / `keyFile` に指定します。
  中間証明書がある場合は `certFile` にサーバー証明書に続けて連結します。
- Mac からの接続では、Mac が信頼する証明書（公的な CA が発行したもの、または Mac に登録した私的な CA のもの）を使います。
- ファイルで渡した証明書を更新したら、サーバーを再起動します。
- 同じホストのリバースプロキシで TLS を終端する場合は、`"host": "127.0.0.1"`（または `"::1"`）と `"tls": false` を指定できます。
- Ingress の後ろに置く場合は、`"tls": false` に `"behindProxy": true` を足すと、loopback 以外のアドレス（例: `"::"`）でも平文で待ち受けます。
  Ingress のコントローラは Pod の IP につなぐので、loopback では届かないためです。平文になるのは Ingress から Pod までの区間です。
  `publicOrigin` は、クライアントから見た https の origin のままにします。
- `behindProxy` を付けずに loopback 以外のアドレスで `tls: false` を指定すると、起動を拒否します。
  `behindProxy` は `tls: false` のときだけ指定できます。

### Let's Encrypt で証明書を自動取得する

`listen.tls` に証明書ファイルの代わりに `acme` を指定すると、サーバーが `publicOrigin` のホスト名の証明書を
ACME の HTTP-01 で取得し、更新します（[ADR 0007](docs/adr/0007-acme-and-fixed-ipv6.md)）。
設定例は [config.acme.example.json](config.acme.example.json) です。証明書ファイルの指定と `acme` は同時に指定できません。

- `acme.directoryUrl`: 省略すると Let's Encrypt の本番（`https://acme-v02.api.letsencrypt.org/directory`）を使います。
  試験には staging（`https://acme-staging-v02.api.letsencrypt.org/directory`）を指定します。staging の証明書は Mac に信頼されません。
- `acme.contactEmail`: 任意です。CA からの連絡先になります。
- `acme.httpPort`: challenge に答える平文のポートで、既定は 80 です。CA は 80 番に接続するので、変える場合は外側で 80 番をこのポートへ転送します。
- `acme` を指定すると、CA の利用規約（Let's Encrypt の Subscriber Agreement）に同意したものとしてアカウントを登録します。
- `publicOrigin` は DNS のホスト名にします（IP アドレスは不可）。DNS のレコードがこのサーバーを指し、
  ファイアウォールで tcp 80 と `listen.port`（通常は 443）が外から届く必要があります。
- 80 番では、発行中の challenge への応答と、`publicOrigin` の https への redirect だけを返します。ログイン・API・WebSocket にはつながりません。
- 起動時に使える証明書がなければ、取得できるまで HTTPS の待ち受けを開きません。その間、`health` は `waiting-for-certificate` で異常を返します。
  取得に失敗すると、15 分後から間隔を倍にしながら、最大 12 時間の間隔で再試行します。
- 残りが 30 日（寿命の短い証明書では寿命の 3 分の 1）を切ると更新し、再起動なしで新しい接続に使います。
  更新に失敗しても、古い証明書のまま動き続けます。
- アカウント鍵と証明書は data directory の `.natsumi/acme/` に保存され（ディレクトリは 0700、ファイルは 0600）、再起動しても再発行しません。
  バックアップの対象に含めてください。失うと新しいアカウントで再発行することになり、CA のレート制限に当たることがあります。

## コンテナ

```sh
docker compose config --quiet
docker compose build
docker compose up -d
```

data directory は named volume `natsumi-data`（`/data`）、Pi 状態領域は `natsumi-pi`（`/var/lib/natsumi-pi`）に永続化され、
コンテナを作り直しても残ります。コンテナは非 root ユーザーと読み取り専用のルートファイルシステムで動きます。
設定は既定で `config.example.json` を読み取り専用でマウントします。実環境の設定は `NATSUMI_CONFIG=./config.local.json` で指定します。
volume の代わりに既存のディレクトリを bind mount する場合は、所有者をコンテナの `node` ユーザー（UID 1000）に合わせてください。

- ポート: コンテナの 8443 番をホストの `${NATSUMI_PORT:-8443}` 番に公開します。IPv6 での公開には Docker daemon の IPv6 設定が必要です。
- 秘密: 証明書・鍵・GitHub client secret は Compose の secrets として `/run/secrets/natsumi_tls_cert`、`natsumi_tls_key`、
  `natsumi_github_client_secret` にマウントされます。設定例はこのパスを参照しています。
  既定ではホストの `secrets/tls-cert.pem`、`secrets/tls-key.pem`、`secrets/github-client-secret` を読みます
  （`NATSUMI_TLS_CERT`、`NATSUMI_TLS_KEY`、`NATSUMI_GITHUB_CLIENT_SECRET_FILE` で変更できます）。
  `secrets/` は Git の追跡対象外です。ファイルはホストの権限のままマウントされるため、UID 1000 だけが読めるようにしてください。

### iPhone に通知を送る

iPhone のアプリが裏にいる間の返事と知らせは、サーバーが APNs に送ります（[ADR 0029](docs/adr/0029-push-notifications-on-the-iphone.md)）。
有料の Apple Developer Program が要ります。設定に `apns` がなければ何も送りません（iPhone の登録は受け付けて記録します）。

1. Apple Developer の Certificates, Identifiers & Profiles → Keys で、Apple Push Notifications service（APNs）を有効にした鍵を作り、
   .p8 のファイルをダウンロードします。ダウンロードできるのは 1 度だけです。sandbox と production のどちらにも使えます。
2. .p8 を `secrets/apns-key.p8` などに置き、コンテナのユーザーだけが読めるようにします（例: `chmod 600`、所有者はコンテナの UID）。
   `secrets/` は Git の追跡対象外です。
3. 設定に `apns` を足します。値は架空の例です。

   ```json
   "apns": {
     "teamId": "ABCDE12345",
     "keyId": "KEY1234567",
     "topic": "net.example.natsumi",
     "keyFile": "/run/secrets/natsumi_apns_key"
   }
   ```

   `teamId` はチームの ID、`keyId` は鍵の ID（どちらも 10 文字の英大文字と数字）、`topic` はアプリの bundle ID です。
   鍵は `keyFile`（secret mount のパス）か `keyEnv`（PEM の中身を入れた環境変数の名前）のどちらか一方で参照します。
   鍵が読めない、または P-256 の秘密鍵でなければ起動を止めます。
4. Compose では override の [compose.apns.example.yaml](compose.apns.example.yaml) を足して、鍵を `/run/secrets/natsumi_apns_key` にマウントします。
   既定ではホストの `secrets/apns-key.p8` を読みます（`NATSUMI_APNS_KEY_FILE` で変更できます）。
   鍵のファイルがないと compose が止まるので、既定の `compose.yaml` には入っていません。

```sh
docker compose -f compose.yaml -f compose.apns.example.yaml up -d
# 固定 IPv6 の構成では、compose.ipv6.example.yaml の後に置きます。
docker compose -f compose.yaml -f compose.ipv6.example.yaml -f compose.apns.example.yaml up -d
```

- 送り先（`api.sandbox.push.apple.com` か `api.push.apple.com`）は、iPhone が登録するときの `environment` で決まります。
  開発用に署名したアプリ（Xcode から入れたもの）は sandbox、配布したものは production です。
- 送れなかった通知は、メモリの中で数回だけ送り直します。サーバーを再起動すると送り直しの予定は消えます。
  返事と知らせそのものは会話に残っているので、アプリを開けば読めます。
- 送るのは、その iPhone のセッションが生きている間だけです。セッションは最後に使ってから 30 日で切れ、接続するたびに延びるので
  （[ADR 0030](docs/adr/0030-a-session-that-lasts-while-it-is-used.md)）、30 日以内に一度でもアプリを開けば通知は止まりません。
  ログアウトすると送らなくなります。
- ログには端末の ID と APNs の応答だけを出し、本文・device token・鍵は出しません。
- 登録は `.natsumi/state.sqlite` の `push_registrations`（migration 10）に持ちます。

### 外のエージェントに頼む

natsumi は、Wiki の管理人のような外の特化エージェントに `ask_agent` で頼めます
（[ADR 0025](docs/adr/0025-talking-to-outside-agents-over-a2a.md)、[ADR 0035](docs/adr/0035-asking-outside-agents-and-hearing-back.md)、
[ADR 0036](docs/adr/0036-a-manual-to-read-and-a-limit-on-waiting.md)）。相手とは A2A 1.0（JSON-RPC）で話し、公式の SDK
`@a2a-js/sdk` を使います。設定に `a2a` がなければ、`ask_agent` は頼まずに断ります（ツール自体は常にあります）。

1. 呼び出しの token を用意します。相手が確かめる ServiceAccount の token（audience `a2a`）です。
   Kubernetes では Pod に差し込まれる projected token のパスを、Docker では手で置いたファイルを使います。
   Docker では `secrets/a2a-token` などに置き、コンテナのユーザーだけが読めるようにします。`secrets/` は Git の追跡対象外です。
2. 設定に `a2a` を足します。値は架空の例です。

   ```json
   "a2a": {
     "tokenFile": "/run/secrets/natsumi_a2a_token",
     "agents": {
       "wiki": { "url": "https://agents.example.net/wiki-keeper/" }
     }
   }
   ```

   | 項目 | 必須 | 既定 | 中身 |
   | --- | --- | --- | --- |
   | `a2a.agents.<名前>.url` | 必須 | | 相手の A2A の受け口。https に限ります（loopback だけ http）。名前は英小文字・数字・ハイフンで 32 文字まで。natsumi は名前だけを扱います |
   | `a2a.tokenFile` | 必須 | | token のファイル（絶対パス）。呼び出しのたびに読み直すので、更新された token は再起動なしで使われます |
   | `a2a.pollIntervalSeconds` | | 15 | 返事を待っている依頼を取りに行く間隔（秒、5 以上） |
   | `a2a.giveUpAfterHours` | | 24 | 返事を待ち続ける上限（時間）。最後に送ってからこの時間が過ぎると、待つのをやめて natsumi に知らせます |

3. Compose では override の [compose.a2a.example.yaml](compose.a2a.example.yaml) を足して、token を `/run/secrets/natsumi_a2a_token` にマウントします。
   既定ではホストの `secrets/a2a-token` を読みます（`NATSUMI_A2A_TOKEN_FILE` で変更できます）。
   token を更新するときは、同じファイルに中身を書き込みます（別のファイルに置き換えると、マウントが古いほうを指したままになります）。

```sh
docker compose -f compose.yaml -f compose.a2a.example.yaml up -d
```

- 頼むと、サーバーは相手に送ってすぐ「頼んだ」とだけ natsumi に返します。返事はサーバーが `a2a.pollIntervalSeconds` ごとに
  取りに行き、済んだ・できなかった・相手が聞き返している・待つのをやめた、のどれかになったら、相手の名前つきの出来事として
  natsumi に届けます。依頼の ID は natsumi に見せません。相手の聞き返しには、natsumi が同じ相手との直近のやり取りに続けて答えます。
- 待っている依頼と、相手ごとの直近のやり取りは `.natsumi/state.sqlite`（migration 12）に残るので、再起動しても取りに行き直します。
  返事の本文は、natsumi に渡すまでだけそこに置き、渡したら消します（以後は Pi の session にあります）。
- 相手とのやり取りは Mac の会話には出ません。本人に伝えることは natsumi が返事や知らせで伝えます。
- 頼める相手の一覧は、サーバーが起動のたびに各相手の Agent Card（token は付けずに取ります）から data directory の
  `agents/INDEX.md` に書き出し、作業環境からは `/manual/agents/INDEX.md` として読み取り専用で見えます。
  取れなかった相手は「今は取れない」と書きます。URL と token は書きません。相手の説明が変わったら、再起動で反映します。
- token は natsumi のコンテナにだけマウントし、作業環境には見せません。ログには相手の名前と失敗の種類だけを出し、頼んだ文面や返事は出しません。

### Slack を受け取る

natsumi 専用の Slack App（bot）を Socket Mode でつなぎ、bot を招待したチャンネルを読みます
（[ADR 0012](docs/adr/0012-slack-and-colleagues.md)、[ADR 0039](docs/adr/0039-slack-as-files-and-a-scored-dove.md)）。
外向きの WebSocket でつなぐので、公開する入口は要りません。公式の SDK `@slack/socket-mode` と `@slack/web-api` を使います。
設定に `slack` がなければ、Slack には何もつなぎません。投稿は下の「Slack に投稿する（ポッポさん）」にあります。

1. ワークスペースごとに Slack App を作り、bot token（`xoxb-`）と Socket Mode の app-level token（`xapp-`）を用意します。
   必要な scope とイベントは [Slack App の作り方](docs/slack-app.md) にあります。本人の user token は使いません。
2. token は秘密なので、設定には値を書かず、環境変数名（`...Env`）かファイル（`...File`）で指します。
3. 設定に `slack` を足します。値は架空の例です。

   ```json
   "slack": {
     "workspaces": {
       "work": {
         "botTokenFile": "/run/secrets/natsumi_slack_work_bot_token",
         "appTokenFile": "/run/secrets/natsumi_slack_work_app_token"
       }
     }
   }
   ```

   | 項目 | 必須 | 既定 | 中身 |
   | --- | --- | --- | --- |
   | `slack.workspaces.<名前>` | 必須 | | ワークスペースごとの `botTokenEnv` か `botTokenFile`、`appTokenEnv` か `appTokenFile`。名前は英小文字・数字・ハイフンで 32 文字まで。natsumi が読むパスと参照（`work/#dev`）に使います |
   | `slack.reaction` | | `eyes` | メンションと DM を受け取ったときにサーバーが付けるリアクション（コロンなしの絵文字名） |
   | `slack.backfillDays` | | 90 | 初めて見るチャンネルを何日前から埋めるか（1〜365） |
   | `slack.maxImageBytes` | | 5 MiB | 取り込む画像の上限（バイト）。超えたものと画像でない添付は「添付あり（取り込まず）」とだけ書きます |
   | `slack.mentionContext.messages` / `.chars` | | 5 / 500 | メンションの出来事に添える前の発言の件数（0〜20）と、1 件あたりの文字数 |
   | `slack.updates` | | `true` | 合図（ping・self_check）の `updates` に Slack の件数を載せるか |
   | `slack.judge` | | 既定の経路の互換のモデルの logprobs | ポッポさんの判定の方式と接続先。下の「Slack に投稿する」 |
   | `slack.approvalExpiryDays` | | 7 | 承認待ちの期限（1〜90 日） |
   | `slack.placementFollowing` | | 2 | 判定なしのとき、チャンネル直下の発言への返事は、その後の発言がこの件数以内ならチャンネル、超えたらスレッドに置く（0〜20） |
   | `slack.judgeContext.messages` / `.chars` | | 5 / 500 | 判定に見せる返信先の周りの発言の件数（1〜20）と、1 件あたりの文字数 |
   | `slack.postImages.maxBytes` / `.maxCount` | | 10 MiB / 4 | ポッポさんに頼む投稿の画像 1 枚の上限（1 KiB〜50 MiB）と、1 回の枚数の上限（1〜10） |

- 参加するチャンネルは、bot を招待して決めます。招待した後の最初の接続で、`backfillDays` 日前から埋めます。
- 発言は data directory の `sources/slack/<ワークスペース>/<チャンネル>/<日付>.md`（DM は `@<名前>/`）に 1 日 1 ファイルで書きます。
  見出しは natsumi のタイムゾーンの `## 14:32:05 山田` で、スレッドの返信は親の下に字下げします。編集と削除ではその日のファイルを書き直します。
  画像は同じ場所の `files/` に取ってきます。目次は `sources/slack/INDEX.md` です。ファイルは消さないので、古いものは手で片づけます。
- 発言に付いたリアクションは、発言の下に `リアクション: :+1: 山田・佐藤、:tada: 田中` の形で書き、付け外しのたびにその日のファイルを書き直します
  （[ADR 0043](docs/adr/0043-reactions-in-the-channel-files.md)）。natsumi 自身が付けたものも書きます。記録に無い発言へのリアクションは捨てます。
  埋め直しでは、取り直した発言の `reactions` を取り込み、Slack が名前を返さなかった分は「ほか N 人」とします。
  Slack App に `reactions:read` とイベント `reaction_added`・`reaction_removed` が要ります（[Slack App の作り方](docs/slack-app.md)）。
- 発言とリアクションは `.natsumi/state.sqlite`（migration 13・15）にも残り、ファイルはそこから書き直します。個人データとしてバックアップの対象です。
- 起動したときと Slack につなぎ直したときに、チャンネルごとに最後に記録した発言から後を取り直して埋めます。
  止まっている間に古いスレッドへ付いた返信は、埋め直しでは拾いません（親が最後に記録した発言より前にあるため）。
  Slack に断られた会話は飛ばして残りを埋め、次につなぎ直したときにまた試します。スレッド・発言者の名前・画像が取れなくても、発言は記録します
  （名前は `someone`、画像は「添付あり（取り込まず）」）。最後に、埋めた件数と失敗した会話の数を 1 行で出します。
- 出来事になるのは、bot への本物のメンションと DM だけです。受け取るとサーバーが `reaction` を付けます。同じ発言は何度届いても出来事 1 件です。
  名前が出ただけの発言やほかの発言は、次の合図の `updates` に件数で出ます。bot の発言（自分のものを含む）は出来事になりません。
- natsumi 自身の投稿にほかの人が付けたリアクションは、合図の `updates.slack.reactions_on_mine` にチャンネルごとの数で出ます。
  natsumi が自分で付けたもの、ほかの人の発言へのもの、見せる前に外されたものは数えません。
- natsumi が読むものには、Slack の ID（ts・チャンネル・ユーザー）を書きません。発言はワークスペース・チャンネル・日付・秒までの時刻・発言者で指します。
- 作業環境からは、data directory の `sources/` を `/sources` に読み取り専用でマウントします（compose.yaml に入っています）。
  natsumi は shell で読み、`view <パス>` で画像を見ます（`/sources/` の下の画像だけ、サーバーが答えます）。
- ログにはワークスペースの名前と失敗の種類だけを出し、発言や token、Slack の ID は出しません。
  Slack の API の失敗は、呼び出したメソッドと Slack のエラーのコード（足りない scope があればそれも）を出します。
  例: `slack (work): filling in a conversation failed (conversations.history: missing_scope, needed im:history)`。
  埋め直しの間は、同じ失敗は 1 度だけ出し、残りは最後の 1 行の件数に数えます。

### Slack に投稿する（ポッポさん）

natsumi は Slack に投稿するツールを持たず、`ask_agent` で送信役のポッポさん（`poppo`）に頼みます
（[ADR 0040](docs/adr/0040-the-dove-sends-what-the-judge-passes.md)）。ポッポさんはサーバーの中にいて、Slack の設定があるときだけ頼める相手の一覧に載ります。

- 依頼は見出し付きのテキスト（`返信先`・`種類`・`表情`、`---` の後が本文）です。書き方は natsumi 向けのマニュアル [manual/slack.md](manual/slack.md) にあります。
  返信先はファイルの発言の参照で、サーバーが記録と突き合わせます。形の崩れ、記録に無い参照、機械的な検査に当たる本文は、その場で断ります。
- 下書きは判定にかけます。問いは英語で、問題点ごとの点数（スレッドに無い情報、本人に代わる約束・期限、隠しごとの匂わせ、事実と違う説明、同意の捏造、私的な事情）と、
  スレッドかチャンネルかを聞きます。判定に見せるのは下書きと返信先の周りの発言だけです。
  - どの点数も `thresholds.owner`（既定 0.5）未満なら、本人の承認なしにそのまま送ります。
  - `thresholds.return`（既定 0.9）以上の問題があれば、理由を添えて natsumi に突き返します。同じ返信先で 3 回目の突き返しは、前の下書きと一緒に本人に回します。
  - その間なら、本人に回します。判定できなかったとき（判定なし）も本人に回します。
- 本人に回した投稿は承認待ちになり、iPhone で承認・修正・却下を選びます（API と通知は [サーバーと Mac の契約](docs/client-contract.md) の「承認と外部実行」）。
  期限（既定 7 日）を過ぎると閉じます。修正した本文は判定に掛け直しません。送る直前には、どの本文にも機械的な検査を掛けます。
- 投稿のアイコンは、natsumi の表情ごとの顔です。サーバーが認証なしの `/avatar/<表情>.png` で配り、`chat.postMessage` の `icon_url` に渡します
  （画像は `assets/avatar/`）。Slack App に `chat:write`・`chat:write.customize` が要ります（[Slack App の作り方](docs/slack-app.md)）。
- リアクションは、実在する絵文字ならどれでも付けます（[ADR 0042](docs/adr/0042-any-emoji-that-exists.md)）。標準の絵文字（肌の色を含む）と、
  ワークスペースのカスタム絵文字（`emoji.list`、別名を含む）にある名前だけを受け付け、判定も承認も通しません。
  カスタム絵文字の一覧は起動時にワークスペースごとに読み、1 時間持ちます。一覧に無い名前を頼まれたら読み直しますが、1 分に 1 度までです。
  Slack App に `emoji:read` が無く一覧を読めなければ、標準の絵文字だけで確かめ、ログに 1 行出します
  （例: `slack (work): the custom emoji could not be read (emoji.list: missing_scope, needed emoji:read)`）。
  以前の設定 `slack.reactions`（候補の一覧）は廃止し、書いてあると起動しません。
  標準の絵文字の名前は emoji-datasource（MIT License）から `scripts/slack-emoji-names.ts` で生成した `src/server/slack-emoji-names.ts` です。
- 投稿には `/work` の画像を付けられます（見出し `画像:`、[ADR 0044](docs/adr/0044-drawing-with-sdctl-and-posting-images.md)）。
  - サーバーは `/work` の下（リンクや `..` で外に出るものは断ります）の PNG・JPEG・WebP（中身で見分けます）だけを、`slack.postImages` の上限まで受け付けます。
  - 受け付けた時点で画像を `.natsumi/images/` に写し、ID を付けます。承認に見せるのも Slack に送るのもこの写しで、後で `/work` のファイルが変わっても変わりません。
  - 判定に掛けるのは本文だけです。本文の無い画像だけの投稿は、判定にも承認にも通さずに送り、置き場所は判定なしのときの決まりで決めます。
  - 送るのは `files.uploadV2` の 3 段（`files.getUploadURLExternal`・アップロード・`files.completeUploadExternal`）で、本文は画像のコメントになります。
    Slack App に `files:write` が要ります。Slack はアップロードにアイコンを指定させないので、画像付きの投稿は bot の既定のアイコンで出ます。
  - 承認待ちには画像の一覧が載り、アプリは `GET /v1/images/<imageId>`（ログインが要ります）で画像を取ります（[サーバーと Mac の契約](docs/client-contract.md) の「画像」）。
- 送った本文、判定の点数、置き場所、本人の判断、画像（写しのパス・大きさ・形式・SHA-256）は `.natsumi/state.sqlite`（migration 14・16）に残ります。
  画像の写しは `.natsumi/images/` にあります。どちらも個人データとしてバックアップの対象です。
- ログには判定の方式、ワークスペースの名前、Slack のメソッドとエラーのコード、判定の失敗の種類（例: `dove: judge: no verdict (no-answer-token)`）だけを出し、
  下書き、接続先、ID は出しません。

#### 判定の方式（`slack.judge`）

判定の方式は 2 つあり、どちらも同じ問いと同じ材料を使います。

- **`logprobs`（既定）**: OpenAI 互換のモデルに、問いごとに 1 回ずつ、思考なしで 1 トークンだけ答えさせ（`temperature 0`、`max_tokens 1`、`top_logprobs 20`）、
  最初のトークンの候補の確率から点数を出します。問題点は yes と no の確率の比、置き場所は A（thread）・B（channel）の確率を合計 1 にしたものです。
  答えのトークンが候補に無い、logprobs が返らない、思考のタグが出た、というときは判定なしです。
  接続先・API キー・model は、書かなければ既定の経路（`pi.defaultRoute`。`pi.model` だけの設定ならその経路）の `compatible` の `baseUrl`・`apiKeyEnv`/`apiKeyFile` と `model.id` を使い回します。経路を切り替えても変わりません。
  `pi` が OpenAI 互換のモデルでなく、`slack.judge` も無ければ、判定はせず、投稿はすべて本人の承認に回ります。
- **`jev`**: TypeSafe AI の Jev の API（`POST /v1/systemone`）、または同じ API を返すサーバーに、1 回の呼び出しで全部の問いを聞きます。

値は架空の例です。1 つ目は pi のモデルを使う既定のもの（書かなくても同じ）、2 つ目は Jev です。

```json
"judge": { "thresholds": { "owner": 0.5, "return": 0.9 } }
```

```json
"judge": { "method": "jev", "apiKeyFile": "/run/secrets/natsumi_jev_api_key" }
```

| 項目 | 既定 | 中身 |
| --- | --- | --- |
| `slack.judge.method` | `logprobs` | `logprobs` か `jev` |
| `slack.judge.baseUrl` | logprobs: 既定の経路の `compatible.baseUrl`、jev: `https://api.typesafe.ai` | 接続先。logprobs は OpenAI 互換の `…/v1`、jev は `/v1/systemone` の手前。http か https。ここで API キーを付けるなら、http で送れるのはループバックの相手だけです |
| `slack.judge.apiKeyEnv` / `apiKeyFile` | logprobs で接続先を書かなければ既定の経路の `compatible` のもの、ほかはなし | API キー。無ければ `Authorization` を付けません。pi のキーは、pi の接続先にしか送りません |
| `slack.judge.model` | logprobs: 既定の経路の `model.id`、jev: `jev-latest` | 要求の `model` |
| `slack.judge.concurrency` | 4 | logprobs で同時に聞く問いの数（1〜16） |
| `slack.judge.timeoutSeconds` | 30 | 1 つの下書きの判定の全体の待ち時間の上限（5〜300 秒）。過ぎたら判定なし |
| `slack.judge.thresholds.owner` / `.return` | 0.5 / 0.9 | 本人に回す・突き返すしきい値（0 より大きく 1 以下、owner ≦ return） |

- 接続先には下書きと周りの発言が出ます。natsumi のコンテナから届くように、出口の許可リストにその接続先を加えます（[ADR 0034](docs/adr/0034-an-allow-list-for-the-way-out.md)）。
- しきい値を決める前に、架空の場面で判定を評価できます。止めるべき下書き（匂わせ・嘘・約束・捏造した同意・私的な事情・スレッドに無い情報）と
  正しい投稿を判定させ、しきい値ごとに止めた数と正しい投稿を止めた数、場面ごとの時間を出します。本物の接続先を呼びます。

  ```sh
  JUDGE_BASE_URL=https://llm.example.net/v1 JUDGE_MODEL=my-model JUDGE_API_KEY_ENV=MY_KEY npm run probe:jev -- --thresholds 0.5,0.9
  ```

  `JUDGE_METHOD`（`logprobs` か `jev`）、`JUDGE_CONCURRENCY`、`JUDGE_TIMEOUT_SECONDS` も指定できます。
  キーは値ではなく、キーを入れた環境変数の名前を `JUDGE_API_KEY_ENV` で渡します。結果にキーの値は出ません。

### natsumi の作業環境（natsumi-workspace）

natsumi は `run_shell` でコマンドを動かします。コマンドは natsumi の中ではなく、閉じ込めたコンテナ
`natsumi-workspace` の中で動きます（[ADR 0011](docs/adr/0011-memory-shell-in-a-confined-container.md)、
[ADR 0019](docs/adr/0019-a-workspace-not-a-memory-tool.md)）。記憶を探す道具ではなく、記憶の整理も調べものも
下書きも集計もそこで行う作業机です。

- 構成
  - natsumi は、共有する小さな tmpfs の volume（`natsumi-workspace-socket`）にある Unix ソケットで、
    `natsumi-workspace` の実行役（runner）にコマンドを送ります。
  - natsumi に Docker のソケットは渡しません。
  - ツールは、設定の `loop.workspaceSocket`（設定例では `/run/natsumi-workspace/runner.sock`）があるときだけ使えます。
- 入っているもの: debian-slim に標準の道具（`coreutils`・`findutils`・`diffutils`・`grep`・`sed`・`gawk`・`tar`・`gzip`・`bash`）と、
  `ripgrep`・`jq`・`python3`（標準ライブラリのみ）・`git`・`procps`・`tzdata`、画像を作る `sdctl`、それに runner です。
  **使えるコマンドの一覧はもうありません。** 閉じ込めはコンテナの形だけで掛けます。
- 書ける場所は 4 つです。ルートは読み取り専用のままです。

  | 場所 | 永続 | 検査・コミット | 中身 |
  | --- | --- | --- | --- |
  | `/memory` | する | する | 記憶。`natsumi-data` の `memory/` |
  | `/memory/.git` | する | — | 読み取り専用で重ねます。履歴は natsumi の手の届かないところに置きます |
  | `/work` | する | しない | 手を動かす場所。`natsumi-data` の `work/` |
  | `/home/natsumi` | する | しない | natsumi のホーム。`natsumi-data` の `home/` |
  | `/tmp` | しない | — | 128 MB の tmpfs。コンテナの再起動で消えます |

  ほかに、読むだけの場所が 2 つあります（[ADR 0036](docs/adr/0036-a-manual-to-read-and-a-limit-on-waiting.md)）。
  `/manual` は natsumi 向けのマニュアル（リポジトリの [manual/](manual/) を image に焼いたもの）で、
  `/manual/agents` は natsumi が起動のたびに書き出す、頼める相手の一覧（`natsumi-data` の `agents/`、読み取り専用）です。
  system prompt には「やり方が分からないときは `/manual/INDEX.md` を読む」の 1 文だけがあり、使い方の説明はマニュアルの側に足します。

  `/work` と `/home/natsumi` はサーバーが見ません。ターンの終わりの検査もコミットも掛からず、
  git の差分でも見られません。中を見るときはオーナーが自分でコンテナに入ります。
  例外は、natsumi が `view` で見る画像と、ポッポさんへの依頼や `reply_to_mac` の `images` で名指しした画像だけです（サーバーが読みます）。
- 画像を作る（[ADR 0044](docs/adr/0044-drawing-with-sdctl-and-posting-images.md)）
  - natsumi は shell で `sdctl`（[yuanying/sdctl](https://github.com/yuanying/sdctl) の v0.3.1。image の build でソースから入れます）を使い、
    Stable Diffusion WebUI で画像を作ります。使い方は natsumi 向けの [manual/images.md](manual/images.md) にあります。
  - 既定の設定は image の `/etc/sdctl/anima.yaml`（リポジトリの [docker/sdctl/anima.yaml](docker/sdctl/anima.yaml)）です。
    Anima 系のモデル `anima_mignolia_v10` と VAE・text encoder を生成ごとの `override_settings` で指定し、Negative prompt、896×1152、30 steps、CFG 4.5、`ER SDE`・`simple` です。
    変えるには image を作り直します。
  - 接続先・既定の設定・出力の既定の `/work/images` は、image の `/etc/sdctl/config.yaml`（リポジトリの [docker/sdctl/config.yaml](docker/sdctl/config.yaml)）にあります。
    PATH の `sdctl` は、本物（`/usr/libexec/sdctl`）にいつもこのファイルを `--config` で渡すラッパーです。
    runner はコマンドにコンテナの環境変数を渡さないので（下の「環境変数」）、image の環境変数では natsumi のコマンドに届きません。
    natsumi は `sdctl txt2img --prompt <ファイル>` だけで作れ、保存したパスが 1 行出ます。
  - 接続先は `http://127.0.0.1:17860` です。Kubernetes の構成では、同じ Pod の出口の proxy がここで受けて token を付ける中継です
    （token は中継だけが持ちます。[権限と秘密の一覧](docs/permissions.md) の「作業環境」）。
    環境変数 `SDCTL_URL` があればそちらが勝つので、コンテナのシェル（`kubectl exec`）では Pod の渡す値を使います。番号を変えるときは環境の設定と両方を直します。
    Docker の構成（`compose.yaml`）には中継が無く、作業環境はネットワークを持たないので、sdctl は使えません。
- 画像を本人に見せる（[ADR 0045](docs/adr/0045-showing-the-owner-images-with-a-reply.md)）
  - natsumi は `reply_to_mac` の `images` に `/work` の下のパスを並べて、返事に画像を添えます。`notify_owner` には添えられません。
  - 検査はポッポさんへの依頼と同じで（`/work` の下の PNG・JPEG・WebP）、上限は 1 枚 10 MB、1 回 4 枚です（設定にはありません）。
    合わなければ本文も送らず、直し方をツールの結果で返します。
  - 呼んだ時点で `.natsumi/images/` に写し、会話の行に結び付けます。写しは会話と同じく消さず、backup に含まれます。
  - 端末は会話の行の `images` を見て、`GET /v1/images/<imageId>` で画像を取ります。iPhone の通知は本文だけで、末尾に「（画像 N 枚）」が付きます
    （[クライアントとの契約](docs/client-contract.md)）。
- 閉じ込め
  - ネットワークはありません（`network_mode: none`）。
  - `natsumi-data` の上の 3 つと、読み取り専用の `agents/` だけをマウントします。SQLite、Pi の状態領域、secrets、設定は見えません。
  - 非 root で動き、全 capability を外し、`no-new-privileges` を付けます。
  - `/tmp` には `noexec` を付けますが、**境界としては数えません。** インタプリタがある以上、
    `python3 /tmp/x.py` は止まりません。
- 上限
  - CPU 2、メモリ 1 GB（swap なし）、プロセス数 256
  - **1 つのコマンドに時間の上限はありません。** 応答の上限（60 秒）までに終わらなければ、
    そこまでの出力と「まだ動いている」印が返り、プロセスはそのまま動き続けます。
    返した後も runner が出力を読み捨て続けるので、コマンドが詰まることはありません。
    残ったプロセスを止めるのは natsumi です（`ps` と `kill`）。サーバーは止めません。
  - 出力は標準出力・標準エラー出力それぞれ 64 KiB まで（モデルに返すのは標準出力 8000 文字・標準エラー出力 2000 文字まで）
  - 1 つのコマンドの長さは 8000 文字まで。超えるとサーバーが送る前に拒否します。
  - 応答の上限と出力の上限は `compose.yaml` の `command` で、サーバー側の待ち時間は `loop.shellWaitSeconds` で変えられます。
- 環境変数: コマンドには `PATH`・`PWD`・`HOME`・`LANG`・`TZ` の 5 つだけを渡します。コンテナ自体の環境変数は空のままです。
  `TZ` はサーバーがコマンドごとに `loop.timeZone` を送ります（`NATSUMI_TIME_ZONE` は runner 側の既定値です）。
- 大きさ: `/memory`・`/work`・`/home/natsumi` の合計が `loop.workspaceSizeWarnBytes`（既定 1 GiB）を超えると、
  次のターンで natsumi に内訳つきで知らせます。強制はしないので、片づけないままだといつかはディスクが埋まります。
- UID: Docker の構成では、`natsumi-workspace` は natsumi と同じ UID で動かします（既定は 1000）。
  natsumi を別の UID で動かすときは、`NATSUMI_WORKSPACE_UID` に同じ値を入れます。
- 別の UID で動かす場合（Kubernetes の構成、[ADR 0033](docs/adr/0033-running-on-kubernetes.md)）は、サーバーと作業環境
  （と ssh でログインするユーザー）を共有のグループに入れ、そのグループで `/memory`・`/work`・`/home/natsumi` を読み書きします。
  - サーバーと runner は umask 007 で動きます。新しいファイルはグループが読み書きでき、グループ以外には見えません。
    ssh でログインするユーザーも umask 007 にしてください。
  - サーバーは data directory の `memory/`・`work/`・`home/` を、setgid 付きの 2770 で作ります。
    中に作られるファイルとディレクトリは、誰が作っても共有のグループになります。
    相手の一覧の `agents/` も同じ作り方で、一覧のファイルはグループが読める 0640 で書きます（作業環境からは読むだけです）。
  - サーバーだけが使うもの（`.natsumi/` の SQLite と証明書、Pi の状態領域）は 0700 のディレクトリに置かれ、グループからも見えません。
  - サーバーの git は、持ち主の違う記憶のリポジトリを `safe.directory` で扱い、そのままコミットします。
  - 既にあるディレクトリの持ち主と権限は変えません。既存のデータを移すときは、3 つの場所の中身のグループを共有のグループにし、
    グループの書き込みと、ディレクトリの setgid を付けてください。umask か setgid が外れると、サーバーが記憶をコミットできなくなります。
  - runner は `-socket` のディレクトリが無ければ作ります。持ち主の違う volume（Pod の `emptyDir` など）では、
    その下のサブディレクトリをソケットの置き場に指定します（例: `/run/natsumi-workspace/runner/runner.sock`）。
- 起動の順番: natsumi が初回の起動で `memory/`・`work/`・`home/`・`agents/` を作るので、`natsumi-workspace` は
  natsumi が healthy になってから起動します。
- 閉じ込めの確認: [scripts/check-workspace-sandbox.sh](scripts/check-workspace-sandbox.sh) が、使い捨ての project で
  2 つのコンテナを起動し、コンテナの形（ネットワーク、マウント、権限、資源の上限、見えない秘密、環境変数）と、
  終わらないコマンドが応答の上限で返りそのプロセスが生き残ることを、runner 経由で確かめます。
  image 名を変える override を用意して、先に build してから実行します。
  **運用中の環境と同じ image 名で build すると、そのタグを上書きします。** build する前に
  `docker compose ... config --images` に `:local` が出ないことを確かめてください。

### 固定 IPv6 で公開する

ルーターの RA で IPv6 のプレフィックスが配られる external network に、固定の IPv6 アドレスで直接つなぐ構成を、
override の [compose.ipv6.example.yaml](compose.ipv6.example.yaml) として用意しています。証明書は Let's Encrypt から取得します
（[ADR 0007](docs/adr/0007-acme-and-fixed-ipv6.md)）。このファイルの値はすべて架空のものです。

```sh
docker compose -f compose.yaml -f compose.ipv6.example.yaml up -d
```

- network の前提: Docker から見て IPv4 だけの external network で、同じリンクのルーターが /64 のプレフィックスを RA で配っていること。
  Docker はプレフィックスを知らないので、Docker にアドレスを割り当てさせることはできません。
- 仕組み: `natsumi-net` コンテナがネットワークの名前空間を持ち、そのインターフェースだけ IPv6 を有効にして、
  `ip token` でインターフェース ID（トークン）を設定します。アドレスは RA のプレフィックスとトークンで決まります。
  natsumi はその名前空間を共有し、非 root・全 capability なしのまま 80 / 443 で待ち受けます。
  `NET_ADMIN` を持つのは `natsumi-net` だけです。natsumi だけを再起動しても、アドレスは変わりません。
- トークンを設定できない、トークンのアドレスが 60 秒以内に使えるようにならない、アドレスが重複している、のいずれかの場合、
  `natsumi-net` はエラーを出して終了し、natsumi は起動しません。
- 実際の値: Git の追跡対象外の `.env` に、network 名を `NATSUMI_IPV6_NETWORK`、トークン（例: `::10`）を `NATSUMI_IPV6_TOKEN` として書きます。
  どちらかが未設定だと compose が止まります。設定ファイルは `NATSUMI_CONFIG` で指定し（既定は `config.acme.example.json`）、
  `publicOrigin` に実際のホスト名を、`listen` に 443 番と `acme` を書きます。この構成では GitHub の client secret だけをマウントします。
- DNS: `publicOrigin` のホスト名に、プレフィックスとトークンからなるアドレスの AAAA レコードを作ります
  （例: プレフィックスが `2001:db8:0:1::/64`、トークンが `::10` なら `2001:db8:0:1::10`）。IPv4 のアドレスは外から届かないので、A レコードは作りません。
- ファイアウォール: そのアドレスへの tcp 443（HTTPS）と tcp 80（ACME の challenge）を外から通します。
- 証明書とアカウント鍵は `natsumi-data` volume の `.natsumi/acme/` に入ります。volume ごとバックアップしてください。
- `natsumi-net` を再作成すると、natsumi も再起動します。
- 名前空間にはトークンのアドレスのほかに自動設定のアドレスが残ることがあり、外向きの通信の送信元はそちらになり得ます。

### 公開の image

版の tag（`v0.x.y`）を push すると、GitHub Actions（[.github/workflows/images.yml](.github/workflows/images.yml)）が
テストを通したうえで、`ghcr.io/yuanying/natsumi`（サーバー）と `ghcr.io/yuanying/natsumi-workspace`（作業環境）を
amd64 でビルドして push します（[ADR 0033](docs/adr/0033-running-on-kubernetes.md)）。image の tag は版の tag そのものです。
`latest` は付けません。動かす版は、環境の設定の側で固定します。

## Mac アプリ

`mac/` に Xcode プロジェクトがあります（[ADR 0010](docs/adr/0010-mac-app-structure.md)）。macOS 15 以降と Xcode 27 を使います。
署名は ad-hoc で、Apple Developer のチームや証明書は要りません。配布（公証・自動更新）はまだ扱っていません。

```sh
xcodebuild build -project mac/Natsumi.xcodeproj -scheme Natsumi -destination 'platform=macOS' -derivedDataPath mac/build
xcodebuild test -project mac/Natsumi.xcodeproj -scheme Natsumi -destination 'platform=macOS' -derivedDataPath mac/build
```

- scheme `Natsumi` は、アプリ `Natsumi`、ロジックの framework `NatsumiCore`、そのテスト `NatsumiCoreTests` を含みます。
  テストは外部ネットワークにもサーバーにも接続しません。Keychain を使うテストがあるため、ログイン中のユーザーの GUI のセッション
  （ターミナル.app など）で実行してください。SSH のセッションからはキーチェーンを開けません。
- build 結果は `mac/build/`（Git の追跡対象外）にでき、アプリは `mac/build/Build/Products/Debug/Natsumi.app` です。
- Mac がスリープから起きると、アプリはサーバーにつなぎ直し、寝ている間の会話（iPhone で話した分など）を取り込みます。
  接続が開いている間は 20 秒ごとに ping を送り、答えが無ければつなぎ直します（[ADR 0037](docs/adr/0037-catching-up-after-sleep-and-pinging-the-socket.md)）。
- 本文の中の `http://`・`https://` の URL は下線付きのリンクになり、クリックすると既定のブラウザで開きます。
  吹き出しや知らせのリンクを開いても既読にはなりません（[ADR 0038](docs/adr/0038-links-in-what-she-says.md)）。

### 使い方

1. アプリを起動すると、メニューバーにアイコンが、デスクトップにキャラクターが出ます。キャラクターはドラッグで動かせます。
2. キャラクターを右クリック（または control キーを押しながらクリック）して出るメニューの「設定…」で、サーバーの URL（例: `https://natsumi.example.net`）を入れて保存します。
3. 「GitHub でログイン」で、ブラウザのシートからログインします。セッションのトークンは Keychain にだけ保存されます。
   サーバーのセッションは最後に使ってから 30 日で切れ、使っている間は延びます（[ADR 0030](docs/adr/0030-a-session-that-lasts-while-it-is-used.md)）。
   アプリは延びた期限を受け取って Keychain の期限も延ばすので、30 日まったく使わなかったときか、セッションが失効したときにだけ、ログインを求められます。
4. キャラクターをクリックすると、会話のウインドウが出ます。初回はキャラクターの真下に出て、以後は前回置いた場所に出ます（キャラクターを動かしても付いてきません）。
   下の欄に書いて Enter で送り、Shift+Enter で改行します（日本語の変換を確定する Enter では送りません）。
   ウインドウを消すのは、⌘W、タイトルバーの閉じるボタン、もう一度キャラクターをクリック、のどれかです。ほかのアプリをクリックしても消えません。
   - どのアプリを使っていても、⌃⌥N（Control+Option+N）で会話のウインドウが前に出て、そのまま書き始められます。出ているときに押しても消えません。
     組み合わせは設定の「ショートカット」で変えられます（ボタンを押してから新しい組み合わせを押す。⌘・⌃・⌥ のどれかが要ります）。「なし」で無くせます。
   - 右上のボタンか ⌘L で、入力欄の上に履歴が上下に開きます。もう一度押すと開く前の場所に畳みます（開いたあとに動かしていれば、その場で畳みます）。開いたまま消せば、次も開いた状態で出ます。
   - ウインドウはタイトルバーのある普通のウインドウで、縁をドラッグして大きさを変えられます。畳んだときの高さと開いたときの高さは別々に、幅は共通で覚え、次の起動でも残ります。
   - 上の行には接続の状態が常に出ます。ログインが必要なときなどは、そこに「GitHub でログイン」などのボタンが出ます。
5. natsumi の最後の返事が、まだ読んでいなければ、キャラクターの上の白い吹き出しに 1 件だけ出ます。新しい返事が届けば入れ替わり、既読になれば消えます。
   - 本文の下には「未読 N 件」と、確かめていない返事の数が出ます。
   - 本文をクリックすると全文が開き、もう一度クリックすると畳みます。開いただけでは既読になりません。
   - 右上の × と、キャラクターの右クリックのメニューの「返事をすべて既読にする」は、最後の返事までをすべて既読にします。
   - 会話のウインドウで履歴を開いていて、そのウインドウを使っている（key になっている）間は、見えている返事まで既読になります。この間は、届いた返事も吹き出しには出ません。
     ウインドウを開いたまま別のアプリを使っている間や、履歴を畳んで入力欄だけにしている間は既読にならず、返事は吹き出しに出ます。
   - 長い発言は 120 文字・5 行までを出し、「続きは履歴で」から全文を見られます。
   - 送った直後は「受付中」、返事を考えている間は「考え中」の雲の吹き出しが、返事の代わりに出ます。
   - 既読かどうかはサーバーに記録され、ほかの Mac とも共通です。ほかの Mac で読んだ返事は、こちらの吹き出しからも消えます。
   - natsumi が返事に画像を添えたときは、本文の下に小さな縮小画像が並びます（[ADR 0045](docs/adr/0045-showing-the-owner-images-with-a-reply.md)）。
     履歴の行にも同じように出ます。クリックすると別の窓で大きく開き、閉じるボタン・Esc・⌘W で閉じます。見ても既読にはなりません。
     画像は出すときに初めてサーバーから取り、ログアウトするまでアプリの中に持ちます。取れなかった画像の場所には印が出て、本文はそのまま読めます。
6. natsumi からの知らせは、返事とは別に、吹き出しのさらに上（返事が無ければキャラクターのすぐ上）の黄色い束に出ます。キャラクターの右上には、確かめていない知らせの件数の黄色い印が付きます。
   - 本文をクリックすると全文が開きます。右上の × は前に出ている知らせを確かめて、次の知らせを前に出し、印の件数が減ります。右クリックのメニューの「知らせをすべて確認する」は、すべての知らせを確かめて閉じます。
   - 後ろに重なっている知らせの件数は、本文の下に「あと N 件」と出ます。
   - 印をクリックすると、知らせの束を隠したり出したりできます。隠しても確かめたことにはならず、新しい知らせが届くとまた出ます。
   - 履歴に残っていない古い知らせは、「前の知らせが N 件」の 1 枚にまとめて出し、クリックでまとめて確かめます。
7. 過去の会話は、会話のウインドウの右上のボタン（⌘L）、キャラクターの右クリックのメニュー、メニューバーの「履歴を開く」、吹き出しの「続きは履歴で」のどれかで、会話のウインドウの入力欄の上に開きます。
   知らせは黄色で「お知らせ」が付き、確かめていない返事と知らせには「未読」「未確認」の印が付きます。返事の「未読」は、ウインドウを使っている間に見えると消えます。
8. キャラクターの右クリックのメニューには、話しかける・履歴を開く・返事をすべて既読にする・知らせをすべて確認する・モデル・設定…・ログアウト・終了があります。メニューバーのアイコンには、既読と確認の 2 つを除く同じ項目があります。
9. キャラクターの大きさは、設定の「キャラクター」で 50% から 200% まで 25% 刻みで変えられます。すぐに反映され、次の起動でも残ります。
10. natsumi が考えるのに使うモデルの経路（上の「モデルの経路を切り替える」）は、設定の「モデル」と、メニュー（キャラクターの右クリックとメニューバー）の「モデル: <経路>」で見て切り替えられます。
    - 設定には、いま話している経路とモデル、経路の一覧（「使用中」「次のターンから」「既定」「使えません」の印）が出ます。
      「切り替える」を押すと、次のターンからその経路に移ります。移るまでは「次のターンから <経路> に切り替わります」と出ます。
      会話の履歴も思考の記録もそのまま続きます。
    - 使える状態にない経路と、選んである経路は押せません。断られたとき（設定に無い、使えない、natsumi が話せない）は理由が出ます。
    - どの経路も使えず natsumi が話せないときは、「なつみはいま話せません」と赤く出ます。メニューの題も「モデル: 話せません」になります。
    - サーバーのコマンドや別の端末で切り替えても、すぐにこちらの表示に反映されます。設定を開くたびに、サーバーに一覧を確かめ直します。

キャラクター・吹き出し・知らせの束・会話のウインドウは、どれもほかのウインドウの上に浮かび、すべての Space と全画面表示のアプリの上にも出ます。

- 知らせの束・吹き出し・キャラクターは、上からこの順に、キャラクターの中心の縦の線にそろって一列に並び、キャラクターと一緒に動きます。
- 画面の上の端では、一列が上下に反転します（キャラクターの下に吹き出しと知らせ）。
- 横の端では、パネルだけが内側にずれます。
- 高さが足りないときは、重なりを減らし、本文の行数を減らします。
- パネルを出したり隠したりしても、キャラクターの位置は変わりません。キャラクターが動くのは、ドラッグしたときと大きさを変えたときだけです。
- 会話のウインドウは一列に入らず、キャラクターにも付いてきません。置いた場所に留まります。
- 吹き出しと知らせは、黒い輪郭の漫画の吹き出し風で、ダークの外観でも白地（知らせは黄色地）に黒い文字です。会話のウインドウは外観に従います。
会話のウインドウはキーボードの入力を受け取りますが、アプリを前面にしないので、それまで使っていたアプリは前面のままです。

ad-hoc 署名はビルドのたびに変わるため、ビルドし直したアプリが Keychain のトークンを読むときに、確認のダイアログが出ることがあります。

### アバターを差し替える

キャラクターの絵は、既定では同梱の `mac/Avatars/natsumi/` を使います。自分のアセットを試すときは、次の場所に置きます
（設定の「アバター」で場所を変えられます）。ここに読めるアセットがあれば、同梱のものより優先します。どちらも読めなければ、仮の絵（絵文字）になります。

```sh
mkdir -p ~/Library/Application\ Support/natsumi/avatar
cp <アセットのディレクトリ>/pet.json <アセットのディレクトリ>/spritesheet.webp ~/Library/Application\ Support/natsumi/avatar/
```

- 形式は Codex のペット（`pet.json` と、その `spritesheetPath` の spritesheet。1 マス 192×208 で 8 列）です。
- `avatar.json` を置くと、atlas（`atlas`・`animations`）、再生の速さ（`framesPerSecond`）、サーバーの表情から動作への対応表（`expressions`）を変えられます。
  書き方は同梱の [avatar.json](mac/Avatars/natsumi/avatar.json) を見てください。対応表にない表情は neutral の動作で表示します。
- 置いた後は、設定の「読み込み直す」で反映します。

## iPhone アプリ

同じ `mac/Natsumi.xcodeproj` に iPhone のアプリ `NatsumiPhone` があります（[ADR 0028](docs/adr/0028-the-iphone-client.md)）。
iOS 26 以降の iPhone と Xcode 27 を使います。ロジックは Mac と同じ `NatsumiCore` で、そのテストは Mac の scheme で走ります。

```sh
xcodebuild build -project mac/Natsumi.xcodeproj -scheme NatsumiPhone -destination 'generic/platform=iOS Simulator' -derivedDataPath mac/build
```

- シミュレータではそのまま動きます。

実機に入れるときは、iOS のときだけ自動署名になるようにしてあるので、次の手順で Xcode にチームを選ばせます。

1. Xcode の Settings… > Accounts に Apple ID を足します。通知（Push Notifications）の entitlement があるので、
   有料の Apple Developer Program のチームが要ります。
2. `mac/Natsumi.xcodeproj` を開き、ターゲット `NatsumiPhone`・`NatsumiWidgets`・`NatsumiNotifications`・`NatsumiCore` の
   Signing & Capabilities で Team を選びます。`NatsumiWidgets` と `NatsumiNotifications` はアプリに埋め込む拡張、
   `NatsumiCore` は埋め込む framework なので、こちらにも要ります。Team を選ぶと `DEVELOPMENT_TEAM` がプロジェクトのファイルに書かれます。
3. Bundle Identifier（`io.github.yuanying.natsumi.phone` と、拡張の `….phone.widgets`・`….phone.notifications`）がほかの人に
   取られていると断られます。その場合は自分のものに変えます。拡張のものはアプリのものの後ろに続けます。
   Keychain の共有グループ（`io.github.yuanying.natsumi.shared`。アプリと `NatsumiNotifications` の entitlements と Info.plist にあります）も、
   同じく自分のものに変えます。
4. iPhone を USB でつなぎ、iPhone 側で「このコンピュータを信頼」を選び、Xcode の実行先に選んで ⌘R で入れます。
5. 初回は iPhone の 設定 > 一般 > VPN とデバイス管理 で、自分の Apple ID の開発者を信頼します。

実機は Mac の `localhost` に届かないので、偽のサーバーではなく本物のサーバー（https）につなぎます。
- 起動するとログインの画面が出ます。サーバーの URL を入れて「GitHub でログイン」を押します。セッションのトークンは Keychain にだけ保存されます。
- メインの画面には、キャラクター・最後の未読の返事（全文。長いときは吹き出しの中だけがスクロールします）・知らせ・入力欄が出ます。
  吹き出しの × は、Mac と同じく最後の返事までを既読にします。
- 入力欄に入ると、キャラクターは気持ちの顔になって入力欄の上に寄り、彼女のセリフがその横に出ます。送ったメッセージは「受付中…」と出ます。
  「閉じる」でキーボードを下ろすと、元の画面に戻ります。
- 右上のボタンで会話の履歴と設定を開きます。知らせのカードを押しても履歴が開きます。
  履歴で見えた返事は既読に、見えた知らせは確認済みになります。
  natsumi が返事に添えた画像は、履歴の行に縮小画像で出ます（[ADR 0045](docs/adr/0045-showing-the-owner-images-with-a-reply.md)）。
  タップすると画面いっぱいに開き（ピンチで拡大、ダブルタップで戻す）、「閉じる」で戻ります。メインの吹き出しと通知には画像は出ません
  （通知の本文の末尾に「（画像 N 枚）」と付きます）。
- 設定には、サーバー・接続の状態・モデルの経路・この端末の ID と、ログアウトがあります。
  モデルの経路は Mac と同じく、いま話している経路と一覧が出て、行を押すと次のターンからその経路に移ります
  （上の「モデルの経路を切り替える」）。使えない経路は押せず、natsumi が話せないときは赤く出ます。
- natsumi の Slack の投稿が本人の承認を待っていると、状態の下に「承認待ち N 件」が出ます（[ADR 0041](docs/adr/0041-approving-slack-posts-on-the-iphone.md)）。
  押すと一覧、行を押すと 1 件の画面になり、返信先・置き場所・下書き・回った理由と問題点ごとの点数・前の突き返しを見て、
  「承認して送る」「修正」「却下」を選べます。返す相手の発言があるときは、スレッドかチャンネルかも選び直せます。
  投稿に画像が付くときは「一緒に送る画像」に並び、タップで大きく見られます。承認が閉じると画像は捨て、枚数だけを出します。
  送った結果（送れなかったときはその理由）はその画面に出ます。
- 吹き出しと履歴の本文の `http://`・`https://` の URL はリンクになり、タップすると既定のブラウザで開きます（[ADR 0038](docs/adr/0038-links-in-what-she-says.md)）。
- アプリが裏に回ると接続を切り、前に戻ると続きから同期し直します。
- 裏にいる間の返事と知らせは、通知で届きます（[ADR 0029](docs/adr/0029-push-notifications-on-the-iphone.md)。サーバーの設定は上の「iPhone への通知」）。
  ログインすると通知を許可するか尋ねられます。本文はこの iPhone の鍵で暗号化されて届き、アプリの拡張 `NatsumiNotifications` が開いて、
  セリフと気持ちの顔を出します。開けなかったときは「返事があります」「知らせがあります」とだけ出ます。
  承認待ちの通知はチャンネルと下書きの先頭を出し、タップするとその承認を開きます。
  バッジは未読の返事と未確認の知らせと承認待ちの数で、Mac で読んだ分の通知は消えます（iOS が間引くと、次にアプリを開いたときに消えます）。
  送り先（sandbox か production か）は、アプリの署名の provisioning profile から決まります。
- シミュレータでも登録までは動きますが、`xcrun simctl push` は拡張を通らないので、本文を開くところは実機で確かめます。
- ロック画面からも開けます。ロック画面を長押しして「カスタマイズ」を選び、下の隅のボタンを「なつみを開く」に替えるか、
  時計の下のウィジェットに「なつみ」を足します。同じボタンはコントロールセンターとアクションボタンにも置けます。
  どちらもアプリを開くだけで、ロック画面に会話は出ません。

### TestFlight で配る

USB で入れたアプリは、開発用の署名の期限が切れるたびに入れ直しが要ります。GitHub Actions でビルドして TestFlight に上げると、
iPhone の TestFlight アプリが新しいビルドを自動で入れます（[ADR 0031](docs/adr/0031-the-iphone-app-through-testflight.md)）。
ワークフローは [.github/workflows/iphone-testflight.yml](.github/workflows/iphone-testflight.yml) です。

最初に一度だけ、次を用意します。

1. **App Store Connect にアプリを作る。** アプリ > ＋ > 新規 App で、プラットフォームは iOS、バンドル ID は
   `io.github.yuanying.natsumi.phone`、SKU は好きな文字列にします。バンドル ID は Xcode の自動署名で登録済みのものが選べます。
   名前は App Store 全体で重複できないので、取られていたら別の名前にします（iPhone のホーム画面の名前は `natsumi` のままです）。
2. **App Store Connect の API キーを作る。** ユーザとアクセス > 統合 > App Store Connect API > チームキーで、アクセスを **Admin** にして
   鍵を作ります。クラウドで管理される配布用の証明書を使うのに Admin が要ります。.p8 はダウンロードできるのが 1 度だけです。
   キー ID と、ページの上にある Issuer ID を控えます。
3. **開発用の証明書を .p12 に書き出す。** Mac のキーチェーンアクセスで、自分の「Apple Development: …」の証明書を秘密鍵ごと選び、
   パスワードを付けて .p12 に書き出します。archive の署名に使います（これがないと、ワークフローは走るたびに開発用の証明書を
   新しく作ってしまい、上限に達して止まります）。証明書は 1 年で切れるので、切れたら書き出し直して Secrets を差し替えます。
   開発用の provisioning profile には登録済みの端末が要ります。USB でアプリを入れた iPhone が登録されていれば足ります。
4. **GitHub の Secrets に登録する。** リポジトリの Settings > Secrets and variables > Actions に、次の 5 つを足します。
   .p8 と .p12 は base64 にします（例: `base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy`）。

   | 名前 | 中身 |
   |---|---|
   | `ASC_KEY_ID` | API キーのキー ID |
   | `ASC_ISSUER_ID` | API キーの Issuer ID |
   | `ASC_KEY_P8` | .p8 を base64 にしたもの |
   | `APPLE_DEVELOPMENT_P12` | 開発用の証明書の .p12 を base64 にしたもの |
   | `APPLE_DEVELOPMENT_P12_PASSWORD` | .p12 に付けたパスワード |

5. **自分を内部テスターにする。** App Store Connect のアプリ > TestFlight > 内部テストでグループを作り、自分を足します。
   ビルドを自動で配る設定にしておくと、上がるたびに届きます。
6. **iPhone に TestFlight アプリを入れる。** App Store から入れ、届いた招待を受けます。TestFlight アプリの設定で自動アップデートを有効にします。

ワークフローは次のときに走ります。

- 手動: Actions > iPhone TestFlight > Run workflow。
- main への push: `mac/` のうち iPhone のアプリに入るものが変わったとき。Mac だけのコード・テスト・文書の変更では走りません。
- 定期: 毎月 1 日。TestFlight のビルドは 90 日で使えなくなるので、変更がなくても作り直します。
- pull request では走りません。public のリポジトリなので、fork からの PR に署名の Secrets を渡さないためです。

- ビルド番号はワークフローの run の番号、版は `1.0` です（ワークフローの `MARKETING_VERSION`）。同じ run を再実行すると
  ビルド番号が重なって断られるので、作り直すときは新しく走らせます。
- Xcode は `xcode-27` のイメージ（2026-09 時点で preview）の Xcode 27.0 を使います。
- 上がったビルドは、App Store Connect の処理が終わってから TestFlight に出ます。輸出規制の質問は Info.plist の
  `ITSAppUsesNonExemptEncryption`（`NO`。OS の暗号を標準の方式で使うだけのため）で済ませているので、毎回答える必要はありません。
- TestFlight のビルドは配布用に署名されるので、通知は production の APNs に登録されます。サーバーは登録の `environment` で
  送り先を選ぶので（上の「iPhone に通知を送る」）、サーバーの設定を変える必要はありません。APNs の鍵は sandbox と production の両方に使えます。
- USB で入れたアプリと同じ bundle ID なので、後から入れた方に置き換わります。
- **定期実行が止まることがあります。** public のリポジトリでは、60 日間リポジトリに動き（コミットなど）がないと、GitHub が定期実行の
  ワークフローを止め、メールで知らせます。止まったら Actions の画面でワークフローを有効にし直すか、手動で走らせてください。
  最後に上がったビルドは、上がってから 90 日は使えます。

### 偽のサーバーで確かめる

GitHub もモデルも使わずに画面を確かめるための、偽のサーバーがあります。`http://localhost:8787` で待ち受け、
ログインは GitHub を通さずに通り、架空の会話と知らせを返し、送ったメッセージには少し考えてから返事をします。
Slack の投稿の承認待ちも架空のものを 2 件持ち、最初の同期から `--approval-delay` 秒（既定 8 秒、0 で送らない）後に 1 件を
`approval.pending` で足します。承認・修正・却下には契約どおりに答え（承認と修正は少し後に `delivery: sent` で閉じ、却下はその場で閉じます）、
閉じた承認への 2 回目の決定には最初の状態を、違う revision には `stale-revision` を返します。ログアウトすると承認待ちは最初の 2 件に戻ります。
チャンネルへの投稿の承認待ちには画像が 2 枚付き、`GET /v1/images/<imageId>` に `Authorization: Bearer fake-token` を付けると画像を返します（無ければ 401）。
会話にも画像を 2 枚添えた返事が 1 件あり、「絵」か「画像」を含むメッセージには画像を 1 枚添えて返事をします。
モデルの経路は架空の 3 つ（使っている `local`、使える `plus`、使えない `spare`）で、`model.use` を受け付けてから
`--switch-delay` 秒（既定 2 秒）後に `model.routes` で移ります。ログアウトすると `local` に戻ります。

```sh
npm ci
npm run fake-server -- [--port 8787] [--reply-delay 5] [--short] [--approval-delay 8] [--switch-delay 2]
```

偽のサーバーそのもののテストは `test/fake-server.test.ts` にあり、`npm test` で走ります。

シミュレータのアプリでは、サーバーに `http://localhost:8787` を入れてログインします。
UI テスト `NatsumiPhoneUITests` は、この偽のサーバーを相手にログイン・返事・履歴・設定・ログアウトまでと、
承認待ちの件数・一覧・1 件の画面から承認・修正・却下までと、履歴と承認の画面の画像を開いて閉じるまでと、
設定でモデルの経路を `plus` に切り替えて移るまでを辿り、画面を撮ります
（偽のサーバーを先に起動してください。別のポートで動かすときは `TEST_RUNNER_NATSUMI_SERVER` に URL を渡します）。撮った画面は結果の bundle に添付され、`TEST_RUNNER_NATSUMI_SCREENSHOTS` に
ディレクトリを渡すとそこにも書き出されます。

```sh
TEST_RUNNER_NATSUMI_SCREENSHOTS=/tmp/natsumi-shots \
  xcodebuild test -project mac/Natsumi.xcodeproj -scheme NatsumiPhone -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath mac/build
```

## ライセンス

- コードは [MIT License](LICENSE) です。
- `mac/Avatars/` のアバターのアセットは [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) です。
  キャラクターの参照画像は Anima で、spritesheet は OpenAI の画像生成で作りました（[詳細](mac/Avatars/natsumi/README.md)）。

## 文書

- [設計 ADR](docs/adr/0001-server-and-data-ownership.md): データ所有権、[通信・承認](docs/adr/0002-client-events-and-approvals.md)、[外部連携](docs/adr/0003-assistance-and-integrations.md)、[Pi のツール・認証・音声](docs/adr/0004-pi-tool-and-voice-boundaries.md)、[サーバー基盤](docs/adr/0005-server-foundation.md)、[GitHub ログインと HTTPS/WSS](docs/adr/0006-github-login-and-transport.md)、[Let's Encrypt と固定 IPv6](docs/adr/0007-acme-and-fixed-ipv6.md)、[単一の思考ループと Mac との会話](docs/adr/0008-single-thinking-loop-and-mac-conversation.md)、[長期記憶と夜の session の切り替え](docs/adr/0009-long-term-memory-and-nightly-session-switch.md)、[Mac アプリの構成](docs/adr/0010-mac-app-structure.md)、[閉じ込めたコンテナで記憶を shell で探す](docs/adr/0011-memory-shell-in-a-confined-container.md)、[Slack 連携と同僚 AI](docs/adr/0012-slack-and-colleagues.md)、[本人が確かめたことをサーバーで持つ](docs/adr/0013-read-state-on-the-server.md)、[自分で予約する確認と定期の合図](docs/adr/0014-self-checks-and-pings.md)、[Mac の UI は一本の木の Passive View](docs/adr/0015-mac-ui-passive-view-tree.md)、[カードを開く操作とキャラクターの移動](docs/adr/0016-opening-a-card-and-moving-the-character.md)、[考えている 1 行を流す](docs/adr/0017-streaming-the-line-she-is-thinking.md)、[記憶を git で持ち、夜に組み直す](docs/adr/0018-memory-in-git-and-the-nightly-rebuild.md)、[記憶の道具をやめ、なつみの作業環境にする](docs/adr/0019-a-workspace-not-a-memory-tool.md)、[外のエージェントと A2A で話す](docs/adr/0025-talking-to-outside-agents-over-a2a.md)、[セリフごとに気持ちを載せる](docs/adr/0026-a-feeling-on-each-line.md)、[履歴のセリフに気持ちの顔を添える](docs/adr/0027-her-face-beside-each-line-in-the-history.md)、[iPhone のクライアント](docs/adr/0028-the-iphone-client.md)、[本番を Kubernetes に置く](docs/adr/0033-running-on-kubernetes.md)、[出口を許可リストで絞る](docs/adr/0034-an-allow-list-for-the-way-out.md)、[外のエージェントに頼むツールと、返事の受け取り方](docs/adr/0035-asking-outside-agents-and-hearing-back.md)、[読み取り専用のマニュアルと、返事を待ち続ける上限](docs/adr/0036-a-manual-to-read-and-a-limit-on-waiting.md)、[スリープから起きたらつなぎ直し、開いている接続は ping で確かめる](docs/adr/0037-catching-up-after-sleep-and-pinging-the-socket.md)、[本文の中の URL をリンクにし、クリックでブラウザを開く](docs/adr/0038-links-in-what-she-says.md)、[Slack は読むファイルとして受け取り、ポッポさんは問題点ごとの点数で判定する](docs/adr/0039-slack-as-files-and-a-scored-dove.md)、[ポッポさんは判定が通したものを送り、本人には回されたものだけを承認してもらう](docs/adr/0040-the-dove-sends-what-the-judge-passes.md)、[Slack の投稿を iPhone で承認する](docs/adr/0041-approving-slack-posts-on-the-iphone.md)、[ポッポさんは実在する絵文字ならどれでもリアクションに付ける](docs/adr/0042-any-emoji-that-exists.md)、[Slack のリアクションをチャンネルのファイルに書き、なつみの投稿へのものを合図で知らせる](docs/adr/0043-reactions-in-the-channel-files.md)、[なつみは作業環境の sdctl で画像を作り、ポッポさんへの依頼で Slack に投稿する](docs/adr/0044-drawing-with-sdctl-and-posting-images.md)、[なつみは reply_to_mac の返事に画像を添えて、本人に見せる](docs/adr/0045-showing-the-owner-images-with-a-reply.md)、[モデルの経路に名前を付けて並べ、本人が手で切り替える](docs/adr/0046-named-model-routes-switched-by-hand.md)、[終わったターンを畳んで一行メモを残し、read で読んだものは残す](docs/adr/0047-folding-ended-turns-with-a-memo.md)
- [サーバーと Mac の契約・実装順](docs/client-contract.md)
- [権限と秘密の一覧](docs/permissions.md): サーバーが外に対して持つ権限・秘密・外への出口と、受け付ける認証
- [実接続の実行方法と結果](docs/probe-results.md)
- [設定例](config.example.json)（証明書ファイル）と [ACME の設定例](config.acme.example.json): 現在サーバーが受け付ける設定だけを載せています。後続の実装で項目を追加します。検証ハーネスはこのファイルを読みません。

個人 Markdown、SQLite、Pi の session・認証、ログ、private Wiki、証明書や secret はコード checkout の外に置きます。
ignore は事故防止の補助です。設定例を実環境に合わせたファイルは `config.local.json` として管理し、
秘密は環境変数や secret mount で渡します。個人データを公開 Git に保存しません。
