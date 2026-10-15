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
