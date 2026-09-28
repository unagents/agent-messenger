import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BROKER_POST_ROUTES,
  DEFAULT_BIND,
  DEFAULT_DISCOVERY_PORT,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  DEFAULT_HTTP_PORT,
  DISCOVERY_PROBE,
  ENV,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  POLL_INTERVAL_MS,
} from "../src/index.js";

// 0.4.x JavaScript implementation (reference, kept under legacy/).
const legacyDir = fileURLToPath(new URL("../../../legacy/src/", import.meta.url));

function envNamesIn(file: string): Set<string> {
  const text = readFileSync(`${legacyDir}${file}`, "utf8");
  return new Set(text.match(/process\.env\.AGENT_MESSENGER_\w+/g)?.map((m) => m.replace("process.env.", "")));
}

describe("constants match legacy/src/config.js", () => {
  it("defaults", async () => {
    // config.js reads process.env at import time; strip overrides first.
    for (const k of Object.keys(process.env)) if (k.startsWith("AGENT_MESSENGER_")) delete process.env[k];
    const cfg = await import(pathToFileURL(`${legacyDir}config.js`).href);
    expect(cfg.PORT).toBe(DEFAULT_HTTP_PORT);
    expect(cfg.BIND).toBe(DEFAULT_BIND);
    expect(cfg.DISCOVERY_PORT).toBe(DEFAULT_DISCOVERY_PORT);
    expect(cfg.DISCOVERY_TIMEOUT_MS).toBe(DEFAULT_DISCOVERY_TIMEOUT_MS);
    expect(cfg.HEARTBEAT_INTERVAL_MS).toBe(HEARTBEAT_INTERVAL_MS);
    expect(cfg.HEARTBEAT_TIMEOUT_MS).toBe(HEARTBEAT_TIMEOUT_MS);
    expect(cfg.POLL_INTERVAL_MS).toBe(POLL_INTERVAL_MS);
  });

  it("env names", () => {
    const legacy = new Set([...envNamesIn("config.js"), ...envNamesIn("server.js")]);
    expect(new Set(Object.values(ENV))).toEqual(legacy);
  });
});

describe("routes match legacy/src/broker.js", () => {
  it("POST route table", () => {
    const text = readFileSync(`${legacyDir}broker.js`, "utf8");
    const block = text.slice(text.indexOf("const ROUTES = {"), text.indexOf("};", text.indexOf("const ROUTES = {")));
    const legacy = [...block.matchAll(/"(\/[a-z-]+)":/g)].map((m) => m[1]);
    expect([...BROKER_POST_ROUTES]).toEqual(legacy);
  });
});

describe("discovery", () => {
  it("probe wire form", () => {
    expect(JSON.stringify(DISCOVERY_PROBE)).toBe('{"agent-messenger":"probe"}');
  });
});
