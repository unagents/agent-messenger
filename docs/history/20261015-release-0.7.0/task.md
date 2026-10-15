# 指示書: 0.7.0 リリース（fallback + mesh を統合し tag・push・linux native build まで）

- 発行: w-cap（local cap、Mac）
- 日時: 2026-10-15
- 宛先: 204 の remote cap `am-cap-204`
- 種別: 統合・リリース準備（fallback + mesh を develop / master に統合し、tag と linux native build まで）。
- sdk-perry 可否検討（別指示）とは独立。並行可。worktree は `wt-release/`。

## 現状（w-cap 把握分）

- `feature/broker-fallback` `e66a6bf`、`feature/broker-mesh` `254bc07`（origin に push 済み、未マージ）。
- origin `develop` = `b350305`（master 72cfde8 + 履歴 docs 1 件）。origin `master` = `72cfde8`（v0.6.3）。
- 公開手順の正本: repo `docs/release-0.5.0.md` と `README.md` の公開節。publish は 202 で行う（別 worker）。204 は tag・push・linux-x64 native build・tarball までを担当。
- Mac は現在 LAN 不達。darwin-arm64 の native build は Mac 側で後追い。202 の publish は darwin を待たずに進める。

## やること（worker に委譲。remote cap は実装しない）

1. `wt-release/`（branch `release/0.7.0`、develop から分岐）に `feature/broker-fallback` → `feature/broker-mesh` の順でマージ。衝突は仕様（fallback: 再解決・自己終了、mesh: 常設 broker 同期）を両立する形で解消。
2. 版上げ: 全パッケージ（protocol / broker / client / cli / client-darwin-arm64 / client-linux-x64）を `0.7.0` に揃える。相互依存の版指定・platform manifest も合わせる（`chore: darwin-arm64 platform manifest` 相当の手順を README / release docs から踏襲）。
3. README に 0.7.0 の挙動を追記: fallback の後処理（本来 broker 発見で自己終了、client 再解決、猶予 30 秒）、mesh（`AGENT_MESSENGER_MESH=on` + `config.json` `brokers`）、`/relay-messages`。`docs/release-0.7.0.md` を `docs/release-0.5.0.md` の型で作る（変更点・publish 順・broker 更新手順・互換性）。
4. テスト: 全パッケージの `node --test` / vitest、typecheck、build、e2e。件数を記録。
5. linux-x64 native build（`toolchain/perry/`、`PERRY_HOME`）。起動時間・RSS を記録。tarball 6 本（darwin は node 側 manifest のみ。darwin バイナリは Mac で後追い）を `release/0.7.0/` に置く（0.6.3 と同じ置き方）。
6. `docs/history/20261015-release-0.7.0/task.md`（本指示書の写し）と、同ディレクトリに `publish-202.md`（下記「202 向け publish 手順」をそのまま）を置く。
7. `release/0.7.0` を develop に ff マージ → develop を master に ff マージ → tag `v0.7.0` → push `develop` `master` `v0.7.0`（単独コマンドで 1 つずつ）。
8. `set_summary` を `release-0.7.0: tagged` に更新。`send_message`（to: `w-cap`）で commit hash・tag・テスト件数・native 実測を 5 行以内。

## 202 向け publish 手順（`publish-202.md` の内容。202 の worker が読む）

```
# publish-202: 0.7.0 を Gitea Packages / Verdaccio に publish し broker を更新する
前提: 202 の checkout /home/vagrant/work/mcp-tools/agent-messenger（vagrant）。~/.npmrc に両レジストリの認証あり。
1. git -C /home/vagrant/work/mcp-tools/agent-messenger fetch origin
2. git -C /home/vagrant/work/mcp-tools/agent-messenger checkout master
3. git -C /home/vagrant/work/mcp-tools/agent-messenger pull --ff-only
4. git -C /home/vagrant/work/mcp-tools/agent-messenger describe --tags  → v0.7.0 であること
5. publish 順（各 1 コマンド単独、Gitea Packages は必ず env npm_config_@agent-hand:registry=http://192.168.1.202/gitea/api/packages/agent-hand/npm/ を付ける）:
   protocol → broker → client → client-linux-x64 → （client-darwin-arm64 は release/0.7.0/ に tarball が届いていれば。無ければ飛ばして報告）
6. CLI（packages/cli）を Verdaccio（http://192.168.1.202/npm/）に publish。**core が Gitea Packages に揃う前に出さない。**
7. 各 publish 後に npm view で版を確認（Gitea Packages 側は同じ env を付ける）。
8. broker 更新: env XDG_RUNTIME_DIR=/run/user/1000 AGENT_MESSENGER_CORE_REFRESH=1 systemctl --user restart agent-messenger-broker → curl http://127.0.0.1:7901/health で version 0.7.0 と peers 数を確認。
   AGENT_MESSENGER_MESH=on の unit への追加はしない（常設 broker 2 台目の配備はユーザー判断待ち）。
9. 分類器・権限で止まったコマンドは、その文言を報告に書いて次へ。回避しない。
報告: /home/vagrant/work/mcp-tools/agent-messenger/reports/publish-0.7.0.report.md（各 publish の npm view 結果、health の JSON、止まった項目）
```

## 禁止

- 202 の broker・Mac に触らない（publish と broker 更新は 202 の worker が行う）。
- publish しない（204 からは出さない）。
- `/tmp` 禁止。python 禁止。パスワード投入禁止。コマンド連結・並列投入禁止。
- 質問するな。不明は仕様から導いて決め、報告に書く。
