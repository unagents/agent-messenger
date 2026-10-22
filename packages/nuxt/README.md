# @agent-hand/messenger-nuxt

Nuxt 4 module for agent-messenger. **One Nuxt server = one peer**: the Nitro server connects to a broker through the
library API of `@agent-hand/messenger-client`, shows up in `agent-messenger peers`, can send messages, and receives
messages through a Nitro hook or by pulling. Optionally it exposes the six messenger tools on `/mcp` through
`@nuxtjs/mcp-toolkit`.

Not published yet (internal registry only).

## Install

```bash
npm i @agent-hand/messenger-nuxt
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@agent-hand/messenger-nuxt'],
  messenger: {
    name: 'my-nuxt',
    summary: 'what this server does',
    brokers: ['http://127.0.0.1:7901'],
  },
})
```

Requires Node >= 20 (Nuxt 4.5 needs Node >= 22.19) and Nuxt >= 4.

## runtimeConfig

Module options (`messenger` key) are copied to the private `runtimeConfig.messenger`. A value that already exists in
`runtimeConfig` wins over the module option.

| key | default | meaning |
|---|---|---|
| `name` | `''` | peer name. Empty = `AGENT_MESSENGER_NAME` env, else the library default |
| `summary` | `''` | peer summary |
| `brokers` | `[]` | broker URLs tried first. Empty = config file, discovery, then the local broker |
| `autoStartBroker` | `false` | spawn a local broker when none is reachable |

Override at runtime with `NUXT_MESSENGER_NAME`, `NUXT_MESSENGER_SUMMARY`, `NUXT_MESSENGER_BROKERS`
(a JSON array or a comma separated list), `NUXT_MESSENGER_AUTO_START_BROKER`.

Resolution order, same as the CLI: `AGENT_MESSENGER_HOST` env (wins over `brokers`), then `brokers`, then the config
file / discovery, then `127.0.0.1:<AGENT_MESSENGER_PORT|7901>`. Set `AGENT_MESSENGER_DISCOVERY=off` to stop discovery.
The token is **not** part of runtimeConfig: pass `AGENT_MESSENGER_TOKEN` as an env variable.

With `autoStartBroker: false` and no reachable local broker, the connect fails; the module retries every 5 s until the
server closes, and logs each failure.

## Sending: `useMessenger()`

Auto-imported in server code (`server/api`, `server/routes`, plugins).

```ts
export default defineEventHandler(async () => {
  const m = useMessenger()
  await m.setSummary('serving requests')
  return await m.send('other-peer', 'hello')            // delivery 'pull' (default) or 'push'
})
```

`send(to, text, delivery?)`, `ping(to, subject?)`, `listPeers(scope?)`, `setName(name)`, `setSummary(summary)`,
`checkMessages()`. Each call waits up to 10 s for the first connect, then throws `Not connected to broker yet`.
Errors from the library keep their text (`Invalid delivery: ...`, `Failed to send: ...`).

## Receiving: the `messenger:message` hook

```ts
// server/plugins/messages.ts
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('messenger:message', async (m) => {
    // m: InboundMessage { id, from_id, from_name, text, mode: 'pull' | 'push' | 'ping', ... }
    await handle(m)
  })
})
```

How a message is delivered depends on whether `messenger:message` has a listener **at that moment** (it is re-evaluated
whenever a listener is added or removed, so plugin order does not matter):

- Listener present: the message goes to the hook. It is acknowledged only after **all** listeners succeeded. If any
  listener throws, the message stays buffered and is handed to **all** listeners again about 1 s later.
- No listener: nothing is consumed. Messages stay on the broker / in the client buffer and are read with
  `useMessenger().checkMessages()`.

Rules:

- **Handlers must be idempotent.** A listener that already succeeded sees the message again when a later listener fails.
- Catch errors for input that can never succeed. A permanently failing listener is retried every second without limit.
- `ping` messages also reach the hook (`m.mode === 'ping'`); ignore them if you do not need them.
- Use either the hook or `checkMessages()`, not both: while a message is being processed it can be seen by both.
- Redelivery works only inside one process and one peer id. After a dev reload or a restart the server registers with a
  new id; messages that were polled but not acknowledged under the old id are not redelivered.
- No push notification is sent to the Nuxt side (there is no conversation to notify).

## One client per process

The broker treats the same pid + hostname as one peer: a second registration removes the first peer and its unread
messages. Do not create another `createMessengerClient` in the same process, and run Nuxt as a single process
(`node-server` preset, no cluster). Several processes make several peers with the same name, which makes name based
sends ambiguous.

In `nuxi dev`, a server file change reloads the Nitro worker. The old worker unregisters on its `close` hook and the new
one registers; `peers` shows the server once. A hard kill leaves the old peer until the broker's stale cleanup removes it.

## Toolkit: the six tools on `/mcp`

Optional. Install `@nuxtjs/mcp-toolkit` (and `zod` v4, which the toolkit needs) and list it in `modules`:

```ts
export default defineNuxtConfig({
  modules: ['@nuxtjs/mcp-toolkit', '@agent-hand/messenger-nuxt'],
})
```

`/mcp` then lists `set_name`, `set_summary`, `list_peers`, `send_message`, `send_ping`, `check_messages`, with the same
texts and error messages as the stdio client (for example `Invalid delivery: bogus (use "pull" or "push")`). The tools
are added per request through the toolkit's `mcp:config:resolved` hook; a tool with the same name that you define yourself
is kept and the module's is skipped. They also appear on named handlers (`/mcp/<name>`). Set `mcp.instructions` yourself if
you want the messenger usage text.

Without the toolkit the module still works and `/mcp` does not exist; `zod` and the toolkit are never imported then.

## Playground

```bash
npm --prefix packages/nuxt run dev:prepare
npm --prefix packages/nuxt run dev -- --host 127.0.0.1 --port 17946
```

`playground/scripts/measure.mjs` is the measurement driver used for the evidence in the repository history (it starts
its own loopback broker on 17945).
