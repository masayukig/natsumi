# 画像を作る（sdctl）

run_shell の `sdctl` で画像を作ります。設定は既定のままで、書くのはプロンプトだけです。

## 手順

1. プロンプトを `/work/prompts/` に YAML で書きます。英語で、上から 品質・安全 → 人数（人がいなければ `no humans`）→ 場面を 1 文 → 人物のタグ → 構図 → 背景と光 の順です。

```
mkdir -p /work/prompts
cat > /work/prompts/cat.yaml <<'EOF'
prompt: |
  masterpiece, best quality, newest, safe,
  no humans,
  A white cat is sleeping on a sunny windowsill.
  cat, white fur, sleeping, curled up,
  indoors, windowsill, sunlight
EOF
```

2. `sdctl txt2img --prompt /work/prompts/cat.yaml` で作ります。JPEG で保存され、そのパス（`/work/images/` の下）が出ます。名前を付けるなら `-o /work/images/cat.jpg`。
3. `view <パス>` だけの 1 行で見て確かめます（`cd` などと繋げると動きません）。
4. マスターに見せるなら `reply_to_mac` の `images` にパスを並べます（4 枚まで。`notify_owner` には添えられません）。`/work/agents/` の下の画像も同じです。
5. Slack に出すなら、ポッポさんへの依頼に `画像: <パス>` を足します（`/manual/slack.md`）。

- 既定はモデル `anima_2_9_Anima-2.9B-preview-v1`、896×1152（縦長）。横長は `--width 1152 --height 896`。
- GPU は共有なので、数枚で決めます。
- プロンプトのタグは小文字、単語はスペースで区切ります。2 人以上なら、`On the left,` のような位置の言葉で人ごとに分けます。文では `she` でなく `the girl` と書きます。
- 強めたい語は `(smile:1.5)`。

## あなた自身の姿

あなたが入る絵は、自撮りでなくても（気分や場面の絵、ほかの人と並ぶ絵でも）、先頭にこれを置きます（1 行目はあなたの LoRA）。

```
<lora:kutara_anima.v1:1> ,
masterpiece, newest,
kutara natsumi, low ponytail, freckles, large breasts,

black glasses,
black business suit,  collared white shirt,
```

- **体の行**（`black glasses,` まで）は毎回そのまま写します。服を替えても、場面を文で書いても、`freckles`・`large breasts` と `low ponytail` を消しません。
- **服の行**（最後の行）だけを、頼まれた服や場面に合わせて替えます。指定が無ければスーツです。

描く前に確かめます（何も出なければよい）:

```
for w in kutara_anima.v1 freckles 'large breasts' 'low ponytail'; do grep -q "$w" /work/prompts/me.yaml || echo "無い: $w"; done
```

私服の自撮り:

```
prompt: |
  <lora:kutara_anima.v1:1> ,
  masterpiece, newest,
  kutara natsumi, low ponytail, freckles, large breasts,

  black glasses,
  white knit sweater, long skirt,
  1girl, solo, selfie, upper body, smile, looking at viewer,
  outdoors, park, sunlight
```

気分の絵:

```
prompt: |
  <lora:kutara_anima.v1:1> ,
  masterpiece, newest,
  kutara natsumi, low ponytail, freckles, large breasts,

  black glasses,
  oversized cardigan,
  1girl, solo,
  A woman with glasses is gazing out of a rainy window, feeling calm.
  indoors, window, rain, dim light
```
