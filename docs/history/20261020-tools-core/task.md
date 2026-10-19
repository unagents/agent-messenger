# 指示書: ツール層の core 化（pluggable）と Nuxt module の実装

- 発行: w-cap（local cap、Mac）
- 日時: 2026-10-20
- 宛先: 204 の remote cap `am-cap-204`
- 種別: 実装（worker へ委譲。2 案件、順序あり）
- 参照（同ディレクトリに配置済み）: `instructions/ref-nuxt-module-study.report.md`（Nuxt module 検討、推奨 C+A）、`instructions/ref-mcp-toolkit-study.report.md`（mcp-toolkit 検討）、`reports/sdk-perry-feasibility.report.md` と `reports/sdk-perry-design.report.md`（204 側、pluggable 設計）。設計の根拠はこれらに従う。矛盾があれば本指示書が優先。

## 確定事項（ユーザー承認済み）

- MCP SDK は native（PerryTS）で使えない（zod 4 リンク失敗、ajv segfault）。client の stdio 層は自前 `mcp.ts` を維持。
- ツール 6 種（set_name / set_summary / list_peers / send_message / send_ping / check_messages）の定義+ハンドラを依存ゼロの core に集約し、(a) 自前 stdio、(b) MCP SDK 低レベル API（node 専用）、(c) `@nuxtjs/mcp-toolkit` の 3 ホストで共有する。
- Nuxt module は client の「ライブラリ API」の上に薄く載せる（C+A）。
- Nuxt ホストの peer 単位: **Nuxt サーバー 1 台 = 1 peer**。受信は pull（`check_messages` 相当の API）で、push 通知は送らない。
- toolkit での入力エラー文言は現行と同じ（`Invalid delivery: ...`）。enum は `z.string` に写す。
- Nuxt からの broker 自動起動は既定 off。
- 受信メッセージの ack はハンドラ成功後（失敗時は再配信）。

## 案件 1: `tools-core`（branch `feature/tools-core`、worktree `wt-tools-core/`、develop `75e2ada` から分岐）

1. `packages/client/src/tools/`: `types.ts`（`ToolDef { name, description, inputSchema: JSON Schema, requiresRegistration, handler(args, ctx) }`、`ToolContext { broker, peer, inbox }`）、`defs.ts`（6 ツール。`client.ts` から移設）、`registry.ts`（`createToolRegistry(ctx) → { list(), call(name, args) }`。未登録ガード・未知ツール・`Error (name): ...` を共通処理）、`index.ts`（公開口 `@agent-hand/messenger-client/tools`。package.json の `exports` に追加）。
2. `startClient` の可変状態と受信処理を `peer.ts`（`PeerState`）と `inbox.ts`（`Inbox`、poll・通知・ack）に切り出す。通知は `Notifier` インターフェースで抽象化（stdio では `mcp.notification`）。
3. ライブラリ API を公開: `createMessengerClient(options) → { connect(), close(), send(), ping(), listPeers(), setName(), setSummary(), checkMessages(), onMessage(handler) }`。内部は既存の解決（env → config → 発見 → fallback）・heartbeat・再解決（0.7.0）をそのまま使う。`process.exit` と stdio の握りはライブラリ側に入れない（`startClient` 側に残す）。
4. (a) stdio アダプタ `hosts/stdio.ts`: `createStdioServer` に `registry.list()` / `registry.call()` を登録。`TOOLS` / `CAPABILITIES` / `INSTRUCTIONS` の静的 export は維持（既存テストが参照）。
5. テスト: 既存テスト（client 22 / cli 16 / e2e 41）は変更なしで通ること。追加: registry 単体テスト（fake broker）、ライブラリ API の接続・送受信・close テスト（loopback broker）。
6. native build（linux-x64、`toolchain/perry`）が通ること。依存ゼロを維持（`packages/client` に外部依存を足さない）。
7. 完了後、develop へマージして push（本指示でマージを含む）。master は触らない。
8. report: `reports/tools-core.report.md`（テスト件数、commit hash、native 実測、公開 API 一覧）。

## 案件 2: `nuxt-module`（branch `feature/nuxt-module`、worktree `wt-nuxt/`、案件 1 のマージ後の develop から分岐）

1. `packages/nuxt` = `@agent-hand/messenger-nuxt`。`@nuxt/kit` の `defineNuxtModule`、`@nuxt/module-builder` でビルド。Nuxt 4 系を対象（公式 docs: nuxt.com/docs/guide/going-further/modules、nitro.build/guide/plugins）。
2. Nitro plugin: サーバー起動時に `createMessengerClient` で接続（runtimeConfig `messenger: { name, summary, brokers?: string[], autoStartBroker: false }`）。dev の HMR 再起動で二重接続しないガード。`close` hook で切断。
3. server utils `useMessenger()`（send / ping / listPeers / setName / setSummary / checkMessages）と Nitro hook `messenger:message`（受信を配る。ハンドラ成功で ack）。型定義を `nuxt.d.ts` で拡張。
4. (c) アダプタ: `@nuxtjs/mcp-toolkit` を optional peer dependency とし、インストール時のみ `/mcp` に 6 ツールを公開する（`TOOL_DEFS` → `defineMcpTool` 写像、JSON Schema → zod v4 変換器 + テスト）。toolkit 無しでも module は動くこと。
5. `packages/nuxt/playground/` に最小 Nuxt アプリ。204 の loopback broker（1794x 系）で起動し、CLI `peers` で peer として見えること、CLI `send` → `messenger:message` hook 到達、`useMessenger().send` → CLI 側で受信、を実測してログを残す。
6. README（`packages/nuxt/README.md`）: 導入手順・runtimeConfig・hook・toolkit 併用。
7. 完了後、develop へマージして push。master は触らない。publish しない。
8. report: `reports/nuxt-module.report.md`。

## 委譲・規約

- worker: 実装 `sonnet`、設計確認・レビューは `opus`。remote cap は実装しない。各 worker に指示書と report。証跡必須。質問禁止。
- 指示書の写しを各 worktree の `docs/history/20261020-<topic>/task.md` に置く。
- 単独コマンド。`/tmp` 禁止。python 禁止。202 / 210 / Mac に触らない（loopback のみ）。
- 案件ごとに `send_message`（to: `w-cap`）で完了通知（report パス + 5 行以内）。10 分おきに `send_ping`。

## ユーザー判断が要る時

仕様に無い・仕様を変える事項だけ `send_message` で w-cap に 1 件ずつ。実装詳細は自分で決めて report の「決めた事項」に書く。
