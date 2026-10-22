# 指示書: 0.8.0 リリース（develop → master、tag、linux native build、tarball）

- 発行: w-cap（local cap、Mac）
- 日時: 2026-10-23
- 宛先: 204 の remote cap `am-cap-204`
- 種別: リリース準備（worker へ委譲）。0.7.0 の手順（`docs/release-0.7.0.md`、`docs/history/20261015-release-0.7.0/`）を踏襲。publish は 202 の別 worker。

## 現状

- develop = `c6f9190`（tools-core + nuxt-module 統合済み）、master = `5bf9229`（v0.7.0）。
- 0.7.0 との差分: ツール core（`packages/client/src/tools/`）、ライブラリ API `createMessengerClient`、`peer.ts` / `inbox.ts`、`packages/nuxt`（`@agent-hand/messenger-nuxt`、新規パッケージ）、e2e スクリプト追従。
- 配布: Gitea Packages（protocol / broker / client / client-linux-x64 / client-darwin-arm64 / **nuxt（新規）**）、Verdaccio（CLI）。darwin-arm64 は Mac で後追い build。

## やること（worker 委譲、単独コマンド）

1. `wt-release/`（branch `release/0.8.0`、develop から）。
2. 版上げ: 全パッケージ `0.8.0`（protocol / broker / client / cli / client-darwin-arm64 / client-linux-x64 / nuxt）。相互依存の版指定、platform manifest、`packages/client/src/version.ts`、cli テストの期待値、`package-lock.json` の workspace 項目。nuxt の `dependencies` で client を参照しているなら `0.8.0` に。
3. `docs/release-0.8.0.md`（0.7.0 の型）: 変更点、publish 順（protocol → broker → client → client-linux-x64 → client-darwin-arm64 → **nuxt** → CLI）、互換性（0.7.0 broker / client との混在）、Nuxt module の導入手順の参照。README に nuxt パッケージの節とツール core の記述を追記（既にあれば確認のみ）。
4. テスト: protocol / broker / client / cli / nuxt の全スイート、typecheck、build、e2e（loopback、sandbox 無効は承認済み形のみ）。件数を記録。
5. linux-x64 native build（`toolchain/perry`）。起動時間・RSS を記録。tarball 7 本（protocol / broker / client / client-linux-x64 / cli / nuxt、darwin は manifest のみ）を `release/0.8.0/`。`tar tzf` で `src` / `test` が無いこと。nuxt は `dist` + `package.json`（playground / test を含めない）。
6. `docs/history/20261023-release-0.8.0/{task.md,publish-202.md}`。`publish-202.md` は 0.7.0 版を 0.8.0 に書き換え、nuxt を publish 順に追加し、broker 更新に **210 も含める**（210 は tmux `am-broker` で稼働: `tmux kill-session -t am-broker` 後に同じコマンドで再起動。コマンドは `/home/vagrant/work/mcp-tools/agent-messenger/notes.md` 相当として本指示書末尾に記載）。
7. `release/0.8.0` → develop ff → master ff → tag `v0.8.0` → push（develop / master / tag を 1 つずつ）。
8. `reports/release-0.8.0.report.md`（commit hash、tag、テスト件数、native 実測、tarball 一覧 + sha256）。w-cap は report ファイルで検知する（messenger 送信は不要）。

## 210 broker の再起動コマンド（publish-202.md に転記）

```
ssh vagrant@192.168.1.210 'tmux kill-session -t am-broker'
ssh vagrant@192.168.1.210 "tmux new -d -s am-broker 'env AGENT_MESSENGER_BIND=0.0.0.0 AGENT_MESSENGER_PORT=7901 AGENT_MESSENGER_MESH=on AGENT_MESSENGER_BROKER_ID=air-7 AGENT_MESSENGER_CORE_REFRESH=1 /usr/bin/npx -y --registry http://192.168.1.202/npm/ @agent-hand/messenger broker'"
```
（202 の worker は 210 に ssh できない可能性がある。その場合は「未実施」と report に書く。w-cap が代行する。）

## 禁止

- publish しない。202 / 210 / Mac に触らない。`/tmp` 禁止。python 禁止。単独コマンド。質問禁止（仕様に無い事項だけ `reports/release-0.8.0-sq.question.md` に書いて続行）。
