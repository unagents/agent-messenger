/**
 * Minimal semver for protocol versions (design 6.2): parse, precedence, and the leading-`v` normalization.
 * No `BigInt` and no lookaround regex (native build): numbers are compared as digit strings.
 */

export interface Semver {
  major: string;
  minor: string;
  patch: string;
  /** dot-separated prerelease identifiers; `[]` for a release */
  pre: string[];
}

/** Strip surrounding whitespace and one leading `v` (`v1.2.0` -> `1.2.0`). */
export function normalizeVersion(v: string): string {
  const t = v.trim();
  return t.startsWith("v") ? t.slice(1) : t;
}

function isNumeric(s: string): boolean {
  return /^[0-9]+$/.test(s);
}

function noLeadingZero(s: string): boolean {
  return s.length === 1 || s.charAt(0) !== "0";
}

/** `major.minor.patch[-prerelease][+build]`, strict (no leading zeros). `null` when it is not a semver. */
export function parseSemver(v: string): Semver | null {
  let rest = v;
  const plus = rest.indexOf("+");
  if (plus !== -1) {
    const build = rest.slice(plus + 1);
    if (build === "") return null;
    for (const id of build.split(".")) if (!/^[0-9A-Za-z-]+$/.test(id)) return null;
    rest = rest.slice(0, plus);
  }
  let pre: string[] = [];
  const dash = rest.indexOf("-");
  if (dash !== -1) {
    const p = rest.slice(dash + 1);
    if (p === "") return null;
    pre = p.split(".");
    for (const id of pre) {
      if (!/^[0-9A-Za-z-]+$/.test(id)) return null;
      if (isNumeric(id) && !noLeadingZero(id)) return null;
    }
    rest = rest.slice(0, dash);
  }
  const nums = rest.split(".");
  if (nums.length !== 3) return null;
  for (const n of nums) if (!isNumeric(n) || !noLeadingZero(n)) return null;
  return { major: nums[0], minor: nums[1], patch: nums[2], pre };
}

function cmpDigits(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** semver precedence (build metadata ignored). Negative when `a` < `b`. */
export function compareSemver(a: Semver, b: Semver): number {
  let c = cmpDigits(a.major, b.major);
  if (c !== 0) return c;
  c = cmpDigits(a.minor, b.minor);
  if (c !== 0) return c;
  c = cmpDigits(a.patch, b.patch);
  if (c !== 0) return c;
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const n = Math.min(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    const nx = isNumeric(x);
    const ny = isNumeric(y);
    if (nx && ny) {
      c = cmpDigits(x, y);
      if (c !== 0) return c;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return a.pre.length === b.pre.length ? 0 : a.pre.length < b.pre.length ? -1 : 1;
}
