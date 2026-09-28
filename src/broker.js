import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { createSocket } from "node:dgram";
import {
  PORT,
  BIND,
  TOKEN,
  STATE_FILE,
  HEARTBEAT_TIMEOUT_MS,
  BROKER_ID,
  DISCOVERY_ENABLED,
  DISCOVERY_PORT,
  DISCOVERY_ADDR,
} from "./config.js";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../package.json");

/**
 * agent-messenger broker
 *
 * Singleton HTTP daemon. Tracks registered peers (any host) and routes
 * messages between them. State is kept in memory and snapshotted to a JSON
 * file so undelivered messages survive a broker restart.
 */

// --- State ---

/** @type {Map<string, Peer>} */
const peers = new Map();
/** @type {Message[]} */
let messages = [];
let nextMsgId = 1;

function loadState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    for (const p of raw.peers ?? []) peers.set(p.id, p);
    messages = raw.messages ?? [];
    nextMsgId = raw.nextMsgId ?? 1;
    log(`Loaded state from ${STATE_FILE} (${peers.size} peer(s), ${messages.length} message(s))`);
  } catch {
    // no state yet
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(dirname(STATE_FILE), { recursive: true });
      const tmp = `${STATE_FILE}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ peers: [...peers.values()], messages, nextMsgId }, null, 1)
      );
      renameSync(tmp, STATE_FILE);
    } catch (e) {
      log(`Save failed: ${e.message}`);
    }
  }, 200);
}

function log(msg) {
  console.error(`[agent-messenger broker] ${msg}`);
}

function generateId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function isAlive(p, cutoff) {
  return p.last_seen >= cutoff;
}

function cleanStalePeers() {
  const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString();
  let removed = 0;
  for (const p of peers.values()) {
    if (!isAlive(p, cutoff)) {
      removePeer(p.id);
      removed++;
    }
  }
  if (removed) {
    log(`Cleaned ${removed} stale peer(s)`);
    scheduleSave();
  }
}

function removePeer(id) {
  peers.delete(id);
  // drop messages that can never be delivered
  messages = messages.filter((m) => !(m.to_id === id && m.delivered === 0));
}

/** Resolve a peer by id or unique name. Returns { peer } or { error }. */
function resolvePeer(to) {
  if (peers.has(to)) return { peer: peers.get(to) };
  const byName = [...peers.values()].filter((p) => p.name && p.name === to);
  if (byName.length === 1) return { peer: byName[0] };
  if (byName.length > 1) {
    return {
      error: `Name "${to}" is ambiguous: ${byName.map((p) => `${p.id}@${p.hostname}`).join(", ")}`,
    };
  }
  return { error: `Peer "${to}" not found (no id or name matches)` };
}

// --- Handlers ---

function handleRegister(body) {
  // re-registration for same pid+hostname replaces the old entry
  for (const p of peers.values()) {
    if (p.pid === body.pid && p.hostname === body.hostname) removePeer(p.id);
  }
  const id = generateId();
  const now = new Date().toISOString();
  peers.set(id, {
    id,
    name: body.name ?? "",
    pid: body.pid,
    hostname: body.hostname ?? "",
    cwd: body.cwd ?? "",
    git_root: body.git_root ?? null,
    tty: body.tty ?? null,
    summary: body.summary ?? "",
    registered_at: now,
    last_seen: now,
  });
  scheduleSave();
  return { id };
}

function handleHeartbeat(body) {
  const p = peers.get(body.id);
  if (!p) return { ok: false, error: "unknown peer (re-register)" };
  p.last_seen = new Date().toISOString();
  scheduleSave(); // keep last_seen fresh on disk so peers survive a broker restart
  return { ok: true };
}

function handleSetSummary(body) {
  const p = peers.get(body.id);
  if (!p) return { ok: false, error: "unknown peer" };
  p.summary = body.summary ?? "";
  scheduleSave();
  return { ok: true };
}

function handleSetName(body) {
  const p = peers.get(body.id);
  if (!p) return { ok: false, error: "unknown peer" };
  p.name = body.name ?? "";
  scheduleSave();
  return { ok: true };
}

function handleListPeers(body) {
  const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString();
  let list = [...peers.values()].filter((p) => isAlive(p, cutoff));
  switch (body.scope) {
    case "host":
      if (body.hostname) list = list.filter((p) => p.hostname === body.hostname);
      break;
    case "directory":
      list = list.filter((p) => p.cwd === body.cwd);
      break;
    case "repo":
      list = body.git_root
        ? list.filter((p) => p.git_root === body.git_root)
        : list.filter((p) => p.cwd === body.cwd);
      break;
    default:
      // "all"
      break;
  }
  if (body.exclude_id) list = list.filter((p) => p.id !== body.exclude_id);
  return list;
}

function handleSendMessage(body) {
  const { peer, error } = resolvePeer(body.to);
  if (error) return { ok: false, error };
  const msg = {
    id: nextMsgId++,
    from_id: body.from_id ?? "cli",
    from_name: body.from_name ?? "",
    to_id: peer.id,
    text: body.text ?? "",
    sent_at: new Date().toISOString(),
    delivered: 0,
    acknowledged: 0,
  };
  messages.push(msg);
  scheduleSave();
  return { ok: true, to_id: peer.id, to_name: peer.name, message_id: msg.id };
}

function handlePollMessages(body) {
  const out = messages.filter((m) => m.to_id === body.id && m.delivered === 0);
  for (const m of out) m.delivered = 1;
  if (out.length) scheduleSave();
  return { messages: out };
}

function handleAcknowledgeMessages(body) {
  const ids = new Set(body.message_ids ?? []);
  // acknowledged messages are dropped from the store
  const before = messages.length;
  messages = messages.filter((m) => !(m.to_id === body.id && ids.has(m.id)));
  if (messages.length !== before) scheduleSave();
  return { ok: true };
}

function handleGetBufferedMessages(body) {
  return {
    messages: messages.filter((m) => m.to_id === body.id && m.delivered === 1 && m.acknowledged === 0),
  };
}

function handleUnregister(body) {
  removePeer(body.id);
  scheduleSave();
  return { ok: true };
}

// --- HTTP ---

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

const ROUTES = {
  "/register": handleRegister,
  "/heartbeat": handleHeartbeat,
  "/set-summary": handleSetSummary,
  "/set-name": handleSetName,
  "/list-peers": handleListPeers,
  "/send-message": handleSendMessage,
  "/poll-messages": handlePollMessages,
  "/acknowledge-messages": handleAcknowledgeMessages,
  "/get-buffered-messages": handleGetBufferedMessages,
  "/unregister": handleUnregister,
};

export function startBroker() {
  loadState();
  cleanStalePeers();
  setInterval(cleanStalePeers, 30_000).unref();

  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;

    if (req.method === "GET" && path === "/health") {
      const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString();
      const alive = [...peers.values()].filter((p) => isAlive(p, cutoff)).length;
      return sendJson(res, 200, { status: "ok", version: VERSION, id: BROKER_ID, port: PORT, peers: alive });
    }
    if (req.method !== "POST") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(`agent-messenger broker ${VERSION}\n`);
    }
    if (TOKEN && req.headers["authorization"] !== `Bearer ${TOKEN}`) {
      return sendJson(res, 401, { error: "unauthorized" });
    }
    const handler = ROUTES[path];
    if (!handler) return sendJson(res, 404, { error: "not found" });
    try {
      const body = await readJson(req);
      return sendJson(res, 200, handler(body));
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  });

  // UDP discovery responder: answer {"agent-messenger":"probe"} with our id/port so
  // clients on the LAN can find us without any configuration.
  let disco = null;
  if (DISCOVERY_ENABLED) {
    disco = createSocket({ type: "udp4", reuseAddr: true });
    disco.on("error", (e) => log(`discovery responder error: ${e.message}`));
    disco.on("message", (msg, rinfo) => {
      try {
        if (JSON.parse(msg.toString())["agent-messenger"] !== "probe") return;
      } catch {
        return;
      }
      const reply = Buffer.from(
        JSON.stringify({ "agent-messenger": "broker", id: BROKER_ID, port: PORT, version: VERSION })
      );
      disco.send(reply, rinfo.port, rinfo.address, () => {});
    });
    // bind to the discovery address when one is pinned (tests use 127.0.0.1), else all interfaces
    const bindAddr = DISCOVERY_ADDR && !DISCOVERY_ADDR.endsWith(".255") ? DISCOVERY_ADDR : "0.0.0.0";
    disco.bind(DISCOVERY_PORT, bindAddr, () => {
      try {
        disco.setBroadcast(true);
      } catch {
        // not needed for replies
      }
      log(`discovery responder on udp ${bindAddr}:${DISCOVERY_PORT} (id: ${BROKER_ID})`);
    });
  }

  server.listen(PORT, BIND, () => {
    log(`v${VERSION} id=${BROKER_ID} listening on ${BIND}:${PORT} (state: ${STATE_FILE})`);
    log(TOKEN ? "token auth enabled" : "WARNING: no AGENT_MESSENGER_TOKEN set — broker is open");
  });

  const shutdown = () => {
    log("shutting down");
    if (disco) disco.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}
