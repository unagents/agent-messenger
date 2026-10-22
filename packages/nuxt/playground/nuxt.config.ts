// Playground for @agent-hand/messenger-nuxt.
// PG_MCP=1       -> also load @nuxtjs/mcp-toolkit (adapter exposes the 6 tools on /mcp)
// PG_MCP_ORDER=after -> list the toolkit after this module (order check)
const withMcp = process.env.PG_MCP === '1'
const after = process.env.PG_MCP_ORDER === 'after'

export default defineNuxtConfig({
  modules: [
    ...(withMcp && !after ? ['@nuxtjs/mcp-toolkit'] : []),
    '../src/module',
    ...(withMcp && after ? ['@nuxtjs/mcp-toolkit'] : []),
  ],
  devtools: { enabled: false },
  telemetry: false,
  messenger: {
    name: 'nuxt-pg',
    summary: 'messenger-nuxt playground',
    brokers: ['http://127.0.0.1:17945'],
  },
  mcp: { name: 'messenger-nuxt-playground' },
  compatibilityDate: '2026-10-01',
})
