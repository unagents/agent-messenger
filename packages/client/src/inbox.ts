import type { Message, Peer } from "@unagents/messenger-protocol";
import type { BrokerClient } from "./broker.js";
import type { PeerState } from "./peer.js";
import { describeMeta, recordSeen } from "./protocols.js";
import type { ProtocolState } from "./protocols.js";
import type { Logger } from "./resolve.js";

/** A polled message enriched with sender details. */
export interface InboundMessage extends Message {
  from_hostname: string;
  from_summary: string;
  from_cwd: string;
  /**
   * `Protocol: name@ver` (+ `(this server: X, mismatch)` / `(not served here)`) for a message that carries `meta`;
   * decided when the message was buffered.
   */
  protocol_line?: string;
}

/** The host's way to reach the conversation (stdio: session socket, then channel notification). */
export interface Notifier {
  /** Pull unread notice. `latest` = last buffered message, `count` = buffer size. Resolves true when delivered. */
  unread(latest: InboundMessage, count: number): Promise<boolean>;
  /** Ping notice. Failures are only logged (the inbox acknowledges afterwards). */
  ping(entry: InboundMessage): Promise<void>;
  /** Push delivery of the text. Resolves true when delivered (the inbox acknowledges); false leaves it buffered. */
  push(entry: InboundMessage): Promise<boolean>;
}

export type MessageHandler = (m: InboundMessage) => void | Promise<void>;

export interface Inbox {
  /** Pull undelivered messages from the broker; `push` enables notifier delivery. */
  poll(push: boolean): Promise<void>;
  /** Read and acknowledge everything buffered (also fetches buffered-but-unacknowledged ones from the broker). */
  checkMessages(): Promise<InboundMessage[]>;
  /** Register a handler (library use). Returns an unregister function. */
  onMessage(handler: MessageHandler): () => void;
  /**
   * Before a broker switch: take what the old broker still holds for us, acknowledge everything buffered
   * there, and keep it for `checkMessages` (message ids are per broker, so they are never acknowledged on the new one).
   * Every step is best effort: an unreachable old broker skips it.
   */
  carryOver(): Promise<void>;
  /** Stop polling and dispatching (the client is closing). Pending work ends at its next step. */
  stop(): void;
}

const MAX_BUFFER = 200;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createInbox(opts: {
  broker: Pick<BrokerClient, "post">;
  peer: PeerState;
  log: Logger;
  notifier?: Notifier;
  /** Declared protocols: marks messages with `meta` and remembers who spoke which version. */
  protocols?: ProtocolState;
}): Inbox {
  const { broker, peer, log, notifier, protocols } = opts;
  /** messages received but not yet acknowledged */
  const localBuffer: InboundMessage[] = [];
  /** ids already covered by an unread notice (cleared by checkMessages) */
  const notifiedIds = new Set<number>();
  const handlers: MessageHandler[] = [];
  /** messages carried over from a previous broker (see `carryOver`); already acknowledged there */
  const carried: InboundMessage[] = [];
  /** an unread notice already covers the carried messages (their ids are from another broker, so they are not in `notifiedIds`) */
  let carriedNotified = false;
  let dispatching = false;
  let stopped = false;

  async function lookupSender(fromId: string): Promise<Peer | null> {
    try {
      const peers = await broker.post("/list-peers", { scope: "all", cwd: peer.cwd, git_root: peer.gitRoot });
      return peers.find((p) => p.id === fromId) ?? null;
    } catch {
      return null;
    }
  }

  async function acknowledge(messageId: number) {
    await broker.post("/acknowledge-messages", { id: peer.id as string, message_ids: [messageId] }).catch(() => {});
    const i = localBuffer.findIndex((b) => b.id === messageId);
    if (i !== -1) localBuffer.splice(i, 1);
  }

  /** Mark an entry that carries `meta` (design 6.4) and remember the version its sender spoke. */
  function markProtocol(entry: InboundMessage) {
    if (!protocols || !entry.meta) return;
    recordSeen(protocols, entry.from_id, entry.from_name, entry.meta);
    entry.protocol_line = describeMeta(protocols, entry.meta);
  }

  function pushBuffer(entry: InboundMessage) {
    markProtocol(entry);
    localBuffer.push(entry);
    if (localBuffer.length > MAX_BUFFER) localBuffer.splice(0, localBuffer.length - MAX_BUFFER);
  }

  /** body=pull: one unread notice when the buffer holds ids not yet covered by a notice. */
  async function notifyUnread() {
    if (!notifier) return;
    const all = [...carried, ...localBuffer];
    if (all.length === 0) return;
    if (!localBuffer.some((b) => !notifiedIds.has(b.id)) && (carried.length === 0 || carriedNotified)) return;
    const latest = all[all.length - 1];
    const delivered = await notifier.unread(latest, all.length);
    if (delivered) {
      for (const b of localBuffer) notifiedIds.add(b.id);
      if (carried.length > 0) carriedNotified = true;
    }
  }

  /** Hand every buffered message to the handlers; acknowledge after all succeeded, keep it (retry next tick) otherwise. */
  async function dispatch() {
    if (dispatching) return;
    dispatching = true;
    try {
      for (const entry of localBuffer.slice()) {
        if (stopped || handlers.length === 0) break;
        try {
          for (const h of handlers.slice()) await h(entry);
        } catch (e) {
          log(`Message handler failed for ${entry.id}: ${errorMessage(e)} — will retry`);
          continue;
        }
        if (stopped) break;
        await acknowledge(entry.id);
      }
    } finally {
      dispatching = false;
    }
  }

  async function poll(push: boolean) {
    if (stopped || !peer.id) return;
    const result = await broker.post("/poll-messages", { id: peer.id });
    for (const msg of result.messages) {
      if (stopped) return;
      const sender = await lookupSender(msg.from_id);
      const entry: InboundMessage = {
        ...msg,
        from_name: msg.from_name || sender?.name || "",
        from_hostname: sender?.hostname ?? "",
        from_summary: sender?.summary ?? "",
        from_cwd: sender?.cwd ?? "",
      };
      if (handlers.length > 0) {
        pushBuffer(entry);
        continue;
      }
      if (msg.mode === "ping") {
        if (notifier) await notifier.ping(entry);
        await acknowledge(msg.id);
        continue;
      }
      pushBuffer(entry);
      if (!push || msg.mode !== "push") continue;
      if (notifier && (await notifier.push(entry))) await acknowledge(msg.id);
    }
    if (handlers.length > 0) await dispatch();
    else if (push) await notifyUnread();
  }

  async function checkMessages(): Promise<InboundMessage[]> {
    await poll(false);
    const buffered = await broker.post("/get-buffered-messages", { id: peer.id as string });
    for (const m of buffered.messages) {
      if (m.mode === "ping") {
        await acknowledge(m.id);
        continue;
      }
      if (!localBuffer.some((b) => b.id === m.id)) {
        const entry: InboundMessage = { ...m, from_hostname: "", from_summary: "", from_cwd: "" };
        markProtocol(entry);
        localBuffer.push(entry);
      }
    }
    // pings that entered the buffer through the handler path are dropped here
    for (const b of localBuffer.slice()) {
      if (b.mode === "ping") await acknowledge(b.id);
    }
    if (localBuffer.length === 0 && carried.length === 0) return [];
    const ids = localBuffer.map((m) => m.id);
    if (ids.length > 0) await broker.post("/acknowledge-messages", { id: peer.id as string, message_ids: ids }).catch(() => {});
    const out = [...carried, ...localBuffer];
    carried.length = 0;
    carriedNotified = false;
    localBuffer.length = 0;
    notifiedIds.clear();
    return out;
  }

  async function carryOver() {
    try {
      await poll(false);
    } catch {
      // old broker unreachable: keep what we already hold
    }
    // pings carry no text worth keeping
    const keep = localBuffer.filter((m) => m.mode !== "ping");
    const ids = localBuffer.map((m) => m.id);
    if (ids.length > 0 && peer.id) await broker.post("/acknowledge-messages", { id: peer.id, message_ids: ids }).catch(() => {});
    carried.push(...keep);
    carriedNotified = false;
    localBuffer.length = 0;
    notifiedIds.clear();
    if (carried.length > MAX_BUFFER) carried.splice(0, carried.length - MAX_BUFFER);
  }

  function onMessage(handler: MessageHandler): () => void {
    handlers.push(handler);
    return () => {
      const i = handlers.indexOf(handler);
      if (i !== -1) handlers.splice(i, 1);
    };
  }

  function stop() {
    stopped = true;
  }

  return { poll, checkMessages, onMessage, carryOver, stop };
}
