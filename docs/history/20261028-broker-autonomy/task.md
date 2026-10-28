# 指示書: broker 自律協調と接続制御ツールの設計書（0.11.0）

- 発行: w-cap（local cap、Mac）
- 日時: 2026-10-28
- 宛先: Mac のローカル worker（opus）
- 種別: 設計のみ。実装しない。commit まで（push しない）。202 / 204 / 210 に触らない。

## 作業場所

- `git -C /Users/koube/work/mcp-tools/agent-messenger/main worktree add -b feature/broker-autonomy /Users/koube/work/mcp-tools/agent-messenger/wt-autonomy develop`（develop = `c687510`、0.10.0）。
- 成果物: `wt-autonomy/docs/design/broker-autonomy.md`（日本語）。`docs/history/20261028-broker-autonomy/task.md` に本指示書をコピー。
- 読む範囲: `packages/broker/src/{config,discovery,mesh,handlers,index}.ts`、`packages/client/src/{resolve,broker,peer,session,messenger,protocols}.ts`、`packages/client/src/tools/`、`packages/protocol/src`、README のメッシュ節、`docs/design/protocol.md`。`npm ci` は不要。

## 合意済み仕様（ユーザー決定、変更不可）

1. **broker の相手探しは discovery のみ**。メッシュ対象 broker（`AGENT_MESSENGER_MESH=on`）は既存 UDP discovery（7902）の応答 / 告知で自分がメッシュ対象であることを示す。同期相手 = LAN で見つけたメッシュ broker（token 一致のみ）。broker が `config.json` の `brokers` を相手一覧として読む仕組みは廃止。
2. **client の解決順は維持**: env → 保存した接続先 → discovery → ローカル fallback。手書きの `config.json` の `brokers` は「保存した接続先」に置き換える（旧 config は読み込み互換として扱うか廃止するかは設計で決める）。
3. **新ツール `get_broker`**: 現在の接続先 URL、決定経路（env / saved / discovery / fallback / set_broker）、discovery で見えている broker 一覧（id / url / version / mesh / fallback）。
4. **新ツール `set_broker(url?, persist?)`**: 接続先をその場で切り替え、新 broker に再登録（name / summary / protocol 宣言を引き継ぐ）。`url` 省略で自動解決に戻る。`persist: true` で次回起動時にも使う（保存先は設計で決める。`~/.agent-messenger/` 配下）。
5. **固定の優先**: `set_broker` で固定した接続先は自動切替より優先。固定先が落ちたら通常の再解決（grace 30 s）に戻る。
6. **client の切替を e2e で実証**: 2 broker のメッシュを e2e 内で起動し、接続中の broker を止めると client が残った broker に移り、送受信（protocol 宣言含む）が続くこと。
7. やらない: 主の選出、fallback broker のメッシュ参加、LAN 外の自動発見（Tailscale 越しは `set_broker` で指定）。

## 設計で決めること

- discovery メッセージの拡張（mesh フラグ、token の照合方法。token 自体を UDP に流さない方法: 例 HMAC / hash の一部）。告知の周期と相手の失効。
- broker の相手一覧の管理（発見、失効、`/mesh/sync` の宛先、自分自身の除外）。既存 `AGENT_MESSENGER_MESH_PEER_TTL_MS` との関係。
- 旧 broker（0.10.0、config で相手を読む）との混在。
- client: 保存形式、`set_broker` の切替手順（旧 broker から unregister → 新 broker に register → protocol 再登録 → 未読の扱い）、`get_broker` の出力、ライブラリ API / Nuxt への露出。
- e2e: 2 broker（異なる port、discovery を loopback で通す方法。既存 e2e の discovery 試験の作り方を参照）での切替シナリオ。
- エラー一覧、実装計画（段と見積り）、未決事項（3 件以内）。

## 報告

- commit 1 つ（英語、`docs: broker autonomy and connection control design`）。push しない。
- `/Users/koube/work/mcp-tools/agent-messenger/reports/20261028-broker-autonomy-design.report.md`: commit hash、設計書パス、未決事項（各 1 行）。
- 最終応答 4 行以内。質問禁止。
