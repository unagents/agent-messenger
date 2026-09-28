/**
 * Test helpers: a minimal in-process npm registry (packument + tarball, fed by `npm pack`),
 * stub packages, and a runner for `dist/main.mjs`. Nothing here talks to 192.168.1.202.
 */
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const CLI_MAIN = fileURLToPath(new URL("../dist/main.mjs", import.meta.url));
export const BROKER_MAIN = join(ROOT, "packages", "broker", "dist", "main.mjs");
export const CLIENT_PKG_DIR = join(ROOT, "packages", "client");

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function tmp(prefix: string): string {
  return mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));
}

/** npm needs a writable cache; keep it out of ~/.npm. */
export const NPM_CACHE = tmp("am-cli-npmcache-");

interface StoredVersion {
  tgz: Buffer;
  file: string;
  integrity: string;
  shasum: string;
}

export interface MockRegistry {
  url: string;
  /** package names requested so far (packument GETs) */
  requests: string[];
  /** `npm pack` the directory and serve it; the version becomes `latest`. */
  publish(dir: string): { name: string; version: string };
  unpublish(name: string): void;
  close(): Promise<void>;
}

export async function startRegistry(): Promise<MockRegistry> {
  const packages = new Map<string, { latest: string; versions: Map<string, StoredVersion> }>();
  const requests: string[] = [];
  const packDest = tmp("am-cli-pack-");

  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const tarball = path.match(/^\/-\/tarball\/(.+)\/(.+\.tgz)$/);
    if (tarball) {
      const stored = packages.get(tarball[1])?.versions;
      const v = stored ? [...stored.values()].find((s) => s.file === tarball[2]) : undefined;
      if (!v) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": v.tgz.length }).end(v.tgz);
      return;
    }
    const name = path.replace(/^\//, "");
    requests.push(name);
    const pkg = packages.get(name);
    if (!pkg) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
      return;
    }
    const versions: Record<string, unknown> = {};
    for (const [version, v] of pkg.versions) {
      versions[version] = {
        name,
        version,
        dist: { tarball: `${url}-/tarball/${name}/${v.file}`, integrity: v.integrity, shasum: v.shasum },
      };
    }
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ name, "dist-tags": { latest: pkg.latest }, versions }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/`;

  return {
    url,
    requests,
    publish(dir) {
      const out = JSON.parse(
        execFileSync("npm", ["pack", "--json", "--pack-destination", packDest, dir], {
          encoding: "utf8",
          env: { ...process.env, npm_config_cache: NPM_CACHE, npm_config_update_notifier: "false" },
          stdio: ["ignore", "pipe", "ignore"],
        })
      ) as { filename: string; integrity: string; shasum: string; name: string; version: string }[];
      const p = out[0];
      const entry = packages.get(p.name) ?? { latest: p.version, versions: new Map<string, StoredVersion>() };
      entry.versions.set(p.version, {
        tgz: readFileSync(join(packDest, p.filename)),
        file: basename(p.filename),
        integrity: p.integrity,
        shasum: p.shasum,
      });
      entry.latest = p.version;
      packages.set(p.name, entry);
      return { name: p.name, version: p.version };
    },
    unpublish(name) {
      packages.delete(name);
    },
    close: () =>
      new Promise<void>((resolve) => {
        rmSync(packDest, { recursive: true, force: true });
        server.close(() => resolve());
      }),
  };
}

/** Write a stub package directory. `files` values are file contents; `*.sh`-like executables get mode 755. */
export function makeStub(
  root: string,
  name: string,
  version: string,
  pkgExtra: Record<string, unknown>,
  files: Record<string, { content: string; executable?: boolean }>
): string {
  const dir = join(root, name.replace(/^@/, "").replace("/", "__"), version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, type: "module", ...pkgExtra }, null, 2));
  for (const [rel, f] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
    if (f.executable) chmodSync(p, 0o755);
  }
  return dir;
}

/** Stub `@agent-hand/messenger-client`: node entry prints its version and argv. */
export function clientStub(root: string, version: string): string {
  return makeStub(
    root,
    "@agent-hand/messenger-client",
    version,
    { exports: { ".": { import: "./dist/index.mjs" } } },
    {
      "dist/index.mjs": { content: "export const stub = true;\n" },
      "dist/main.mjs": {
        content: `console.log("node-client v${version} argv=" + JSON.stringify(process.argv.slice(2)));\n`,
      },
    }
  );
}

/** Stub native platform package for this host: a shell script as `bin`. */
export function nativeStub(root: string, version: string): string {
  const name = `@agent-hand/messenger-client-${process.platform}-${process.arch}`;
  return makeStub(
    root,
    name,
    version,
    { bin: { "messenger-client": "./messenger-client" } },
    { "messenger-client": { content: `#!/bin/sh\necho "native-client v${version} argv=$*"\n`, executable: true } }
  );
}

/** Stub `@agent-hand/messenger-broker` with a `./main` export. */
export function brokerStub(root: string, version: string): string {
  return makeStub(
    root,
    "@agent-hand/messenger-broker",
    version,
    { exports: { ".": { import: "./dist/index.mjs" }, "./main": "./dist/main.mjs" } },
    {
      "dist/index.mjs": { content: "export const stub = true;\n" },
      "dist/main.mjs": { content: `console.log("broker-main v${version}");\n` },
    }
  );
}

/** Environment for the CLI under test: no inherited AGENT_MESSENGER_*, own cache, mock registry. */
export function cliEnv(registry: MockRegistry, pkgsDir: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("AGENT_MESSENGER_") || k.startsWith("CLAUDE_CODE_MESSAGING_")) delete env[k];
  // consola (used by citty for --help / --version) silences `log` when NODE_ENV=test / TEST is set
  delete env.NODE_ENV;
  delete env.TEST;
  delete env.VITEST;
  env.AGENT_MESSENGER_REGISTRY = registry.url;
  env.AGENT_MESSENGER_PKGS_DIR = pkgsDir;
  env.npm_config_cache = NPM_CACHE;
  env.npm_config_update_notifier = "false";
  env.NO_COLOR = "1";
  return { ...env, ...extra };
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the CLI asynchronously: the mock registry lives in this process, so a sync spawn would deadlock `npm install`. */
export function runCli(args: string[], env: Record<string, string | undefined>): Promise<CliResult> {
  return new Promise<CliResult>((resolve, reject) => {
    const p = spawn(process.execPath, [CLI_MAIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout!.setEncoding("utf8");
    p.stderr!.setEncoding("utf8");
    p.stdout!.on("data", (d: string) => (stdout += d));
    p.stderr!.on("data", (d: string) => (stderr += d));
    p.on("error", reject);
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** Start the TypeScript broker (`packages/broker/dist/main.mjs`) on a free loopback port. */
export async function startBroker(stateDir: string): Promise<{ proc: ChildProcess; port: number; id: string }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("AGENT_MESSENGER_")) delete env[k];
  Object.assign(env, {
    AGENT_MESSENGER_PORT: String(port),
    AGENT_MESSENGER_BIND: "127.0.0.1",
    AGENT_MESSENGER_DISCOVERY: "off",
    AGENT_MESSENGER_STATE: join(stateDir, "broker.json"),
    AGENT_MESSENGER_BROKER_ID: "test-broker",
  });
  const proc = spawn(process.execPath, [BROKER_MAIN], { env, stdio: ["ignore", "ignore", "pipe"] });
  proc.stderr!.on("data", () => {});
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return { proc, port, id: "test-broker" };
    } catch {
      // not yet
    }
    await sleep(100);
  }
  proc.kill();
  throw new Error("broker did not start");
}
