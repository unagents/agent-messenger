// Pull-mode check (PG_NO_LISTENER=1): returns and acknowledges the buffered messages.
export default defineEventHandler(async () => await useMessenger().checkMessages())
