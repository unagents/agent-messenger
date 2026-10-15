import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import type { DiscoveryReply } from "@agent-hand/messenger-protocol";
import { DISCOVERY_BROADCAST_ADDR, DISCOVERY_KEY, DISCOVERY_PROBE_VALUE, DISCOVERY_REPLY_VALUE } from "./constants.js";
import type { BrokerClient } from "./broker.js";
import type { ClientConfig } from "./config.js";
import { isLocalHost } from "./config.js";

export interface ResolvedBroker {
  url: string;
  host: string;
  /** `"env"` / `"config <file>"` / `"discovery (<id>)"` / `"local fallback"` */
  source: string;
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
}

export type Logger = (msg: string) => void;

/**
 * Find the broker (same order as the current `legacy/src/resolve.js`) and set the client URL.
 *
 *   1. env      AGENT_MESSENGER_HOST (+PORT)
 *   2. config   ~/.agent-messenger/config.json {"brokers": [...]}, first reachable
 *   3. discover UDP broadcast probe, first broker that answers
 *   4. local    127.0.0.1:PORT (caller may auto-launch)
 */
export async function resolveBroker(cfg: ClientConfig, broker: BrokerClient, log: Logger): Promise<ResolvedBroker> {
  const done = (r: ResolvedBroker): ResolvedBroker => {
    broker.setUrl(r.url);
    return r;
  };

  // 1. explicit
  if (cfg.host) {
    const url = `http://${cfg.host}:${cfg.port}`;
    return done({ url, host: cfg.host, source: "env", isLocal: isLocalHost(cfg.host) });
  }

  // 2. config file
  const configured = readConfigBrokers(cfg);
  for (const url of configured) {
    if (await broker.health(url, 1500)) {
      const host = hostOf(url);
      return done({ url, host, source: `config ${cfg.configFile}`, isLocal: isLocalHost(host) });
    }
    log(`config broker not reachable: ${url}`);
  }

  // 3. discovery
  if (cfg.discoveryEnabled) {
    const found = await discoverBrokers(cfg);
    if (found.length) {
      // a real broker beats a fallback; discoverBrokers sorts them first
      const b = found[0];
      return done({ url: b.url, host: b.host, source: `discovery (${b.id})`, isLocal: isLocalHost(b.host) });
    }
    log("discovery: no broker answered");
  }

  // 4. local
  const url = `http://127.0.0.1:${cfg.port}`;
  return done({ url, host: "127.0.0.1", source: "local fallback", isLocal: true });
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
      if (typeof s === "string" && s.trim()) out.push(normalizeUrl(s, cfg.port));
    }
    return out;
  } catch {
    return [];
  }
}

function normalizeUrl(s: string, defaultPort: number): string {
  s = s.trim();
  if (!/^https?:\/\//.test(s)) s = `http://${s}`;
  const u = new URL(s);
  if (!u.port) u.port = String(defaultPort);
  return u.origin;
}

/** Broadcast targets: explicit address, or 255.255.255.255 plus every IPv4 interface's directed broadcast. */
function probeTargets(cfg: ClientConfig): string[] {
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
      resolve([...found.values()].sort((a, b) => Number(a.fallback) - Number(b.fallback)));
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
          found.set(url, { url, host, port: m.port, id: m.id ?? host, version: m.version ?? "", fallback: m.fallback === true });
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
        sock.send(probe, cfg.discoveryPort, t, () => {});
      }
    });
  });
}
