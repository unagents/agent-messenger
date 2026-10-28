import { z } from 'zod'
import type { JsonObjectSchema } from '@unagents/messenger-client/tools'

/**
 * Convert the JSON Schema subset used by the tool definitions into a zod v4 raw shape.
 * - `type: "string"` and `type: "object"` (one level, string members; `send_message` `meta`) are supported
 *   (anything else throws).
 * - `enum` is NOT enforced: it maps to a plain `z.string()` so that a bad value reaches the
 *   tool handler, which answers with its own `Invalid delivery: ...` text.
 * - Keys missing from `required` become optional.
 */
export function jsonSchemaToZodShape(schema: JsonObjectSchema): Record<string, z.ZodType> {
  const required = new Set(schema.required ?? [])
  const shape: Record<string, z.ZodType> = {}
  for (const [key, prop] of Object.entries(schema.properties)) {
    const type: unknown = prop.type
    let field: z.ZodType
    if (type === 'string') {
      field = z.string()
    } else if (type === 'object') {
      const nestedRequired = new Set(prop.required ?? [])
      const nested: Record<string, z.ZodType> = {}
      for (const [nestedKey, nestedProp] of Object.entries(prop.properties ?? {})) {
        const nestedType: unknown = nestedProp.type
        if (nestedType !== 'string') throw new Error(`Unsupported JSON Schema type for ${key}.${nestedKey}: ${String(nestedType)}`)
        let nestedField: z.ZodType = z.string()
        if (nestedProp.description !== undefined) nestedField = nestedField.describe(nestedProp.description)
        if (!nestedRequired.has(nestedKey)) nestedField = nestedField.optional()
        nested[nestedKey] = nestedField
      }
      field = z.object(nested)
    } else {
      throw new Error(`Unsupported JSON Schema type for ${key}: ${String(type)}`)
    }
    if (prop.description !== undefined) field = field.describe(prop.description)
    if (!required.has(key)) field = field.optional()
    shape[key] = field
  }
  return shape
}
