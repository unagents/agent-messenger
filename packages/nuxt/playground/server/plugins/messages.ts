import { defineNitroPlugin } from 'nitropack/runtime'

// Received messages, newest last. Module scope: reset when the worker reloads.
export const received: { id: number, mode: string, from: string, text: string }[] = []
const failedOnce = new Set<number>()

export default defineNitroPlugin((nitroApp) => {
  // PG_NO_LISTENER=1: register no listener, so the module stays in pull mode (D3).
  if (process.env.PG_NO_LISTENER === '1') return
  nitroApp.hooks.hook('messenger:message', (m) => {
    // Handlers must be idempotent: a failure here redelivers to every listener ~1 s later.
    if (m.text.startsWith('FAIL-ONCE-') && !failedOnce.has(m.id)) {
      failedOnce.add(m.id)
      console.log(`[pg] messenger:message id=${m.id} failing once`)
      throw new Error('planned one-time failure')
    }
    console.log(`[pg] messenger:message id=${m.id} mode=${m.mode} from=${m.from_name} text=${m.text}`)
    received.push({ id: m.id, mode: m.mode, from: m.from_name, text: m.text })
  })
})
