# 指示書: e2e スクリプトの古い前提を 0.7.0 に追従させる

- 発行: w-cap（local cap、Mac）
- 日時: 2026-10-18
- 宛先: 204 の remote cap（claudeAgent、tmux `am-cap`）
- 種別: 修正（worker へ委譲。sonnet）

## 背景

`scripts/e2e-mcp.mjs` は 0.7.0 リリース時に 34 pass / 4 fail（`reports/release-0.7.0.report.md`）。失敗 4 件はスクリプト側の古い前提で、コードの不具合ではない。

1. `mcp native/node: tools/list` — 5 ツールを期待。0.6.0 以降は `send_ping` を含む 6 ツール（`list_peers, send_message, send_ping, set_name, set_summary, check_messages`）。
2. `session socket: user line` — 本文がそのまま届く前提。0.6.0 以降の既定 `pull` では未読通知 `[agent-messenger] 未読 1 件 …` が届く。
3. `client acknowledged` — ログ `Session socket delivery OK` を期待。現行は `Session socket unread notice OK`（`packages/client/src/client.ts` 付近、worker が実測で確認すること）。
4. 上記 2・3 に連動する 1 件（report の記載を確認して特定）。

## やること

- worktree `wt-e2e/`（branch `fix/e2e-0.7.0`、develop から分岐）。
- `scripts/e2e-mcp.mjs` の期待値を現行挙動に合わせる。`push` 配信の経路（`delivery: "push"` 指定時に本文が届く）も 1 ケース追加し、pull / push 両方を検証する。
- 実行: `E2E_PORT` / `E2E_DISCOVERY_PORT` は loopback の未使用ポートを使う（release report と同じ 1794x 系）。全件 pass を確認。
- `docs/release-0.7.0.md` の e2e 記載（34/4）を更新。
- commit → `fix/e2e-0.7.0` を push → develop に ff または merge → develop を push。master へは **マージしない**（次回リリース時に取り込む）。
- `docs/history/20261018-e2e-script-fix/task.md` に本指示書の写し。
- 完了したら `reports/e2e-script-fix.report.md`（pass 件数、commit hash、変更点）。`send_message` で `w-cap` に 3 行以内。

## 禁止

- 202 / Mac に触らない。publish しない。master を変更しない。`/tmp` 禁止。python 禁止。単独コマンド厳守。質問禁止。
