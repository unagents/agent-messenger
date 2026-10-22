export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  return await useMessenger().send(String(q.to), String(q.text), q.delivery === 'push' ? 'push' : undefined)
})
