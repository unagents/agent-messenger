# agent-messenger

Claude Code セッション同士（同一ホスト・別ホスト）でメッセージをやり取りする仕組み。
[claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) の設計を引き継いだもの。TypeScript の monorepo（npm workspaces、unbuild）。

## パッケージ構成（`packages/`）

| ディレクトリ | パッケージ | 置き場 | 内容 |
|---|---|---|---|
| `cli/` | `@agent-hand/messenger` | Verdaccio `http://192.168.1.202/npm/` | `npx -y @agent-hand/messenger <command>` の入口（citty）。broker / client を Gitea Packages から取得して `~/.agent-messenger/pkgs/` にキャッシュし、起動する。旧 loader の後継 |
| `broker/` | `@agent-hand/messenger-broker` | Gitea Packages `http://192.168.1.202/gitea/api/packages/agent-hand/npm/` | 1 台に 1 つ動かす HTTP デーモン（h3 + listhen、node）。peer の登録とメッセージ中継。状態は `~/.agent-messenger/broker.json` |
| `client/` | `@agent-hand/messenger-client` | Gitea Packages | Claude Code セッションごとに起動する stdio MCP サーバー（node 版、runtime 依存ゼロ）。broker に登録し、ツールを提供し、受信メッセージをセッションへ投入する |
| `client-darwin-arm64/` `client-linux-x64/` | `@agent-hand/messenger-client-<platform>-<arch>` | Gitea Packages | client のネイティブ実行ファイル（PerryTS で `client/src/main.ts` を compile）。`os` / `cpu` 付き。CLI の `mcp` はこれが取得できればこちらを使い、無ければ node 版に落ちる |
| `protocol/` | `@agent-hand/messenger-protocol` | Gitea Packages | broker HTTP API・UDP 発見・session socket の型と定数。broker の runtime 依存、client / cli は型のみ参照 |

`src/` `bin/` `loader/` `test/`（ルート直下）は 0.4.0 までの JavaScript 実装。参照用に残してあり、ビルド・テスト・配布の対象外。

```
  Mac (local cap / master-cap)              192.168.1.202 (remote cap)
  ┌──────────────────────────┐              ┌──────────────────────────┐
  │ claude ── mcp (stdio) ───┼──────┐       │ claude ── mcp (stdio) ───┼──┐
  └──────────────────────────┘      │       └──────────────────────────┘  │
                                    ▼                                     ▼
                              ┌───────────────────────────────────────────┐
                              │ broker  0.0.0.0:7901  (192.168.1.202)     │
                              └───────────────────────────────────────────┘
```

## 起動（npx で 202 の npm registry から）

```bash
npx -y @agent-hand/messenger <command>
```

`<command>`: `mcp` / `broker` / `status` / `peers` / `send <name|id> <message...>`

## セットアップ

### 1. broker（1 台だけ。現在は 192.168.1.202）

```bash
AGENT_MESSENGER_BIND=0.0.0.0 AGENT_MESSENGER_PORT=7901 \
  npx -y @agent-hand/messenger broker
```

確認: `curl http://192.168.1.202:7901/health` → `{"status":"ok","version":"…","peers":N}`

### 2. 各ホストで Claude Code に MCP 登録（user scope = 全セッション共通）

```bash
claude mcp add --scope user --transport stdio agent-messenger \
  --env AGENT_MESSENGER_HOST=192.168.1.202 \
  --env AGENT_MESSENGER_PORT=7901 \
  -- npx -y @agent-hand/messenger mcp
```

セッションに固定名を付けたい場合はプロジェクトの `.mcp.json` で `AGENT_MESSENGER_NAME` を渡す（project scope が user scope より優先）。
名前を渡さない場合はセッション内で `set_name` ツールを呼ぶ。

### 3. Claude Code の起動

通常の `claude` 起動でよい。受信メッセージは Claude Code が各セッションに用意する inbox socket（`CLAUDE_CODE_MESSAGING_SOCKET`、MCP 子プロセスに継承される）へ投入され、会話に「別セッションからのメッセージ」として届く（Claude Code v2.1.224 以降、cross-session messaging）。

socket が無い環境（古いバージョン、bare mode 等）では channel push にフォールバックする。channel push は起動フラグが要る:

```bash
claude --dangerously-load-development-channels server:agent-messenger
```

どちらも効かない場合は `check_messages` ツールで受信する（送信は常に可能）。配信方式は `AGENT_MESSENGER_DELIVERY`（`auto` / `socket` / `channel`）で固定できる。

## ツール（MCP）

| ツール | 内容 |
|---|---|
| `list_peers` | 接続中セッション一覧。scope: `all`(既定) / `host` / `directory` / `repo` |
| `send_message` | `to`（名前または id）へ送信。ホストをまたいで届く |
| `set_name` | このセッションに名前を付ける（他 peer が名前で宛先指定できる） |
| `set_summary` | 作業内容の 1〜2 文（list_peers に表示） |
| `check_messages` | 未読メッセージの取得と既読化。channel push 無しの環境では必須 |

## CLI

```bash
export AGENT_MESSENGER_HOST=192.168.1.202
npx -y @agent-hand/messenger status
npx -y @agent-hand/messenger peers
npx -y @agent-hand/messenger send master-cap "作業完了"
```

## broker の見つけ方（mcp / CLI）

上から順に試し、最初に決まった所を使う。

1. `AGENT_MESSENGER_HOST`（+ `AGENT_MESSENGER_PORT`）。`auto` または未設定なら次へ
2. `~/.agent-messenger/config.json` の `{"brokers": ["http://192.168.1.202:7901", ...]}`。先頭から `/health` が返る最初の 1 つ
3. LAN 自動発見: UDP ブロードキャスト（port 7902）に対し、稼働中の broker が `{id, port, version}` で応答。最初に応じた broker
4. `127.0.0.1:7901`。mcp はここで broker を自動起動する

`agent-messenger discover` で、設定ファイルの内容・応答した broker・最終的に選んだ URL を表示する。broker 側は起動時に UDP 7902 で応答を始める（`AGENT_MESSENGER_DISCOVERY=off` で無効化）。

## 環境変数

| 変数 | 既定 | 用途 |
|---|---|---|
| `AGENT_MESSENGER_HOST` | なし（`auto`） | broker のホスト。`127.0.0.1` のときは mcp 起動時に broker を自動起動する。未設定なら上記の解決順 |
| `AGENT_MESSENGER_CONFIG` | `~/.agent-messenger/config.json` | broker 一覧の設定ファイル |
| `AGENT_MESSENGER_BROKER_ID` | ホスト名 | broker の識別子（`/health` と発見応答に載る） |
| `AGENT_MESSENGER_DISCOVERY` | `on` | `off` で UDP 発見を無効化 |
| `AGENT_MESSENGER_DISCOVERY_PORT` / `_ADDR` / `_TIMEOUT_MS` | `7902` / なし / `1000` | 発見用 UDP ポート・探索先固定・応答待ち |
| `AGENT_MESSENGER_PORT` | `7901` | broker のポート（claude-peers の 7899 と衝突させないため別番号） |
| `AGENT_MESSENGER_BIND` | `0.0.0.0` | broker の bind アドレス |
| `AGENT_MESSENGER_TOKEN` | なし | Bearer トークン。broker と全クライアントで同じ値を設定 |
| `AGENT_MESSENGER_NAME` | なし | このセッションの名前 |
| `AGENT_MESSENGER_DELIVERY` | `auto` | 受信配信方式。`auto` = session socket があれば socket、無ければ channel。`socket` / `channel` で固定 |
| `AGENT_MESSENGER_STATE` | `~/.agent-messenger/broker.json` | broker の状態ファイル |

## 配信の仕組み

1. mcp が 1 秒ごとに broker を poll し、受信メッセージをローカルバッファに積む。
2. `CLAUDE_CODE_MESSAGING_SOCKET` があれば、その Unix socket に `{"type":"auth","token":…}` と `{"type":"user","message":{"role":"user","content":…}}` を 1 行ずつ書いて投入する（Claude Code の own-child message）。成功したら broker に ack。
3. socket が無い／失敗したら channel 通知（`notifications/claude/channel`）を試み、成功したら ack。
4. どちらも失敗したメッセージはバッファと broker に残り、`check_messages` で取り出せる。
5. heartbeat は 15 秒ごと。60 秒途絶えた peer は broker から消える（未配信メッセージも破棄）。

同一マシン内のセッション間は Claude Code 標準の cross-session messaging（`SendMessage` / `ListAgents`、`/list-agents`）でも送れる。agent-messenger が要るのはホストをまたぐ場合（Remote Control を使わない構成）。

## CLI（loader）の環境変数

| 変数 | 既定 | 用途 |
|---|---|---|
| `AGENT_MESSENGER_REGISTRY` | Gitea Packages の URL | broker / client / platform package の取得元 |
| `AGENT_MESSENGER_BROKER_SPEC` / `AGENT_MESSENGER_CLIENT_SPEC` | `latest` | 取得する版（`1.2.3` / `file:…` など npm spec） |
| `AGENT_MESSENGER_PKGS_DIR` | `~/.agent-messenger/pkgs` | キャッシュ先 |
| `AGENT_MESSENGER_REFRESH`（旧 `AGENT_MESSENGER_CORE_REFRESH` も可） | なし | `1` で再取得 |
| `AGENT_MESSENGER_TTL_HOURS` | `24` | `latest` 等の再確認間隔。`0` で毎回 |
| `AGENT_MESSENGER_CLIENT` | なし（auto） | `native` / `node` で client の種類を固定 |

## ビルドとテスト

```bash
npm ci
npm run build        # protocol を先に build してから全 workspace（unbuild → packages/*/dist）
npm run typecheck    # tsgo（@typescript/native-preview）
npm test             # vitest（broker 10 / cli 15 / client 15 / protocol 4）
```

テストは loopback で broker・疑似 npm registry を立てる（192.168.1.202 には接続しない）。

ネイティブ client（PerryTS）:

```bash
PERRY_HOME=<perry の rel/ と clang がある dir> node scripts/build-native.mjs [--clean]
```

`packages/client/native/messenger-client-<platform>-<arch>` と `packages/client-<platform>-<arch>/`（`package.json` + `bin/messenger-client`）を生成する。実行したホストの platform のみ。darwin-arm64 は Mac、linux-x64 は 204 で実行し、`bin/messenger-client` を持ち帰る。

統合確認（疑似 registry から 6 パッケージを取得し、`cli discover / mcp（native・node）/ peers / status / send / broker`、session socket 投入、node フォールバックを通す）:

```bash
node scripts/e2e-mcp.mjs [--broker direct|cli]
```

## 公開手順

`docs/release-0.5.0.md`（publish の順序: protocol → broker → client → platform 2 種 → cli、broker 切替、ロールバック）。

## 既知の課題

`docs/issues.md` を参照。
