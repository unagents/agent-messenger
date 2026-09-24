# agent-messenger

Claude Code セッション同士（同一ホスト・別ホスト）でメッセージをやり取りする仕組み。
[claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) の設計を引き継ぎ、Node だけで動くように書き直したもの（Bun 不要、ビルド不要）。

構成:

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

## 起動（npx で Gitea から直接）

```bash
npx -y git+http://192.168.1.202/gitea/grrowapp/agent-messenger.git <command>
```

`<command>`: `mcp` / `broker` / `status` / `peers` / `send <name|id> <message...>`

## セットアップ

### 1. broker（1 台だけ。現在は 192.168.1.202）

```bash
AGENT_MESSENGER_BIND=0.0.0.0 AGENT_MESSENGER_PORT=7901 \
  npx -y git+http://192.168.1.202/gitea/grrowapp/agent-messenger.git broker
```

確認: `curl http://192.168.1.202:7901/health` → `{"status":"ok","version":"…","peers":N}`

### 2. 各ホストで Claude Code に MCP 登録（user scope = 全セッション共通）

```bash
claude mcp add --scope user --transport stdio agent-messenger \
  --env AGENT_MESSENGER_HOST=192.168.1.202 \
  --env AGENT_MESSENGER_PORT=7901 \
  -- npx -y git+http://192.168.1.202/gitea/grrowapp/agent-messenger.git mcp
```

セッションに固定名を付けたい場合はプロジェクトの `.mcp.json` で `AGENT_MESSENGER_NAME` を渡す（project scope が user scope より優先）。
名前を渡さない場合はセッション内で `set_name` ツールを呼ぶ。

### 3. Claude Code の起動

受信メッセージを会話に即時に押し込む（channel push）には起動フラグが要る:

```bash
claude --dangerously-load-development-channels server:agent-messenger
```

フラグ無しで起動したセッションは、`check_messages` ツールを呼んだ時だけ受信できる（送信は常に可能）。

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
npx -y git+http://192.168.1.202/gitea/grrowapp/agent-messenger.git status
npx -y git+http://192.168.1.202/gitea/grrowapp/agent-messenger.git peers
npx -y git+http://192.168.1.202/gitea/grrowapp/agent-messenger.git send master-cap "作業完了"
```

## 環境変数

| 変数 | 既定 | 用途 |
|---|---|---|
| `AGENT_MESSENGER_HOST` | `127.0.0.1` | broker のホスト。`127.0.0.1` のときは mcp 起動時に broker を自動起動する |
| `AGENT_MESSENGER_PORT` | `7901` | broker のポート（claude-peers の 7899 と衝突させないため別番号） |
| `AGENT_MESSENGER_BIND` | `0.0.0.0` | broker の bind アドレス |
| `AGENT_MESSENGER_TOKEN` | なし | Bearer トークン。broker と全クライアントで同じ値を設定 |
| `AGENT_MESSENGER_NAME` | なし | このセッションの名前 |
| `AGENT_MESSENGER_STATE` | `~/.agent-messenger/broker.json` | broker の状態ファイル |

## 配信の仕組み

1. mcp が 1 秒ごとに broker を poll し、受信メッセージをローカルバッファに積む。
2. channel 通知（`notifications/claude/channel`）を試み、成功したら broker に ack して既読にする。
3. 失敗した（フラグ無し等）メッセージはバッファと broker に残り、`check_messages` で取り出せる。
4. heartbeat は 15 秒ごと。60 秒途絶えた peer は broker から消える（未配信メッセージも破棄）。

## テスト

```bash
npm install
npm test
```

broker 起動、HTTP API、MCP 2 セッション間の送受信（channel 通知 / check_messages）を通しで検証する。

## 既知の課題

`docs/issues.md` を参照。
