import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ClientConfig } from "./config.js";

/**
 * The saved broker: `{"broker": "http://host:port", "saved_at": "<ISO8601>"}` in `client.json`
 * (`AGENT_MESSENGER_CLIENT_STATE`). One entry. Written by `set_broker(url, persist: true)`.
 */

/** The saved broker URL, or `null` when the file is absent, unreadable or holds none. */
export function readSavedBroker(cfg: Pick<ClientConfig, "clientFile">): string | null {
  try {
    const parsed = JSON.parse(readFileSync(cfg.clientFile, "utf8")) as { broker?: unknown };
    return typeof parsed.broker === "string" && parsed.broker.trim() !== "" ? parsed.broker.trim() : null;
  } catch {
    return null;
  }
}

/** Save `url`, or remove the saved broker when `url` is `null`. Temp file + rename. Throws on failure. */
export function writeSavedBroker(cfg: Pick<ClientConfig, "clientFile">, url: string | null): void {
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(cfg.clientFile, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
  } catch {
    // no file yet
  }
  if (url === null) {
    delete current.broker;
    delete current.saved_at;
  } else {
    current.broker = url;
    current.saved_at = new Date().toISOString();
  }
  mkdirSync(dirname(cfg.clientFile), { recursive: true });
  const tmp = `${cfg.clientFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(current, null, 2) + "\n");
  renameSync(tmp, cfg.clientFile);
}
