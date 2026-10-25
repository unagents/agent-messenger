# リリース手順 0.9.0（スコープ改名 @unagents・npmjs 公開）

0.8.0 から、7 パッケージを 0.9.0 に揃えて上げる手順。スコープを `@agent-hand` から `@unagents` に改名し、公開先を npmjs に移す。基本の流れ（tarball 作成・broker 切替・ロールバック）は `docs/release-0.5.0.md` と `docs/release-0.8.0.md` と同じ。ここでは差分だけ書く。

| パッケージ | 置き場 | 0.9.0 |
|---|---|---|
| `@unagents/messenger-protocol` | npmjs | 0.9.0 |
| `@unagents/messenger-broker` | npmjs | 0.9.0 |
| `@unagents/messenger-client` | npmjs | 0.9.0 |
| `@unagents/messenger-client-linux-x64` | npmjs | 0.9.0 |
| `@unagents/messenger-client-darwin-arm64` | npmjs | 0.9.0（バイナリは Mac で build） |
| `@unagents/messenger-nuxt` | npmjs | 0.9.0 |
| `@unagents/messenger` | npmjs | 0.9.0 |

## 1. 変更点

### 改名

- 全パッケージのスコープを `@agent-hand/*` から `@unagents/*` に変更した。相互依存、optionalDependencies、CLI の `CLIENT_NAME` / `BROKER_NAME`、`package-lock.json` の workspace 項目、registry 指定のキー（`npm_config_@unagents:registry`）、テスト、README を追従。
- 全パッケージの版を 0.9.0 に揃えた（`packages/client/src/version.ts` を含む）。
- `repository.url` は `https://github.com/unagents/agent-messenger.git`。

### npmjs 公開

- 全 `package.json` から `publishConfig` を削除した。`npm publish` は npmjs の既定で行う。
- CLI の `DEFAULT_REGISTRY` は `https://registry.npmjs.org/`。環境変数 `AGENT_MESSENGER_REGISTRY` で上書きでき、Gitea Packages を使う場合は `http://192.168.1.202/gitea/api/packages/unagents/npm/` を指定する。
- `deploy/` と `scripts/e2e-mcp.mjs` の owner を `unagents` に変更した。

### GitHub mirror

- 公開先 repo は `https://github.com/unagents/agent-messenger`。Gitea（`unagents/agent-messenger`）からの push mirror を予定している。

## 2. tarball と publish の順序

```bash
npm ci && npm run build && npm run typecheck && npm test
PERRY_HOME=<perry> node scripts/build-native.mjs        # 実行したホストの platform
mkdir -p release/0.9.0
for p in protocol broker client client-linux-x64 client-darwin-arm64 nuxt cli; do npm pack --pack-destination release/0.9.0 ./packages/$p; done
```

darwin-arm64 の tarball は、バイナリを持つ Mac でのみ作る（バイナリ無しの tarball は作らない）。

publish の順序（**順序厳守**、全て npmjs）: protocol → broker → client → client-linux-x64 → client-darwin-arm64 → nuxt → CLI。nuxt は `@unagents/messenger-client` 0.9.0 に依存するため client の後。CLI は全て揃ってから出す。

## 3. 旧 `@agent-hand/*` 利用者の移行

- `@agent-hand/*` は Gitea Packages にそのまま残る。更新はされない。
- MCP 設定のコマンドを次に変える。

```bash
npx -y @unagents/messenger mcp
```

- Nuxt module は依存を `@unagents/messenger-nuxt` に差し替える。`nuxt.config` の `modules` も同名に変える。
- `@agent-hand/messenger-client/tools` などの import は `@unagents/messenger-client/tools` に変える。
- 常設 broker は CLI 経由の取得元が npmjs に変わる。Gitea Packages から取り続ける場合は `AGENT_MESSENGER_REGISTRY` を指定する。

## 4. 互換性

| 組み合わせ | 状態 | 根拠 |
|---|---|---|
| 新 client 0.9.0 ↔ 旧 broker（0.8.0） | 動く見込み | `packages/protocol/src` は 0.8.0 から差分なし。broker / client のソース差分は import 先のパッケージ名と版のみ。`git diff v0.8.0 -- packages/protocol/src` が空。混在での実機確認はしていない |
| 旧 client（0.8.0） ↔ 新 broker 0.9.0 | 動く見込み | 同上 |
| 新 CLI 0.9.0 | 取得元の既定が npmjs | 取得対象は `@unagents/messenger-client` / `-broker`。旧スコープのパッケージは取得しない |

## 5. ロールバック

`docs/release-0.5.0.md` の 5 と同じ。CLI の `latest` を戻し、broker は旧版に固定して再起動する。旧スコープ（`@agent-hand/*` 0.8.0）は Gitea Packages に残っているため、`AGENT_MESSENGER_REGISTRY` と旧パッケージ名で戻せる（CLI 0.8.0 を使う）。
