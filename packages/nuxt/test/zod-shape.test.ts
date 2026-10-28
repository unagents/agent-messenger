import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { TOOL_DEFS } from '@unagents/messenger-client/tools'
import type { JsonObjectSchema } from '@unagents/messenger-client/tools'
import { jsonSchemaToZodShape } from '../src/runtime/server/lib/zod-shape'

const def = (name: string) => {
  const d = TOOL_DEFS.find((t) => t.name === name)
  if (!d) throw new Error(`no tool ${name}`)
  return d
}

describe('jsonSchemaToZodShape', () => {
  it('converts all eleven tool definitions', () => {
    expect(TOOL_DEFS).toHaveLength(11)
    for (const d of TOOL_DEFS) {
      const shape = jsonSchemaToZodShape(d.inputSchema)
      expect(Object.keys(shape)).toEqual(Object.keys(d.inputSchema.properties))
    }
  })

  it('set_broker: url string and persist boolean, both optional; get_broker takes nothing', () => {
    const s = z.object(jsonSchemaToZodShape(def('set_broker').inputSchema))
    expect(s.safeParse({}).success).toBe(true)
    expect(s.safeParse({ url: '10.0.0.2', persist: true }).success).toBe(true)
    expect(s.safeParse({ persist: 'yes' }).success).toBe(false)
    expect(Object.keys(jsonSchemaToZodShape(def('get_broker').inputSchema))).toEqual([])
  })

  it('send_message: to / message required, delivery optional', () => {
    const s = z.object(jsonSchemaToZodShape(def('send_message').inputSchema))
    expect(s.safeParse({ to: 'a', message: 'b' }).success).toBe(true)
    expect(s.safeParse({ to: 'a' }).success).toBe(false)
    expect(s.safeParse({ message: 'b' }).success).toBe(false)
  })

  it('send_message.meta: object with protocol / version, optional as a whole, both required inside', () => {
    const s = z.object(jsonSchemaToZodShape(def('send_message').inputSchema))
    expect(s.safeParse({ to: 'a', message: 'b' }).success).toBe(true)
    expect(s.safeParse({ to: 'a', message: 'b', meta: { protocol: 'p', version: '1.0.0' } }).success).toBe(true)
    expect(s.safeParse({ to: 'a', message: 'b', meta: { protocol: 'p' } }).success).toBe(false)
    expect(s.safeParse({ to: 'a', message: 'b', meta: { version: '1.0.0' } }).success).toBe(false)
    expect(s.safeParse({ to: 'a', message: 'b', meta: 'p@1' }).success).toBe(false)
  })

  it('send_message.meta keeps type / description / required through toJSONSchema', () => {
    const d = def('send_message').inputSchema.properties.meta
    const json = z.toJSONSchema(z.object(jsonSchemaToZodShape(def('send_message').inputSchema))) as {
      properties: Record<string, { type?: string, description?: string, properties?: Record<string, { type?: string, description?: string }>, required?: string[] }>
      required?: string[]
    }
    const meta = json.properties.meta
    expect(meta.type).toBe('object')
    expect(meta.description).toBe(d.description)
    expect(Object.keys(meta.properties ?? {})).toEqual(['protocol', 'version'])
    expect(meta.properties?.protocol.description).toBe('Protocol name')
    expect([...(meta.required ?? [])].sort()).toEqual(['protocol', 'version'])
    expect(json.required).not.toContain('meta')
  })

  it('an object member is optional unless listed in the nested required', () => {
    const schema = { type: 'object', properties: { o: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a'] } }, required: ['o'] } as unknown as JsonObjectSchema
    const s = z.object(jsonSchemaToZodShape(schema))
    expect(s.safeParse({ o: { a: 'x' } }).success).toBe(true)
    expect(s.safeParse({ o: { b: 'x' } }).success).toBe(false)
    expect(s.safeParse({}).success).toBe(false)
  })

  it('throws on a non-string member of an object property', () => {
    const bad = { type: 'object', properties: { o: { type: 'object', properties: { n: { type: 'number' } } } } } as unknown as JsonObjectSchema
    expect(() => jsonSchemaToZodShape(bad)).toThrow('Unsupported JSON Schema type for o.n: number')
  })

  it('enum maps to a plain string (a bad delivery passes zod and reaches the handler)', () => {
    const s = z.object(jsonSchemaToZodShape(def('send_message').inputSchema))
    expect(s.safeParse({ to: 'a', message: 'b', delivery: 'bogus' }).success).toBe(true)
    const json = z.toJSONSchema(s) as { properties: Record<string, { enum?: unknown, type?: string }> }
    expect(json.properties.delivery.enum).toBeUndefined()
    expect(json.properties.delivery.type).toBe('string')
  })

  it('list_peers.scope is optional and free-form', () => {
    const s = z.object(jsonSchemaToZodShape(def('list_peers').inputSchema))
    expect(s.safeParse({}).success).toBe(true)
    expect(s.safeParse({ scope: 'x' }).success).toBe(true)
  })

  it('check_messages is an empty shape', () => {
    expect(jsonSchemaToZodShape(def('check_messages').inputSchema)).toEqual({})
  })

  it('keeps description and required through toJSONSchema for every tool', () => {
    for (const d of TOOL_DEFS) {
      const json = z.toJSONSchema(z.object(jsonSchemaToZodShape(d.inputSchema))) as {
        properties: Record<string, { description?: string }>
        required?: string[]
      }
      for (const [k, p] of Object.entries(d.inputSchema.properties)) {
        expect(json.properties[k].description).toBe(p.description)
      }
      expect([...(json.required ?? [])].sort()).toEqual([...(d.inputSchema.required ?? [])].sort())
    }
  })

  it('throws on a non-string property type', () => {
    const bad = { type: 'object', properties: { n: { type: 'number' } } } as unknown as JsonObjectSchema
    expect(() => jsonSchemaToZodShape(bad)).toThrow('Unsupported JSON Schema type for n: number')
  })

  it('returns {} for no properties', () => {
    expect(jsonSchemaToZodShape({ type: 'object', properties: {} })).toEqual({})
  })
})
