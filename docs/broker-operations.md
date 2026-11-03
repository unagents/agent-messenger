# broker の運用

## fallback broker と client の再解決（0.7.0〜）

- 解決順 4 番目の `127.0.0.1:7901`（client が自動起動するローカル broker）は fallback broker（`AGENT_MESSENGER_FALLBACK=1`）として起動する。`/health` と発見応答に `"fallback": true` が付く。常設 broker は付かない。
- fallback broker は `AGENT_MESSENGER_FALLBACK_INTERVAL_MS`（既定 10 秒）ごとに UDP 発見で他の broker を探す（`AGENT_MESSENGER_DISCOVERY=off` なら探さない）。自分自身と別の fallback は対象外。本来の broker が見つかると、未配信メッセージを `POST /relay-messages` で転送してから自己終了する。転送が失敗したら終了せず次の周期で再試行する。
- `/relay-messages` は宛先を peer の名前（+ホスト名）で指定する。受け側は登録済みの該当 peer にすぐ配信し、まだ登録されていなければ保留（state file の `pending`、TTL 1 時間）して、その名前の peer が登録または改名した時点で配信する。名前の無い peer 宛は届けられず破棄する。`/relay-messages` を知らない旧 broker（404）には `/send-message` で名前宛に送る（登録済みの peer にのみ届く）。
- client は broker に繋がらなくなると、同じ URL を猶予（`AGENT_MESSENGER_GRACE_MS`、既定 30 秒）の間再試行し、過ぎたら broker を再解決する（env → config → 発見 → ローカル fallback 起動。成功まで最大 5 秒間隔）。fallback が自己終了した後も同じで、猶予後に本来の broker へ戻って再登録する。heartbeat が拒否された場合は猶予なしで再解決し、再登録する。
- 発見結果は fallback でない broker を優先して並べる。

## 常設 broker メッシュ（0.11.0〜）

常設 broker を複数台（例: 拠点ごとに 1 台）置く場合に相互同期し、どの broker に繋いだ peer からも `list_peers` で全ホストの peer が見えるようにする。

- 参加するのは `AGENT_MESSENGER_MESH=on` で起動した broker のみ。相手は設定ファイル無しで UDP 発見により見つける。fallback で自動起動された broker は `on` にしないので参加せず、`/mesh/sync` に 404 を返す。
- 同期は `POST /mesh/sync`（全 mesh broker が相互に送る）。自分に直接登録された peer を送り、相手の peer を受け取る。相手の peer 宛の未配信メッセージも一緒に転送し、相手が受理してから手元で破棄する。
- 片側が停止中でも、もう一方は送受信を続ける。停止側の peer 宛メッセージは手元に積まれ、復帰後の次の同期で届く。複製 peer は元 broker の同期が途絶えて `AGENT_MESSENGER_MESH_PEER_TTL_MS` 経つと消える。
- 相手の見つけ方: mesh broker は起動時に 1 回 probe し、以後 `AGENT_MESSENGER_MESH_ANNOUNCE_MS` ごとに UDP で自分を告知（announce）する。受けた broker は **同じ token の broker だけ**を相手にする。token は UDP に流さず、token を鍵にした HMAC で照合する。token が違う broker は相手にならない（broker ログに `token mismatch` を 1 回出す）。
- 相手の失効: announce が途絶えて告知間隔の 3 倍 + 5 秒を過ぎ、かつ直近の同期も失敗している相手を一覧から外す。UDP だけが落ちて同期が通っている間は残る。複製した peer の寿命（`AGENT_MESSENGER_MESH_PEER_TTL_MS`）とは別の時計。
- 自分自身は id で除外する。mesh broker ごとに `AGENT_MESSENGER_BROKER_ID` を別の値にする。
- 発見を使うので `AGENT_MESSENGER_MESH=on` では `AGENT_MESSENGER_DISCOVERY=off` にしない（相手を見つけられない。起動時に警告を出す）。UDP broadcast が届かない LAN は `AGENT_MESSENGER_DISCOVERY_TARGETS` で相手の発見ポートを明示する。
- 旧 broker の `config.json` の `brokers` を相手一覧として読む動作は廃止した（broker 側のみ。client の保存した接続先としては 0.12.0 まで読む）。
- クライアントの変更は不要。旧 client（0.6.3）はそのまま使える（`list_peers` は従来の peer 形式を返す）。
- 全 broker で `AGENT_MESSENGER_TOKEN` を同じ値にする（相手の照合と同期の認証に使う）。
- **混在注意**: メッシュ broker は同時に 0.11.0 以上へ上げる。0.11 の mesh broker は 0.10 の broker を発見で相手にしない（0.10 の応答に mesh の印が無いため）。0.10 側が config で 0.11 を指していれば 0.10 → 0.11 の同期だけ成立し、peer は両側に見えるが、0.11 から 0.10 側 peer 宛のメッセージは 0.10 を 0.11 に更新して次の同期が通るまで 0.11 側に保留される。
- 有効化は常設 broker の起動環境に `AGENT_MESSENGER_MESH=on` を足す（systemd なら `deploy/agent-messenger-broker.service` の該当行のコメントを外す）。

## broker の接続制御（0.11.0〜）

- `get_broker` は現在の接続先・決まり方・保存済み・発見中の broker を返す。発見は呼ぶたびに 1 回実行する。
- `set_broker(url, persist?)` の手順: 新 URL の `/health`（2 秒）→ 旧 broker の未読を手元へ退避（`check_messages` で読める）→ 旧 broker に unregister → 新 broker に名前・summary・protocol 宣言を引き継いで登録。新 broker に登録できなければ旧 broker へ戻す。
- 固定（pin）は `AGENT_MESSENGER_HOST` より優先する。固定先が落ちても猶予（`AGENT_MESSENGER_GRACE_MS`）の間は同じ URL を再試行し、猶予が尽きたら固定を外して通常の解決順で別の broker に移る。固定先が復帰しても自動では戻らない。
- `set_broker()`（url 省略）は固定を外して再解決する。`persist: true` を付けると保存した接続先（`client.json`）を書き換える（url 省略時は削除）。
- エラー: `INVALID_BROKER_URL` / `BROKER_UNREACHABLE`（変更なし）/ `BROKER_SWITCH_FAILED`（旧 broker に復帰）/ `BROKER_SWITCH_BUSY` / `SAVE_FAILED`（切替自体は成功）。
- ライブラリ: `MessengerClient.getBroker()` / `setBroker(url?, { persist? })`。Nuxt の `useMessenger()` からも同じ。
