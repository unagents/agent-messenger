// Standalone entry: `node dist/main.mjs` or `perry compile src/main.ts`.
// The process stays alive through the poll / heartbeat timers and stdin.
import { startClient } from "./client.js";

startClient().catch((e: unknown) => {
  console.error(`[agent-messenger] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
