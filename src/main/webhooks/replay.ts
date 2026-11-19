import type { WebhookEvent } from '@vvpost/core/types'

/** Headers que dizem respeito à conexão de quem mandou, não ao evento. */
const HOP_BY_HOP = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'expect', 'upgrade'])

/**
 * Reenvia um evento ao próprio servidor, com o método, o caminho, os headers (assinatura
 * inclusive) e os bytes do corpo como chegaram: depurar o fluxo disparado sem pedir ao
 * remetente que mande de novo. O reenvio vira um evento novo, com x-vvpost-replay-of.
 */
export async function replayEvent(baseUrl: string, event: WebhookEvent): Promise<{ id: number | null; status: number }> {
  const headers = new Headers()
  for (const { name, value } of event.headers) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers.append(name, value)
  }
  headers.set('x-vvpost-replay-of', String(event.id))
  const hasBody = event.method !== 'GET' && event.method !== 'HEAD'
  const body = !hasBody ? undefined : event.bodyBase64 !== undefined ? Buffer.from(event.bodyBase64, 'base64') : event.body
  const res = await fetch(new URL(event.url, baseUrl), { method: event.method, headers, ...(body !== undefined && { body }) })
  await res.arrayBuffer().catch(() => undefined)
  const id = Number(res.headers.get('x-vvpost-event'))
  return { id: Number.isInteger(id) && id > 0 ? id : null, status: res.status }
}
