import type { Peer } from "@unagents/messenger-protocol";
import type { InboundMessage } from "../inbox.js";
import { formatBrokerInfo } from "../broker-info.js";
import { errorMessage, protocolErrorCode } from "../protocol-error.js";
import { getProtocol, listPeers, parseMeta, planOutgoing, setProtocol, unsetProtocol } from "../protocols.js";
import { normalizeVersion } from "../semver.js";
import { VERSION } from "../version.js";
import type { ToolDef, ToolResult } from "./types.js";

export const INSTRUCTIONS = `agent-messenger v${VERSION}

You are connected to agent-messenger. Other Claude Code sessions on this machine AND on remote hosts can find you and send you messages.

Inbound traffic arrives in the conversation as one of:
- "[agent-messenger] 未読 N 件（from <name>@<host>）…" — an unread notice. Call check_messages to read the text, reply with send_message if needed, then resume your work.
- "[agent-messenger] ping（from <name>@<host>）" or "…）: <subject>" — the sender is alive and working (subject = what it is working on, if given). Nothing to read, no reply needed.
- "[agent-messenger] message from <name>@<host>" followed by the text — sent with delivery "push". Reply with send_message if needed, then resume your work.

Tools:
- list_peers: discover sessions (scope: all / host / directory / repo)
- send_message: send to a peer by name or id (cross-host). delivery "pull" (default) = the receiver sees only an unread notice; "push" = the text is shown directly
- send_ping: send a liveness signal, optionally with a one-line subject such as the task id (e.g. periodically while working, so the orchestrator can tell progress from a stall)
- set_name: give this session a stable name (e.g. "master-cap", "agent-messenger") so others can address it by name
- set_summary: describe what you are working on (visible in list_peers)
- check_messages: read unread message texts. Notices are delivered into the conversation automatically (via the session inbox socket, or via channel push when Claude Code was started with --dangerously-load-development-channels server:agent-messenger); call check_messages any time to read.
- set_protocol: declare that this session serves a protocol (a public GitHub / Gitea repo or a local path holding protocol.json and PROTOCOL.md), so peers can find it with list_peers(protocol)
- unset_protocol: stop serving a protocol (all of them when no name is given)
- get_protocol: read a protocol definition held by the broker (protocol.json and PROTOCOL.md) to speak it
- list_peers(protocol, version): only the sessions that serve that protocol (and version)
- send_message(meta): meta = {protocol, version} tags the message with the protocol it follows; the receiver is warned when its served version differs
- get_broker: show the broker this session uses, where it came from (env / saved / discovery / fallback / set_broker), the saved one and the brokers discovery finds now
- set_broker: switch this session to another broker (url), keeping name, summary and protocols; without url the choice is dropped and the broker is resolved again. persist: true saves it for later sessions

On start, call set_name (if not already named) and set_summary.`;

function text(t: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text: t }], isError: true } : { content: [{ type: "text", text: t }] };
}

/** A protocol error (`<CODE>: ...`) is the tool's answer, not a crash. */
async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (protocolErrorCode(e) !== null) return text(errorMessage(e), true);
    throw e;
  }
}

export function formatPeer(p: Peer): string {
  const parts = [`ID: ${p.id}`];
  if (p.name) parts.push(`Name: ${p.name}`);
  parts.push(`Host: ${p.hostname}`, `PID: ${p.pid}`, `CWD: ${p.cwd}`);
  if (p.git_root) parts.push(`Repo: ${p.git_root}`);
  if (p.tty) parts.push(`TTY: ${p.tty}`);
  if (p.summary) parts.push(`Summary: ${p.summary}`);
  for (const d of p.protocols ?? []) parts.push(`Protocol: ${d.name}@${d.version}`);
  parts.push(`Last seen: ${p.last_seen}`);
  return parts.join("\n  ");
}

export function formatMessage(m: InboundMessage): string {
  const who = m.from_name ? `${m.from_name} (${m.from_id})` : m.from_id;
  const host = m.from_hostname ? `@${m.from_hostname}` : "";
  return `From ${who}${host} at ${m.sent_at}:\n${m.protocol_line ? `${m.protocol_line}\n` : ""}${m.text}`;
}

/** The eleven tools. Descriptions carry no version prefix; `toolDescriptors()` adds it. */
export const TOOL_DEFS: readonly ToolDef[] = [
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
        protocol: {
          type: "string",
          description: "Only sessions that serve this protocol (set_protocol). Combines with scope.",
        },
        version: {
          type: "string",
          description: "Only with protocol: only sessions that serve exactly this version (a leading v is ignored).",
        },
      },
    },
    requiresRegistration: false,
    handler(args, ctx) {
      return guarded(async () => {
        const scope = (typeof args.scope === "string" ? args.scope : "all") as "all" | "host" | "directory" | "repo";
        const protocol = args.protocol === undefined || args.protocol === "" ? undefined : String(args.protocol);
        const version = protocol === undefined || args.version === undefined || args.version === "" ? undefined : normalizeVersion(String(args.version));
        const peers = await listPeers(ctx, scope, { protocol, version });
        if (protocol !== undefined) {
          if (peers.length === 0) return text(`No server for protocol "${protocol}" (version: ${version ?? "any"}).`);
          return text(
            `Found ${peers.length} peer(s) (scope: ${scope}, protocol: ${protocol}, version: ${version ?? "any"}):\n\n${peers.map(formatPeer).join("\n\n")}`
          );
        }
        if (peers.length === 0) return text(`No other sessions found (scope: ${scope}).`);
        return text(`Found ${peers.length} peer(s) (scope: ${scope}):\n\n${peers.map(formatPeer).join("\n\n")}`);
      });
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
        meta: {
          type: "object",
          description:
            "Optional protocol tag of this message: which protocol (see get_protocol) and version it follows. Both fields are required when meta is given.",
          properties: {
            protocol: { type: "string", description: "Protocol name" },
            version: { type: "string", description: "Protocol version" },
          },
          required: ["protocol", "version"],
        },
      },
      required: ["to", "message"],
    },
    requiresRegistration: true,
    handler(args, ctx) {
      return guarded(async () => {
        const delivery = args.delivery === undefined ? "pull" : String(args.delivery);
        if (delivery !== "pull" && delivery !== "push") return text(`Invalid delivery: ${delivery} (use "pull" or "push")`, true);
        const meta = parseMeta(args.meta);
        const to = String(args.to);
        const plan = planOutgoing(ctx.protocols, to, String(args.message), meta);
        const r = await ctx.broker.post("/send-message", {
          from_id: ctx.peer.id ?? undefined,
          from_name: ctx.peer.name,
          to,
          text: plan.text,
          mode: delivery,
          ...(plan.meta === undefined ? {} : { meta: plan.meta }),
        });
        if (!r.ok) return text(`Failed to send: ${r.error}`, true);
        const label = r.to_name ? `${r.to_name} (${r.to_id})` : r.to_id;
        return text(`Message sent to ${label} (delivery: ${delivery}).${plan.warning ? `\n${plan.warning}` : ""}`);
      });
    },
  },
  {
    name: "send_ping",
    description:
      "Send a liveness signal to a peer, optionally with a one-line subject (e.g. the task id or name being worked on). The receiver sees a one-line ping notice (sender and subject shown), nothing to read or reply to. Use it periodically during long work so the orchestrator can tell progress from a stall.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target peer name or id" },
        subject: {
          type: "string",
          description: "Optional one-line subject, e.g. the task id or name being worked on. Delivered as the message text.",
        },
      },
      required: ["to"],
    },
    requiresRegistration: true,
    async handler(args, ctx) {
      const r = await ctx.broker.post("/send-message", {
        from_id: ctx.peer.id ?? undefined,
        from_name: ctx.peer.name,
        to: String(args.to),
        text: args.subject === undefined ? "" : String(args.subject),
        mode: "ping",
      });
      if (!r.ok) return text(`Failed to send: ${r.error}`, true);
      const label = r.to_name ? `${r.to_name} (${r.to_id})` : r.to_id;
      return text(`Ping sent to ${label}.`);
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
    requiresRegistration: true,
    async handler(args, ctx) {
      const newName = String(args.name);
      const r = await ctx.broker.post("/set-name", { id: ctx.peer.id as string, name: newName });
      if (!r.ok) return text(`Failed: ${r.error}`, true);
      ctx.peer.name = newName;
      return text(`Name set: "${newName}"`);
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
    requiresRegistration: true,
    async handler(args, ctx) {
      const summary = String(args.summary);
      const r = await ctx.broker.post("/set-summary", { id: ctx.peer.id as string, summary });
      if (!r.ok) return text(`Failed: ${r.error}`, true);
      ctx.peer.summary = summary;
      return text(`Summary updated: "${summary}"`);
    },
  },
  {
    name: "check_messages",
    description:
      "Read and acknowledge unread messages from other sessions (the text behind an unread notice). Safe to call any time.",
    inputSchema: { type: "object", properties: {} },
    requiresRegistration: true,
    async handler(_args, ctx) {
      const list = await ctx.inbox.checkMessages();
      if (list.length === 0) return text("No new messages.");
      return text(`${list.length} message(s):\n\n${list.map(formatMessage).join("\n\n---\n\n")}`);
    },
  },
  {
    name: "set_protocol",
    description:
      "Declare that this session serves a protocol: read protocol.json (and PROTOCOL.md) from a protocol repo, register the definition at the broker, and become findable with list_peers(protocol). Declaring a name again replaces its version. Public GitHub / Gitea repos and local paths only.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description:
            "Protocol repo: https://github.com/<owner>/<repo>, <owner>/<repo>, github:<owner>/<repo>, gitea:<base-url>/<owner>/<repo>, https://<gitea-host>/<owner>/<repo>, or a local path (/abs/path, ./rel/path, file:///abs/path).",
        },
        version: {
          type: "string",
          description: 'Tag to use, e.g. "1.2.0" or "v1.2.0". Default: the latest release tag (or the default branch head for a repo without tags). Ignored for local paths except as a check.',
        },
      },
      required: ["repo"],
    },
    requiresRegistration: true,
    handler(args, ctx) {
      return guarded(async () => {
        const info = await setProtocol(ctx, String(args.repo), args.version === undefined ? undefined : String(args.version));
        return text(`Protocol set: ${info.name}@${info.version} (sha256 ${info.hash.slice(0, 8)}…, from ${info.source})`);
      });
    },
  },
  {
    name: "unset_protocol",
    description: "Stop serving a protocol declared with set_protocol. Without a name, all protocols of this session are unset.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Protocol name to unset (default: all)" },
      },
    },
    requiresRegistration: true,
    handler(args, ctx) {
      return guarded(async () => {
        const name = args.name === undefined ? undefined : String(args.name);
        const removed = await unsetProtocol(ctx, name);
        if (removed === 0) return text("No protocol set.");
        return text(name === undefined ? `Protocol unset: (all, ${removed})` : `Protocol unset: ${name}`);
      });
    },
  },
  {
    name: "get_protocol",
    description:
      "Show the definition of a protocol held by the broker (protocol.json and PROTOCOL.md) so you can speak it. Latest version when version is omitted.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Protocol name (see list_peers)" },
        version: { type: "string", description: 'Version, e.g. "1.2.0" or "v1.2.0". Default: the latest the broker holds.' },
      },
      required: ["name"],
    },
    requiresRegistration: false,
    handler(args, ctx) {
      return guarded(async () => {
        const p = await getProtocol(
          ctx,
          String(args.name),
          args.version === undefined ? undefined : String(args.version)
        );
        const description = (p.manifest as { description?: unknown }).description;
        const lines = [
          `${p.name}@${p.version} (sha256 ${p.hash.slice(0, 8)}…, servers: ${p.servers})`,
          `Description: ${typeof description === "string" ? description : ""}`,
          "",
          "protocol.json:",
          JSON.stringify(p.manifest, null, 2),
          "",
          "PROTOCOL.md:",
          p.doc === "" ? "(none)" : p.doc,
        ];
        return text(lines.join("\n"));
      });
    },
  },
  {
    name: "get_broker",
    description:
      "Show which broker this session is connected to (url, id, version, mesh), where that choice came from (env, saved, discovery, fallback, set_broker), the saved broker, and the brokers that answer discovery right now.",
    inputSchema: { type: "object", properties: {} },
    requiresRegistration: false,
    handler(_args, ctx) {
      return guarded(async () => {
        if (!ctx.connection) return text("get_broker is not available in this host.", true);
        return text(formatBrokerInfo(await ctx.connection.get()));
      });
    },
  },
  {
    name: "set_broker",
    description:
      "Switch this session to another broker. Name, summary and protocol declarations carry over; unread messages stay readable with check_messages. The choice holds for this session and wins over AGENT_MESSENGER_HOST until the broker stays unreachable past the grace period. Without url the choice is dropped and the broker is resolved again.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Broker to use: host, host:port or http://host:port (default port 7901). Omit to drop the choice and resolve again.",
        },
        persist: {
          type: "boolean",
          description: "Also save the choice in the client state file for later sessions (with no url: remove the saved one).",
        },
      },
    },
    requiresRegistration: false,
    handler(args, ctx) {
      return guarded(async () => {
        if (!ctx.connection) return text("set_broker is not available in this host.", true);
        const url = args.url === undefined || args.url === "" ? undefined : String(args.url);
        const persist = args.persist === true || args.persist === "true";
        return text(formatBrokerInfo(await ctx.connection.set(url, persist)));
      });
    },
  },
];
