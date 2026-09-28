/**
 * Standalone entry: `node dist/main.mjs`.
 * Runs the broker in the foreground; SIGINT / SIGTERM shut it down (exit 0),
 * like `agent-messenger broker` in the JavaScript implementation.
 */
import { startBroker } from "./index.js";
import { log } from "./log.js";

const broker = await startBroker();

const shutdown = () => {
  log.info("shutting down");
  broker.close().finally(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
