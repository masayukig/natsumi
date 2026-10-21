# 0079. 依存の更新は Renovate に追わせ、公開から 7 日経った版だけを受け取る

- Date: 2026-10-16
- Status: Accepted（2026-10-21: パッチ等の自動マージと、Renovate だけの変更の週次のリリースを「追記」の節に加えた）

## Context

このリポジトリは、依存の版をすべて固定している。npm の依存は `package.json` に版をそのまま書き、`package-lock.json` で固める。
Pi は `@earendil-works/pi-coding-agent` と、その土台の `@earendil-works/pi-ai` を npm の依存として固定している。
Node は Dockerfile の 3 つの stage のベース（`node:<版>-bookworm-slim`）と、ci.yml・images.yml の setup-node の両方に同じ版で書いている。
作業環境の image の材料として、Go の image（`golang:1.27`）で runner を作り、sdctl を版を付けて `go install` で作る（[ADR 0044](0044-drawing-with-sdctl-and-posting-images.md)）。
作業環境そのものは `debian:bookworm-slim` に apt で入れている（[ADR 0019](0019-a-workspace-not-a-memory-tool.md)）。

固定は、放っておくと古くなる。上げ続ける人がいなければ、いずれ脆弱性の直った版にも、Pi の新しい版にも届かない。
手で上げるなら「そろそろ上げる」と思い出す人が要る。

一方で、公開された直後の版は、取り下げられたり、数日のうちに直しの版が出たりする。乗っ取られた公開元から悪い版が出る場合も、
気づかれて消されるまでの数日がいちばん危ない。新しい版をすぐに受け取ることは、この期間をそのまま引き受けることになる。

本人は fraction-agents で、同じ Node と TypeScript の構成に Renovate を入れている（fraction-agents の ADR 0018）。
`config:recommended` を土台にし、規則ごとに理由を書く形である。

## Decision

### 更新の担い手を Renovate にする

依存の更新は Renovate に任せる。設定はリポジトリ直下の `renovate.json` に置き、fraction-agents に揃えて `config:recommended` を土台にする。
コミットの種類は `chore` にそろえる。時刻は `Asia/Tokyo`、Dependency Dashboard を使う。規則と custom manager には、なぜそうするのかを `description` に書く。

### 公開から 7 日経った版だけを受け取る

全体に `minimumReleaseAge` を 7 日で効かせる。7 日経っていない版は、branch も PR も作らない（`internalChecksFilter` を `strict` にする）。
`strict` は Renovate の既定だが、待ちが「PR の状態の検査」ではなく「branch と PR そのものを出さないこと」であると設定から読めるように書いておく。

`strict` では、7 日経った版の中でいちばん新しいものを提案する。待っている間に次の版が出ても、PR が出ないまま待ち続けるのではなく、
7 日経った手前の版が届く。7 日経った版が 1 つもなければ、Dependency Dashboard に保留として載る。

公開の時刻が取れない版は、7 日経ったかを判断できないので保留のままになる（Renovate の既定）。

### Node は Docker のタグではなく Node の版として読む

テストを通った Node と image の Node は同じでなければ意味がないので、Dockerfile の 3 か所と setup-node の 2 か所を 1 つのグループ `node` にして、1 つの PR で上げる。

Dockerfile の image のタグを Docker の image として読むと、7 日の待ちが正しく働かない。
Docker のタグの時刻は、そのタグが最後に push された時刻であり、Node が出た時刻ではない。同じタグが Debian の層の焼き直しのたびに push し直される。
Docker Hub が時刻を返さないこともあり、そのときは保留のまま動かない。
同じグループの setup-node の側は Node の版の時刻で 7 日を数えるので、image の側だけが取り残され、グループにした意味がなくなる。

そこで Dockerfile の Node は custom manager で版の部分だけを読み、Node の版の一覧（setup-node と同じ datasource）で追う。
タグの `-bookworm-slim` の部分は書かれたまま残る。Dockerfile の標準の manager が同じ Node を二重に提案しないよう、そちらの Node は無効にする。
こうすると 5 か所とも同じ時刻で 7 日を数え、同じ日に同じ版が届く。

Node の major は、Renovate の Node の版の扱いに従い、LTS になった版だけが届く。

### `@types/node` の major は Node と一緒に手で上げる

`@types/node` は、コードが動く Node の型である。その major は Node の major に対応するが、Node が LTS になるより先に出る。
これを先に上げると、image の Node に無い API を型検査が通してしまう。`@types/node` の major は Renovate に出させず、`node` のグループの major を受け取るときに手で合わせる。
minor と patch は Renovate に任せる。

### Pi の 2 つのパッケージは 1 つの PR で上げる

`@earendil-works/pi-coding-agent` は `@earendil-works/pi-ai` に依存し、なつみは両方を直接 import する。2 つは同じ版で揃って出る。
別々の PR にすると、片方だけ上がった間は `pi-ai` が 2 つ入る。2 つをグループ `pi` にして、1 つの PR で上げる。

### typebox は Pi に合わせて手で上げる

なつみが Pi に渡す道具の引数の形は typebox で書いており、Pi のパッケージは typebox を 1 つの版に固定している。
なつみの側だけを上げると、Pi の typebox の隣に別の版の typebox が入る。typebox は Renovate に出させず、
`pi` のグループの PR で Pi の固定する版が変わったときに、その版に手で合わせる。

### sdctl は custom manager で追う

sdctl はリリースにバイナリが無いので、Dockerfile の中で版を付けて `go install` で作っている（[ADR 0044](0044-drawing-with-sdctl-and-posting-images.md)）。
標準の manager は `go install` の行の版を読まない。custom manager で、その版を Go の module の版として追う。

### 自分の image のタグは動かさない

`ghcr.io/yuanying/natsumi` と `ghcr.io/yuanying/natsumi-workspace` は、このリポジトリ自身の image である。
動かす版は環境の設定の側で固定する（[ADR 0033](0033-running-on-kubernetes.md)）。タグを動かすのは、その設定を持つリポジトリの Renovate の役目である。
いまの compose ファイルは checkout から `build` するローカルのタグ（`natsumi:local` など）を書いており、Renovate は読み飛ばす。
将来、版の付いたタグが書かれても動かさないように、規則で無効にしておく。

### PR の数を抑える

GitHub Actions は 1 つのグループにまとめる。どれも同じ見方で確かめるもので、1 つずつ届けても PR の数が増えるだけである。
`config:recommended` の既定どおり、major は minor・patch と別の PR になる。setup-node の Node は Actions のグループではなく `node` のグループに入る。

### 追わないもの

- Dockerfile と CI が apt で入れるパッケージ（git、ripgrep、poppler-utils、bubblewrap など）は版を書いていない。Debian と Ubuntu の配布に任せ、image の再ビルドで新しくなる。
- `debian:bookworm-slim` は Debian の版の名前で、Renovate は版として読まない。Debian の次の版に移るときは、apt で入れるものと一緒に手で確かめて上げる。
- `package.json` の `engines` の Node と、`runner/go.mod` の `go` の行は下限なので、Renovate は書き換えない。上げる理由があるときに手で上げる。
- iPhone のワークフローの Xcode（`xcode-27` の runner と `DEVELOPER_DIR`）は Renovate が読まない。Mac と iPhone のアプリに Swift Package の依存は無い。

## Consequences

固定した依存が古びていくことに、人の記憶以外の歯止めがかかる。届いた PR は ci.yml のテストとブラウザの試験が確かめる。
image のビルドは版の tag を打つまで走らないので、Dockerfile だけにかかわる更新（`golang` の image や sdctl）は、tag の前に手元か CI で image を作って確かめる。

新しい版は、最短でも公開から 7 日遅れて届く。公開直後に取り下げられた版や悪い版は、その間に消えていれば届かない。
代わりに、急いで受け取りたい直し（脆弱性の修正など）も 7 日待つ。待てないときは手で上げる。

Node は image とテストで同じ版のまま上がる。その代わり、Dockerfile の Node のタグの付け方（`node:<版>-<変種>`）を変えるときは、custom manager の読み方も合わせて変える必要がある。
読めなくなっても Renovate は何も言わずに Dockerfile の Node を追わなくなるだけなので、Dependency Dashboard の一覧に Dockerfile の Node が載っているかで確かめる。
sdctl の `go install` の書き方を変えるときも同じである。

`golang` の image は Docker のタグのまま追う。Node と違って合わせる相手がいないためだが、タグの時刻が取れずに Dependency Dashboard で保留のまま動かなければ、Node と同じように Go の版として読む形に変える。

typebox は Renovate が知らせないので、`pi` の PR を受け取るときに、lock で Pi の typebox の版が変わっていないかを見る必要がある。

Renovate の設定はこのリポジトリにあるが、Renovate 自体はここにない。構文は `renovate-config-validator` で確かめられ、
何が拾われるかは手元で Renovate を `--platform=local` で動かせば確かめられる。それでも、実際に何が届くかは PR が届くまで分からない。

## 追記（2026-10-21）: パッチ等は CI が通れば Renovate がマージし、Renovate だけの変更は週に一度リリースする

### 自動マージ

- patch・digest・pin・pinDigest の更新は、PR の CI が通ったら Renovate 自身がマージする（`automerge`）。minor と major は今までどおり PR が開くだけ。
- `platformAutomerge` は切る。GitHub の auto-merge の許可や branch protection に頼らず、Renovate がチェックの通過を待ってマージする。
- `ci.yml` は `pull_request` を絞り込まずに動くので、Renovate の PR はどれも CI を通ってからマージされる。

### PR での image の build

- Consequences に「image のビルドは版の tag を打つまで走らない」と書いたが、PR の CI はすでに image を作っている。
  `npm test` に含まれる `test/image.test.ts` が、docker のある環境（GitHub の runner）で server と workspace の 2 つの image を build し、起動して確かめる。
- そのため Dockerfile だけにかかわる更新（`golang` の image や sdctl の版）も、自動マージの前に image が作られる。push はしない。

### 週に一度のリリース

- 毎週月曜 9 時（JST）に `weekly-release.yml` が判定する（`scripts/weekly-release.ts`）。判定の材料は、最後の `vX.Y.Z` タグから `main` の HEAD までの、マージ以外のコミットである。
- 次の 2 つを両方満たすときだけ、パッチ版を 1 つ上げてリリースする。満たさなければ何もせず、理由をログに残す。
  - そのコミットの作者がすべて `renovate[bot]` である。
  - image に入るファイルが変わっている。`.github/`・`renovate.json`・`mac/`・`docs/`・`test/` だけの変更は数えない。
- 人のコミットが 1 つでも入っていれば、手のリリースに任せる。手で打つタグには変更の中身を書いているので、人の変更を「依存の更新」として出さないためである。
  したがって、人の変更のあとは、次に手でリリースするまで自動のリリースは出ない。
- 自動のタグも、手のタグと同じく注釈つきにする。メッセージは「依存の更新」であることと、含まれる Renovate のコミットの subject の一覧である。
- `GITHUB_TOKEN` で push したタグでは `images.yml` が動かない。そこで同じ run の中で `images.yml` を呼び、image を push してからタグを push する。
  image の push に失敗したときは、タグは残らない。手でタグを push したときは、今までどおり `images.yml` が動く。

## 関連 ADR

- [ADR 0019](0019-a-workspace-not-a-memory-tool.md) — 作業環境の image を Debian に apt で作ること
- [ADR 0033](0033-running-on-kubernetes.md) — 動かす版は環境の設定で固定すること。自分の image を Renovate で動かさない理由
- [ADR 0044](0044-drawing-with-sdctl-and-posting-images.md) — sdctl を版を付けてソースから作ること。custom manager で追う理由
