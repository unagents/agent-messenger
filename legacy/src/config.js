import { homedir, hostname } from "node:os";
import { join } from "node:path";

/**
 * Environment configuration shared by broker, MCP server and CLI.
 *
 * Client side (MCP server / CLI) — how the broker is found, in this order:
 *   1. AGENT_MESSENGER_HOST (+ AGENT_MESSENGER_PORT)   explicit. "auto" or unset = go on
 *   2. ~/.agent-messenger/config.json  {"brokers": ["http://host:port", ...]}  first reachable
 *   3. LAN discovery: UDP broadcast probe, brokers answer            (AGENT_MESSENGER_DISCOVERY_*)
 *   4. 127.0.0.1:AGENT_MESSENGER_PORT, auto-launching a local broker
 *
 * Broker side:
 *   AGENT_MESSENGER_PORT            listen port (default 7901)
 *   AGENT_MESSENGER_BIND            bind address (default 0.0.0.0)
 *   AGENT_MESSENGER_TOKEN           bearer token (optional)
 *   AGENT_MESSENGER_BROKER_ID       broker id shown in /health and discovery (default hostname)
 *   AGENT_MESSENGER_STATE           state file (default ~/.agent-messenger/broker.json)
 *   AGENT_MESSENGER_DISCOVERY       "off" disables the UDP discovery responder
 *
 * Discovery (both sides):
 *   AGENT_MESSENGER_DISCOVERY_PORT        UDP port (default 7902)
 *   AGENT_MESSENGER_DISCOVERY_ADDR        probe target (default 255.255.255.255 + per-interface broadcast)
 *   AGENT_MESSENGER_DISCOVERY_TIMEOUT_MS  how long to wait for answers (default 1000)
 *
 * Session:
 *   AGENT_MESSENGER_NAME            peer name for this session (optional)
 *   AGENT_MESSENGER_CONFIG          path of the config file (default ~/.agent-messenger/config.json)
 */

const rawHost = (process.env.AGENT_MESSENGER_HOST ?? "").trim();
export const HOST = rawHost && rawHost.toLowerCase() !== "auto" ? rawHost : "";
export const PORT = parseInt(process.env.AGENT_MESSENGER_PORT ?? "7901", 10);
export const BIND = process.env.AGENT_MESSENGER_BIND ?? "0.0.0.0";
export const TOKEN = process.env.AGENT_MESSENGER_TOKEN ?? "";
export const NAME = process.env.AGENT_MESSENGER_NAME ?? "";
export const BROKER_ID = process.env.AGENT_MESSENGER_BROKER_ID ?? hostname();
export const STATE_DIR = join(homedir(), ".agent-messenger");
export const STATE_FILE = process.env.AGENT_MESSENGER_STATE ?? join(STATE_DIR, "broker.json");
export const CONFIG_FILE = process.env.AGENT_MESSENGER_CONFIG ?? join(STATE_DIR, "config.json");

export const DISCOVERY_ENABLED = (process.env.AGENT_MESSENGER_DISCOVERY ?? "on").toLowerCase() !== "off";
export const DISCOVERY_PORT = parseInt(process.env.AGENT_MESSENGER_DISCOVERY_PORT ?? "7902", 10);
export const DISCOVERY_ADDR = process.env.AGENT_MESSENGER_DISCOVERY_ADDR ?? "";
export const DISCOVERY_TIMEOUT_MS = parseInt(process.env.AGENT_MESSENGER_DISCOVERY_TIMEOUT_MS ?? "1000", 10);

export const HEARTBEAT_INTERVAL_MS = parseInt(process.env.AGENT_MESSENGER_HEARTBEAT_MS ?? "15000", 10);
export const HEARTBEAT_TIMEOUT_MS = 60_000;
export const POLL_INTERVAL_MS = 1000;

export function isLocalHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
