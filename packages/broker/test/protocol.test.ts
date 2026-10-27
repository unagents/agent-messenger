import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_DOC_MAX_BYTES,
  PROTOCOL_MANIFEST_MAX_BYTES,
  PROTOCOL_MAX_STORED,
  canonicalJSON,
  type Message,
  type Peer,
  type ProtocolDecl,
  type StoredProtocol,
} from "@unagents/messenger-protocol";
import { startBroker, type BrokerHandle, type BrokerStateFile } from "../src/index.js";
import { BrokerHandlers } from "../src/handlers.js";
import { BrokerState } from "../src/state.js";
import { relayUndelivered } from "../src/relay.js";
import { compareVersions } from "../src/protocol.js";

const TOKEN = "proto-token";

const dirs: string[] = [];
const brokers: BrokerHandle[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "messenger-protocol-"));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  while (brokers.length) await brokers.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** The hash form of design 5.4, computed here without the broker's helper. */
function hashOf(manifest: object, doc: string): string {
  return createHash("sha256").update(canonicalJSON({ manifest, doc })).digest("hex");
}

/** A `/set-protocol` body for `name@version` (body text varies with `doc`). */
function setBody(id: string, name: string, version: string, doc = "# usage\n") {
  const manifest = { name, version, description: "test protocol", messages: { request: { type: "object" } } };
  const hash = hashOf(manifest, doc);
  return { id, name, version, hash, definition: { manifest, doc, source: "file:/protocols/" + name, ref: "local" } };
}

function decl(name: string, version: string, doc = "# usage\n"): ProtocolDecl {
  const b = setBody("x", name, version, doc);
  return { name, version, hash: b.hash };
}

async function boot(opts: Parameters<typeof startBroker>[0] = {}) {
  const b = await startBroker({
    port: 0,
    bind: "127.0.0.1",
    token: TOKEN,
    id: "test-broker",
    stateFile: join(tmp(), "broker.json"),
    discovery: false,
    ...opts,
  });
  brokers.push(b);
  const url = `http://127.0.0.1:${b.port}`;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    return res.json() as Promise<any>;
  };
  const join_ = async (name: string, pid: number, extra: object = {}) =>
    (await post("/register", { pid, hostname: "host-" + name, cwd: "/work/" + name, name, ...extra })).id as string;
  return { b, url, post, join: join_ };
}

/**
 * A state that never writes. The debounced save would fire after the temp dir was removed and recreate it,
 * so tests that only look at memory must not schedule one.
 */
function memoryState(file = join(tmp(), "broker.json")): BrokerState {
  const state = new BrokerState(file);
  state.scheduleSave = () => {};
  return state;
}

/** Handlers over a memory-only state, for tests that need to reach into the state. */
function bare(id = "broker-x") {
  const state = memoryState();
  const handlers = new BrokerHandlers(state, { id });
  const join_ = (name: string, pid: number, extra: object = {}) =>
    handlers.register({ pid, hostname: "host-" + name, cwd: "/work/" + name, name, ...extra }).id;
  const stale = (peerId: string) => {
    state.peers.get(peerId)!.last_seen = new Date(Date.now() - 120_000).toISOString();
  };
  return { state, handlers, join: join_, stale };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function until<T>(fn: () => Promise<T | false | undefined> | T | false | undefined, what: string, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("set / get / unset / list", () => {
  test("a declared protocol is stored, served and listed; unset removes it", async () => {
    const { post, join: join_ } = await boot();
    const a = await join_("alpha", 1);
    const b = await join_("beta", 2);

    const set = setBody(a, "review-request", "1.2.0", "# review\n");
    expect(await post("/set-protocol", set)).toEqual({ ok: true });

    const got = await post("/get-protocol", { name: "review-request" });
    expect(got.ok).toBe(true);
    expect(got.servers).toBe(1);
    expect(got.protocol).toMatchObject({
      name: "review-request",
      version: "1.2.0",
      hash: set.hash,
      definition: { doc: "# review\n", source: "file:/protocols/review-request", ref: "local", manifest: set.definition.manifest },
    });
    expect(typeof got.protocol.registered_at).toBe("string");

    const listed: Peer[] = await post("/list-peers", { protocol: "review-request" });
    expect(listed.map((p) => p.name)).toEqual(["alpha"]);
    expect(listed[0]!.protocols).toEqual([{ name: "review-request", version: "1.2.0", hash: set.hash }]);
    // a peer without protocols has no `protocols` key at all
    const all: Peer[] = await post("/list-peers", {});
    expect(all.find((p) => p.name === "beta")).not.toHaveProperty("protocols");
    expect(all.find((p) => p.id === b)).toBeTruthy();

    expect(await post("/unset-protocol", { id: a })).toEqual({ ok: true, removed: 1 });
    expect(await post("/unset-protocol", { id: a })).toEqual({ ok: true, removed: 0 });
    const gone = await post("/get-protocol", { name: "review-request" });
    expect(gone).toMatchObject({ ok: false, code: "PROTOCOL_NOT_FOUND", versions: [] });
    expect(await post("/list-peers", { protocol: "review-request" })).toEqual([]);
  });

  test("protocol routes need the bearer token and a known peer", async () => {
    const { url, post } = await boot();
    for (const route of ["/set-protocol", "/unset-protocol", "/get-protocol"]) {
      const res = await fetch(`${url}${route}`, { method: "POST", body: "{}" });
      expect(res.status).toBe(401);
    }
    const r = await post("/set-protocol", setBody("nobody", "p", "1.0.0"));
    expect(r).toEqual({ ok: false, error: "unknown peer" });
    expect(await post("/unset-protocol", { id: "nobody" })).toEqual({ ok: false, error: "unknown peer" });
  });

  test("list-peers: protocol, version and scope are ANDed; version alone is ignored", async () => {
    const { post, join: join_ } = await boot();
    const a = await join_("alpha", 1);
    const b = await join_("beta", 2);
    const c = await join_("gamma", 3);
    await post("/set-protocol", setBody(a, "proto", "1.0.0"));
    await post("/set-protocol", setBody(b, "proto", "1.1.0"));
    await post("/set-protocol", setBody(c, "other", "1.0.0"));
    const names = async (body: object) => ((await post("/list-peers", body)) as Peer[]).map((p) => p.name).sort();

    expect(await names({ protocol: "proto" })).toEqual(["alpha", "beta"]);
    expect(await names({ protocol: "proto", version: "1.0.0" })).toEqual(["alpha"]);
    expect(await names({ protocol: "proto", version: "9.9.9" })).toEqual([]);
    expect(await names({ protocol: "nope" })).toEqual([]);
    expect(await names({ version: "1.0.0" })).toEqual(["alpha", "beta", "gamma"]); // no protocol: version is ignored
    // scope AND: beta lives in /work/beta
    expect(await names({ protocol: "proto", scope: "directory", cwd: "/work/beta" })).toEqual(["beta"]);
    expect(await names({ protocol: "proto", scope: "directory", cwd: "/work/gamma" })).toEqual([]);
    expect(await names({ protocol: "proto", scope: "host", hostname: "host-alpha" })).toEqual(["alpha"]);
    // exclude_id still applies
    expect(await names({ protocol: "proto", exclude_id: a })).toEqual(["beta"]);
  });

  test("one version per name per peer: a new version replaces the old; several names coexist", async () => {
    const { post, join: join_ } = await boot();
    const a = await join_("alpha", 1);
    await post("/set-protocol", setBody(a, "one", "1.0.0"));
    await post("/set-protocol", setBody(a, "two", "3.0.0"));
    await post("/set-protocol", setBody(a, "one", "1.1.0"));

    const [peer]: Peer[] = await post("/list-peers", {});
    expect(peer!.protocols!.map((d) => `${d.name}@${d.version}`).sort()).toEqual(["one@1.1.0", "two@3.0.0"]);
    // the replaced version had no other server: its body is gone
    expect(await post("/get-protocol", { name: "one", version: "1.0.0" })).toMatchObject({ ok: false, code: "PROTOCOL_NOT_FOUND", versions: ["1.1.0"] });
    expect((await post("/get-protocol", { name: "one", version: "1.1.0" })).ok).toBe(true);

    // unset by name only drops that name
    expect(await post("/unset-protocol", { id: a, name: "one" })).toEqual({ ok: true, removed: 1 });
    const [after]: Peer[] = await post("/list-peers", {});
    expect(after!.protocols!.map((d) => d.name)).toEqual(["two"]);
    expect(await post("/unset-protocol", { id: a })).toEqual({ ok: true, removed: 1 });
    const [bare_]: Peer[] = await post("/list-peers", {});
    expect(bare_).not.toHaveProperty("protocols");
  });

  test("setting the same definition again is a no-op success", async () => {
    const { post, join: join_ } = await boot();
    const a = await join_("alpha", 1);
    const b = await join_("beta", 2);
    const body = setBody(a, "p", "1.0.0");
    expect(await post("/set-protocol", body)).toEqual({ ok: true });
    expect(await post("/set-protocol", body)).toEqual({ ok: true });
    expect(await post("/set-protocol", { ...body, id: b })).toEqual({ ok: true });
    const got = await post("/get-protocol", { name: "p" });
    expect(got.servers).toBe(2);
    const [pa]: Peer[] = await post("/list-peers", { exclude_id: b });
    expect(pa!.protocols).toHaveLength(1);
  });
});

describe("get-protocol: version choice", () => {
  test("no version = highest semver; 0.0.0+sha counts as lowest; prerelease sorts below its release", async () => {
    const { handlers, join: join_ } = bare();
    const ids = ["1.2.0", "1.10.0", "0.0.0+abc1234", "2.0.0-rc.1", "1.10.0-beta.2"].map((v, i) => ({ v, id: join_("p" + i, i + 1) }));
    for (const { v, id } of ids) expect(handlers.setProtocol(setBody(id, "proto", v))).toEqual({ ok: true });

    const latest = handlers.getProtocol({ name: "proto" });
    expect(latest).toMatchObject({ ok: true, protocol: { version: "2.0.0-rc.1" } });
    const miss = handlers.getProtocol({ name: "proto", version: "7.0.0" });
    // versions are listed highest first
    expect(miss).toMatchObject({ ok: false, code: "PROTOCOL_NOT_FOUND", versions: ["2.0.0-rc.1", "1.10.0", "1.10.0-beta.2", "1.2.0", "0.0.0+abc1234"] });
    expect((miss as { error: string }).error).toContain("7.0.0");
    expect(handlers.getProtocol({ name: "proto", version: "1.2.0" })).toMatchObject({ ok: true, protocol: { version: "1.2.0" }, servers: 1 });
  });

  test("a tag-less version is served when it is all there is", () => {
    const { handlers, join: join_ } = bare();
    expect(handlers.setProtocol(setBody(join_("a", 1), "solo", "0.0.0+abc1234"))).toEqual({ ok: true });
    expect(handlers.getProtocol({ name: "solo" })).toMatchObject({ ok: true, protocol: { version: "0.0.0+abc1234" } });
  });

  test("unknown name lists no versions; missing name is not found too", () => {
    const { handlers } = bare();
    expect(handlers.getProtocol({ name: "ghost" })).toMatchObject({ ok: false, code: "PROTOCOL_NOT_FOUND", versions: [] });
    expect(handlers.getProtocol({} as never)).toMatchObject({ ok: false, code: "PROTOCOL_NOT_FOUND" });
  });

  test("compareVersions", () => {
    const sorted = ["0.0.0+z", "0.0.1", "0.1.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.0+build", "1.0.1", "1.10.0", "2.0.0"];
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i]!;
      const b = sorted[i + 1]!;
      expect(compareVersions(a, b), `${a} < ${b}`).toBeLessThanOrEqual(0);
      expect(compareVersions(b, a), `${b} > ${a}`).toBeGreaterThanOrEqual(0);
    }
    expect(compareVersions("1.0.0+a", "1.0.0+b")).toBe(0);
    expect(compareVersions("0.0.0+a", "0.0.0+b")).toBe(0);
    expect(compareVersions("0.0.0+a", "0.0.0-rc.1")).toBeLessThan(0);
  });
});

describe("set-protocol: rejections", () => {
  test("HASH_MISMATCH: the broker recomputes the hash and stores nothing", async () => {
    const { post, join: join_ } = await boot();
    const a = await join_("alpha", 1);
    const body = setBody(a, "p", "1.0.0");
    const res = await post("/set-protocol", { ...body, hash: "0".repeat(64) });
    expect(res).toMatchObject({ ok: false, code: "HASH_MISMATCH" });
    expect(res.error).toContain(body.hash);
    // doc changed after hashing
    const res2 = await post("/set-protocol", { ...body, definition: { ...body.definition, doc: "tampered" } });
    expect(res2).toMatchObject({ ok: false, code: "HASH_MISMATCH" });
    // source / ref are not part of the hash
    expect(await post("/set-protocol", { ...body, definition: { ...body.definition, source: "github:o/r", ref: "v1.0.0" } })).toEqual({ ok: true });
    expect((await post("/get-protocol", { name: "p" })).protocol.definition).toMatchObject({ source: "github:o/r", ref: "v1.0.0" });
  });

  test("PROTOCOL_CONFLICT: same name@version, other hash. Reports the held hash and the servers", async () => {
    const { post, join: join_ } = await boot();
    const a = await join_("alpha", 1);
    const b = await join_("beta", 2);
    const first = setBody(a, "p", "1.0.0", "original");
    expect(await post("/set-protocol", first)).toEqual({ ok: true });
    const res = await post("/set-protocol", setBody(b, "p", "1.0.0", "different text"));
    expect(res).toMatchObject({ ok: false, code: "PROTOCOL_CONFLICT", existing_hash: first.hash, servers: ["alpha@host-alpha"] });
    expect(res.error).toContain("alpha@host-alpha");
    expect(res.error).toContain(first.hash);
    // beta declared nothing; alpha's definition is untouched
    const list: Peer[] = await post("/list-peers", { protocol: "p" });
    expect(list.map((p) => p.name)).toEqual(["alpha"]);
    expect((await post("/get-protocol", { name: "p" })).protocol.definition.doc).toBe("original");
    // another version of the same name is fine
    expect(await post("/set-protocol", setBody(b, "p", "1.1.0", "different text"))).toEqual({ ok: true });
  });

  test("a conflict clears once every server of the old definition has unset it", async () => {
    const { post, join: join_ } = await boot();
    const a = await join_("alpha", 1);
    const b = await join_("beta", 2);
    await post("/set-protocol", setBody(a, "p", "1.0.0", "original"));
    expect((await post("/set-protocol", setBody(b, "p", "1.0.0", "second"))).code).toBe("PROTOCOL_CONFLICT");
    await post("/unset-protocol", { id: a });
    expect(await post("/set-protocol", setBody(b, "p", "1.0.0", "second"))).toEqual({ ok: true });
    expect((await post("/get-protocol", { name: "p" })).protocol.definition.doc).toBe("second");
  });

  test("a stale holder does not block a new definition (GC before the conflict check)", () => {
    const { handlers, join: join_, stale } = bare();
    const a = join_("alpha", 1);
    const b = join_("beta", 2);
    handlers.setProtocol(setBody(a, "p", "1.0.0", "old"));
    stale(a); // not yet swept by cleanStalePeers
    expect(handlers.setProtocol(setBody(b, "p", "1.0.0", "new"))).toEqual({ ok: true });
    expect(handlers.getProtocol({ name: "p" })).toMatchObject({ ok: true, protocol: { definition: { doc: "new" } }, servers: 1 });
  });

  test("TOO_LARGE: protocol.json and PROTOCOL.md are capped at 64 KiB each", () => {
    const { handlers, join: join_ } = bare();
    const a = join_("alpha", 1);

    const bigDoc = setBody(a, "p", "1.0.0", "x".repeat(PROTOCOL_DOC_MAX_BYTES + 1));
    expect(handlers.setProtocol(bigDoc)).toMatchObject({ ok: false, code: "TOO_LARGE" });

    // multi-byte text counts in UTF-8 bytes: 21846 x 3 bytes = 65538
    const wide = setBody(a, "p", "1.0.0", "あ".repeat(21_846));
    expect(handlers.setProtocol(wide)).toMatchObject({ ok: false, code: "TOO_LARGE" });

    const manifest = { name: "p", version: "1.0.0", description: "y".repeat(PROTOCOL_MANIFEST_MAX_BYTES) };
    const bigManifest = { id: a, name: "p", version: "1.0.0", hash: hashOf(manifest, ""), definition: { manifest, doc: "", source: "file:/p", ref: "local" } };
    expect(handlers.setProtocol(bigManifest)).toMatchObject({ ok: false, code: "TOO_LARGE" });

    // exactly at the cap is fine
    expect(handlers.setProtocol(setBody(a, "p", "1.0.0", "x".repeat(PROTOCOL_DOC_MAX_BYTES)))).toEqual({ ok: true });
  });

  test("LIMIT: a broker holds at most 256 definitions; existing ones can still be joined", () => {
    const { handlers, join: join_ } = bare();
    const a = join_("alpha", 1);
    const b = join_("beta", 2);
    for (let i = 0; i < PROTOCOL_MAX_STORED; i++) expect(handlers.setProtocol(setBody(a, `proto-${i}`, "1.0.0"))).toEqual({ ok: true });
    expect(handlers.setProtocol(setBody(a, "one-too-many", "1.0.0"))).toMatchObject({ ok: false, code: "LIMIT" });
    // joining a held definition does not need a slot
    expect(handlers.setProtocol(setBody(b, "proto-7", "1.0.0"))).toEqual({ ok: true });
    // replacing a version frees the old slot (alpha had none to spare, so unset one first)
    handlers.unsetProtocol({ id: a, name: "proto-0" });
    expect(handlers.setProtocol(setBody(b, "one-too-many", "1.0.0"))).toEqual({ ok: true });
  });

  test("INVALID_DEFINITION: name, version, shape", () => {
    const { handlers, join: join_ } = bare();
    const a = join_("alpha", 1);
    const ok = setBody(a, "p", "1.0.0");
    const code = (b: unknown) => (handlers.setProtocol(b as never) as { code?: string }).code;

    expect(code({ ...ok, name: "Upper" })).toBe("INVALID_DEFINITION");
    expect(code({ ...ok, name: "a".repeat(65) })).toBe("INVALID_DEFINITION");
    expect(code({ ...ok, name: undefined })).toBe("INVALID_DEFINITION");
    expect(code({ ...ok, version: "v1.0.0" })).toBe("INVALID_DEFINITION");
    expect(code({ ...ok, version: "1.0" })).toBe("INVALID_DEFINITION");
    expect(code({ ...ok, version: 1 })).toBe("INVALID_DEFINITION");
    expect(code({ ...ok, definition: undefined })).toBe("INVALID_DEFINITION");
    expect(code({ ...ok, definition: { ...ok.definition, manifest: [] } })).toBe("INVALID_DEFINITION");
    expect(code({ ...ok, definition: { ...ok.definition, manifest: "{}" } })).toBe("INVALID_DEFINITION");
    expect(code({ ...ok, definition: { ...ok.definition, doc: null } })).toBe("INVALID_DEFINITION");
    expect(code({ ...ok, definition: { ...ok.definition, source: "" } })).toBe("INVALID_DEFINITION");
    expect(code({ ...ok, definition: { ...ok.definition, ref: undefined } })).toBe("INVALID_DEFINITION");

    // manifest.name must be the declared name; messages must be an object of objects
    const wrong = (m: object) => ({ ...ok, hash: hashOf(m, ok.definition.doc), definition: { ...ok.definition, manifest: m } });
    expect(code(wrong({ name: "other", version: "1.0.0" }))).toBe("INVALID_DEFINITION");
    expect(code(wrong({ version: "1.0.0" }))).toBe("INVALID_DEFINITION");
    expect(code(wrong({ name: "p", messages: [] }))).toBe("INVALID_DEFINITION");
    expect(code(wrong({ name: "p", messages: { request: "string" } }))).toBe("INVALID_DEFINITION");
    expect(code(wrong({ name: "p", description: 3 }))).toBe("INVALID_DEFINITION");
    // the manifest may carry anything else, and its own version is free (tag-less repos)
    expect(code(wrong({ name: "p", version: "whatever", extra: { a: [1, 2] } }))).toBeUndefined();
    expect(handlers.getProtocol({ name: "p" })).toMatchObject({ ok: true });
  });
});

describe("GC of stored definitions", () => {
  test("a stale peer takes its definition with it (cleanStalePeers)", () => {
    const { handlers, join: join_, stale } = bare();
    const a = join_("alpha", 1);
    handlers.setProtocol(setBody(a, "p", "1.0.0"));
    expect(handlers.getProtocol({ name: "p" }).ok).toBe(true);
    stale(a);
    handlers.cleanStalePeers();
    expect(handlers.getProtocol({ name: "p" })).toMatchObject({ ok: false, code: "PROTOCOL_NOT_FOUND" });
    expect(handlers.listPeers({ protocol: "p" })).toEqual([]);
  });

  test("with two servers the definition survives until the last one is gone", () => {
    const { handlers, join: join_, stale, state } = bare();
    const a = join_("alpha", 1);
    const b = join_("beta", 2);
    handlers.setProtocol(setBody(a, "p", "1.0.0"));
    handlers.setProtocol(setBody(b, "p", "1.0.0"));
    expect(handlers.getProtocol({ name: "p" })).toMatchObject({ ok: true, servers: 2 });

    handlers.unsetProtocol({ id: a });
    expect(handlers.getProtocol({ name: "p" })).toMatchObject({ ok: true, servers: 1 });
    stale(b);
    handlers.cleanStalePeers();
    expect(state.protocols.size).toBe(0);
  });

  test("unregister and a re-register of the same session collect orphans", () => {
    const { handlers, join: join_, state } = bare();
    const a = join_("alpha", 1);
    handlers.setProtocol(setBody(a, "p", "1.0.0"));
    handlers.unregister({ id: a });
    expect(state.protocols.size).toBe(0);

    // same pid + hostname registers again: the old record (and its declaration) is replaced
    const a2 = join_("alpha", 2);
    handlers.setProtocol(setBody(a2, "q", "1.0.0"));
    const a3 = join_("alpha", 2);
    expect(a3).not.toBe(a2);
    expect(state.protocols.size).toBe(0);
    // ...unless the new registration declares it again
    const a4 = join_("alpha", 2);
    handlers.setProtocol(setBody(a4, "q", "1.0.0"));
    handlers.register({ pid: 2, hostname: "host-alpha", name: "alpha", protocols: [decl("q", "1.0.0")] });
    expect(state.protocols.has("q@1.0.0")).toBe(true);
  });

  test("a definition without a declaring peer is not served even before the sweep runs", () => {
    const { handlers, join: join_, stale, state } = bare();
    const a = join_("alpha", 1);
    handlers.setProtocol(setBody(a, "p", "1.0.0"));
    stale(a);
    expect(handlers.getProtocol({ name: "p" })).toMatchObject({ ok: false, code: "PROTOCOL_NOT_FOUND" });
    expect(state.protocols.size).toBe(0);
  });
});

describe("register / heartbeat declarations and resend", () => {
  test("a declaration without a body gets a resend until /set-protocol delivers it", async () => {
    const { post, join: join_ } = await boot();
    const d = decl("p", "1.0.0");
    const a = await join_("alpha", 1, { protocols: [d] });

    // register recorded the declaration (hash only)
    const [peer]: Peer[] = await post("/list-peers", {});
    expect(peer!.protocols).toEqual([d]);
    expect(await post("/get-protocol", { name: "p" })).toMatchObject({ ok: false, code: "PROTOCOL_NOT_FOUND" });

    expect(await post("/heartbeat", { id: a, protocols: [d] })).toEqual({ ok: true, resend: ["p@1.0.0"] });
    expect(await post("/heartbeat", { id: a })).toEqual({ ok: true, resend: ["p@1.0.0"] }); // list not needed to be asked again

    expect(await post("/set-protocol", setBody(a, "p", "1.0.0"))).toEqual({ ok: true });
    expect(await post("/heartbeat", { id: a, protocols: [d] })).toEqual({ ok: true });
    expect((await post("/get-protocol", { name: "p" })).servers).toBe(1);
  });

  test("a heartbeat adds an unknown declaration but never changes an existing one", async () => {
    const { post, join: join_ } = await boot();
    const a = await join_("alpha", 1);
    expect(await post("/heartbeat", { id: a, protocols: [decl("p", "1.0.0")] })).toEqual({ ok: true, resend: ["p@1.0.0"] });
    await post("/set-protocol", setBody(a, "p", "1.1.0"));
    // a heartbeat built before the change arrives late: it must not roll the declaration back
    expect(await post("/heartbeat", { id: a, protocols: [decl("p", "1.0.0")] })).toEqual({ ok: true });
    const [peer]: Peer[] = await post("/list-peers", {});
    expect(peer!.protocols!.map((d) => d.version)).toEqual(["1.1.0"]);
    // a heartbeat without the list keeps everything
    expect(await post("/heartbeat", { id: a })).toEqual({ ok: true });
    expect(((await post("/list-peers", {})) as Peer[])[0]!.protocols).toHaveLength(1);
  });

  test("a declaration whose hash differs from the held definition is ignored (no resend)", async () => {
    const { post, join: join_ } = await boot();
    const a = await join_("alpha", 1);
    const b = await join_("beta", 2);
    await post("/set-protocol", setBody(a, "p", "1.0.0", "original"));
    expect(await post("/heartbeat", { id: b, protocols: [decl("p", "1.0.0", "other")] })).toEqual({ ok: true });
    expect(((await post("/list-peers", { protocol: "p" })) as Peer[]).map((p) => p.name)).toEqual(["alpha"]);
  });

  test("malformed declarations are dropped", async () => {
    const { post, join: join_ } = await boot();
    const good = decl("p", "1.0.0");
    const a = await join_("alpha", 1, {
      protocols: [good, { name: "BAD", version: "1.0.0", hash: good.hash }, { name: "q", version: "x", hash: good.hash }, { name: "r", version: "1.0.0", hash: "nothex" }, "str", null],
    });
    expect(((await post("/list-peers", {})) as Peer[])[0]!.protocols).toEqual([good]);
    expect(await post("/heartbeat", { id: a, protocols: "not a list" })).toEqual({ ok: true, resend: ["p@1.0.0"] });
  });

  test("a restarted broker asks for what it lost; a persisted body needs no resend", async () => {
    const stateFile = join(tmp(), "broker.json");
    const first = await boot({ stateFile });
    const a = await first.join("alpha", 1);
    await first.post("/set-protocol", setBody(a, "kept", "1.0.0"));
    await first.post("/heartbeat", { id: a, protocols: [decl("kept", "1.0.0"), decl("lost", "2.0.0")] });
    await first.b.close();
    brokers.splice(brokers.indexOf(first.b), 1);

    // "lost" was only ever declared by heartbeat, so the file holds no body for it
    const file = JSON.parse(readFileSync(stateFile, "utf8")) as BrokerStateFile;
    expect(file.protocols!.map((p) => p.name)).toEqual(["kept"]);
    const second = await boot({ stateFile });
    expect(await second.post("/heartbeat", { id: a, protocols: [decl("kept", "1.0.0"), decl("lost", "2.0.0")] })).toEqual({ ok: true, resend: ["lost@2.0.0"] });
  });
});

describe("persistence", () => {
  test("save then load brings the definitions back", async () => {
    const stateFile = join(tmp(), "broker.json");
    const first = await boot({ stateFile });
    const a = await first.join("alpha", 1);
    const set = setBody(a, "p", "1.0.0", "persist me");
    await first.post("/set-protocol", set);
    await first.b.close(); // flushes the pending snapshot
    brokers.splice(brokers.indexOf(first.b), 1);

    const onDisk = JSON.parse(readFileSync(stateFile, "utf8")) as BrokerStateFile;
    expect(onDisk.protocols).toHaveLength(1);
    expect(onDisk.protocols![0]).toMatchObject({ name: "p", version: "1.0.0", hash: set.hash, definition: { doc: "persist me" } });
    expect(onDisk.peers[0]!.protocols).toEqual([{ name: "p", version: "1.0.0", hash: set.hash }]);

    const second = await boot({ stateFile });
    const got = await second.post("/get-protocol", { name: "p" });
    expect(got).toMatchObject({ ok: true, servers: 1, protocol: { hash: set.hash, definition: { doc: "persist me" } } });
    expect(((await second.post("/list-peers", { protocol: "p" })) as Peer[]).map((p) => p.name)).toEqual(["alpha"]);
  });

  test("a file written without protocols (0.9.x) loads; nothing is invented; no protocols key is written back", async () => {
    const stateFile = join(tmp(), "broker.json");
    const old = {
      peers: [{ id: "oldpeer1", name: "old", pid: 9, hostname: "h", cwd: "/w", git_root: null, tty: null, summary: "", registered_at: new Date().toISOString(), last_seen: new Date().toISOString() }],
      messages: [],
      nextMsgId: 5,
    };
    writeFileSync(stateFile, JSON.stringify(old));
    const { b, post } = await boot({ stateFile });
    expect(((await post("/list-peers", {})) as Peer[]).map((p) => p.id)).toEqual(["oldpeer1"]);
    expect(await post("/get-protocol", { name: "p" })).toMatchObject({ ok: false, code: "PROTOCOL_NOT_FOUND" });
    await post("/set-name", { id: "oldpeer1", name: "renamed" }); // forces a save
    await b.close();
    brokers.splice(brokers.indexOf(b), 1);
    const back = JSON.parse(readFileSync(stateFile, "utf8")) as BrokerStateFile;
    expect(back).not.toHaveProperty("protocols");
    expect(back.nextMsgId).toBe(5);
  });

  test("definitions loaded from disk whose peers are gone are collected on the first sweep", async () => {
    const stateFile = join(tmp(), "broker.json");
    const set = setBody("x", "orphan", "1.0.0");
    const stored: StoredProtocol = { name: "orphan", version: "1.0.0", hash: set.hash, definition: set.definition, registered_at: new Date().toISOString() };
    writeFileSync(stateFile, JSON.stringify({ peers: [], messages: [], nextMsgId: 1, protocols: [stored] }));
    const { post } = await boot({ stateFile });
    expect(await post("/get-protocol", { name: "orphan" })).toMatchObject({ ok: false, code: "PROTOCOL_NOT_FOUND" });
  });
});

describe("send-message meta", () => {
  test("meta is stored, returned by poll and by the buffered list; a message without meta has no key", async () => {
    const { post, join: join_ } = await boot();
    const a = await join_("alpha", 1);
    const b = await join_("beta", 2);
    const meta = { protocol: "review-request", version: "1.2.0" };

    expect(await post("/send-message", { to: b, from_id: a, from_name: "alpha", text: "tagged", meta })).toMatchObject({ ok: true });
    expect(await post("/send-message", { to: b, from_id: a, from_name: "alpha", text: "plain" })).toMatchObject({ ok: true });
    const polled = (await post("/poll-messages", { id: b })).messages as Message[];
    expect(polled.map((m) => m.text)).toEqual(["tagged", "plain"]);
    expect(polled[0]!.meta).toEqual(meta);
    expect(polled[1]).not.toHaveProperty("meta");
    const buffered = (await post("/get-buffered-messages", { id: b })).messages as Message[];
    expect(buffered[0]!.meta).toEqual(meta);
  });

  test("only protocol and version are kept; the shape is checked, not the content", async () => {
    const { post, join: join_ } = await boot();
    const a = await join_("alpha", 1);
    const send = (meta: unknown) => post("/send-message", { to: a, text: "t", meta });

    expect(await send({ protocol: "x", version: "y", extra: 1 })).toMatchObject({ ok: true });
    expect(((await post("/poll-messages", { id: a })).messages as Message[])[0]!.meta).toEqual({ protocol: "x", version: "y" });
    // content is not validated: unknown protocol, odd version, even empty strings pass
    expect(await send({ protocol: "no-such-protocol", version: "not semver" })).toMatchObject({ ok: true });
    expect(await send({ protocol: "p".repeat(128), version: "v".repeat(128) })).toMatchObject({ ok: true });

    for (const bad of [{ protocol: "x" }, { version: "1" }, { protocol: 1, version: "1" }, { protocol: "x", version: null }, "str", 5, null, [], { protocol: "p".repeat(129), version: "1" }, { protocol: "x", version: "v".repeat(129) }]) {
      const r = await send(bad);
      expect(r, JSON.stringify(bad)).toMatchObject({ ok: false });
      expect(r.error).toContain("invalid meta");
    }
    // a rejected message is not queued
    expect(((await post("/poll-messages", { id: a })).messages as Message[]).map((m) => m.meta?.protocol)).toEqual(["no-such-protocol", "p".repeat(128)]);
  });

  test("relay keeps meta: /relay-messages, and relayUndelivered from a fallback broker", async () => {
    const { post, join: join_, url } = await boot();
    const b = await join_("beta", 2);
    const meta = { protocol: "p", version: "1.0.0" };
    const res = await post("/relay-messages", {
      messages: [
        { from_id: "x", from_name: "x", to_name: "beta", text: "with", sent_at: new Date().toISOString(), meta },
        { from_id: "x", from_name: "x", to_name: "beta", text: "broken meta", sent_at: new Date().toISOString(), meta: { protocol: 1 } },
        { from_id: "x", from_name: "x", to_name: "beta", text: "without", sent_at: new Date().toISOString() },
      ],
    });
    expect(res).toMatchObject({ ok: true, delivered: 3 });
    const polled = (await post("/poll-messages", { id: b })).messages as Message[];
    expect(polled.map((m) => [m.text, m.meta])).toEqual([["with", meta], ["broken meta", undefined], ["without", undefined]]);

    // the fallback side: a BrokerState holding an undelivered tagged message for a named peer
    const fb = memoryState(join(tmp(), "fallback.json"));
    fb.peers.set("fbpeer01", { id: "fbpeer01", name: "beta", pid: 2, hostname: "host-beta", cwd: "", git_root: null, tty: null, summary: "", registered_at: "", last_seen: "" });
    fb.messages.push({ id: 1, from_id: "s", from_name: "s", to_id: "fbpeer01", text: "relayed", mode: "pull", sent_at: new Date().toISOString(), delivered: 0, acknowledged: 0, meta });
    expect(await relayUndelivered(fb, url, TOKEN)).toEqual({ sent: 1, dropped: 0 });
    const relayed = (await post("/poll-messages", { id: b })).messages as Message[];
    expect(relayed.map((m) => [m.text, m.meta])).toEqual([["relayed", meta]]);
  });
});

describe("mesh", () => {
  /** Run one sync round `from` -> `to` and back, like Mesh.syncWith does (handlers only, no HTTP). */
  function roundTrip(from: ReturnType<typeof bare>, fromId: string, to: ReturnType<typeof bare>, toId: string): void {
    const res = to.handlers.meshSync({
      from: fromId,
      peers: from.handlers.meshLocalPeers(),
      messages: [],
      protocols: from.handlers.meshLocalProtocols(),
    });
    from.handlers.meshApplyPeers(toId, res.peers);
    from.handlers.meshApplyProtocols(toId, res.protocols ?? []);
  }

  test("a definition declared on one broker is served by the other; the replica lists with its protocols", () => {
    const a = bare("broker-a");
    const b = bare("broker-b");
    const pa = a.join("alpha", 1);
    const set = setBody(pa, "p", "1.0.0", "from a");
    expect(a.handlers.setProtocol(set)).toEqual({ ok: true });

    roundTrip(a, "broker-a", b, "broker-b");

    const got = b.handlers.getProtocol({ name: "p" });
    expect(got).toMatchObject({ ok: true, servers: 1, protocol: { hash: set.hash, definition: { doc: "from a", source: "file:/protocols/p" } } });
    const listed = b.handlers.listPeers({ protocol: "p" });
    expect(listed.map((p) => p.name)).toEqual(["alpha"]);
    expect(listed[0]!.protocols).toEqual([{ name: "p", version: "1.0.0", hash: set.hash }]);

    // b's own server of the same definition joins it
    const pb = b.join("beta", 2);
    expect(b.handlers.setProtocol(setBody(pb, "p", "1.0.0", "from a"))).toEqual({ ok: true });
    expect(b.handlers.getProtocol({ name: "p" })).toMatchObject({ ok: true, servers: 2 });
  });

  test("the sync sends direct peers' definitions only, never a replica's", () => {
    const a = bare("broker-a");
    const b = bare("broker-b");
    a.handlers.setProtocol(setBody(a.join("alpha", 1), "p", "1.0.0"));
    roundTrip(a, "broker-a", b, "broker-b");
    expect(b.handlers.meshLocalProtocols()).toEqual([]);
    expect(b.handlers.meshLocalPeers()).toEqual([]);
    const res = b.handlers.meshSync({ from: "broker-c", peers: [], messages: [] });
    expect(res).not.toHaveProperty("protocols");
  });

  test("another hash for a name@version this broker holds is dropped; ours stays", () => {
    const a = bare("broker-a");
    const b = bare("broker-b");
    const pa = a.join("alpha", 1);
    const pb = b.join("beta", 2);
    const mine = setBody(pb, "p", "1.0.0", "ours (b)");
    const theirs = setBody(pa, "p", "1.0.0", "theirs (a)");
    expect(b.handlers.setProtocol(mine)).toEqual({ ok: true });
    expect(a.handlers.setProtocol(theirs)).toEqual({ ok: true }); // raced: a never saw b's

    roundTrip(a, "broker-a", b, "broker-b");
    expect(b.handlers.getProtocol({ name: "p" })).toMatchObject({ ok: true, protocol: { hash: mine.hash, definition: { doc: "ours (b)" } } });
    roundTrip(a, "broker-a", b, "broker-b"); // a standing conflict stays quiet and stable
    expect(b.handlers.getProtocol({ name: "p" })).toMatchObject({ ok: true, protocol: { hash: mine.hash } });
    // and a took b's side of the exchange the same way: it keeps its own
    expect(a.handlers.getProtocol({ name: "p" })).toMatchObject({ ok: true, protocol: { hash: theirs.hash } });
  });

  test("received definitions are re-checked: hash, shape, orphans and the held limit", () => {
    const b = bare("broker-b");
    const good = setBody("x", "p", "1.0.0");
    const stored = (over: Partial<StoredProtocol> = {}): StoredProtocol => ({
      name: "p",
      version: "1.0.0",
      hash: good.hash,
      definition: good.definition,
      registered_at: new Date().toISOString(),
      ...over,
    });
    const peer = (protocols: ProtocolDecl[]): Peer => ({
      id: "replica1", name: "r", pid: 1, hostname: "h", cwd: "", git_root: null, tty: null, summary: "", registered_at: "", last_seen: "", protocols,
    });

    // a peer declares p@1.0.0 with the good hash; bodies that do not check out are refused
    b.handlers.meshApplyPeers("broker-a", [peer([{ name: "p", version: "1.0.0", hash: good.hash }])]);
    b.handlers.meshApplyProtocols("broker-a", [stored({ hash: "f".repeat(64) })]); // claims a hash its body does not have
    b.handlers.meshApplyProtocols("broker-a", [stored({ definition: { ...good.definition, doc: "swapped" } })]);
    b.handlers.meshApplyProtocols("broker-a", [stored({ name: "Bad Name" })]);
    expect(b.state.protocols.size).toBe(0);

    // a body nobody here declares would be collected at once: not stored
    const q = setBody("x", "q", "1.0.0");
    b.handlers.meshApplyProtocols("broker-a", [stored({ name: "q", hash: q.hash, definition: q.definition })]);
    expect(b.state.protocols.size).toBe(0);

    b.handlers.meshApplyProtocols("broker-a", [stored()]);
    expect([...b.state.protocols.keys()]).toEqual(["p@1.0.0"]);
  });

  test("when the origin stops listing the peer, the replica and its definition are gone", () => {
    const a = bare("broker-a");
    const b = bare("broker-b");
    const pa = a.join("alpha", 1);
    a.handlers.setProtocol(setBody(pa, "p", "1.0.0"));
    roundTrip(a, "broker-a", b, "broker-b");
    expect(b.handlers.getProtocol({ name: "p" }).ok).toBe(true);

    a.handlers.unsetProtocol({ id: pa });
    roundTrip(a, "broker-a", b, "broker-b");
    expect(b.handlers.getProtocol({ name: "p" })).toMatchObject({ ok: false, code: "PROTOCOL_NOT_FOUND" });
    expect(b.handlers.listPeers({ protocol: "p" })).toEqual([]);

    // and when the peer vanishes from the origin altogether
    a.handlers.setProtocol(setBody(pa, "p", "1.0.0"));
    roundTrip(a, "broker-a", b, "broker-b");
    expect(b.handlers.getProtocol({ name: "p" }).ok).toBe(true);
    a.handlers.unregister({ id: pa });
    roundTrip(a, "broker-a", b, "broker-b");
    expect(b.state.protocols.size).toBe(0);
  });

  test("two real brokers: set-protocol on one is readable on the other within a sync round", async () => {
    const portA = await freePort();
    const portB = await freePort();
    const start = async (port: number, id: string, other: number) => {
      const h = await startBroker({
        port,
        bind: "127.0.0.1",
        token: TOKEN,
        id,
        stateFile: join(tmp(), "broker.json"),
        discovery: false,
        mesh: true,
        meshIntervalMs: 80,
        meshBrokers: [`http://127.0.0.1:${other}`],
      });
      brokers.push(h);
      return async (path: string, body: unknown) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify(body),
        });
        return res.json() as Promise<any>;
      };
    };
    const postA = await start(portA, "mesh-a", portB);
    const postB = await start(portB, "mesh-b", portA);

    const alpha = (await postA("/register", { pid: 1, hostname: "ha", cwd: "/a", name: "alpha" })).id as string;
    const set = setBody(alpha, "mesh-proto", "1.0.0", "over the mesh");
    expect(await postA("/set-protocol", set)).toEqual({ ok: true });

    const got = await until(async () => {
      const r = await postB("/get-protocol", { name: "mesh-proto" });
      return r.ok ? r : false;
    }, "definition on broker b");
    expect(got).toMatchObject({ servers: 1, protocol: { hash: set.hash, definition: { doc: "over the mesh" } } });
    expect(((await postB("/list-peers", { protocol: "mesh-proto" })) as Peer[]).map((p) => p.name)).toEqual(["alpha"]);

    // unset on a: b loses it after the next round
    expect(await postA("/unset-protocol", { id: alpha })).toEqual({ ok: true, removed: 1 });
    await until(async () => (await postB("/get-protocol", { name: "mesh-proto" })).ok === false, "definition gone from broker b");
  });
});
