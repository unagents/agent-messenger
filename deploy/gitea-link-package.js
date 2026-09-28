#!/usr/bin/env node
// Links a Gitea package to a repository so it shows up in the repository's
// "Packages" tab. Uses the credential git already stores for the Gitea host.
// Prints nothing secret.
//
//   node deploy/gitea-link-package.js [gitea-base-url] [owner] [type] [package] [repo]
//   default: http://192.168.1.202/gitea agent-hand npm @agent-hand/messenger-core messenger
//   (API: POST /packages/{owner}/{type}/{name}/-/link/{repo_name} — links every version)
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";

const [base = "http://192.168.1.202/gitea", owner = "agent-hand", type = "npm", pkg = "@agent-hand/messenger-core", repo = "messenger"] =
  process.argv.slice(2);

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
const auth = "Basic " + Buffer.from(`${kv.username}:${kv.password}`).toString("base64");
// GITEA_API_BASE lets the API go straight to Gitea (e.g. http://127.0.0.1:6000) when a
// reverse proxy in front rewrites %2F in the scoped package name and breaks the route.
const api = `${(process.env.GITEA_API_BASE ?? base).replace(/\/$/, "")}/api/v1`;
const enc = encodeURIComponent;

// node:http rather than fetch: fetch refuses "bad ports" such as 6000 (Gitea's direct port).
function call(method, path) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${api}${path}`);
    const req = httpRequest(
      u,
      { method, headers: { Authorization: auth, Accept: "application/json", "Content-Length": 0 } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

const link = await call("POST", `/packages/${enc(owner)}/${enc(type)}/${enc(pkg)}/-/link/${enc(repo)}`);
if (link.status >= 200 && link.status < 300) {
  console.log(`linked ${type} ${pkg} -> ${owner}/${repo}`);
} else {
  console.error(`link failed: ${link.status} ${link.body.slice(0, 300)}`);
  process.exit(1);
}
