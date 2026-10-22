import type { MessengerClientOptions } from '@agent-hand/messenger-client'

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

function toBrokers(v: unknown): string[] | undefined {
  let list: string[] = []
  if (Array.isArray(v)) {
    list = v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x !== '')
  }
  else if (typeof v === 'string') {
    list = v.split(',').map((x) => x.trim()).filter((x) => x !== '')
  }
  // `[]` would hide the config-file stage of the broker resolution; leave it undefined instead.
  return list.length > 0 ? list : undefined
}

/**
 * Map the private `runtimeConfig.messenger` to library options.
 * Empty values become `undefined` so the library defaults (env, config file, discovery) still apply.
 * `env` / `log` / `config` / `notifier` are intentionally not passed.
 */
export function toClientOptions(rc: unknown): MessengerClientOptions {
  const c = (rc ?? {}) as Record<string, unknown>
  return {
    name: str(c.name),
    summary: str(c.summary),
    brokers: toBrokers(c.brokers),
    autoStartBroker: c.autoStartBroker === true || c.autoStartBroker === 'true',
  }
}
