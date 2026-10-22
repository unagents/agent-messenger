// Minimal stand-in for `nitropack/runtime` so the toolkit's tool registration code
// (definitions/tools.js) can run in plain vitest. Only what that code path imports.
export function defineCachedFunction<T>(fn: T): T {
  return fn
}

export function useEvent(): never {
  throw new Error('useEvent is not available in unit tests')
}

export function defineNitroPlugin<T>(fn: T): T {
  return fn
}

export function useRuntimeConfig(): Record<string, unknown> {
  return {}
}
