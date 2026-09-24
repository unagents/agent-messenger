#!/usr/bin/env node
/**
 * Manual cross-host probe: connect to the broker as a named MCP peer,
 * print every channel notification, optionally send one message first.
 *
 *   AGENT_MESSENGER_HOST=192.168.1.202 node test/probe.js <name> [seconds] [to] [message...]
 */
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

const BIN = fileURLToPath(new URL("../bin/agent-messenger.js", import.meta.url));
const [name, secondsArg, to, ...words] = process.argv.slice(2);
if (!name) {
  console.error("usage: probe.js <name> [seconds] [to] [message...]");
  process.exit(1);
}
const seconds = parseInt(secondsArg ?? "20", 10);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [BIN, "mcp"],
  env: { ...process.env, AGENT_MESSENGER_NAME: name },
  stderr: "pipe",
});
transport.stderr?.on("data", (d) => process.stderr.write(d));
const client = new Client({ name: `probe-${name}`, version: "0" }, { capabilities: {} });
client.setNotificationHandler(
  z.object({ method: z.literal("notifications/claude/channel"), params: z.any() }),
  (n) => {
    const m = n.params.meta ?? {};
    console.log(`[${new Date().toISOString()}] CHANNEL from ${m.from_name || m.from_id}@${m.from_hostname}: ${n.params.content}`);
  }
);
await client.connect(transport);

const peers = await client.callTool({ name: "list_peers", arguments: {} });
console.log(peers.content[0].text);

if (to && words.length) {
  const r = await client.callTool({ name: "send_message", arguments: { to, message: words.join(" ") } });
  console.log(r.content[0].text);
}

console.log(`listening as "${name}" for ${seconds}s ...`);
await new Promise((r) => setTimeout(r, seconds * 1000));
const cm = await client.callTool({ name: "check_messages", arguments: {} });
console.log(`check_messages: ${cm.content[0].text}`);
await client.close();
