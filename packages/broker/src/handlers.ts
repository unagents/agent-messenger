import type {
  AcknowledgeMessagesRequest,
  AcknowledgeMessagesResponse,
  BrokerPostRoute,
  BrokerRequest,
  BrokerResponse,
  GetBufferedMessagesRequest,
  GetBufferedMessagesResponse,
  GetProtocolRequest,
  GetProtocolResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  ListPeersRequest,
  ListPeersResponse,
  Message,
  MessageMeta,
  MeshSyncRequest,
  MeshSyncResponse,
  Peer,
  PollMessagesRequest,
  PollMessagesResponse,
  ProtocolDecl,
  ProtocolErrorCode,
  ProtocolErrorResponse,
  ProtocolRoute,
  ProtocolRouteMap,
  RegisterRequest,
  RegisterResponse,
  RelayedMessage,
  RelayMessagesRequest,
  RelayMessagesResponse,
  SendMessageRequest,
  SendMessageResponse,
  SetNameRequest,
  SetNameResponse,
  SetProtocolRequest,
  SetProtocolResponse,
  SetSummaryRequest,
  SetSummaryResponse,
  StoredProtocol,
  UnregisterRequest,
  UnregisterResponse,
  UnsetProtocolRequest,
  UnsetProtocolResponse,
} from "@unagents/messenger-protocol";
import { HEARTBEAT_TIMEOUT_MS, PROTOCOL_MAX_STORED } from "@unagents/messenger-protocol";
import { log } from "./log.js";
import { checkDefinition, checkMeta, compareVersions, protocolHash, sanitizeDecls } from "./protocol.js";
import type { BrokerState } from "./state.js";

/** A relayed message nobody claims within this time is dropped. */
const PENDING_RELAY_TTL_MS = 60 * 60 * 1000;

/** Replicated peers vanish this long after their origin broker last synced (default 5 min). */
export const DEFAULT_MESH_PEER_TTL_MS = 300_000;

/** Upper bound of the duplicate-guard memory for forwarded mesh messages. */
const MESH_KEY_MEMORY = 2000;

export interface HandlerOptions {
  /** This broker's id (mesh: `origin` of the peers it hands out). */
  id?: string;
  /** Mesh: how long replicated peers survive without a sync from their origin. */
  meshPeerTtlMs?: number;
  /** Mesh: called after a message for a replicated peer was queued, to flush it early. */
  onRemoteMessage?: () => void;
}

/** Route handlers over a `BrokerState`. Logic is transcribed 1:1 from `legacy/src/broker.js`; fallback relay and mesh methods are additions. */
export class BrokerHandlers {
  private readonly recentMeshKeys = new Set<string>();
  /** Mesh protocol conflicts already logged (`name@version:hash`), so a standing conflict warns once, not every round. */
  private readonly warnedProtocolConflicts = new Set<string>();

  constructor(
    private readonly state: BrokerState,
    private readonly opts: HandlerOptions = {}
  ) {}

  // --- peer bookkeeping ---

  /** Cutoff `last_seen` (ISO) below which a peer counts as stale. */
  static cutoff(): string {
    return new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString();
  }

  /**
   * Direct peers: `last_seen` within the heartbeat timeout. Replicated peers
   * (mesh): their origin broker synced within `meshPeerTtlMs`; `last_seen` is
   * the origin's clock and is not compared.
   */
  isAlive(p: Peer, cutoff: string): boolean {
    if (p.origin) {
      const seen = this.state.originSeen.get(p.origin) ?? 0;
      return Date.now() - seen < (this.opts.meshPeerTtlMs ?? DEFAULT_MESH_PEER_TTL_MS);
    }
    return p.last_seen >= cutoff;
  }

  /** Number of peers seen within `HEARTBEAT_TIMEOUT_MS` (for `/health`). */
  alivePeerCount(): number {
    const cutoff = BrokerHandlers.cutoff();
    return [...this.state.peers.values()].filter((p) => this.isAlive(p, cutoff)).length;
  }

  cleanStalePeers(): void {
    const cutoff = BrokerHandlers.cutoff();
    let removed = 0;
    for (const p of [...this.state.peers.values()]) {
      if (!this.isAlive(p, cutoff)) {
        this.removePeer(p.id);
        removed++;
      }
    }
    if (removed) {
      log.info(`Cleaned ${removed} stale peer(s)`);
      this.state.scheduleSave();
    }
    const expiry = new Date(Date.now() - PENDING_RELAY_TTL_MS).toISOString();
    const kept = this.state.pending.filter((r) => r.queued_at >= expiry);
    if (kept.length !== this.state.pending.length) {
      log.info(`Dropped ${this.state.pending.length - kept.length} expired relayed message(s)`);
      this.state.pending = kept;
      this.state.scheduleSave();
    }
    this.gcProtocols();
  }

  // --- protocol store ---

  /** Alive peers (replicas included) that declare `name@version`. */
  private serversOf(name: string, version: string): Peer[] {
    const cutoff = BrokerHandlers.cutoff();
    return [...this.state.peers.values()].filter(
      (p) => this.isAlive(p, cutoff) && p.protocols?.some((d) => d.name === name && d.version === version)
    );
  }

  /**
   * Drop stored definitions that no alive peer (replicas included) declares by `(name, version)` any more.
   * Runs after `cleanStalePeers`, `register`, `unregister`, `/set-protocol`, `/unset-protocol`, `meshApplyPeers`
   * and before `/get-protocol` answers.
   */
  gcProtocols(): void {
    if (this.state.protocols.size === 0) return;
    const cutoff = BrokerHandlers.cutoff();
    const live = new Set<string>();
    for (const p of this.state.peers.values()) {
      if (!this.isAlive(p, cutoff)) continue;
      for (const d of p.protocols ?? []) live.add(`${d.name}@${d.version}`);
    }
    let removed = 0;
    for (const key of [...this.state.protocols.keys()]) {
      if (!live.has(key)) {
        this.state.protocols.delete(key);
        removed++;
      }
    }
    if (removed) {
      log.info(`Dropped ${removed} protocol definition(s) without a declaring peer`);
      this.state.scheduleSave();
    }
  }

  /**
   * Record `decls` on `peer` (hash only). A name the peer already declares is left alone (only `/set-protocol`
   * changes a declaration, so a heartbeat that raced a change cannot undo it), and so is a declaration whose hash
   * differs from the definition stored for the same `(name, version)`.
   */
  private mergeDecls(peer: Peer, decls: ProtocolDecl[]): boolean {
    let changed = false;
    for (const d of decls) {
      if (peer.protocols?.some((x) => x.name === d.name)) continue;
      const stored = this.state.protocols.get(`${d.name}@${d.version}`);
      if (stored && stored.hash !== d.hash) continue;
      peer.protocols = [...(peer.protocols ?? []), d];
      changed = true;
    }
    return changed;
  }

  /** A peer that registered here (not a mesh replica). Only those can heartbeat / rename. */
  private localPeer(id: string): Peer | undefined {
    const p = this.state.peers.get(id);
    return p && !p.origin ? p : undefined;
  }

  private removePeer(id: string): void {
    this.state.peers.delete(id);
    // drop messages that can never be delivered
    this.state.messages = this.state.messages.filter((m) => !(m.to_id === id && m.delivered === 0));
  }

  /** Resolve a peer by id or unique name. */
  private resolvePeer(to: string): { peer: Peer; error?: undefined } | { peer?: undefined; error: string } {
    const byId = this.state.peers.get(to);
    if (byId) return { peer: byId };
    const byName = [...this.state.peers.values()].filter((p) => p.name && p.name === to);
    if (byName.length === 1) return { peer: byName[0]! };
    if (byName.length > 1) {
      return {
        error: `Name "${to}" is ambiguous: ${byName.map((p) => `${p.id}@${p.hostname}`).join(", ")}`,
      };
    }
    return { error: `Peer "${to}" not found (no id or name matches)` };
  }

  private static generateId(): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let id = "";
    for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
  }

  // --- routes ---

  register(body: RegisterRequest): RegisterResponse {
    // re-registration for same pid+hostname replaces the old entry (also a replicated copy of it: the session moved here)
    for (const p of [...this.state.peers.values()]) {
      if (p.pid === body.pid && p.hostname === body.hostname) this.removePeer(p.id);
    }
    const id = BrokerHandlers.generateId();
    const now = new Date().toISOString();
    this.state.peers.set(id, {
      id,
      name: body.name ?? "",
      pid: body.pid,
      hostname: body.hostname ?? "",
      cwd: body.cwd ?? "",
      git_root: body.git_root ?? null,
      tty: body.tty ?? null,
      summary: body.summary ?? "",
      registered_at: now,
      last_seen: now,
    });
    const peer = this.state.peers.get(id)!;
    if (body.protocols !== undefined) this.mergeDecls(peer, sanitizeDecls(body.protocols));
    this.deliverPending(peer);
    this.gcProtocols(); // the replaced registration of the same session may have been the only declarer
    this.state.scheduleSave();
    return { id };
  }

  heartbeat(body: HeartbeatRequest): HeartbeatResponse {
    const p = this.localPeer(body.id);
    if (!p) return { ok: false, error: "unknown peer (re-register)" };
    p.last_seen = new Date().toISOString();
    if (body.protocols !== undefined) this.mergeDecls(p, sanitizeDecls(body.protocols));
    this.state.scheduleSave(); // keep last_seen fresh on disk so peers survive a broker restart
    // declarations of this peer whose body the broker does not hold: the client re-sends them with /set-protocol
    const resend = (p.protocols ?? []).filter((d) => !this.state.protocols.has(`${d.name}@${d.version}`)).map((d) => `${d.name}@${d.version}`);
    return resend.length ? { ok: true, resend } : { ok: true };
  }

  setSummary(body: SetSummaryRequest): SetSummaryResponse {
    const p = this.localPeer(body.id);
    if (!p) return { ok: false, error: "unknown peer" };
    p.summary = body.summary ?? "";
    this.state.scheduleSave();
    return { ok: true };
  }

  setName(body: SetNameRequest): SetNameResponse {
    const p = this.localPeer(body.id);
    if (!p) return { ok: false, error: "unknown peer" };
    p.name = body.name ?? "";
    this.deliverPending(p);
    this.state.scheduleSave();
    return { ok: true };
  }

  listPeers(body: ListPeersRequest): ListPeersResponse {
    const cutoff = BrokerHandlers.cutoff();
    let list = [...this.state.peers.values()].filter((p) => this.isAlive(p, cutoff));
    switch (body.scope) {
      case "host":
        if (body.hostname) list = list.filter((p) => p.hostname === body.hostname);
        break;
      case "directory":
        list = list.filter((p) => p.cwd === body.cwd);
        break;
      case "repo":
        list = body.git_root
          ? list.filter((p) => p.git_root === body.git_root)
          : list.filter((p) => p.cwd === body.cwd);
        break;
      default:
        // "all"
        break;
    }
    if (body.exclude_id) list = list.filter((p) => p.id !== body.exclude_id);
    if (body.protocol) {
      const { protocol, version } = body;
      list = list.filter((p) => p.protocols?.some((d) => d.name === protocol && (!version || d.version === version)));
    }
    // `origin` is mesh bookkeeping; clients see the plain 0.6.x peer shape
    return list.map(({ origin: _origin, ...p }) => p);
  }

  sendMessage(body: SendMessageRequest): SendMessageResponse {
    const resolved = this.resolvePeer(body.to);
    if (resolved.error !== undefined) return { ok: false, error: resolved.error };
    const { peer } = resolved;
    const mode = body.mode ?? "pull";
    if (mode !== "pull" && mode !== "push" && mode !== "ping") return { ok: false, error: `invalid mode: ${String(mode)}` };
    let meta: MessageMeta | undefined;
    if (body.meta !== undefined) {
      const checked = checkMeta(body.meta);
      if (!checked) return { ok: false, error: "invalid meta: expected {protocol: string, version: string}, each at most 128 characters" };
      meta = checked;
    }
    const msg: Message = {
      id: this.state.nextMsgId++,
      from_id: body.from_id ?? "cli",
      from_name: body.from_name ?? "",
      to_id: peer.id,
      text: body.text ?? "",
      mode,
      sent_at: new Date().toISOString(),
      delivered: 0,
      acknowledged: 0,
      ...(meta ? { meta } : {}),
    };
    this.state.messages.push(msg);
    this.state.scheduleSave();
    if (peer.origin) this.opts.onRemoteMessage?.();
    return { ok: true, to_id: peer.id, to_name: peer.name, message_id: msg.id };
  }

  pollMessages(body: PollMessagesRequest): PollMessagesResponse {
    const out = this.state.messages.filter((m) => m.to_id === body.id && m.delivered === 0);
    for (const m of out) m.delivered = 1;
    if (out.length) this.state.scheduleSave();
    return { messages: out };
  }

  acknowledgeMessages(body: AcknowledgeMessagesRequest): AcknowledgeMessagesResponse {
    const ids = new Set(body.message_ids ?? []);
    // acknowledged messages are dropped from the store
    const before = this.state.messages.length;
    this.state.messages = this.state.messages.filter((m) => !(m.to_id === body.id && ids.has(m.id)));
    if (this.state.messages.length !== before) this.state.scheduleSave();
    return { ok: true };
  }

  getBufferedMessages(body: GetBufferedMessagesRequest): GetBufferedMessagesResponse {
    return {
      messages: this.state.messages.filter(
        (m) => m.to_id === body.id && m.delivered === 1 && m.acknowledged === 0
      ),
    };
  }

  unregister(body: UnregisterRequest): UnregisterResponse {
    this.removePeer(body.id);
    this.gcProtocols();
    this.state.scheduleSave();
    return { ok: true };
  }

  // --- protocol registry ---

  private protocolError(code: ProtocolErrorCode, error: string, extra: Partial<ProtocolErrorResponse> = {}): ProtocolErrorResponse {
    return { ok: false, error, code, ...extra };
  }

  /**
   * `/set-protocol`. Order: unknown peer, definition shape / size (INVALID_DEFINITION, TOO_LARGE), hash
   * re-computation (HASH_MISMATCH), different hash for the same `(name, version)` (PROTOCOL_CONFLICT), held
   * definitions limit (LIMIT). The same hash again is a no-op success, so a client may re-send at will.
   */
  setProtocol(body: SetProtocolRequest): SetProtocolResponse {
    const peer = this.localPeer(body.id);
    if (!peer) return { ok: false, error: "unknown peer" };
    const checked = checkDefinition(body.name, body.version, body.definition);
    if (!checked.ok) return this.protocolError(checked.code, checked.error);
    const { name, version, definition } = body;
    const hash = protocolHash(definition.manifest, definition.doc);
    if (body.hash !== hash) {
      return this.protocolError("HASH_MISMATCH", `hash mismatch for ${name}@${version}: sent ${String(body.hash)}, computed ${hash}`);
    }
    this.gcProtocols(); // a definition nobody declares any more must not block a new one
    const key = `${name}@${version}`;
    const existing = this.state.protocols.get(key);
    if (existing && existing.hash !== hash) {
      const servers = this.serversOf(name, version).map((p) => `${p.name || p.id}@${p.hostname}`);
      return this.protocolError(
        "PROTOCOL_CONFLICT",
        `${key} is already registered with a different definition (hash ${existing.hash}, held by ${servers.join(", ") || "no server"}); every server of it must unset_protocol first`,
        { existing_hash: existing.hash, servers }
      );
    }
    if (!existing) {
      if (this.state.protocols.size >= PROTOCOL_MAX_STORED) {
        return this.protocolError("LIMIT", `this broker already holds ${PROTOCOL_MAX_STORED} protocol definitions (limit)`);
      }
      this.state.protocols.set(key, {
        name,
        version,
        hash,
        definition: { manifest: definition.manifest, doc: definition.doc, source: definition.source, ref: definition.ref },
        registered_at: new Date().toISOString(),
      });
    }
    // one version per name: a different version of the same name is replaced
    peer.protocols = [...(peer.protocols ?? []).filter((d) => d.name !== name), { name, version, hash }];
    this.gcProtocols();
    this.state.scheduleSave();
    return { ok: true };
  }

  /** `/unset-protocol`: drop one declaration by `name`, or all of the peer's. Succeeds with `removed: 0` when there was none. */
  unsetProtocol(body: UnsetProtocolRequest): UnsetProtocolResponse {
    const peer = this.localPeer(body.id);
    if (!peer) return { ok: false, error: "unknown peer" };
    if (body.name !== undefined && typeof body.name !== "string") return { ok: false, error: "invalid name" };
    const before = peer.protocols ?? [];
    const kept = body.name === undefined ? [] : before.filter((d) => d.name !== body.name);
    const removed = before.length - kept.length;
    if (kept.length) peer.protocols = kept;
    else delete peer.protocols;
    if (removed) {
      this.gcProtocols();
      this.state.scheduleSave();
    }
    return { ok: true, removed };
  }

  /** `/get-protocol`: the stored definition of `name` at `version`, or at the highest held version. No round trip to any server. */
  getProtocol(body: GetProtocolRequest): GetProtocolResponse {
    if (typeof body.name !== "string" || !body.name) return this.protocolError("PROTOCOL_NOT_FOUND", "protocol name is required", { versions: [] });
    this.gcProtocols(); // a definition whose servers are gone must not be served
    const held = [...this.state.protocols.values()].filter((sp) => sp.name === body.name);
    held.sort((a, b) => compareVersions(b.version, a.version) || (a.registered_at < b.registered_at ? 1 : -1));
    const versions = held.map((sp) => sp.version);
    const found = body.version === undefined ? held[0] : held.find((sp) => sp.version === body.version);
    if (!found) {
      const what = body.version === undefined ? `"${body.name}"` : `"${body.name}" version "${body.version}"`;
      return this.protocolError("PROTOCOL_NOT_FOUND", `Protocol ${what} not found (registered versions: ${versions.join(", ") || "none"})`, { versions });
    }
    return { ok: true, protocol: found, servers: this.serversOf(found.name, found.version).length };
  }

  /** Route table of the protocol registry in `PROTOCOL_ROUTES` order. */
  protocolRoutes(): { [R in ProtocolRoute]: (body: ProtocolRouteMap[R]["request"]) => ProtocolRouteMap[R]["response"] } {
    return {
      "/set-protocol": (b) => this.setProtocol(b),
      "/unset-protocol": (b) => this.unsetProtocol(b),
      "/get-protocol": (b) => this.getProtocol(b),
    };
  }

  // --- relay from a fallback broker ---

  /** Queue a message for `peerId` exactly like `sendMessage` does. */
  private enqueue(peerId: string, m: RelayedMessage): void {
    const meta = m.meta === undefined ? null : checkMeta(m.meta);
    this.state.messages.push({
      id: this.state.nextMsgId++,
      from_id: m.from_id,
      from_name: m.from_name,
      to_id: peerId,
      text: m.text,
      mode: m.mode ?? "pull",
      sent_at: m.sent_at,
      delivered: 0,
      acknowledged: 0,
      ...(meta ? { meta } : {}),
    });
  }

  /** Give `peer` the relayed messages that were waiting for its name. */
  private deliverPending(peer: Peer): void {
    if (!peer.name || this.state.pending.length === 0) return;
    const mine = (r: RelayedMessage) => r.to_name === peer.name && (!r.to_hostname || r.to_hostname === peer.hostname);
    const hits = this.state.pending.filter(mine);
    if (hits.length === 0) return;
    for (const r of hits) this.enqueue(peer.id, r);
    this.state.pending = this.state.pending.filter((r) => !mine(r));
    log.info(`Delivered ${hits.length} relayed message(s) to ${peer.name} (${peer.id})`);
  }

  /**
   * `/relay-messages`: undelivered messages of a fallback broker. Peer ids are broker-local, so the
   * recipient is addressed by name (and hostname). A recipient that is not registered yet (its client
   * moves over only after the fallback exits) gets the message when it registers.
   */
  relayMessages(body: RelayMessagesRequest): RelayMessagesResponse {
    const res: RelayMessagesResponse = { ok: true, delivered: 0, queued: 0, dropped: 0 };
    const cutoff = BrokerHandlers.cutoff();
    for (const m of body.messages ?? []) {
      if (!m.to_name) {
        res.dropped++;
        continue;
      }
      let cands = [...this.state.peers.values()].filter((p) => p.name === m.to_name && this.isAlive(p, cutoff));
      if (m.to_hostname && cands.some((p) => p.hostname === m.to_hostname)) cands = cands.filter((p) => p.hostname === m.to_hostname);
      if (cands.length === 1) {
        this.enqueue(cands[0]!.id, m);
        res.delivered++;
      } else {
        this.state.pending.push({ ...m, queued_at: new Date().toISOString() });
        res.queued++;
      }
    }
    this.state.scheduleSave();
    log.info(`Relay: ${res.delivered} delivered, ${res.queued} queued, ${res.dropped} dropped`);
    return res;
  }

  // --- mesh (permanent broker sync) ---

  /** Live peers that registered with this broker directly. */
  meshLocalPeers(): Peer[] {
    const cutoff = BrokerHandlers.cutoff();
    return [...this.state.peers.values()].filter((p) => !p.origin && this.isAlive(p, cutoff));
  }

  /** Undelivered messages addressed to peers replicated from `origin` (to be forwarded there). */
  meshOutbox(origin: string): Message[] {
    return this.state.messages.filter((m) => {
      if (m.delivered !== 0) return false;
      return this.state.peers.get(m.to_id)?.origin === origin;
    });
  }

  /** Drop messages the other broker took over. */
  meshDrop(ids: number[]): void {
    if (!ids.length) return;
    const gone = new Set(ids);
    this.state.messages = this.state.messages.filter((m) => !gone.has(m.id));
    this.state.scheduleSave();
  }

  /** Replace everything held for `origin` by `peers` and note that `origin` is alive. */
  meshApplyPeers(origin: string, peers: Peer[]): void {
    const now = new Date().toISOString();
    this.state.originSeen.set(origin, Date.now());
    const incoming = new Set<string>();
    for (const p of peers) {
      const local = this.state.peers.get(p.id);
      if (local && !local.origin) continue; // id clash with a direct peer: ours wins
      // the same session registered here after failing over: drop the stale copy
      const moved = [...this.state.peers.values()].some((q) => !q.origin && q.pid === p.pid && q.hostname === p.hostname);
      if (moved) continue;
      incoming.add(p.id);
      this.state.peers.set(p.id, { ...p, origin, last_seen: now });
    }
    for (const p of [...this.state.peers.values()]) {
      if (p.origin === origin && !incoming.has(p.id)) this.removePeer(p.id);
    }
    this.gcProtocols();
    this.state.scheduleSave();
  }

  /** Definitions declared by this broker's direct, alive peers (what a mesh sync sends). */
  meshLocalProtocols(): StoredProtocol[] {
    const out = new Map<string, StoredProtocol>();
    for (const p of this.meshLocalPeers()) {
      for (const d of p.protocols ?? []) {
        const key = `${d.name}@${d.version}`;
        const sp = this.state.protocols.get(key);
        if (sp && sp.hash === d.hash) out.set(key, sp);
      }
    }
    return [...out.values()];
  }

  /**
   * Take over definitions another broker's direct peers declare. Only a definition that a peer we now hold
   * declares with the same hash is stored (the rest would be collected at once). A `(name, version)` we already
   * hold with another hash stays as it is (ours wins) and the received one is dropped with a warning.
   */
  meshApplyProtocols(from: string, protocols: StoredProtocol[]): void {
    let added = false;
    for (const sp of protocols) {
      const checked = checkDefinition(sp?.name, sp?.version, sp?.definition);
      if (!checked.ok) {
        log.warn(`mesh: dropped protocol from ${from}: ${checked.error}`);
        continue;
      }
      const hash = protocolHash(sp.definition.manifest, sp.definition.doc);
      if (hash !== sp.hash) {
        log.warn(`mesh: dropped protocol ${sp.name}@${sp.version} from ${from}: hash mismatch`);
        continue;
      }
      const key = `${sp.name}@${sp.version}`;
      const mine = this.state.protocols.get(key);
      if (mine) {
        if (mine.hash !== hash && !this.warnedProtocolConflicts.has(`${key}:${hash}`)) {
          this.warnedProtocolConflicts.add(`${key}:${hash}`);
          log.warn(`mesh: protocol ${key} from ${from} differs from the one held here (${hash} vs ${mine.hash}); keeping ours`);
        }
        continue;
      }
      if (this.state.protocols.size >= PROTOCOL_MAX_STORED) {
        log.warn(`mesh: dropped protocol ${key} from ${from}: ${PROTOCOL_MAX_STORED} definitions held (limit)`);
        continue;
      }
      if (!this.serversOf(sp.name, sp.version).some((p) => p.protocols?.some((d) => d.name === sp.name && d.version === sp.version && d.hash === hash))) continue;
      this.state.protocols.set(key, {
        name: sp.name,
        version: sp.version,
        hash,
        definition: { manifest: sp.definition.manifest, doc: sp.definition.doc, source: sp.definition.source, ref: sp.definition.ref },
        registered_at: typeof sp.registered_at === "string" ? sp.registered_at : new Date().toISOString(),
      });
      added = true;
    }
    if (added) this.state.scheduleSave();
  }

  /** Take over messages forwarded by broker `from`; returns the sender-side ids to drop (duplicates count as taken). */
  meshAccept(from: string, messages: Message[]): number[] {
    const accepted: number[] = [];
    for (const m of messages) {
      const target = this.state.peers.get(m.to_id);
      if (!target || target.origin) continue;
      const key = `${from}:${m.id}`;
      const dup = this.recentMeshKeys.has(key) || this.state.messages.some((x) => x.mesh_key === key);
      if (!dup) {
        this.state.messages.push({ ...m, id: this.state.nextMsgId++, delivered: 0, acknowledged: 0, mesh_key: key });
        this.recentMeshKeys.add(key);
        if (this.recentMeshKeys.size > MESH_KEY_MEMORY) this.recentMeshKeys.delete(this.recentMeshKeys.values().next().value!);
      }
      accepted.push(m.id);
    }
    if (accepted.length) this.state.scheduleSave();
    return accepted;
  }

  /** Inbound `/mesh/sync`. */
  meshSync(body: MeshSyncRequest): MeshSyncResponse {
    if (!body.from) throw new Error("mesh sync: missing from");
    // listed itself in the member list: answer with our id so the sender sees it is talking to itself
    if (body.from === this.opts.id) return { id: body.from, peers: [], accepted: [] };
    this.meshApplyPeers(body.from, body.peers ?? []);
    this.meshApplyProtocols(body.from, body.protocols ?? []);
    const accepted = this.meshAccept(body.from, body.messages ?? []);
    const protocols = this.meshLocalProtocols();
    return { id: this.opts.id ?? "", peers: this.meshLocalPeers(), accepted, ...(protocols.length ? { protocols } : {}) };
  }

  /** Route table in `BROKER_POST_ROUTES` order. */
  routes(): { [R in BrokerPostRoute]: (body: BrokerRequest<R>) => BrokerResponse<R> } {
    return {
      "/register": (b) => this.register(b),
      "/heartbeat": (b) => this.heartbeat(b),
      "/set-summary": (b) => this.setSummary(b),
      "/set-name": (b) => this.setName(b),
      "/list-peers": (b) => this.listPeers(b),
      "/send-message": (b) => this.sendMessage(b),
      "/poll-messages": (b) => this.pollMessages(b),
      "/acknowledge-messages": (b) => this.acknowledgeMessages(b),
      "/get-buffered-messages": (b) => this.getBufferedMessages(b),
      "/unregister": (b) => this.unregister(b),
    };
  }
}
