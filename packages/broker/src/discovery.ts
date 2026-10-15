import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { DISCOVERY_KEY, DISCOVERY_PROBE_VALUE, DISCOVERY_REPLY_VALUE, type DiscoveryReply } from "@agent-hand/messenger-protocol";
import { log } from "./log.js";

export interface DiscoveryResponderOptions {
  port: number;
  /** `AGENT_MESSENGER_DISCOVERY_ADDR`; when set and not a `.255` broadcast address the socket binds to it. */
  addr: string;
  reply: () => DiscoveryReply;
}

/**
 * UDP discovery responder: answer `{"agent-messenger":"probe"}` with our
 * id / port / version so clients on the LAN can find us without configuration.
 * Transcribed from `legacy/src/broker.js`.
 */
export function startDiscoveryResponder(opts: DiscoveryResponderOptions): Promise<Socket> {
  const disco = createSocket({ type: "udp4", reuseAddr: true });
  disco.on("error", (e) => log.warn(`discovery responder error: ${e.message}`));
  disco.on("message", (msg, rinfo) => {
    try {
      if ((JSON.parse(msg.toString()) as Record<string, unknown>)[DISCOVERY_KEY] !== DISCOVERY_PROBE_VALUE) return;
    } catch {
      return;
    }
    const reply = Buffer.from(JSON.stringify(opts.reply()));
    disco.send(reply, rinfo.port, rinfo.address, () => {});
  });
  // bind to the discovery address when one is pinned (tests use 127.0.0.1), else all interfaces
  const bindAddr = opts.addr && !opts.addr.endsWith(".255") ? opts.addr : "0.0.0.0";
  return new Promise((resolve) => {
    // a bind failure is reported through the "error" handler above; the broker keeps running
    disco.once("error", () => resolve(disco));
    disco.bind(opts.port, bindAddr, () => {
      try {
        disco.setBroadcast(true);
      } catch {
        // not needed for replies
      }
      log.info(`discovery responder on udp ${bindAddr}:${opts.port} (id: ${opts.reply().id})`);
      resolve(disco);
    });
  });
}

export interface FoundBroker {
  url: string;
  host: string;
  port: number;
  id: string;
  version: string;
  fallback: boolean;
}

/** Probe targets: the pinned address, else 255.255.255.255 plus every IPv4 interface's directed broadcast (as the client does). */
function probeTargets(addr: string): string[] {
  if (addr) return [addr];
  const targets = new Set<string>(["255.255.255.255"]);
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal || !i.netmask) continue;
      const ip = i.address.split(".").map(Number);
      const mask = i.netmask.split(".").map(Number);
      targets.add(ip.map((o, k) => (o & mask[k]!) | (~mask[k]! & 255)).join("."));
    }
  }
  return [...targets];
}

/** Every IPv4 address of this host (plus loopback); a reply from one of these with our own port is us. */
export function localAddresses(): Set<string> {
  const out = new Set<string>(["127.0.0.1"]);
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) if (i.family === "IPv4") out.add(i.address);
  }
  return out;
}

/** Send one UDP probe and collect broker answers for `timeoutMs` (the broker-side twin of the client's `discoverBrokers`). */
export function probeBrokers(opts: { port: number; addr: string; timeoutMs: number }): Promise<FoundBroker[]> {
  return new Promise((resolve) => {
    const sock = createSocket({ type: "udp4" });
    const found = new Map<string, FoundBroker>();
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
      resolve([...found.values()]);
    };
    const timer = setTimeout(finish, opts.timeoutMs);
    sock.on("error", finish);
    sock.on("message", (msg, rinfo) => {
      try {
        const m = JSON.parse(msg.toString()) as Partial<DiscoveryReply>;
        if (m[DISCOVERY_KEY] !== DISCOVERY_REPLY_VALUE || !m.port) return;
        const url = `http://${rinfo.address}:${m.port}`;
        if (!found.has(url)) {
          found.set(url, { url, host: rinfo.address, port: m.port, id: m.id ?? rinfo.address, version: m.version ?? "", fallback: m.fallback === true });
        }
      } catch {
        // not ours
      }
    });
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
      } catch {
        // directed sends still work
      }
      const probe = Buffer.from(JSON.stringify({ [DISCOVERY_KEY]: DISCOVERY_PROBE_VALUE }));
      for (const t of probeTargets(opts.addr)) sock.send(probe, opts.port, t, () => {});
    });
  });
}
