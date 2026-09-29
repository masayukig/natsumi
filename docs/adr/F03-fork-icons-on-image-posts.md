# F03. fork: 画像の投稿にも表情のアイコンを出す

- Date: 2026-09-29
- Status: Accepted（この fork だけの決定）

## Context

ポッポさんの文だけの投稿と、本人のチャンネルへの投稿は、`chat.postMessage` の `icon_url` で表情のアイコンを出している
（[ADR 0040](0040-the-dove-sends-what-the-judge-passes.md)、[ADR F01](F01-fork-talking-with-the-owner-in-a-slack-channel.md)）。
画像の投稿は `uploadFiles`（files.uploadV2、[ADR 0044](0044-drawing-with-sdctl-and-posting-images.md)）で上げており、これには `icon_url` を渡す口が無い。
そのため #random などでは、画像の投稿だけ Slack App の既定のアイコンで出る。App のアイコンは変えられない。
本人のチャンネルの返事は F01 の追記で image ブロックに変えたが、ポッポさんの投稿は `uploadFiles` のままだった。

## Decision

- 画像のある投稿は、本人のチャンネルでもポッポさんでも、同じ 1 つの関数（`src/server/slack-images.ts` の `postWithImages`）で出す。
  画像をチャンネルに共有せずに上げ（`files.completeUploadExternal` に `channel_id` を渡さない）、
  本文の `section`（mrkdwn）と、その ID を `slack_file` で指す `image` ブロックを並べて、表情のアイコンの `chat.postMessage` 1 通で出す。
- ポッポさんは、文だけの投稿と同じ `icon_url` を使い、スレッドに置くときは `thread_ts` をそのまま渡す。`username` は渡さない（App の名前で出る）。
- `invalid_blocks` は 1 秒・2 秒おいて計 3 回試し、それでも通らなければ（ほかの理由で断られたときはすぐに）これまでどおり `uploadFiles` で本文をコメントにして上げ、ログに 1 行出す。
  共有しないアップロードそのものが断られたときは、これまでの `uploadFiles` の失敗と同じく届けられなかったことになる。
- ポッポさんは投稿の ts を記録しないので（Slack が受けたかどうかだけを見る）、どちらの道でも送った扱いは変わらない。

退けた案:

- **ポッポさんと本人のチャンネルで別々に書く**: 同じ再試行と代わりの道が 2 か所に分かれ、片方だけ直す事故が起きる。

## Consequences

- 画像の投稿も、文の投稿と同じ表情のアイコンで出る。代わりの道に落ちたときだけ、これまでどおり App のアイコンになる。
- 上流の `dove.ts` への差分は、画像を上げる 1 行を `postWithImages` の呼び出しに替えるところだけ。
- 上げた画像のファイルは、どのチャンネルにも共有されずに bot のものとして残る（代わりの道に落ちたときは、同じ画像がもう一度上がる）。
