import { defineNitroPlugin } from 'nitropack/runtime'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { toMcpToolDefinitions } from '../lib/mcp-defs'
import { getStore } from '../lib/lifecycle'

// Registered by the module only when @nuxtjs/mcp-toolkit is in `modules`.
export default defineNitroPlugin((nitroApp) => {
  const defs = toMcpToolDefinitions(() => getStore().current?.client).map((d) => defineMcpTool(d))
  nitroApp.hooks.hook('mcp:config:resolved', ({ config }) => {
    const have = new Set(config.tools.map((t) => t.name))
    for (const d of defs) {
      if (!have.has(d.name)) config.tools.push(d)
    }
  })
})
