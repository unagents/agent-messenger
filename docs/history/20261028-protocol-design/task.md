# 指示書: protocol 機能（set_protocol / get_protocol / list_peers(protocol)）の設計書作成（0.10.0）

- 発行: w-cap（local cap、Mac）
- 日時: 2026-10-28
- 宛先: Mac のローカル worker（opus）
- 種別: 設計のみ。実装しない。commit まで（push しない、w-cap が行う）。202 / 204 / 210 に触らない。

## 作業場所

- 本体 repo: `/Users/koube/work/mcp-tools/agent-messenger/main`（develop = `b03496a`、0.9.0）。
- worktree: `git -C /Users/koube/work/mcp-tools/agent-messenger/main worktree add -b feature/protocol /Users/koube/work/mcp-tools/agent-messenger/wt-protocol develop`
- 成果物: `wt-protocol/docs/design/protocol.md`（日本語、見出し構成は下記）。`docs/history/20261028-protocol-design/task.md` に本指示書をコピー。
- 既存コードは設計に必要な範囲で読んでよい（`packages/protocol/src`、`packages/broker/src/{handlers,state,mesh,http}.ts`、`packages/client/src/{tools/defs,peer,broker,messenger}.ts`、`packages/nuxt/src`）。`npm ci` は不要。

## 用語（固定）

- **server**: `set_protocol` を実行した待受側 messenger。
- **caller**: protocol 名だけを知って server を探し、メッセージを送る側。
- server の識別は既存の peer 識別（`set_name` の名前 / id / host）をそのまま使う。protocol 固有の識別子は作らない。

## 合意済み仕様（ユーザー決定、変更不可）

1. `set_protocol(repo, version?)`: server が protocol repo から定義を取得し、broker に `(name, version, 定義本体)` と自分（peer）を登録する。`unset_protocol()` で解除。heartbeat にも protocol 宣言を載せ、server が消えれば一覧から消える。
2. **定義の取得元は server**（取得元 A）。broker は repo に出ない。broker は server から受け取った定義を保存するだけ。
3. version: 未指定なら repo の tag から最新（GitHub の release 慣行: semver 最大、prerelease 除外。Gitea も tag API で同じ判定）。指定があればその tag。tag が無い repo は既定 branch の HEAD を `0.0.0+<short sha>` として扱う。
4. broker は定義を `(name, version)` で保持。同名で別 version の server が共存できる。同じ `(name, version)` で定義本体（hash）が違う `set_protocol` は拒否し、理由を返す。更新は該当 version の server を全て `unset_protocol` してから再登録。
5. `list_peers(protocol, version?)`: version 未指定なら全 version の server を既存 peer 形式（id / name / host / summary）+ version で返す。指定があればその version の server だけ。
6. `get_protocol(name, version?)`: broker が保持する定義を返す（server への往復なし）。version 未指定なら broker が持つ最新 version。
7. `send_message(to, text, meta)`: `meta` は `{protocol, version}` を必ず持つ。server の client は自分の version と不一致でも受け取る（判断は LLM）が、返信時に warning を添える仕組みを client 側に置く。
8. mesh（202 / 210）同期に protocol 登録を含める。
9. Nuxt module とライブラリ API（`createMessengerClient`）にも同じ 3 ツール（set_protocol / unset_protocol / get_protocol）と `list_peers` の protocol 引数を露出。

## 設計で決めること（提案として書く。合意済み仕様と矛盾させない）

- protocol repo の内容の形: 推奨は repo ルートの `protocol.json`（`name` / `version` / `description` / `messages`: メッセージ種別ごとの JSON Schema）+ `PROTOCOL.md`（運用説明、LLM が読む）。`version` は tag と一致させる。
- 取得方法: native client は `fetch` のみ（git 不可、依存ゼロ）。GitHub は `https://api.github.com/repos/<o>/<r>/tags` と `https://raw.githubusercontent.com/<o>/<r>/<tag>/<file>`、Gitea は `<base>/api/v1/repos/<o>/<r>/tags` と `<base>/api/v1/repos/<o>/<r>/raw/<file>?ref=<tag>`。repo 引数の受け付け形（URL / `owner/repo` 短縮 / ローカル path）を決める。private repo の資格情報の扱い（環境変数名）を決める。
- broker の HTTP ルート（例: `POST /protocols`、`DELETE /protocols`、`GET /protocols/:name?version=`、`GET /peers?protocol=&version=`）と、register / heartbeat の拡張フィールド。
- 定義本体の hash（sha256）と上限サイズ。
- `/mesh/sync` への載せ方と、broker 再起動時の扱い（定義は server の heartbeat で再登録されるか、broker が永続化するか）。
- `send_message` の `meta` の形と、既存 0.9.0 client / broker との混在（meta 無しの旧 client が壊れないこと）。
- エラー一覧（repo 不達、tag 無し、version 不一致、定義衝突、protocol 未登録の `get_protocol`）。
- e2e シナリオ（`scripts/e2e-mcp.mjs` に足す案）。
- 実装分割（broker / protocol / client / nuxt / docs の順と見積り）。

## 設計書の見出し

1. 目的と用語
2. 全体フロー（server 登録 → caller 探索 → 送受信）図（テキスト）
3. protocol repo の形式
4. ツール仕様（MCP 3 ツール + list_peers / send_message の拡張。引数・戻り・エラー）
5. broker API とデータモデル（mesh 同期・再起動含む）
6. client 側の責務（取得・hash・version 解決・warning）
7. 互換性（0.9.0 混在）
8. e2e シナリオ
9. 実装計画（worktree 分割と見積り）
10. 未決事項（3 件以内。ユーザー判断が要るものだけ）

## 報告

- commit 1 つ（英語、`docs: protocol feature design (set_protocol / get_protocol)`）。push しない。
- `/Users/koube/work/mcp-tools/agent-messenger/reports/20261028-protocol-design.report.md`: commit hash、設計書パス、未決事項の要約（各 1 行）。
- 最終応答は 4 行以内。質問禁止（仕様に無い事項は未決事項に書いて続行）。
