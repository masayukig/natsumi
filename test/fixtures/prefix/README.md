# prefix のスナップショット

`with-workspace.json` と `without-workspace.json` は、session の生成時に 1 度だけ組まれ、session の間ずっと
変わらないもの —— system prompt とツールの定義 —— をそのまま写したものである。`test/prefix.test.ts` が突き合わせる。

**変えるときは意図して更新する。prefix が変わると、走っている session のキャッシュが全損する。**
バックエンドは prefill が遅く、ここが 1 文字変わると、その session は夜の切り替えで作り直されるまで、
毎ターン prompt 全体を読み直すことになる（ADR 0019）。

更新するときは、文面を変えた上で次を実行し、差分を読んでからコミットする。

```
UPDATE_PREFIX_FIXTURES=1 node --test test/prefix.test.ts
```

## 中身

- `systemPrompt` —— サーバーが組む指示。`personality.md`・`always.md`・`handoff.md` には固定の 1 行ずつを
  入れて測っている。写っているのは骨組みと、サーバーが各節に付ける見出しであり、記憶の中身ではない。
  3 つのファイルはどれも自分の見出しで始めてあるので、**サーバーの見出しと重なっていないこと**もここで固定される
  （ADR 0020）。
- `trailer` —— Pi が後ろに足す作業ディレクトリの節（`<cwd>`）。`{dataDirectory}` は実行ごとに変わるデータディレクトリを置き換えたもの。
  Pi の更新でここが増えれば、文面を変えていなくても prefix は動く。
- `tools` —— `createLoopTools` が返す順のツール。`name`・`description`・`parameters`（JSON schema）。

## Codemode を on にしたとき（ADR 0066）

`with-workspace-codemode.json`（作業環境のツールは `direct`）と `with-workspace-codemode-scripts-only.json`
（作業環境のツールは `codemode`、スクリプトからだけ）は、`loop.codemode.enabled` を true にしたときの並びと文面である。
Codemode は既定で off で、off のときは上の 2 つから何も変わらない。

- `tools` は、ここでは `createLoopTools` からではなく、**session がモデルに宣言している形**から写す。
  Pi は codemode があると、スクリプトから呼べるツールの説明の末尾に呼び方を足し、codemode の説明に
  スクリプトからだけ呼べるツールの宣言を載せる。その文面は Pi が組むので、Pi の更新でも動きうる。
- codemode は最後に並ぶ。`direct` では作業環境のツールも宣言に残り、`codemode` では宣言から外れて
  codemode の説明の中にだけ現れる。

## skills を on にしたとき（ADR 0073）

`with-workspace-skills.json` は、`skills.enabled` を true にしたときの system prompt とツールである。
data directory の `skills/`（本人の skill）と記憶の `skills/`（なつみの skill）に固定の skill を 1 つずつ置いて測っている。
skill は他の場合にも置いてあり、off のときは上の fixture から何も変わらないこと（一覧が入らないこと）も、それで確かめている。

- 作業環境の節の中に、skill の置き場所と書き方の節（`### skill`）が入る。
- `systemPrompt` の末尾に、Pi が足す skill の一覧（`<skills>`）が入る。パスは作業環境から見たもの（`/skills/...`・`/memory/skills/...`）で、
  本人の分が先に並ぶ。一覧の前置きの英文は Pi が組むので、Pi の更新でも動きうる。
- ツールの定義は skills off のときと同じである。`read` の説明は変えず、`/skills` を読めるのは実行のときの検査だけで決まる。

## config で tools を宣言したとき（ADR 0075）

`with-workspace-tools.json`（Codemode off）と `with-workspace-tools-codemode.json`（Codemode on）は、config の
`tools` に固定のツールを 2 つ（`direct` の `weather` と、`codemode` の `count_words`）宣言したときのツールである。
tools を書かない config では、上の fixture から何も変わらない。

- 宣言したツールは、組み込みのツールのすべての後ろに、宣言した順で並ぶ。`description` と `parameters` は書いたとおりに載る。
- system prompt は宣言の有無で変わらない（テストで突き合わせている）。
- Codemode が off のときは、`exposure` に関わらず、すべてモデルに宣言される（組み込みのツールと同じ）。
  on のときは、`direct` は宣言に残って呼び方の文が足され、`codemode` は宣言から外れて codemode の説明の中にだけ現れる。
