import type {
  AcknowledgeMessagesRequest,
  AcknowledgeMessagesResponse,
  BrokerPostRoute,
  BrokerRequest,
  BrokerResponse,
  GetBufferedMessagesRequest,
  GetBufferedMessagesResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  ListPeersRequest,
  ListPeersResponse,
  Message,
  MeshSyncRequest,
  MeshSyncResponse,
  Peer,
  PollMessagesRequest,
  PollMessagesResponse,
  RegisterRequest,
  RegisterResponse,
  SendMessageRequest,
  SendMessageResponse,
  SetNameRequest,
  SetNameResponse,
  SetSummaryRequest,
  SetSummaryResponse,
  UnregisterRequest,
  UnregisterResponse,
} from "@agent-hand/messenger-protocol";
import { HEARTBEAT_TIMEOUT_MS } from "@agent-hand/messenger-protocol";
import { log } from "./log.js";
import type { BrokerState } from "./state.js";

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

/** Route handlers over a `BrokerState`. Logic is transcribed 1:1 from `legacy/src/broker.js`; mesh methods are additions. */
export class BrokerHandlers {
  private readonly recentMeshKeys = new Set<string>();

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
    this.state.scheduleSave();
    return { id };
  }

  heartbeat(body: HeartbeatRequest): HeartbeatResponse {
    const p = this.localPeer(body.id);
    if (!p) return { ok: false, error: "unknown peer (re-register)" };
    p.last_seen = new Date().toISOString();
    this.state.scheduleSave(); // keep last_seen fresh on disk so peers survive a broker restart
    return { ok: true };
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
    // `origin` is mesh bookkeeping; clients see the plain 0.6.x peer shape
    return list.map(({ origin: _origin, ...p }) => p);
  }

  sendMessage(body: SendMessageRequest): SendMessageResponse {
    const resolved = this.resolvePeer(body.to);
    if (resolved.error !== undefined) return { ok: false, error: resolved.error };
    const { peer } = resolved;
    const mode = body.mode ?? "pull";
    if (mode !== "pull" && mode !== "push" && mode !== "ping") return { ok: false, error: `invalid mode: ${String(mode)}` };
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
    this.state.scheduleSave();
    return { ok: true };
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
    this.state.scheduleSave();
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
    const accepted = this.meshAccept(body.from, body.messages ?? []);
    return { id: this.opts.id ?? "", peers: this.meshLocalPeers(), accepted };
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
