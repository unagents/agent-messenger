import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MessengerClient } from '@unagents/messenger-client'
import { getStore } from '../src/runtime/server/lib/lifecycle'
import type { MessengerEntry } from '../src/runtime/server/lib/lifecycle'
import { useMessenger } from '../src/runtime/server/utils/useMessenger'

const calls: { fn: string, args: unknown[] }[] = []

function fakeClient(): MessengerClient {
  const rec = (fn: string) => async (...args: unknown[]) => {
    calls.push({ fn, args })
    return { fn }
  }
  return {
    send: rec('send'),
    ping: rec('ping'),
    listPeers: rec('listPeers'),
    setName: rec('setName'),
    setSummary: rec('setSummary'),
    checkMessages: rec('checkMessages'),
    setProtocol: rec('setProtocol'),
    unsetProtocol: rec('unsetProtocol'),
    getProtocol: rec('getProtocol'),
    getBroker: rec('getBroker'),
    setBroker: rec('setBroker'),
  } as unknown as MessengerClient
}

let saved: MessengerEntry | undefined

beforeEach(() => {
  saved = getStore().current
  calls.length = 0
  getStore().current = {
    client: fakeClient(),
    ready: Promise.resolve(),
    connected: () => true,
    refresh: () => {},
    stop: async () => {},
  }
})

afterEach(() => {
  getStore().current = saved
})

describe('useMessenger protocol API', () => {
  it('passes meta through send', async () => {
    const meta = { protocol: 'p', version: '1.0.0' }
    await useMessenger().send('x', 'hi', 'push', meta)
    expect(calls).toEqual([{ fn: 'send', args: ['x', 'hi', 'push', meta] }])
  })

  it('passes the protocol filter through listPeers', async () => {
    await useMessenger().listPeers('repo', { protocol: 'p', version: '1.0.0' })
    expect(calls).toEqual([{ fn: 'listPeers', args: ['repo', { protocol: 'p', version: '1.0.0' }] }])
  })

  it('delegates setProtocol / unsetProtocol / getProtocol', async () => {
    const m = useMessenger()
    await m.setProtocol('github:o/r', 'v1.0.0')
    await m.unsetProtocol('p')
    await m.unsetProtocol()
    await m.getProtocol('p', '1.0.0')
    expect(calls).toEqual([
      { fn: 'setProtocol', args: ['github:o/r', 'v1.0.0'] },
      { fn: 'unsetProtocol', args: ['p'] },
      { fn: 'unsetProtocol', args: [undefined] },
      { fn: 'getProtocol', args: ['p', '1.0.0'] },
    ])
  })

  it('delegates getBroker / setBroker', async () => {
    const m = useMessenger()
    await m.getBroker()
    await m.setBroker('10.0.0.2', { persist: true })
    await m.setBroker()
    expect(calls).toEqual([
      { fn: 'getBroker', args: [] },
      { fn: 'setBroker', args: ['10.0.0.2', { persist: true }] },
      { fn: 'setBroker', args: [undefined, undefined] },
    ])
  })
})
