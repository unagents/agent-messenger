import { createHash } from "node:crypto";
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
  PROTOCOL_DOC_MAX_BYTES,
  PROTOCOL_ERROR_CODES,
  PROTOCOL_MANIFEST_MAX_BYTES,
  PROTOCOL_MAX_STORED,
  PROTOCOL_META_MAX_LENGTH,
  PROTOCOL_NAME_PATTERN,
  PROTOCOL_ROUTES,
  PROTOCOL_TOTAL_MAX_BYTES,
  RELAY_ROUTE,
  canonicalJSON,
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

describe("canonicalJSON", () => {
  it("sorts keys at every depth and writes no whitespace", () => {
    expect(canonicalJSON({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it("is independent of key insertion order", () => {
    const x = { manifest: { name: "p", version: "1.0.0", messages: { b: {}, a: {} } }, doc: "text" };
    const y = { doc: "text", manifest: { messages: { a: {}, b: {} }, version: "1.0.0", name: "p" } };
    expect(canonicalJSON(x)).toBe(canonicalJSON(y));
  });

  it("keeps array order and primitive forms of JSON.stringify", () => {
    expect(canonicalJSON([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJSON(["a\n\"é"])).toBe(JSON.stringify(["a\n\"é"]));
    expect(canonicalJSON([null, true, false, 0, -1.5, 1e21])).toBe(JSON.stringify([null, true, false, 0, -1.5, 1e21]));
    expect(canonicalJSON("")).toBe('""');
    expect(canonicalJSON({})).toBe("{}");
    expect(canonicalJSON([])).toBe("[]");
  });

  it("skips undefined members and nulls undefined array items, like JSON.stringify", () => {
    expect(canonicalJSON({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJSON([undefined, 1])).toBe("[null,1]");
    expect(canonicalJSON(undefined)).toBe("null");
  });

  it("orders keys by UTF-16 code unit, not by locale", () => {
    expect(canonicalJSON({ b: 1, B: 2, a: 3, "\u00e9": 4, Z: 5 })).toBe('{"B":2,"Z":5,"a":3,"b":1,"\u00e9":4}');
  });

  it("the protocol hash form is pinned: sha256(canonicalJSON({manifest, doc}))", () => {
    const body = canonicalJSON({ manifest: { name: "x", b: [1, 2], a: 1 }, doc: "d" });
    expect(body).toBe('{"doc":"d","manifest":{"a":1,"b":[1,2],"name":"x"}}');
    expect(createHash("sha256").update(body).digest("hex")).toBe("1e76605b61d8b2e8a4d0f7c8609fdc5c1d5ffa858c366ea4e7a9d9f0be00fc80");
  });
});

describe("protocol registry constants", () => {
  it("routes are POST paths kept apart from BROKER_POST_ROUTES and the relay route", () => {
    expect([...PROTOCOL_ROUTES]).toEqual(["/set-protocol", "/unset-protocol", "/get-protocol"]);
    for (const r of PROTOCOL_ROUTES) {
      expect((BROKER_POST_ROUTES as readonly string[]).includes(r)).toBe(false);
      expect(r).not.toBe(RELAY_ROUTE);
    }
  });

  it("limits", () => {
    expect(PROTOCOL_MANIFEST_MAX_BYTES).toBe(64 * 1024);
    expect(PROTOCOL_DOC_MAX_BYTES).toBe(64 * 1024);
    expect(PROTOCOL_TOTAL_MAX_BYTES).toBe(128 * 1024);
    expect(PROTOCOL_MAX_STORED).toBe(256);
    expect(PROTOCOL_META_MAX_LENGTH).toBe(128);
  });

  it("name pattern", () => {
    for (const ok of ["a", "review-request", "r1.2_x", "0abc", "a".repeat(64)]) expect(PROTOCOL_NAME_PATTERN.test(ok)).toBe(true);
    for (const bad of ["", "A", "-a", ".a", "_a", "a b", "a/b", "a@1", "a".repeat(65)]) expect(PROTOCOL_NAME_PATTERN.test(bad)).toBe(false);
  });

  it("error codes are the design 7.2 list without NO_TAG", () => {
    expect([...PROTOCOL_ERROR_CODES].sort()).toEqual(
      [
        "REPO_UNREACHABLE",
        "UNSUPPORTED_REPO",
        "VERSION_NOT_FOUND",
        "INVALID_DEFINITION",
        "VERSION_MISMATCH",
        "TOO_LARGE",
        "HASH_MISMATCH",
        "PROTOCOL_CONFLICT",
        "LIMIT",
        "PROTOCOL_NOT_FOUND",
        "BROKER_UNSUPPORTED",
        "INVALID_META",
      ].sort()
    );
    expect(new Set(PROTOCOL_ERROR_CODES).size).toBe(PROTOCOL_ERROR_CODES.length);
  });
});
