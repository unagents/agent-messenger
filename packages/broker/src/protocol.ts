import { createHash } from "node:crypto";
import type { MessageMeta, ProtocolDecl, ProtocolDefinition } from "@unagents/messenger-protocol";
import {
  PROTOCOL_DOC_MAX_BYTES,
  PROTOCOL_MANIFEST_MAX_BYTES,
  PROTOCOL_META_MAX_LENGTH,
  PROTOCOL_NAME_PATTERN,
  PROTOCOL_TOTAL_MAX_BYTES,
  canonicalJSON,
} from "@unagents/messenger-protocol";

/** `major.minor.patch[-prerelease][+build]`. Also matches the `0.0.0+<sha7>` form of a repo without tags. */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Longest `version`, `source` and `ref` the broker accepts. */
const MAX_FIELD_LENGTH = 1024;

/** `sha256(canonicalJSON({manifest, doc}))` as lower-case hex (design 5.4). */
export function protocolHash(manifest: unknown, doc: string): string {
  return createHash("sha256").update(canonicalJSON({ manifest, doc })).digest("hex");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export type DefinitionCheck = { ok: true } | { ok: false; code: "INVALID_DEFINITION" | "TOO_LARGE"; error: string };

/** Shape and size check of a definition sent to `/set-protocol` (design 5.4, 7.2). The hash is checked separately. */
export function checkDefinition(name: unknown, version: unknown, def: unknown): DefinitionCheck {
  const bad = (error: string): DefinitionCheck => ({ ok: false, code: "INVALID_DEFINITION", error });
  if (typeof name !== "string" || !PROTOCOL_NAME_PATTERN.test(name)) {
    return bad(`invalid protocol name (expected ${String(PROTOCOL_NAME_PATTERN)})`);
  }
  if (typeof version !== "string" || version.length > MAX_FIELD_LENGTH || !VERSION_PATTERN.test(version)) {
    return bad("invalid version (expected semver, e.g. 1.2.0 or 0.0.0+abc1234)");
  }
  if (!isPlainObject(def)) return bad("missing definition");
  const { manifest, doc, source, ref } = def as Partial<Record<keyof ProtocolDefinition, unknown>>;
  if (!isPlainObject(manifest)) return bad("definition.manifest must be an object");
  if (typeof doc !== "string") return bad("definition.doc must be a string");
  if (typeof source !== "string" || !source || source.length > MAX_FIELD_LENGTH) return bad("definition.source must be a non-empty string");
  if (typeof ref !== "string" || !ref || ref.length > MAX_FIELD_LENGTH) return bad("definition.ref must be a non-empty string");
  if (manifest.name !== name) return bad(`protocol.json "name" must equal "${name}"`);
  if (manifest.description !== undefined && typeof manifest.description !== "string") return bad('protocol.json "description" must be a string');
  if (manifest.messages !== undefined) {
    if (!isPlainObject(manifest.messages)) return bad('protocol.json "messages" must be an object');
    for (const [k, schema] of Object.entries(manifest.messages)) {
      if (!isPlainObject(schema)) return bad(`protocol.json messages.${k} must be an object (JSON Schema)`);
    }
  }
  const manifestBytes = Buffer.byteLength(JSON.stringify(manifest));
  const docBytes = Buffer.byteLength(doc);
  if (manifestBytes > PROTOCOL_MANIFEST_MAX_BYTES) {
    return { ok: false, code: "TOO_LARGE", error: `protocol.json is ${manifestBytes} bytes (limit ${PROTOCOL_MANIFEST_MAX_BYTES})` };
  }
  if (docBytes > PROTOCOL_DOC_MAX_BYTES) {
    return { ok: false, code: "TOO_LARGE", error: `PROTOCOL.md is ${docBytes} bytes (limit ${PROTOCOL_DOC_MAX_BYTES})` };
  }
  if (manifestBytes + docBytes > PROTOCOL_TOTAL_MAX_BYTES) {
    return { ok: false, code: "TOO_LARGE", error: `definition is ${manifestBytes + docBytes} bytes (limit ${PROTOCOL_TOTAL_MAX_BYTES})` };
  }
  return { ok: true };
}

/** Well-formed declarations of an untrusted list (heartbeat / register); one per name, the first wins. */
export function sanitizeDecls(list: unknown): ProtocolDecl[] {
  if (!Array.isArray(list)) return [];
  const out: ProtocolDecl[] = [];
  for (const d of list) {
    if (!isPlainObject(d)) continue;
    const { name, version, hash } = d;
    if (typeof name !== "string" || !PROTOCOL_NAME_PATTERN.test(name)) continue;
    if (typeof version !== "string" || version.length > MAX_FIELD_LENGTH || !VERSION_PATTERN.test(version)) continue;
    if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) continue;
    if (out.some((o) => o.name === name)) continue;
    out.push({ name, version, hash });
  }
  return out;
}

/** `meta` of `/send-message`: both fields strings of at most `PROTOCOL_META_MAX_LENGTH` characters. Returns the clean copy, or null. */
export function checkMeta(meta: unknown): MessageMeta | null {
  if (!isPlainObject(meta)) return null;
  const { protocol, version } = meta;
  if (typeof protocol !== "string" || typeof version !== "string") return null;
  if (protocol.length > PROTOCOL_META_MAX_LENGTH || version.length > PROTOCOL_META_MAX_LENGTH) return null;
  return { protocol, version };
}

/** `0.0.0+<sha>`: a repo without tags; counts as the lowest version. */
function isTagless(v: string): boolean {
  return v.startsWith("0.0.0+");
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/;

/** semver precedence (build metadata ignored); `0.0.0+sha` is below everything. Negative when `a` < `b`. */
export function compareVersions(a: string, b: string): number {
  const ta = isTagless(a);
  const tb = isTagless(b);
  if (ta || tb) return ta && tb ? 0 : ta ? -1 : 1;
  const ma = SEMVER.exec(a);
  const mb = SEMVER.exec(b);
  if (!ma || !mb) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 1; i <= 3; i++) {
    const x = BigInt(ma[i]!);
    const y = BigInt(mb[i]!);
    if (x !== y) return x < y ? -1 : 1;
  }
  const pa = ma[4];
  const pb = mb[4];
  if (pa === undefined && pb === undefined) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  const ia = pa.split(".");
  const ib = pb.split(".");
  for (let i = 0; i < Math.min(ia.length, ib.length); i++) {
    const x = ia[i]!;
    const y = ib[i]!;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const dx = BigInt(x);
      const dy = BigInt(y);
      if (dx !== dy) return dx < dy ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return ia.length === ib.length ? 0 : ia.length < ib.length ? -1 : 1;
}
