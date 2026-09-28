import pkg from "../package.json" with { type: "json" };

/** CLI package version (`@agent-hand/messenger`). */
export const VERSION: string = pkg.version;
