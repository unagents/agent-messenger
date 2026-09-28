import { createConsola } from "consola";

/**
 * Broker logger. Everything goes to stderr, like the JavaScript broker's
 * `console.error("[agent-messenger broker] ...")`.
 */
export const log = createConsola({ stdout: process.stderr, stderr: process.stderr }).withTag(
  "agent-messenger broker"
);
