import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import type { MessageMeta, PeerScope } from "@unagents/messenger-protocol";
import { createBrokerClient } from "./broker.js";
import type { BrokerInfo } from "./broker-info.js";
import type { BrokerClient } from "./broker.js";
import { DEFAULT_HTTP_PORT, FALLBACK_ENV, RESOLVE_RETRY_MS } from "./constants.js";
import { isLocalHost, loadConfig } from "./config.js";
import type { ClientConfig, Env } from "./config.js";
import { createInbox } from "./inbox.js";
import type { InboundMessage, MessageHandler, Notifier } from "./inbox.js";
import { createPeerState, detectGitRoot, detectTty, registerPeer } from "./peer.js";
import type { PeerState } from "./peer.js";
import {
  createProtocolState,
  getProtocol as getProtocolDef,
  listPeers as listPeersFiltered,
  parseMeta,
  planOutgoing,
  resendDefinitions,
  setProtocol as setProtocolDef,
  unsetProtocol as unsetProtocolDef,
  wireDecls,
} from "./protocols.js";
import type { PeerProtocolFilter, ProtocolDetail, ProtocolInfo, ProtocolPeer } from "./protocols.js";
import { brokerError } from "./protocol-error.js";
import { discoverBrokers, normalizeBrokerUrl, resolveBroker } from "./resolve.js";
import { readSavedBroker, writeSavedBroker } from "./saved-broker.js";
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
  /** Test seam: replaces the HTTP broker client (unit tests run the client against in-memory brokers). Not part of the public API. */
  brokerClient?: BrokerClient;
}

export interface SendResult {
  to_id: string;
  to_name: string;
  message_id: number;
  /** Set when the text was prefixed with a protocol version warning (design 6.4); the same line the tool reports. */
  warning?: string;
}

export interface MessengerClient {
  readonly peer: PeerState;
  /** For tool hosts (MCP SDK, toolkit). Context = { broker, peer, inbox }. */
  readonly registry: ToolRegistry;
  connect(): Promise<void>;
  close(): Promise<void>;
  /** `meta` tags the message with a protocol (both fields required, else INVALID_META). */
  send(to: string, text: string, delivery?: "pull" | "push", meta?: MessageMeta): Promise<SendResult>;
  ping(to: string, subject?: string): Promise<SendResult>;
  listPeers(scope?: PeerScope, filter?: PeerProtocolFilter): Promise<ProtocolPeer[]>;
  /** Serve the protocol of a repo (GitHub / Gitea / local path): read, check and register its definition. */
  setProtocol(repo: string, version?: string): Promise<ProtocolInfo>;
  /** Stop serving `name`, or every protocol when omitted. */
  unsetProtocol(name?: string): Promise<void>;
  /** The definition the broker holds for `name` (latest version when omitted). */
  getProtocol(name: string, version?: string): Promise<ProtocolDetail>;
  /** The broker in use, where it came from, the saved one and the brokers discovery finds right now. */
  getBroker(): Promise<BrokerInfo>;
  /**
   * Switch to the broker at `url` for this session (pinned; wins over `AGENT_MESSENGER_HOST`), keeping name, summary
   * and protocol declarations. Without `url` the pin is dropped and the broker is resolved again.
   * `persist` saves the choice in `client.json` (without `url`: removes the saved one).
   */
  setBroker(url?: string, opts?: { persist?: boolean }): Promise<BrokerInfo>;
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
  const broker = options.brokerClient ?? createBrokerClient(cfg.token);
  const peer = createPeerState({ name: options.name ?? cfg.name, summary: options.summary });
  const protocols = createProtocolState();
  const inbox = createInbox({ broker, peer, log, notifier, protocols });
  const registry = createToolRegistry({
    broker,
    peer,
    inbox,
    protocols,
    connection: { get: () => getBroker(), set: (url, persist) => setBroker(url, { persist: persist === true }) },
  });
  const protocolEnv = { broker, peer, protocols };

  let connectPromise: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  let closed = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let recoverTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** `set_broker(url)` pin: first in the resolution order until `set_broker()` or the grace period after a failure ends it. */
  let pin: string | null = null;
  /** how the current broker was found */
  let current: ResolvedBroker | null = null;

  // --- Link health + re-resolve ---
  //
  // A failed poll / heartbeat starts a grace period in which the previous URL keeps being retried (the
  // poll loop does that every second), so a flapping broker does not push the session into a local
  // fallback. When the grace is over the full resolution (env → config → discovery → local) runs again.
  // A heartbeat the broker rejects (it forgot us) re-runs the resolution at once.
  let failSince: number | null = null;
  let lastResolveAttempt = 0;
  let resolving = false;
  /** the re-resolution in progress (close() waits for it) */
  let inflightReresolve: Promise<void> | null = null;

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

  async function doReresolve(reason: string) {
    resolving = true;
    lastResolveAttempt = Date.now();
    try {
      const prev = broker.getUrl();
      log(`Re-resolving broker (${reason})`);
      const r = await resolveBroker(cfg, broker, log, options.brokers, pin);
      current = r;
      await ensureBroker(cfg, env, broker, r, log, autoStart);
      if (closed) return; // close() won the race: never re-register after it
      await registerPeer(broker, peer, log, wireDecls(protocols));
      // a re-registered peer starts without bodies at the broker: send every definition again (design 5.5)
      await resendDefinitions(protocolEnv, log);
      log(`broker=${broker.getUrl()} (${r.isLocal ? "local" : "remote"}, via ${r.source})${prev === broker.getUrl() ? "" : ` — was ${prev}`}`);
      failSince = null;
    } catch (e) {
      log(`Re-resolve failed: ${errorMessage(e)}`);
      noteFailure(); // keeps the recover loop retrying
    } finally {
      resolving = false;
    }
  }

  async function reresolve(reason: string) {
    if (resolving || closed) return;
    const p = doReresolve(reason);
    inflightReresolve = p;
    try {
      await p;
    } finally {
      if (inflightReresolve === p) inflightReresolve = null;
    }
  }

  async function pollLoop() {
    if (resolving || closed) return;
    try {
      await inbox.poll(true);
      noteOk();
    } catch (e) {
      log(`Poll error: ${errorMessage(e)}`);
      noteFailure();
    }
  }

  async function recoverLoop() {
    if (failSince === null || resolving || closed) return;
    const now = Date.now();
    if (now - failSince < cfg.graceMs || now - lastResolveAttempt < RESOLVE_RETRY_MS) return;
    if (pin !== null) {
      // the grace period was spent retrying the pinned broker: give the pin up, resolve from the top (it does not come back by itself)
      log(`Pinned broker ${pin} unreachable for ${cfg.graceMs} ms — pin dropped, resolving again`);
      pin = null;
    }
    await reresolve("connection failure");
  }

  async function heartbeat() {
    if (resolving || closed) return;
    try {
      const decls = wireDecls(protocols);
      const r = await broker.post("/heartbeat", decls === undefined ? { id: peer.id as string } : { id: peer.id as string, protocols: decls });
      if (r && r.ok === false) {
        log(`Heartbeat rejected (${r.error}) — re-registering`);
        await reresolve("heartbeat rejected");
      } else {
        noteOk();
        // the broker lacks the body of some declarations (restart, GC): send them again (design 5.5)
        if (r && r.ok && Array.isArray(r.resend) && r.resend.length > 0) await resendDefinitions(protocolEnv, log, r.resend);
      }
    } catch {
      // broker down; the grace period / re-resolve picks it up
      noteFailure();
    }
  }

  async function doConnect(): Promise<void> {
    const resolved = await resolveBroker(cfg, broker, log, options.brokers, pin);
    current = resolved;
    await ensureBroker(cfg, env, broker, resolved, log, autoStart);

    peer.gitRoot = detectGitRoot(peer.cwd);
    peer.tty = detectTty();
    log(`v${VERSION} host=${peer.hostname} broker=${broker.getUrl()} (${resolved.isLocal ? "local" : "remote"}, via ${resolved.source})`);
    log(`cwd=${peer.cwd} git_root=${peer.gitRoot ?? "(none)"} tty=${peer.tty ?? "(unknown)"} name=${peer.name || "(unset)"}`);
    if (notifier) log(`delivery=${cfg.delivery} session_socket=${cfg.sessionSocket || "(none)"}`);

    await registerPeer(broker, peer, log, wireDecls(protocols));
    if (closed) return; // close() won the race: it unregisters, no timers

    pollTimer = setInterval(pollLoop, cfg.pollIntervalMs);
    // Heartbeat; if the broker no longer knows us (restart, stale cleanup), re-register
    // so the session keeps its name and stays reachable without a restart.
    recoverTimer = setInterval(recoverLoop, cfg.pollIntervalMs);
    heartbeatTimer = setInterval(heartbeat, cfg.heartbeatIntervalMs);
  }

  function connect(): Promise<void> {
    if (closed) return Promise.reject(new Error("client closed"));
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
    inbox.stop();
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
    // a re-resolution already in progress must finish (it will not register) before we unregister
    if (inflightReresolve) await inflightReresolve.catch(() => {});
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

  async function sendMode(to: string, text: string, mode: "pull" | "push" | "ping", meta?: MessageMeta): Promise<SendResult> {
    const id = requireRegistered();
    const plan = mode === "ping" ? { text, meta, warning: undefined } : planOutgoing(protocols, to, text, meta);
    const r = await broker.post("/send-message", {
      from_id: id,
      from_name: peer.name,
      to,
      text: plan.text,
      mode,
      ...(plan.meta === undefined ? {} : { meta: plan.meta }),
    });
    if (!r.ok) throw new Error(`Failed to send: ${r.error}`);
    const out: SendResult = { to_id: r.to_id, to_name: r.to_name ?? "", message_id: r.message_id };
    if (plan.warning) out.warning = plan.warning;
    return out;
  }

  // --- get_broker / set_broker ---

  async function getBroker(): Promise<BrokerInfo> {
    const url = broker.getUrl();
    const h = url ? await broker.health(url, 2000) : null;
    const found = cfg.discoveryEnabled ? await discoverBrokers(cfg) : [];
    return {
      url,
      id: h?.id ?? "",
      version: h?.version ?? "",
      mesh: h?.mesh === true,
      source: current?.kind ?? "fallback",
      pinned: pin !== null,
      saved: readSavedBroker(cfg),
      discovered: found.map((d) => ({ id: d.id, url: d.url, version: d.version, mesh: d.mesh, fallback: d.fallback })),
    };
  }

  async function doSetBroker(urlArg: string | undefined, persist: boolean): Promise<BrokerInfo> {
    const prev = broker.getUrl();
    let target: string;
    let resolvedAuto: ResolvedBroker | null = null;
    if (urlArg === undefined) {
      // no URL: drop the pin and resolve again (env, saved, discovery, local)
      const r = await resolveBroker(cfg, broker, log, options.brokers, null);
      broker.setUrl(prev);
      target = r.url;
      resolvedAuto = r;
    } else {
      target = normalizeBrokerUrl(urlArg, DEFAULT_HTTP_PORT);
    }

    if (target !== prev) {
      if (!(await broker.health(target, 2000))) {
        throw brokerError("BROKER_UNREACHABLE", `Broker ${target} is not reachable; still connected to ${prev || "(none)"}`);
      }
      if (peer.id) {
        await inbox.carryOver(); // unread messages of the old broker stay readable here
        await broker.post("/unregister", { id: peer.id }).catch(() => {}); // best effort
        broker.setUrl(target);
        try {
          if (closed) throw new Error("client closed");
          await registerPeer(broker, peer, log, wireDecls(protocols));
          await resendDefinitions(protocolEnv, log);
        } catch (e) {
          broker.setUrl(prev);
          try {
            await registerPeer(broker, peer, log, wireDecls(protocols));
            await resendDefinitions(protocolEnv, log);
          } catch (e2) {
            log(`Could not register again on ${prev}: ${errorMessage(e2)}`);
          }
          throw brokerError("BROKER_SWITCH_FAILED", `Could not register with ${target} (${errorMessage(e)}); back on ${prev}`);
        }
      } else {
        broker.setUrl(target); // not connected yet: connect() will register here
      }
      log(`broker=${target} (via set_broker) — was ${prev || "(none)"}`);
    }

    pin = urlArg === undefined ? null : target;
    if (resolvedAuto) {
      current = resolvedAuto;
    } else {
      const host = new URL(target).hostname;
      current = { url: target, host, source: "set_broker", kind: "set_broker", isLocal: isLocalHost(host) };
    }
    failSince = null;
    let saveError: unknown = null;
    if (persist) {
      try {
        writeSavedBroker(cfg, urlArg === undefined ? null : target);
      } catch (e) {
        saveError = e;
      }
    }
    if (saveError !== null) throw brokerError("SAVE_FAILED", `Switched to ${target}, but could not save it: ${errorMessage(saveError)}`);
    return getBroker();
  }

  async function setBroker(url?: string, opts: { persist?: boolean } = {}): Promise<BrokerInfo> {
    if (closed) throw new Error("client closed");
    if (resolving) throw brokerError("BROKER_SWITCH_BUSY", "Broker switch in progress; try again");
    resolving = true; // poll / heartbeat / re-resolve stand still meanwhile
    lastResolveAttempt = Date.now();
    const p = doSetBroker(url, opts.persist === true);
    inflightReresolve = p.then(
      () => {},
      () => {}
    );
    try {
      return await p;
    } finally {
      resolving = false;
      if (inflightReresolve !== null) inflightReresolve = null;
    }
  }

  // the broker answered `unknown peer` to a protocol call: register again (which also re-sends the definitions)
  protocols.reregister = () => reresolve("protocol call: unknown peer");

  return {
    peer,
    registry,
    connect,
    close,
    async send(to, text, delivery, meta) {
      requireRegistered();
      const d = delivery === undefined ? "pull" : String(delivery);
      if (d !== "pull" && d !== "push") throw new Error(`Invalid delivery: ${d} (use "pull" or "push")`);
      return sendMode(to, text, d, parseMeta(meta));
    },
    ping(to, subject) {
      return sendMode(to, subject ?? "", "ping");
    },
    async listPeers(scope = "all", filter) {
      requireRegistered();
      return listPeersFiltered(protocolEnv, scope, filter);
    },
    setProtocol(repo, version) {
      return setProtocolDef(protocolEnv, repo, version);
    },
    async unsetProtocol(name) {
      await unsetProtocolDef(protocolEnv, name);
    },
    getProtocol(name, version) {
      return getProtocolDef(protocolEnv, name, version);
    },
    getBroker,
    setBroker,
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
