#!/usr/bin/env node
/**
 * agent-messenger loader
 *
 * Thin launcher published to the npm registry that `npx` reaches (Verdaccio).
 * The real body (@agent-hand/messenger-core) lives wherever you point it —
 * Gitea Packages by default — so the body can move without touching any
 * `claude mcp add` registration or .npmrc.
 *
 *   npx -y @agent-hand/messenger <mcp|broker|status|peers|send ...>
 *
 * Environment:
 *   AGENT_MESSENGER_CORE_SPEC      npm spec of the body
 *                                  (default: the Gitea git repo,
 *                                   "git+http://192.168.1.202/gitea/agent-hand/messenger.git#semver:^0.3";
 *                                   any npm spec works: "@scope/name@1.2.3",
 *                                   "git+http://host/repo.git#tag", "file:/path")
 *   AGENT_MESSENGER_CORE_REGISTRY  registry for the @agent-hand scope when SPEC is a
 *                                  registry spec (default Gitea Packages on 192.168.1.202)
 *   AGENT_MESSENGER_CORE_DIR       cache dir (default ~/.agent-messenger/core)
 *   AGENT_MESSENGER_CORE_REFRESH   "1" = reinstall the body now
 *   AGENT_MESSENGER_CORE_TTL_HOURS re-check a floating spec (latest / tag / range)
 *                                  after this many hours (default 24, 0 = every run)
 */
import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const CORE_NAME = "@agent-hand/messenger-core";
// Default body source: the Gitea git repository (public, anonymous clone, no
// registry token needed). Tags vX.Y.Z are resolved by semver; "^0.3" floats
// within the minor line and is re-checked every TTL_HOURS.
const SPEC =
  process.env.AGENT_MESSENGER_CORE_SPEC ?? "git+http://192.168.1.202/gitea/agent-hand/messenger.git#semver:^0.3";
// Used only when SPEC is a registry spec (e.g. "@agent-hand/messenger-core@latest").
const REGISTRY =
  process.env.AGENT_MESSENGER_CORE_REGISTRY ?? "http://192.168.1.202/gitea/api/packages/agent-hand/npm/";
const BASE_DIR = process.env.AGENT_MESSENGER_CORE_DIR ?? join(homedir(), ".agent-messenger", "core");
const REFRESH = process.env.AGENT_MESSENGER_CORE_REFRESH === "1";
const TTL_HOURS = parseFloat(process.env.AGENT_MESSENGER_CORE_TTL_HOURS ?? "24");

function log(msg) {
  console.error(`[agent-messenger loader] ${msg}`);
}

/** A spec is "pinned" when it names an exact version or a fixed git ref; anything else may move. */
function isPinned(spec) {
  const git = spec.match(/^git\+.*#(.+)$/);
  if (git) return !git[1].startsWith("semver:") && !/^(master|main|HEAD)$/.test(git[1]);
  const m = spec.match(/^(@[^/]+\/[^@]+|[^@]+)@(.+)$/);
  return Boolean(m && /^\d+\.\d+\.\d+([-+].*)?$/.test(m[2]));
}

const key = createHash("sha1").update(`${REGISTRY}\n${SPEC}`).digest("hex").slice(0, 12);
const dir = join(BASE_DIR, key);
const stamp = join(dir, ".installed");
const entry = join(dir, "node_modules", CORE_NAME, "bin", "agent-messenger.js");

function needsInstall() {
  if (REFRESH) return "refresh requested";
  if (!existsSync(entry) || !existsSync(stamp)) return "not installed";
  if (isPinned(SPEC) || TTL_HOURS < 0) return null;
  const ageH = (Date.now() - statSync(stamp).mtimeMs) / 3_600_000;
  if (ageH >= TTL_HOURS) return `floating spec, last checked ${ageH.toFixed(1)}h ago`;
  return null;
}

function install(reason) {
  log(`installing ${SPEC} (${reason}) -> ${dir}`);
  mkdirSync(dir, { recursive: true });
  const pkgJson = join(dir, "package.json");
  if (!existsSync(pkgJson)) writeFileSync(pkgJson, JSON.stringify({ name: "agent-messenger-core-cache", private: true }));
  const env = { ...process.env, ["npm_config_@agent-hand:registry"]: REGISTRY };
  const r = spawnSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--no-package-lock", "--loglevel=error", "--prefix", dir, SPEC],
    { env, stdio: ["ignore", "ignore", "inherit"] }
  );
  if (r.status !== 0) {
    if (existsSync(entry)) {
      log("install failed, using cached body");
      return;
    }
    log(`install failed (exit ${r.status}) and no cached body — cannot start`);
    process.exit(r.status || 1);
  }
  writeFileSync(stamp, new Date().toISOString());
  const now = new Date();
  utimesSync(stamp, now, now);
  const v = JSON.parse(readFileSync(join(dir, "node_modules", CORE_NAME, "package.json"), "utf8")).version;
  log(`body ready: ${CORE_NAME}@${v}`);
}

const reason = needsInstall();
if (reason) install(reason);
if (!existsSync(entry)) {
  log(`body entry not found: ${entry}`);
  process.exit(1);
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => child.kill(sig));
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
