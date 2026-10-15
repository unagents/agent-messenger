/**
 * Client re-resolve: connection failure -> grace period on the previous URL -> full resolution again
 * (env, config, UDP discovery, local fallback spawn); fallback broker hands over and exits; a second outage
 * repeats the whole thing.
 *
 * Isolation: every broker and client here binds / probes 127.0.0.1 only (HTTP 17911 "original", 17913 local
 * fallback, discovery 17912 pinned to 127.0.0.1) and uses temp config / state files, so nothing reaches the LAN.
 */
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { baseEnv, BROKER_BIN, McpTestClient, sleep, startBroker } from "./helpers.js";

const ORIGINAL = 17911;
const DISCOVERY = 17912;
const LOCAL = 17913;
const GRACE_MS = 2500;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const alive = (port: number) =>
  fetch(`http://127.0.0.1:${port}/health`).then(
    (r) => r.json() as Promise<{ fallback?: boolean; peers: number }>,
    () => null
  );

async function until(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(100);
  }
  return pred();
}

function stop(p: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (p.exitCode !== null) return resolve();
    p.once("exit", () => resolve());
    p.kill("SIGTERM");
  });
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "am-reresolve-"));
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ brokers: [`http://127.0.0.1:${ORIGINAL}`] }));
  // wrapper: record the pid of every spawned (detached) fallback broker so the test can stop it
  const pidFile = join(dir, "fallback.pid");
  const wrapper = join(dir, "broker-wrapper.mjs");
  writeFileSync(
    wrapper,
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n");\nawait import(${JSON.stringify(BROKER_BIN)});\n`
  );
  const common = {
    ...baseEnv(),
    // the client keeps broker.log under $HOME/.agent-messenger: keep that out of the real home
    HOME: dir,
    AGENT_MESSENGER_BIND: "127.0.0.1",
    AGENT_MESSENGER_DISCOVERY_PORT: String(DISCOVERY),
    AGENT_MESSENGER_DISCOVERY_ADDR: "127.0.0.1",
    AGENT_MESSENGER_CONFIG: config,
  };
  const originalEnv = { ...common, AGENT_MESSENGER_PORT: String(ORIGINAL), AGENT_MESSENGER_STATE: join(dir, "original.json"), AGENT_MESSENGER_BROKER_ID: "original" };
  const clientEnv = {
    ...common,
    // the local fallback listens on LOCAL; the original is reached through the config file
    AGENT_MESSENGER_PORT: String(LOCAL),
    AGENT_MESSENGER_STATE: join(dir, "local.json"),
    AGENT_MESSENGER_BROKER_ID: "local-fallback",
    AGENT_MESSENGER_DISCOVERY_TIMEOUT_MS: "300",
    AGENT_MESSENGER_GRACE_MS: String(GRACE_MS),
    AGENT_MESSENGER_FALLBACK_INTERVAL_MS: "300",
    AGENT_MESSENGER_BROKER_CMD: `${process.execPath} ${wrapper}`,
    AGENT_MESSENGER_NAME: "reresolve-client",
  };
  cleanups.push(() => {
    let pids: string[] = [];
    try {
      pids = readFileSync(pidFile, "utf8").split("\n").filter(Boolean);
    } catch {
      // never spawned
    }
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        // already gone
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { originalEnv, clientEnv };
}

async function startClient(env: Record<string, string | undefined>) {
  const c = new McpTestClient(env);
  cleanups.push(() => c.close().then(() => undefined));
  expect(await c.waitFor(() => /Registered as peer/.test(c.stderrText()), 15000)).toBe(true);
  await c.initialize();
  return c;
}

const count = (s: string, re: RegExp) => (s.match(new RegExp(re.source, "g")) ?? []).length;

describe("client re-resolve", () => {
  it("falls back after the grace period, returns when the original comes back, and falls back again on the next outage", async () => {
    const { originalEnv, clientEnv } = setup();
    let original = await startBroker(originalEnv);
    cleanups.push(() => stop(original));

    const c = await startClient(clientEnv);
    expect(c.stderrText()).toMatch(new RegExp(`broker=http://127\\.0\\.0\\.1:${ORIGINAL} \\(local, via config`));

    // --- outage 1: original down. Grace first, then a local fallback broker.
    const t0 = Date.now();
    await stop(original);
    expect(await until(() => /unreachable/.test(c.stderrText()), 5000)).toBe(true);
    await sleep(GRACE_MS / 2);
    expect(c.stderrText()).not.toMatch(/Starting local broker daemon/); // still retrying the previous URL
    expect(await until(() => /Broker started/.test(c.stderrText()), 15000)).toBe(true);
    const fellBackAfter = Date.now() - t0;
    expect(fellBackAfter).toBeGreaterThanOrEqual(GRACE_MS);
    expect(c.stderrText()).toMatch(new RegExp(`broker=http://127\\.0\\.0\\.1:${LOCAL} \\(local, via local fallback\\)`));
    expect(await alive(LOCAL)).toMatchObject({ fallback: true });

    // a message for a peer that is registered on the fallback but has not polled yet (it will move later)
    const post = (path: string, body: unknown, port = LOCAL) =>
      fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
    const ghost = (await post("/register", { pid: 99999, hostname: "ghost-host", cwd: "/", name: "ghost" })).id as string;
    await post("/send-message", { to: ghost, from_id: "cli", from_name: "tester", text: "survives the hand-over" });

    // --- recovery: original comes back -> fallback relays and exits -> client returns to the original
    original = await startBroker(originalEnv);
    cleanups.push(() => stop(original));
    expect(await until(async () => (await alive(LOCAL)) === null, 15000)).toBe(true);
    expect(await until(() => new RegExp(`broker=http://127\\.0\\.0\\.1:${ORIGINAL} .*was http://127\\.0\\.0\\.1:${LOCAL}`).test(c.stderrText()), 20000)).toBe(true);
    expect(await alive(ORIGINAL)).toMatchObject({ peers: 1 });
    // the relayed message is waiting for "ghost" on the original
    const ghost2 = (await post("/register", { pid: 99998, hostname: "ghost-host", cwd: "/", name: "ghost" }, ORIGINAL)).id as string;
    const polled = await post("/poll-messages", { id: ghost2 }, ORIGINAL);
    expect(polled.messages.map((m: any) => m.text)).toEqual(["survives the hand-over"]);

    // --- outage 2: same story again
    const starts = count(c.stderrText(), /Starting local broker daemon/);
    expect(starts).toBe(1);
    await stop(original);
    expect(await until(() => count(c.stderrText(), /Starting local broker daemon/) === 2, 20000)).toBe(true);
    expect(await until(async () => (await alive(LOCAL))?.fallback === true, 10000)).toBe(true);
    // the client registered on the second fallback (its state file still holds the first one's peers)
    expect(await until(() => count(c.stderrText(), /Registered as peer/) >= 4, 10000)).toBe(true);
    expect((await alive(LOCAL))!.peers).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("a short flap inside the grace period does not start a local broker", async () => {
    const { originalEnv, clientEnv } = setup();
    let original = await startBroker(originalEnv);
    cleanups.push(() => stop(original));
    const c = await startClient({ ...clientEnv, AGENT_MESSENGER_GRACE_MS: "8000" });

    await stop(original);
    expect(await until(() => /unreachable/.test(c.stderrText()), 5000)).toBe(true);
    await sleep(1500);
    original = await startBroker(originalEnv); // same state file: the client is still known
    cleanups.push(() => stop(original));
    expect(await until(() => /reachable again/.test(c.stderrText()), 10000)).toBe(true);
    await sleep(500);
    expect(c.stderrText()).not.toMatch(/Starting local broker daemon|Re-resolving/);
    expect(await alive(LOCAL)).toBeNull();
    expect((await c.callTool("list_peers")).isError).not.toBe(true);
  }, 60_000);

  it("a rejected heartbeat re-runs the resolution", async () => {
    const { originalEnv, clientEnv } = setup();
    let original = await startBroker(originalEnv);
    cleanups.push(() => stop(original));
    const c = await startClient({ ...clientEnv, AGENT_MESSENGER_HEARTBEAT_MS: "400" });

    await stop(original);
    // restart on a fresh state file: the broker is up again but has forgotten the client
    original = await startBroker({ ...originalEnv, AGENT_MESSENGER_STATE: originalEnv.AGENT_MESSENGER_STATE + ".fresh" });
    cleanups.push(() => stop(original));
    expect(await until(() => /Heartbeat rejected/.test(c.stderrText()), 10000)).toBe(true);
    expect(await until(() => /Re-resolving broker \(heartbeat rejected\)/.test(c.stderrText()) && count(c.stderrText(), /Registered as peer/) >= 2, 10000)).toBe(true);
    expect(c.stderrText()).toMatch(new RegExp(`broker=http://127\\.0\\.0\\.1:${ORIGINAL} .*via config`));
    expect(await alive(ORIGINAL)).toMatchObject({ peers: 1 });
  }, 60_000);
});
