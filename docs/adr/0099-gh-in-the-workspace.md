# 0099. 作業環境に GitHub の CLI の gh を入れ、token は image に持たせない

- Date: 2026-11-13
- Status: Accepted

## Context

なつみは、作業環境から GitHub を使う。pull request とその差分・コミット・リリースを読み、レビューを書き、pull request を出してマージする。
今の作業環境には GitHub の CLI の `gh` が無い。GitHub の操作は、手書きの `curl` か、インスタンスが config で宣言したツール（[ADR 0075](0075-tools-declared-in-the-config.md)）で行っている。

- ADR 0085 は `gh` を入れないと決めた。GitHub の API を loopback の中継に平文の HTTP で呼ぶ形だったので、`curl` で足りたためである。
  関所を選んだインスタンスでは、作業環境の道具は本物の URL に話す（[ADR 0095](0095-letting-her-act-and-noticing-quickly.md)）。`gh` が話す先（`api.github.com`）にそのまま届く。
- `curl` で書くと、なつみは REST のパス・ページ送り・JSON の組み立てを毎回自分で書く。宣言したツールは、1 つごとに説明が全員の prefix に載る。
  `gh` はベースモデルがよく知っている道具で、どちらにも頼らずに済む。本人は、ベースモデルの知っている道具で済ませ、宣言したツールを増やさない方針である。
- 作業環境の image は、全インスタンスに共通である（ADR 0085、[ADR 0088](0088-ruby-sops-and-go-in-the-workspace.md)）。
- runner は、コマンドに `PATH`・`PWD`・`HOME`・`LANG`・`TZ` しか渡さない（[ADR 0019](0019-a-workspace-not-a-memory-tool.md)）。image に書いた環境変数は届かない。`HOME` は mount で、image の中身は隠れる。
- `gh` は、既定で、コマンドを打つたびに使い方の telemetry を GitHub へ送る。端末につながっていない実行（`run_shell` の形）でも送る。
  止めるには、環境変数（`GH_TELEMETRY`・`DO_NOT_TRACK`）か、`HOME` の下の `gh` の設定で切る。また、1 日に 1 度、新しい版が出ていないかを確かめる。

## Decision

### 全員の作業環境の image に `gh` を入れる

- ADR 0085 の `kubectl`、ADR 0088 の `sops` と同じく、全員の作業環境の image に入れる。
  外向きが閉じたインスタンスでは、入っていてもどこにもつながらない。選んだインスタンスにだけ届ける形は、配置の仕組みを増やすだけで守りを強めない。
- 入れるのは `gh` の本体だけである。拡張（`gh extension`）は image に入れない。

### 公開の配布物から、版を固定し、検査値で確かめて入れる

- Debian の package ではなく、GitHub の CLI の GitHub のリリースから、版を固定して取る。`sops` と同じく、一緒に公開されているチェックサムで確かめる。
  Debian trixie の package は 2.46 で止まっており、GitHub の API と `gh` の変化に追いつかない。
- amd64・arm64 の両方に対応する。今の image と同じく、build する arch のものを取る。
- 版は Dockerfile に書き、Renovate が cli/cli のリリースとして上げる。ほかの依存と同じく、公開から日の経った版だけを受け取る（[ADR 0079](0079-dependency-updates-with-renovate.md)）。

### token は image に持たせず、使う側が渡す

- image には token も設定も入れない。`gh` は、コマンドの行で付けた環境変数 `GH_TOKEN` か、`HOME` の下の自分の設定ファイル（`gh auth login --with-token` で書くもの）から token を受ける。
- どちらを使うか、何の token を渡すかは、使うインスタンスの手引き（`/manual`、[ADR 0036](0036-a-manual-to-read-and-a-limit-on-waiting.md)）が決める。
  関所を選んだインスタンスでは、渡すのは鍵ではなくサロゲートである。本物の鍵への差し替えと、操作ごとに通すかは関所が決める（ADR 0095）。
- 作業環境に渡る環境変数は限られている、という ADR 0019 の決まりは変えない。`gh` のために runner が渡す環境変数を増やさない。
- token が無ければ、`gh` はログインを求めて止まる。鍵を持たない側に倒れる。

### `gh` が自分から送る telemetry と版の確かめは、既定で切る

- 作業環境から外へ出るのは、なつみが打ったコマンドの用だけにする。`gh` の使い方の記録を GitHub へ送らない。
  関所を選んだインスタンスでは、送れば、なつみの打っていない要求が関所の記録に混ざる。
- runner は環境変数を渡さず、`HOME` の下の設定は image から置けない。そこで、PATH の `gh` を、telemetry と新しい版の知らせを切って本物を動かすラッパーにする（ADR 0088 の `bundle` と同じ形）。
  版は image が固定しているので、新しい版の知らせはなつみが動けることではない。
- コマンドの行で `GH_TELEMETRY` などを付ければ、そちらが勝つ。

### 手引きとプロンプトは変えない

- `run_shell` の説明と、プロンプトの「作業環境だけのコマンド」（[ADR 0056](0056-the-manual-index-and-the-workspace-commands-in-the-prompt.md)）には足さない。
  `gh` は普通の道具で、使うのは GitHub を扱うインスタンスである。足せば全員の prefix が変わる（ADR 0085・0088 と同じ判断）。
- 使い方（token の渡し方、宛先）は、使うインスタンスの `/manual` の手引きで知らせる。

### 本 ADR で決定しないこと

- インスタンスごとの token の種類・権限と、その渡し方（委譲先: 各インスタンスの環境の設定と `/manual` の手引き）。
- 関所が GitHub への操作ごとに通すか・聞くか・断るか（委譲先: natsumi-sentinel の ADR と関所の表）。
- 宣言した GitHub のツールを外すかどうか（委譲先: 各インスタンスの環境の設定。ツールの宣言は ADR 0075 で環境の設定の側にある）。

### 置き換える既存の決定

- ADR-0085 の「実装で決めたこと（2026-10-30）」の「`gh` は入れない」を置き換える。ほかのコマンドを全員の image に入れることは変わらない。

## Consequences

- なつみは、GitHub の操作を、ベースモデルの知っている `gh` の形で書ける。REST のパスやページ送りを自分で組み立てずに済む。
- 作業環境の image が `gh` の分（本体で約 40 MB）大きくなる。
- `gh` の修正は、Renovate の pull request を取り込み、image を出し直すまで入らない。`gh` が自分で新しい版を取りに行くことはない。
- token を `HOME` の下の設定に書けば、`HOME` が永続するので残る。なつみもその中身を読める。鍵を置くなら、なつみに見せてよいものに限ることを、使う側が受け持つ。
- `gh` の telemetry と版の知らせは、ラッパーを通らない呼び方（本物を直接動かすなど）では切れない。
- `gh` は、`HOME` の下に書けなくても動く。設定やキャッシュを残したいときだけ `HOME` に書く。
- runner が渡す環境変数を増やさないので、`gh` の挙動を変える環境変数（プロキシなど）は、コマンドの行で付けるか、`gh` の設定に書く。

## Alternatives Considered

- **入れずに `curl` と宣言したツールのままにする**: 手書きの `curl` はなつみが毎回組み立てる分だけ間違え、宣言したツールは全員の prefix を太らせる。本人の方針に合わない。
- **Debian の package を入れる**: apt が署名で確かめる利点はあるが、trixie の版は古いまま止まる。公開のチェックサムで確かめられるので、`sops` と同じく公開の配布物を取る。
- **telemetry を切らずに入れる**: 作業環境から、なつみの打っていない外への送信が毎回出る。関所の記録を濁し、外向きの閉じたインスタンスでは届かない要求を出し続ける。

## Related ADRs

- Related: ADR-0085 作業環境から鍵の要る API とノードへ、鍵を見せずに中継で出る（「実装で決めたこと（2026-10-30）」の `gh` を入れない決定を置き換える）
- Related: ADR-0088 作業環境に Ruby・sops・age・Go を入れる（入れ方、PATH のラッパーの形）
- Related: ADR-0019 記憶の道具をやめ、なつみの作業環境にする（Decision の「環境変数」。runner が渡す環境変数は変えない）
- Related: ADR-0095 なつみは自由に動かし、守りは「防ぐ」より「すぐ気づく」に寄せる（関所、サロゲート）
- Related: ADR-0075 インスタンスに特有のツールを config で宣言する（宣言したツール）
- Related: ADR-0079 依存の更新は Renovate に追わせ、公開から 7 日経った版だけを受け取る（版の更新）
- Related: ADR-0036 読み取り専用のマニュアルと、返事を待ち続ける上限（手引き）
- Related: ADR-0056 マニュアルの目次と作業環境のコマンドを system prompt に置く（プロンプトに足さない判断）

## References

- GitHub CLI のリリース（`https://github.com/cli/cli/releases`）。linux の amd64・arm64 の tar.gz と、それらの sha256 を並べた `checksums.txt` があること、2026-11-13 確認
- Debian trixie の `gh` の package の版（`apt-cache policy gh` で 2.46.0-3）、2026-11-13 確認
- `gh` v2.103.3 を token 無しで `gh api user` と動かすと、`gh auth login` か `GH_TOKEN` を求めて終了コード 4 で止まること、2026-11-13 確認
- `gh help environment`（v2.103.3）の `GH_TOKEN`・`GH_TELEMETRY`・`DO_NOT_TRACK`・`GH_NO_UPDATE_NOTIFIER`・`GH_CONFIG_DIR`。`gh config --help` の `telemetry`（既定は `enabled`）、2026-11-13 確認
- `gh` v2.103.3 を `GH_TELEMETRY=log` で動かし、端末につながっていない `gh api`・`gh config list` でも送る内容（`is_tty` が `false`）が出ること。`gh --version` には出ないこと、2026-11-13 確認
- natsumi `runner/runner.go` の `environment`（コマンドに渡す環境変数）、2026-11-13 確認
