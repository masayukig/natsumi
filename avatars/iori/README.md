# いおりのアバター

fork（masayukig/natsumi）だけにあるアバターです（ADR 0057）。組み込み（`assets/avatars/`）には置いていません。
置くと上流のテストが組み込みの一覧（natsumi・nanashi）を固定で確かめていて落ち、同期のたびに衝突するためです。
ここは Slack が取りに来るアイコンの公開の置き場と、素材の原本です。サーバーには private の natsumi-deploy が
`avatar.json`（id と名前だけ）と `appearance.yaml` を ConfigMap で渡し、`avatar.directory` で指します。
作り方と各ファイルの説明は [docs/avatar.md](../../docs/avatar.md) にあります。

| ファイル | 内容 |
| --- | --- |
| `avatar.json` | ID（`iori`）と表示名（いおり）、spritesheet の区切り方（1 コマ 192×208、8 列 × 11 行）と動作・表情の対応（なつみと同じ）、表情ごとの顔のアイコンの場所 |
| `spritesheet.webp` | Mac・iPhone・GNOME に出るちびキャラのペット。透明背景、上から `idle`（6）・`running-right`（8）・`running-left`（8）・`waving`（4）・`jumping`（5）・`failed`（8）・`waiting`（6）・`running`（6）・`review`（6）、下の 2 行は見る向き（16 方向） |
| `icons/<表情>.webp` | 表情ごとの顔（512×512）。`angry` を含む 9 つ |
| `slack/<表情>.png` | Slack のアイコン。同じ元画像を 256×256 の PNG（RGB）に縮めたもの |
| `appearance.yaml` | 自分を描くときのプロンプト（LoRA・体の行・既定の服・確かめる語・例） |

`sdctl-params.yaml` は置いていないので、サーバーの既定（名無しの `../nanashi/sdctl-params.yaml`）を使います。

## 出どころ

- 画像はすべて Anima（circlestone-labs、aesthetic v1.1）に、上流の作者から個人的にもらった LoRA
  `iori_funaki_anima.v4` を重ねて、ComfyUI で描いたものです（2026-09-29）。
- 見た目は LoRA の人物に、なつみの要素（黒縁メガネ・そばかす・スーツ）を足したもの。
- LoRA のファイルはこのリポジトリに含めません。
- `spritesheet.webp`（2026-10-01）は、上と同じ設定で描いた全身の立ち絵（ER SDE・Beta・32 steps・CFG 4、
  seed 1002、896×1152）を参照画像にして、Codex（`work-pets` プラグインの `create-pet`）に作らせたもの。
  頭身はなつみ・組み込みの伊織の spritesheet を見本に渡して約 2 頭身にそろえた。待機（`idle`）は小さな呼吸だけにした。
  付属の検証（`validate`）は合格。警告は見る向きの 2 行のつなぎ目だけ。
