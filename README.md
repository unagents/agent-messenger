# agent-messenger

Claude Code セッション同士（同一ホスト・別ホスト）でメッセージをやり取りする仕組み。
[claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) の設計を引き継いだもの。TypeScript の monorepo（npm workspaces、unbuild）。

- LAN 内のどこか 1 台で **broker**（HTTP デーモン）を動かし、各 Claude Code セッションは **stdio MCP サーバー**として broker に登録する
- セッションは名前を付けて互いを探し、ホストをまたいでメッセージを送れる。着信は会話に「別セッションからのメッセージ」として届く
- broker は LAN の UDP 自動発見で見つかる。見つからなければローカルに fallback broker を自動起動するので、1 台だけでも設定無しで動く
- Nuxt サーバーを 1 peer として参加させる module もある

```
  host A                                    host B
  ┌──────────────────────────┐              ┌──────────────────────────┐
  │ claude ── mcp (stdio) ───┼──────┐       │ claude ── mcp (stdio) ───┼──┐
  │ claude ── mcp (stdio) ───┼────┐ │       └──────────────────────────┘  │
  └──────────────────────────┘    │ │                                     │
                                  ▼ ▼                                     ▼
                              ┌───────────────────────────────────────────┐
                              │ broker  0.0.0.0:7901  (どこか 1 台)        │
                              └───────────────────────────────────────────┘
```

動作要件: Node.js 20 以上。Claude Code は v2.1.224 以降（cross-session messaging の inbox socket を使う。古い版でも channel push か `check_messages` で受信できる）。

## クイックスタート

```bash
# 1. Claude Code にプラグインとして導入（user scope = そのホストの全セッション共通）
claude plugin marketplace add unagents/agent-messenger
claude plugin install messenger@agent-messenger

# 2. 通常どおり claude を起動し、セッション内でツールを呼ぶ
#    set_name("my-session")  → list_peers()  → send_message(to: "other-session", message: "...")
```

同じ LAN に broker が無ければ、最初のセッションがローカル（`127.0.0.1:7901`）に fallback broker を自動起動する。別ホストとやり取りするには、[セットアップ](docs/setup.md)で常設 broker を 1 台立てる。

## ドキュメント

| ファイル | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | パッケージ構成（`packages/`）、配信の仕組み |
| [docs/setup.md](docs/setup.md) | セットアップ（broker・Claude Code 導入・起動）、broker の見つけ方、環境変数 |
| [docs/usage.md](docs/usage.md) | MCP ツールと CLI の使い方 |
| [docs/protocol-and-library.md](docs/protocol-and-library.md) | protocol（0.10.0〜）、ライブラリと Nuxt module（0.8.0〜） |
| [docs/broker-operations.md](docs/broker-operations.md) | fallback broker と client の再解決、常設 broker メッシュ、broker の接続制御 |
| [docs/development.md](docs/development.md) | ビルドとテスト、ネイティブ client、公開手順、既知の課題 |

## ライセンス

MIT
