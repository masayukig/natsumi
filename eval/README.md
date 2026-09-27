# 1 ターンの評価

なつみの 1 ターンを、サーバーと同じ思考ループで回して、期待どおりに動いたかを確かめます（[ADR 0051](../docs/adr/0051-evaluating-one-turn-on-the-real-path.md)）。
同じ場面を何度も回し、場面・変種・項目ごとの成功率を出します。2 つの版の結果を並べて比べられます。

- 通るのは本物の経路です。システム指示、ツールの定義と結果の文、イベントの行、打ち切り、マニュアル（`manual/`）は、評価するブランチのものがそのまま使われます。
- workspace の shell は本物の runner（`runner/`）で、bubblewrap の中で本番のコンテナと同じ配置にして動かします。ネットワークはありません。
- 外への作用は記録するだけです。Mac への返事と知らせは記録に残り、ポッポさんへの依頼は形を確かめて受け付けの文を返すだけで、Slack には何も送りません。
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
| `--workspace host` | bubblewrap を使わずに runner を手元で動かします。パスが本番と違い、閉じ込めもないので、ドライランでだけ使えます |

回は、全部の条件を 1 周ずつ回してから次の周に進みます。エンドポイントの揺れが、どの条件にも同じように掛かるようにするためです。

ほかのコマンド:

- `npm run eval -- list`: 場面と変種と項目の一覧。このブランチで回せない場面には、その理由が付きます
- `npm run eval -- summarize <結果のディレクトリ>`: 集計し直します
- `npm run eval -- compare <a> <b>`: 場面・変種・項目ごとに、合格数、率の差（b − a）、Newcombe の 95% 区間を並べます

### 結果

`<out>/<label>/` に次のものができます。

- `runs.jsonl`: 1 行 1 回。渡した出来事、ターンのプロンプト、システム指示の大きさと SHA-256、モデルの呼び出しごとの時間・トークン・本文、ツールの呼び出しと結果、本人に見せたもの、ポッポさんへの依頼、項目ごとの判定（規則・関数・LLM のどれで判定したか）、終わり方。
- `summary.md`・`summary.json`: 項目ごとの合格数と Wilson の 95% 区間、副指標（呼び出し回数、秒、トークン、打ち切り、失敗）、飛ばした場面。
- `work/<場面>/<変種>/run-<N>/`: その回のデータディレクトリと Pi の session。ターンの中身を読み返せます。

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
| `asked: { agent, message, replyTo }` | `ask_agent` の宛先、本文の正規表現、ポッポさんへの依頼の返信先（`work/#dev 2026-09-27 14:32:05 田中` の形）が合った。`min`・`max` |
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

## 私的な場面

本番の文脈で試したいときは、リポジトリの外に場面のディレクトリを作り、`--scenes` で指定します。書き方はリポジトリの場面と同じです。
本番の会話・記憶を含むので、リポジトリには入れません。

```sh
npm run eval -- run --scenes ~/natsumi-eval/scenes --model ~/natsumi-eval/qwen.json --runs 5 --label private-before
```

### 本番の session の写しを取り出す

評価の仕組みは本番に触れません。写しは本人が本番から取り出して置きます。

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
- 外のエージェント（A2A）にはつなぎません。`ask_agent` の相手がポッポさん以外なら、本番で設定が無いときと同じく断られます。
- 生の Slack のメッセージから `sources_updated` の行を組み立てる形はまだありません。行を直接書きます。
