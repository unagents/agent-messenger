import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOADER = join(ROOT, "loader", "loader.js");

test("loader: installs core from a file: spec, caches it, and runs it", () => {
  const dir = mkdtempSync(join(tmpdir(), "am-loader-"));
  const env = {
    ...process.env,
    AGENT_MESSENGER_CORE_SPEC: `file:${ROOT}`,
    AGENT_MESSENGER_CORE_DIR: dir,
  };
  try {
    // first run: install + run core with no args -> usage, exit 0
    const r1 = spawnSync(process.execPath, [LOADER], { env, encoding: "utf8" });
    assert.equal(r1.status, 0, r1.stderr);
    assert.match(r1.stderr, /installing file:/);
    assert.match(r1.stdout, /agent-messenger — Claude Code session messaging/);

    // second run: cached, no install
    const r2 = spawnSync(process.execPath, [LOADER, "nosuchcommand"], { env, encoding: "utf8" });
    assert.equal(r2.status, 1);
    assert.doesNotMatch(r2.stderr, /installing/);
    assert.match(r2.stdout, /Usage:/);

    // exactly one cache entry with the core body inside
    const entries = spawnSync("ls", [dir], { encoding: "utf8" }).stdout.trim().split("\n");
    assert.equal(entries.length, 1);
    assert.ok(existsSync(join(dir, entries[0], "node_modules", "@agent-hand", "messenger-core", "bin", "agent-messenger.js")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
