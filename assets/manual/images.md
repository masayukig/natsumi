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
4. マスターに見せるなら `reply_to_mac` の `images` にパスを並べます（4 枚まで。`notify_owner` には添えられません）。外のエージェントが返した画像（`/sources/agents/` の下）も同じです。
5. Slack に出すなら、ポッポさんへの依頼の `images` にパスを並べます（`/manual/slack.md`）。

{{defaults}}
- GPU は共有なので、数枚で決めます。
- プロンプトのタグは小文字、単語はスペースで区切ります。2 人以上なら、`On the left,` のような位置の言葉で人ごとに分けます。文では `she` でなく `the girl` と書きます。
- 強めたい語は `(smile:1.5)`。

## skill の sd-generate と合わせて読む

skill の一覧に `sd-generate` があれば、プロンプトの書き方、img2img・hires の使い方、params の YAML の形、モデルの系統ごとの値を調べるのに読んでかまいません。ただし、その skill は別の環境向けに書かれています。次のことは、このページに従います。

- 入れ方: `sdctl` は作業環境に入っています。skill の `go install` で入れ直しません。
- 接続先と設定: `sdctl` はいつも `/etc/sdctl/config.yaml` を読みます。接続先は中継、出力は `/work/images`、形式は JPEG、既定の params は `/manual/avatar/sdctl-params.yaml` です。`--config` も `SDCTL_URL` などの環境変数も付けません。skill に出てくる `http://localhost:7860` には届きません。`echo $SDCTL_PARAMS` で既定を確かめる手順も、ここでは何も出ません（既定はそのファイルにあります）。
- モデルの切り替え: `sdctl models set` は中継が断ります（403）。sd-webui はマスターも使っているので、全体の設定は変えません。モデル・VAE・text encoder は、生成ごとに `--model`・`--vae`・`--text-encoder` か、params の `override_settings` で指定します。一覧（`sdctl models list`・`sdctl modules` など）は使えます。
- params: 別の params のファイルを渡すと、既定の params とは合わさらず、丸ごと置き換わります。少し変えるだけならフラグ（`--steps` など）を足します。params ごと変えるなら、`/manual/avatar/sdctl-params.yaml` を `/work/prompts/` に写して直します。
- 枚数: skill の勧める `--batch-size 2` は付けません。GPU は共有なので、数枚で決めます。
- 保存先と名前: 出力は `/work/images/` の下です。`-o` で名前を付けるときは `.jpg` にします（skill の例の `.png` のままだと PNG で保存されます）。
- 見せ方: 画像を見る・マスターに見せる・Slack に出すのは、上の手順の 3〜5 のとおりです（`view`、`reply_to_mac`、`/manual/slack.md`）。

{{self}}
