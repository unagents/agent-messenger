# 指示書: agent-messenger の Claude Code plugin を monorepo に同梱する（実装）

- 発行: w-cap（local cap、Mac）
- 日時: 2026-10-31
- 宛先: 204 の remote cap `am-cap-204`
- 種別: 実装（worker 委譲）。publish しない。版は上げない（release は w-cap が別に行う。次の版は 0.12.0 の予定）。develop / master に触らない。

## 方針（ユーザー決定、変更不可）

- agent-messenger の Claude Code plugin の正式な置き場は、この monorepo とする。npm パッケージと同じ版で、同時に出す。
- 正本の設計は branch `design/role-plugin`（`89a7d81`）の `docs/design/role-and-plugin.md` の **8 章（plugin 構成）**。
- **role 関連は棚上げ（ユーザー決定）**。設計書の role に関わる部分は作らない: `skills/role/`（`/messenger:role`）、`roles/*.md`、`protocols/task/`、`set_role` ツール、規約の生成。8 章のうち plugin の同梱に必要な部分だけを実装する。

## やること（worker 委譲、単独コマンド）

1. worktree `wt-plugin/`（branch `feature/claude-plugin`、develop = `15f5335`（0.11.1）から）。
2. `plugins/messenger/` を作る（npm workspace には入れない。plugin は npm に出さない）。
   - `.claude-plugin/plugin.json`: name `messenger`、version は npm（`packages/cli/package.json`）と同じ。
   - `.mcp.json`: server `agent-messenger`。`npx -y @unagents/messenger@<版> mcp`。client の版も固定する（8.3 の `AGENT_MESSENGER_CLIENT_SPEC`）。`.mcp.json` の `env` が利用者の env と合わさるか置き換えるかを実機で確かめ、結果に合わせて書く（8.3 の未検証事項）。旧 plugin にあった `broker_host` / `broker_port` の userConfig は、0.11 の discovery と `set_broker` で不要になったので入れない。
   - `skills/messenger/SKILL.md`: 旧 plugin の messenger skill を移し、0.11.1 の実際のツール（11 本: set_name / set_summary / list_peers / send_message / send_ping / check_messages / set_protocol / unset_protocol / get_protocol / get_broker / set_broker）と引数名（`send_message` の本文は `message`）に合わせて直す。
   - `README.md`: 導入手順（`claude plugin marketplace add unagents/agent-messenger` → `claude plugin install messenger@agent-messenger`）。
   - 旧 plugin の元: Gitea `unagents/plugins`（http://192.168.1.202/gitea/unagents/plugins 、master `88a80af`）の `messenger/`。GitHub には無い。
3. repo ルートに `.claude-plugin/marketplace.json`（8.2: marketplace 名 `agent-messenger`、plugin `messenger`、source `./plugins/messenger`）。
4. `scripts/build-plugin.mjs`: `packages/cli/package.json` の版を `plugin.json` と `.mcp.json` に反映する（role 生成は入れない）。
5. テスト: 版の一致の検査を `npm test` に足す（8.4 の 2）。`claude plugin validate ./plugins/messenger` と `claude plugin validate .` を通す。
6. 実機の導入確認: 使い捨ての設定ディレクトリ（cap 領域配下。`/home/vagrant/.claude` と `.claude-agent` は使わない）で、この worktree をローカルの marketplace として追加し、plugin を install し、MCP サーバー `agent-messenger` が設定に載ることを確かめる。sandbox や分類器で止まったら、止まった事実とコマンドを report に書く。終わったら使い捨ての設定ディレクトリを消す。
7. ドキュメント: README の導入の節を plugin 前提に更新。`docs/release-0.12.0.md` の下書き（8.4 の release 手順の追加分。版の変更はしない）。
8. 204 で build / typecheck / 全 workspace test / e2e を通す（既知の `resolve.test.ts` の EACCES は環境要因として記録だけ）。
9. `docs/history/20261031-claude-plugin-impl/task.md` に本指示書を置く。push（branch `feature/claude-plugin`）。GitHub へは Gitea の push mirror で自動的に同期される。

## 範囲外（やらない）

- grrow-plugins-core からの MCP 登録の削除、`unagents/plugins` の廃止（release 後にユーザー判断で行う）。
- publish、版の変更、tag の作成（`claude plugin tag` を含む）。

## 委譲

- 実装は `sonnet` worker。remote cap は実装しない。worker が sandbox で止まる操作（テスト、e2e、`claude plugin` コマンド）は、sandbox の外で実行する経路を remote cap が用意し、止まったら止まった事実を report に書く。

## 完了条件・報告

- `reports/claude-plugin-impl.report.md`: commit hash、テスト件数、e2e 結果、`claude plugin validate` の結果、導入確認の結果（`.mcp.json` の env の挙動を含む）、実装者が決めた細部、残課題。
- 完了したら `send_message`（to: `w-cap`、本文の引数名は `message`）で report のパスを 1 行。作業中は 15 分おきに `send_ping`（subject: `plugin`）。

## 保留（着手しない）

- `instructions/20261031-0.12-0.13-impl.md`、role 関連の作業。

## 禁止

- publish しない。202 / 210 / Mac に触らない。develop / master を動かさない。grrow-plugins-core と `unagents/plugins` を変更しない。
- `/home/vagrant/.claude` と他の cap（`wcap-mflow` など）に触らない。
- `/tmp` 禁止。python 禁止。パスワード投入禁止。単独コマンド。質問禁止（仕様に無い事項は report に書いて続行）。
