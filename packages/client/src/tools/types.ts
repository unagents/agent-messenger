import type { BrokerClient } from "../broker.js";
import type { Inbox } from "../inbox.js";
import type { PeerState } from "../peer.js";

/** JSON Schema subset used by the six tools. */
export interface JsonObjectSchema {
  type: "object";
  properties: Record<string, { type: "string"; enum?: string[]; description?: string }>;
  required?: string[];
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: true;
}

export interface ToolContext {
  broker: Pick<BrokerClient, "post">;
  peer: PeerState;
  inbox: Inbox;
}

export interface ToolDef {
  name: string;
  /** Plain description without the version prefix. */
  description: string;
  inputSchema: JsonObjectSchema;
  /** `false` only for list_peers. */
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
