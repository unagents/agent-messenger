# アーキテクチャ

## パッケージ構成（`packages/`）

| ディレクトリ | パッケージ | 内容 |
|---|---|---|
| `cli/` | `@unagents/messenger` | `npx -y @unagents/messenger <command>` の入口（citty）。broker / client を npm registry から取得して `~/.agent-messenger/pkgs/` にキャッシュし、起動する |
| `broker/` | `@unagents/messenger-broker` | 1 台に 1 つ動かす HTTP デーモン（h3 + listhen、node）。peer の登録とメッセージ中継。状態は `~/.agent-messenger/broker.json` |
| `client/` | `@unagents/messenger-client` | Claude Code セッションごとに起動する stdio MCP サーバー（node 版、runtime 依存ゼロ）。broker に登録し、ツールを提供し、受信メッセージをセッションへ投入する。ライブラリとしても使える |
| `client-darwin-arm64/` `client-linux-x64/` | `@unagents/messenger-client-<platform>-<arch>` | client のネイティブ実行ファイル（PerryTS で `client/src/main.ts` を compile）。`os` / `cpu` 付き。CLI の `mcp` はこれが取得できればこちらを使い、無ければ node 版に落ちる |
| `protocol/` | `@unagents/messenger-protocol` | broker HTTP API・UDP 発見・session socket の型と定数。broker の runtime 依存、client / cli は型のみ参照 |
| `nuxt/` | `@unagents/messenger-nuxt` | Nuxt 4 module。Nuxt サーバー 1 つを 1 peer として broker に接続する |

全パッケージは npmjs に同じ版番号で公開する。`plugins/messenger/` は Claude Code プラグイン（MCP 登録 + 使い方 skill）で、版は `@unagents/messenger` と常に同じ。

`legacy/`（`src/` `bin/` `loader/` `test/`）は 0.4.0 までの JavaScript 実装。client / broker の互換テストと protocol の定数突き合わせが参照する。ビルド・配布の対象外。

## 配信の仕組み

1. mcp が 1 秒ごとに broker を poll し、受信メッセージをローカルバッファに積む。
2. `CLAUDE_CODE_MESSAGING_SOCKET` があれば、その Unix socket に `{"type":"auth","token":…}` と `{"type":"user","message":{"role":"user","content":…}}` を 1 行ずつ書いて投入する（Claude Code の own-child message）。成功したら broker に ack。
3. socket が無い／失敗したら channel 通知（`notifications/claude/channel`）を試み、成功したら ack。
4. どちらも失敗したメッセージはバッファと broker に残り、`check_messages` で取り出せる。
5. heartbeat は 15 秒ごと。60 秒途絶えた peer は broker から消える（未配信メッセージも破棄）。

同一マシン内のセッション間は Claude Code 標準の cross-session messaging（`SendMessage` / `ListAgents`、`/list-agents`）でも送れる。agent-messenger が要るのはホストをまたぐ場合（Remote Control を使わない構成）。
