# agent-messenger

Claude Code セッション同士（同一ホスト・別ホスト）でメッセージをやり取りする仕組み。
[claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) の設計を引き継ぎ、Node だけで動くように書き直したもの（Bun 不要、ビルド不要）。

配布は 2 パッケージ:

- **`@agent-hand/messenger`（loader、`loader/`）** — `npx` が引く薄いランチャー。Verdaccio（`http://192.168.1.202/npm/`）に置く。本体を設定可能な npm ソースから取得・キャッシュして実行する。詳細は `loader/README.md`。
- **`@agent-hand/messenger-core`（本体、このリポジトリのルート）** — Gitea に置く。既定は git リポジトリ `agent-hand/messenger` のタグ `vX.Y.Z` を npm の git spec で取得（公開リポジトリなのでトークン不要）。Gitea Packages（`http://192.168.1.202/gitea/api/packages/agent-hand/npm/`）へ publish した場合は loader の環境変数で切り替える。置き場を変えても `claude mcp add` の登録は変わらない。

本体の構成:

- **broker** — 1 台に 1 つ動かす HTTP デーモン。peer の登録とメッセージ中継。状態は `~/.agent-messenger/broker.json` に保存。
- **mcp** — Claude Code セッションごとに起動する stdio MCP サーバー。broker に登録し、ツールを提供し、受信メッセージを channel 通知で押し込む。
- **CLI** — シェルから peer 一覧・送信・状態確認。

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

## 環境変数

| 変数 | 既定 | 用途 |
|---|---|---|
| `AGENT_MESSENGER_HOST` | `127.0.0.1` | broker のホスト。`127.0.0.1` のときは mcp 起動時に broker を自動起動する |
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

## テスト

```bash
npm install
npm test
```

broker 起動、HTTP API、MCP 2 セッション間の送受信（channel 通知 / check_messages）を通しで検証する。

## 公開手順

```bash
# 本体 → Gitea git リポジトリにタグを打って push（loader の既定はこれを取得する）
git tag v0.3.0 && git push origin master --tags

# （任意）本体 → Gitea Packages。~/.npmrc に //192.168.1.202/gitea/api/packages/agent-hand/npm/:_authToken=<token> が要る
npm publish --registry http://192.168.1.202/gitea/api/packages/agent-hand/npm/

# loader → Verdaccio（~/.npmrc の @agent-hand:registry=http://192.168.1.202/npm/ を使う）
cd loader && npm publish
```

loader と本体は独立して版を上げられる。loader は `latest` の本体を 24 時間ごとに再確認する（`AGENT_MESSENGER_CORE_TTL_HOURS`）。

## 既知の課題

`docs/issues.md` を参照。
