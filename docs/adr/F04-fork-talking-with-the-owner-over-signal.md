# F04. fork: 本人と Signal で話す

- Date: 2026-10-02
- Status: Accepted（この fork だけの決定）

## Context

本人との会話と承認は、Slack のチャンネルと DM でできる（[ADR F01](F01-fork-talking-with-the-owner-in-a-slack-channel.md)、[ADR F02](F02-fork-approving-slack-posts-in-slack.md)）。
Slack を使わず、本人の私的な連絡手段である Signal で話したいインスタンスがある。Signal には bot の API が無いので、
natsumi の番号で登録した signal-cli を daemon として動かし、その JSON-RPC（`POST /api/v1/rpc`）と受信のイベント（`GET /api/v1/events`、SSE）を使う。

## Decision

- 設定 `signal`（`url`・`account`・`owner`・`approvals`）があるとき、本人の番号（`sourceNumber`）からの本文のある `dataMessage` を、`ThinkingLoop.send()` に `deviceId: 'signal'` で渡す。
  `requestId` は `signal:<timestamp>` にし、同じ発言は 1 度だけ渡る。既読・入力中・プロフィールキーの更新・本人以外の発言は捨てる。
  早い時期の受信には UUID が無いことがあったので、番号で見る。
- natsumi の会話の発言（返事と知らせ）は、ループの購読から `send` で本人に送る。返事は、答えたメッセージの端末が `signal` のときだけ送る（F01 の Slack と同じく、聞かれた場所で答える）。
  知らせと、どのメッセージにも答えていない返事も送る。Signal は本人の私的な場所なので、知らせが Slack と重なってもかまわない。Slack 側の動きは変えない。
  画像は data URI の添付で送り、断られたら本文だけ送り直す。
- `approvals: true` でポッポさんがいるときは、承認待ち（`approval.pending`）ごとに、F02 と同じ中身（投稿先・返信先・下書き・判定の理由・画像の枚数・期限）を本文にして 1 通送る。
  その発言への 👍 で承認、👎・❌ で見送り、引用した返信の「送る」「見送る」（`ok`・`no`）でも同じにし、`SlackDove.decide` を `deviceId: 'signal'` で呼ぶ。
  ほかの文の引用は、ふつうの発言として natsumi に渡す。Signal ではメッセージを書き換えられないので、決まったら（どこで決めても）結果を 1 行送る。
  先に決めた方が通るのは `decide` の条件付き更新のまま。
- どの承認をどの時刻の発言で送ったかは、fork だけの表 `fork_signal_approval_messages` に持つ。F02 と同じく、番号付きの migration ではなく起動時に `CREATE TABLE IF NOT EXISTS` で作る。
  起動時には、まだ送っていない承認待ちを送り、止まっていた間に閉じた承認の結果を送る。
- 受信のストリームが切れたら、1 秒から倍にして最長 1 分あけてつなぎ直す。daemon に届かなくても起動は止めない。
- `url` は https か、loopback の http だけ。signal-cli の HTTP には認証が無いので、同じ Pod のサイドカーで動かす前提にする。
- system prompt には、本人が Signal でも話すことを固定の短い節として足す。`reply_to_mac` の答えの文は、`slack.owner` が無く `signal` があれば「マスターの Signal」と言う。

退けた案:

- **Slack のコードを汎用の「本人の場所」に作り直す**: Slack の動きを変えずに済ませたい。Signal は Slack と並ぶもう 1 つの口として足す。
- **リアクションのたびに承認のメッセージを書き換える**: Signal にはメッセージの編集が無い（あっても、ほかの端末での見え方が揃わない）。結果は新しい 1 行で伝える。

## Consequences

- 本人は Slack なしで、Signal だけで natsumi と話せる。両方を設定すれば両方で話せ、返事はそれぞれ聞かれた方に出る。
- ポッポさんは Slack に投稿するものなので、`slack` の設定が無ければポッポさんも承認も無い。`approvals: true` でも何も送らず、起動時にログに 1 行出す。
- 本人が画像だけを送った発言は会話に渡らない。
- `slack.owner` と `signal` の両方があるとき、`reply_to_mac` の答えの文は Slack のチャンネルと言う（Signal に送った返事でも）。
