# 0087. サブスクリプションの経路を標準の Responses API に移し、loopback の中継越しにも使えるようにする

- Date: 2026-10-30
- Status: Accepted

## Context

ChatGPT のサブスクリプションの経路は、Pi の provider `openai-codex` を使っていた（[ADR 0004](0004-pi-tool-and-voice-boundaries.md)）。
`openai-codex` は Pi では legacy の扱いである。宛先は Codex 専用の口で、token の中身からアカウントの ID を読んでヘッダに付け、既定では WebSocket を先に試す。

Pi 1.4.0 には、もう 1 つ provider `openai` がある。

- 宛先は標準の OpenAI API の Responses API（`https://api.openai.com/v1`）で、転送は SSE だけである。
- 認証は「Sign in with ChatGPT」の OAuth の access token を、API キーと同じ `Authorization: Bearer` に置く。Pi の `/login` で選べる。
- API キー（`sk-` で始まるもの）でも通る。Pi は、宛先が公式の base で、鍵が `sk-` で始まらないときだけ、それを ChatGPT のサインインとみなす。
  サインインとみなしたときだけ、サインインが断る欄（`prompt_cache_retention` など）と、要求の途中で思考の強さを変える項目（`configuration_update`）を送らない。

本人は、インスタンスごとにサブスクリプションへログインするのを面倒に感じていた。
ログインの refresh token は 1 回きりなので、ログインのファイルを写すと片方が切れる。
そこで、token を 1 か所だけで持ち、Bearer を付け替えて Responses API へ素通しする Proxy を、natsumi の外に立てることにした。
インスタンスは Proxy に直接は話さない。[ADR 0085](0085-relays-that-add-the-keys-for-the-workspace.md) の形の loopback の中継に平文で話し、
中継が Kubernetes の ServiceAccount の token を付けて、gated の後ろの Proxy へ HTTPS で送る。

宛先を中継に向けるのに Pi の base を中継の URL に変えると、Pi は鍵をサインインとみなさず、サインインでは断られる形で送ってしまう。
Pi は、provider の登録（`registerProvider`）で、その provider の要求の流し方（`streamSimple`）を差し替えられる。
差し替えた流し方に渡す options には `fetch` があり、Pi はそれを OpenAI のクライアントにそのまま渡す。

設計は本人との問答で決めた。

## Decision

### サブスクリプションの経路は `openai` にもできる。直接ならログインで使う

- 経路の model に `{ "provider": "openai", "id": "gpt-6.1-sol" }` のように書ける。設定の検査は、互換でない provider と同じく、ログインで使う経路として読む。
- 直接の `openai` は、今のサブスクリプションと同じく `pi.authPath` の OAuth のログインだけを使う。環境の API キーを代わりに使うことはない（ADR 0004 のまま）。
- ログインは、Pi の CLI の `/login` で「Sign in with ChatGPT」を選ぶ。Pi はログインを provider ごとに持つので、`openai-codex` のログインは `openai` には使えない。
  切り替えるときは、同じ `authPath` にもう一度ログインする。`openai-codex` のログインは消えずに残る。
- `openai-codex` の経路はそのまま使える。どちらを使うかは、経路の provider で選ぶ。

### 中継越しの経路は、経路に `relay` を足す

```json
"plus": {
  "model": { "provider": "openai", "id": "gpt-6.1-sol" },
  "relay": { "url": "http://127.0.0.1:18080" }
}
```

- `relay.url` は loopback（`127.0.0.0/8`・`::1`・`localhost`）の `http` の origin だけを受ける。パス・query・認証情報は書けない。
  TLS と、外への認証は中継の仕事である（ADR 0085）。
- `relay` を書けるのは provider `openai` の経路だけである。Pi は provider ごとに 1 つの流し方しか持てないので、
  `openai` の経路を 2 つ以上並べるときは、全部をログインで使うか、全部を同じ中継で使うかのどちらかにする。混ぜた設定は起動を止める。
- 単一の経路の設定（`pi.model`）では `pi.relay` に書く。

### 中継越しのとき、natsumi は宛先だけを書き換え、鍵はダミーにする

- Pi の base は公式の `https://api.openai.com/v1` のままにする。natsumi は provider `openai` の流し方を差し替え、
  Pi の Responses API の実装に、宛先だけを書き換える `fetch` を足して渡す。要求の本文とヘッダは Pi が作ったままである。
- `fetch` は `https://api.openai.com` への要求を、同じパスと query のまま中継の origin へ送る。ほかの宛先への要求は断る。
- 鍵は、秘密ではない決まった値を Pi の runtime の鍵として渡す。`sk-` で始めない。これで Pi は鍵をサインインとみなし、断られる欄を外す。
  中継はこの `Authorization` を捨てる。本物の token は Proxy だけが持つ。
- 中継越しの経路のために `pi.authPath` のログインは読まない。ほかにログインで使う経路が無ければ、ファイルを開きもしない。
- 中継越しの経路は、いつも「使える状態」として扱う（鍵は必ずある）。中継や Proxy が止まっていれば、そのターンのモデルの呼び出しが失敗する。
  ほかの経路には落とさない（ADR 0004）。

### prefix cache と思考の続きが保たれる理由

- 本文は Pi が作ったまま中継と Proxy を素通しする。prefix cache の鍵 `prompt_cache_key` と `session_id` のヘッダは session の ID から Pi が付ける。
  cache が効くかは OpenAI の側でこの鍵と本文の先頭で決まり、natsumi が宛先の名前を書き換えても変わらない。
- 思考の続きは、サーバーに何も残さない形（`store: false`）で、暗号化された思考を受け取り（`include: ["reasoning.encrypted_content"]`）、次の要求で返すことで保たれる。
  これも本文の中だけで完結する。
- 直接と中継越しは、provider・API・model が同じなので、どちらに切り替えても Pi は前の思考を暗号化されたまま返す。
- `openai-codex` から `openai` に移るのは provider の変更である。移った最初のターンだけ、前の思考は平文になり、prefix cache も一から温まる（[ADR 0046](0046-named-model-routes-switched-by-hand.md) の切り替えと同じ）。
- system prompt とツールの説明は経路に依らない（[ADR 0019](0019-a-workspace-not-a-memory-tool.md) の固定のまま）。

### 窓が小さくなるので、閾値を確かめる

- Pi のモデル定義では、`openai` の `gpt-6.1-sol` の窓は 272000 tokens、`openai-codex` の同じモデルは 500000 tokens である。
- 窓と compaction の閾値の検査は、今のサブスクリプションと同じく、サーバーの起動時に Pi の窓で行う。
  閾値に 53248 tokens（1 ターンの伸び・1 回の返事の上限・Pi の余白）を足した量が窓を超えると、起動を止める。
  `openai` の `gpt-6.1-sol` では、経路の `compactionThreshold` は 218752 以下にする。既定の 60000 は通る。
  `openai-codex` の窓に合わせて閾値を上げていた経路は、移すときに下げる。

### 戻し方

- 中継越しから直接へ: 経路の `relay` を消し、`authPath` に「Sign in with ChatGPT」でログインして起動し直す。
- `openai` から `openai-codex` へ: 経路の provider を `openai-codex` に戻し、閾値を必要なら戻して起動し直す。`openai-codex` のログインが切れていなければ、そのまま使える。
- 起動し直さずに戻したいときは、両方の経路を並べておき、ADR 0046 の手の切り替えで選ぶ（ただし `openai` の経路どうしは同じ通り方に揃える）。

## Alternatives

- **Pi の base を中継に向け、中継か Proxy が断られる欄を外す**: Proxy が Pi の要求の形を知ることになり、Pi の版上げで壊れうる。素通しでなくなる。
- **natsumi が Pi の payload の加工の口で欄を外す**: natsumi に Pi の内部の事情が入るうえ、Pi がサインインとみなしたときの振る舞い（ほかの欄の扱い）を natsumi が追いかけることになる。
- **中継を名前で透過にする（作業環境からは `api.openai.com` のまま、出口で TLS を終端して付け替える）**: 私設の CA が要る。ADR 0085 で「将来」とした形である。
- **Pi に「base を変えてもサインインとして扱う」設定を足してもらう**: 待つことになる。足されたら、こちらの差し替えをやめられる。
- **中継越しの経路に別の provider の名前を付ける**: Pi のサインインの判定は provider が `openai` のときだけなので、断られる形になる。直接との間で思考の続きも切れる。

## Consequences

- インスタンスはサブスクリプションへのログインを持たずに、Proxy の 1 つのログインでサブスクリプションを使える。
- natsumi は、Pi の 2 つの振る舞いに依る。サインインの判定（provider が `openai`、base が公式、鍵が `sk-` で始まらない）と、差し替えた流し方の options の `fetch` が OpenAI のクライアントに届くことである。
  どちらも、偽の中継に向けたテストで、本文の欄（`prompt_cache_key` があり、`prompt_cache_retention`・`configuration_update` が無い）・ダミーの鍵・書き換わった宛先・2 ターン目に戻る暗号化された思考として確かめる。Pi の版上げで変われば、このテストが落ちる。
- 中継か Proxy が止まると、その経路で話せない。互換の経路への手の切り替えは残る。
- 評価のモデルのファイル（[ADR 0051](0051-evaluating-one-turn-on-the-real-path.md)）は、中継越しの経路を受けない。直接の `openai` は受ける。
- Proxy・中継・配置は natsumi の外で決める。
