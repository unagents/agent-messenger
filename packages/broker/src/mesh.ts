import { request } from "node:http";
import {
  DEFAULT_HTTP_PORT,
  MESH_SYNC_ROUTE,
  type MeshSyncRequest,
  type MeshSyncResponse,
} from "@unagents/messenger-protocol";
import type { BrokerHandlers } from "./handlers.js";
import { log } from "./log.js";

export interface MeshOptions {
  /** This broker's id (`from` of every sync). */
  id: string;
  token: string;
  handlers: BrokerHandlers;
  /** Other permanent brokers, re-evaluated every round (the discovery-fed `MeshPeerTable`, or a fixed test list). */
  urls: () => string[];
  intervalMs: number;
  /** Per-request timeout; one dead broker must not stall a round. */
  timeoutMs?: number;
}

type LinkState = "up" | "down" | "unsupported" | "self";

/**
 * Permanent-broker mesh: every `intervalMs` (and right after a message for a
 * replicated peer was queued) POST our live peers and the messages we hold for
 * the other broker's peers to each listed broker, and take its peers back.
 * A broker that is down is just skipped; the next round after it returns
 * resyncs everything (peers are replaced wholesale, queued messages are still
 * in our store because they are only dropped once the other side accepted them).
 */
export class Mesh {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private again = false;
  private stopped = false;
  private readonly links = new Map<string, LinkState>();
  /** url -> id of the broker that answered there */
  private readonly origins = new Map<string, string>();

  constructor(private readonly opts: MeshOptions) {}

  start(): void {
    log.info(`mesh on (id ${this.opts.id}, every ${this.opts.intervalMs}ms)`);
    this.timer = setInterval(() => void this.syncOnce(), this.opts.intervalMs);
    this.timer.unref();
    void this.syncOnce();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** True while the last sync with `url` succeeded. */
  linkUp(url: string): boolean {
    return this.links.get(url) === "up";
  }

  /** Forget everything learned about `url` (its broker left or moved). */
  forget(url: string): void {
    this.links.delete(url);
    this.origins.delete(url);
  }

  /** Sync soon (coalesced). */
  kick(): void {
    if (this.running) this.again = true;
    else setImmediate(() => void this.syncOnce());
  }

  /** One round against every listed broker. Never throws. */
  async syncOnce(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await Promise.all(this.opts.urls().map((url) => this.syncWith(url)));
      } while (this.again && !this.stopped);
    } finally {
      this.running = false;
    }
  }

  private setLink(url: string, state: LinkState, detail = ""): void {
    const prev = this.links.get(url);
    this.links.set(url, state);
    if (prev === state) return;
    if (state === "up") log.info(`mesh: ${url} ${prev === "down" ? "is back, synced" : "joined"}`);
    else if (state === "down") log.warn(`mesh: ${url} unreachable${detail ? ` (${detail})` : ""}; will keep retrying`);
    else if (state === "unsupported") log.warn(`mesh: ${url} does not take part in the mesh (${detail})`);
    else if (state === "self") log.info(`mesh: ${url} is this broker, skipped`);
  }

  private async syncWith(url: string): Promise<void> {
    if (this.links.get(url) === "self" || this.stopped) return;
    const { handlers, id } = this.opts;
    // The other broker's id is only known after a first answer; messages are
    // matched by the origin we learned from earlier answers.
    const origin = this.origins.get(url);
    const protocols = handlers.meshLocalProtocols();
    const req: MeshSyncRequest = {
      from: id,
      peers: handlers.meshLocalPeers(),
      messages: origin ? handlers.meshOutbox(origin) : [],
      ...(protocols.length ? { protocols } : {}),
    };
    let res: MeshSyncResponse;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
      const r = await postJson(`${url}${MESH_SYNC_ROUTE}`, headers, JSON.stringify(req), this.opts.timeoutMs ?? 3000);
      if (r.status === 404) return this.setLink(url, "unsupported", "HTTP 404");
      if (r.status < 200 || r.status >= 300) return this.setLink(url, "down", `HTTP ${r.status}`);
      res = JSON.parse(r.body) as MeshSyncResponse;
    } catch (e) {
      return this.setLink(url, "down", (e as Error).message);
    }
    if (!res.id) return this.setLink(url, "unsupported", "no broker id in answer");
    if (res.id === id) return this.setLink(url, "self");
    const learned = this.origins.get(url) !== res.id;
    this.origins.set(url, res.id);
    handlers.meshApplyPeers(res.id, res.peers ?? []);
    handlers.meshApplyProtocols(res.id, res.protocols ?? []);
    handlers.meshDrop(res.accepted ?? []);
    // first answer from this broker: messages queued for its peers can go now
    if (learned && handlers.meshOutbox(res.id).length) this.again = true;
    this.setLink(url, "up");
  }
}

export function normalizeBrokerUrl(s: string): string {
  s = s.trim();
  if (!/^https?:\/\//.test(s)) s = `http://${s}`;
  const u = new URL(s);
  if (!u.port) u.port = String(DEFAULT_HTTP_PORT);
  return u.origin;
}

/**
 * One POST on a fresh connection (`agent: false` = `Connection: close`). Not `fetch`:
 * its pooled keep-alive sockets go stale when the other broker restarts, which
 * would cost a whole sync round right after a broker comes back.
 */
function postJson(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", agent: false, headers: { ...headers, "Content-Length": Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(body);
  });
}
