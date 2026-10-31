/**
 * Sub-command bodies. Output text is the same as `legacy/bin/agent-messenger.js`.
 */
import { spawnSync } from "node:child_process";
import type { Peer } from "@unagents/messenger-protocol";
import type { BrokerClientLike, ClientModule } from "./client-module.js";
import { loadClientModule } from "./client-module.js";
import type { LoaderConfig } from "./config.js";
import { BROKER_NAME, CLIENT_NAME, nativeClientName } from "./config.js";
import type { InstalledPackage } from "./pkgs.js";
import { ensurePackage, resolveBin, resolveEntry } from "./pkgs.js";
import { runChild } from "./run.js";

const log = (m: string) => console.error(`[agent-messenger] ${m}`);

/** Cached node client package (`@unagents/messenger-client`). Exits when it cannot be obtained. */
function nodeClient(cfg: LoaderConfig): InstalledPackage {
  return ensurePackage(cfg, CLIENT_NAME, cfg.clientSpec) as InstalledPackage;
}

/**
 * `mcp`: run the client. Native platform package first
 * (`@unagents/messenger-client-<platform>-<arch>`), else the node client;
 * `AGENT_MESSENGER_CLIENT=node|native` forces one flavour.
 * Without the `native` force, the native executable is first run with
 * `--version`; when that fails (e.g. a newer glibc is required) the node
 * client is used instead.
 */
export async function runMcp(cfg: LoaderConfig): Promise<void> {
  if (cfg.clientMode !== "node") {
    const name = nativeClientName();
    const native = ensurePackage(cfg, name, cfg.clientSpec, { optional: cfg.clientMode !== "native" });
    const bin = native ? resolveBin(native.pkgDir) : null;
    if (bin) {
      if (cfg.clientMode === "native") return runChild(bin, []);
      const failure = probeNative(bin);
      if (!failure) return runChild(bin, []);
      console.error(`[agent-messenger loader] ${name} cannot run on this host (${failure}), using node client`);
    }
    if (cfg.clientMode === "native") {
      console.error(`[agent-messenger loader] ${native ? `${name} has no bin entry` : `${name} is not available`}`);
      process.exit(1);
    }
    if (native && !bin) console.error(`[agent-messenger loader] ${name} has no bin entry, using node client`);
  }
  const client = nodeClient(cfg);
  return runChild(process.execPath, [resolveEntry(client.pkgDir, "./main")]);
}

/** Run the native client with `--version`; `null` when it works, else a one-line reason. */
function probeNative(bin: string): string | null {
  const r = spawnSync(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"], timeout: 5000, encoding: "utf8" });
  if (r.error) return r.error.message;
  if (r.status === 0) return null;
  const first = `${r.stderr ?? ""}`.trim().split("\n")[0] ?? "";
  return first || (r.signal ? `signal ${r.signal}` : `exit ${r.status}`);
}

/** `broker`: run `@unagents/messenger-broker/main` (handles SIGINT / SIGTERM → close → exit 0). */
export async function runBroker(cfg: LoaderConfig): Promise<void> {
  const broker = ensurePackage(cfg, BROKER_NAME, cfg.brokerSpec) as InstalledPackage;
  return runChild(process.execPath, [resolveEntry(broker.pkgDir, "./main")]);
}

interface Session {
  mod: ClientModule;
  cfg: ReturnType<ClientModule["loadConfig"]>;
  broker: BrokerClientLike;
}

async function session(cfg: LoaderConfig): Promise<Session> {
  const mod = await loadClientModule(nodeClient(cfg).pkgDir);
  const clientCfg = mod.loadConfig(process.env);
  return { mod, cfg: clientCfg, broker: mod.createBrokerClient(clientCfg.token) };
}

function printPeers(peers: Peer[]): void {
  if (peers.length === 0) {
    console.log("No peers registered.");
    return;
  }
  for (const p of peers) {
    console.log(`${p.id}  ${p.name || "-"}  ${p.hostname}  PID:${p.pid}  ${p.cwd}`);
    if (p.summary) console.log(`    ${p.summary}`);
    console.log(`    last seen: ${p.last_seen}`);
  }
}

const listPeers = (broker: BrokerClientLike) => broker.post("/list-peers", { scope: "all", cwd: "/", git_root: null });

export async function runStatus(cfg: LoaderConfig): Promise<void> {
  const s = await session(cfg);
  const r = await s.mod.resolveBroker(s.cfg, s.broker, log);
  const h = await s.broker.health();
  if (!h) {
    console.log(`Broker at ${s.broker.getUrl()} (via ${r.source}) is not running.`);
    process.exit(1);
  }
  console.log(`Broker: ${h.status} v${h.version} id=${h.id ?? "-"} (${h.peers} peer(s)) at ${s.broker.getUrl()} (via ${r.source})`);
  if (h.peers > 0) printPeers(await listPeers(s.broker));
}

export async function runPeers(cfg: LoaderConfig): Promise<void> {
  const s = await session(cfg);
  await s.mod.resolveBroker(s.cfg, s.broker, log);
  printPeers(await listPeers(s.broker));
}

export async function runSend(cfg: LoaderConfig, rawArgs: string[]): Promise<void> {
  const [to, ...words] = rawArgs;
  const message = words.join(" ");
  if (!to || !message) {
    console.error("Usage: agent-messenger send <name|id> <message...>");
    process.exit(1);
  }
  const s = await session(cfg);
  await s.mod.resolveBroker(s.cfg, s.broker, log);
  const r = await s.broker.post("/send-message", { from_id: "cli", from_name: "cli", to, text: message });
  if (!r.ok) {
    console.error(`Failed: ${r.error}`);
    process.exit(1);
  }
  console.log(`Message sent to ${r.to_name ? `${r.to_name} (${r.to_id})` : r.to_id}`);
}

export async function runDiscover(cfg: LoaderConfig): Promise<void> {
  const s = await session(cfg);
  const found = await s.mod.discoverBrokers(s.cfg);
  console.log(`discovery: ${found.length} broker(s) answered`);
  for (const b of found) console.log(`  ${b.id}  ${b.url}  v${b.version}`);
  const r = await s.mod.resolveBroker(s.cfg, s.broker, log);
  console.log(`resolved: ${r.url} (via ${r.source})`);
}
