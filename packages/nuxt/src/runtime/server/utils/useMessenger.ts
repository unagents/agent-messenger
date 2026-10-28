import type {
  BrokerInfo,
  InboundMessage,
  MessageMeta,
  PeerProtocolFilter,
  PeerScope,
  ProtocolDetail,
  ProtocolInfo,
  ProtocolPeer,
  SendResult,
} from '@unagents/messenger-client'
import { getStore, waitReady, READY_TIMEOUT_MS } from '../lib/lifecycle'

export interface MessengerApi {
  send(to: string, text: string, delivery?: 'pull' | 'push', meta?: MessageMeta): Promise<SendResult>
  ping(to: string, subject?: string): Promise<SendResult>
  listPeers(scope?: PeerScope, filter?: PeerProtocolFilter): Promise<ProtocolPeer[]>
  setName(name: string): Promise<void>
  setSummary(summary: string): Promise<void>
  checkMessages(): Promise<InboundMessage[]>
  setProtocol(repo: string, version?: string): Promise<ProtocolInfo>
  unsetProtocol(name?: string): Promise<void>
  getProtocol(name: string, version?: string): Promise<ProtocolDetail>
  getBroker(): Promise<BrokerInfo>
  setBroker(url?: string, opts?: { persist?: boolean }): Promise<BrokerInfo>
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
    async send(to, text, delivery, meta) {
      await ready()
      return c.send(to, text, delivery, meta)
    },
    async ping(to, subject) {
      await ready()
      return c.ping(to, subject)
    },
    async listPeers(scope, filter) {
      await ready()
      return c.listPeers(scope, filter)
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
    async setProtocol(repo, version) {
      await ready()
      return c.setProtocol(repo, version)
    },
    async unsetProtocol(name) {
      await ready()
      return c.unsetProtocol(name)
    },
    async getProtocol(name, version) {
      await ready()
      return c.getProtocol(name, version)
    },
    async getBroker() {
      await ready()
      return c.getBroker()
    },
    async setBroker(url, opts) {
      await ready()
      return c.setBroker(url, opts)
    },
  }
}
