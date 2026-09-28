# OKD（okd-shiftlab）への配置

なつみを OKD の namespace `natsumi` で動かすためのマニフェストです（[ADR 0033](../../docs/adr/0033-running-on-kubernetes.md)、
[ADR 0034](../../docs/adr/0034-an-allow-list-for-the-way-out.md)）。sshd・A2A・APNs・sdctl の中継は入れていません。

| ファイル | 中身 |
| --- | --- |
| `scc.yaml` | SCC `natsumi`（UID 0〜1001、GID 1000、`NET_ADMIN` の追加だけ許す）。SA `natsumi` だけが使える。残るリスクはファイル先頭のコメント |
| `namespace.yaml` | Namespace、ServiceAccount（RBAC なし、token を載せない）、PVC `natsumi-data`（RWO、`ceph-rbd-shiftlab`） |
| `statefulset.yaml` | `natsumi-0`。init `egress-rules`（nft、root + `NET_ADMIN`）→ init `prepare-data` → `server`（UID 1000）と `workspace`（UID 1001、グループ 1000） |
| `service-route.yaml` | Service と Route `natsumi.apps.lab.igawa.io`（edge、LAN のみ） |
| `backup-cronjob.yaml` | `natsumi-backup-direct`（毎日 03:25 JST、`natsumi-0` と同じノード） |
| `config.json` | サーバーの設定。`configMapGenerator` で ConfigMap になる |
| `kustomization.yaml` | 上の一覧と、動かす版（`images[].newTag`） |

出口の規則は今は「UID 1000（サーバー）以外は、名前解決も loopback も含めて全部拒否」です。
サーバーはまだ無制限で、SNI の proxy（ADR 0034）は TODO として `statefulset.yaml` に残しています。

## 本人が手でやること（適用の前）

1. **image**: fork で版の tag（`v0.x.y`）を push し、`images.yml` が `ghcr.io/masayukig/natsumi` と
   `ghcr.io/masayukig/natsumi-workspace` を作るのを待つ（image 名は `github.repository_owner` から決まる）。
   ghcr の package は既定で private なので、**public にする**か、SA `natsumi` に pull secret を足す。
   版を上げるときは `kustomization.yaml` の `newTag`（2 か所、初版は `v0.1.9-mig.1`）を書き換える。
2. **GitHub OAuth App**: Homepage URL `https://natsumi.apps.lab.igawa.io`、
   callback URL `https://natsumi.apps.lab.igawa.io/auth/github/callback`。
   Client ID を `config.json` の `github.clientId` に、`gh api user --jq .id` の値を `github.allowedUserId` に書く。
   client secret は Vaultwarden の `OKD Secret: natsumi/natsumi-github`（フィールド `client-secret`）へ。
3. **Slack App**: [docs/slack-app.md](../../docs/slack-app.md) のとおり openstackwarrior に作り、bot を `#natsumi` に招待する。
   bot token（`xoxb-`）と app token（`xapp-`）は `OKD Secret: natsumi/natsumi-slack`（フィールド `bot-token` / `app-token`）へ。
   `#natsumi` のチャンネル ID（`C…`）と本人のユーザー ID（`U…`）を `config.json` の `slack.owner` に書く。
   **プレースホルダのままだと設定の検査で起動が止まる。**
4. **SCC と namespace**（cluster-admin で）:
   ```sh
   oc apply -f deploy/okd/scc.yaml
   oc apply -f deploy/okd/namespace.yaml
   ```
5. **Secret**（値は端末に出さない）:
   ```sh
   oc create secret generic natsumi-github -n natsumi \
     --from-file=client-secret=<(vaultwarden-safe-ops.py get-field 'OKD Secret: natsumi/natsumi-github' client-secret)
   oc create secret generic natsumi-slack -n natsumi \
     --from-file=bot-token=<(vaultwarden-safe-ops.py get-field 'OKD Secret: natsumi/natsumi-slack' bot-token) \
     --from-file=app-token=<(vaultwarden-safe-ops.py get-field 'OKD Secret: natsumi/natsumi-slack' app-token)
   ```
6. **backup の下準備**（`~/work-reports/k8s/direct-backup/rgw-provisioning/`。`setup-direct-backup.sh` の手順 1〜4 を個別に。
   手順 5 は work-reports 側のマニフェストを当てるので使わない）:
   ```sh
   oc -n natsumi import-image rclone:latest --from=docker.io/rclone/rclone --confirm
   ~/work-reports/scripts/rgw-safe-ops.py provision-user natsumi --apply          # okd-backup-natsumi(+:viewer)
   PUSH_URL=$(./uptime-kuma-push-monitor.py 'natsumi Direct Backup' --oc-context okd-shiftlab)
   ./make-direct-backup-creds.sh natsumi --backup-user okd-backup-natsumi --push-url "$PUSH_URL" --apply
   ./add-offsite-upstream.sh --app natsumi --apply    # と b2-offsite/cronjob.yaml の EXPECTED_APPS に natsumi
   ```
   バケット `natsumi-direct-backup` は rclone の初回書き込みで作られる。`system-overview.md` にも行を足す。

## 適用

```sh
oc apply -k deploy/okd
oc -n natsumi rollout status sts/natsumi --timeout=5m
```

### codex（ChatGPT のサブスクリプション）へのログイン（初回だけ）

サーバーは `auth.json` を作らないので、Pi の CLI で Pi 領域にログインする（README「モデルの経路を切り替える」）。

```sh
oc -n natsumi exec -it natsumi-0 -c server -- env HOME=/tmp PI_CODING_AGENT_DIR=/var/lib/natsumi-pi/agent \
  node /app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
# Pi の画面で /login → openai-codex
```

ブラウザの戻り先が `localhost` のポートなら、別の端末で `oc -n natsumi port-forward natsumi-0 <port>:<port>` をつなぐ
（未確認: Pi の codex ログインが待ち受けるポートと、URL を貼り付ける手段があるか）。
起動時に `auth.json` が無かったので、ログインしたら一度 `oc -n natsumi delete pod natsumi-0` で起動し直す。

## 確かめること

```sh
oc -n natsumi get pod natsumi-0 -o jsonpath='{.metadata.annotations.openshift\.io/scc}{"\n"}'   # natsumi
oc -n natsumi logs natsumi-0 -c egress-rules                                                   # 張った table が出る
oc -n natsumi exec natsumi-0 -c workspace -- id                                                # uid=1001 gid=1000

# 作業環境（UID 1001）からは出られない: どれも失敗する
oc -n natsumi exec natsumi-0 -c workspace -- python3 -c "import socket; socket.getaddrinfo('github.com', 443)"
oc -n natsumi exec natsumi-0 -c workspace -- python3 -c "import socket; socket.create_connection(('1.1.1.1', 443), 5)"
oc -n natsumi exec natsumi-0 -c workspace -- python3 -c "import socket; socket.create_connection(('127.0.0.1', 8080), 5)"

# サーバー（UID 1000）からは出られる: 200
oc -n natsumi exec natsumi-0 -c server -- node -e "fetch('https://api.github.com/').then(r => console.log(r.status))"

# runner とサーバーがつながっている
oc -n natsumi exec natsumi-0 -c workspace -- /usr/libexec/natsumi-workspace-runner check -socket /run/natsumi-workspace/runner/runner.sock
curl -sS -o /dev/null -w '%{http_code}\n' https://natsumi.apps.lab.igawa.io/

# backup を 1 回手で流す
oc -n natsumi create job --from=cronjob/natsumi-backup-direct natsumi-backup-manual
oc -n natsumi logs -f job/natsumi-backup-manual --all-containers
```

## restore（概略。最初の backup の後に実地で確かめる、ADR 0033）

1. `oc -n natsumi scale sts/natsumi --replicas=0`
2. SA `natsumi`・annotation `openshift.io/required-scc: natsumi`・UID/GID/fsGroup 1000 の使い捨て Pod で
   `natsumi-data` を `/pvc` にマウントし、rclone で
   `okd-backup-natsumi:natsumi-direct-backup/natsumi/mirror` → `/pvc` を `--metadata` 付きで戻す
   （UID 1000 では持ち主を 1001 に戻せないが、グループ 1000 と setgid が残れば両方が書ける）。
3. 戻したい日の `sqlite/state-<日時>.sqlite` を `/pvc/data/.natsumi/state.sqlite` に置き、
   同じ場所の `state.sqlite-wal` と `state.sqlite-shm` を消す。
4. 使い捨て Pod を消して `oc -n natsumi scale sts/natsumi --replicas=1`。

記憶は git の履歴も世代になる（`data/memory/.git`）。Pi の session は鏡だけ。
