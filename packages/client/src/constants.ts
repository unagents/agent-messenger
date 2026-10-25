/**
 * Runtime constants used by the client.
 *
 * These duplicate values from `@unagents/messenger-protocol` on purpose: the
 * client imports only *types* from protocol. PerryTS resolves the protocol
 * package to its unbuild output (`dist/index.mjs`, `export { A, B }` list form)
 * and turns numeric constants imported from it into functions (see
 * `reports/20260928-ts-03-client.md`), so values are kept here and
 * `test/constants.test.ts` asserts they equal the protocol's.
 */

/** Broker HTTP listen port (`AGENT_MESSENGER_PORT` default). */
export const DEFAULT_HTTP_PORT = 7901;

/** UDP discovery port (`AGENT_MESSENGER_DISCOVERY_PORT` default). */
export const DEFAULT_DISCOVERY_PORT = 7902;

/** How long a client waits for discovery answers (`AGENT_MESSENGER_DISCOVERY_TIMEOUT_MS` default). */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 1000;

/** Client heartbeat interval (`AGENT_MESSENGER_HEARTBEAT_MS` default). */
export const HEARTBEAT_INTERVAL_MS = 15000;

/** Client `/poll-messages` interval. Not configurable. */
export const POLL_INTERVAL_MS = 1000;

/** Loopback hosts treated as "local broker" by the resolver. */
export const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1"];

/** Environment variable names (`AGENT_MESSENGER_*`). */
export const ENV = {
  HOST: "AGENT_MESSENGER_HOST",
  PORT: "AGENT_MESSENGER_PORT",
  BIND: "AGENT_MESSENGER_BIND",
  TOKEN: "AGENT_MESSENGER_TOKEN",
  NAME: "AGENT_MESSENGER_NAME",
  BROKER_ID: "AGENT_MESSENGER_BROKER_ID",
  STATE: "AGENT_MESSENGER_STATE",
  CONFIG: "AGENT_MESSENGER_CONFIG",
  DISCOVERY: "AGENT_MESSENGER_DISCOVERY",
  DISCOVERY_PORT: "AGENT_MESSENGER_DISCOVERY_PORT",
  DISCOVERY_ADDR: "AGENT_MESSENGER_DISCOVERY_ADDR",
  DISCOVERY_TIMEOUT_MS: "AGENT_MESSENGER_DISCOVERY_TIMEOUT_MS",
  HEARTBEAT_MS: "AGENT_MESSENGER_HEARTBEAT_MS",
  DELIVERY: "AGENT_MESSENGER_DELIVERY",
};

/** Command used to auto-launch a local broker (whitespace separated). Client-only, not in protocol. */
export const BROKER_CMD_ENV = "AGENT_MESSENGER_BROKER_CMD";
export const DEFAULT_BROKER_CMD = "npx -y @unagents/messenger broker";

/**
 * Fallback / re-resolve settings. Client-only, not in the protocol ENV table (that table mirrors legacy).
 * `FALLBACK_ENV` is what the client sets on a broker it spawns, so the broker knows it is a local fallback.
 */
export const FALLBACK_ENV = "AGENT_MESSENGER_FALLBACK";
export const GRACE_MS_ENV = "AGENT_MESSENGER_GRACE_MS";

/** How long the previous broker URL is retried after a failure before the client re-resolves. */
export const DEFAULT_GRACE_MS = 30000;

/** Minimum spacing of re-resolve attempts once the grace period is over. */
export const RESOLVE_RETRY_MS = 5000;

/** Session inbox socket env names. */
export const SESSION_SOCKET_ENV = "CLAUDE_CODE_MESSAGING_SOCKET";
export const SESSION_TOKEN_ENV = "CLAUDE_CODE_MESSAGING_TOKEN";

/** Broker health route (the only GET route). */
export const HEALTH_ROUTE = "/health";

/** UDP discovery wire form. */
export const DISCOVERY_KEY = "agent-messenger";
export const DISCOVERY_PROBE_VALUE = "probe";
export const DISCOVERY_REPLY_VALUE = "broker";
export const DISCOVERY_BROADCAST_ADDR = "255.255.255.255";
