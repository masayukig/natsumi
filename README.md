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

プロンプトやソースの変更でなつみが期待どおりに動くかは、`npm run eval` で確かめます。本物の思考ループで 1 ターンを回し、
場面ごとの成功率を出して、版どうしで比べます（[使い方と場面の書き方](eval/README.md)）。`npm test` はこれを偽のモデルで回します
（Go と bubblewrap がなければ、その試験だけ skip するか、閉じ込めずに回します）。

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
     （既定 30 分、`false` で合図を出さない）、表情が neutral に戻るまでの時間 `expressionResetMinutes`（既定 3 分）。
     自分で予約する確認の上限 `selfCheck` はなくなりました（[ADR 0063](docs/adr/0063-repeating-self-checks-without-limits.md)）。
     書いたままでも起動はしますが、読まれないので消してください。
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
   - `curator`（省略可）: 夜に記憶を組み直す記憶の整理係の設定です（[ADR 0055](docs/adr/0055-a-memory-curator-at-night.md)）。
     `enabled`（既定 `true`。`false` で動かさない）、係の経路 `route`（`pi.routes` の名前。省略すると、そのときなつみが使っている経路）、
     係のターンの上限 `modelCalls`（既定 60 回）と `timeoutMinutes`（既定 30 分）、一晩に順番で回すファイルの数 `rotateFiles`
     （既定 2、0〜10）。係は作業環境（`loop.workspaceSocket`）があるときだけ動きます。
   - `avatar`（省略可）: 姿と名前（プロンプト・通知・Slack のアイコン・アプリ・画像のページ）を決めるアバターです。次のどちらか一方を書きます。
     組み込みのアバターの ID `id`（`natsumi`（なつみ。既定）、`iori`（伊織）、`myao`（ミャオ）、`nanashi`（名無し）。[assets/avatars/](assets/avatars/)）か、足すアバターのディレクトリ `directory`（絶対パス）です。
     省略すると、組み込みのなつみ（`id` が `natsumi`）です。
     `appearance`（省略可、絶対パス）に `appearance.yaml` を書くと、そのアバターの姿（自分を描くときのプロンプト）を丸ごと置き換えます。
     `sdctlParams`（省略可、絶対パス）に `sdctl-params.yaml` を書くと、そのアバターの画像生成の設定（sdctl の params）を丸ごと置き換えます。
     壊れていれば起動せず、素材が足りないだけなら、名無し（`nanashi`）の、のっぺらぼうの素材で埋めて起動します。
     アバターの `personality.md`（省略可）は、記憶に `personality.md` がまだ無いときだけ、その初期値になります。すでにある性格は上書きしません。
     作り方と検査のコマンド `natsumi avatar check <ディレクトリか ID>` は [アバターの作り方](docs/avatar.md)、決めたことは [ADR 0057](docs/adr/0057-an-avatar-directory-named-in-the-server-config.md) にあります。
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
記憶そのものは、トピックごとの Markdown ファイルです。トピックには「今どうなっているか」を書き、その日の出来事と経緯は
`diary/` の日ごとのファイルに書くよう、natsumi に指示しています（[ADR 0055](docs/adr/0055-a-memory-curator-at-night.md)）。
natsumi はこのファイルを `run_shell` で読み書きし（[ADR 0019](docs/adr/0019-a-workspace-not-a-memory-tool.md)）、
`INDEX.md` から、または `search_memory`（`rg` を決まったオプションで `/memory` に掛けるツール）で探します。
手で読んで直すこともできますし、直下に手で置いた `.md` ファイルも natsumi が探す対象になります。

サーバーが名前と置き場所を決めるのは、リポジトリ直下の 4 つだけです。

| ファイル | 中身 |
| --- | --- |
| `always.md` | 常時記憶。session を作るときにプロンプトに入ります。夜のターンでだけ書き換えられます |
| `personality.md` | 性格・話し方。session を作るときにプロンプトに入ります。夜のターンでだけ書き換えられます。無ければアバターの `personality.md`（無ければ表示名の入った枠）を置きます（[ADR 0060](docs/adr/0060-a-personality-to-start-from-in-the-avatar.md)） |
| `handoff.md` | 夜の引き継ぎ。初回起動で、そのときの最新の引き継ぎを写します（引き継ぎ自体を SQLite からこのファイルへ移すのは後続の実装） |
| `INDEX.md` | 記憶の索引。無ければ雛形を置きます。書くのは記憶の整理係だけで、natsumi のターンで変わっていたら戻します |

記憶に変更があったターンの終わりごとに、サーバーが 1 回コミットします。順序は、ターンが終わる → 変わったファイルを
検査 → 当たったものを直前のコミットの状態に戻す（新しいファイルは消す）→ 残りをコミット、です。ターンがモデル呼び出しの
上限や時間切れで終わったときも同じように検査してコミットします。検査は `.md` 以外・symlink・空・
`loop.memoryFileMaxChars`（既定 32000 文字）超過・テンプレートの制御文字列・制御文字・日本語以外の文字と、
日中のターンでの `always.md`・`personality.md` の変更と、natsumi のターンでの `INDEX.md` の変更です。`always.md` にはこれに加えて
`loop.alwaysMemoryMaxChars`（既定 2000 文字）の上限が掛かります。戻した理由は次のターンで natsumi に伝わります。

上限を掛けるのは書くときだけです（[ADR 0020](docs/adr/0020-limits-at-write-time-and-a-nightly-menu.md)）。
プロンプトを組む側は長さを見ないので、オーナーが自分で git に直接コミットした長い `always.md` は、そのまま
プロンプトに入ります。サーバーが書いたものは必ず上限の中にあります。

natsumi が作ったファイルは、削除も改名も検査しません。全部消しても履歴から戻せます。上の 4 つだけは別で、
消すことも改名することもできません（戻したうえで理由を伝えます）。サーバーはこの 4 つが直下にある前提で動くので、
黙って消えるとその前提が崩れます。

**サーバーは commit だけを行い、push も pull もしません。** リモートを設定するか、外へ出すかはオーナーが決めます。
リポジトリには本人の私的なことがそのまま残るので、リモートを作るなら private にしてください。
author と committer はサーバーが固定し、リポジトリに置かれた git の hook は実行しません。

毎晩 `loop.nightlyRotationAt` に、natsumi はその日を振り返り、引き継ぎのメモを持って新しい Pi session に切り替えます。
夜のターンに必ず求めるのは、引き継ぎを書くこととターンを終えることの 2 つだけで、書き漏れの書き足し、常時記憶と性格の見直し、
作業場の片づけなどは候補として渡し、その夜に何をするかは natsumi が選びます
（[ADR 0020](docs/adr/0020-limits-at-write-time-and-a-nightly-menu.md)）。やらなかったことは引き継ぎに残ります。
その夜のコミットメッセージは natsumi 自身の説明で、書かれなかった夜はサーバーが機械的に付けます。

記憶の組み直し（ファイルの統合・分割・改名・ディレクトリの整理、重複や古いところの手直し、`INDEX.md`）は、振り返りの後、
新しい session に切り替える前に、記憶の整理係が行います（[ADR 0055](docs/adr/0055-a-memory-curator-at-night.md)）。

- 係は natsumi の人格を持たない、別の Pi の session です。毎晩新しく作り、記録は `pi.sessionDirectory` の `curator/` に残ります。
  使えるツールは `run_shell`・`read`・`search_memory` と、係の変更の説明を書くツールだけです。
- 係には、全ファイルの一覧と見出し、前回の整理から変わったファイル、最後に手が入ってから日が経ったファイル（`curator.rotateFiles` 件）を渡します。
  中身まで書き直すのは後の 2 つだけで、ほかのファイルは構成の組み替えのために読むだけです。
- 係は `always.md`・`personality.md`・`handoff.md` と `diary/` を変えられません。古いもの・重複は消してよく、消したものは理由とともに
  コミットメッセージに残ります。本人の言葉・約束・「覚えておいて」と言われたことは、済んだと明らかでない限り残します。
- 係の変更は 1 コミットか、無しかです。検査に 1 つでも当たったとき、上限で打ち切られたとき、モデルの呼び出しが失敗したときは、
  その夜の係の変更をすべて捨てます。それでも夜の切り替えは止めません。捨てた夜は、ダッシュボードの「失敗と待ち」に出ます。
- 係が動いている間、natsumi は寝ています。届いたメッセージは、切り替えの後に新しい session が扱います。
- 係の結果も説明も、翌朝の natsumi には渡しません。本人は git の履歴か、ダッシュボードの係のターンで確かめます。
- 係の途中でサーバーが止まったときは、次の起動で、係がコミットしなかった変更を捨てます。
古い session ファイルは消さずに残るので、Pi の session 領域は日ごとに増えます。日中に context が `loop.compactionThreshold` を超えると、
イベントの合間に古い部分を要約します。記憶のリポジトリ、`.natsumi/state.sqlite`、Pi の session 領域は一組でバックアップしてください。

natsumi は自分から動くこともあります（[ADR 0014](docs/adr/0014-self-checks-and-pings.md)）。
`loop.awakeHours` の間、会話や処理のない時間が `loop.pingIntervalMinutes` 続くと、サーバーが「何かしたいことは？」の合図を送ります。
また natsumi は「30 分後」「15:00」のような一回きりの予約と、「毎日 16:00」（cron 式 `0 16 * * *`）のような繰り返しの予約で、
後で自分から確かめられます（[ADR 0063](docs/adr/0063-repeating-self-checks-without-limits.md)）。予約は `.natsumi/state.sqlite` に残ります。
一回きりの予約でサーバーの停止や夜で時刻を過ぎたものは、起動後（夜なら朝）にまとめて 1 回で届きます。
繰り返しの予約は、起きている時間帯の外の回を飛ばし、止まっていた間に過ぎた回は最後の 1 回だけ届きます。予約の件数と間隔に上限はありません。
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
- ブラウザの設定の画面（`/settings`）からも選べ、「config に戻す」で選んだ記録（`.natsumi/model-route.json`）を消して既定の経路に戻せます（下の「ブラウザで話す・設定を変える」）。

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
- ブラウザの設定の画面（`/settings`）からも切り替えられ、「config に戻す」でこのファイルを消せます（下の「ブラウザで話す・設定を変える」）。
- 切り替えた直後のターンは、prefix cache が 1 回外れます。

ターンごとの数と、そのターンが session のファイルのどこにあるか（本文は含みません）が `.natsumi/state.sqlite` の `turn_stats` に残ります。
夜の振り返りと記憶の整理係のターンも 1 行ずつになり、種類で普通のターンと見分けます。on と off を比べるには:

```sh
node dist/src/server/main.js stats --since 2026-09-20 --until 2026-09-27 --data-dir <data directory>
node dist/src/server/main.js stats --memos 20 --config <config file>   # 直近の一行メモ（session のファイルから読みます）
```

- `stats` は、最初の返事（またはポッポさんへの依頼）までの時間、ターンの長さ、呼び出しの回数、最初の呼び出しの文脈の大きさ、
  キャッシュに乗った割合、出力の tokens、振り返りの時間を on と off に分けて中央値と p90 で並べ、compaction の回数と、
  迷いの指標（読み直し・ツールのエラー・ポッポさんの突き返し・答えなかったメッセージの 1 ターンあたりの平均、打ち切りの割合）を続けます。
- `stats` が数えるのは普通のターンだけです。夜の振り返りと記憶の整理係のターンは、あれば件数だけを最後に出します。
- `--since` と `--until` は `YYYY-MM-DD`（UTC の 0 時）か、`Z` 付きの時刻です。`--until` の時刻は含みません。
- `--memos` は `pi.sessionDirectory` を読むために設定ファイルを読みます（既定は `config.local.json`）。

### ブラウザで話す・設定を変える

ブラウザで `<publicOrigin>/`（例: `https://natsumi.example.net/`）を開くと、Mac・iPhone と同じ会話でなつみと話せ、承認もできます。
`<publicOrigin>/settings` では、動いている最中に変えられる設定を変えます（[ADR 0058](docs/adr/0058-settings-and-chat-in-the-browser.md)）。

- ログインはダッシュボードと同じ GitHub ログインで、開いたページに戻ります。cookie もダッシュボードと共通です。
- ブラウザは開いている間だけの端末です。通知は受けません。ブラウザを開いていても、iPhone への通知は止まりません。
- 変えられる設定は、モデルの経路、畳み込み、ターンの上限（出来事ごとと夜の振り返りの、呼び出しの回数と時間）、起きている時間帯、合図の間隔です。
  サーバーの設定ファイル（config）の値が既定で、画面で変えた値は上書きとして data directory に残ります（経路と畳み込みは上の節のファイル、ほかは `.natsumi/runtime-settings.json`）。
  再起動やリリースでは戻りません。config を変えても上書きがあれば効かないので、画面の「config の値」と「今の値」を見比べ、「config に戻す」で上書きを消します。
- 値は config と同じ規則で確かめます。ターンの上限は次のターンから、時間帯と合図の間隔は次の見回り（10 秒ごと）から効きます。
- 画面は、別にビルドする JS の束（`dist/web/`）です。image には入っています。束が無いサーバーでは、`/` は束が無い旨だけを出します。
  画面でできることと、開発のしかたは下の「ブラウザのアプリ」にあります。
- 端末からの読み書きの約束事は[契約](docs/client-contract.md)の「実行中の設定」と「ブラウザ」にあります。

### ブラウザでダッシュボードを見る

ブラウザで `<publicOrigin>/dashboard`（例: `https://natsumi.example.net/dashboard`）を開くと、
GitHub でログインしてから、なつみのいまの状態と、ターンごとの中身、失敗と待ち、一行メモ、ポッポさんの依頼、承認の履歴、端末、統計のグラフ、なつみのファイルを見られます（[ADR 0049](docs/adr/0049-a-read-only-dashboard-in-the-browser.md)、[ADR 0054](docs/adr/0054-her-files-on-the-dashboard.md)）。

- ログインはアプリと同じ GitHub OAuth App と `github.allowedUserId` で行います。GitHub OAuth App の設定を足す必要はありません。
- ログインの状態は cookie `natsumi_session`（`Path=/`）に載り、`/`（話す）と `/settings`（設定）と共通です。最後に使ってから 30 日で切れ、開くたびに延びます。
  以前の `/dashboard` だけの cookie を持つブラウザは、`/dashboard` を開いたときに新しい cookie へ移し替えます。
  ページの「ログアウト」は、そのブラウザのセッションだけを終わらせます。
- 読み取り専用です。経路や畳み込みの切り替え、承認は、アプリとコマンド、ブラウザの `/` と `/settings` で行います。上のリンク（「話す」「設定」）から移れます。
- いまの状態の欄は、サーバーの生死（`.natsumi/status.json` の heartbeat）、使っている経路と候補、畳み込みの on/off、
  文脈の大きさと compaction の閾値、最後の compaction、実行中のターン、出来事のキューの長さを出し、10 秒ごとに更新します。
  文脈の大きさは、ターンの終わりに測った値です。実行中のターンからは、その詳細へ移れます。
- 「ターン」（`/dashboard/turns`）は、ターンを新しい順に 50 件ずつ並べます。時刻、種類（ターン／夜の振り返り／記憶の整理）、出来事の種類、
  outcome、返事までの時間、ターンの長さ、呼び出しの回数、tokens、経路、畳み込み、compaction の有無です。
  outcome が `ok` でないターン（失敗や打ち切り）は赤で出します。一覧は SQLite だけから作ります。
- ターンを開くと、session のファイル（`pi.sessionDirectory`）からそのターンの分だけを読み、全文で出します。
  届いた出来事、途中で差し込まれた本人のメッセージ、モデル呼び出しごとの思考・テキスト・ツールの呼び出し（名前と引数）と結果（成否）、
  usage、エラー、一行メモ、compaction です。2KB を超えるツールの結果は畳んであり、クリックで開きます。
  出来事やツールの結果に入っている画像（PNG・JPEG・GIF・WebP）は、`/dashboard` の下の URL から出します。
- この版より前に記録されたターンは、session のファイルの中の位置を持っていません。時刻と `<events>` の区切りから対応付け、
  「推定」と印を付けて出します。境目がずれていることがあります。
- 「失敗と待ち」（`/dashboard/waits`）は、次の節を並べ、10 秒ごとに更新します。どれも最大 20 件です。
  - 失敗した出来事（`loop_events` の failed）と理由。どのターンで扱ったかが記録にあれば、その詳細へ移れます。
  - 打ち切られたターン（outcome が `ok` でないもの。`model-call-limit`・`timeout`・夜の振り返りの `no-handoff`、記憶の整理係の `rejected`（検査に当たった）・`memory-not-clean`・`route-unavailable` など）。
  - 承認待ち。何の承認か（投稿先・下書き・判定・引っかかった問題点）と期限です。承認はこれまでどおりアプリで行います。
    ここから「承認の履歴」へ移れます。
  - 予約した確認（self-check）の予定と理由、次の夜の切り替えの予定時刻（`loop.nightlyRotationAt`）。
  - 外のエージェントへの依頼。相手、状態（waiting・input-required・completed・failed・gave-up）、送った時刻と最後の変化。まだ続いているものが先です。
  - 夜の session の切り替えの結果と、失敗の理由。
- 「一行メモ」（`/dashboard/memos`）は、ターンの終わりに書いた一行メモを新しい順に 20 件ずつ、全文で出します。
  一覧は SQLite から作り、メモは session のファイルのうち、そのターンの位置の終わりの付近（最大 1MB）だけを読みます。
  位置を持つ前の「推定」のターンは、ファイルを先頭から探すことになるので一覧では読みません。そのターンの詳細で見られます。
- 「ポッポさん」（`/dashboard/dove`）は、ポッポさんへの依頼を新しい順に 50 件ずつ出します。投稿かリアクションか、チャンネル、
  判定と問題点ごとの点数、状態、投稿先、時刻、下書きの全文と、本人が直して送った文です。
- 「承認の履歴」（`/dashboard/approvals`）は、本人に承認を求めた投稿を、終わったものも含めて新しい順に 20 件ずつ出します。
  結果（待ち・承認・修正・却下・期限切れ）で絞れます（`?state=pending` など。ほかの値は 404）。
  1 件ごとに、承認を求めた時刻と期限、投稿先と返信先、承認を求めた文、判定と問題点ごとの点数、本人が決めたこと（そのまま承認・直して承認・却下）、
  直したときの文と置き場所、決めた端末（ID の `device-` に続く先頭 8 文字）、閉じた時刻、送れたか（送れなかった理由）を出します。
  「閉じた時刻」は、却下と期限切れでは決まった時刻、承認と修正では送った結果が出た時刻です（決めた時刻そのものは記録にありません）。
  端末には名前が無いので ID で出します。対応するポッポさんの依頼の状態から、「ポッポさん」の該当する行へ移れます。
- 「端末」（`/dashboard/devices`）は、端末ごとの最後に接続した時刻、いまつながっているか、push の登録（APNs の環境と時刻）と、
  ログインのセッション（ダッシュボードのものを含む）の件数、最後の利用、期限を出します。token、ハッシュ、鍵は出しません。
  最後の利用は、使うたびに延びる期限から逆算した値で、1 時間の幅があります。
- 「統計」（`/dashboard/stats`）は、普通のターン（夜の振り返りと記憶の整理係を除く。`natsumi stats` と同じ）をグラフにします。
  期間は 24 時間（1 時間ごと）、7 日（6 時間ごと）、30 日（1 日ごと）から選び、刻みは `loop.timeZone` の時計に揃えます。
  - 返事までの時間とターンの長さの p50・p90（秒）、モデルの呼び出しの回数、tokens、
    打ち切り（上限・時間切れ）とほかの失敗の回数です。
  - tokens は、既定では「input と output」と「cache read」の 2 つのグラフに分けます。cache read は桁が違うので、同じ軸では input と output が読めないためです。
    グラフの上のチェックボックスで系列を選ぶと、選んだ系列だけを 1 つのグラフに、その系列に合わせた縦軸で描きます。
    選んだ系列はクエリの `show`（`?period=7d&show=input&show=output`。`show=input,output` でもよい）に入り、期間を切り替えても保たれます。
    知らない値が入っていれば 404 を返します。
  - グラフはサーバーが SVG で描き、JS は使いません。点や棒に触れると値が出て、各グラフの下の「数値の表」に同じ数値があります。
  - ターンの無い刻みは値なしとして扱い、0 にはしません。線はそこで切れ、表では「—」と出します。
  - 集計は SQLite で行い、期間の行だけを `started_at` の索引で読みます。
- 「ファイル」（`/dashboard/files`）は、なつみの作業環境の `/memory`・`/work`・`/home/natsumi`・`/manual`・`/manual/agents` の今の中身を、
  読み取り専用で見せます（[ADR 0054](docs/adr/0054-her-files-on-the-dashboard.md)）。URL は `/dashboard/files` の後に作業環境のパスを続けた形です（`/dashboard/files/memory/always.md` など）。
  - 読む場所: `/memory` は記憶の repository（`loop.memoryRepository`、既定は data directory の `memory/`）、`/work` と `/home/natsumi` は data directory の `work/` と `home/`、
    `/manual/agents` は data directory の `agents/` です。`/manual` は、コードに同梱の [manual/](manual/) を読みます。
    image ではサーバーの `/app/manual`（作業環境の `/manual` と同じビルドから作ったもの）、チェックアウトから `--data-dir` を付けて起動したときは、そのチェックアウトの `manual/` です。設定では変えられません。
  - ディレクトリは 1 階層ずつ並べます。既定は名前順（ディレクトリが先）で、列見出しの「名前」「更新日時」「大きさ」で並べ替えます（`?sort=mtime&order=asc` など）。
    ディレクトリの大きさは数えません。1 つのディレクトリで並べるのは 2,000 件までです。
  - `.` で始まるものは既定で隠し、「隠しファイルを表示」（`?hidden=1`）で出します。`/memory` の `.git` はどちらでも出さず、開けません。
  - symlink はたどりません。一覧に「→ 指す先」を出すだけで、開けません。パスの途中に symlink があるときも断ります。
  - テキスト（NUL を含まず、UTF-8 として読めるもの）は先頭の 1 MiB までを出し、それより大きければ「以降は省略」と書きます。
    画像（PNG・JPEG・WebP・GIF。中身の先頭のバイトで見分けます）は表示し、SVG と HTML はテキストとして出します。ほかのバイナリは種類と大きさだけです。
  - Markdown（`.md`・`.markdown`）は整形して出し、「生のテキスト」（`?raw=1`）で元の文字列に切り替えます。
    Markdown の中の HTML はそのまま文字として出します。リンクは `http`・`https` と、同じ場所の中への相対パスだけを残し、画像は同じ場所の中への相対パスのものだけを出します。
  - どのファイルにも「ダウンロード」（`?download=1`）があり、全体を取り出せます。
  - ターンの詳細では、`read` の引数のパスが上の場所の中なら、そのファイルへのリンクになります。リンク先は今の中身で、そのターンの時点のものではありません。

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
- 済んだ返事に画像の成果物（A2A の FilePart）があれば、サーバーが取り込みます（[ADR 0048](docs/adr/0048-bringing-in-images-an-agent-hands-back.md)）。
  相手の URL と同じ origin のものだけを、呼び出しと同じ token で取り（リダイレクトはたどりません）、PNG・JPEG・WebP（中身で判定）、
  1 枚 10 MiB・1 回 8 枚までを、作業環境の `/work/agents/<名前>/<日時>-<名前>` に置き、`.natsumi/images/` にも写しを残します（migration 19）。
  出来事には置いたパスと説明、取らなかった画像とその理由を書きます。取れなくてもテキストの返事はそのまま届けます。
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
   | `slack.maxImageBytes` | | 5 MiB | 取り込む画像の上限（バイト）。超えたものと、画像でも PDF でもない添付は「添付あり（取り込まず）」とだけ書きます。PDF の上限は 20 MiB で固定です |
   | `slack.judge` | | 既定の経路の互換のモデルの logprobs だけ | ポッポさんの 2 つの判定（logprobs と Jev）の接続先・しきい値と、採用する方。下の「Slack に投稿する」 |
   | `slack.approvalExpiryDays` | | 7 | 承認待ちの期限（1〜90 日） |
   | `slack.placementFollowing` | | 2 | 判定なしのとき、チャンネル直下の発言への返事は、その後のチャンネル直下の発言がこの件数以内ならチャンネルに直接出し、超えたらスレッドに置く（0〜20）。スレッドの中の発言への返事はスレッドに置く |
   | `slack.judgeContext.messages` / `.chars` | | 5 / 500 | 判定に見せる発言の件数（1〜20）と、1 件あたりの文字数。チャンネル直下の最新と、返信先のスレッドの最新を、それぞれこの件数まで見せる |
   | `slack.postImages.maxBytes` / `.maxCount` | | 10 MiB / 4 | ポッポさんに頼む投稿の画像 1 枚の上限（1 KiB〜50 MiB）と、1 回の枚数の上限（1〜10） |

   `slack.mentionContext` と `slack.updates` は使わなくなりました（[ADR 0050](docs/adr/0050-telling-of-source-updates-with-one-event.md)）。
   書かれていても起動は止めず、ログに `config: slack.mentionContext is no longer read (ADR 0050); it can be deleted` と出します。消してかまいません。

- 参加するチャンネルは、bot を招待して決めます。招待した後の最初の接続で、`backfillDays` 日前から埋めます。
- 発言は data directory の `sources/slack/<ワークスペース>/<チャンネル>/<日付>.jsonl`（DM は `@<名前>/`）に 1 日 1 ファイル、
  1 行 1 発言の JSON Lines で書きます（[ADR 0050](docs/adr/0050-telling-of-source-updates-with-one-event.md)）。
  行は記録した順に並び、あとで動きません。時刻（`at`）は natsumi のタイムゾーンの秒まで、スレッドの返信は親と同じファイルの 1 行で、親の行の番号を `reply_to` に持ちます。
  編集と削除ではその日のファイルを書き直し、削除された発言は `deleted` の行として残します。
  画像と PDF は同じ場所の `files/` に取ってきます（PDF は行の `pdfs`。モデルには画像として渡さず、なつみが作業環境の `pdftotext`・`pdftoppm` で読みます。[ADR 0066](docs/adr/0066-reading-pdfs-posted-in-slack.md)）。目次は `sources/slack/INDEX.md`（Markdown）です。ファイルは消さないので、古いものは手で片づけます。
  Markdown で書いていた以前の日付のファイルは、起動したときに SQLite から JSON Lines に書き直して消します。
- 発言に付いたリアクションは、その発言の行の `reactions` に書き、付け外しのたびにその日のファイルを書き直します
  （[ADR 0043](docs/adr/0043-reactions-in-the-channel-files.md)）。natsumi 自身が付けたものも書きます。記録に無い発言へのリアクションは捨てます。
  埋め直しでは、取り直した発言の `reactions` を取り込み、Slack が名前を返さなかった分は `others` の人数とします。
  Slack App に `reactions:read` とイベント `reaction_added`・`reaction_removed` が要ります（[Slack App の作り方](docs/slack-app.md)）。
- 発言とリアクションは `.natsumi/state.sqlite`（migration 13・15・21）にも残り、ファイルはそこから書き直します。個人データとしてバックアップの対象です。
- 起動したときと Slack につなぎ直したときに、チャンネルごとに最後に記録した発言から後を取り直して埋めます。
  止まっている間に古いスレッドへ付いた返信は、埋め直しでは拾いません（親が最後に記録した発言より前にあるため）。
  Slack に断られた会話は飛ばして残りを埋め、次につなぎ直したときにまた試します。スレッド・発言者の名前・画像が取れなくても、発言は記録します
  （名前は `someone`、画像は「添付あり（取り込まず）」）。最後に、埋めた件数と失敗した会話の数を 1 行で出します。
- チャンネルが変わると、`sources_updated` の出来事で natsumi に知らせます（下の「読みものの更新」）。
  bot への本物のメンションと DM は、そのチャンネルの `attention`（`kind` が `mention` か `dm`、ファイルと `jq -s` のパス、画像）として、待たずに、夜でも知らせます。
  受け取るとサーバーが `reaction` を付けます。natsumi が発言したスレッドへの、人からのメンションの無い返事も `attention`（`kind` が `thread-reply`）として同じように知らせますが、
  `reaction` は付けません（[ADR 0053](docs/adr/0053-waiting-at-random-for-source-updates.md)）。同じ発言は何度届いても 1 度だけ知らせます。bot の発言（自分のものを含む）は `attention` になりません。
  本文や前後の流れは出来事に載せず、natsumi がファイルから読みます。
- natsumi が読むものには、Slack の ID（ts・チャンネル・ユーザー）を書きません。発言はワークスペース・チャンネル・日付・秒までの時刻・発言者で指します。
- 作業環境からは、data directory の `sources/` を `/sources` に、`sources.git/` を `/sources.git` に、どちらも読み取り専用でマウントします（compose.yaml に入っています）。
  natsumi は shell で読み、`view <パス>` で画像を見ます（`/sources/` の下の画像だけ、サーバーが答えます）。
- ログにはワークスペースの名前と失敗の種類だけを出し、発言や token、Slack の ID は出しません。
  Slack の API の失敗は、呼び出したメソッドと Slack のエラーのコード（足りない scope があればそれも）を出します。
  例: `slack (work): filling in a conversation failed (conversations.history: missing_scope, needed im:history)`。
  埋め直しの間は、同じ失敗は 1 度だけ出し、残りは最後の 1 行の件数に数えます。

### 読みものの更新（sources_updated）

`/sources` の下の読みもの（いまは Slack だけ）が変わったことを、出来事 `sources_updated` で natsumi に知らせます
（[ADR 0050](docs/adr/0050-telling-of-source-updates-with-one-event.md)、[ADR 0053](docs/adr/0053-waiting-at-random-for-source-updates.md)）。

- サーバーは data directory の `sources/` を作業ツリーとする git の履歴を `sources.git/` に持ちます。commit するのは出来事を作るときだけです。
- 変わったかどうかは、スケジューラの tick ごとに見ます。読みものごとの単位（Slack はチャンネル）で書き込みの回数を数えます。
  前回見せた後で最初に変化を見つけたときに待ちを 1 回引き、それを過ぎたら出来事にします。
  待ちは平均 m の指数分布から引いて最長で打ち切ります。m は `k ÷ 直近 windowMinutes 分の書き込みの速さ` を最短と静かなときの平均の間で頭打ちにしたもので、
  書き込みが 0〜1 回なら静かなときの平均です。引いた待ちはメモリに持ち、再起動したら残っていた変化について引き直します。
- 本人の起きている時間（`loop.awakeHours`）の外は、`attention` が無い限り知らせません。朝の最初の出来事に夜の分がまとめて入ります。
- 出来事は、待っているものが 1 件だけになるようにまとめます。中身はそのターンの始めに作り、見せるものが無ければターンを始めずに閉じます。
- 出来事に差分の本文は載せません。natsumi は作業環境の `sources-diff` で見ます（`/sources.git` を読み取り専用でマウントします）。
- 毎晩、`historyDays` 日より前の履歴を刈り込みます。

```json
"sources": { "activity": { "k": 3, "minMinutes": 3, "maxMinutes": 60, "windowMinutes": 15, "quietMeanMinutes": 10 }, "historyDays": 7 }
```

| 項目 | 必須 | 既定 | 中身 |
| --- | --- | --- | --- |
| `sources.activity.k` | | 3 | 待ちの平均の係数。直近 15 分に書き込みが 15 回なら 3 分、6 回なら 7.5 分 |
| `sources.activity.minMinutes` | | 3 | 待ちの平均の最短（分、1〜1440） |
| `sources.activity.maxMinutes` | | 60 | 待ちの最長。引いた待ちはここで打ち切る（分、minMinutes〜1440） |
| `sources.activity.windowMinutes` | | 15 | 書き込みの速さを測る窓（分、1〜1440） |
| `sources.activity.quietMeanMinutes` | | 10 | 静かなとき（窓の中の書き込みが 0〜1 回）の待ちの平均。賑やかなときの平均もこれより長くならない（分、minMinutes〜maxMinutes） |
| `sources.historyDays` | | 7 | 残す履歴の日数（1〜90） |

### Slack に投稿する（ポッポさん）

natsumi は Slack に投稿するツールを持たず、`ask_agent` で送信役のポッポさん（`poppo`）に頼みます
（[ADR 0040](docs/adr/0040-the-dove-sends-what-the-judge-passes.md)）。ポッポさんはサーバーの中にいて、Slack の設定があるときだけ頼める相手の一覧に載ります。

- 依頼は見出し付きのテキスト（`返信先`・`種類`・`表情`、`---` の後が本文）です。書き方は natsumi 向けのマニュアル [manual/slack.md](manual/slack.md) にあります。
  返信先はファイルの発言の参照で、サーバーが記録と突き合わせます。形の崩れ、記録に無い参照、機械的な検査に当たる本文は、その場で断ります。
- 下書きは判定にかけます（[ADR 0059](docs/adr/0059-two-judges-side-by-side-and-fewer-issues.md)）。問いは英語で、問題点ごとの点数（本人に代わる約束・期限、隠しごとの匂わせ、事実と違う説明、同意の捏造、私的な事情）と、
  置き場所を聞きます。判定に見せるのは下書き・今の時刻・返信先と、チャンネル直下と返信先のスレッドのそれぞれ最新の発言（今の時点まで）だけです。
  - 判定は logprobs と Jev の 2 つあり、有効なものを同時に掛けて、両方の結果を残します。決めるのは採用する方で、答えが無ければもう一方、両方だめなら判定なしです。
  - 決めた方の判定のどの点数もその判定の `thresholds.owner` 未満なら、本人の承認なしにそのまま送ります。
  - `thresholds.return` 以上の問題があれば、理由を添えて natsumi に突き返します。同じ返信先で 3 回目の突き返しは、前の下書きと一緒に本人に回します。
  - その間なら、本人に回します。判定できなかったとき（判定なし）も本人に回します。
- 返信先のある投稿の置き場所は 3 つです（[ADR 0062](docs/adr/0062-three-placements-for-a-reply.md)）。スレッドに返す（`thread`）、チャンネルに直接出す（`channel`）、
  スレッドに返し、チャンネルにも出す（`broadcast`、`chat.postMessage` の `reply_broadcast`）です。判定なしのときは `slack.placementFollowing` の決まりで `thread` か `channel` にします。
  チャンネルそのものへの投稿は、今までどおりチャンネルに出します（`channel`）。画像付きの投稿は Slack が `reply_broadcast` を受け付けないので、`broadcast` ならスレッドにだけ置きます。
- 本人に回した投稿は承認待ちになり、iPhone で承認・修正・却下を選びます（API と通知は [サーバーと Mac の契約](docs/client-contract.md) の「承認と外部実行」）。
  期限（既定 7 日）を過ぎると閉じます。修正した本文は判定に掛け直しません。送る直前には、どの本文にも機械的な検査を掛けます。
- 投稿のアイコンは、natsumi の表情ごとの顔です。サーバーが認証なしの `/avatar/<表情>.png` で配り、`chat.postMessage` の `icon_url` に渡します
  （画像はアバターのディレクトリの `slack/<表情>.png`。無ければのっぺらぼうの画像）。Slack App に `chat:write`・`chat:write.customize` が要ります（[Slack App の作り方](docs/slack-app.md)）。
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
  2 つの判定のそれぞれの結果（判定、点数、置き場所、判定なしならその理由）と、採用していた方、決めた方も残ります（migration 23）。
  画像の写しは `.natsumi/images/` にあります。どちらも個人データとしてバックアップの対象です。
- ログには判定の方式、ワークスペースの名前、Slack のメソッドとエラーのコード、判定の失敗の種類（例: `dove: judge (jev): no verdict (timeout)`）だけを出し、
  下書き、接続先、ID は出しません。

#### 判定の方式（`slack.judge`）

判定は 2 つあり、どちらも同じ問いと同じ材料を使います（[ADR 0059](docs/adr/0059-two-judges-side-by-side-and-fewer-issues.md)）。

- **`logprobs`**: OpenAI 互換のモデルに、問いごとに 1 回ずつ、思考なしで 1 トークンだけ答えさせ（`temperature 0`、`max_tokens 1`、`top_logprobs 20`）、
  最初のトークンの候補の確率から点数を出します。問題点は yes と no の確率の比、置き場所は A（thread）・B（channel）の確率を合計 1 にしたものです。
  答えのトークンが候補に無い、logprobs が返らない、思考のタグが出た、というときは判定なしです。
  接続先・API キー・model は、書かなければ既定の経路（`pi.defaultRoute`。`pi.model` だけの設定ならその経路）の `compatible` の `baseUrl`・`apiKeyEnv`/`apiKeyFile` と `model.id` を使い回します。経路を切り替えても変わりません。
  `pi` が OpenAI 互換のモデルなら、`slack.judge.logprobs` を書かなくても有効です。
- **`jev`**: TypeSafe AI の Jev の API（`POST /v1/systemone`）、または同じ API を返すサーバーに、1 回の呼び出しで全部の問いを聞きます。
  `slack.judge.jev` を書いたときだけ有効です。従量課金なので、有効な間は採用していなくても投稿のたびに料金がかかります。
- 有効な判定が 1 つも無ければ、判定はせず、投稿はすべて本人の承認に回ります。
- 有効・無効と採用する方、判定ごとのしきい値は、動いている最中に `/settings`（`judgeLogprobs`・`judgeJev`・`judgeAdopted`・`judgeLogprobsThresholds`・`judgeJevThresholds`）で上書きできます。次の下書きから効きます。
  config に接続先の無い判定は、画面から有効にできません。

値は架空の例です。1 つ目は pi のモデルの logprobs だけを使う既定のもの（書かなくても同じ）、2 つ目は 2 つを並べて Jev を採用するものです。
Jev の鍵があるなら、2 つ目の形で始めることを勧めます。事前の評価（下）では、Jev のほうが止めるべき下書きをよく拾い、置き場所の選択も選択肢の順序に左右されませんでした。
logprobs は並べて記録を取り、Jev が答えないときの控えになります。しきい値は `/settings` で動かしながら合わせる前提です。

```json
"judge": { "logprobs": { "thresholds": { "owner": 0.5, "return": 0.9 } } }
```

```json
"judge": { "adopted": "jev", "jev": { "apiKeyFile": "/run/secrets/natsumi_jev_api_key", "thresholds": { "owner": 0.5, "return": 0.9 } } }
```

| 項目 | 既定 | 中身 |
| --- | --- | --- |
| `slack.judge.adopted` | `logprobs` | 採用する方（`logprobs` か `jev`）。config に接続先の無い方は指定できません |
| `slack.judge.<判定>.enabled` | `true` | 起動したときに有効か。`false` でも接続先は読むので、画面から有効にできます |
| `slack.judge.<判定>.baseUrl` | logprobs: 既定の経路の `compatible.baseUrl`、jev: `https://api.typesafe.ai` | 接続先。logprobs は OpenAI 互換の `…/v1`、jev は `/v1/systemone` の手前。http か https。ここで API キーを付けるなら、http で送れるのはループバックの相手だけです |
| `slack.judge.<判定>.apiKeyEnv` / `apiKeyFile` | logprobs で接続先を書かなければ既定の経路の `compatible` のもの、ほかはなし | API キー。無ければ `Authorization` を付けません。pi のキーは、pi の接続先にしか送りません |
| `slack.judge.<判定>.model` | logprobs: 既定の経路の `model.id`、jev: `jev-latest` | 要求の `model` |
| `slack.judge.logprobs.concurrency` | 4 | logprobs で同時に聞く問いの数（1〜16） |
| `slack.judge.<判定>.timeoutSeconds` | 30 | 1 つの下書きの判定の待ち時間の上限（5〜300 秒）。過ぎたら判定なし。2 つの判定は同時に掛けるので、全体は遅いほうの上限までです |
| `slack.judge.<判定>.thresholds.owner` / `.return` | logprobs: 0.5 / 0.9、jev: 0.5 / 0.9 | 本人に回す・突き返すしきい値（0 より大きく 1 以下、owner ≦ return）。判定ごとに点数の付き方が違うので、別々に持ちます。jev の既定は事前の評価で決めた値です。動いている最中は `/settings` で上書きできます |

- 以前の形（`slack.judge.method` で 1 つを選び、接続先の項目を `slack.judge` の直下に書くもの）も読めます。選んだ方だけを有効にして採用したものとして読みます。
  `method` が `jev` で、pi が OpenAI 互換のモデルなら、logprobs は無効のまま接続先だけ用意されます。新しい形と混ぜて書くと起動しません。

- 接続先には下書きと周りの発言が出ます。natsumi のコンテナから届くように、出口の許可リストにその接続先を加えます（[ADR 0034](docs/adr/0034-an-allow-list-for-the-way-out.md)）。
- しきい値を決める前に、架空の場面で判定を評価できます。止めるべき下書き（匂わせ・嘘・約束・捏造した同意・私的な事情）と
  正しい投稿を判定させ、しきい値ごとに止めた数と正しい投稿を止めた数、場面ごとの時間を出します。本物の接続先を呼びます。

  ```sh
  JUDGE_BASE_URL=https://llm.example.net/v1 JUDGE_MODEL=my-model JUDGE_API_KEY_ENV=MY_KEY npm run probe:jev -- --thresholds 0.5,0.9
  ```

  `JUDGE_METHOD`（`logprobs` か `jev`）、`JUDGE_CONCURRENCY`、`JUDGE_TIMEOUT_SECONDS` も指定できます。2 つの判定は、`JUDGE_METHOD` を変えて 1 つずつ評価します。
  返信先のある場面は置き場所も聞き、場面が決めている置き場所との一致を数えます。`--order-check` を付けると、置き場所の選択肢を逆の順にしてもう一度聞き、答えが変わった数と確率の差の最大を出します。
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
  `ripgrep`・`jq`・`python3`（標準ライブラリのみ）・`git`・`procps`・`tzdata`、PDF を読む `poppler-utils`（`pdftotext`・`pdftoppm`）と、その日本語などの文字の対応表 `poppler-data`、画像を作る `sdctl`、それに runner です。
  **使えるコマンドの一覧はもうありません。** 閉じ込めはコンテナの形だけで掛けます。
- 書ける場所は 4 つです。ルートは読み取り専用のままです。

  | 場所 | 永続 | 検査・コミット | 中身 |
  | --- | --- | --- | --- |
  | `/memory` | する | する | 記憶。`natsumi-data` の `memory/` |
  | `/memory/.git` | する | — | 読み取り専用で重ねます。履歴は natsumi の手の届かないところに置きます |
  | `/work` | する | しない | 手を動かす場所。`natsumi-data` の `work/` |
  | `/home/natsumi` | する | しない | natsumi のホーム。`natsumi-data` の `home/` |
  | `/tmp` | しない | — | 128 MB の tmpfs。コンテナの再起動で消えます |

  ほかに、読むだけの場所が 3 つあります（[ADR 0036](docs/adr/0036-a-manual-to-read-and-a-limit-on-waiting.md)）。
  `/manual` は natsumi 向けのマニュアル（リポジトリの [manual/](manual/) を image に焼いたもの）で、
  `/manual/agents` は natsumi が起動のたびに書き出す、頼める相手の一覧（`natsumi-data` の `agents/`、読み取り専用）です。
  `/manual/avatar` は natsumi が起動のたびにアバターから書き出す、画像を作るページ `images.md` と画像生成の設定 `sdctl-params.yaml`
  （`natsumi-data` の `avatar/`、読み取り専用。[ADR 0057](docs/adr/0057-an-avatar-directory-named-in-the-server-config.md)）です。
  system prompt には「やり方が分からないときは `/manual/INDEX.md` を読む」の 1 文だけがあり、使い方の説明はマニュアルの側に足します。

  `/work` と `/home/natsumi` にはターンの終わりの検査もコミットも掛からず、git の差分でも見られません。
  サーバーが読むのは、natsumi が `view` で見る画像と、ポッポさんへの依頼や `reply_to_mac` の `images` で名指しした画像、
  それにダッシュボードの「ファイル」でオーナーが開いたもの（読み取り専用）だけです。
- 画像を作る（[ADR 0044](docs/adr/0044-drawing-with-sdctl-and-posting-images.md)）
  - natsumi は shell で `sdctl`（[yuanying/sdctl](https://github.com/yuanying/sdctl) の v0.3.2。image の build でソースから入れます）を使い、
    Stable Diffusion WebUI で画像を作ります。使い方は natsumi 向けの `/manual/avatar/images.md` にあります。
    サーバーが起動のたびに、雛形の [assets/manual/images.md](assets/manual/images.md) に、アバターの自分の姿（`appearance.yaml`）と既定の大きさを差し込んで書き出します。
  - 既定の設定は `/manual/avatar/sdctl-params.yaml` です。設定の `avatar.sdctlParams` があればそのファイル、無ければアバターの `sdctl-params.yaml`、無ければサーバーの既定
    （名無しの [assets/avatars/nanashi/sdctl-params.yaml](assets/avatars/nanashi/sdctl-params.yaml)）を、サーバーが起動のたびに書き出します。
    サーバーの既定は、Anima 系のモデル `anima_mignolia_v10` と VAE・text encoder を生成ごとの `override_settings` で指定し、Negative prompt、896×1152、30 steps、CFG 4.5、`ER SDE`・`simple` です。
  - 接続先・既定の設定・出力の既定の `/work/images` と形式の JPEG は、image の `/etc/sdctl/config.yaml`（リポジトリの [docker/sdctl/config.yaml](docker/sdctl/config.yaml)）にあります。
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

1. 初めて起動すると、メニューバーにアイコンが出て、設定が開きます。アプリはキャラクターの絵を持たず、サーバーから受け取るので、
   受け取るまではデスクトップに誰も出ません（下の「アバター」）。
2. 設定の「サーバー」に URL（例: `https://natsumi.example.net`）を入れて保存します。アバターはログインしなくても受け取れるので、
   保存するとすぐにキャラクターが出ます。キャラクターはドラッグで動かせます。設定は、キャラクターを右クリック（または control キーを押しながらクリック）して出るメニューか、メニューバーの「設定…」で開きます。
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
    - どの経路も使えず natsumi が話せないときは、「なつみはいま話せません」のように赤く出ます（名前はアバターの表示名）。メニューの題も「モデル: 話せません」になります。
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

### アバター

キャラクターの姿と名前（メニューバー・会話のウインドウの題・履歴など）は、サーバーの設定で決まり、アプリはサーバーから受け取ります
（[ADR 0057](docs/adr/0057-an-avatar-directory-named-in-the-server-config.md)）。アプリには絵を同梱していません。

- サーバーを保存したとき、アプリは `GET /v1/avatar` の一覧を取り、手元の控えと版が違えば全ファイルを取って、大きさと SHA-256 を確かめてから控えを丸ごと置き換えます。
  その後は、接続したときにサーバーが知らせる版が控えと違うときだけ取り直します。取れなかったときは控えのまま動きます。
- 控えは `~/Library/Application Support/natsumi/avatar-copy/` にあり、次の起動からはこれで始まります。一度も受け取っていないときは、設定から始まります。
- 設定の「アバター」に、受け取ったアバターの表示名と版が出ます。
- アバターを替えるのはサーバーの config（`avatar.id` で組み込みのアバター、`avatar.directory` で足すアバター。上の「設定」）です。
  自分のアバターの作り方は [アバターの作り方](docs/avatar.md) を見てください。
- 以前の版にあった、Mac の手元でアバターのディレクトリを指す設定はなくなりました。保存してあった値は使いません。

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
- キャラクターの姿と名前は、Mac と同じくサーバーから受け取ります（上の「アバター」）。ログインしていても、アバターを一度も受け取っていなければ
  ログインの画面のままで、受け取るとメインの画面になります。受け取れなかったときは、ログインの画面にそう出ます。
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
  「承認して送る」「修正」「却下」を選べます。返す相手の発言があるときは、置き場所も「スレッド」「チャンネル」（チャンネル直下）「チャンネルにも」（スレッドに返し、チャンネルにも表示）から選び直せます。
  アプリの知らない置き場所が届いても承認は選べ、置き場所は「不明」と出ます。
  投稿に画像が付くときは「一緒に送る画像」に並び、タップで大きく見られます。承認が閉じると画像は捨て、枚数だけを出します。
  送った結果（送れなかったときはその理由）はその画面に出ます。
- 吹き出しと履歴の本文の `http://`・`https://` の URL はリンクになり、タップすると既定のブラウザで開きます（[ADR 0038](docs/adr/0038-links-in-what-she-says.md)）。
- アプリが裏に回ると接続を切り、前に戻ると続きから同期し直します。
- 裏にいる間の返事と知らせは、通知で届きます（[ADR 0029](docs/adr/0029-push-notifications-on-the-iphone.md)。サーバーの設定は上の「iPhone への通知」）。
  ログインすると通知を許可するか尋ねられます。本文はこの iPhone の鍵で暗号化されて届き、アプリの拡張 `NatsumiNotifications` が開いて、
  セリフと気持ちの顔を出します。顔は、暗号化された本文に入っているサーバーの URL（Slack のアイコンと同じもの）から取り、取れなければ顔なしで出します。開けなかったときは「返事があります」「知らせがあります」とだけ出ます。
  承認待ちの通知はチャンネルと下書きの先頭を出し、タップするとその承認を開きます。
  バッジは未読の返事と未確認の知らせと承認待ちの数で、Mac で読んだ分の通知は消えます（iOS が間引くと、次にアプリを開いたときに消えます）。
  送り先（sandbox か production か）は、アプリの署名の provisioning profile から決まります。
- シミュレータでも登録までは動きますが、`xcrun simctl push` は拡張を通らないので、本文を開くところは実機で確かめます。
- ロック画面からも開けます。ロック画面を長押しして「カスタマイズ」を選び、下の隅のボタンを「会話を開く」に替えるか、
  時計の下のウィジェットに「会話を開く」を足します（ウィジェットは受け取ったアバターを読めないので、名前は出しません）。同じボタンはコントロールセンターとアクションボタンにも置けます。
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
実行中の設定（`settings.*`）も本物と同じ規則で答え、ログアウトすると config の値に戻ります。
ブラウザの画面を試すときは、`http://localhost:8787/` を開くと `/fake-login` で cookie が付いて戻り、`--bundle` のディレクトリ
（省略すると本物と同じ `dist/web/`）の束を読み込みます（[契約](docs/client-contract.md)の「ブラウザ」の「偽のサーバー」）。

```sh
npm ci
npm run fake-server -- [--port 8787] [--reply-delay 5] [--short] [--approval-delay 8] [--switch-delay 2] [--bundle <dir>]
```

偽のサーバーそのもののテストは `test/fake-server.test.ts` にあり、`npm test` で走ります。

シミュレータのアプリでは、サーバーに `http://localhost:8787` を入れてログインします。
UI テスト `NatsumiPhoneUITests` は、この偽のサーバーを相手にログイン・返事・履歴・設定・ログアウトまでと、
承認待ちの件数・一覧・1 件の画面から承認・修正・却下までと、履歴と承認の画面の画像を開いて閉じるまでと、
設定でモデルの経路を `plus` に切り替えて移るまでと、アバターを受け取っていない状態からログインしてキャラクターが出るまで
（起動引数 `-NatsumiForgetAvatar` で手元の控えを消して始めます）を辿り、画面を撮ります
（偽のサーバーを先に起動してください。別のポートで動かすときは `TEST_RUNNER_NATSUMI_SERVER` に URL を渡します）。撮った画面は結果の bundle に添付され、`TEST_RUNNER_NATSUMI_SCREENSHOTS` に
ディレクトリを渡すとそこにも書き出されます。

```sh
TEST_RUNNER_NATSUMI_SCREENSHOTS=/tmp/natsumi-shots \
  xcodebuild test -project mac/Natsumi.xcodeproj -scheme NatsumiPhone -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath mac/build
```

## ブラウザのアプリ

`/`（チャット）と `/settings`（設定）の画面です。サーバーは `dist/web/` の束を配るだけで、画面は束が WebSocket（`/v1/ws`）で
Mac・iPhone と同じ約束事を話して組みます（[ADR 0058](docs/adr/0058-settings-and-chat-in-the-browser.md)、[契約](docs/client-contract.md)の「ブラウザ」）。

### 使い方

- **チャット（`/`）**: 会話の履歴、送信、なつみの「考え中」と考えている 1 行、セリフの横の表情の顔、返事の画像を出します。
  ページが見えていて手前にある間に届いた返事は既読になり、知らせは「確認した」で確認します。
  つながりが切れると、待つ時間を延ばしながらつなぎ直し、同期し直します。切れている間に書いたメッセージは、つながってから送ります。
  同じブラウザの別のタブで開くと前のタブは止まり、「ここでつなぎ直す」で戻せます。
- **承認**: 承認待ちは会話の上に並び、上端の「承認待ち N 件」から飛べます。「承認…」「直す」「却下…」は選ぶだけで、
  何が起きるか（どこに何を送るか）をもう一度聞き、「送る」「直して送る」「却下する」を押したときだけ決定を送ります。
- **設定（`/settings`）**: 設定ごとに「今の値」（上書き中の印つき）と「config の値」を並べ、「変える」と「config に戻す」ができます。
  値は送る前に契約と同じ規則で確かめ、合わなければ理由を出します。経路と畳み込みは、実際に移るまで「次のターンから」と出ます。
  ほかの端末やサーバーのコマンドで変わると、その場で反映します。
- 上のリンクで `/`・`/settings`・`/dashboard` を行き来し、「ログアウト」でそのブラウザのセッションを終えます。
- スマホでは 1 列、PC では中央に最大幅で出ます。押すものは 44px 以上で、iOS Safari のキーボードが出ても入力欄は隠れません。ダークモードに従います。

### 開発のしかた

```sh
npm ci
npm run build:web          # dist/web/ に app.js・app.js.map・app.css を作る（npm run build でも作る）
npm run fake-server        # http://localhost:8787/ と /settings で試す（cookie は /fake-login で付く）
npm test                   # 約束事の読み取り・Mediator・Props の導出・レイヤーの検査（node のテスト）
npm run test:browser       # 束を作り、ヘッドレス Chromium で偽のサーバーにつなぐ通しのテスト
```

- 通しのテストは Playwright の Chromium（headless shell）を使います。初めては `npx playwright install --with-deps --only-shell chromium` で入れます。
  スマホ（390×844）と PC（1280×860）の 2 つの大きさで走り、`NATSUMI_SCREENSHOTS=<dir>` を渡すとチャット・承認の確認・設定・ダークモードの画面を撮ります。
- 型検査（`npm run typecheck`）は、サーバーと core を Node の設定で、画面のコード全体を `src/web/tsconfig.json`（DOM と Preact の JSX、Node の型なし）で確かめます。

### 作り

Mac アプリと同じ Passive View＋Mediator の形です（[mac/CLAUDE.md](mac/CLAUDE.md)）。図の矢印は「下のものが上のものに頼る」向きで、依存はこの一方向だけ、循環はありません。
`test/architecture.test.ts` がこの向きと循環の無さを検査します。

```text
src/shared/protocol/   約束事の型と、受け取った JSON の読み取り（純粋。サーバーも使う）
        ↑                settings.ts（設定の名前・値の形・規則・一覧の形）、conversation.ts、envelope.ts、avatar.ts
src/web/core/          状態・出来事・効果・Mediator（(状態, 出来事) → (状態, 効果)）と Props の導出（純粋関数）
        ↑                stream.ts（seq の追い方）、settings.ts（入力の検査）、words.ts（コードを言葉に）
        ├──────────────────────────┐
src/web/adapters/      src/web/view/
  WebSocket・localStorage・         Preact の関数コンポーネント。Props を描き、
  /v1/avatar を出来事に変える        操作を出来事として返す（状態を持たない）
        ↑                          ↑
        └───────────┬──────────────┘
src/web/main.ts        組み立て（本物の WebSocket・DOM をつなぐ。ここだけが全部を知る）
```

- `src/shared/protocol/` と `src/web/core/` は何も import しません（DOM も WebSocket も Node も Preact も知りません。protocol 同士、core から protocol は可）。
- `adapters` と `view` は `core` と `protocol` だけに頼り、互いを知りません。Preact を使うのは `view` と `main.ts` だけです。
- 画面はサーバーのコードを import しません。約束事の型はサーバーと `src/shared/protocol/` で共有します
  （設定の規則と形はサーバーから移し、会話・承認・画像・経路の型はサーバーもここのものを使います）。
- フレームワークは view の層の Preact だけです。`useState` などの状態の機能は使わず、状態は core の Mediator に一本化しています。
  `useRef`・`useEffect` は、入力欄を空にする・最新の行へスクロールするといった DOM の操作にだけ使います。
- 束は esbuild（`scripts/build-web.ts`）で作ります。CSP（inline なし・eval なし・同じオリジンだけ）に合わせ、script と style は束のファイルだけです。

## ライセンス

- コードは [MIT License](LICENSE) です。
- なつみのアバターのアセット（`assets/avatars/natsumi/`）は [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) です。
  キャラクターの参照画像は Anima で、spritesheet は OpenAI の画像生成で作りました（[詳細](assets/avatars/natsumi/README.md)）。

## 文書

- [設計 ADR](docs/adr/0001-server-and-data-ownership.md): データ所有権、[通信・承認](docs/adr/0002-client-events-and-approvals.md)、[外部連携](docs/adr/0003-assistance-and-integrations.md)、[Pi のツール・認証・音声](docs/adr/0004-pi-tool-and-voice-boundaries.md)、[サーバー基盤](docs/adr/0005-server-foundation.md)、[GitHub ログインと HTTPS/WSS](docs/adr/0006-github-login-and-transport.md)、[Let's Encrypt と固定 IPv6](docs/adr/0007-acme-and-fixed-ipv6.md)、[単一の思考ループと Mac との会話](docs/adr/0008-single-thinking-loop-and-mac-conversation.md)、[長期記憶と夜の session の切り替え](docs/adr/0009-long-term-memory-and-nightly-session-switch.md)、[Mac アプリの構成](docs/adr/0010-mac-app-structure.md)、[閉じ込めたコンテナで記憶を shell で探す](docs/adr/0011-memory-shell-in-a-confined-container.md)、[Slack 連携と同僚 AI](docs/adr/0012-slack-and-colleagues.md)、[本人が確かめたことをサーバーで持つ](docs/adr/0013-read-state-on-the-server.md)、[自分で予約する確認と定期の合図](docs/adr/0014-self-checks-and-pings.md)、[Mac の UI は一本の木の Passive View](docs/adr/0015-mac-ui-passive-view-tree.md)、[カードを開く操作とキャラクターの移動](docs/adr/0016-opening-a-card-and-moving-the-character.md)、[考えている 1 行を流す](docs/adr/0017-streaming-the-line-she-is-thinking.md)、[記憶を git で持ち、夜に組み直す](docs/adr/0018-memory-in-git-and-the-nightly-rebuild.md)、[記憶の道具をやめ、なつみの作業環境にする](docs/adr/0019-a-workspace-not-a-memory-tool.md)、[外のエージェントと A2A で話す](docs/adr/0025-talking-to-outside-agents-over-a2a.md)、[セリフごとに気持ちを載せる](docs/adr/0026-a-feeling-on-each-line.md)、[履歴のセリフに気持ちの顔を添える](docs/adr/0027-her-face-beside-each-line-in-the-history.md)、[iPhone のクライアント](docs/adr/0028-the-iphone-client.md)、[本番を Kubernetes に置く](docs/adr/0033-running-on-kubernetes.md)、[出口を許可リストで絞る](docs/adr/0034-an-allow-list-for-the-way-out.md)、[外のエージェントに頼むツールと、返事の受け取り方](docs/adr/0035-asking-outside-agents-and-hearing-back.md)、[読み取り専用のマニュアルと、返事を待ち続ける上限](docs/adr/0036-a-manual-to-read-and-a-limit-on-waiting.md)、[スリープから起きたらつなぎ直し、開いている接続は ping で確かめる](docs/adr/0037-catching-up-after-sleep-and-pinging-the-socket.md)、[本文の中の URL をリンクにし、クリックでブラウザを開く](docs/adr/0038-links-in-what-she-says.md)、[Slack は読むファイルとして受け取り、ポッポさんは問題点ごとの点数で判定する](docs/adr/0039-slack-as-files-and-a-scored-dove.md)、[ポッポさんは判定が通したものを送り、本人には回されたものだけを承認してもらう](docs/adr/0040-the-dove-sends-what-the-judge-passes.md)、[Slack の投稿を iPhone で承認する](docs/adr/0041-approving-slack-posts-on-the-iphone.md)、[ポッポさんは実在する絵文字ならどれでもリアクションに付ける](docs/adr/0042-any-emoji-that-exists.md)、[Slack のリアクションをチャンネルのファイルに書き、なつみの投稿へのものを合図で知らせる](docs/adr/0043-reactions-in-the-channel-files.md)、[なつみは作業環境の sdctl で画像を作り、ポッポさんへの依頼で Slack に投稿する](docs/adr/0044-drawing-with-sdctl-and-posting-images.md)、[なつみは reply_to_mac の返事に画像を添えて、本人に見せる](docs/adr/0045-showing-the-owner-images-with-a-reply.md)、[モデルの経路に名前を付けて並べ、本人が手で切り替える](docs/adr/0046-named-model-routes-switched-by-hand.md)、[終わったターンを畳んで一行メモを残し、read で読んだものは残す](docs/adr/0047-folding-ended-turns-with-a-memo.md)、[外のエージェントが返事に付けた画像を、サーバーが /work に取り込む](docs/adr/0048-bringing-in-images-an-agent-hands-back.md)、[ブラウザで見る読み取り専用のダッシュボードを、サーバー自身が配る](docs/adr/0049-a-read-only-dashboard-in-the-browser.md)、[本物のターンの経路で 1 ターンを回し、場面ごとの成功率で評価する](docs/adr/0051-evaluating-one-turn-on-the-real-path.md)、[本番の状態の写しから始め、相手役を立てて、修正したコードでターンを試す](docs/adr/0052-trying-a-turn-on-a-copy-of-production.md)、[ダッシュボードで、なつみの作業環境・記憶・マニュアルのファイルを読み取り専用で見る](docs/adr/0054-her-files-on-the-dashboard.md)、[記憶の組み直しは、人格を持たない整理係が夜に行う](docs/adr/0055-a-memory-curator-at-night.md)、[アバターと名前を、サーバーの設定で指すアバターのディレクトリから決める](docs/adr/0057-an-avatar-directory-named-in-the-server-config.md)、[ブラウザで話し、動いている間に変えられる設定をブラウザから変える](docs/adr/0058-settings-and-chat-in-the-browser.md)、[ポッポさんは 2 つの判定を並べて使い、判定の項目を見直す](docs/adr/0059-two-judges-side-by-side-and-fewer-issues.md)
- [サーバーと Mac の契約・実装順](docs/client-contract.md)
- [アバターの作り方](docs/avatar.md): 自分のアバターのディレクトリを作り、検査して、サーバーで使うまで
- [権限と秘密の一覧](docs/permissions.md): サーバーが外に対して持つ権限・秘密・外への出口と、受け付ける認証
- [実接続の実行方法と結果](docs/probe-results.md)
- [1 ターンの評価](eval/README.md): 使い方、場面の書き方、私的な場面、本番の session の写しの取り出し方
- [設定例](config.example.json)（証明書ファイル）と [ACME の設定例](config.acme.example.json): 現在サーバーが受け付ける設定だけを載せています。後続の実装で項目を追加します。検証ハーネスはこのファイルを読みません。

個人 Markdown、SQLite、Pi の session・認証、ログ、private Wiki、証明書や secret はコード checkout の外に置きます。
ignore は事故防止の補助です。設定例を実環境に合わせたファイルは `config.local.json` として管理し、
秘密は環境変数や secret mount で渡します。個人データを公開 Git に保存しません。
