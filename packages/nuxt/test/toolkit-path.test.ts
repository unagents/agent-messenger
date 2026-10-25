import { afterEach, describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { defineMcpTool, registerToolFromDefinition } from '@nuxtjs/mcp-toolkit/server'
import { createToolRegistry } from '@unagents/messenger-client/tools'
import type { MessengerClient } from '@unagents/messenger-client'
import { toMcpToolDefinitions } from '../src/runtime/server/lib/mcp-defs'

// Registers the adapter's definitions through the toolkit's own registration code
// (registerToolFromDefinition -> SDK McpServer), then calls them over an in-memory transport.

const posts: { path: string, body: unknown }[] = []

function makeClient(): MessengerClient {
  const broker = {
    post: (async (path: string, body: unknown) => {
      posts.push({ path, body })
      if (path === '/send-message') return { ok: true, to_id: 'y', to_name: 'yy', message_id: 1 }
      return []
    }) as never,
  }
  const peer = { id: 'x', name: 'me', summary: '', hostname: 'h', cwd: '/', gitRoot: null, tty: null }
  const inbox = { poll: async () => {}, checkMessages: async () => [], onMessage: () => () => {}, stop: () => {} }
  return { registry: createToolRegistry({ broker, peer, inbox }) } as unknown as MessengerClient
}

let closers: (() => Promise<void>)[] = []

async function connect(): Promise<Client> {
  const server = new McpServer({ name: 't', version: '0' })
  const client = makeClient()
  for (const d of toMcpToolDefinitions(() => client)) registerToolFromDefinition(server, defineMcpTool(d))
  const [a, b] = InMemoryTransport.createLinkedPair()
  const c = new Client({ name: 'c', version: '0' })
  await server.connect(a)
  await c.connect(b)
  closers.push(() => c.close(), () => server.close())
  return c
}

afterEach(async () => {
  for (const f of closers) await f()
  closers = []
  posts.length = 0
})

describe('toolkit registration path', () => {
  it('tools/list shows the six tools, delivery without enum', async () => {
    const c = await connect()
    const { tools } = await c.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['check_messages', 'list_peers', 'send_message', 'send_ping', 'set_name', 'set_summary'])
    const send = tools.find((t) => t.name === 'send_message')!
    const props = send.inputSchema.properties as Record<string, { type?: string, enum?: unknown }>
    expect(props.delivery.type).toBe('string')
    expect(props.delivery.enum).toBeUndefined()
    expect(send.title).toMatch(/^send_message \(v/)
    const check = tools.find((t) => t.name === 'check_messages')!
    expect(check.inputSchema.type).toBe('object')
  })

  it('a bad delivery returns the exact Invalid delivery text (not a zod error)', async () => {
    const c = await connect()
    const r = await c.callTool({ name: 'send_message', arguments: { to: 'y', message: 'hi', delivery: 'bogus' } })
    expect(r.isError).toBe(true)
    expect(r.content).toEqual([{ type: 'text', text: 'Invalid delivery: bogus (use "pull" or "push")' }])
    expect(posts).toHaveLength(0)
  })

  it('a valid send reaches the broker', async () => {
    const c = await connect()
    const r = await c.callTool({ name: 'send_message', arguments: { to: 'y', message: 'hi', delivery: 'push' } })
    expect(r.isError).toBeFalsy()
    expect(posts.map((p) => p.path)).toEqual(['/send-message'])
  })

  it('check_messages (empty shape) is callable', async () => {
    const c = await connect()
    const r = await c.callTool({ name: 'check_messages', arguments: {} })
    expect(r.isError).toBeFalsy()
  })
})
