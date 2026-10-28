import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProtocolDefinition } from "@unagents/messenger-protocol";
import {
  PROTOCOL_DOC_MAX_BYTES,
  PROTOCOL_MANIFEST_MAX_BYTES,
  PROTOCOL_NAME_PATTERN,
  PROTOCOL_TOTAL_MAX_BYTES,
} from "./constants.js";
import { protocolHash } from "./hash.js";
import { errorMessage, protocolError } from "./protocol-error.js";
import { compareSemver, normalizeVersion, parseSemver } from "./semver.js";
import type { Semver } from "./semver.js";

/**
 * Protocol repo access (design 3, 6.1, 6.2): which repo an argument names, which version of it to read, and
 * the validated definition. Public GitHub / Gitea repos over https (no credentials) and local paths only.
 */

export interface FetchResult {
  status: number;
  text: string;
}

/** One GET without headers (PerryTS `fetch` drops them anyway). Rejects on a network failure. */
export type Fetcher = (url: string) => Promise<FetchResult>;

const FETCH_TIMEOUT_MS = 15000;

/** `fetch` is looked up per call, so a test can stub the global. */
export const defaultFetcher: Fetcher = (url) =>
  new Promise<FetchResult>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${FETCH_TIMEOUT_MS}ms`)), FETCH_TIMEOUT_MS);
    fetch(url)
      .then(async (res) => {
        const text = await res.text();
        clearTimeout(timer);
        resolve({ status: res.status, text });
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
  });

export type RepoRef =
  | { kind: "github"; owner: string; repo: string; source: string }
  | { kind: "gitea"; base: string; owner: string; repo: string; source: string; verified: boolean }
  | { kind: "local"; dir: string; source: string };

const ACCEPTED =
  "https://github.com/<owner>/<repo>, <owner>/<repo>, github:<owner>/<repo>, gitea:<base-url>/<owner>/<repo>, " +
  "https://<gitea-host>/<owner>/<repo>, /abs/path, ./rel/path, file:///abs/path";

function unsupported(arg: string, why = ""): Error {
  return protocolError("UNSUPPORTED_REPO", `cannot use "${arg}" as a protocol repo${why ? ` (${why})` : ""}. Accepted forms: ${ACCEPTED}`);
}

const NAME_PART = /^[A-Za-z0-9_.-]+$/;

/** Collapse `.` / `..` / empty segments of an absolute path. */
function normalizePath(p: string): string {
  const stack: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return "/" + stack.join("/");
}

function local(dir: string): RepoRef {
  const d = normalizePath(dir);
  return { kind: "local", dir: d, source: `file:${d}` };
}

function cleanRepoName(r: string): string {
  return r.length > 4 && r.endsWith(".git") ? r.slice(0, r.length - 4) : r;
}

function github(owner: string, repo: string, arg: string): RepoRef {
  const r = cleanRepoName(repo);
  if (!NAME_PART.test(owner) || !NAME_PART.test(r)) throw unsupported(arg, "owner / repo contain unsupported characters");
  return { kind: "github", owner, repo: r, source: `github:${owner}/${r}` };
}

function parseHttp(s: string, allowHttp: boolean, arg: string): { host: string; segs: string[]; protocol: string } {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw unsupported(arg, "not a URL");
  }
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) throw unsupported(arg, "https is required");
  return { host: u.host, protocol: u.protocol, segs: u.pathname.split("/").filter((x) => x !== "") };
}

function gitea(s: string, allowHttp: boolean, verified: boolean, arg: string): RepoRef {
  const { host, protocol, segs } = parseHttp(s, allowHttp, arg);
  if (segs.length < 2) throw unsupported(arg, "expected <base-url>/<owner>/<repo>");
  const owner = segs[segs.length - 2];
  const repo = cleanRepoName(segs[segs.length - 1]);
  if (!NAME_PART.test(owner) || !NAME_PART.test(repo)) throw unsupported(arg, "owner / repo contain unsupported characters");
  const prefix = segs.length > 2 ? `/${segs.slice(0, segs.length - 2).join("/")}` : "";
  const base = `${protocol}//${host}${prefix}`;
  return { kind: "gitea", base, owner, repo, source: `gitea:${base}/${owner}/${repo}`, verified };
}

/** Classify a `repo` argument (design 6.1). `cwd` resolves `./rel` paths. A bare https URL still needs `verifyGitea`. */
export function parseRepoArg(arg: string, cwd: string): RepoRef {
  const s = arg.trim();
  if (s === "") throw unsupported(arg, "empty");
  if (s.startsWith("file://")) {
    const p = s.slice(7);
    if (!p.startsWith("/")) throw unsupported(arg, "file:// needs an absolute path (file:///abs/path)");
    let dir: string;
    try {
      dir = decodeURIComponent(p);
    } catch {
      throw unsupported(arg, "bad escape in file URL");
    }
    return local(dir);
  }
  if (s.startsWith("/")) return local(s);
  if (s === "." || s === ".." || s.startsWith("./") || s.startsWith("../")) return local(`${cwd}/${s}`);
  if (s.startsWith("github:")) {
    const parts = s.slice(7).split("/");
    if (parts.length !== 2) throw unsupported(arg, "expected github:<owner>/<repo>");
    return github(parts[0], parts[1], arg);
  }
  if (s.startsWith("gitea:")) return gitea(s.slice(6), true, true, arg);
  if (s.startsWith("https://") || s.startsWith("http://")) {
    const { host, segs } = parseHttp(s, false, arg);
    if (host === "github.com" || host === "www.github.com") {
      if (segs.length !== 2) throw unsupported(arg, "expected https://github.com/<owner>/<repo>");
      return github(segs[0], segs[1], arg);
    }
    return gitea(s, false, false, arg);
  }
  const parts = s.split("/");
  if (parts.length === 2 && NAME_PART.test(parts[0]) && NAME_PART.test(parts[1])) return github(parts[0], parts[1], arg);
  throw unsupported(arg);
}

// --- remote API ---

type Remote = Exclude<RepoRef, { kind: "local" }>;

function apiBase(r: Remote): string {
  return r.kind === "github" ? "https://api.github.com" : `${r.base}/api/v1`;
}

async function fetchText(fetcher: Fetcher, url: string): Promise<FetchResult> {
  try {
    return await fetcher(url);
  } catch (e) {
    throw protocolError("REPO_UNREACHABLE", `${url}: ${errorMessage(e)}`);
  }
}

function httpFail(url: string, status: number): Error {
  let hint = "";
  if (status === 401 || status === 403 || status === 404) {
    hint = ` (repository not found or private; private repositories are not supported${status === 403 ? ", or the API rate limit is reached" : ""})`;
  }
  return protocolError("REPO_UNREACHABLE", `${url} returned HTTP ${status}${hint}`);
}

async function getJson(fetcher: Fetcher, url: string): Promise<unknown> {
  const r = await fetchText(fetcher, url);
  if (r.status < 200 || r.status >= 300) throw httpFail(url, r.status);
  try {
    return JSON.parse(r.text);
  } catch {
    throw protocolError("REPO_UNREACHABLE", `${url} did not return JSON`);
  }
}

/** A bare https URL is taken for Gitea only when `<base>/api/v1/version` answers like Gitea. */
async function verifyGitea(r: Extract<RepoRef, { kind: "gitea" }>, arg: string, fetcher: Fetcher): Promise<void> {
  const url = `${r.base}/api/v1/version`;
  let res: FetchResult;
  try {
    res = await fetcher(url);
  } catch (e) {
    throw unsupported(arg, `${url} is not reachable: ${errorMessage(e)}`);
  }
  let ok = false;
  if (res.status === 200) {
    try {
      const v = JSON.parse(res.text) as { version?: unknown };
      ok = typeof v === "object" && v !== null && typeof v.version === "string";
    } catch {
      ok = false;
    }
  }
  if (!ok) throw unsupported(arg, `${url} does not answer like Gitea (HTTP ${res.status}); use github:/gitea: or a local path`);
}

const MAX_TAG_PAGES = 20;

/** Tag names, paged (GitHub 100 per page, Gitea up to its own page limit). */
async function listTags(r: Remote, fetcher: Fetcher): Promise<string[]> {
  const names: string[] = [];
  let prevFirst = "";
  for (let page = 1; page <= MAX_TAG_PAGES; page++) {
    const q = r.kind === "github" ? `per_page=100&page=${page}` : `limit=50&page=${page}`;
    const arr = await getJson(fetcher, `${apiBase(r)}/repos/${r.owner}/${r.repo}/tags?${q}`);
    if (!Array.isArray(arr) || arr.length === 0) break;
    const first = String((arr[0] as { name?: unknown } | null)?.name ?? "");
    if (first === prevFirst) break; // the server ignored `page`
    prevFirst = first;
    for (const t of arr) {
      const n = (t as { name?: unknown } | null)?.name;
      if (typeof n === "string") names.push(n);
    }
    if (r.kind === "github" && arr.length < 100) break;
  }
  return names;
}

async function headSha(r: Remote, fetcher: Fetcher): Promise<string> {
  const api = apiBase(r);
  const info = (await getJson(fetcher, `${api}/repos/${r.owner}/${r.repo}`)) as { default_branch?: unknown } | null;
  const branch = info?.default_branch;
  if (typeof branch !== "string" || branch === "") {
    throw protocolError("REPO_UNREACHABLE", `${r.source}: the repository info has no default_branch`);
  }
  const commit = (await getJson(fetcher, `${api}/repos/${r.owner}/${r.repo}/commits/${encodeURIComponent(branch)}`)) as { sha?: unknown } | null;
  const sha = commit?.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{7,64}$/.test(sha)) {
    throw protocolError("REPO_UNREACHABLE", `${r.source}: no commit sha for branch ${branch}`);
  }
  return sha;
}

function rawUrl(r: Remote, ref: string, file: string): string {
  if (r.kind === "github") return `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${encodeURIComponent(ref)}/${file}`;
  return `${r.base}/api/v1/repos/${r.owner}/${r.repo}/raw/${file}?ref=${encodeURIComponent(ref)}`;
}

/** File text, or `null` when the repo has no such file (HTTP 404). */
async function fetchFile(r: Remote, ref: string, file: string, fetcher: Fetcher): Promise<string | null> {
  const url = rawUrl(r, ref, file);
  const res = await fetchText(fetcher, url);
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) throw httpFail(url, res.status);
  return res.text;
}

// --- validation ---

/** Largest file text read before parsing (a guard against a huge download; the real limits are below). */
const RAW_MAX_CHARS = 1024 * 1024;

export interface LoadedProtocol {
  name: string;
  version: string;
  /** `sha256(canonicalJSON({manifest, doc}))` */
  hash: string;
  definition: ProtocolDefinition;
}

type VersionMode =
  | { mode: "tag"; version: string }
  | { mode: "tagless"; version: string }
  | { mode: "local"; requested: string | undefined };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function invalid(detail: string): Error {
  return protocolError("INVALID_DEFINITION", detail);
}

/** Check `protocol.json` + `PROTOCOL.md` (design 3, 5.4) and build the definition. */
function buildLoaded(manifestText: string, doc: string, source: string, ref: string, ver: VersionMode): LoadedProtocol {
  if (manifestText.length > RAW_MAX_CHARS) {
    throw protocolError("TOO_LARGE", `protocol.json is over ${RAW_MAX_CHARS} characters (limit ${PROTOCOL_MANIFEST_MAX_BYTES} bytes)`);
  }
  if (doc.length > RAW_MAX_CHARS) {
    throw protocolError("TOO_LARGE", `PROTOCOL.md is over ${RAW_MAX_CHARS} characters (limit ${PROTOCOL_DOC_MAX_BYTES} bytes)`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch (e) {
    throw invalid(`protocol.json is not valid JSON (${errorMessage(e)})`);
  }
  if (!isPlainObject(parsed)) throw invalid("protocol.json must be a JSON object");
  const manifest = parsed;
  const name = manifest.name;
  if (typeof name !== "string" || !PROTOCOL_NAME_PATTERN.test(name)) {
    throw invalid(`protocol.json "name" is missing or does not match ${String(PROTOCOL_NAME_PATTERN)}`);
  }
  if (typeof manifest.description !== "string") throw invalid('protocol.json "description" is missing (a string is required)');
  if (manifest.messages !== undefined) {
    if (!isPlainObject(manifest.messages)) throw invalid('protocol.json "messages" must be an object');
    for (const k of Object.keys(manifest.messages)) {
      if (!isPlainObject(manifest.messages[k])) throw invalid(`protocol.json messages.${k} must be an object (JSON Schema)`);
    }
  }

  let version: string;
  if (ver.mode === "tagless") {
    version = ver.version; // protocol.json "version" is not checked (design 3)
  } else {
    const mv = manifest.version;
    if (typeof mv !== "string" || parseSemver(mv) === null) {
      throw invalid('protocol.json "version" is missing or not a semver (e.g. 1.2.0)');
    }
    if (ver.mode === "tag") {
      if (mv !== ver.version) throw protocolError("VERSION_MISMATCH", `protocol.json version is ${mv} but the tag is ${ver.version}`);
      version = ver.version;
    } else {
      if (ver.requested !== undefined && normalizeVersion(ver.requested) !== mv) {
        throw protocolError("VERSION_MISMATCH", `version ${ver.requested} was requested but protocol.json (local path) says ${mv}`);
      }
      version = mv;
    }
  }

  const manifestBytes = Buffer.byteLength(JSON.stringify(manifest));
  const docBytes = Buffer.byteLength(doc);
  if (manifestBytes > PROTOCOL_MANIFEST_MAX_BYTES) {
    throw protocolError("TOO_LARGE", `protocol.json is ${manifestBytes} bytes (limit ${PROTOCOL_MANIFEST_MAX_BYTES})`);
  }
  if (docBytes > PROTOCOL_DOC_MAX_BYTES) {
    throw protocolError("TOO_LARGE", `PROTOCOL.md is ${docBytes} bytes (limit ${PROTOCOL_DOC_MAX_BYTES})`);
  }
  if (manifestBytes + docBytes > PROTOCOL_TOTAL_MAX_BYTES) {
    throw protocolError("TOO_LARGE", `the definition is ${manifestBytes + docBytes} bytes (limit ${PROTOCOL_TOTAL_MAX_BYTES})`);
  }

  return { name, version, hash: protocolHash(manifest, doc), definition: { manifest, doc, source, ref } };
}

// --- loading ---

function loadLocal(r: Extract<RepoRef, { kind: "local" }>, requested: string | undefined): LoadedProtocol {
  let isDir = false;
  try {
    isDir = existsSync(r.dir) && statSync(r.dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw protocolError("REPO_UNREACHABLE", `${r.dir} is not a directory`);
  const manifestPath = join(r.dir, "protocol.json");
  if (!existsSync(manifestPath)) throw invalid(`protocol.json not found in ${r.dir}`);
  const manifestText = readFileSync(manifestPath, "utf8");
  const docPath = join(r.dir, "PROTOCOL.md");
  const doc = existsSync(docPath) ? readFileSync(docPath, "utf8") : "";
  return buildLoaded(manifestText, doc, r.source, "local", { mode: "local", requested });
}

async function loadRemote(r: Remote, requested: string | undefined, fetcher: Fetcher): Promise<LoadedProtocol> {
  const tags: { name: string; version: string; sv: Semver }[] = [];
  for (const name of await listTags(r, fetcher)) {
    const version = normalizeVersion(name);
    const sv = parseSemver(version);
    if (sv !== null) tags.push({ name, version, sv });
  }
  const newestFirst = tags.slice().sort((a, b) => compareSemver(b.sv, a.sv));

  let ref: string;
  let ver: VersionMode;
  if (requested === undefined) {
    const stable = newestFirst.find((t) => t.sv.pre.length === 0);
    if (stable !== undefined) {
      ref = stable.name;
      ver = { mode: "tag", version: stable.version };
    } else {
      const sha = await headSha(r, fetcher);
      ref = sha;
      ver = { mode: "tagless", version: `0.0.0+${sha.slice(0, 7)}` };
    }
  } else {
    const want = normalizeVersion(requested);
    const hit = tags.find((t) => t.version === want);
    if (hit === undefined) {
      const cand = newestFirst.slice(0, 5).map((t) => t.name);
      throw protocolError(
        "VERSION_NOT_FOUND",
        `version "${requested}" has no tag in ${r.source}. ${cand.length > 0 ? `Candidates: ${cand.join(", ")}` : "The repository has no semver tags."}`
      );
    }
    ref = hit.name;
    ver = { mode: "tag", version: hit.version };
  }

  const manifestText = await fetchFile(r, ref, "protocol.json", fetcher);
  if (manifestText === null) throw invalid(`protocol.json not found in ${r.source} at ${ref}`);
  const doc = (await fetchFile(r, ref, "PROTOCOL.md", fetcher)) ?? "";
  return buildLoaded(manifestText, doc, r.source, ref, ver);
}

/**
 * Resolve `repoArg` / `requested` version to a validated definition: classify the repo (6.1), pick the version
 * (6.2), read `protocol.json` / `PROTOCOL.md`, check them (3, 5.4) and hash them.
 */
export async function loadProtocol(
  repoArg: string,
  requested: string | undefined,
  cwd: string,
  fetcher: Fetcher
): Promise<LoadedProtocol> {
  const req = requested === undefined || requested.trim() === "" ? undefined : requested.trim();
  const ref = parseRepoArg(repoArg, cwd);
  if (ref.kind === "local") return loadLocal(ref, req);
  if (ref.kind === "gitea" && !ref.verified) await verifyGitea(ref, repoArg, fetcher);
  return loadRemote(ref, req, fetcher);
}
