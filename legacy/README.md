# legacy

0.4.0 までの JavaScript 実装（`src/` `bin/` `loader/` `test/`）。publish しない。
`packages/client/test/`（旧 broker との互換テスト）、`packages/broker/test/`（旧 CLI との互換テスト）、`packages/protocol/test/`（定数・route の突き合わせ）が参照する。
`package.json` は `src/broker.js` / `src/server.js` の `require("../package.json")` と ESM 判定（`type: module`）のために置いてある。
