# F02. fork: Slack の投稿を Slack で承認する

- Date: 2026-09-28
- Status: Accepted（この fork だけの決定）

## Context

ポッポさんが本人に回した下書き（`to_owner`）は承認待ちになり、本人は iPhone のアプリの `approval.decide` で決める
（[ADR 0040](0040-the-dove-sends-what-the-judge-passes.md)、[ADR 0041](0041-approving-slack-posts-on-the-iphone.md)）。
この fork の本人は iPhone も Mac も持たないので、承認待ちは誰にも見られないまま `slack.approvalExpiryDays` で期限切れになる。
本人と natsumi の会話は、すでに Slack にある（[ADR F01](F01-fork-talking-with-the-owner-in-a-slack-channel.md)）。

## Decision

- `slack.owner` があるとき、承認待ち（`approval.pending`）ごとに、そのワークスペースの本人と bot の DM（`conversations.open`）へ、Block Kit のメッセージを 1 通投稿する。
  中身は投稿先（スレッドかどうか）・返信先・下書き・判定の理由（verdict と flagged の問題点、突き返された回数）・画像の枚数・期限と、「送る」「見送る」のボタン。
  Slack と natsumi から来た文字はすべて `plain_text` で出し、mrkdwn として読ませない。期限は Slack の日付書式で、見る人のタイムゾーンで出る。
- ボタンの `value` は承認の ID。押されたことは Socket Mode の `interactive`（`block_actions`）で届く。
  押したのが `slack.owner.userId` で、承認のメッセージそのものへの操作のときだけ、`SlackDove.decide`（`approval.decide` が呼ぶのと同じもの）を `deviceId: 'slack'` で呼ぶ。
  送る・送る前の検査・記録・natsumi への知らせは、上流のまま変えない。本人以外が押したら何もせず、ID を含まない 1 行をログに出す。
- 決まったら（Slack からでも、iPhone からでも、期限切れでも）、`approval.resolved` を聞いて `chat.update` でボタンを外し、送った・見送った・期限切れ・送れなかった（理由の種類）に書き換える。
  既に閉じた承認のボタンが押されたときも、書き換えるだけにする。
- どの承認をどのメッセージにしたかは、fork だけの表 `fork_slack_approval_messages` に持つ。番号付きの migration ではなく、起動時に `CREATE TABLE IF NOT EXISTS` で作る。
  起動時には、まだ投稿していない承認待ちを投稿し、止まっていた間に閉じた承認のメッセージを書き換える。
- Slack App には Interactivity（`settings.interactivity.is_enabled: true`、Socket Mode なので Request URL なし）と `im:write` を足す。`chat.update` は `chat:write` で足りる。

退けた案:

- **`approvals` に列を足す migration**: 上流が次の migration を足したとき、番号がぶつかる。承認の表も上流のものなので、fork の都合で形を変えない。
- **ボタンの処理で送る**: 送る道がもう 1 つでき、検査や記録が上流とずれる。`decide` を呼ぶだけにする。

## Consequences

- 本人は Slack だけで承認できる。iPhone のアプリも、これまでどおり使える（先に決めた方が通る）。
- 直してから送る（`edit`）はまだできない。見送って natsumi に頼み直す。modal で直せるようにするのは後の仕事。
- 承認のメッセージは bot の DM の発言なので、ほかの発言と同じくファイルに残り、natsumi も読める。
- 投稿や書き換えに失敗しても、承認そのものは変わらない（ログに 1 行出す）。投稿に失敗した承認は、次の起動で投稿し直す。
