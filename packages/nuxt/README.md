# @unagents/messenger-nuxt

Nuxt 4 module for agent-messenger. **One Nuxt server = one peer**: the Nitro server connects to a broker through the
library API of `@unagents/messenger-client`, shows up in `agent-messenger peers`, can send messages, and receives
messages through a Nitro hook or by pulling. Optionally it exposes the nine messenger tools on `/mcp` through
`@nuxtjs/mcp-toolkit`.

Not published yet (internal registry only).

## Install

```bash
npm i @unagents/messenger-nuxt
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@unagents/messenger-nuxt'],
  messenger: {
    name: 'my-nuxt',
    summary: 'what this server does',
    brokers: ['http://127.0.0.1:7901'],
  },
})
```

Requires Nuxt >= 4 and Node `^22.19.0 || ^24.11.0 || >=26` (the range of Nuxt 4.5).

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

`send(to, text, delivery?, meta?)`, `ping(to, subject?)`, `listPeers(scope?, filter?)`, `setName(name)`,
`setSummary(summary)`, `checkMessages()`. Each call waits up to 10 s for the first connect, then throws `Not connected to broker yet`.
Errors from the library keep their text (`Invalid delivery: ...`, `Failed to send: ...`).

Protocols (needs a broker 0.10.0 or newer): `setProtocol(repo, version?)` declares that this server follows the protocol in a
public GitHub / Gitea repo or a local path, `unsetProtocol(name?)` withdraws it (all when no name), and
`getProtocol(name, version?)` reads a stored definition. `listPeers(scope, { protocol, version })` returns only servers
that declare the protocol, and `send(to, text, delivery, { protocol, version })` tags a message with the protocol it
follows. The same three tools are on `/mcp` (see below).

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
- The check is made for every delivery. When a listener appears later, the unread backlog (messages that arrived while
  nobody listened and were not pulled) is handed to the hook together with the next message.

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

## Toolkit: the nine tools on `/mcp`

Optional. Install `@nuxtjs/mcp-toolkit` (and `zod` v4, which the toolkit needs) and list it in `modules`:

```ts
export default defineNuxtConfig({
  modules: ['@nuxtjs/mcp-toolkit', '@unagents/messenger-nuxt'],
})
```

`/mcp` then lists `set_name`, `set_summary`, `list_peers`, `send_message`, `send_ping`, `check_messages`, `set_protocol`, `unset_protocol`, `get_protocol`, with the same
texts and error messages as the stdio client (for example `Invalid delivery: bogus (use "pull" or "push")`). The tools
are added per request through the toolkit's `mcp:config:resolved` hook; a tool with the same name that you define yourself
is kept and the module's is skipped. They also appear on named handlers (`/mcp/<name>`). Set `mcp.instructions` yourself if
you want the messenger usage text.

**Security: `/mcp` has no authentication of its own.** Anyone who can reach the route can call `send_message`
(with `push`, the text appears directly in the receiver's conversation), `check_messages` (reads and acknowledges the
inbox, competing with your hook) and `set_name`. The tools act through this server's peer, so this also bypasses a broker
`AGENT_MESSENGER_TOKEN`. Do not expose the route, or protect `/mcp*`, for example with a Nitro server middleware
(or the toolkit's handler `middleware`):

```ts
// server/middleware/mcp-auth.ts
export default defineEventHandler((event) => {
  if (!getRequestURL(event).pathname.startsWith('/mcp')) return
  if (getHeader(event, 'authorization') !== `Bearer ${process.env.MCP_TOKEN}`) {
    throw createError({ statusCode: 401 })
  }
})
```

Without the toolkit the module still works and `/mcp` does not exist; `zod` and the toolkit are never imported then.

## Playground

```bash
npm --prefix packages/nuxt run dev:prepare
npm --prefix packages/nuxt run dev -- --host 127.0.0.1 --port 17946
```

`playground/scripts/measure.mjs` is the measurement driver used for the evidence in the repository history (it starts
its own loopback broker on 17945).
