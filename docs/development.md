# 開発・公開

## 開発

### ビルドとテスト

```bash
npm ci
npm run build        # protocol を先に build してから全 workspace（unbuild → packages/*/dist）
npm run typecheck    # tsgo（@typescript/native-preview）
npm test             # vitest（全 workspace）
```

テストは loopback で broker・疑似 npm registry を立てる。外部ネットワークには接続しない。

統合確認（疑似 registry から 6 パッケージを取得し、`cli discover / mcp（native・node）/ peers / status / send / broker`、session socket 投入、node フォールバックを通す）:

```bash
node scripts/e2e-mcp.mjs [--broker direct|cli]
```

### ネイティブ client（PerryTS）

```bash
PERRY_HOME=<perry の rel/ と clang がある dir> node scripts/build-native.mjs [--clean]
```

`packages/client/native/messenger-client-<platform>-<arch>` と `packages/client-<platform>-<arch>/`（`package.json` + `bin/messenger-client`）を生成する。生成されるのは実行したホストの platform のみなので、darwin-arm64 と linux-x64 はそれぞれのホストで実行し、`bin/messenger-client` を集める。

前提: Perry の archive（LLVM 23.1 製の bitcode を含む）を読める `llvm-nm` / `llvm-objcopy` を PATH の先頭に置く。Perry は link 前の `[strip-dedup]` で stdlib と net 拡張の重複シンボルを取り除くが、読めないと `(non-fatal)` で飛ばし、重複を残したまま link する（darwin では新しい ld が stub 側を選び、broker に接続できない native client になる）。`build-native.mjs` は Perry の出力の `[strip-dedup]` 行を検査し、未完了ならバイナリを消し、platform package に何も書かず、非 0 で終了する。

道具は rust `nightly-2026-09-21` の `llvm-tools`（LLVM 23.1.1）。rustup は不要で、tarball を取得し、sha256 が manifest（`https://static.rust-lang.org/dist/2026-09-21/channel-rust-nightly.toml` の `[pkg.llvm-tools-preview.target.<target>]` の `xz_url` / `xz_hash`）と一致するのを確かめてから展開する。

| target | `xz_url`（`https://static.rust-lang.org/dist/2026-09-21/` 配下） | `xz_hash`（sha256） |
|---|---|---|
| aarch64-apple-darwin | `llvm-tools-nightly-aarch64-apple-darwin.tar.xz` | `957afe6f5eef8d959ba7d0b4bd65b607a03fc2044441f97a3d1e459ad829b619` |
| x86_64-unknown-linux-gnu | `llvm-tools-nightly-x86_64-unknown-linux-gnu.tar.xz` | `f4a7240bfbf9073d4d2b5f1bff63eb0641deaaa81db9d49f64b1602dbb3d6032` |

```bash
curl -fO https://static.rust-lang.org/dist/2026-09-21/llvm-tools-nightly-<target>.tar.xz
sha256sum llvm-tools-nightly-<target>.tar.xz     # macOS は shasum -a 256。上の表の値と一致を確認
mkdir llvm-tools && tar -xJf llvm-tools-nightly-<target>.tar.xz -C llvm-tools
# 展開物の llvm-nm / llvm-objcopy がある dir（linux では llvm-tools/llvm-tools-nightly-<target>/llvm-tools-preview/lib/rustlib/<target>/bin）
PATH=<その dir>:$PATH PERRY_HOME=<perry の rel/ と clang がある dir> node scripts/build-native.mjs
```

linux-x64 では GNU binutils 2.42 の `nm` / `objcopy` だけでも `[strip-dedup]` が完了することを確認している。release の build は上の `llvm-tools` を PATH に入れて行う。

### 公開手順

publish の順序は protocol → broker → client → platform 2 種 → cli。基本手順と broker 切替・ロールバックは [`release-0.5.0.md`](release-0.5.0.md)、各版の変更点と互換性は `release-<version>.md` を参照。

## 既知の課題

[`issues.md`](issues.md) を参照。
