import type { BrokerClient } from "../broker.js";
import type { Inbox } from "../inbox.js";
import type { PeerState } from "../peer.js";
import type { ProtocolState } from "../protocols.js";

/** JSON Schema subset used by the tools: string properties, and one level of object (`send_message` `meta`). */
export interface JsonPropertySchema {
  type: "string" | "object";
  enum?: string[];
  description?: string;
  properties?: Record<string, { type: "string"; description?: string }>;
  required?: string[];
}

export interface JsonObjectSchema {
  type: "object";
  properties: Record<string, JsonPropertySchema>;
  required?: string[];
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: true;
}

export interface ToolContext {
  /** `health` is only used to name the broker version in BROKER_UNSUPPORTED. */
  broker: Pick<BrokerClient, "post"> & Partial<Pick<BrokerClient, "health">>;
  peer: PeerState;
  inbox: Inbox;
  protocols: ProtocolState;
}

export interface ToolDef {
  name: string;
  /** Plain description without the version prefix. */
  description: string;
  inputSchema: JsonObjectSchema;
  /** `false` for list_peers and get_protocol. */
  requiresRegistration: boolean;
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
  annotations: { title: string };
}

export interface ToolRegistry {
  list(): ToolDescriptor[];
  call(name: string, args: Record<string, unknown> | undefined): Promise<ToolResult>;
}
