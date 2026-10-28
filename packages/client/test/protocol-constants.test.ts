/**
 * The client keeps its own copy of the protocol limits and of `canonicalJSON` (see src/constants.ts for why).
 * This test pins them to the protocol package, and the hash to a value computed outside the client.
 */
import { createHash } from "node:crypto";
import * as protocol from "@unagents/messenger-protocol";
import { describe, expect, it } from "vitest";
import * as local from "../src/constants.js";
import { canonicalJSON, protocolHash } from "../src/hash.js";

describe("client protocol constants match @unagents/messenger-protocol", () => {
  it("limits and name pattern", () => {
    expect(local.PROTOCOL_MANIFEST_MAX_BYTES).toBe(protocol.PROTOCOL_MANIFEST_MAX_BYTES);
    expect(local.PROTOCOL_DOC_MAX_BYTES).toBe(protocol.PROTOCOL_DOC_MAX_BYTES);
    expect(local.PROTOCOL_TOTAL_MAX_BYTES).toBe(protocol.PROTOCOL_TOTAL_MAX_BYTES);
    expect(local.PROTOCOL_META_MAX_LENGTH).toBe(protocol.PROTOCOL_META_MAX_LENGTH);
    expect(local.PROTOCOL_NAME_PATTERN.source).toBe(protocol.PROTOCOL_NAME_PATTERN.source);
    expect(local.PROTOCOL_NAME_PATTERN.flags).toBe(protocol.PROTOCOL_NAME_PATTERN.flags);
  });
});

const SAMPLES: unknown[] = [
  null,
  true,
  0,
  -1.5,
  "text \"q\" \\ \n\t   日本語 \u{1F600}",
  [],
  {},
  [1, [2, { b: 1, a: [undefined, null] }]],
  { b: 1, a: { d: [3, 2, 1], c: "x" }, "é": 1, Z: 2, "10": 3, "9": 4 },
  { skipped: undefined, kept: 1 },
];

describe("canonicalJSON / protocolHash", () => {
  it("canonicalJSON equals the protocol package's on every sample", () => {
    for (const s of SAMPLES) expect(canonicalJSON(s)).toBe(protocol.canonicalJSON(s));
  });

  it("protocolHash is sha256(canonicalJSON({manifest, doc})) in lower-case hex", () => {
    const manifest = { name: "demo", version: "1.0.0", description: 'x', messages: { b: { type: "object" }, a: { enum: ["x", 1, null, true] } } };
    const doc = "# Doc\n\ttab 日本語";
    const expected = createHash("sha256").update(protocol.canonicalJSON({ manifest, doc })).digest("hex");
    expect(protocolHash(manifest, doc)).toBe(expected);
    expect(protocolHash(manifest, doc)).toMatch(/^[0-9a-f]{64}$/);
    // key order and whitespace of the source do not matter, the content does
    expect(protocolHash(JSON.parse('{ "version":"1.0.0", "name":"demo", "description":"x", "messages":{"a":{"enum":["x",1,null,true]},"b":{"type":"object"}} }'), doc)).toBe(expected);
    expect(protocolHash(manifest, doc + " ")).not.toBe(expected);
  });

  it("pins a hash computed with node:crypto outside the client", () => {
    const manifest = {
      name: "demo",
      version: "1.0.0",
      description: '説明 "q" \u{1F600}',
      messages: { b: { type: "object" }, a: { enum: ["x", 1, null, true] } },
    };
    const doc = "# Doc\n\ttab   日本語";
    expect(protocolHash(manifest, doc)).toBe("4db29ee6f5917a7962ebd185f18ca07a767ef65262edcf5bf0e1dba66301541e");
  });
});
