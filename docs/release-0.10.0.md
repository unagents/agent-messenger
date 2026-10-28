# リリース手順 0.10.0（protocol 機能）

0.9.0 から、7 パッケージを 0.10.0 に揃えて上げる手順。セッションが話す protocol を宣言し、`list_peers` で探し、`send_message` に付けられるようにする（設計は `docs/design/protocol.md`）。基本の流れ（tarball 作成・broker 切替・ロールバック）は `docs/release-0.5.0.md`、`docs/release-0.8.0.md`、`docs/release-0.9.0.md` と同じ。ここでは差分だけ書く。版の変更（各 `package.json` と `packages/client/src/version.ts`）はこの文書の対象外で、リリース時に別途行う。

| パッケージ | 置き場 | 0.10.0 |
|---|---|---|
| `@unagents/messenger-protocol` | npmjs | 0.10.0 |
| `@unagents/messenger-broker` | npmjs | 0.10.0 |
| `@unagents/messenger-client` | npmjs | 0.10.0 |
| `@unagents/messenger-client-linux-x64` | npmjs | 0.10.0 |
| `@unagents/messenger-client-darwin-arm64` | npmjs | 0.10.0（バイナリは Mac で build） |
| `@unagents/messenger-nuxt` | npmjs | 0.10.0 |
| `@unagents/messenger` | npmjs | 0.10.0 |

## 1. 変更点

### protocol 機能

- MCP ツールを 6 から 9 に増やした: `set_protocol` / `unset_protocol` / `get_protocol`。
- `list_peers` に `protocol` / `version`、`send_message` に `meta`（`{protocol, version}`）を追加した。`meta` 無しの送受信は従来どおり。
- protocol repo は `protocol.json`（必須）と `PROTOCOL.md`（任意）を持つ Git repo かローカルディレクトリ。取得できるのは public の GitHub / Gitea repo とローカル path のみ。private repo は `REPO_UNREACHABLE`。
- broker は定義を `broker.json` の `protocols` に保存する。heartbeat の応答 `resend` で、本体を持たない宣言の再送を client に求める。mesh 同期にも `protocols` が載る。
- 受信表示に `Protocol: name@version` が付く。自分の宣言と版が違えば mismatch を示し、その相手への返信の結果に警告行が付く。

### 公開 API と Nuxt

- `MessengerClient` に `setProtocol` / `unsetProtocol` / `getProtocol` を追加し、`listPeers(scope?, filter?)` と `send(to, text, delivery?, meta?)` を拡張した。
- `@unagents/messenger-nuxt` は `object` 型のツール引数（`meta`）を zod に写せるようにした。`/mcp` が 9 ツールを公開し、`useMessenger()` に同じ API が通る。

### HTTP API

- 新ルート（POST + JSON + Bearer）: `/set-protocol` / `/unset-protocol` / `/get-protocol`。定数は `PROTOCOL_ROUTES`。
- `/register` `/heartbeat` に `protocols`、`/list-peers` に `protocol` / `version`、`/send-message` に `meta` を追加。全て任意の追加欄。

## 2. tarball と publish の順序

```bash
npm ci && npm run build && npm run typecheck && npm test
PERRY_HOME=<perry> node scripts/build-native.mjs        # 実行したホストの platform
node scripts/e2e-mcp.mjs                                # protocol シナリオを含む
mkdir -p release/0.10.0
for p in protocol broker client client-linux-x64 client-darwin-arm64 nuxt cli; do npm pack --pack-destination release/0.10.0 ./packages/$p; done
```

darwin-arm64 の tarball は、バイナリを持つ Mac でのみ作る（バイナリ無しの tarball は作らない）。

publish の順序（**順序厳守**、全て npmjs）: protocol → broker → client → client-linux-x64 → client-darwin-arm64 → nuxt → CLI。broker と client は protocol の新しい型と定数に依存する。nuxt は `@unagents/messenger-client` 0.10.0 に依存するため client の後。CLI は全て揃ってから出す。

## 3. broker の切替

常設 broker（現在は 192.168.1.202）を先に 0.10.0 に上げる。protocol 機能は broker 側の対応が無いと使えない。手順は `docs/release-0.5.0.md` の 3 と同じ。`broker.json` は旧形式のまま読め、宣言が 1 件も無ければ `protocols` キーを書かない。

## 4. 互換性

| 組み合わせ | 状態 | 挙動 |
|---|---|---|
| 新 client 0.10.0 → 旧 broker（0.9.x） | 一部のみ | `set_protocol` は `BROKER_UNSUPPORTED`（broker の版を添える）。`list_peers(protocol)` も、応答に `protocols` 欄が無いことを検知して `BROKER_UNSUPPORTED`。`send_message(meta)` は `meta` が落ちるだけで届く。protocol を使わない操作は従来どおり |
| 旧 client（0.9.x） → 新 broker 0.10.0 | 動く | 新しい欄を送らないので従来どおり。受信 message の `meta` は旧 client が無視する |
| 新 broker 0.10.0 ↔ 旧 broker 0.9.x（mesh） | peer と message は従来どおり | 定義と宣言は旧側に伝わらない |
| 旧 broker が新 client の heartbeat `protocols` を受信 | 無視される | `resend` が返らないので再送しない |

## 5. ロールバック

`docs/release-0.5.0.md` の 5 と同じ。CLI の `latest` を 0.9.0 に戻し、broker は 0.9.0 に固定して再起動する。0.10.0 が書いた `broker.json` の `protocols` は 0.9.x が未知の欄として無視して読み書きするため、戻した後は定義が消えるだけで peer と message は残る。protocol を使っていたセッションは、broker を戻した後は `BROKER_UNSUPPORTED` になる。
