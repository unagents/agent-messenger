import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { meshMac, meshMacEqual } from "../src/index.js";

describe("meshMac", () => {
  it("is the 128 bit prefix of HMAC-SHA256(token, am-mesh/1|nonce|id|port)", () => {
    const full = createHmac("sha256", "tok").update("am-mesh/1|abc|204|7901").digest("hex");
    expect(meshMac("tok", "abc", "204", 7901)).toBe(full.slice(0, 32));
  });

  it("changes with token, nonce, id and port", () => {
    const base = meshMac("tok", "n", "a", 1);
    expect(meshMac("tok2", "n", "a", 1)).not.toBe(base);
    expect(meshMac("tok", "n2", "a", 1)).not.toBe(base);
    expect(meshMac("tok", "n", "b", 1)).not.toBe(base);
    expect(meshMac("tok", "n", "a", 2)).not.toBe(base);
  });

  it("empty tokens match each other but not a non-empty token", () => {
    expect(meshMac("", "n", "a", 1)).toBe(meshMac("", "n", "a", 1));
    expect(meshMac("", "n", "a", 1)).not.toBe(meshMac("x", "n", "a", 1));
  });

  it("meshMacEqual rejects non-strings and wrong values", () => {
    const m = meshMac("t", "n", "a", 1);
    expect(meshMacEqual(m, m)).toBe(true);
    expect(meshMacEqual(m, undefined)).toBe(false);
    expect(meshMacEqual(m, m.slice(1))).toBe(false);
    expect(meshMacEqual(m, "0".repeat(32))).toBe(false);
  });
});
