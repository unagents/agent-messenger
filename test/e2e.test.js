import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

const BIN = fileURLToPath(new URL("../bin/agent-messenger.js", import.meta.url));
const PORT = 17901 + Math.floor(Math.random() * 1000);
const TOKEN = "test-token";
const dir = mkdtempSync(join(tmpdir(), "agent-messenger-"));
// never let the test post into a real Claude Code session the runner may be a child of
const baseEnv = { ...process.env };
delete baseEnv.CLAUDE_CODE_MESSAGING_SOCKET;
delete baseEnv.CLAUDE_CODE_MESSAGING_TOKEN;
delete baseEnv.AGENT_MESSENGER_DELIVERY;

const env = {
  ...baseEnv,
  AGENT_MESSENGER_HOST: "127.0.0.1",
  AGENT_MESSENGER_PORT: String(PORT),
  AGENT_MESSENGER_BIND: "127.0.0.1",
  AGENT_MESSENGER_TOKEN: TOKEN,
  AGENT_MESSENGER_STATE: join(dir, "broker.json"),
};
const URL_ = `http://127.0.0.1:${PORT}`;

let broker;
async function post(path, body) {
  const res = await fetch(`${URL_}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

before(async () => {
  broker = spawn(process.execPath, [BIN, "broker"], { env, stdio: ["ignore", "ignore", "pipe"] });
  broker.stderr.on("data", () => {});
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${URL_}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("broker did not start");
});

after(() => {
  broker.kill("SIGTERM");
  rmSync(dir, { recursive: true, force: true });
});

test("auth: POST without token is rejected", async () => {
  const res = await fetch(`${URL_}/list-peers`, { method: "POST", body: "{}" });
  assert.equal(res.status, 401);
});

test("http: register, name resolution, send/poll/ack", async () => {
  const a = await post("/register", { pid: 1, hostname: "hostA", cwd: "/a", name: "alpha" });
  const b = await post("/register", { pid: 2, hostname: "hostB", cwd: "/b", name: "" });
  assert.ok(a.id && b.id);

  const peers = await post("/list-peers", { scope: "all", cwd: "/", git_root: null });
  assert.equal(peers.length, 2);

  const sent = await post("/send-message", { from_id: b.id, to: "alpha", text: "hi alpha" });
  assert.equal(sent.ok, true);
  assert.equal(sent.to_id, a.id);

  const missing = await post("/send-message", { from_id: b.id, to: "nobody", text: "x" });
  assert.equal(missing.ok, false);

  const polled = await post("/poll-messages", { id: a.id });
  assert.equal(polled.messages.length, 1);
  assert.equal(polled.messages[0].text, "hi alpha");

  const again = await post("/poll-messages", { id: a.id });
  assert.equal(again.messages.length, 0);

  const buffered = await post("/get-buffered-messages", { id: a.id });
  assert.equal(buffered.messages.length, 1);

  await post("/acknowledge-messages", { id: a.id, message_ids: [polled.messages[0].id] });
  const afterAck = await post("/get-buffered-messages", { id: a.id });
  assert.equal(afterAck.messages.length, 0);

  await post("/unregister", { id: a.id });
  await post("/unregister", { id: b.id });
});

async function mcpClient(name, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, "mcp"],
    env: { ...env, AGENT_MESSENGER_NAME: name, ...extraEnv },
    stderr: "pipe",
  });
  const client = new Client({ name: `test-${name}`, version: "0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

test("mcp: two sessions exchange a message, channel push + check_messages", async () => {
  const cap = await mcpClient("cap-x");
  const master = await mcpClient("master");

  const received = [];
  cap.setNotificationHandler(
    z.object({ method: z.literal("notifications/claude/channel"), params: z.any() }),
    (n) => received.push(n.params)
  );

  const tools = await cap.listTools();
  assert.deepEqual(
    tools.tools.map((t) => t.name).sort(),
    ["check_messages", "list_peers", "send_message", "set_name", "set_summary"]
  );

  const lp = await master.callTool({ name: "list_peers", arguments: { scope: "all" } });
  assert.match(lp.content[0].text, /Name: cap-x/);

  const sm = await master.callTool({ name: "send_message", arguments: { to: "cap-x", message: "ping from master" } });
  assert.match(sm.content[0].text, /Message sent to cap-x/);

  for (let i = 0; i < 40 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 1, "channel notification should arrive");
  assert.equal(received[0].content, "ping from master");
  assert.equal(received[0].meta.from_name, "master");

  // pushed message was acknowledged, so check_messages is empty now
  const cm = await cap.callTool({ name: "check_messages", arguments: {} });
  assert.match(cm.content[0].text, /No new messages/);

  // send by id works too
  const peers = await cap.callTool({ name: "list_peers", arguments: {} });
  const masterId = peers.content[0].text.match(/ID: (\w+)\n  Name: master/)[1];
  const r2 = await cap.callTool({ name: "send_message", arguments: { to: masterId, message: "pong" } });
  assert.match(r2.content[0].text, /Message sent to master/);

  await cap.close();
  await master.close();
});

test("mcp: re-registers with the same name after the broker forgets it", async () => {
  const cap = await mcpClient("cap-reg", { AGENT_MESSENGER_HEARTBEAT_MS: "300" });
  const before = await post("/list-peers", { scope: "all", cwd: "/", git_root: null });
  const me = before.find((p) => p.name === "cap-reg");
  assert.ok(me, "registered");

  // simulate broker restart / stale cleanup: drop the peer server-side
  await post("/unregister", { id: me.id });
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const now = await post("/list-peers", { scope: "all", cwd: "/", git_root: null });
    if (now.some((p) => p.name === "cap-reg" && p.id !== me.id)) break;
  }
  const after = await post("/list-peers", { scope: "all", cwd: "/", git_root: null });
  const again = after.find((p) => p.name === "cap-reg");
  assert.ok(again, "re-registered");
  assert.notEqual(again.id, me.id);

  // and it is reachable by name again
  const sent = await post("/send-message", { from_id: "cli", to: "cap-reg", text: "back" });
  assert.equal(sent.ok, true);
  await cap.close();
});

test("mcp: inbound message is posted to the session inbox socket when available", async () => {
  const sockPath = join(dir, "session.sock");
  const lines = [];
  const server = createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
  });
  await new Promise((r) => server.listen(sockPath, r));

  const cap = await mcpClient("cap-sock", { CLAUDE_CODE_MESSAGING_SOCKET: sockPath, CLAUDE_CODE_MESSAGING_TOKEN: "tok" });
  const channel = [];
  cap.setNotificationHandler(
    z.object({ method: z.literal("notifications/claude/channel"), params: z.any() }),
    (n) => channel.push(n.params)
  );
  const master = await mcpClient("master2");
  await master.callTool({ name: "send_message", arguments: { to: "cap-sock", message: "via socket" } });

  for (let i = 0; i < 40 && lines.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(lines.length, 2, "auth line + user line");
  assert.deepEqual(lines[0], { type: "auth", token: "tok" });
  assert.equal(lines[1].type, "user");
  assert.equal(lines[1].message.role, "user");
  assert.match(lines[1].message.content, /^\[agent-messenger\] message from master2/);
  assert.match(lines[1].message.content, /via socket/);
  assert.equal(channel.length, 0, "no channel push when socket delivery succeeded");

  const cm = await cap.callTool({ name: "check_messages", arguments: {} });
  assert.match(cm.content[0].text, /No new messages/);

  await cap.close();
  await master.close();
  server.close();
});
