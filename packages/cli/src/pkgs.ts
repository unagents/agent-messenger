/**
 * Package fetch + cache, ported from `legacy/loader/loader.js`.
 *
 * Layout: `<pkgsDir>/<short name>@<spec>/<hash>/`
 *   package.json        {"name":"agent-messenger-pkg-cache","private":true}
 *   node_modules/<name> the installed package
 *   .installed          stamp; its mtime is the last successful check
 *   .missing            stamp written when an *optional* package (a native client
 *                       platform package) could not be installed; its mtime gates the retry
 *
 * `<short name>` is the package name without the `@unagents/` scope, `<spec>` is the
 * configured spec value with characters outside `[A-Za-z0-9._+-]` replaced by `_`, and
 * `<hash>` is sha1(`<registry>\n<full spec>`)[0..12] — same key as the loader.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoaderConfig } from "./config.js";
import { fullSpec } from "./config.js";
import { VERSION } from "./version.js";

export type Logger = (msg: string) => void;

export interface InstalledPackage {
  name: string;
  /** full npm spec that was installed */
  spec: string;
  /** cache directory (the `npm install --prefix` target) */
  dir: string;
  /** `<dir>/node_modules/<name>` */
  pkgDir: string;
  version: string;
}

export interface EnsureOptions {
  /**
   * `true`: the package may legitimately not exist (native client platform package).
   * Install failure then returns `null` (and is remembered via `.missing`) instead of exiting.
   */
  optional?: boolean;
  log?: Logger;
  /** CLI version used for the "cache older than the CLI" rule (default: this CLI's `VERSION`). */
  cliVersion?: string;
}

export const defaultLog: Logger = (msg) => console.error(`[agent-messenger loader] ${msg}`);

/** A spec is "pinned" when it names an exact version or a fixed git ref; anything else may move. */
export function isPinned(spec: string): boolean {
  const git = spec.match(/^git\+.*#(.+)$/);
  if (git) return !git[1].startsWith("semver:") && !/^(master|main|HEAD)$/.test(git[1]);
  const m = spec.match(/^(@[^/]+\/[^@]+|[^@]+)@(.+)$/);
  return Boolean(m && /^\d+\.\d+\.\d+([-+].*)?$/.test(m[2]));
}

export function cacheKey(registry: string, spec: string): string {
  return createHash("sha1").update(`${registry}\n${spec}`).digest("hex").slice(0, 12);
}

export function shortName(name: string): string {
  const i = name.indexOf("/");
  return i === -1 ? name : name.slice(i + 1);
}

export function sanitizeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._+-]/g, "_");
}

export function cacheDir(cfg: LoaderConfig, name: string, specValue: string): string {
  const spec = fullSpec(name, specValue);
  return join(cfg.pkgsDir, `${shortName(name)}@${sanitizeSegment(specValue.trim() || "latest")}`, cacheKey(cfg.registry, spec));
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** semver order (build metadata ignored; a prerelease is lower than its release). `null` when either side is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const ma = a.trim().match(SEMVER);
  const mb = b.trim().match(SEMVER);
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return Math.sign(d);
  }
  const pa = ma[4];
  const pb = mb[4];
  if (pa === undefined && pb === undefined) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  const ia = pa.split(".");
  const ib = pb.split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    if (ia[i] === undefined) return -1;
    if (ib[i] === undefined) return 1;
    const na = /^\d+$/.test(ia[i]);
    const nb = /^\d+$/.test(ib[i]);
    if (na && nb) {
      const d = Number(ia[i]) - Number(ib[i]);
      if (d !== 0) return Math.sign(d);
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (ia[i] !== ib[i]) {
      return ia[i] < ib[i] ? -1 : 1;
    }
  }
  return 0;
}

/** Records the CLI version for which the registry was already re-checked because the cache was older than the CLI. */
const CLI_CHECKED = ".cli-checked";

function ageHours(file: string): number {
  return (Date.now() - statSync(file).mtimeMs) / 3_600_000;
}

function touch(file: string): void {
  writeFileSync(file, new Date().toISOString());
  const now = new Date();
  utimesSync(file, now, now);
}

/**
 * Make sure `name@specValue` is installed in the cache (installing / refreshing as
 * needed) and return where it is. Exits the process when a required package cannot
 * be obtained; returns `null` for an optional one.
 */
export function ensurePackage(cfg: LoaderConfig, name: string, specValue: string, opts: EnsureOptions = {}): InstalledPackage | null {
  const log = opts.log ?? defaultLog;
  const spec = fullSpec(name, specValue);
  const dir = cacheDir(cfg, name, specValue);
  const pkgDir = join(dir, "node_modules", ...name.split("/"));
  const pkgJson = join(pkgDir, "package.json");
  const stamp = join(dir, ".installed");
  const missing = join(dir, ".missing");
  const floating = !isPinned(spec) && cfg.ttlHours >= 0;
  const cliVersion = opts.cliVersion ?? VERSION;
  const checked = join(dir, CLI_CHECKED);

  const needsInstall = (): string | null => {
    if (cfg.refresh) return "refresh requested";
    if (!existsSync(pkgJson) || !existsSync(stamp)) return "not installed";
    if (!floating) return null;
    // The cache is older than this CLI: do not wait for the TTL, but only once per CLI version
    // (the registry may itself be older than the CLI, e.g. a prerelease CLI).
    const cached = readVersion(pkgJson);
    if (compareVersions(cached, cliVersion) === -1 && readCliChecked(checked) !== cliVersion) {
      return `floating spec, cached ${cached} is older than CLI ${cliVersion}`;
    }
    const ageH = ageHours(stamp);
    if (ageH >= cfg.ttlHours) return `floating spec, last checked ${ageH.toFixed(1)}h ago`;
    return null;
  };

  const knownMissing = (): boolean => {
    if (!opts.optional || cfg.refresh || !existsSync(missing)) return false;
    if (!floating) return true;
    return ageHours(missing) < cfg.ttlHours;
  };

  const reason = needsInstall();
  if (reason === "not installed" && knownMissing()) {
    log(`${name} not available (checked ${ageHours(missing).toFixed(1)}h ago)`);
    return null;
  }

  if (reason) {
    log(`installing ${spec} (${reason}) -> ${dir}`);
    mkdirSync(dir, { recursive: true });
    const cachePkgJson = join(dir, "package.json");
    if (!existsSync(cachePkgJson)) writeFileSync(cachePkgJson, JSON.stringify({ name: "agent-messenger-pkg-cache", private: true }));
    const env = { ...process.env, ["npm_config_@unagents:registry"]: cfg.registry };
    const r = spawnSync(
      "npm",
      ["install", "--no-audit", "--no-fund", "--no-package-lock", "--loglevel=error", "--prefix", dir, spec],
      { env, stdio: ["ignore", "ignore", "inherit"] }
    );
    if (r.status !== 0) {
      if (existsSync(pkgJson)) {
        log(`install failed, using cached ${name}`);
        if (floating) writeFileSync(checked, cliVersion);
      } else if (opts.optional) {
        log(`${name} not available (install exit ${r.status})`);
        touch(missing);
        return null;
      } else {
        log(`install failed (exit ${r.status}) and no cached ${name} — cannot start`);
        process.exit(r.status || 1);
      }
    } else {
      touch(stamp);
      if (floating) writeFileSync(checked, cliVersion);
      rmSync(missing, { force: true });
      log(`ready: ${name}@${readVersion(pkgJson)}`);
    }
  }

  if (!existsSync(pkgJson)) {
    if (opts.optional) return null;
    log(`package not found after install: ${pkgJson}`);
    process.exit(1);
  }
  return { name, spec, dir, pkgDir, version: readVersion(pkgJson) };
}

function readCliChecked(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function readVersion(pkgJson: string): string {
  try {
    return String((JSON.parse(readFileSync(pkgJson, "utf8")) as { version?: unknown }).version ?? "");
  } catch {
    return "";
  }
}

interface PackageJson {
  main?: string;
  bin?: string | Record<string, string>;
  exports?: Record<string, unknown> | string;
}

function readPackageJson(pkgDir: string): PackageJson {
  return JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as PackageJson;
}

/**
 * Resolve an ESM entry of an installed package: `exports[subpath]` (string, or the
 * `import` / `default` condition), else `main` for `"."`, else `dist/<x>.mjs`.
 */
export function resolveEntry(pkgDir: string, subpath: "." | "./main"): string {
  const pkg = readPackageJson(pkgDir);
  let target: unknown;
  if (typeof pkg.exports === "string") {
    if (subpath === ".") target = pkg.exports;
  } else if (pkg.exports && typeof pkg.exports === "object") {
    target = pkg.exports[subpath];
  }
  if (target && typeof target === "object") {
    const cond = target as Record<string, unknown>;
    target = cond.import ?? cond.default;
  }
  if (typeof target !== "string") {
    target = subpath === "." ? (pkg.main ?? "dist/index.mjs") : "dist/main.mjs";
  }
  return join(pkgDir, target as string);
}

/** First `bin` entry of an installed package (the native client executable), or `null`. */
export function resolveBin(pkgDir: string): string | null {
  const pkg = readPackageJson(pkgDir);
  if (typeof pkg.bin === "string") return join(pkgDir, pkg.bin);
  if (pkg.bin && typeof pkg.bin === "object") {
    for (const k of Object.keys(pkg.bin)) return join(pkgDir, pkg.bin[k]);
  }
  return null;
}
