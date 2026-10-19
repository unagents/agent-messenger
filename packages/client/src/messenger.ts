import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import type { Peer, PeerScope } from "@agent-hand/messenger-protocol";
import { createBrokerClient } from "./broker.js";
import type { BrokerClient } from "./broker.js";
import { FALLBACK_ENV, RESOLVE_RETRY_MS } from "./constants.js";
import { loadConfig } from "./config.js";
import type { ClientConfig, Env } from "./config.js";
import { createInbox } from "./inbox.js";
import type { InboundMessage, MessageHandler, Notifier } from "./inbox.js";
import { createPeerState, detectGitRoot, detectTty, registerPeer } from "./peer.js";
import type { PeerState } from "./peer.js";
import { resolveBroker } from "./resolve.js";
import type { Logger, ResolvedBroker } from "./resolve.js";
import { createToolRegistry } from "./tools/registry.js";
import type { ToolRegistry } from "./tools/types.js";
import { VERSION } from "./version.js";

/**
 * Library API: connect one peer to the broker (resolution, heartbeat, re-resolution) and
 * talk to other peers. No stdio, no process.exit, no session socket (those belong to the
 * stdio host in `client.ts` / `hosts/stdio.ts`). Creating a client does no I/O.
 */

export interface MessengerClientOptions {
  /** Environment to read configuration from (default `process.env`). */
  env?: Env;
  /** Log sink (default: stderr, prefixed `[agent-messenger] `). */
  log?: Logger;
  /** Already loaded configuration (used by startClient). Default `loadConfig(env)`. */
  config?: ClientConfig;
  /** Initial peer name (default: config name, `AGENT_MESSENGER_NAME`). */
  name?: string;
  /** Initial peer summary (default empty). */
  summary?: string;
  /** Broker URLs to try instead of the config file's `brokers` (second step of the resolution order). */
  brokers?: string[];
  /** Spawn a local broker when none is running (default false; startClient passes true). */
  autoStartBroker?: boolean;
  /** Stdio host only. Library users do not pass this. */
  notifier?: Notifier;
}

export interface SendResult {
  to_id: string;
  to_name: string;
  message_id: number;
}

export interface MessengerClient {
  readonly peer: PeerState;
  /** For tool hosts (MCP SDK, toolkit). Context = { broker, peer, inbox }. */
  readonly registry: ToolRegistry;
  connect(): Promise<void>;
  close(): Promise<void>;
  send(to: string, text: string, delivery?: "pull" | "push"): Promise<SendResult>;
  ping(to: string, subject?: string): Promise<SendResult>;
  listPeers(scope?: PeerScope): Promise<Peer[]>;
  setName(name: string): Promise<void>;
  setSummary(summary: string): Promise<void>;
  checkMessages(): Promise<InboundMessage[]>;
  onMessage(handler: MessageHandler): () => void;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function ensureBroker(
  cfg: ClientConfig,
  env: Env,
  broker: BrokerClient,
  resolved: ResolvedBroker,
  log: Logger,
  autoStart: boolean
) {
  if (await broker.health()) {
    log("Broker already running");
    return;
  }
  if (!resolved.isLocal) {
    throw new Error(
      `Remote broker at ${broker.getUrl()} is not reachable. Start it on the broker host: agent-messenger broker`
    );
  }
  if (!autoStart) {
    throw new Error(`Local broker at ${broker.getUrl()} is not reachable (autoStartBroker is off)`);
  }
  log("Starting local broker daemon...");
  mkdirSync(cfg.stateDir, { recursive: true });
  const out = openSync(`${cfg.stateDir}/broker.log`, "a");
  const argv = cfg.brokerCmd.trim().split(/\s+/);
  const cmd = argv[0];
  const args = argv.slice(1);
  const proc = spawn(cmd, args, {
    stdio: ["ignore", out, out],
    detached: true,
    // FALLBACK_ENV: this broker is a stop-gap; it hands over to a real broker once one shows up and exits
    env: { ...env, AGENT_MESSENGER_PORT: new URL(broker.getUrl()).port, [FALLBACK_ENV]: "1" },
  });
  proc.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise<void>((r) => setTimeout(r, 200));
    if (await broker.health()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

export function createMessengerClient(options: MessengerClientOptions = {}): MessengerClient {
  const env: Env = options.env ?? (process.env as Env);
  const log: Logger = options.log ?? ((msg: string) => console.error(`[agent-messenger] ${msg}`));
  const cfg: ClientConfig = options.config ?? loadConfig(env);
  const autoStart = options.autoStartBroker === true;
  const notifier = options.notifier;
  const broker = createBrokerClient(cfg.token);
  const peer = createPeerState({ name: options.name ?? cfg.name, summary: options.summary });
  const inbox = createInbox({ broker, peer, log, notifier });
  const registry = createToolRegistry({ broker, peer, inbox });

  let connectPromise: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  let closed = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let recoverTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // --- Link health + re-resolve ---
  //
  // A failed poll / heartbeat starts a grace period in which the previous URL keeps being retried (the
  // poll loop does that every second), so a flapping broker does not push the session into a local
  // fallback. When the grace is over the full resolution (env → config → discovery → local) runs again.
  // A heartbeat the broker rejects (it forgot us) re-runs the resolution at once.
  let failSince: number | null = null;
  let lastResolveAttempt = 0;
  let resolving = false;

  function noteFailure() {
    if (failSince !== null) return;
    failSince = Date.now();
    log(`Broker ${broker.getUrl()} unreachable — retrying it for ${cfg.graceMs} ms before re-resolving`);
  }

  function noteOk() {
    if (failSince === null) return;
    failSince = null;
    log(`Broker ${broker.getUrl()} reachable again`);
  }

  async function reresolve(reason: string) {
    if (resolving) return;
    resolving = true;
    lastResolveAttempt = Date.now();
    try {
      const prev = broker.getUrl();
      log(`Re-resolving broker (${reason})`);
      const r = await resolveBroker(cfg, broker, log, options.brokers);
      await ensureBroker(cfg, env, broker, r, log, autoStart);
      await registerPeer(broker, peer, log);
      log(`broker=${broker.getUrl()} (${r.isLocal ? "local" : "remote"}, via ${r.source})${prev === broker.getUrl() ? "" : ` — was ${prev}`}`);
      failSince = null;
    } catch (e) {
      log(`Re-resolve failed: ${errorMessage(e)}`);
      noteFailure(); // keeps the recover loop retrying
    } finally {
      resolving = false;
    }
  }

  async function pollLoop() {
    if (resolving) return;
    try {
      await inbox.poll(true);
      noteOk();
    } catch (e) {
      log(`Poll error: ${errorMessage(e)}`);
      noteFailure();
    }
  }

  async function recoverLoop() {
    if (failSince === null || resolving) return;
    const now = Date.now();
    if (now - failSince < cfg.graceMs || now - lastResolveAttempt < RESOLVE_RETRY_MS) return;
    await reresolve("connection failure");
  }

  async function heartbeat() {
    if (resolving) return;
    try {
      const r = await broker.post("/heartbeat", { id: peer.id as string });
      if (r && r.ok === false) {
        log(`Heartbeat rejected (${r.error}) — re-registering`);
        await reresolve("heartbeat rejected");
      } else {
        noteOk();
      }
    } catch {
      // broker down; the grace period / re-resolve picks it up
      noteFailure();
    }
  }

  async function doConnect(): Promise<void> {
    const resolved = await resolveBroker(cfg, broker, log, options.brokers);
    await ensureBroker(cfg, env, broker, resolved, log, autoStart);

    peer.gitRoot = detectGitRoot(peer.cwd);
    peer.tty = detectTty();
    log(`v${VERSION} host=${peer.hostname} broker=${broker.getUrl()} (${resolved.isLocal ? "local" : "remote"}, via ${resolved.source})`);
    log(`cwd=${peer.cwd} git_root=${peer.gitRoot ?? "(none)"} tty=${peer.tty ?? "(unknown)"} name=${peer.name || "(unset)"}`);
    if (notifier) log(`delivery=${cfg.delivery} session_socket=${cfg.sessionSocket || "(none)"}`);

    await registerPeer(broker, peer, log);
    if (closed) return; // close() won the race: it unregisters, no timers

    pollTimer = setInterval(pollLoop, cfg.pollIntervalMs);
    // Heartbeat; if the broker no longer knows us (restart, stale cleanup), re-register
    // so the session keeps its name and stays reachable without a restart.
    recoverTimer = setInterval(recoverLoop, cfg.pollIntervalMs);
    heartbeatTimer = setInterval(heartbeat, cfg.heartbeatIntervalMs);
  }

  function connect(): Promise<void> {
    if (connectPromise) return connectPromise;
    const p = doConnect();
    connectPromise = p;
    p.catch(() => {
      if (connectPromise === p) connectPromise = null;
    });
    return p;
  }

  async function doClose(cp: Promise<void>): Promise<void> {
    closed = true;
    try {
      await cp;
    } catch {
      // connect failed; nothing was started
    }
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (recoverTimer) clearInterval(recoverTimer);
    pollTimer = null;
    heartbeatTimer = null;
    recoverTimer = null;
    if (!peer.id) return;
    try {
      await broker.post("/unregister", { id: peer.id });
      log("Unregistered from broker");
    } catch {
      // best effort
    }
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    if (!connectPromise) return Promise.resolve();
    closePromise = doClose(connectPromise);
    return closePromise;
  }

  function requireRegistered(): string {
    if (!peer.id) throw new Error("Not registered with broker yet");
    return peer.id;
  }

  async function sendMode(to: string, text: string, mode: "pull" | "push" | "ping"): Promise<SendResult> {
    const id = requireRegistered();
    const r = await broker.post("/send-message", { from_id: id, from_name: peer.name, to, text, mode });
    if (!r.ok) throw new Error(`Failed to send: ${r.error}`);
    return { to_id: r.to_id, to_name: r.to_name ?? "", message_id: r.message_id };
  }

  return {
    peer,
    registry,
    connect,
    close,
    async send(to, text, delivery) {
      requireRegistered();
      const d = delivery === undefined ? "pull" : String(delivery);
      if (d !== "pull" && d !== "push") throw new Error(`Invalid delivery: ${d} (use "pull" or "push")`);
      return sendMode(to, text, d);
    },
    ping(to, subject) {
      return sendMode(to, subject ?? "", "ping");
    },
    async listPeers(scope = "all") {
      requireRegistered();
      return broker.post("/list-peers", {
        scope,
        cwd: peer.cwd,
        git_root: peer.gitRoot,
        hostname: peer.hostname,
        exclude_id: peer.id ?? undefined,
      });
    },
    async setName(name) {
      const id = requireRegistered();
      const r = await broker.post("/set-name", { id, name });
      if (!r.ok) throw new Error(`Failed: ${r.error}`);
      peer.name = name;
    },
    async setSummary(summary) {
      const id = requireRegistered();
      const r = await broker.post("/set-summary", { id, summary });
      if (!r.ok) throw new Error(`Failed: ${r.error}`);
      peer.summary = summary;
    },
    checkMessages() {
      requireRegistered();
      return inbox.checkMessages();
    },
    onMessage: inbox.onMessage,
  };
}
