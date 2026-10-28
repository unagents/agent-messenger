import {
  DISCOVERY_KEY,
  DISCOVERY_ANNOUNCE_VALUE,
  DISCOVERY_REPLY_VALUE,
  MESH_ANNOUNCE_MAX_SKEW_MS,
  meshMac,
  meshMacEqual,
} from "@unagents/messenger-protocol";
import { log } from "./log.js";

/** One mesh broker found by discovery. */
export interface MeshPeerEntry {
  id: string;
  url: string;
  version: string;
  /** ms epoch of the last valid announce / reply */
  lastSeen: number;
}

export interface MeshPeerTableOptions {
  /** This broker's id; never registered. */
  selfId: string;
  token: string;
  /** An entry nobody vouched for within this time is a removal candidate (announce interval x 3 + slack). */
  expireMs: number;
  /** Called when an entry's URL is dropped (replaced by a newer URL of the same id, or expired). */
  onDrop?: (url: string) => void;
  /** Called when a broker is newly registered. */
  onJoin?: (entry: MeshPeerEntry) => void;
  now?: () => number;
}

/** Expiry derived from the announce interval: 3 periods plus 5 s (10 s -> 35 s). */
export function meshExpireMs(announceMs: number): number {
  return announceMs * 3 + 5000;
}

/**
 * Mesh broker table filled by discovery. A packet counts only when it says `mesh: true` and carries the
 * right `mac` (token proof, see `meshMac`); everything else is ignored, a wrong MAC is logged once per source.
 */
export class MeshPeerTable {
  private readonly byId = new Map<string, MeshPeerEntry>();
  private readonly mismatchLogged = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly opts: MeshPeerTableOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Current sync targets. */
  urls(): string[] {
    return [...this.byId.values()].map((e) => e.url);
  }

  entries(): MeshPeerEntry[] {
    return [...this.byId.values()];
  }

  /** `announce` packet from `address` (UDP source). Returns true when accepted. */
  handleAnnounce(m: Record<string, unknown>, address: string): boolean {
    if (m[DISCOVERY_KEY] !== DISCOVERY_ANNOUNCE_VALUE || m.mesh !== true) return false;
    const ts = m.ts;
    if (typeof ts !== "number" || !Number.isFinite(ts) || Math.abs(this.now() - ts) > MESH_ANNOUNCE_MAX_SKEW_MS) return false;
    return this.accept(m, address, String(ts));
  }

  /** `broker` reply to our probe that carried `nonce`. Returns true when accepted. */
  handleReply(m: Record<string, unknown>, address: string, nonce: string): boolean {
    if (m[DISCOVERY_KEY] !== DISCOVERY_REPLY_VALUE || m.mesh !== true) return false;
    return this.accept(m, address, nonce);
  }

  private accept(m: Record<string, unknown>, address: string, nonce: string): boolean {
    const { id, port, version, mac } = m;
    if (typeof id !== "string" || !id || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return false;
    if (typeof mac !== "string") return false;
    if (!meshMacEqual(meshMac(this.opts.token, nonce, id, port), mac)) {
      const key = `${id}@${address}`;
      if (!this.mismatchLogged.has(key)) {
        this.mismatchLogged.add(key);
        log.warn(`mesh: ignoring ${id}@${address} (token mismatch)`);
      }
      return false;
    }
    if (id === this.opts.selfId) return false;
    const url = `http://${address}:${port}`;
    const prev = this.byId.get(id);
    const entry: MeshPeerEntry = { id, url, version: typeof version === "string" ? version : "", lastSeen: this.now() };
    this.byId.set(id, entry);
    if (!prev) {
      log.info(`mesh: found ${id} at ${url}`);
      this.opts.onJoin?.(entry);
    } else if (prev.url !== url) {
      log.info(`mesh: ${id} moved ${prev.url} -> ${url}`);
      this.opts.onDrop?.(prev.url);
      this.opts.onJoin?.(entry);
    }
    return true;
  }

  /**
   * Drop entries not vouched for within `expireMs` whose last sync did not succeed (`linkUp`): a link that
   * still syncs stays even when UDP is lost. Returns the removed entries.
   */
  sweep(linkUp: (url: string) => boolean): MeshPeerEntry[] {
    const gone: MeshPeerEntry[] = [];
    const t = this.now();
    for (const e of this.byId.values()) {
      if (t - e.lastSeen <= this.opts.expireMs || linkUp(e.url)) continue;
      this.byId.delete(e.id);
      gone.push(e);
      log.info(`mesh: ${e.url} left`);
      this.opts.onDrop?.(e.url);
    }
    return gone;
  }
}
