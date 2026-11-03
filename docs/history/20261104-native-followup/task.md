# 指示書: native 修正（0.12.1）の残課題 2 件の修正

- 発行: w-cap（local cap、Mac）
- 日時: 2026-11-04
- 宛先: 204 の remote cap `am-cap-204`
- 種別: 修正（worker 委譲）。publish しない。版は上げない（release は w-cap が別に行う）。develop / master に触らない。

## 対象

- issue #3（http://192.168.1.202/gitea/unagents/agent-messenger/issues/3）と issue #4（http://192.168.1.202/gitea/unagents/agent-messenger/issues/4）。文面は `instructions/20261104-issues-native-followup.md`。以下の「issue 1」は #3、「issue 2」は #4。

## issue 1 の修正（検査で失敗した時に古いバイナリが残る）

- `scripts/build-native.mjs`: strip-dedup の検査で失敗した時、`packages/client/native/` の出力に加えて、platform package の `packages/client-<platform>-<arch>/bin/messenger-client` があれば消す。消した path をメッセージに出す。
- テスト: 失敗時に消す path の決め方を単体テストにする（必要なら関数に切り出す。置き場所は前回の `packages/cli/test/strip-dedup-check.test.ts` に合わせる）。
- 実測（204）: 同じ worktree で、道具ありの成功 build の直後に失敗 build を行い、platform package の `bin/messenger-client` が消えることを確かめる。失敗 build は、exit 1 だけを返す `nm` / `objcopy` / `llvm-nm` / `llvm-objcopy` の stub を PATH の先頭に入れて起こす（前回の `build-3-stub` と同じ形）。

## issue 2 の修正（`latest` のキャッシュに古い client が残る）

- 変えない仕様: `AGENT_MESSENGER_CLIENT_SPEC` / `AGENT_MESSENGER_BROKER_SPEC` の既定は `latest`。再確認の間隔は `AGENT_MESSENGER_TTL_HOURS`（既定 24）。
- 足す規則: spec が dist-tag（`latest` など、版を固定しないもの）で、キャッシュにある版が CLI 自身の版より古い時は、TTL を待たずに registry を再確認する。
  - 再確認しても registry の版が CLI より古い場合（CLI が prerelease など）に、起動のたびに registry へ問い合わせ続けない工夫は実装者が決め、report に書く。
  - client と broker の両方に同じ規則を使うか client だけにするかは、コードの作りを見て実装者が決め、report に書く。どちらでも client には必ず効くこと。
- テスト（3 件以上）:
  - キャッシュの版が CLI より古い時は再確認する。
  - 同じか新しい時は今の TTL の規則のまま。
  - 版を固定した spec（`0.12.1` など）は影響を受けない。
  - registry はテスト用の偽物でよい（既存のテストの作りに合わせる）。
- 実測（204）: `AGENT_MESSENGER_PKGS_DIR` を作業用の dir に向け、そこに `latest` として 0.12.0 の client を入れた状態を作る。この branch の CLI（版は 0.12.1 のまま）で `mcp` を起動し、TTL 内でも再確認して 0.12.1 を取り直すことと、broker（`AGENT_MESSENGER_HOST=192.168.1.202`）に接続できることを確かめる。
- README の env 表の `AGENT_MESSENGER_TTL_HOURS` の説明に、この規則を 1 文足す。

## 共通

1. worktree `wt-followup/`（branch `fix/native-followup`、develop = `c33dca5`（0.12.1）から）。
2. 204 で build / typecheck / 全 workspace test / e2e / linux native build（道具あり。`toolchain/llvm-tools-nightly-2026-09-21/` の linux 版を PATH の先頭に入れる）を通す。既知の `resolve.test.ts` の失敗は環境要因として記録だけでよい。
3. issue 2 件に、原因と修正 commit をコメントする（claude.cli 名義。issue 登録と同じやり方。トークンは表示・保存しない）。issue は閉じない（release 後に w-cap が閉じる）。
4. `docs/history/20261104-native-followup/task.md` に本指示書を置く。push（branch `fix/native-followup`）。
5. 一時物（作業用のキャッシュ dir、stub、ログ）は cap 領域の `followup-scratch/` にまとめる。削除は w-cap が行うので、report に一覧と Perry の一時 dir の場所を書く。

## 委譲

- 実装は `sonnet` worker。remote cap は実装しない。worker が sandbox で止まる操作は、sandbox の外で実行する経路を remote cap が用意する。止まったら止まった事実を report に書く。

## 完了条件・報告

- `reports/native-followup.report.md`: commit hash、各修正の仕様（実装者が決めた細部を含む）、テスト件数、e2e 結果、2 つの実測の結果、issue コメントの URL、一時物の一覧。
- w-cap の messenger は今つながらない。完了判定は report の存在で行うので、`send_message` / `send_ping` は不要。

## 禁止

- 版を変えない。tag しない。publish しない。`npm deprecate` しない。develop / master を動かさない。
- 202 / 210 / Mac に触らない。`/home/vagrant/.claude` と他の cap（`wcap-mflow` など）に触らない。`~/.rustup` を変えない。
- `/tmp` 禁止（Perry の一時物を除く）。python 禁止。パスワード投入禁止。単独コマンド。質問禁止（仕様に無い事項は report に書いて続行）。
