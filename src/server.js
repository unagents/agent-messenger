import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { hostname as osHostname } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  BROKER_URL,
  IS_LOCAL_BROKER,
  NAME,
  STATE_DIR,
  HEARTBEAT_INTERVAL_MS,
  POLL_INTERVAL_MS,
} from "./config.js";
import { brokerFetch, brokerHealth } from "./client.js";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../package.json");
const BIN = fileURLToPath(new URL("../bin/agent-messenger.js", import.meta.url));
const MY_HOSTNAME = osHostname();

/**
 * agent-messenger MCP server (stdio, one per Claude Code session).
 * Registers with the broker, exposes tools, pushes inbound messages as
 * channel notifications (needs `--dangerously-load-development-channels
 * server:agent-messenger`) and keeps a local buffer for check_messages.
 */

function log(msg) {
  console.error(`[agent-messenger] ${msg}`);
}

async function ensureBroker() {
  if (await brokerHealth()) {
    log("Broker already running");
    return;
  }
  if (!IS_LOCAL_BROKER) {
    throw new Error(
      `Remote broker at ${BROKER_URL} is not reachable. Start it on the broker host: agent-messenger broker`
    );
  }
  log("Starting local broker daemon...");
  mkdirSync(STATE_DIR, { recursive: true });
  const out = openSync(`${STATE_DIR}/broker.log`, "a");
  const proc = spawn(process.execPath, [BIN, "broker"], {
    stdio: ["ignore", out, out],
    detached: true,
    env: process.env,
  });
  proc.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await brokerHealth()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout.toString().trim() : null;
}

function getTty() {
  try {
    const r = spawnSync("ps", ["-o", "tty=", "-p", String(process.ppid)]);
    const tty = r.stdout.toString().trim();
    if (tty && tty !== "?" && tty !== "??") return tty;
  } catch {
    // ignore
  }
  return null;
}

// --- State ---

let myId = null;
let myName = NAME;
const myCwd = process.cwd();
let myGitRoot = null;

/** messages received but not yet acknowledged by the session */
const localBuffer = [];
const MAX_BUFFER = 200;

// --- MCP ---

const mcp = new Server(
  { name: "agent-messenger", version: VERSION },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to agent-messenger. Other Claude Code sessions on this machine AND on remote hosts can find you and send you messages.

When a <channel source="agent-messenger" ...> message arrives, respond right away: read from_id / from_name / from_hostname / from_cwd, reply with send_message (to = from_name or from_id), then resume your work.

Tools:
- list_peers: discover sessions (scope: all / host / directory / repo)
- send_message: send to a peer by name or id (cross-host)
- set_name: give this session a stable name (e.g. "master-cap", "agent-messenger") so others can address it by name
- set_summary: describe what you are working on (visible in list_peers)
- check_messages: read buffered messages. Channel push only works when Claude Code was started with --dangerously-load-development-channels server:agent-messenger; otherwise call check_messages to receive.

On start, call set_name (if not already named) and set_summary.`,
  }
);

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code sessions connected to the broker (id, name, hostname, cwd, repo, summary).",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["all", "host", "directory", "repo"],
          description:
            '"all" = every host (default). "host" = same hostname. "directory" = same cwd. "repo" = same git repository.',
        },
      },
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code session by peer name or id (from list_peers). Works across hosts.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target peer name or id" },
        message: { type: "string", description: "Message text" },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "set_name",
    description: "Set a stable name for this session so other peers can address it by name.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Name, e.g. the session name" } },
      required: ["name"],
    },
  },
  {
    name: "set_summary",
    description: "Set a 1-2 sentence summary of what this session is working on (visible in list_peers).",
    inputSchema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Read and acknowledge buffered messages from other sessions. Required when channel push is not enabled; safe to call any time.",
    inputSchema: { type: "object", properties: {} },
  },
];

function text(t, isError = false) {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

function formatPeer(p) {
  const parts = [`ID: ${p.id}`];
  if (p.name) parts.push(`Name: ${p.name}`);
  parts.push(`Host: ${p.hostname}`, `PID: ${p.pid}`, `CWD: ${p.cwd}`);
  if (p.git_root) parts.push(`Repo: ${p.git_root}`);
  if (p.tty) parts.push(`TTY: ${p.tty}`);
  if (p.summary) parts.push(`Summary: ${p.summary}`);
  parts.push(`Last seen: ${p.last_seen}`);
  return parts.join("\n  ");
}

function formatMessage(m) {
  const who = m.from_name ? `${m.from_name} (${m.from_id})` : m.from_id;
  const host = m.from_hostname ? `@${m.from_hostname}` : "";
  return `From ${who}${host} at ${m.sent_at}:\n${m.text}`;
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (!myId && name !== "list_peers") return text("Not registered with broker yet", true);
  try {
    switch (name) {
      case "list_peers": {
        const scope = args.scope ?? "all";
        const peers = await brokerFetch("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          hostname: MY_HOSTNAME,
          exclude_id: myId,
        });
        if (peers.length === 0) return text(`No other sessions found (scope: ${scope}).`);
        return text(`Found ${peers.length} peer(s) (scope: ${scope}):\n\n${peers.map(formatPeer).join("\n\n")}`);
      }
      case "send_message": {
        const r = await brokerFetch("/send-message", {
          from_id: myId,
          from_name: myName,
          to: args.to,
          text: args.message,
        });
        if (!r.ok) return text(`Failed to send: ${r.error}`, true);
        const label = r.to_name ? `${r.to_name} (${r.to_id})` : r.to_id;
        return text(`Message sent to ${label}. If they run without channel push, they must call check_messages.`);
      }
      case "set_name": {
        const r = await brokerFetch("/set-name", { id: myId, name: args.name });
        if (!r.ok) return text(`Failed: ${r.error}`, true);
        myName = args.name;
        return text(`Name set: "${args.name}"`);
      }
      case "set_summary": {
        const r = await brokerFetch("/set-summary", { id: myId, summary: args.summary });
        if (!r.ok) return text(`Failed: ${r.error}`, true);
        return text(`Summary updated: "${args.summary}"`);
      }
      case "check_messages": {
        await pollBroker(false);
        const buffered = await brokerFetch("/get-buffered-messages", { id: myId });
        for (const m of buffered.messages) {
          if (!localBuffer.some((b) => b.id === m.id)) localBuffer.push(m);
        }
        if (localBuffer.length === 0) return text("No new messages.");
        const out = localBuffer.map(formatMessage).join("\n\n---\n\n");
        const ids = localBuffer.map((m) => m.id);
        await brokerFetch("/acknowledge-messages", { id: myId, message_ids: ids }).catch(() => {});
        const count = localBuffer.length;
        localBuffer.length = 0;
        return text(`${count} message(s):\n\n${out}`);
      }
      default:
        return text(`Unknown tool: ${name}`, true);
    }
  } catch (e) {
    return text(`Error (${name}): ${e.message}`, true);
  }
});

// --- Inbound polling + channel push ---

async function lookupSender(fromId) {
  try {
    const peers = await brokerFetch("/list-peers", { scope: "all", cwd: myCwd, git_root: myGitRoot });
    return peers.find((p) => p.id === fromId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Pull undelivered messages from the broker into the local buffer.
 * When `push` is true, try to deliver each via channel notification and
 * acknowledge on success.
 */
async function pollBroker(push) {
  if (!myId) return;
  const result = await brokerFetch("/poll-messages", { id: myId });
  for (const msg of result.messages) {
    const sender = await lookupSender(msg.from_id);
    const entry = {
      ...msg,
      from_name: msg.from_name || sender?.name || "",
      from_hostname: sender?.hostname ?? "",
      from_summary: sender?.summary ?? "",
      from_cwd: sender?.cwd ?? "",
    };
    localBuffer.push(entry);
    if (localBuffer.length > MAX_BUFFER) localBuffer.splice(0, localBuffer.length - MAX_BUFFER);
    if (!push) continue;

    try {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.text,
          meta: {
            from_id: entry.from_id,
            from_name: entry.from_name,
            from_hostname: entry.from_hostname,
            from_summary: entry.from_summary,
            from_cwd: entry.from_cwd,
            sent_at: entry.sent_at,
          },
        },
      });
      log(`Channel push OK from ${entry.from_name || entry.from_id}: ${msg.text.slice(0, 80)}`);
      await brokerFetch("/acknowledge-messages", { id: myId, message_ids: [msg.id] }).catch(() => {});
      const i = localBuffer.findIndex((b) => b.id === msg.id);
      if (i !== -1) localBuffer.splice(i, 1);
    } catch (e) {
      log(`Channel push FAILED from ${entry.from_id}: ${e.message}`);
    }
  }
}

async function pollLoop() {
  try {
    await pollBroker(true);
  } catch (e) {
    log(`Poll error: ${e.message}`);
  }
}

// --- Startup ---

export async function startMcpServer() {
  await ensureBroker();

  myGitRoot = git(["rev-parse", "--show-toplevel"], myCwd);
  const tty = getTty();
  log(`v${VERSION} host=${MY_HOSTNAME} broker=${BROKER_URL} (${IS_LOCAL_BROKER ? "local" : "remote"})`);
  log(`cwd=${myCwd} git_root=${myGitRoot ?? "(none)"} tty=${tty ?? "(unknown)"} name=${myName || "(unset)"}`);

  const reg = await brokerFetch("/register", {
    pid: process.pid,
    hostname: MY_HOSTNAME,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: "",
    name: myName,
  });
  myId = reg.id;
  log(`Registered as peer ${myId}`);

  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  const pollTimer = setInterval(pollLoop, POLL_INTERVAL_MS);
  const heartbeatTimer = setInterval(() => {
    brokerFetch("/heartbeat", { id: myId })
      .then((r) => {
        if (r && r.ok === false) log(`Heartbeat rejected: ${r.error}`);
      })
      .catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    try {
      await brokerFetch("/unregister", { id: myId });
      log("Unregistered from broker");
    } catch {
      // best effort
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.stdin.on("close", cleanup);
}
