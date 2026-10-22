import { describe, expect, it } from 'vitest'
import { toClientOptions } from '../src/runtime/server/lib/options'

describe('toClientOptions', () => {
  it('maps a full config', () => {
    expect(toClientOptions({ name: 'n', summary: 's', brokers: ['http://a', 'http://b'], autoStartBroker: true })).toEqual({
      name: 'n',
      summary: 's',
      brokers: ['http://a', 'http://b'],
      autoStartBroker: true,
    })
  })

  it('maps empty name / summary to undefined', () => {
    const o = toClientOptions({ name: '', summary: '', brokers: [], autoStartBroker: false })
    expect(o.name).toBeUndefined()
    expect(o.summary).toBeUndefined()
  })

  it('maps non-string name to undefined', () => {
    expect(toClientOptions({ name: 5 }).name).toBeUndefined()
  })

  it('maps an empty brokers array to undefined (keeps the config-file stage)', () => {
    expect(toClientOptions({ brokers: [] }).brokers).toBeUndefined()
  })

  it('drops empty entries from brokers arrays', () => {
    expect(toClientOptions({ brokers: ['http://a', '', '  '] }).brokers).toEqual(['http://a'])
  })

  it('splits a comma separated brokers string and trims', () => {
    expect(toClientOptions({ brokers: 'a, b' }).brokers).toEqual(['a', 'b'])
  })

  it('maps other brokers types to undefined', () => {
    expect(toClientOptions({ brokers: 3 }).brokers).toBeUndefined()
  })

  it('accepts true and "true" for autoStartBroker only', () => {
    expect(toClientOptions({ autoStartBroker: true }).autoStartBroker).toBe(true)
    expect(toClientOptions({ autoStartBroker: 'true' }).autoStartBroker).toBe(true)
    expect(toClientOptions({ autoStartBroker: 'false' }).autoStartBroker).toBe(false)
    expect(toClientOptions({ autoStartBroker: 1 }).autoStartBroker).toBe(false)
    expect(toClientOptions({}).autoStartBroker).toBe(false)
  })

  it('never passes env / log / config / notifier', () => {
    const o = toClientOptions({ name: 'n' }) as Record<string, unknown>
    for (const k of ['env', 'log', 'config', 'notifier']) expect(k in o).toBe(false)
  })

  it('tolerates undefined / null config', () => {
    expect(toClientOptions(undefined).autoStartBroker).toBe(false)
    expect(toClientOptions(null).brokers).toBeUndefined()
  })
})
