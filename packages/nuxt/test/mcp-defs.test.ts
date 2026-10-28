import { describe, expect, it } from 'vitest'
import { TOOL_DEFS, createToolRegistry, toolDescriptors } from '@unagents/messenger-client/tools'
import type { MessengerClient } from '@unagents/messenger-client'
import { toMcpToolDefinitions } from '../src/runtime/server/lib/mcp-defs'

interface Post {
  path: string
  body: unknown
}

function fakeClient(peerId: string | null = 'x'): { client: MessengerClient, posts: Post[] } {
  const posts: Post[] = []
  const broker = {
    post: (async (path: string, body: unknown) => {
      posts.push({ path, body })
      if (path === '/send-message') return { ok: true, to_id: 'y', to_name: 'yy', message_id: 1 }
      return []
    }) as never,
  }
  const peer = { id: peerId, name: 'me', summary: '', hostname: 'h', cwd: '/', gitRoot: null, tty: null }
  const inbox = { poll: async () => {}, checkMessages: async () => [], onMessage: () => () => {}, stop: () => {} }
  const registry = createToolRegistry({ broker, peer, inbox })
  return { client: { registry } as unknown as MessengerClient, posts }
}

describe('toMcpToolDefinitions', () => {
  it('maps the nine tools in order with title / description from toolDescriptors()', () => {
    const defs = toMcpToolDefinitions(() => undefined)
    const desc = toolDescriptors()
    expect(defs.map((d) => d.name)).toEqual(TOOL_DEFS.map((d) => d.name))
    expect(defs).toHaveLength(9)
    defs.forEach((d, i) => {
      expect(d.title).toBe(desc[i].annotations.title)
      expect(d.annotations).toEqual({ title: desc[i].annotations.title })
      expect(d.description).toBe(desc[i].description)
      expect(d.description.startsWith('[agent-messenger v')).toBe(true)
    })
  })

  it('exposes the nine tools by name, in order', () => {
    expect(toMcpToolDefinitions(() => undefined).map((d) => d.name)).toEqual([
      'list_peers',
      'send_message',
      'send_ping',
      'set_name',
      'set_summary',
      'check_messages',
      'set_protocol',
      'unset_protocol',
      'get_protocol',
    ])
  })

  it('send_message.meta is an object in the input schema', () => {
    const send = toMcpToolDefinitions(() => undefined).find((d) => d.name === 'send_message')!
    expect(Object.keys(send.inputSchema)).toEqual(['to', 'message', 'delivery', 'meta'])
    expect(send.inputSchema.meta.safeParse({ protocol: 'p', version: '1' }).success).toBe(true)
    expect(send.inputSchema.meta.safeParse({ protocol: 'p' }).success).toBe(false)
  })

  it('delegates to registry.call', async () => {
    const { client, posts } = fakeClient()
    const defs = toMcpToolDefinitions(() => client)
    const send = defs.find((d) => d.name === 'send_message')!
    const r = await send.handler({ to: 'y', message: 'hi' })
    expect(r.isError).toBeUndefined()
    expect(r.content[0].text).toBe('Message sent to yy (y) (delivery: pull).')
    expect(posts).toHaveLength(1)
    expect(posts[0].path).toBe('/send-message')
  })

  it('returns the exact Invalid delivery text and does not post', async () => {
    const { client, posts } = fakeClient()
    const send = toMcpToolDefinitions(() => client).find((d) => d.name === 'send_message')!
    const r = await send.handler({ to: 'y', message: 'hi', delivery: 'bogus' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe('Invalid delivery: bogus (use "pull" or "push")')
    expect(posts).toHaveLength(0)
  })

  it('answers "Not registered with broker yet" without a client', async () => {
    const defs = toMcpToolDefinitions(() => undefined)
    for (const d of defs) {
      const r = await d.handler({})
      expect(r.isError).toBe(true)
      expect(r.content[0].text).toBe('Not registered with broker yet')
    }
  })

  it('evaluates getClient on every call', async () => {
    let current: MessengerClient | undefined
    const send = toMcpToolDefinitions(() => current).find((d) => d.name === 'check_messages')!
    expect((await send.handler({})).isError).toBe(true)
    current = fakeClient().client
    expect((await send.handler({})).isError).toBeUndefined()
  })
})
