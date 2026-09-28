import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import {
  HOST,
  PORT,
  CONFIG_FILE,
  DISCOVERY_ENABLED,
  DISCOVERY_PORT,
  DISCOVERY_ADDR,
  DISCOVERY_TIMEOUT_MS,
  isLocalHost,
} from "./config.js";
import { brokerHealth, setBrokerUrl } from "./client.js";

/**
 * Find the broker. Returns { url, host, source, isLocal } and sets the client URL.
 *
 *   1. env      AGENT_MESSENGER_HOST (+PORT)
 *   2. config   ~/.agent-messenger/config.json {"brokers": [...]}, first reachable
 *   3. discover UDP broadcast probe, first broker that answers
 *   4. local    127.0.0.1:PORT (caller may auto-launch)
 */
export async function resolveBroker(log = () => {}) {
  // 1. explicit
  if (HOST) {
    const url = `http://${HOST}:${PORT}`;
    return done({ url, host: HOST, source: "env", isLocal: isLocalHost(HOST) });
  }

  // 2. config file
  const configured = readConfigBrokers();
  for (const url of configured) {
    if (await brokerHealth(url, 1500)) {
      return done({ url, host: hostOf(url), source: `config ${CONFIG_FILE}`, isLocal: isLocalHost(hostOf(url)) });
    }
    log(`config broker not reachable: ${url}`);
  }

  // 3. discovery
  if (DISCOVERY_ENABLED) {
    const found = await discoverBrokers();
    if (found.length) {
      const b = found[0];
      return done({ url: b.url, host: b.host, source: `discovery (${b.id})`, isLocal: isLocalHost(b.host) });
    }
    log("discovery: no broker answered");
  }

  // 4. local
  const url = `http://127.0.0.1:${PORT}`;
  return done({ url, host: "127.0.0.1", source: "local fallback", isLocal: true });

  function done(r) {
    setBrokerUrl(r.url);
    return r;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** ~/.agent-messenger/config.json → ["http://host:port", ...] */
export function readConfigBrokers() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    const list = Array.isArray(cfg.brokers) ? cfg.brokers : cfg.broker ? [cfg.broker] : [];
    return list.filter((s) => typeof s === "string" && s.trim()).map(normalizeUrl);
  } catch {
    return [];
  }
}

function normalizeUrl(s) {
  s = s.trim();
  if (!/^https?:\/\//.test(s)) s = `http://${s}`;
  const u = new URL(s);
  if (!u.port) u.port = String(PORT);
  return u.origin;
}

/** Broadcast targets: explicit address, or 255.255.255.255 plus every IPv4 interface's directed broadcast. */
function probeTargets() {
  if (DISCOVERY_ADDR) return [DISCOVERY_ADDR];
  const targets = new Set(["255.255.255.255"]);
  for (const ifs of Object.values(networkInterfaces())) {
    for (const i of ifs ?? []) {
      if (i.family !== "IPv4" || i.internal || !i.netmask) continue;
      const ip = i.address.split(".").map(Number);
      const mask = i.netmask.split(".").map(Number);
      targets.add(ip.map((o, k) => (o & mask[k]) | (~mask[k] & 255)).join("."));
    }
  }
  return [...targets];
}

/**
 * Send a UDP probe and collect broker answers for DISCOVERY_TIMEOUT_MS.
 * Answers: {"agent-messenger":"broker","id":..,"port":..,"version":..}; the broker's
 * address is the packet's source address.
 */
export function discoverBrokers(timeoutMs = DISCOVERY_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = createSocket({ type: "udp4", reuseAddr: true });
    const found = new Map();
    const finish = () => {
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        // already closed
      }
      resolve([...found.values()]);
    };
    const timer = setTimeout(finish, timeoutMs);
    sock.on("error", finish);
    sock.on("message", (msg, rinfo) => {
      try {
        const m = JSON.parse(msg.toString());
        if (m["agent-messenger"] !== "broker" || !m.port) return;
        const host = rinfo.address;
        const url = `http://${host}:${m.port}`;
        if (!found.has(url)) found.set(url, { url, host, port: m.port, id: m.id ?? host, version: m.version ?? "" });
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
      const probe = Buffer.from(JSON.stringify({ "agent-messenger": "probe" }));
      for (const t of probeTargets()) {
        sock.send(probe, DISCOVERY_PORT, t, () => {});
      }
    });
  });
}
