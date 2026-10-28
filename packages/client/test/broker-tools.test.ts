/** get_broker / set_broker through the tool registry with a fake connection (no socket). */
import { describe, expect, it } from "vitest";
import type { BrokerConnection, BrokerInfo } from "../src/broker-info.js";
import { formatBrokerInfo } from "../src/broker-info.js";
import { createInbox } from "../src/inbox.js";
import { createPeerState } from "../src/peer.js";
import { createToolRegistry, toolDescriptors } from "../src/tools/registry.js";
import { protocolErrorCode } from "../src/protocol-error.js";

const INFO: BrokerInfo = {
  url: "http://192.168.1.204:7901",
  id: "204",
  version: "0.11.0",
  mesh: true,
  source: "discovery",
  pinned: false,
  saved: "http://100.64.0.3:7901",
  discovered: [
    { id: "204", url: "http://192.168.1.204:7901", version: "0.11.0", mesh: true, fallback: false },
    { id: "mac", url: "http://192.168.1.10:7901", version: "0.10.0", mesh: false, fallback: true },
  ],
};

function setup(connection?: BrokerConnection, registered = true) {
  const broker = { post: async () => ({}) } as never;
  const peer = createPeerState({ name: "me", hostname: "h", cwd: "/w" });
  if (registered) peer.id = "me-id";
  const inbox = createInbox({ broker, peer, log: () => {} });
  return createToolRegistry({ broker, peer, inbox, ...(connection ? { connection } : {}) });
}

describe("formatBrokerInfo", () => {
  it("prints the design 5.4 layout", () => {
    expect(formatBrokerInfo(INFO)).toBe(
      [
        "broker: http://192.168.1.204:7901 (id 204, v0.11.0, mesh)",
        "source: discovery",
        "pinned: no   saved: http://100.64.0.3:7901",
        "discovered:",
        "  - 204  http://192.168.1.204:7901  v0.11.0  mesh",
        "  - mac  http://192.168.1.10:7901   v0.10.0  fallback",
      ].join("\n")
    );
  });

  it("handles no saved broker, nothing discovered, a silent broker and a plain one", () => {
    expect(formatBrokerInfo({ ...INFO, saved: null, discovered: [], pinned: true, source: "set_broker", mesh: false })).toBe(
      ["broker: http://192.168.1.204:7901 (id 204, v0.11.0)", "source: set_broker", "pinned: yes   saved: -", "discovered: (none)"].join("\n")
    );
    expect(formatBrokerInfo({ ...INFO, id: "", version: "", mesh: false, discovered: [] })).toContain("broker: http://192.168.1.204:7901 (not answering)");
  });
});

describe("get_broker / set_broker tools", () => {
  it("are listed, need no registration, and set_broker takes url (string) and persist (boolean)", () => {
    const d = toolDescriptors();
    const names = d.map((t) => t.name);
    expect(names.slice(-2)).toEqual(["get_broker", "set_broker"]);
    const set = d.find((t) => t.name === "set_broker")!;
    expect(set.inputSchema.properties.url!.type).toBe("string");
    expect(set.inputSchema.properties.persist!.type).toBe("boolean");
    expect(set.inputSchema.required).toBeUndefined();
  });

  it("get_broker returns the formatted info, also before registration", async () => {
    const reg = setup({ get: async () => INFO, set: async () => INFO }, false);
    const r = await reg.call("get_broker", {});
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toBe(formatBrokerInfo(INFO));
  });

  it("set_broker passes url and persist through; empty url / absent persist mean undefined / false", async () => {
    const calls: [string | undefined, boolean | undefined][] = [];
    const reg = setup({ get: async () => INFO, set: async (u, p) => (calls.push([u, p]), { ...INFO, source: "set_broker", pinned: true }) });
    const r = await reg.call("set_broker", { url: "10.0.0.2", persist: true });
    expect(r.content[0]!.text).toContain("source: set_broker");
    await reg.call("set_broker", {});
    await reg.call("set_broker", { url: "", persist: "true" });
    expect(calls).toEqual([
      ["10.0.0.2", true],
      [undefined, false],
      [undefined, true],
    ]);
  });

  it("a coded failure is the tool's error text, not a crash", async () => {
    const reg = setup({
      get: async () => INFO,
      set: async () => {
        throw Object.assign(new Error("BROKER_UNREACHABLE: Broker http://x:7901 is not reachable; still connected to http://y:7901"), { code: "BROKER_UNREACHABLE" });
      },
    });
    const r = await reg.call("set_broker", { url: "x" });
    expect(r).toEqual({ content: [{ type: "text", text: "BROKER_UNREACHABLE: Broker http://x:7901 is not reachable; still connected to http://y:7901" }], isError: true });
    expect(protocolErrorCode(new Error("x"))).toBeNull();
  });

  it("without a connection the tools say so", async () => {
    const reg = setup();
    expect((await reg.call("get_broker", {})).isError).toBe(true);
    expect((await reg.call("set_broker", { url: "x" })).content[0]!.text).toMatch(/not available/);
  });
});
