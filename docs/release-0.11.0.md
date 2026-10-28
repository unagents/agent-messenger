# リリース手順 0.11.0（broker 自律協調と接続制御）

0.10.0 から、7 パッケージを 0.11.0 に揃えて上げる手順。メッシュ broker が設定ファイル無しで互いを見つけて同期し、client はセッション内で接続先を確認・切替できるようにする（設計は `docs/design/broker-autonomy.md`）。基本の流れ（tarball 作成・broker 切替・ロールバック）は `docs/release-0.5.0.md`、`docs/release-0.8.0.md`、`docs/release-0.9.0.md`、`docs/release-0.10.0.md` と同じ。ここでは差分だけ書く。版の変更（各 `package.json` と `packages/client/src/version.ts`）はこの文書の対象外で、リリース時に別途行う。

| パッケージ | 置き場 | 0.11.0 |
|---|---|---|
| `@unagents/messenger-protocol` | npmjs | 0.11.0 |
| `@unagents/messenger-broker` | npmjs | 0.11.0 |
| `@unagents/messenger-client` | npmjs | 0.11.0 |
| `@unagents/messenger-client-linux-x64` | npmjs | 0.11.0 |
| `@unagents/messenger-client-darwin-arm64` | npmjs | 0.11.0（バイナリは Mac で build） |
| `@unagents/messenger-nuxt` | npmjs | 0.11.0 |
| `@unagents/messenger` | npmjs | 0.11.0 |

## 1. 変更点

### broker の自律協調

- メッシュ broker の相手探しを UDP 発見に一本化した。起動時に probe を 1 回送り、以後 `AGENT_MESSENGER_MESH_ANNOUNCE_MS`（既定 10 秒）ごとに announce を送る。client 用 `config.json` の `brokers` を相手一覧として読む動作は廃止した。
- 相手にするのは同じ token の broker だけ。token は UDP に流さず、token を鍵にした HMAC（`id` と `port` を含む）で照合する。announce は送信時刻が ±60 秒の範囲のものだけ受理する。
- 相手の失効は「announce 途絶（告知間隔の 3 倍 + 5 秒）かつ直近の同期失敗」。複製 peer の寿命（`AGENT_MESSENGER_MESH_PEER_TTL_MS`）は従来どおり別の時計。
- `AGENT_MESSENGER_MESH=on` で `AGENT_MESSENGER_DISCOVERY=off` の場合は起動時に警告を出す。
- `/health` と発見応答に `mesh: true`（メッシュ参加の broker のみ）。発見の probe は `n`、応答は `mac`、告知は `announce` パケット。旧 broker / 旧 client は未知の欄を無視する。
- `BrokerOptions.meshBrokers`（固定の相手一覧）は discovery を使わないテスト専用として残す。README には載せない。

### client の接続制御

- MCP ツールを 9 から 11 に増やした: `get_broker` / `set_broker`。`MessengerClient` に `getBroker()` / `setBroker(url?, { persist? })`、Nuxt の `useMessenger()` に同じ 2 メソッド、`/mcp` に 11 ツール。
- 解決順は「固定（`set_broker`）→ env → 保存した接続先 → 発見 → ローカル」。保存先は `~/.agent-messenger/client.json`（`AGENT_MESSENGER_CLIENT_STATE`）で、続けて旧 `config.json` の `brokers` と `options.brokers` を同じ扱いで試す。旧 `config.json` の読み込みは **0.12.0 で廃止予定**で、使うと 1 回警告をログに出す。
- `set_broker` は `AGENT_MESSENGER_HOST` より優先する。固定先が猶予（`AGENT_MESSENGER_GRACE_MS`）を超えて落ちたら固定を外して通常の解決に移り、復帰しても自動では戻さない。
- 発見結果は fallback でない broker、同条件なら mesh の broker を優先する。
- `ResolvedBroker.source`（ログ文字列）は据え置き、`kind`（`env` / `saved` / `discovery` / `fallback` / `set_broker`）を追加した。

### 新しい環境変数

| 変数 | 既定 | 内容 |
|---|---|---|
| `AGENT_MESSENGER_MESH_ANNOUNCE_MS` | `10000` | broker。announce の間隔 |
| `AGENT_MESSENGER_DISCOVERY_TARGETS` | なし | broker / client。発見の送信先を `host:port` のカンマ区切りで明示（broadcast の代わり） |
| `AGENT_MESSENGER_CLIENT_STATE` | `~/.agent-messenger/client.json` | client。保存した接続先 |

## 2. tarball と publish の順序

```bash
npm ci && npm run build && npm run typecheck && npm test
PERRY_HOME=<perry> node scripts/build-native.mjs        # 実行したホストの platform
node scripts/e2e-mcp.mjs                                # mesh シナリオを含む
mkdir -p release/0.11.0
for p in protocol broker client client-linux-x64 client-darwin-arm64 nuxt cli; do npm pack --pack-destination release/0.11.0 ./packages/$p; done
```

darwin-arm64 の tarball は、バイナリを持つ Mac でのみ作る（バイナリ無しの tarball は作らない）。

publish の順序（**順序厳守**、全て npmjs）: protocol → broker → client → client-linux-x64 → client-darwin-arm64 → nuxt → CLI。broker は protocol の `meshMac` と発見の型に依存する。client の native build は `get_broker` / `set_broker` を含めて作り直す。

## 3. broker の切替

常設の mesh broker は**同時に** 0.11.0 へ上げる（一台ずつ上げる間は相手を見つけられない時間が生じる）。手順は `docs/release-0.5.0.md` の 3 と同じ。全 mesh broker の `AGENT_MESSENGER_TOKEN` が同じことを確認する。mesh broker が `AGENT_MESSENGER_DISCOVERY=off` でないことも確認する。LAN の broadcast が届かない組み合わせは `AGENT_MESSENGER_DISCOVERY_TARGETS` を設定する。

## 4. 互換性

| 組み合わせ | 状態 | 挙動 |
|---|---|---|
| 新 client 0.11.0 → 旧 broker（0.10.x） | 動く | 接続・送受信は従来どおり。`get_broker` の一覧で `mesh` が付かない |
| 旧 client（0.10.x） → 新 broker 0.11.0 | 動く | 追加の欄を無視する |
| 新 mesh broker 0.11.0 ↔ 旧 mesh broker 0.10.x | 部分的 | 0.11 側は 0.10 を相手にしない（応答に mesh の印が無い）。0.10 側が config で 0.11 を指していれば 0.10 → 0.11 の同期は成立し、peer は両側に見える。0.11 から 0.10 側 peer 宛のメッセージは、0.10 を更新して同期が通るまで 0.11 側の送信待ちに残る（受理されるまで消えない） |
| 旧 `config.json` の `brokers` を使う client | 動く | 0.11.0 では保存した接続先として読む（ログに廃止予定の警告）。0.12.0 で廃止 |

## 5. ロールバック

`docs/release-0.5.0.md` の 5 と同じ。CLI の `latest` を 0.10.0 に戻し、broker は 0.10.0 に固定して再起動する。0.11.0 が書く `client.json` は 0.10.x が読まないので残っても無害。メッシュは 0.10.0 に戻すと再び `config.json` の `brokers` が相手一覧になるため、戻す前に各 broker の `config.json` に相手を書く。
