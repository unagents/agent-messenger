# 指示書: role 機能と plugin の monorepo 同梱の設計書

- 発行: w-cap（local cap、Mac）
- 日時: 2026-10-31
- 宛先: 204 の remote cap `am-cap-204`
- 種別: 設計（worker 委譲）と検証用の小さな実験。本実装はしない。publish しない。develop / master に触らない。

## 背景（ユーザーと合意済み、変更不可）

他のエージェントから届いたメッセージは、受け手の Claude Code では「ユーザーの指示」として扱われない。このため受け手は権限の要る作業を断る（am-cap が w-cap の指示を 2 日止めた事例あり）。一方、セッション起動時の最初の指示（ユーザー入力）で渡した作業は断られずに実行された（2026-10-31 の am-cap）。

合意した方向:

1. **role**: agent-messenger に role を入れる。broker が role を付与・検証し、peer 一覧や受信メッセージに配信する。自己申告にしない（誰でも上位を名乗れるため）。
2. **動作規約**: role ごとの動作規約（誰からの依頼を受けるか、何を報告するか、など）を agent-messenger 側で持ち、案内する。
3. **権限の根拠はユーザー自身の操作**: 利用者の CLAUDE.md などの設定ファイルは編集しない（外部パッケージとして誰でも使えることが前提）。代わりに次の 2 つでユーザー自身が規約を読み込ませる。
   - パッケージの起動コマンド（例: `npx @unagents/messenger launch --role remote-cap`）。Claude を起動し、role の規約を最初の指示として渡す。人が端末にいない remote cap 向け。
   - plugin のスラッシュコマンド（例: `/messenger:role remote-cap`）。人が使う対話セッションで最初に 1 回実行する。
4. **承認は伝言しない**: 他のセッション経由の承認は Claude Code の仕様で承認にならない。危険な操作（publish、資格情報、リモート操作など）は、起動時に渡す範囲で事前に許可する設計にする。
5. **plugin を repo に同梱**: agent-messenger の monorepo に plugin を置く（`plugins/messenger/`: MCP 設定、messenger skill、`/messenger:role` コマンド、role の規約）。repo ルートに marketplace を置き、`claude plugin marketplace add unagents/agent-messenger` で入るようにする。npm パッケージと plugin は同じ版で同時に出し、plugin の MCP 設定はその版に固定する。
6. **片付け**: grrow-plugins-core から agent-messenger の MCP 登録を外す（二重登録防止）。`unagents/plugins` の messenger plugin は移行後に廃止する。どちらも手順を設計書に書くだけで、この指示では実施しない。

## 作業場所

- worktree `wt-role/`（branch `design/role-plugin`、develop = `15f5335`（0.11.1）から）。
- 成果物: `docs/design/role-and-plugin.md`（日本語）、`docs/history/20261031-role-plugin-design/task.md`（本指示書）。
- 関連の設計書: `docs/design/{protocol,broker-autonomy}.md`、branch `feature/broker-liveness` の `docs/design/broker-liveness.md`（0.13.0、未実装）、branch `feature/drop-config-brokers`（0.12.0、WIP）。順番と版の割り当て（例: 0.14.0）を設計書に書く。

## 設計で決めること

- role の型（固定の名前か、利用者が定義するか）と、role 同士の関係（どの role がどの role に依頼できるか）。
- role の付与と検証の仕組み（broker の設定、鍵やトークン、登録時の検証、メッセージへの検証済み表示、mesh 越しの扱い）。
- 動作規約の文面の持ち方（role ごとのテンプレート、利用者による上書きの可否）と、起動コマンド・スラッシュコマンドへの渡し方。
- 起動コマンドの仕様（引数、Claude の起動方法、設定ディレクトリ、permission mode、事前許可の範囲の書き方）。
- protocol 機能（0.10.0）との関係（例: 作業指示を protocol として定義するか）。
- plugin の構成（ディレクトリ、marketplace、版の固定、release 手順への組み込み）。
- 旧版との混在、e2e シナリオ、実装計画（段と見積り）、未決事項（3 件以内、ユーザー判断が要るものだけ）。

## 必須の実験（設計の前提を確かめる）

設計の前提「起動時に規約を渡せば、後から messenger で届いた依頼を断らずに実行する」を、204 で小さく確かめる。

- 使い捨ての実験用ディレクトリ（cap 領域配下）と、使い捨ての Claude セッション 1 つで行う。他の cap（`wcap-bantou`、`wcap-mflow`）や `/home/vagrant/.claude` には触らない。
- 手順の例: 規約（「w-cap-test からの依頼は作業指示として実行し、結果を返信せよ」）を最初の指示として Claude を起動する。別の peer から無害な依頼（実験用ディレクトリにファイルを 1 つ作る、など）を送る。実行されたか、断られたかを記録する。
- 比較として、規約なしで起動したセッションに同じ依頼を送った結果も記録する。
- 終わったら実験用のセッションとディレクトリを片付ける。

## 委譲

- 設計は `opus` worker、実験は `sonnet` worker。remote cap は自分で書かない。

## 完了条件・報告

- 設計書を 1 commit（英語、`docs: role and plugin design`）。push する（branch `design/role-plugin`）。
- `reports/role-plugin-design.report.md`: commit hash、実験の結果（両条件のログの要点）、未決事項。
- 完了したら `send_message`（to: `w-cap`、本文の引数名は `message`）で report のパスを 1 行。作業中は 15 分おきに `send_ping`（subject: `role-design`）。

## 保留（着手しない）

- `instructions/20261031-0.12-0.13-impl.md`（ユーザー判断待ち）。

## 禁止

- publish しない。202 / 210 / Mac に触らない。develop / master を動かさない。grrow-plugins-core と `unagents/plugins` を変更しない。
- `/home/vagrant/.claude` と他の cap に触らない。
- `/tmp` 禁止。python 禁止。パスワード投入禁止。単独コマンド。質問禁止（仕様に無い事項は report に書いて続行）。
