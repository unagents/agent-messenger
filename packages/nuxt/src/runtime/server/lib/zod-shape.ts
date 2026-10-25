import { z } from 'zod'
import type { JsonObjectSchema } from '@unagents/messenger-client/tools'

/**
 * Convert the JSON Schema subset used by the tool definitions into a zod v4 raw shape.
 * - Only `type: "string"` is supported (anything else throws).
 * - `enum` is NOT enforced: it maps to a plain `z.string()` so that a bad value reaches the
 *   tool handler, which answers with its own `Invalid delivery: ...` text.
 * - Keys missing from `required` become optional.
 */
export function jsonSchemaToZodShape(schema: JsonObjectSchema): Record<string, z.ZodType> {
  const required = new Set(schema.required ?? [])
  const shape: Record<string, z.ZodType> = {}
  for (const [key, prop] of Object.entries(schema.properties)) {
    const type: unknown = prop.type
    if (type !== 'string') throw new Error(`Unsupported JSON Schema type for ${key}: ${String(type)}`)
    let field: z.ZodType = z.string()
    if (prop.description !== undefined) field = field.describe(prop.description)
    if (!required.has(key)) field = field.optional()
    shape[key] = field
  }
  return shape
}
