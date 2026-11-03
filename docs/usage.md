# ツールと CLI の使い方

## ツール（MCP）

| ツール | 内容 |
|---|---|
| `list_peers` | 接続中セッション一覧。`scope`: `all`(既定) / `host` / `directory` / `repo`。`protocol` / `version` を渡すと、その protocol（と version）を宣言中のセッションだけ返す（`scope` と併用可） |
| `send_message` | `to`（名前または id）へ送信。ホストをまたいで届く。`delivery`: `pull`(既定) / `push`。`meta`: `{protocol, version}` で従う protocol を付ける（両方必須） |
| `send_ping` | `to` に生存通知を送る。`subject`（任意、1 行）に作業中のタスク名などを付けられる。受け側は 1 行の ping 通知を見るだけで、読む・返信する必要は無い |
| `set_name` | このセッションに名前を付ける（他 peer が名前で宛先指定できる） |
| `set_summary` | 作業内容の 1〜2 文（list_peers に表示） |
| `check_messages` | 未読メッセージの取得と既読化。channel push 無しの環境では必須 |
| `set_protocol` | `repo`（と任意の `version`）の protocol を、このセッションが話すものとして宣言する。定義を取得して broker に登録する |
| `unset_protocol` | 宣言を解除する。`name` 省略で自分の全宣言 |
| `get_protocol` | broker が持つ protocol の定義（`protocol.json` と `PROTOCOL.md`）を表示する。`version` 省略で最新 |
| `get_broker` | 今繋いでいる broker（url・id・版・mesh）、その決まり方（`env` / `saved` / `discovery` / `fallback` / `set_broker`）、保存済みの broker、いま発見で見える broker を表示する |
| `set_broker` | このセッションの接続先を `url` の broker に切り替える（名前・summary・protocol 宣言は引き継ぐ）。`url` 省略で固定を外して再解決。`persist: true` で次回以降も使う設定として保存する |

## CLI

```bash
npx -y @unagents/messenger <command>
```

| command | 内容 |
|---|---|
| `mcp` | stdio MCP サーバーとして起動（Claude Code から呼ばれる） |
| `broker` | broker を起動 |
| `status` | broker の `/health` を表示 |
| `peers` | 接続中 peer の一覧 |
| `send <name\|id> <message...>` | peer にメッセージを送る |
| `discover` | 設定ファイルの内容・発見で応答した broker・最終的に選んだ URL を表示 |

```bash
export AGENT_MESSENGER_HOST=<broker-host>   # 自動発見が使える LAN では不要
npx -y @unagents/messenger status
npx -y @unagents/messenger peers
npx -y @unagents/messenger send my-session "作業完了"
```
