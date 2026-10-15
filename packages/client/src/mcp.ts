/**
 * SPIKE (spike/sdk-perry): MCP stdio server on `@modelcontextprotocol/sdk`
 * (`Server` + `StdioServerTransport`) instead of the hand-written JSON-RPC layer.
 *
 * Keeps the `createStdioServer` surface that client.ts uses, so client.ts is untouched.
 * Only `tools/list` and `tools/call` handlers are mapped to SDK request schemas.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";

export { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS };

export type RequestHandler = (params: unknown) => unknown | Promise<unknown>;

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpStdioServerOptions {
  serverInfo: McpServerInfo;
  capabilities: Record<string, unknown>;
  instructions?: string;
  /** Called when stdin closes. */
  onClose?: () => void;
  /** Called for transport / protocol errors. */
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

const SCHEMAS: Record<string, typeof ListToolsRequestSchema | typeof CallToolRequestSchema> = {
  "tools/list": ListToolsRequestSchema,
  "tools/call": CallToolRequestSchema,
};

export function createStdioServer(opts: McpStdioServerOptions): McpStdioServer {
  const server = new Server(opts.serverInfo, {
    capabilities: opts.capabilities,
    instructions: opts.instructions,
  });
  if (opts.onError) server.onerror = opts.onError;

  return {
    setRequestHandler(method, handler) {
      const schema = SCHEMAS[method];
      if (!schema) throw new Error(`spike: unsupported method ${method}`);
      server.setRequestHandler(schema, (req) => handler(req.params) as never);
    },
    notification(method, params) {
      return server.notification({ method, params: params as Record<string, unknown> });
    },
    connect() {
      const transport = new StdioServerTransport();
      server.connect(transport).catch((e: unknown) => opts.onError?.(e instanceof Error ? e : new Error(String(e))));
      // StdioServerTransport never reports stdin EOF; keep the old onClose contract.
      process.stdin.on("end", () => {
        if (opts.onClose) opts.onClose();
      });
    },
  };
}
