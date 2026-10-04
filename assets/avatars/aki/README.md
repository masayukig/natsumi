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
モデルは `anima_2_9_Anima-2.9B-preview-v1`、LoRA は `kutara_anima.v6`（強度1、トリガー語 `kutara aki`）。
モデル hash は `0b3020d1b9`、LoRA hash は `9d800d85550e` です。

- `sdctl-params.yaml` の設定で生成しました。Negative の末尾には `twins, duplicate` を加えています。
- **表情の生成時だけ width/height を1024に上書き**しました。自分を描く通常の既定値は896×1152のままです。
- ER SDE、beta、Steps 32、CFG 4、ADetailer `face_yolov8n.pt`（denoising 0.4、inpaint only masked）。
- モジュールは `qwen_image_vae.safetensors` と `qwen_3_06b_base.safetensors`。
- PNG の記録では Shift 3.5、beta の alpha/beta ともに0.6。これらは WebUI 側の設定に依存します。
- 各表情を2枚ずつ、合計18枚生成し、外見・表情・仕草のある手の形で選びました。

伊織・ミャオの README と PNG の `parameters`、[CLAUDE.md](../CLAUDE.md)・[アバターの作り方](../../../docs/avatar.md) を参考にしています。

### プロンプト

本人の LoRA・品質・外見・衣装の行を保持し、顔が主役になるよう単一のポートレートと顔・肩だけの構図を明記しました。
余計な吹き出し・絵文字・隅の小顔を避けるため `icon` は使っていません。共通の形は次のとおりです。

```text
<lora:kutara_anima.v6:1>,
masterpiece, newest,
solo, single portrait,
A single close-up portrait. The face fills most of the square frame, with only the head and shoulders visible.
kutara aki, femboy, bob cut, freckles,
white tanktop, blue shorts,
<表情と仕草の行>
face close-up, headshot, portrait, simple white background,
```

表情の生成では `femboy` を使いました。PNG の `parameters` にもそのまま残っています。
自分を描くときの既定値である `appearance.yaml` の `body` では、本人の決定でこの語を `1girl` に替えています（`kutara aki, 1girl, black hair, bob cut, ...`）。

表情と仕草の行は各 PNG の `parameters` で確認できます。
happy は `happy, smile, playing with own hair, looking at viewer,`、thinking は `thinking face, hand on own chin, looking up,`。
**仕草はこの2枚だけ**です。ほかの7枚は手を出さず、顔と肩の構図です。

生成コマンドの形です。batch size 2 は採用候補を比較するための指定です。

```sh
sdctl txt2img '<上記プロンプト>' --params sdctl-params.yaml \
  --width 1024 --height 1024 --seed <seed> --batch-size 2 -o <表情>.png
```

## 選定・縮小

| 表情 | seed | 仕草 | 選んだ理由 |
| --- | ---: | --- | --- |
| neutral | 10030700 | なし | 閉じた口と穏やかな視線。白いタンクトップと肩が自然で、灰色の瞳・ボブ・そばかすが明瞭。 sleepyの顔幅と目の高さに合わせて切り抜き、i2iで細部を再生成。 |
| happy | 10030710 | playing with own hair | 髪先に添える指の形が読み取れ、柔らかい微笑みと仕草が両立する。 sleepyの顔幅と目の高さに合わせて切り抜き、i2iで細部を再生成。 |
| laughing | 10030720 | なし | 閉じた目と大きく開いた口が明確な笑いを表す。枠線の無い正面に近い顔。 sleepyの顔幅と目の高さに合わせて切り抜き、i2iで細部を再生成。 |
| surprised | 10030730 | なし | 見開いた目と開いた口で驚きが伝わり、顔の大きさが neutral に近い。 sleepyの顔幅と目の高さに合わせて切り抜き、i2iで細部を再生成。 |
| thinking | 10030740 | hand on own chin | 顎に添えた手と上向きの視線。指の曲がりが読み取れ、顔を隠しすぎない。 sleepyの顔幅と目の高さに合わせて切り抜き、i2iで細部を再生成。 |
| sad | 10030750 | なし | 下がった眉と視線・口角が悲しさを表す。白いタンクトップで余計な袖がない。 sleepyの顔幅と目の高さに合わせて切り抜き、i2iで細部を再生成。 |
| sleepy | 10030661 | なし | 半分閉じた目と傾いた頭で眠さを表し、sad の寄せた眉と区別できる。 |
| angry | 10030760 | なし | 寄せた眉と尖った口元が怒りを明確に伝える。 sleepyの顔幅と目の高さに合わせて切り抜き、i2iで細部を再生成。 |
| worried | 10030770 | なし | 上がった眉の内側、開いた目、下がった口角で不安が伝わり、sad と区別できる。 sleepyの顔幅と目の高さに合わせて切り抜き、i2iで細部を再生成。 |

### sleepy に揃える切り抜きと i2i

本人の指定により、sleepy を基準に顔の幅と目の高さを揃えました。
sleepy は生成元の1024×1024を保持し、ほかの8枚は下の正方形を切り抜き、LANCZOSで1024×1024に拡大して img2img で再生成しました。
上下位置を揃えるため、一部の切り抜きは上端が元画像の外に出ます。その部分は白で埋めています（負の「上」の絶対値が白い余白の高さ）。
座標はi2i前の1024×1024画像上のものです。i2i前の元画像と入力画像は素材に含めていません。

| 表情 | 左 | 上 | 一辺 | 元seed | i2i seed | denoising |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| neutral | 120 | -25 | 800 | 10030601 | 10030700 | 0.25 |
| happy | 65 | 5 | 790 | 10030611 | 10030710 | 0.25 |
| laughing | 10 | -105 | 1000 | 10030621 | 10030720 | 0.25 |
| surprised | 120 | -15 | 810 | 10030630 | 10030730 | 0.25 |
| thinking | 115 | -85 | 850 | 10030640 | 10030740 | 0.25 |
| sad | 200 | 123 | 655 | 10030651 | 10030750 | 0.25 |
| sleepy | 0 | 0 | 1024 | 10030661 | — | — |
| angry | 100 | 25 | 850 | 10030671 | 10030760 | 0.25 |
| worried | 100 | 25 | 830 | 10030681 | 10030770 | 0.25 |

i2i は1024×1024、denoising 0.25、batch size 1。他の生成設定（32 steps、CFG4、ER SDE/beta、モデル・モジュール・ADetailer）は `sdctl-params.yaml` のままです。
白一色の衣装にするため、8枚のi2iでは `white tanktop` を `plain white tanktop` に替え、Negative の末尾に `trim, piping, layered clothes` を追加しました。
通常の画像生成用 `sdctl-params.yaml` のNegativeは、`twins, duplicate` を足した値のままです。
顔中心の切り抜きで衣服はほとんど写りませんが、neutral・sadを含め表示画像に紺色の線はありません。写っているほかの衣服も確認しています。

```sh
sdctl img2img '<plain white tanktop に替えたプロンプト>' <切り抜きを1024に拡大した入力.png> \
  --params sdctl-params.yaml --width 1024 --height 1024 --denoising 0.25 \
  --negative '<既定のNegative>, trim, piping, layered clothes' \
  --seed <i2i seed> --batch-size 1 -o <表情>.png
```

9枚の最終1024×1024画像から、512×512のWebP（quality 90、method 6）と256×256のRGB PNGへLANCZOSで直接縮小しました。
9枚を並べ、顔幅・目の高さ・表情・手を目視確認しています。表示用画像には生成メタデータを引き継いでいません。

## 外見

描いた絵では黒いボブ、揃った前髪、灰色の瞳、頬と鼻のそばかすを確認しました。
`keep` の候補は `black hair`・`bob cut`・`gray eyes`・`freckles` の4語です。**本人の確認待ち**です。
描く前の確認で特徴の語を照合できるよう、どの語も `body` の体の行に含めています。衣装は白いタンクトップと青い短パンです。
`body` の人物の語は `1girl` です（表情の生成で使った `femboy` から替えています）。

## 性格・話し方

本人が決めた内容を [personality.md](personality.md) に写しています。
一人称「ぼく」、二人称「きみ」、やわらかく女の子っぽい話し方、素直で人懐っこく、かわいいと言われると照れる、という初期値です。

## アニメーション

Codex の hatch-pet と OpenAI の built-in 画像生成で制作しました。
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
アバターの配布版は `40aedb253698c13fdc716acc36c281da` です。

## ライセンス

このディレクトリの画像と定義は [Creative Commons Attribution 4.0 International（CC BY 4.0）](https://creativecommons.org/licenses/by/4.0/) で提供します。
コードの MIT ライセンスとは別です。帰属表示は「アキのアバター — yuanying / natsumi」とし、このディレクトリとライセンスへのリンクを添えてください。
表情の出どころは Anima と LoRA `kutara_anima.v6`、spritesheet の出どころは hatch-pet / OpenAI の画像生成です。
