# 0081. main への push ごとに image を `main` の tag で出し、押し出された版を消す

- Date: 2026-10-27
- Status: Accepted

## Context

image は、版の tag（`v0.x.y`）を push したときと、週次のリリース（`weekly-release.yml`）のときだけ、ghcr に置いている（[ADR 0033](0033-running-on-kubernetes.md)・[ADR 0079](0079-dependency-updates-with-renovate.md)）。
`natsumi` と `natsumi-workspace` の 2 つで、amd64 だけである。

本番のクラスタでは、Trivy Operator が動いている image の脆弱性を調べている。その結果を集計する係（`vuln-tracker`。別のリポジトリ）を作り、
脆弱性ごとに対応がどの段まで進んだかを追う。段の 1 つが「main では直ったが、まだ版の tag が付いていない」である。
これを知るには、main の今のコミットから作った image を調べるしかない。版の tag の image は、tag を付けるまで main の変化を映さない。

集計役は、自作のリポジトリの image に、決まった名前の動く tag が 1 つあることを前提にする。どのリポジトリでも tag の名前は `main` である。
既定のブランチが master のリポジトリでも変えない。集計役は image のラベル `org.opencontainers.image.source` でリポジトリを、
`org.opencontainers.image.revision` でコミットを知る。

動く tag を push し直すと、それまで tag が指していた版は tag の無い版として ghcr に残る。放っておけば push のたびに増える。
ghcr の版は、1 つの image でも index・各プラットフォームの manifest・attestation が別々の版に見える。tag の無いものを単純に消すと、
tag の付いた image の中身まで消えてしまう。

## Decision

### main への push で `main` の tag を出す

- `images.yml` を main への push でも動かす。版の tag のときと同じく、検査（typecheck・テスト・build）を通ってから、
  サーバーの image を起動して確かめ、2 つの image を push する。
- tag は `main` だけである。プラットフォームは版の tag と同じ amd64 である。
- `main` は、main への push のときだけ付ける。週次のリリースも main の上で `images.yml` を呼ぶが、そのときは付けない。
  リリースの流れは今までと変えない。
- 続けて main に push すると、2 つのビルドが競って古いコミットが `main` に残り得る。image のジョブは、image と ref ごとに 1 本ずつ順に走らせる。
- `main` の image は、どこでも動かさない。脆弱性を調べるためだけにある。

### ラベルで出どころを示す

- metadata-action の既定のラベルを、版の tag の image にも `main` の image にも付ける（前から付けている）。
  `org.opencontainers.image.source` はこのリポジトリの URL、`org.opencontainers.image.revision` はビルドしたコミットの SHA である。

### tag の無い版を CI で消す

- `images.yml` で image を push した後、2 つのパッケージそれぞれについて、tag の無い版を消す。
- 消すのは `dataaxiom/ghcr-cleanup-action` の `delete-untagged` である。この Action は、index に属する各プラットフォームの manifest と attestation を
  index と一体に扱う。tag の付いた image の中身は消さず、tag の無い image を消すときはその中身も一緒に消す。
- 他人の Action に、パッケージの版を消せる権限を渡すことになる。そのため、他の Action のような major の tag ではなく、コミットの SHA で固定する。
  更新は Renovate が提案する。
- 同じパッケージに 2 つ同時に走らせると安全でないと Action の説明にあるので、パッケージごとに 1 本ずつ順に走らせる。
- dry run にはせず、始めから消す。自作の image を出す他のリポジトリと同じ設定に揃える。
- 消した後に、残った image に欠けたプラットフォームの manifest が無いかを確かめる（`validate`）。欠けていてもジョブは失敗せず、ログに警告が出るだけである。

## Consequences

- main への push のたびに、2 つの image がビルドされて ghcr に push される。同じ push で `ci.yml` も走るので、検査は 2 回走る。
- 集計役は、`ghcr.io/yuanying/natsumi:main` と `ghcr.io/yuanying/natsumi-workspace:main` を調べて、main で直ったかを判定できる。
- tag の無い版を CI が消すには、ghcr の各パッケージの「Manage Actions access」で、このリポジトリに Admin の役割が要る。
  足りなければ、最初の main への push の `cleanup` ジョブが消せずに失敗する。
- 消された版は、ログに出る版の ID から、GitHub の REST API で戻せる。
