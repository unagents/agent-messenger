#!/usr/bin/env node
/**
 * Compile the client (`packages/client/src/main.ts`) to a native executable with
 * PerryTS and generate the platform package for this host.
 *
 *   PERRY_HOME=/path/to/toolchain/perry node scripts/build-native.mjs [--clean]
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
 *
 * Perry's `[strip-dedup]` step needs an llvm-nm / llvm-objcopy that reads Perry's archives
 * (LLVM 23.1) on PATH. If the step does not complete, the build fails and nothing is placed
 * (see scripts/strip-dedup-check.mjs and README.md).
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkStripDedup } from "./strip-dedup-check.mjs";

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
// Perry output is shown as it arrives and also kept (per stream) to inspect the `[strip-dedup]` lines.
const r = await new Promise((resolveRun) => {
  const child = spawn(perry, ["compile", "src/main.ts", "-o", `native/${binaryName}`], {
    cwd: CLIENT_DIR,
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...process.env, PERRY_LLVM_CLANG: clang, PERRY_LIB_DIR: libDir },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    stderr += chunk;
  });
  child.on("error", (e) => resolveRun({ status: null, signal: null, spawnError: e, output: "" }));
  // "close" fires after the stdio streams are drained ("exit" can fire before)
  child.on("close", (status, signal) => resolveRun({ status, signal, output: `${stdout}\n${stderr}` }));
});
if (r.spawnError) {
  console.error(`build-native: failed to start perry: ${r.spawnError.message}`);
  process.exit(1);
}
if (r.status !== 0) {
  console.error(`build-native: perry compile failed (exit ${r.status ?? r.signal})`);
  process.exit(r.status || 1);
}
if (!existsSync(binary)) {
  console.error(`build-native: perry exited 0 but ${binary} is missing`);
  process.exit(1);
}

// 1b. check that Perry's strip-dedup completed (see scripts/strip-dedup-check.mjs)
const dedup = checkStripDedup(r.output);
if (!dedup.ok) {
  rmSync(binary, { force: true });
  console.error("build-native: [strip-dedup] did not complete; the binary is not usable and was removed:");
  for (const p of dedup.problems) console.error(`  - ${p}`);
  console.error(`build-native: put an llvm-nm / llvm-objcopy that can read Perry's archives (LLVM 23.1,
  rust nightly-2026-09-21 \`llvm-tools\`) at the front of PATH and build again, e.g.
    PATH=<llvm-tools bin dir>:$PATH PERRY_HOME=... node scripts/build-native.mjs
  How to obtain them: README.md ("ネイティブ client" section).`);
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
  description: `agent-messenger client, native ${target} build (PerryTS). Selected by @unagents/messenger over the node client when installable.`,
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
