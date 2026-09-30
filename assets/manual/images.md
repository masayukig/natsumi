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

{{defaults}}
- GPU は共有なので、数枚で決めます。
- プロンプトのタグは小文字、単語はスペースで区切ります。2 人以上なら、`On the left,` のような位置の言葉で人ごとに分けます。文では `she` でなく `the girl` と書きます。
- 強めたい語は `(smile:1.5)`。

{{self}}
