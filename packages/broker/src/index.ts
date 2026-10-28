import type { Socket } from "node:dgram";
import { listen, type Listener } from "listhen";
import { toNodeListener } from "h3";
import { DISCOVERY_KEY, DISCOVERY_REPLY_VALUE, meshMac, type DiscoveryReply } from "@unagents/messenger-protocol";
import { resolveConfig, type BrokerOptions } from "./config.js";
import { BrokerState } from "./state.js";
import { BrokerHandlers } from "./handlers.js";
import { Mesh, normalizeBrokerUrl } from "./mesh.js";
import { MeshPeerTable, meshExpireMs } from "./mesh-peers.js";
import { createBrokerApp } from "./http.js";
import { buildAnnounce, localAddresses, newNonce, probeBrokers, sendAnnounce, sendTargets, startDiscoveryResponder } from "./discovery.js";
import { relayUndelivered } from "./relay.js";
import { log } from "./log.js";
import pkg from "../package.json" with { type: "json" };

export type { BrokerOptions, BrokerConfig } from "./config.js";
export { configFromEnv, MESH_ENV, resolveConfig, DEFAULT_STATE_FILE, STATE_DIR, FALLBACK_ENV, FALLBACK_INTERVAL_ENV } from "./config.js";
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
  const { onSupersede, ...rest } = options;
  const cfg = resolveConfig(rest);

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
    fallback: cfg.fallback,
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

  const reply = (nonce?: string): DiscoveryReply => ({
    [DISCOVERY_KEY]: DISCOVERY_REPLY_VALUE,
    id: cfg.id,
    port,
    version: VERSION,
    ...(cfg.fallback ? { fallback: true as const } : {}),
    ...(cfg.mesh ? { mesh: true as const, ...(nonce ? { mac: meshMac(cfg.token, nonce, cfg.id, port) } : {}) } : {}),
  });

  // Mesh members are found by discovery (token-checked). `meshBrokers` is a fixed, test-only list that replaces it.
  const fixed = cfg.meshBrokers.map(normalizeBrokerUrl);
  const peerTable = cfg.mesh
    ? new MeshPeerTable({
        selfId: cfg.id,
        token: cfg.token,
        expireMs: meshExpireMs(cfg.meshAnnounceMs),
        onDrop: (url) => mesh?.forget(url),
        onJoin: () => mesh?.kick(),
      })
    : null;

  let disco: Socket | null = null;
  if (cfg.discovery) {
    disco = await startDiscoveryResponder({
      port: cfg.discoveryPort,
      addr: cfg.discoveryAddr,
      reply,
      ...(peerTable ? { onAnnounce: (m, rinfo) => void peerTable.handleAnnounce(m, rinfo.address) } : {}),
    });
  }

  let announceTimer: NodeJS.Timeout | null = null;
  if (cfg.mesh) {
    mesh = new Mesh({
      id: cfg.id,
      token: cfg.token,
      handlers,
      urls: () => (fixed.length ? fixed : peerTable!.urls()),
      intervalMs: cfg.meshIntervalMs,
    });
    mesh.start();
    if (!cfg.discovery && !fixed.length) {
      log.warn("mesh: AGENT_MESSENGER_MESH=on but AGENT_MESSENGER_DISCOVERY=off; no other mesh broker can be found");
    }
    if (cfg.discovery && disco && !fixed.length) {
      const sock = disco;
      const targets = sendTargets({ port: cfg.discoveryPort, addr: cfg.discoveryAddr, targets: cfg.discoveryTargets });
      const announceAndSweep = () => {
        sendAnnounce(sock, buildAnnounce({ token: cfg.token, id: cfg.id, port, version: VERSION, ts: Date.now() }), targets);
        peerTable!.sweep((url) => mesh?.linkUp(url) ?? false);
      };
      announceAndSweep();
      announceTimer = setInterval(announceAndSweep, cfg.meshAnnounceMs);
      announceTimer.unref();
      // one probe at start finds brokers that announced before we came up
      const nonce = newNonce();
      void probeBrokers({ port: cfg.discoveryPort, addr: cfg.discoveryAddr, targets: cfg.discoveryTargets, nonce, timeoutMs: 1000 }).then((found) => {
        for (const b of found) {
          peerTable!.handleReply({ [DISCOVERY_KEY]: DISCOVERY_REPLY_VALUE, id: b.id, port: b.port, version: b.version, mesh: b.mesh, mac: b.mac }, b.host, nonce);
        }
      });
    }
  }

  log.info(`v${VERSION} id=${cfg.id} listening on ${cfg.bind}:${port} (state: ${cfg.stateFile})`);
  if (cfg.fallback) log.info(`FALLBACK mode: looking for another broker every ${cfg.fallbackIntervalMs} ms (discovery ${cfg.discovery ? "on" : "off"})`);
  log.info(cfg.token ? "token auth enabled" : "WARNING: no AGENT_MESSENGER_TOKEN set — broker is open");

  let closed = false;
  let fallbackTimer: NodeJS.Timeout | null = null;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(cleaner);
    if (fallbackTimer) clearInterval(fallbackTimer);
    if (announceTimer) clearInterval(announceTimer);
    mesh?.stop();
    if (disco) {
      await new Promise<void>((resolve) => disco!.close(() => resolve()));
    }
    await listener.close();
    if (state.savePending) state.saveNow();
  };

  // A fallback broker exists only until a real broker shows up: relay what it holds, then leave.
  // Clients notice the exit and re-resolve (client side), so nothing has to push them out.
  if (cfg.fallback && cfg.discovery) {
    const mine = localAddresses();
    let busy = false;
    const lookForBroker = async (): Promise<void> => {
      if (busy || closed) return;
      busy = true;
      try {
        const found = await probeBrokers({ port: cfg.discoveryPort, addr: cfg.discoveryAddr, targets: cfg.discoveryTargets, timeoutMs: 1000 });
        // not ourselves (our own responder answers too) and not another fallback (two fallbacks must not relay into each other)
        const other = found.find((b) => !b.fallback && !(b.port === port && mine.has(b.host)));
        if (!other || closed) return;
        log.info(`fallback: found broker ${other.id} at ${other.url} — relaying messages and exiting`);
        await relayUndelivered(state, other.url, cfg.token);
        await close();
        log.info("fallback: done");
        onSupersede?.(other.url);
      } catch (e) {
        log.warn(`fallback: ${(e as Error).message} — will retry`);
      } finally {
        busy = false;
      }
    };
    fallbackTimer = setInterval(() => void lookForBroker(), cfg.fallbackIntervalMs);
    fallbackTimer.unref();
  }

  return { close, port, id: cfg.id };
}
