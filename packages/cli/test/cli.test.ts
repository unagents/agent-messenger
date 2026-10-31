import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cacheDir, fullSpec, isPinned, loadLoaderConfig, nativeClientName, DEFAULT_REGISTRY, VERSION } from "../src/index.js";
import type { MockRegistry } from "./helpers.js";
import { brokerStub, clientStub, cliEnv, CLIENT_PKG_DIR, nativeStub, NPM_CACHE, runCli, startBroker, startRegistry, tmp } from "./helpers.js";

afterAll(() => rmSync(NPM_CACHE, { recursive: true, force: true }));

const NATIVE = nativeClientName();
const CLIENT_CACHE = "messenger-client@latest";

describe("unit", () => {
  it("defaults and env names", async () => {
    const cfg = loadLoaderConfig({});
    expect(cfg.registry).toBe(DEFAULT_REGISTRY);
    expect(cfg.registry).toBe("https://registry.npmjs.org/");
    expect(cfg.brokerSpec).toBe("latest");
    expect(cfg.clientSpec).toBe("latest");
    expect(cfg.ttlHours).toBe(24);
    expect(cfg.refresh).toBe(false);
    expect(cfg.clientMode).toBe("auto");
    expect(loadLoaderConfig({ AGENT_MESSENGER_REFRESH: "1" }).refresh).toBe(true);
    expect(loadLoaderConfig({ AGENT_MESSENGER_CORE_REFRESH: "1" }).refresh).toBe(true);
    expect(loadLoaderConfig({ AGENT_MESSENGER_CLIENT: "native" }).clientMode).toBe("native");
    expect(loadLoaderConfig({ AGENT_MESSENGER_CLIENT: "NODE" }).clientMode).toBe("node");
    expect(loadLoaderConfig({ AGENT_MESSENGER_CLIENT: "x" }).clientMode).toBe("auto");
    expect(loadLoaderConfig({ AGENT_MESSENGER_PKGS_DIR: "/x" }).pkgsDir).toBe("/x");
  });

  it("fullSpec / isPinned", async () => {
    const n = "@unagents/messenger-client";
    expect(fullSpec(n, "latest")).toBe(`${n}@latest`);
    expect(fullSpec(n, "@latest")).toBe(`${n}@latest`);
    expect(fullSpec(n, "1.2.3")).toBe(`${n}@1.2.3`);
    expect(fullSpec(n, "")).toBe(`${n}@latest`);
    expect(fullSpec(n, "file:/tmp/x.tgz")).toBe("file:/tmp/x.tgz");
    expect(fullSpec(n, `${n}@next`)).toBe(`${n}@next`);
    expect(isPinned(`${n}@1.2.3`)).toBe(true);
    expect(isPinned(`${n}@latest`)).toBe(false);
    expect(isPinned(`${n}@^1.2.0`)).toBe(false);
    expect(isPinned("git+http://h/r.git#v1")).toBe(true);
    expect(isPinned("git+http://h/r.git#main")).toBe(false);
  });

  it("cache directory layout: <pkgs>/<short name>@<spec>/<hash>", async () => {
    const cfg = loadLoaderConfig({ AGENT_MESSENGER_PKGS_DIR: "/p", AGENT_MESSENGER_REGISTRY: "http://r/" });
    const d = cacheDir(cfg, "@unagents/messenger-client", "latest");
    expect(d).toMatch(/^\/p\/messenger-client@latest\/[0-9a-f]{12}$/);
    expect(cacheDir(cfg, NATIVE, "latest")).toMatch(new RegExp(`^/p/messenger-client-${process.platform}-${process.arch}@latest/[0-9a-f]{12}$`));
    expect(cacheDir(cfg, "@unagents/messenger-broker", "file:/tmp/b.tgz")).toMatch(/^\/p\/messenger-broker@file__tmp_b.tgz\/[0-9a-f]{12}$/);
    // different registry -> different hash
    expect(cacheDir({ ...cfg, registry: "http://other/" }, "@unagents/messenger-client", "latest")).not.toBe(d);
  });
});

describe("help / version", () => {
  it("--help lists the sub-commands, --version prints the package version", async () => {
    // no registry is contacted by --help / --version; the cache dir stays empty
    const pkgs = tmp("am-cli-pkgs-");
    const env = cliEnv({ url: "http://127.0.0.1:1/", requests: [] } as unknown as MockRegistry, pkgs);
    const h = await runCli(["--help"], env);
    expect(h.status).toBe(0);
    for (const c of ["mcp", "broker", "status", "peers", "send", "discover"]) expect(h.stdout).toMatch(new RegExp(`\\b${c}\\b`));
    expect(h.stdout).toMatch(/USAGE/);
    const v = await runCli(["--version"], env);
    expect(v.status).toBe(0);
    expect(v.stdout.trim()).toBe(VERSION);
    expect(VERSION).toBe("0.11.0");
    const u = await runCli(["nosuchcommand"], env);
    expect(u.status).toBe(1);
    expect(u.stdout).toMatch(/USAGE/);
    expect(readdirSync(pkgs)).toHaveLength(0);
    rmSync(pkgs, { recursive: true, force: true });
  });
});

describe("package fetch + cache (ported from test/loader.test.js)", () => {
  let registry: MockRegistry;
  let stubs: string;
  beforeAll(async () => {
    registry = await startRegistry();
    stubs = tmp("am-cli-stubs-");
  });
  afterAll(async () => {
    await registry.close();
    rmSync(stubs, { recursive: true, force: true });
  });

  it("installs the node client from the registry, caches it, and runs it (no platform package)", async () => {
    registry.publish(clientStub(stubs, "1.0.0"));
    const pkgs = tmp("am-cli-pkgs-");
    const env = cliEnv(registry, pkgs);
    try {
      const r1 = await runCli(["mcp"], env);
      expect(r1.status, r1.stderr).toBe(0);
      expect(r1.stderr).toMatch(/installing @unagents\/messenger-client@latest \(not installed\)/);
      expect(r1.stderr).toMatch(new RegExp(`${NATIVE} not available`));
      expect(r1.stdout).toMatch(/^node-client v1\.0\.0 argv=\[\]$/m);

      // second run: cached, no install, native not re-checked
      const before = registry.requests.filter((n) => n === NATIVE).length;
      const r2 = await runCli([], env);
      expect(r2.status).toBe(0);
      expect(r2.stderr).not.toMatch(/installing/);
      expect(r2.stderr).toMatch(new RegExp(`${NATIVE} not available \\(checked`));
      expect(r2.stdout).toMatch(/^node-client v1\.0\.0/m);
      expect(registry.requests.filter((n) => n === NATIVE).length).toBe(before);

      // exactly one cache entry per package with the body inside
      const entries = readdirSync(join(pkgs, CLIENT_CACHE));
      expect(entries).toHaveLength(1);
      expect(existsSync(join(pkgs, CLIENT_CACHE, entries[0], "node_modules", "@unagents", "messenger-client", "dist", "main.mjs"))).toBe(true);
      expect(existsSync(join(pkgs, CLIENT_CACHE, entries[0], ".installed"))).toBe(true);
      const nativeEntries = readdirSync(join(pkgs, `messenger-client-${process.platform}-${process.arch}@latest`));
      expect(nativeEntries).toHaveLength(1);
      expect(existsSync(join(pkgs, `messenger-client-${process.platform}-${process.arch}@latest`, nativeEntries[0], ".missing"))).toBe(true);
    } finally {
      rmSync(pkgs, { recursive: true, force: true });
    }
  });

  it("AGENT_MESSENGER_REFRESH=1 (and the old AGENT_MESSENGER_CORE_REFRESH=1) reinstalls", async () => {
    registry.publish(clientStub(stubs, "1.0.0"));
    const pkgs = tmp("am-cli-pkgs-");
    const env = cliEnv(registry, pkgs);
    try {
      expect((await runCli(["mcp"], env)).stdout).toMatch(/node-client v1\.0\.0/);
      registry.publish(clientStub(stubs, "1.0.1"));
      // still cached
      const r2 = await runCli(["mcp"], env);
      expect(r2.stderr).not.toMatch(/installing/);
      expect(r2.stdout).toMatch(/node-client v1\.0\.0/);
      // refresh -> new version
      const r3 = await runCli(["mcp"], { ...env, AGENT_MESSENGER_REFRESH: "1" });
      expect(r3.status, r3.stderr).toBe(0);
      expect(r3.stderr).toMatch(/installing @unagents\/messenger-client@latest \(refresh requested\)/);
      expect(r3.stdout).toMatch(/node-client v1\.0\.1/);
      // old name still accepted
      const r4 = await runCli(["mcp"], { ...env, AGENT_MESSENGER_CORE_REFRESH: "1" });
      expect(r4.stderr).toMatch(/\(refresh requested\)/);
      expect(r4.stdout).toMatch(/node-client v1\.0\.1/);
      // TTL 0 = re-check every run
      const r5 = await runCli(["mcp"], { ...env, AGENT_MESSENGER_TTL_HOURS: "0" });
      expect(r5.stderr).toMatch(/\(floating spec, last checked/);
    } finally {
      rmSync(pkgs, { recursive: true, force: true });
    }
  });

  it("AGENT_MESSENGER_CLIENT_SPEC pins a version", async () => {
    registry.publish(clientStub(stubs, "1.0.0"));
    registry.publish(clientStub(stubs, "1.0.1"));
    const pkgs = tmp("am-cli-pkgs-");
    try {
      const r = await runCli(["mcp"], cliEnv(registry, pkgs, { AGENT_MESSENGER_CLIENT_SPEC: "1.0.0", AGENT_MESSENGER_CLIENT: "node" }));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/node-client v1\.0\.0/);
      expect(readdirSync(join(pkgs, "messenger-client@1.0.0"))).toHaveLength(1);
      // pinned: TTL 0 does not re-check
      const r2 = await runCli(["mcp"], cliEnv(registry, pkgs, { AGENT_MESSENGER_CLIENT_SPEC: "1.0.0", AGENT_MESSENGER_CLIENT: "node", AGENT_MESSENGER_TTL_HOURS: "0" }));
      expect(r2.stderr).not.toMatch(/installing/);
    } finally {
      rmSync(pkgs, { recursive: true, force: true });
    }
  });
});

describe("mcp: native platform package vs node client", () => {
  let registry: MockRegistry;
  let stubs: string;
  beforeAll(async () => {
    registry = await startRegistry();
    stubs = tmp("am-cli-stubs-");
    registry.publish(clientStub(stubs, "2.0.0"));
  });
  afterAll(async () => {
    await registry.close();
    rmSync(stubs, { recursive: true, force: true });
  });

  it("uses the native package when the registry has it, node when forced", async () => {
    registry.publish(nativeStub(stubs, "2.0.0"));
    const pkgs = tmp("am-cli-pkgs-");
    try {
      const r = await runCli(["mcp"], cliEnv(registry, pkgs));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(new RegExp(`installing ${NATIVE}@latest \\(not installed\\)`));
      expect(r.stdout).toMatch(/^native-client v2\.0\.0 argv=$/m);
      expect(r.stdout).not.toMatch(/node-client/);
      // node client was not fetched at all
      expect(existsSync(join(pkgs, CLIENT_CACHE))).toBe(false);

      const forced = await runCli(["mcp"], cliEnv(registry, pkgs, { AGENT_MESSENGER_CLIENT: "node" }));
      expect(forced.status, forced.stderr).toBe(0);
      expect(forced.stdout).toMatch(/^node-client v2\.0\.0/m);

      const native = await runCli(["mcp"], cliEnv(registry, pkgs, { AGENT_MESSENGER_CLIENT: "native" }));
      expect(native.stdout).toMatch(/^native-client v2\.0\.0/m);
    } finally {
      registry.unpublish(NATIVE);
      rmSync(pkgs, { recursive: true, force: true });
    }
  });

  it("falls back to node when the native executable cannot run; AGENT_MESSENGER_CLIENT=native still runs it", async () => {
    registry.publish(nativeStub(stubs, "2.0.0", { broken: true }));
    const pkgs = tmp("am-cli-pkgs-");
    try {
      const r = await runCli(["mcp"], cliEnv(registry, pkgs));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/^node-client v2\.0\.0/m);
      expect(r.stderr).not.toMatch(/has no bin entry/);
      expect(r.stderr).toMatch(new RegExp(`${NATIVE} cannot run on this host \\(.*GLIBC_2\\.39.*\\), using node client`));
      const f = await runCli(["mcp"], cliEnv(registry, pkgs, { AGENT_MESSENGER_CLIENT: "native" }));
      expect(f.status).toBe(1);
      expect(f.stderr).toMatch(/GLIBC_2\.39/);
    } finally {
      registry.unpublish(NATIVE);
      rmSync(pkgs, { recursive: true, force: true });
    }
  });

  it("falls back to node when the platform package is missing; AGENT_MESSENGER_CLIENT=native then fails", async () => {
    const pkgs = tmp("am-cli-pkgs-");
    try {
      const r = await runCli(["mcp"], cliEnv(registry, pkgs));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/^node-client v2\.0\.0/m);
      const f = await runCli(["mcp"], cliEnv(registry, pkgs, { AGENT_MESSENGER_CLIENT: "native" }));
      expect(f.status).toBe(1);
      expect(f.stderr).toMatch(new RegExp(`no cached ${NATIVE} — cannot start`));
    } finally {
      rmSync(pkgs, { recursive: true, force: true });
    }
  });
});

describe("broker", () => {
  it("runs @unagents/messenger-broker/main", async () => {
    const registry = await startRegistry();
    const stubs = tmp("am-cli-stubs-");
    const pkgs = tmp("am-cli-pkgs-");
    try {
      registry.publish(brokerStub(stubs, "3.0.0"));
      const r = await runCli(["broker"], cliEnv(registry, pkgs));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/installing @unagents\/messenger-broker@latest \(not installed\)/);
      expect(r.stdout).toMatch(/^broker-main v3\.0\.0$/m);
      expect(readdirSync(join(pkgs, "messenger-broker@latest"))).toHaveLength(1);
    } finally {
      await registry.close();
      rmSync(stubs, { recursive: true, force: true });
      rmSync(pkgs, { recursive: true, force: true });
    }
  });
});

describe("status / peers / send / discover (real client package, TypeScript broker)", () => {
  let registry: MockRegistry;
  let pkgs: string;
  let state: string;
  let broker: Awaited<ReturnType<typeof startBroker>>;
  let env: Record<string, string | undefined>;

  beforeAll(async () => {
    registry = await startRegistry();
    registry.publish(CLIENT_PKG_DIR);
    pkgs = tmp("am-cli-pkgs-");
    state = tmp("am-cli-state-");
    broker = await startBroker(state);
    env = cliEnv(registry, pkgs, {
      AGENT_MESSENGER_CLIENT: "node",
      AGENT_MESSENGER_HOST: "127.0.0.1",
      AGENT_MESSENGER_PORT: String(broker.port),
      // keep discovery probes on loopback (never the LAN)
      AGENT_MESSENGER_DISCOVERY_ADDR: "127.0.0.1",
      AGENT_MESSENGER_DISCOVERY_PORT: String(broker.port + 1),
      AGENT_MESSENGER_DISCOVERY_TIMEOUT_MS: "200",
    });
  });
  afterAll(async () => {
    broker.proc.kill("SIGTERM");
    await registry.close();
    rmSync(pkgs, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  it("status", async () => {
    const r = await runCli(["status"], env);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/installing @unagents\/messenger-client@latest/);
    expect(r.stdout.trim()).toBe(`Broker: ok v0.11.0 id=test-broker (0 peer(s)) at http://127.0.0.1:${broker.port} (via env)`);
  });

  it("peers", async () => {
    const r = await runCli(["peers"], env);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/installing/);
    expect(r.stdout.trim()).toBe("No peers registered.");
  });

  it("send", async () => {
    const usage = await runCli(["send", "only-target"], env);
    expect(usage.status).toBe(1);
    expect(usage.stderr).toMatch(/Usage: agent-messenger send <name\|id> <message\.\.\.>/);
    const r = await runCli(["send", "nobody", "hello", "there"], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^Failed: /m);
  });

  it("discover", async () => {
    const r = await runCli(["discover"], env);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^discovery: 0 broker\(s\) answered$/m);
    expect(r.stdout).toMatch(new RegExp(`^resolved: http://127\\.0\\.0\\.1:${broker.port} \\(via env\\)$`, "m"));
  });

  it("status: broker down -> exit 1", async () => {
    const r = await runCli(["status"], { ...env, AGENT_MESSENGER_PORT: String(broker.port + 2) });
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe(`Broker at http://127.0.0.1:${broker.port + 2} (via env) is not running.`);
  });
});
