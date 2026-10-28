import { describe, expect, test } from "vitest";
import { meshMac } from "@unagents/messenger-protocol";
import { buildAnnounce, parseDiscoveryTargets, sendTargets } from "../src/discovery.js";
import { MeshPeerTable, meshExpireMs } from "../src/mesh-peers.js";

const TOKEN = "secret";

function table(opts: { now: () => number; token?: string; selfId?: string; onDrop?: (u: string) => void; onJoin?: (id: string) => void }) {
  return new MeshPeerTable({
    selfId: opts.selfId ?? "self",
    token: opts.token ?? TOKEN,
    expireMs: meshExpireMs(10_000),
    now: opts.now,
    ...(opts.onDrop ? { onDrop: opts.onDrop } : {}),
    ...(opts.onJoin ? { onJoin: (e) => opts.onJoin!(e.id) } : {}),
  });
}

const announce = (id: string, port: number, ts: number, token = TOKEN) => buildAnnounce({ token, id, port, version: "0.11.0", ts }) as unknown as Record<string, unknown>;

describe("meshExpireMs", () => {
  test("is three announce periods plus 5 s (10 s -> 35 s)", () => {
    expect(meshExpireMs(10_000)).toBe(35_000);
    expect(meshExpireMs(500)).toBe(6_500);
  });
});

describe("buildAnnounce", () => {
  test("mac is bound to ts, id and port with the token as key", () => {
    const a = buildAnnounce({ token: TOKEN, id: "204", port: 7901, version: "0.11.0", ts: 1234 });
    expect(a).toMatchObject({ "agent-messenger": "announce", id: "204", port: 7901, version: "0.11.0", mesh: true, ts: 1234 });
    expect(a.mac).toBe(meshMac(TOKEN, "1234", "204", 7901));
    expect(JSON.stringify(a)).not.toContain(TOKEN);
  });
});

describe("MeshPeerTable: announce", () => {
  test("a valid announce registers the broker at the UDP source address", () => {
    const t = table({ now: () => 1_000_000 });
    expect(t.handleAnnounce(announce("204", 7901, 1_000_000), "192.168.1.204")).toBe(true);
    expect(t.urls()).toEqual(["http://192.168.1.204:7901"]);
    expect(t.entries()[0]).toMatchObject({ id: "204", version: "0.11.0", lastSeen: 1_000_000 });
  });

  test("a token mismatch is ignored", () => {
    const t = table({ now: () => 1_000_000 });
    expect(t.handleAnnounce(announce("204", 7901, 1_000_000, "other"), "10.0.0.1")).toBe(false);
    expect(t.urls()).toEqual([]);
  });

  test("empty tokens on both sides match; empty vs non-empty does not", () => {
    const empty = table({ now: () => 1_000_000, token: "" });
    expect(empty.handleAnnounce(announce("a", 1, 1_000_000, ""), "10.0.0.1")).toBe(true);
    expect(empty.handleAnnounce(announce("b", 1, 1_000_000, "x"), "10.0.0.2")).toBe(false);
    const full = table({ now: () => 1_000_000 });
    expect(full.handleAnnounce(announce("a", 1, 1_000_000, ""), "10.0.0.1")).toBe(false);
  });

  test("a changed port or id breaks the mac", () => {
    const t = table({ now: () => 1_000_000 });
    const a = announce("204", 7901, 1_000_000);
    expect(t.handleAnnounce({ ...a, port: 7777 }, "10.0.0.1")).toBe(false);
    expect(t.handleAnnounce({ ...a, id: "evil" }, "10.0.0.1")).toBe(false);
    expect(t.urls()).toEqual([]);
  });

  test("announces more than 60 s from now (old or future) are rejected, 60 s is still accepted", () => {
    const now = 10_000_000;
    const t = table({ now: () => now });
    expect(t.handleAnnounce(announce("a", 1, now - 60_001), "10.0.0.1")).toBe(false);
    expect(t.handleAnnounce(announce("b", 1, now + 60_001), "10.0.0.2")).toBe(false);
    expect(t.handleAnnounce(announce("c", 1, now - 60_000), "10.0.0.3")).toBe(true);
    expect(t.entries().map((e) => e.id)).toEqual(["c"]);
  });

  test("own id is never registered", () => {
    const t = table({ now: () => 1_000_000, selfId: "204" });
    expect(t.handleAnnounce(announce("204", 7901, 1_000_000), "192.168.1.204")).toBe(false);
    expect(t.urls()).toEqual([]);
  });

  test("garbage and non-mesh packets are ignored", () => {
    const t = table({ now: () => 1_000_000 });
    const good = announce("a", 1, 1_000_000);
    expect(t.handleAnnounce({ ...good, mesh: undefined }, "10.0.0.1")).toBe(false);
    expect(t.handleAnnounce({ ...good, mac: 5 }, "10.0.0.1")).toBe(false);
    expect(t.handleAnnounce({ ...good, ts: "1000000" }, "10.0.0.1")).toBe(false);
    expect(t.handleAnnounce({ ...good, port: 0 }, "10.0.0.1")).toBe(false);
    expect(t.handleAnnounce({ "agent-messenger": "probe" }, "10.0.0.1")).toBe(false);
  });

  test("same id from a new URL: last one wins, old URL is dropped", () => {
    const dropped: string[] = [];
    const joined: string[] = [];
    const t = table({ now: () => 1_000_000, onDrop: (u) => dropped.push(u), onJoin: (id) => joined.push(id) });
    t.handleAnnounce(announce("204", 7901, 1_000_000), "192.168.1.204");
    t.handleAnnounce(announce("204", 7901, 1_000_000), "192.168.1.204");
    expect(joined).toEqual(["204"]);
    t.handleAnnounce(announce("204", 7901, 1_000_000), "100.64.0.3");
    expect(t.urls()).toEqual(["http://100.64.0.3:7901"]);
    expect(dropped).toEqual(["http://192.168.1.204:7901"]);
    expect(joined).toEqual(["204", "204"]);
  });
});

describe("MeshPeerTable: probe reply", () => {
  const reply = (id: string, port: number, nonce: string, token = TOKEN) => ({
    "agent-messenger": "broker",
    id,
    port,
    version: "0.11.0",
    mesh: true,
    mac: meshMac(token, nonce, id, port),
  });

  test("a reply bound to our nonce registers; another nonce or token does not", () => {
    const t = table({ now: () => 1 });
    expect(t.handleReply(reply("a", 7901, "n1"), "10.0.0.1", "n1")).toBe(true);
    expect(t.handleReply(reply("b", 7901, "n1"), "10.0.0.2", "n2")).toBe(false);
    expect(t.handleReply(reply("c", 7901, "n1", "x"), "10.0.0.3", "n1")).toBe(false);
    expect(t.entries().map((e) => e.id)).toEqual(["a"]);
  });

  test("a reply without mesh (0.10 broker or fallback) is ignored", () => {
    const t = table({ now: () => 1 });
    const { mesh: _m, mac: _c, ...old } = reply("a", 7901, "n1");
    expect(t.handleReply(old, "10.0.0.1", "n1")).toBe(false);
  });
});

describe("MeshPeerTable: expiry", () => {
  test("removed after expireMs only when the link is not up", () => {
    let now = 1_000_000;
    const dropped: string[] = [];
    const t = table({ now: () => now, onDrop: (u) => dropped.push(u) });
    t.handleAnnounce(announce("a", 7901, now), "10.0.0.1");
    now += 35_000;
    expect(t.sweep(() => false)).toEqual([]);
    now += 1;
    // still syncing: kept although UDP went silent
    expect(t.sweep(() => true)).toEqual([]);
    expect(t.urls()).toEqual(["http://10.0.0.1:7901"]);
    // sync failing too: removed
    const gone = t.sweep(() => false);
    expect(gone.map((e) => e.id)).toEqual(["a"]);
    expect(t.urls()).toEqual([]);
    expect(dropped).toEqual(["http://10.0.0.1:7901"]);
  });

  test("a fresh announce renews the entry", () => {
    let now = 1_000_000;
    const t = table({ now: () => now });
    t.handleAnnounce(announce("a", 7901, now), "10.0.0.1");
    now += 30_000;
    t.handleAnnounce(announce("a", 7901, now), "10.0.0.1");
    now += 30_000;
    expect(t.sweep(() => false)).toEqual([]);
    expect(t.urls()).toHaveLength(1);
  });
});

describe("discovery targets", () => {
  test("host:port list parses; invalid entries are dropped", () => {
    expect(parseDiscoveryTargets(["127.0.0.1:17922", "127.0.0.1:17932", "nope", "h:0", ":5"])).toEqual([
      { host: "127.0.0.1", port: 17922 },
      { host: "127.0.0.1", port: 17932 },
    ]);
  });

  test("explicit targets replace broadcast and the discovery port", () => {
    expect(sendTargets({ port: 7902, addr: "", targets: ["127.0.0.1:17922"] })).toEqual([{ host: "127.0.0.1", port: 17922 }]);
  });

  test("a pinned address is the only target on the discovery port", () => {
    expect(sendTargets({ port: 7902, addr: "127.0.0.1" })).toEqual([{ host: "127.0.0.1", port: 7902 }]);
  });

  test("without anything it includes the limited broadcast address", () => {
    expect(sendTargets({ port: 7902, addr: "" })).toContainEqual({ host: "255.255.255.255", port: 7902 });
  });
});
