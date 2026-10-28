import type {
  ListPeersRequest,
  MessageMeta,
  Peer,
  PeerScope,
  ProtocolDecl,
  ProtocolDefinition,
  ProtocolErrorResponse,
  ProtocolRoute,
  ProtocolRouteMap,
} from "@unagents/messenger-protocol";
import type { BrokerClient } from "./broker.js";
import { PROTOCOL_META_MAX_LENGTH } from "./constants.js";
import type { PeerState } from "./peer.js";
import { protocolError, errorMessage } from "./protocol-error.js";
import { defaultFetcher, loadProtocol } from "./repo.js";
import type { Fetcher } from "./repo.js";
import type { Logger } from "./resolve.js";
import { normalizeVersion } from "./semver.js";

/**
 * Client side of the protocol feature: the definitions this peer serves (kept in memory, design 6.5), the
 * calls to the broker's protocol routes, the filter on `list_peers`, `meta` handling for `send_message` and the
 * version check on received messages (design 6.4).
 */

/** A protocol this peer serves: the declaration sent in heartbeats and the body used to re-send it. */
export interface DeclaredProtocol {
  decl: ProtocolDecl;
  definition: ProtocolDefinition;
}

/** The newest `meta` received from one peer (reply warning, design 6.4). */
export interface SeenMeta {
  peerId: string;
  peerName: string;
  meta: MessageMeta;
}

export interface ProtocolState {
  declared: DeclaredProtocol[];
  /** oldest first, at most `SEEN_MAX` (LRU by arrival) */
  seen: SeenMeta[];
  fetcher: Fetcher;
  /** Set by the messenger: re-register with the broker (answer to `/set-protocol` saying `unknown peer`). */
  reregister: (() => Promise<void>) | null;
}

export function createProtocolState(fetcher: Fetcher = defaultFetcher): ProtocolState {
  return { declared: [], seen: [], fetcher, reregister: null };
}

/** What the tools and the library need from the messenger. */
export interface ProtocolEnv {
  broker: Pick<BrokerClient, "post"> & Partial<Pick<BrokerClient, "health">>;
  peer: PeerState;
  protocols: ProtocolState;
}

/** Result of `setProtocol`. */
export interface ProtocolInfo {
  name: string;
  version: string;
  hash: string;
  source: string;
  ref: string;
}

/** Result of `getProtocol`: the stored definition plus its identity and the number of servers. */
export interface ProtocolDetail extends ProtocolDefinition {
  name: string;
  version: string;
  hash: string;
  servers: number;
}

/** A peer as returned by `listPeers`; `protocols` lists what it serves. */
export type ProtocolPeer = Peer;

export interface PeerProtocolFilter {
  protocol?: string;
  /** Only with `protocol`. A leading `v` is dropped. */
  version?: string;
}

const SEEN_MAX = 100;

function requireId(env: ProtocolEnv): string {
  if (!env.peer.id) throw new Error("Not registered with broker yet");
  return env.peer.id;
}

// --- broker calls ---

async function brokerUnsupported(env: ProtocolEnv, what: string): Promise<Error> {
  let version = "unknown";
  try {
    if (typeof env.broker.health === "function") {
      const h = await env.broker.health();
      if (h) version = h.version;
    }
  } catch {
    // keep "unknown"
  }
  return protocolError("BROKER_UNSUPPORTED", `the broker (version ${version}) does not support ${what}; use a broker of 0.10.0 or later`);
}

/** POST to a protocol route; a 404 (broker older than 0.10) becomes `BROKER_UNSUPPORTED`. */
async function postRoute<R extends ProtocolRoute>(
  env: ProtocolEnv,
  path: R,
  body: ProtocolRouteMap[R]["request"]
): Promise<ProtocolRouteMap[R]["response"]> {
  try {
    return await env.broker.post(path, body);
  } catch (e) {
    if (errorMessage(e).startsWith(`Broker error (${path}): 404`)) throw await brokerUnsupported(env, "protocols");
    throw e;
  }
}

function responseError(r: { ok: false; error: string; code?: unknown }): Error {
  if (typeof r.code === "string") {
    return protocolError((r as ProtocolErrorResponse).code, r.error);
  }
  return new Error(`Failed: ${r.error}`);
}

function isUnknownPeer(r: { ok: false; error: string; code?: unknown }): boolean {
  return r.code === undefined && r.error.startsWith("unknown peer");
}

// --- set / unset / get ---

function declareLocally(state: ProtocolState, d: DeclaredProtocol): void {
  const i = state.declared.findIndex((x) => x.decl.name === d.decl.name);
  if (i === -1) state.declared.push(d);
  else state.declared[i] = d;
}

/** Fetch the definition of `repo` (design 6.2), register it at the broker and start serving it. */
export async function setProtocol(env: ProtocolEnv, repo: string, version?: string): Promise<ProtocolInfo> {
  requireId(env);
  const loaded = await loadProtocol(repo, version, env.peer.cwd, env.protocols.fetcher);
  const body = () => ({
    id: env.peer.id as string,
    name: loaded.name,
    version: loaded.version,
    hash: loaded.hash,
    definition: loaded.definition,
  });
  let r = await postRoute(env, "/set-protocol", body());
  if (!r.ok && isUnknownPeer(r) && env.protocols.reregister) {
    await env.protocols.reregister();
    requireId(env);
    r = await postRoute(env, "/set-protocol", body());
  }
  if (!r.ok) throw responseError(r);
  declareLocally(env.protocols, {
    decl: { name: loaded.name, version: loaded.version, hash: loaded.hash },
    definition: loaded.definition,
  });
  return {
    name: loaded.name,
    version: loaded.version,
    hash: loaded.hash,
    source: loaded.definition.source,
    ref: loaded.definition.ref,
  };
}

/** Stop serving `name` (all declarations when omitted). Returns how many the broker dropped. */
export async function unsetProtocol(env: ProtocolEnv, name?: string): Promise<number> {
  requireId(env);
  const body = () => (name === undefined ? { id: env.peer.id as string } : { id: env.peer.id as string, name });
  let r = await postRoute(env, "/unset-protocol", body());
  if (!r.ok && isUnknownPeer(r) && env.protocols.reregister) {
    await env.protocols.reregister();
    requireId(env);
    r = await postRoute(env, "/unset-protocol", body());
  }
  if (!r.ok) throw responseError(r);
  const st = env.protocols;
  st.declared = name === undefined ? [] : st.declared.filter((d) => d.decl.name !== name);
  return r.removed;
}

/** The definition the broker holds (no round trip to any server). `version` defaults to the highest held. */
export async function getProtocol(env: ProtocolEnv, name: string, version?: string): Promise<ProtocolDetail> {
  const v = version === undefined || version.trim() === "" ? undefined : normalizeVersion(version);
  const r = await postRoute(env, "/get-protocol", v === undefined ? { name } : { name, version: v });
  if (!r.ok) throw responseError(r);
  const p = r.protocol;
  return {
    name: p.name,
    version: p.version,
    hash: p.hash,
    servers: r.servers,
    manifest: p.definition.manifest,
    doc: p.definition.doc,
    source: p.definition.source,
    ref: p.definition.ref,
  };
}

// --- list_peers ---

/** `/list-peers` with the optional protocol filter; a broker that ignores the filter is `BROKER_UNSUPPORTED` (design 7.1). */
export async function listPeers(env: ProtocolEnv, scope: PeerScope, filter?: PeerProtocolFilter): Promise<Peer[]> {
  const body: ListPeersRequest = {
    scope,
    cwd: env.peer.cwd,
    git_root: env.peer.gitRoot,
    hostname: env.peer.hostname,
    exclude_id: env.peer.id ?? undefined,
  };
  const protocol = filter?.protocol === undefined || filter.protocol === "" ? undefined : filter.protocol;
  if (protocol !== undefined) {
    body.protocol = protocol;
    if (filter?.version !== undefined && filter.version.trim() !== "") body.version = normalizeVersion(filter.version);
  }
  const peers = await env.broker.post("/list-peers", body);
  // a 0.9 broker ignores the unknown fields and returns every peer, without `protocols`
  if (protocol !== undefined && peers.some((p) => !Array.isArray(p.protocols))) {
    throw await brokerUnsupported(env, "the protocol filter of list_peers");
  }
  return peers;
}

// --- send_message meta and reply warning ---

/** Check the `meta` argument (design 4.5): an object with non-empty string `protocol` and `version`. */
export function parseMeta(raw: unknown): MessageMeta | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw protocolError("INVALID_META", 'meta must be an object {protocol, version}');
  }
  const m = raw as Record<string, unknown>;
  if (typeof m.protocol !== "string" || m.protocol === "" || typeof m.version !== "string" || m.version === "") {
    throw protocolError("INVALID_META", "meta needs both protocol and version (non-empty strings)");
  }
  if (m.protocol.length > PROTOCOL_META_MAX_LENGTH || m.version.length > PROTOCOL_META_MAX_LENGTH) {
    throw protocolError("INVALID_META", `meta.protocol and meta.version are at most ${PROTOCOL_META_MAX_LENGTH} characters`);
  }
  return { protocol: m.protocol, version: m.version };
}

export interface OutgoingPlan {
  text: string;
  meta?: MessageMeta;
  /** the warning line, also reported to the sender */
  warning?: string;
}

/**
 * What to send to `to` (peer id or name). When that peer's latest message spoke another version of a protocol this
 * peer serves, the text starts with a warning line and `meta` carries this peer's version (design 6.4).
 * A `meta` the caller gave for a different protocol is left alone.
 */
export function planOutgoing(state: ProtocolState, to: string, text: string, meta?: MessageMeta): OutgoingPlan {
  for (let i = state.seen.length - 1; i >= 0; i--) {
    const s = state.seen[i];
    if (s.peerId !== to && (s.peerName === "" || s.peerName !== to)) continue;
    const mine = state.declared.find((d) => d.decl.name === s.meta.protocol);
    if (mine === undefined) break;
    if (normalizeVersion(s.meta.version) === mine.decl.version) break;
    if (meta !== undefined && meta.protocol !== s.meta.protocol) break;
    const warning = `[agent-messenger warning] protocol version mismatch: you sent ${s.meta.protocol}@${s.meta.version}, this server serves ${s.meta.protocol}@${mine.decl.version}`;
    return { text: `${warning}\n${text}`, meta: { protocol: s.meta.protocol, version: mine.decl.version }, warning };
  }
  return meta === undefined ? { text } : { text, meta };
}

// --- received messages ---

/** Remember the newest `meta` of a peer (LRU of `SEEN_MAX`). */
export function recordSeen(state: ProtocolState, peerId: string, peerName: string, meta: MessageMeta): void {
  const i = state.seen.findIndex((s) => s.peerId === peerId);
  if (i !== -1) state.seen.splice(i, 1);
  state.seen.push({ peerId, peerName, meta });
  while (state.seen.length > SEEN_MAX) state.seen.shift();
}

/** `Protocol: name@ver` for a received message, with the version check (design 6.4). */
export function describeMeta(state: ProtocolState, meta: MessageMeta): string {
  const base = `Protocol: ${meta.protocol}@${meta.version}`;
  const mine = state.declared.find((d) => d.decl.name === meta.protocol);
  if (mine === undefined) return `${base} (not served here)`;
  if (normalizeVersion(meta.version) === mine.decl.version) return base;
  return `${base} (this server: ${mine.decl.version}, mismatch)`;
}

// --- declarations on the wire ---

/** Hash-only declarations for `/register` and `/heartbeat`; `undefined` when there is none (the 0.9 wire form). */
export function wireDecls(state: ProtocolState): ProtocolDecl[] | undefined {
  if (state.declared.length === 0) return undefined;
  return state.declared.map((d) => ({ name: d.decl.name, version: d.decl.version, hash: d.decl.hash }));
}

/**
 * Re-send definition bodies with `/set-protocol`: every declared protocol, or only those named in `keys`
 * (`name@version`, from a heartbeat `resend`). Failures are logged, never thrown.
 */
export async function resendDefinitions(env: ProtocolEnv, log: Logger, keys?: string[]): Promise<void> {
  const id = env.peer.id;
  if (!id) return;
  for (const d of env.protocols.declared.slice()) {
    const key = `${d.decl.name}@${d.decl.version}`;
    if (keys !== undefined && !keys.includes(key)) continue;
    try {
      const r = await postRoute(env, "/set-protocol", {
        id,
        name: d.decl.name,
        version: d.decl.version,
        hash: d.decl.hash,
        definition: d.definition,
      });
      if (r.ok) log(`Protocol ${key} re-sent to the broker`);
      else log(`Protocol ${key} re-send rejected: ${r.error}`);
    } catch (e) {
      log(`Protocol ${key} re-send failed: ${errorMessage(e)}`);
    }
  }
}
