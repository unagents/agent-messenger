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
 * `<short name>` is the package name without the `@agent-hand/` scope, `<spec>` is the
 * configured spec value with characters outside `[A-Za-z0-9._+-]` replaced by `_`, and
 * `<hash>` is sha1(`<registry>\n<full spec>`)[0..12] — same key as the loader.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoaderConfig } from "./config.js";
import { fullSpec } from "./config.js";

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

  const needsInstall = (): string | null => {
    if (cfg.refresh) return "refresh requested";
    if (!existsSync(pkgJson) || !existsSync(stamp)) return "not installed";
    if (!floating) return null;
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
    const env = { ...process.env, ["npm_config_@agent-hand:registry"]: cfg.registry };
    const r = spawnSync(
      "npm",
      ["install", "--no-audit", "--no-fund", "--no-package-lock", "--loglevel=error", "--prefix", dir, spec],
      { env, stdio: ["ignore", "ignore", "inherit"] }
    );
    if (r.status !== 0) {
      if (existsSync(pkgJson)) {
        log(`install failed, using cached ${name}`);
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
