import type { InboundMessage, Peer, PeerScope, SendResult } from '@unagents/messenger-client'
import { getStore, waitReady, READY_TIMEOUT_MS } from '../lib/lifecycle'

export interface MessengerApi {
  send(to: string, text: string, delivery?: 'pull' | 'push'): Promise<SendResult>
  ping(to: string, subject?: string): Promise<SendResult>
  listPeers(scope?: PeerScope): Promise<Peer[]>
  setName(name: string): Promise<void>
  setSummary(summary: string): Promise<void>
  checkMessages(): Promise<InboundMessage[]>
}

/**
 * The messenger client of this Nitro process (one server = one peer).
 * Methods wait up to 10 s for the first connect, then throw `Not connected to broker yet`.
 * Errors from the client library are passed through unchanged.
 */
export function useMessenger(): MessengerApi {
  const entry = getStore().current
  if (!entry) throw new Error('[messenger] not initialised (module plugin not loaded or closed)')
  const c = entry.client
  const ready = async (): Promise<void> => waitReady(entry, READY_TIMEOUT_MS)
  return {
    async send(to, text, delivery) {
      await ready()
      return c.send(to, text, delivery)
    },
    async ping(to, subject) {
      await ready()
      return c.ping(to, subject)
    },
    async listPeers(scope) {
      await ready()
      return c.listPeers(scope)
    },
    async setName(name) {
      await ready()
      return c.setName(name)
    },
    async setSummary(summary) {
      await ready()
      return c.setSummary(summary)
    },
    async checkMessages() {
      await ready()
      return c.checkMessages()
    },
  }
}
