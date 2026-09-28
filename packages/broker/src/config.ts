import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { defu } from "defu";
import { DEFAULT_BIND, DEFAULT_DISCOVERY_PORT, DEFAULT_HTTP_PORT, ENV } from "@agent-hand/messenger-protocol";

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
}

export type BrokerConfig = Required<BrokerOptions>;

/** Directory of the default state file (`~/.agent-messenger`). Not exported by protocol. */
export const STATE_DIR = join(homedir(), ".agent-messenger");

/** Default state file path (`~/.agent-messenger/broker.json`). Not exported by protocol. */
export const DEFAULT_STATE_FILE = join(STATE_DIR, "broker.json");

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
  };
}

/** `options` over environment over built-in defaults. */
export function resolveConfig(options: BrokerOptions = {}): BrokerConfig {
  return defu(options, configFromEnv()) as BrokerConfig;
}
