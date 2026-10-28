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

/** Value of `DISCOVERY_KEY` in a mesh broker's self-announcement (0.11.0). */
export const DISCOVERY_ANNOUNCE_VALUE = "announce" as const;

/** Client → broadcast: `{"agent-messenger":"probe"}` */
export interface DiscoveryProbe {
  [DISCOVERY_KEY]: typeof DISCOVERY_PROBE_VALUE;
  /** Mesh brokers add a 16 byte random hex nonce; the reply's `mac` is bound to it. Clients send none. */
  n?: string;
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
  /** Present (`true`) only when the broker takes part in the mesh (`AGENT_MESSENGER_MESH=on`). */
  mesh?: true;
  /** Mesh broker only, and only when the probe carried `n`: `meshMac(token, n, id, port)`. */
  mac?: string;
}

/** Mesh broker → broadcast, every `AGENT_MESSENGER_MESH_ANNOUNCE_MS`: `{"agent-messenger":"announce",id,port,version,mesh:true,ts,mac}` */
export interface DiscoveryAnnounce {
  [DISCOVERY_KEY]: typeof DISCOVERY_ANNOUNCE_VALUE;
  id: string;
  port: number;
  version: string;
  mesh: true;
  /** Send time (ms since epoch); also the MAC nonce (decimal string). Receivers accept `|now - ts| <= MESH_ANNOUNCE_MAX_SKEW_MS`. */
  ts: number;
  /** `meshMac(token, String(ts), id, port)` */
  mac: string;
}

/** Announces older (or newer) than this are ignored. */
export const MESH_ANNOUNCE_MAX_SKEW_MS = 60_000;

/** The exact probe object sent by the client. */
export const DISCOVERY_PROBE: DiscoveryProbe = { [DISCOVERY_KEY]: DISCOVERY_PROBE_VALUE };

/** Default probe target when `AGENT_MESSENGER_DISCOVERY_ADDR` is unset (plus per-interface directed broadcast). */
export const DISCOVERY_BROADCAST_ADDR = "255.255.255.255";
