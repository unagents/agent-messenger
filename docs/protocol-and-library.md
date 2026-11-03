# protocol・ライブラリ・Nuxt module

## protocol（0.10.0〜）

セッションが「どんな種類のメッセージを、どんな形で話すか」を宣言し、相手を protocol で探せるようにする。

- protocol repo は、ルートに `protocol.json`（必須。`name` / `version` / `description` / `messages`）と `PROTOCOL.md`（任意。運用説明）を置いた Git repo、またはそのローカルディレクトリ。`set_protocol` が受け付けるのは **public** の GitHub / Gitea repo とローカル path のみ（private repo は `REPO_UNREACHABLE`）。
- `set_protocol(repo, version?)` は tag（`1.2.0` / `v1.2.0`）の `protocol.json` と `PROTOCOL.md` を取得し、hash を付けて broker に登録する。1 セッションに複数の protocol を宣言でき、同じ name は版を置き換える。
- 同じ `name@version` で中身が違う定義は `PROTOCOL_CONFLICT` で拒否される。宣言者がいなくなった定義は broker から消える。定義は `broker.json` に保存され、broker の再起動後も heartbeat で復旧する。
- `list_peers(protocol, version?)` で話せる相手を探し、`get_protocol(name)` で定義を読み、`send_message(meta: {protocol, version})` で従う protocol を付けて送る。受け側の表示に `Protocol: name@version` が付き、自分の宣言と版が違えば mismatch が示され、返信の結果に警告が付く。
- 0.9 の broker では `set_protocol` / `list_peers(protocol)` が `BROKER_UNSUPPORTED` になる（0.10.0 以上が必要）。meta 無しの送受信は従来どおり。

## ライブラリと Nuxt module（0.8.0〜）

ツール定義と受信処理は stdio MCP から切り離してライブラリとして使える。stdio の挙動（ツール一覧・文言・instructions・capabilities）とは golden fixture で一致を確認している。

- `@unagents/messenger-client/tools`: `TOOL_DEFS` / `INSTRUCTIONS` / `toolDescriptors()` / `createToolRegistry(ctx)`（`list()` と `call(name, args)`）/ `formatPeer` / `formatMessage`
- `@unagents/messenger-client`（`"."`）の `createMessengerClient(options?)`。`connect()` / `close()` / `send` / `ping` / `listPeers` / `setName` / `setSummary` / `checkMessages` / `onMessage(handler)` / `getBroker()` / `setBroker(url?, { persist? })`。`autoStartBroker` の既定は `false`
- 受信 handler の再配信は同一プロセス・同一 peer id の範囲のみ（約 1 s 後に再投入）。プロセス再起動や再登録（新 id）を跨いだ再配信はしない。handler は冪等にし、恒久的に失敗する入力は自分で握りつぶす（失敗し続ける handler は無制限に再試行される）
- 1 プロセスに `createMessengerClient` を複数作らない（broker は同じ pid + hostname を 1 peer として扱う）

`@unagents/messenger-nuxt`（`packages/nuxt/`）は上記ライブラリを使う Nuxt 4 module。導入手順・runtimeConfig・`useMessenger()`・`messenger:message` hook・`/mcp` のセキュリティ注意は [`packages/nuxt/README.md`](../packages/nuxt/README.md) を参照。

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@unagents/messenger-nuxt'],
  messenger: { name: 'my-nuxt', brokers: ['http://127.0.0.1:7901'] },
})
```

- `messenger:message` に listener があればそこへ配信（全 listener 成功で ack、失敗は再配信）。無ければ消費せず `useMessenger().checkMessages()` で取得
- `@nuxtjs/mcp-toolkit` を入れた場合のみ、ツールを `/mcp` に追加する。`/mcp` 自体に認証は無く、broker の token を迂回できる点に注意
