import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import type { Message, Peer } from "@agent-hand/messenger-protocol";
import { createBrokerClient } from "./broker.js";
import type { BrokerClient } from "./broker.js";
import { loadConfig } from "./config.js";
import type { ClientConfig, Env } from "./config.js";
import { createStdioServer } from "./mcp.js";
import { resolveBroker } from "./resolve.js";
import type { Logger, ResolvedBroker } from "./resolve.js";
import { postToSession } from "./session.js";
import { VERSION } from "./version.js";

/**
 * agent-messenger client (stdio MCP server, one per Claude Code session).
 * Registers with the broker, exposes tools, delivers inbound messages to the
 * session (inbox socket → channel notification → local buffer for check_messages).
 *
 * Behaviour mirrors the current `legacy/src/server.js`.
 */

export interface StartClientOptions {
  /** Environment to read configuration from (default `process.env`). */
  env?: Env;
  /** Log sink (default: stderr, prefixed `[agent-messenger] `). */
  log?: Logger;
}

export const INSTRUCTIONS = `agent-messenger v${VERSION}

You are connected to agent-messenger. Other Claude Code sessions on this machine AND on remote hosts can find you and send you messages.

Inbound traffic arrives in the conversation as one of:
- "[agent-messenger] 未読 N 件（from <name>@<host>）…" — an unread notice. Call check_messages to read the text, reply with send_message if needed, then resume your work.
- "[agent-messenger] ping（from <name>@<host>）" — the sender is alive and working. No text, nothing to read, no reply needed.
- "[agent-messenger] message from <name>@<host>" followed by the text — sent with delivery "push". Reply with send_message if needed, then resume your work.

Tools:
- list_peers: discover sessions (scope: all / host / directory / repo)
- send_message: send to a peer by name or id (cross-host). delivery "pull" (default) = the receiver sees only an unread notice; "push" = the text is shown directly
- send_ping: send an empty liveness signal (e.g. periodically while working, so the orchestrator can tell progress from a stall)
- set_name: give this session a stable name (e.g. "master-cap", "agent-messenger") so others can address it by name
- set_summary: describe what you are working on (visible in list_peers)
- check_messages: read unread message texts. Notices are delivered into the conversation automatically (via the session inbox socket, or via channel push when Claude Code was started with --dangerously-load-development-channels server:agent-messenger); call check_messages any time to read.

On start, call set_name (if not already named) and set_summary.`;

export const CAPABILITIES = {
  experimental: { "claude/channel": {} },
  tools: {},
};

/** Every tool description starts with the version so `/mcp` → View tools shows which build is running. */
export const TOOLS = [
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
        delivery: {
          type: "string",
          enum: ["pull", "push"],
          description:
            '"pull" (default) = the receiver sees only an unread notice (sender shown) and reads the text with check_messages. "push" = the text is shown in the receiver\'s conversation directly.',
        },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "send_ping",
    description:
      "Send an empty liveness signal to a peer. The receiver sees a one-line ping notice (sender shown), nothing to read or reply to. Use it periodically during long work so the orchestrator can tell progress from a stall.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string", description: "Target peer name or id" } },
      required: ["to"],
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
      "Read and acknowledge unread messages from other sessions (the text behind an unread notice). Safe to call any time.",
    inputSchema: { type: "object", properties: {} },
  },
].map((t) => ({ ...t, description: `[agent-messenger v${VERSION}] ${t.description}` }));

const MAX_BUFFER = 200;

/** A polled message enriched with sender details (same shape as the current server's buffer entries). */
interface BufferedMessage extends Message {
  from_hostname: string;
  from_summary: string;
  from_cwd: string;
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: true;
}

function text(t: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text: t }], isError: true } : { content: [{ type: "text", text: t }] };
}

function formatPeer(p: Peer): string {
  const parts = [`ID: ${p.id}`];
  if (p.name) parts.push(`Name: ${p.name}`);
  parts.push(`Host: ${p.hostname}`, `PID: ${p.pid}`, `CWD: ${p.cwd}`);
  if (p.git_root) parts.push(`Repo: ${p.git_root}`);
  if (p.tty) parts.push(`TTY: ${p.tty}`);
  if (p.summary) parts.push(`Summary: ${p.summary}`);
  parts.push(`Last seen: ${p.last_seen}`);
  return parts.join("\n  ");
}

function formatMessage(m: BufferedMessage): string {
  const who = m.from_name ? `${m.from_name} (${m.from_id})` : m.from_id;
  const host = m.from_hostname ? `@${m.from_hostname}` : "";
  return `From ${who}${host} at ${m.sent_at}:\n${m.text}`;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function git(args: string[], cwd: string): string | null {
  const r = spawnSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout.toString().trim() : null;
}

function getTty(): string | null {
  try {
    const r = spawnSync("ps", ["-o", "tty=", "-p", String(process.ppid)]);
    const tty = r.stdout.toString().trim();
    if (tty && tty !== "?" && tty !== "??") return tty;
  } catch {
    // ignore
  }
  return null;
}

async function ensureBroker(cfg: ClientConfig, env: Env, broker: BrokerClient, resolved: ResolvedBroker, log: Logger) {
  if (await broker.health()) {
    log("Broker already running");
    return;
  }
  if (!resolved.isLocal) {
    throw new Error(
      `Remote broker at ${broker.getUrl()} is not reachable. Start it on the broker host: agent-messenger broker`
    );
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
    env: { ...env, AGENT_MESSENGER_PORT: new URL(broker.getUrl()).port },
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

export async function startClient(options: StartClientOptions = {}): Promise<void> {
  const env: Env = options.env ?? (process.env as Env);
  const log: Logger = options.log ?? ((msg: string) => console.error(`[agent-messenger] ${msg}`));
  const cfg = loadConfig(env);
  const broker = createBrokerClient(cfg.token);
  const myHostname = osHostname();
  const myCwd = process.cwd();

  // --- State ---
  let myId: string | null = null;
  let myName = cfg.name;
  let mySummary = "";
  let myGitRoot: string | null = null;
  /** messages received but not yet acknowledged by the session */
  const localBuffer: BufferedMessage[] = [];
  /** ids already covered by an unread notice (cleared by check_messages) */
  const notifiedIds = new Set<number>();

  const resolved = await resolveBroker(cfg, broker, log);
  await ensureBroker(cfg, env, broker, resolved, log);

  myGitRoot = git(["rev-parse", "--show-toplevel"], myCwd);
  const tty = getTty();
  log(`v${VERSION} host=${myHostname} broker=${broker.getUrl()} (${resolved.isLocal ? "local" : "remote"}, via ${resolved.source})`);
  log(`cwd=${myCwd} git_root=${myGitRoot ?? "(none)"} tty=${tty ?? "(unknown)"} name=${myName || "(unset)"}`);
  log(`delivery=${cfg.delivery} session_socket=${cfg.sessionSocket || "(none)"}`);

  const register = async () => {
    const reg = await broker.post("/register", {
      pid: process.pid,
      hostname: myHostname,
      cwd: myCwd,
      git_root: myGitRoot,
      tty,
      summary: mySummary,
      name: myName,
    });
    myId = reg.id;
    log(`Registered as peer ${myId}`);
  };
  await register();

  // --- MCP ---
  const mcp = createStdioServer({
    serverInfo: { name: "agent-messenger", version: VERSION },
    capabilities: CAPABILITIES,
    instructions: INSTRUCTIONS,
    onClose: () => {
      cleanup();
    },
  });

  mcp.setRequestHandler("tools/list", () => ({ tools: TOOLS }));

  mcp.setRequestHandler("tools/call", async (params: unknown): Promise<ToolResult> => {
    const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const name = p.name ?? "";
    const args = p.arguments ?? {};
    if (!myId && name !== "list_peers") return text("Not registered with broker yet", true);
    try {
      switch (name) {
        case "list_peers": {
          const scope = (typeof args.scope === "string" ? args.scope : "all") as "all" | "host" | "directory" | "repo";
          const peers = await broker.post("/list-peers", {
            scope,
            cwd: myCwd,
            git_root: myGitRoot,
            hostname: myHostname,
            exclude_id: myId ?? undefined,
          });
          if (peers.length === 0) return text(`No other sessions found (scope: ${scope}).`);
          return text(`Found ${peers.length} peer(s) (scope: ${scope}):\n\n${peers.map(formatPeer).join("\n\n")}`);
        }
        case "send_message": {
          const delivery = args.delivery === undefined ? "pull" : String(args.delivery);
          if (delivery !== "pull" && delivery !== "push") return text(`Invalid delivery: ${delivery} (use "pull" or "push")`, true);
          const r = await broker.post("/send-message", {
            from_id: myId ?? undefined,
            from_name: myName,
            to: String(args.to),
            text: String(args.message),
            mode: delivery,
          });
          if (!r.ok) return text(`Failed to send: ${r.error}`, true);
          const label = r.to_name ? `${r.to_name} (${r.to_id})` : r.to_id;
          return text(`Message sent to ${label} (delivery: ${delivery}).`);
        }
        case "send_ping": {
          const r = await broker.post("/send-message", {
            from_id: myId ?? undefined,
            from_name: myName,
            to: String(args.to),
            text: "",
            mode: "ping",
          });
          if (!r.ok) return text(`Failed to send: ${r.error}`, true);
          const label = r.to_name ? `${r.to_name} (${r.to_id})` : r.to_id;
          return text(`Ping sent to ${label}.`);
        }
        case "set_name": {
          const newName = String(args.name);
          const r = await broker.post("/set-name", { id: myId as string, name: newName });
          if (!r.ok) return text(`Failed: ${r.error}`, true);
          myName = newName;
          return text(`Name set: "${newName}"`);
        }
        case "set_summary": {
          const summary = String(args.summary);
          const r = await broker.post("/set-summary", { id: myId as string, summary });
          if (!r.ok) return text(`Failed: ${r.error}`, true);
          mySummary = summary;
          return text(`Summary updated: "${summary}"`);
        }
        case "check_messages": {
          await pollBroker(false);
          const buffered = await broker.post("/get-buffered-messages", { id: myId as string });
          for (const m of buffered.messages) {
            if (m.mode === "ping") {
              await acknowledge(m.id);
              continue;
            }
            if (!localBuffer.some((b) => b.id === m.id)) {
              localBuffer.push({ ...m, from_hostname: "", from_summary: "", from_cwd: "" });
            }
          }
          if (localBuffer.length === 0) return text("No new messages.");
          const out = localBuffer.map(formatMessage).join("\n\n---\n\n");
          const ids = localBuffer.map((m) => m.id);
          await broker.post("/acknowledge-messages", { id: myId as string, message_ids: ids }).catch(() => {});
          const count = localBuffer.length;
          localBuffer.length = 0;
          notifiedIds.clear();
          return text(`${count} message(s):\n\n${out}`);
        }
        default:
          return text(`Unknown tool: ${name}`, true);
      }
    } catch (e) {
      return text(`Error (${name}): ${errorMessage(e)}`, true);
    }
  });

  // --- Inbound polling + delivery ---

  async function lookupSender(fromId: string): Promise<Peer | null> {
    try {
      const peers = await broker.post("/list-peers", { scope: "all", cwd: myCwd, git_root: myGitRoot });
      return peers.find((p) => p.id === fromId) ?? null;
    } catch {
      return null;
    }
  }

  async function acknowledge(messageId: number) {
    await broker.post("/acknowledge-messages", { id: myId as string, message_ids: [messageId] }).catch(() => {});
    const i = localBuffer.findIndex((b) => b.id === messageId);
    if (i !== -1) localBuffer.splice(i, 1);
  }

  function senderLabel(entry: BufferedMessage): string {
    return `${entry.from_name || entry.from_id}${entry.from_hostname ? `@${entry.from_hostname}` : ""}`;
  }

  function channelMeta(entry: BufferedMessage) {
    return {
      from_id: entry.from_id,
      from_name: entry.from_name,
      from_hostname: entry.from_hostname,
      from_summary: entry.from_summary,
      from_cwd: entry.from_cwd,
      sent_at: entry.sent_at,
    };
  }

  /**
   * body=pull: put one unread notice into the session (session socket → channel)
   * when the buffer holds ids not yet covered by a notice. The text stays
   * unacknowledged at the broker until `check_messages`.
   */
  async function notifyUnread() {
    if (localBuffer.length === 0) return;
    if (!localBuffer.some((b) => !notifiedIds.has(b.id))) return;
    const latest = localBuffer[localBuffer.length - 1];
    const who = senderLabel(latest);
    const notice = `[agent-messenger] 未読 ${localBuffer.length} 件（from ${who}）。check_messages で受信してください`;
    let delivered = false;
    const useSocket = cfg.delivery === "socket" || (cfg.delivery === "auto" && cfg.sessionSocket);
    if (useSocket) {
      try {
        await postToSession(cfg.sessionSocket, cfg.sessionToken, notice);
        log(`Session socket unread notice OK (${localBuffer.length}) from ${who}`);
        delivered = true;
      } catch (e) {
        log(`Session socket unread notice FAILED from ${latest.from_id}: ${errorMessage(e)} — trying channel`);
      }
    }
    if (!delivered) {
      try {
        await mcp.notification("notifications/claude/channel", { content: notice, meta: channelMeta(latest) });
        log(`Channel unread notice OK (${localBuffer.length}) from ${who}`);
        delivered = true;
      } catch (e) {
        log(`Channel unread notice FAILED from ${latest.from_id}: ${errorMessage(e)}`);
      }
    }
    if (delivered) for (const b of localBuffer) notifiedIds.add(b.id);
  }

  /**
   * mode=ping: put a one-line ping notice into the session (session socket →
   * channel). The ping has no text and is acknowledged right away.
   */
  async function notifyPing(entry: BufferedMessage) {
    const who = senderLabel(entry);
    const notice = `[agent-messenger] ping（from ${who}）`;
    const useSocket = cfg.delivery === "socket" || (cfg.delivery === "auto" && cfg.sessionSocket);
    if (useSocket) {
      try {
        await postToSession(cfg.sessionSocket, cfg.sessionToken, notice);
        log(`Session socket ping notice OK from ${who}`);
        return;
      } catch (e) {
        log(`Session socket ping notice FAILED from ${entry.from_id}: ${errorMessage(e)} — trying channel`);
      }
    }
    try {
      await mcp.notification("notifications/claude/channel", { content: notice, meta: channelMeta(entry) });
      log(`Channel ping notice OK from ${who}`);
    } catch (e) {
      log(`Channel ping notice FAILED from ${entry.from_id}: ${errorMessage(e)}`);
    }
  }

  /**
   * Pull undelivered messages from the broker.
   * - mode=ping: notice only, acknowledged at once, never buffered.
   * - otherwise the message goes into the local buffer. When `push` is true,
   *   mode=push is delivered with its text and acknowledged on success;
   *   mode=pull (or missing) gets one unread notice and the text stays
   *   unacknowledged until `check_messages`.
   */
  async function pollBroker(push: boolean) {
    if (!myId) return;
    const result = await broker.post("/poll-messages", { id: myId });
    for (const msg of result.messages) {
      const sender = await lookupSender(msg.from_id);
      const entry: BufferedMessage = {
        ...msg,
        from_name: msg.from_name || sender?.name || "",
        from_hostname: sender?.hostname ?? "",
        from_summary: sender?.summary ?? "",
        from_cwd: sender?.cwd ?? "",
      };
      if (msg.mode === "ping") {
        await notifyPing(entry);
        await acknowledge(msg.id);
        continue;
      }
      localBuffer.push(entry);
      if (localBuffer.length > MAX_BUFFER) localBuffer.splice(0, localBuffer.length - MAX_BUFFER);
      if (!push || msg.mode !== "push") continue;

      const useSocket = cfg.delivery === "socket" || (cfg.delivery === "auto" && cfg.sessionSocket);
      if (useSocket) {
        try {
          const who = `${entry.from_name || entry.from_id}${entry.from_hostname ? `@${entry.from_hostname}` : ""}`;
          const replyTo = entry.from_name || entry.from_id;
          await postToSession(
            cfg.sessionSocket,
            cfg.sessionToken,
            `[agent-messenger] message from ${who}\n${msg.text}\n\n(reply with the agent-messenger send_message tool, to: "${replyTo}")`
          );
          log(`Session socket delivery OK from ${who}: ${msg.text.slice(0, 80)}`);
          await acknowledge(msg.id);
          continue;
        } catch (e) {
          log(`Session socket delivery FAILED from ${entry.from_id}: ${errorMessage(e)} — trying channel`);
        }
      }

      try {
        await mcp.notification("notifications/claude/channel", {
          content: msg.text,
          meta: {
            from_id: entry.from_id,
            from_name: entry.from_name,
            from_hostname: entry.from_hostname,
            from_summary: entry.from_summary,
            from_cwd: entry.from_cwd,
            sent_at: entry.sent_at,
          },
        });
        log(`Channel push OK from ${entry.from_name || entry.from_id}: ${msg.text.slice(0, 80)}`);
        await acknowledge(msg.id);
      } catch (e) {
        log(`Channel push FAILED from ${entry.from_id}: ${errorMessage(e)}`);
      }
    }
    if (push) await notifyUnread();
  }

  async function pollLoop() {
    try {
      await pollBroker(true);
    } catch (e) {
      log(`Poll error: ${errorMessage(e)}`);
    }
  }

  // --- Run ---

  mcp.connect();
  log("MCP connected");

  const pollTimer = setInterval(pollLoop, cfg.pollIntervalMs);
  // Heartbeat; if the broker no longer knows us (restart, stale cleanup), re-register
  // so the session keeps its name and stays reachable without a Claude Code restart.
  const heartbeatTimer = setInterval(async () => {
    try {
      const r = await broker.post("/heartbeat", { id: myId as string });
      if (r && r.ok === false) {
        log(`Heartbeat rejected (${r.error}) — re-registering`);
        await register();
      }
    } catch {
      // broker down; try again next tick
    }
  }, cfg.heartbeatIntervalMs);

  let cleaningUp = false;
  async function cleanup() {
    if (cleaningUp) return;
    cleaningUp = true;
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    try {
      await broker.post("/unregister", { id: myId as string });
      log("Unregistered from broker");
    } catch {
      // best effort
    }
    process.exit(0);
  }
  process.on("SIGINT", () => {
    cleanup();
  });
  process.on("SIGTERM", () => {
    cleanup();
  });
}
