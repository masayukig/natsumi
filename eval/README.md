# 1 ターンの評価

なつみの 1 ターンを、サーバーと同じ思考ループで回して、期待どおりに動いたかを確かめます（[ADR 0051](../docs/adr/0051-evaluating-one-turn-on-the-real-path.md)）。
同じ場面を何度も回し、場面・変種・項目ごとの成功率を出します。2 つの版の結果を並べて比べられます。

- 通るのは本物の経路です。システム指示、ツールの定義と結果の文、イベントの行、打ち切り、マニュアル（`manual/`）は、評価するブランチのものがそのまま使われます。
- workspace の shell は本物の runner（`runner/`）で、bubblewrap の中で本番のコンテナと同じ配置にして動かします。ネットワークはありません。
- 外への作用は記録するだけです。Mac への返事と知らせは記録に残り、ポッポさんへの依頼は形を確かめ、実行の data directory の `sources/agents/poppo/` に置いて受け付けの文を返すだけで、Slack には何も送りません（返す先が記録にあるかは確かめません）。
- 外のエージェントとポッポさんには、場面に書いた相手役が答えます。本物にはつなぎません（下の「相手役と、続けるターン」）。
- 本番の状態の写しから始めることもできます（下の「本番の写しから試す」、[ADR 0052](../docs/adr/0052-trying-a-turn-on-a-copy-of-production.md)）。
- 1 回ごとに新しいデータディレクトリ、SQLite、Pi の session で回します。

## 準備

- Node.js（`package.json` の `engines`）と `npm ci`
- Go（runner をその場で build します）
- bubblewrap（`bwrap`）。user namespace を作れること
- 場面が使うコマンド（`git`、`jq`、`rg` など）。コマンドは手元の `/usr` のものが使われるので、本番の image と版が違うことがあります

## 使い方

まず偽のモデルで流れを確かめます。key は読みません。

```sh
npm run eval -- run --dry-run --runs 1
```

実際のモデルで回します。

```sh
npm run eval -- run --model ~/natsumi-eval/qwen.json --judge ~/natsumi-eval/plus.json --runs 10 --label qwen-before
npm run eval -- run --model ~/natsumi-eval/qwen.json --judge ~/natsumi-eval/plus.json --runs 10 --label qwen-after
npm run eval -- compare eval/results/qwen-before eval/results/qwen-after
```

プロンプトやソースを変えたら、そのブランチで同じ場面を回して、前の結果と `compare` で並べます。

| 指定 | 意味 |
| --- | --- |
| `--model <file>` | 評価するモデル（下の「モデルのファイル」）。`--dry-run` のときは名前だけに使い、key は読みません |
| `--judge <file>` | ルーブリックを判定するモデル。省くと ChatGPT Plus の経路（`openai-codex` の `gpt-6-sol`）で、ログインは `--judge-auth <file>`（既定は `~/.pi/agent/auth.json`） |
| `--no-judge` | ルーブリックの項目を判定しません（「判定できず」に数えます） |
| `--scenes <dir>` | 場面の置き場。何度でも書けます。既定は `eval/scenes` |
| `--scene <name>`・`--variant <name>` | 回す場面と変種を絞ります。何度でも書けます |
| `--runs N` | 回数。場面の `runs` より優先します |
| `--label L`・`--out <dir>` | 結果の置き場は `<out>/<label>/`。`--out` の既定は `eval/results`（Git は無視します） |
| `--max-calls N`・`--minutes N` | 打ち切り（モデルの呼び出し回数と時間）。場面の `limits` より優先します |
| `--concurrency N` | 並べて回す数。既定は 1。所要時間の比較が崩れるので、速さを測るときは 1 のままにします |
| `--memo model` | ターンの後の一行メモも評価するモデルに頼みます。既定は決まった文で答え、呼び出しを使いません |
| `--dry-run` | 偽のモデル（場面の `dryRun`）で回します。判定役も呼びません |
| `--actor <file>` | LLM が演じる相手役のモデル。省くと ChatGPT Plus の経路（`openai-codex` の `gpt-6-sol`）で、ログインは `--actor-auth <file>`（既定は `~/.pi/agent/auth.json`）。返事を書いていない相手役がいて、`follow` の場面を回すときだけ使います |
| `--snapshots <dir>` | 写しの置き場。既定は `~/.local/share/natsumi-eval/snapshots` |
| `--workspace host` | bubblewrap を使わずに runner を手元で動かします。パスが本番と違い、閉じ込めもないので、ドライランでだけ使えます |

回は、全部の条件を 1 周ずつ回してから次の周に進みます。エンドポイントの揺れが、どの条件にも同じように掛かるようにするためです。

ほかのコマンド:

- `npm run eval -- list`: 場面と変種と項目の一覧。このブランチで回せない場面には、その理由が付きます
- `npm run eval -- summarize <結果のディレクトリ>`: 集計し直します
- `npm run eval -- pull …`・`npm run eval -- snapshots`: 本番の写しを取る・一覧する（下の「本番の写しから試す」）
- `npm run eval -- curate …`・`npm run eval -- curate-compare <a> <b>`: 写しの記憶で整理係の一晩を回す・2 つの夜を並べる（下の「係の一晩を写しで回す」）
- `npm run eval -- compare <a> <b>`: 場面・変種・項目ごとに、合格数、率の差（b − a）、Newcombe の 95% 区間を並べます。その横に、着くまでの呼び出し回数の中央値（数えた回数つき）と、その差（b − a）を並べます

### 結果

`<out>/<label>/` に次のものができます。

- `runs.jsonl`: 1 行 1 回。渡した出来事、ターンのプロンプト、システム指示の大きさと SHA-256、モデルの呼び出しごとの時間・トークン・本文、ツールの呼び出しと結果、本人に見せたもの、ポッポさんへの依頼、項目ごとの判定（規則・関数・LLM のどれで判定したか）、終わり方。
- `summary.md`・`summary.json`: 項目ごとの合格数と Wilson の 95% 区間、着くまでのステップ（下の「着くまでのステップ」）、副指標（呼び出し回数、秒、トークン、打ち切り、失敗）、失敗の理由、飛ばした場面。
  失敗は、回を作れなかった回（`error`）と、モデルの呼び出しが失敗して終わった回（`model-error`）です。理由は `runs.jsonl` の `error` と、呼び出しごとの `error`（プロバイダーのメッセージ。エンドポイントのホストは除きます）にも残ります。
- `work/<場面>/<変種>/run-<N>/`: その回のデータディレクトリと Pi の session。ターンの中身を読み返せます。

### 着くまでのステップ

合格したかどうかに加えて、正解に着くまでにどれだけ掛かったかを見ます。
規則の項目のうち、モデルの呼び出しの中でしたこと（ツールを呼んだ、読んだ、返事をした）で満たされるものには、初めて満たされた呼び出しの番号（1 から）と、その呼び出しの終わりまでに使ったトークン（input・cache read・output の合計）と経過時間（出来事を渡してから）を記録に残します（`runs.jsonl` の各項目の `reached`）。
`min` があれば、数がその回数に届いた呼び出しです。合格しなかった回には残しません。

| 部品 | 着くまで |
| --- | --- |
| `called`・`shell`・`output`・`read`・`asked`・`reply` | 残します（`min: 0` のときは残しません） |
| `notCalled`・`notRead` | 残しません。「しなかった」ことは、どの呼び出しでも起きていません |
| `modelCalls`・`finished` | 残しません。ターン全体で決まります |
| `rubric`・`function` | 残しません。記録の全体を見て決まります |

集計では、合格した回だけで、着くまでの呼び出しの番号の中央値と 90 パーセンタイル、秒とトークンの中央値を、合格の率の横に出します。
この機能の前に書かれた結果には記録が無いので、この欄は空（`—`）になります。

読み方の注意:

- 合格した回だけの数です。率が下がって速く着く回だけが残ると、中央値は良く見えます。率と並べて読みます。
- 回数が少ないと中央値は大きく揺れます。呼び出しの番号は整数なので、5 回程度の中央値の 1 回の差は偶然でも起こります。`compare` の括弧の回数を見て、差を言うには 10 回以上を目安に回します。区間は出していません。
- 秒はエンドポイントの混み具合で揺れます。速さを比べるときは `--concurrency 1` で、同じ時間帯に回します。

key とエンドポイントの URL は、どこにも残しません。結果に残るのは provider とモデルの名前だけです。
ただし `work/` の中の session には、モデルが読んだもの（場面のファイル、私的な場面なら本番の写し）がそのまま入ります。

## モデルのファイル

本番の設定の `pi` と同じ書き方で、経路を 1 つだけ書きます。

互換エンドポイント（key はファイルか環境変数から読みます）:

```json
{ "pi": {
  "model": { "provider": "natsumi-compatible", "id": "example-model" },
  "compatible": { "baseUrl": "https://llm.example.net/v1", "apiKeyFile": "/home/me/.config/natsumi-eval/key", "contextWindow": 131072 }
} }
```

サブスクリプションのログイン（Pi の CLI でログインしたファイル）:

```json
{ "pi": { "model": { "provider": "openai-codex", "id": "gpt-6-sol" }, "authPath": "/home/me/.pi/agent/auth.json" } }
```

`pi.thinking` に `"off"` を書くと思考なしで回します（既定は本番と同じ `"on"`）。

## 場面の書き方

1 つの場面は、1 つのディレクトリの `scene.yaml` です。ディレクトリの名前が場面の名前になります。
部品で書けない準備や判定は、同じディレクトリの `scene.ts` に関数として書きます。
`eval/scenes/` の場面が例です。リポジトリの場面は、人物も会話もすべて架空にします。

```yaml
description: 夕飯の約束の時刻を聞かれて、/memory のメモを探してから答える
runs: 5
time: "2026-09-27T17:40:00+09:00"
files:
  /memory/plans/2026-09.md: |
    - 9/27（土）19:00 駅前の定食屋で、佐藤さんと夕飯。
event:
  mac_message: 今日の夕飯の約束って何時だっけ？
checks:
  - { id: replied-once, called: reply_to_mac, max: 1 }
  - { id: looked-in-memory, shell: "/memory" }
  - { id: answer, rubric: 今日の夕飯が 19 時であることを答えている。 }
```

### 始めの状態

| キー | 意味 |
| --- | --- |
| `files` | workspace のパス → 中身。`/memory`・`/work`・`/home/natsumi`・`/sources`・`/manual`（`/manual/agents` を含む）の下に書けます。`{ file: ./x.md }` で場面の横のファイルを使えます。`/manual` の下はリポジトリのマニュアルを上書きします |
| `copy` | workspace のパス → 場面の横のディレクトリ。まるごと写します |
| `edits` | `{ path, replace, with }`。ファイルの一部を書き換えます。書き換える文が無ければ、その回は失敗します |
| `prompt` | `{ replace, with }`。システム指示の一部を書き換えます。書き換える文がブランチの指示に無ければ、その回は失敗します |
| `time`・`timeZone` | 出来事が届く時刻（ISO 8601）と本人のタイムゾーン（既定 `Asia/Tokyo`）。思考ループの時計だけが動きます。shell の `date` は実際の時刻を返します |
| `context.prelude` | 評価するターンの前のやりとり。`{ event, calls }` の並びで、`calls`（`{ tool, args }`）は決まった応答として本物の思考ループに回します |
| `context.padding` | `{ turns, chars }`。文脈の水増し。ping のターンを `turns` 回、それぞれ `chars` 文字の思考で回します |
| `context.session` | 始めの文脈にする Pi の session のファイル（場面の横からの相対パス）。下の「私的な場面」 |
| `dove` | `true` にすると、`ask_agent` の `poppo` を受け付けて記録します（Slack が設定されているときと同じ）。`/manual/agents/INDEX.md` にもポッポさんが載ります |
| `setup` | `scene.ts` の関数の名前。ループを開く前に、データディレクトリとマニュアルの写しを受け取って準備をします（git の履歴を作るなど） |
| `limits` | `{ modelCalls, minutes }`。打ち切り。省くと本番の既定です |
| `start` | `{ snapshot: latest }` か `{ snapshot: <写しの名前> }`。本番の写しから始めます（下の「本番の写しから試す」）。写しが無ければ、その場面は飛ばして、集計に残します。`context.session` とは一緒に書けません |
| `actors` | 相手役。下の「相手役と、続けるターン」 |
| `follow` | `true` か `{ maxTurns: N }`。相手役の返事を出来事として積み、処理するターンまで続けます。上限の既定は 4 ターンです |
| `requires` | 要る機能（いまは `sources-updated`）。ブランチに無ければ、その場面は飛ばして、集計に残します |
| `dryRun` | ドライランで偽のモデルが答える内容。`{ thinking, text, calls }` の並びで、1 つが 1 回の呼び出しです |

### 出来事

`event` に 1 つだけ書きます。

- `mac_message: <本文>`: 本人の Mac のメッセージ。サーバーと同じ入口から渡し、行は思考ループが作ります。
- `ping: {}`: 定期の ping。
- `line: { type: …, … }`: 出来事の行そのもの。まだ無いイベントの形や、欄の違いを比べるために使います。
  外からの出来事の口（Slack の側、`sources_updated` が入ってからはその側）を通すので、ターンの経路は同じです。`received_at` を省くと思考ループの時刻が入ります。

### 判定の項目

`checks` の 1 つに、`id` と次のうち 1 つを書きます。`min`・`max`（既定は 1 回以上）で回数を絞れる部品もあります。

| 部品 | 合格の条件 |
| --- | --- |
| `called: <ツール>` | そのツールが呼ばれた。`args: { <引数>: <正規表現> }` で引数も絞れます。`min`・`max` |
| `notCalled: <ツール>` | そのツールが呼ばれなかった |
| `shell: <正規表現>` | run_shell のコマンドが合った。`min`・`max` |
| `output: <文字列>` | run_shell か read の結果に含まれた。`min`・`max` |
| `read: <パス>`・`notRead: <パス>` | read で読んだか、run_shell のコマンドがそのパスを含んだ（読まなかった）。ディレクトリも書けます |
| `asked: { agent, message, to }` | `ask_agent` の宛先、本文の正規表現、ポッポさんへの依頼の返す先（`{ file: /sources/slack/work/dev/2026-09-27.jsonl, path: ".[36]" }`、チャンネルなら `file` だけ）が合った。`min`・`max` |
| `reply: <正規表現>` | 本人への返事の文が合った。`min`・`max` |
| `modelCalls: { min, max }` | モデルの呼び出し回数 |
| `finished: true` | 打ち切られずに終わった |
| `rubric: <基準>` | 判定役の LLM が基準を満たすと答えた |
| `function: <名前>` | `scene.ts` の関数が合格と答えた。関数はその回の記録（`src/eval/record.ts` の形）を受け取り、真偽か `{ pass, detail }` を返します |

判定できなかった項目（判定役が答えない、関数が失敗したなど）は、合否に数えずに「判定できず」に数えます。

### 変種

同じ場面の小さな違いです。`variants` に名前ごとに書くか、`axes` に軸ごとに書いて掛け合わせます（`axes` なら変種の名前は `P/with` のようになります）。
変種には `event`（置き換え）、`files`・`copy`（上書き）、`edits`・`prompt`（足す）、`checks`（同じ `id` は置き換え、ほかは足す）を書けます。
`setup` の関数は変種の名前を受け取るので、変種ごとの準備もできます。

## 相手役と、続けるターン

`ask_agent` の相手は、場面の `actors` に書いた相手役です。名前は `ask_agent` の `agent` にそのまま使われます（`poppo` はポッポさん）。
相手役がいれば、本番で設定があるときと同じく `/manual/agents/INDEX.md` に載り、依頼は受け付けられます。書いていない名前は、本番で設定に無い相手と同じく断られます。

```yaml
actors:
  wiki-keeper:
    card: Wiki の管理人。Wiki の記事を調べて答え、原文の追加を PR にする。   # Agent Card の説明（省くと決まった文）
    instructions: デプロイは毎週木曜、と答える。                           # LLM が演じるときの場面の指示
  researcher:
    replies:                                                          # 書いた返事をそのまま返す（LLM を呼ばない）
      - 調べました。候補は 3 つです。
  poppo:
    replies:
      - ポッポ！ #dev に届けたよ。                                       # 届けた（result: sent）
      - { result: returned, text: ポッポ、これは届けられないよ。 }          # 突き返した
follow: true
```

- 既定は 1 ターンです。相手役は依頼を受け付けるだけで、返事はしません。
- `follow` を書くと、ターンが終わるたびに、そのターンの依頼に相手役が答え、本物と同じ出来事で返します。外のエージェントの返事は、実行の data directory の `sources/agents/` に置かれ、`sources_updated` の attention（kind `agent_reply`）で届きます（サーバーの返事の取りに行きの道筋と、本物の `sources` を通ります。ADR 0069）。ポッポさんの返事も、本物と同じく依頼のディレクトリの `results.jsonl` に 1 行足され、attention（kind `agent_reply`、agent `poppo`、`state`・`summary`）で届きます（ADR 0074）。同じターンの依頼への返事は、1 つの `sources_updated` にまとめて届きます。依頼が無くなるか、ターンが上限に達したら止まります。
- `replies` を書いた相手役は、書いた順に返事を返します（使い切ったら最後のものを繰り返します）。ポッポさんの `result` は `sent`・`reacted`・`to_owner`・`returned`・`rejected`・`expired`・`not_sent` のどれかで、省くと `sent` です。
- `replies` の無い相手役は LLM（`--actor`）が演じます。外のエージェントは Agent Card の説明と `instructions` を、ポッポさんは「判定と承認を経て投稿する係」という役と `instructions` を渡されます。ドライランでは決まった文で答えます。
- 相手役への依頼と返事、返事が書いた文か LLM か（`by`）は、結果の `actors` に残ります。判定役にも見せます。ターン数は `turns`、呼び出し回数・トークン・時間は全ターンの合計です。
- 相手役のぶれを除いて版を比べたいときは、`replies` を書いた場面を使います。

## 本番の写しから試す

Kubernetes で動いている本番の状態を手元に写し、修正したコードで、その状態から 1 ターン（`follow` なら返事を受けるまで）回します（[ADR 0052](../docs/adr/0052-trying-a-turn-on-a-copy-of-production.md)）。

### 写しを取る

```sh
# 今の状態: backup のジョブをその場で起こし、終わるのを待ってから持ってくる
npm run eval -- pull --context <本番の context>
# 毎日の backup の SQLite を使う（ファイルは常に最新の鏡）。stamp は backup の sqlite/state-<stamp>.sqlite の部分
npm run eval -- pull --context <本番の context> --backup latest
npm run eval -- pull --context <本番の context> --backup 20260927T203000Z
npm run eval -- snapshots
```

| 指定 | 意味 |
| --- | --- |
| `--context C` | kubectl の context。省くと kubectl の今の選択 |
| `--namespace N`・`--cronjob J` | 既定は `natsumi` と `natsumi-backup` |
| `--backup <stamp>` | 毎日の backup の SQLite を選びます。`latest` はいちばん新しいもの。省くとジョブを起こします |
| `--snapshots <dir>`・`--keep N` | 置き場（既定 `~/.local/share/natsumi-eval/snapshots`、0700）と、残す数（既定 3）。取るたびに古いものを消します |
| `--kubectl <path>` | kubectl の場所 |

取り方:

1. backup の CronJob の定義を読み、NFS の場所と natsumi の image を知ります。
2. （`--backup` が無ければ）`kubectl create job --from=cronjob/natsumi-backup` でジョブを起こし、終わるのを待ちます。
3. なつみの PVC をマウントしない使い捨ての Pod を立て、backup の NFS を読み取り専用で読みます（root ですが、できるのは読むことだけです）。1 時間で自分で止まります。
4. 許可リストの場所だけを tar で手元に流し、置き場に展開します。
5. 使い捨ての Pod と、起こしたジョブを消します。なつみの Pod では何も動かしません。

写すもの（許可リスト）:

| 写しの中 | 本番のボリューム |
| --- | --- |
| `data/memory/` | 記憶（git の履歴を含む。人格と常時記憶もここ） |
| `data/sources/`・`data/sources.git/` | `/sources` とその履歴 |
| `data/work/` | `/work` |
| `data/.natsumi/images/` | 返事に添えた画像 |
| `data/.natsumi/state.sqlite` | SQLite の整合したコピー（backup の `sqlite/state-<stamp>.sqlite`） |
| `pi/sessions/` | Pi の session |

写さないもの: Pi のログイン（`auth.json`）と状態、設定、`/home/natsumi`、証明書、`data/.natsumi` のほかのファイル、そのほか許可リストに無いものすべて。
SQLite の写しからは、端末の push の token（`push_registrations`）とログインの session（`client_sessions`）を空にし、空いた領域も消してから置きます。

### 写しから始める場面

```yaml
start: { snapshot: latest }
time: "2026-09-28T09:00:00+09:00"
event:
  mac_message: きのう頼んだ件、どうなった？
actors:
  wiki-keeper:
    instructions: 頼まれた記事はまだ書いていない、と答える。
follow: true
checks:
  - { id: replied, called: reply_to_mac }
```

- 回ごとに、写しを結果の `work/` の下にコピーしてから使います。写しそのものは変わりません。評価するブランチの migration は、そのコピーの SQLite に走ります。
- session は、写しの SQLite が今の会話として指しているものを開きます。夜の切り替えより前の session は使いません。
- 写しに残っていた未処理の出来事は失敗として閉じ、返事を待っていた外のエージェントへの依頼は待つのをやめた扱いにします（どちらも出来事は作りません）。評価するターンには、場面の出来事だけが渡ります。
- `files`・`copy`・`edits`・`prompt`・`context.prelude` は、写しの上に重なります。
- 渡す出来事は場面に手で書きます。本番の過去の出来事を再生することはしません。
- 写しを使う場面はリポジトリの外（私的な場面）に置くのが基本です。`eval/scenes/replay-example` はリポジトリに置いた例で、写しが無ければ飛ばされます。

### 外に作用させない仕組み

写しを使う場面を回すときは、次の 3 つが必ず掛かります。

1. **評価用の設定だけ。** 本番の設定は写さず、読みもしません。外のエージェントの相手は相手役（この process の中）で、token のファイルは存在しない場所を指します。Slack・APNs にはつながりません。
2. **ネットワークからの隔離。** 評価のプロセス全体を bubblewrap の新しいネットワークの名前空間（loopback だけ）で動かし直します。
   外へ出られるのは、外側の中継（HTTP の CONNECT）を通る道だけで、中継は評価するモデル・判定役・相手役のエンドポイントのホストとポートだけを通します（`openai-codex` は `chatgpt.com:443` と `auth.openai.com:443`）。
   それ以外は名前の解決もされずに断られ、断った宛先は終わりに表示します。ファイルシステムは読み取り専用で、書けるのは結果の置き場、一時の置き場、ログインのファイルのあるディレクトリ（token の更新のため）だけです。
   環境変数は、proxy の設定と、モデルのファイルが `apiKeyEnv` で名指しした変数、`NODE_EXTRA_CA_CERTS`・`SSL_CERT_FILE`（自前のエンドポイントの CA）のほかは渡しません。workspace の runner は外側で起動し、Unix socket で渡します。
   中の Node は、起動時に環境の proxy から作った dispatcher を、Pi を読み込んだあとに戻します。Pi が読み込む undici は、proxy を知らない dispatcher に差し替えるからです。
3. **起動時の拒否。** 次のものがあれば始めません。理由には場所だけを出し、値は出しません。
   - 名前に `SLACK`・`APNS`・`A2A` を含む環境変数、または値が Slack の token・秘密鍵・JWT の形の環境変数
   - 本番の秘密の置き場（`/run/secrets/natsumi`・`/run/secrets/natsumi-a2a` など）
   - 使う写しの中の、Slack の token・秘密鍵・JWT の形の文字列（git のオブジェクトは圧縮されているので見ません）と、SQLite の push の token・ログインの session の行

   手元の shell に `SLACK_WEBHOOK_URL` などがあると拒否されます。そのときは `env -u SLACK_WEBHOOK_URL npm run eval -- run …` のように外して回します。

bubblewrap が user と network の名前空間を作れない環境では、写しを使う場面は回せません。

### 結果の置き場

写しを使う場面を含む回の結果は、既定で `~/.local/share/natsumi-eval/results/<label>/`（0700）に置きます。`--out` にリポジトリの中は指定できません。
30 日より古い結果は、写しを使う回を始めるときに消します。集計と `compare` はほかの結果と同じです。

```sh
npm run eval -- run --scenes ~/natsumi-eval/scenes --model ~/natsumi-eval/qwen.json --judge ~/natsumi-eval/plus.json --runs 5 --label replay-before
npm run eval -- compare ~/.local/share/natsumi-eval/results/replay-before ~/.local/share/natsumi-eval/results/replay-after
```

## 係の一晩を写しで回す

記憶の整理係（[ADR 0055](../docs/adr/0055-a-memory-curator-at-night.md)）の一晩を、本番の写しの記憶の上で回します（[ADR 0068](../docs/adr/0068-a-curator-that-remembers-like-a-person.md)）。
係の変更を本番に入れる前に、結果の記憶を読み、モデルの経路どうしを比べるためのものです。判定の項目はありません。読むのは本人です。

```sh
npm run eval -- pull --context <本番の context>
npm run eval -- curate --model ~/natsumi-eval/qwen.json --label curator-qwen
npm run eval -- curate --model ~/natsumi-eval/plus.json --label curator-plus
npm run eval -- curate-compare ~/.local/share/natsumi-eval/results/curator-qwen ~/.local/share/natsumi-eval/results/curator-plus
```

| 指定 | 意味 |
| --- | --- |
| `--model <file>` | 係を回すモデル（上の「モデルのファイル」）。設定の `curator.route` の代わりに、このファイルの経路で回します |
| `--snapshot <name>` | 使う写し。既定は `latest`（いちばん新しいもの）。同じ写しで経路を比べるときは名前で揃えます |
| `--snapshots <dir>` | 写しの置き場。既定は `~/.local/share/natsumi-eval/snapshots` |
| `--label L`・`--out <dir>` | 結果の置き場は `<out>/<label>/`。`--out` の既定は `~/.local/share/natsumi-eval/results` |
| `--max-calls N`・`--minutes N`・`--rotate-files N` | 係の上限と順番の本数（設定の `curator.modelCalls`・`timeoutMinutes`・`rotateFiles`）。省くと設定の既定値 |
| `--at <時刻>` | 係に伝える「今夜」。既定は写しを取った時刻 |
| `--stop-starting-at HH:MM` | 朝の締め切り（設定の `curator.stopStartingAt`）。`--at` の後で最初に来るこの時刻を過ぎたら、次の工程を始めません。既定は無しで、写しを取った時刻に関わらず全工程を回します。要約に締め切りと、始めなかった工程（`skipped-deadline`）が出ます |
| `--time-zone <zone>` | 日付を決めるタイムゾーン。既定は手元のもの |
| `--dry-run` | 偽のモデルで流れを確かめます。key は読みません。偽のモデルの答えは `--script <file>` で書けます（場面の `dryRun` と同じ形の YAML のリスト）。省くと「変えることはありません」と答えて終わります |

回し方:

1. 写しの記憶（git の履歴ごと）、SQLite、Pi の session を、結果の `copy/` に写します。写しそのものは変わりません。評価するブランチの migration は、写した SQLite に走ります。
2. 写しの記憶にコミットされていない変更があれば、夜の前に `eval: 写しにコミットされずに残っていた変更` として別にコミットします。本番では、夜の振り返りが係の直前にコミットしているからです。係の途中で取られた写しなら、サーバーと同じく係の書きかけを捨てます。
3. サーバーと同じ係の一晩（全工程）を 1 度回します。写しに係の書きかけが残っていれば、サーバーの起動と同じく先に捨てます。なつみの夜の振り返りは回しません。係の作業環境は本物の runner（bubblewrap の中）です。
   最初の工程（出来事から知識へ）に渡す会話の本文は、写した Pi の session から、写しの SQLite にある前回の整理の成功から「今夜」までを抜き出します。
4. 係が残した記憶とコミットを読み、要約を出します。

外に作用させない仕組みは、上の「外に作用させない仕組み」と同じです（評価用の設定だけ、ネットワークからの隔離、起動時の拒否）。

結果（`<out>/<label>/`、0700、30 日で消します）:

| ファイル | 中身 |
| --- | --- |
| `summary.md` | 写し・モデル・時間、工程ごとの結果・呼び出しの回数・時間・token・ツールの失敗・コミット・変更の説明・検査に当たったもの（やり直す前に当たったものも）、コミットのメッセージ、変わったファイル、サーバーのログ（記憶と係の行だけ） |
| `night.json` | 同じものを JSON で。`curate-compare` はこれを読みます |
| `memory.diff` | 夜の前のコミットから夜の後までの `git diff` |
| `copy/data/memory/` | 夜の後の記憶。git の履歴ごとなので、`git log`・`git show`・`git diff <夜の前>` で読めます |
| `copy/pi/sessions/curator/` | 係の session の記録（工程ごとに 1 つ）。係が何を読み、どう考えたかはここにあります |

`curate-compare <a> <b>` は、2 つの夜を並べます（モデル、時間、コミットとファイルの数、工程ごとの結果、ファイルごとの変更）。写しが違えばそう書きます。
2 つの夜の記憶そのものの違いは `diff -ru --exclude=.git <a>/copy/data/memory <b>/copy/data/memory` で見られます。

結果には本人の記憶と、係が読んだ会話がそのまま入っています。Git やクラウドに上げないでください。

## 私的な場面

本番の文脈で試したいときは、リポジトリの外に場面のディレクトリを作り、`--scenes` で指定します。書き方はリポジトリの場面と同じです。
本番の会話・記憶を含むので、リポジトリには入れません。

```sh
npm run eval -- run --scenes ~/natsumi-eval/scenes --model ~/natsumi-eval/qwen.json --runs 5 --label private-before
```

### 本番の session の写しを取り出す

本番の状態をまるごと使うなら、上の「本番の写しから試す」のほうが手軽です。session だけを手で写すときは、次のようにします。

1. 本番の Pi の session は、設定の `pi.sessionDirectory` にある JSONL のファイルです。いま使っているものは、いちばん新しく書かれたものです（夜の切り替えで新しいファイルになります）。
   Kubernetes なら、たとえば `kubectl -n <namespace> exec <pod> -- ls -t <pi.sessionDirectory>` の先頭です。
2. 手元に写します: `kubectl -n <namespace> cp <pod>:<pi.sessionDirectory>/<file>.jsonl ~/natsumi-eval/scenes/<場面>/session.jsonl`
3. 場面の `context.session: ./session.jsonl` に書きます。評価のたびにこの写しを別の場所に写してから開くので、写しそのものは変わりません。
4. 途中までの文脈にしたいときは、ファイルの先頭から行の単位で切ります（1 行目の header は残します）。
5. 記憶も写したいときは、データディレクトリの `memory/` を写して `copy: { /memory: ./memory }` と書きます。

写しには本人の会話、記憶、Slack の中身がそのまま入っています。置き場の権限に気をつけ、Git やクラウドに上げないでください。

## 限り

- shell は手元のコマンドで動きます。本番の image にしか無いコマンド（`sdctl` の本体など）は動きません。image が `/usr/local/bin` に置くスクリプトは、Dockerfile の行を読んで同じ場所に置きます。
- bubblewrap が pid namespace を作れない環境（コンテナの中など）では、手元の `/proc` を読み取り専用で見せます。`ps` に手元のプロセスが見え、回の後に残ったコマンドは止まりません。
- 外のエージェント（A2A）の本物にはつなぎません。相手役は本物の Wiki などを読みません。
- 写しは許可リストの場所だけです。`/home/natsumi` などに頼るターンは、本番と違う動きをし得ます。
- 生の Slack のメッセージから `sources_updated` の行を組み立てる形はまだありません。行を直接書きます。
