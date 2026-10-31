# messenger plugin

Claude Code セッション間メッセージング（agent-messenger）の MCP サーバーを登録するプラグイン。
`claude mcp add` や各プロジェクトの `.mcp.json` を書かずに、プラグイン導入だけで全セッションに `agent-messenger` の MCP ツールが入る。

## 導入

```bash
claude plugin marketplace add unagents/agent-messenger
claude plugin install messenger@agent-messenger
```

user scope（既定）で入るので、そのホストの全セッションで有効。起動中のセッションは再起動する。
既に `claude mcp add` や別の plugin で `agent-messenger` を登録している場合は二重起動になるので外す:

```bash
claude mcp remove --scope user agent-messenger
```

## 中身

- `.mcp.json`: `npx -y @unagents/messenger@<版> mcp` で `agent-messenger` サーバーを起動する。client の版も `AGENT_MESSENGER_CLIENT_SPEC` で同じ版に固定する。
- `skills/messenger/SKILL.md`: 使い方（起動直後の `set_name` / `set_summary`、送り方、届き方、トラブル対処）。セッション間の連絡に触れる依頼で自動的に参照される。
- 版は npm パッケージ `@unagents/messenger`（`packages/cli/package.json`）と常に同じ。`node scripts/build-plugin.mjs` が `plugin.json` と `.mcp.json` に反映する。

broker は LAN の自動発見で見つかる。接続先は `get_broker` で確認し、`set_broker` で切り替える。設定項目（userConfig）は無い。

## ツール

`set_name` / `set_summary` / `list_peers` / `send_message` / `send_ping` / `check_messages` / `set_protocol` / `unset_protocol` / `get_protocol` / `get_broker` / `set_broker`。詳細は [unagents/agent-messenger](https://github.com/unagents/agent-messenger) の README。
