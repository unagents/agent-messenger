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

/** Route handlers over a `BrokerState`. Logic is transcribed 1:1 from `legacy/src/broker.js`. */
export class BrokerHandlers {
  constructor(private readonly state: BrokerState) {}

  // --- peer bookkeeping ---

  /** Cutoff `last_seen` (ISO) below which a peer counts as stale. */
  static cutoff(): string {
    return new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString();
  }

  static isAlive(p: Peer, cutoff: string): boolean {
    return p.last_seen >= cutoff;
  }

  /** Number of peers seen within `HEARTBEAT_TIMEOUT_MS` (for `/health`). */
  alivePeerCount(): number {
    const cutoff = BrokerHandlers.cutoff();
    return [...this.state.peers.values()].filter((p) => BrokerHandlers.isAlive(p, cutoff)).length;
  }

  cleanStalePeers(): void {
    const cutoff = BrokerHandlers.cutoff();
    let removed = 0;
    for (const p of this.state.peers.values()) {
      if (!BrokerHandlers.isAlive(p, cutoff)) {
        this.removePeer(p.id);
        removed++;
      }
    }
    if (removed) {
      log.info(`Cleaned ${removed} stale peer(s)`);
      this.state.scheduleSave();
    }
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
    // re-registration for same pid+hostname replaces the old entry
    for (const p of this.state.peers.values()) {
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
    const p = this.state.peers.get(body.id);
    if (!p) return { ok: false, error: "unknown peer (re-register)" };
    p.last_seen = new Date().toISOString();
    this.state.scheduleSave(); // keep last_seen fresh on disk so peers survive a broker restart
    return { ok: true };
  }

  setSummary(body: SetSummaryRequest): SetSummaryResponse {
    const p = this.state.peers.get(body.id);
    if (!p) return { ok: false, error: "unknown peer" };
    p.summary = body.summary ?? "";
    this.state.scheduleSave();
    return { ok: true };
  }

  setName(body: SetNameRequest): SetNameResponse {
    const p = this.state.peers.get(body.id);
    if (!p) return { ok: false, error: "unknown peer" };
    p.name = body.name ?? "";
    this.state.scheduleSave();
    return { ok: true };
  }

  listPeers(body: ListPeersRequest): ListPeersResponse {
    const cutoff = BrokerHandlers.cutoff();
    let list = [...this.state.peers.values()].filter((p) => BrokerHandlers.isAlive(p, cutoff));
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
    return list;
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
