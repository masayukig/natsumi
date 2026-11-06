# ペネロペのアバター

組み込みのアバターです。config の `avatar.id` に `penelope` を指定すると、名前と姿がペネロペになります。
ファイルの仕様は [アバターの作り方](../../../docs/avatar.md)、制作手順は [CLAUDE.md](../CLAUDE.md) を参照してください。

ペネロペは、クラスターの運用を受け持つ、寡黙なアンドロイドです。
デスクトップのアプリで使う前提が無いので、spritesheet と `pet.json` は持ちません。
アプリに出る姿は名無しののっぺらぼうの人形で埋まり、`pet.json` はサーバーが作ります。
表情9枚、話し方、`appearance.yaml` は本人の確認済みです。

| ファイル | 内容 |
| --- | --- |
| `avatar.json` | ID・表示名と、表情のアイコンの場所。spritesheet と動作は書いていません |
| `icons/<表情>.webp` | 顔を切り出した 512×512 の WebP。`angry` を含む 9 種 |
| `slack/<表情>.png` | 同じ切り出しから作った 256×256、RGB の PNG。9 種 |
| 直下の PNG 9 枚 | 表情の生成元（1024×1024）。`parameters` にプロンプトと seed を保存しています |
| `appearance.yaml` | 自分を描くときの LoRA・体・既定の服・描画例 |
| `sdctl-params.yaml` | 自分を描くときのモデル・サンプラーなどの既定値（アキと同じ） |
| `personality.md` | 性格・話し方の初期値（記憶に性格がまだ無いときだけ使われます） |

## 表情の出どころと生成設定

sdctl と Stable Diffusion WebUI で生成しました。
モデルは `anima_2_9_Anima-2.9B-preview-v1`（hash `0b3020d1b9`）、LoRA は `penelope_natsumi_anima.v2`（強度1、トリガー語 `penelope`、hash `1d553daf9692`）です。

- `sdctl-params.yaml` の設定で、**width/height だけを1024に上書き**しました。自分を描く通常の既定値は896×1152のままです。
- ER SDE、beta、Steps 32、CFG 4、ADetailer `face_yolov8n.pt`（denoising 0.4、inpaint only masked）。
- モジュールは `qwen_image_vae.safetensors` と `qwen_3_06b_base.safetensors`。
- PNG の記録では Shift 3.5、beta の alpha/beta ともに0.6。これらは WebUI 側の設定に依存します。
- 各表情を batch size 2 で生成し、2枚から1枚を選びました。PNG の seed は、2枚目なら指定した seed に1を足した値です。

### プロンプト

表情の行だけを替え、ほかの行は9枚で共通です。

```text
<lora:penelope_natsumi_anima.v2:1>,
masterpiece, newest,
solo, single portrait,
penelope, 1girl, android,
<表情の行>
face close-up, headshot, portrait, simple white background,
```

ペネロペは表情が乏しい、という本人の決定に合わせ、`angry` 以外は目と口元のわずかな差にとどめています。
`angry` だけは、本人の指示で、worried・sad と一目で見分けられる怒り顔にしました（下の「angry」）。

## 選定・切り出し

| 表情 | 表情の行 | PNG の seed | 選んだ理由 |
| --- | --- | ---: | --- |
| neutral | `neutral expression, expressionless, looking at viewer,` | 1031000 | 正面、閉じた口、眠たげな目 |
| happy | `faint smile, slight smile, looking at viewer,` | 1031011 | ごく薄い笑み。もう1枚は顔が小さい |
| laughing | `slight smile, closed eyes, head tilt,` | 1031020 | 目を閉じた薄い笑み。大きく笑わない |
| surprised | `surprised, slightly widened eyes, slightly open mouth, looking at viewer,` | 1031031 | 目が少し開き、口がわずかに開く。もう1枚は驚きが強すぎる |
| thinking | `thoughtful, looking to the side, finger to chin,` | 1031040 | 横目と顎に添えた機械の手。顔を隠さない |
| worried | `worried, slightly furrowed brow, looking at viewer,` | 1031050 | 眉の内側が少し上がる |
| sad | `sad, looking down, slight frown,` | 1031061 | 伏し目と下がった口角。正面に近い |
| sleepy | `sleepy, half-closed eyes, drowsy, head tilt,` | 1031071 | 片目が落ちかけ、首が傾く |
| angry | `angry, (v-shaped eyebrows:1.4), (glaring:1.2), narrowed eyes, frown, clenched teeth, looking at viewer,` | 1031120 | 内に下がった眉、睨む目、食いしばった口元 |

### angry

最初の `annoyed, slight frown, furrowed brow, glaring` では怒りが弱く、`angry, furrowed brow, glaring, frown, clenched teeth` では眉が上がって困り顔に見えました。
眉の向きを強め、Negative の末尾に `worried, sad, upturned eyebrows, tears` を足して、困り顔の眉に戻らないようにしています。
通常の画像生成用の `sdctl-params.yaml` の Negative は、アキと同じ値のままです。

### 切り出し

9枚とも、両目の間隔が一辺の約36%、目の高さが上から40%になる正方形で切り出しました（顔の大きさは angry に合わせています）。
laughing は目を閉じているので、並べて見て顔の幅がそろうように一辺を決めました。
同じ切り出しから、512×512 の WebP（quality 90、method 6）と 256×256 の RGB PNG を LANCZOS で作っています。表示用の画像には生成メタデータを引き継いでいません。

座標は元の1024×1024の上の左・上・一辺です。

| 表情 | 左 | 上 | 一辺 |
| --- | ---: | ---: | ---: |
| neutral | 154 | 176 | 721 |
| happy | 158 | 195 | 707 |
| laughing | 120 | 128 | 805 |
| surprised | 148 | 145 | 707 |
| thinking | 177 | 190 | 680 |
| worried | 160 | 173 | 735 |
| sad | 140 | 186 | 721 |
| sleepy | 116 | 185 | 749 |
| angry | 85 | 181 | 860 |

## 外見

トリガー語 `penelope` だけで、白い長髪と水色のインナーカラー、目にかかる前髪、光る水色の目と眠たげな目、薄いそばかす、口元のほくろ、
金色のヘッドセット、首の金属の輪、白と黒の機械の体、白いフリルの袖が毎回出ることを確かめました。
上半身・顔・全身・私服（白い T シャツとジーンズ）・`android` を外したもの、の5通りを2枚ずつと、表情18枚で、どれも欠けませんでした。
服を替えても、ヘッドセット・首の輪・機械の腕は残ります。

そのため `appearance.yaml` の `body` には特徴の語を足していません。`keep` は `penelope` と `android` です。
既定の服は `white mechanical body, white frills,`（白い機械の体とフリル）です。

## 性格・話し方

[personality.md](personality.md) は、本人の決めた点（寡黙、一つのことに熱中する、クラスターの保守への執着、本人を「マスター」と呼ぶ、オタク気質）をもとに書き、
本人の確認を経て直したものです。
常体の素っ気ない言い切りで話し、マスターにはあまり関心がなく、Slack などで周りがくだけていても口調を合わせません。

## 検査

`natsumi avatar check penelope` の結果は、errors none、埋めるものは `spritesheet` だけ、サーバーの既定は `pet.json` だけです。

## ライセンス

このディレクトリの画像と定義は [Creative Commons Attribution 4.0 International（CC BY 4.0）](https://creativecommons.org/licenses/by/4.0/) で提供します。
コードの MIT ライセンスとは別です。帰属表示は「ペネロペのアバター — yuanying / natsumi」とし、このディレクトリとライセンスへのリンクを添えてください。
表情の出どころは Anima と LoRA `penelope_natsumi_anima.v2` です。
