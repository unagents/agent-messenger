import * as crypto from "node:crypto";

/**
 * Canonical JSON for protocol hashes (design 5.4): object keys in ascending (UTF-16 code unit) order at every depth, no
 * whitespace, every value as `JSON.stringify` writes it.
 *
 * A copy of `canonicalJSON` in `@unagents/messenger-protocol`: the client imports only types from protocol (see
 * `constants.ts`). `test/protocol-constants.test.ts` pins the two together.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJSON(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
    parts.push(`${JSON.stringify(k)}:${canonicalJSON(v)}`);
  }
  return `{${parts.join(",")}}`;
}

/** `sha256(canonicalJSON({manifest, doc}))` as lower-case hex. Same value the broker re-computes. */
export function protocolHash(manifest: unknown, doc: string): string {
  return crypto.createHash("sha256").update(canonicalJSON({ manifest, doc })).digest("hex");
}
