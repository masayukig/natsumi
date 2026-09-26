# 0004. Pi のツール・認証・音声の境界

- Date: 2026-09-14
- Status: Accepted（思考ループに登録するツールは [ADR 0008](0008-single-thinking-loop-and-mac-conversation.md) で置き換え、記憶のツールは [ADR 0009](0009-long-term-memory-and-nightly-session-switch.md) で追加、「任意 shell を許可しない」は閉じ込めたコンテナの中に限り [ADR 0011](0011-memory-shell-in-a-confined-container.md) で置き換え、同僚へ話しかけるツールと同僚ごとのモデルの選択は [ADR 0012](0012-slack-and-colleagues.md) で追加・具体化、記憶の読み書きを独自ツールとする点は [ADR 0018](0018-memory-in-git-and-the-nightly-rebuild.md) で置き換え、Wiki の読み書きを独自ツールとする点は [ADR 0025](0025-talking-to-outside-agents-over-a2a.md) で置き換え、外の特化エージェントに頼むツールは同 ADR で追加、ネットワークの到達先制限は出口の許可リストとして [ADR 0034](0034-an-allow-list-for-the-way-out.md) で具体化、モデルの経路を名前付きで複数並べ、本人が手で切り替えることは [ADR 0046](0046-named-model-routes-switched-by-hand.md) で追加、「既定の read/bash/edit/write を有効にしない」は、作業環境の /manual と /memory に向けて範囲を絞った read だけを有効にする形に [ADR 0047](0047-folding-ended-turns-with-a-memo.md) で改め、Pi の拡張はコードから渡すものだけを読み込むことも同 ADR で追加。自動の fallback をしない点は変わらない）

## Context

Pi のツール登録とモデル認証は、外部サービスへの実行許可や OS の隔離を代替しない。
Calendar の承認をモデルが回避しない構成と、明示されていない API 課金を避ける構成が必要である。

## Decision

Pi SDK の `tools` allowlist を明示し、既定の read/bash/edit/write を有効にしない。
独自の `calendar_propose` は提案内容を natsumi の承認待ちに渡すだけで、Google の書き込み client を持たない。
承認後の Calendar executor は Pi の tool として登録せず、GitHub 認証済み本人の決定を検証するサービスに置く。
この PR のツールは架空の pending-approval 結果だけを返す fixture で、承認 DB や executor は後続実装である。

拡張・skills・prompt templates・context file の自動探索を無効にする。
本体では必要な memory/personality を natsumi が明示的に読み込む。
Wiki と記憶に必要な読み書きは、対象ルートと操作を制限する独自ツールとして後続実装する。
任意 shell、任意 HTTP、任意 credential 読み出しを許可しない。

ツールの非登録はプロンプト上の依頼より強い境界だが、Pi 自身が OS sandbox を提供するとは仮定しない。
実行プロセスは専用の非 root コンテナ/OS ユーザーで動かし、必要な volume だけを mount する。
Google の書き込み credential と executor はモデル実行側からアクセス不能な別権限/サービスに置く。
ネットワークの到達先制限とファイル権限はデプロイ側で実施し、SDK allowlist と別に試験する。

モデル接続は Pi の ChatGPT subscription provider `openai-codex` を使い、Plus 利用を優先する。
これは Pi 内の provider 名であり、別の coding-agent backend を導入するものではない。
本人が専用 Pi 領域で `/login` し、ハーネスはその authPath を直接参照する。
専用 credential の通常 OAuth refresh は許可し、既存の他ツールの認証を変換・コピーしない。
OAuth credential がない場合はモデル送信前に停止し、API key・別 provider への自動 fallback を行わない。
Pi の OAuth metadata だけでは Plus/Pro のプラン差は判定しない。
使用するモデルは provider と model ID の組で固定し、選べない場合は別モデルへ置き換えず停止する。

本人が管理する OpenAI 互換エンドポイント（例: llama.cpp）は、明示的に設定した場合だけ
`ModelRuntime.registerProvider` で Chat Completions の provider として登録する。
API key は設定ファイルに書かず、環境変数や secret mount から Pi が要求時に参照する。
平文 HTTP はループバックに限る。Plus 経路とこの経路の間で自動 fallback はしない。
これもモデル接続先の選択であり、バックエンドの差し替えではない。

音声は未対応・未検証として無効にする。Pi 採用だけで録音・再生・音声サービスを利用可能とはしない。
別の従量課金音声 API は導入しない。必要な方式・利用条件と Mac 上の入出力を確認してから別途判断する。

## Consequences

モデルが未登録 tool 名を要求しても実行できないことを実 SDK と fixture で試験する。
本体の承認前未実行・revision 照合・二重実行防止と OS 隔離は後続試験であり、この PR で動作済みとは扱わない。
検証バージョン、実測/未実施は [probe-results.md](../probe-results.md) に記録する。
