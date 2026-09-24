# 既知の課題

## 1. 全セッションが stdio で MCP サーバーを起動する必要がある（未解決）

- Claude Code の MCP は stdio 方式だとセッションごとに `agent-messenger mcp` プロセスが 1 つ立つ。`npx` 経由だと起動のたびに Gitea へ問い合わせが走る。
- channel push（受信メッセージを会話へ即時投入）は、セッションを `--dangerously-load-development-channels server:agent-messenger` 付きで起動した場合にしか効かない。フラグ無しのセッションは `check_messages` を呼ぶまで受信に気づかない。
- 検討中の方向:
  - broker 側に Streamable HTTP の MCP エンドポイントを持たせ、`claude mcp add --transport http` で登録する（セッションごとのプロセスを無くす）。channel 通知が HTTP transport でも届くかは未検証。
  - フラグを付けずに済む起動方法（settings.json 等）が公式に用意されているかは未確認。
- 当面の運用: stdio + フラグ付き起動。フラグ無しの cap には `check_messages` を促す。

## 2. 認証トークン未設定

- 現在の broker（192.168.1.202:7901）はトークン無しで LAN 内公開。`AGENT_MESSENGER_TOKEN` を broker と全クライアントに配布して有効化する手順が未整備。

## 3. セッション名の自動付与

- Claude Code の `/rename` 名は MCP サーバーから取得できない。名前は `AGENT_MESSENGER_NAME`（プロジェクトの `.mcp.json`）か `set_name` ツールで付ける。
