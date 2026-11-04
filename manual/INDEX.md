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
| マスターがチャットに添えた PDF を読む | `/manual/slack.md` の「PDF を読む」 |

`/manual/agents/INDEX.md` と `/manual/avatar/images.md` は、サーバーが起動するたびに書き直します。ほかのファイルは、natsumi のコードと一緒に更新されます。
