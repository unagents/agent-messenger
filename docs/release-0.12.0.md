# リリース手順 0.12.0（下書き: plugin 同梱の追加分）

0.12.0 の release 手順のうち、Claude Code plugin（`plugins/messenger/`、repo ルートの `.claude-plugin/marketplace.json`）の同梱に伴う追加分だけを書く下書き。基本の流れ（tarball 作成・publish の順序・broker 切替・ロールバック）は `docs/release-0.11.0.md` と同じ。版の変更（各 `package.json` と `packages/client/src/version.ts`）はこの文書の対象外で、リリース時に別途行う。

plugin は npm に出さない。`plugin.json` の `version` と `.mcp.json` の `@unagents/messenger@<版>` / `AGENT_MESSENGER_CLIENT_SPEC` は、npm（`packages/cli/package.json`）の版と同じにする。

## 1. 追加する手順

1. 版を変えたら `node scripts/build-plugin.mjs` を実行し、`plugin.json` と `.mcp.json` を更新して同じ commit に入れる（何度実行しても同じ結果）。
2. `npm test` で版の一致検査（`packages/cli/test/plugin-version.test.ts`）が通ることを確かめる。`plugins/messenger` の 2 ファイルを `packages/cli/package.json` の版と比べる。
3. 次の 2 本を通す（`CLAUDE_CONFIG_DIR` を使い捨てのディレクトリにして実行する）:

```bash
claude plugin validate ./plugins/messenger
claude plugin validate .
```

4. npm の publish を全て終える（順序は `docs/release-0.11.0.md` の 2 と同じ: protocol → broker → client → client-linux-x64 → client-darwin-arm64 → nuxt → CLI）。
5. その後で Gitea と GitHub の既定 branch に push する。GitHub へは Gitea の push mirror で同期される。
6. push の後で `claude plugin tag ./plugins/messenger` を実行し、`messenger--v<版>` の tag を作る（`plugin.json` と marketplace の entry の一致も検査される）。

4 より前に 5 / 6 をしない。plugin が未公開の版を指し、`npx -y @unagents/messenger@<版>` が失敗する。

## 2. 導入の確認（任意）

使い捨ての `CLAUDE_CONFIG_DIR` で次を実行し、`claude plugin list` に `messenger@agent-messenger` と版が出ること、`claude mcp list` に `plugin:messenger:agent-messenger` が出ることを確かめる。

```bash
claude plugin marketplace add unagents/agent-messenger
claude plugin install messenger@agent-messenger
```

## 3. 利用者の更新

plugin の更新は `claude plugin update messenger@agent-messenger` または marketplace の更新で届く。適用には Claude Code の再起動が要る。`plugin.json` に `version` があるので、版を変えるまで利用者は同じ版に留まる。
