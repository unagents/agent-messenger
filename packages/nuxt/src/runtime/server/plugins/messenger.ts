import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime'
import { toClientOptions } from '../lib/options'
import { listenerCount, startMessenger, watchListeners } from '../lib/lifecycle'

export default defineNitroPlugin((nitroApp) => {
  const entry = startMessenger({
    options: toClientOptions(useRuntimeConfig().messenger),
    forward: (m) => nitroApp.hooks.callHook('messenger:message', m),
    hasListeners: () => listenerCount(nitroApp.hooks, 'messenger:message') > 0,
    watchListeners: (onChange) => watchListeners(nitroApp.hooks, onChange),
  })
  nitroApp.hooks.hookOnce('close', () => entry.stop())
})
