# セットアップと設定

## セットアップ

### 1. broker（LAN に 1 台）

```bash
AGENT_MESSENGER_BIND=0.0.0.0 AGENT_MESSENGER_PORT=7901 \
  npx -y @unagents/messenger broker
```

確認: `curl http://<broker-host>:7901/health` → `{"status":"ok","version":"…","peers":N}`

常駐化する場合は `deploy/agent-messenger-broker.service`（systemd user unit）を使う。導入手順はファイル先頭のコメントを参照。LAN 外からの到達を防ぐため、公開ネットワークでは `AGENT_MESSENGER_TOKEN` を broker と全クライアントに設定する。

### 2. 各ホストで Claude Code に導入

plugin を入れる（推奨）。MCP サーバー `agent-messenger` と使い方の skill が入る。

```bash
claude plugin marketplace add unagents/agent-messenger
claude plugin install messenger@agent-messenger
```

plugin を使わず MCP だけ直接登録する場合（plugin と両方入れると二重起動になる）:

```bash
claude mcp add --scope user --transport stdio agent-messenger \
  -- npx -y @unagents/messenger mcp
```

broker は UDP 自動発見で見つかる。発見が使えない環境（broadcast が届かない LAN、VPN 越し等）は `--env AGENT_MESSENGER_HOST=<broker-host>` を足すか、セッション内で `set_broker(url, persist: true)` で保存する。

セッションに固定名を付けたい場合はプロジェクトの `.mcp.json` で `AGENT_MESSENGER_NAME` を渡す（project scope が user scope より優先）。
名前を渡さない場合はセッション内で `set_name` ツールを呼ぶ。

### 3. Claude Code の起動

通常の `claude` 起動でよい。着信は Claude Code が各セッションに用意する inbox socket（`CLAUDE_CODE_MESSAGING_SOCKET`、MCP 子プロセスに継承される）へ投入され、会話に「別セッションからのメッセージ」として届く（Claude Code v2.1.224 以降、cross-session messaging）。投入内容は送信側が決める: `send_message` の既定（`delivery: "pull"`）は着信通知 1 行（本文は `check_messages` で取得）、`delivery: "push"` は本文そのもの、`send_ping` は ping 通知 1 行。

socket が無い環境（古いバージョン、bare mode 等）では channel push にフォールバックする。channel push は起動フラグが要る:

```bash
claude --dangerously-load-development-channels server:agent-messenger
```

どちらも効かない場合は `check_messages` ツールで受信する（送信は常に可能）。配信方式は `AGENT_MESSENGER_DELIVERY`（`auto` / `socket` / `channel`）で固定できる。

## broker の見つけ方（mcp / CLI）

上から順に試し、最初に決まった所を使う。

0. `set_broker(url)` で固定した接続先（セッション内のみ。`AGENT_MESSENGER_HOST` より優先）
1. `AGENT_MESSENGER_HOST`（+ `AGENT_MESSENGER_PORT`）。`auto` または未設定なら次へ
2. 保存した接続先: `~/.agent-messenger/client.json` の `broker`、次に旧 `~/.agent-messenger/config.json` の `{"brokers": [...]}`（先頭から `/health` が返る最初の 1 つ）。旧 config は **0.12.0 で廃止予定**で、使うと 1 回だけ警告をログに出す。移行は `set_broker(url, persist: true)`
3. LAN 自動発見: UDP ブロードキャスト（port 7902）に対し、稼働中の broker が `{id, port, version}` で応答。fallback でない broker を優先し、同条件なら mesh 参加の broker を優先
4. `127.0.0.1:7901`。mcp はここで broker を自動起動する（fallback broker。[broker の運用](broker-operations.md) 参照）

`npx -y @unagents/messenger discover` で、設定ファイルの内容・応答した broker・最終的に選んだ URL を表示する（セッション内の `get_broker` は固定・保存・発見を一度に表示する）。broker 側は起動時に UDP 7902 で応答を始める（`AGENT_MESSENGER_DISCOVERY=off` で無効化）。

## 環境変数

### broker / client 共通

| 変数 | 既定 | 用途 |
|---|---|---|
| `AGENT_MESSENGER_HOST` | なし（`auto`） | broker のホスト。`127.0.0.1` のときは mcp 起動時に broker を自動起動する。未設定なら上記の解決順 |
| `AGENT_MESSENGER_PORT` | `7901` | broker のポート（claude-peers の 7899 と衝突させないため別番号） |
| `AGENT_MESSENGER_TOKEN` | なし | Bearer トークン。broker と全クライアントで同じ値を設定 |
| `AGENT_MESSENGER_DISCOVERY` | `on` | `off` で UDP 発見を無効化 |
| `AGENT_MESSENGER_DISCOVERY_PORT` / `_ADDR` / `_TIMEOUT_MS` | `7902` / なし / `1000` | 発見用 UDP ポート・探索先固定・応答待ち |
| `AGENT_MESSENGER_DISCOVERY_TARGETS` | なし | 発見の送信先を `host:port` のカンマ区切りで明示（設定時は broadcast の代わりに client の probe と broker の announce をここへ送る。broadcast が届かない LAN とテスト用。client と broker で同じ値にする） |

### client（mcp）

| 変数 | 既定 | 用途 |
|---|---|---|
| `AGENT_MESSENGER_NAME` | なし | このセッションの名前 |
| `AGENT_MESSENGER_DELIVERY` | `auto` | 受信配信方式。`auto` = session socket があれば socket、無ければ channel。`socket` / `channel` で固定 |
| `AGENT_MESSENGER_CLIENT_STATE` | `~/.agent-messenger/client.json` | client の保存した接続先（`set_broker(url, persist: true)` が書く） |
| `AGENT_MESSENGER_CONFIG` | `~/.agent-messenger/config.json` | 旧 broker 一覧の設定ファイル（0.12.0 で廃止予定。broker は読まない） |
| `AGENT_MESSENGER_GRACE_MS` | `30000` | broker に繋がらなくなってから、同じ URL を再試行し続ける猶予（過ぎたら再解決） |

### broker

| 変数 | 既定 | 用途 |
|---|---|---|
| `AGENT_MESSENGER_BIND` | `0.0.0.0` | bind アドレス |
| `AGENT_MESSENGER_BROKER_ID` | ホスト名 | broker の識別子（`/health` と発見応答に載る） |
| `AGENT_MESSENGER_STATE` | `~/.agent-messenger/broker.json` | 状態ファイル |
| `AGENT_MESSENGER_FALLBACK` | なし | `1` で fallback broker として起動（client が自動起動時に付ける。手動では通常使わない） |
| `AGENT_MESSENGER_FALLBACK_INTERVAL_MS` | `10000` | fallback broker が他の broker を探す間隔 |
| `AGENT_MESSENGER_MESH` | `off` | `on` で常設 broker メッシュに参加（[broker の運用](broker-operations.md) 参照） |
| `AGENT_MESSENGER_MESH_INTERVAL_MS` | `5000` | メッシュ同期の間隔 |
| `AGENT_MESSENGER_MESH_ANNOUNCE_MS` | `10000` | メッシュ broker が自分を UDP で告知する間隔（相手の失効は間隔の 3 倍 + 5 秒） |
| `AGENT_MESSENGER_MESH_PEER_TTL_MS` | `300000` | 他 broker から複製した peer が、その broker の同期途絶後に残る時間 |

### CLI（loader）

| 変数 | 既定 | 用途 |
|---|---|---|
| `AGENT_MESSENGER_REGISTRY` | npmjs | broker / client / platform package の取得元 registry の URL（private registry に上書き可） |
| `AGENT_MESSENGER_BROKER_SPEC` / `AGENT_MESSENGER_CLIENT_SPEC` | `latest` | 取得する版（`1.2.3` / `file:…` など npm spec） |
| `AGENT_MESSENGER_PKGS_DIR` | `~/.agent-messenger/pkgs` | キャッシュ先 |
| `AGENT_MESSENGER_REFRESH`（旧 `AGENT_MESSENGER_CORE_REFRESH` も可） | なし | `1` で再取得 |
| `AGENT_MESSENGER_TTL_HOURS` | `24` | `latest` 等の再確認間隔。`0` で毎回。キャッシュの版が CLI より古い時は、間隔を待たず再確認する（CLI の版ごとに 1 回） |
| `AGENT_MESSENGER_CLIENT` | なし（auto） | `native` / `node` で client の種類を固定 |
