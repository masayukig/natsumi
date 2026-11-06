# 0085. 作業環境から鍵の要る API とノードへ、鍵を見せずに中継で出る

- Date: 2026-10-30
- Status: Accepted（2026-10-30: 作業環境の image に入れるコマンドを全員に入れると決めたことを「実装で決めたこと」の節に加えた）

## Context

本人は、クラスタの運用を受け持つインスタンスを立てる。目標は、クラスタの安定稼働・アップデート・脆弱性への対応である。
そのインスタンスは、作業環境から次のものを使う。

- 運用するクラスタの Kubernetes の API。Secret を除いた読み取りの専用の ServiceAccount で使う。
- 壊してよい試験用のクラスタの Kubernetes の API。専用の ServiceAccount の cluster-admin で使う。
- 試験用のクラスタのノードへの ssh。kubelet・containerd・OS の更新を試すためである。
- gated の後ろの API（脆弱性の集計や、リリースの遅れの一覧）。gated の audience の token で呼ぶ（[ADR 0084](0084-calling-agents-behind-gated-with-its-audience.md)）。
- GitHub の API と git。読み取りだけの GitHub App の installation token で使う。token は 1 時間で切れる。

今の決まりでは、これができない。

- 作業環境の外向きは、名前解決も含めてすべて拒否している（[ADR 0034](0034-an-allow-list-for-the-way-out.md)）。
- [ADR 0004](0004-pi-tool-and-voice-boundaries.md) は「任意 HTTP を許可しない」とし、ADR 0034 はそれを作業環境の出口を開ける作業単位で決め直すとしていた。
- 秘密の要る API を道具にするときの方向は、[ADR 0075](0075-tools-declared-in-the-config.md) の「後で決めること」に残してあった。
  認証は出口の proxy の中継が付け、秘密は出口の proxy のコンテナだけが持つ、という方向である。

前例が 1 つある。画像生成の中継である（[ADR 0044](0044-drawing-with-sdctl-and-posting-images.md)）。

- 作業環境は loopback の平文の HTTP で中継に話す。中継（出口の proxy の nginx の http の server）は、
  行き先を設定で固定し、行き先の証明書を確かめ、bearer token を付けて HTTPS で送る。
- token は出口の proxy のコンテナにだけ mount した秘密である。作業環境から来た `Authorization` と `Cookie` は捨てる。
- 通すパスと method を絞る。作業環境の UID の外向きの規則は変えない（loopback は通る）。

インスタンスは外の文章を読む（リリースノート、Advisory、Issue など）。prompt injection の入口がある。
最初は鍵を作業環境に置き、モデルに見える形を考えた。本人はそれを取り消し、鍵を 1 つも見せない形を選んだ。
鍵が見えなければ、読まされた文章に従っても鍵そのものは持ち出せない。

設計は本人との問答で決めた。

## Decision

### インスタンスが配置で選ぶ。既定は今までどおり

- この ADR の中継と出口は、インスタンスごとに配置（環境の設定）で選ぶ。選ばないインスタンスは、ADR 0034 のまま作業環境の外向きを全部拒否する。
- natsumi のコードは、このために変えない。中継も出口の規則も、出口の proxy と初期化のコンテナの設定である。
  作業環境の image に入れるコマンド（kubectl・ssh の client など）は、実装の作業単位で決める（後述）。

### 作業環境は鍵を 1 つも見ない

- Kubernetes の API の token、gated の token、GitHub App の token、ssh の秘密鍵は、どれも作業環境に置かない。サーバーのコンテナにも置かない。
- HTTP の API の鍵は、中継のコンテナにだけ mount する。ssh の秘密鍵は、ssh-agent のコンテナにだけ mount する（後述）。
- 作業環境に置くのは、鍵を含まない接続の設定だけである（kubeconfig、ssh の client の設定、known_hosts）。どれも秘密ではない。

### HTTP の API は、loopback の中継が認証を付けて HTTPS で送る

ADR 0044 の画像生成の中継と同じ形を、API ごとに足す。

- API ごとに、loopback のポートを 1 つと、中継の server を 1 つ持つ。作業環境はそのポートに平文の HTTP で話す。
- 行き先は中継の設定で固定する。要求の中身（Host のヘッダ、パス）から行き先を変えない。
- 中継は、行き先の証明書を確かめてから送る。Kubernetes の API なら、そのクラスタの CA で確かめる。
- 中継は、作業環境から来た `Authorization` と `Cookie` を捨て、自分の鍵で認証を付ける。
  付け方は相手に合わせる（Kubernetes の API と GitHub の API は `Authorization: Bearer`、git の HTTP は installation token の Basic など）。
- 通すパスと method は、中継ごとに絞れる。どの中継も、要らないものは閉じる。
- 中継はリダイレクトをたどらない。別の名前へ飛ぶ応答は、そのまま作業環境に返る。作業環境からその先へは出られない。
- アクセスログは method・パス・状態・時間だけにする。ヘッダと本文は出さない（ADR 0044 の中継と同じ）。

中継ごとの絞り方の目安は次のとおりである。正確な location は環境の設定で書く。

| 中継 | 通すもの | upgrade |
| --- | --- | --- |
| 運用するクラスタの Kubernetes の API | GET（HEAD を含む）だけ | 通さない |
| 試験用のクラスタの Kubernetes の API | すべての method とパス | 通す（exec・port-forward・attach） |
| gated の後ろの API | API ごとに、使うパスの GET だけ | 通さない |
| GitHub の API | GET だけ | 通さない |
| GitHub の git | 取り込み（`info/refs` の GET と `git-upload-pack` の POST）だけ。`git-receive-pack` は断る | 通さない |

- 運用するクラスタは、ServiceAccount の権限（RBAC）でも読み取りに絞る。中継の GET の絞りは、その上に重ねる 2 枚目である。
  exec・port-forward は RBAC でも許さないので、中継でも upgrade を通さない。ログの追いかけ（`logs -f`）はふつうの GET なので通る。
- 試験用のクラスタは壊してよい場所である。中継では絞らず、権限は ServiceAccount に任せる。
  exec・port-forward は、更新の予行や調べに要るので、upgrade（WebSocket と SPDY）を通す。
- GitHub の App は読み取りだけの権限（Contents・Pull requests・Metadata の Read-only）にする。中継の GET の絞りは、ここでも 2 枚目である。

### 時間で切れる token は、作り直す側が中継の読む場所へ書く

- GitHub App の installation token は 1 時間で切れる。App の秘密鍵から token を作り直す小さな sidecar を置く。
  sidecar は、中継が読む場所（中継と sidecar の間の共有の volume）へ token を書く。App の秘密鍵は sidecar のコンテナにだけ mount する。
- gated の token と、Kubernetes の API の token を projected token で持つ場合も、kubelet が作り直す。
- **中継は、作業環境を止めずに、書き換わった token を切れる前に使い始める。** 拾い方（nginx の reload、要求のたびに読む、sidecar 自身を中継にする、など）は環境の設定の側で決める。
  中継が古い token を使い続けると、上流が 401 を返す。作業環境からは、上流の 401 として見える。

退けた案:

- **長く効く token（GitHub の personal access token など）を中継に置く**: 作り直しは要らないが、漏れたときの効き目が長い。
  App の installation token は 1 時間で切れ、権限も App の設定に縛られる。

### ssh は、ssh-agent を別のコンテナで動かし、socket だけを渡す

- ssh は HTTP ではないので、認証を付ける中継の形が取れない。
- ssh-agent を別のコンテナで動かし、秘密鍵はそのコンテナにだけ mount する。agent の socket だけを、共有の volume で作業環境に渡す。
  作業環境の ssh は agent に署名を頼めるが、秘密鍵は読めない。
- 作業環境と sshd の UID に、試験用のクラスタのノードの tcp 22 だけへの外向きを、初期化のコンテナの規則（ADR 0034）で開ける。
  宛先は IP で列挙する。名前解決は開けない。ssh の client の設定は IP で書く。
- ノードの host key は known_hosts で固定し、作業環境に読み取り専用で置く。知らない host key のノードにはつながない。
- agent の鍵は、試験用のクラスタのノードにだけ登録する。GitHub などほかの場所には登録しない。
  作業環境は loopback の GitHub の ssh の中継（ADR 0073）にも届くので、鍵を GitHub に登録すると、その鍵で GitHub に入れてしまう。

### 中継の出口

- 中継は出口の proxy の UID で外へ出る。ADR 0034 では、proxy の UID の外向きは tcp 443 と名前解決だけである。
- Kubernetes の API が 443 以外のポート（6443 など）で受けるときは、proxy の UID に、その宛先（IP とポート）への外向きを足す。
  足すのは中継の行き先に限る。名前で絞る SNI の許可リストは通らない。中継の行き先は中継の設定で固定されており、作業環境からは選べないためである。
- 運用するクラスタが Pod のいるクラスタそのものなら、クラスタの中の API の Service（443）を行き先にしてよい。

### 作業環境の SNI の許可リストは作らない

- ADR 0034 は、後で作業環境用の SNI の許可リストを持てるように proxy を作っていた。この ADR では使わない。
  作業環境の HTTPS をそのまま名前で通す道（たとえば github.com を許可リストに入れる）は作らない。
- 理由: 名前で通す道では、要求の中の認証は作業環境が自由に書ける。読まされた文章に他人の token が書いてあれば、
  その token で許可した名前のサービスに書き込めてしまう（GitHub なら、他人のリポジトリへの push や Issue への書き込みで、作業環境の中身を持ち出せる）。
  中継は作業環境から来た `Authorization` を捨て、method も絞るので、この道が無い。
- 公開のページ（リリースノート、Advisory）も、GitHub の API の中継で読む。

### 道具は、宣言したツールと run_shell から使う

- 中継を使う CLI（kubectl、git、`gh`、gated の後ろの API の小さな CLI など）は、作業環境から loopback の中継を指す。
- インスタンスは、それを宣言したツール（ADR 0075 のコマンド型）として持てる。本体は `/tools` の小さなスクリプトで、中継を使う CLI を呼ぶ。
  出力が大きいもの（脆弱性の一覧など）は `exposure` を `codemode` にし、スクリプトの中で絞ってから文脈に入れる（[ADR 0066](0066-codemode-to-keep-raw-output-out-of-the-context.md)）。
- `run_shell` から直接 CLI を使ってもよい。中継が鍵を付けるので、道具を通しても通さなくても、作業環境が持てる力は同じである。
- runner はコマンドに `PATH`・`HOME`・`LANG`・`TZ` しか渡さない（[ADR 0019](0019-a-workspace-not-a-memory-tool.md)）。
  CLI の接続先は環境変数ではなく、読み取り専用の設定ファイル（kubeconfig、ssh の client の設定）か、それを必ず渡すラッパーで決める（ADR 0044 の sdctl と同じ）。
  kubeconfig には、中継の loopback の URL と context の名前だけを書き、鍵は書かない。

### run_shell の説明は変えない

- `run_shell` の説明（「ネットワークの無い Debian の環境」）は変えない。中継を選ぶのは一部のインスタンスで、説明を変えると全員の prefix が変わる。
  画像生成の中継（ADR 0044）のときも変えなかった。
- 使える中継と CLI は、そのインスタンスの `/manual` の手引きで知らせる（[ADR 0036](0036-a-manual-to-read-and-a-limit-on-waiting.md)）。

### 環境の設定の側で決めること

この公開のリポジトリには書かない。

- 中継の名前・loopback のポート・行き先の名前と IP・秘密の名前・中継の location の正確な書き方。
- 書き換わった token を中継が拾う方法。
- ssh-agent のコンテナと socket の置き場所、ノードの IP の一覧、known_hosts、ノードの側でその鍵に許すこと。
- 中継をインスタンスごとの overlay で持つか、base で持つか。

### 実装の作業単位で決めること

- kubectl・ssh の client・git・`gh` などを、作業環境の image に全員の分として入れるか、選んだインスタンスにだけ届ける形にするか。
- 宣言したツールの本体と、`/tools` の mount の形（ADR 0075 で環境の設定の側に残したもの）。

### 実装で決めたこと（2026-10-30）

上の「実装の作業単位で決めること」の 1 つ目を、natsumi の実装の PR で次のように決めた。2 つ目（宣言したツールの本体と `/tools` の mount の形）は環境の設定の側で決める。

- **コマンドは全員の作業環境の image に入れる。** 入れるのは `kubectl`・ssh の client（`openssh-client`）・`curl` である。
  - 中継を選ばないインスタンスでは、作業環境の外向きが全部閉じているので、入っていてもどこにもつながらない。選んだインスタンスにだけ届ける形（別の image、mount）は、配置の仕組みを増やすだけで守りを強めない。
  - `git`・`jq` は既に入っている。`gh` は入れない。GitHub の API は中継の loopback の平文の HTTP で呼ぶので、`curl` で足りる。
- **`kubectl` は版を固定して公式の配布から取る。** Debian のパッケージには無い。版はクラスタの minor（v1.37）に合わせ、dl.k8s.io の `.sha256` で確かめる。
  版は Dockerfile の `ARG KUBECTL_VERSION` に書き、Renovate が Kubernetes のリリースとして上げる。patch はほかの依存と同じく自動でマージし、minor はクラスタの版と合わせて人が取り込む。
- **PATH の ssh はラッパーにする。** ssh は起動時に自分の UID の行を `/etc/passwd` から引き、無ければ `No user exists for uid` で止まる。`-F` の設定でも避けられない。
  image の `/etc/passwd` には既定の UID（1000）の行しか無く、Kubernetes の配置は作業環境を別の UID（1001）で動かす（[ADR 0033](0033-running-on-kubernetes.md)）。
  - ラッパーは、行がある UID ではそのまま本物の ssh を動かす。行が無い UID では、`/tmp` に 1 行の passwd（ホームは `HOME`）を書き、`libnss-wrapper` を `LD_PRELOAD` で ssh にだけ読ませる。
    preload はラッパーが ssh を起動するコマンドの行にだけ付けるので、効くのは ssh とその子だけで、`run_shell` のほかのコマンドには効かない。
  - 配置の UID を公開の image に焼き込む案と、配置の側で `/etc/passwd` を上書きする案は退けた。前者は配置ごとに UID が違えば同じ問題が残り、後者は image の `/etc/passwd` の変更に配置が追従しなければならない。
  - `kubectl`・`curl`・`git` は passwd の行が無くても動く。ssh の行の要るほかのコマンド（`scp`・`sftp`）はラッパーを持たない。
- どのコマンドも `HOME` に書かずに動く。ssh は `-F` の設定の `UserKnownHostsFile` で known_hosts を指し、`kubectl` は `--kubeconfig` で設定を読む（キャッシュの場所に書けなくても止まらない）。
  作業環境の image の試験で、UID 1000 と 1001 の両方について、`HOME` を書けなくした状態で確かめている。

### 置き換える既存の決定

- ADR 0034
  - 置き換え:「作業環境の外向きは、今は全部拒否する」を、この ADR の形を選んだインスタンスに限って決め直す。
    作業環境と sshd の UID に、試験用のクラスタのノードの tcp 22 だけを開ける。名前解決は開けない。
  - 追加: 出口の proxy に、loopback で受けて認証を付ける中継を API ごとに足せる。中継の行き先が 443 以外なら、proxy の UID にその宛先を足す。
  - 置き換え:「proxy は、後で作業環境用の許可リストを別に持てる形にしておく」の見込み。作業環境の HTTPS を名前で通す道は作らない。
  - 残す: 選ばないインスタンスでは、作業環境の外向きは全部拒否する。サーバーの外向きの規則と SNI の許可リスト。
  - 残す:「外のエージェントとのやり取りは、そのあともサーバーを通す」。この ADR の中継は外のエージェントへの依頼（A2A）には使わない。
- ADR 0004
  - 置き換え:「任意 HTTP を許可しない」を、この ADR の形を選んだインスタンスに限って決め直す。
    作業環境は、中継が固定した行き先・パス・method に限って HTTP を使える。行き先を作業環境が選べる HTTP は、これまでどおり許さない。
  - 残す:「任意 credential 読み出しを許可しない」。鍵は作業環境にもサーバーにも置かない。
- ADR 0075
  - 具体化:「後で決めること」の、秘密の要る API の認証。出口の proxy の中継が付ける。
  - 残す:「つなぎ方は、中継が TLS を終端する形を目指す」。最初は loopback の平文の HTTP で始め、TLS の終端は別の作業単位で決める。
- ADR 0044
  - 残す: 画像生成の中継。この ADR の中継は同じ形の仲間である。

## Consequences

- この形を選んだインスタンスでも、作業環境とモデルは鍵を見ない。読まされた文章に従っても、鍵そのものは持ち出せない。
  ただし、中継が通す範囲では鍵を「使える」。使える範囲は、中継の絞りと、鍵の側の権限（RBAC、App の権限、ノードの側の設定）で決まる。
- **試験用のクラスタの cluster-admin を使えば、試験用のクラスタに Pod を立てて、そこから外へ出られる。**
  作業環境の出口の絞りは、試験用のクラスタを通すと効かない。試験用のクラスタは壊してよい場所で、持ち出されて困る鍵や記録を置かないことを前提に、本人が承知している。
  同じ理由で、試験用のクラスタのノードへの ssh からも外へ出られる。
- 運用するクラスタは、RBAC と中継の GET の 2 枚で読み取りに絞る。Secret は RBAC で読めない。
  それでも、ConfigMap・Pod の定義・ログなどに書かれた値は読める。秘密を ConfigMap や環境変数の平文に置いていれば、それは見える。
- GitHub の App は All repositories が読める。本人の private のリポジトリも読める。読んだ中身は、外の文章に従って Slack などに書き出されうる（投稿はポッポさんの関所を通る、[ADR 0040](0040-the-dove-sends-what-the-judge-passes.md)）。
- 中継の数だけ、出口の proxy の設定と秘密が増える。token を作り直す sidecar と ssh-agent のコンテナが増える。
  中継の token の拾い方を誤ると、1 時間ごとに GitHub が 401 を返す。
- 中継はリダイレクトをたどらないので、別の名前へ飛ぶもの（リリースの添付、アーカイブのダウンロードなど）は、作業環境からは取れない。要るようになったら、中継を足すかを考える。
- ssh-agent に頼める署名は、socket に届くプロセスならどれでも頼める。作業環境の中のどのコマンドも、試験用のクラスタのノードに入れる。
- 中継は loopback で待ち受けるので、同じ Pod のどの UID からも届く（ADR 0044 の中継と同じ）。サーバーは中継を使わない。
- `run_shell` の説明は「ネットワークの無い」のままで、選んだインスタンスでは実際と食い違う。手引きで補う。
- natsumi のコードは変わらないので、prefix も変わらない。宣言したツールを足したインスタンスでは、ADR 0075 のとおりツールの定義が長くなる。

作業は次の単位で進める。

1. natsumi: 中継を使う CLI を作業環境に入れる場所と、手引きの雛形（実装の作業単位）。
2. 環境の設定（private のリポジトリ）: そのインスタンスの overlay に、中継・秘密・token を作り直す sidecar・ssh-agent・初期化のコンテナの規則・kubeconfig と ssh の設定・`/tools`。
   運用するクラスタの ServiceAccount と ClusterRole、試験用のクラスタの ServiceAccount、gated の認可にインスタンスの主体を足すこと。
