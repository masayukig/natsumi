# 伊織のアバター

組み込みのアバターです。config の `avatar.id` に `iori` を指定すると、名前と姿が伊織になります。
各ファイルの仕様は [アバターの作り方](../../../docs/avatar.md) を参照してください。

| ファイル | 内容 |
| --- | --- |
| `avatar.json` | ID・表示名、atlas、動作と表情の対応、顔のアイコンの場所 |
| `pet.json` | Codex のペット形式の定義 |
| `spritesheet.webp` | 192×208 のセル、8 列 × 9 行、透明背景のアニメーション |
| `icons/<表情>.webp` | 顔を近く切り出した 512×512 のアイコン。`angry` を含む 9 種 |
| `slack/<表情>.png` | 同じ切り出しから作った 256×256、RGB の PNG。9 種 |
| `appearance.yaml` | 伊織の LoRA、身体の特徴、白いワンピース、描画例 |
| `sdctl-params.yaml` | 自分を描くときのモデル・サンプラーなどの既定値 |
| 直下の PNG 9 枚 | 提供された元画像 8 枚と、追加生成した `worried.png`。元画像の `anyry.png` は元の名前を保持 |

## 出どころと生成設定

元の表情 8 枚は、Anima 系のモデル `unholyDesireLunar_v20` と LoRA `iori_funaki_anima.v4` で生成した画像です。
元画像は名前・内容を変えずに保存しています。`._*` は含めていません。表示用の怒った顔だけを `angry` と命名しています。

`worried.png` は sdctl で追加生成しました。元画像の品質・身体・服・構図・LoRA・Negative の行を保持し、
表情の行を `worried, furrowed brow, head tilt, uneasy expression,` にしています。
首をかしげた候補 2 枚（seed `700795633` と `700795634`）から `700795633` を選びました。
首の傾き、寄った眉、下がった口角が読み取りやすく、伏し目の `sad` と区別でき、髪・瞳・そばかすも既存の顔になじむためです。

- ER SDE、Beta、Steps 32、CFG 4、1024×1024。
- Model hash `17e4e494f8`、LoRA hash `4a129d71bb81`。
- モジュールは `qwen_image_vae` と `qwen_3_06b_base`。
- Beta の alpha/beta は生成メタデータでともに 0.6。Shift は元画像が 3、追加生成が 3.5 です。
  sdctl の params に Shift と Beta の alpha/beta の専用欄がないため、これらは WebUI の値に依存します。
- `sdctl-params.yaml` では、モデル一覧にある名前 `anima_unholyDesireLunar_v20` を使い、通常の描画は 896×1152 の縦長にしています。

顔は目の位置と顔の大きさをそろえて正方形に切り出し、Pillow の LANCZOS で縮小しました。
表示用 WebP と Slack 用 PNG は同じ切り出しを使い、生成メタデータを引き継いでいません。
元画像からの切り出し座標（左・上・一辺、元の 1024×1024 上）は次のとおりです。

| 表情 | 左 | 上 | 一辺 |
| --- | ---: | ---: | ---: |
| angry (`anyry.png`) | 60 | 181 | 650 |
| happy | 200 | 140 | 650 |
| laughing | 275 | 135 | 630 |
| neutral | 310 | 156 | 630 |
| sad | 229 | 169 | 650 |
| sleepy | 229 | 161 | 650 |
| surprised | 193 | 117 | 650 |
| thinking | 270 | 93 | 650 |
| worried | 268 | 126 | 630 |

spritesheet は Codex の `hatch-pet` と OpenAI の画像生成で作成しました。
`happy.png` を参照して小さな全身の姿を作り、それを共通の参照として動作ごとの画像を生成しています。
左移動は、左右で意味が変わる小物や模様がないことを確認し、右移動のコマ順を保って各コマを左右反転しています。
その他の動作はそれぞれ生成し、hatch-pet のスクリプトで背景を抜き、セルに収めて atlas にしています。
抽出は `stable-slots`、青い背景の除去閾値は 160 です。動作内の縮尺を共通にすることで、
ジャンプの上下動とうつむく動作を保ち、コマごとの拡大縮小を避けています。
残った青い輪郭は Pillow で補正しました。透過境界から4ピクセル以内で、青成分が赤・緑の最大値を12より多く上回る画素だけ、
青成分をその最大値に合わせています。輪郭の内側にある紫の瞳と、アルファ値は変えていません。

動作とフレーム数は `idle` 6、`running-right` 8、`running-left` 8、`waving` 4、`jumping` 5、
`failed` 8、`waiting` 6、`running` 6、`review` 6 です。
表情から動作への対応はなつみに合わせ、`angry` は `failed` にしています（現在のサーバーは `angry` を使いません）。

## ライセンス

このディレクトリの画像と定義は
[Creative Commons Attribution 4.0 International（CC BY 4.0）](https://creativecommons.org/licenses/by/4.0/)
で提供します。リポジトリのコードのライセンス（MIT）とは別です。
帰属表示は「伊織のアバター — yuanying / natsumi」とし、このディレクトリとライセンスへのリンクを添えてください。
