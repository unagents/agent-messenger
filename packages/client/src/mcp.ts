/**
 * Minimal MCP stdio server: newline-delimited JSON-RPC 2.0 over stdin/stdout.
 *
 * Replaces `@modelcontextprotocol/sdk` (`Server` + `StdioServerTransport`) with
 * the subset agent-messenger uses, keeping the SDK's observable behaviour
 * (measured against SDK 1.30.1):
 *
 * - one JSON object per `\n`-terminated line; a trailing `\r` is stripped
 * - unparsable / malformed lines are ignored (no response)
 * - unknown request method → `{"code":-32601,"message":"Method not found"}`
 * - handler exception → `code` = numeric `error.code` if a safe integer, else `-32603`
 * - `initialize` echoes the requested `protocolVersion` when supported, else the latest
 * - `ping` → `{}`; `notifications/initialized` and other notifications are ignored
 * - responses / errors from the peer are ignored (the server never sends requests)
 */

export const LATEST_PROTOCOL_VERSION = "2025-11-25";
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type RequestHandler = (params: unknown) => unknown | Promise<unknown>;

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpStdioServerOptions {
  serverInfo: McpServerInfo;
  capabilities: Record<string, unknown>;
  instructions?: string;
  /** Called with a received `initialize` request's params. */
  onInitialize?: (params: unknown) => void;
  /** Called when stdin closes. */
  onClose?: () => void;
  /** Called for ignored malformed input and write failures. */
  onError?: (err: Error) => void;
}

export interface McpStdioServer {
  /** Register a request handler; the result becomes the JSON-RPC `result`. */
  setRequestHandler(method: string, handler: RequestHandler): void;
  /** Send a notification to the peer. */
  notification(method: string, params: unknown): Promise<void>;
  /** Start reading stdin. */
  connect(): void;
}

interface ErrorLike {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

export function createStdioServer(opts: McpStdioServerOptions): McpStdioServer {
  const handlers = new Map<string, RequestHandler>();
  const onError = opts.onError ?? (() => {});

  const write = (msg: unknown): Promise<void> =>
    new Promise<void>((resolve) => {
      const line = JSON.stringify(msg) + "\n";
      const flushed = process.stdout.write(line, (err?: Error | null) => {
        if (err) onError(err);
      });
      if (flushed) resolve();
      else process.stdout.once("drain", () => resolve());
    });

  const sendResult = (id: JsonRpcId, result: unknown) => write({ jsonrpc: "2.0", id, result });
  const sendError = (id: JsonRpcId, code: number, message: string, data?: unknown) =>
    write({ jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } });

  // Built-in handlers (SDK `Server` / `Protocol` defaults).
  handlers.set("initialize", (params: unknown) => {
    const p = (params ?? {}) as { protocolVersion?: unknown };
    const requested = typeof p.protocolVersion === "string" ? p.protocolVersion : "";
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
    if (opts.onInitialize) opts.onInitialize(params);
    const result: Record<string, unknown> = {
      protocolVersion,
      capabilities: opts.capabilities,
      serverInfo: opts.serverInfo,
    };
    if (opts.instructions) result.instructions = opts.instructions;
    return result;
  });
  handlers.set("ping", () => ({}));

  const dispatchRequest = (req: JsonRpcRequest) => {
    const handler = handlers.get(req.method);
    if (!handler) {
      sendError(req.id, -32601, "Method not found").catch(onError);
      return;
    }
    Promise.resolve()
      .then(() => handler(req.params))
      .then(
        (result) => sendResult(req.id, result),
        (err: unknown) => {
          const e = (err ?? {}) as ErrorLike;
          const code = typeof e.code === "number" && Number.isSafeInteger(e.code) ? e.code : -32603;
          const message = typeof e.message === "string" ? e.message : "Internal error";
          return sendError(req.id, code, message, e.data);
        }
      )
      .catch(onError);
  };

  const handleLine = (raw: string) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      onError(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    if (typeof msg !== "object" || msg === null) {
      onError(new Error("invalid JSON-RPC message"));
      return;
    }
    const m = msg as Record<string, unknown>;
    if (m.jsonrpc !== "2.0") {
      onError(new Error("invalid JSON-RPC message"));
      return;
    }
    const hasId = typeof m.id === "number" || typeof m.id === "string";
    if (typeof m.method === "string") {
      if (hasId) dispatchRequest(m as unknown as JsonRpcRequest);
      // notifications: nothing subscribed (initialized / cancelled / progress are no-ops)
      return;
    }
    // response or error to a request we never sent: ignore
  };

  return {
    setRequestHandler(method, handler) {
      handlers.set(method, handler);
    },
    notification(method, params) {
      const n: JsonRpcNotification = { jsonrpc: "2.0", method, params };
      return write(n);
    },
    connect() {
      let buf = "";
      process.stdin.setEncoding("utf8");
      // Read stdin with `for await` rather than `on("data")`. In node the two are
      // equivalent, but on the PerryTS native runtime `data` listeners are only pumped
      // when the event loop wakes (1 s idle cap), so every request could wait up to
      // ~1 s; the async iterator resumes as soon as bytes arrive (measured ~1 ms).
      // See reports/20260928-ts-05-stdin.md.
      const read = async () => {
        try {
          for await (const chunk of process.stdin) {
            buf += chunk as string;
            let i: number;
            while ((i = buf.indexOf("\n")) !== -1) {
              const line = buf.slice(0, i);
              buf = buf.slice(i + 1);
              handleLine(line);
            }
          }
        } catch (e) {
          onError(e instanceof Error ? e : new Error(String(e)));
        }
        if (opts.onClose) opts.onClose();
      };
      read().catch(onError);
    },
  };
}
