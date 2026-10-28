import { createProtocolState } from "../protocols.js";
import { VERSION } from "../version.js";
import { TOOL_DEFS } from "./defs.js";
import type { ToolContext, ToolDef, ToolDescriptor, ToolRegistry, ToolResult } from "./types.js";

function text(t: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text: t }], isError: true } : { content: [{ type: "text", text: t }] };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Every tool carries the version: `annotations.title` (`<name> (v<VERSION>)`) is what the
 * `/mcp` → View tools list shows, and the description starts with it too.
 * Key order is fixed (name, description, inputSchema, annotations).
 */
export function toolDescriptors(defs: readonly ToolDef[] = TOOL_DEFS): ToolDescriptor[] {
  return defs.map((d) => ({
    name: d.name,
    description: `[agent-messenger v${VERSION}] ${d.description}`,
    inputSchema: d.inputSchema,
    annotations: { title: `${d.name} (v${VERSION})` },
  }));
}

export const TOOLS: ToolDescriptor[] = toolDescriptors();

export function createToolRegistry(
  input: Omit<ToolContext, "protocols"> & { protocols?: ToolContext["protocols"] },
  defs: readonly ToolDef[] = TOOL_DEFS
): ToolRegistry {
  const ctx: ToolContext = { ...input, protocols: input.protocols ?? createProtocolState() };
  return {
    list: () => toolDescriptors(defs),
    async call(name, args) {
      const def = defs.find((d) => d.name === name);
      if (!ctx.peer.id && (def === undefined || def.requiresRegistration)) return text("Not registered with broker yet", true);
      if (def === undefined) return text(`Unknown tool: ${name}`, true);
      try {
        return await def.handler(args ?? {}, ctx);
      } catch (e) {
        return text(`Error (${name}): ${errorMessage(e)}`, true);
      }
    },
  };
}
