/**
 * Library API (createMessengerClient) against a loopback broker (child process).
 *
 * Isolation: broker and client bind / use 127.0.0.1 on a port from 17944-17949 only. Discovery and
 * fallback are off, autoStartBroker stays off, HOME / config / state live in a temp dir, and the env is
 * built from baseEnv() (no CLAUDE_CODE_MESSAGING_*, no AGENT_MESSENGER_*). 7901 / 7902 are never used.
 * One library client per process: the broker drops an earlier peer with the same pid + hostname.
 */
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect as netConnect, createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InboundMessage } from "../src/inbox.js";
import { createMessengerClient } from "../src/messenger.js";
import type { MessengerClient } from "../src/messenger.js";
import { baseEnv, sleep, startBroker } from "./helpers.js";

const TOKEN = "lib-test-token";
const PORTS = [17944, 17945, 17946, 17947, 17948, 17949];

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

async function freePorts(n: number): Promise<number[]> {
  const out: number[] = [];
  for (const p of PORTS) {
    if (out.length === n) break;
    if (await canListen(p)) out.push(p);
  }
  if (out.length < n) throw new Error("no free port in 17944-17949");
  return out;
}

async function until(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(100);
  }
  return pred();
}

/** TCP proxy to the broker that can hold GET /health requests (to freeze a re-resolution mid-flight). */
function healthHoldingProxy(listenPort: number, targetPort: number) {
  const state = { hold: false, held: 0, release: () => {} };
  let gate: Promise<void> = Promise.resolve();
  let open = () => {};
  const arm = () => {
    gate = new Promise<void>((r) => (open = r));
    state.release = () => open();
  };
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.once("data", async (first) => {
      if (state.hold && first.toString().startsWith("GET /health")) {
        state.held++;
        await gate;
      }
      const up = netConnect(targetPort, "127.0.0.1");
      sockets.add(up);
      up.on("close", () => sockets.delete(up));
      up.on("error", () => client.destroy());
      client.on("error", () => up.destroy());
      up.write(first);
      client.pipe(up);
      up.pipe(client);
    });
    client.on("error", () => {});
  });
  return {
    state,
    arm,
    listen: () => new Promise<void>((r) => server.listen(listenPort, "127.0.0.1", () => r())),
    stop: () => {
      for (const k of sockets) k.destroy();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

let dir: string;
let port: number;
let spare: number;
let proxyPort: number;
let broker: ChildProcess;
let origHome: string | undefined;
let fakeB: string;
const logs: string[] = [];
let a: MessengerClient;

function libEnv(p: number, name: string): Record<string, string | undefined> {
  return {
    ...baseEnv(),
    HOME: dir,
    AGENT_MESSENGER_HOST: "127.0.0.1",
    AGENT_MESSENGER_PORT: String(p),
    AGENT_MESSENGER_TOKEN: TOKEN,
    AGENT_MESSENGER_DISCOVERY: "off",
    AGENT_MESSENGER_CONFIG: join(dir, "no-config.json"),
    AGENT_MESSENGER_NAME: name,
  };
}

async function raw<T = any>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return (await r.json()) as T;
}

const peersNow = () => raw<{ id: string; name: string; summary: string }[]>("/list-peers", { scope: "all", cwd: "/" });
const buffered = (id: string) => raw<{ messages: { id: number; text: string; mode: string }[] }>("/get-buffered-messages", { id });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "am-lib-"));
  origHome = process.env.HOME;
  process.env.HOME = dir;
  [port, spare, proxyPort] = await freePorts(3);
  broker = await startBroker({
    ...baseEnv(),
    HOME: dir,
    AGENT_MESSENGER_PORT: String(port),
    AGENT_MESSENGER_BIND: "127.0.0.1",
    AGENT_MESSENGER_TOKEN: TOKEN,
    AGENT_MESSENGER_STATE: join(dir, "broker.json"),
    AGENT_MESSENGER_DISCOVERY: "off",
    AGENT_MESSENGER_CONFIG: join(dir, "no-config.json"),
  });
  const reg = await raw<{ id: string }>("/register", {
    pid: 99999,
    hostname: "fake-host",
    cwd: "/",
    git_root: null,
    tty: null,
    summary: "",
    name: "fake-b",
  });
  fakeB = reg.id;
});

afterAll(async () => {
  await a?.close().catch(() => {});
  if (broker && broker.exitCode === null) {
    await new Promise<void>((resolve) => {
      broker.once("exit", () => resolve());
      broker.kill("SIGTERM");
    });
  }
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("createMessengerClient", () => {
  it("connect(): resolves via env, registers, no delivery= line without a notifier", async () => {
    a = createMessengerClient({ env: libEnv(port, "lib-a"), log: (m) => logs.push(m) });
    expect(a.peer.id).toBeNull();
    await a.connect();
    await a.connect(); // idempotent
    const text = logs.join("\n");
    expect(text).toContain(`broker=http://127.0.0.1:${port} (local, via env)`);
    expect(text).toContain("Registered as peer");
    expect(text).not.toMatch(/delivery=/);
    expect(logs.filter((m) => m.startsWith("Registered as peer"))).toHaveLength(1);
    expect((await peersNow()).map((p) => p.name)).toContain("lib-a");
  });

  it("setName / setSummary / listPeers", async () => {
    await a.setName("lib-a2");
    await a.setSummary("s");
    const mine = (await peersNow()).find((p) => p.id === a.peer.id);
    expect(mine?.name).toBe("lib-a2");
    expect(mine?.summary).toBe("s");
    expect((await a.listPeers()).map((p) => p.name)).toContain("fake-b");
  });

  it("send(): pull message reaches the peer; invalid delivery rejects", async () => {
    const r = await a.send("fake-b", "hello");
    expect(r.to_name).toBe("fake-b");
    const polled = await raw<{ messages: { text: string; mode: string }[] }>("/poll-messages", { id: fakeB });
    expect(polled.messages.map((m) => [m.text, m.mode])).toEqual([["hello", "pull"]]);
    await expect(a.send("fake-b", "x", "loud" as never)).rejects.toThrow("Invalid delivery: loud");
    await expect(a.send("nobody-here", "x")).rejects.toThrow(/^Failed to send:/);
  });

  it("onMessage(): handler gets the message, then it is acknowledged", async () => {
    const got: InboundMessage[] = [];
    const off = a.onMessage((m) => {
      got.push(m);
    });
    await raw("/send-message", { to: "lib-a2", from_id: "cli", from_name: "tester", text: "in1" });
    expect(await until(() => got.length === 1, 5000)).toBe(true);
    expect(got[0].text).toBe("in1");
    expect(await until(async () => (await buffered(a.peer.id as string)).messages.length === 0, 5000)).toBe(true);
    off();
  });

  it("onMessage(): a failing handler is retried with the same id until it succeeds", async () => {
    const ids: number[] = [];
    let calls = 0;
    const off = a.onMessage((m) => {
      ids.push(m.id);
      calls++;
      if (calls === 1) throw new Error("first attempt fails");
    });
    await raw("/send-message", { to: "lib-a2", from_id: "cli", from_name: "tester", text: "in2" });
    expect(await until(() => ids.length >= 2, 8000)).toBe(true);
    expect(ids[0]).toBe(ids[1]);
    expect(await until(async () => (await buffered(a.peer.id as string)).messages.length === 0, 5000)).toBe(true);
    expect(logs.some((m) => m.includes("Message handler failed for"))).toBe(true);
    off();
  });

  it("checkMessages() without a handler returns the message once", async () => {
    await raw("/send-message", { to: "lib-a2", from_id: "cli", from_name: "tester", text: "in3" });
    expect(await until(async () => (await buffered(a.peer.id as string)).messages.length === 1, 5000)).toBe(true);
    const first = await a.checkMessages();
    expect(first.map((m) => m.text)).toEqual(["in3"]);
    expect(await a.checkMessages()).toEqual([]);
  });

  it("onMessage(): ping is delivered with mode ping and acknowledged", async () => {
    const got: InboundMessage[] = [];
    const off = a.onMessage((m) => {
      got.push(m);
    });
    await raw("/send-message", { to: "lib-a2", from_id: "cli", from_name: "tester", text: "subj", mode: "ping" });
    expect(await until(() => got.length === 1, 5000)).toBe(true);
    expect(got[0].mode).toBe("ping");
    expect(await until(async () => (await buffered(a.peer.id as string)).messages.length === 0, 5000)).toBe(true);
    off();
  });

  it("close(): unregisters, is idempotent, does not exit the process", async () => {
    await a.close();
    expect(logs).toContain("Unregistered from broker");
    expect((await peersNow()).map((p) => p.id)).not.toContain(a.peer.id);
    await a.close();
  });

  it("close() right after connect() starts (no await) leaves no peer and no timers behind", async () => {
    const blogs: string[] = [];
    const b = createMessengerClient({ env: libEnv(port, "lib-b"), log: (m) => blogs.push(m) });
    const c = b.connect();
    const cl = b.close();
    await Promise.allSettled([c, cl]);
    await sleep(2500);
    expect((await peersNow()).map((p) => p.name)).not.toContain("lib-b");
    expect(blogs.some((m) => m.includes("Poll error"))).toBe(false);
  });

  it("close() during a re-resolution: the re-resolution does not register after close", async () => {
    const proxy = healthHoldingProxy(proxyPort, port);
    await proxy.listen();
    const dlogs: string[] = [];
    const env = { ...libEnv(proxyPort, "lib-d"), AGENT_MESSENGER_HEARTBEAT_MS: "300" };
    const d = createMessengerClient({ env, log: (m) => dlogs.push(m) });
    try {
      await d.connect();
      expect(dlogs.filter((m) => m.startsWith("Registered as peer"))).toHaveLength(1);
      proxy.arm();
      proxy.state.hold = true;
      // the broker forgets the peer: the next heartbeat is rejected and starts a re-resolution that parks on GET /health
      await raw("/unregister", { id: d.peer.id });
      expect(await until(() => proxy.state.held > 0, 5000)).toBe(true);
      expect(dlogs.some((m) => m.includes("Re-resolving broker (heartbeat rejected)"))).toBe(true);
      const closing = d.close();
      proxy.state.hold = false;
      proxy.state.release();
      await closing;
      await sleep(800);
      expect((await peersNow()).map((p) => p.name)).not.toContain("lib-d");
      expect(dlogs.filter((m) => m.startsWith("Registered as peer"))).toHaveLength(1);
      await expect(d.connect()).rejects.toThrow("client closed");
    } finally {
      proxy.state.release();
      await d.close().catch(() => {});
      await proxy.stop();
    }
  });

  it("autoStartBroker is off by default: unreachable local broker rejects without spawning", async () => {
    const clogs: string[] = [];
    const c = createMessengerClient({ env: libEnv(spare, "lib-c"), log: (m) => clogs.push(m) });
    await expect(c.connect()).rejects.toThrow("autoStartBroker is off");
    expect(clogs.join("\n")).not.toContain("Starting local broker daemon");
    await c.close();
  });
});
