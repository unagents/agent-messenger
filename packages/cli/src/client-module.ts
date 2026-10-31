/**
 * `status` / `peers` / `send` / `discover` reuse the broker-resolution and HTTP code
 * exported by the cached `@unagents/messenger-client` package (node build), loaded
 * with a dynamic `import()`. Only the parts the CLI uses are typed here; the client
 * package is not a dependency of the CLI (it is fetched at runtime).
 */
import { pathToFileURL } from "node:url";
import type { HealthResponse, Peer, SendMessageResponse } from "@unagents/messenger-protocol";
import { resolveEntry } from "./pkgs.js";

export interface ClientConfigLike {
  token: string;
}

export interface BrokerClientLike {
  getUrl(): string;
  post(path: "/list-peers", body: { scope: "all"; cwd: string; git_root: null }): Promise<Peer[]>;
  post(path: "/send-message", body: { from_id: string; from_name: string; to: string; text: string }): Promise<SendMessageResponse>;
  health(): Promise<HealthResponse | null>;
}

export interface ResolvedBrokerLike {
  url: string;
  source: string;
}

export interface DiscoveredBrokerLike {
  url: string;
  id: string;
  version: string;
}

export interface ClientModule {
  loadConfig(env: Record<string, string | undefined>): ClientConfigLike;
  createBrokerClient(token: string): BrokerClientLike;
  resolveBroker(cfg: ClientConfigLike, broker: BrokerClientLike, log: (msg: string) => void): Promise<ResolvedBrokerLike>;
  discoverBrokers(cfg: ClientConfigLike): Promise<DiscoveredBrokerLike[]>;
}

export async function loadClientModule(pkgDir: string): Promise<ClientModule> {
  const entry = resolveEntry(pkgDir, ".");
  return (await import(pathToFileURL(entry).href)) as ClientModule;
}
