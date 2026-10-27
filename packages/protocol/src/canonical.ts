/**
 * Canonical JSON for protocol hashes: object keys in ascending (UTF-16 code unit) order at every depth,
 * no whitespace, otherwise exactly what `JSON.stringify` writes for each value. Pure TypeScript with no
 * Node dependency, so any runtime can import it. The hash itself,
 * `sha256(canonicalJSON({manifest, doc}))` in lower-case hex, is computed by each side with its own
 * sha256 (broker: `node:crypto`).
 *
 * Input is expected to be JSON data (what `JSON.parse` returns). As in `JSON.stringify`, an object member whose
 * value is `undefined` / a function / a symbol is skipped, and such an array element becomes `null`.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // string / number / boolean: JSON.stringify escapes and formats them; undefined / function / symbol give undefined
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
