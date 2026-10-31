/** The old `config.json` is never read; its presence only prints a one-time notice. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEGACY_CONFIG_NOTICE, noticeLegacyConfig, resetLegacyConfigNotice } from "../src/legacy-config.js";

const dirs: string[] = [];
beforeEach(() => resetLegacyConfigNotice());
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function stateDir(withConfig: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "am-legacy-"));
  dirs.push(dir);
  if (withConfig) writeFileSync(join(dir, "config.json"), JSON.stringify({ brokers: ["10.0.0.8"] }));
  return dir;
}

describe("noticeLegacyConfig", () => {
  it("says nothing when there is no config.json", () => {
    const logs: string[] = [];
    noticeLegacyConfig(stateDir(false), (m) => void logs.push(m));
    expect(logs).toEqual([]);
  });

  it("prints the notice once per process when config.json exists", () => {
    const logs: string[] = [];
    const dir = stateDir(true);
    noticeLegacyConfig(dir, (m) => void logs.push(m));
    noticeLegacyConfig(dir, (m) => void logs.push(m));
    expect(logs).toEqual([LEGACY_CONFIG_NOTICE]);
    expect(LEGACY_CONFIG_NOTICE).toContain("set_broker(url, persist: true)");
  });
});
