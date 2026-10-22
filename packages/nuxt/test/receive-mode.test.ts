import { describe, expect, it } from 'vitest'
import { createHooks } from 'hookable'
import type { InboundMessage, MessengerClient } from '@agent-hand/messenger-client'
import { listenerCount, startMessenger, watchListeners } from '../src/runtime/server/lib/lifecycle'

// SQ-1 (decided by w-cap/user): hook vs pull is decided on every delivery, not at first connect.
// The fake client mimics the library inbox: with a handler registered every message goes to the
// handler (consumed, acked on success); without one it stays buffered for checkMessages().

type Hooks = { 'messenger:message': (m: InboundMessage) => void | Promise<void> }

function setup() {
  const hooks = createHooks<Hooks>()
  const handlers: ((m: InboundMessage) => void | Promise<void>)[] = []
  const buffer: InboundMessage[] = []
  const acked: number[] = []
  const client = {
    peer: { id: 'p' },
    async connect() {},
    async close() {},
    onMessage(h: (m: InboundMessage) => void | Promise<void>) {
      handlers.push(h)
      return () => {
        handlers.splice(handlers.indexOf(h), 1)
      }
    },
    async checkMessages() {
      const out = buffer.splice(0)
      acked.push(...out.map((m) => m.id))
      return out
    },
  } as unknown as MessengerClient
  const deliver = async (m: InboundMessage): Promise<void> => {
    if (handlers.length === 0) {
      buffer.push(m)
      return
    }
    try {
      for (const h of handlers.slice()) await h(m)
      acked.push(m.id)
    }
    catch {
      buffer.push(m) // kept for the next tick (library: retry); enough for this model
    }
  }
  const entry = startMessenger({
    options: {},
    create: () => client,
    forward: (m) => hooks.callHook('messenger:message', m),
    hasListeners: () => listenerCount(hooks, 'messenger:message') > 0,
    watchListeners: (cb) => watchListeners(hooks, cb),
    log: () => {},
    retryMs: 5,
    global: {},
  })
  return { hooks, handlers, buffer, acked, client, deliver, entry }
}

const msg = (id: number, text = 't'): InboundMessage => ({ id, text, mode: 'pull' }) as unknown as InboundMessage

describe('receive mode follows the listener set (SQ-1)', () => {
  it('no listener: the message is not consumed and stays pullable', async () => {
    const s = setup()
    await s.entry.ready
    expect(s.handlers).toHaveLength(0)
    await s.deliver(msg(1))
    expect(s.acked).toEqual([])
    const pulled = await s.client.checkMessages()
    expect(pulled.map((m) => m.id)).toEqual([1])
    await s.entry.stop()
  })

  it('a listener registered after connect receives the next message through the hook', async () => {
    const s = setup()
    await s.entry.ready
    await s.deliver(msg(1)) // no listener yet -> pull
    const seen: number[] = []
    s.hooks.hook('messenger:message', (m) => {
      seen.push(m.id)
    }) // attached late (e.g. a plugin that ran after ours)
    expect(s.handlers).toHaveLength(1)
    await s.deliver(msg(2))
    expect(seen).toEqual([2])
    expect(s.acked).toEqual([2])
    expect((await s.client.checkMessages()).map((m) => m.id)).toEqual([1])
    await s.entry.stop()
  })

  it('removing the last listener returns to pull mode', async () => {
    const s = setup()
    await s.entry.ready
    const off = s.hooks.hook('messenger:message', () => {})
    expect(s.handlers).toHaveLength(1)
    off()
    expect(s.handlers).toHaveLength(0)
    await s.deliver(msg(3))
    expect((await s.client.checkMessages()).map((m) => m.id)).toEqual([3])
    await s.entry.stop()
  })

  it('a listener that throws keeps the message (not acked)', async () => {
    const s = setup()
    await s.entry.ready
    s.hooks.hook('messenger:message', () => {
      throw new Error('nope')
    })
    await s.deliver(msg(4))
    expect(s.acked).toEqual([])
    await s.entry.stop()
  })

  it('listeners added before connect finish are picked up at connect', async () => {
    const s = setup()
    s.hooks.hook('messenger:message', () => {})
    await s.entry.ready
    expect(s.handlers).toHaveLength(1)
    await s.entry.stop()
  })

  it('no handler is registered after stop even if a listener appears', async () => {
    const s = setup()
    await s.entry.ready
    await s.entry.stop()
    s.hooks.hook('messenger:message', () => {})
    expect(s.handlers).toHaveLength(0)
  })
})
