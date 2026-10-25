import { describe, expect, it } from 'vitest'
import { createHooks } from 'hookable'
import type { InboundMessage, MessengerClient } from '@unagents/messenger-client'
import { createInbox } from '../../client/src/inbox'
import { listenerCount, startMessenger, watchListeners } from '../src/runtime/server/lib/lifecycle'

// SQ-1 (decided by w-cap/user): hook vs pull follows the listener set per delivery.
// The inbox here is the real `createInbox` of the client library; only the broker is faked.

type Hooks = { 'messenger:message': (m: InboundMessage) => void | Promise<void> }

interface Stored {
  id: number
  delivered: boolean
  acked: boolean
}

function setup() {
  const hooks = createHooks<Hooks>()
  const msgs = new Map<number, Stored & Record<string, unknown>>()
  const broker = {
    post: (async (path: string, body: { message_ids?: number[] }) => {
      if (path === '/poll-messages') {
        const out = [...msgs.values()].filter((m) => !m.delivered && !m.acked)
        for (const m of out) m.delivered = true
        return { messages: out.map(raw) }
      }
      if (path === '/get-buffered-messages') {
        return { messages: [...msgs.values()].filter((m) => m.delivered && !m.acked).map(raw) }
      }
      if (path === '/acknowledge-messages') {
        for (const id of body.message_ids ?? []) {
          const m = msgs.get(id)
          if (m) m.acked = true
        }
        return { ok: true }
      }
      if (path === '/list-peers') return []
      throw new Error(`unexpected ${path}`)
    }) as never,
  }
  const raw = (m: Stored & Record<string, unknown>) => {
    const { delivered: _d, acked: _a, ...rest } = m
    return rest
  }
  const peer = { id: 'p', name: 'me', summary: '', hostname: 'h', cwd: '/', gitRoot: null, tty: null }
  const inbox = createInbox({ broker, peer, log: () => {} })
  const client = {
    peer,
    async connect() {},
    async close() {},
    onMessage: inbox.onMessage,
    checkMessages: inbox.checkMessages,
  } as unknown as MessengerClient
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
  const send = (id: number, text = 't'): void => {
    msgs.set(id, { id, delivered: false, acked: false, from_id: 'x', from_name: 'x', to_id: 'p', text, mode: 'pull' })
  }
  const acked = () => [...msgs.values()].filter((m) => m.acked).map((m) => m.id)
  return { hooks, inbox, client, entry, send, acked }
}

describe('receive mode follows the listener set (SQ-1, real Inbox)', () => {
  it('no listener: a polled message is not acknowledged and stays pullable', async () => {
    const s = setup()
    await s.entry.ready
    s.send(1)
    await s.inbox.poll(false)
    expect(s.acked()).toEqual([])
    expect((await s.client.checkMessages()).map((m) => m.id)).toEqual([1])
    expect(s.acked()).toEqual([1])
    await s.entry.stop()
  })

  it('a listener attached after connect gets the next message through the hook (and the unread backlog)', async () => {
    const s = setup()
    await s.entry.ready
    s.send(1)
    await s.inbox.poll(false) // pull mode: buffered only
    expect(s.acked()).toEqual([])
    const seen: number[] = []
    s.hooks.hook('messenger:message', (m) => {
      seen.push(m.id)
    }) // attached late (a plugin that ran after ours)
    s.send(2)
    await s.inbox.poll(false)
    expect(seen).toEqual([1, 2]) // the backlog flows to the hook together with the new message
    expect(s.acked()).toEqual([1, 2])
    expect(await s.client.checkMessages()).toEqual([])
    await s.entry.stop()
  })

  it('removing the last listener returns to pull mode', async () => {
    const s = setup()
    await s.entry.ready
    const off = s.hooks.hook('messenger:message', () => {})
    off()
    s.send(3)
    await s.inbox.poll(false)
    expect(s.acked()).toEqual([])
    expect((await s.client.checkMessages()).map((m) => m.id)).toEqual([3])
    await s.entry.stop()
  })

  it('a listener that throws keeps the message unacknowledged and it is retried on the next poll', async () => {
    const s = setup()
    await s.entry.ready
    let fail = true
    const seen: number[] = []
    s.hooks.hook('messenger:message', (m) => {
      if (fail) {
        fail = false
        throw new Error('nope')
      }
      seen.push(m.id)
    })
    s.send(4)
    await s.inbox.poll(false)
    expect(s.acked()).toEqual([])
    await s.inbox.poll(false)
    expect(seen).toEqual([4])
    expect(s.acked()).toEqual([4])
    await s.entry.stop()
  })

  it('per delivery: a listener removed behind our back does not consume the message', async () => {
    const s = setup()
    s.hooks.hook('messenger:message', () => {})
    await s.entry.ready
    // bypass watchListeners: empty the table directly (like removeAllHooks would)
    const table = (s.hooks as unknown as { _hooks: Record<string, unknown[] | undefined> })._hooks
    delete table['messenger:message']
    s.send(5)
    await s.inbox.poll(false)
    expect(s.acked()).toEqual([])
    expect((await s.client.checkMessages()).map((m) => m.id)).toEqual([5])
    await s.entry.stop()
  })

  it('listeners added before connect finish are picked up at connect', async () => {
    const s = setup()
    const seen: number[] = []
    s.hooks.hook('messenger:message', (m) => {
      seen.push(m.id)
    })
    await s.entry.ready
    s.send(6)
    await s.inbox.poll(false)
    expect(seen).toEqual([6])
    await s.entry.stop()
  })

  it('no handler is registered after stop even if a listener appears', async () => {
    const s = setup()
    await s.entry.ready
    await s.entry.stop()
    s.hooks.hook('messenger:message', () => {})
    s.send(7)
    await s.inbox.poll(false)
    expect(s.acked()).toEqual([])
  })
})
