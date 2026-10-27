/**
 * Protocol constants shared by broker, client and CLI.
 *
 * Values are transcribed from the current JavaScript implementation
 * (`legacy/src/config.js`, `legacy/src/broker.js`, `legacy/src/server.js`). Do not change them here
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
 * Environment variable names. Source of truth: `legacy/src/config.js`
 * (`DELIVERY` lives in `legacy/src/server.js`).
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

// --- Protocol registry (0.10.0) ---

/**
 * Extra POST routes of the protocol registry. Like `RELAY_ROUTE`, not part of `BROKER_POST_ROUTES`
 * (that table mirrors the legacy broker); request / response shapes are `ProtocolRouteMap` in `http.ts`.
 */
export const PROTOCOL_ROUTES = ["/set-protocol", "/unset-protocol", "/get-protocol"] as const;

export type ProtocolRoute = (typeof PROTOCOL_ROUTES)[number];

/** Max size of `protocol.json` (UTF-8 bytes). */
export const PROTOCOL_MANIFEST_MAX_BYTES = 64 * 1024;

/** Max size of `PROTOCOL.md` (UTF-8 bytes). */
export const PROTOCOL_DOC_MAX_BYTES = 64 * 1024;

/** Max size of manifest + doc together (UTF-8 bytes). */
export const PROTOCOL_TOTAL_MAX_BYTES = 128 * 1024;

/** Max number of `(name, version)` definitions one broker holds; more is `LIMIT`. */
export const PROTOCOL_MAX_STORED = 256;

/** Max length (characters) of each of `meta.protocol` and `meta.version`. */
export const PROTOCOL_META_MAX_LENGTH = 128;

/** Valid protocol `name`. */
export const PROTOCOL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Error `code`s of the protocol feature (design 7.2). `NO_TAG` is not listed: a repo without tags is
 * not an error (`0.0.0+<sha7>`). Raised by the broker: HASH_MISMATCH, PROTOCOL_CONFLICT, LIMIT,
 * PROTOCOL_NOT_FOUND, and TOO_LARGE / INVALID_DEFINITION on re-check. The rest are raised by the client.
 */
export const PROTOCOL_ERROR_CODES = [
  "REPO_UNREACHABLE",
  "UNSUPPORTED_REPO",
  "VERSION_NOT_FOUND",
  "INVALID_DEFINITION",
  "VERSION_MISMATCH",
  "TOO_LARGE",
  "HASH_MISMATCH",
  "PROTOCOL_CONFLICT",
  "LIMIT",
  "PROTOCOL_NOT_FOUND",
  "BROKER_UNSUPPORTED",
  "INVALID_META",
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];
