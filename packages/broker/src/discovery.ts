import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import {
  DISCOVERY_ANNOUNCE_VALUE,
  DISCOVERY_KEY,
  DISCOVERY_PROBE_VALUE,
  DISCOVERY_REPLY_VALUE,
  meshMac,
  type DiscoveryAnnounce,
  type DiscoveryReply,
} from "@unagents/messenger-protocol";
import { log } from "./log.js";

export interface DiscoveryResponderOptions {
  port: number;
  /** `AGENT_MESSENGER_DISCOVERY_ADDR`; when set and not a `.255` broadcast address the socket binds to it. */
  addr: string;
  /** Build the answer to a probe; `nonce` is the probe's `n` (mesh brokers bind their `mac` to it). */
  reply: (nonce?: string) => DiscoveryReply;
  /** Mesh brokers: receives every `announce` packet. */
  onAnnounce?: (msg: Record<string, unknown>, rinfo: RemoteInfo) => void;
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
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(msg.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    if (m[DISCOVERY_KEY] === DISCOVERY_ANNOUNCE_VALUE) return opts.onAnnounce?.(m, rinfo);
    if (m[DISCOVERY_KEY] !== DISCOVERY_PROBE_VALUE) return;
    const nonce = typeof m.n === "string" && m.n.length > 0 && m.n.length <= 128 ? m.n : undefined;
    const reply = Buffer.from(JSON.stringify(opts.reply(nonce)));
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
  /** Reply said `mesh: true`. */
  mesh: boolean;
  /** Reply `mac` (only when our probe carried a nonce and the broker is a mesh member). */
  mac?: string;
}

export interface UdpTarget {
  host: string;
  port: number;
}

/** `host:port` entries (`AGENT_MESSENGER_DISCOVERY_TARGETS`); unparsable ones are dropped. */
export function parseDiscoveryTargets(list: string[]): UdpTarget[] {
  const out: UdpTarget[] = [];
  for (const s of list) {
    const i = s.lastIndexOf(":");
    const port = Number(s.slice(i + 1));
    if (i <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
      log.warn(`discovery: ignoring invalid target "${s}" (want host:port)`);
      continue;
    }
    out.push({ host: s.slice(0, i), port });
  }
  return out;
}

/** Where probes / announces go: the explicit target list, else `addr` (pinned) or broadcast, all on `port`. */
export function sendTargets(opts: { port: number; addr: string; targets?: string[] }): UdpTarget[] {
  const explicit = parseDiscoveryTargets(opts.targets ?? []);
  if (explicit.length) return explicit;
  return probeTargets(opts.addr).map((host) => ({ host, port: opts.port }));
}

/** The announce packet a mesh broker sends (`mac` is bound to `ts`, `id`, `port`). */
export function buildAnnounce(a: { token: string; id: string; port: number; version: string; ts: number }): DiscoveryAnnounce {
  return {
    [DISCOVERY_KEY]: DISCOVERY_ANNOUNCE_VALUE,
    id: a.id,
    port: a.port,
    version: a.version,
    mesh: true,
    ts: a.ts,
    mac: meshMac(a.token, String(a.ts), a.id, a.port),
  };
}

/** Send one announce through `sock` (the responder socket) to every target. */
export function sendAnnounce(sock: Socket, packet: DiscoveryAnnounce, targets: UdpTarget[]): void {
  const buf = Buffer.from(JSON.stringify(packet));
  for (const t of targets) {
    try {
      sock.send(buf, t.port, t.host, () => {});
    } catch {
      // socket closing
    }
  }
}

/** 16 random bytes as hex, the `n` of a mesh probe. */
export function newNonce(): string {
  return randomBytes(16).toString("hex");
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
export function probeBrokers(opts: { port: number; addr: string; timeoutMs: number; targets?: string[]; nonce?: string }): Promise<FoundBroker[]> {
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
          found.set(url, {
            url,
            host: rinfo.address,
            port: m.port,
            id: m.id ?? rinfo.address,
            version: m.version ?? "",
            fallback: m.fallback === true,
            mesh: m.mesh === true,
            ...(typeof m.mac === "string" ? { mac: m.mac } : {}),
          });
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
      const probe = Buffer.from(JSON.stringify({ [DISCOVERY_KEY]: DISCOVERY_PROBE_VALUE, ...(opts.nonce ? { n: opts.nonce } : {}) }));
      for (const t of sendTargets(opts)) sock.send(probe, t.port, t.host, () => {});
    });
  });
}
