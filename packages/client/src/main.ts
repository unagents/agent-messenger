// Standalone entry: `node dist/main.mjs` or `perry compile src/main.ts`.
// The process stays alive through the poll / heartbeat timers and stdin.
// `--version` prints the version and exits; the CLI uses it to check that a
// native build can run on this host before starting it.
import { startClient } from "./client.js";
import { VERSION } from "./version.js";

if (process.argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}

startClient().catch((e: unknown) => {
  console.error(`[agent-messenger] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
