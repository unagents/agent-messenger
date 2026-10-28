import { describe, expect, it } from "vitest";
import { compareSemver, normalizeVersion, parseSemver } from "../src/semver.js";

const sv = (v: string) => parseSemver(v)!;

describe("normalizeVersion", () => {
  it("drops one leading v and surrounding whitespace", () => {
    expect(normalizeVersion("v1.2.0")).toBe("1.2.0");
    expect(normalizeVersion(" 1.2.0 ")).toBe("1.2.0");
    expect(normalizeVersion("vv1.2.0")).toBe("v1.2.0");
    expect(normalizeVersion("1.2.0-rc.1+b")).toBe("1.2.0-rc.1+b");
  });
});

describe("parseSemver", () => {
  it("accepts release, prerelease and build forms", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: "1", minor: "2", patch: "3", pre: [] });
    expect(parseSemver("0.0.0+abc1234")).toEqual({ major: "0", minor: "0", patch: "0", pre: [] });
    expect(parseSemver("1.0.0-rc.1+build.5")).toEqual({ major: "1", minor: "0", patch: "0", pre: ["rc", "1"] });
    expect(parseSemver("10.20.30-0.a-b")?.pre).toEqual(["0", "a-b"]);
  });

  it("rejects everything else", () => {
    for (const bad of ["", "1", "1.2", "1.2.3.4", "01.2.3", "1.02.3", "1.2.03", "v1.2.3", "1.2.3-", "1.2.3+", "1.2.3-01", "1.2.3-a..b", "1.2.x", "latest", "1.2.3-a_b"]) {
      expect(parseSemver(bad), bad).toBeNull();
    }
  });
});

describe("compareSemver", () => {
  it("orders by the semver 2.0.0 precedence rules", () => {
    const order = [
      "0.9.0",
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.2.0",
      "1.10.0",
      "2.0.0",
      "10.0.0",
    ];
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        const c = compareSemver(sv(order[i]), sv(order[j]));
        expect(Math.sign(c), `${order[i]} vs ${order[j]}`).toBe(Math.sign(i - j));
      }
    }
  });

  it("ignores build metadata and compares huge numbers as digits", () => {
    expect(compareSemver(sv("1.0.0+a"), sv("1.0.0+b"))).toBe(0);
    expect(compareSemver(sv("99999999999999999999.0.0"), sv("99999999999999999998.0.0"))).toBeGreaterThan(0);
  });
});
