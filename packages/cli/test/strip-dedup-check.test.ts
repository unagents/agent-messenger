import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkStripDedup, outputsToRemoveOnFailure } from "../../../scripts/strip-dedup-check.mjs";

const fixture = (name: string) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "strip-dedup", name), "utf8");

describe("checkStripDedup (scripts/build-native.mjs)", () => {
  it("accepts the linux-x64 output captured on 204 (keeping lines and the `Perry workspace source not found` note are not failures)", () => {
    const r = checkStripDedup(fixture("linux-success.txt"));
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("accepts the darwin-arm64 output (LLVM 23.1 llvm-tools on PATH)", () => {
    const r = checkStripDedup(fixture("darwin-success.txt"));
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("rejects the no-tools output (objcopy / llvm-objcopy not found)", () => {
    const r = checkStripDedup(fixture("fail-no-tools.txt"));
    expect(r.ok).toBe(false);
    const joined = r.problems.join("\n");
    expect(joined).toContain("archive preparation was incomplete");
    expect(joined).toContain("not found");
    expect(joined).toContain("failed to inspect");
    expect(joined).toContain("(non-fatal) skipped");
  });

  it("rejects the LLVM 18 output (failed to inspect ...)", () => {
    const r = checkStripDedup(fixture("fail-llvm18.txt"));
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("failed to inspect archive symbols");
    expect(r.problems.join("\n")).toContain("failed to inspect libperry_runtime.a symbols");
  });

  it("rejects each failure marker on its own, even when the success marker is present", () => {
    const ok = "[strip-dedup] x: localized wrapper-only globals in 3 member(s)\n";
    for (const line of [
      "[strip-dedup] warning: archive preparation was incomplete; linking the full stdlib",
      "[strip-dedup] shared-deps drop skipped for a.a (non-fatal): boom",
      "[strip-dedup] tool problem: objcopy not found",
      "[strip-dedup] failed to inspect defined symbols of a.a",
    ]) {
      expect(checkStripDedup(`${ok}${line}\n`).ok, line).toBe(false);
    }
  });

  it("does not fail on a `(non-fatal)` line that is not a skip notice", () => {
    const text = "[strip-dedup] info (non-fatal): something harmless\n[strip-dedup] w: localized wrapper-only globals in 1 member(s)\n";
    expect(checkStripDedup(text).ok).toBe(true);
  });

  it("ignores `not found` on lines without [strip-dedup]", () => {
    const text = "warning: foo not found\n[strip-dedup] w: localized wrapper-only globals in 1 member(s)\n";
    expect(checkStripDedup(text).ok).toBe(true);
  });

  it("rejects output with no [strip-dedup] line", () => {
    const r = checkStripDedup("Linking (with stdlib)...\nWrote executable: native/x\n");
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("no [strip-dedup] line");
  });

  it("rejects output with [strip-dedup] lines but no success marker", () => {
    const r = checkStripDedup("[strip-dedup] libperry_ext_net.a: dropped 706 bundled member(s) also provided by stdlib\n");
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("success marker missing");
  });

  it("on failure, removes both the Perry output and the platform package copy", () => {
    expect(outputsToRemoveOnFailure("/r", "linux-x64")).toEqual([
      "/r/packages/client/native/messenger-client-linux-x64",
      "/r/packages/client-linux-x64/bin/messenger-client",
    ]);
    expect(outputsToRemoveOnFailure("/r", "darwin-arm64")).toEqual([
      "/r/packages/client/native/messenger-client-darwin-arm64",
      "/r/packages/client-darwin-arm64/bin/messenger-client",
    ]);
  });

  it("handles CRLF line endings", () => {
    expect(checkStripDedup(fixture("fail-no-tools.txt").replace(/\n/g, "\r\n")).ok).toBe(false);
    expect(checkStripDedup(fixture("linux-success.txt").replace(/\n/g, "\r\n")).ok).toBe(true);
  });
});
