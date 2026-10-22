import { attachListener } from '../plugins/messages'

// Attaches the messenger:message listener after startup (SQ-1 measurement: listener appears later).
export default defineEventHandler(() => ({ attached: attachListener(useNitroApp()) }))
