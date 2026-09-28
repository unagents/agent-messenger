import { createSocket, type Socket } from "node:dgram";
import { DISCOVERY_KEY, DISCOVERY_PROBE_VALUE, type DiscoveryReply } from "@agent-hand/messenger-protocol";
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
