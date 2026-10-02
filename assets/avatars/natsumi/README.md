# なつみのアバター

サーバーに組み込みのアバターで、既定です（ADR 0057）。config の `avatar.id` に `natsumi` と書くか、`avatar` を省略すると、これになります。
作り方と各ファイルの説明は [docs/avatar.md](../../../docs/avatar.md) にあります。

| ファイル | 内容 |
| --- | --- |
| `avatar.json` | ID（`natsumi`）と表示名（なつみ）、atlas（行ごとの動作とフレーム数）、表情から動作への対応表、表情ごとの顔のアイコンの場所 |
| `pet.json` | Codex のペットの形式の定義 |
| `spritesheet.webp` | 動作ごとのフレームを並べた spritesheet（1 マス 192×208、8 列 × 11 行、背景は透明） |
| `icons/<表情>.webp` | 会話の履歴でセリフの横に出す、表情ごとの顔（512×512）。`angry` を含む 9 つの表情にそれぞれ 1 枚 |
| `icons/angry.webp` | 怒った顔。`avatar.json` の `icons` に載せているが、サーバーの表情にまだ `angry` がないので、今は使われない（ADR 0057） |
| `slack/<表情>.png` | Slack のアイコン。`icons/<表情>.webp` を 256×256 の PNG に縮めて変換したもの（Pillow で開き、RGB にして LANCZOS で縮め、PNG で保存）。`angry` も同じく作ってある。元の画像を差し替えたら作り直す |
| `appearance.yaml` | 自分を描くときのプロンプト（LoRA・体の行・既定の服・確かめる語・例） |

自分を描くときは専用の `sdctl-params.yaml` を使います。モデルは `anima_2_9_Anima-2.9B-preview-v1`（hash `0b3020d1b9`）、LoRAは `kutara_anima.v1`（強度1）です。
ER SDE・Beta・32 steps・CFG 4・896×1152、`qwen_image_vae.safetensors` と `qwen_3_06b_base.safetensors` で生成を確認しました。
品質の行は `masterpiece, newest,`。体の行は `kutara natsumi, low ponytail, freckles, large breasts,` と、空行を挟んだ `black glasses,` で、黒縁眼鏡は服ではなく体の行に含めています。
`keep` は `freckles`・`large breasts`・`low ponytail`。
眼鏡は体の行にあるので、描画例（私服の自撮り・雨窓のカーディガン）のどちらにも入ります。

## ライセンス

このディレクトリの画像と定義（`spritesheet.webp`・`icons/`・`slack/`・`pet.json`・`avatar.json`）は
[Creative Commons Attribution 4.0 International（CC BY 4.0）](https://creativecommons.org/licenses/by/4.0/)
で提供します。リポジトリのコードのライセンス（MIT）とは別です。

## 出どころ

- キャラクターの参照画像は Anima で生成しました。
- spritesheet と表情のアイコンは、その参照画像をもとに OpenAI の画像生成で作りました。
- Slack の PNG は、表情のアイコンを変換したものです。
