/**
 * set_protocol / unset_protocol / get_protocol, list_peers filter, send_message meta, received-message marks
 * and the reply warning, through the tool registry with a fake broker (no process, no socket, no network).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createInbox } from "../src/inbox.js";
import type { InboundMessage, Notifier } from "../src/inbox.js";
import { createPeerState } from "../src/peer.js";
import { createProtocolState, planOutgoing, recordSeen } from "../src/protocols.js";
import { protocolHash } from "../src/hash.js";
import { createToolRegistry } from "../src/tools/registry.js";

const dir = mkdtempSync(join(tmpdir(), "am-ptools-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Handler = (body: Record<string, any>) => unknown;

function repo(name: string, manifest: Record<string, unknown>, doc?: string): string {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "protocol.json"), JSON.stringify(manifest));
  if (doc !== undefined) writeFileSync(join(d, "PROTOCOL.md"), doc);
  return d;
}

const M = (version: string, name = "demo-proto") => ({ name, version, description: "demo protocol", messages: { ping: { type: "object" } } });

function setup(routes: Record<string, Handler>, opts: { registered?: boolean; health?: () => Promise<{ version: string } | null> } = {}) {
  const calls: { path: string; body: Record<string, any> }[] = [];
  const broker: any = {
    async post(path: string, body: Record<string, any>) {
      calls.push({ path, body });
      const h = routes[path];
      if (!h) throw new Error(`no route ${path}`);
      return h(body);
    },
  };
  if (opts.health) broker.health = opts.health;
  const peer = createPeerState({ name: "me", hostname: "h", cwd: dir });
  if (opts.registered !== false) peer.id = "me-id";
  const protocols = createProtocolState(async () => {
    throw new Error("no network in this test");
  });
  const inbox = createInbox({ broker, peer, log: () => {}, protocols });
  const registry = createToolRegistry({ broker, peer, inbox, protocols });
  return { registry, peer, calls, protocols, inbox };
}

const text = (r: { content: { text: string }[] }) => r.content[0].text;
const ok = (t: string) => ({ content: [{ type: "text", text: t }] });
const err = (t: string) => ({ content: [{ type: "text", text: t }], isError: true });

describe("set_protocol", () => {
  it("fetches, posts the definition with its hash, remembers it, and reports hash prefix and source", async () => {
    const d = repo("p1", M("1.0.0"), "# usage");
    const { registry, calls, protocols } = setup({ "/set-protocol": () => ({ ok: true }) });
    const hash = protocolHash(M("1.0.0"), "# usage");
    expect(await registry.call("set_protocol", { repo: d })).toEqual(ok(`Protocol set: demo-proto@1.0.0 (sha256 ${hash.slice(0, 8)}…, from file:${d})`));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      path: "/set-protocol",
      body: {
        id: "me-id",
        name: "demo-proto",
        version: "1.0.0",
        hash,
        definition: { manifest: M("1.0.0"), doc: "# usage", source: `file:${d}`, ref: "local" },
      },
    });
    expect(protocols.declared.map((x) => x.decl)).toEqual([{ name: "demo-proto", version: "1.0.0", hash }]);
  });

  it("declaring a name again replaces the local declaration; another name adds one", async () => {
    const { registry, protocols } = setup({ "/set-protocol": () => ({ ok: true }) });
    await registry.call("set_protocol", { repo: repo("p1", M("1.0.0")) });
    await registry.call("set_protocol", { repo: repo("p2", M("2.0.0")) });
    await registry.call("set_protocol", { repo: repo("p3", M("1.0.0", "other")) });
    expect(protocols.declared.map((x) => `${x.decl.name}@${x.decl.version}`)).toEqual(["demo-proto@2.0.0", "other@1.0.0"]);
  });

  it("requires registration", async () => {
    const { registry, calls } = setup({}, { registered: false });
    expect(await registry.call("set_protocol", { repo: "x" })).toEqual(err("Not registered with broker yet"));
    expect(calls).toHaveLength(0);
  });

  it("client-side errors are the tool answer (code prefix), nothing is posted or remembered", async () => {
    const { registry, calls, protocols } = setup({});
    const r = await registry.call("set_protocol", { repo: "not a repo" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^UNSUPPORTED_REPO: /);
    const r2 = await registry.call("set_protocol", { repo: join(dir, "missing-dir") });
    expect(text(r2)).toMatch(/^REPO_UNREACHABLE: /);
    const r3 = await registry.call("set_protocol", { repo: repo("p4", M("1.0.0")), version: "2.0.0" });
    expect(text(r3)).toMatch(/^VERSION_MISMATCH: /);
    expect(calls).toHaveLength(0);
    expect(protocols.declared).toHaveLength(0);
  });

  it("broker errors with a code are shown as <CODE>: <message>", async () => {
    const { registry, protocols } = setup({
      "/set-protocol": () => ({ ok: false, error: "demo-proto@1.0.0 is already registered with a different definition", code: "PROTOCOL_CONFLICT", existing_hash: "ab", servers: ["a@h"] }),
    });
    expect(await registry.call("set_protocol", { repo: repo("p1", M("1.0.0")) })).toEqual(
      err("PROTOCOL_CONFLICT: demo-proto@1.0.0 is already registered with a different definition")
    );
    expect(protocols.declared).toHaveLength(0);
  });

  it("a 0.9 broker (404 on the route) is BROKER_UNSUPPORTED with its version", async () => {
    const { registry } = setup(
      {
        "/set-protocol": () => {
          throw new Error('Broker error (/set-protocol): 404 {"error":"not found"}');
        },
      },
      { health: async () => ({ version: "0.9.0" }) }
    );
    const r = await registry.call("set_protocol", { repo: repo("p1", M("1.0.0")) });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^BROKER_UNSUPPORTED: .*version 0\.9\.0/);
  });

  it("other broker failures stay generic tool errors", async () => {
    const { registry } = setup({
      "/set-protocol": () => {
        throw new Error("Broker error (/set-protocol): 500 boom");
      },
    });
    expect(await registry.call("set_protocol", { repo: repo("p1", M("1.0.0")) })).toEqual(err("Error (set_protocol): Broker error (/set-protocol): 500 boom"));
  });

  it("'unknown peer' re-registers once and retries with the new id", async () => {
    let n = 0;
    const { registry, peer, calls, protocols } = setup({
      "/set-protocol": (b) => {
        n++;
        return b.id === "me-id" ? { ok: false, error: "unknown peer" } : { ok: true };
      },
    });
    protocols.reregister = async () => {
      peer.id = "new-id";
    };
    const r = await registry.call("set_protocol", { repo: repo("p1", M("1.0.0")) });
    expect(text(r)).toMatch(/^Protocol set: demo-proto@1\.0\.0/);
    expect(n).toBe(2);
    expect(calls.map((c) => c.body.id)).toEqual(["me-id", "new-id"]);
  });

  it("'unknown peer' without a way to re-register is a plain failure", async () => {
    const { registry } = setup({ "/set-protocol": () => ({ ok: false, error: "unknown peer" }) });
    expect(await registry.call("set_protocol", { repo: repo("p1", M("1.0.0")) })).toEqual(err("Error (set_protocol): Failed: unknown peer"));
  });
});

describe("unset_protocol", () => {
  async function withTwo() {
    const s = setup({ "/set-protocol": () => ({ ok: true }), "/unset-protocol": () => ({ ok: true, removed: 1 }) });
    await s.registry.call("set_protocol", { repo: repo("p1", M("1.0.0")) });
    await s.registry.call("set_protocol", { repo: repo("p3", M("1.0.0", "other")) });
    return s;
  }

  it("by name", async () => {
    const s = await withTwo();
    expect(await s.registry.call("unset_protocol", { name: "other" })).toEqual(ok("Protocol unset: other"));
    expect(s.calls[s.calls.length - 1]).toEqual({ path: "/unset-protocol", body: { id: "me-id", name: "other" } });
    expect(s.protocols.declared.map((x) => x.decl.name)).toEqual(["demo-proto"]);
  });

  it("all (no name sent), with the count", async () => {
    const s = setup({ "/set-protocol": () => ({ ok: true }), "/unset-protocol": () => ({ ok: true, removed: 2 }) });
    await s.registry.call("set_protocol", { repo: repo("p1", M("1.0.0")) });
    await s.registry.call("set_protocol", { repo: repo("p3", M("1.0.0", "other")) });
    expect(await s.registry.call("unset_protocol", {})).toEqual(ok("Protocol unset: (all, 2)"));
    expect(s.calls[s.calls.length - 1].body).toEqual({ id: "me-id" });
    expect(s.protocols.declared).toEqual([]);
  });

  it("nothing declared is still a success", async () => {
    const { registry } = setup({ "/unset-protocol": () => ({ ok: true, removed: 0 }) });
    expect(await registry.call("unset_protocol", {})).toEqual(ok("No protocol set."));
    expect(await registry.call("unset_protocol", { name: "x" })).toEqual(ok("No protocol set."));
  });

  it("requires registration", async () => {
    const { registry } = setup({}, { registered: false });
    expect(await registry.call("unset_protocol", {})).toEqual(err("Not registered with broker yet"));
  });
});

describe("get_protocol", () => {
  const stored = {
    name: "demo-proto",
    version: "1.2.0",
    hash: "1a2b3c4d" + "0".repeat(56),
    registered_at: "t",
    definition: { manifest: M("1.2.0"), doc: "# How to\nline2", source: "github:o/r", ref: "v1.2.0" },
  };

  it("shows heading, description, protocol.json and PROTOCOL.md; version is normalized; no registration needed", async () => {
    const { registry, calls } = setup({ "/get-protocol": () => ({ ok: true, protocol: stored, servers: 2 }) }, { registered: false });
    const r = await registry.call("get_protocol", { name: "demo-proto", version: "v1.2.0" });
    expect(calls[0]).toEqual({ path: "/get-protocol", body: { name: "demo-proto", version: "1.2.0" } });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toBe(
      [
        "demo-proto@1.2.0 (sha256 1a2b3c4d…, servers: 2)",
        "Description: demo protocol",
        "",
        "protocol.json:",
        JSON.stringify(M("1.2.0"), null, 2),
        "",
        "PROTOCOL.md:",
        "# How to\nline2",
      ].join("\n")
    );
  });

  it("no version: the field is not sent; empty PROTOCOL.md says (none)", async () => {
    const { registry, calls } = setup({
      "/get-protocol": () => ({ ok: true, protocol: { ...stored, definition: { ...stored.definition, doc: "" } }, servers: 1 }),
    });
    const r = await registry.call("get_protocol", { name: "demo-proto" });
    expect(calls[0].body).toEqual({ name: "demo-proto" });
    expect(text(r).endsWith("PROTOCOL.md:\n(none)")).toBe(true);
  });

  it("PROTOCOL_NOT_FOUND is shown with its message", async () => {
    const { registry } = setup({
      "/get-protocol": () => ({ ok: false, error: 'Protocol "x" not found (registered versions: none)', code: "PROTOCOL_NOT_FOUND", versions: [] }),
    });
    expect(await registry.call("get_protocol", { name: "x" })).toEqual(err('PROTOCOL_NOT_FOUND: Protocol "x" not found (registered versions: none)'));
  });

  it("404 from an old broker", async () => {
    const { registry } = setup({
      "/get-protocol": () => {
        throw new Error('Broker error (/get-protocol): 404 {"error":"not found"}');
      },
    });
    expect(text(await registry.call("get_protocol", { name: "x" }))).toMatch(/^BROKER_UNSUPPORTED: .*version unknown/);
  });
});

describe("list_peers with a protocol filter", () => {
  const peerA = { id: "a", name: "srv", hostname: "h1", pid: 1, cwd: "/a", git_root: null, tty: null, summary: "", registered_at: "t", last_seen: "t", protocols: [{ name: "demo-proto", version: "1.0.0", hash: "h" }, { name: "other", version: "2.0.0", hash: "h" }] };

  it("sends protocol and normalized version, formats Protocol lines, names the filter", async () => {
    const { registry, calls } = setup({ "/list-peers": () => [peerA] });
    const r = await registry.call("list_peers", { protocol: "demo-proto", version: "v1.0.0", scope: "host" });
    expect(calls[0].body).toMatchObject({ scope: "host", protocol: "demo-proto", version: "1.0.0", exclude_id: "me-id" });
    expect(text(r)).toBe(
      "Found 1 peer(s) (scope: host, protocol: demo-proto, version: 1.0.0):\n\n" +
        "ID: a\n  Name: srv\n  Host: h1\n  PID: 1\n  CWD: /a\n  Protocol: demo-proto@1.0.0\n  Protocol: other@2.0.0\n  Last seen: t"
    );
  });

  it("zero hits: the fixed sentence, with the version or 'any'", async () => {
    const { registry } = setup({ "/list-peers": () => [] });
    expect(text(await registry.call("list_peers", { protocol: "demo-proto" }))).toBe('No server for protocol "demo-proto" (version: any).');
    expect(text(await registry.call("list_peers", { protocol: "demo-proto", version: "v2.0.0" }))).toBe('No server for protocol "demo-proto" (version: 2.0.0).');
  });

  it("version without protocol is ignored; no filter keeps the old wire form and wording", async () => {
    const { registry, calls } = setup({ "/list-peers": () => [{ ...peerA, protocols: undefined }] });
    const r = await registry.call("list_peers", { version: "1.0.0" });
    expect(calls[0].body.protocol).toBeUndefined();
    expect(calls[0].body.version).toBeUndefined();
    expect(text(r).startsWith("Found 1 peer(s) (scope: all):")).toBe(true);
    expect(text(r)).not.toContain("Protocol:");
  });

  it("a broker that ignores the filter (peers without a protocols field) is BROKER_UNSUPPORTED", async () => {
    const { registry } = setup({ "/list-peers": () => [{ ...peerA, protocols: undefined }] }, { health: async () => ({ version: "0.9.0" }) });
    const r = await registry.call("list_peers", { protocol: "demo-proto" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^BROKER_UNSUPPORTED: .*version 0\.9\.0/);
  });

  it("an empty answer is simply 'no server' (an old broker with no other peer says the same)", async () => {
    const { registry } = setup({ "/list-peers": () => [] }, { health: async () => ({ version: "0.9.0" }) });
    expect(text(await registry.call("list_peers", { protocol: "x" }))).toBe('No server for protocol "x" (version: any).');
  });
});

describe("send_message meta", () => {
  const sendOk = { "/send-message": () => ({ ok: true, to_id: "b-id", to_name: "b", message_id: 1 }) };

  it("INVALID_META: nothing is sent", async () => {
    const { registry, calls } = setup(sendOk);
    const bad: unknown[] = [
      { protocol: "p" },
      { version: "1" },
      { protocol: "", version: "1" },
      { protocol: "p", version: 1 },
      { protocol: 1, version: "1" },
      "p@1",
      null,
      [],
      { protocol: "p".repeat(129), version: "1" },
      { protocol: "p", version: "1".repeat(129) },
    ];
    for (const meta of bad) {
      const r = await registry.call("send_message", { to: "b", message: "m", meta });
      expect(r.isError, JSON.stringify(meta)).toBe(true);
      expect(text(r), JSON.stringify(meta)).toMatch(/^INVALID_META: /);
    }
    expect(calls).toHaveLength(0);
  });

  it("a valid meta is sent as {protocol, version} only; without meta the body has no meta key", async () => {
    const { registry, calls } = setup(sendOk);
    const r = await registry.call("send_message", { to: "b", message: "m", meta: { protocol: "p", version: "1.0.0", extra: 1 } });
    expect(r).toEqual(ok("Message sent to b (b-id) (delivery: pull)."));
    expect(calls[0].body.meta).toEqual({ protocol: "p", version: "1.0.0" });
    await registry.call("send_message", { to: "b", message: "m" });
    expect("meta" in calls[1].body).toBe(false);
  });

  it("an invalid delivery is still reported first", async () => {
    const { registry } = setup(sendOk);
    expect(await registry.call("send_message", { to: "b", message: "m", delivery: "x", meta: 5 })).toEqual(err('Invalid delivery: x (use "pull" or "push")'));
  });
});

describe("received messages: Protocol line and mismatch marks", () => {
  function inboxWith(messages: unknown[]) {
    const s = setup({
      "/poll-messages": () => ({ messages }),
      "/get-buffered-messages": () => ({ messages: [] }),
      "/acknowledge-messages": () => ({ ok: true }),
      "/list-peers": () => [],
    });
    return s;
  }
  const msg = (id: number, meta?: { protocol: string; version: string }, from = "peer-1") => ({
    id,
    from_id: from,
    from_name: "caller",
    to_id: "me-id",
    text: `t${id}`,
    sent_at: "T",
    mode: "pull",
    ...(meta ? { meta } : {}),
  });

  async function declare(s: ReturnType<typeof setup>, name: string, version: string) {
    s.protocols.declared.push({ decl: { name, version, hash: "h" }, definition: { manifest: M(version, name), doc: "", source: "s", ref: "r" } });
  }

  it("check_messages: matching version, mismatch, not served, and no meta", async () => {
    const s = inboxWith([
      msg(1, { protocol: "demo-proto", version: "1.2.0" }),
      msg(2, { protocol: "demo-proto", version: "1.1.0" }, "peer-2"),
      msg(3, { protocol: "elsewhere", version: "9.9.9" }, "peer-3"),
      msg(4, undefined, "peer-4"),
      msg(5, { protocol: "demo-proto", version: "v1.2.0" }, "peer-5"),
    ]);
    await declare(s, "demo-proto", "1.2.0");
    const out = text(await s.registry.call("check_messages", {}));
    expect(out).toBe(
      "5 message(s):\n\n" +
        [
          "From caller (peer-1) at T:\nProtocol: demo-proto@1.2.0\nt1",
          "From caller (peer-2) at T:\nProtocol: demo-proto@1.1.0 (this server: 1.2.0, mismatch)\nt2",
          "From caller (peer-3) at T:\nProtocol: elsewhere@9.9.9 (not served here)\nt3",
          "From caller (peer-4) at T:\nt4",
          "From caller (peer-5) at T:\nProtocol: demo-proto@v1.2.0\nt5",
        ].join("\n\n---\n\n")
    );
  });

  it("the notifier gets the mark on the entry (unread notice / push)", async () => {
    const seen: InboundMessage[] = [];
    const notifier: Notifier = {
      async unread(latest) {
        seen.push(latest);
        return true;
      },
      async ping() {},
      async push(entry) {
        seen.push(entry);
        return true;
      },
    };
    const calls: string[] = [];
    const broker: any = {
      async post(path: string) {
        calls.push(path);
        if (path === "/poll-messages") {
          return { messages: [{ ...msg(1, { protocol: "demo-proto", version: "1.0.0" }), mode: "push" }, msg(2, { protocol: "demo-proto", version: "1.0.0" }, "peer-2")] };
        }
        if (path === "/list-peers") return [];
        return { ok: true };
      },
    };
    const peer = createPeerState({ name: "me", hostname: "h", cwd: "/" });
    peer.id = "me-id";
    const protocols = createProtocolState();
    protocols.declared.push({ decl: { name: "demo-proto", version: "2.0.0", hash: "h" }, definition: { manifest: {}, doc: "", source: "s", ref: "r" } });
    const inbox = createInbox({ broker, peer, log: () => {}, notifier, protocols });
    await inbox.poll(true);
    expect(seen.map((e) => e.protocol_line)).toEqual([
      "Protocol: demo-proto@1.0.0 (this server: 2.0.0, mismatch)",
      "Protocol: demo-proto@1.0.0 (this server: 2.0.0, mismatch)",
    ]);
  });
});

describe("reply warning", () => {
  const sendOk = { "/send-message": () => ({ ok: true, to_id: "peer-1", to_name: "caller", message_id: 1 }) };

  function served(version: string) {
    const s = setup(sendOk);
    s.protocols.declared.push({ decl: { name: "demo-proto", version, hash: "h" }, definition: { manifest: {}, doc: "", source: "s", ref: "r" } });
    return s;
  }

  it("mismatch: warning line first in the text, meta carries this server's version, the result repeats the line", async () => {
    const s = served("1.2.0");
    recordSeen(s.protocols, "peer-1", "caller", { protocol: "demo-proto", version: "1.1.0" });
    const warning = "[agent-messenger warning] protocol version mismatch: you sent demo-proto@1.1.0, this server serves demo-proto@1.2.0";
    for (const to of ["peer-1", "caller"]) {
      const r = await s.registry.call("send_message", { to, message: "answer" });
      expect(text(r)).toBe(`Message sent to caller (peer-1) (delivery: pull).\n${warning}`);
      const body = s.calls[s.calls.length - 1].body;
      expect(body.text).toBe(`${warning}\nanswer`);
      expect(body.meta).toEqual({ protocol: "demo-proto", version: "1.2.0" });
    }
  });

  it("no warning when the versions agree (v prefix ignored), the peer never spoke, or the protocol is not served", async () => {
    const s = served("1.2.0");
    recordSeen(s.protocols, "peer-1", "caller", { protocol: "demo-proto", version: "v1.2.0" });
    recordSeen(s.protocols, "peer-2", "other", { protocol: "not-mine", version: "0.1.0" });
    for (const to of ["peer-1", "peer-2", "stranger"]) {
      const r = await s.registry.call("send_message", { to, message: "answer" });
      expect(text(r)).toBe("Message sent to caller (peer-1) (delivery: pull).");
      const body = s.calls[s.calls.length - 1].body;
      expect(body.text).toBe("answer");
      expect("meta" in body).toBe(false);
    }
  });

  it("a meta the caller gave for another protocol is kept untouched; for the same protocol it is corrected", async () => {
    const s = served("1.2.0");
    recordSeen(s.protocols, "peer-1", "caller", { protocol: "demo-proto", version: "1.1.0" });
    await s.registry.call("send_message", { to: "peer-1", message: "m", meta: { protocol: "side-proto", version: "3.0.0" } });
    expect(s.calls[0].body).toMatchObject({ text: "m", meta: { protocol: "side-proto", version: "3.0.0" } });
    await s.registry.call("send_message", { to: "peer-1", message: "m", meta: { protocol: "demo-proto", version: "1.1.0" } });
    expect(s.calls[1].body.meta).toEqual({ protocol: "demo-proto", version: "1.2.0" });
  });

  it("the newest message of a peer wins; pings are never changed", async () => {
    const s = served("1.2.0");
    recordSeen(s.protocols, "peer-1", "caller", { protocol: "demo-proto", version: "1.1.0" });
    recordSeen(s.protocols, "peer-1", "caller", { protocol: "demo-proto", version: "1.2.0" });
    await s.registry.call("send_message", { to: "peer-1", message: "m" });
    expect(s.calls[0].body.text).toBe("m");
    recordSeen(s.protocols, "peer-1", "caller", { protocol: "demo-proto", version: "1.0.0" });
    await s.registry.call("send_ping", { to: "peer-1", subject: "task" });
    expect(s.calls[1].body).toMatchObject({ text: "task", mode: "ping" });
    expect("meta" in s.calls[1].body).toBe(false);
  });

  it("the memory holds 100 peers (LRU): the oldest is forgotten, a re-heard peer is refreshed", () => {
    const st = createProtocolState();
    st.declared.push({ decl: { name: "p", version: "2.0.0", hash: "h" }, definition: { manifest: {}, doc: "", source: "s", ref: "r" } });
    for (let i = 0; i < 100; i++) recordSeen(st, `id${i}`, `n${i}`, { protocol: "p", version: "1.0.0" });
    expect(st.seen).toHaveLength(100);
    recordSeen(st, "id0", "n0", { protocol: "p", version: "1.0.0" }); // refresh id0, now the newest
    recordSeen(st, "id100", "n100", { protocol: "p", version: "1.0.0" }); // evicts the oldest, which is id1
    expect(st.seen).toHaveLength(100);
    expect(planOutgoing(st, "id1", "x").warning).toBeUndefined();
    expect(planOutgoing(st, "id0", "x").warning).toBeDefined();
    expect(planOutgoing(st, "n100", "x").warning).toBeDefined();
  });
});
