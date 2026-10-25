import { fileURLToPath } from "node:url";
import { defineBuildConfig } from "unbuild";

export default defineBuildConfig({
  entries: ["src/index", "src/main"],
  declaration: true,
  clean: true,
  // protocol is a build-time only dependency (types); resolve it from source so
  // the .d.ts bundle does not depend on packages/protocol/dist.
  alias: {
    "@unagents/messenger-protocol": fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
  },
  rollup: {
    emitCJS: false,
    inlineDependencies: ["@unagents/messenger-protocol"],
  },
});
