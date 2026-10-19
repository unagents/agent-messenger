import { fileURLToPath } from "node:url";
import { defineBuildConfig } from "unbuild";

export default defineBuildConfig({
  entries: ["src/index", "src/main", "src/tools/index"],
  declaration: true,
  clean: true,
  // protocol is a build-time only dependency: its constants and types are
  // bundled from source so the published client has zero runtime dependencies
  // (and the node build does not depend on packages/protocol/dist).
  alias: {
    "@agent-hand/messenger-protocol": fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
  },
  rollup: {
    emitCJS: false,
    inlineDependencies: ["@agent-hand/messenger-protocol"],
  },
});
