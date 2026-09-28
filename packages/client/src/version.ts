/**
 * Package version reported in the MCP `initialize` response (`serverInfo.version`).
 *
 * Kept as a constant (not read from `package.json` at runtime) so the native
 * binary has no file dependency. `test/version.test.ts` checks it matches
 * `package.json`.
 */
export const VERSION = "0.5.1";
