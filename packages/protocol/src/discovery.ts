/**
 * UDP LAN discovery — probe / reply JSON shapes.
 *
 * Transcribed from `legacy/src/resolve.js` (`discoverBrokers`) and `legacy/src/broker.js`
 * (discovery responder). Both packets are single JSON objects; the broker's
 * address is the reply packet's UDP source address.
 */

/** JSON key present in both probe and reply. */
export const DISCOVERY_KEY = "agent-messenger" as const;

/** Value of `DISCOVERY_KEY` in a client probe. */
export const DISCOVERY_PROBE_VALUE = "probe" as const;

/** Value of `DISCOVERY_KEY` in a broker reply. */
export const DISCOVERY_REPLY_VALUE = "broker" as const;

/** Client → broadcast: `{"agent-messenger":"probe"}` */
export interface DiscoveryProbe {
  [DISCOVERY_KEY]: typeof DISCOVERY_PROBE_VALUE;
}

/** Broker → client: `{"agent-messenger":"broker","id":..,"port":..,"version":..}` */
export interface DiscoveryReply {
  [DISCOVERY_KEY]: typeof DISCOVERY_REPLY_VALUE;
  /** Broker id (`AGENT_MESSENGER_BROKER_ID`, default hostname). */
  id: string;
  /** Broker HTTP port. */
  port: number;
  /** Broker package version. */
  version: string;
  /** Present (`true`) only when the broker is a local fallback; clients prefer other brokers, fallbacks never relay to each other. */
  fallback?: true;
}

/** The exact probe object sent by the client. */
export const DISCOVERY_PROBE: DiscoveryProbe = { [DISCOVERY_KEY]: DISCOVERY_PROBE_VALUE };

/** Default probe target when `AGENT_MESSENGER_DISCOVERY_ADDR` is unset (plus per-interface directed broadcast). */
export const DISCOVERY_BROADCAST_ADDR = "255.255.255.255";
