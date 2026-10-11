# 0003. 自発的支援と外部連携の境界

- Date: 2026-09-14
- Status: Accepted（長期記憶の Markdown の形とツールは [ADR 0009](0009-long-term-memory-and-nightly-session-switch.md) で具体化、Wiki をマウントして読み書きし自動で commit/push する点は [ADR 0025](0025-talking-to-outside-agents-over-a2a.md) で置き換え。Gmail と Calendar を 15 分ごとに確認する点は、サーバーが定期確認を持たず、係のエージェントへの定期便として送る形に [ADR 0076](0076-a-postbox-for-requests-sent-on-a-schedule.md) で置き換え）

## Context

会話、長期記憶、時刻指定通知、定期確認からの提案を提供する。
本人のメール・予定・Wiki は非公開データであり、連携ごとに実行可能な操作を限定する。

## Decision

natsumi が SQLite を使って永続スケジューラーを持つ。
Gmail と Calendar は 15 分ごとに確認し、時刻指定リマインダーは独立した指定時刻に処理する。
Mac の画面や作業内容を常時収集しない。
ジョブは種類と予定実行時刻による一意キー、実行 lease、次回時刻を保存する。
再起動時の定期確認は取りこぼした回数分を連続実行せず最新の確認へまとめる。
期限を過ぎたリマインダーは遅延を示して一度通知待ちへ移す。
通知作成とジョブ完了は同じ SQLite transaction とし、外部処理の結果不明は別状態にする。

Gmail は読み取り専用で送信機能を提供しない。
Calendar は作成・変更を提案し、対象・時刻・タイムゾーン・変更前後など具体的内容への承認後に実行する。
削除と招待は無効とし、参加者変更、通知メール送信、副作用を伴う未対応の操作は実行前に拒否する。
書き込み権限を持つ Google credential はサーバー内に閉じ、Pi の会話モデルから直接扱わせない。
OAuth scope に加え、ツール境界でも操作を検証する。Pi に登録する Calendar ツールは提案だけとし、
承認済みの immutable revision を実行する処理はモデルから呼べない natsumi サービスに置く。

Wiki はローカル checkout を mount して読み書きする。
根拠と更新先が明確なら更新と自身の差分の commit/push を自動化できる。
不確実な根拠、矛盾、判断が必要な場合は本人に尋ねる。
対象 Wiki に実在する AGENTS.md / CLAUDE.md と対応スキルを参照し、
frontmatter、Wiki Link、関連ページ、index、追記 log の規約に従う。
日本語で記述し、`raw/` と `Permanent-Notes/` は読み取り専用とする。
既存のユーザー変更を混ぜない。公開範囲は既存値を維持し、新規・省略時は private とする。
公開範囲の変更は明示指示がある場合だけ行い、既存 public ページを自動で private に変更しない。
連携の開発試験は架空 fixture だけを使う。

長期記憶の Markdown は明示された記憶と重要情報の整理に使う。
会話全文の複製先にはしない。性格・話し方は同じ data directory の Markdown で調整する。
必要になった場合だけ private memory repository を別途作成する。

## Consequences

外部サービスへの書き込みは、承認 revision と実行内容の一致、対象の更新競合、結果不明からの照合を必要とする。
個人情報を含む設定、データ、ログ、秘密は公開コードの Git 管理から分離する。
Google 実データと個人 Wiki への書き込み試験はこの設計検証では行わない。
