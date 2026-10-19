import { loadConfig } from "./config.js";
import type { Env } from "./config.js";
import { createStdioHost } from "./hosts/stdio.js";
import { createMessengerClient } from "./messenger.js";
import type { Logger } from "./resolve.js";

/**
 * agent-messenger client (stdio MCP server, one per Claude Code session).
 * Registers with the broker, exposes tools, delivers inbound messages to the
 * session (inbox socket → channel notification → local buffer for check_messages).
 *
 * The peer logic lives in `messenger.ts` (library API), the tools in `tools/`, the stdio
 * transport and notifications in `hosts/stdio.ts`. This file wires them together and
 * owns `process.exit` and the signal handlers.
 */

export interface StartClientOptions {
  /** Environment to read configuration from (default `process.env`). */
  env?: Env;
  /** Log sink (default: stderr, prefixed `[agent-messenger] `). */
  log?: Logger;
}

export async function startClient(options: StartClientOptions = {}): Promise<void> {
  const env: Env = options.env ?? (process.env as Env);
  const log: Logger = options.log ?? ((msg: string) => console.error(`[agent-messenger] ${msg}`));
  const cfg = loadConfig(env);
  let cleaningUp = false;

  const host = createStdioHost({
    cfg,
    log,
    onClose: () => {
      cleanup();
    },
  });
  const client = createMessengerClient({ env, log, config: cfg, autoStartBroker: true, notifier: host.notifier });
  await client.connect();
  host.attach(client.registry);
  host.connect();
  log("MCP connected");

  async function cleanup() {
    if (cleaningUp) return;
    cleaningUp = true;
    await client.close();
    process.exit(0);
  }
  process.on("SIGINT", () => {
    cleanup();
  });
  process.on("SIGTERM", () => {
    cleanup();
  });
}
