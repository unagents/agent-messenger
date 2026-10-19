import type { ClientConfig } from "../config.js";
import type { InboundMessage, Notifier } from "../inbox.js";
import { createStdioServer } from "../mcp.js";
import type { Logger } from "../resolve.js";
import { postToSession } from "../session.js";
import type { ToolRegistry, ToolResult } from "../tools/types.js";
import { INSTRUCTIONS } from "../tools/defs.js";
import { VERSION } from "../version.js";

export const CAPABILITIES = {
  experimental: { "claude/channel": {} },
  tools: {},
};

export interface StdioHost {
  notifier: Notifier;
  /** Register tools/list and tools/call on top of the registry. */
  attach(registry: ToolRegistry): void;
  /** Start reading stdin. */
  connect(): void;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function senderLabel(entry: InboundMessage): string {
  return `${entry.from_name || entry.from_id}${entry.from_hostname ? `@${entry.from_hostname}` : ""}`;
}

function channelMeta(entry: InboundMessage) {
  return {
    from_id: entry.from_id,
    from_name: entry.from_name,
    from_hostname: entry.from_hostname,
    from_summary: entry.from_summary,
    from_cwd: entry.from_cwd,
    sent_at: entry.sent_at,
  };
}

export function createStdioHost(opts: { cfg: ClientConfig; log: Logger; onClose: () => void }): StdioHost {
  const { cfg, log } = opts;
  const mcp = createStdioServer({
    serverInfo: { name: "agent-messenger", version: VERSION },
    capabilities: CAPABILITIES,
    instructions: INSTRUCTIONS,
    onClose: opts.onClose,
  });

  const notifier: Notifier = {
    /**
     * body=pull: put one unread notice into the session (session socket → channel).
     * The text stays unacknowledged at the broker until `check_messages`.
     */
    async unread(latest: InboundMessage, count: number): Promise<boolean> {
      const who = senderLabel(latest);
      const notice = `[agent-messenger] 未読 ${count} 件（from ${who}）。check_messages で受信してください`;
      let delivered = false;
      const useSocket = cfg.delivery === "socket" || (cfg.delivery === "auto" && cfg.sessionSocket);
      if (useSocket) {
        try {
          await postToSession(cfg.sessionSocket, cfg.sessionToken, notice);
          log(`Session socket unread notice OK (${count}) from ${who}`);
          delivered = true;
        } catch (e) {
          log(`Session socket unread notice FAILED from ${latest.from_id}: ${errorMessage(e)} — trying channel`);
        }
      }
      if (!delivered) {
        try {
          await mcp.notification("notifications/claude/channel", { content: notice, meta: channelMeta(latest) });
          log(`Channel unread notice OK (${count}) from ${who}`);
          delivered = true;
        } catch (e) {
          log(`Channel unread notice FAILED from ${latest.from_id}: ${errorMessage(e)}`);
        }
      }
      return delivered;
    },

    /**
     * mode=ping: put a one-line ping notice into the session (session socket →
     * channel), with the subject (message text) when given.
     */
    async ping(entry: InboundMessage): Promise<void> {
      const who = senderLabel(entry);
      const notice = `[agent-messenger] ping（from ${who}）${entry.text ? `: ${entry.text}` : ""}`;
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
    },

    /** mode=push: deliver the text (session socket → channel). true = delivered. */
    async push(entry: InboundMessage): Promise<boolean> {
      const useSocket = cfg.delivery === "socket" || (cfg.delivery === "auto" && cfg.sessionSocket);
      if (useSocket) {
        try {
          const who = `${entry.from_name || entry.from_id}${entry.from_hostname ? `@${entry.from_hostname}` : ""}`;
          const replyTo = entry.from_name || entry.from_id;
          await postToSession(
            cfg.sessionSocket,
            cfg.sessionToken,
            `[agent-messenger] message from ${who}\n${entry.text}\n\n(reply with the agent-messenger send_message tool, to: "${replyTo}")`
          );
          log(`Session socket delivery OK from ${who}: ${entry.text.slice(0, 80)}`);
          return true;
        } catch (e) {
          log(`Session socket delivery FAILED from ${entry.from_id}: ${errorMessage(e)} — trying channel`);
        }
      }

      try {
        await mcp.notification("notifications/claude/channel", {
          content: entry.text,
          meta: {
            from_id: entry.from_id,
            from_name: entry.from_name,
            from_hostname: entry.from_hostname,
            from_summary: entry.from_summary,
            from_cwd: entry.from_cwd,
            sent_at: entry.sent_at,
          },
        });
        log(`Channel push OK from ${entry.from_name || entry.from_id}: ${entry.text.slice(0, 80)}`);
        return true;
      } catch (e) {
        log(`Channel push FAILED from ${entry.from_id}: ${errorMessage(e)}`);
      }
      return false;
    },
  };

  return {
    notifier,
    attach(registry: ToolRegistry) {
      mcp.setRequestHandler("tools/list", () => ({ tools: registry.list() }));
      mcp.setRequestHandler("tools/call", async (params: unknown): Promise<ToolResult> => {
        const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        return registry.call(p.name ?? "", p.arguments ?? {});
      });
    },
    connect() {
      mcp.connect();
    },
  };
}
