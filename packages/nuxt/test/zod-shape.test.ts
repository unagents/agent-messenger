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
  it('converts all six tool definitions', () => {
    expect(TOOL_DEFS).toHaveLength(6)
    for (const d of TOOL_DEFS) {
      const shape = jsonSchemaToZodShape(d.inputSchema)
      expect(Object.keys(shape)).toEqual(Object.keys(d.inputSchema.properties))
    }
  })

  it('send_message: to / message required, delivery optional', () => {
    const s = z.object(jsonSchemaToZodShape(def('send_message').inputSchema))
    expect(s.safeParse({ to: 'a', message: 'b' }).success).toBe(true)
    expect(s.safeParse({ to: 'a' }).success).toBe(false)
    expect(s.safeParse({ message: 'b' }).success).toBe(false)
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
