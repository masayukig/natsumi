# Signal のグループ

あなたは、マスターが参加を認めた Signal のグループにいます。グループでの発言はファイルとして読め、書き込むのは Slack と同じく送信役のポッポさん（`poppo`）に頼みます。

## 何が届くか

グループで発言があると、Slack と同じく `sources_updated` の出来事で届きます。

- `changed` の `dir` が変わったグループです（例: `/sources/signal/g-1a2b3c4d`、マスターが名前を付けたグループは `/sources/signal/iori-test` のように）。`files`・`writes`・`diff` の意味は Slack と同じです（`/manual/slack.md` の「何が届くか」）。
- **あなた宛て**は、そのグループの `attention` に載り、待たずに届きます。
  - `kind` が `mention` なら、あなたへのメンションです。
  - `kind` が `quote-reply` なら、あなたの発言を引用した返事です。
  - `file` がその発言のあるファイル、`path` がファイルの中の場所（`jq -s` のパス）です。読み方は Slack と同じです: `jq -s '.[3]' /sources/signal/iori-test/2026-10-25.jsonl`。
- マスターがグループで書いたことも、ほかの人と同じくファイルに記録されます。マスターとの 1 対 1 の会話としては届きません。

## 記録の読み方

- `/sources/signal/<グループ>/<日付>.jsonl`: 1 日 1 ファイル。1 行が 1 発言の JSON で、届いた順に並びます。日付と時刻はマスターのタイムゾーンです。
  - 行の番号は 0 から数えます。`jq -s '.[N]'` が N 番目の行です。行はあとで動きません。
  - `at` は日付と秒までの時刻、`from` は発言者の Signal のプロフィール名（無ければ `someone`）、`text` は本文です。本文のメンションは `@名前` になっています。
  - `quote` は引用した返事で、`from` が引用元の発言者、`text` がその先頭です。`quote` の中の `mine: true` なら、あなたの発言の引用です。
  - 行の `mine: true` は、ポッポさんが届けたあなた自身の投稿です。
  - `attachments` は添付の名前・種類・大きさです。中身は取り込んでいないので、見ることはできません。
- 編集・削除・リアクションは記録されません。マスターが参加を認める前の発言もありません。
- `/sources/signal/INDEX.md`: 参加しているグループの、ディレクトリと Signal でのグループ名の目次です。
- 過去の流れは、前の行や前の日のファイルを読みます（例: `jq -s '.[0:4]' <file>`、`tail -n 5 <file>`）。

## 返し方（ポッポさんに頼む）

ask_agent でポッポさん（agent: `poppo`）に頼みます。書き方・判定・結果の読み方は Slack と同じです（`/manual/slack.md` の「返し方」と「結果」）。違うのは次のところだけです。

- `to` の `file` には `/sources/signal/` の下を書きます。
  - 発言に返す: その発言のある日のファイルと行の場所。`{"file": "/sources/signal/iori-test/2026-10-25.jsonl", "path": ".[3]"}`（出来事の attention の `file` と `path` をそのまま写せます）
  - グループそのものに投稿する: グループのディレクトリ。`{"file": "/sources/signal/iori-test"}`
- 発言への返事は、その発言を**引用した**投稿としてグループに出ます。Signal にはスレッドがありません。
- リアクションの `emoji` には、絵文字そのものを 1 つ書きます（例: `"👍"`、`"🎉"`）。Slack の名前（`"+1"` など）は断られます。
- 参加していないグループ、マスターが答えていないグループには頼めません（その場で断られます）。
- `face` は Signal では使われません（アイコンは変わりません）。
- 結果の `slack_file` と `slack_path` は、Signal の記録の中のあなた自身の投稿の行を指します（名前は Slack と共通です）。

```json
{"kind": "post", "to": {"file": "/sources/signal/iori-test/2026-10-25.jsonl", "path": ".[3]"}, "text": "10 時に駅でお願いします。"}
```

```json
{"kind": "reaction", "to": {"file": "/sources/signal/iori-test/2026-10-25.jsonl", "path": ".[3]"}, "emoji": "👍"}
```
