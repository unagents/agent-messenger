import type { InboundMessage } from '@agent-hand/messenger-client'

declare module 'nitropack/types' {
  interface NitroRuntimeHooks {
    /** Fired for every inbound message when at least one listener existed at first connect. */
    'messenger:message': (message: InboundMessage) => void | Promise<void>
  }
}

declare module '@nuxt/schema' {
  interface RuntimeConfig {
    messenger: { name: string, summary: string, brokers: string[], autoStartBroker: boolean }
  }
}

export {}
