# 指示書: broker の自律協調（fallback 後処理 + client 再解決 + 常設 broker メッシュ）

- 発行: w-cap（local cap、Mac）
- 日時: 2026-10-15
- 宛先: 204 の remote cap（claudeAgent、tmux `am-cap`）
- 種別: 実装（worker へ委譲して進める。remote cap 自身は実装しない）

## 背景（ユーザー確定済み、再確認不要）

client が broker 解決に失敗すると `127.0.0.1:7901` に local broker を `spawn`（detached）するが、その後の後処理が無い。

- 再解決は起動時 1 回だけ（`packages/client/src/client.ts:245-246` 付近）
- local broker を止める側が無い（broker の終了経路は SIGINT / SIGTERM のみ、`packages/broker/src/main.ts:11-16`）
- heartbeat 拒否時も同じ URL へ再登録するだけ（`packages/client/src/client.ts:542-554`）

結果、Mac（192.168.1.111）に孤立 broker が残り、202（192.168.1.202）の常設 broker と二重になっている。ユーザー判定: **バグ**。

## 確定仕様

### A. fallback broker の後処理（案件 `fallback`）

1. local fallback として起動された broker は、定期的に UDP 発見（7902）を行う。
2. 自分以外の broker（本来の broker）を見つけたら、自分が保持する未配信メッセージをその broker へ転送してから自己終了する。
3. 自分に繋がっている client は、broker 消失を検知して C の再解決で移る（broker 側から client を追い出す必要は無い）。
4. 「fallback として起動された」ことは起動時に明示する（例: CLI フラグまたは env）。常設 broker（systemd の 202 など）はこの動作をしない。

### C. client の再解決（案件 `fallback` に含める）

1. 接続失敗・heartbeat 拒否を検知したら、解決順（env → config → UDP 発見 → local 起動）を再度通す。
2. 猶予: 不通を即 fallback にしない。直前の URL を一定時間（既定 30 秒、設定可）再試行してから次の解決へ進む。瞬断で broker が立ったり消えたりする flapping を防ぐ。
3. 同一ホスト多重起動の抑止は現行どおり（7901 の bind 排他 + `/health` 確認）。同じホストの複数セッションが同時に落ちた場合、最速で bind した 1 つが broker になり、残りはそれに接続する。
4. 正常化後に再度不通になった場合も、同じ再解決が走り、必要なら local broker を再度起動する。

### B. 常設 broker のメッシュ（案件 `mesh`、A/C と並行可）

1. 対象は `~/.agent-messenger/config.json` の `brokers` に明示した常設 broker 同士のみ（例: 202 + Mac）。fallback broker は対象外。
2. 常設 broker 同士は peer 一覧と未配信メッセージを相互同期する。どの常設 broker に繋いだ peer も `list_peers` で全ホストの peer が見える。
3. 片側停止で送受信が継続し、復帰後に自動で同期が戻る。
4. 旧 client（0.6.3）が混在しても壊れない。

## 作業環境（この指示書を読む時点で bootstrap 済み）

```
/home/vagrant/work/mcp-tools/agent-messenger/
  main/         master の checkout（読み取り用。ここで作業しない）
  develop/      develop の worktree（統合先。直接編集しない）
  wt-<topic>/   案件ごとの worktree。develop から分岐（branch: feature/<topic>）
  instructions/ reports/ toolchain/ notes.md
```

- 案件 `fallback` → `wt-fallback/`（branch `feature/broker-fallback`）
- 案件 `mesh` → `wt-mesh/`（branch `feature/broker-mesh`）
- worktree は remote cap が `git -C main worktree add ../wt-<topic> -b feature/<topic> develop` で作る。並行案件が増えたら同じ型で増やす。
- 指示書の写しを各 worktree の `docs/history/20261015-<topic>/task.md` に置く（`docs/history/README.md` があれば整合させる）。

## 委譲の規約（remote cap → worker）

- worker は Agent ツールのサブエージェント。実装は `sonnet`、調査は `opus`。`model` を毎回明示。
- worker ごとに指示書を `instructions/<YYYYMMDD-HHMM>-<案件>.md` に書き、完了判定は `reports/<案件>.report.md` の存在。
- 報告に証跡必須: テスト結果（`node --test` / e2e の件数）、commit hash、実測ログ。
- worker の report にバグがあれば remote cap が補修 worker を立てて自律で回す。w-cap に戻さない。
- 質問するな。不明点は仕様から導いて決め、報告に「決めた事項」として書く。

## 完了条件

### `fallback`
- `feature/broker-fallback` に commit 済み（push 済み）。develop へのマージは **しない**（w-cap が判断）。
- テスト: 既存テスト全通過 + 新規テスト（fallback 自己終了、client 再解決、猶予、再 fallback）。
- 実測（204 上）: 本来の broker を止める → client が 30 秒後に local 起動 → 本来の broker を戻す → local broker が自己終了し client が戻る。この一連をログで示す。

### `mesh`
- `feature/broker-mesh` に commit 済み（push 済み）。マージはしない。
- テスト: 2 broker を同一ホストの別ポートで立て、peer 同期・片側停止継続・復帰同期を自動テストで示す。
- 旧 client 0.6.3 との互換を実測で示す。

## 禁止事項

- 202 の broker（systemd user unit `agent-messenger-broker`）と Mac に触らない。
- パッケージの publish（Verdaccio / Gitea Packages）をしない。
- `main/` と `develop/` を直接編集しない。develop へのマージをしない。
- `/tmp` を使わない。一時物は cap 領域配下、終了時に削除。
- python を使わない。
- sudo がパスワードを要求したら止まって報告（パスワードを渡す・探す・回避する行為は禁止）。
- コマンドは単独で実行（`&&` `;` `|` 連結・並列投入は分類器に止まる。止まったら単独で再実行してから判定）。

## 報告

- 各案件の report: `/home/vagrant/work/mcp-tools/agent-messenger/reports/<topic>.report.md`
- 案件完了ごとに agent-messenger の `send_message` で `w-cap` へ通知（report のパスと要約 5 行以内）。
- 作業中は 10 分おきに `send_ping`（to: `w-cap`、subject: 案件名）。
- 起動直後に `set_name` で `am-cap-204`、`set_summary` で担当案件を設定し、`w-cap` へ「受領」を 1 行送る。
