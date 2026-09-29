# F01. fork: 本人と Slack のチャンネルで話す

- Date: 2026-09-28
- Status: Accepted（この fork だけの決定）

## Context

本人との会話は、Mac のクライアントの `conversation.send` と、返事のツール `reply_to_mac`・`notify_owner` でできている
（[ADR 0008](0008-single-thinking-loop-and-mac-conversation.md)、[ADR 0032](0032-talking-to-the-owner-as-often-as-she-likes.md)）。
Slack は読みもので、本人の発言も `attention` として届き、natsumi の Slack への投稿はポッポさんの判定と本人の承認を通る
（[ADR 0040](0040-the-dove-sends-what-the-judge-passes.md)、[ADR 0041](0041-approving-slack-posts-on-the-iphone.md)）。

この fork の本人は Mac も iPhone も持たない。判定のモデルも無いので、ポッポさんへの依頼はすべて承認待ちになり、承認する手段が無い。
本人が natsumi と話せる場所が無い。

## Decision

- 設定 `slack.owner`（`workspace`・`userId`・`channel`）があるとき、そのワークスペースの、本人の、そのチャンネル（スレッドを含む）と bot との DM での発言を、
  `conversation.send` と同じ `ThinkingLoop.send()` に渡す。本人との会話（`mac_message`）であり、`attention` にはしない。
  `requestId` は `slack:<チャンネル>:<ts>` にし、メンションと同じ印で 1 つの発言を 1 度だけ渡す。受け取りの `reaction` はメンションと同じく付ける。
  ファイルへの記録は変えない。編集と削除は会話に渡さない。
- natsumi の会話の発言（`conversation.message` のうち `role` が `natsumi` のもの、つまり返事と知らせ）は、ループの購読からそのチャンネルに `chat.postMessage` で投稿する。
  本人自身のチャンネルなので、判定も承認も通さない。アイコンはポッポさんと同じ `<publicOrigin>/avatar/<表情>.png`。
  返事の画像（[ADR 0045](0045-showing-the-owner-images-with-a-reply.md)）は、ポッポさんと同じ `uploadFiles` で本文をコメントにして上げる。失敗はログに 1 行出すだけにする。
- system prompt には、本人が Slack で読み書きしていることを固定の短い節として足す。ツールの名前は変えない。
- `slack.owner` が無ければ、上流と同じに動く。
- 追記: `slack.owner.username`（1〜80 文字、制御文字なし）があれば、本人のチャンネルへの `chat.postMessage` に `username` を渡し、`bots.info` のアイコンと違いボット名を上書きして出す（`chat:write.customize`、`icon_url` と同じ既得スコープ）。無ければ上流と同じくボットのプロフィール名。
- 追記: publicOrigin が LAN の中だけだと、Slack のサーバーは `icon_url` の `<publicOrigin>/avatar/<表情>.png` を取れず、アイコンが出ない。
  設定 `slack.avatarBaseUrl`（https だけ、末尾の `/` は落とす）があれば、ポッポさんの投稿と本人のチャンネルへの投稿は `<avatarBaseUrl>/<表情>.png` を使う。
  無ければ上流と同じ `<publicOrigin>/avatar`。置き場所は `assets/avatar` を公開したところならどこでもよい。
- 追記: 返事の画像を `uploadFiles`（files.uploadV2）で上げると、`icon_url` を渡す口が無く、Slack App の既定のアイコンで出る。App のアイコンは変えられない。
  そこで本人のチャンネルでは、画像をチャンネルに共有せずに上げ（`files.completeUploadExternal` に `channel_id` を渡さない）、
  その ID を `slack_file` で指す `image` ブロックを、本文の `section`（mrkdwn）の後ろに並べて、表情のアイコンの `chat.postMessage` 1 通で出す。
  上げた直後のファイルは Slack がまだ処理中で `invalid_blocks` と断られることがあるので、1 秒・2 秒おいて計 3 回試し、
  それでも通らなければ（ほかの理由で断られたときはすぐに）これまでどおり `uploadFiles` で本文をコメントにして上げ、ログに 1 行出す。ポッポさんの画像の投稿も、のちに同じ道にした（[ADR F03](F03-fork-icons-on-image-posts.md)）。

退けた案:

- **ポッポさんに本人のチャンネル向けの例外を足す**: 判定と承認の仕組みに fork の分岐が入り、上流に追いつくたびにぶつかる。
- **ツールの名前を変える（`reply_to_owner` など）**: prompt・eval・テストの広い範囲に差分が出る。

## Consequences

- 本人は Slack だけで natsumi と話せる。Mac と iPhone のクライアントも、これまでどおり使える（同じ会話が両方に出る）。
- 本人が画像だけを送った発言は会話に渡らない（`conversation.send` が本文しか持たないため）。DM ならこれまでどおり `attention` として届く。
- 本人の発言はファイルにも残るので、natsumi は `sources_updated` でも同じ発言を見る。prompt で、改めて返事をしなくてよいと伝える。
- 返事は `reply_to_mac` の答えの文で「本人の Mac に送りました」と言い続ける。
