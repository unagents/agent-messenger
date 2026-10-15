import type { Socket } from "node:dgram";
import { listen, type Listener } from "listhen";
import { toNodeListener } from "h3";
import { DISCOVERY_KEY, DISCOVERY_REPLY_VALUE, type DiscoveryReply } from "@agent-hand/messenger-protocol";
import { resolveConfig, type BrokerOptions } from "./config.js";
import { BrokerState } from "./state.js";
import { BrokerHandlers } from "./handlers.js";
import { Mesh, normalizeBrokerUrl, readMeshBrokers } from "./mesh.js";
import { createBrokerApp } from "./http.js";
import { startDiscoveryResponder } from "./discovery.js";
import { log } from "./log.js";
import pkg from "../package.json" with { type: "json" };

export type { BrokerOptions, BrokerConfig } from "./config.js";
export { configFromEnv, MESH_ENV, resolveConfig, DEFAULT_STATE_FILE, STATE_DIR } from "./config.js";
export type { BrokerStateFile } from "./state.js";

/** Package version, reported by `/health` and discovery replies (inlined at build time). */
export const VERSION: string = pkg.version;

/** Interval of the stale-peer sweep (`legacy/src/broker.js`: `setInterval(cleanStalePeers, 30_000)`). */
const CLEAN_INTERVAL_MS = 30_000;

export interface BrokerHandle {
  /** Stop HTTP + UDP, flush a pending state save. Idempotent. */
  close(): Promise<void>;
  /** Port the HTTP server listens on (actual port when `port: 0` was given). */
  port: number;
  /** Broker id (`AGENT_MESSENGER_BROKER_ID`, default hostname). */
  id: string;
}

/**
 * Start the broker daemon: load state, sweep stale peers, listen on HTTP
 * (h3 + listhen) and answer UDP discovery probes.
 *
 * Unlike the JavaScript `startBroker()`, this does not install SIGINT /
 * SIGTERM handlers — callers own the lifecycle through `close()`
 * (`src/main.ts` does that for the standalone entry).
 */
export async function startBroker(options: BrokerOptions = {}): Promise<BrokerHandle> {
  const cfg = resolveConfig(options);

  const state = new BrokerState(cfg.stateFile);
  state.load();
  let mesh: Mesh | null = null;
  const handlers = new BrokerHandlers(state, {
    id: cfg.id,
    meshPeerTtlMs: cfg.meshPeerTtlMs,
    onRemoteMessage: () => mesh?.kick(),
  });
  handlers.cleanStalePeers();
  const cleaner = setInterval(() => handlers.cleanStalePeers(), CLEAN_INTERVAL_MS);
  cleaner.unref();

  let port = cfg.port;
  const app = createBrokerApp({
    handlers,
    version: VERSION,
    id: cfg.id,
    port: () => port,
    token: cfg.token,
    mesh: cfg.mesh,
  });

  let listener: Listener;
  try {
    listener = await listen(toNodeListener(app), {
      port: cfg.port,
      hostname: cfg.bind,
      showURL: false,
      autoClose: false,
      // `isProd` makes listhen fail on a busy port instead of silently picking another one.
      // For port 0 we need listhen's random-port path, which `isProd` would disable.
      isProd: cfg.port !== 0,
    });
  } catch (e) {
    clearInterval(cleaner);
    throw e;
  }
  port = listener.address.port;

  const reply = (): DiscoveryReply => ({ [DISCOVERY_KEY]: DISCOVERY_REPLY_VALUE, id: cfg.id, port, version: VERSION });
  let disco: Socket | null = null;
  if (cfg.discovery) {
    disco = await startDiscoveryResponder({ port: cfg.discoveryPort, addr: cfg.discoveryAddr, reply });
  }

  if (cfg.mesh) {
    const fixed = cfg.meshBrokers.map(normalizeBrokerUrl);
    mesh = new Mesh({
      id: cfg.id,
      token: cfg.token,
      handlers,
      urls: () => (fixed.length ? fixed : readMeshBrokers(cfg.configFile)),
      intervalMs: cfg.meshIntervalMs,
    });
    mesh.start();
  }

  log.info(`v${VERSION} id=${cfg.id} listening on ${cfg.bind}:${port} (state: ${cfg.stateFile})`);
  log.info(cfg.token ? "token auth enabled" : "WARNING: no AGENT_MESSENGER_TOKEN set — broker is open");

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(cleaner);
    mesh?.stop();
    if (disco) {
      await new Promise<void>((resolve) => disco!.close(() => resolve()));
    }
    await listener.close();
    if (state.savePending) state.saveNow();
  };

  return { close, port, id: cfg.id };
}
