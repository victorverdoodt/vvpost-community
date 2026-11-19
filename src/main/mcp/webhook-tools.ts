import type { WebhookEvent } from '@vvpost/core/types'
import { REDACTED } from '@vvpost/core/sanitizer'
import { loadWebhooksConfig, hookInfo } from '../webhooks/config'
import { load, ToolError, type McpTool, type ToolContext } from './tools'

/** Corpo de evento devolvido à IA: sanitizado inteiro e só depois cortado. */
const BODY_PREVIEW_CHARS = 4000
const MAX_LIST = 100

/** O servidor ligado, com os segredos do workspace já no sanitizer (o evento pode ecoá-los). */
async function inbox(ctx: ToolContext) {
  const found = ctx.webhooks?.()
  if (!found) {
    throw new ToolError(
      'o servidor de webhooks está desligado: ligue-o na barra de status do app (Webhooks) ou rode o MCP com --webhooks'
    )
  }
  await load(ctx).catch(() => undefined)
  return found
}

function cut(text: string): string {
  if (text.length <= BODY_PREVIEW_CHARS) return text
  let head = text.slice(0, BODY_PREVIEW_CHARS)
  const open = head.lastIndexOf('[')
  if (open > BODY_PREVIEW_CHARS - REDACTED.length && REDACTED.startsWith(head.slice(open))) head = head.slice(0, open)
  return `${head}…`
}

const summary = (e: WebhookEvent) => ({
  id: e.id,
  receivedAt: e.receivedAt,
  method: e.method,
  url: e.url,
  ...(e.hookId && { hook: e.hookId }),
  status: e.response.status,
  sizeBytes: e.sizeBytes,
  ...(e.signature && { signature: e.signature }),
  ...(e.rejected && { rejected: e.rejected }),
  ...(e.trigger && { trigger: e.trigger })
})

const listWebhookEvents: McpTool = {
  name: 'list_webhook_events',
  title: 'Eventos recebidos pelo servidor local de webhooks',
  description:
    'Lista os eventos que chegaram ao servidor local de webhooks do VVPost (do mais novo para o mais antigo), com o hook que atendeu, a resposta, ' +
    'a assinatura e o resultado do disparo do hook (fluxo ou cenários). Também devolve a URL do servidor e os hooks configurados. ' +
    'Use get_webhook_event para os headers e o corpo. Credenciais vêm mascaradas.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      hook: { type: 'string', description: 'Só eventos deste hook.' },
      afterId: { type: 'integer', minimum: 0, description: 'Só eventos com id maior que este (para acompanhar os novos).' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIST, description: `Padrão: 20, até ${MAX_LIST}.` }
    }
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async call(args, ctx) {
    const box = await inbox(ctx)
    const config = await loadWebhooksConfig(ctx.workspaceDir).catch(() => null)
    const hook = typeof args['hook'] === 'string' ? args['hook'] : undefined
    const after = typeof args['afterId'] === 'number' ? args['afterId'] : 0
    const limit = typeof args['limit'] === 'number' ? args['limit'] : 20
    const events = box.inbox.list().filter((e) => e.id > after && (hook === undefined || e.hookId === hook))
    return {
      url: box.url,
      hooks: config?.hooks.map(hookInfo) ?? [],
      nextId: box.inbox.cursor(),
      total: events.length,
      events: events.slice(0, limit).map((e) => ({ ...summary(e), url: ctx.pii.text(e.url) }))
    }
  }
}

const getWebhookEvent: McpTool = {
  name: 'get_webhook_event',
  title: 'Um evento do servidor local de webhooks',
  description:
    'O evento inteiro: método, URL, query, headers e corpo (cortado em 4000 caracteres), com a resposta dada e o disparo. ' +
    'Headers de credencial e valores com cara de segredo vêm como [REDACTED_SECRET].',
  inputSchema: {
    type: 'object',
    required: ['id'],
    additionalProperties: false,
    properties: { id: { type: 'integer', minimum: 1, description: 'Id do evento (veja list_webhook_events).' } }
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async call(args, ctx) {
    const event = (await inbox(ctx)).inbox.get(Number(args['id']))
    if (!event) throw new ToolError(`o evento ${String(args['id'])} não está na memória do servidor (os mais antigos saem)`)
    // Dados pessoais e depois credenciais, com o corpo ainda inteiro (JSON parseável) antes do corte.
    const sanitized = ctx.sanitizer.sanitize({ ...event, url: ctx.pii.text(event.url), query: ctx.pii.sanitize(event.query), headers: ctx.pii.sanitize(event.headers) })
    return {
      ...summary(sanitized),
      query: sanitized.query,
      headers: sanitized.headers,
      ...(sanitized.remoteAddress && { remoteAddress: sanitized.remoteAddress }),
      ...(event.bodyBase64 !== undefined
        ? { body: '(corpo binário)', bodyBase64Bytes: event.sizeBytes }
        : { body: cut(ctx.sanitizer.text(ctx.pii.text(event.body))) })
    }
  }
}

export const WEBHOOK_TOOLS: readonly McpTool[] = [listWebhookEvents, getWebhookEvent]
