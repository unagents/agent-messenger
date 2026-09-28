/**
 * Protocol constants shared by broker, client and CLI.
 *
 * Values are transcribed from the current JavaScript implementation
 * (`src/config.js`, `src/broker.js`, `src/server.js`). Do not change them here
 * without changing the implementation on both ends.
 */

/** Broker HTTP listen port (`AGENT_MESSENGER_PORT` default). */
export const DEFAULT_HTTP_PORT = 7901;

/** Broker HTTP bind address (`AGENT_MESSENGER_BIND` default). */
export const DEFAULT_BIND = "0.0.0.0";

/** UDP discovery port (`AGENT_MESSENGER_DISCOVERY_PORT` default). */
export const DEFAULT_DISCOVERY_PORT = 7902;

/** How long a client waits for discovery answers (`AGENT_MESSENGER_DISCOVERY_TIMEOUT_MS` default). */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 1000;

/** Client heartbeat interval (`AGENT_MESSENGER_HEARTBEAT_MS` default). */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** Broker drops a peer whose `last_seen` is older than this. Not configurable. */
export const HEARTBEAT_TIMEOUT_MS = 60_000;

/** Client `/poll-messages` interval. Not configurable. */
export const POLL_INTERVAL_MS = 1000;

/** Loopback hosts treated as "local broker" by the client resolver. */
export const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1"] as const;

/**
 * Environment variable names. Source of truth: `src/config.js`
 * (`DELIVERY` lives in `src/server.js`).
 */
export const ENV = {
  /** Explicit broker host. `"auto"` or unset = resolve by config / discovery / local. */
  HOST: "AGENT_MESSENGER_HOST",
  /** Broker HTTP port (client target / broker listen). */
  PORT: "AGENT_MESSENGER_PORT",
  /** Broker bind address. */
  BIND: "AGENT_MESSENGER_BIND",
  /** Bearer token; when set, every POST must carry `Authorization: Bearer <token>`. */
  TOKEN: "AGENT_MESSENGER_TOKEN",
  /** Peer name for this session. */
  NAME: "AGENT_MESSENGER_NAME",
  /** Broker id shown in `/health` and discovery replies (default hostname). */
  BROKER_ID: "AGENT_MESSENGER_BROKER_ID",
  /** Broker state file (default `~/.agent-messenger/broker.json`). */
  STATE: "AGENT_MESSENGER_STATE",
  /** Client config file (default `~/.agent-messenger/config.json`). */
  CONFIG: "AGENT_MESSENGER_CONFIG",
  /** `"off"` disables UDP discovery (broker responder and client probe). */
  DISCOVERY: "AGENT_MESSENGER_DISCOVERY",
  /** UDP discovery port. */
  DISCOVERY_PORT: "AGENT_MESSENGER_DISCOVERY_PORT",
  /** Discovery probe target address. */
  DISCOVERY_ADDR: "AGENT_MESSENGER_DISCOVERY_ADDR",
  /** Discovery answer wait time in ms. */
  DISCOVERY_TIMEOUT_MS: "AGENT_MESSENGER_DISCOVERY_TIMEOUT_MS",
  /** Client heartbeat interval in ms. */
  HEARTBEAT_MS: "AGENT_MESSENGER_HEARTBEAT_MS",
  /** Inbound delivery mode: `"auto"` (default) / `"socket"` / `"channel"`. */
  DELIVERY: "AGENT_MESSENGER_DELIVERY",
} as const;

export type EnvName = (typeof ENV)[keyof typeof ENV];
