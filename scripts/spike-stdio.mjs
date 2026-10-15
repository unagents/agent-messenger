#!/usr/bin/env node
/**
 * SPIKE driver: start a loopback broker, spawn the client (node dist or native binary),
 * run initialize -> tools/list -> tools/call over stdio and print the exchange + timings + RSS.
 *
 *   SPIKE_DIR=<scratch dir> [SPIKE_PORT=17931] [CLIENT_BIN=<native binary>] node scripts/spike-stdio.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dir = process.env.SPIKE_DIR;
if (!dir) throw new Error("SPIKE_DIR is required");
const port = process.env.SPIKE_PORT ?? "17931";
mkdirSync(join(dir, "home"), { recursive: true });

const env = {
  PATH: process.env.PATH,
  HOME: join(dir, "home"),
  TMPDIR: dir,
  AGENT_MESSENGER_HOST: "127.0.0.1",
  AGENT_MESSENGER_PORT: port,
  AGENT_MESSENGER_BIND: "127.0.0.1",
  AGENT_MESSENGER_TOKEN: "spike-token",
  AGENT_MESSENGER_STATE: join(dir, `broker-${port}.json`),
  AGENT_MESSENGER_DISCOVERY: "off",
  AGENT_MESSENGER_CONFIG: join(dir, "no-config.json"),
  AGENT_MESSENGER_NAME: "spike",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

const broker = spawn(process.execPath, [join(ROOT, "packages/broker/dist/main.mjs")], { env, stdio: ["ignore", "ignore", "pipe"] });
broker.stderr.on("data", () => {});
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
  } catch {}
  await sleep(100);
}
console.log(`[driver] broker pid=${broker.pid} port=${port}`);

const bin = process.env.CLIENT_BIN;
const cmd = bin ? [bin, []] : [process.execPath, [join(ROOT, "packages/client/dist/main.mjs")]];
console.log(`[driver] client: ${cmd[0]} ${cmd[1].join(" ")}`);
const t0 = now();
const client = spawn(cmd[0], cmd[1], { env, stdio: ["pipe", "pipe", "pipe"] });
client.stderr.setEncoding("utf8");
client.stderr.on("data", (d) => process.stdout.write(`[client stderr] ${d}`));
client.stdout.setEncoding("utf8");

let buf = "";
const waiters = new Map();
client.stdout.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    console.log(`<- ${line.length > 600 ? line.slice(0, 600) + "...(" + line.length + " B)" : line}`);
    const m = JSON.parse(line);
    if (m.id !== undefined && waiters.has(m.id)) waiters.get(m.id)(m);
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  console.log(`-> ${JSON.stringify(msg)}`);
  const p = new Promise((res, rej) => {
    waiters.set(id, res);
    setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), 15000);
  });
  client.stdin.write(JSON.stringify(msg) + "\n");
  return p;
}
function notify(method) {
  const msg = { jsonrpc: "2.0", method };
  console.log(`-> ${JSON.stringify(msg)}`);
  client.stdin.write(JSON.stringify(msg) + "\n");
}

let rc = 0;
try {
  const t1 = now();
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "spike", version: "0" } });
  const tInit = now();
  console.log(`[driver] initialize answered ${(tInit - t0).toFixed(0)} ms after spawn (${(tInit - t1).toFixed(0)} ms after request sent)`);
  notify("notifications/initialized");
  const tl0 = now();
  const list = await request("tools/list", {});
  console.log(`[driver] tools/list ${(now() - tl0).toFixed(0)} ms, ${list.result.tools.length} tools`);
  const tc0 = now();
  const c1 = await request("tools/call", { name: "set_summary", arguments: { summary: "sdk-perry spike" } });
  console.log(`[driver] tools/call set_summary ${(now() - tc0).toFixed(0)} ms isError=${c1.result?.isError ?? false}`);
  const tc1 = now();
  const c2 = await request("tools/call", { name: "list_peers", arguments: { scope: "all" } });
  console.log(`[driver] tools/call list_peers ${(now() - tc1).toFixed(0)} ms isError=${c2.result?.isError ?? false}`);
  const status = readFileSync(`/proc/${client.pid}/status`, "utf8");
  const rss = /VmRSS:\s+(\d+) kB/.exec(status)?.[1];
  const hwm = /VmHWM:\s+(\d+) kB/.exec(status)?.[1];
  console.log(`[driver] RSS=${rss} kB (${(rss / 1024).toFixed(1)} MB) VmHWM=${hwm} kB`);
} catch (e) {
  console.log(`[driver] FAILED: ${e.message}`);
  rc = 1;
}
client.kill("SIGTERM");
await new Promise((r) => (client.exitCode !== null ? r() : client.once("exit", r)));
broker.kill("SIGTERM");
await new Promise((r) => (broker.exitCode !== null ? r() : broker.once("exit", r)));
console.log("[driver] stopped client and broker");
process.exit(rc);
