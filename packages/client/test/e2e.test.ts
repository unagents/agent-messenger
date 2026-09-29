import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPABILITIES, INSTRUCTIONS, TOOLS, VERSION } from "../src/index.js";
import { baseEnv, McpTestClient, sleep, startBroker, startClientProcess } from "./helpers.js";

const PORT = 17901 + Math.floor(Math.random() * 1000);
const TOKEN = "test-token";
const dir = mkdtempSync(join(tmpdir(), "am-client-e2e-"));

const env = {
  ...baseEnv(),
  AGENT_MESSENGER_HOST: "127.0.0.1",
  AGENT_MESSENGER_PORT: String(PORT),
  AGENT_MESSENGER_BIND: "127.0.0.1",
  AGENT_MESSENGER_TOKEN: TOKEN,
  AGENT_MESSENGER_STATE: join(dir, "broker.json"),
  AGENT_MESSENGER_DISCOVERY: "off",
  AGENT_MESSENGER_CONFIG: join(dir, "no-config.json"),
};
const URL_ = `http://127.0.0.1:${PORT}`;

let broker: ChildProcess;

async function post<T = any>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${URL_}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

function mcpClient(name: string, extraEnv: Record<string, string> = {}) {
  return startClientProcess({ ...env, AGENT_MESSENGER_NAME: name, ...extraEnv });
}

beforeAll(async () => {
  broker = await startBroker(env);
});

afterAll(() => {
  broker.kill("SIGTERM");
  rmSync(dir, { recursive: true, force: true });
});

describe("mcp stdio", () => {
  it("initialize / tools/list / ping / unknown method match the SDK-based server", async () => {
    const c = await mcpClient("init-x");
    const init = await c.request<any>("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    // measured from the legacy/src/server.js (@modelcontextprotocol/sdk 1.30.1)
    expect(init).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: { experimental: { "claude/channel": {} }, tools: {} },
      serverInfo: { name: "agent-messenger", version: VERSION },
      instructions: INSTRUCTIONS,
    });
    expect(init.capabilities).toEqual(CAPABILITIES);
    c.notify("notifications/initialized");

    const tools = await c.request<{ tools: unknown[] }>("tools/list");
    expect(tools).toEqual({ tools: TOOLS });
    expect(INSTRUCTIONS.startsWith(`agent-messenger v${VERSION}\n`)).toBe(true);
    for (const t of TOOLS) expect(t.description.startsWith(`[agent-messenger v${VERSION}] `)).toBe(true);
    expect((tools.tools as { name: string }[]).map((t) => t.name).sort()).toEqual([
      "check_messages",
      "list_peers",
      "send_message",
      "send_ping",
      "set_name",
      "set_summary",
    ]);

    expect(await c.request("ping")).toEqual({});

    await expect(c.request("resources/list")).rejects.toMatchObject({ code: -32601, message: "Method not found" });

    const unknown = await c.callTool("unknown_tool", {});
    expect(unknown).toEqual({ content: [{ type: "text", text: "Unknown tool: unknown_tool" }], isError: true });

    // malformed input is ignored, the server keeps answering
    c.writeRaw("not json at all");
    c.writeRaw("");
    expect(await c.request("ping")).toEqual({});

    expect(await c.close()).toBe(0);
    expect(c.stderrText()).toMatch(/Unregistered from broker/);
  });

  it("protocolVersion: unsupported requested version falls back to the latest", async () => {
    const c = await mcpClient("init-y");
    const init = await c.request<any>("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    expect(init.protocolVersion).toBe("2025-11-25");
    await c.close();
  });

  it("two sessions exchange a message: set_name → send_message → channel push, then check_messages", async () => {
    const cap = await mcpClient("cap-x");
    const master = await mcpClient("master");
    await cap.initialize();
    await master.initialize();

    const sn = await cap.callTool("set_name", { name: "cap-renamed" });
    expect(sn.content[0].text).toBe('Name set: "cap-renamed"');

    const lp = await master.callTool("list_peers", { scope: "all" });
    expect(lp.content[0].text).toMatch(/Name: cap-renamed/);

    const sm = await master.callTool("send_message", { to: "cap-renamed", message: "ping from master", delivery: "push" });
    expect(sm.content[0].text).toMatch(/Message sent to cap-renamed/);

    await cap.waitFor(() => cap.notifications.length > 0, 4000);
    expect(cap.notifications.length, "channel notification should arrive").toBe(1);
    const n = cap.notifications[0];
    expect(n.method).toBe("notifications/claude/channel");
    const params = n.params as { content: string; meta: Record<string, string> };
    expect(params.content).toBe("ping from master");
    expect(params.meta.from_name).toBe("master");
    expect(params.meta.from_cwd).toBe(process.cwd());
    expect(typeof params.meta.from_id).toBe("string");
    expect(typeof params.meta.sent_at).toBe("string");

    // pushed message was acknowledged, so check_messages is empty now
    const cm = await cap.callTool("check_messages", {});
    expect(cm.content[0].text).toMatch(/No new messages/);

    // send by id works too
    const peers = await cap.callTool("list_peers");
    const masterId = peers.content[0].text.match(/ID: (\w+)\n  Name: master/)![1];
    const r2 = await cap.callTool("send_message", { to: masterId, message: "pong" });
    expect(r2.content[0].text).toMatch(/Message sent to master/);

    // unknown target is reported as a tool error
    const r3 = await cap.callTool("send_message", { to: "nobody", message: "x" });
    expect(r3.isError).toBe(true);
    expect(r3.content[0].text).toMatch(/Failed to send: Peer "nobody" not found/);

    await cap.close();
    await master.close();
  });

  it("check_messages returns buffered messages when channel push is disabled", async () => {
    // AGENT_MESSENGER_DELIVERY=channel with the poll timer racing: send before the client polls,
    // then read via check_messages. A pushed message is acknowledged; a message that arrives
    // between polls is picked up by check_messages itself (pollBroker(false)).
    const cap = await mcpClient("cap-buf", { AGENT_MESSENGER_DELIVERY: "channel" });
    await cap.initialize();
    const peers = await post<{ id: string; name: string }[]>("/list-peers", { scope: "all", cwd: "/", git_root: null });
    const me = peers.find((p) => p.name === "cap-buf")!;
    // deliver through the broker directly, mark delivered (poll) so the client's own poll does not push it
    await post("/send-message", { from_id: "cli", from_name: "cli", to: me.id, text: "buffered hello" });
    await post("/poll-messages", { id: me.id });
    const cm = await cap.callTool("check_messages", {});
    expect(cm.content[0].text).toMatch(/^1 message\(s\):\n\nFrom cli \(cli\) at .*:\nbuffered hello$/s);
    const again = await cap.callTool("check_messages", {});
    expect(again.content[0].text).toMatch(/No new messages/);
    await cap.close();
  });

  it("re-registers with the same name after the broker forgets it", async () => {
    const cap = await mcpClient("cap-reg", { AGENT_MESSENGER_HEARTBEAT_MS: "300" });
    await cap.initialize();
    const before = await post<{ id: string; name: string }[]>("/list-peers", { scope: "all", cwd: "/", git_root: null });
    const me = before.find((p) => p.name === "cap-reg");
    expect(me, "registered").toBeTruthy();

    // simulate broker restart / stale cleanup: drop the peer server-side
    await post("/unregister", { id: me!.id });
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      const now = await post<{ id: string; name: string }[]>("/list-peers", { scope: "all", cwd: "/", git_root: null });
      if (now.some((p) => p.name === "cap-reg" && p.id !== me!.id)) break;
    }
    const after = await post<{ id: string; name: string }[]>("/list-peers", { scope: "all", cwd: "/", git_root: null });
    const again = after.find((p) => p.name === "cap-reg");
    expect(again, "re-registered").toBeTruthy();
    expect(again!.id).not.toBe(me!.id);
    expect(cap.stderrText()).toMatch(/Heartbeat rejected \(unknown peer \(re-register\)\) — re-registering/);

    // and it is reachable by name again
    const sent = await post<{ ok: boolean }>("/send-message", { from_id: "cli", to: "cap-reg", text: "back" });
    expect(sent.ok).toBe(true);
    await cap.close();
  });

  it("inbound message is posted to the session inbox socket when available", async () => {
    const sockPath = join(dir, "session.sock");
    const lines: any[] = [];
    let ended = false;
    const server = createServer((c) => {
      let buf = "";
      c.on("data", (d) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf("\n")) !== -1) {
          lines.push(JSON.parse(buf.slice(0, i)));
          buf = buf.slice(i + 1);
        }
      });
      c.on("end", () => {
        ended = true;
        c.end();
      });
    });
    await new Promise<void>((r) => server.listen(sockPath, r));

    const cap = await mcpClient("cap-sock", { CLAUDE_CODE_MESSAGING_SOCKET: sockPath, CLAUDE_CODE_MESSAGING_TOKEN: "tok" });
    await cap.initialize();
    const master = await mcpClient("master2");
    await master.initialize();
    await master.callTool("send_message", { to: "cap-sock", message: "via socket", delivery: "push" });

    await cap.waitFor(() => lines.length >= 2 && ended, 4000);
    expect(lines.length, "auth line + user line").toBe(2);
    expect(lines[0]).toEqual({ type: "auth", token: "tok" });
    expect(lines[1].type).toBe("user");
    expect(lines[1].message.role).toBe("user");
    expect(lines[1].message.content).toMatch(/^\[agent-messenger\] message from master2/);
    expect(lines[1].message.content).toMatch(/via socket/);
    expect(ended, "client half-closes after the user line").toBe(true);
    expect(cap.notifications.length, "no channel push when socket delivery succeeded").toBe(0);
    expect(cap.stderrText()).toMatch(/Session socket delivery OK from master2/);

    const cm = await cap.callTool("check_messages", {});
    expect(cm.content[0].text).toMatch(/No new messages/);

    await cap.close();
    await master.close();
    server.close();
  });

  it("falls back to channel push when the session socket is unreachable", async () => {
    const cap = await mcpClient("cap-nosock", { CLAUDE_CODE_MESSAGING_SOCKET: join(dir, "missing.sock") });
    await cap.initialize();
    const master = await mcpClient("master3");
    await master.initialize();
    await master.callTool("send_message", { to: "cap-nosock", message: "fallback", delivery: "push" });
    await cap.waitFor(() => cap.notifications.length > 0, 4000);
    expect(cap.notifications.length).toBe(1);
    expect((cap.notifications[0].params as { content: string }).content).toBe("fallback");
    expect(cap.stderrText()).toMatch(/Session socket delivery FAILED from .* — trying channel/);
    await cap.close();
    await master.close();
  });

  it("wrong token: tool calls report the broker error, the client keeps running", async () => {
    // registration fails → client exits with an error before serving
    const c = new McpTestClient({ ...env, AGENT_MESSENGER_NAME: "bad-token", AGENT_MESSENGER_TOKEN: "wrong" });
    const code = await c.exited;
    expect(code).toBe(1);
    expect(c.stderrText()).toMatch(/Broker error \(\/register\): 401/);
  });
});
