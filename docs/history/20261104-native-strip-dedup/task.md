# 指示書: native client が broker に接続できない不具合の修正（native build の検査の追加）

- 発行: w-cap（local cap、Mac）
- 日時: 2026-11-04
- 宛先: 204 の remote cap `am-cap-204`
- 種別: 修正（worker 委譲）。publish しない。版は上げない（0.12.1 の release は w-cap が別に行う）。develop / master に触らない。

## 原因（w-cap が Mac で確定、2026-11-04）

- 症状: darwin-arm64 の native client 0.11.1 / 0.12.0 が broker に接続できない（`Remote broker at http://192.168.1.202:7901 is not reachable` で終了）。npm の 0.11.0 以前は接続できる。コードの差分は無関係（同じ v0.11.0 でも今の Mac で build すると接続できない）。
- Perry は link の前の `[strip-dedup]` で、stdlib と net 拡張（`libperry_ext_net.a`）の重複を llvm-nm / llvm-objcopy で取り除く。Perry の archive は LLVM 23.1（rust 1.100.0-nightly）製の bitcode を含む。これを読める llvm-nm / llvm-objcopy が PATH に無いと、`(non-fatal)` として処理を飛ばし、重複を残したまま link する。
- 重複したシンボルのどちらが選ばれるかは linker 次第。Mac の Xcode が 10-29 に 14.3.1 から 26.3 に上がった。新しい ld（1230.1）は stub 側を選ぶので通信できない。旧 ld（857.1）は結果的に net 拡張側を選んでいた。
- 実測: rust `nightly-2026-09-21` の `llvm-tools`（LLVM 23.1.1）の bin を PATH の先頭に入れて build すると、`[strip-dedup]` が完了し、新しい ld でも接続できた。

失敗時の Perry の出力（Mac、道具なし）:

```
[strip-dedup] shared-deps drop skipped for .../toolchain/perry/rel/libperry_ext_net.a (non-fatal): failed to inspect defined symbols of libperry_ext_net.a
[strip-dedup] Processing well-known wrapper: .../toolchain/perry/rel/libperry_ext_net.a
[strip-dedup] wrapper symbol rewrite skipped for .../toolchain/perry/rel/libperry_ext_net.a (non-fatal): objcopy not found
[strip-dedup] warning: archive preparation was incomplete; linking the full stdlib before wrappers to keep its allocator and runtime authoritative
[strip-dedup] runtime stdlib-stub localize skipped (non-fatal): llvm-objcopy not found
```

LLVM 18 の llvm-nm / llvm-objcopy を PATH に入れた時は、`not found` が `failed to inspect archive symbols` と `failed to inspect libperry_runtime.a symbols` に変わるだけで、同じく未完了。

成功時の Perry の出力（Mac、LLVM 23.1.1 の llvm-tools を PATH に入れた時）:

```
[strip-dedup] libperry_ext_net.a: keeping bundled alloc-....rcgu.o — needed by a kept sibling and not safely replaceable by stdlib
（同じ形の keeping の行が計 11 行。正常）
[strip-dedup] libperry_ext_net.a: dropped 806 bundled member(s) also provided by stdlib (shared transitive deps, fixed-point safe)
[strip-dedup] Processing well-known wrapper: <一時 dir>/_libperry_ext_net.a_nosharedeps.lib
[strip-dedup] _libperry_ext_net.a_nosharedeps.lib: localized wrapper-only globals in 3 member(s)
```

## やること（worker 委譲、単独コマンド）

1. worktree `wt-dedup/`（branch `fix/native-strip-dedup`、develop = `16927fb`（0.12.0）から）。
2. 204 の linux-x64 の現状を先に確かめる。この worktree で今の手順どおり native build し、Perry の出力の `[strip-dedup]` の行を全て report に残す。
   - 未完了（上の失敗の形）なら、同じ日付の `llvm-tools` の linux 版を cap 領域 `/home/vagrant/work/mcp-tools/agent-messenger/toolchain/llvm-tools-nightly-2026-09-21/` に取得する。
     - manifest `https://static.rust-lang.org/dist/2026-09-21/channel-rust-nightly.toml` の `[pkg.llvm-tools-preview.target.x86_64-unknown-linux-gnu]` で `xz_url` と `xz_hash` を確かめる。
     - tarball の sha256 が `xz_hash` と一致することを確かめてから展開する（`~/.rustup` には入れない。`rustup` は使わない）。
     - 展開物の `llvm-nm` / `llvm-objcopy` の dir を PATH の先頭に入れて build し直し、`[strip-dedup]` が完了することを確かめる。
3. `scripts/build-native.mjs` に検査を足す。Perry の出力（stdout / stderr）を今どおり表示しながら取り込む。`[strip-dedup]` の行に次のいずれかがあれば、バイナリを配置せず、非 0 で終了する。
   - `archive preparation was incomplete`
   - `(non-fatal)` を含む `skipped` の行
   - `not found`
   - `failed to inspect`
   - keeping の行（`not safely replaceable by stdlib`）は正常。失敗にしない。
   - 終了時のメッセージには、Perry の archive（LLVM 23.1）を読める llvm-nm / llvm-objcopy を PATH の先頭に入れることと、手順書の場所を書く。
   - 道具の場所は PATH で渡す（新しい環境変数は作らない）。
   - `[strip-dedup]` の行が 1 行も無い場合や、成功の印（`localized wrapper-only globals` など）が無い場合を失敗にするかは、linux と darwin の成功時の出力を見て実装者が決める。決めた内容を report に書く。
4. テスト: 検査の判定の単体テストを `npm test` に入れる。上の失敗の形（道具なし、LLVM 18）と成功の形を fixture にする。
5. ドキュメント: native build の前提として、Perry の archive を読める LLVM 23.1 系の llvm-nm / llvm-objcopy が PATH に要ることを、build の手順が今書いてある場所に書く。内容は、rust `nightly-2026-09-21` の `llvm-tools`、取得 URL、sha256 の照合の手順。
   - darwin の値: `xz_url` は `https://static.rust-lang.org/dist/2026-09-21/llvm-tools-nightly-aarch64-apple-darwin.tar.xz`、`xz_hash` は `957afe6f5eef8d959ba7d0b4bd65b607a03fc2044441f97a3d1e459ad829b619`。
   - linux の値: 手順 2 で取得した場合はその値。
6. 204 で build / typecheck / 全 workspace test / e2e / linux native build（検査あり）を通す。既知の失敗 `resolve.test.ts` の EACCES は環境要因として記録だけでよい。
   - 検査の実測を両方記録する: 道具なしで失敗すること（linux が元から完了する場合は、道具なしで通ること）と、道具ありで通ること。
   - 出来た linux バイナリで broker（`AGENT_MESSENGER_HOST=192.168.1.202`）への initialize の応答を確かめる。
7. Perry が一時 dir に作る `perry_strip_*` は build 後に確かめてから削除し、report に書く。
8. `docs/history/20261104-native-strip-dedup/task.md` に本指示書を置く。push（branch `fix/native-strip-dedup`）。

## 範囲外（やらない）

- 版の変更、tag、publish、release script の変更（w-cap が行う）。
- darwin の build（Mac で w-cap が行う）。

## 委譲

- 実装は `sonnet` worker。remote cap は実装しない。worker が sandbox で止まる操作は、sandbox の外で実行する経路を remote cap が用意する。止まったら止まった事実を report に書く。

## 完了条件・報告

- `reports/native-strip-dedup.report.md`:
  - commit hash
  - linux の `[strip-dedup]` の行（道具なし、道具あり）
  - llvm-tools を取得した場合は、URL と sha256 の照合結果、展開先
  - 検査の仕様（実装者が決めた細部を含む）
  - テスト件数、e2e 結果、検査の成否の実測、linux バイナリの接続確認
  - release で linux の native build に要る PATH の指定
- w-cap の messenger は今つながらない。完了判定は report の存在で行うので、`send_message` / `send_ping` は不要。

## 保留（着手しない）

- `instructions/20261031-0.12-0.13-impl.md`、role 関連の作業。

## 禁止

- publish しない。202 / 210 / Mac に触らない。develop / master を動かさない。版を変えない。
- `/home/vagrant/.claude` と他の cap（`wcap-mflow` など）に触らない。`~/.rustup` を変えない。
- `/tmp` 禁止（Perry の一時物は手順 7 で片付ける）。python 禁止。パスワード投入禁止。単独コマンド。質問禁止（仕様に無い事項は report に書いて続行）。
