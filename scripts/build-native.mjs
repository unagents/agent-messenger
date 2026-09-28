#!/usr/bin/env node
/**
 * Compile the client (`packages/client/src/main.ts`) to a native executable with
 * PerryTS and generate the platform package for this host.
 *
 *   PERRY_HOME=/path/to/spike-perry node scripts/build-native.mjs [--clean]
 *
 * PERRY_HOME layout (same on Mac and 204):
 *   <PERRY_HOME>/rel/perry            perry executable
 *   <PERRY_HOME>/rel/                 perry lib dir (PERRY_LIB_DIR)
 *   <PERRY_HOME>/bin/clang            clang (204), or
 *   <PERRY_HOME>/llvm/<dist>/bin/clang clang (Mac); PERRY_CLANG overrides the lookup
 *
 * Outputs:
 *   packages/client/native/messenger-client-<platform>-<arch>       the executable
 *   packages/client-<platform>-<arch>/package.json                  platform package manifest (committed)
 *   packages/client-<platform>-<arch>/bin/messenger-client          copy of the executable (ignored)
 *
 * `--clean` removes packages/client/node_modules/.cache/perry first (forces a full recompile).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLIENT_DIR = join(ROOT, "packages", "client");
const platform = process.platform;
const arch = process.arch;
const target = `${platform}-${arch}`;
const binaryName = `messenger-client-${target}`;

function usage(msg) {
  if (msg) console.error(`build-native: ${msg}`);
  console.error(`usage: PERRY_HOME=<dir> [PERRY_CLANG=<clang>] node scripts/build-native.mjs [--clean]

  PERRY_HOME   directory holding rel/perry (perry executable + lib dir) and clang
               (bin/clang or llvm/*/bin/clang)
  PERRY_CLANG  explicit clang path (overrides the lookup under PERRY_HOME)
  --clean      remove packages/client/node_modules/.cache/perry before compiling`);
  process.exit(1);
}

const home = process.env.PERRY_HOME;
if (!home) usage("PERRY_HOME is not set");
const perry = join(home, "rel", "perry");
const libDir = join(home, "rel");
if (!existsSync(perry)) usage(`perry executable not found: ${perry}`);

function findClang() {
  if (process.env.PERRY_CLANG) return process.env.PERRY_CLANG;
  const direct = join(home, "bin", "clang");
  if (existsSync(direct)) return direct;
  const llvm = join(home, "llvm");
  if (existsSync(llvm)) {
    for (const d of readdirSync(llvm)) {
      const c = join(llvm, d, "bin", "clang");
      if (existsSync(c)) return c;
    }
  }
  return null;
}
const clang = findClang();
if (!clang) usage(`clang not found under ${home} (bin/clang or llvm/*/bin/clang); set PERRY_CLANG`);

const clean = process.argv.includes("--clean");
if (clean) rmSync(join(CLIENT_DIR, "node_modules", ".cache", "perry"), { recursive: true, force: true });

// 1. compile
const nativeDir = join(CLIENT_DIR, "native");
mkdirSync(nativeDir, { recursive: true });
const binary = join(nativeDir, binaryName);
rmSync(binary, { force: true });
console.error(`build-native: ${perry} compile src/main.ts -o native/${binaryName} (clang=${clang})`);
const r = spawnSync(perry, ["compile", "src/main.ts", "-o", `native/${binaryName}`], {
  cwd: CLIENT_DIR,
  stdio: "inherit",
  env: { ...process.env, PERRY_LLVM_CLANG: clang, PERRY_LIB_DIR: libDir },
});
if (r.status !== 0) {
  console.error(`build-native: perry compile failed (exit ${r.status ?? r.signal})`);
  process.exit(r.status || 1);
}
if (!existsSync(binary)) {
  console.error(`build-native: perry exited 0 but ${binary} is missing`);
  process.exit(1);
}

// 2. platform package
const client = JSON.parse(readFileSync(join(CLIENT_DIR, "package.json"), "utf8"));
const pkgDir = join(ROOT, "packages", `client-${target}`);
mkdirSync(join(pkgDir, "bin"), { recursive: true });
copyFileSync(binary, join(pkgDir, "bin", "messenger-client"));
const manifest = {
  name: `${client.name}-${target}`,
  version: client.version,
  description: `agent-messenger client, native ${target} build (PerryTS). Selected by @agent-hand/messenger over the node client when installable.`,
  license: client.license,
  repository: { ...client.repository, directory: `packages/client-${target}` },
  os: [platform],
  cpu: [arch],
  bin: { "messenger-client": "./bin/messenger-client" },
  files: ["bin"],
  publishConfig: client.publishConfig,
};
writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
console.error(`build-native: wrote ${binary}`);
console.error(`build-native: wrote ${join(pkgDir, "package.json")} + bin/messenger-client`);
