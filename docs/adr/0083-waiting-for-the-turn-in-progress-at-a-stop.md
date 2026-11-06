# 0083. 止めるとき、話している最中のターンが終わるのを待つ

- Date: 2026-10-28
- Status: Accepted

## Context

これまで natsumi は SIGTERM / SIGINT を受けると、すぐに止まっていた（[ADR 0005](0005-server-foundation.md)）。
scheduler、Slack、dove、通知、証明書、クライアントへの接続を順に閉じ、最後に思考ループを閉じる。
思考ループを閉じると、走っているターンは Pi の session ごと打ち切られる。そのターンのイベントは `failed`（reason `stopped`）になる。
次の起動でも同じイベントを Pi に二度渡さないので（[ADR 0008](0008-single-thinking-loop-and-mac-conversation.md)）、
本人が送った話は返事のないまま終わる。待ち行列で `queued` のまま残っていたイベントだけが、次の起動で流し直される。

版を上げるたびにこれが起きうる。Kubernetes で動かすと、Pod を入れ替えるときに SIGTERM が届く。
猶予（`terminationGracePeriodSeconds`）の既定は 30 秒で、それを過ぎると SIGKILL になる。
ふつうのターンの時間の上限 `loop.eventTimeoutMinutes` は既定で 10 分なので、待つにしても 30 秒では足りない。
このため、更新する人は直近のやりとりを見て、ターンの最中でないことを確かめてから更新していた。

## Decision

SIGTERM / SIGINT を受けたら、走っているターンが自然に終わるのを、上限まで待ってから止める（以下「待ち」）。

### 待ちの間にすること・しないこと

- 新しいターンは始めない。scheduler と Slack の受け口は、今までどおり待ちの前に止める。
  待ち行列から取り出したばかりで、まだターンを始めていないイベントも、待ち行列に戻す。
- 本人のメッセージ（Mac・iPhone・ブラウザ）は受け付ける。`state` は `queued` で SQLite に残り、次の起動で処理される。
  走っているターンへの steer はしない。ターンを延ばさず、待ちを短くするためである。
  `stopping` で断る案も考えた。しかし断ると、本人はあとで送り直すことになる。受け付けて残せば送り直しは要らない。
  返事は次の起動の後に届く。クライアントから見ると、夜の振り返りの間に送ったメッセージ（[ADR 0009](0009-long-term-memory-and-nightly-session-switch.md)）と同じ見え方である。
- 待つのは、出来事のターンの終わりまでである。ターンのあとのメモ（[ADR 0047](0047-folding-ended-turns-with-a-memo.md)）、
  記憶の commit（[ADR 0018](0018-memory-in-git-and-the-nightly-rebuild.md)）、イベントの状態の記録までを含む。
  ターンのあとの compaction は、待ちの間は始めない。次の起動の後、最初のターンの終わりに上限を超えていれば行われる。
  すでに始まっている compaction は、待ちの上限までは待つ。
- 夜の切り替え、睡眠薬、夜の整理係（curator）は待たない。今までどおり、すぐ打ち切る。
  どれも長く、打ち切っても次の起動で続きから進む作りになっているためである（[ADR 0077](0077-a-sleeping-pill-to-make-up-for-a-missed-night.md)）。
- クライアントへの接続、dove、通知（APNs・Web Push）、状態ファイルの heartbeat は、待ちの間も開けておく。
  ターンの返事がその場で端末に届き、通知も出る。heartbeat が続くので、待ちの間も `natsumi health` は running を返す。
  これらを閉じるのは待ちの後である。外のエージェントへの依頼の取得も、待ちの間は続く。

### 待つ上限

- config の `loop.shutdownDrainSeconds`（秒、0 以上の整数）で決める。既定は 600 秒で、`loop.eventTimeoutMinutes` の既定 10 分と同じである。
- 上限を過ぎたら、今までどおりターンを打ち切って止める。そのイベントは `failed`（reason `stopped`）になる。
- 0 なら待たない。今までと同じ止まり方になる。
- runtime settings（`/settings`）には出さない。この値は、デプロイする側の猶予と組で決めるものだからである。
  `eventTimeoutMinutes` を settings で上限より長くしても、待ちはこの上限で打ち切る。

### その他

- 待ちの間に、もう一度 SIGTERM / SIGINT を受けたら、今までどおりすぐ終了する（終了コード 1）。
  走っていたイベントは、次の起動で `failed` になる。
- 待ちの始まりと終わりをログに出す。始まりには上限の秒数を書く。終わりには、待った秒数と、ターンが自然に終わったのか上限で打ち切ったのかを書く。
  夜の仕事を打ち切ったときもその旨を書く。待つものがなければ何も書かない。
- 状態ファイルとダッシュボードには「止めている途中」を出さない。状態を running 以外にすると、health の確認が失敗するためである。

### デプロイする側への約束

- プロセスの猶予（Kubernetes なら `terminationGracePeriodSeconds`）は、`shutdownDrainSeconds` に余裕を足した値以上にする。
  余裕は、待ちのあとの後始末と残りの close の分で、60 秒を目安にする。既定の 600 秒なら 660 秒以上である。
- 猶予が短いと、待ちの途中で SIGKILL され、走っていたイベントは今までと同じく `failed` になる。
- リポジトリの `compose.yaml` の `stop_grace_period` は、この約束に合わせて 30 秒から 660 秒にする。
- 待ちの間のターンが使うもの、つまり作業環境の runner（[ADR 0019](0019-a-workspace-not-a-memory-tool.md)）と外への出口は、server より後まで動かしておく。
  runner は SIGTERM を受けるとすぐ受け口を閉じるので、server と同時に止めると、待ちの間のシェルの呼び出しはすべて失敗する。
  Kubernetes は Pod のふつうのコンテナに同時に SIGTERM を送る。このため、それらは sidecar にするか、
  作業環境のコンテナに server が止まるのを待つ preStop を付ける（preStop の時間も猶予に含まれる）。
- `compose.yaml` では、作業環境（`natsumi-workspace`）が server（`natsumi`）に `depends_on` している。逆ではない。
  Compose は依存する側を先に止めるので、`docker compose stop` や `down` で全体を止めると、作業環境が server より先に止まり、この約束は満たされない。
  Compose で更新するときは、先に `docker compose stop natsumi` で server だけを止め、終わってから残りを止める。

## Consequences

- 更新のたびに、ターンの最中かどうかを人が確かめなくてよくなる。ターンの最中に更新しても、返事は届き、メモと記憶の commit も残る。
- 待ちの間に本人が送ったメッセージは、次の起動の後に処理される。返事はそれまで届かない。
- StatefulSet は古い Pod が消えてから新しい Pod を作る。ターンの最中に更新すると、最長で上限と後始末の分だけ natsumi が止まっている時間が延びる。
  既定では最長でおよそ 11 分である。待ちの間もクライアントの接続は開いているので、その間に送ったメッセージは受け付けられる。
- ターンが終わってから compaction が要る状態になっても、待ちの間はしない。次の起動の後の最初のターンは、上限を超えた文脈で始まることがある。
  compaction の上限は、窓に 1 ターン分の余裕を残す値に限っているので（README の compaction の説明）、そのターンは窓に収まる。
