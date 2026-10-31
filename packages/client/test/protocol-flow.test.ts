/**
 * The protocol feature against a real broker (child process, loopback):
 * - library API (`createMessengerClient`) as a caller and as a server, heartbeat `resend`, re-register re-send
 * - a 0.9-style broker (fake HTTP server) for BROKER_UNSUPPORTED and the unchanged wire form
 * - two stdio client processes: tools over JSON-RPC, channel notices carrying the Protocol line, reply warning
 *
 * Isolation as in library.test.ts: 127.0.0.1 only, ports from 19300-19399, discovery off, temp HOME / config /
 * state, env from baseEnv(). One library client per process at a time (the broker drops an earlier peer with the
 * same pid + hostname), so the other side of each exchange is a raw HTTP peer or a child process.
 */
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { protocolHash } from "../src/hash.js";
import type { InboundMessage } from "../src/inbox.js";
import { createMessengerClient } from "../src/messenger.js";
import type { MessengerClient } from "../src/messenger.js";
import { baseEnv, sleep, startBroker, startClientProcess } from "./helpers.js";

const TOKEN = "proto-flow-token";

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

async function freePort(): Promise<number> {
  for (let i = 0; i < 60; i++) {
    const p = 19300 + Math.floor(Math.random() * 100);
    if (await canListen(p)) return p;
  }
  throw new Error("no free port in 19300-19399");
}

async function until(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(100);
  }
  return pred();
}

let dir: string;
let port: number;
let broker: ChildProcess;
let origHome: string | undefined;

function envFor(p: number, name: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    ...baseEnv(),
    HOME: dir,
    AGENT_MESSENGER_HOST: "127.0.0.1",
    AGENT_MESSENGER_PORT: String(p),
    AGENT_MESSENGER_TOKEN: TOKEN,
    AGENT_MESSENGER_DISCOVERY: "off",
    AGENT_MESSENGER_NAME: name,
    ...extra,
  };
}

function brokerEnv(p: number, state: string): Record<string, string | undefined> {
  return {
    ...baseEnv(),
    HOME: dir,
    AGENT_MESSENGER_PORT: String(p),
    AGENT_MESSENGER_BIND: "127.0.0.1",
    AGENT_MESSENGER_TOKEN: TOKEN,
    AGENT_MESSENGER_STATE: state,
    AGENT_MESSENGER_DISCOVERY: "off",
  };
}

async function raw<T = any>(path: string, body: unknown, p = port): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${p}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return (await r.json()) as T;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

/** A protocol repo on disk. */
function repo(name: string, version: string, doc: string, protoName = "flow-proto"): string {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "protocol.json"), JSON.stringify({ name: protoName, version, description: `flow ${version}`, messages: { req: { type: "object" } } }));
  writeFileSync(join(d, "PROTOCOL.md"), doc);
  return d;
}

/** Register a raw peer that declares a protocol (what a server client does), without a library client. */
async function rawServer(name: string, pid: number, protoName: string, version: string, doc: string) {
  const { id } = await raw<{ id: string }>("/register", { pid, hostname: "raw-host", cwd: "/", git_root: null, tty: null, summary: "", name });
  const manifest = { name: protoName, version, description: "raw", messages: {} };
  const hash = protocolHash(manifest, doc);
  const r = await raw("/set-protocol", { id, name: protoName, version, hash, definition: { manifest, doc, source: "github:raw/server", ref: `v${version}` } });
  expect(r.ok).toBe(true);
  return { id, hash };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "am-pflow-"));
  origHome = process.env.HOME;
  process.env.HOME = dir;
  port = await freePort();
  broker = await startBroker(brokerEnv(port, join(dir, "broker.json")));
});

afterAll(async () => {
  if (broker) await stop(broker);
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("library API as a caller", () => {
  let lib: MessengerClient;
  const logs: string[] = [];
  let srvA: { id: string; hash: string };
  let srvB: { id: string; hash: string };

  beforeAll(async () => {
    srvA = await rawServer("raw-srv-a", 90001, "flow-proto", "1.0.0", "doc A");
    srvB = await rawServer("raw-srv-b", 90002, "flow-proto", "1.1.0", "doc B");
    lib = createMessengerClient({ env: envFor(port, "lib-caller"), log: (m) => logs.push(m) });
    await lib.connect();
  });

  afterAll(async () => {
    await lib?.close().catch(() => {});
  });

  it("listPeers filters by protocol and version (a leading v is ignored)", async () => {
    const all = await lib.listPeers("all", { protocol: "flow-proto" });
    expect(all.map((p) => p.name).sort()).toEqual(["raw-srv-a", "raw-srv-b"]);
    expect(all.find((p) => p.name === "raw-srv-a")?.protocols).toEqual([{ name: "flow-proto", version: "1.0.0", hash: srvA.hash }]);
    expect((await lib.listPeers("all", { protocol: "flow-proto", version: "v1.1.0" })).map((p) => p.name)).toEqual(["raw-srv-b"]);
    expect(await lib.listPeers("all", { protocol: "flow-proto", version: "9.9.9" })).toEqual([]);
    expect(await lib.listPeers("all", { protocol: "no-such" })).toEqual([]);
    // scope AND protocol
    expect(await lib.listPeers("host", { protocol: "flow-proto" })).toEqual([]);
    // no filter: every peer, as before
    expect((await lib.listPeers()).length).toBeGreaterThanOrEqual(2);
  });

  it("getProtocol: latest by default, a given version, and the not-found error", async () => {
    const latest = await lib.getProtocol("flow-proto");
    expect([latest.name, latest.version, latest.hash, latest.servers, latest.doc, latest.source, latest.ref]).toEqual([
      "flow-proto",
      "1.1.0",
      srvB.hash,
      1,
      "doc B",
      "github:raw/server",
      "v1.1.0",
    ]);
    expect((latest.manifest as { description: string }).description).toBe("raw");
    expect((await lib.getProtocol("flow-proto", "v1.0.0")).doc).toBe("doc A");
    await expect(lib.getProtocol("flow-proto", "7.7.7")).rejects.toMatchObject({ code: "PROTOCOL_NOT_FOUND" });
    await expect(lib.getProtocol("no-such")).rejects.toThrow(/^PROTOCOL_NOT_FOUND: /);
  });

  it("send(): meta reaches the receiver; a bad meta is INVALID_META and sends nothing", async () => {
    const r = await lib.send("raw-srv-a", "hello", "pull", { protocol: "flow-proto", version: "1.0.0" });
    expect(r.to_name).toBe("raw-srv-a");
    expect(r.warning).toBeUndefined();
    const polled = await raw<{ messages: { text: string; meta?: unknown }[] }>("/poll-messages", { id: srvA.id });
    expect(polled.messages.map((m) => [m.text, m.meta])).toEqual([["hello", { protocol: "flow-proto", version: "1.0.0" }]]);
    await expect(lib.send("raw-srv-a", "x", "pull", { protocol: "flow-proto" } as never)).rejects.toMatchObject({ code: "INVALID_META" });
    await lib.send("raw-srv-a", "plain");
    const plain = await raw<{ messages: { text: string; meta?: unknown }[] }>("/poll-messages", { id: srvA.id });
    expect(plain.messages.map((m) => [m.text, m.meta])).toEqual([["plain", undefined]]);
  });

  it("incoming meta is marked on the message handed to onMessage (not served here)", async () => {
    const got: InboundMessage[] = [];
    const off = lib.onMessage((m) => {
      got.push(m);
    });
    await raw("/send-message", { to: "lib-caller", from_id: srvA.id, from_name: "raw-srv-a", text: "tagged", meta: { protocol: "flow-proto", version: "1.0.0" } });
    expect(await until(() => got.length === 1, 5000)).toBe(true);
    expect(got[0].meta).toEqual({ protocol: "flow-proto", version: "1.0.0" });
    expect(got[0].protocol_line).toBe("Protocol: flow-proto@1.0.0 (not served here)");
    off();
  });

  it("setProtocol (local path): registered at the broker, visible to others, the old name is replaced", async () => {
    const d1 = repo("lib-p1", "1.0.0", "lib doc 1", "lib-proto");
    const info = await lib.setProtocol(d1);
    expect(info).toMatchObject({ name: "lib-proto", version: "1.0.0", source: `file:${d1}`, ref: "local" });
    expect(info.hash).toBe(protocolHash({ name: "lib-proto", version: "1.0.0", description: "flow 1.0.0", messages: { req: { type: "object" } } }, "lib doc 1"));
    const stored = await raw("/get-protocol", { name: "lib-proto" });
    expect(stored).toMatchObject({ ok: true, servers: 1, protocol: { version: "1.0.0", hash: info.hash } });
    const seen = await raw<{ name: string; protocols?: { name: string }[] }[]>("/list-peers", { scope: "all", cwd: "/", git_root: null, protocol: "lib-proto" });
    expect(seen.map((p) => p.name)).toEqual(["lib-caller"]);

    const info2 = await lib.setProtocol(repo("lib-p2", "2.0.0", "lib doc 2", "lib-proto"));
    expect(info2.version).toBe("2.0.0");
    expect(await raw("/get-protocol", { name: "lib-proto", version: "1.0.0" })).toMatchObject({ ok: false, code: "PROTOCOL_NOT_FOUND" });
  });

  it("setProtocol of a definition that differs from one held by another server is PROTOCOL_CONFLICT", async () => {
    const d = repo("conflict", "1.0.0", "different body");
    await expect(lib.setProtocol(d)).rejects.toMatchObject({ code: "PROTOCOL_CONFLICT" });
    // lib-proto@2.0.0 stays declared
    expect((await lib.getProtocol("lib-proto")).version).toBe("2.0.0");
  });

  it("mismatch: the incoming message is marked, and the reply carries the warning and this server's version", async () => {
    const got: InboundMessage[] = [];
    const off = lib.onMessage((m) => {
      got.push(m);
    });
    await raw("/send-message", { to: "lib-caller", from_id: srvA.id, from_name: "raw-srv-a", text: "old speaker", meta: { protocol: "lib-proto", version: "1.0.0" } });
    expect(await until(() => got.length === 1, 5000)).toBe(true);
    expect(got[0].protocol_line).toBe("Protocol: lib-proto@1.0.0 (this server: 2.0.0, mismatch)");
    off();

    const r = await lib.send("raw-srv-a", "my answer");
    const warning = "[agent-messenger warning] protocol version mismatch: you sent lib-proto@1.0.0, this server serves lib-proto@2.0.0";
    expect(r.warning).toBe(warning);
    const polled = await raw<{ messages: { text: string; meta?: unknown }[] }>("/poll-messages", { id: srvA.id });
    expect(polled.messages.map((m) => [m.text, m.meta])).toEqual([[`${warning}\nmy answer`, { protocol: "lib-proto", version: "2.0.0" }]]);
  });

  it("unsetProtocol: by name, then everything; both succeed when nothing is left", async () => {
    await lib.unsetProtocol("lib-proto");
    expect(await raw("/get-protocol", { name: "lib-proto" })).toMatchObject({ ok: false, code: "PROTOCOL_NOT_FOUND" });
    await lib.unsetProtocol();
    await lib.unsetProtocol("never-set");
    expect((await lib.listPeers("all", { protocol: "lib-proto" })).length).toBe(0);
  });
});

describe("library API as a server: re-sending definitions", () => {
  it("heartbeat resend: a restarted broker that lost the bodies gets them back", async () => {
    const p = await freePort();
    const state = join(dir, "resend-broker.json");
    let b = await startBroker(brokerEnv(p, state));
    const logs: string[] = [];
    const c = createMessengerClient({ env: envFor(p, "resend-srv", { AGENT_MESSENGER_HEARTBEAT_MS: "300" }), log: (m) => logs.push(m) });
    try {
      await c.connect();
      const info = await c.setProtocol(repo("rs1", "1.0.0", "resend doc", "resend-proto"));
      expect((await raw("/get-protocol", { name: "resend-proto" }, p)).ok).toBe(true);

      // broker restarts from its state file, which keeps the peer and its declaration but not the bodies
      await stop(b);
      const saved = JSON.parse(readFileSync(state, "utf8")) as Record<string, unknown>;
      expect(Array.isArray(saved.protocols)).toBe(true);
      delete saved.protocols;
      writeFileSync(state, JSON.stringify(saved));
      b = await startBroker(brokerEnv(p, state));
      expect(await until(async () => (await raw("/get-protocol", { name: "resend-proto" }, p)).ok === true, 8000)).toBe(true);
      expect(logs.some((m) => m === "Protocol resend-proto@1.0.0 re-sent to the broker")).toBe(true);
      expect((await raw("/get-protocol", { name: "resend-proto" }, p)).protocol.hash).toBe(info.hash);
    } finally {
      await c.close().catch(() => {});
      await stop(b);
    }
  });

  it("re-register: a broker that forgot the peer gets the declaration and the body again", async () => {
    const p = await freePort();
    let b = await startBroker(brokerEnv(p, join(dir, "rereg-broker-1.json")));
    const logs: string[] = [];
    const c = createMessengerClient({ env: envFor(p, "rereg-srv", { AGENT_MESSENGER_HEARTBEAT_MS: "300" }), log: (m) => logs.push(m) });
    try {
      await c.connect();
      const info = await c.setProtocol(repo("rr1", "1.0.0", "rereg doc", "rereg-proto"));
      const oldId = c.peer.id;
      // a new broker with an empty state on the same port
      await stop(b);
      b = await startBroker(brokerEnv(p, join(dir, "rereg-broker-2.json")));
      expect(await until(async () => (await raw("/get-protocol", { name: "rereg-proto" }, p)).ok === true, 10000)).toBe(true);
      expect(c.peer.id).not.toBe(oldId);
      const peers = await raw<{ name: string; protocols?: { name: string; hash: string }[] }[]>("/list-peers", { scope: "all", cwd: "/", git_root: null, protocol: "rereg-proto" }, p);
      expect(peers.map((x) => [x.name, x.protocols?.[0]?.hash])).toEqual([["rereg-srv", info.hash]]);
      expect(logs.some((m) => m.includes("re-registering"))).toBe(true);
    } finally {
      await c.close().catch(() => {});
      await stop(b);
    }
  });

  it("set_protocol that meets 'unknown peer' re-registers, re-sends what was declared, and then succeeds", async () => {
    const p = await freePort();
    const b = await startBroker(brokerEnv(p, join(dir, "unk-broker.json")));
    // no heartbeat within the test: only the explicit re-send after register can bring the first definition back
    const c = createMessengerClient({ env: envFor(p, "unk-srv", { AGENT_MESSENGER_HEARTBEAT_MS: "60000" }), log: () => {} });
    try {
      await c.connect();
      await c.setProtocol(repo("unk0", "1.0.0", "first doc", "unk-first"));
      const oldId = c.peer.id;
      await raw("/unregister", { id: oldId }, p); // the broker forgets us (and drops the definition nobody declares)
      expect(await raw("/get-protocol", { name: "unk-first" }, p)).toMatchObject({ ok: false, code: "PROTOCOL_NOT_FOUND" });
      const info = await c.setProtocol(repo("unk1", "1.0.0", "unk doc", "unk-proto"));
      expect(info.name).toBe("unk-proto");
      expect(c.peer.id).not.toBe(oldId);
      expect((await raw("/get-protocol", { name: "unk-proto" }, p)).servers).toBe(1);
      expect((await raw("/get-protocol", { name: "unk-first" }, p)).ok).toBe(true);
    } finally {
      await c.close().catch(() => {});
      await stop(b);
    }
  });
});

describe("a 0.9 broker (no protocol routes)", () => {
  let server: Server;
  let p: number;
  const seen: { path: string; body: any }[] = [];

  beforeAll(async () => {
    p = await freePort();
    server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (d: Buffer) => chunks.push(d));
      req.on("end", () => {
        const send = (code: number, obj: unknown) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(obj));
        };
        const url = req.url ?? "";
        if (req.method === "GET" && url === "/health") return send(200, { status: "ok", version: "0.9.0", id: "old", port: p, peers: 1 });
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        seen.push({ path: url, body });
        switch (url) {
          case "/register":
            return send(200, { id: "old-me" });
          case "/heartbeat":
            return send(200, { ok: true });
          case "/list-peers":
            return send(200, [{ id: "x", name: "old-peer", pid: 1, hostname: "h", cwd: "/", git_root: null, tty: null, summary: "", registered_at: "t", last_seen: "t" }]);
          case "/send-message":
            return send(200, { ok: true, to_id: "x", to_name: "old-peer", message_id: 1 });
          case "/poll-messages":
            return send(200, { messages: [] });
          case "/unregister":
            return send(200, { ok: true });
          default:
            return send(404, { error: "not found" });
        }
      });
    });
    await new Promise<void>((r) => server.listen(p, "127.0.0.1", () => r()));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("protocol calls say BROKER_UNSUPPORTED with the broker version; the old wire form is unchanged", async () => {
    const c = createMessengerClient({ env: envFor(p, "old-user", { AGENT_MESSENGER_HEARTBEAT_MS: "200" }), log: () => {} });
    try {
      await c.connect();
      const d = repo("old1", "1.0.0", "d", "old-proto");
      await expect(c.setProtocol(d)).rejects.toThrow(/^BROKER_UNSUPPORTED: .*version 0\.9\.0/);
      await expect(c.unsetProtocol()).rejects.toMatchObject({ code: "BROKER_UNSUPPORTED" });
      await expect(c.getProtocol("old-proto")).rejects.toMatchObject({ code: "BROKER_UNSUPPORTED" });
      // the broker ignores the unknown filter fields and returns every peer without `protocols`
      await expect(c.listPeers("all", { protocol: "old-proto" })).rejects.toMatchObject({ code: "BROKER_UNSUPPORTED" });
      expect((await c.listPeers("all")).map((x) => x.name)).toEqual(["old-peer"]);
      // meta is simply sent (an old broker drops it)
      await c.send("old-peer", "hi", "pull", { protocol: "p", version: "1" });
      expect(seen.filter((s) => s.path === "/send-message").pop()?.body.meta).toEqual({ protocol: "p", version: "1" });

      await sleep(700); // a few heartbeats
      expect(seen.some((s) => s.path === "/heartbeat")).toBe(true);
      for (const s of seen.filter((x) => x.path === "/heartbeat")) expect(s.body).toEqual({ id: "old-me" });
      expect("protocols" in seen.filter((x) => x.path === "/register")[0].body).toBe(false);
      // the unfiltered listPeers() keeps the old request
      expect("protocol" in seen.filter((x) => x.path === "/list-peers").pop()!.body).toBe(false);
    } finally {
      await c.close().catch(() => {});
    }
  });
});

describe("stdio clients over JSON-RPC", () => {
  it("tools/call: set_protocol, list_peers, get_protocol, channel notices with the Protocol line, check_messages, reply warning", async () => {
    const srv = await startClientProcess(envFor(port, "p-srv"));
    const caller = await startClientProcess(envFor(port, "p-caller"));
    try {
      await srv.initialize();
      await caller.initialize();

      const d = repo("stdio1", "1.2.0", "# stdio doc\nspeak JSON", "stdio-proto");
      const hash = protocolHash({ name: "stdio-proto", version: "1.2.0", description: "flow 1.2.0", messages: { req: { type: "object" } } }, "# stdio doc\nspeak JSON");
      const set = await srv.callTool("set_protocol", { repo: d });
      expect(set.content[0].text).toBe(`Protocol set: stdio-proto@1.2.0 (sha256 ${hash.slice(0, 8)}…, from file:${d})`);

      const lp = await caller.callTool("list_peers", { protocol: "stdio-proto", version: "v1.2.0" });
      expect(lp.content[0].text).toMatch(/^Found 1 peer\(s\) \(scope: all, protocol: stdio-proto, version: 1\.2\.0\):/);
      expect(lp.content[0].text).toContain("Name: p-srv");
      expect(lp.content[0].text).toContain("Protocol: stdio-proto@1.2.0");
      const none = await caller.callTool("list_peers", { protocol: "stdio-proto", version: "1.0.0" });
      expect(none.content[0].text).toBe('No server for protocol "stdio-proto" (version: 1.0.0).');

      const gp = await caller.callTool("get_protocol", { name: "stdio-proto" });
      expect(gp.content[0].text).toContain(`stdio-proto@1.2.0 (sha256 ${hash.slice(0, 8)}…, servers: 1)`);
      expect(gp.content[0].text).toContain("# stdio doc\nspeak JSON");

      const bad = await caller.callTool("send_message", { to: "p-srv", message: "x", meta: { protocol: "stdio-proto" } });
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toMatch(/^INVALID_META: /);

      // push: the channel content starts with the Protocol line
      await caller.callTool("send_message", { to: "p-srv", message: "pushed", delivery: "push", meta: { protocol: "stdio-proto", version: "1.1.0" } });
      await srv.waitFor(() => srv.notifications.length >= 1, 5000);
      const pushed = srv.notifications[0].params as { content: string };
      expect(pushed.content).toBe("Protocol: stdio-proto@1.1.0 (this server: 1.2.0, mismatch)\npushed");

      // pull: the unread notice carries the Protocol line of the latest message
      await caller.callTool("send_message", { to: "p-srv", message: "pulled", meta: { protocol: "stdio-proto", version: "1.2.0" } });
      await srv.waitFor(() => srv.notifications.length >= 2, 5000);
      const notice = (srv.notifications[1].params as { content: string }).content;
      expect(notice).toMatch(/^\[agent-messenger\] 未読 1 件（from p-caller@.*）。check_messages で受信してください\nProtocol: stdio-proto@1\.2\.0$/);

      const cm = await srv.callTool("check_messages", {});
      expect(cm.content[0].text).toMatch(/^1 message\(s\):\n\nFrom p-caller \(\w+\)@\S+ at .*:\nProtocol: stdio-proto@1\.2\.0\npulled$/s);

      // an old-version message arrives; the reply to its sender carries the warning
      await caller.callTool("send_message", { to: "p-srv", message: "old", delivery: "push", meta: { protocol: "stdio-proto", version: "1.0.0" } });
      await srv.waitFor(() => srv.notifications.length >= 3, 5000);
      const reply = await srv.callTool("send_message", { to: "p-caller", message: "answer" });
      const warning = "[agent-messenger warning] protocol version mismatch: you sent stdio-proto@1.0.0, this server serves stdio-proto@1.2.0";
      expect(reply.content[0].text).toMatch(new RegExp(`^Message sent to p-caller \\(\\w+\\) \\(delivery: pull\\)\\.\\n${warning.replace(/[[\]]/g, "\\$&")}$`));
      const back = await caller.callTool("check_messages", {});
      expect(back.content[0].text).toMatch(new RegExp(`:\\nProtocol: stdio-proto@1\\.2\\.0 \\(not served here\\)\\n${warning.replace(/[[\]]/g, "\\$&")}\\nanswer$`));

      const un = await srv.callTool("unset_protocol", { name: "stdio-proto" });
      expect(un.content[0].text).toBe("Protocol unset: stdio-proto");
      const gone = await caller.callTool("get_protocol", { name: "stdio-proto" });
      expect(gone.isError).toBe(true);
      expect(gone.content[0].text).toMatch(/^PROTOCOL_NOT_FOUND: /);
    } finally {
      await srv.close();
      await caller.close();
    }
  });
});

describe("stdio client: hash parity with the broker", () => {
  it("a definition full of escapes, control characters and non-ASCII is accepted (the broker re-computes the same hash)", async () => {
    const c = await startClientProcess(envFor(port, "p-hash"));
    try {
      await c.initialize();
      const d = join(dir, "tricky");
      mkdirSync(d, { recursive: true });
      const doc = "# 見出し\r\n\t\"quoted\" \\ back/slash <tag> & \u0001 \u001f \u007f     😀 é ｱ\n末尾";
      const manifest = {
        name: "tricky-proto",
        version: "1.0.0",
        description: "説明 \"q\" \\ \u0001 😀  ",
        messages: { "ключ": { type: "object", properties: { n: { type: "number", minimum: -1.5e-7, maximum: 12345678901234567890 } } }, "a\"b": { enum: ["é", "é", 0, 1.0, null, true] } },
      };
      writeFileSync(join(d, "protocol.json"), JSON.stringify(manifest, null, 2));
      writeFileSync(join(d, "PROTOCOL.md"), doc);
      const set = await c.callTool("set_protocol", { repo: d });
      expect(set.isError, set.content[0].text).toBeUndefined();
      expect(set.content[0].text).toMatch(/^Protocol set: tricky-proto@1\.0\.0 \(sha256 [0-9a-f]{8}…, from file:/);
      const stored = await raw("/get-protocol", { name: "tricky-proto" });
      expect(stored.ok).toBe(true);
      expect(stored.protocol.definition.doc).toBe(doc);
      expect(stored.protocol.hash).toBe(protocolHash(JSON.parse(JSON.stringify(manifest)), doc));
      await c.callTool("unset_protocol", {});
    } finally {
      await c.close();
    }
  });
});
