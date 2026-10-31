/**
 * Standalone entry: `node dist/main.mjs`.
 * Runs the broker in the foreground; SIGINT / SIGTERM shut it down (exit 0),
 * like `agent-messenger broker` in the JavaScript implementation.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./config.js";
import { startBroker } from "./index.js";
import { log } from "./log.js";

// config.json is not read any more (0.12.0); say so once if an old one is lying around.
if (existsSync(join(STATE_DIR, "config.json"))) {
  log.warn("config.json brokers is no longer read (removed in 0.12.0); use set_broker(url, persist: true)");
}

const broker = await startBroker({
  // fallback only: messages are relayed and the broker is closed, nothing left to do
  onSupersede: () => process.exit(0),
});

const shutdown = () => {
  log.info("shutting down");
  broker.close().finally(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
