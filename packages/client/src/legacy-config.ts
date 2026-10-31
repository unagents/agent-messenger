import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./resolve.js";

/** Printed once per process; the file is never read. */
export const LEGACY_CONFIG_NOTICE = "config.json brokers is no longer read (removed in 0.12.0); use set_broker(url, persist: true)";

let noticed = false;

/** Tell the user once per process that `<stateDir>/config.json` is ignored. Does not read the file. */
export function noticeLegacyConfig(stateDir: string, log: Logger): void {
  if (noticed) return;
  if (!existsSync(join(stateDir, "config.json"))) return;
  noticed = true;
  log(LEGACY_CONFIG_NOTICE);
}

/** Test seam: forget that the notice was printed. */
export function resetLegacyConfigNotice(): void {
  noticed = false;
}
