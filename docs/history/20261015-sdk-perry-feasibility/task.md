# 指示書: MCP SDK の native（PerryTS）利用可否と、ツール実装の pluggable 化の可否検討

- 発行: w-cap（local cap、Mac）
- 日時: 2026-10-15
- 宛先: 204 の remote cap `am-cap-204`（claudeAgent、tmux `am-cap`）
- 種別: 可否検討（spike 実測 + 設計報告）。本実装はしない。

## 背景（ユーザー指示、再確認不要）

- 現行 `packages/client/src/mcp.ts` は `@modelcontextprotocol/sdk` を使わず stdio JSON-RPC を自前実装している。理由は 2026-09-28 の「client は PerryTS でネイティブ化するため外部依存ゼロ」方針。
- ユーザー指示: 「以前を無理に無くす必要はなく、PerryTS でコンパイルできるなら MCP SDK を使え。使えないとしても、ツール部分を使い回しできる構造を検討しろ。可能なら MCP SDK を利用。ダメでも mcp-toolkit や MCP SDK の枠組みに寄せ、ツール実装を pluggable に使い回せる実装ができないか検討し、まず可否を報告しろ」。
- 参考報告（Mac 側、必要なら要約を w-cap に求めよ）: `reports/20261015-mcp-toolkit-study.report.md`（`@nuxtjs/mcp-toolkit` 0.24.2 は Nuxt module 専用、Streamable HTTP のみ、`@modelcontextprotocol/sdk ^1.32.1` 内包、peer に `zod ^4`）、`reports/20261015-nuxt-module-study.report.md`（推奨 C+A: client にライブラリ API、薄い Nuxt module）。
- 204 の perry toolchain: `/home/vagrant/work/mcp-tools/agent-messenger/toolchain/perry/`（`PERRY_HOME` に指定。`rel/` + `bin/clang` gcc shim + `lib/libtinfo.so.5`）。native build 手順は repo の `docs/release-0.5.0.md` と `scripts/` を正とする。
- 既知の perry 制約（`reports/20260928-perry-spike.md`）: `node:http` client はディスパッチ無し（`fetch` を使う）。unix socket / dgram / child_process / stdio / fs はネイティブ動作。

## 問 1: `@modelcontextprotocol/sdk` を PerryTS で native build できるか（spike 実測）

- worktree: `wt-sdk-perry/`（branch `spike/sdk-perry`、develop から分岐）。
- `packages/client` に `@modelcontextprotocol/sdk`（最新安定版、版数を記録）を追加し、`mcp.ts` の自前層を SDK の `Server` + `StdioServerTransport` に置き換えた最小実装（tools/list と tools/call が通る程度。6 ツール全部でなくてよい、2 つで可）を作る。
- 現行の native build 手順で linux-x64 をビルドする。結果を記録: 成功 / 失敗、失敗なら決定的なエラー行（perry が拒否した API・モジュール名）。
- 成功した場合: バイナリサイズ、起動時間、RSS を現行 native（起動 0.04 s / RSS 31 MB の実績）と並べて実測。stdio で `initialize` → `tools/list` → `tools/call` が通ることをログで示す。
- 失敗した場合: 失敗箇所が SDK 本体か依存（zod / ajv / その他）かを切り分け、回避の見込み（依存差し替え、SDK の低レベル API のみ使用、など）を 3 行以内で書く。実装はしない。
- node（非 native）でも同じ最小実装が動くことを確認（これは必ず通るはず。通らなければ spike の作り方の問題）。

## 問 2: ツール実装を pluggable に使い回せる構造は作れるか（設計）

ツール 6 種（set_name / set_summary / list_peers / send_message / send_ping / check_messages）の「定義 + ハンドラ」を 1 箇所に置き、以下 3 つのホストから同じ定義を使う構造を設計し、可否を判定する。

- (a) 現行の自前 stdio サーバー（`mcp.ts`）
- (b) `@modelcontextprotocol/sdk`（高レベル `McpServer.registerTool` は zod 前提、低レベル `Server.setRequestHandler` は JSON Schema 直渡し。どちらに寄せるか判断）
- (c) `@nuxtjs/mcp-toolkit`（`defineMcpTool` 相当、zod v4）

検討項目:
- 定義の形（name / description / inputSchema / annotations / handler）と、スキーマ表現を JSON Schema と zod のどちらを正にするか（変換の方向と、依存ゼロ要件との両立）。
- ハンドラが必要とする文脈（broker client、自分の peer id、設定）の注入方法。
- 置き場所: `packages/client` 内か、新パッケージ（例: `packages/tools`）か。native 制約（依存ゼロ）を守れる境界。
- 各ホスト向けアダプタの薄さ（行数見積り）。
- 既存テストへの影響。

## 出力

- 報告書: `/home/vagrant/work/mcp-tools/agent-messenger/reports/sdk-perry-feasibility.report.md`
- 構成:
  1. 問 1 の判定（可 / 否）と証跡（build ログの決定行、実測値、commit hash）
  2. 問 2 の判定（可 / 否 / 条件付き可）と提案構造（ディレクトリ・型の骨子、アダプタ 3 つの責務）
  3. 推奨（SDK を使うか、自前 + pluggable か）3 行以内
  4. ユーザー判断が要る点（1〜3 件）
- spike branch は結果に関わらず `spike/sdk-perry` として push（証跡）。worktree は報告後に削除。一時物も削除。
- 完了したら `send_message`（to: `w-cap`）で report パスと判定 2 行。作業中は 10 分おきに `send_ping`（subject: `sdk-perry`）。

## 委譲

- spike 実装は `sonnet` worker、設計検討は `opus` worker。並行可。remote cap 自身は実装しない。
- 各 worker の指示書は `instructions/`、report は `reports/`。証跡必須。質問禁止。

## 禁止

- 202 の broker と Mac に触らない。publish しない。develop / master に触らない（マージ禁止）。
- `/tmp` 禁止。python 禁止。パスワード投入禁止。
- コマンドは単独実行（連結・並列投入は分類器に止まる）。
