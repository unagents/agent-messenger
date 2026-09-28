# リリース手順 0.5.0（TypeScript 版、パッケージ分割）

0.4.0（`@agent-hand/messenger-core` + loader `@agent-hand/messenger` 0.3.1）から、次の 6 パッケージ構成へ切り替える手順。

| パッケージ | 置き場 | 役割 |
|---|---|---|
| `@agent-hand/messenger-protocol` | Gitea Packages | 型と定数。broker の runtime 依存 |
| `@agent-hand/messenger-broker` | Gitea Packages | broker（h3 + listhen、node） |
| `@agent-hand/messenger-client` | Gitea Packages | stdio MCP client（node 版、依存ゼロ） |
| `@agent-hand/messenger-client-darwin-arm64` | Gitea Packages | client のネイティブ版（PerryTS）。`os` / `cpu` 付き |
| `@agent-hand/messenger-client-linux-x64` | Gitea Packages | 同上 |
| `@agent-hand/messenger` | Verdaccio | CLI（旧 loader の後継）。`npx -y @agent-hand/messenger <mcp\|broker\|status\|peers\|send\|discover>` |

Gitea Packages: `http://192.168.1.202/gitea/api/packages/agent-hand/npm/`、Verdaccio: `http://192.168.1.202/npm/`（各ホストの `~/.npmrc` に `@agent-hand:registry=http://192.168.1.202/npm/`）。

## 0. tarball を作る（Mac、`main/` の `ts-rewrite`）

```bash
npm ci && npm run build && npm run typecheck && npm test
PERRY_HOME=/Users/koube/work/mcp-tools/agent-messenger/spike-perry node scripts/build-native.mjs   # darwin-arm64
# linux-x64 は 204 で同じスクリプトを実行し、packages/client-linux-x64/bin/messenger-client を回収する
mkdir -p release/0.5.0
for p in protocol broker client client-darwin-arm64 client-linux-x64 cli; do npm pack --pack-destination release/0.5.0 ./packages/$p; done
node scripts/e2e-mcp.mjs        # 疑似 registry で 6 パッケージの取得経路と MCP 交換を通す
```

`release/` は git 管理外。`tar tzf` で中身を確認する（`package/dist/*` または `package/bin/messenger-client` + `package.json` のみ。`src` / `test` が入っていないこと）。

## 1. publish の順序

**順序厳守**: 依存先が無い状態で依存元を出すと `npm install` が 404 で失敗する（broker は protocol に、CLI は broker / client / platform に実行時依存する）。

1. `@agent-hand/messenger-protocol`
2. `@agent-hand/messenger-broker`
3. `@agent-hand/messenger-client`
4. `@agent-hand/messenger-client-darwin-arm64`、`@agent-hand/messenger-client-linux-x64`
5. `@agent-hand/messenger`（CLI、Verdaccio）— **1〜4 が Gitea Packages に揃ってから**。ここを出した時点で全ホストの `npx -y @agent-hand/messenger` が新版になる

### 1〜4: Gitea Packages（202 の checkout から）

Mac の `release/0.5.0/` の 5 本を 202 の checkout（`/home/vagrant/work/agent-messenger`）へ転送し、`env npm_config_@agent-hand:registry=http://192.168.1.202/gitea/api/packages/agent-hand/npm/ npm publish <tgz>` を 1 本ずつ実行する。**`~/.npmrc` の `@agent-hand:registry=http://192.168.1.202/npm/`（scope 設定）が tarball の `publishConfig.registry` と `--registry` のどちらよりも優先される**（0.5.0 リリース時の実測。`npm publish <tgz>` だけだと Verdaccio に入る）ため、`env npm_config_@agent-hand:registry=<Gitea Packages>` で scope 設定を上書きする。202 の `~/.npmrc` に Gitea Packages の認証行があること（無ければ `node deploy/npmrc-gitea-auth.js`）。

```bash
# Mac
scp release/0.5.0/agent-hand-messenger-{protocol,broker,client,client-darwin-arm64,client-linux-x64}-0.5.0.tgz vagrant@192.168.1.202:/home/vagrant/work/agent-messenger/release/0.5.0/
# 202（単独コマンドで 1 本ずつ。`cd &&` 連結は分類器に止まる）
env npm_config_@agent-hand:registry=http://192.168.1.202/gitea/api/packages/agent-hand/npm/ npm publish /home/vagrant/work/agent-messenger/release/0.5.0/agent-hand-messenger-protocol-0.5.0.tgz
env npm_config_@agent-hand:registry=http://192.168.1.202/gitea/api/packages/agent-hand/npm/ npm publish /home/vagrant/work/agent-messenger/release/0.5.0/agent-hand-messenger-broker-0.5.0.tgz
env npm_config_@agent-hand:registry=http://192.168.1.202/gitea/api/packages/agent-hand/npm/ npm publish /home/vagrant/work/agent-messenger/release/0.5.0/agent-hand-messenger-client-0.5.0.tgz
env npm_config_@agent-hand:registry=http://192.168.1.202/gitea/api/packages/agent-hand/npm/ npm publish /home/vagrant/work/agent-messenger/release/0.5.0/agent-hand-messenger-client-darwin-arm64-0.5.0.tgz
env npm_config_@agent-hand:registry=http://192.168.1.202/gitea/api/packages/agent-hand/npm/ npm publish /home/vagrant/work/agent-messenger/release/0.5.0/agent-hand-messenger-client-linux-x64-0.5.0.tgz
```

確認（202）: `env npm_config_@agent-hand:registry=http://192.168.1.202/gitea/api/packages/agent-hand/npm/ npm view @agent-hand/messenger-broker version` が `0.5.0`。5 本とも。`--registry` 形は scope 設定に負けて Verdaccio を見るので使わない。

Gitea の repo リンク（Packages タブへの表示）は publish 時に自動で付く（`package.json` の `repository`）。`deploy/gitea-link-package.js` の実行は不要（リンク済のため `400 invalid argument` になる）。

broker の unscoped 依存（`h3` / `listhen` / `consola` / `defu`）は各ホストの既定 registry（npmjs）から取る。

### 5: Verdaccio（CLI）

```bash
npm publish /home/vagrant/work/agent-messenger/release/0.5.0/agent-hand-messenger-0.5.0.tgz
```

（`publishConfig.registry` = `http://192.168.1.202/npm/`）。確認: `npm view @agent-hand/messenger version --registry http://192.168.1.202/npm/` → `0.5.0`。

## 2. 旧版との互換

| 組み合わせ | 状態 | 根拠 |
|---|---|---|
| 新 client 0.5.0 ↔ 旧 broker（core 0.4.0） | 動く | client の vitest（`packages/client/test/`）は broker に旧 JS 実装 `bin/agent-messenger.js broker` を使っており 15 件通過（報告書 03 / 05） |
| 旧 client / 旧 CLI（core 0.4.0） ↔ 新 broker 0.5.0 | 動く | broker の vitest に旧 CLI `peers` の互換テストあり（報告書 02）。HTTP API・UDP 発見応答・state file（`broker.json`）の形は同一 |
| 新 broker が旧 broker の `~/.agent-messenger/broker.json` を読む | 可 | 報告書 02 の state file テスト（indent 1、同キー） |

したがって **broker と client はどちらを先に切り替えてもよい**。手順 1 の順序は「取得できないパッケージを参照しない」ためのもの。

## 3. broker の切替（202 の tmux `am-broker`）

現行: tmux `am-broker` で `npx -y @agent-hand/messenger broker`（core 0.4.0、`AGENT_MESSENGER_BIND=0.0.0.0 AGENT_MESSENGER_PORT=7901`）。

1. `tmux send-keys -t am-broker C-c`（旧 broker を SIGINT で停止。`tmux kill-session -t am-broker` は分類器 `[Interfere With Workloads]` に止まる）
2. 同じ env で再起動: `tmux new-session -d -s am-broker 'AGENT_MESSENGER_BIND=0.0.0.0 AGENT_MESSENGER_PORT=7901 npx -y @agent-hand/messenger@0.5.0 broker'`
   - 0.5.0 リリース時は上記のとおり `@agent-hand/messenger@0.5.0` に版を固定して起動した。次回更新時はこの版を上げる（`deploy/agent-messenger-broker.service` の `ExecStart` は未固定のまま）
   - CLI 0.5.0 が `@agent-hand/messenger-broker@latest` を `~/.agent-messenger/pkgs/` に取得して `node .../dist/main.mjs` を起動する
   - 初回は `npm install`（protocol + h3 系）で数秒かかる
3. `curl http://192.168.1.202:7901/health` → `{"status":"ok","version":"0.5.0",...}`
4. peer は heartbeat 拒否を検知して同名で再登録する（core 0.3.1 以降・新 client とも）。既存セッションの再起動は不要。state file は同じ `~/.agent-messenger/broker.json` を引き継ぐ

停止は SIGINT / SIGTERM（exit 0、保留中の state 保存を flush）。systemd 化する場合の unit は `deploy/agent-messenger-broker.service`（`ExecStart` は同じ `npx -y @agent-hand/messenger broker`）。

## 4. plugin 側（`agent-hand/plugins` の `messenger`）

**変更不要**。`.mcp.json` は `npx -y @agent-hand/messenger mcp` のままで、`AGENT_MESSENGER_HOST` / `_PORT` も同じ名前・意味。CLI 0.5.0 の `mcp` は platform package（native）があればそれを、無ければ node client を起動する。

変わるもの: loader の env 名（`AGENT_MESSENGER_CORE_*` → `AGENT_MESSENGER_REGISTRY` / `_PKGS_DIR` / `_REFRESH` / `_TTL_HOURS` / `_BROKER_SPEC` / `_CLIENT_SPEC`、`AGENT_MESSENGER_CLIENT=node|native`）。plugin はこれらを使っていない。旧 `AGENT_MESSENGER_CORE_REFRESH=1` だけは引き続き有効。

各ホストで新版が使われ始めるタイミングは、`npx -y @agent-hand/messenger` が Verdaccio の `latest` を再解決した時。確実に切り替えるには各ホストで `npx -y @agent-hand/messenger@0.5.0 --version` を一度実行するか、Claude Code セッションを再起動する（`~/.npm/_npx/` の解決キャッシュの更新タイミングは未検証）。

## 5. ロールバック

CLI を 0.3.1（旧 loader）に戻せば、全ホストが従来どおり `@agent-hand/messenger-core@latest`（Gitea Packages、0.4.0）を使う。core 0.4.0 は Gitea Packages から消さないこと。

```bash
# 202
npm dist-tag add @agent-hand/messenger@0.3.1 latest --registry http://192.168.1.202/npm/
npm view @agent-hand/messenger dist-tags --registry http://192.168.1.202/npm/   # latest: 0.3.1
```

broker を戻す: `tmux kill-session -t am-broker` → `npx -y @agent-hand/messenger@0.3.1 broker`（同じ env）。新 broker が書いた `broker.json` は旧 broker がそのまま読める（同じ形）。

Gitea Packages の 5 パッケージは残してよい（旧 loader は参照しない）。

## 6. 各ホストの `~/.agent-messenger/core/`（旧キャッシュ）

- 0.5.0 の CLI は `~/.agent-messenger/pkgs/` を使い、`core/` には触れない
- `core/` は旧 loader 0.3.1 のキャッシュ。ロールバック時にそのまま使われる（再 install 不要）ので、**切替が安定するまで残す**
- 安定後に各ホストで `rm -rf ~/.agent-messenger/core` で削除（ユーザー操作。Mac / 202 / 203 / 204）
- `~/.agent-messenger/config.json`（broker 一覧）と `broker.json`（202 の state）はそのまま使う

## 7. 確認（各ホスト）

```bash
npx -y @agent-hand/messenger --version          # 0.5.0
npx -y @agent-hand/messenger status             # Broker: ok v0.5.0 ...
ls ~/.agent-messenger/pkgs/                     # messenger-client-<platform>-<arch>@latest/ ...（mcp を一度起動した後）
```

Claude Code 側は `/mcp` で `plugin:messenger:agent-messenger` が接続していること、`list_peers` で他ホストが見えること。
