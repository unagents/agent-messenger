import type { z } from 'zod'
import type { MessengerClient } from '@agent-hand/messenger-client'
import { toolDescriptors } from '@agent-hand/messenger-client/tools'
import type { ToolResult } from '@agent-hand/messenger-client/tools'
import { jsonSchemaToZodShape } from './zod-shape'

export interface McpToolDefinitionInput {
  name: string
  title: string
  description: string
  annotations: { title: string }
  inputSchema: Record<string, z.ZodType>
  handler: (args: Record<string, unknown>) => Promise<ToolResult>
}

/**
 * Map the six shared tool definitions to the shape `defineMcpTool` of @nuxtjs/mcp-toolkit takes.
 * `getClient` is evaluated on every call so a reloaded worker uses its current client.
 * Unregistered guard, unknown tool and the `Error (<name>): ...` wrapping come from the registry.
 */
export function toMcpToolDefinitions(getClient: () => MessengerClient | undefined): McpToolDefinitionInput[] {
  return toolDescriptors().map((d) => ({
    name: d.name,
    title: d.annotations.title,
    description: d.description,
    annotations: { title: d.annotations.title },
    inputSchema: jsonSchemaToZodShape(d.inputSchema),
    handler: async (args) => {
      const c = getClient()
      if (!c) return { content: [{ type: 'text', text: 'Not registered with broker yet' }], isError: true }
      return c.registry.call(d.name, args ?? {})
    },
  }))
}
