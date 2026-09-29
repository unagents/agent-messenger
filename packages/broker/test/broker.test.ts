import { afterEach, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DISCOVERY_PROBE, type DiscoveryReply, type Peer } from "@agent-hand/messenger-protocol";
import { startBroker, VERSION, type BrokerHandle, type BrokerStateFile } from "../src/index.js";

const TOKEN = "test-token";
const OLD_CLI = resolve(fileURLToPath(new URL("../../../legacy/bin/agent-messenger.js", import.meta.url)));

const dirs: string[] = [];
const brokers: BrokerHandle[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "messenger-broker-"));
  dirs.push(d);
  return d;
}

async function boot(opts: Parameters<typeof startBroker>[0] = {}) {
  const b = await startBroker({
    port: 0,
    bind: "127.0.0.1",
    token: TOKEN,
    id: "test-broker",
    stateFile: join(tmp(), "broker.json"),
    discovery: false,
    ...opts,
  });
  brokers.push(b);
  const url = `http://127.0.0.1:${b.port}`;
  const post = async (path: string, body: unknown, token: string | null = TOKEN) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    return res.json() as Promise<any>;
  };
  return { b, url, post };
}

afterEach(async () => {
  while (brokers.length) await brokers.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("http", () => {
  test("GET /health has the current shape", async () => {
    const { b, url } = await boot();
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ status: "ok", version: VERSION, id: "test-broker", port: b.port, peers: 0 });
  });

  test("non-POST returns the text banner; unknown POST is 404; bad JSON is 500", async () => {
    const { url } = await boot();
    const get = await fetch(`${url}/register`);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("text/plain");
    expect(await get.text()).toBe(`agent-messenger broker ${VERSION}\n`);

    const nf = await fetch(`${url}/nope`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: "{}" });
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: "not found" });

    const bad = await fetch(`${url}/register`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: "{" });
    expect(bad.status).toBe(500);
    expect(await bad.json()).toHaveProperty("error");

    const empty = await fetch(`${url}/list-peers`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);
  });

  test("auth: POST without token is rejected", async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/list-peers`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("register, name resolution, send/poll/buffered/ack, unregister", async () => {
    const { post } = await boot();
    const a = await post("/register", { pid: 1, hostname: "hostA", cwd: "/a", name: "alpha" });
    const b = await post("/register", { pid: 2, hostname: "hostB", cwd: "/b", name: "" });
    expect(a.id).toMatch(/^[a-z0-9]{8}$/);
    expect(b.id).toMatch(/^[a-z0-9]{8}$/);

    const peers = await post("/list-peers", { scope: "all", cwd: "/", git_root: null });
    expect(peers).toHaveLength(2);

    const sent = await post("/send-message", { from_id: b.id, to: "alpha", text: "hi alpha" });
    expect(sent).toEqual({ ok: true, to_id: a.id, to_name: "alpha", message_id: 1 });

    const missing = await post("/send-message", { from_id: b.id, to: "nobody", text: "x" });
    expect(missing.ok).toBe(false);

    const polled = await post("/poll-messages", { id: a.id });
    expect(polled.messages).toHaveLength(1);
    expect(polled.messages[0]).toMatchObject({ id: 1, from_id: b.id, to_id: a.id, text: "hi alpha", delivered: 1, acknowledged: 0 });

    const again = await post("/poll-messages", { id: a.id });
    expect(again.messages).toHaveLength(0);

    const buffered = await post("/get-buffered-messages", { id: a.id });
    expect(buffered.messages).toHaveLength(1);

    expect(await post("/acknowledge-messages", { id: a.id, message_ids: [polled.messages[0].id] })).toEqual({ ok: true });
    const afterAck = await post("/get-buffered-messages", { id: a.id });
    expect(afterAck.messages).toHaveLength(0);

    // per-message mode: default pull, push kept, ping keeps its subject text, unknown rejected
    await post("/send-message", { from_id: b.id, to: "alpha", text: "p" });
    await post("/send-message", { from_id: b.id, to: "alpha", text: "q", mode: "push" });
    await post("/send-message", { from_id: b.id, to: "alpha", text: "task-42", mode: "ping" });
    const bad = await post("/send-message", { from_id: b.id, to: "alpha", text: "x", mode: "loud" });
    expect(bad).toEqual({ ok: false, error: "invalid mode: loud" });
    const modes = await post("/poll-messages", { id: a.id });
    expect(modes.messages.map((m: { mode: string; text: string }) => [m.mode, m.text])).toEqual([["pull", "p"], ["push", "q"], ["ping", "task-42"]]);
    await post("/acknowledge-messages", { id: a.id, message_ids: modes.messages.map((m: { id: number }) => m.id) });

    expect(await post("/set-name", { id: b.id, name: "beta" })).toEqual({ ok: true });
    expect(await post("/set-summary", { id: b.id, summary: "working" })).toEqual({ ok: true });
    const [beta] = (await post("/list-peers", { scope: "host", hostname: "hostB" })) as Peer[];
    expect(beta).toMatchObject({ id: b.id, name: "beta", summary: "working" });

    expect(await post("/unregister", { id: a.id })).toEqual({ ok: true });
    expect(await post("/unregister", { id: b.id })).toEqual({ ok: true });
    expect(await post("/list-peers", { scope: "all" })).toEqual([]);
  });

  test("heartbeat keeps a peer; unknown peer gets ok:false", async () => {
    const { post } = await boot();
    const a = await post("/register", { pid: 1, hostname: "h", cwd: "/" });
    expect(await post("/heartbeat", { id: a.id })).toEqual({ ok: true });
    expect(await post("/heartbeat", { id: "zzzzzzzz" })).toEqual({ ok: false, error: "unknown peer (re-register)" });
  });
});

describe("state file", () => {
  test("peers are restored after a restart", async () => {
    const stateFile = join(tmp(), "broker.json");
    const first = await boot({ stateFile });
    const a = await first.post("/register", { pid: 1, hostname: "h", cwd: "/w", name: "alpha" });
    await first.post("/send-message", { from_id: "cli", to: "alpha", text: "kept" });
    await first.b.close();

    const raw = JSON.parse(readFileSync(stateFile, "utf8")) as BrokerStateFile;
    expect(raw.peers.map((p) => p.id)).toEqual([a.id]);
    expect(raw.messages).toHaveLength(1);
    expect(raw.nextMsgId).toBe(2);

    const second = await boot({ stateFile });
    const peers = (await second.post("/list-peers", { scope: "all" })) as Peer[];
    expect(peers.map((p) => p.id)).toEqual([a.id]);
    expect(await second.post("/heartbeat", { id: a.id })).toEqual({ ok: true });
    const polled = await second.post("/poll-messages", { id: a.id });
    expect(polled.messages.map((m: { text: string }) => m.text)).toEqual(["kept"]);
  });

  test("expired peer: heartbeat says ok:false after restart, re-register works", async () => {
    const stateFile = join(tmp(), "broker.json");
    const stale: BrokerStateFile = {
      peers: [
        {
          id: "stale001",
          name: "old",
          pid: 42,
          hostname: "h",
          cwd: "/w",
          git_root: null,
          tty: null,
          summary: "",
          registered_at: "2026-01-01T00:00:00.000Z",
          last_seen: new Date(Date.now() - 61_000).toISOString(),
        },
      ],
      messages: [],
      nextMsgId: 1,
    };
    writeFileSync(stateFile, JSON.stringify(stale, null, 1));

    const { post } = await boot({ stateFile });
    expect(await post("/list-peers", { scope: "all" })).toEqual([]);
    expect(await post("/heartbeat", { id: "stale001" })).toEqual({ ok: false, error: "unknown peer (re-register)" });
    const fresh = await post("/register", { pid: 42, hostname: "h", cwd: "/w", name: "old" });
    expect(fresh.id).not.toBe("stale001");
    expect(await post("/heartbeat", { id: fresh.id })).toEqual({ ok: true });
  });

  test("reads a file written by core 0.4.0 (indent 1, same keys)", async () => {
    const stateFile = join(tmp(), "broker.json");
    const now = new Date().toISOString();
    const legacy: BrokerStateFile = {
      peers: [
        { id: "abcd1234", name: "cap", pid: 7, hostname: "mac", cwd: "/repo", git_root: "/repo", tty: "/dev/ttys001", summary: "s", registered_at: now, last_seen: now },
      ],
      messages: [
        { id: 5, from_id: "cli", from_name: "cli", to_id: "abcd1234", text: "pending", sent_at: now, delivered: 0, acknowledged: 0 },
      ],
      nextMsgId: 6,
    };
    writeFileSync(stateFile, JSON.stringify(legacy, null, 1));

    const { post } = await boot({ stateFile });
    expect((await post("/list-peers", { scope: "repo", git_root: "/repo" })).map((p: Peer) => p.id)).toEqual(["abcd1234"]);
    const polled = await post("/poll-messages", { id: "abcd1234" });
    expect(polled.messages.map((m: { id: number }) => m.id)).toEqual([5]);
    const sent = await post("/send-message", { to: "cap", text: "next" });
    expect(sent.message_id).toBe(6);
  });
});

describe("udp discovery", () => {
  test("probe on loopback gets a reply", async () => {
    const discoveryPort = 17902 + Math.floor(Math.random() * 1000);
    const { b } = await boot({ discovery: true, discoveryPort, discoveryAddr: "127.0.0.1" });

    const sock = createSocket("udp4");
    const reply = new Promise<DiscoveryReply>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no discovery reply")), 3000);
      sock.once("message", (msg) => {
        clearTimeout(t);
        resolve(JSON.parse(msg.toString()));
      });
    });
    await new Promise<void>((r) => sock.bind(0, "127.0.0.1", r));
    sock.send(Buffer.from(JSON.stringify(DISCOVERY_PROBE)), discoveryPort, "127.0.0.1");
    try {
      expect(await reply).toEqual({ "agent-messenger": "broker", id: "test-broker", port: b.port, version: VERSION });
    } finally {
      sock.close();
    }
  });
});

describe("compat", () => {
  test("core 0.4.0 CLI `peers` talks to the new broker", async () => {
    const { b, post } = await boot();
    const a = await post("/register", { pid: 99, hostname: "legacy-host", cwd: "/legacy", name: "legacy" });

    const env = { ...process.env };
    delete env.AGENT_MESSENGER_CONFIG;
    delete env.AGENT_MESSENGER_DISCOVERY;
    const { stdout } = await promisify(execFile)(process.execPath, [OLD_CLI, "peers"], {
      env: { ...env, AGENT_MESSENGER_HOST: "127.0.0.1", AGENT_MESSENGER_PORT: String(b.port), AGENT_MESSENGER_TOKEN: TOKEN },
    });
    expect(stdout).toContain(`${a.id}  legacy  legacy-host  PID:99  /legacy`);
  });
});
