# 指示書: スコープ改名 @agent-hand → @unagents、repo 移転追従、npmjs 公開準備（0.9.0）— Mac ローカル worker 版

- 発行: w-cap（local cap、Mac）
- 日時: 2026-10-26
- 宛先: Mac のローカル worker（sonnet）
- 種別: コード変更。publish しない。push しない（w-cap が行う）。202 / 204 / 210 に触らない。

## 既に済んでいること（w-cap 実施、2026-10-26）

- Gitea の organization `agent-hand` を `unagents` に改名済み。repo は `unagents/agent-messenger`。新 URL: `http://192.168.1.202/gitea/unagents/agent-messenger.git`。
- Gitea Packages の npm registry は `http://192.168.1.202/gitea/api/packages/unagents/npm/`。既存の `@agent-hand/*` パッケージはそのまま残る。
- GitHub organization `unagents` は存在する。公開先 repo は `https://github.com/unagents/agent-messenger`（未作成、Gitea push mirror 予定）。
- npmjs のスコープは `@unagents`。

## 作業場所

- 本体 repo: `/Users/koube/work/mcp-tools/agent-messenger/main`（develop = `bbdedb9`、ローカルにあり）。
- worktree: `git -C /Users/koube/work/mcp-tools/agent-messenger/main worktree add -b feature/rename-unagents /Users/koube/work/mcp-tools/agent-messenger/wt-rename develop`
- npm は `npm ci --prefer-offline --cache /Users/koube/work/mcp-tools/agent-messenger/.npm-cache`（`~/.npm/_cacache` は EPERM）。
- `dangerouslyDisableSandbox` は使わない。ネットワークは npm registry のみ。

## やること（単独コマンド）

1. パッケージ名を全て `@agent-hand/*` → `@unagents/*` に改名（protocol / broker / client / cli / client-darwin-arm64 / client-linux-x64 / nuxt）。相互依存・optionalDependencies・platform manifest・`package-lock.json` の workspace 項目・`npm_config_@agent-hand:registry` のキー・CLI の `CLIENT_NAME` / `BROKER_NAME` / platform package 名・テストの期待値・README / docs の記述まで。`legacy/` と `docs/history/` と `docs/release-0.{5,7,8}.0.md` は触らない（履歴）。
2. 版を全パッケージ `0.9.0` に揃える（`packages/client/src/version.ts`、cli テスト期待値、package-lock の workspace 項目を含む）。
3. `repository.url` を全 package.json で `https://github.com/unagents/agent-messenger.git` に変更。`homepage` / `bugs` は無ければ追加しない。
4. `publishConfig` を全 package.json から削除（npmjs 既定で publish）。CLI の `DEFAULT_REGISTRY`（`packages/cli/src/config.ts`）は `https://registry.npmjs.org/` に変更。Gitea Packages は既存の registry override 用 env 変数で指定できる形を維持（変数名は `config.ts` の現行名を正とする）。
5. `deploy/gitea-link-package.js` / `deploy/npmrc-gitea-auth.js` / `scripts/e2e-mcp.mjs` / `deploy/agent-messenger-broker.service` の owner `agent-hand` を `unagents` に。
6. `docs/release-0.9.0.md`（`docs/release-0.8.0.md` の型）: 変更点（改名・npmjs 公開・GitHub mirror）、publish 順（protocol → broker → client → client-linux-x64 → client-darwin-arm64 → nuxt → CLI、全て npmjs）、旧 `@agent-hand/*` 利用者の移行（`npx -y @unagents/messenger mcp`）、互換性（0.8.0 broker との混在: wire protocol が不変なら可、根拠を書く）。
7. テスト: `npm run build`、`npm run typecheck`、`npm test`（全 workspace）、`node scripts/e2e-mcp.mjs`（loopback。sandbox で bind 不可なら「未実施」と記録）。件数を記録。
8. `docs/history/20261026-rename-unagents/task.md` に本指示書をコピー。
9. 1 commit にまとめて `feature/rename-unagents` にコミット（push しない）。コミットメッセージは英語、`chore: rename scope to @unagents, bump 0.9.0, point to github/npmjs`。
10. `node_modules` 以外の一時物は残さない。

## 報告

- `/Users/koube/work/mcp-tools/agent-messenger/reports/20261026-rename-unagents.report.md`
- 内容: commit hash、テスト件数（build / typecheck / test / e2e）、`grep -rn agent-hand` の残件（上記の除外以外で 0 件であること）、止まった項目。
- 最終応答は 4 行以内。質問禁止（仕様に無い事項は report に書いて続行）。
