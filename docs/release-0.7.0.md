# リリース手順 0.7.0（broker fallback の後処理・client 再解決・常設 broker メッシュ）

0.6.x（protocol 0.6.1 / broker 0.6.1 / client 0.6.3 / cli 0.6.1）から、6 パッケージを 0.7.0 に揃えて上げる手順。基本の流れ（tarball 作成・Gitea Packages / Verdaccio・broker 切替・ロールバック）は `docs/release-0.5.0.md` と同じ。ここでは差分だけ書く。

| パッケージ | 置き場 | 0.7.0 |
|---|---|---|
| `@agent-hand/messenger-protocol` | Gitea Packages | 0.7.0 |
| `@agent-hand/messenger-broker` | Gitea Packages | 0.7.0 |
| `@agent-hand/messenger-client` | Gitea Packages | 0.7.0 |
| `@agent-hand/messenger-client-darwin-arm64` | Gitea Packages | 0.7.0（バイナリは Mac で build） |
| `@agent-hand/messenger-client-linux-x64` | Gitea Packages | 0.7.0 |
| `@agent-hand/messenger` | Verdaccio | 0.7.0 |

## 1. 変更点

### fallback broker の後処理と client の再解決（`feature/broker-fallback`）

- client が自動起動するローカル broker は fallback broker（`AGENT_MESSENGER_FALLBACK=1`）。`/health` と発見応答に `"fallback": true` が付く（任意フィールド。旧 client は無視）。
- fallback broker は `AGENT_MESSENGER_FALLBACK_INTERVAL_MS`（既定 10000）ごとに UDP 発見で他の broker を探す。本来の broker が見つかると未配信メッセージを `POST /relay-messages` で転送して自己終了する。転送が失敗すれば残って再試行する。常設 broker は自己終了しない。
- `/relay-messages` は宛先を peer の名前（+ホスト名）で指定する。登録済みならすぐ配信、未登録なら state file の `pending` に保留（TTL 1 時間）して、その名前の peer が登録または改名した時に配信する。名前の無い peer 宛は破棄。旧 broker（404）には `/send-message` で名前宛に送る。
- client は broker に繋がらなくなると同じ URL を猶予 30 秒（`AGENT_MESSENGER_GRACE_MS`）再試行し、過ぎたら再解決（env → config → 発見 → ローカル fallback）。fallback が終了した後も同様に本来の broker へ戻って再登録する。heartbeat 拒否は猶予なしで再解決する。発見結果は fallback でない broker を先に並べる。

### 常設 broker メッシュ（`feature/broker-mesh`）

- `AGENT_MESSENGER_MESH=on` で起動した broker のみ参加。相手は `AGENT_MESSENGER_CONFIG`（`~/.agent-messenger/config.json`）の `brokers`（毎回読み直す）。
- `POST /mesh/sync` で互いの直接登録 peer を複製し、複製 peer 宛の未配信メッセージを元の broker へ転送する（受理後に手元で破棄）。片側停止中も他方は動き、復帰後の同期で追いつく。複製 peer は `AGENT_MESSENGER_MESH_PEER_TTL_MS`（既定 300000）で消える。同期間隔 `AGENT_MESSENGER_MESH_INTERVAL_MS`（既定 5000）。
- mesh を有効にしない broker（fallback を含む）は `/mesh/sync` に 404 を返し、複製も受けない。mesh broker ごとに `AGENT_MESSENGER_BROKER_ID` を別にし、`AGENT_MESSENGER_TOKEN` を揃える。
- `list_peers` は従来の peer 形式のまま（`origin` は返さない）。client の変更は不要。

### 統合

- 両ブランチの衝突は broker の `config.ts` / `handlers.ts` / `http.ts` / `index.ts` / `state.ts`。どちらも追加のみだったため両方を残して解消した。`/mesh/sync` と `/relay-messages` は同じ POST ヘルパで登録。`isAlive` は mesh 側のインスタンスメソッドに合わせた。
- protocol: `RELAY_ROUTE`、`MESH_SYNC_ROUTE`、`Peer.origin`、`Message.mesh_key`、discovery / health の `fallback`（いずれも追加・任意。`BROKER_POST_ROUTES` と `ENV` は不変）。

## 2. tarball と publish の順序

```bash
npm ci && npm run build && npm run typecheck && npm test
PERRY_HOME=<perry> node scripts/build-native.mjs        # 実行したホストの platform（linux-x64 は 204、darwin-arm64 は Mac）
mkdir -p release/0.7.0
for p in protocol broker client client-linux-x64 cli; do npm pack --pack-destination release/0.7.0 ./packages/$p; done
```

e2e `scripts/e2e-mcp.mjs` の結果は `41 passed, 0 failed`（6 tool、pull の未読通知、push の本文配信の assertion に更新。2026-10-18）。

darwin-arm64 の tarball は、バイナリを持つ Mac で `client-darwin-arm64` を pack した時だけ作る（バイナリ無しの tarball は作らない）。

publish の順序（`docs/release-0.5.0.md` の 1 と同じ。**順序厳守**）: protocol → broker → client → client-linux-x64 →（client-darwin-arm64。tarball が届いていれば）→ CLI（Verdaccio）。CLI は core が Gitea Packages に揃ってから出す。Gitea Packages 側は必ず `env npm_config_@agent-hand:registry=http://192.168.1.202/gitea/api/packages/agent-hand/npm/` を付ける。手順書は `docs/history/20261015-release-0.7.0/publish-202.md`。

darwin-arm64 が後追いになる間、darwin ホストの CLI は platform package が取得できず node client に落ちる（`docs/release-0.5.0.md` 5 の動作）。

## 3. broker の更新

202 は systemd user unit `agent-messenger-broker`。

```bash
env XDG_RUNTIME_DIR=/run/user/1000 AGENT_MESSENGER_CORE_REFRESH=1 systemctl --user restart agent-messenger-broker
curl http://127.0.0.1:7901/health      # version 0.7.0
```

peer は heartbeat 拒否を検知して再登録する（再起動不要）。メッシュ（`AGENT_MESSENGER_MESH=on`）は常設 broker の 2 台目を置く時に unit へ追加する。0.7.0 の更新だけでは有効にしない。

## 4. 互換性

| 組み合わせ | 状態 | 根拠 |
|---|---|---|
| 新 client 0.7.0 ↔ 旧 broker（0.6.x） | 動く | 再解決は既存の `/health` / 発見のみ使う。`/relay-messages` を知らない broker は fallback 側が 404 を見て `/send-message` に切り替える（fallback report の Decisions） |
| 旧 client（0.6.3） ↔ 新 broker 0.7.0 | 動く | `list_peers` の形は不変。`fallback` / `origin` は任意フィールド。mesh の生存試験で 0.6.3 client が送受信・再同期できた（mesh report） |
| fallback 0.7.0 ↔ 旧 broker | 動く | 発見応答の `fallback` は任意。旧 broker は `fallback: true` を付けないので「本来の broker」として扱われる |
| mesh broker ↔ mesh でない broker | 同期しない | `/mesh/sync` は 404。互いに影響なし |
| 新 state file を旧 broker が読む | 可 | `pending` / `origin` は未知キーとして無視される（推測。未検証） |

## 5. ロールバック

`docs/release-0.5.0.md` の 5 と同じ。CLI の `latest` を 0.6.1 に戻し、broker は 0.6.1 に固定して再起動する。`pending` / `origin` を含む state file を旧 broker が読む場合の挙動は未検証。
