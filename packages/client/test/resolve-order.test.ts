/**
 * Resolution order without any socket: a stub broker client says which URLs are healthy.
 * pin > env > saved (client.json, then legacy config.json / options.brokers) > discovery > local.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrokerClient } from "../src/broker.js";
import { loadConfig } from "../src/config.js";
import { normalizeBrokerUrl, rankBrokers, resolveBroker } from "../src/resolve.js";
import type { DiscoveredBroker } from "../src/resolve.js";
import { readSavedBroker, writeSavedBroker } from "../src/saved-broker.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function setup(env: Record<string, string> = {}, healthy: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "am-order-"));
  dirs.push(dir);
  const cfg = loadConfig({
    AGENT_MESSENGER_DISCOVERY: "off",
    AGENT_MESSENGER_CONFIG: join(dir, "config.json"),
    AGENT_MESSENGER_CLIENT_STATE: join(dir, "client.json"),
    ...env,
  });
  let url = "";
  const checked: string[] = [];
  const broker = {
    setUrl: (u: string) => void (url = u),
    getUrl: () => url,
    health: async (u?: string) => {
      checked.push(u ?? url);
      return healthy.includes(u ?? url) ? ({ status: "ok", version: "0.11.0", id: "x", port: 7901, peers: 0 } as const) : null;
    },
  } as unknown as BrokerClient;
  const logs: string[] = [];
  return { dir, cfg, broker, logs, checked, log: (m: string) => void logs.push(m), url: () => url };
}

describe("resolveBroker order", () => {
  it("pin wins over env, saved and everything", async () => {
    const s = setup({ AGENT_MESSENGER_HOST: "10.0.0.9" }, ["http://10.0.0.5:7901"]);
    writeSavedBroker(s.cfg, "http://10.0.0.7:7901");
    const r = await resolveBroker(s.cfg, s.broker, s.log, undefined, "http://10.0.0.5:7901");
    expect(r).toMatchObject({ url: "http://10.0.0.5:7901", kind: "set_broker", source: "set_broker", isLocal: false });
    expect(s.url()).toBe("http://10.0.0.5:7901");
    expect(s.checked).toEqual([]);
  });

  it("env comes next (kind env), without health check", async () => {
    const s = setup({ AGENT_MESSENGER_HOST: "10.0.0.9" });
    writeSavedBroker(s.cfg, "http://10.0.0.7:7901");
    const r = await resolveBroker(s.cfg, s.broker, s.log);
    expect(r).toMatchObject({ url: "http://10.0.0.9:7901", kind: "env", source: "env" });
  });

  it("client.json is used before the legacy config.json (kind saved)", async () => {
    const s = setup({}, ["http://10.0.0.7:7901", "http://10.0.0.8:7901"]);
    writeSavedBroker(s.cfg, "http://10.0.0.7:7901");
    writeFileSync(s.cfg.configFile, JSON.stringify({ brokers: ["10.0.0.8"] }));
    const r = await resolveBroker(s.cfg, s.broker, s.log);
    expect(r).toMatchObject({ url: "http://10.0.0.7:7901", kind: "saved" });
    expect(r.source).toBe(`saved ${s.cfg.clientFile}`);
    expect(s.logs.join("\n")).not.toMatch(/deprecated/);
  });

  it("an unreachable saved broker falls through to the legacy config, which logs the deprecation once", async () => {
    const s = setup({}, ["http://10.0.0.8:7901"]);
    writeSavedBroker(s.cfg, "http://10.0.0.7:7901");
    writeFileSync(s.cfg.configFile, JSON.stringify({ brokers: ["10.0.0.8"] }));
    const r = await resolveBroker(s.cfg, s.broker, s.log);
    expect(r).toMatchObject({ url: "http://10.0.0.8:7901", kind: "saved", source: `config ${s.cfg.configFile}` });
    expect(s.logs).toContain("saved broker not reachable: http://10.0.0.7:7901");
    expect(s.logs.filter((l) => l.includes("config.json brokers is deprecated; use set_broker(url, persist: true)"))).toHaveLength(1);
    await resolveBroker(s.cfg, s.broker, s.log);
    expect(s.logs.filter((l) => l.includes("deprecated"))).toHaveLength(1);
  });

  it("options.brokers behave like a saved broker, without the deprecation", async () => {
    const s = setup({}, ["http://10.0.0.3:7901"]);
    const r = await resolveBroker(s.cfg, s.broker, s.log, ["10.0.0.4", "10.0.0.3"]);
    expect(r).toMatchObject({ url: "http://10.0.0.3:7901", kind: "saved", source: "config (options)" });
    expect(s.logs.join("\n")).not.toMatch(/deprecated/);
  });

  it("nothing reachable and discovery off: local fallback (kind fallback)", async () => {
    const s = setup();
    const r = await resolveBroker(s.cfg, s.broker, s.log);
    expect(r).toMatchObject({ url: "http://127.0.0.1:7901", kind: "fallback", source: "local fallback", isLocal: true });
  });
});

describe("saved broker file", () => {
  it("round-trips, keeps nothing after removal, and survives a corrupt file", () => {
    const s = setup();
    expect(readSavedBroker(s.cfg)).toBeNull();
    writeSavedBroker(s.cfg, "http://10.0.0.7:7901");
    expect(readSavedBroker(s.cfg)).toBe("http://10.0.0.7:7901");
    const raw = JSON.parse(readFileSync(s.cfg.clientFile, "utf8"));
    expect(raw.broker).toBe("http://10.0.0.7:7901");
    expect(Number.isNaN(Date.parse(raw.saved_at))).toBe(false);
    writeSavedBroker(s.cfg, null);
    expect(readSavedBroker(s.cfg)).toBeNull();
    writeFileSync(s.cfg.clientFile, "not json");
    expect(readSavedBroker(s.cfg)).toBeNull();
    writeSavedBroker(s.cfg, "http://10.0.0.1:7901");
    expect(readSavedBroker(s.cfg)).toBe("http://10.0.0.1:7901");
  });
});

describe("normalizeBrokerUrl", () => {
  it("adds http:// and the default port", () => {
    expect(normalizeBrokerUrl("192.168.1.204")).toBe("http://192.168.1.204:7901");
    expect(normalizeBrokerUrl("host:9000")).toBe("http://host:9000");
    expect(normalizeBrokerUrl(" http://h/ ")).toBe("http://h:7901");
  });
  it("rejects other schemes and garbage with INVALID_BROKER_URL", () => {
    for (const bad of ["https://h", "ftp://h", "", "a b", "http://"]) {
      expect(() => normalizeBrokerUrl(bad)).toThrow(/^INVALID_BROKER_URL: Invalid broker URL: /);
    }
  });
});

describe("rankBrokers", () => {
  const b = (id: string, fallback: boolean, mesh: boolean): DiscoveredBroker => ({ url: `http://${id}:1`, host: id, port: 1, id, version: "", fallback, mesh });
  it("real before fallback, mesh before plain, arrival order otherwise", () => {
    const out = rankBrokers([b("fb", true, false), b("plain1", false, false), b("mesh1", false, true), b("plain2", false, false), b("mesh2", false, true)]);
    expect(out.map((x) => x.id)).toEqual(["mesh1", "mesh2", "plain1", "plain2", "fb"]);
  });
});
