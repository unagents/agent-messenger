import { describe, expect, it } from 'vitest'
import { createHooks } from 'hookable'
import { listenerCount } from '../src/runtime/server/lib/lifecycle'

// Assumptions about hookable 5.x that the module relies on (hook mode ack semantics, D3 listener count).

describe('hookable 5.x', () => {
  it('callHook runs listeners serially; a throwing listener rejects and skips the rest', async () => {
    const hooks = createHooks<{ m: (x: number) => void | Promise<void> }>()
    const calls: string[] = []
    hooks.hook('m', () => {
      calls.push('1')
    })
    hooks.hook('m', () => {
      calls.push('2')
      throw new Error('boom')
    })
    hooks.hook('m', () => {
      calls.push('3')
    })
    await expect(hooks.callHook('m', 1)).rejects.toThrow('boom')
    expect(calls).toEqual(['1', '2'])
  })

  it('callHook with no listener resolves immediately', async () => {
    const hooks = createHooks<{ m: () => void }>()
    await expect(hooks.callHook('m')).resolves.toBeUndefined()
  })

  it('listenerCount reads 0 / 1 / 0 after removal', () => {
    const hooks = createHooks<{ m: () => void }>()
    expect(listenerCount(hooks, 'm')).toBe(0)
    const off = hooks.hook('m', () => {})
    expect(listenerCount(hooks, 'm')).toBe(1)
    off()
    expect(listenerCount(hooks, 'm')).toBe(0)
  })
})
