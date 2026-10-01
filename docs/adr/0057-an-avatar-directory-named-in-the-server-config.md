# 0057. アバターと名前を、サーバーの設定で指すアバターのディレクトリから決める

- Date: 2026-09-28
- Status: Accepted（アバターのディレクトリに、性格・話し方の初期値の `personality.md` を足すことは [ADR 0060](0060-a-personality-to-start-from-in-the-avatar.md) で追加）

## Context

なつみの姿と名前は、コードのあちこちに直に書かれている。

- 姿: Mac アプリは同梱の `mac/Avatars/natsumi`（Codex pet の `pet.json` と spritesheet に、表情のアイコンと表情→動作の対応を書いた `avatar.json` を足したもの）を既定とし、手元の設定で別のディレクトリも指せる。iPhone は同梱のものに固定。
  Slack のアイコンは、リポジトリの `assets/avatar/<表情>.png` をサーバーが配る（[ADR 0040](0040-the-dove-sends-what-the-judge-passes.md)）。
- 自分の姿のプロンプト: `manual/images.md` の「あなた自身の姿」に LoRA・体の行・既定の服・確かめる語が直書きされ、評価の場面 `self-look`・`draw-other` も同じ語を直書きしている。
  画像生成の既定の params（`docker/sdctl/anima.yaml`）は作業環境の image に焼き込まれている（[ADR 0044](0044-drawing-with-sdctl-and-posting-images.md)）。
- 名前: system prompt の「あなたは natsumi。」、記憶の整理係のプロンプト、iPhone への通知のタイトル、記憶のコミットの author、ダッシュボードの文言。

本人は、アバターと名前を設定から変えられるようにしたいと考えた。アバター用のディレクトリがあり、既定はなつみ、パスを指定するとそのアバターになる。
設計は grill-me（Q0〜Q15）で詰めた。決まったことの要点は次のとおりである。

- 設定はサーバーに置く。Mac の手元のアバターの設定はなくし、Mac・iPhone・Slack で必ず同じ姿にする。アプリはアバターを同梱せず、サーバーから丸ごと受け取って手元に控える。
- 名前は表示名（例「なつみ」）と ID（英文字、例 `natsumi`）の 2 つを持つ。
- アバターは基本的に切り替えない。最初に決めたものを使い続け、途中で切り替えたときの記憶の中の古い名前などは扱わない。記憶はアバターごとに分けない。
- 指定したアバターに無い素材は、のっぺらぼうの汎用の素材で埋める。なつみの素材では埋めない（別のキャラの顔が混ざらないように）。
- 設定が壊れていれば起動を止め、素材が一部足りないだけなら止めない。
- 素材は 1.9MB あり、ConfigMap（1MiB）に入らない。なつみ以外のアバターは永続ボリュームに置く。
- アバターは 2 種類ある。サーバーの image に含めた組み込みのアバター（なつみはこれ）は ID で選び、後から足すアバターはパスで指す（grill Q5 の修正）。
- のっぺらぼうの素材は、組み込みのアバター「名無し」（`nanashi`）とし、これも ID で選べる。

制約は次のとおりである。

- system prompt とツールの説明は session の生成時に 1 度だけ組み、走っている session では変えない。設定の値から文面を組み立てない（[ADR 0019](0019-a-workspace-not-a-memory-tool.md)、[ADR 0056](0056-the-manual-index-and-the-workspace-commands-in-the-prompt.md)）。
- 作業環境は、サーバーが data directory に書いたものを読み取り専用で見る。前例は `/manual/agents`（[ADR 0036](0036-a-manual-to-read-and-a-limit-on-waiting.md)）。
- Kubernetes では、ファイル 1 枚の subPath のマウントは、起動順によってはファイルの代わりにディレクトリが作られてしまう。読み取り専用のマウントの中にさらにマウントを重ねると、マウント先のディレクトリを作れずに起動できないことがある。

## Decision

### config は組み込みの ID か、足すアバターのパスのどちらか一方

- config に `avatar` を足す。中身は次のどちらか一方で、両方を書く・どちらも書かないと `ConfigError` で止まる。
  - `avatar.id`: 組み込みのアバターの ID。サーバーの image の `assets/avatars/<id>/` のどれか。今は `natsumi`（なつみ）と `nanashi`（名無し）。
    知らない ID は、組み込みの ID の一覧を添えて `ConfigError`（`avatar.id`）で止まる。一覧はディレクトリから決まり、config の検査の時点では分からないので、アバターを読むときに確かめる。
  - `avatar.directory`: 足すアバターのディレクトリ（絶対パス）。
- `avatar` を省略すると、`avatar.id` が `natsumi` のときと同じになる。
- `avatar.appearance`（省略可）: `appearance.yaml` の絶対パス。選んだアバターの `appearance.yaml` を、混ぜずに丸ごと置き換える。
  組み込みのアバターを、ディレクトリを写さずに衣装違いで使うためのもの。`avatar.id` とも `avatar.directory` とも書ける。
  アバターの `appearance.yaml` と同じ検査をし、無い・壊れていると `ConfigError`（`avatar.appearance`）で止まる。
  運用者が指したファイルなので、ディレクトリの外を指す検査はせず、symlink（ConfigMap のマウント）もたどる。アプリには渡さないので、版は変わらない。
- 足すアバターの置き場所の目安は、永続ボリュームの別の場所を読み取り専用でサーバーにだけ見せる形（例 `/var/lib/natsumi-avatars/<id>`）。作業環境には見せない。
- 組み込みも足すものも、検査とのっぺらぼうの埋め方は同じである。組み込みのアバターが検査に通らないのは image の不具合なので、テストで固定する。

### アバターのディレクトリの形

| ファイル | 要否 | 中身 |
| --- | --- | --- |
| `avatar.json` | 必須 | `id`・`name` と、動作と表情の定義（下記） |
| `pet.json` | 省略可 | Codex pet の定義。そのままアプリに渡す。無ければサーバーが `id`・`displayName`・`spritesheetPath` だけのものを作る |
| spritesheet（例 `spritesheet.webp`） | 省略可 | 動作ごとのフレームを並べた画像。WebP か PNG |
| `icons/<表情>.webp` | 省略可 | 表情ごとの顔。アプリが会話の履歴でセリフの横に出す。WebP か PNG |
| `slack/<表情>.png` | 省略可 | Slack のアイコン。PNG で、名前は表情のとおり |
| `appearance.yaml` | 省略可 | 自分の姿のプロンプト（下記） |
| `sdctl-params.yaml` | 省略可 | 画像生成の既定の params（sdctl の params の YAML） |
| `README.md` | 推奨 | ライセンスと出どころ。サーバーは読まない |

`avatar.json` の欄:

- `id`: 英小文字で始まり、英小文字・数字・`-` の 32 文字まで。コミットのメールの部分・アプリの控えの置き場所・ログに使う。
- `name`: 表示名。1〜32 文字で、改行などの制御文字を含まない。プロンプト・通知のタイトル・アプリの表示・ダッシュボードの文言・コミットの author 名に使う。
- `spritesheet`・`atlas`（`columns`・`rows`・`cellWidth`・`cellHeight`）・`framesPerSecond`・`animations`（名前→`row`・`frames`）・`expressions`（表情→動作の名前）・`icons`（表情→ファイル）は、今の Mac の `avatar.json` と同じ形である。
- 表情の一覧はサーバーが決める（今の 8 つ）。アバターは素材を出すだけで、一覧に無い表情の素材は使わない。
- アバターの仕様の表情は、サーバーの 8 つに `angry` を足した 9 つとする。`angry` は仕様にはあるが、サーバーの表情の一覧にはまだ無い（今は使われない）。
  - `icons/angry.*`・`slack/angry.png`・`avatar.json` の `icons.angry`・`expressions.angry` を置いてよい。置いても誤りにしない。形が合わなければ、ほかの表情と同じく誤りにする。
  - サーバーの一覧に無いうちは、アプリに配る組に入れず（配る `avatar.json` の `icons`・`expressions` からも除く）、Slack にも使わず、無くても欠けとして埋めない。
    そのため、`angry` を置いても置かなくても版は変わらない。
  - サーバーの表情の一覧とツールの説明は変えない（prefix が動くため）。サーバーが `angry` を使うようにしたとき、配る組に入り、無いアバターは名無しの顔で埋まる。

`pet.json` の `id`・`displayName` とは別に、`avatar.json` の `id`・`name` を持つ。`pet.json` は Codex pet の形のまま、手を入れずに置けるようにする。

`appearance.yaml` の欄:

- `lora`（省略可）: LoRA の名前。確かめる語の先頭に入り、評価はプロンプトに `<lora:<名前>` があるかを見る。
- `body`（必須）: 自分を描くとき、毎回そのまま写す行（LoRA の行・品質の行・体の行・眼鏡などの小物）。
- `outfit`（必須）: 既定の服の行。`outfitName`（省略可）はその呼び名（例「スーツ」）。
- `keep`（省略可）: 服を替えても消してはいけない語。確かめる語と評価に使う。
- `examples`（省略可）: 例。`title`・`outfit`・`scene`（服の後に続く行）。

### 起動を止める誤りと、のっぺらぼうで埋める欠け

**書いてあるものが壊れていれば誤り、無いものは欠け**、を境目にする。

起動を止める誤り（`ConfigError` と同じく、`avatar.id` か `avatar.directory` の名前と理由を出して止まる）:

- ディレクトリが無い、ディレクトリでない。
- `avatar.json` が無い・読めない・JSON のオブジェクトでない。`id` か `name` が無い、形が合わない。
- `avatar.json` に書いた欄の形が合わない（atlas が正の整数でない、`expressions` が無い動作を指す、ファイルのパスがディレクトリの外を指す、画像でない拡張子など）。spritesheet があるのに `atlas` か `animations` が無い。
- `pet.json`・`appearance.yaml`・`sdctl-params.yaml` があるのに、読めない・形が合わない。
- 指したファイルがディレクトリの外に解決される（symlink を含む）。

のっぺらぼうで埋める欠け（起動は続け、埋めたものをログに 1 行ずつ出す）:

- spritesheet が無い（書いていない、書いたファイルが無い）: spritesheet・`atlas`・`framesPerSecond`・`animations`・`expressions` の組をまとめて、のっぺらぼうのものにする。動作の定義は spritesheet と 1 組なので、片方だけを混ぜない。
- 表情のアイコンが無い: その表情だけ、のっぺらぼうのアイコン。
- Slack の PNG が無い: その表情だけ、のっぺらぼうの PNG。

サーバーの既定を使うもの（欠けではない。検査のコマンドは分けて出す）:

- `pet.json` が無い: サーバーが作る。
- `appearance.yaml` が無い: 自分の姿の節は「決まった姿は無い」旨の短い文になる。評価の自分の姿の判定は、決まった姿が無いので行えない。
- `sdctl-params.yaml` が無い: サーバーに含めた既定（今の `anima.yaml`。Anima の汎用の設定）。

のっぺらぼうの素材と既定の params は、組み込みのアバター「名無し」（`assets/avatars/nanashi/`、ID `nanashi`、表示名「名無し」）に置く。

- 名無しは、それ自体が欠けの無い完全なアバターである（`pet.json`・spritesheet・仕様の 9 つの表情（`angry` を含む）のアイコンと Slack の PNG・`sdctl-params.yaml`）。
  `appearance.yaml` は置かない（決まった姿は無い）。検査で埋めるものが無いことをテストで固定する。
- ほかのアバターの欠けは、名無しの素材で埋める。`sdctl-params.yaml` を持たないアバターは、名無しのものを既定として使う。
- `avatar.id` に `nanashi` と書けば、名無しそのものを選べる。
- サーバーの改修で素材が増えたときは、名無しにも足す。既存のアバターにその素材が無くても、ここで埋まる。

### 検査のコマンド

- `natsumi avatar check <ディレクトリか組み込みの ID>` を足す。`/` を含むものはディレクトリ、含まないものは組み込みの ID として読む（手元の相対パスは `./` を付ける）。
  起動時と同じ検査を手元で走らせ、「起動を止める誤り」「のっぺらぼうで埋める欠け」「サーバーの既定を使うもの」を分けて出す。
- 誤りがあれば終了コード 1、無ければ 0。版（下記）も出す。

### アプリへの配り方

- アプリは、`pet.json`・`avatar.json`・spritesheet・表情のアイコンの組を受け取る。サーバーは、欠けを埋めた後の組を、決まった名前で配る。
  - `pet.json`、`avatar.json`（欠けを埋めた後の定義。`id`・`name` と、サーバーの 8 つの表情すべての `icons`。`angry` は含めない）、`spritesheet.<拡張子>`、`icons/<表情>.<拡張子>`。
  - アプリは、どこまでが元のアバターのものかを知らなくてよい。受け取った組は、今の Mac のアバターのディレクトリと同じ形で読める。
- **認証なしで配る**。姿と名前は秘密ではなく、Slack で既に出ている。`appearance.yaml`・`sdctl-params.yaml`・`README.md`・Slack の PNG は配らない。
- `GET /v1/avatar` が一覧を返す: 版・`id`・`name`・ファイルごとのパス・大きさ・SHA-256。
- `GET /v1/avatar/<版>/<パス>` がファイルを返す。版が今のものでなければ 404。版を URL に入れるので、途中で版が変わっても、違う版のファイルが混ざらない。
- 版は、配る組の中身のハッシュ（パスとファイルごとの SHA-256 から作る）。中身が同じなら、どのサーバーでも同じ版になる。

### 版の知らせ方

- `session.snapshot` に `avatarVersion` を入れる。会話が使えないときの `service.unavailable`（`session.sync` への答え）にも入れる。
- アプリは、手元の控えの版と違えば取り直す。
- **接続中に版が変わったことを知らせるイベントは作らない。** サーバーはアバターを起動時に 1 度だけ読み、Slack のアイコン・プロンプト・作業環境へ書き出すものも、その値でそろえる。
  版が変わるのは再起動のとき（config の変更、image の更新、ボリュームの素材の手直し）だけである。再起動で epoch が変わるので、アプリは再接続で必ず snapshot を受け、そこで新しい版を知る。
  プロセスの中で版が変わることが無いので、イベントには送る機会が無い。
- アバターは基本的に切り替えないので、版が変わるのは主に、サーバーの改修（のっぺらぼうの素材が増えた等）と素材の手直しである。

### Slack のアイコン

- 置き場所をアバターのディレクトリの `slack/<表情>.png` にする。URL は今の `<publicOrigin>/avatar/<表情>.png` のまま（ADR 0040）。
- 無ければのっぺらぼうの PNG。サーバーに画像の変換の依存（sharp 等）は足さない。なつみの PNG は今までどおり手で変換したもの。

### 名前の使いどころ

| 使うところ | 使う名前 |
| --- | --- |
| system prompt の冒頭（「あなたはなつみ (natsumi)。」）、compaction の指示 | 表示名と ID を並べる |
| 記憶の整理係の system prompt と、整理係への説明・差し戻しの文 | 表示名 |
| iPhone への通知のタイトル | 表示名 |
| 記憶のコミットの author と committer | 名は表示名、メールは `<ID>@natsumi.invalid` |
| ダッシュボードの文言（「なつみのホーム」など） | 表示名 |
| アプリの表示 | 表示名（アプリの作業で扱う） |

- 製品の名前（コマンド名 `natsumi`、URL scheme、コンテナのユーザーと `/home/natsumi`、ダッシュボードの見出しの `natsumi`）は変えない。
- `/sources` の履歴のコミット（[ADR 0050](0050-telling-of-source-updates-with-one-event.md)）はサーバーの記録なので、今の名前のまま変えない。
- 既定のなつみでも、コミットの author 名は `natsumi` から表示名の「なつみ」に変わる。

### prefix cache と ADR 0019

- 名前と表情の一覧は、session の生成時に system prompt とツールの説明へ 1 度だけ組まれる。走っている session の instructions は変えない。
- 名前は設定から来るが、ADR 0019 が避けたのは、デプロイのたびに勝手に動くものから文面を組むことである。
  アバターは最初に決めたら変えない前提であり、変わるのは本人がアバターを替えたときだけで、そのとき名前が変わるのは意図どおりである。
  コマンドの一覧や image の中身から文面を作らない決まりは残す。
- この変更を反映した後の最初の session は、冒頭の名前の表記と、画像のページのパス（下記）の分だけ prefix cache が効かない。

### 作業環境への渡し方

サーバーが data directory の `avatar/` に書き、作業環境には `/manual/avatar` として読み取り専用で見せる。`/manual/agents` と同じ形である。

- `avatar/images.md`: 画像を作るページ。今の `manual/images.md` を雛形にして、「既定はモデル…、896×1152（縦長）」の行を params から、「あなた自身の姿」の節と確かめる語のコマンドと例を `appearance.yaml` から作る。
  マニュアルは 1 ファイルのまま（ADR 0056 の読ませ方を崩さない）。
- `avatar/sdctl-params.yaml`: アバターの params、無ければサーバーの既定。
- どちらも起動のたびに書き直す（中身を丸ごと置き換える）。
- 雛形はサーバーの image の `assets/manual/images.md` に置き、`manual/` からは外す。`manual/` に残すと、作業環境の image に書き出す前の雛形が載ってしまうからである。
- ページのパスは `/manual/images.md` から `/manual/avatar/images.md` に変わる。目次（`manual/INDEX.md`）・作業環境のコマンドの行・ほかのページの案内をそろえる。
- 作業環境の image:
  - `/etc/sdctl/config.yaml` の `params` は `/manual/avatar/sdctl-params.yaml` を指す。
  - `/etc/sdctl/anima.yaml` は image から外す。既定の params の持ち主はサーバーの 1 か所だけにする。
  - マウント先の `/manual/avatar` を image の中に作っておく（`/manual/agents` と同じ）。
- ディレクトリ単位で重ねる理由:
  - `/manual/images.md` のファイル 1 枚を subPath で差し替えると、起動順によってはディレクトリが作られてしまう。
  - `/manual` を丸ごとサーバーの書いたものに差し替えると、その中に `/manual/agents` を重ねることになり、読み取り専用の中にマウント先を作れない。
  - `/manual/avatar` は image が作ったディレクトリで、ほかのマウントの中ではないので、どちらの落とし穴にも当たらない。
- ダッシュボードの「ファイル」に `/manual/avatar` を足す（[ADR 0054](0054-her-files-on-the-dashboard.md)）。

Kubernetes（fleet-infra）で要る変更:

1. emptyDir `avatar` を足し、サーバーのコンテナに `/data/avatar`、作業環境と sshd に `/manual/avatar`（読み取り専用）でマウントする。`agents` と同じ扱いで、起動のたびに作り直すので永続させない。
2. 足すアバターを使うときだけ: 永続ボリュームのアバターの置き場を、サーバーのコンテナに読み取り専用でマウントし、config の `avatar.directory` で指す。組み込みのアバター（なつみ・名無し）なら `avatar.id` を書くだけでよく、マウントは要らない。
3. この版の作業環境の image は `/etc/sdctl/anima.yaml` を持たないので、1 のマウントが無いと画像を作れない。1 は image の更新と同時に入れる。

compose では `natsumi-data` の subpath `avatar` を作業環境の `/manual/avatar` に読み取り専用で重ねる。

### 素材の置き場

- 組み込みのアバターは `assets/avatars/<id>/` に置く。ディレクトリの名前がその ID で、`avatar.json` の `id` と一致させる。
- なつみの素材は `assets/avatars/natsumi/` に 1 か所にまとめる（`mac/Avatars/natsumi` の `pet.json`・`avatar.json`・spritesheet・アイコンと、`assets/avatar/` の Slack の PNG、`appearance.yaml`）。
- サーバーの image に `assets/avatars/` を入れる。
- アプリの同梱（`mac/Avatars/natsumi`）をなくすのは、アプリの作業で行う。それまでは両方にある。

### 評価の場面

- 評価（[ADR 0051](0051-evaluating-one-turn-on-the-real-path.md)）は、サーバーと同じ道筋で既定のアバターから `images.md` と params を書き、作業環境の `/manual/avatar` に見せる。
- `self-look`・`draw-other` は、LoRA・確かめる語・既定の服を、既定のアバターの `appearance.yaml` から取って判定する。
  判定の名前は、なつみの語に依らないもの（`lora`・`keep`・`look`・`changedOutfit`・`notMe`）にする。

### 置き換える既存の決定

- ADR 0040: Slack のアイコンの置き場所をリポジトリの `assets/avatar/` からアバターのディレクトリの `slack/` に置き換える。URL と、認証なしで配ることは残す。
- ADR 0044: 既定の params を作業環境の image に焼き込む点を置き換える。サーバーが書き、作業環境は `/manual/avatar` で読む。
- ADR 0036・ADR 0056: 画像のページは `manual/` の静的なファイルではなく、サーバーが書くものになる。ほかのページと目次は変わらない。
- ADR 0019: system prompt の冒頭の名前を設定（アバター）から取る。session の生成時に 1 度だけ組むことは残す。

## Consequences

- 本人は、組み込みのアバターを ID で選ぶか、アバターのディレクトリを 1 つ用意して config でパスを指すだけで、プロンプト・通知・Slack・アプリ・画像のページの姿と名前をそろえて変えられる。
- 素材が足りないアバターでも起動する。足りないところは、のっぺらぼうで埋まる。
- なつみの既定のままなら、振る舞いは今と同じである。変わるのは、system prompt の冒頭の名前の表記、画像のページのパス、記憶のコミットの author 名だけ。
- アプリは、サーバーの一覧と版を見て取り直す実装が要る（アプリの作業単位）。版が変わるのは再起動のときだけなので、snapshot の版を見るだけで足りる。
- fleet-infra は、emptyDir の `avatar` を足す変更を、この版の image と同時に入れる必要がある。
- アバターを途中で替えたときの、記憶の中の古い名前や自己認識は扱わない。
- Slack App の表示名は Slack 側の設定で、本人が変える。
