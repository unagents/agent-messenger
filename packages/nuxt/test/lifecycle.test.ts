import { describe, expect, it } from 'vitest'
import type { InboundMessage, MessengerClient } from '@unagents/messenger-client'
import { getStore, listenerCount, selectReceiveMode, startMessenger, waitReady } from '../src/runtime/server/lib/lifecycle'

interface Fake {
  client: MessengerClient
  events: string[]
  handlers: ((m: InboundMessage) => void | Promise<void>)[]
  connects: () => number
}

function fake(name: string, opts: { failConnects?: number, events?: string[], closeDelayMs?: number } = {}): Fake {
  const events = opts.events ?? []
  const handlers: Fake['handlers'] = []
  let connects = 0
  let failLeft = opts.failConnects ?? 0
  const client = {
    peer: { id: `${name}-id` },
    async connect() {
      connects++
      events.push(`${name}:connect`)
      if (failLeft > 0) {
        failLeft--
        throw new Error('down')
      }
    },
    async close() {
      if (opts.closeDelayMs) await new Promise((r) => setTimeout(r, opts.closeDelayMs))
      events.push(`${name}:close`)
    },
    onMessage(h: Fake['handlers'][number]) {
      handlers.push(h)
      return () => {
        handlers.splice(handlers.indexOf(h), 1)
      }
    },
  } as unknown as MessengerClient
  return { client, events, handlers, connects: () => connects }
}

const base = () => ({
  options: {},
  forward: async () => {},
  hasListeners: () => true,
  log: () => {},
  retryMs: 10,
  global: {},
})

describe('startMessenger', () => {
  it('retries the first connect until it succeeds', async () => {
    const f = fake('a', { failConnects: 2 })
    const logs: string[] = []
    const e = startMessenger({ ...base(), create: () => f.client, log: (m) => logs.push(m) })
    await e.ready
    expect(f.connects()).toBe(3)
    expect(e.connected()).toBe(true)
    expect(logs.filter((l) => l.startsWith('connect failed'))).toHaveLength(2)
    expect(logs.some((l) => l.includes('connected as a-id (mode: hook)'))).toBe(true)
    await e.stop()
  })

  it('stop() ends the retry loop', async () => {
    const f = fake('a', { failConnects: 1000 })
    const e = startMessenger({ ...base(), create: () => f.client, retryMs: 5 })
    await new Promise((r) => setTimeout(r, 30))
    await e.stop()
    await e.ready
    const n = f.connects()
    await new Promise((r) => setTimeout(r, 40))
    expect(f.connects()).toBe(n)
    expect(e.connected()).toBe(false)
  })

  it('stop() wakes a long retry sleep immediately', async () => {
    const f = fake('a', { failConnects: 1000 })
    const e = startMessenger({ ...base(), create: () => f.client, retryMs: 60_000 })
    await new Promise((r) => setTimeout(r, 20))
    const t0 = Date.now()
    await e.stop()
    await e.ready
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('stop() is idempotent and empties the store', async () => {
    const g = {}
    const f = fake('a')
    const e = startMessenger({ ...base(), global: g, create: () => f.client })
    await e.ready
    expect(getStore(g).current).toBe(e)
    const p1 = e.stop()
    const p2 = e.stop()
    expect(p2).toBe(p1)
    await p1
    expect(f.events.filter((x) => x === 'a:close')).toHaveLength(1)
    expect(getStore(g).current).toBeUndefined()
  })

  it('a second start in the same global closes the old client before connecting the new one', async () => {
    const g = {}
    const events: string[] = []
    const a = fake('a', { events, closeDelayMs: 30 })
    const b = fake('b', { events })
    const ea = startMessenger({ ...base(), global: g, create: () => a.client })
    await ea.ready
    const eb = startMessenger({ ...base(), global: g, create: () => b.client })
    await eb.ready
    expect(events).toEqual(['a:connect', 'a:close', 'b:connect'])
    expect(getStore(g).current).toBe(eb)
    await ea.stop()
    expect(getStore(g).current).toBe(eb)
    await eb.stop()
  })

  it('hook mode: registers onMessage when a listener exists (D3)', async () => {
    const f = fake('a')
    const e = startMessenger({ ...base(), create: () => f.client, hasListeners: () => true })
    await e.ready
    expect(f.handlers).toHaveLength(1)
    await e.stop()
    expect(f.handlers).toHaveLength(0)
  })

  it('pull mode: does not register onMessage without a listener (D3)', async () => {
    const f = fake('a')
    const logs: string[] = []
    const e = startMessenger({ ...base(), create: () => f.client, hasListeners: () => false, log: (m) => logs.push(m) })
    await e.ready
    expect(f.handlers).toHaveLength(0)
    expect(logs.some((l) => l.includes('(mode: pull)'))).toBe(true)
    await e.stop()
  })

  it('forwards inbound messages to the hook relay', async () => {
    const f = fake('a')
    const got: InboundMessage[] = []
    const e = startMessenger({ ...base(), create: () => f.client, forward: async (m) => { got.push(m) } })
    await e.ready
    const m = { id: 1, text: 'x' } as unknown as InboundMessage
    await f.handlers[0](m)
    expect(got).toEqual([m])
    await e.stop()
  })

  it('selectReceiveMode follows hasListeners', () => {
    expect(selectReceiveMode(() => true)).toBe(true)
    expect(selectReceiveMode(() => false)).toBe(false)
  })
})

describe('waitReady', () => {
  it('returns at once when connected', async () => {
    const f = fake('a')
    const e = startMessenger({ ...base(), create: () => f.client })
    await e.ready
    await expect(waitReady(e, 5)).resolves.toBeUndefined()
    await e.stop()
  })

  it('throws "Not connected to broker yet" after the timeout', async () => {
    const f = fake('a', { failConnects: 1000 })
    const e = startMessenger({ ...base(), create: () => f.client, retryMs: 5 })
    await expect(waitReady(e, 30)).rejects.toThrow('Not connected to broker yet')
    await e.stop()
  })

  it('throws after stop even when ready resolved', async () => {
    const f = fake('a')
    const e = startMessenger({ ...base(), create: () => f.client })
    await e.ready
    await e.stop()
    await expect(waitReady(e, 10)).rejects.toThrow('Not connected to broker yet')
  })
})

describe('listenerCount', () => {
  it('reads _hooks and falls back to 0 (pull) when unknown', () => {
    expect(listenerCount({ _hooks: { x: [() => {}, () => {}] } }, 'x')).toBe(2)
    expect(listenerCount({ _hooks: {} }, 'x')).toBe(0)
    expect(listenerCount({}, 'x')).toBe(0)
  })
})
