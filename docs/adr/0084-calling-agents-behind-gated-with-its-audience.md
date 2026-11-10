# 0084. gated の後ろの係は、gated の audience の token で呼ぶ

- Date: 2026-10-29
- Status: Accepted（Consequences の「gated 経由の係と Service を直接呼ぶ係を混ぜられない」は、係ごとに `tokenFile` を指せるようにすることで [ADR 0089](0089-hearing-from-agents-over-a2a.md) で置き換え）

## Context

[ADR 0025](0025-talking-to-outside-agents-over-a2a.md) で、外のエージェントを呼ぶ token は ServiceAccount の token とし、
受け取った側が TokenReview で確かめる、と決めた。token の audience は `a2a` に限った。
受け取ったエージェントが、その token を他の用途に使い回せないようにするためである。
[ADR 0033](0033-running-on-kubernetes.md) で、なつみがクラスタに移った後は、Pod に差し込まれる token（projected token、audience `a2a`）を使うことにした。

`yuanying/fraction-agents` の係（Wiki 管理人など）は、クラスタの入口の gated の後ろにいる。
gated は GitHub のログインと NetworkRole で認可する Ingress controller である。
これまで係の Ingress には NetworkRole を付けず、gated は `a2a` の token をそのまま係へ通していた。係が自分で TokenReview をしていた。

係を gated の NetworkRole で守る側に移すことになった。

- gated（v0.5.0）は、audience `https://auth.fraction.jp` の ServiceAccount の token を TokenReview で確かめる。
  受け付けたら `Authorization` を落とし、署名付きの `Gated-Assertion`（`sub` は `system:serviceaccount:<名前空間>:<名前>`）に置き換えて係へ転送する。
- 係はその assertion を検証し、`sub` を受け付ける呼び出し元（`allowedCallers`）と照らす（fraction-agents の ADR 0030）。
  係は自前の TokenReview（audience `a2a`）の入口も持ち続ける。
- 最後に係の Ingress を NetworkRole で守る。そうなると、gated 経由で `a2a` の token を送っても、gated は主体を決められず、未ログインとして断る。

## Decision

### 呼ぶ道で、token の audience を分ける

- **gated 経由で係を呼ぶとき（`https://<係>.fraction.jp` など）は、gated の audience（`https://auth.fraction.jp`）の token だけを使う。**
  なつみの本番はこれに当たる。projected token の audience を `https://auth.fraction.jp` にする。
- **係の Service を直接呼ぶときは、今までどおり audience `a2a` の token を使う。** 係が自分で TokenReview をする。
- ADR 0025 の「token の audience は `a2a` に限る」と、ADR 0033 の「projected token、audience `a2a`」を、gated 経由の呼び出しについて置き換える。

### 使い回されない性質は保たれる

ADR 0025 が audience を `a2a` に限ったのは、受け取った係が token を他の用途に使い回せないようにするためだった。
gated 経由では、gated が `Authorization` を落とすので、係は token を一度も見ない。係に渡るのは、そのホスト名に宛てた 60 秒の assertion だけである。
係が token を使い回すことはできない。

ただし、gated の audience の token は、gated が許す範囲で、gated の後ろのどのホストにも使える。
`a2a` の token が係にしか通じないのとは違う。
その範囲は、gated の NetworkRoleBinding で、なつみの ServiceAccount を通すホストを絞って決める。
なつみの側では、token を設定の `a2a.agents` の URL にだけ送る今の決まり（ADR 0025、[ADR 0036](0036-a-manual-to-read-and-a-limit-on-waiting.md)、[ADR 0048](0048-bringing-in-images-an-agent-hands-back.md)）がそのまま効く。

### なつみのコードは変えない

- なつみは token の中身を見ない。`a2a.tokenFile` を呼ぶたびに読み直し、`Authorization: Bearer` で送るだけである。audience が変わっても、コードと設定の形は変わらない。
- audience を決めるのは、token を発行する側である。本番では projected token の設定（環境のリポジトリ）、Docker では手で置くファイルを発行するときの指定で決まる。
- Agent Card は今までどおり token なしで取る。gated は Agent Card（`/.well-known/*`）を未ログインにも返す。
- 返事の画像の成果物（ADR 0048）も、係と同じ origin から同じ token で取る。gated 経由では、その token も gated で落とされて assertion になり、係は assertion で確かめる。
  なつみの側の決まり（同じ origin だけ、リダイレクトはたどらない）は変わらない。

## Consequences

- 本番のなつみの token は、gated の後ろのホストのうち、NetworkRoleBinding がなつみの ServiceAccount を通すところでは使える。
  通す範囲を広げすぎないことは、環境のリポジトリで NetworkRoleBinding を書く側の責任になる。
- `a2a.tokenFile` は 1 つなので、1 つのなつみの `a2a.agents` には、gated 経由の係と Service を直接呼ぶ係を混ぜられない。
  混ぜたくなったら、token を係ごとに持てるように設定とコードを変える。
- 切り替えの順番は、gated と係が新しい形を受け付けるようになってから、なつみの token の audience を変え、最後に係の Ingress を NetworkRole で守る。
  順番は環境のリポジトリの手順に従う。
