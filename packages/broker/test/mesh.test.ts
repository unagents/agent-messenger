import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Peer } from "@unagents/messenger-protocol";
import { startBroker, type BrokerHandle } from "../src/index.js";

const TOKEN = "mesh-token";
const INTERVAL = 80;

const dirs: string[] = [];
const brokers: BrokerHandle[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "messenger-mesh-"));
  dirs.push(d);
  return d;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function until<T>(fn: () => Promise<T | false | undefined> | T | false | undefined, what: string, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** POST on a fresh connection (a pooled keep-alive socket would point at a previous instance after a restart). */
function httpPost(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", agent: false, headers: { ...headers, "Content-Length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

interface Node {
  id: string;
  /** fixed mesh members handed to this broker (discovery is off in these tests) */
  members: string[];
  port: number;
  url: string;
  stateFile: string;
  handle: BrokerHandle | null;
  post: (path: string, body?: unknown, token?: string | null) => Promise<any>;
  /** register a peer and return its id */
  join: (name: string, pid: number) => Promise<string>;
  peers: (exclude?: string) => Promise<Peer[]>;
  stop: () => Promise<void>;
  start: () => Promise<void>;
}

/** A mesh (or plain, `mesh:false`) broker on a fixed loopback port; `members` is the fixed list of mesh URLs (`meshBrokers`, test-only). */
async function node(id: string, port: number, members: string[], opts: { mesh?: boolean } = {}): Promise<Node> {
  const stateFile = join(tmp(), "broker.json");
  const url = `http://127.0.0.1:${port}`;
  const n: Node = {
    id,
    members,
    port,
    url,
    stateFile,
    handle: null,
    async post(path, body = {}, token: string | null = TOKEN) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      return httpPost(`${url}${path}`, headers, JSON.stringify(body));
    },
    async join(name, pid) {
      const r = await n.post("/register", { pid, hostname: id, cwd: `/work/${id}`, name });
      return r.json.id as string;
    },
    async peers(exclude) {
      return (await n.post("/list-peers", { scope: "all", exclude_id: exclude })).json as Peer[];
    },
    async stop() {
      await n.handle?.close();
      brokers.splice(brokers.indexOf(n.handle!), 1);
      n.handle = null;
    },
    async start() {
      n.handle = await startBroker({
        port,
        bind: "127.0.0.1",
        token: TOKEN,
        id,
        stateFile,
        discovery: false,
        mesh: opts.mesh ?? true,
        meshIntervalMs: INTERVAL,
        meshBrokers: members,
      });
      brokers.push(n.handle);
    },
  };
  await n.start();
  return n;
}

/** Brokers that all list each other (and themselves) as fixed members. A spec may be `[id, {mesh:false}]`. */
async function meshNodes(specs: (string | [string, { mesh?: boolean }])[]): Promise<Node[]> {
  const ports = await Promise.all(specs.map(() => freePort()));
  const members = ports.map((p) => `http://127.0.0.1:${p}`);
  const out: Node[] = [];
  for (const [i, s] of specs.entries()) {
    const [id, o] = typeof s === "string" ? [s, {}] : s;
    out.push(await node(id, ports[i]!, members, o));
  }
  return out;
}

afterEach(async () => {
  while (brokers.length) await brokers.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("mesh: two permanent brokers on one host", () => {
  test("peers show up on both brokers; origin never leaks to clients", async () => {
    const [a, b] = (await meshNodes(["broker-a", "broker-b"])) as [Node, Node];

    const pa = await a.join("alice", 101);
    const pb = await b.join("bob", 202);

    const seenOnA = await until(async () => {
      const l = await a.peers(pa);
      return l.length === 1 && l;
    }, "bob visible on A");
    expect(seenOnA[0]).toMatchObject({ id: pb, name: "bob", hostname: "broker-b" });
    expect(seenOnA[0]).not.toHaveProperty("origin");
    const seenOnB = await until(async () => (await b.peers(pb)).length === 1 && (await b.peers(pb)), "alice visible on B");
    expect(seenOnB[0]).toMatchObject({ id: pa, name: "alice" });

    // scope filters work on replicated peers
    const host = await a.post("/list-peers", { scope: "host", hostname: "broker-b" });
    expect(host.json.map((p: Peer) => p.name)).toEqual(["bob"]);

    // unregister on B disappears from A
    await b.post("/unregister", { id: pb });
    await until(async () => (await a.peers(pa)).length === 0, "bob gone from A");
  });

  test("messages cross in both directions and are delivered once", async () => {
    const [a, b] = (await meshNodes(["broker-a", "broker-b"])) as [Node, Node];
    const pa = await a.join("alice", 101);
    const pb = await b.join("bob", 202);
    await until(async () => (await a.peers(pa)).length === 1, "bob visible on A");

    // alice (on A) -> bob (on B) by name
    const sent = await a.post("/send-message", { to: "bob", from_id: pa, from_name: "alice", text: "hi bob", mode: "push" });
    expect(sent.json).toMatchObject({ ok: true, to_id: pb, to_name: "bob" });
    const got = await until(async () => {
      const r = await b.post("/poll-messages", { id: pb });
      return r.json.messages.length ? (r.json.messages as Message[]) : false;
    }, "bob receives");
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ from_id: pa, from_name: "alice", text: "hi bob", mode: "push", to_id: pb });

    // bob answers to the sender id carried by the message
    await b.post("/acknowledge-messages", { id: pb, message_ids: [got[0].id] });
    await b.post("/send-message", { to: got[0].from_id, from_id: pb, from_name: "bob", text: "hi alice" });
    const back = await until(async () => {
      const r = await a.post("/poll-messages", { id: pa });
      return r.json.messages.length ? (r.json.messages as Message[]) : false;
    }, "alice receives");
    expect(back.map((m) => m.text)).toEqual(["hi alice"]);

    // nothing is left queued or redelivered on either side
    await new Promise((r) => setTimeout(r, INTERVAL * 4));
    expect((await b.post("/poll-messages", { id: pb })).json.messages).toEqual([]);
    expect((await a.post("/poll-messages", { id: pa })).json.messages).toEqual([]);
  });

  test("one side stopped: the other keeps working; after it returns everything resyncs", async () => {
    const [a, b] = (await meshNodes(["broker-a", "broker-b"])) as [Node, Node];
    const pa = await a.join("alice", 101);
    const pa2 = await a.join("carol", 103);
    const pb = await b.join("bob", 202);
    await until(async () => (await a.peers(pa)).length === 2, "bob + carol visible on A");

    await b.stop();

    // A keeps serving its own peers
    await a.post("/send-message", { to: "carol", from_id: pa, from_name: "alice", text: "local while B is down" });
    const local = await a.post("/poll-messages", { id: pa2 });
    expect(local.json.messages.map((m: Message) => m.text)).toEqual(["local while B is down"]);
    expect((await a.post("/heartbeat", { id: pa })).json).toEqual({ ok: true });

    // a message for bob (on the stopped broker) is accepted and queued, not lost
    const queued = await a.post("/send-message", { to: "bob", from_id: pa, from_name: "alice", text: "for bob, queued" });
    expect(queued.json).toMatchObject({ ok: true, to_id: pb });
    // ... and A's list still shows bob (replicas outlive a short outage)
    expect((await a.peers(pa)).map((p) => p.name).sort()).toEqual(["bob", "carol"]);

    // a new peer registers on A meanwhile
    const pnew = await a.join("dave", 104);

    await b.start(); // same port + same state file => bob keeps his id
    const got = await until(async () => {
      const r = await b.post("/poll-messages", { id: pb });
      return r.json.messages.length ? (r.json.messages as Message[]) : false;
    }, "queued message reaches bob after B returns");
    expect(got.map((m) => m.text)).toEqual(["for bob, queued"]);

    // peers synced again, including the one that appeared during the outage
    const names = await until(async () => {
      const l = (await b.peers(pb)).map((p) => p.name).sort();
      return l.includes("dave") && l;
    }, "B sees A's peers again");
    expect(names).toEqual(["alice", "carol", "dave"]);
    expect((await b.peers(pb)).find((p) => p.name === "dave")?.id).toBe(pnew);
  });

  test("B can also queue for A while A is down (symmetric)", async () => {
    const [a, b] = (await meshNodes(["broker-a", "broker-b"])) as [Node, Node];
    const pa = await a.join("alice", 101);
    const pb = await b.join("bob", 202);
    await until(async () => (await b.peers(pb)).length === 1, "alice visible on B");

    await a.stop();
    await b.post("/send-message", { to: "alice", from_id: pb, from_name: "bob", text: "while A is down" });
    await a.start();
    const got = await until(async () => {
      const r = await a.post("/poll-messages", { id: pa });
      return r.json.messages.length ? (r.json.messages as Message[]) : false;
    }, "alice receives after A returns");
    expect(got.map((m) => m.text)).toEqual(["while A is down"]);
  });

  test("replicas expire when the origin stays silent past the ttl", async () => {
    const [a, b] = (await meshNodes(["broker-a", "broker-b"])) as [Node, Node];
    const pa = await a.join("alice", 101);
    await b.join("bob", 202);
    await until(async () => (await a.peers(pa)).length === 1, "bob visible on A");
    await b.stop();
    await a.stop();
    // restart A with a tiny ttl: B never answers again
    a.handle = await startBroker({
      port: a.port,
      bind: "127.0.0.1",
      token: TOKEN,
      id: "broker-a",
      stateFile: a.stateFile,
      discovery: false,
      mesh: true,
      meshIntervalMs: INTERVAL,
      meshPeerTtlMs: 150,
      meshBrokers: a.members,
    });
    brokers.push(a.handle);
    await until(async () => (await a.peers()).length === 1, "alice (direct) still there");
    await until(async () => (await a.peers()).every((p) => p.name !== "bob"), "bob (replica) expired");
  });
});

describe("mesh: who takes part", () => {
  test("a broker without mesh (fallback / 0.6.x style) answers 404 and never receives peers", async () => {
    const [a, plain] = (await meshNodes(["broker-a", ["fallback", { mesh: false }]])) as [Node, Node];
    const pa = await a.join("alice", 101);
    await plain.join("local-only", 303);

    const r = await plain.post("/mesh/sync", { from: "broker-a", peers: [], messages: [] });
    expect(r.status).toBe(404);

    await new Promise((res) => setTimeout(res, INTERVAL * 5));
    expect((await plain.peers()).map((p) => p.name)).toEqual(["local-only"]);
    expect((await a.peers(pa)).map((p) => p.name)).toEqual([]);
  });

  test("a mesh broker that lists itself skips itself", async () => {
    const [a] = (await meshNodes(["broker-a"])) as [Node];
    const pa = await a.join("alice", 101);
    await new Promise((res) => setTimeout(res, INTERVAL * 4));
    expect((await a.peers()).map((p) => p.id)).toEqual([pa]);
  });

  test("/mesh/sync requires the token", async () => {
    const [a] = (await meshNodes(["broker-a"])) as [Node];
    const r = await a.post("/mesh/sync", { from: "x", peers: [], messages: [] }, null);
    expect(r.status).toBe(401);
    const bad = await a.post("/mesh/sync", { from: "x", peers: [], messages: [] }, "wrong");
    expect(bad.status).toBe(401);
  });

  test("a forwarded message that arrives twice is stored once", async () => {
    const [a] = (await meshNodes(["broker-a"])) as [Node];
    const pa = await a.join("alice", 101);
    const m: Message = { id: 7, from_id: "x1", from_name: "x", to_id: pa, text: "once", mode: "pull", sent_at: new Date().toISOString(), delivered: 0, acknowledged: 0 };
    const one = await a.post("/mesh/sync", { from: "other", peers: [], messages: [m] });
    const two = await a.post("/mesh/sync", { from: "other", peers: [], messages: [m] });
    expect(one.json.accepted).toEqual([7]);
    expect(two.json.accepted).toEqual([7]);
    const polled = await a.post("/poll-messages", { id: pa });
    expect(polled.json.messages.map((x: Message) => x.text)).toEqual(["once"]);
  });
});

describe("mesh: discovery (announce) instead of a member list", () => {
  /** Mac sandbox cannot bind UDP: this block runs on a host that can. Two brokers see each other only through `discoveryTargets`. */
  async function discovered(id: string, port: number, dport: number, targets: string[], token = TOKEN): Promise<{ post: Node["post"]; handle: BrokerHandle; port: number }> {
    const handle = await startBroker({
      port,
      bind: "127.0.0.1",
      token,
      id,
      stateFile: join(tmp(), "broker.json"),
      discovery: true,
      discoveryPort: dport,
      discoveryAddr: "127.0.0.1",
      discoveryTargets: targets,
      mesh: true,
      meshIntervalMs: INTERVAL,
      meshAnnounceMs: 150,
    });
    brokers.push(handle);
    const url = `http://127.0.0.1:${port}`;
    return {
      handle,
      port,
      post: (path, body = {}, tok: string | null = token) => {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (tok) headers.Authorization = `Bearer ${tok}`;
        return httpPost(`${url}${path}`, headers, JSON.stringify(body));
      },
    };
  }

  test("two brokers with the same token find each other; a different token is never a member", async () => {
    const [pa, pb, pc] = await Promise.all([freePort(), freePort(), freePort()]);
    const [da, db, dc] = await Promise.all([freePort(), freePort(), freePort()]);
    const targets = [da, db, dc].map((p) => `127.0.0.1:${p}`);
    const a = await discovered("broker-a", pa, da, targets);
    const b = await discovered("broker-b", pb, db, targets);
    const c = await discovered("broker-c", pc, dc, targets, "other-token");

    const alice = (await a.post("/register", { pid: 101, hostname: "a", cwd: "/a", name: "alice" })).json.id as string;
    const bob = (await b.post("/register", { pid: 202, hostname: "b", cwd: "/b", name: "bob" })).json.id as string;
    await until(async () => (await a.post("/list-peers", { scope: "all", exclude_id: alice })).json.length === 1, "bob visible on A through discovery");
    await until(async () => (await b.post("/list-peers", { scope: "all", exclude_id: bob })).json.length === 1, "alice visible on B");

    // C has another token: it neither joins A / B nor receives their peers
    await new Promise((r) => setTimeout(r, 600));
    expect((await c.post("/list-peers", { scope: "all" })).json).toEqual([]);
    expect((await a.post("/list-peers", { scope: "all" })).json.map((p: Peer) => p.name).sort()).toEqual(["alice", "bob"]);
    const health = await fetch(`http://127.0.0.1:${pa}/health`).then((r) => r.json() as Promise<any>);
    expect(health).toMatchObject({ status: "ok", mesh: true });
  });
});
