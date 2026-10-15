import { afterEach, describe, expect, test, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeBrokers } from "../src/discovery.js";
import { startBroker, type BrokerHandle } from "../src/index.js";

// Everything stays on loopback: discovery is pinned to 127.0.0.1 on ports 17915-17919 and never broadcasts to the LAN.
const ADDR = "127.0.0.1";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const dirs: string[] = [];
const brokers: BrokerHandle[] = [];
const servers: Server[] = [];

async function boot(dport: number, opts: Parameters<typeof startBroker>[0] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "messenger-fallback-"));
  dirs.push(dir);
  const b = await startBroker({
    port: 0,
    bind: "127.0.0.1",
    token: "",
    id: "b",
    stateFile: join(dir, "broker.json"),
    discovery: true,
    discoveryPort: dport,
    discoveryAddr: ADDR,
    fallbackIntervalMs: 150,
    ...opts,
  });
  brokers.push(b);
  const url = `http://127.0.0.1:${b.port}`;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return res.json() as Promise<any>;
  };
  const alive = () => fetch(`${url}/health`).then((r) => r.ok, () => false);
  return { b, url, post, alive };
}

async function until(pred: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(50);
  }
  return pred();
}

const peer = (name: string) => ({ pid: Math.floor(Math.random() * 1e6), hostname: "h1", cwd: "/w", name });

afterEach(async () => {
  while (brokers.length) await brokers.pop()!.close();
  while (servers.length) servers.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("fallback broker", () => {
  test("relays undelivered messages to the broker it discovers, then exits itself", async () => {
    const onSupersede = vi.fn();
    // the fallback binds the discovery port first; the permanent broker, bound last, receives the unicast probes
    const fb = await boot(17915, { fallback: true, onSupersede });
    const alice = (await fb.post("/register", peer("alice"))).id as string;
    const anon = (await fb.post("/register", { ...peer(""), pid: 4242 })).id as string;
    const sender = (await fb.post("/register", peer("sender"))).id as string;
    await fb.post("/send-message", { to: alice, from_id: sender, from_name: "sender", text: "hello alice", mode: "push" });
    await fb.post("/send-message", { to: anon, from_id: sender, from_name: "sender", text: "nobody home" });

    await sleep(600); // no other broker yet: stays up
    expect(onSupersede).not.toHaveBeenCalled();
    expect(await fb.alive()).toBe(true);

    const perm = await boot(17915);
    expect(await until(() => onSupersede.mock.calls.length > 0)).toBe(true);
    expect(onSupersede).toHaveBeenCalledWith(perm.url);
    expect(await fb.alive()).toBe(false);

    // alice's client moves over later and registers under the same name: the relayed message is waiting
    const alice2 = (await perm.post("/register", peer("alice"))).id as string;
    const polled = await perm.post("/poll-messages", { id: alice2 });
    expect(polled.messages).toHaveLength(1);
    expect(polled.messages[0]).toMatchObject({ from_name: "sender", text: "hello alice", mode: "push", to_id: alice2 });
  });

  test("a permanent broker never goes looking for another broker", async () => {
    const onSupersede = vi.fn();
    const perm = await boot(17916, { fallback: false, onSupersede });
    await boot(17916);
    await sleep(700);
    expect(onSupersede).not.toHaveBeenCalled();
    expect(await perm.alive()).toBe(true);
  });

  test("two fallbacks do not relay into each other", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const fa = await boot(17917, { fallback: true, onSupersede: a });
    const fb = await boot(17917, { fallback: true, onSupersede: b });
    await sleep(700);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(await fa.alive()).toBe(true);
    expect(await fb.alive()).toBe(true);
  });

  test("reports fallback in /health and in the discovery reply, and only then", async () => {
    const fb = await boot(17918, { fallback: true });
    expect(await fetch(`${fb.url}/health`).then((r) => r.json())).toMatchObject({ status: "ok", fallback: true });
    const found = await probeBrokers({ port: 17918, addr: ADDR, timeoutMs: 300 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ port: fb.b.port, fallback: true });
    const perm = await boot(17919);
    expect(await fetch(`${perm.url}/health`).then((r) => r.json())).not.toHaveProperty("fallback");
    const f2 = await probeBrokers({ port: 17919, addr: ADDR, timeoutMs: 300 });
    expect(f2[0]).toMatchObject({ port: perm.b.port, fallback: false });
  });

  test("keeps running and retries when the discovered broker refuses the relay", async () => {
    const onSupersede = vi.fn();
    let hits = 0;
    const stub = createServer((req, res) => {
      hits++;
      res.statusCode = 500;
      res.end("boom");
    });
    servers.push(stub);
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    const stubPort = (stub.address() as { port: number }).port;
    // the stub answers discovery like a broker would
    const { createSocket } = await import("node:dgram");
    const udp = createSocket({ type: "udp4", reuseAddr: true });
    udp.on("message", (_m, r) => udp.send(JSON.stringify({ "agent-messenger": "broker", id: "stub", port: stubPort, version: "x" }), r.port, r.address));
    try {
      // the fallback binds first; the stub, bound last, receives the unicast probes
      const fb = await boot(17915, { fallback: true, onSupersede });
      await new Promise<void>((r) => udp.bind(17915, ADDR, r));
      const alice = (await fb.post("/register", peer("alice"))).id as string;
      await fb.post("/send-message", { to: alice, text: "keep me" });
      expect(await until(() => hits >= 2)).toBe(true); // retried
      expect(onSupersede).not.toHaveBeenCalled();
      expect(await fb.alive()).toBe(true);
      const again = await fb.post("/poll-messages", { id: alice });
      expect(again.messages).toHaveLength(1); // still ours
    } finally {
      udp.close();
    }
  });

  test("a target without /relay-messages gets /send-message by name", async () => {
    const got: string[] = [];
    const stub = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/relay-messages") {
          res.statusCode = 404;
          res.end('{"error":"not found"}');
        } else {
          got.push(`${req.url} ${body}`);
          res.end('{"ok":true,"to_id":"x","to_name":"alice","message_id":1}');
        }
      });
    });
    servers.push(stub);
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    const { relayUndelivered } = await import("../src/relay.js");
    const { BrokerState } = await import("../src/state.js");
    const dir = mkdtempSync(join(tmpdir(), "messenger-fallback-"));
    dirs.push(dir);
    const st = new BrokerState(join(dir, "s.json"));
    st.peers.set("p1", { id: "p1", name: "alice", pid: 1, hostname: "h", cwd: "/", git_root: null, tty: null, summary: "", registered_at: "", last_seen: "" });
    st.messages.push({ id: 1, from_id: "s", from_name: "S", to_id: "p1", text: "t", mode: "pull", sent_at: "2026-01-01T00:00:00.000Z", delivered: 0, acknowledged: 0 });
    const r = await relayUndelivered(st, `http://127.0.0.1:${(stub.address() as { port: number }).port}`, "");
    expect(r).toEqual({ sent: 1, dropped: 0 });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatch(/^\/send-message .*"to":"alice".*"text":"t"/);
    expect(st.messages).toHaveLength(0);
  });
});

describe("/relay-messages", () => {
  test("delivers to a registered peer, queues for an unknown name until it registers or is renamed, drops nameless", async () => {
    const t = await boot(17919, { discovery: false });
    const bob = (await t.post("/register", peer("bob"))).id as string;
    const item = (to_name: string, text: string) => ({ from_id: "x", from_name: "X", to_name, to_hostname: "h1", text, sent_at: "2026-01-01T00:00:00.000Z" });
    const r = await t.post("/relay-messages", { messages: [item("bob", "to bob"), item("carol", "to carol"), item("", "nameless"), item("dave", "to dave")] });
    expect(r).toEqual({ ok: true, delivered: 1, queued: 2, dropped: 1 });
    expect((await t.post("/poll-messages", { id: bob })).messages.map((m: any) => m.text)).toEqual(["to bob"]);

    const carol = (await t.post("/register", peer("carol"))).id as string;
    expect((await t.post("/poll-messages", { id: carol })).messages.map((m: any) => m.text)).toEqual(["to carol"]);

    const other = (await t.post("/register", peer(""))).id as string; // gets its name later
    await t.post("/set-name", { id: other, name: "dave" });
    expect((await t.post("/poll-messages", { id: other })).messages.map((m: any) => m.text)).toEqual(["to dave"]);
    expect((await t.post("/poll-messages", { id: carol })).messages).toEqual([]); // delivered once only
  });
});
