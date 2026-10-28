/**
 * Protocol repo resolution (design 6.1, 6.2) and definition checks (3, 5.4, 7.2) against a fake `fetch` and
 * local directories. Nothing here touches the network or a broker.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { protocolHash } from "../src/hash.js";
import { loadProtocol, parseRepoArg } from "../src/repo.js";
import type { Fetcher } from "../src/repo.js";

const dir = mkdtempSync(join(tmpdir(), "am-repo-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Reply = { status: number; body: unknown } | Error;

/** Routes by exact URL; an unknown URL is a failure of the test. */
function fakeFetch(routes: Record<string, Reply>) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (r === undefined) throw new Error(`unexpected URL ${url}`);
    if (r instanceof Error) throw r;
    return { status: r.status, text: typeof r.body === "string" ? r.body : JSON.stringify(r.body) };
  };
  return { fetcher, calls };
}

const manifest = (over: Record<string, unknown> = {}) => ({
  name: "review-request",
  version: "1.2.0",
  description: "code review",
  messages: { request: { type: "object" } },
  ...over,
});

const GH = "https://api.github.com/repos/o/r";
const RAW = "https://raw.githubusercontent.com/o/r";
const tagsUrl = (page = 1) => `${GH}/tags?per_page=100&page=${page}`;
const tag = (name: string) => ({ name });

async function fail(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { code?: string };
    return { code: err.code ?? "(none)", message: err.message };
  }
  throw new Error("expected a rejection");
}

describe("parseRepoArg", () => {
  const cwd = "/work/dir";

  it("GitHub forms", () => {
    for (const arg of ["https://github.com/o/r", "https://github.com/o/r/", "https://github.com/o/r.git", "https://www.github.com/o/r", "o/r", "github:o/r", " o/r "]) {
      expect(parseRepoArg(arg, cwd), arg).toEqual({ kind: "github", owner: "o", repo: "r", source: "github:o/r" });
    }
  });

  it("explicit Gitea prefix is taken as is (http allowed), with an optional path prefix", () => {
    expect(parseRepoArg("gitea:https://git.example.com/o/r", cwd)).toEqual({
      kind: "gitea",
      base: "https://git.example.com",
      owner: "o",
      repo: "r",
      source: "gitea:https://git.example.com/o/r",
      verified: true,
    });
    expect(parseRepoArg("gitea:http://10.0.0.5:3000/git/o/r.git", cwd)).toMatchObject({
      base: "http://10.0.0.5:3000/git",
      source: "gitea:http://10.0.0.5:3000/git/o/r",
      verified: true,
    });
  });

  it("any other https URL is an unverified Gitea candidate", () => {
    expect(parseRepoArg("https://git.example.com/o/r", cwd)).toMatchObject({ kind: "gitea", base: "https://git.example.com", verified: false });
  });

  it("local paths", () => {
    expect(parseRepoArg("/abs/p", cwd)).toEqual({ kind: "local", dir: "/abs/p", source: "file:/abs/p" });
    expect(parseRepoArg("/abs/./p/../q/", cwd)).toMatchObject({ dir: "/abs/q" });
    expect(parseRepoArg("./rel", cwd)).toMatchObject({ dir: "/work/dir/rel", source: "file:/work/dir/rel" });
    expect(parseRepoArg("../up/x", cwd)).toMatchObject({ dir: "/work/up/x" });
    expect(parseRepoArg("file:///abs/p%20q", cwd)).toMatchObject({ dir: "/abs/p q" });
  });

  it("UNSUPPORTED_REPO for everything else", () => {
    for (const bad of ["", "   ", "foo", "a/b/c", "http://git.example.com/o/r", "https://github.com/o", "https://github.com/o/r/tree/main", "file://host/x", "file://rel", "ftp://x/y/z", "github:o", "github:a/b/c", "gitea:ftp://x/o/r", "gitea:https://git.example.com/onlyone", "o/r r", "https://git.example.com/onlyone"]) {
      let err: Error & { code?: string } | null = null;
      try {
        parseRepoArg(bad, cwd);
      } catch (e) {
        err = e as Error & { code?: string };
      }
      expect(err?.code, `"${bad}"`).toBe("UNSUPPORTED_REPO");
      expect(err?.message).toContain("Accepted forms:");
    }
  });
});

describe("GitHub version resolution and fetch", () => {
  const pj = manifest();
  const baseRoutes = (): Record<string, Reply> => ({
    [tagsUrl()]: { status: 200, body: [tag("v1.0.0"), tag("v1.2.0"), tag("v1.3.0-rc.1"), tag("latest"), tag("v1.1.0")] },
    [`${RAW}/v1.2.0/protocol.json`]: { status: 200, body: pj },
    [`${RAW}/v1.2.0/PROTOCOL.md`]: { status: 200, body: "# how\n日本語\n" },
  });

  it("no version: the highest release tag (prerelease and non-semver tags skipped)", async () => {
    const { fetcher, calls } = fakeFetch(baseRoutes());
    const r = await loadProtocol("o/r", undefined, "/w", fetcher);
    expect(r.name).toBe("review-request");
    expect(r.version).toBe("1.2.0");
    expect(r.definition).toEqual({ manifest: pj, doc: "# how\n日本語\n", source: "github:o/r", ref: "v1.2.0" });
    expect(r.hash).toBe(protocolHash(pj, "# how\n日本語\n"));
    expect(calls).toEqual([tagsUrl(), `${RAW}/v1.2.0/protocol.json`, `${RAW}/v1.2.0/PROTOCOL.md`]);
  });

  it("given version: v-prefix is optional on both sides", async () => {
    for (const v of ["1.1.0", "v1.1.0", " v1.1.0 "]) {
      const routes = baseRoutes();
      routes[`${RAW}/v1.1.0/protocol.json`] = { status: 200, body: manifest({ version: "1.1.0" }) };
      routes[`${RAW}/v1.1.0/PROTOCOL.md`] = { status: 404, body: "not found" };
      const r = await loadProtocol("o/r", v, "/w", fakeFetch(routes).fetcher);
      expect([r.version, r.definition.ref, r.definition.doc], v).toEqual(["1.1.0", "v1.1.0", ""]);
    }
  });

  it("a prerelease tag can be requested by name", async () => {
    const routes = baseRoutes();
    routes[`${RAW}/v1.3.0-rc.1/protocol.json`] = { status: 200, body: manifest({ version: "1.3.0-rc.1" }) };
    routes[`${RAW}/v1.3.0-rc.1/PROTOCOL.md`] = { status: 404, body: "" };
    const r = await loadProtocol("o/r", "1.3.0-rc.1", "/w", fakeFetch(routes).fetcher);
    expect(r.version).toBe("1.3.0-rc.1");
  });

  it("VERSION_NOT_FOUND lists the top 5 candidates, newest first", async () => {
    const routes: Record<string, Reply> = {
      [tagsUrl()]: { status: 200, body: ["v1.0.0", "v1.1.0", "v1.2.0", "v2.0.0-beta.1", "v2.0.0", "v0.9.0", "junk"].map(tag) },
    };
    const e = await fail(loadProtocol("o/r", "9.9.9", "/w", fakeFetch(routes).fetcher));
    expect(e.code).toBe("VERSION_NOT_FOUND");
    expect(e.message).toContain("Candidates: v2.0.0, v2.0.0-beta.1, v1.2.0, v1.1.0, v1.0.0");
    expect(e.message).not.toContain("v0.9.0");
  });

  it("VERSION_NOT_FOUND without any semver tag says so", async () => {
    const routes: Record<string, Reply> = { [tagsUrl()]: { status: 200, body: [tag("nightly")] } };
    const e = await fail(loadProtocol("o/r", "1.0.0", "/w", fakeFetch(routes).fetcher));
    expect(e.code).toBe("VERSION_NOT_FOUND");
    expect(e.message).toContain("no semver tags");
  });

  it("tags are paged (100 per page) until a short page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => tag(`v0.0.${i}`));
    const routes: Record<string, Reply> = {
      [tagsUrl(1)]: { status: 200, body: page1 },
      [tagsUrl(2)]: { status: 200, body: [tag("v9.0.0")] },
      [`${RAW}/v9.0.0/protocol.json`]: { status: 200, body: manifest({ version: "9.0.0" }) },
      [`${RAW}/v9.0.0/PROTOCOL.md`]: { status: 404, body: "" },
    };
    const { fetcher, calls } = fakeFetch(routes);
    expect((await loadProtocol("o/r", undefined, "/w", fetcher)).version).toBe("9.0.0");
    expect(calls.filter((c) => c.includes("/tags"))).toEqual([tagsUrl(1), tagsUrl(2)]);
  });

  it("no tag at all: the default branch head sha becomes 0.0.0+<sha7>; protocol.json version is not checked", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const routes: Record<string, Reply> = {
      [tagsUrl()]: { status: 200, body: [] },
      [GH]: { status: 200, body: { default_branch: "main" } },
      [`${GH}/commits/main`]: { status: 200, body: { sha } },
      [`${RAW}/${sha}/protocol.json`]: { status: 200, body: manifest({ version: "not even semver" }) },
      [`${RAW}/${sha}/PROTOCOL.md`]: { status: 404, body: "" },
    };
    const r = await loadProtocol("o/r", undefined, "/w", fakeFetch(routes).fetcher);
    expect([r.version, r.definition.ref]).toEqual(["0.0.0+0123456", sha]);
  });

  it("only prerelease tags: also falls back to the head sha (a release is required for a tag)", async () => {
    const sha = "fedcba9876543210fedcba9876543210fedcba98";
    const routes: Record<string, Reply> = {
      [tagsUrl()]: { status: 200, body: [tag("v1.0.0-rc.1")] },
      [GH]: { status: 200, body: { default_branch: "trunk" } },
      [`${GH}/commits/trunk`]: { status: 200, body: { sha } },
      [`${RAW}/${sha}/protocol.json`]: { status: 200, body: manifest() },
      [`${RAW}/${sha}/PROTOCOL.md`]: { status: 200, body: "d" },
    };
    expect((await loadProtocol("o/r", undefined, "/w", fakeFetch(routes).fetcher)).version).toBe("0.0.0+fedcba9");
  });

  it("a requested version on a repo without tags is VERSION_NOT_FOUND (no head fallback)", async () => {
    const routes: Record<string, Reply> = { [tagsUrl()]: { status: 200, body: [] } };
    expect((await fail(loadProtocol("o/r", "1.0.0", "/w", fakeFetch(routes).fetcher))).code).toBe("VERSION_NOT_FOUND");
  });
});

describe("definition checks", () => {
  async function load(files: { json?: unknown; md?: string | null; tags?: string[] }) {
    const routes: Record<string, Reply> = {
      [tagsUrl()]: { status: 200, body: (files.tags ?? ["v1.2.0"]).map(tag) },
      [`${RAW}/v1.2.0/protocol.json`]:
        files.json === undefined ? { status: 404, body: "404: Not Found" } : { status: 200, body: files.json },
      [`${RAW}/v1.2.0/PROTOCOL.md`]: files.md === null || files.md === undefined ? { status: 404, body: "404" } : { status: 200, body: files.md },
    };
    return loadProtocol("o/r", undefined, "/w", fakeFetch(routes).fetcher);
  }

  it("a good definition passes (PROTOCOL.md optional, messages optional)", async () => {
    const m = { name: "x", version: "1.2.0", description: "d" };
    const r = await load({ json: m });
    expect([r.name, r.version, r.definition.doc]).toEqual(["x", "1.2.0", ""]);
  });

  it("INVALID_DEFINITION", async () => {
    const cases: [string, unknown][] = [
      ["missing protocol.json", undefined],
      ["not JSON", "{oops"],
      ["array", "[]"],
      ["null", "null"],
      ["name missing", manifest({ name: undefined })],
      ["name upper case", manifest({ name: "Review" })],
      ["name too long", manifest({ name: "a".repeat(65) })],
      ["name not a string", manifest({ name: 5 })],
      ["description missing", manifest({ description: undefined })],
      ["description not a string", manifest({ description: 1 })],
      ["messages not an object", manifest({ messages: [] })],
      ["message schema not an object", manifest({ messages: { a: "x" } })],
      ["version missing", manifest({ version: undefined })],
      ["version not semver", manifest({ version: "1.2" })],
      ["version with v", manifest({ version: "v1.2.0" })],
    ];
    for (const [label, json] of cases) {
      const e = await fail(load({ json }));
      expect(e.code, label).toBe("INVALID_DEFINITION");
    }
  });

  it("VERSION_MISMATCH between protocol.json and the tag (v stripped)", async () => {
    const e = await fail(load({ json: manifest({ version: "1.2.1" }) }));
    expect(e.code).toBe("VERSION_MISMATCH");
    expect(e.message).toContain("1.2.1");
    expect(e.message).toContain("1.2.0");
  });

  it("TOO_LARGE: protocol.json, PROTOCOL.md (UTF-8 bytes)", async () => {
    const big = await fail(load({ json: manifest({ description: "x".repeat(64 * 1024) }) }));
    expect(big.code).toBe("TOO_LARGE");
    expect(big.message).toContain("protocol.json");
    // 22000 x 3-byte characters = 66000 bytes > 64 KiB although only 22000 characters
    const bigDoc = await fail(load({ json: manifest(), md: "あ".repeat(22000) }));
    expect(bigDoc.code).toBe("TOO_LARGE");
    expect(bigDoc.message).toContain("PROTOCOL.md");
    const hugeFile = await fail(load({ json: "x".repeat(1024 * 1024 + 1) }));
    expect(hugeFile.code).toBe("TOO_LARGE");
  });

  it("exactly at the limit is accepted", async () => {
    const m = manifest({ description: "" });
    const overhead = Buffer.byteLength(JSON.stringify(m));
    const atLimit = manifest({ description: "x".repeat(64 * 1024 - overhead) });
    expect(Buffer.byteLength(JSON.stringify(atLimit))).toBe(64 * 1024);
    const r = await load({ json: atLimit, md: "y".repeat(64 * 1024) });
    expect(r.name).toBe("review-request");
  });
});

describe("REPO_UNREACHABLE", () => {
  it("tag list: 404 / 403 / 500 / network error / not JSON", async () => {
    const cases: [Reply, string][] = [
      [{ status: 404, body: "" }, "HTTP 404"],
      [{ status: 403, body: "" }, "HTTP 403"],
      [{ status: 500, body: "" }, "HTTP 500"],
      [new Error("getaddrinfo ENOTFOUND"), "ENOTFOUND"],
      [{ status: 200, body: "<html>" }, "did not return JSON"],
    ];
    for (const [reply, needle] of cases) {
      const e = await fail(loadProtocol("o/r", undefined, "/w", fakeFetch({ [tagsUrl()]: reply }).fetcher));
      expect(e.code, needle).toBe("REPO_UNREACHABLE");
      expect(e.message).toContain(needle);
    }
    const priv = await fail(loadProtocol("o/r", undefined, "/w", fakeFetch({ [tagsUrl()]: { status: 404, body: "" } }).fetcher));
    expect(priv.message).toContain("private repositories are not supported");
  });

  it("raw file: 403 and network errors are unreachable, only 404 means 'no such file'", async () => {
    const tags = { [tagsUrl()]: { status: 200, body: [tag("v1.2.0")] } as Reply };
    const e403 = await fail(loadProtocol("o/r", undefined, "/w", fakeFetch({ ...tags, [`${RAW}/v1.2.0/protocol.json`]: { status: 403, body: "" } }).fetcher));
    expect(e403.code).toBe("REPO_UNREACHABLE");
    const eNet = await fail(loadProtocol("o/r", undefined, "/w", fakeFetch({ ...tags, [`${RAW}/v1.2.0/protocol.json`]: new Error("reset") }).fetcher));
    expect(eNet.code).toBe("REPO_UNREACHABLE");
    const ok = { ...tags, [`${RAW}/v1.2.0/protocol.json`]: { status: 200, body: manifest() } as Reply };
    const eMd = await fail(loadProtocol("o/r", undefined, "/w", fakeFetch({ ...ok, [`${RAW}/v1.2.0/PROTOCOL.md`]: { status: 502, body: "" } }).fetcher));
    expect(eMd.code).toBe("REPO_UNREACHABLE");
  });

  it("default branch lookup failures", async () => {
    const tags = { [tagsUrl()]: { status: 200, body: [] } as Reply };
    const noBranch = await fail(loadProtocol("o/r", undefined, "/w", fakeFetch({ ...tags, [GH]: { status: 200, body: {} } }).fetcher));
    expect(noBranch.code).toBe("REPO_UNREACHABLE");
    const badSha = await fail(
      loadProtocol("o/r", undefined, "/w", fakeFetch({ ...tags, [GH]: { status: 200, body: { default_branch: "main" } }, [`${GH}/commits/main`]: { status: 200, body: { sha: "xyz" } } }).fetcher)
    );
    expect(badSha.code).toBe("REPO_UNREACHABLE");
  });
});

describe("Gitea", () => {
  const BASE = "https://git.example.com";
  const API = `${BASE}/api/v1`;
  const tagsG = (page = 1) => `${API}/repos/o/r/tags?limit=50&page=${page}`;
  const rawG = (ref: string, file: string) => `${API}/repos/o/r/raw/${file}?ref=${ref}`;
  const routes = (): Record<string, Reply> => ({
    [`${API}/version`]: { status: 200, body: { version: "1.22.0" } },
    [tagsG(1)]: { status: 200, body: [tag("v1.0.0"), tag("v1.1.0")] },
    [tagsG(2)]: { status: 200, body: [] },
    [rawG("v1.1.0", "protocol.json")]: { status: 200, body: manifest({ version: "1.1.0" }) },
    [rawG("v1.1.0", "PROTOCOL.md")]: { status: 200, body: "doc" },
  });

  it("a bare https URL is checked with /api/v1/version, then tags are paged until an empty page", async () => {
    const { fetcher, calls } = fakeFetch(routes());
    const r = await loadProtocol("https://git.example.com/o/r", undefined, "/w", fetcher);
    expect([r.version, r.definition.source, r.definition.ref]).toEqual(["1.1.0", "gitea:https://git.example.com/o/r", "v1.1.0"]);
    expect(calls).toEqual([`${API}/version`, tagsG(1), tagsG(2), rawG("v1.1.0", "protocol.json"), rawG("v1.1.0", "PROTOCOL.md")]);
  });

  it("gitea: prefix skips the version probe", async () => {
    const rs = routes();
    delete rs[`${API}/version`];
    const { fetcher, calls } = fakeFetch(rs);
    await loadProtocol("gitea:https://git.example.com/o/r", undefined, "/w", fetcher);
    expect(calls).not.toContain(`${API}/version`);
  });

  it("UNSUPPORTED_REPO when the host does not answer like Gitea", async () => {
    const cases: Record<string, Reply> = {
      "404": { status: 404, body: "" },
      "html": { status: 200, body: "<html></html>" },
      "json without version": { status: 200, body: { hello: 1 } },
      "network": new Error("ECONNREFUSED"),
    };
    for (const [label, reply] of Object.entries(cases)) {
      const e = await fail(loadProtocol("https://git.example.com/o/r", undefined, "/w", fakeFetch({ [`${API}/version`]: reply }).fetcher));
      expect(e.code, label).toBe("UNSUPPORTED_REPO");
    }
  });

  it("stops paging when the server ignores the page parameter", async () => {
    const rs = routes();
    rs[tagsG(2)] = { status: 200, body: [tag("v1.0.0"), tag("v1.1.0")] };
    const { fetcher, calls } = fakeFetch(rs);
    await loadProtocol("gitea:https://git.example.com/o/r", undefined, "/w", fetcher);
    expect(calls.filter((c) => c.includes("/tags"))).toEqual([tagsG(1), tagsG(2)]);
  });

  it("head sha fallback uses the same API shape", async () => {
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const rs: Record<string, Reply> = {
      [tagsG(1)]: { status: 200, body: [] },
      [`${API}/repos/o/r`]: { status: 200, body: { default_branch: "main" } },
      [`${API}/repos/o/r/commits/main`]: { status: 200, body: { sha } },
      [rawG(sha, "protocol.json")]: { status: 200, body: manifest() },
      [rawG(sha, "PROTOCOL.md")]: { status: 404, body: "" },
    };
    const r = await loadProtocol("gitea:https://git.example.com/o/r", undefined, "/w", fakeFetch(rs).fetcher);
    expect(r.version).toBe("0.0.0+abcdef0");
  });
});

describe("local path", () => {
  const never: Fetcher = async () => {
    throw new Error("local paths must not fetch");
  };

  function repo(name: string, files: Record<string, string>): string {
    const d = join(dir, name);
    mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c);
    return d;
  }

  it("version comes from protocol.json, ref is local, no network", async () => {
    const m = manifest({ version: "3.1.4" });
    const d = repo("ok", { "protocol.json": JSON.stringify(m), "PROTOCOL.md": "local doc" });
    for (const arg of [d, `file://${d}`]) {
      const r = await loadProtocol(arg, undefined, "/elsewhere", never);
      expect([r.version, r.definition.ref, r.definition.source, r.definition.doc]).toEqual(["3.1.4", "local", `file:${d}`, "local doc"]);
      expect(r.hash).toBe(protocolHash(m, "local doc"));
    }
  });

  it("./rel is resolved against the given cwd; PROTOCOL.md is optional", async () => {
    const d = repo("rel", { "protocol.json": JSON.stringify(manifest()) });
    const r = await loadProtocol("./rel", undefined, dir, never);
    expect([r.definition.source, r.definition.doc]).toEqual([`file:${d}`, ""]);
  });

  it("a requested version is only a check against protocol.json", async () => {
    const d = repo("chk", { "protocol.json": JSON.stringify(manifest({ version: "1.2.0" })) });
    expect((await loadProtocol(d, "v1.2.0", "/", never)).version).toBe("1.2.0");
    const e = await fail(loadProtocol(d, "2.0.0", "/", never));
    expect(e.code).toBe("VERSION_MISMATCH");
  });

  it("errors: missing dir, missing protocol.json, bad version", async () => {
    expect((await fail(loadProtocol(join(dir, "nope"), undefined, "/", never))).code).toBe("REPO_UNREACHABLE");
    const empty = repo("empty", {});
    expect((await fail(loadProtocol(empty, undefined, "/", never))).code).toBe("INVALID_DEFINITION");
    const bad = repo("badver", { "protocol.json": JSON.stringify(manifest({ version: "latest" })) });
    expect((await fail(loadProtocol(bad, undefined, "/", never))).code).toBe("INVALID_DEFINITION");
    const noVer = repo("nover", { "protocol.json": JSON.stringify(manifest({ version: undefined })) });
    expect((await fail(loadProtocol(noVer, undefined, "/", never))).code).toBe("INVALID_DEFINITION");
  });
});
