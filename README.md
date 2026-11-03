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

同じ LAN に broker が無ければ、最初のセッションがローカル（`127.0.0.1:7901`）に fallback broker を自動起動する。別ホストとやり取りするには、次の「セットアップ」で常設 broker を 1 台立てる。

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

## protocol（0.10.0〜）

セッションが「どんな種類のメッセージを、どんな形で話すか」を宣言し、相手を protocol で探せるようにする。

- protocol repo は、ルートに `protocol.json`（必須。`name` / `version` / `description` / `messages`）と `PROTOCOL.md`（任意。運用説明）を置いた Git repo、またはそのローカルディレクトリ。`set_protocol` が受け付けるのは **public** の GitHub / Gitea repo とローカル path のみ（private repo は `REPO_UNREACHABLE`）。
- `set_protocol(repo, version?)` は tag（`1.2.0` / `v1.2.0`）の `protocol.json` と `PROTOCOL.md` を取得し、hash を付けて broker に登録する。1 セッションに複数の protocol を宣言でき、同じ name は版を置き換える。
- 同じ `name@version` で中身が違う定義は `PROTOCOL_CONFLICT` で拒否される。宣言者がいなくなった定義は broker から消える。定義は `broker.json` に保存され、broker の再起動後も heartbeat で復旧する。
- `list_peers(protocol, version?)` で話せる相手を探し、`get_protocol(name)` で定義を読み、`send_message(meta: {protocol, version})` で従う protocol を付けて送る。受け側の表示に `Protocol: name@version` が付き、自分の宣言と版が違えば mismatch が示され、返信の結果に警告が付く。
- 0.9 の broker では `set_protocol` / `list_peers(protocol)` が `BROKER_UNSUPPORTED` になる（0.10.0 以上が必要）。meta 無しの送受信は従来どおり。

## ライブラリと Nuxt module（0.8.0〜）

ツール定義と受信処理は stdio MCP から切り離してライブラリとして使える。stdio の挙動（ツール一覧・文言・instructions・capabilities）とは golden fixture で一致を確認している。

- `@unagents/messenger-client/tools`: `TOOL_DEFS` / `INSTRUCTIONS` / `toolDescriptors()` / `createToolRegistry(ctx)`（`list()` と `call(name, args)`）/ `formatPeer` / `formatMessage`
- `@unagents/messenger-client`（`"."`）の `createMessengerClient(options?)`。`connect()` / `close()` / `send` / `ping` / `listPeers` / `setName` / `setSummary` / `checkMessages` / `onMessage(handler)` / `getBroker()` / `setBroker(url?, { persist? })`。`autoStartBroker` の既定は `false`
- 受信 handler の再配信は同一プロセス・同一 peer id の範囲のみ（約 1 s 後に再投入）。プロセス再起動や再登録（新 id）を跨いだ再配信はしない。handler は冪等にし、恒久的に失敗する入力は自分で握りつぶす（失敗し続ける handler は無制限に再試行される）
- 1 プロセスに `createMessengerClient` を複数作らない（broker は同じ pid + hostname を 1 peer として扱う）

`@unagents/messenger-nuxt`（`packages/nuxt/`）は上記ライブラリを使う Nuxt 4 module。導入手順・runtimeConfig・`useMessenger()`・`messenger:message` hook・`/mcp` のセキュリティ注意は [`packages/nuxt/README.md`](packages/nuxt/README.md) を参照。

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@unagents/messenger-nuxt'],
  messenger: { name: 'my-nuxt', brokers: ['http://127.0.0.1:7901'] },
})
```

- `messenger:message` に listener があればそこへ配信（全 listener 成功で ack、失敗は再配信）。無ければ消費せず `useMessenger().checkMessages()` で取得
- `@nuxtjs/mcp-toolkit` を入れた場合のみ、ツールを `/mcp` に追加する。`/mcp` 自体に認証は無く、broker の token を迂回できる点に注意

## broker の見つけ方（mcp / CLI）

上から順に試し、最初に決まった所を使う。

0. `set_broker(url)` で固定した接続先（セッション内のみ。`AGENT_MESSENGER_HOST` より優先）
1. `AGENT_MESSENGER_HOST`（+ `AGENT_MESSENGER_PORT`）。`auto` または未設定なら次へ
2. 保存した接続先: `~/.agent-messenger/client.json` の `broker`、次に旧 `~/.agent-messenger/config.json` の `{"brokers": [...]}`（先頭から `/health` が返る最初の 1 つ）。旧 config は **0.12.0 で廃止予定**で、使うと 1 回だけ警告をログに出す。移行は `set_broker(url, persist: true)`
3. LAN 自動発見: UDP ブロードキャスト（port 7902）に対し、稼働中の broker が `{id, port, version}` で応答。fallback でない broker を優先し、同条件なら mesh 参加の broker を優先
4. `127.0.0.1:7901`。mcp はここで broker を自動起動する（fallback broker。下記）

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
| `AGENT_MESSENGER_MESH` | `off` | `on` で常設 broker メッシュに参加（下記） |
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

## fallback broker と client の再解決（0.7.0〜）

- 解決順 4 番目の `127.0.0.1:7901`（client が自動起動するローカル broker）は fallback broker（`AGENT_MESSENGER_FALLBACK=1`）として起動する。`/health` と発見応答に `"fallback": true` が付く。常設 broker は付かない。
- fallback broker は `AGENT_MESSENGER_FALLBACK_INTERVAL_MS`（既定 10 秒）ごとに UDP 発見で他の broker を探す（`AGENT_MESSENGER_DISCOVERY=off` なら探さない）。自分自身と別の fallback は対象外。本来の broker が見つかると、未配信メッセージを `POST /relay-messages` で転送してから自己終了する。転送が失敗したら終了せず次の周期で再試行する。
- `/relay-messages` は宛先を peer の名前（+ホスト名）で指定する。受け側は登録済みの該当 peer にすぐ配信し、まだ登録されていなければ保留（state file の `pending`、TTL 1 時間）して、その名前の peer が登録または改名した時点で配信する。名前の無い peer 宛は届けられず破棄する。`/relay-messages` を知らない旧 broker（404）には `/send-message` で名前宛に送る（登録済みの peer にのみ届く）。
- client は broker に繋がらなくなると、同じ URL を猶予（`AGENT_MESSENGER_GRACE_MS`、既定 30 秒）の間再試行し、過ぎたら broker を再解決する（env → config → 発見 → ローカル fallback 起動。成功まで最大 5 秒間隔）。fallback が自己終了した後も同じで、猶予後に本来の broker へ戻って再登録する。heartbeat が拒否された場合は猶予なしで再解決し、再登録する。
- 発見結果は fallback でない broker を優先して並べる。

## 常設 broker メッシュ（0.11.0〜）

常設 broker を複数台（例: 拠点ごとに 1 台）置く場合に相互同期し、どの broker に繋いだ peer からも `list_peers` で全ホストの peer が見えるようにする。

- 参加するのは `AGENT_MESSENGER_MESH=on` で起動した broker のみ。相手は設定ファイル無しで UDP 発見により見つける。fallback で自動起動された broker は `on` にしないので参加せず、`/mesh/sync` に 404 を返す。
- 同期は `POST /mesh/sync`（全 mesh broker が相互に送る）。自分に直接登録された peer を送り、相手の peer を受け取る。相手の peer 宛の未配信メッセージも一緒に転送し、相手が受理してから手元で破棄する。
- 片側が停止中でも、もう一方は送受信を続ける。停止側の peer 宛メッセージは手元に積まれ、復帰後の次の同期で届く。複製 peer は元 broker の同期が途絶えて `AGENT_MESSENGER_MESH_PEER_TTL_MS` 経つと消える。
- 相手の見つけ方: mesh broker は起動時に 1 回 probe し、以後 `AGENT_MESSENGER_MESH_ANNOUNCE_MS` ごとに UDP で自分を告知（announce）する。受けた broker は **同じ token の broker だけ**を相手にする。token は UDP に流さず、token を鍵にした HMAC で照合する。token が違う broker は相手にならない（broker ログに `token mismatch` を 1 回出す）。
- 相手の失効: announce が途絶えて告知間隔の 3 倍 + 5 秒を過ぎ、かつ直近の同期も失敗している相手を一覧から外す。UDP だけが落ちて同期が通っている間は残る。複製した peer の寿命（`AGENT_MESSENGER_MESH_PEER_TTL_MS`）とは別の時計。
- 自分自身は id で除外する。mesh broker ごとに `AGENT_MESSENGER_BROKER_ID` を別の値にする。
- 発見を使うので `AGENT_MESSENGER_MESH=on` では `AGENT_MESSENGER_DISCOVERY=off` にしない（相手を見つけられない。起動時に警告を出す）。UDP broadcast が届かない LAN は `AGENT_MESSENGER_DISCOVERY_TARGETS` で相手の発見ポートを明示する。
- 旧 broker の `config.json` の `brokers` を相手一覧として読む動作は廃止した（broker 側のみ。client の保存した接続先としては 0.12.0 まで読む）。
- クライアントの変更は不要。旧 client（0.6.3）はそのまま使える（`list_peers` は従来の peer 形式を返す）。
- 全 broker で `AGENT_MESSENGER_TOKEN` を同じ値にする（相手の照合と同期の認証に使う）。
- **混在注意**: メッシュ broker は同時に 0.11.0 以上へ上げる。0.11 の mesh broker は 0.10 の broker を発見で相手にしない（0.10 の応答に mesh の印が無いため）。0.10 側が config で 0.11 を指していれば 0.10 → 0.11 の同期だけ成立し、peer は両側に見えるが、0.11 から 0.10 側 peer 宛のメッセージは 0.10 を 0.11 に更新して次の同期が通るまで 0.11 側に保留される。
- 有効化は常設 broker の起動環境に `AGENT_MESSENGER_MESH=on` を足す（systemd なら `deploy/agent-messenger-broker.service` の該当行のコメントを外す）。

## broker の接続制御（0.11.0〜）

- `get_broker` は現在の接続先・決まり方・保存済み・発見中の broker を返す。発見は呼ぶたびに 1 回実行する。
- `set_broker(url, persist?)` の手順: 新 URL の `/health`（2 秒）→ 旧 broker の未読を手元へ退避（`check_messages` で読める）→ 旧 broker に unregister → 新 broker に名前・summary・protocol 宣言を引き継いで登録。新 broker に登録できなければ旧 broker へ戻す。
- 固定（pin）は `AGENT_MESSENGER_HOST` より優先する。固定先が落ちても猶予（`AGENT_MESSENGER_GRACE_MS`）の間は同じ URL を再試行し、猶予が尽きたら固定を外して通常の解決順で別の broker に移る。固定先が復帰しても自動では戻らない。
- `set_broker()`（url 省略）は固定を外して再解決する。`persist: true` を付けると保存した接続先（`client.json`）を書き換える（url 省略時は削除）。
- エラー: `INVALID_BROKER_URL` / `BROKER_UNREACHABLE`（変更なし）/ `BROKER_SWITCH_FAILED`（旧 broker に復帰）/ `BROKER_SWITCH_BUSY` / `SAVE_FAILED`（切替自体は成功）。
- ライブラリ: `MessengerClient.getBroker()` / `setBroker(url?, { persist? })`。Nuxt の `useMessenger()` からも同じ。

## 配信の仕組み

1. mcp が 1 秒ごとに broker を poll し、受信メッセージをローカルバッファに積む。
2. `CLAUDE_CODE_MESSAGING_SOCKET` があれば、その Unix socket に `{"type":"auth","token":…}` と `{"type":"user","message":{"role":"user","content":…}}` を 1 行ずつ書いて投入する（Claude Code の own-child message）。成功したら broker に ack。
3. socket が無い／失敗したら channel 通知（`notifications/claude/channel`）を試み、成功したら ack。
4. どちらも失敗したメッセージはバッファと broker に残り、`check_messages` で取り出せる。
5. heartbeat は 15 秒ごと。60 秒途絶えた peer は broker から消える（未配信メッセージも破棄）。

同一マシン内のセッション間は Claude Code 標準の cross-session messaging（`SendMessage` / `ListAgents`、`/list-agents`）でも送れる。agent-messenger が要るのはホストをまたぐ場合（Remote Control を使わない構成）。

## 開発

### ビルドとテスト

```bash
npm ci
npm run build        # protocol を先に build してから全 workspace（unbuild → packages/*/dist）
npm run typecheck    # tsgo（@typescript/native-preview）
npm test             # vitest（全 workspace）
```

テストは loopback で broker・疑似 npm registry を立てる。外部ネットワークには接続しない。

統合確認（疑似 registry から 6 パッケージを取得し、`cli discover / mcp（native・node）/ peers / status / send / broker`、session socket 投入、node フォールバックを通す）:

```bash
node scripts/e2e-mcp.mjs [--broker direct|cli]
```

### ネイティブ client（PerryTS）

```bash
PERRY_HOME=<perry の rel/ と clang がある dir> node scripts/build-native.mjs [--clean]
```

`packages/client/native/messenger-client-<platform>-<arch>` と `packages/client-<platform>-<arch>/`（`package.json` + `bin/messenger-client`）を生成する。生成されるのは実行したホストの platform のみなので、darwin-arm64 と linux-x64 はそれぞれのホストで実行し、`bin/messenger-client` を集める。

前提: Perry の archive（LLVM 23.1 製の bitcode を含む）を読める `llvm-nm` / `llvm-objcopy` を PATH の先頭に置く。Perry は link 前の `[strip-dedup]` で stdlib と net 拡張の重複シンボルを取り除くが、読めないと `(non-fatal)` で飛ばし、重複を残したまま link する（darwin では新しい ld が stub 側を選び、broker に接続できない native client になる）。`build-native.mjs` は Perry の出力の `[strip-dedup]` 行を検査し、未完了ならバイナリを消し、platform package に何も書かず、非 0 で終了する。

道具は rust `nightly-2026-09-21` の `llvm-tools`（LLVM 23.1.1）。rustup は不要で、tarball を取得し、sha256 が manifest（`https://static.rust-lang.org/dist/2026-09-21/channel-rust-nightly.toml` の `[pkg.llvm-tools-preview.target.<target>]` の `xz_url` / `xz_hash`）と一致するのを確かめてから展開する。

| target | `xz_url`（`https://static.rust-lang.org/dist/2026-09-21/` 配下） | `xz_hash`（sha256） |
|---|---|---|
| aarch64-apple-darwin | `llvm-tools-nightly-aarch64-apple-darwin.tar.xz` | `957afe6f5eef8d959ba7d0b4bd65b607a03fc2044441f97a3d1e459ad829b619` |
| x86_64-unknown-linux-gnu | `llvm-tools-nightly-x86_64-unknown-linux-gnu.tar.xz` | `f4a7240bfbf9073d4d2b5f1bff63eb0641deaaa81db9d49f64b1602dbb3d6032` |

```bash
curl -fO https://static.rust-lang.org/dist/2026-09-21/llvm-tools-nightly-<target>.tar.xz
sha256sum llvm-tools-nightly-<target>.tar.xz     # macOS は shasum -a 256。上の表の値と一致を確認
mkdir llvm-tools && tar -xJf llvm-tools-nightly-<target>.tar.xz -C llvm-tools
# 展開物の llvm-nm / llvm-objcopy がある dir（linux では llvm-tools/llvm-tools-nightly-<target>/llvm-tools-preview/lib/rustlib/<target>/bin）
PATH=<その dir>:$PATH PERRY_HOME=<perry の rel/ と clang がある dir> node scripts/build-native.mjs
```

linux-x64 では GNU binutils 2.42 の `nm` / `objcopy` だけでも `[strip-dedup]` が完了することを確認している。release の build は上の `llvm-tools` を PATH に入れて行う。

### 公開手順

publish の順序は protocol → broker → client → platform 2 種 → cli。基本手順と broker 切替・ロールバックは `docs/release-0.5.0.md`、各版の変更点と互換性は `docs/release-<version>.md` を参照。

## 既知の課題

`docs/issues.md` を参照。

## ライセンス

MIT
