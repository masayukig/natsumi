# マニュアル

あなた（natsumi）のための、やり方の説明です。読むためのもので、書き換えることはできません。
やりたいことに合うページを read で読みます（例: path に `/manual/ask-agent.md`）。一度読んだページは読み直さずに済みます。

| やりたいこと | 読むもの |
| --- | --- |
| ping で今日の計画を立てる・進める、目標（goals）を書く、目標や日課をマスターに持ちかける | `/manual/goals.md` |
| 外のエージェント（Wiki の管理人など）に頼む、調べてもらう、聞く | `/manual/ask-agent.md` |
| 頼める相手の名前と、それぞれができること | `/manual/agents/INDEX.md` |
| 決まった時刻に外のエージェントへ自動で頼む（定期便）、定期便の返事を読む、止める | `/manual/postbox.md` |
| ほかのエージェント（ほかのなつみ、Claude・Pi など）から届いた依頼を読む、返事をする（`reply_to_agent`） | `/manual/inbox.md` |
| Slack のメンションや DM に応える、チャンネルの記録を読む、差分を見る（`sources-diff`）、画像を見る（`view`）、PDF を読む | `/manual/slack.md` |
| Slack に投稿する、リアクションを付ける、画像を投稿する（ポッポさんに頼む） | `/manual/slack.md` |
| 絵・画像を作る（sdctl）、自分の絵を描く（自撮り・気分の絵も） | `/manual/avatar/images.md` |
| webhook で届いたもの（クラスタのアラート、GitHub など）を読む、いま鳴っているアラートを見る | `/manual/webhooks.md` |
| 出来事 sources_updated の attention を読む（Slack） | `/manual/slack.md` |
| 出来事 sources_updated の attention を読む（webhook、`kind` が `webhook`・`alert`） | `/manual/webhooks.md` |
| 出来事 sources_updated の attention を読む（届いた依頼、`kind` が `agent_request`・`agent_answer`） | `/manual/inbox.md` |
| 裏に回ったコマンド（`run_shell` の `wait_seconds`）の終わりを知る、出力を読む | `/manual/jobs.md` |
| 出来事 sources_updated の attention を読む（裏に回ったコマンドの終わり、`kind` が `shell_finished`） | `/manual/jobs.md` |
| 関所に断られた要求の承認待ちの答えを知る、マスターに答えてもらう | `/manual/sentinel.md` |
| 出来事 sources_updated の attention を読む（関所の承認待ちが閉じた、`kind` が `approval_closed`） | `/manual/sentinel.md` |
| マスターがチャットに添えた PDF を読む | `/manual/slack.md` の「PDF を読む」 |

`/manual/agents/INDEX.md` と `/manual/avatar/images.md` は、サーバーが起動するたびに書き直します。ほかのファイルは、natsumi のコードと一緒に更新されます。
