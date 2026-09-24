import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Environment configuration shared by broker, MCP server and CLI.
 *
 *   AGENT_MESSENGER_HOST   broker host (default 127.0.0.1)
 *   AGENT_MESSENGER_PORT   broker port (default 7901)
 *   AGENT_MESSENGER_BIND   broker bind address (default 0.0.0.0)
 *   AGENT_MESSENGER_TOKEN  bearer token (optional, recommended for multihost)
 *   AGENT_MESSENGER_NAME   peer name for this session (optional, e.g. "master-cap")
 *   AGENT_MESSENGER_STATE  broker state file (default ~/.agent-messenger/broker.json)
 */

export const HOST = process.env.AGENT_MESSENGER_HOST ?? "127.0.0.1";
export const PORT = parseInt(process.env.AGENT_MESSENGER_PORT ?? "7901", 10);
export const BIND = process.env.AGENT_MESSENGER_BIND ?? "0.0.0.0";
export const TOKEN = process.env.AGENT_MESSENGER_TOKEN ?? "";
export const NAME = process.env.AGENT_MESSENGER_NAME ?? "";
export const STATE_DIR = join(homedir(), ".agent-messenger");
export const STATE_FILE = process.env.AGENT_MESSENGER_STATE ?? join(STATE_DIR, "broker.json");
export const BROKER_URL = `http://${HOST}:${PORT}`;
export const IS_LOCAL_BROKER = HOST === "127.0.0.1" || HOST === "localhost";

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 60_000;
export const POLL_INTERVAL_MS = 1000;
