import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Mesh membership proof (0.11.0): `hex(HMAC-SHA256(key = token, "am-mesh/1|" + nonce + "|" + id + "|" + port))`
 * cut to 32 hex characters (128 bit). The token itself never goes on the wire. `nonce` is the probe's `n`
 * (reply) or the announce `ts` as a decimal string (announce).
 */
export function meshMac(token: string, nonce: string, id: string, port: number): string {
  return createHmac("sha256", token).update(`am-mesh/1|${nonce}|${id}|${port}`).digest("hex").slice(0, 32);
}

/** Constant-time check of a received `mac` against the one computed with our token. */
export function meshMacEqual(expected: string, received: unknown): boolean {
  if (typeof received !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}
