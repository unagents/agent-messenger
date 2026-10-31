#!/usr/bin/env node
/**
 * End-to-end check of the release layout without any external registry:
 *
 *   node scripts/e2e-mcp.mjs [--broker direct|cli] [--no-native] [--no-node]
 *
 * 1. `npm pack`s packages/{protocol,broker,client,client-<platform>-<arch>} into a temp dir and
 *    serves them from an in-process npm registry on 127.0.0.1 (packument + tarball);
 *    packages/protocol is served too because the broker depends on it.
 * 2. Starts the broker: `direct` = node packages/broker/dist/main.mjs (needs node_modules),
 *    `cli` = `agent-messenger broker` installed from the mock registry. Fixed port, token,
 *    discovery on (own discovery port, loopback only).
 * 3. Through packages/cli/dist/main.mjs (installing from the mock registry):
 *    discover → mcp (native, auto) → mcp (node) → set_name / send_message / check_messages
 *    both ways → session socket delivery (unix socket server in this process) →
 *    peers / status / send → node fallback when the platform package is missing →
 *    `agent-messenger broker` (cli mode only when --broker direct, as an extra check).
 *
 * Environment (all optional):
 *   E2E_PORT (17901)  E2E_DISCOVERY_PORT (17902)  E2E_DISCOVERY_ADDR (127.0.0.1)
 *   E2E_BIND (127.0.0.1)  E2E_TOKEN (random)
 *   E2E_BROKER_HOST / E2E_BROKER_PORT: use an already running broker instead (skips discovery)
 *   E2E_CLI: path of the CLI entry to drive (default packages/cli/dist/main.mjs)
 *   E2E_KEEP=1: keep the temp dir
 *
 * Also runs the mesh scenario (design broker-autonomy 6.2): two mesh brokers find each other by UDP announce
 * (AGENT_MESSENGER_DISCOVERY_TARGETS on loopback), two clients pinned with set_broker, the connected broker is
 * stopped, the client moves to the other one and send / protocol declarations keep working, and a broker with
 * another token is never a member. Ports: E2E_PORT + 20..25 (HTTP, UDP). Skipped with E2E_BROKER_HOST.
 *
 * Also runs the protocol scenarios (set_protocol / unset_protocol / get_protocol, list_peers(protocol),
 * send_message(meta), broker restart) against protocol repos given as local paths. They are generated in
 * <repo>/.e2e/ (p1, p1b, p2) and removed when the script ends, also on failure.
 *
 * Never talks to 192.168.1.202: AGENT_MESSENGER_* / CLAUDE_CODE_MESSAGING_* are stripped
 * from the child environment, the config file is pointed at an empty temp path and
 * discovery is restricted to E2E_DISCOVERY_ADDR.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
/** the CLI under test; E2E_CLI points at an installed copy (e.g. node_modules/@unagents/messenger/dist/main.mjs) */
const CLI = process.env.E2E_CLI ?? join(ROOT, "packages", "cli", "dist", "main.mjs");
const BROKER_MAIN = join(ROOT, "packages", "broker", "dist", "main.mjs");
const TARGET = `${process.platform}-${process.arch}`;
const NATIVE_PKG = `@unagents/messenger-client-${TARGET}`;

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};
const brokerMode = opt("--broker", "direct");
const doNative = !args.includes("--no-native");
const doNode = !args.includes("--no-node");

const PORT = Number(process.env.E2E_PORT ?? 17901);
const DISCOVERY_PORT = Number(process.env.E2E_DISCOVERY_PORT ?? 17902);
const DISCOVERY_ADDR = process.env.E2E_DISCOVERY_ADDR ?? "127.0.0.1";
const BIND = process.env.E2E_BIND ?? "127.0.0.1";
const TOKEN = process.env.E2E_TOKEN ?? randomBytes(8).toString("hex");
const REMOTE_HOST = process.env.E2E_BROKER_HOST ?? "";
const REMOTE_PORT = Number(process.env.E2E_BROKER_PORT ?? PORT);
const BROKER_URL = REMOTE_HOST ? `http://${REMOTE_HOST}:${REMOTE_PORT}` : `http://127.0.0.1:${PORT}`;

/** local protocol repos of the protocol scenarios (inside the worktree, not in the system temp dir) */
const PROTO_DIR = join(ROOT, ".e2e");
const TMP = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "am-e2e-"));
const NPM_CACHE = join(TMP, "npmcache");
const children = new Set();
const results = [];
let failed = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[e2e] ${m}`);
function pass(name, detail = "") {
  results.push({ name, ok: true, detail });
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail = "") {
  failed++;
  results.push({ name, ok: false, detail });
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}
function check(name, cond, detail = "") {
  if (cond) pass(name, detail);
  else fail(name, detail);
  return Boolean(cond);
}

// ---------------------------------------------------------------- mock registry
async function startRegistry() {
  const packages = new Map(); // name -> { latest, versions: Map<version, {tgz, file, integrity, shasum, manifest}> }
  const packDest = join(TMP, "pack");
  mkdirSync(packDest, { recursive: true });
  let url = "";
  const server = createHttpServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const tarball = path.match(/^\/-\/tarball\/(.+)\/(.+\.tgz)$/);
    if (tarball) {
      const stored = packages.get(tarball[1])?.versions;
      const v = stored ? [...stored.values()].find((s) => s.file === tarball[2]) : undefined;
      if (!v) return res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
      return res.writeHead(200, { "content-type": "application/octet-stream", "content-length": v.tgz.length }).end(v.tgz);
    }
    const name = path.replace(/^\//, "");
    const pkg = packages.get(name);
    if (!pkg) return res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
    const versions = {};
    for (const [version, v] of pkg.versions) {
      versions[version] = { ...v.manifest, dist: { tarball: `${url}-/tarball/${name}/${v.file}`, integrity: v.integrity, shasum: v.shasum } };
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name, "dist-tags": { latest: pkg.latest }, versions }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}/`;
  return {
    url,
    publish(dir) {
      const out = JSON.parse(
        execFileSync("npm", ["pack", "--json", "--pack-destination", packDest, dir], {
          encoding: "utf8",
          env: { ...process.env, npm_config_cache: NPM_CACHE, npm_config_update_notifier: "false" },
          stdio: ["ignore", "pipe", "ignore"],
        })
      )[0];
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const entry = packages.get(out.name) ?? { latest: out.version, versions: new Map() };
      entry.versions.set(out.version, { tgz: readFileSync(join(packDest, out.filename)), file: out.filename, integrity: out.integrity, shasum: out.shasum, manifest });
      entry.latest = out.version;
      packages.set(out.name, entry);
      return { name: out.name, version: out.version, filename: out.filename, size: entry.versions.get(out.version).tgz.length };
    },
    unpublish(name) {
      packages.delete(name);
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// ---------------------------------------------------------------- processes
function baseEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("AGENT_MESSENGER_") || k.startsWith("CLAUDE_CODE_MESSAGING_")) delete env[k];
  delete env.NODE_ENV;
  delete env.TEST;
  delete env.VITEST;
  env.NO_COLOR = "1";
  env.npm_config_cache = NPM_CACHE;
  env.npm_config_update_notifier = "false";
  return { ...env, ...extra };
}

function cliEnv(registryUrl, pkgsDir, extra = {}) {
  return baseEnv({
    AGENT_MESSENGER_REGISTRY: registryUrl,
    AGENT_MESSENGER_PKGS_DIR: pkgsDir,
    AGENT_MESSENGER_PORT: String(REMOTE_HOST ? REMOTE_PORT : PORT),
    AGENT_MESSENGER_TOKEN: TOKEN,
    AGENT_MESSENGER_CLIENT_STATE: join(TMP, "no-client.json"),
    AGENT_MESSENGER_DISCOVERY_PORT: String(DISCOVERY_PORT),
    AGENT_MESSENGER_DISCOVERY_ADDR: DISCOVERY_ADDR,
    ...(REMOTE_HOST ? { AGENT_MESSENGER_HOST: REMOTE_HOST } : {}),
    ...extra,
  });
}

function track(p) {
  children.add(p);
  p.on("exit", () => children.delete(p));
  return p;
}

/** run the CLI to completion */
function runCli(cliArgs, env) {
  return new Promise((resolveP, reject) => {
    const p = track(spawn(process.execPath, [CLI, ...cliArgs], { env, stdio: ["ignore", "pipe", "pipe"] }));
    let stdout = "";
    let stderr = "";
    p.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    p.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (status) => resolveP({ status, stdout, stderr }));
  });
}

async function waitHealth(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return await r.json();
    } catch {
      // not yet
    }
    await sleep(200);
  }
  return null;
}

async function startBrokerDirect() {
  const env = baseEnv({
    AGENT_MESSENGER_PORT: String(PORT),
    AGENT_MESSENGER_BIND: BIND,
    AGENT_MESSENGER_TOKEN: TOKEN,
    AGENT_MESSENGER_DISCOVERY: "on",
    AGENT_MESSENGER_DISCOVERY_PORT: String(DISCOVERY_PORT),
    AGENT_MESSENGER_STATE: join(TMP, "broker.json"),
    AGENT_MESSENGER_BROKER_ID: "e2e-broker",
  });
  const p = track(spawn(process.execPath, [BROKER_MAIN], { env, stdio: ["ignore", "ignore", "pipe"] }));
  let stderr = "";
  p.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
  const exited = new Promise((r) => p.on("exit", (c, sig) => r(c ?? sig)));
  const h = await waitHealth(BROKER_URL);
  return { proc: p, health: h, stderr: () => stderr, exited };
}

async function startBrokerCli(registryUrl, pkgsDir, port, discovery) {
  const env = cliEnv(registryUrl, pkgsDir, {
    AGENT_MESSENGER_PORT: String(port),
    AGENT_MESSENGER_BIND: BIND,
    AGENT_MESSENGER_DISCOVERY: discovery ? "on" : "off",
    AGENT_MESSENGER_STATE: join(TMP, `broker-cli-${port}.json`),
    AGENT_MESSENGER_BROKER_ID: "e2e-broker-cli",
  });
  const p = track(spawn(process.execPath, [CLI, "broker"], { env, stdio: ["ignore", "ignore", "pipe"] }));
  let stderr = "";
  p.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
  const exited = new Promise((r) => p.on("exit", (c, sig) => r(c ?? sig)));
  let h = null;
  for (let i = 0; i < 300 && h === null && p.exitCode === null; i++) h = await waitHealth(`http://127.0.0.1:${port}`, 1);
  return { proc: p, health: h, stderr: () => stderr, exited };
}

/** MCP stdio client over `agent-messenger mcp` */
class Mcp {
  constructor(label, env) {
    this.label = label;
    this.notifications = [];
    this.stderr = "";
    this.pending = new Map();
    this.nextId = 1;
    this.buf = "";
    this.proc = track(spawn(process.execPath, [CLI, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] }));
    this.proc.stdout.setEncoding("utf8").on("data", (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        this.onLine(line);
      }
    });
    this.proc.stderr.setEncoding("utf8").on("data", (d) => (this.stderr += d));
    this.exited = new Promise((r) => this.proc.on("exit", (code, sig) => r(code ?? sig)));
  }
  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.code} ${msg.error.message}`));
      else p.resolve(msg.result);
    } else if (typeof msg.method === "string") {
      this.notifications.push({ method: msg.method, params: msg.params });
    }
  }
  request(method, params, timeoutMs = 15000) {
    const id = this.nextId++;
    return new Promise((resolveP, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label}: ${method} timed out after ${timeoutMs} ms\n--- stderr ---\n${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolveP(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async initialize() {
    const r = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } }, 60000);
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return r;
  }
  async tool(name, args = {}) {
    const r = await this.request("tools/call", { name, arguments: args });
    return { text: r.content.map((c) => c.text).join("\n"), isError: Boolean(r.isError) };
  }
  async waitNotification(pred, timeoutMs = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const n = this.notifications.find(pred);
      if (n) return n;
      await sleep(100);
    }
    return null;
  }
  async close() {
    this.proc.stdin.end();
    const t = setTimeout(() => this.proc.kill("SIGKILL"), 10000);
    const code = await this.exited;
    clearTimeout(t);
    return code;
  }
}

/** send_message A→B, then read on B: channel notification and/or check_messages */
async function exchange(a, b, toName, text) {
  const s = await a.tool("send_message", { to: toName, message: text });
  const c = await b.tool("check_messages");
  const viaCheck = c.text.includes(text);
  let viaChannel = false;
  if (!viaCheck) viaChannel = Boolean(await b.waitNotification((n) => n.method === "notifications/claude/channel" && n.params?.content === text));
  return { sent: s, viaCheck, viaChannel, checkText: c.text };
}

const TOOL_NAMES = "list_peers,send_message,send_ping,set_name,set_summary,check_messages,set_protocol,unset_protocol,get_protocol,get_broker,set_broker";

// ---------------------------------------------------------------- protocol scenarios
const PROTO_NAME = "e2e-proto";

/** write a local protocol repo (protocol.json + PROTOCOL.md) and return its path */
function writeProtoRepo(dirName, version, doc) {
  const dir = join(PROTO_DIR, dirName);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    name: PROTO_NAME,
    version,
    description: `e2e protocol ${version}`,
    messages: { request: { type: "object", required: ["ref"], properties: { ref: { type: "string" } } } },
  };
  writeFileSync(join(dir, "protocol.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(dir, "PROTOCOL.md"), doc);
  return dir;
}

/** read the text of a message that `m` was sent: check_messages, or the channel notification when the push won */
async function receiveText(m, marker) {
  for (let i = 0; i < 40; i++) {
    const c = await m.tool("check_messages");
    if (c.text.includes(marker)) return c.text;
    const n = m.notifications.find((x) => x.method === "notifications/claude/channel" && String(x.params?.content ?? "").includes(marker));
    if (n) return String(n.params.content);
    await sleep(150);
  }
  return "(not received)";
}

/**
 * Design 8: scenarios 2-9 (1 = tools/list in mcpFlow, 10 = the unchanged plain send_message checks).
 * a / b are the two peers of mcpFlow, o is a third peer used to list (list_peers leaves out the caller).
 * restartBroker is null when the broker is not ours.
 */
async function protocolFlow(a, b, aName, bName, o, restartBroker) {
  const p1 = writeProtoRepo("p1", "1.0.0", "# e2e-proto 1.0.0\nE2E-DOC-ONE: request carries ref.\n");
  const p1b = writeProtoRepo("p1b", "1.0.0", "# e2e-proto 1.0.0 (other body)\nE2E-DOC-OTHER.\n");
  const p2 = writeProtoRepo("p2", "1.1.0", "# e2e-proto 1.1.0\nE2E-DOC-TWO: request carries ref and note.\n");

  // 2. A declares 1.0.0
  const s2 = await a.tool("set_protocol", { repo: p1 });
  check(`protocol 2: ${a.label} set_protocol(p1) → Protocol set: ${PROTO_NAME}@1.0.0`, !s2.isError && s2.text.startsWith(`Protocol set: ${PROTO_NAME}@1.0.0 (sha256 `), s2.text);

  // 3. B lists by protocol: only A, with the Protocol line
  const l3 = await b.tool("list_peers", { protocol: PROTO_NAME });
  check(
    "protocol 3: list_peers(protocol) → only A, with its Protocol line",
    !l3.isError && l3.text.startsWith("Found 1 peer(s)") && l3.text.includes(`Name: ${aName}`) && l3.text.includes(`Protocol: ${PROTO_NAME}@1.0.0`) && !l3.text.includes(`Name: ${bName}`),
    l3.text.split("\n").slice(0, 2).join(" | ")
  );

  // 4. B reads the definition
  const g4 = await b.tool("get_protocol", { name: PROTO_NAME });
  check("protocol 4: get_protocol → heading, protocol.json and the PROTOCOL.md body", !g4.isError && g4.text.startsWith(`${PROTO_NAME}@1.0.0 (sha256 `) && g4.text.includes("E2E-DOC-ONE") && g4.text.includes('"name": "e2e-proto"'), g4.text.split("\n")[0]);

  // 5. same name / version, other body → conflict
  const c5 = await b.tool("set_protocol", { repo: p1b });
  check("protocol 5: set_protocol(p1b, same name / version, other body) → PROTOCOL_CONFLICT", c5.isError && c5.text.startsWith("PROTOCOL_CONFLICT: "), c5.text.split("\n")[0]);

  // 6. B declares 1.1.0; filters; latest
  const s6 = await b.tool("set_protocol", { repo: p2 });
  check(`protocol 6: ${b.label} set_protocol(p2) → Protocol set: ${PROTO_NAME}@1.1.0`, !s6.isError && s6.text.startsWith(`Protocol set: ${PROTO_NAME}@1.1.0 (sha256 `), s6.text);
  const l6a = await o.tool("list_peers", { protocol: PROTO_NAME, version: "1.0.0" });
  check("protocol 6: list_peers(version 1.0.0) → A only", l6a.text.startsWith("Found 1 peer(s)") && l6a.text.includes(`Name: ${aName}`) && !l6a.text.includes(`Name: ${bName}`), l6a.text.split("\n")[0]);
  const l6b = await o.tool("list_peers", { protocol: PROTO_NAME });
  check("protocol 6: list_peers(no version) → A and B", l6b.text.startsWith("Found 2 peer(s)") && l6b.text.includes(`Name: ${aName}`) && l6b.text.includes(`Name: ${bName}`), l6b.text.split("\n")[0]);
  const g6 = await o.tool("get_protocol", { name: PROTO_NAME });
  check("protocol 6: get_protocol(no version) → 1.1.0", !g6.isError && g6.text.startsWith(`${PROTO_NAME}@1.1.0 (sha256 `) && g6.text.includes("E2E-DOC-TWO"), g6.text.split("\n")[0]);

  // 7. B → A with meta 1.1.0 while A serves 1.0.0: mismatch on A, warning on A's reply
  const m7 = `proto meta ${Date.now()}`;
  const s7 = await b.tool("send_message", { to: aName, message: m7, meta: { protocol: PROTO_NAME, version: "1.1.0" } });
  check(`protocol 7: ${b.label} → ${a.label} send_message(meta)`, !s7.isError && s7.text.startsWith(`Message sent to ${aName} (`), s7.text);
  const r7 = await receiveText(a, m7);
  check("protocol 7: receiver shows Protocol line with mismatch", r7.includes(`Protocol: ${PROTO_NAME}@1.1.0 (this server: 1.0.0, mismatch)`), r7.split("\n").slice(0, 3).join(" | "));
  const reply7 = `proto reply ${Date.now()}`;
  const a7 = await a.tool("send_message", { to: bName, message: reply7 });
  check(
    "protocol 7: the reply result carries the version mismatch warning",
    !a7.isError && a7.text.includes(`[agent-messenger warning] protocol version mismatch: you sent ${PROTO_NAME}@1.1.0, this server serves ${PROTO_NAME}@1.0.0`),
    a7.text.split("\n").join(" | ")
  );
  const r7b = await receiveText(b, reply7);
  check("protocol 7: the reply reaches B with the warning line and A's version", r7b.includes("protocol version mismatch") && r7b.includes(`Protocol: ${PROTO_NAME}@1.0.0`), r7b.split("\n").slice(0, 3).join(" | "));

  // 8. A withdraws 1.0.0
  const u8 = await a.tool("unset_protocol");
  check("protocol 8: unset_protocol() → Protocol unset: (all, 1)", !u8.isError && u8.text === "Protocol unset: (all, 1)", u8.text);
  const l8 = await o.tool("list_peers", { protocol: PROTO_NAME, version: "1.0.0" });
  check("protocol 8: list_peers(version 1.0.0) → none", l8.text === `No server for protocol "${PROTO_NAME}" (version: 1.0.0).`, l8.text);
  const g8 = await o.tool("get_protocol", { name: PROTO_NAME, version: "1.0.0" });
  check("protocol 8: get_protocol(version 1.0.0) → PROTOCOL_NOT_FOUND", g8.isError && g8.text.startsWith("PROTOCOL_NOT_FOUND: "), g8.text.split("\n")[0]);

  // 9. broker restart: B's declaration is served again (persisted state or heartbeat resend)
  if (restartBroker) {
    await restartBroker();
    let g9 = { text: "", isError: true };
    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      try {
        g9 = await o.tool("get_protocol", { name: PROTO_NAME });
      } catch (e) {
        g9 = { text: String(e), isError: true };
      }
      if (!g9.isError && g9.text.startsWith(`${PROTO_NAME}@1.1.0 (`)) break;
      await sleep(500);
    }
    check("protocol 9: after the broker restart get_protocol returns 1.1.0", !g9.isError && g9.text.startsWith(`${PROTO_NAME}@1.1.0 (`), `${Math.round((Date.now() - t0) / 100) / 10} s: ${g9.text.split("\n")[0]}`);
    // B is listed again with its declaration (A withdrew its own in scenario 8)
    const l9 = await o.tool("list_peers", { protocol: PROTO_NAME });
    check("protocol 9: list_peers(protocol) after the restart → B", l9.text.startsWith("Found 1 peer(s)") && l9.text.includes(`Name: ${bName}`), l9.text.split("\n")[0]);
  } else {
    log("protocol 9 skipped: the broker is not started by this script");
  }
}

async function mcpFlow(a, b, aName, bName) {
  const ia = await a.initialize();
  check(`${a.label}: initialize`, ia.serverInfo?.name === "agent-messenger" && ia.protocolVersion === "2025-06-18", `serverInfo=${JSON.stringify(ia.serverInfo)}`);
  const tl = await a.request("tools/list");
  const names = (tl.tools ?? []).map((t) => t.name).join(",");
  check(`${a.label}: tools/list`, names === TOOL_NAMES, names);
  const sn = await a.tool("set_name", { name: aName });
  check(`${a.label}: set_name`, sn.text === `Name set: "${aName}"`, sn.text);

  const ib = await b.initialize();
  check(`${b.label}: initialize`, ib.serverInfo?.name === "agent-messenger", `serverInfo=${JSON.stringify(ib.serverInfo)}`);
  const tlb = await b.request("tools/list");
  check(`${b.label}: tools/list`, (tlb.tools ?? []).length === 11, `${(tlb.tools ?? []).length} tools`);
  const snb = await b.tool("set_name", { name: bName });
  check(`${b.label}: set_name`, snb.text === `Name set: "${bName}"`, snb.text);

  const t1 = `hello ${bName} from ${aName} ${Date.now()}`;
  const x1 = await exchange(a, b, bName, t1);
  check(`${a.label} → ${b.label}: send_message`, !x1.sent.isError && x1.sent.text.startsWith(`Message sent to ${bName} (`), x1.sent.text);
  check(`${b.label}: receives (check_messages / channel)`, x1.viaCheck || x1.viaChannel, x1.viaCheck ? "via check_messages" : x1.viaChannel ? `via channel push; check_messages said "${x1.checkText}"` : x1.checkText);

  const t2 = `hello ${aName} from ${bName} ${Date.now()}`;
  const x2 = await exchange(b, a, aName, t2);
  check(`${b.label} → ${a.label}: send_message`, !x2.sent.isError && x2.sent.text.startsWith(`Message sent to ${aName} (`), x2.sent.text);
  check(`${a.label}: receives (check_messages / channel)`, x2.viaCheck || x2.viaChannel, x2.viaCheck ? "via check_messages" : x2.viaChannel ? `via channel push; check_messages said "${x2.checkText}"` : x2.checkText);
}

function loaderPicked(mcp) {
  const m = mcp.stderr.match(/ready: (@unagents\/messenger-client[^\s]*)@/);
  return m ? m[1] : "(no install this run)";
}

function cacheEntries(pkgsDir) {
  return existsSync(pkgsDir) ? readdirSync(pkgsDir).sort() : [];
}

// ---------------------------------------------------------------- mesh scenario (broker autonomy, design 6.2)
const MESH_PROTO = "e2e-mesh-proto";

async function meshPost(url, token, path, body = {}) {
  const r = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return r.json();
}

/** start a mesh broker on loopback; all brokers and clients share one explicit discovery target list */
async function startMeshBroker(id, port, dport, token, targets) {
  const env = baseEnv({
    AGENT_MESSENGER_PORT: String(port),
    AGENT_MESSENGER_BIND: "127.0.0.1",
    AGENT_MESSENGER_TOKEN: token,
    AGENT_MESSENGER_BROKER_ID: id,
    AGENT_MESSENGER_STATE: join(PROTO_DIR, `mesh-${id}.json`),
    AGENT_MESSENGER_DISCOVERY: "on",
    AGENT_MESSENGER_DISCOVERY_PORT: String(dport),
    AGENT_MESSENGER_DISCOVERY_ADDR: "127.0.0.1",
    AGENT_MESSENGER_DISCOVERY_TARGETS: targets,
    AGENT_MESSENGER_MESH: "on",
    AGENT_MESSENGER_MESH_ANNOUNCE_MS: "500",
    AGENT_MESSENGER_MESH_INTERVAL_MS: "500",
  });
  const p = track(spawn(process.execPath, [BROKER_MAIN], { env, stdio: ["ignore", "ignore", "pipe"] }));
  let stderr = "";
  p.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
  const exited = new Promise((r) => p.on("exit", (c, sig) => r(c ?? sig)));
  const url = `http://127.0.0.1:${port}`;
  return { proc: p, url, health: await waitHealth(url), stderr: () => stderr, exited, id, token };
}

async function meshFlow(registryUrl, pkgs) {
  const [pa, pb, pc] = [PORT + 20, PORT + 22, PORT + 24];
  const [da, db, dc] = [DISCOVERY_PORT + 20, DISCOVERY_PORT + 22, DISCOVERY_PORT + 24];
  const targets = [da, db, dc].map((d) => `127.0.0.1:${d}`).join(",");
  mkdirSync(PROTO_DIR, { recursive: true });
  const A = await startMeshBroker("mesh-a", pa, da, TOKEN, targets);
  const B = await startMeshBroker("mesh-b", pb, db, TOKEN, targets);
  const opened = [];
  let C = null;
  let probe = null;
  try {
    // 1
    check("mesh 1: brokers A and B are up with mesh: true", A.health?.status === "ok" && B.health?.status === "ok" && A.health.mesh === true && B.health.mesh === true, `A=${JSON.stringify(A.health)} B=${JSON.stringify(B.health)}`);
    if (!A.health || !B.health) return;

    // 2. a peer registered on A shows up on B (found each other by announce, then synced)
    probe = (await meshPost(A.url, TOKEN, "/register", { pid: process.pid, hostname: "e2e-probe", cwd: ROOT, name: "mesh-probe" })).id;
    let seen = false;
    for (let i = 0; i < 25 && !seen; i++) {
      const l = await meshPost(B.url, TOKEN, "/list-peers", { scope: "all" });
      seen = Array.isArray(l) && l.some((p) => p.name === "mesh-probe");
      if (!seen) await sleep(200);
    }
    check("mesh 2: A's peer is listed by B (mutual discovery and sync, <= 5 s)", seen, B.stderr().split("\n").filter((l) => /mesh/.test(l)).slice(-3).join(" | "));
    check("mesh 2: B logged the discovery of A", /mesh: found mesh-a at http:\/\/127\.0\.0\.1:/.test(B.stderr()), B.stderr().match(/mesh: found[^\n]*/)?.[0] ?? "(no log)");

    // 3. clients X and Y; discovery sees both brokers, set_broker pins X to A and Y to B
    const clientEnv = (extra = {}) =>
      cliEnv(registryUrl, pkgs, {
        AGENT_MESSENGER_CLIENT: "node",
        AGENT_MESSENGER_DISCOVERY_PORT: String(da),
        AGENT_MESSENGER_DISCOVERY_TARGETS: targets,
        AGENT_MESSENGER_CLIENT_STATE: join(PROTO_DIR, "mesh-client.json"),
        AGENT_MESSENGER_GRACE_MS: "2000",
        ...extra,
      });
    const X = new Mcp("mesh client X", clientEnv());
    const Y = new Mcp("mesh client Y", clientEnv());
    opened.push(X, Y);
    await X.initialize();
    await Y.initialize();
    await X.tool("set_name", { name: "mesh-x" });
    await Y.tool("set_name", { name: "mesh-y" });
    const gx0 = await X.tool("get_broker");
    check("mesh 3: get_broker lists both mesh brokers from discovery", !gx0.isError && gx0.text.includes("discovered:") && gx0.text.includes("mesh-a") && gx0.text.includes("mesh-b"), gx0.text.split("\n").join(" | "));
    const sx = await X.tool("set_broker", { url: A.url });
    const sy = await Y.tool("set_broker", { url: B.url });
    check("mesh 3: X pinned to A with source set_broker", !sx.isError && sx.text.startsWith(`broker: ${A.url} (id mesh-a, `) && sx.text.includes("mesh)") && sx.text.includes("source: set_broker") && sx.text.includes("pinned: yes"), sx.text.split("\n").join(" | "));
    check("mesh 3: Y pinned to B with source set_broker", !sy.isError && sy.text.startsWith(`broker: ${B.url} (id mesh-b, `) && sy.text.includes("source: set_broker"), sy.text.split("\n").join(" | "));

    // 4. X serves a protocol; Y finds X across brokers and sends with meta
    const repo = join(PROTO_DIR, "mesh-p");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "protocol.json"), JSON.stringify({ name: MESH_PROTO, version: "1.0.0", description: "e2e mesh protocol", messages: { request: { type: "object" } } }, null, 2) + "\n");
    writeFileSync(join(repo, "PROTOCOL.md"), "# e2e-mesh-proto 1.0.0\nMESH-DOC.\n");
    const sp = await X.tool("set_protocol", { repo });
    check("mesh 4: X set_protocol", !sp.isError && sp.text.startsWith(`Protocol set: ${MESH_PROTO}@1.0.0`), sp.text.split("\n")[0]);
    let ly = { text: "" };
    for (let i = 0; i < 25 && !ly.text.includes("Name: mesh-x"); i++) {
      ly = await Y.tool("list_peers", { protocol: MESH_PROTO });
      if (!ly.text.includes("Name: mesh-x")) await sleep(200);
    }
    check("mesh 4: Y list_peers(protocol) → X (declaration crossed A → B)", ly.text.includes("Name: mesh-x") && ly.text.includes(`Protocol: ${MESH_PROTO}@1.0.0`), ly.text.split("\n").slice(0, 2).join(" | "));
    const m4 = `mesh meta ${Date.now()}`;
    const s4 = await Y.tool("send_message", { to: "mesh-x", message: m4, meta: { protocol: MESH_PROTO, version: "1.0.0" } });
    const r4 = await receiveText(X, m4);
    check("mesh 4: Y → X send_message(meta) arrives with the Protocol line", !s4.isError && r4.includes(m4) && r4.includes(`Protocol: ${MESH_PROTO}@1.0.0`), s4.isError ? s4.text : r4.split("\n").slice(0, 3).join(" | "));

    // 5. stop A
    A.proc.kill("SIGTERM");
    const codeA = await A.exited;
    check("mesh 5: broker A stopped (SIGTERM → exit 0)", codeA === 0, `exit=${codeA}`);

    // 6. X leaves the dead pinned broker after the grace period and finds B by discovery
    let gx = { text: "" };
    const t6 = Date.now();
    while (Date.now() - t6 < 30000) {
      gx = await X.tool("get_broker");
      if (gx.text.startsWith(`broker: ${B.url} `)) break;
      await sleep(500);
    }
    check("mesh 6: X moved to B with source discovery and no pin", gx.text.startsWith(`broker: ${B.url} (id mesh-b, `) && gx.text.includes("source: discovery") && gx.text.includes("pinned: no"), `${Math.round((Date.now() - t6) / 100) / 10} s: ${gx.text.split("\n").join(" | ")}`);

    // 7. both directions again, and X's protocol declaration is served again
    const m7a = `mesh after Y→X ${Date.now()}`;
    const m7b = `mesh after X→Y ${Date.now()}`;
    const s7a = await Y.tool("send_message", { to: "mesh-x", message: m7a, meta: { protocol: MESH_PROTO, version: "1.0.0" } });
    const r7a = await receiveText(X, m7a);
    const s7b = await X.tool("send_message", { to: "mesh-y", message: m7b, meta: { protocol: MESH_PROTO, version: "1.0.0" } });
    const r7b = await receiveText(Y, m7b);
    check("mesh 7: Y → X send_message(meta) after the outage", !s7a.isError && r7a.includes(m7a), s7a.isError ? s7a.text : r7a.split("\n")[0]);
    check("mesh 7: X → Y send_message(meta) after the outage", !s7b.isError && r7b.includes(m7b), s7b.isError ? s7b.text : r7b.split("\n")[0]);
    let l7 = { text: "" };
    for (let i = 0; i < 25 && !l7.text.includes("Name: mesh-x"); i++) {
      l7 = await Y.tool("list_peers", { protocol: MESH_PROTO });
      if (!l7.text.includes("Name: mesh-x")) await sleep(200);
    }
    check("mesh 7: list_peers(protocol) still shows X (declaration re-sent on the new broker)", l7.text.includes("Name: mesh-x") && l7.text.includes(`Protocol: ${MESH_PROTO}@1.0.0`), l7.text.split("\n").slice(0, 2).join(" | "));

    // 8. a broker with another token is never a member
    C = await startMeshBroker("mesh-c", pc, dc, "another-token", targets);
    const pcPeer = (await meshPost(C.url, "another-token", "/register", { pid: process.pid, hostname: "e2e-probe-c", cwd: ROOT, name: "mesh-c-peer" })).id;
    await sleep(3000);
    const lb = await meshPost(B.url, TOKEN, "/list-peers", { scope: "all" });
    const lc = await meshPost(C.url, "another-token", "/list-peers", { scope: "all" });
    const hb = await (await fetch(`${B.url}/health`)).json();
    check("mesh 8: B's peer list has no peer of C (token mismatch)", Array.isArray(lb) && !lb.some((p) => p.name === "mesh-c-peer"), `B peers: ${Array.isArray(lb) ? lb.map((p) => p.name).join(",") : "?"}; health.peers=${hb.peers}`);
    check("mesh 8: C's peer list has none of A/B's peers", Array.isArray(lc) && lc.every((p) => p.name === "mesh-c-peer"), `C peers: ${Array.isArray(lc) ? lc.map((p) => p.name).join(",") : "?"}`);
    check("mesh 8: B logged the token mismatch once", (B.stderr().match(/mesh: ignoring mesh-c@127\.0\.0\.1 \(token mismatch\)/g) ?? []).length === 1, B.stderr().match(/mesh: ignoring[^\n]*/g)?.join(" | ") ?? "(no log)");
    void pcPeer;
  } finally {
    for (const m of opened) {
      const code = await m.close();
      check(`${m.label}: stdin close → exit 0`, code === 0, `exit=${code}`);
    }
    for (const br of [A, B, C]) {
      if (!br || br.proc.exitCode !== null) continue;
      br.proc.kill("SIGTERM");
      const code = await br.exited;
      check(`mesh: broker ${br.id} SIGTERM → exit 0`, code === 0, `exit=${code}`);
    }
    void probe;
  }
}

// ---------------------------------------------------------------- session socket
function startSessionSocket(path) {
  const lines = [];
  let ended = false;
  const server = createNetServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    sock.on("end", () => {
      ended = true;
      sock.end();
    });
  });
  return new Promise((r) => server.listen(path, () => r({ server, lines, ended: () => ended })));
}

// ---------------------------------------------------------------- main
async function main() {
  log(`root=${ROOT} cli=${CLI} target=${TARGET} tmp=${TMP} broker=${brokerMode} url=${BROKER_URL}`);
  const nativeDir = join(ROOT, "packages", `client-${TARGET}`);
  const haveNative = existsSync(join(nativeDir, "bin", "messenger-client"));
  if (doNative && !haveNative) log(`WARNING: ${nativeDir}/bin/messenger-client missing — native checks will fail`);

  const registry = await startRegistry();
  // same set and order as the release: protocol (broker depends on it) → broker → client → platform
  const published = [
    registry.publish(join(ROOT, "packages", "protocol")),
    registry.publish(join(ROOT, "packages", "broker")),
    registry.publish(join(ROOT, "packages", "client")),
  ];
  if (haveNative) published.push(registry.publish(nativeDir));
  log(`mock registry ${registry.url}: ${published.map((p) => `${p.name}@${p.version} (${p.filename}, ${p.size} B)`).join("; ")}`);

  // broker
  let broker = null;
  let health;
  if (REMOTE_HOST) {
    health = await waitHealth(BROKER_URL, 5);
  } else if (brokerMode === "cli") {
    broker = await startBrokerCli(registry.url, join(TMP, "pkgs-broker"), PORT, true);
    health = broker.health;
  } else {
    broker = await startBrokerDirect();
    health = broker.health;
  }
  if (!check("broker: /health", health && health.status === "ok", health ? `v${health.version} id=${health.id} port=${health.port}` : `no broker at ${BROKER_URL}${broker ? `\n${broker.stderr()}` : ""}`)) return;
  if (broker && brokerMode === "cli") check("broker: installed through the cli", /ready: @unagents\/messenger-broker@/.test(broker.stderr()), broker.stderr().match(/ready: .*/)?.[0] ?? broker.stderr());

  // token required
  const unauth = await fetch(`${BROKER_URL}/list-peers`, { method: "POST", body: "{}" });
  check("broker: POST without token → 401", unauth.status === 401, `status ${unauth.status}`);

  const pkgs = join(TMP, "pkgs");

  // 1. discover
  if (!REMOTE_HOST) {
    const d = await runCli(["discover"], cliEnv(registry.url, pkgs));
    const okDiscover = d.status === 0 && /discovery: 1 broker\(s\) answered/.test(d.stdout) && d.stdout.includes(`resolved: ${BROKER_URL} (via discovery (`);
    check("cli discover: finds the broker via UDP", okDiscover, d.stdout.trim().split("\n").join(" | ") || d.stderr);
  } else {
    const d = await runCli(["discover"], cliEnv(registry.url, pkgs));
    check("cli discover: resolves via env", d.status === 0 && d.stdout.includes(`resolved: ${BROKER_URL} (via env)`), d.stdout.trim().split("\n").join(" | ") || d.stderr);
  }

  // 2. mcp native (auto: platform package preferred) + mcp node
  const pkgsNative = join(TMP, "pkgs-native");
  const a = doNative ? new Mcp("mcp native", cliEnv(registry.url, pkgsNative)) : null;
  const b = doNode ? new Mcp("mcp node", cliEnv(registry.url, pkgs, { AGENT_MESSENGER_CLIENT: "node" })) : null;
  const opened = [a, b].filter(Boolean);
  try {
    let pair = null; // [first, second, firstName, secondName] of mcpFlow
    if (a && b) {
      await mcpFlow(a, b, "e2e-native", "e2e-node");
      pair = [a, b, "e2e-native", "e2e-node"];
    } else if (a) {
      const x = new Mcp("mcp node (peer)", cliEnv(registry.url, pkgs, { AGENT_MESSENGER_CLIENT: "node" }));
      opened.push(x);
      await mcpFlow(a, x, "e2e-native", "e2e-node");
      pair = [a, x, "e2e-native", "e2e-node"];
    } else if (b) {
      const x = new Mcp("mcp node (peer)", cliEnv(registry.url, pkgs, { AGENT_MESSENGER_CLIENT: "node" }));
      opened.push(x);
      await mcpFlow(b, x, "e2e-node", "e2e-node2");
      pair = [b, x, "e2e-node", "e2e-node2"];
    }
    if (a) {
      check("mcp native: loader picked the platform package", loaderPicked(a) === NATIVE_PKG, `${loaderPicked(a)}; cache: ${cacheEntries(pkgsNative).join(", ")}`);
      check("mcp native: node client not installed for auto mode", !cacheEntries(pkgsNative).some((e) => e === "messenger-client@latest"), cacheEntries(pkgsNative).join(", "));
    }
    if (b) check("mcp node: loader picked the node client", loaderPicked(b) === "@unagents/messenger-client" || cacheEntries(pkgs).includes("messenger-client@latest"), `${loaderPicked(b)}; cache: ${cacheEntries(pkgs).join(", ")}`);

    // 3. session socket delivery
    const sockPath = join(TMP, "sess.sock");
    const sess = await startSessionSocket(sockPath);
    const c = new Mcp(a ? "mcp native (socket)" : "mcp node (socket)", cliEnv(registry.url, a ? pkgsNative : pkgs, {
      CLAUDE_CODE_MESSAGING_SOCKET: sockPath,
      CLAUDE_CODE_MESSAGING_TOKEN: "e2e-session-token",
      ...(a ? {} : { AGENT_MESSENGER_CLIENT: "node" }),
    }));
    opened.push(c);
    await c.initialize();
    await c.tool("set_name", { name: "e2e-socket" });
    const sender = b ?? a;
    const t3 = `socket test ${Date.now()}`;
    const s3 = await sender.tool("send_message", { to: "e2e-socket", message: t3 });
    check(`${sender.label} → socket peer: send_message`, !s3.isError, s3.text);
    for (let i = 0; i < 60 && !(sess.lines.length >= 2 && sess.ended()); i++) await sleep(100);
    let auth = null;
    let user = null;
    try {
      auth = JSON.parse(sess.lines[0] ?? "null");
      user = JSON.parse(sess.lines[1] ?? "null");
    } catch {
      // reported below
    }
    check("session socket: auth line", auth && auth.type === "auth" && auth.token === "e2e-session-token", sess.lines[0] ?? "(none)");
    check("session socket: user line (pull: unread notice)", user && user.type === "user" && user.message?.role === "user" && /^\[agent-messenger\] 未読 1 件/.test(user.message?.content ?? ""), (sess.lines[1] ?? "(none)").slice(0, 120));
    check("session socket: half-close after the two lines", sess.ended() && sess.lines.length === 2, `lines=${sess.lines.length} ended=${sess.ended()}`);
    check("session socket: client acknowledged", /Session socket unread notice OK/.test(c.stderr), c.stderr.match(/Session socket unread notice [^\n]*/)?.[0] ?? "(no log)");

    // delivery "push": the text itself arrives on the session socket
    const t3p = `socket push test ${Date.now()}`;
    const s3p = await sender.tool("send_message", { to: "e2e-socket", message: t3p, delivery: "push" });
    check(`${sender.label} → socket peer: send_message (push)`, !s3p.isError && /\(delivery: push\)/.test(s3p.text), s3p.text);
    for (let i = 0; i < 60 && !sess.lines.some((l) => l.includes(t3p)); i++) await sleep(100);
    const pushLine = sess.lines.find((l) => l.includes(t3p));
    let pushed = null;
    try {
      pushed = JSON.parse(pushLine ?? "null");
    } catch {
      // reported below
    }
    check("session socket: user line (push: message text)", pushed && pushed.type === "user" && pushed.message?.content?.startsWith("[agent-messenger] message from ") && pushed.message.content.includes(t3p), (pushLine ?? "(none)").slice(0, 120));
    check("session socket: client acknowledged (push)", /Session socket delivery OK/.test(c.stderr), c.stderr.match(/Session socket delivery [^\n]*/)?.[0] ?? "(no log)");
    sess.server.close();

    // 4. peers / status / send
    const env = cliEnv(registry.url, pkgs);
    const peers = await runCli(["peers"], env);
    const names = ["e2e-native", "e2e-node", "e2e-socket"].filter((n) => (a || n !== "e2e-native") && (b || n !== "e2e-node"));
    check("cli peers", peers.status === 0 && names.every((n) => new RegExp(`^\\S+  ${n}  `, "m").test(peers.stdout)), peers.stdout.trim().split("\n").filter((l) => !l.startsWith("    ")).join(" | ") || peers.stderr);
    const status = await runCli(["status"], env);
    check("cli status", status.status === 0 && new RegExp(`^Broker: ok v${health.version} id=${health.id} \\(${opened.length} peer\\(s\\)\\) at ${BROKER_URL.replace(/[.]/g, "\\.")} \\(via `, "m").test(status.stdout), status.stdout.split("\n")[0] || status.stderr);
    const target = b ?? a;
    const targetName = b ? "e2e-node" : "e2e-native";
    const t4 = `hello from cli ${Date.now()}`;
    const send = await runCli(["send", targetName, t4], env);
    check("cli send", send.status === 0 && send.stdout.startsWith(`Message sent to ${targetName} (`), send.stdout.trim() || send.stderr);
    const got = await target.tool("check_messages");
    const gotViaChannel = got.text.includes(t4) ? false : Boolean(await target.waitNotification((n) => n.method === "notifications/claude/channel" && n.params?.content === t4));
    check(`cli send: ${target.label} receives`, got.text.includes(t4) || gotViaChannel, got.text.includes(t4) ? "via check_messages" : gotViaChannel ? "via channel push" : got.text);
    const bad = await runCli(["send", "nobody-here", "x"], env);
    check("cli send: unknown peer fails", bad.status === 1 && /^Failed: /.test(bad.stderr), bad.stderr.trim());

    // 5. node fallback: platform package missing from the registry
    if (haveNative) {
      registry.unpublish(NATIVE_PKG);
      const pkgsFb = join(TMP, "pkgs-fallback");
      const f = new Mcp("mcp auto (no platform package)", cliEnv(registry.url, pkgsFb));
      opened.push(f);
      const fi = await f.initialize();
      check("fallback: mcp still answers initialize", fi.serverInfo?.name === "agent-messenger");
      check("fallback: loader reported the platform package missing", new RegExp(`${NATIVE_PKG.replace(/[/-]/g, "\\$&")} not available`).test(f.stderr), f.stderr.match(/not available[^\n]*/)?.[0] ?? f.stderr);
      check("fallback: loader ran the node client", loaderPicked(f) === "@unagents/messenger-client", `${loaderPicked(f)}; cache: ${cacheEntries(pkgsFb).join(", ")}`);
      const forced = await runCli(["mcp"], cliEnv(registry.url, join(TMP, "pkgs-forced"), { AGENT_MESSENGER_CLIENT: "native" }));
      check("fallback: AGENT_MESSENGER_CLIENT=native exits 1 when missing", forced.status === 1 && /cannot start|is not available/.test(forced.stderr), forced.stderr.trim().split("\n").pop());
      registry.publish(nativeDir);
    }

    // 7. protocol scenarios (design 8, 2-9)
    if (pair) {
      const o = new Mcp("mcp node (observer)", cliEnv(registry.url, pkgs, { AGENT_MESSENGER_CLIENT: "node" }));
      opened.push(o);
      await o.initialize();
      let restartBroker = null;
      if (broker) {
        restartBroker = async () => {
          broker.proc.kill("SIGTERM");
          const code = await broker.exited;
          check("protocol 9: broker SIGTERM → exit 0", code === 0, `exit=${code}`);
          broker = brokerMode === "cli" ? await startBrokerCli(registry.url, join(TMP, "pkgs-broker"), PORT, true) : await startBrokerDirect();
          check("protocol 9: broker restarted", broker.health && broker.health.status === "ok", broker.health ? `v${broker.health.version}` : broker.stderr());
        };
      }
      await protocolFlow(pair[0], pair[1], pair[2], pair[3], o, restartBroker);
    }
  } finally {
    for (const m of opened) {
      const code = await m.close();
      check(`${m.label}: stdin close → unregister → exit 0`, code === 0 && /Unregistered from broker/.test(m.stderr), `exit=${code}`);
    }
  }

  // mesh scenario (broker autonomy)
  if (!REMOTE_HOST) await meshFlow(registry.url, pkgs);

  // 6. `agent-messenger broker` through the mock registry (extra port; skipped when it already is the broker)
  if (brokerMode !== "cli" && !REMOTE_HOST) {
    const bc = await startBrokerCli(registry.url, join(TMP, "pkgs-broker"), PORT + 2, false);
    check("cli broker: installed from the mock registry and serves /health", bc.health && bc.health.status === "ok" && /ready: @unagents\/messenger-broker@/.test(bc.stderr()), bc.health ? `v${bc.health.version} ${bc.stderr().match(/ready: [^\n]*/)?.[0]}` : bc.stderr());
    const st = await runCli(["status"], cliEnv(registry.url, pkgs, { AGENT_MESSENGER_HOST: "127.0.0.1", AGENT_MESSENGER_PORT: String(PORT + 2) }));
    check("cli broker: cli status against it", st.status === 0 && st.stdout.startsWith("Broker: ok v"), st.stdout.split("\n")[0] || st.stderr);
    bc.proc.kill("SIGTERM");
    const code = await bc.exited;
    check("cli broker: SIGTERM → exit 0", code === 0, `exit=${code}`);
  }

  if (broker) {
    broker.proc.kill("SIGTERM");
    const code = await broker.exited;
    check("broker: SIGTERM → exit 0", code === 0, `exit=${code}`);
  }
  await registry.close();
}

main()
  .catch((e) => {
    fail("driver", e instanceof Error ? e.stack ?? e.message : String(e));
  })
  .finally(async () => {
    for (const p of children) {
      try {
        p.kill("SIGKILL");
      } catch {
        // gone
      }
    }
    await sleep(200);
    if (!process.env.E2E_KEEP) rmSync(TMP, { recursive: true, force: true });
    if (!process.env.E2E_KEEP) rmSync(PROTO_DIR, { recursive: true, force: true });
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${failed === 0 ? "E2E OK" : "E2E FAILED"}: ${passed} passed, ${failed} failed (${TARGET}, broker=${REMOTE_HOST ? "remote" : brokerMode})`);
    process.exit(failed === 0 ? 0 : 1);
  });
