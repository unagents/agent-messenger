import type { InboundMessage } from '@agent-hand/messenger-client'

declare module 'nitropack/types' {
  interface NitroRuntimeHooks {
    /** Fired for inbound messages while at least one listener exists; without a listener messages are left for `checkMessages()`. */
    'messenger:message': (message: InboundMessage) => void | Promise<void>
  }
}

declare module '@nuxt/schema' {
  interface RuntimeConfig {
    messenger: { name: string, summary: string, brokers: string[], autoStartBroker: boolean }
  }
}

export {}
