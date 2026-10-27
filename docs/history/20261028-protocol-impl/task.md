# 指示書: protocol 機能の実装（0.10.0、feature/protocol）

- 発行: w-cap（local cap、Mac）
- 日時: 2026-10-28
- 宛先: 204 の remote cap `am-cap-204`（claudeAgent、tmux `am-cap`）
- 種別: 実装（worker 委譲）。設計書どおりに作る。publish しない。develop / master に触らない。

## 正本

- 設計書: branch `feature/protocol`（`6ed1131`）の `docs/design/protocol.md`。10 章の未決は 11 章で決定済み（private repo 非対応 / 永続化する / 複数 protocol 許可）。設計書と矛盾する実装はしない。設計書に無い細部は実装者が決め、report に列挙する。
- 現在地: develop = master = `b03496a`（0.9.0、`@unagents/*`、npmjs 公開済み）。repo は `unagents/agent-messenger`（204 の `main/` origin は更新済み）。

## 作業場所

- worktree `wt-protocol/`（`git -C main worktree add ../wt-protocol feature/protocol`、origin から fetch）。実装は `feature/protocol` に積む。
- `npm ci`、`npm run build`、`npm run typecheck`、`npm test`、`node scripts/e2e-mcp.mjs` は 204 で全部通る（bind 可）。
- native build は `toolchain/perry`（`PERRY_HOME`）。段 3 の最初に native で `fetch`（https、ヘッダ無し）と `crypto.createHash("sha256")` が動くことを実機確認し、結果を report に書く。

## 段階（設計書 9 章。順に。各段で commit）

1. protocol: 型（`ProtocolDecl` / `ProtocolDefinition` / `StoredProtocol` / `MessageMeta`、`Peer.protocols` / `Message.meta`）、`PROTOCOL_ROUTES`、mesh 型、上限定数。
2. broker: state（`protocols` Map、永続化、GC）、handlers（`/set-protocol` `/unset-protocol` `/get-protocol`、`/list-peers` フィルタ、`/register` `/heartbeat` の `protocols` + `resend`、`/send-message` の `meta`）、mesh 同期、http ルート、単体テスト（衝突・GC・再送・mesh・永続化）。
3. client: repo 引数の解決（GitHub URL / `o/r` / `github:` / `gitea:` / https / ローカル path）、tag 一覧からの version 解決（semver 最大、prerelease 除外、tag 無しは `0.0.0+<sha7>`）、`protocol.json` / `PROTOCOL.md` 取得、検証、hash、再送、TOOL_DEFS に 3 ツール追加 + `list_peers` / `send_message` 拡張、受信表示と version 不一致 warning、`MessengerClient` API（`setProtocol` / `unsetProtocol` / `getProtocol` / `listPeers` filter / `send` meta）、単体テスト（fetch 差し替え）。token 環境変数は実装しない。
4. nuxt: `zod-shape` の object 引数（`meta`）対応、ツール露出テスト。
5. e2e / docs: 設計書 8 章の 10 シナリオを `scripts/e2e-mcp.mjs` に追加（ローカル path の protocol repo を一時ディレクトリに生成。`/tmp` は使わず worktree 配下の `.e2e/` に作り終了時に削除）。README のツール表（`send_ping` 欠落も直す）、INSTRUCTIONS 文言、`docs/release-0.10.0.md`（0.9.0 の型。版上げは別指示、ここでは版を変えない）。golden fixture（stdio のツール一覧）の更新。

## 委譲

- 段 1〜2 は `sonnet` worker 1 体、段 3 は `sonnet` worker 1 体（段 2 完了後）、段 4〜5 は `sonnet` worker 1 体。設計の解釈に迷う箇所は `opus` worker に設計書の該当章を読ませて判断させる。remote cap は実装しない。
- worker の指示書は `instructions/`、report は `reports/`。証跡（テスト件数、commit hash、e2e 結果）必須。質問禁止。

## 完了条件

- `feature/protocol` に段 1〜5 の commit が積まれ、push 済み。
- 204 で build / typecheck / 全 workspace test / e2e が全部通る（件数を report に）。native build が通り、native の stdio で `tools/list` が 9 ツールを返す。
- `reports/protocol-impl.report.md`: commit hash 一覧、テスト件数、native 実測、設計書と違えた点（あれば理由）、実装者が決めた細部の一覧、残課題。
- 完了したら `send_message`（to: `w-cap`）で report パスと結果 2 行。作業中は 15 分おきに `send_ping`（subject: `protocol-impl`）。

## 禁止

- publish しない。202 / 210 / Mac に触らない。develop / master を動かさない。`/tmp` 禁止。python 禁止。パスワード投入禁止。単独コマンド。
