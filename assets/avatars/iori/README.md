# いおりのアバター

fork（masayukig/natsumi）だけにあるアバターです（ADR 0057）。config の `avatar.id` に `iori` と書くと、これになります。
作り方と各ファイルの説明は [docs/avatar.md](../../../docs/avatar.md) にあります。

| ファイル | 内容 |
| --- | --- |
| `avatar.json` | ID（`iori`）と表示名（いおり）、表情ごとの顔のアイコンの場所。spritesheet は無い（Slack だけで使うので、名無しの人形で埋まる） |
| `icons/<表情>.webp` | 表情ごとの顔（512×512）。`angry` を含む 9 つ |
| `slack/<表情>.png` | Slack のアイコン。同じ元画像を 256×256 の PNG（RGB）に縮めたもの |
| `appearance.yaml` | 自分を描くときのプロンプト（LoRA・体の行・既定の服・確かめる語・例） |

`sdctl-params.yaml` は置いていないので、サーバーの既定（名無しの `../nanashi/sdctl-params.yaml`）を使います。

## 出どころ

- 画像はすべて Anima（circlestone-labs、aesthetic v1.1）に、上流の作者から個人的にもらった LoRA
  `iori_funaki_anima.v4` を重ねて、ComfyUI で描いたものです（2026-09-29）。
- 見た目は LoRA の人物に、なつみの要素（黒縁メガネ・そばかす・スーツ）を足したもの。
- LoRA のファイルはこのリポジトリに含めません。
