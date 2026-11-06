# アキのアバター

組み込みのアバターです。config の `avatar.id` に `aki` を指定すると、名前と姿がアキになります。
ファイルの仕様は [アバターの作り方](../../../docs/avatar.md)、制作手順は [CLAUDE.md](../CLAUDE.md) を参照してください。

表情9枚は本人の確認済みです。spritesheet は全9動作の目視QAと機械検査を通しています。

直下の PNG は1024×1024の生成元で、`parameters` にプロンプトと seed を保存しています。
`icons/` は512×512 WebP、`slack/` は256×256 RGB PNGです。
`avatar.json` と `pet.json` は名前・動作・表情の定義、`appearance.yaml` と `sdctl-params.yaml` は描画の既定値を持ちます。
`personality.md` は性格・話し方の初期値で、本人が決めた文をそのまま写しています（記憶に性格がまだ無いときだけ使われます）。

## 表情の出どころと生成設定

sdctl と Stable Diffusion WebUI で生成しました。
モデルは `anima_2_9_Anima-2.9B-preview-v1`、LoRA は `kutara_anima.v12`（強度1、トリガー語 `kutara aki`）。
モデル hash は `0b3020d1b9`、LoRA hash は `81068aaf6f61` です。

- `sdctl-params.yaml` の設定で生成しました。Negative の末尾には `twins, duplicate, hood up` を加えています（`hood up` は表情の生成だけ）。
- **表情の生成時だけ width/height を1024に上書き**しました。自分を描く通常の既定値は896×1152のままです。
- ER SDE、beta、Steps 32、CFG 4、ADetailer `face_yolov8n.pt`（denoising 0.4、inpaint only masked）。
- モジュールは `qwen_image_vae.safetensors` と `qwen_3_06b_base.safetensors`。
- PNG の記録では Shift 3.5、beta の alpha/beta ともに0.6。これらは WebUI 側の設定に依存します。
- 各表情を2枚ずつ生成し、手が切り出しの枠に入らなかった happy・worried・angry は仕草を変えて生成し直しました。

伊織・ミャオの README と PNG の `parameters`、なつみの表情アイコン、[CLAUDE.md](../CLAUDE.md)・[アバターの作り方](../../../docs/avatar.md) を参考にしています。

### 構図と服

本人の指定で、なつみのアイコンのように顔を大きくし、頭の上部を切って、下に上着が見える構図にしました。
服は白いタンクトップから、薄いグレーのパーカー（フードは下ろす）に替えています。
なつみの表情のように、表情ごとに手の仕草を付け、仕草が正方形の枠に入るよう手を顔の近くに置いています。

### プロンプト

本人の LoRA・品質・外見の行を保持し、胸から上のポートレートでパーカーが見えることを明記しました。共通の形は次のとおりです。

```text
<lora:kutara_anima.v12:1>,
masterpiece, newest,
solo, single portrait,
A single portrait from the chest up. The face is large and centered, and the light gray hoodie is clearly visible on the shoulders and chest.
kutara aki, femboy, bob cut, freckles,
light gray hoodie, hood down,
<表情と仕草の行>
upper body, portrait, simple white background,
```

neutral だけは服を比べる段階で生成したため、最後の行に `facing viewer` が入り、Negative に `hood up` がありません。
表情の生成では `femboy` を使いました。PNG の `parameters` にもそのまま残っています。
自分を描くときの既定値である `appearance.yaml` の `body` では、本人の決定でこの語を `1girl` に替えています（`kutara aki, 1girl, black hair, bob cut, ...`）。

生成コマンドの形です。batch size 2 は採用候補を比較するための指定です。

```sh
sdctl txt2img '<上記プロンプト>' --params sdctl-params.yaml \
  -n '<既定のNegative>, hood up' \
  --width 1024 --height 1024 --seed <seed> --batch-size 2 -o <表情>.png
```

## 選定・切り出し・描き直し

| 表情 | 元seed | 表情と仕草の行 | 選んだ理由 |
| --- | ---: | --- | --- |
| neutral | 10031120（2枚目） | `neutral expression, closed mouth, looking at viewer,` | 正面の穏やかな顔で、フードの縁とひもの金具が見え、パーカーだとわかる |
| happy | 10031205（1枚目） | `happy, smile, one eye closed, peace sign next to own eye, v over eye, hand close to face, looking at viewer,` | ウインクとピースがはっきりし、ピースの指が枠に入る。頬に手を添える案・ひもをつまむ案より、うれしさが伝わる |
| laughing | 10031210（1枚目） | `laughing, closed eyes, open mouth, sleeves past wrists, sleeve covering mouth, hand near face,` | 閉じた目と大きく開いた口に、口元の手が添う |
| surprised | 10031220（1枚目） | `surprised, wide-eyed, open mouth, both hands raised beside face, open palms,` | 顔の横に上げた両手と見開いた目で驚きが明確 |
| thinking | 10031230（2枚目） | `thinking, index finger on own cheek, looking up, head tilt, closed mouth,` | 頬に当てた人差し指と首のかしげ方で考えている様子が伝わる |
| worried | 10031241（1枚目） | `worried, raised inner eyebrows, frown, both hands near own mouth, fingertips touching lips, looking at viewer,` | 口元に寄せた両手と上がった眉の内側で不安が伝わる。胸の前で指を組む案は手が枠の外に出た |
| sad | 10031250（2枚目） | `sad, looking down, teary eyes, sleeves past wrists, wiping tears with sleeve,` | うつむいて目元をぬぐう手と涙が、悲しさを表す |
| sleepy | 10031260（1枚目） | `sleepy, yawning, one eye closed, sleeves past wrists, rubbing eye with sleeve,` | あくびと目をこする手で眠さが伝わり、sad と区別できる |
| angry | 10031272（1枚目） | `angry, puffed cheeks, pout, furrowed brow, anger vein, both clenched fists raised beside own face, looking at viewer,` | ふくらませた頬と頬の横のこぶしで、むくれた怒りが伝わる。腕組みの案は腕が枠の外に出た |

`sleeves past wrists`・`with sleeve` を指定した表情も、描かれた手は素手です。

### 切り出しと i2i

元の1024×1024画像から下の正方形を切り出しました。
目の高さが枠の上から約45%、両目の間隔が枠の約35%になるよう、neutral に合わせて表情ごとに位置と一辺を決めています。
happy と angry は本人の確認で寄せ具合を決めました。happy は右端のピースが入るよう、顔を少し左に置いています。
切り出しを LANCZOS で1024×1024に拡大し、img2img で細部を再生成しました。

| 表情 | 左 | 上 | 一辺 | 元seed | i2i seed | denoising |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| neutral | 172 | 160 | 680 | 10031120 | 10031300 | 0.25 |
| happy | 244 | 80 | 780 | 10031205 | 10031310 | 0.25 |
| laughing | 130 | 67 | 795 | 10031210 | 10031320 | 0.25 |
| surprised | 175 | 116 | 709 | 10031220 | 10031330 | 0.25 |
| thinking | 68 | 89 | 838 | 10031230 | 10031340 | 0.25 |
| worried | 165 | 169 | 738 | 10031241 | 10031350 | 0.25 |
| sad | 213 | 189 | 680 | 10031250 | 10031360 | 0.25 |
| sleepy | 167 | 105 | 767 | 10031260 | 10031370 | 0.25 |
| angry | 72 | 104 | 880 | 10031272 | 10031380 | 0.25 |

i2i は1024×1024、denoising 0.25、batch size 1。プロンプトと Negative は元画像のものをそのまま使い、他の生成設定は `sdctl-params.yaml` のままです。
直下の PNG は i2i の結果で、`parameters` は i2i のものです。元seed の画像と i2i の入力画像は素材に含めていません。
i2i で surprised の瞳はわずかに緑がかった灰色になりましたが、本人の確認でそのまま採用しました。

```sh
sdctl img2img '<元画像のプロンプト>' <切り出しを1024に拡大した入力.png> \
  --params sdctl-params.yaml -n '<元画像のNegative>' \
  --width 1024 --height 1024 --denoising 0.25 --seed <i2i seed> --batch-size 1 -o <表情>.png
```

9枚の最終1024×1024画像から、512×512のWebP（quality 90、method 6）と256×256のRGB PNGへLANCZOSで直接縮小しました。
9枚を並べ、顔の大きさ・目の高さ・表情・手を目視確認しています。表示用画像には生成メタデータを引き継いでいません。

## 外見

描いた絵では黒いボブ、揃った前髪、灰色の瞳、頬と鼻のそばかすを確認しました。
`keep` の候補は `black hair`・`bob cut`・`gray eyes`・`freckles` の4語です。**本人の確認待ち**です。
描く前の確認で特徴の語を照合できるよう、どの語も `body` の体の行に含めています。
既定の衣装は表情に合わせて薄いグレーのパーカー（`light gray hoodie, hood down,`）です。描画例のうち夏の休憩は、白いタンクトップと青い短パンのままです。
`body` の人物の語は `1girl` です（表情の生成で使った `femboy` から替えています）。

## 性格・話し方

本人が決めた内容を [personality.md](personality.md) に写しています。
一人称「ぼく」、二人称「きみ」、やわらかく女の子っぽい話し方、素直で人懐っこく、かわいいと言われると照れる、という初期値です。

## アニメーション

Codex の hatch-pet と OpenAI の built-in 画像生成で制作しました。
spritesheet は表情をパーカーに替える前に作ったもので、白いタンクトップと青い短パンのままです。
先に生成した896×1152の neutral を参照に、白いタンクトップ・白縁の青い短パン・白いスニーカーの全身像を作り、共通の参照にしました。
各動作は共通の全身像と配置ガイドを添付して個別に生成しました。

動作とフレーム数は idle 6、running-right 8、running-left 8、waving 4、jumping 5、failed 8、waiting 6、running 6、review 6。
8列×9行、1コマ192×208、全体1536×1872、6fpsです。
右移動の歩幅変化と、左右で意味が変わる文字・小物が無いことを確認し、共有倍率で分離した各コマの反転から左移動を作りました。順序と縮尺は保持しています。
`running` は足をその場に置き、腰の前で片手の指をもう一方の手で数えて考えを整理する作業姿です。手の役割を各コマで保ち、顎に手を置く `review` と区別しています。

背景は #00FF00、背景除去の距離閾値は160。抽出は hatch-pet の `stable-slots` を使い、動作内で共通の倍率と縦位置を保っています。
ジャンプの上下動と、前屈時に体が大きくならないことを全コマで確認しました。
境界から4ピクセル以内で緑成分が赤・青の最大値を12より多く上回る画素だけ、緑成分をその最大値に合わせて背景色の縁を補正しました。アルファと内部の色は保持しています。
全9動作の確認画像とGIFを全コマ展開して、外見・衣装・縮尺・動き・全身の切れ・透過を目視確認しています。
未使用セルは完全透明、透明画素の隠れたRGB残留は0です。
機械検査の `stable-slots` に対する9件の目視確認要求は、すべて確認済みです。
確認用画像・GIF・採用しなかった候補はこの素材に含めません。

## 検査

最終の9枚が1024×1024、iconsが512×512 WebP、Slackが256×256 RGB PNGであることを検査しました。
Slack画像が生成元全体の LANCZOS 縮小と一致すること、PNG元画像に生成情報があり表示用には無いことも確認しています。
アバター全体を `natsumi avatar check aki` で検査し、errors・fills・server defaults がともに none であることを確認しました。
アバターの配布版は `62adb6650400b24d2a093ff37f4e7e66` です。

## ライセンス

このディレクトリの画像と定義は [Creative Commons Attribution 4.0 International（CC BY 4.0）](https://creativecommons.org/licenses/by/4.0/) で提供します。
コードの MIT ライセンスとは別です。帰属表示は「アキのアバター — yuanying / natsumi」とし、このディレクトリとライセンスへのリンクを添えてください。
表情の出どころは Anima と LoRA `kutara_anima.v12`、spritesheet の出どころは hatch-pet / OpenAI の画像生成です。
