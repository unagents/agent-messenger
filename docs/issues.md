# 既知の課題

## 1. 全セッションが stdio で MCP サーバーを起動する必要がある（緩和済み、未解決）

- Claude Code の MCP は stdio 方式だとセッションごとに `agent-messenger mcp` プロセスが 1 つ立つ。`npx` 経由だと起動のたびに Gitea へ問い合わせが走る。
- **緩和（2026-09-25）**: 受信配信に Claude Code 標準の session inbox socket（`CLAUDE_CODE_MESSAGING_SOCKET`、MCP 子プロセスへ継承される事を実測）を使うようにした。これにより `--dangerously-load-development-channels` フラグ無しでも受信メッセージが会話に届く（own-child message、docs: cross-session-messaging）。フェイクソケットでの自動テストは通過。**実セッションでの到達確認は未実施**（分類器により cap からの自己投入・`claude -p` 起動が拒否されたため、ユーザー側で確認が要る）。
- 残る課題:
  - セッションごとのプロセスそのものは残る。broker 側に Streamable HTTP の MCP エンドポイントを持たせ `claude mcp add --transport http` で登録すれば無くせるが、その場合 session socket の env が MCP 側に渡らないため、受信配信の手段が無くなる。stdio のままが妥当。
  - 受信側が `bypassPermissions` のセッションでは、own-child 検証に失敗した socket 投入が承認待ち（hold）になる（docs の inbound 規則）。`crossSessionInbound: accept` を設定すれば回避できる。

## 2. 認証トークン未設定

- 現在の broker（192.168.1.202:7901）はトークン無しで LAN 内公開。`AGENT_MESSENGER_TOKEN` を broker と全クライアントに配布して有効化する手順が未整備。

## 3. セッション名の自動付与

- Claude Code の `/rename` 名は MCP サーバーから取得できない。名前は `AGENT_MESSENGER_NAME`（プロジェクトの `.mcp.json`）か `set_name` ツールで付ける。

## 4. broker の常駐化

- systemd user unit 案を `deploy/agent-messenger-broker.service` に置いた。有効化はユーザー操作（cap の分類器で `Unauthorized Persistence` として拒否される）。現状は tmux セッション `am-broker` で稼働。
