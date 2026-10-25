import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { defu } from "defu";
import { DEFAULT_BIND, DEFAULT_DISCOVERY_PORT, DEFAULT_HTTP_PORT, ENV } from "@unagents/messenger-protocol";

/**
 * Broker configuration. Every field can be given to `startBroker(options)`;
 * anything left out falls back to the environment (`AGENT_MESSENGER_*`,
 * same names and defaults as the JavaScript `legacy/src/config.js`).
 */
export interface BrokerOptions {
  /** HTTP listen port (`AGENT_MESSENGER_PORT`, default 7901). `0` = random free port. */
  port?: number;
  /** HTTP bind address (`AGENT_MESSENGER_BIND`, default `0.0.0.0`). */
  bind?: string;
  /** Bearer token; `""` disables auth (`AGENT_MESSENGER_TOKEN`, default `""`). */
  token?: string;
  /** Broker id shown in `/health` and discovery replies (`AGENT_MESSENGER_BROKER_ID`, default hostname). */
  id?: string;
  /** State file (`AGENT_MESSENGER_STATE`, default `~/.agent-messenger/broker.json`). */
  stateFile?: string;
  /** UDP discovery responder on/off (`AGENT_MESSENGER_DISCOVERY`, `"off"` disables; default on). */
  discovery?: boolean;
  /** UDP discovery port (`AGENT_MESSENGER_DISCOVERY_PORT`, default 7902). */
  discoveryPort?: number;
  /** UDP bind address when pinned (`AGENT_MESSENGER_DISCOVERY_ADDR`, default `""` = all interfaces). */
  discoveryAddr?: string;
  /**
   * Run as a local fallback broker (`AGENT_MESSENGER_FALLBACK=1`, set by the client when it spawns one).
   * A fallback probes for other brokers every `fallbackIntervalMs`; when it finds one it relays its
   * undelivered messages there and exits. A permanent broker (default) never does this.
   */
  fallback?: boolean;
  /** Fallback discovery interval in ms (`AGENT_MESSENGER_FALLBACK_INTERVAL_MS`, default 10000). */
  fallbackIntervalMs?: number;
  /** Called after a fallback broker has relayed its messages and closed itself (`main.ts` exits the process). */
  onSupersede?: (url: string) => void;
  /**
   * Join the permanent-broker mesh (`AGENT_MESSENGER_MESH`, `"on"` enables; default off).
   * Fallback brokers must leave this off: only brokers started with it take part.
   */
  mesh?: boolean;
  /**
   * Mesh members to sync with. Empty (default) = the `brokers` list of the client
   * config file (`AGENT_MESSENGER_CONFIG`, default `~/.agent-messenger/config.json`), re-read every round.
   */
  meshBrokers?: string[];
  /** Mesh sync interval in ms (`AGENT_MESSENGER_MESH_INTERVAL_MS`, default 5000). */
  meshIntervalMs?: number;
  /** Replicated peers disappear this long after their origin stopped syncing (`AGENT_MESSENGER_MESH_PEER_TTL_MS`, default 300000). */
  meshPeerTtlMs?: number;
  /** Client config file read for the mesh member list (`AGENT_MESSENGER_CONFIG`). */
  configFile?: string;
}

export type BrokerConfig = Required<Omit<BrokerOptions, "onSupersede">> & Pick<BrokerOptions, "onSupersede">;

/** Marks a broker as a local fallback. Broker-private (not in the protocol ENV table, which mirrors legacy). */
export const FALLBACK_ENV = "AGENT_MESSENGER_FALLBACK";
export const FALLBACK_INTERVAL_ENV = "AGENT_MESSENGER_FALLBACK_INTERVAL_MS";
export const DEFAULT_FALLBACK_INTERVAL_MS = 10_000;

/** Directory of the default state file (`~/.agent-messenger`). Not exported by protocol. */
export const STATE_DIR = join(homedir(), ".agent-messenger");

/** Default state file path (`~/.agent-messenger/broker.json`). Not exported by protocol. */
export const DEFAULT_STATE_FILE = join(STATE_DIR, "broker.json");

/** Mesh environment variables. Broker-private (not in the protocol's `ENV`, which mirrors the legacy names). */
export const MESH_ENV = {
  MESH: "AGENT_MESSENGER_MESH",
  INTERVAL_MS: "AGENT_MESSENGER_MESH_INTERVAL_MS",
  PEER_TTL_MS: "AGENT_MESSENGER_MESH_PEER_TTL_MS",
} as const;

/** Read the broker-side environment exactly like `legacy/src/config.js`. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  return {
    port: parseInt(env[ENV.PORT] ?? String(DEFAULT_HTTP_PORT), 10),
    bind: env[ENV.BIND] ?? DEFAULT_BIND,
    token: env[ENV.TOKEN] ?? "",
    id: env[ENV.BROKER_ID] ?? hostname(),
    stateFile: env[ENV.STATE] ?? DEFAULT_STATE_FILE,
    discovery: (env[ENV.DISCOVERY] ?? "on").toLowerCase() !== "off",
    discoveryPort: parseInt(env[ENV.DISCOVERY_PORT] ?? String(DEFAULT_DISCOVERY_PORT), 10),
    discoveryAddr: env[ENV.DISCOVERY_ADDR] ?? "",
    fallback: ["1", "true", "on", "yes"].includes((env[FALLBACK_ENV] ?? "").toLowerCase()),
    fallbackIntervalMs: parseInt(env[FALLBACK_INTERVAL_ENV] ?? String(DEFAULT_FALLBACK_INTERVAL_MS), 10),
    mesh: (env[MESH_ENV.MESH] ?? "off").toLowerCase() === "on",
    meshBrokers: [],
    meshIntervalMs: parseInt(env[MESH_ENV.INTERVAL_MS] ?? "5000", 10),
    meshPeerTtlMs: parseInt(env[MESH_ENV.PEER_TTL_MS] ?? "300000", 10),
    configFile: env[ENV.CONFIG] ?? join(STATE_DIR, "config.json"),
  };
}

/** `options` over environment over built-in defaults. */
export function resolveConfig(options: BrokerOptions = {}): BrokerConfig {
  return defu(options, configFromEnv()) as BrokerConfig;
}
