import { createMessengerClient } from '@agent-hand/messenger-client'
import type { InboundMessage, MessengerClient, MessengerClientOptions } from '@agent-hand/messenger-client'

const STORE_KEY = Symbol.for('@agent-hand/messenger-nuxt')
export const CONNECT_RETRY_MS = 5000
export const READY_TIMEOUT_MS = 10000

export interface MessengerEntry {
  readonly client: MessengerClient
  /** Resolves after the first successful connect (or after stop). Never rejects. */
  readonly ready: Promise<void>
  readonly connected: () => boolean
  /** Re-evaluate the receive mode (hook / pull) now. Called on every listener change. */
  refresh(): void
  /** Idempotent. */
  stop(): Promise<void>
}

export interface MessengerStore {
  current?: MessengerEntry
}

export function getStore(g: object = globalThis): MessengerStore {
  const holder = g as Record<symbol, MessengerStore | undefined>
  return (holder[STORE_KEY] ??= {})
}

export interface StartDeps {
  options: MessengerClientOptions
  /** Defaults to `createMessengerClient` (replaced in tests). */
  create?: (o: MessengerClientOptions) => MessengerClient
  /** Relay to the `messenger:message` hook. */
  forward: (m: InboundMessage) => Promise<void>
  /** Whether the `messenger:message` hook has at least one listener right now. */
  hasListeners: () => boolean
  /** Register a callback that fires whenever the listener set of the hook may have changed. */
  watchListeners?: (onChange: () => void) => void
  log?: (msg: string) => void
  retryMs?: number
  global?: object
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function startMessenger(deps: StartDeps): MessengerEntry {
  const log = deps.log ?? ((m: string) => console.log(`[messenger-nuxt] ${m}`))
  const retryMs = deps.retryMs ?? CONNECT_RETRY_MS
  const create = deps.create ?? createMessengerClient
  const store = getStore(deps.global)
  const prev = store.current

  const client = create(deps.options)
  let stopped = false
  let isConnected = false
  let unsub: (() => void) | undefined
  let wake: (() => void) | undefined
  let stopPromise: Promise<void> | undefined

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const t = setTimeout(done, ms)
      function done(): void {
        clearTimeout(t)
        wake = undefined
        resolve()
      }
      wake = done
    })

  // SQ-1 (decided by w-cap/user): the mode follows the listener set at every delivery, not only at first connect.
  // A client handler is registered exactly while the hook has a listener (the library consumes every message
  // once any handler exists); without one nothing is consumed and the app pulls via checkMessages().
  // The relay re-checks the listener set on every delivery, so a change that bypassed `watchListeners`
  // (removeAllHooks, a saved `hook` reference, ...) still cannot consume a message nobody listens to:
  // it throws before the hook is called (no ack, message stays buffered) and drops the handler.
  const guardedForward = async (m: InboundMessage): Promise<void> => {
    if (!selectReceiveMode(deps.hasListeners)) {
      refresh()
      throw new Error('no messenger:message listener (left for pull)')
    }
    await deps.forward(m)
  }
  const refresh = (): void => {
    if (stopped || !isConnected) return
    const hook = selectReceiveMode(deps.hasListeners)
    if (hook && !unsub) {
      unsub = client.onMessage(guardedForward)
    }
    else if (!hook && unsub) {
      unsub()
      unsub = undefined
    }
  }
  deps.watchListeners?.(refresh)

  const run = async (): Promise<void> => {
    try {
      // The broker evicts a peer with the same pid+hostname on register, so never register two at once.
      if (prev) await prev.stop()
      while (!stopped) {
        try {
          await client.connect()
          break
        }
        catch (e) {
          if (stopped) return
          log(`connect failed: ${errMsg(e)} - retry in ${Math.round(retryMs / 1000)} s`)
          await sleep(retryMs)
        }
      }
      if (stopped) return
      isConnected = true
      refresh()
      log(`connected as ${client.peer.id ?? '?'} (mode: ${unsub ? 'hook' : 'pull'})`)
    }
    catch (e) {
      log(`startup error: ${errMsg(e)}`)
    }
  }

  const entry: MessengerEntry = {
    client,
    ready: run(),
    connected: () => isConnected && !stopped,
    refresh,
    stop(): Promise<void> {
      stopPromise ??= (async () => {
        stopped = true
        wake?.()
        unsub?.()
        unsub = undefined
        try {
          await client.close()
        }
        catch (e) {
          log(`close failed: ${errMsg(e)}`)
        }
        if (store.current === entry) store.current = undefined
      })()
      return stopPromise
    },
  }
  store.current = entry
  return entry
}

/**
 * SQ-1 / D3 switch (isolated here on purpose): true = hook mode, false = pull mode.
 * Evaluated on every listener change. To change the policy, edit only this function.
 */
export function selectReceiveMode(hasListeners: () => boolean): boolean {
  return hasListeners()
}

let warnedNoHooksMap = false

/**
 * Number of listeners of a hookable hook. `_hooks` is private in hookable 5.
 * Unknown => 0 (pull mode: nothing is consumed), with one warning.
 */
export function listenerCount(hooks: unknown, name: string): number {
  const map = (hooks as { _hooks?: Record<string, unknown[] | undefined> })._hooks
  if (!map) {
    if (!warnedNoHooksMap) {
      warnedNoHooksMap = true
      console.warn('[messenger-nuxt] cannot read the hook listener table; staying in pull mode (use checkMessages())')
    }
    return 0
  }
  return map[name]?.length ?? 0
}

/**
 * Call `onChange` after every `hook()` / `removeHook()` (and the unsubscribe function `hook()` returns) of a
 * hookable 5 instance, so listeners attached by plugins that run after ours are noticed.
 */
export function watchListeners(hooks: unknown, onChange: () => void): void {
  const h = hooks as {
    hook: (...a: unknown[]) => () => void
    removeHook: (...a: unknown[]) => void
  }
  const hook = h.hook.bind(h)
  const removeHook = h.removeHook.bind(h)
  h.hook = (...a: unknown[]) => {
    const off = hook(...a)
    onChange()
    return () => {
      off()
      onChange()
    }
  }
  h.removeHook = (...a: unknown[]) => {
    removeHook(...a)
    onChange()
  }
}

export async function waitReady(entry: MessengerEntry, timeoutMs: number = READY_TIMEOUT_MS): Promise<void> {
  if (entry.connected()) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    const r = await Promise.race([entry.ready.then(() => 'ready' as const), timeout])
    if (r === 'timeout' || !entry.connected()) throw new Error('Not connected to broker yet')
  }
  finally {
    clearTimeout(timer)
  }
}
