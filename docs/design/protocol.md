# protocol 機能 設計書（0.10.0）

- 対象: `set_protocol` / `unset_protocol` / `get_protocol` / `list_peers(protocol)` / `send_message(meta)`
- 基準: develop `b03496a`（0.9.0）
- 指示書: `docs/history/20261028-protocol-design/task.md`
- 状態: 設計のみ（未実装）。「合意済み」は指示書の合意済み仕様、「提案」は本書で決めた案。

## 1. 目的と用語

目的は、相手の名前を知らなくても「ある protocol を話す待受側」を見つけ、定義（メッセージ形式と運用説明）を得て、protocol 付きで送受信できるようにすること。

| 用語 | 意味 |
|---|---|
| server | `set_protocol` を実行した待受側 messenger（peer）。 |
| caller | protocol 名だけを知って server を探し、メッセージを送る側。 |
| protocol repo | 定義を置く Git repo（GitHub / Gitea / ローカル path）。 |
| 定義本体 | protocol repo から server が取得した `protocol.json` + `PROTOCOL.md` の組。 |
| hash | 定義本体の正規化 JSON の sha256（hex）。 |

server の識別は既存の peer 識別（`set_name` の名前 / id / host）をそのまま使う。protocol 固有の識別子は作らない（合意済み）。

## 2. 全体フロー

```
 protocol repo                server (client)                 broker                    caller (client)
 (GitHub/Gitea/path)
      |   1. tags 取得           |                                |                            |
      |<-------------------------|  set_protocol(repo, version?)  |                            |
      |   2. protocol.json /     |                                |                            |
      |      PROTOCOL.md 取得    |                                |                            |
      |------------------------->|  3. version 解決・検証・hash   |                            |
      |                          |  4. POST /set-protocol ------->|  (name,version) に保存     |
      |                          |     {id, name, version, hash,  |  peer に宣言を紐付け        |
      |                          |      definition}               |  hash 衝突なら拒否          |
      |                          |<------------------ ok ---------|                            |
      |                          |  5. heartbeat に宣言を載せる ->|  宣言の維持・再登録        |
      |                          |                                |<-- list_peers(protocol) ---|
      |                          |                                |--- server 一覧 + version ->|
      |                          |                                |<-- get_protocol(name,ver) -|
      |                          |                                |--- 定義本体（broker 保持）->|
      |                          |                                |<-- send_message(to, text,  |
      |                          |                                |     meta{protocol,version})|
      |                          |<-- poll: message + meta -------|                            |
      |                          |  6. version 照合（不一致でも受信）                          |
      |                          |  7. 返信時、不一致なら warning を添える ------------------->|
```

- broker は repo に出ない（合意済み: 取得元 A）。
- 定義は broker 間で mesh 同期される（合意済み）。caller はどの broker に繋いでいても同じ一覧を得る。

## 3. protocol repo の形式（提案）

repo ルートに 2 ファイルを置く。

| ファイル | 必須 | 内容 |
|---|---|---|
| `protocol.json` | 必須 | 機械可読の定義。 |
| `PROTOCOL.md` | 任意 | 運用説明（LLM が読む）。無ければ `""`。 |

`protocol.json`:

```json
{
  "name": "review-request",
  "version": "1.2.0",
  "description": "コードレビュー依頼と結果返却",
  "messages": {
    "request": { "type": "object", "required": ["repo", "ref"], "properties": { "repo": { "type": "string" }, "ref": { "type": "string" } } },
    "result":  { "type": "object", "required": ["verdict"], "properties": { "verdict": { "enum": ["approve", "reject"] } } }
  }
}
```

- `name`: `^[a-z0-9][a-z0-9._-]{0,63}$`。protocol の識別名。repo 名と一致しなくてよい。
- `version`: semver。取得した tag（先頭 `v` を除去）と一致必須。tag 無し repo（`0.0.0+<sha>`）では `protocol.json` の `version` は照合しない（任意値でよい）。
- `description`: 1 行。
- `messages`: メッセージ種別名 → JSON Schema。client は検証に使わない（LLM が読む参考情報）。schema の妥当性検査は「object であること」のみ。

## 4. ツール仕様

MCP の 3 ツールを追加し、`list_peers` / `send_message` を拡張する。ツール数は 6 → 9。

### 4.1 set_protocol（requiresRegistration: true）

| 引数 | 型 | 必須 | 説明 |
|---|---|---|---|
| `repo` | string | 必須 | 受け付け形は 6.1。 |
| `version` | string | 任意 | tag 名（`v1.2.0` / `1.2.0` どちらも可）。未指定は最新。 |

- 1 peer が宣言できる protocol は複数可（name ごとに 1 version）。同じ name を別 version で再宣言したら置き換え。
- 戻り（成功）: `Protocol set: review-request@1.2.0 (sha256 1a2b3c4d…, from github:owner/repo)`。
- エラー: 7 章の一覧。

### 4.2 unset_protocol（requiresRegistration: true）

| 引数 | 型 | 必須 | 説明 |
|---|---|---|---|
| `name` | string | 任意 | 解除する protocol 名。未指定は自分の全宣言を解除。 |

合意済み仕様は `unset_protocol()`（引数なし）。複数宣言を許すため `name` を任意引数として足す（引数なしの挙動は合意どおり）。

- 戻り: `Protocol unset: review-request` / `Protocol unset: (all, N)`。宣言なしでも成功（`No protocol set.`）。

### 4.3 get_protocol（requiresRegistration: false）

| 引数 | 型 | 必須 | 説明 |
|---|---|---|---|
| `name` | string | 必須 | protocol 名。 |
| `version` | string | 任意 | 未指定は broker が持つ最新 version（semver 比較、`0.0.0+sha` は最小扱い）。 |

- 戻り: `review-request@1.2.0 (sha256 …, servers: 2)` の見出し、`description`、`protocol.json` 本文（JSON）、`PROTOCOL.md` 本文。
- server への往復はしない（合意済み）。

### 4.4 list_peers（拡張）

| 追加引数 | 型 | 説明 |
|---|---|---|
| `protocol` | string | 指定時、その protocol を宣言中の server だけを返す。`scope` と併用可（AND）。 |
| `version` | string | `protocol` 指定時のみ有効。その version の server だけ。 |

- 表示は既存 `formatPeer` に `Protocol: review-request@1.2.0` 行を追加。
- 0 件: `No server for protocol "review-request" (version: any).`

### 4.5 send_message（拡張）

| 追加引数 | 型 | 説明 |
|---|---|---|
| `meta` | object | `{protocol: string, version: string}`。指定するなら両方必須（合意済み）。 |

- `meta` は任意引数（protocol を使わない従来送信を壊さないため）。指定時に片方欠けたら client でエラー。
- 受信表示（`formatMessage` / 未読通知 / push 表示）に `Protocol: review-request@1.2.0` を付ける。
- 不一致 warning は 6.4。

### 4.6 ライブラリ API / Nuxt（合意済み 9）

`MessengerClient` に追加:

```ts
setProtocol(repo: string, version?: string): Promise<ProtocolInfo>;
unsetProtocol(name?: string): Promise<void>;
getProtocol(name: string, version?: string): Promise<ProtocolDefinition>;
listPeers(scope?: PeerScope, filter?: { protocol?: string; version?: string }): Promise<ProtocolPeer[]>;
send(to: string, text: string, delivery?: "pull" | "push", meta?: MessageMeta): Promise<SendResult>;
```

Nuxt module は `toolDescriptors()` 経由で MCP ツールを登録しているため、TOOL_DEFS に足せば自動で露出する。`zod-shape.ts` が `object` 型引数（`meta`）を変換できるかは実装時に確認・対応する。

## 5. broker API とデータモデル

### 5.1 ルート（提案）

既存の transport 規約（GET は `/health` のみ、他は全て POST + JSON + Bearer）に合わせる。指示書例の `GET /protocols/:name` / `DELETE` 形ではなく POST に統一する。理由は client の HTTP 実装・認可・404 判定の流用。

| ルート | request | response |
|---|---|---|
| `POST /set-protocol` | `{id, name, version, hash, definition}` | `{ok:true}` / `{ok:false, error, code}` |
| `POST /unset-protocol` | `{id, name?}` | `{ok:true, removed: number}` |
| `POST /get-protocol` | `{name, version?}` | `{ok:true, protocol: StoredProtocol, servers: number}` / `{ok:false, error, code}` |
| `POST /list-peers`（拡張） | 既存 + `protocol?`, `version?` | `Peer[]`（各要素に `protocols?`） |
| `POST /heartbeat`（拡張） | 既存 + `protocols?: ProtocolDecl[]` | 既存 + `resend?: string[]` |
| `POST /register`（拡張） | 既存 + `protocols?: ProtocolDecl[]` | 既存 |
| `POST /send-message`（拡張） | 既存 + `meta?: MessageMeta` | 既存 |

新ルートは `BROKER_POST_ROUTES` とは別の定数（`PROTOCOL_ROUTES`）にする。`RELAY_ROUTE` と同じ扱い。

### 5.2 型（`packages/protocol/src/http.ts` に追加）

```ts
interface ProtocolDecl { name: string; version: string; hash: string }
interface ProtocolDefinition { manifest: object /* protocol.json */; doc: string /* PROTOCOL.md */; source: string /* 正規化 repo 表記 */; ref: string /* tag or sha */ }
interface StoredProtocol extends ProtocolDecl { definition: ProtocolDefinition; registered_at: string }
interface MessageMeta { protocol: string; version: string }
// Peer に追加: protocols?: ProtocolDecl[]   Message に追加: meta?: MessageMeta
```

### 5.3 broker の保持

- `BrokerState.protocols: Map<"name@version", StoredProtocol>`。
- 宣言は `Peer.protocols` に持つ（peer と寿命を共有）。peer が stale で消えれば宣言も消え、一覧から消える（合意済み 1）。
- `StoredProtocol` は「その `(name, version)` を宣言する alive peer（mesh 複製含む）が 0 になった時点」で削除（`cleanStalePeers` / `unregister` / `unset-protocol` / `meshApplyPeers` の後で GC）。
- `set-protocol` の判定（合意済み 4）:
  1. hash を broker で再計算し、送られた `hash` と不一致なら `HASH_MISMATCH`。
  2. 同 `(name, version)` が既にあり hash が違えば `PROTOCOL_CONFLICT`（既存 hash と保持 server 一覧を返す）。
  3. 同じなら宣言を peer に追加して成功。

### 5.4 hash と上限（提案）

- hash = `sha256(canonicalJSON({manifest, doc}))`。canonicalJSON はキーを辞書順に並べ空白なしで直列化。`source` / `ref` は含めない（同じ定義を別 mirror から取得しても衝突しない）。
- 上限: `protocol.json` 64 KiB、`PROTOCOL.md` 64 KiB、合計 128 KiB。broker 全体で保持する protocol は 256 件まで（超過は `LIMIT`）。
- client は送信前に検査し、broker も同じ値で再検査する。

### 5.5 heartbeat と再登録

- client は heartbeat に `protocols: ProtocolDecl[]`（hash のみ、本体なし）を毎回載せる。
- broker が宣言の本体を持たない（再起動・GC 後）場合、`resend: ["name@version", …]` を返す。client はキャッシュ済み本体で `/set-protocol` を再送する。
- `heartbeat` が `unknown peer` で re-register するときは、`/register` 後に保持中の宣言を全て `/set-protocol` で再送する。

### 5.6 永続化（提案: 永続化する）

- `broker.json` に `protocols?: StoredProtocol[]` を追加して保存する。既存の peer 永続化（再起動後も peer が残る）と揃えるため。
- 読み込み時、宣言 peer がいない定義は次の GC で消える。5.5 の `resend` があるため、永続化が無くても回復はする（二重の安全網）。
- 旧 broker（0.9.0）は未知フィールドを無視して読み書きするため、ダウングレード時は定義が消えるだけ。

### 5.7 mesh 同期（合意済み 8）

- `MeshSyncRequest` / `MeshSyncResponse` に `protocols?: StoredProtocol[]`（送信側の direct peer が宣言している定義のみ）を追加。
- 複製 peer の `protocols` は `Peer` に載ったまま `meshApplyPeers` で入る。
- 受信側は `(name, version)` ごとに取り込む。既に別 hash を持つ場合は自分側を優先し、受信分は捨ててログに warn（direct の衝突は 5.3 で拒否済みなので、mesh 経由の衝突は「両 broker に同時に別 hash で登録された」競合時のみ）。
- 0.9.0 broker は未知フィールドを無視するので、mesh 混在で壊れない（定義が伝わらないだけ）。

### 5.8 list-peers のフィルタ

`protocol` 指定時: `p.protocols?.some(d => d.name === protocol && (!version || d.version === version))`。version は 6.2 の正規化（先頭 `v` 除去）後の文字列一致。返却 peer は既存形 + `protocols`（合意済み 5 の「既存 peer 形式 + version」）。

### 5.9 send-message の meta

broker は `meta` を検証せず（形だけ: 両 string、各 128 文字以下）`Message.meta` に保存して poll で返す。relay / mesh 転送でも `meta` を落とさない（`RelayedMessage` にも追加）。

## 6. client 側の責務

### 6.1 repo 引数の受け付け形（提案）

| 形 | 例 | 解決 |
|---|---|---|
| GitHub URL | `https://github.com/o/r` | GitHub |
| 短縮 | `o/r` | GitHub |
| 明示 prefix | `github:o/r` / `gitea:https://git.example.com/o/r` | 指定どおり |
| その他 https URL | `https://git.example.com/o/r` | Gitea（`/api/v1/version` 応答で確認、不可なら `UNSUPPORTED_REPO`） |
| ローカル path | `/abs/path` / `./rel` / `file:///abs` | ファイル読み込み |

- 正規化表記（`source`）: `github:o/r` / `gitea:<base>/o/r` / `file:<abs path>`。
- ローカル path の tag 解決は git が要るため、ローカル path は tag 解決をしない。`version` は `protocol.json` の値をそのまま使い、`ref` は `local`。native client で git を使わない制約（指示書）と合わせる。

### 6.2 version 解決（合意済み 3）

1. tag 一覧を取得（GitHub: `GET https://api.github.com/repos/<o>/<r>/tags?per_page=100` をページング、Gitea: `GET <base>/api/v1/repos/<o>/<r>/tags`）。
2. tag 名から先頭 `v` を除き semver として parse。parse 不可は除外。
3. 未指定: prerelease を除外し最大を採用。0 件（tag 無し、または semver tag 無し）なら既定 branch の HEAD sha（GitHub: `GET /repos/<o>/<r>` の `default_branch` → `GET /repos/<o>/<r>/commits/<branch>`、Gitea も同形）を `0.0.0+<sha 先頭 7>` とする。
4. 指定: 正規化後に一致する tag を採用。無ければ `VERSION_NOT_FOUND`（候補の上位 5 件を添える）。
5. ファイル取得: GitHub `https://raw.githubusercontent.com/<o>/<r>/<ref>/<file>`、Gitea `<base>/api/v1/repos/<o>/<r>/raw/<file>?ref=<ref>`。

### 6.3 資格情報（提案）

| 環境変数 | 対象 |
|---|---|
| `AGENT_MESSENGER_GITHUB_TOKEN`（無ければ `GITHUB_TOKEN`） | api.github.com / raw.githubusercontent.com |
| `AGENT_MESSENGER_GITEA_TOKEN` | Gitea（`Authorization: token <t>`） |

token は client 内だけで使い、broker に送らない。ログに出さない。

### 6.4 version 照合と warning（合意済み 7）

- 受信時、`meta.protocol` を自分が宣言していれば version を照合する。
- 一致: 表示に `Protocol: name@ver` を付けるだけ。
- 不一致: 受け取る（判断は LLM）。表示に `Protocol: name@1.1.0 (this server: 1.2.0, mismatch)` を付ける。
- 自分が宣言していない protocol: 表示に `(not served here)` を付ける。
- 返信時の warning: client は「peer id → 直近受信 meta」を記憶する（上限 100 件、LRU）。その peer への `send_message` で、記憶した meta の version が自分の宣言と違えば、送信 text の先頭に `[agent-messenger warning] protocol version mismatch: you sent name@1.1.0, this server serves name@1.2.0` を付け、`meta` に自分の version を入れる。送信結果にも同じ warning 行を返す。

### 6.5 キャッシュ

set_protocol で取得した定義本体はメモリに保持し、5.5 の再送に使う。ディスクキャッシュはしない。

## 7. 互換性（0.9.0 混在）とエラー

### 7.1 混在

| 組み合わせ | 挙動 |
|---|---|
| 0.10 client → 0.9 broker | `/set-protocol` が 404。`set_protocol` は `BROKER_UNSUPPORTED`（broker の version を添える）。`list_peers(protocol)` は broker が未知フィールドを無視し全 peer を返すため、client 側で `protocols` 欄の無い応答を検知して `BROKER_UNSUPPORTED` を返す。`send_message(meta)` は meta が落ちるだけで届く。 |
| 0.9 client → 0.10 broker | 新フィールドを送らないので従来どおり。受信 message の `meta` は 0.9 client が無視する。 |
| 0.10 broker ↔ 0.9 broker（mesh） | 定義と宣言は 0.9 側に伝わらない。peer と message は従来どおり。 |
| heartbeat の `protocols` を 0.9 broker が受信 | 無視される。`resend` が返らないので再送しない。 |

### 7.2 エラー一覧

| code | 発生元 | 条件 | 返す文言（要旨） |
|---|---|---|---|
| `REPO_UNREACHABLE` | client | repo API / raw の通信失敗、404、401/403 | repo と HTTP status、token 環境変数名の案内 |
| `UNSUPPORTED_REPO` | client | 受け付け形に該当しない | 受け付け形の一覧 |
| `NO_TAG` | （発生しない） | tag 無しは `0.0.0+sha` で継続（合意済み 3） | — |
| `VERSION_NOT_FOUND` | client | 指定 version の tag が無い | 候補 tag 上位 5 |
| `INVALID_DEFINITION` | client / broker | `protocol.json` 無し・JSON 不正・必須欄欠け・name 形式違反 | 欠けた欄 |
| `VERSION_MISMATCH` | client | `protocol.json` の version と tag が不一致 | 両方の値 |
| `TOO_LARGE` | client / broker | 5.4 の上限超過 | 上限とサイズ |
| `HASH_MISMATCH` | broker | 送信 hash と再計算 hash が不一致 | — |
| `PROTOCOL_CONFLICT` | broker | 同 `(name, version)` で hash 違い | 既存 hash と保持 server（name@host）、全 server の unset を案内 |
| `LIMIT` | broker | 保持件数上限 | 上限 |
| `PROTOCOL_NOT_FOUND` | broker | `get-protocol` で該当なし | 登録済み version 一覧（あれば） |
| `BROKER_UNSUPPORTED` | client | broker が 0.9 以前 | broker version |
| `INVALID_META` | client | `meta` の片方欠け・型違い | — |

## 8. e2e シナリオ（`scripts/e2e-mcp.mjs` に追加する案）

外部 repo に依存しないよう、e2e は **ローカル path** の protocol repo（一時ディレクトリに `protocol.json` / `PROTOCOL.md` を生成）を使う。GitHub / Gitea の tag 解決は client の単体テスト（fetch を差し替え）で見る。

1. `tools/list` が 9 ツールになる（既存の名前列 check を更新）。
2. A が `set_protocol(<tmp>/p1)` → `Protocol set: e2e-proto@1.0.0`。
3. B が `list_peers(protocol:"e2e-proto")` → A だけが `Protocol: e2e-proto@1.0.0` 付きで返る。
4. B が `get_protocol("e2e-proto")` → `PROTOCOL.md` の本文を含む。
5. 別 path（同 name / version、本文違い）で B が `set_protocol` → `PROTOCOL_CONFLICT`。
6. B が `set_protocol(<tmp>/p2)`（version 1.1.0）→ 成功。`list_peers(protocol, version:"1.0.0")` は A のみ、未指定は A と B。`get_protocol` 未指定は 1.1.0。
7. B → A に `send_message(meta:{protocol:"e2e-proto", version:"1.1.0"})` → A の受信に `mismatch` が付く。A → B の返信結果に warning 行が付く。
8. A が `unset_protocol()` → `list_peers(protocol, version:"1.0.0")` が 0 件、`get_protocol(version:"1.0.0")` が `PROTOCOL_NOT_FOUND`。
9. broker 再起動 → B の heartbeat 後、`get_protocol("e2e-proto")` が 1.1.0 を返す（永続化または resend）。
10. 旧 client 互換: meta 無し `send_message` が従来の文言で成功（既存 check がそのまま通ること）。

mesh は既存 e2e に 2 broker 構成が無いため、broker の単体テスト（`meshSync` に `protocols` を渡す）で見る。

## 9. 実装計画

worktree は `feature/protocol` 1 本で順に進める（各段階は前段の型に依存するため並列化しない）。

| 段 | 範囲 | 内容 | 見積 |
|---|---|---|---|
| 1 | protocol | 5.2 の型、`PROTOCOL_ROUTES`、mesh 型拡張、上限定数 | 0.5 h |
| 2 | broker | state（保持・永続化・GC）、handlers（set/unset/get/list/heartbeat/send meta）、mesh、http ルート、単体テスト | 3 h |
| 3 | client | repo 解決・version 解決・取得（fetch、GitHub/Gitea/path）、hash、再送、TOOL_DEFS 3 本 + 拡張、warning、`MessengerClient` API、単体テスト | 4 h |
| 4 | nuxt | `zod-shape` の object 対応確認、tools 露出の確認テスト | 0.5 h |
| 5 | e2e / docs | 8 章のシナリオ、README / INSTRUCTIONS 文言、release-0.10.0.md | 1.5 h |
| 計 | | | 9.5 h |

native build（PerryTS）での `fetch` / `crypto`（sha256）の可否は段 3 の最初に実機で確認する（10 章）。

## 10. 未決事項（ユーザー判断が要るもの）

1. **native client の HTTPS / ヘッダ制約**: 既存 `broker.ts` の記録では PerryTS の `fetch` は全リクエストヘッダを落とす。このため native client では private repo の token 送信ができない。選択肢は「native は public repo のみ対応」か「native も token 必須にし別の HTTPS 手段を用意（依存ゼロ制約に反する可能性）」。本書は前者を仮定。
2. **broker の定義永続化の要否**: 本書は永続化 + heartbeat `resend` の二重化を提案。永続化を省けば `broker.json` 形式は変わらないが、broker 再起動直後は server の次の heartbeat（最大 15 秒）まで `get_protocol` が `PROTOCOL_NOT_FOUND` になる。
3. **`unset_protocol` の `name` 引数と複数宣言**: 合意済み仕様は引数なし。本書は 1 peer 複数 protocol を許し `name?` を足した。1 peer 1 protocol に限るなら `name` は不要で、`set_protocol` は既存宣言の置き換えになる。

## 11. 決定（2026-10-28、ユーザー）

1. native client の private repo: **対応しない**（node client も同様）。`set_protocol` が扱うのは public の GitHub / Gitea repo とローカル path のみ。6.3 の token 環境変数は実装しない。private repo は `REPO_UNREACHABLE` として扱う。
2. broker の定義永続化: **する**（5.6 のとおり、`broker.json` に保存 + heartbeat `resend`）。
3. 1 server 複数 protocol: **許す**（4.1 / 4.2 のとおり、`unset_protocol(name?)`）。
