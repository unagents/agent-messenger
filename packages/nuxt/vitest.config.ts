import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
// The toolkit's `/server` entry pulls in Nitro-only virtual modules. Unit tests only need the
// tool registration code, so alias that entry to `definitions/tools.js` and stub `nitropack/runtime`.
const toolkitDefinitions = dirname(fileURLToPath(import.meta.resolve("@nuxtjs/mcp-toolkit/server")));

export default defineConfig({
  resolve: {
    alias: {
      "@nuxtjs/mcp-toolkit/server": resolve(toolkitDefinitions, "tools.js"),
      "nitropack/runtime": resolve(here, "test/stubs/nitropack-runtime.ts"),
    },
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    server: { deps: { inline: [/@nuxtjs\/mcp-toolkit/] } },
  },
});
