# @agent-hand/messenger (loader)

`npx -y @agent-hand/messenger <command>` で起動する薄いランチャー。
本体 `@agent-hand/messenger-core` を設定可能な npm ソース（既定: Gitea Packages）から取得・キャッシュして実行する。依存ゼロ。

本体の置き場を変えても、`claude mcp add` の登録や `.npmrc` は変更不要。

## 環境変数

| 変数 | 既定 | 用途 |
|---|---|---|
| `AGENT_MESSENGER_CORE_SPEC` | `git+http://192.168.1.202/gitea/agent-hand/messenger.git#semver:^0.3` | 本体の npm spec。既定は Gitea の git リポジトリ（公開、トークン不要、タグ `vX.Y.Z` を semver 解決）。`@scope/name@1.2.3` / `git+http://…#tag` / `file:/path` など npm が解釈できるもの全て |
| `AGENT_MESSENGER_CORE_REGISTRY` | `http://192.168.1.202/gitea/api/packages/agent-hand/npm/` | SPEC が registry 指定（`@agent-hand/messenger-core@…`）の時の取得先。Gitea Packages に publish した後に切り替える用 |
| `AGENT_MESSENGER_CORE_DIR` | `~/.agent-messenger/core` | キャッシュ先 |
| `AGENT_MESSENGER_CORE_REFRESH` | なし | `1` で本体を再取得 |
| `AGENT_MESSENGER_CORE_TTL_HOURS` | `24` | 版固定でない spec の再確認間隔。`0` で毎回確認 |

本体の引数・環境変数（`AGENT_MESSENGER_HOST` など）はそのまま本体へ渡る。

## 動作

1. registry + spec からキャッシュディレクトリを決める
2. 未取得、`REFRESH=1`、または floating spec が TTL 超過なら `npm install --prefix <cache> <spec>` で取得
3. 取得失敗時はキャッシュがあればそれで起動（オフライン耐性）
4. `node <cache>/node_modules/@agent-hand/messenger-core/bin/agent-messenger.js <args>` を実行し、終了コードとシグナルを引き継ぐ
