# broker 死活監視・待機フラグ・分担配送 設計書（0.13.0）

- 対象: peer の最終アクセス時刻、消失判定と掃除、死亡 / 終了通知、待機フラグ tool `watch_peers` / `unwatch_peers`、mesh を使った通知の分担配送
- 基準: develop `e182ed5`（0.11.0）。0.12.0（`feature/drop-config-brokers`、旧 `config.json` の `brokers` 読み込み廃止）の上に積む。本書は 0.12.0 の変更（client の解決順）に依存しない。
- 指示書: `docs/history/20261029-broker-liveness/task.md`
- 状態: 設計のみ（未実装）。「要望」は指示書の依頼元要望、「提案」は本書で決めた案。

## 1. 目的と現状

目的は、報告待ちのエージェント（bantou の master-cap）が、相手の終了・消失を broker から知らされて待ち続けないようにすること（要望 1〜4）。

0.11.0 の現状（コード上の事実）:

| 箇所 | 現状 |
|---|---|
| client heartbeat | `HEARTBEAT_INTERVAL_MS` = 15 s（env `AGENT_MESSENGER_HEARTBEAT_MS`）。`/heartbeat` が拒否されたら即再解決・再登録。 |
| client poll | `POLL_INTERVAL_MS` = 1 s で `/poll-messages`。 |
| `last_seen` 更新 | `register`（作成時）と `heartbeat` のみ。poll・送信・ack 等では更新しない。heartbeat ごとに `scheduleSave`。 |
| stale 判定 | `isAlive`: direct peer は `last_seen >= now - HEARTBEAT_TIMEOUT_MS`（60 s、固定）。掃除 `cleanStalePeers` は 30 s 周期（起動時も 1 回）。よって消失から削除まで 60〜90 s。 |
| 削除経路 | `cleanStalePeers`（stale）、`unregister`（client の `close()`。stdin EOF / SIGINT / SIGTERM、`set_broker` 切替時の旧 broker への best effort）、`register` の pid+hostname 置換、`meshApplyPeers` の replica 差し替え。いずれも理由を区別せず `removePeer` に入り、誰にも通知しない。 |
| mesh replica | `origin` 付き。生存は `originSeen`（origin broker の最終 sync）から `meshPeerTtlMs`（既定 300 s）以内。`last_seen` は sync 時刻で上書き。origin 側で消えた peer は次の sync で replica からも消える（理由は伝わらない）。 |
| mesh 形 | discovery で見つけた全 broker と直接 sync（フルメッシュ、1 ホップ）。周期 `meshIntervalMs` 5 s、即時 `kick` あり。 |
| broker → client | 経路なし。client は pull（poll）のみ。session socket は client ホスト内のローカル UNIX socket。 |
| 通知表示 | client inbox が mode で分岐: `pull` = 未読通知 1 行、`push` = 本文、`ping` = 1 行（バッファに残さず即 ack）。 |

## 2. 最終アクセス時刻（要望 1、提案）

- 自分の peer id を運ぶルートの受理時に `last_seen` を更新する: `/heartbeat`、`/poll-messages`、`/acknowledge-messages`、`/get-buffered-messages`、`/set-summary`、`/set-name`、`/set-protocol`、`/unset-protocol`、新設 `/watch` `/unwatch`、`/send-message`（`from_id` が direct peer のとき）。
- 更新は `BrokerHandlers.touch(id)` 1 か所にまとめる。direct peer のみ（replica は origin 側の責務）。
- 永続化: poll 起因の更新はメモリのみ（1 s ごとの書き込みを避ける）。ディスクは従来どおり heartbeat の `scheduleSave` で 15 s 以内に追随する。
- 効果: poll が 1 s 周期なので、生きている client の `last_seen` は通常 1 s 以内に保たれる。これにより 3 章の「疑い」判定を heartbeat 周期より短くできる。
- `list_peers` の各 peer に `idle_s`（最終アクセスからの秒数、direct は broker 時計、replica は origin の値）と `state`（`alive` / `suspect`）を足す。旧 client は未知フィールドを無視する。

## 3. 死活確認と掃除（要望 2、提案）

### 3.1 health check の手段

broker から client へ到達する経路が無いため、選択肢を比べた。

| 案 | 内容 | 判定 |
|---|---|---|
| A 期限のみ | 現状の 60 s 期限 | 速さが足りない。誤判定耐性は今と同じ。 |
| B 最終アクセス + 同一ホスト pid 確認 + 期限 | 2 章の `last_seen` で疑い、同一ホストなら pid を確かめ、他ホストは期限で確定 | 採用。新しい通信路が不要。 |
| C broker → client の HTTP 呼び戻し | client に待受を持たせる | 却下。client は NAT / コンテナ内のことがあり、待受は攻撃面も増やす。 |
| D session socket 経由の確認 | broker が socket に書く | 却下。socket は client ホストのローカルで、書けば会話に文字が入る。 |

案 B の判定（`cleanStalePeers` を 5 s 周期の `sweepLiveness` に置き換え）:

| 状態 | 条件 | 動作 |
|---|---|---|
| alive | `idle < SUSPECT_MS`（10 s） | なし |
| suspect | `idle >= SUSPECT_MS` | 同一ホスト（`peer.hostname === os.hostname()`）なら `process.kill(pid, 0)`: `ESRCH` なら即 lost 確定。`EPERM` / 成功なら生存扱いで期限待ち。`list_peers` の `state: suspect`。 |
| lost | `idle >= LOST_MS`（60 s、`HEARTBEAT_TIMEOUT_MS` と同値） | 名簿から削除し `lost` イベント（4 章）。 |

- pid 再利用の誤判定（別プロセスが同じ pid を得た）は「生存扱い」側に倒れるだけで、期限で確定するので害は遅延のみ。
- broker がコンテナ内で hostname が異なる場合は pid 確認は働かず、期限のみになる。

### 3.2 誤判定への耐性

- **broker 自身のスリープ / 時計の跳び**: `sweepLiveness` は前回実行からの経過を測る。周期の 3 倍（15 s）を超えていたら、全 direct peer の `last_seen` を現在時刻に置き直して 1 周見送る（ログ `liveness: clock gap <n>s, grace for all peers`）。復帰直後の一斉 lost を防ぐ。
- **client のスリープ / ネットワーク断**: 60 s で lost になり通知される（正しい通知）。復帰した client は heartbeat 拒否 → 再登録になる。同じ `name` + `hostname` の peer が lost から `BACK_WINDOW_MS`（10 分）以内に再登録したら `back` イベントを、その peer を watch している者にだけ送る（4.2）。
- **移動（broker 切替・フェイルオーバー）**: lost 確定直前に、同じ `pid` + `hostname` の生存 peer が名簿（direct / replica 問わず）にあれば「移動」とみなし、イベントを出さずに削除する。replica は 5 s ごとの sync で届くので、60 s の期限内に通常は判明する。
- **`register` の pid+hostname 置換**: 同一セッションの再登録なのでイベントを出さない（現状どおり）。

### 3.3 終了（exit）と消失（lost）の区別

- `/unregister` に `reason?: "exit" | "switch"` を足す。`exit`（省略時も同じ、旧 client 互換）は `exit` イベント、`switch`（`set_broker` 切替時の旧 broker への unregister）はイベントなし。
- client の `close()` は stdin EOF / SIGINT / SIGTERM で呼ばれる。Claude Code が異常終了しても MCP の stdin が閉じれば `exit` になる。つまり `exit` は「MCP セッションが閉じた」、`lost` は「client プロセスが応答しなくなった（kill -9、フリーズ、ネットワーク断、スリープ）」を意味する。この限界は README に書く（未決 2）。

## 4. 通知（要望 2、提案）

### 4.1 イベント

broker 内部の型（`packages/protocol` に追加）:

```ts
interface PeerEvent {
  eid: string;            // "<broker id>:<seq>"（重複排除キー）
  kind: "exit" | "lost" | "back";
  peer: { id: string; name: string; hostname: string; pid: number };
  at: string;             // ISO、発生 broker の時計
  idle_s?: number;        // lost: 最終アクセスからの秒数
  origin: string;         // 発生 broker id
}
```

- 発生元は対象 peer の direct broker のみ（replica を持つ broker は自分では判定しない、5 章の例外を除く）。
- 同じ掃除周期で複数の peer が消えたら、受け手ごとに 1 通にまとめる（broker 停止時の大量通知を避ける）。

### 4.2 配送先

| 案 | 内容 | 評価 |
|---|---|---|
| a 全員 | 全 peer に exit / lost を配る | 要望 2 の文言どおり。peer 数 × 終了数で騒がしく、無関係なエージェントの文脈を消費する。 |
| b 関心登録者のみ | 6 章で watch した者にだけ配る | 静か。bantou の用途（master-cap の待機）を満たす。 |
| c 混合 | watch 者には全種、それ以外には lost のみ 1 行 | 中間。exit は通常運用で頻発するので外す。 |

推奨は **b を既定、broker env `AGENT_MESSENGER_LIVENESS_NOTIFY=watchers|lost|all`（b / c / a）で切替**。理由は、bantou の用途は watch で満たせ、全員通知は peer 数が増えるほどノイズが全エージェントの作業を妨げるため（未決 1）。`back` は常に watch 者のみ。

### 4.3 通知の形

- 新しい message mode `event` を足す。broker は宛先 peer のキューに `{mode: "event", from_id: "broker", from_name: "", text: <表示文>, event: PeerEvent[]}` を積む。
- client inbox は `event` を `ping` と同じく扱う（バッファに残さず即 ack、`check_messages` に出さない）。stdio host の新メソッド `notifier.event()` が 1 行を session socket → channel の順に入れる（既存 ping と同じ経路）。
- 表示文:

```
[agent-messenger] 終了: remote-cap-A@host204（unregister）
[agent-messenger] 消失: remote-worker-AA@host206（最終応答 63 秒前）
[agent-messenger] 復帰: remote-worker-AA@host206（lost から 4 分後に再登録）
```

  複数件は 1 行ずつ並べ、先頭に `[agent-messenger] peer 状態の変化 N 件` を置く。watch 対象には行末に `［watch］` を付ける。
- 旧 client（0.12.x 以前）は `event` を知らず未読扱いにしてしまうため、broker は `register` / `heartbeat` で `features: ["events"]` を申告した peer にだけ `event` を積む。旧 client には何も届かない。
- `send_ping` との整合: ping は「相手が生きている」通知、event は「broker が判定した状態変化」。表示語を分けて混同を避ける。ping 受信は送信者の `last_seen` 更新にもなる（2 章、`/send-message` の `from_id`）。

## 5. 分担配送（要望 4、提案）

- 発生元 broker は event を自分の direct peer の宛先に積み、同時に mesh の送信箱 `eventOutbox`（相手 broker ごと）へ入れる。次の sync（`kick` で即時）で `MeshSyncRequest.events?: PeerEvent[]` として全 mesh 相手に渡す。応答 `MeshSyncResponse.events_accepted?: string[]`（eid）で受理分を送信箱から消す。逆方向も同様に応答 `events?` / 次要求 `events_accepted?` で返す。
- 受け手 broker は自分の **direct peer にだけ** 配る（4.2 の配送先規則で）。フルメッシュ 1 ホップなので再転送しない（ループなし）。
- 重複排除: broker は受理済み eid を `recentEventIds`（上限 2000、`recentMeshKeys` と同形）で覚え、二重受理を捨てる。client も直近 200 eid を覚える（broker 切替直後の再配送対策）。
- mesh 分断: 送信箱は相手ごとに `EVENT_TTL_MS`（10 分）保持し、復旧後の sync で渡す。受け手は `at` が 10 分より古いものを捨てる（ログのみ）。届いた古い event は表示文に `（N 分前）` を付ける。
- 例外（origin broker 自体が消えた場合）: replica を持つ broker は、origin が `meshPeerTtlMs` を過ぎて replica を落とす時、その replica を watch している自分の direct peer にだけ `lost`（`idle_s` なし、表示 `消失: <name>@<host>（broker <origin> と不通）`）を出す。mesh には流さない（各 broker が自分で判定するため）。移動判定（3.2）は同様に効かせる。
- origin が旧 broker（`events` を送らない）の replica が sync で消えたら、watch 者にだけ `exit` / `lost` を区別できない `gone` 相当として `lost` を出し、表示を `消失または終了: …（旧 broker 経由のため区別不可）` にする。

## 6. 待機フラグ tool（要望 3、提案）

### 6.1 tool

| tool | 引数 | 動作 |
|---|---|---|
| `watch_peers` | `peers: string[]`（name または id、1 件以上）、`on?: ("message" \| "exit" \| "lost")[]`（既定 3 種すべて） | 対象を登録（同じ対象は `on` を置き換え）。結果は現在の全 watch 一覧と各対象の今の状態（`alive` / `suspect` / `absent`）。 |
| `unwatch_peers` | `peers?: string[]`（省略時は全解除） | 解除。結果は残りの一覧と解除件数。 |

- 例: master-cap が `watch_peers({peers: ["remote-cap-A", "remote-cap-B", "remote-worker-AA"]})`。
- name 指定は name で照合する（再登録で id が変わっても追える）。id 指定は登録時に `{id, name, pid, hostname}` に解決して保持し、pid+hostname の再登録にも追従する。
- 登録時に存在しない name は `absent` として保持し、後から現れた peer にも効く（相手の起動前に watch できる）。存在しない id は `PEER_NOT_FOUND` で拒否。
- `back` は `lost` を watch していれば自動で付く。

### 6.2 寿命

- watch は watcher の direct broker が持つ（`BrokerState.watches`、`broker.json` に保存）。キーは watcher の pid+hostname で、同じ broker での再登録では引き継ぐ。
- watcher が名簿から消えたら（exit / lost / 移動）その watch も消す。
- broker 切替時は client が自分の watch 一覧を覚えていて、再登録後に `/watch` を送り直す（`resendDefinitions` と同じ位置）。
- 永続的（発火しても消えない）。解除は `unwatch_peers` か watcher の終了のみ。

### 6.3 発火

| 条件 | 判定する broker | 表示 |
|---|---|---|
| message: 対象から watcher 宛てのメッセージがキューに入った | watcher の broker（`sendMessage` / `meshAccept` / relay の enqueue） | 既存の未読通知 / push 本文の先頭を `[agent-messenger] 待機中の相手から未読 N 件（from …）` に変える。メッセージに `watched: true` を付けて client に伝える。新しい通知は増やさない。 |
| exit / lost / back | event を受けた watcher の broker（5 章） | 4.3 の 1 行（`［watch］` 付き） |

### 6.4 ライブラリ API / Nuxt

```ts
MessengerClient.watch(peers: string[], on?: WatchKind[]): Promise<WatchState[]>
MessengerClient.unwatch(peers?: string[]): Promise<WatchState[]>
MessengerClient.onEvent(handler: (events: PeerEvent[]) => void): () => void
interface WatchState { target: string; on: WatchKind[]; state: "alive" | "suspect" | "absent"; peer?: { id: string; name: string; hostname: string } }
```

- tool は registry 経由で Nuxt にも自動公開。`useMessenger()` の client に 3 メソッドが増える。
- broker ルート: `/watch` `{id, peers, on?}` → `{ok, watches}`、`/unwatch` `{id, peers?}` → `{ok, watches, removed}`。`PROTOCOL_ROUTES` と同様の追加ルート表 `LIVENESS_ROUTES` に置く。404（旧 broker）は既存コード `BROKER_UNSUPPORTED` で tool エラーにする。

## 7. 既存 mesh / protocol との整合、旧版混在（提案）

- discovery・token 照合（MAC）は変えない。event は認証済みの `/mesh/sync` にだけ乗る。
- protocol GC（`gcProtocols`）は従来どおり peer 削除後に走る。削除経路を `removePeer(id, reason)` に一本化し、reason（`exit` / `switch` / `lost` / `moved` / `replaced` / `replica`）でイベント要否を決める。
- `HealthResponse` に `liveness?: true` を足し、client はこれと `/watch` の 404 で対応可否を判定する。

| 組合せ | 挙動 |
|---|---|
| 新 broker + 旧 client | 2 章の時刻更新・3 章の判定は効く。旧 client には event を積まない。旧 client を watch することはできる。 |
| 旧 broker + 新 client | `watch_peers` は `BROKER_UNSUPPORTED`。他の tool は従来どおり。 |
| 新 broker と旧 broker の mesh | 旧側は `events` を無視する。旧 broker の peer には通知が届かない。旧 origin の replica の消失は 5 章末の扱い。 |

## 8. e2e（`scripts/e2e-mcp.mjs` に追加、提案）

0.11.0 e2e と同じく 2 broker（`MESH=on`、同 token、`DISCOVERY_TARGETS`、`MESH_ANNOUNCE_MS=500`）。e2e では閾値を env で縮める（`AGENT_MESSENGER_LIVENESS_SUSPECT_MS=1000`、`..._LOST_MS=4000`、掃除周期 500 ms）。

| # | 手順 | 判定 |
|---|---|---|
| 1 | client W（watcher）を A、X / Y / Z を B に接続（`set_broker`） | 4 者が両 broker の `list_peers` に出る |
| 2 | W が `watch_peers(["X","Y","Z"])` | 結果に 3 件、`state: alive` |
| 3 | X が W に `send_message` | W の通知文が `待機中の相手から未読` で始まる |
| 4 | Y の client を stdin close で正常終了 | W に `終了: Y@…［watch］`、`消失` ではない |
| 5 | Z の client を kill -9 | W に `消失: Z@…［watch］`（LOST_MS + 掃除周期 + sync 以内） |
| 6 | 別 client V（A、watch なし、`LIVENESS_NOTIFY=watchers`）| V には 4・5 の通知が来ない |
| 7 | `LIVENESS_NOTIFY=all` の broker で 5 を再実施 | V にも `消失` が 1 回だけ届く（重複なし） |
| 8 | Z を同じ name で再起動 | W に `復帰: Z@…` |
| 9 | X を `set_broker` で A に移す | W に exit / lost が出ない（移動判定と `reason: switch`） |
| 10 | W が `unwatch_peers()` 後に X を kill -9 | W に通知なし |

unit（vitest）: `touch` の対象ルート、suspect / lost の境界、pid 確認（ESRCH / EPERM のモック）、時計の跳び、移動判定、event のまとめと eid 重複排除、送信箱の TTL、watch の名前照合と寿命。

## 9. 実装計画

| 段 | 内容 | 見積り |
|---|---|---|
| 1 | protocol: `PeerEvent`、mode `event`、`features`、`/unregister.reason`、`/watch` `/unwatch` 型、`MeshSync*.events*`、`HealthResponse.liveness`、閾値定数 | 0.5 日 |
| 2 | broker: `touch`、`sweepLiveness`（suspect / pid / 時計の跳び / 移動判定）、`removePeer(reason)`、event 生成とまとめ、`list_peers` の `idle_s` / `state`、unit | 1.5 日 |
| 3 | broker: watch 保存と寿命、message 発火の `watched`、mesh の event 送受・重複排除・TTL、origin 消失時の例外、unit | 1.5 日 |
| 4 | client: `features` 申告、inbox の `event`、`notifier.event()`、`watched` の通知文、`unregister(reason)`、watch の再送、tool 2 本、ライブラリ API、unit | 1.5 日 |
| 5 | e2e: 8 章 | 1 日 |
| 6 | README（死活監視節・env 表・exit の意味）、Nuxt 型、CHANGELOG | 0.5 日 |

合計 6.5 日。段 1 → 2 → 3 / 4（並行可）→ 5 → 6。

## 10. 未決事項（ユーザー判断が要るもの）

1. 死亡・終了の通知先: 推奨は「watch した者のみ」を既定とし、env で lost のみ全員 / 全種全員に切替（4.2）。要望 2 の「全エージェントに通知」を既定にするかを決めてほしい。
2. `exit` は Claude Code の異常終了でも出る（MCP の stdin が閉じるため）。この区別の限界を受け入れて README 明記で済ませてよいか。
3. 消失確定の閾値: 既定 60 s（現行と同値、スリープ・瞬断に強い）を維持するか、検知を速めて 30 s にするか。

## 11. 決定（2026-10-29）

1. 死亡・終了の通知先: **watch した者のみ**を既定とする（ユーザー決定、A）。env で全員通知に切り替え可能（4.2 のとおり）。
2. `exit` が Claude Code の異常終了でも出る限界は受け入れ、README に明記する（w-cap 決定）。
3. 消失確定の閾値は 60 s を維持する（スリープ・瞬断での誤判定を避けるため、w-cap 決定）。
