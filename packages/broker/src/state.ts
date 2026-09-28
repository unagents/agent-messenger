import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Message, Peer } from "@agent-hand/messenger-protocol";
import { log } from "./log.js";

/**
 * On-disk shape of `~/.agent-messenger/broker.json` (written by core 0.4.0
 * `src/broker.js`). Not part of the protocol package — broker-private.
 */
export interface BrokerStateFile {
  peers: Peer[];
  messages: Message[];
  nextMsgId: number;
}

/**
 * In-memory peer / message store with a debounced JSON snapshot.
 *
 * Persistence is done with `node:fs` (not unstorage) so the file is written
 * exactly like the JavaScript broker: `JSON.stringify(state, null, 1)` to
 * `<file>.tmp`, then an atomic rename over `<file>`.
 */
export class BrokerState {
  readonly peers = new Map<string, Peer>();
  messages: Message[] = [];
  nextMsgId = 1;

  private saveTimer: NodeJS.Timeout | null = null;

  constructor(readonly file: string) {}

  /** Read the snapshot if present. A missing or unreadable file starts empty. */
  load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<BrokerStateFile>;
      for (const p of raw.peers ?? []) this.peers.set(p.id, p);
      this.messages = raw.messages ?? [];
      this.nextMsgId = raw.nextMsgId ?? 1;
      log.info(`Loaded state from ${this.file} (${this.peers.size} peer(s), ${this.messages.length} message(s))`);
    } catch {
      // no state yet
    }
  }

  /** Snapshot to disk after 200 ms; repeated calls inside the window coalesce. */
  scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 200);
  }

  /** Write the snapshot immediately (also cancels a pending debounced save). */
  saveNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      const snapshot: BrokerStateFile = {
        peers: [...this.peers.values()],
        messages: this.messages,
        nextMsgId: this.nextMsgId,
      };
      writeFileSync(tmp, JSON.stringify(snapshot, null, 1));
      renameSync(tmp, this.file);
    } catch (e) {
      log.warn(`Save failed: ${(e as Error).message}`);
    }
  }

  /** True when a debounced save is still pending. */
  get savePending(): boolean {
    return this.saveTimer !== null;
  }
}
