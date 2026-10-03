# アバターの作り方

natsumi の姿と名前は、サーバーの設定で選ぶ「アバター」から決まります（[ADR 0057](adr/0057-an-avatar-directory-named-in-the-server-config.md)）。
この文書は、自分のアバターを作り、検査して、サーバーで使うまでの手順です。

アバターには 2 種類あります。

- **組み込みのアバター**: サーバーの image に含まれていて、ID で選びます。`natsumi`（なつみ。既定）、`iori`（[伊織](../assets/avatars/iori/README.md)）、`myao`（[ミャオ](../assets/avatars/myao/README.md)）、`nanashi`（名無し。顔の無い人形）の 4 つです。
- **足すアバター**: 自分で作ったアバターのディレクトリで、パスで指します。この文書の手順で作るのはこちらです。

組み込みも足すものも、同じ形のディレクトリで、同じ検査を受けます。

アバターのディレクトリ 1 つで、次のものがそろって変わります。

- system prompt の冒頭の名前（「あなたは〇〇 (id)。」）と、記憶の整理係・compaction の指示の中の名前
- iPhone の通知のタイトル、ダッシュボードの文言、記憶のコミットの author
- Mac と iPhone に出る姿（spritesheet と表情のアイコン）と名前。アプリはサーバーから受け取ります
- Slack に投稿するときのアイコン
- 自分を描くときのプロンプト（作業環境の `/manual/avatar/images.md` の「あなた自身の姿」）と、画像生成の既定の設定
- 性格・話し方の初期値（記憶に `personality.md` がまだ無いときだけ。[ADR 0060](adr/0060-a-personality-to-start-from-in-the-avatar.md)）

アバターは、最初に決めたらそのまま使う前提です。途中で替えても動きますが、記憶の中の古い名前や自己認識は書き換わりません（記憶はアバターごとに分けていません）。
性格も入れ替わりません。記憶の `personality.md` は夜に natsumi 自身が育てるもので、すでにあればアバターの `personality.md` で上書きしません。

## ディレクトリの構成

例として、既定のなつみ（[assets/avatars/natsumi/](../assets/avatars/natsumi/)）を見ながら読んでください。

| ファイル | 要否 | 中身 |
| --- | --- | --- |
| `avatar.json` | 必須 | ID と表示名、spritesheet の区切り方、表情と動作の対応、表情のアイコンの場所 |
| `pet.json` | 省略可 | Codex のペットの定義。そのままアプリに渡します。無ければサーバーが ID・表示名・spritesheet の場所だけのものを作ります |
| `spritesheet.webp` | 省略可 | 動作ごとのフレームを並べた画像（PNG も可）。名前は `avatar.json` で決めます |
| `icons/<表情>.webp` | 省略可 | 表情ごとの顔（PNG も可）。アプリの会話の履歴で、セリフの横に出ます |
| `slack/<表情>.png` | 省略可 | Slack のアイコン。PNG で、名前は表情のとおりにします |
| `appearance.yaml` | 省略可 | 自分を描くときのプロンプト |
| `sdctl-params.yaml` | 省略可 | 画像生成の既定の設定（sdctl の params） |
| `personality.md` | 省略可 | 性格・話し方の初期値（Markdown）。記憶に `personality.md` が無いときだけ、そのまま写します。アプリには渡しません |
| `README.md` | 推奨 | ライセンスと出どころ。サーバーは読みません |

表情は、次の 9 つです: `neutral`・`happy`・`laughing`・`surprised`・`thinking`・`worried`・`sad`・`sleepy`・`angry`。

- `angry` は仕様にはありますが、サーバーの表情の一覧にはまだありません。今は使われません。
  `icons/angry.*`・`slack/angry.png`・`avatar.json` の `icons.angry`・`expressions.angry` は置いてかまいません。置いても誤りにはならず、無くても埋められません。
  サーバーが `angry` を使うようになれば、そのまま使われます（無ければ名無しの顔で埋まります）。先に用意しておくと、後で作り直さずに済みます。
- これ以外の表情の素材を置いても使われません。

### 足りないもの、壊れているもの

- **書いてあるのに壊れているものがあると、サーバーは起動しません。** 設定の誤りとして、`avatar.directory`（組み込みなら `avatar.id`）の名前と理由をログに出して止まります。
  たとえば、ディレクトリが無い、`avatar.json` が無い・JSON として読めない、`id` か `name` が無い、`avatar.json` の欄の形が合わない、
  ファイルの場所がディレクトリの外を指す（symlink を含む）、`appearance.yaml` や `sdctl-params.yaml` が YAML として読めない、`personality.md` が空、などです。
- **無いものは、名無し（`nanashi`）の、のっぺらぼうの素材で埋めて起動します。** なつみの素材では埋めません。
  - spritesheet が無ければ、spritesheet と動作の定義をまとめて、のっぺらぼうのものにします（顔の無い人形が 1 コマだけ）。
  - 表情のアイコンや Slack の PNG が無ければ、その表情だけ、のっぺらぼうの顔にします。
  - 埋めたものは、起動のたびにログに 1 行ずつ出ます。
- **無くてもサーバーの既定を使うもの**もあります。`pet.json`（サーバーが作る）、`appearance.yaml`（自分の姿の節が「決まった姿は無い」旨になる）、
  `sdctl-params.yaml`（名無しの持つサーバーの既定の、Anima の汎用の設定）、
  `personality.md`（記憶の `personality.md` を、表示名だけが入った固定の枠で始める）です。

サーバーの改修で素材の種類が増えたときも、足りない分はのっぺらぼうの素材で埋まります。

## avatar.json

| 欄 | 要否 | 中身 |
| --- | --- | --- |
| `id` | 必須 | 英小文字で始まり、英小文字・数字・`-` だけの 32 文字まで。例 `natsumi`。記憶のコミットのメール（`<id>@natsumi.invalid`）、アプリの控えの置き場所、ログに使います |
| `name` | 必須 | 表示名。1〜32 文字で、改行を含まない。例「なつみ」。プロンプトでは「なつみ (natsumi)」のように ID と並べます |
| `spritesheet` | 省略可 | spritesheet のファイル（ディレクトリの中の相対パス。WebP か PNG） |
| `atlas` | spritesheet があれば必須 | `columns`（列の数）・`rows`（行の数）・`cellWidth`・`cellHeight`（1 コマの幅と高さ）。どれも正の整数 |
| `framesPerSecond` | 省略可 | 1 秒に進めるコマの数 |
| `animations` | spritesheet があれば必須 | 動作の名前ごとに、`row`（何行目か。0 から）と `frames`（コマの数） |
| `expressions` | 省略可 | 表情ごとに、使う動作の名前。`animations` に無い名前は書けません |
| `icons` | 省略可 | 表情ごとに、顔のアイコンのファイル（ディレクトリの中の相対パス。WebP か PNG） |

`pet.json` の `id`・`displayName` とは別に、`avatar.json` の `id`・`name` を使います。`pet.json` は Codex のペットの形のまま置けます。

動作の名前は、アプリが知っているものを使います。`idle`（立ち止まり）、`running-right`・`running-left`（左右への移動）、`running`（向きの無い移動）、
`waving`・`jumping`・`failed`・`waiting`・`review` などです。移動の動作が無ければ、アプリは表情の動作のまま動かします。

## 作り方

なつみは次の順で作りました。出どころは [assets/avatars/natsumi/README.md](../assets/avatars/natsumi/README.md) にあります。

### 1. 参照画像を作る

キャラクターの全身が分かる参照画像を 1 枚作ります。なつみは、画像生成モデルの Anima で作りました。
後の手順で何度も渡すので、顔・髪・服がはっきり見えるものにします。

### 2. ペットの spritesheet を作る

参照画像をもとに、動作ごとのフレームを並べた spritesheet を作ります。
ChatGPT の画像生成や、Codex のペットを作る機能（hatch-pet）に参照画像を渡し、Codex のペットの形式で作らせます。

- 1 コマは同じ大きさにそろえ、背景は透明にします。なつみは 1 コマ 192×208、8 列 × 11 行です。
- 1 行に 1 つの動作を並べます。なつみの行は、上から `idle`（6 コマ）、`running-right`（8）、`running-left`（8）、`waving`（4）、`jumping`（5）、
  `failed`（8）、`waiting`（6）、`running`（6）、`review`（6）です。
- できた画像を `spritesheet.webp` として置き、行とコマの数を `avatar.json` の `atlas` と `animations` に書きます。
- 表情ごとに見せる動作を `expressions` に書きます。なつみは、`neutral` と `sleepy` が `idle`、`thinking` が `review`、`happy` が `waving`、
  `laughing` と `surprised` が `jumping`、`worried` が `waiting`、`sad` が `failed` です。

生成した spritesheet は、コマの位置が少しずれていることがあります。アプリで動かして確かめ、ずれていれば画像を直します。

### 3. 表情のアイコンを作る

9 つの表情（`angry` を含む）それぞれの顔を、正方形の画像で作ります。なつみは 512×512 の WebP です。
参照画像を渡し、「同じキャラクターの、〇〇の表情の顔のアップ」のように 1 枚ずつ作らせると、顔がそろいやすくなります。
`icons/<表情>.webp` として置き、`avatar.json` の `icons` に並べます。

### 4. Slack 用の PNG に変換する

Slack のアイコンには PNG を使います。サーバーは画像を変換しないので、手で変換して置きます。

- 表情のアイコンを 1 枚ずつ開き、背景の無い RGB にして 256×256 に縮め、PNG で保存します。
  なつみは Python の Pillow で変換しました。画像編集のアプリで書き出しても構いません。
- `slack/<表情>.png` として、9 つの表情（`angry` を含む）すべてを置きます。
- 表情のアイコンを差し替えたら、こちらも作り直します。

### 5. 自分の姿の LoRA とタグを決める

natsumi は、自分が入る絵（自撮り、気分の絵、ほかの人と並ぶ絵）を描くとき、決まったプロンプトを先頭に置きます。
それを `appearance.yaml` に書きます。サーバーは起動のたびに、これを作業環境の `/manual/avatar/images.md` の「あなた自身の姿」に差し込みます。
`appearance.yaml` はアプリにも作業環境にもそのままは渡しません。

| 欄 | 要否 | 中身 |
| --- | --- | --- |
| `lora` | 省略可 | キャラクターの LoRA の名前（例 `kutara_aki_anima.v3`）。描く前に確かめる語の先頭に入ります |
| `body` | 必須 | 毎回そのまま写す行。LoRA の行、品質の行、体の特徴の行、眼鏡のような小物の行を、改行も含めて書きます |
| `outfit` | 必須 | 既定の服の行 |
| `outfitName` | 省略可 | 既定の服の呼び名（例「スーツ」）。「指定が無ければスーツです」の文に入ります |
| `keep` | 省略可 | 服を替えても消してはいけない語（例 `freckles`）。描く前に確かめる語と、評価の判定に使います |
| `examples` | 省略可 | 例。1 つごとに `title`（例の名前）、`outfit`（その例の服）、`scene`（服の後に続く行） |

- 体の行は、服を替えても場面を文で書いても、毎回そのまま写すものです。服の行だけを頼まれた服や場面に合わせて替えます。
- 描く前に確かめるコマンドは、`lora` と `keep` の語から作られます。どれも、描いたプロンプトに文字どおり入る語にします。
- 書いたら、`natsumi avatar check` の後にサーバーを起動し、`/manual/avatar/images.md` を読んで確かめます（ダッシュボードの「ファイル」でも見られます）。

### 6. 画像生成の設定を決める

画像生成の既定を変えたいときだけ、`sdctl-params.yaml` を置きます。
中身は sdctl の params の YAML で、サーバーの既定（名無しの [assets/avatars/nanashi/sdctl-params.yaml](../assets/avatars/nanashi/sdctl-params.yaml)）が見本です。

- モデルとモジュールは、生成ごとの `override_settings` で指定します（中継が WebUI の設定の変更を通さないため）。
- WebUI の拡張（always-on script）の設定は `alwayson_scripts` に書きます。txt2img・img2img・hires の要求にそのまま渡ります（例: ADetailer で顔を描き直す。拡張は WebUI 側に入っている必要があります）。
- `prompt` は書きません。プロンプトは natsumi が毎回書くものです。
- `/manual/avatar/images.md` の「既定はモデル…、896×1152（縦長）」の行は、この `override_settings.sd_model_checkpoint`・`width`・`height` から作られます。

### 7. 性格・話し方の初期値を書く（任意）

natsumi が最初に持つ性格と話し方を決めたいときだけ、`personality.md` を置きます。中身は自由な Markdown で、見出しは記憶の枠にそろえて `# 性格・話し方` にすると読みやすくなります。

- 使われるのは、記憶のリポジトリに `personality.md` がまだ無いときだけです（初回の起動、または手で消したあと）。サーバーはそのまま写してコミットします。
- 記憶にすでに `personality.md` があれば、何もしません。アバターを替えても、書き直しても、記憶の性格は変わりません。
  育った性格を捨ててアバターの初期値からやり直したいときは、記憶のリポジトリの `personality.md` を消してからサーバーを再起動します。
- 写したあとは記憶の一部です。夜の再構成で natsumi が書き換え、日中の変更は戻されます（[ADR 0018](adr/0018-memory-in-git-and-the-nightly-rebuild.md)）。記憶のファイルの長さの上限（`loop.memoryFileMaxChars`）に収めます。
- 置かなければ、「〇〇の性格と話し方をここに書きます。」（〇〇は表示名）という枠で始まります。

### 8. 検査する

置いたら、サーバーの起動と同じ検査を手元で走らせます。

サーバーと同じ版の image かチェックアウトで、`natsumi avatar check <ディレクトリ>` を実行します。
`/` を含まない名前は組み込みのアバターの ID として読みます（例 `natsumi avatar check nanashi`）。手元の相対パスは `./hana` のように `./` を付けます。

- image なら、サーバーの image の ENTRYPOINT に `avatar check <ディレクトリ>` を渡します（ディレクトリはコンテナにマウントし、コンテナの中のパスを書きます）。
- チェックアウトなら、`node src/server/main.ts avatar check <ディレクトリ>` です。

結果は次のように読みます。

- 結果は 3 つに分けて出ます。「起動を止める誤り」「のっぺらぼうで埋めるもの」「サーバーの既定を使うもの」です。
- 誤りがあれば終了コードは 1 で、サーバーは起動しません。直してもう一度走らせます。
- 誤りが無ければ、ID・表示名と、アプリに配る組の版が出ます。

## サーバーで使う

1. アバターのディレクトリを、サーバーから読める場所に置きます。
   - Kubernetes では、永続ボリュームの別の場所（例 `avatars/<id>`）に置き、サーバーのコンテナにだけ読み取り専用でマウントします（例 `/var/lib/natsumi-avatars`）。
     作業環境のコンテナには見せません。素材は 2MB ほどあり、ConfigMap（1MiB まで）には入りません。
   - compose やチェックアウトから動かすときは、手元のディレクトリをサーバーのコンテナに読み取り専用で bind します。
2. 設定ファイルの `avatar.directory` に、コンテナの中から見た絶対パスを書きます（例 `/var/lib/natsumi-avatars/hana`）。
   組み込みのアバターを使うなら、代わりに `avatar.id` に ID を書きます（例 `nanashi`）。この場合、1 の置き場所は要りません。
   `avatar.id` と `avatar.directory` はどちらか一方だけを書きます。`avatar` を省略すると、組み込みのなつみを使います。
   姿だけを替えたいときは、`avatar.appearance` に別の `appearance.yaml` の絶対パスを書きます（例 `/etc/natsumi/appearance.yaml`）。
   アバターの `appearance.yaml` を混ぜずに丸ごと置き換えます。組み込みのアバターを、眼鏡やスーツの衣装違いで使うときなどに使います。
   検査はアバターの `appearance.yaml` と同じで、無い・壊れていると起動しません。ConfigMap でマウントしたもの（symlink）もそのまま読めます。
   画像生成の設定だけを替えたいときは、`avatar.sdctlParams` に別の `sdctl-params.yaml` の絶対パスを書きます（例 `/etc/natsumi/sdctl-params.yaml`）。
   アバターの `sdctl-params.yaml`（無ければサーバーの既定）を混ぜずに丸ごと置き換え、`/manual/avatar/sdctl-params.yaml` と `images.md` の既定の行に使います。
   モデルや LoRA を、image を作り直さずに替えるときなどに使います。`avatar.appearance` と併せて書けます。
   検査はアバターの `sdctl-params.yaml` と同じで、無い・壊れていると起動しません。ConfigMap でマウントしたもの（symlink）もそのまま読めます。
3. サーバーを再起動します。アバターは起動時に 1 度だけ読みます。素材を直したときも、再起動で反映します。
4. 起動のログに `avatar: <id> (<表示名>), version <版>` と、埋めたものが出ることを確かめます。
5. アプリは、再接続したときに版が変わったことを知り、新しいアバターを取り直します。

Slack App の表示名（投稿に出る名前）は Slack 側の設定なので、Slack App の設定画面で変えます。

## ライセンスと出どころ

アバターのディレクトリに `README.md` を置き、次のことを書きます。

- 各ファイルが何か（この文書の表を写して、自分のアバターに合わせて直せば足ります）。
- ライセンス。リポジトリのコード（MIT）とは別に決めます。なつみは CC BY 4.0 です。
- 出どころ。どの画像を何で作ったか（生成に使ったモデルやサービス、元にした画像）。
  なつみは「参照画像は Anima で生成、spritesheet と表情のアイコンは参照画像をもとに OpenAI の画像生成で作成、Slack の PNG は表情のアイコンを変換」と書いています。
- LoRA を使うなら、その LoRA の配布元と利用条件。

生成サービスや LoRA の利用条件で、商用や再配布に制限があることがあります。公開するアバターなら、条件を確かめてから書きます。
