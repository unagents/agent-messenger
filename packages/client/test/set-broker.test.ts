/**
 * get_broker / set_broker at the library level, against in-memory brokers (no socket, no process).
 * The HTTP client is replaced through the `brokerClient` test seam; time is real but the loops are
 * stopped by closing the client.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrokerClient } from "../src/broker.js";
import { loadConfig } from "../src/config.js";
import { createMessengerClient } from "../src/messenger.js";
import type { MessengerClient } from "../src/messenger.js";
import { readSavedBroker } from "../src/saved-broker.js";

interface Stored {
  id: string;
  name: string;
  summary: string;
  protocols: unknown;
}

/** One in-memory broker: peers, queued messages, a call log. */
class FakeBroker {
  up = true;
  peers = new Map<string, Stored>();
  messages: { id: number; to: string; text: string; acked: boolean; delivered: boolean }[] = [];
  calls: string[] = [];
  rejectRegister = false;
  private seq = 0;
  constructor(
    readonly url: string,
    readonly id: string,
    readonly mesh = false,
    readonly version = "0.11.0"
  ) {}

  queue(to: string, text: string): number {
    const id = ++this.seq + 100;
    this.messages.push({ id, to, text, acked: false, delivered: false });
    return id;
  }

  health() {
    return this.up ? { status: "ok" as const, version: this.version, id: this.id, port: 7901, peers: this.peers.size, ...(this.mesh ? { mesh: true as const } : {}) } : null;
  }

  handle(path: string, body: any): any {
    if (!this.up) throw new Error("connection refused");
    this.calls.push(path);
    switch (path) {
      case "/register": {
        if (this.rejectRegister) throw new Error("Broker error (/register): 500 nope");
        const id = `${this.id}-p${this.peers.size + 1}`;
        this.peers.set(id, { id, name: body.name, summary: body.summary, protocols: body.protocols });
        return { id, ok: true };
      }
      case "/unregister":
        this.peers.delete(body.id);
        return { ok: true };
      case "/heartbeat":
        return this.peers.has(body.id) ? { ok: true } : { ok: false, error: "unknown peer" };
      case "/poll-messages": {
        const out = this.messages.filter((m) => m.to === body.id && !m.delivered && !m.acked);
        for (const m of out) m.delivered = true;
        return {
          messages: out.map((m) => ({ id: m.id, from_id: "other", from_name: "other", to_id: m.to, text: m.text, mode: "pull", sent_at: "2026-10-28T00:00:00Z", delivered: 1, acknowledged: 0 })),
        };
      }
      case "/get-buffered-messages":
        return { messages: [] };
      case "/acknowledge-messages":
        for (const m of this.messages) if (m.to === body.id && body.message_ids.includes(m.id)) m.acked = true;
        return { ok: true };
      case "/list-peers":
        return [...this.peers.values()].map((p) => ({ id: p.id, name: p.name, hostname: "h", pid: 1, cwd: "/", git_root: null, tty: null, summary: p.summary, registered_at: "", last_seen: "" }));
      case "/set-protocol":
        return { ok: true };
      default:
        return { ok: true };
    }
  }
}

function netClient(brokers: FakeBroker[]): BrokerClient {
  let url = "";
  const find = (u: string) => brokers.find((b) => b.url === u);
  return {
    setUrl: (u: string) => void (url = u.replace(/\/$/, "")),
    getUrl: () => url,
    async post(path: string, body: any) {
      const b = find(url);
      if (!b) throw new Error("broker not resolved");
      return b.handle(path, body);
    },
    async health(u = url) {
      return find(u)?.health() ?? null;
    },
  } as unknown as BrokerClient;
}

const dirs: string[] = [];
const clients: MessengerClient[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const A = () => new FakeBroker("http://10.0.0.1:7901", "A", true);
const B = () => new FakeBroker("http://10.0.0.2:7901", "B", true);

async function start(brokers: FakeBroker[], env: Record<string, string> = {}, opts: { brokers?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "am-setbroker-"));
  dirs.push(dir);
  const logs: string[] = [];
  const cfg = loadConfig({
    AGENT_MESSENGER_DISCOVERY: "off",
    AGENT_MESSENGER_CONFIG: join(dir, "config.json"),
    AGENT_MESSENGER_CLIENT_STATE: join(dir, "client.json"),
    AGENT_MESSENGER_GRACE_MS: "300",
    ...env,
  });
  const client = createMessengerClient({ config: cfg, log: (m) => logs.push(m), name: "alice", summary: "working", brokerClient: netClient(brokers), ...opts });
  clients.push(client);
  await client.connect();
  return { client, cfg, logs, dir };
}

describe("getBroker", () => {
  it("reports url, id, mesh, source and pin state", async () => {
    const [a, b] = [A(), B()];
    const { client } = await start([a, b], { AGENT_MESSENGER_HOST: "10.0.0.1" });
    expect(await client.getBroker()).toEqual({ url: a.url, id: "A", version: "0.11.0", mesh: true, source: "env", pinned: false, saved: null, discovered: [] });
  });

  it("a plain 0.10 broker is mesh: false", async () => {
    const a = new FakeBroker("http://10.0.0.1:7901", "old", false, "0.10.0");
    const { client } = await start([a], { AGENT_MESSENGER_HOST: "10.0.0.1" });
    expect(await client.getBroker()).toMatchObject({ id: "old", version: "0.10.0", mesh: false });
  });
});

describe("setBroker", () => {
  it("switches, keeps name / summary, pins over env, and leaves the old broker without us", async () => {
    const [a, b] = [A(), B()];
    const { client, logs } = await start([a, b], { AGENT_MESSENGER_HOST: "10.0.0.1" });
    const oldId = client.peer.id!;
    const info = await client.setBroker("10.0.0.2");
    expect(info).toMatchObject({ url: b.url, id: "B", mesh: true, source: "set_broker", pinned: true });
    expect(a.peers.has(oldId)).toBe(false);
    expect(client.peer.id).not.toBe(oldId);
    expect([...b.peers.values()]).toMatchObject([{ name: "alice", summary: "working" }]);
    expect(a.calls).toContain("/unregister");
    expect(logs.some((l) => l.includes(`broker=${b.url} (via set_broker)`))).toBe(true);
  });

  it("unread messages of the old broker stay readable and are never acknowledged on the new one", async () => {
    const [a, b] = [A(), B()];
    const { client } = await start([a, b], { AGENT_MESSENGER_HOST: "10.0.0.1" });
    const mid = a.queue(client.peer.id!, "left on A");
    await client.setBroker(b.url);
    // same numeric id on the other broker: must not be confused with the carried message
    const bMsg = b.queue(client.peer.id!, "arrived on B");
    expect(bMsg).toBe(mid);
    const got = await client.checkMessages();
    expect(got.map((m) => m.text)).toEqual(["left on A", "arrived on B"]);
    expect(a.messages.find((m) => m.id === mid)!.acked).toBe(true);
    expect(b.messages.find((m) => m.id === bMsg)!.acked).toBe(true);
    expect(await client.checkMessages()).toEqual([]);
  });

  it("an unreachable target changes nothing (BROKER_UNREACHABLE)", async () => {
    const [a, b] = [A(), B()];
    b.up = false;
    const { client } = await start([a, b], { AGENT_MESSENGER_HOST: "10.0.0.1" });
    const id = client.peer.id!;
    await expect(client.setBroker(b.url)).rejects.toThrow(`BROKER_UNREACHABLE: Broker ${b.url} is not reachable; still connected to ${a.url}`);
    expect(client.peer.id).toBe(id);
    expect(a.peers.has(id)).toBe(true);
    expect((await client.getBroker()).pinned).toBe(false);
  });

  it("a register failure goes back to the old broker (BROKER_SWITCH_FAILED)", async () => {
    const [a, b] = [A(), B()];
    b.rejectRegister = true;
    const { client } = await start([a, b], { AGENT_MESSENGER_HOST: "10.0.0.1" });
    await expect(client.setBroker(b.url)).rejects.toThrow(/^BROKER_SWITCH_FAILED: Could not register with http:\/\/10\.0\.0\.2:7901 \(.*nope.*\); back on http:\/\/10\.0\.0\.1:7901$/);
    const info = await client.getBroker();
    expect(info).toMatchObject({ url: a.url, pinned: false, source: "env" });
    expect(a.peers.has(client.peer.id!)).toBe(true);
    expect([...a.peers.values()][0]).toMatchObject({ name: "alice" });
  });

  it("an invalid URL is rejected before anything happens (INVALID_BROKER_URL)", async () => {
    const [a] = [A()];
    const { client } = await start([a], { AGENT_MESSENGER_HOST: "10.0.0.1" });
    await expect(client.setBroker("https://10.0.0.2")).rejects.toThrow("INVALID_BROKER_URL: Invalid broker URL: https://10.0.0.2");
    expect(a.calls.filter((c) => c === "/unregister")).toEqual([]);
  });

  it("persist writes client.json; set_broker() with persist removes it", async () => {
    const [a, b] = [A(), B()];
    const { client, cfg } = await start([a, b], { AGENT_MESSENGER_HOST: "10.0.0.1" });
    await client.setBroker(b.url, { persist: true });
    expect(readSavedBroker(cfg)).toBe(b.url);
    expect((await client.getBroker()).saved).toBe(b.url);
    expect(JSON.parse(readFileSync(cfg.clientFile, "utf8")).broker).toBe(b.url);
    await client.setBroker(undefined, { persist: true });
    expect(readSavedBroker(cfg)).toBeNull();
  });

  it("without url the pin is dropped and the broker is resolved again", async () => {
    const [a, b] = [A(), B()];
    const { client } = await start([a, b], { AGENT_MESSENGER_HOST: "10.0.0.1" });
    await client.setBroker(b.url);
    expect((await client.getBroker()).pinned).toBe(true);
    const info = await client.setBroker();
    expect(info).toMatchObject({ url: a.url, source: "env", pinned: false });
    expect([...a.peers.values()]).toMatchObject([{ name: "alice" }]);
    expect(b.peers.size).toBe(0);
  });

  it("the same URL only changes the pin / persist, nothing is re-registered", async () => {
    const [a] = [A()];
    const { client, cfg } = await start([a], { AGENT_MESSENGER_HOST: "10.0.0.1" });
    const id = client.peer.id;
    const info = await client.setBroker(a.url, { persist: true });
    expect(info).toMatchObject({ url: a.url, source: "set_broker", pinned: true, saved: a.url });
    expect(client.peer.id).toBe(id);
    expect(a.calls.filter((c) => c === "/register")).toHaveLength(1);
    expect(existsSync(cfg.clientFile)).toBe(true);
  });

  it("a SAVE_FAILED still leaves the switch done", async () => {
    const [a, b] = [A(), B()];
    const { client, dir } = await start([a, b], { AGENT_MESSENGER_HOST: "10.0.0.1", AGENT_MESSENGER_CLIENT_STATE: "/dev/null/client.json" });
    void dir;
    await expect(client.setBroker(b.url, { persist: true })).rejects.toThrow(/^SAVE_FAILED: Switched to http:\/\/10\.0\.0\.2:7901, but could not save it: /);
    expect((await client.getBroker()).url).toBe(b.url);
  });

  it("a second switch while one runs is BROKER_SWITCH_BUSY", async () => {
    const [a, b] = [A(), B()];
    const { client } = await start([a, b], { AGENT_MESSENGER_HOST: "10.0.0.1" });
    const first = client.setBroker(b.url);
    await expect(client.setBroker(a.url)).rejects.toThrow(/^BROKER_SWITCH_BUSY: Broker switch in progress; try again$/);
    await first;
  });

  it("works before connect: the choice is the first connection", async () => {
    const [a, b] = [A(), B()];
    const dir = mkdtempSync(join(tmpdir(), "am-setbroker-"));
    dirs.push(dir);
    const cfg = loadConfig({ AGENT_MESSENGER_DISCOVERY: "off", AGENT_MESSENGER_HOST: "10.0.0.1", AGENT_MESSENGER_CONFIG: join(dir, "c.json"), AGENT_MESSENGER_CLIENT_STATE: join(dir, "s.json") });
    const client = createMessengerClient({ config: cfg, log: () => {}, name: "alice", brokerClient: netClient([a, b]) });
    clients.push(client);
    await client.setBroker(b.url);
    await client.connect();
    expect(a.peers.size).toBe(0);
    expect(b.peers.size).toBe(1);
  });
});

describe("pin and failure", () => {
  it("a pinned broker that stays down past the grace period is given up; the next resolution wins", async () => {
    const [a, b] = [A(), B()];
    const { client, logs } = await start([a, b], { AGENT_MESSENGER_HOST: "10.0.0.1", AGENT_MESSENGER_HEARTBEAT_MS: "100" });
    await client.setBroker(b.url);
    b.up = false;
    const end = Date.now() + 8000;
    while (Date.now() < end && !(await client.getBroker()).url.startsWith(a.url)) await new Promise((r) => setTimeout(r, 100));
    const info = await client.getBroker();
    expect(info).toMatchObject({ url: a.url, pinned: false, source: "env" });
    expect(logs.some((l) => l.includes("pin dropped"))).toBe(true);
    // it does not hop back when B returns
    b.up = true;
    await new Promise((r) => setTimeout(r, 500));
    expect((await client.getBroker()).url).toBe(a.url);
  }, 15000);
});

describe("unread notices after a switch", () => {
  it("a carried message and a new message with the same numeric id both get a notice", async () => {
    const [a, b] = [A(), B()];
    const notices: { latest: string; count: number }[] = [];
    const dir = mkdtempSync(join(tmpdir(), "am-setbroker-"));
    dirs.push(dir);
    const cfg = loadConfig({ AGENT_MESSENGER_DISCOVERY: "off", AGENT_MESSENGER_HOST: "10.0.0.1", AGENT_MESSENGER_CONFIG: join(dir, "c.json"), AGENT_MESSENGER_CLIENT_STATE: join(dir, "s.json") });
    const notifier = {
      unread: async (latest: { text: string }, count: number) => (notices.push({ latest: latest.text, count }), true),
      ping: async () => {},
      push: async () => false,
    };
    const client = createMessengerClient({ config: cfg, log: () => {}, name: "alice", brokerClient: netClient([a, b]), notifier });
    clients.push(client);
    await client.connect();
    a.queue(client.peer.id!, "left on A");
    await client.setBroker(b.url);
    await new Promise((r) => setTimeout(r, 1300)); // the poll loop runs once per second
    expect(notices.at(-1)).toEqual({ latest: "left on A", count: 1 });
    b.queue(client.peer.id!, "arrived on B"); // same numeric id as the carried message
    await new Promise((r) => setTimeout(r, 1300));
    expect(notices.at(-1)).toEqual({ latest: "arrived on B", count: 2 });
  }, 10000);
});
