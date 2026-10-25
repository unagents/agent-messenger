#!/usr/bin/env node
// Adds a Gitea Packages npm auth line to ~/.npmrc using the credential that
// git already stores for this Gitea host. Prints nothing secret.
//
//   node deploy/npmrc-gitea-auth.js [gitea-base-url] [owner]
//   default: http://192.168.1.202/gitea  unagents
import { spawnSync } from "node:child_process";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] ?? "http://192.168.1.202/gitea";
const owner = process.argv[3] ?? "unagents";
const u = new URL(base);
const registryPath = `//${u.host}${u.pathname.replace(/\/$/, "")}/api/packages/${owner}/npm/`;
const npmrc = join(homedir(), ".npmrc");

const existing = existsSync(npmrc) ? readFileSync(npmrc, "utf8") : "";
if (existing.includes(`${registryPath}:_auth=`) || existing.includes(`${registryPath}:_authToken=`)) {
  console.log(`already configured: ${registryPath}`);
  process.exit(0);
}

const r = spawnSync("git", ["credential", "fill"], {
  input: `url=${base}\n\n`,
  encoding: "utf8",
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
});
if (r.status !== 0) {
  console.error("git credential fill failed");
  process.exit(1);
}
const kv = Object.fromEntries(
  r.stdout
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
if (!kv.username || !kv.password) {
  console.error("no stored credential for " + base);
  process.exit(1);
}
const auth = Buffer.from(`${kv.username}:${kv.password}`).toString("base64");
appendFileSync(npmrc, `${registryPath}:_auth=${auth}\n`);
console.log(`configured: ${registryPath} (user ${kv.username})`);
