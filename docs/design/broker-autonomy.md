# broker 自律協調と接続制御 設計書（0.11.0）

- 対象: broker のメッシュ相手探しを discovery に一本化、client の「保存した接続先」、新ツール `get_broker` / `set_broker`
- 基準: develop `c687510`（0.10.0）
- 指示書: `docs/history/20261028-broker-autonomy/task.md`
- 状態: 設計のみ（未実装）。「合意済み」は指示書の合意済み仕様（変更不可）、「提案」は本書で決めた案。

## 1. 目的と現状

目的は、メッシュ broker 同士が設定ファイルなしで互いを見つけて同期し、client は接続先の確認・切替をセッション内で行えるようにすること。

0.10.0 の現状（コード上の事実）:

| 箇所 | 現状 |
|---|---|
| broker `index.ts` | `cfg.mesh` のとき `Mesh.urls = meshBrokers`（固定）か `readMeshBrokers(cfg.configFile)`（client 用 `config.json` の `brokers` を毎ラウンド読む）。 |
| broker `discovery.ts` | 応答は `{"agent-messenger":"broker", id, port, version, fallback?}`。probe にのみ応答。告知（自発送信）なし。 |
| broker `mesh.ts` | 相手の `/mesh/sync` 応答 `id` が自分と同じなら `self` として以後スキップ。 |
| client `resolve.ts` | env → `config.json` の `brokers`（先頭から health 1.5 s）→ discovery（非 fallback 優先）→ `127.0.0.1` fallback。 |
| client `messenger.ts` | 失敗で grace（`graceMs`、既定 30 s）→ 全解決やり直し → `registerPeer` → `resendDefinitions`。 |

## 2. discovery メッセージの拡張（提案）

### 2.1 パケット

既存 2 種（probe / reply）にフィールドを足し、告知 1 種を新設する。旧実装は値が一致しない JSON を捨てるため、追加フィールドと新種別は旧 client / 旧 broker に無害。

| 種別 | 送信者 | 形 |
|---|---|---|
| probe（拡張） | client / broker | `{"agent-messenger":"probe", n?}` 。`n` = メッシュ broker が付ける 16 byte 乱数（hex）。client は付けない。 |
| reply（拡張） | 全 broker | 既存 + `mesh?: true` + `mac?: string`。`mac` は probe に `n` があり、かつ自分がメッシュ対象の時だけ付ける。 |
| announce（新設） | メッシュ broker のみ | `{"agent-messenger":"announce", id, port, version, mesh:true, ts, mac}`。`ts` = 送信時刻（ms）。 |

`mesh: true` は client 向け表示（`get_broker`）にも使う。fallback broker は `mesh` を付けない（合意済み 7）。

### 2.2 token の照合（token を UDP に流さない）

- `mac = hex(HMAC-SHA256(key = token, data = "am-mesh/1|" + nonce + "|" + id + "|" + port)).slice(0, 32)`（128 bit）。
- `nonce` は reply では probe の `n`、announce では `ts` の 10 進文字列。
- 受信側は自分の token で同じ値を計算し、一致したものだけを同期相手にする（合意済み 1「token 一致のみ」）。
- announce は `|now - ts| <= 60 s` のものだけ受理する（古い announce の再送で相手一覧に残り続けるのを防ぐ）。
- token が空同士は空鍵の HMAC が一致するので相手になる。空と非空は一致しない。
- 比較は `timingSafeEqual`。`id` と `port` を MAC に含めるので、他人の announce の `port` 差し替えは通らない。

### 2.3 周期と失効

| 項目 | 値（提案） | env |
|---|---|---|
| announce 周期 | 10 s（起動直後に 1 回） | `AGENT_MESSENGER_MESH_ANNOUNCE_MS`（新設） |
| 起動時 probe | 起動直後に 1 回（`n` 付き、応答待ち 1 s） | なし |
| 相手の失効 | 最後の announce / 有効 reply から 35 s（周期の 3 倍強） | なし（announce 周期から算出） |

- 失効は「相手一覧から外す」だけ。複製 peer の寿命は既存 `AGENT_MESSENGER_MESH_PEER_TTL_MS`（既定 300 s、`/mesh/sync` 途絶起点）のまま変えない。二つは別の時計で、相手一覧の失効が先に来ても複製 peer は TTL まで残る（短時間の UDP 欠落で peer が消えない）。
- 相手一覧から外れた後も `/mesh/sync` が成功している間は残す（UDP だけが落ちる経路の救済）。外すのは「announce 途絶 かつ 直近の sync 失敗」の時。

## 3. broker の相手一覧（提案）

新モジュール `packages/broker/src/mesh-peers.ts` に `MeshPeerTable` を置き、`Mesh.urls` はこのテーブルを返す。

| 操作 | 内容 |
|---|---|
| 発見 | announce 受信 / 起動時 probe への reply 受信で、MAC 一致なら `url = http://<UDP 送信元>:<port>` を登録（`id`, `version`, `lastSeen`）。 |
| 自分の除外 | `id === cfg.id` は登録しない。加えて既存の `/mesh/sync` 応答 `id` 一致による `self` 判定を残す（同 id 誤設定の二重防御）。 |
| 同一 id の別 URL | 後勝ちで URL を更新（broker の IP 変更・再起動に追従）。旧 URL の link 状態は破棄。 |
| 失効 | 2.3 の条件で削除。削除時に `mesh: <url> left` をログ。 |
| `/mesh/sync` の宛先 | 毎ラウンド、テーブルの現在値。宛先 0 件なら sync しない。 |

- 受信: メッシュ broker の discovery responder（既存ソケット、7902）が probe に加えて announce も処理する。announce の送信先は client の probe と同じ（`255.255.255.255` + 各 IF の directed broadcast、`AGENT_MESSENGER_DISCOVERY_ADDR` 固定時はそこだけ）。
- 削除するもの: `readMeshBrokers`、`BrokerOptions.meshBrokers` / `configFile` の broker 側利用（合意済み 1）。`meshBrokers` はテスト用に「固定相手（discovery を使わない）」として残すか消すかは未決 1。
- `AGENT_MESSENGER_MESH=on` でも `AGENT_MESSENGER_DISCOVERY=off` なら相手を見つけられない。起動時に warn を出す（エラーにはしない）。

## 4. 旧 broker（0.10.0）との混在（提案）

| 組み合わせ | 挙動 |
|---|---|
| 0.11 client → 0.10 broker | reply に `mesh` が無いだけ。接続・送受信は従来どおり。`get_broker` の一覧で `mesh: false` と表示。 |
| 0.10 client → 0.11 broker | 追加フィールドを無視。従来どおり。 |
| 0.11 mesh broker ↔ 0.10 mesh broker | 0.11 側は 0.10 の reply に `mesh` / `mac` が無いので相手にしない。0.10 側が config で 0.11 を指していれば 0.10→0.11 の sync は成立し、peer は両側に見える。0.11 から 0.10 の peer 宛メッセージは 0.11 の outbox に残り、0.10 を更新した次の同期で届く（`meshDrop` は受理後のみなので消えない）。 |

方針: メッシュ broker は同時に 0.11 へ上げる。README に「混在中は 0.11 側から 0.10 側 peer 宛の配送が更新まで保留」と書く。

## 5. client

### 5.1 解決順（合意済み 2 + 提案）

```
0. pin      set_broker(url) で固定した URL（セッション内のみ）
1. env      AGENT_MESSENGER_HOST (+PORT)
2. saved    ~/.agent-messenger/client.json の broker → 旧 config.json の brokers（読み込み互換）
3. discover UDP probe（非 fallback 優先。同条件なら mesh 優先）
4. local    127.0.0.1:PORT（autoStartBroker 時は fallback 起動）
```

- pin を env より前に置く理由: `set_broker` はセッション内の明示操作で、合意済み 5「固定は自動切替より優先」を env 設定環境でも成立させるため。`set_broker()`（url 省略）で pin を外すと 1 から再解決する。
- 固定先の障害（合意済み 5）: 既存 grace（`graceMs`、30 s）中は固定先を再試行。grace 切れで pin を外し、1 からの通常再解決に入る。外したことをログと `get_broker` の `source` で示す。固定先が復帰しても自動で戻さない（戻すのは `set_broker` 再実行）。
- `options.brokers`（ライブラリ / Nuxt の `brokers`）は 2 の「保存した接続先」と同じ扱い（先頭から health）。

### 5.2 保存形式（提案）

- ファイル: `~/.agent-messenger/client.json`（`broker.json` は broker の state なので別名）。env `AGENT_MESSENGER_CLIENT_STATE` で差し替え可（テスト用）。
- 内容: `{"broker": "http://host:port", "saved_at": "<ISO8601>"}`。1 件のみ。
- 書き込み: `set_broker(url, persist: true)` で上書き、`set_broker(persist: true)`（url 省略）で `broker` を削除。一時ファイル + rename。
- 旧 `config.json` の `brokers`: 読み込み互換として残す（Tailscale 越しの既存運用が `config.json` に依存しているため）。`client.json` の後に試し、使った時に 1 回 `config.json brokers is deprecated; use set_broker(url, persist: true)` をログ。0.12.0 で廃止予定と README に書く。

### 5.3 `set_broker(url?, persist?)` の手順（合意済み 4）

`requiresRegistration: false`。再解決ループと排他（既存 `resolving` フラグを共用）。

1. url 正規化（スキーム省略可、port 省略時 7901）。url 省略時は自動解決で新 URL を決める（pin 解除）。
2. 新 URL が現在と同じなら 7 へ（`persist` だけ反映）。
3. 新 URL を `health`（2 s）。不通なら何も変えず `BROKER_UNREACHABLE`。
4. 旧 broker から未読を退避: `inbox.poll(false)` で未配信を手元バッファへ取り込み、手元バッファ全件を旧 broker に acknowledge（旧 id で）。バッファ内容は保持し、`check_messages` で読める（ack 先が新 broker に変わって ack が迷子になるのを防ぐ）。旧 broker 不通ならこの段は飛ばす。
5. 旧 broker に `/unregister`（best effort）。
6. `setUrl(新)` → `registerPeer`（name / summary / protocols 宣言を引き継ぐ）→ `resendDefinitions`。失敗したら旧 URL に戻して再登録し `BROKER_SWITCH_FAILED`。
7. pin を設定（url 省略時は解除）。`persist` が真なら 5.2 を書く。`failSince` を解除。
8. 結果として `get_broker` と同じ内容を返す。

切替後に旧 broker へ届いたメッセージ: 両 broker がメッシュなら旧 broker は同名 peer を複製として持つので転送される。メッシュでなければ送信者側に `unknown peer` が返る（従来と同じ）。

### 5.4 `get_broker` の出力（合意済み 3）

`requiresRegistration: false`。discovery は呼ぶたびに 1 回実行（`discoveryTimeoutMs`）。

```
broker: http://192.168.1.204:7901 (id 204, v0.11.0, mesh)
source: discovery
pinned: no   saved: http://100.64.0.3:7901
discovered:
  - 204  http://192.168.1.204:7901  v0.11.0  mesh
  - mac  http://192.168.1.10:7901   v0.10.0  fallback
```

`source` は `env` / `saved` / `discovery` / `fallback` / `set_broker`（合意済み 3 の語彙。旧 `config.json` 由来も `saved`）。

### 5.5 ライブラリ API / Nuxt（提案）

```ts
interface BrokerInfo {
  url: string; id: string; version: string; mesh: boolean;
  source: "env" | "saved" | "discovery" | "fallback" | "set_broker";
  pinned: boolean; saved: string | null;
  discovered: { id: string; url: string; version: string; mesh: boolean; fallback: boolean }[];
}
MessengerClient.getBroker(): Promise<BrokerInfo>
MessengerClient.setBroker(url?: string, opts?: { persist?: boolean }): Promise<BrokerInfo>
```

- ツールは `ToolContext` に `connection?: { get(): Promise<BrokerInfo>; set(url?, persist?): Promise<BrokerInfo> }` を足して呼ぶ（registry は messenger が組み立てるので注入できる）。
- `ResolvedBroker.source` は文字列のまま残し、新フィールド `kind`（上記 5 値）を足す（ログ互換）。
- Nuxt: ツールは registry 経由で自動公開される。`useMessenger()` が返す client に 2 メソッドが増える。`brokers` オプションは 5.1 のとおり「保存した接続先」扱いで据え置く。
- 依存: `DiscoveryReply` に `mesh?` / `mac?`、`DiscoveryProbe` に `n?`、`DiscoveryAnnounce` 型と `DISCOVERY_ANNOUNCE_VALUE` を `packages/protocol/src/discovery.ts` に追加。`HealthResponse` に `mesh?: true` を追加（`get_broker` の現在接続先表示に使う）。

## 6. e2e（合意済み 6）

### 6.1 loopback で 2 broker を見せる方法（提案）

同一ホストで同じ UDP port に 2 ソケットを bind した場合の unicast 配送先は OS 依存（片方にしか届かない）で、既存 e2e の「discovery を 127.0.0.1 に固定」では 2 台を見つけられない。そこで discovery 送信先の明示リストを新設する。

- env `AGENT_MESSENGER_DISCOVERY_TARGETS`（新設）: `host:port` のカンマ区切り。設定時は broadcast の代わりにこの全宛先へ probe / announce を送る。client と broker で共通。
- 各 broker は自分の discovery port を別にする（例 17922 / 17932）。両 broker と client に `DISCOVERY_TARGETS=127.0.0.1:17922,127.0.0.1:17932` を渡す。
- LAN の複数サブネット（broadcast が届かない）運用にも使えるが、主用途はテスト。

### 6.2 シナリオ（`scripts/e2e-mcp.mjs` に追加）

| # | 手順 | 判定 |
|---|---|---|
| 1 | broker A / B を `MESH=on`、同 token、別 HTTP / discovery port、`MESH_ANNOUNCE_MS=500` で起動 | 両 `/health` が ok |
| 2 | 待つ（最大 5 s） | A の peer が B の `/list-peers` に出る（相互発見と sync） |
| 3 | client X / Y を起動（解決は discovery。X は A、Y は B に繋がるよう `set_broker` で固定） | `get_broker` の url と `source: set_broker` |
| 4 | X で `set_protocol`、Y から `list_peers(protocol)` / `send_message(meta)` | Y の一覧に X、X が meta 付きで受信 |
| 5 | broker A を停止 | — |
| 6 | grace（e2e は `GRACE_MS=2000`）後、X が B に移る | X の `get_broker` が B、`source: discovery` |
| 7 | Y → X、X → Y の `send_message(meta)` | 双方受信、`list_peers(protocol)` に X が残る（protocol 再登録） |
| 8 | token 違いの broker C を起動 | A/B の相手一覧に C が入らない（`/health` の peers 件数と B のログで判定） |

8 は合意済み 1「token 一致のみ」の確認。unit（vitest、`packages/broker/test/mesh.test.ts`）に MAC 計算・失効・自分除外の試験を足す。

## 7. エラー一覧（提案）

| コード | 発生 | 文面（ツール） |
|---|---|---|
| `INVALID_BROKER_URL` | `set_broker` の url が解釈不能 / http 以外 | `Invalid broker URL: <url>` |
| `BROKER_UNREACHABLE` | 新 URL の health 失敗（変更なし） | `Broker <url> is not reachable; still connected to <current>` |
| `BROKER_SWITCH_FAILED` | 新 broker への register 失敗（旧に復帰） | `Could not register with <url> (<reason>); back on <current>` |
| `BROKER_SWITCH_BUSY` | 再解決 / 別の切替が実行中 | `Broker switch in progress; try again` |
| `SAVE_FAILED` | `client.json` 書き込み失敗（切替自体は成功） | `Switched to <url>, but could not save it: <reason>` |
| （ログ） | MAC 不一致の announce / reply | broker ログ `mesh: ignoring <id>@<addr> (token mismatch)`（同一送信元は 1 回だけ） |
| （ログ） | `MESH=on` かつ `DISCOVERY=off` | broker 起動時 warn |

## 8. 実装計画

| 段 | 内容 | 見積り |
|---|---|---|
| 1 | protocol: discovery 型拡張、MAC 計算関数（`packages/protocol` に置き broker / client 共用）、`HealthResponse.mesh` | 0.5 日 |
| 2 | broker: announce 送信・受信、`MeshPeerTable`、`readMeshBrokers` 廃止、`DISCOVERY_TARGETS`、unit 試験 | 1.5 日 |
| 3 | client: `client.json`、解決順（pin / saved / 旧 config 互換）、`kind`、`DISCOVERY_TARGETS` | 1 日 |
| 4 | client: `setBroker` / `getBroker`、ツール 2 本、ToolContext 拡張、unit 試験 | 1.5 日 |
| 5 | e2e: 6.2 のシナリオ | 1 日 |
| 6 | README（メッシュ節・env 表・混在注意・config 廃止予定）、Nuxt 型、CHANGELOG | 0.5 日 |

合計 6 日。段 1 → 2 / 3（並行可）→ 4 → 5 → 6。

## 9. 未決事項（ユーザー判断が要るもの）

1. `BrokerOptions.meshBrokers`（discovery を使わない固定相手）を残すか: 残すと既存 `mesh.test.ts` がそのまま使えるが、合意済み 1「相手探しは discovery のみ」の例外になる。提案は「テスト専用として残し README に載せない」。
2. `set_broker` を env（`AGENT_MESSENGER_HOST`）より優先してよいか: 提案は優先（5.1）。不可なら env 設定時の `set_broker` は `BROKER_PINNED_BY_ENV` で拒否する。
3. 旧 `config.json` の `brokers` 読み込み互換の廃止時期: 提案は 0.12.0。
