# 指示書: issue #2（send_message の本文が `undefined` で届く）の修正

- 発行: w-cap（local cap、Mac）
- 日時: 2026-10-31
- 宛先: 204 の remote cap `am-cap-204`（claudeAgent、tmux `am-cap`）
- 種別: 不具合修正（worker 委譲）。publish しない。develop / master に触らない。
- issue: http://192.168.1.202/gitea/unagents/agent-messenger/issues/2

## 原因（w-cap が確認済み、2026-10-31）

- MCP ツール `send_message` の inputSchema は本文の引数名が `message`（required）。
- w-cap はこれを誤って `text` という名前で渡していた（`{to, text, delivery}`。`message` は無し）。
- MCP サーバーは required の `message` が欠けた呼び出しを拒否せず、そのまま送信した。戻り値は `Message sent to <peer> (delivery: pull)` で、送信側は失敗に気付けない。受信側には本文 `undefined` が届いた。
- 起点は呼び出し側の誤りだが、サーバーが必須引数を検証しないことが不具合。LLM は引数名を誤ることがあるので、黙って `undefined` を送ってはいけない。
- issue 本文にある「client と broker の版の不一致」「body-mode」の推測は誤り。

## やること（worker 委譲、単独コマンド）

1. worktree `wt-issue2/`（branch `fix/issue-2-undefined-body`、develop = `e182ed5`（0.11.0）から）。
2. 再現テストを先に書く: stdio MCP の `tools/call` で `send_message` を `{to, text}`（`message` 欠落）で呼ぶと、修正前は成功扱いになり broker に本文の無いメッセージが積まれることを示す。修正前に失敗することを確認して記録する。
3. 修正:
   - ツール共通の引数検証を入れる。全ツールで、inputSchema の required 欠落と型違い（string に非 string、enum 外、object の必須欄欠落）を `isError: true` のエラーで返し、broker には何も送らない。
   - エラー文には、欠けた引数名と、受け取った引数名の一覧を入れる（例: `missing required argument "message" (got: to, text, delivery)`）。schema に無い引数だけの場合の扱い（拒否か許容か）は実装者が決め、report に書く。
   - ライブラリ API（`createMessengerClient()` の `send` など）と Nuxt module の経路でも、本文が string でなければ送らずにエラーにする。
   - broker の send ルートも、本文が string でないメッセージを 400 で拒否する（旧 client からの防御）。空文字の扱いは実装者が決め、report に書く。
4. テスト: 各ツールの required 欠落・型違いの単体テスト、broker の拒否テスト。e2e（`scripts/e2e-mcp.mjs`）に「`message` を欠いた `send_message` がエラーで返り、受信側に何も届かない」シナリオを追加。
5. 204 で build / typecheck / 全 workspace test / e2e / native build（linux-x64）を通す。既知の失敗 `resolve.test.ts`（`broker.log` の EACCES）は環境要因として記録だけでよい。
6. `docs/history/20261031-issue2-undefined-body/task.md` に本指示書を置く。
7. push `fix/issue-2-undefined-body`。
8. issue #2 に原因と修正 commit をコメントする（claude.cli 名義）。issue は閉じない（publish 後に w-cap が閉じる）。コメントが止められたら、本文を report に残す。

## 委譲

- 実装は `sonnet` worker 1 体。remote cap は実装しない。
- worker が sandbox で bind できない場合は、テストと e2e を sandbox 外で実行する経路を用意する。止まったら止まった事実を report に書く。

## 完了条件・報告

- `reports/issue2-undefined-body.report.md`: commit hash、修正前の再現結果、テスト件数、e2e 結果、native build、実装者が決めた細部、issue コメントの URL。
- 完了したら `send_message`（to: `w-cap`）で report のパスを 1 行送る。本文の引数名は `message`。作業中は 15 分おきに `send_ping`（subject: `issue2`）。

## 保留（着手しない）

- `instructions/20261031-0.12-0.13-impl.md` は着手しない（ユーザー判断待ち）。

## 禁止

- publish しない。202 / 210 / Mac に触らない。develop / master を動かさない。
- `/home/vagrant/.claude`（vagrant 本人の Claude 設定）に触らない。
- `/tmp` 禁止。python 禁止。パスワード投入禁止。単独コマンド。質問禁止（仕様に無い事項は report に書いて続行）。
