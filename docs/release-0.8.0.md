# リリース手順 0.8.0（ツール core・ライブラリ API・Nuxt module）

0.7.0（protocol / broker / client / cli とも 0.7.0）から、7 パッケージ（新規の `@agent-hand/messenger-nuxt` を含む）を 0.8.0 に揃えて上げる手順。基本の流れ（tarball 作成・Gitea Packages / Verdaccio・broker 切替・ロールバック）は `docs/release-0.5.0.md` と `docs/release-0.7.0.md` と同じ。ここでは差分だけ書く。

| パッケージ | 置き場 | 0.8.0 |
|---|---|---|
| `@agent-hand/messenger-protocol` | Gitea Packages | 0.8.0 |
| `@agent-hand/messenger-broker` | Gitea Packages | 0.8.0 |
| `@agent-hand/messenger-client` | Gitea Packages | 0.8.0 |
| `@agent-hand/messenger-client-darwin-arm64` | Gitea Packages | 0.8.0（バイナリは Mac で build） |
| `@agent-hand/messenger-client-linux-x64` | Gitea Packages | 0.8.0 |
| `@agent-hand/messenger-nuxt` | Gitea Packages | 0.8.0（新規） |
| `@agent-hand/messenger` | Verdaccio | 0.8.0 |

## 1. 変更点

### ツール core とライブラリ API（`feature/tools-core`）

- ツール定義を `packages/client/src/tools/` に切り出した（`TOOL_DEFS` / `createToolRegistry` / `toolDescriptors` / `INSTRUCTIONS`）。`@agent-hand/messenger-client/tools` から import できる。
- `createMessengerClient(options?)` を `@agent-hand/messenger-client` に追加（`connect` / `close` / `send` / `ping` / `listPeers` / `setName` / `setSummary` / `checkMessages` / `onMessage`）。`autoStartBroker` の既定は `false`。既存の export は全て維持。
- `peer.ts`（PeerState、登録）、`inbox.ts`（受信 buffer と配信）、`hosts/stdio.ts`（stdio MCP と session socket）に分離。`client.ts` は薄くなった。stdio のツール一覧・文言・instructions・capabilities は不変（golden fixture のテストで確認）。
- 再配信は同一プロセス・同一 peer id の範囲のみ。再起動や再登録（新 id）を跨いだ再配信はしない。
- broker / protocol / cli のソースは 0.7.0 から変更なし（版のみ 0.8.0）。

### Nuxt module（`feature/nuxt-module`、`packages/nuxt`、新規）

- `@agent-hand/messenger-nuxt`: Nuxt 4 module。Nuxt サーバー 1 つ = 1 peer。`useMessenger()` で送信、`messenger:message` hook で受信（listener が無ければ消費せず `checkMessages()` で取得）。
- `@nuxtjs/mcp-toolkit` が有る場合のみ 6 ツールを `/mcp` に追加する。`/mcp` に認証は無く broker の token を迂回できる。導入手順と注意は `packages/nuxt/README.md`。
- tarball は `dist` + `package.json`（`files: ["dist"]`）。playground / test は含まない。
- 統合時に `package-lock.json` の推移的依存が 31 件上がっている（nuxt 系の最小版要求による）。client / cli の依存宣言は不変。

### e2e script

- `scripts/e2e-mcp.mjs` は 6 tool、pull の未読通知、push の本文配信の assertion に更新済み（`41 passed, 0 failed`）。

## 2. tarball と publish の順序

```bash
npm ci && npm run build && npm run typecheck && npm test
PERRY_HOME=<perry> node scripts/build-native.mjs        # 実行したホストの platform（linux-x64 は 204、darwin-arm64 は Mac）
mkdir -p release/0.8.0
for p in protocol broker client client-linux-x64 cli nuxt; do npm pack --pack-destination release/0.8.0 ./packages/$p; done
```

darwin-arm64 の tarball は、バイナリを持つ Mac で `client-darwin-arm64` を pack した時だけ作る（バイナリ無しの tarball は作らない）。0.8.0 の 204 作成分は 6 本。

publish の順序（**順序厳守**）: protocol → broker → client → client-linux-x64 →（client-darwin-arm64。tarball が届いていれば）→ **nuxt** → CLI（Verdaccio）。nuxt は `@agent-hand/messenger-client` 0.8.0 に依存するため client の後。CLI は core と nuxt が Gitea Packages に揃ってから出す。Gitea Packages 側は必ず `env npm_config_@agent-hand:registry=http://192.168.1.202/gitea/api/packages/agent-hand/npm/` を付ける。手順書は `docs/history/20261023-release-0.8.0/publish-202.md`。

darwin-arm64 が後追いになる間、darwin ホストの CLI は platform package が取得できず node client に落ちる（`docs/release-0.5.0.md` 5 の動作）。

## 3. broker の更新

0.8.0 の broker は 0.7.0 からコード変更が無い（版のみ）。常設 broker は 2 台。

- 202: systemd user unit `agent-messenger-broker`。
- 210: tmux セッション `am-broker`（`AGENT_MESSENGER_MESH=on`、`AGENT_MESSENGER_BROKER_ID=air-7`）。

```bash
# 202
env XDG_RUNTIME_DIR=/run/user/1000 AGENT_MESSENGER_CORE_REFRESH=1 systemctl --user restart agent-messenger-broker
curl http://127.0.0.1:7901/health      # version 0.8.0
```

210 の再起動コマンドは `docs/history/20261023-release-0.8.0/publish-202.md`（`tmux kill-session` 後に同じ起動コマンドで立て直す）。peer は heartbeat 拒否を検知して再登録する（再起動不要）。

## 4. 互換性

| 組み合わせ | 状態 | 根拠 |
|---|---|---|
| 新 client 0.8.0 ↔ 旧 broker（0.7.0） | 動く見込み | broker / protocol は 0.7.0 から変更なし（`git diff 5bf9229 c6f9190 -- packages/broker packages/protocol` が空）。client の broker 呼び出しは同じ route のみ。混在での実機確認はしていない |
| 旧 client（0.7.0） ↔ 新 broker 0.8.0 | 動く見込み | 同上 |
| 新 CLI 0.8.0 | 0.7.0 と同じ | cli のソース変更なし（版と test の期待値のみ） |
| nuxt 0.8.0 ↔ client 0.8.0 | 動く | nuxt は `@agent-hand/messenger-client` を `0.8.0` 固定で依存する |
| nuxt 0.8.0 ↔ 旧 client（0.7.0） | 使えない | ライブラリ API `createMessengerClient` は 0.8.0 で追加 |

## 5. ロールバック

`docs/release-0.5.0.md` の 5 と同じ。CLI の `latest` を 0.7.0 に戻し、broker は 0.7.0 に固定して再起動する。nuxt は新規パッケージのため、戻す場合は利用側が依存を外す。
