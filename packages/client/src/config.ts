import { homedir } from "node:os";
import { join } from "node:path";
import {
  BROKER_CMD_ENV,
  CLIENT_STATE_ENV,
  DEFAULT_BROKER_CMD,
  DEFAULT_DISCOVERY_PORT,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  DEFAULT_GRACE_MS,
  DEFAULT_HTTP_PORT,
  DISCOVERY_TARGETS_ENV,
  ENV,
  GRACE_MS_ENV,
  HEARTBEAT_INTERVAL_MS,
  LOCAL_HOSTS,
  POLL_INTERVAL_MS,
  SESSION_SOCKET_ENV,
  SESSION_TOKEN_ENV,
} from "./constants.js";

/** Environment map (defaults to `process.env`). */
export type Env = Record<string, string | undefined>;

export type DeliveryMode = "auto" | "socket" | "channel";

/**
 * Client configuration, read from the environment once at startup.
 * Same variables and defaults as the current `legacy/src/config.js` / `legacy/src/server.js`.
 */
export interface ClientConfig {
  /** Explicit broker host (`AGENT_MESSENGER_HOST`); `""` when unset or `"auto"`. */
  host: string;
  port: number;
  token: string;
  name: string;
  stateDir: string;
  /** Saved broker (`client.json`, `AGENT_MESSENGER_CLIENT_STATE`), written by `set_broker(url, persist: true)`. */
  clientFile: string;
  /** Explicit discovery send targets (`host:port`, `AGENT_MESSENGER_DISCOVERY_TARGETS`); empty = broadcast. */
  discoveryTargets: string[];
  discoveryEnabled: boolean;
  discoveryPort: number;
  discoveryAddr: string;
  discoveryTimeoutMs: number;
  heartbeatIntervalMs: number;
  /** Time the previous broker URL is retried after a failure before re-resolving (`AGENT_MESSENGER_GRACE_MS`, default 30000). */
  graceMs: number;
  pollIntervalMs: number;
  sessionSocket: string;
  sessionToken: string;
  delivery: DeliveryMode;
  brokerCmd: string;
}

export function loadConfig(env: Env): ClientConfig {
  const rawHost = (env[ENV.HOST] ?? "").trim();
  const stateDir = join(homedir(), ".agent-messenger");
  return {
    host: rawHost && rawHost.toLowerCase() !== "auto" ? rawHost : "",
    port: parseInt(env[ENV.PORT] ?? String(DEFAULT_HTTP_PORT), 10),
    token: env[ENV.TOKEN] ?? "",
    name: env[ENV.NAME] ?? "",
    stateDir,
    clientFile: env[CLIENT_STATE_ENV] ?? join(stateDir, "client.json"),
    discoveryTargets: (env[DISCOVERY_TARGETS_ENV] ?? "").split(",").map((s) => s.trim()).filter((s) => s !== ""),
    discoveryEnabled: (env[ENV.DISCOVERY] ?? "on").toLowerCase() !== "off",
    discoveryPort: parseInt(env[ENV.DISCOVERY_PORT] ?? String(DEFAULT_DISCOVERY_PORT), 10),
    discoveryAddr: env[ENV.DISCOVERY_ADDR] ?? "",
    discoveryTimeoutMs: parseInt(env[ENV.DISCOVERY_TIMEOUT_MS] ?? String(DEFAULT_DISCOVERY_TIMEOUT_MS), 10),
    heartbeatIntervalMs: parseInt(env[ENV.HEARTBEAT_MS] ?? String(HEARTBEAT_INTERVAL_MS), 10),
    graceMs: parseInt(env[GRACE_MS_ENV] ?? String(DEFAULT_GRACE_MS), 10),
    pollIntervalMs: POLL_INTERVAL_MS,
    sessionSocket: env[SESSION_SOCKET_ENV] ?? "",
    sessionToken: env[SESSION_TOKEN_ENV] ?? "",
    delivery: (env[ENV.DELIVERY] ?? "auto") as DeliveryMode,
    brokerCmd: env[BROKER_CMD_ENV] ?? DEFAULT_BROKER_CMD,
  };
}

export function isLocalHost(host: string): boolean {
  for (const h of LOCAL_HOSTS) if (h === host) return true;
  return false;
}
