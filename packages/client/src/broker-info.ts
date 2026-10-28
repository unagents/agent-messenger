import type { BrokerKind } from "./resolve.js";

/** What `get_broker` / `getBroker()` report (and `set_broker` returns after a switch). */
export interface BrokerInfo {
  /** The broker this client talks to now (`""` before the first connect). */
  url: string;
  /** From the broker's `/health`; `""` when it did not answer. */
  id: string;
  version: string;
  mesh: boolean;
  /** Where `url` came from. */
  source: BrokerKind;
  /** A `set_broker(url)` pin is active for this session. */
  pinned: boolean;
  /** The URL saved in `client.json`, if any. */
  saved: string | null;
  /** Brokers that answered a discovery probe just now. */
  discovered: { id: string; url: string; version: string; mesh: boolean; fallback: boolean }[];
}

/** Connection control of a client, as the tools see it (`ToolContext.connection`). */
export interface BrokerConnection {
  get(): Promise<BrokerInfo>;
  set(url?: string, persist?: boolean): Promise<BrokerInfo>;
}

/**
 * ```
 * broker: http://192.168.1.204:7901 (id 204, v0.11.0, mesh)
 * source: discovery
 * pinned: no   saved: http://100.64.0.3:7901
 * discovered:
 *   - 204  http://192.168.1.204:7901  v0.11.0  mesh
 *   - mac  http://192.168.1.10:7901   v0.10.0  fallback
 * ```
 */
export function formatBrokerInfo(i: BrokerInfo): string {
  const detail = i.id || i.version ? ` (${[i.id ? `id ${i.id}` : "", i.version ? `v${i.version}` : "", i.mesh ? "mesh" : ""].filter(Boolean).join(", ")})` : " (not answering)";
  const lines = [`broker: ${i.url || "(none yet)"}${i.url ? detail : ""}`, `source: ${i.source}`, `pinned: ${i.pinned ? "yes" : "no"}   saved: ${i.saved ?? "-"}`];
  if (i.discovered.length === 0) {
    lines.push("discovered: (none)");
  } else {
    lines.push("discovered:");
    const w = (f: (d: BrokerInfo["discovered"][number]) => string) => Math.max(...i.discovered.map((d) => f(d).length));
    const wid = w((d) => d.id);
    const wurl = w((d) => d.url);
    const wver = w((d) => (d.version ? `v${d.version}` : "-"));
    for (const d of i.discovered) {
      const tag = [d.mesh ? "mesh" : "", d.fallback ? "fallback" : ""].filter(Boolean).join(" ");
      lines.push(`  - ${d.id.padEnd(wid)}  ${d.url.padEnd(wurl)}  ${(d.version ? `v${d.version}` : "-").padEnd(wver)}${tag ? `  ${tag}` : ""}`.trimEnd());
    }
  }
  return lines.join("\n");
}
