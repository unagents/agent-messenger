# 指示書: broker 死活監視・待機フラグ・分担ブロードキャストの設計書（0.13.0）

- 発行: w-cap（local cap、Mac）
- 日時: 2026-10-29
- 宛先: Mac のローカル worker（opus）
- 種別: 設計のみ。実装しない。commit まで（push しない）。他ホストに触らない。

## 作業場所

- `/Users/koube/work/mcp-tools/agent-messenger/wt-liveness`（branch `feature/broker-liveness`、develop = `e182ed5`（0.11.0）から作成済み）。
- 成果物: `docs/design/broker-liveness.md`（日本語）。`docs/history/20261029-broker-liveness/task.md` に本指示書をコピー。
- 並行作業: 別 branch `feature/drop-config-brokers`（0.12.0、旧 `config.json` brokers 読み込み廃止）が実装中。0.13.0 はその上に積む前提で書く。
- 読む範囲: `packages/broker/src/`、`packages/client/src/`（`peer`, `inbox`, `session`, `tools/`, `hosts/stdio`）、`packages/protocol/src`、`docs/design/{protocol,broker-autonomy}.md`、README。

## 依頼元（bantou main cap、ユーザー指示の転記。ユーザーは着手を承認済み）

背景: bantou で master-cap が報告待ちのまま止まり、相手（remote-cap / worker）が終わっていた・落ちていたことに気づけない事象が多い。broker を死活監視にも使いたい。

1. 名簿のタイムスタンプ: broker を経由したアクセスがあるたびに、その peer のタイムスタンプを更新。
2. 死活確認と掃除: 一定時間以上経過した peer に health check。落ちていれば名簿から消し、全エージェントに通知。
3. 待機フラグ tool: エージェント（例 master-cap）が「この相手からの宛て、またはこの相手の死亡を通知してほしい」を broker に登録できる tool。例: master-cap が [remote-cap-A, remote-cap-B, remote-worker-AA] を登録。
4. 分担ブロードキャスト: broker 同士が協調して手分け送信（各 broker が直接つながる peer へ）。

閾値・通知形式・tool 名は agent-messenger 側で決めてよい。既存の mesh / protocol との整合を優先。bantou は待機フラグと死亡通知を master-cap の待機に使う。

## 設計で決めること

- 現状の棚卸し（heartbeat 間隔、`last_seen` 更新箇所、stale 判定と削除、mesh 複製 peer の TTL）と、1 で足すもの。
- 2 の health check の手段（broker → client の到達経路が無い場合の扱い。session socket / heartbeat 応答 / 期限のみ等）、閾値、誤判定（スリープ・ネットワーク断）への耐性、「終了（正常 unregister）」と「消失（stale）」の区別。
- 死亡通知の配送: 全員通知か、関心登録者のみか（ノイズとの兼ね合い、推奨を書く）。通知の形（未読通知 / push / 新しい種別）。既存 `send_ping` / 未読通知の表示との整合。
- 3 の tool 名・引数（相手は name / id、複数）、登録の寿命（自分が落ちたら消える、解除 tool）、発火条件（相手からのメッセージ受信、相手の死亡、相手の正常終了）、発火時の表示、ライブラリ API / Nuxt への露出。
- 4 の分担: 通知の発生元 broker から mesh 経由で各 broker に渡し、各 broker が自分の直接 peer に配る方式。重複排除、mesh 分断時の扱い。
- 既存 mesh（discovery 相互発見、token 照合）・protocol 宣言（peer 消失時の GC）との整合。旧版混在。
- e2e シナリオ（2 broker、待機登録 → 相手の送信で発火、相手の kill で死亡通知、正常終了の区別、別 broker 側 peer への配送）。
- 実装計画（段と見積り）、未決事項（3 件以内、ユーザー判断が要るものだけ）。

## 報告

- commit 1 つ（英語、`docs: broker liveness, watch and fan-out design`）。push しない。
- `/Users/koube/work/mcp-tools/agent-messenger/reports/20261029-broker-liveness-design.report.md`: commit hash、設計書パス、未決事項（各 1 行）。
- 最終応答 4 行以内。質問禁止。
