/**
 * Broker resolution order (port of test/resolve.test.js): the client logs
 * `broker=<url> (<local|remote>, via <source>)` on stderr at startup.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baseEnv, BROKER_BIN, McpTestClient, sleep, startBroker } from "./helpers.js";

const base = baseEnv();

async function startAndCapture(env: Record<string, string | undefined>) {
  const c = new McpTestClient(env);
  await c.waitFor(() => /Registered as peer|MCP connected/.test(c.stderrText()) || c.proc.exitCode !== null, 15000);
  return c;
}

describe("resolve", () => {
  it("explicit AGENT_MESSENGER_HOST wins (source env)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "am-resolve-"));
    const port = String(18100 + Math.floor(Math.random() * 500));
    const env = {
      ...base,
      AGENT_MESSENGER_PORT: port,
      AGENT_MESSENGER_BIND: "127.0.0.1",
      AGENT_MESSENGER_STATE: join(dir, "b.json"),
      AGENT_MESSENGER_DISCOVERY: "off",
      AGENT_MESSENGER_CONFIG: join(dir, "missing.json"),
    };
    const broker = await startBroker(env);
    try {
      const c = await startAndCapture({ ...env, AGENT_MESSENGER_HOST: "127.0.0.1" });
      expect(c.stderrText()).toMatch(new RegExp(`broker=http://127\\.0\\.0\\.1:${port} \\(local, via env\\)`));
      expect(c.stderrText()).toMatch(/Broker already running/);
      await c.close();
    } finally {
      broker.kill("SIGTERM");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("config file brokers list is used when no env (source config)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "am-resolve-"));
    const port = String(18600 + Math.floor(Math.random() * 500));
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, JSON.stringify({ brokers: [`http://127.0.0.1:${Number(port) + 1}`, `127.0.0.1:${port}`] }));
    const env = {
      ...base,
      AGENT_MESSENGER_PORT: port,
      AGENT_MESSENGER_BIND: "127.0.0.1",
      AGENT_MESSENGER_STATE: join(dir, "b.json"),
      AGENT_MESSENGER_DISCOVERY: "off",
      AGENT_MESSENGER_CONFIG: cfg,
    };
    const broker = await startBroker(env);
    try {
      const c = await startAndCapture(env);
      const err = c.stderrText();
      expect(err).toMatch(new RegExp(`broker=http://127\\.0\\.0\\.1:${port} \\(local, via config ${cfg.replace(/[.\\/]/g, "\\$&")}\\)`));
      expect(err).toMatch(/config broker not reachable/); // the first, dead entry was skipped
      await c.close();
    } finally {
      broker.kill("SIGTERM");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("UDP discovery finds the broker when no env and no config (source discovery)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "am-resolve-"));
    const port = String(19100 + Math.floor(Math.random() * 500));
    const dport = String(19700 + Math.floor(Math.random() * 200));
    const env = {
      ...base,
      AGENT_MESSENGER_PORT: port,
      AGENT_MESSENGER_BIND: "127.0.0.1",
      AGENT_MESSENGER_STATE: join(dir, "b.json"),
      AGENT_MESSENGER_CONFIG: join(dir, "missing.json"),
      AGENT_MESSENGER_BROKER_ID: "test-broker",
      AGENT_MESSENGER_DISCOVERY_PORT: dport,
      AGENT_MESSENGER_DISCOVERY_ADDR: "127.0.0.1",
      AGENT_MESSENGER_DISCOVERY_TIMEOUT_MS: "500",
    };
    const broker = await startBroker(env);
    try {
      const c = await startAndCapture(env);
      expect(c.stderrText()).toMatch(
        new RegExp(`broker=http://127\\.0\\.0\\.1:${port} \\(local, via discovery \\(test-broker\\)\\)`)
      );
      await c.close();
    } finally {
      broker.kill("SIGTERM");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to 127.0.0.1 and auto-launches a local broker with AGENT_MESSENGER_BROKER_CMD", async () => {
    const dir = mkdtempSync(join(tmpdir(), "am-resolve-"));
    const port = String(19950 + Math.floor(Math.random() * 40));
    // wrapper: record the broker pid so the test can stop the detached daemon
    const pidFile = join(dir, "broker.pid");
    const wrapper = join(dir, "broker-wrapper.mjs");
    writeFileSync(
      wrapper,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.argv[2] = "broker";\nawait import(${JSON.stringify(BROKER_BIN)});\n`
    );
    const env = {
      ...base,
      AGENT_MESSENGER_PORT: port,
      AGENT_MESSENGER_BIND: "127.0.0.1",
      AGENT_MESSENGER_STATE: join(dir, "b.json"),
      AGENT_MESSENGER_CONFIG: join(dir, "missing.json"),
      AGENT_MESSENGER_DISCOVERY_PORT: "19998",
      AGENT_MESSENGER_DISCOVERY_ADDR: "127.0.0.1",
      AGENT_MESSENGER_DISCOVERY_TIMEOUT_MS: "300",
      AGENT_MESSENGER_BROKER_CMD: `${process.execPath} ${wrapper}`,
    };
    let brokerPid: number | null = null;
    try {
      const c = await startAndCapture(env);
      const err = c.stderrText();
      expect(err).toMatch(/discovery: no broker answered/);
      expect(err).toMatch(/Starting local broker daemon\.\.\./);
      expect(err).toMatch(/Broker started/);
      expect(err).toMatch(new RegExp(`broker=http://127\\.0\\.0\\.1:${port} \\(local, via local fallback\\)`));
      brokerPid = Number(readFileSync(pidFile, "utf8"));
      const h = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json() as Promise<{ status: string; peers: number }>);
      expect(h.status).toBe("ok");
      expect(h.peers).toBe(1);
      await c.close();
    } finally {
      if (brokerPid) {
        try {
          process.kill(brokerPid, "SIGTERM");
        } catch {
          // already gone
        }
        await sleep(200);
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
