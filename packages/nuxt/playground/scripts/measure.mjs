// Measurement driver for the playground (one command = one scenario; every process lives and dies inside it).
// Needed because each sandboxed shell command has its own network namespace, so a broker started in one command
// is not reachable from the next one.
//
// usage: PG_TMP=<isolated dir> node measure.mjs <scenario> <log-dir>
//   scenario: hook   (a, b1, b2, c, d1: no toolkit, one hook listener)
//             pull   (b3: no listener, app pulls via /api/check)
//             late   (SQ-1: a listener attached after startup; the next message goes to the hook)
//             mcp    (d2, d3, d4: toolkit before this module)
//             mcp-after (d5: toolkit after this module)
// Isolation: broker 127.0.0.1:17945, nuxt 127.0.0.1:17946, discovery off, autoStartBroker off, own HOME, empty env.
import { spawn } from "node:child_process";
import { createWriteStream, utimesSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const NUXT_PKG = resolve(here, "../..");
const WT = resolve(NUXT_PKG, "../..");
const PG_TMP = process.env.PG_TMP;
const scenario = process.argv[2];
const logDir = process.argv[3];
if (!PG_TMP || !scenario || !logDir) {
  console.error("usage: PG_TMP=<dir> node measure.mjs <hook|pull|mcp|mcp-after> <log-dir>");
  process.exit(2);
}
const BROKER = "http://127.0.0.1:17945";
const NUXT = "http://127.0.0.1:17946";
const PATH = "/usr/local/bin:/usr/bin:/bin";

const base = {
  HOME: join(PG_TMP, "home"),
  PATH,
  TMPDIR: join(PG_TMP, "tmp"),
  AGENT_MESSENGER_DISCOVERY: "off",
};
const cliEnv = {
  ...base,
  AGENT_MESSENGER_HOST: "127.0.0.1",
  AGENT_MESSENGER_PORT: "17945",
  AGENT_MESSENGER_CLIENT_SPEC: `file:${join(WT, "packages/client")}`,
  AGENT_MESSENGER_PKGS_DIR: join(PG_TMP, "pkgs"),
  AGENT_MESSENGER_REGISTRY: "http://127.0.0.1:9/",
  npm_config_cache: join(PG_TMP, "npm-cache"),
};
const CLI = join(WT, "packages/cli/dist/main.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);
const say = (s) => console.log(`[${stamp()}] ${s}`);
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  say(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`);
}

const procs = [];
function bg(label, cmd, args, env, logFile, opts = {}) {
  const out = createWriteStream(logFile);
  const p = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"], detached: true, ...opts });
  p.stdout.pipe(out, { end: false });
  p.stderr.pipe(out, { end: false });
  p.exited = new Promise((r) => p.on("exit", (c, s) => r(c ?? s)));
  procs.push({ label, p });
  say(`started ${label} pid=${p.pid}`);
  return p;
}
function killTree(p, sig = "SIGTERM") {
  try {
    process.kill(-p.pid, sig);
  } catch {
    // already gone
  }
}

function run(cmd, args, env, timeoutMs = 120000) {
  return new Promise((r) => {
    const p = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("exit", (code) => {
      clearTimeout(t);
      r({ code, out });
    });
  });
}
const cli = (...args) => run("node", [CLI, ...args], cliEnv);

async function peers() {
  const r = await cli("peers");
  return r.out.split("\n").filter((l) => l.includes("nuxt-pg"));
}
function pidOf(line) {
  return /PID:(\d+)/.exec(line)?.[1];
}
function idOf(line) {
  return line.trim().split(/\s+/)[0];
}

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(500);
  }
}

let nuxtLogPath = "";
async function nuxtLog() {
  const { readFileSync } = await import("node:fs");
  try {
    return readFileSync(nuxtLogPath, "utf8");
  } catch {
    return "";
  }
}
const count = (s, needle) => s.split(needle).length - 1;

async function get(path) {
  const r = await fetch(`${NUXT}${path}`);
  return { status: r.status, text: await r.text() };
}
async function mcpPost(body) {
  const r = await fetch(`${NUXT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  say(`mcp ${body.method ?? ""} -> HTTP ${r.status}\n${text}`);
  const data = text.split("\n").find((l) => l.startsWith("data:"));
  let json;
  try {
    json = JSON.parse(data ? data.slice(5).trim() : text);
  } catch {
    json = undefined;
  }
  return { status: r.status, text, json };
}

function startNuxt(extraEnv, name) {
  nuxtLogPath = join(logDir, name);
  return bg(
    "nuxt",
    "npm",
    ["--prefix", NUXT_PKG, "run", "dev", "--", "--host", "127.0.0.1", "--port", "17946"],
    { ...base, AGENT_MESSENGER_PORT: "17945", NUXT_TELEMETRY_DISABLED: "1", NITRO_NO_UNIX_SOCKET: "1", ...extraEnv },
    nuxtLogPath,
  );
}

async function main() {
  say(`scenario=${scenario} CI=${process.env.CI ?? "(unset)"}`);
  bg(
    "broker",
    "node",
    [join(WT, "packages/broker/dist/main.mjs")],
    {
      ...base,
      AGENT_MESSENGER_PORT: "17945",
      AGENT_MESSENGER_BIND: "127.0.0.1",
      AGENT_MESSENGER_STATE: join(PG_TMP, "home", "broker.json"),
      AGENT_MESSENGER_BROKER_ID: "nuxt-pg",
    },
    join(logDir, `${scenario}-broker.log`),
  );
  await waitFor(async () => (await fetch(`${BROKER}/health`).then((r) => r.ok, () => false)), 20000, "broker");
  say("broker up");

  const epoch = Date.now();
  if (scenario === "hook") await scenarioHook(epoch);
  else if (scenario === "pull") await scenarioPull(epoch);
  else if (scenario === "late") await scenarioLate(epoch);
  else if (scenario === "mcp" || scenario === "mcp-after") await scenarioMcp(epoch);
  else throw new Error(`unknown scenario ${scenario}`);
}

async function ready() {
  await waitFor(async () => (await fetch(`${NUXT}/api/received`).then((r) => r.ok, () => false)), 180000, "nuxt");
  say("nuxt up");
}

async function scenarioHook(epoch) {
  startNuxt({}, "hook-nuxt.log");
  await ready();
  // (a1)
  const l1 = await waitFor(async () => {
    const l = await peers();
    return l.length ? l : null;
  }, 30000, "peer nuxt-pg");
  check("a1 peers shows nuxt-pg exactly once", l1.length === 1, l1.join(" | "));
  say(`a1 id=${idOf(l1[0])} pid=${pidOf(l1[0])}`);
  say(`mode line: ${(await nuxtLog()).split("\n").filter((l) => l.includes("connected as")).join(" || ")}`);
  say(`broker line: ${(await nuxtLog()).split("\n").filter((l) => l.includes("broker=")).join(" || ")}`);

  // (b1)
  const t1 = `hello-b-${epoch}`;
  const s1 = await cli("send", "nuxt-pg", t1);
  say(`send: ${s1.out.trim()}`);
  await waitFor(async () => (await nuxtLog()).includes(`text=${t1}`), 10000, "hook delivery b1");
  const rec = await get("/api/received");
  check("b1 CLI send reached messenger:message hook", (await nuxtLog()).includes(`text=${t1}`) && rec.text.includes(t1), rec.text);

  // (b2)
  const t2 = `FAIL-ONCE-${epoch}`;
  await cli("send", "nuxt-pg", t2);
  await waitFor(async () => (await get("/api/received")).text.includes(t2), 15000, "redelivery b2");
  await sleep(5000);
  const log2 = await nuxtLog();
  const rec2 = await get("/api/received");
  const failN = count(log2, "failing once");
  const retryN = count(log2, "will retry");
  const okN = count(rec2.text, t2);
  check("b2 failing listener -> retried once -> delivered once -> no more redelivery", failN === 1 && retryN === 1 && okN === 1, `failing=${failN} retry-log=${retryN} delivered=${okN}`);

  // (c)
  const tc = `hello-c-${epoch}`;
  const peer = bg(
    "cli-peer",
    "node",
    [join(here, "cli-peer.mjs"), CLI, tc, "60000"],
    { ...cliEnv, AGENT_MESSENGER_CLIENT: "node", AGENT_MESSENGER_NAME: "cli-pg", AGENT_MESSENGER_BROKER_CMD: "/bin/false" },
    join(logDir, "hook-cli-peer.log"),
  );
  await waitFor(async () => (await cli("peers")).out.includes("cli-pg"), 30000, "cli-pg registered");
  const sr = await get(`/api/send?to=cli-pg&text=${tc}`);
  say(`/api/send -> ${sr.status} ${sr.text}`);
  const code = await Promise.race([peer.exited, sleep(70000).then(() => "timeout")]);
  check("c useMessenger().send received on CLI side (check_messages shows marker)", code === 0 && sr.status === 200, `send=${sr.text} cli-peer exit=${code}`);

  // (d1) toolkit absent
  const r = await fetch(`${NUXT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = await r.text();
  say(`/mcp without toolkit -> HTTP ${r.status} ${body.slice(0, 200)}`);
  // In the sandbox an unmatched route falls through to the Nuxt renderer, which talks to Vite over a unix socket
  // (connect EPERM -> HTTP 500), so a plain 404 cannot be observed here. Evidence instead: the response is not a
  // JSON-RPC answer, and the Nitro dev bundle holds no toolkit handler.
  const { readFileSync } = await import("node:fs");
  const bundle = readFileSync(join(NUXT_PKG, "playground/.nuxt/dev/index.mjs"), "utf8");
  check(
    "d1 /mcp is absent without the toolkit (not a JSON-RPC answer; no toolkit in the nitro bundle)",
    !body.includes('"jsonrpc"') && r.status !== 200 && !bundle.includes("mcp-toolkit") && !/from ['"]zod/.test(bundle),
    `HTTP ${r.status}; bundle=playground/.nuxt/dev/index.mjs mcp-toolkit hits=${bundle.split("mcp-toolkit").length - 1} zod-import hits=${(bundle.match(/from ['"]zod/g) ?? []).length}`,
  );

  // (a2) worker reload
  const log0 = await nuxtLog();
  const reg0 = count(log0, "Registered as peer");
  const unreg0 = count(log0, "Unregistered from broker");
  const now = new Date();
  utimesSync(join(NUXT_PKG, "playground/server/plugins/messages.ts"), now, now);
  await waitFor(async () => count(await nuxtLog(), "Registered as peer") > reg0, 60000, "re-register after reload");
  await sleep(3000);
  const l2 = await peers();
  check("a2 after worker reload: nuxt-pg exactly once", l2.length === 1, l2.join(" | "));
  say(`a2 id ${idOf(l1[0])} -> ${idOf(l2[0] ?? " ")} ; pid ${pidOf(l1[0])} -> ${pidOf(l2[0] ?? "")}`);
  await sleep(25000);
  const l2b = await peers();
  check("a2 after >20 s: still once, same id (no eviction round trip)", l2b.length === 1 && l2.length === 1 && idOf(l2b[0]) === idOf(l2[0]), l2b.join(" | "));
  const log2a = await nuxtLog();
  say(`registered=${count(log2a, "Registered as peer")} (was ${reg0}) unregistered=${count(log2a, "Unregistered from broker")} (was ${unreg0})`);

  // (a3) full restart
  const regA = count(log2a, "Registered as peer");
  const now2 = new Date();
  utimesSync(join(NUXT_PKG, "playground/nuxt.config.ts"), now2, now2);
  await waitFor(async () => count(await nuxtLog(), "Registered as peer") > regA, 120000, "re-register after full restart");
  await sleep(3000);
  const l3 = await peers();
  check("a3 after full restart: nuxt-pg exactly once", l3.length === 1, l3.join(" | "));
  say(`a3 id ${idOf(l2b[0])} -> ${idOf(l3[0] ?? " ")} ; pid ${pidOf(l2b[0])} -> ${pidOf(l3[0] ?? "")} (pid changed: ${pidOf(l2b[0]) !== pidOf(l3[0] ?? "")})`);
  await sleep(25000);
  const l3b = await peers();
  check("a3 after >20 s: still once, same id", l3b.length === 1 && idOf(l3b[0]) === idOf(l3[0] ?? " "), l3b.join(" | "));
  const log3 = await nuxtLog();
  say(`registered=${count(log3, "Registered as peer")} unregistered=${count(log3, "Unregistered from broker")}`);
}

async function scenarioPull(epoch) {
  startNuxt({ PG_NO_LISTENER: "1" }, "pull-nuxt.log");
  await ready();
  const l1 = await waitFor(async () => {
    const l = await peers();
    return l.length ? l : null;
  }, 30000, "peer nuxt-pg");
  check("pull: peers shows nuxt-pg once", l1.length === 1, l1.join(" | "));
  const modeLine = (await nuxtLog()).split("\n").filter((l) => l.includes("connected as")).join(" || ");
  check("b3 start log says mode: pull", modeLine.includes("mode: pull"), modeLine);
  const t = `hello-pull-${epoch}`;
  await cli("send", "nuxt-pg", t);
  await sleep(3000); // several poll ticks: a consuming handler would have acked it by now
  const chk = await get("/api/check");
  say(`/api/check -> ${chk.status} ${chk.text}`);
  check("b3 message stays pullable and checkMessages() returns it", chk.status === 200 && chk.text.includes(t));
  const again = await get("/api/check");
  check("b3 second check is empty (acked by the pull)", again.text === "[]", again.text);
}

async function scenarioLate(epoch) {
  startNuxt({ PG_NO_LISTENER: "1" }, "late-nuxt.log");
  await ready();
  await waitFor(async () => ((await peers()).length ? true : null), 30000, "peer nuxt-pg");
  check("late: starts in pull mode", (await nuxtLog()).includes("mode: pull"));
  const a = `late-A-${epoch}`;
  await cli("send", "nuxt-pg", a);
  await sleep(3000);
  const r0 = await get("/api/received");
  check("late: before any listener the message is not delivered to a hook", r0.text === "[]", r0.text);
  const at = await get("/api/listen");
  say(`/api/listen -> ${at.text}`);
  const b = `late-B-${epoch}`;
  await cli("send", "nuxt-pg", b);
  await waitFor(async () => (await get("/api/received")).text.includes(b), 15000, "hook delivery of B");
  const r1 = await get("/api/received");
  check("late: after the listener appeared the next message goes to the hook", r1.text.includes(b), r1.text);
  check("late: the unread backlog (A) flows to the hook too", r1.text.includes(a));
  const chk = await get("/api/check");
  check("late: nothing is left to pull", chk.text === "[]", chk.text);
}

async function scenarioMcp(epoch) {
  startNuxt({ PG_MCP: "1", ...(scenario === "mcp-after" ? { PG_MCP_ORDER: "after" } : {}) }, `${scenario}-nuxt.log`);
  await waitFor(async () => (await fetch(`${NUXT}/mcp`, { method: "GET" }).then((r) => r.status > 0, () => false)), 180000, "nuxt /mcp");
  say("nuxt up");
  const l1 = await waitFor(async () => {
    const l = await peers();
    return l.length ? l : null;
  }, 30000, "peer nuxt-pg");
  check(`${scenario}: peers shows nuxt-pg once (module loaded with toolkit)`, l1.length === 1, l1.join(" | "));
  const init = await mcpPost({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pg", version: "0" } } });
  check(`${scenario}: initialize ok`, init.status === 200 && Boolean(init.json?.result), `HTTP ${init.status}`);
  const list = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = list.json?.result?.tools ?? [];
  const names = tools.map((t) => t.name).sort();
  const want = ["check_messages", "list_peers", "send_message", "send_ping", "set_name", "set_summary"];
  check(`${scenario}: tools/list has the 6 tools`, JSON.stringify(names) === JSON.stringify(want), names.join(","));
  const titlesOk = tools.every((t) => /\(v\d+\.\d+\.\d+\)$/.test(t.title ?? t.annotations?.title ?? ""));
  const descOk = tools.every((t) => (t.description ?? "").startsWith("[agent-messenger v"));
  check(`${scenario}: titles "<name> (vX)" and descriptions "[agent-messenger vX] ..."`, titlesOk && descOk);
  const send = tools.find((t) => t.name === "send_message");
  const dp = send?.inputSchema?.properties?.delivery;
  check(`${scenario}: send_message.delivery is a plain string (no enum)`, dp?.type === "string" && dp?.enum === undefined, JSON.stringify(dp));
  const bad = await mcpPost({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send_message", arguments: { to: "cli-pg", message: "x", delivery: "bogus" } } });
  const badText = bad.json?.result?.content?.[0]?.text;
  check(`${scenario}: bad delivery -> isError + exact Invalid delivery text`, bad.json?.result?.isError === true && badText === 'Invalid delivery: bogus (use "pull" or "push")', String(badText));
  const lp = await mcpPost({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_peers", arguments: {} } });
  const lpText = lp.json?.result?.content?.[0]?.text ?? "";
  check(`${scenario}: list_peers reaches the client`, /Found \d+ peer\(s\)|No other sessions found/.test(lpText), lpText.split("\n")[0]);
  void epoch;
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  say(`ERROR ${e?.stack ?? e}`);
} finally {
  for (const { label, p } of procs.slice().reverse()) {
    if (label === "nuxt") {
      killTree(p, "SIGTERM");
      const done = await Promise.race([p.exited.then(() => true), sleep(15000).then(() => false)]);
      if (!done) killTree(p, "SIGKILL");
    } else {
      killTree(p, "SIGTERM");
    }
  }
  await sleep(1500);
  for (const { label, p } of procs) {
    let alive = true;
    try {
      process.kill(p.pid, 0);
    } catch {
      alive = false;
    }
    say(`cleanup ${label} pid=${p.pid} alive=${alive}`);
    if (alive) killTree(p, "SIGKILL");
  }
}
const bad = results.filter((r) => !r.ok);
say(`SUMMARY ${results.length - bad.length}/${results.length} passed${failed ? " (script error)" : ""}`);
process.exit(failed || bad.length ? 1 : 0);
