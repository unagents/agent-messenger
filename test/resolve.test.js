import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/agent-messenger.js", import.meta.url));

const base = { ...process.env };
delete base.AGENT_MESSENGER_HOST;
delete base.AGENT_MESSENGER_PORT;
delete base.AGENT_MESSENGER_CONFIG;
delete base.AGENT_MESSENGER_DISCOVERY;
delete base.AGENT_MESSENGER_DISCOVERY_PORT;
delete base.AGENT_MESSENGER_DISCOVERY_ADDR;

async function startBroker(env) {
  const p = spawn(process.execPath, [BIN, "broker"], { env, stdio: ["ignore", "ignore", "pipe"] });
  p.stderr.on("data", () => {});
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${env.AGENT_MESSENGER_PORT}/health`);
      if (r.ok) return p;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  p.kill();
  throw new Error("broker did not start");
}

function run(args, env) {
  return spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8" });
}

test("resolve: explicit AGENT_MESSENGER_HOST wins (source env)", async () => {
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
    const r = run(["status"], { ...env, AGENT_MESSENGER_HOST: "127.0.0.1" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /via env/);
  } finally {
    broker.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolve: config file brokers list is used when no env (source config)", async () => {
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
    const r = run(["status"], env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /via config/);
    assert.match(r.stdout, new RegExp(`127\\.0\\.0\\.1:${port}`));
    assert.match(r.stderr, /config broker not reachable/); // the first, dead entry was skipped
  } finally {
    broker.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolve: UDP discovery finds the broker when no env and no config (source discovery)", async () => {
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
    const r = run(["discover"], env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 broker\(s\) answered/);
    assert.match(r.stdout, new RegExp(`test-broker\\s+http://127\\.0\\.0\\.1:${port}`));
    assert.match(r.stdout, /via discovery \(test-broker\)/);
  } finally {
    broker.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolve: falls back to 127.0.0.1 when nothing answers (source local fallback)", () => {
  const dir = mkdtempSync(join(tmpdir(), "am-resolve-"));
  const env = {
    ...base,
    AGENT_MESSENGER_PORT: "19999",
    AGENT_MESSENGER_CONFIG: join(dir, "missing.json"),
    AGENT_MESSENGER_DISCOVERY_PORT: "19998",
    AGENT_MESSENGER_DISCOVERY_ADDR: "127.0.0.1",
    AGENT_MESSENGER_DISCOVERY_TIMEOUT_MS: "300",
  };
  try {
    const r = run(["discover"], env);
    assert.match(r.stdout, /0 broker\(s\) answered/);
    assert.match(r.stdout, /resolved: http:\/\/127\.0\.0\.1:19999 \(via local fallback\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
