import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import type { DiscoveryReply } from "@unagents/messenger-protocol";
import { DEFAULT_HTTP_PORT, DISCOVERY_BROADCAST_ADDR, DISCOVERY_KEY, DISCOVERY_PROBE_VALUE, DISCOVERY_REPLY_VALUE } from "./constants.js";
import type { BrokerClient } from "./broker.js";
import type { ClientConfig } from "./config.js";
import { isLocalHost } from "./config.js";
import { brokerError } from "./protocol-error.js";
import { readSavedBroker } from "./saved-broker.js";

/** Where the current broker came from (vocabulary of `get_broker`'s `source`). */
export type BrokerKind = "env" | "saved" | "discovery" | "fallback" | "set_broker";

export interface ResolvedBroker {
  url: string;
  host: string;
  /** `"env"` / `"set_broker"` / `"saved <file>"` / `"config <file>"` / `"config (options)"` / `"discovery (<id>)"` / `"local fallback"` (log text) */
  source: string;
  /** Same thing as a fixed word: `env` / `saved` (client.json, legacy config.json, `options.brokers`) / `discovery` / `fallback` / `set_broker`. */
  kind: BrokerKind;
  isLocal: boolean;
}

export interface DiscoveredBroker {
  url: string;
  host: string;
  port: number;
  id: string;
  version: string;
  /** The broker is a local fallback (it will hand over to a real broker and exit). */
  fallback: boolean;
  /** The broker takes part in the mesh (`mesh: true` in its reply). */
  mesh: boolean;
}

export type Logger = (msg: string) => void;

/** `config.json brokers` deprecation is logged once per file and process. */
const warnedLegacyConfig = new Set<string>();

/**
 * Find the broker and set the client URL.
 *
 *   0. pin      `set_broker(url)` for this session (`pin`)
 *   1. env      AGENT_MESSENGER_HOST (+PORT)
 *   2. saved    `client.json` broker, then (legacy) `config.json` `brokers` / `options.brokers`; first reachable
 *   3. discover UDP probe: a real broker beats a fallback, a mesh broker beats a non-mesh one
 *   4. local    127.0.0.1:PORT (caller may auto-launch)
 */
export async function resolveBroker(
  cfg: ClientConfig,
  broker: BrokerClient,
  log: Logger,
  brokers?: string[],
  pin?: string | null
): Promise<ResolvedBroker> {
  const done = (r: ResolvedBroker): ResolvedBroker => {
    broker.setUrl(r.url);
    return r;
  };

  // 0. pinned by set_broker (the caller decides when a pin is dropped)
  if (pin) {
    const host = hostOf(pin);
    return done({ url: pin, host, source: "set_broker", kind: "set_broker", isLocal: isLocalHost(host) });
  }

  // 1. explicit
  if (cfg.host) {
    const url = `http://${cfg.host}:${cfg.port}`;
    return done({ url, host: cfg.host, source: "env", kind: "env", isLocal: isLocalHost(cfg.host) });
  }

  // 2. saved: client.json, then the legacy config file (or the library option)
  const saved = readSavedBroker(cfg);
  const candidates: { url: string; source: string }[] = [];
  if (saved) {
    try {
      candidates.push({ url: normalizeBrokerUrl(saved, cfg.port), source: `saved ${cfg.clientFile}` });
    } catch {
      log(`saved broker is not a valid URL: ${saved}`);
    }
  }
  if (brokers === undefined) {
    for (const url of readConfigBrokers(cfg)) candidates.push({ url, source: `config ${cfg.configFile}` });
  } else {
    for (const s of brokers) candidates.push({ url: normalizeBrokerUrl(s, cfg.port), source: "config (options)" });
  }
  for (const c of candidates) {
    if (await broker.health(c.url, 1500)) {
      if (c.source.startsWith("config ") && c.source !== "config (options)" && !warnedLegacyConfig.has(cfg.configFile)) {
        warnedLegacyConfig.add(cfg.configFile);
        log("config.json brokers is deprecated; use set_broker(url, persist: true)");
      }
      const host = hostOf(c.url);
      return done({ url: c.url, host, source: c.source, kind: "saved", isLocal: isLocalHost(host) });
    }
    log(`${c.source.startsWith("saved") ? "saved" : "config"} broker not reachable: ${c.url}`);
  }

  // 3. discovery
  if (cfg.discoveryEnabled) {
    const found = await discoverBrokers(cfg);
    if (found.length) {
      // a real broker beats a fallback, a mesh broker beats a plain one; discoverBrokers sorts them first
      const b = found[0];
      return done({ url: b.url, host: b.host, source: `discovery (${b.id})`, kind: "discovery", isLocal: isLocalHost(b.host) });
    }
    log("discovery: no broker answered");
  }

  // 4. local
  const url = `http://127.0.0.1:${cfg.port}`;
  return done({ url, host: "127.0.0.1", source: "local fallback", kind: "fallback", isLocal: true });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** ~/.agent-messenger/config.json → ["http://host:port", ...] */
export function readConfigBrokers(cfg: ClientConfig): string[] {
  try {
    const parsed = JSON.parse(readFileSync(cfg.configFile, "utf8")) as { brokers?: unknown; broker?: unknown };
    const list: unknown[] = Array.isArray(parsed.brokers) ? parsed.brokers : parsed.broker ? [parsed.broker] : [];
    const out: string[] = [];
    for (const s of list) {
      if (typeof s === "string" && s.trim()) out.push(normalizeBrokerUrl(s, cfg.port));
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * `host`, `host:port` or `http://host[:port]` → `http://host:port` (default port 7901). Only http is supported;
 * anything else throws `INVALID_BROKER_URL`.
 */
export function normalizeBrokerUrl(s: string, defaultPort: number = DEFAULT_HTTP_PORT): string {
  const raw = s.trim();
  try {
    if (raw === "" || /\s/.test(raw)) throw new Error("empty or has whitespace");
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
    if (hasScheme && !/^http:\/\//i.test(raw)) throw new Error("not http");
    const u = new URL(hasScheme ? raw : `http://${raw}`);
    if (!u.hostname) throw new Error("no host");
    if (!u.port) u.port = String(defaultPort);
    return u.origin;
  } catch {
    throw brokerError("INVALID_BROKER_URL", `Invalid broker URL: ${s}`);
  }
}

/** Probe targets: explicit `host:port` list, else the pinned address, else 255.255.255.255 plus every IPv4 interface's directed broadcast. */
function probeTargets(cfg: ClientConfig): { host: string; port: number }[] {
  const explicit: { host: string; port: number }[] = [];
  for (const s of cfg.discoveryTargets) {
    const i = s.lastIndexOf(":");
    const port = Number(s.slice(i + 1));
    if (i > 0 && Number.isInteger(port) && port >= 1 && port <= 65535) explicit.push({ host: s.slice(0, i), port });
  }
  if (explicit.length) return explicit;
  return broadcastHosts(cfg).map((host) => ({ host, port: cfg.discoveryPort }));
}

function broadcastHosts(cfg: ClientConfig): string[] {
  if (cfg.discoveryAddr) return [cfg.discoveryAddr];
  const targets = new Set<string>([DISCOVERY_BROADCAST_ADDR]);
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    const list = ifaces[name] ?? [];
    for (const i of list) {
      if (i.family !== "IPv4" || i.internal || !i.netmask) continue;
      const ip = i.address.split(".").map(Number);
      const mask = i.netmask.split(".").map(Number);
      const parts: string[] = [];
      for (let k = 0; k < 4; k++) parts.push(String((ip[k] & mask[k]) | (~mask[k] & 255)));
      targets.add(parts.join("."));
    }
  }
  return [...targets];
}

/** Non-fallback first, then mesh first; equal rank keeps arrival order (Array.sort is stable). */
export function rankBrokers(list: DiscoveredBroker[]): DiscoveredBroker[] {
  return list.slice().sort((a, b) => Number(a.fallback) - Number(b.fallback) || Number(b.mesh) - Number(a.mesh));
}

/**
 * Send a UDP probe and collect broker answers for `discoveryTimeoutMs`.
 * Answers: {"agent-messenger":"broker","id":..,"port":..,"version":..}; the broker's
 * address is the packet's source address.
 */
export function discoverBrokers(cfg: ClientConfig, timeoutMs = cfg.discoveryTimeoutMs): Promise<DiscoveredBroker[]> {
  return new Promise<DiscoveredBroker[]>((resolve) => {
    const sock = createSocket({ type: "udp4", reuseAddr: true });
    const found = new Map<string, DiscoveredBroker>();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        // already closed
      }
      resolve(rankBrokers([...found.values()]));
    };
    const timer = setTimeout(finish, timeoutMs);
    sock.on("error", finish);
    sock.on("message", (msg, rinfo) => {
      try {
        const m = JSON.parse(msg.toString()) as Partial<DiscoveryReply>;
        if (m[DISCOVERY_KEY] !== DISCOVERY_REPLY_VALUE || !m.port) return;
        const host = rinfo.address;
        const url = `http://${host}:${m.port}`;
        if (!found.has(url)) {
          found.set(url, { url, host, port: m.port, id: m.id ?? host, version: m.version ?? "", fallback: m.fallback === true, mesh: m.mesh === true });
        }
      } catch {
        // not ours
      }
    });
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
      } catch {
        // some platforms refuse; directed sends still work
      }
      const probe = Buffer.from(JSON.stringify({ [DISCOVERY_KEY]: DISCOVERY_PROBE_VALUE }));
      for (const t of probeTargets(cfg)) {
        sock.send(probe, t.port, t.host, () => {});
      }
    });
  });
}
