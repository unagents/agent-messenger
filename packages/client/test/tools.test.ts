/**
 * Tool registry unit tests: a fake broker (no process, no socket), the stdio surface golden
 * fixture (taken from the 75e2ada build) and the `./tools` export.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "../src/hosts/stdio.js";
import { createInbox } from "../src/inbox.js";
import { createPeerState } from "../src/peer.js";
import { INSTRUCTIONS } from "../src/tools/defs.js";
import { createToolRegistry, toolDescriptors } from "../src/tools/registry.js";
import { VERSION } from "../src/version.js";

type Handler = (body: Record<string, unknown>) => unknown;

function fakeBroker(routes: Record<string, Handler>) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const broker = {
    async post(path: string, body: Record<string, unknown>) {
      calls.push({ path, body });
      const h = routes[path];
      if (!h) throw new Error(`no route ${path}`);
      return h(body);
    },
  };
  return { broker: broker as never, calls };
}

function setup(routes: Record<string, Handler>, registered = true) {
  const { broker, calls } = fakeBroker(routes);
  const peer = createPeerState({ name: "me", hostname: "h", cwd: "/w" });
  if (registered) peer.id = "me-id";
  const inbox = createInbox({ broker, peer, log: () => {} });
  const registry = createToolRegistry({ broker, peer, inbox });
  return { registry, peer, calls };
}

const err = (text: string) => ({ content: [{ type: "text", text }], isError: true });
const ok = (text: string) => ({ content: [{ type: "text", text }] });

describe("stdio surface", () => {
  it("matches the golden fixture taken from 75e2ada (tools, instructions, capabilities)", () => {
    const raw = readFileSync(fileURLToPath(new URL("./fixtures/stdio-surface.json", import.meta.url)), "utf8").replaceAll(
      "0.7.0",
      VERSION
    );
    const golden = JSON.parse(raw) as { tools: unknown; instructions: string; capabilities: unknown };
    expect(JSON.stringify(toolDescriptors())).toBe(JSON.stringify(golden.tools));
    expect(INSTRUCTIONS).toBe(golden.instructions);
    expect(JSON.stringify(CAPABILITIES)).toBe(JSON.stringify(golden.capabilities));
  });

  it("exports ./tools and the file it points at exists after build", () => {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { exports: Record<string, { import: string; types: string }> };
    const entry = pkg.exports["./tools"];
    expect(entry).toBeDefined();
    expect(existsSync(fileURLToPath(new URL(`../${entry.import}`, import.meta.url)))).toBe(true);
    expect(existsSync(fileURLToPath(new URL(`../${entry.types}`, import.meta.url)))).toBe(true);
  });
});

describe("tool registry", () => {
  it("list() carries descriptors only (no handler / requiresRegistration)", () => {
    const { registry } = setup({});
    const list = registry.list();
    expect(list.map((t) => t.name)).toEqual([
      "list_peers",
      "send_message",
      "send_ping",
      "set_name",
      "set_summary",
      "check_messages",
      "set_protocol",
      "unset_protocol",
      "get_protocol",
      "get_broker",
      "set_broker",
    ]);
    for (const t of list) {
      expect(Object.keys(t)).toEqual(["name", "description", "inputSchema", "annotations"]);
    }
  });

  it("not registered: guards everything but list_peers (also unknown tools)", async () => {
    const { registry, calls } = setup({ "/list-peers": () => [] }, false);
    expect(await registry.call("send_message", { to: "x", message: "m" })).toEqual(err("Not registered with broker yet"));
    expect(await registry.call("unknown_x", {})).toEqual(err("Not registered with broker yet"));
    expect(await registry.call("list_peers", undefined)).toEqual(ok("No other sessions found (scope: all)."));
    expect(calls).toHaveLength(1);
    expect(calls[0].body.exclude_id).toBeUndefined();
  });

  it("registered: unknown tool, invalid delivery, failed send, successful send", async () => {
    let reply: unknown = { ok: false, error: "x" };
    const { registry, calls } = setup({ "/send-message": () => reply });
    expect(await registry.call("unknown_x", {})).toEqual(err("Unknown tool: unknown_x"));
    expect(await registry.call("send_message", { to: "b", message: "m", delivery: "loud" })).toEqual(
      err('Invalid delivery: loud (use "pull" or "push")')
    );
    expect(calls).toHaveLength(0);
    expect(await registry.call("send_message", { to: "b", message: "m" })).toEqual(err("Failed to send: x"));
    reply = { ok: true, to_id: "b-id", to_name: "b", message_id: 1 };
    expect(await registry.call("send_message", { to: "b", message: "m", delivery: "push" })).toEqual(
      ok("Message sent to b (b-id) (delivery: push).")
    );
    expect(calls[calls.length - 1].body).toEqual({ from_id: "me-id", from_name: "me", to: "b", text: "m", mode: "push" });
    reply = { ok: true, to_id: "b-id", to_name: "", message_id: 2 };
    expect(await registry.call("send_message", { to: "b", message: "m" })).toEqual(ok("Message sent to b-id (delivery: pull)."));
  });

  it("send_ping, set_name, set_summary", async () => {
    const { registry, peer, calls } = setup({
      "/send-message": () => ({ ok: true, to_id: "b-id", to_name: "b", message_id: 3 }),
      "/set-name": () => ({ ok: true }),
      "/set-summary": () => ({ ok: true }),
    });
    expect(await registry.call("send_ping", { to: "b", subject: "task-1" })).toEqual(ok("Ping sent to b (b-id)."));
    expect(calls[0].body).toEqual({ from_id: "me-id", from_name: "me", to: "b", text: "task-1", mode: "ping" });
    expect(await registry.call("send_ping", { to: "b" })).toEqual(ok("Ping sent to b (b-id)."));
    expect(calls[1].body.text).toBe("");
    expect(await registry.call("set_name", { name: "n2" })).toEqual(ok('Name set: "n2"'));
    expect(peer.name).toBe("n2");
    expect(await registry.call("set_summary", { summary: "s2" })).toEqual(ok('Summary updated: "s2"'));
    expect(peer.summary).toBe("s2");
  });

  it("set_name failure keeps the old name; a throwing broker becomes Error (name): ...", async () => {
    const failing = setup({ "/set-name": () => ({ ok: false, error: "taken" }) });
    expect(await failing.registry.call("set_name", { name: "n2" })).toEqual(err("Failed: taken"));
    expect(failing.peer.name).toBe("me");
    const throwing = setup({
      "/set-name": () => {
        throw new Error("boom");
      },
    });
    expect(await throwing.registry.call("set_name", { name: "n2" })).toEqual(err("Error (set_name): boom"));
  });

  it("check_messages: empty", async () => {
    const { registry } = setup({
      "/poll-messages": () => ({ messages: [] }),
      "/get-buffered-messages": () => ({ messages: [] }),
    });
    expect(await registry.call("check_messages", {})).toEqual(ok("No new messages."));
  });

  it("check_messages: acknowledges pings, returns the text of the rest", async () => {
    const msg = (id: number, mode: string, text: string) => ({
      id,
      from_id: "f",
      from_name: "fn",
      to_id: "me-id",
      text,
      sent_at: "t",
      mode,
    });
    const { registry, calls } = setup({
      "/poll-messages": () => ({ messages: [] }),
      "/get-buffered-messages": () => ({ messages: [msg(1, "ping", "subject"), msg(2, "pull", "hello")] }),
      "/acknowledge-messages": () => ({ ok: true }),
    });
    expect(await registry.call("check_messages", {})).toEqual(ok("1 message(s):\n\nFrom fn (f) at t:\nhello"));
    const acks = calls.filter((c) => c.path === "/acknowledge-messages").map((c) => c.body.message_ids);
    expect(acks).toEqual([[1], [2]]);
  });
});
