import type { JsonObjectSchema } from "./types.js";

/**
 * Check a tools/call `arguments` object against the tool's inputSchema (the JSON Schema subset of
 * `types.ts`). Returns the error text, or `null` when the arguments are fine. Nothing is coerced.
 *
 * Order of the checks (the first failure is reported):
 *  1. `required` keys that are missing (absent or `undefined`)
 *  2. a call that carries arguments but none the schema knows (typo'd names only) is rejected;
 *     extra unknown names next to known ones are tolerated
 *  3. per string / boolean property in schema order: type and `enum` (object properties are left to their handler)
 *
 * Kept to plain loops and typeof checks: it also runs in the PerryTS native client.
 */
export function validateArgs(schema: JsonObjectSchema, args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return `arguments must be an object (got ${typeName(args)})`;
  }
  const given = args as Record<string, unknown>;
  const names = presentKeys(given);
  const got = names.length === 0 ? "none" : names.join(", ");

  const required = schema.required === undefined ? [] : schema.required;
  const missing: string[] = [];
  for (const key of required) {
    if (given[key] === undefined) missing.push(`"${key}"`);
  }
  if (missing.length > 0) {
    return `missing required argument${missing.length > 1 ? "s" : ""} ${missing.join(", ")} (got: ${got})`;
  }

  const known = Object.keys(schema.properties);
  if (known.length > 0 && names.length > 0) {
    let anyKnown = false;
    for (const n of names) {
      if (known.includes(n)) anyKnown = true;
    }
    if (!anyKnown) return `none of the given arguments is known (got: ${got}; expected: ${known.join(", ")})`;
  }

  for (const key of known) {
    const value = given[key];
    if (value === undefined) continue;
    const prop = schema.properties[key];
    if (prop.type === "string") {
      if (typeof value !== "string") return `argument "${key}" must be a string (got ${typeName(value)})`;
      if (prop.enum !== undefined && !prop.enum.includes(value)) return `Invalid ${key}: ${value} (use ${quoteChoices(prop.enum)})`;
    } else if (prop.type === "boolean") {
      // clients that stringify booleans send "true" / "false"; the handlers accept that
      if (typeof value !== "boolean" && value !== "true" && value !== "false") return `argument "${key}" must be a boolean (got ${typeName(value)})`;
    }
    // object properties (`send_message` `meta`) are not checked here: parseMeta checks them and answers with
    // INVALID_META, which is part of the protocol tools contract
  }
  return null;
}

/** Keys whose value is not `undefined` (what a JSON-RPC peer actually sent). */
function presentKeys(o: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(o)) {
    if (o[k] !== undefined) out.push(k);
  }
  return out;
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** `"a"`, `"a" or "b"`, `"a", "b" or "c"` */
function quoteChoices(choices: string[]): string {
  const quoted: string[] = [];
  for (const c of choices) quoted.push(`"${c}"`);
  if (quoted.length === 1) return quoted[0];
  return `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
}
