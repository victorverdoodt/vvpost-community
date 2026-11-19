import { createHmac, timingSafeEqual } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type { WebhookHook } from '@vvpost/schemas'
import { environmentValues, type LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import { pathMatches, pathSpecificity } from '@vvpost/core/flows/webhook'
import { isBinaryBody } from '@vvpost/core/http/body'
import type { HttpHeader, WebhookEvent } from '@vvpost/core/types'
import { loadWebhooksConfig, variableName, WEBHOOKS_FILE, type ResolvedWebhooksConfig } from './config'
import { createWebhookInbox, type WebhookInbox } from './inbox'
import { assertFeature } from '@vvpost/core/policy/features'

export interface WebhookServerDeps {
  inbox: WebhookInbox
  /** Workspace com o vault, para a chave das assinaturas (lido a cada evento assinado). */
  workspace: () => Promise<LoadedWorkspace>
  /** Evento aceito de um hook com trigger: quem roda o fluxo ou os cenários. */
  onTrigger?: (event: WebhookEvent, hook: WebhookHook) => void
}

export interface RunningWebhookServer {
  port: number
  /** Raiz do servidor, ex.: http://127.0.0.1:4480. */
  url: string
  config: ResolvedWebhooksConfig
  /** Ambiente das assinaturas e dos disparos (null: o workspace não tem ambientes). */
  environment: string | null
  inbox: WebhookInbox
  close(): Promise<void>
}

export interface StartWebhookOptions {
  /** Sobrepõe a porta do arquivo (0 escolhe uma livre; testes e benchmark). */
  port?: number
  inbox?: WebhookInbox
  /** Sobrepõe o ambiente do arquivo (`vvpost webhooks --env`). */
  environment?: string
  workspace: () => Promise<LoadedWorkspace>
  onTrigger?: WebhookServerDeps['onTrigger']
}

/**
 * Servidor local de webhooks: um Fastify em 127.0.0.1 que aceita qualquer
 * caminho, guarda cada evento em memória para a inspeção e para os nós webhook dos
 * fluxos, responde como o hook manda e, com trigger, dispara um fluxo ou os cenários.
 */
export async function startWebhookServer(dir: string, options: StartWebhookOptions): Promise<RunningWebhookServer> {
  assertFeature('webhooks')
  const loaded = await loadWebhooksConfig(dir)
  const config = options.environment !== undefined ? { ...loaded, environment: options.environment } : loaded
  const inbox = options.inbox ?? createWebhookInbox({ maxEvents: config.maxEvents })
  const environment = config.environment ?? firstEnvironment(await options.workspace().catch(() => null))
  const app = buildWebhookApp(config, {
    inbox,
    workspace: options.workspace,
    ...(options.onTrigger && { onTrigger: options.onTrigger })
  })
  await app.listen({ host: '127.0.0.1', port: options.port ?? config.port })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : config.port
  return { port, url: `http://127.0.0.1:${port}`, config, environment, inbox, close: () => app.close() }
}

const firstEnvironment = (ws: LoadedWorkspace | null): string | null => (ws ? ([...ws.environments.keys()][0] ?? null) : null)

/** O hook que atende o caminho: o mais específico (exato antes de /*, o /* mais longo antes). */
export function matchHook(hooks: readonly WebhookHook[], path: string): WebhookHook | undefined {
  let best: WebhookHook | undefined
  for (const hook of hooks) {
    if (pathMatches(hook.path, path) && (!best || pathSpecificity(hook.path) > pathSpecificity(best.path))) best = hook
  }
  return best
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

export function buildWebhookApp(config: ResolvedWebhooksConfig, deps: WebhookServerDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: config.maxBodyBytes,
    // HEAD e OPTIONS também são eventos: nada de rotas automáticas.
    exposeHeadRoutes: false,
    // Desligar o servidor não espera remetentes com keep-alive aberto.
    forceCloseConnections: true
  })
  const hosts = config.allowHosts.map(hostPattern)

  // Corpo cru em qualquer content-type: a assinatura confere os bytes como chegaram.
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

  // Corpo grande demais e afins: o evento fica registrado, sem corpo, com o motivo.
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500
    const reason = err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? `corpo maior que ${Math.round(config.maxBodyBytes / 1024)} KB` : err.message
    const hook = matchHook(config.hooks, pathOf(req.url))
    deps.inbox.add(buildEvent(req, Buffer.alloc(0), { status, hook, rejected: reason, started: performance.now() }))
    void reply.code(status).send({ error: reason })
  })

  app.route({ method: [...METHODS], url: '/*', handler: (req, reply) => handle(req, reply, config, hosts, deps) })
  return app
}

async function handle(
  req: FastifyRequest,
  reply: FastifyReply,
  config: ResolvedWebhooksConfig,
  hosts: ((host: string) => boolean)[],
  deps: WebhookServerDeps
): Promise<void> {
  const started = performance.now()
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  const path = pathOf(req.url)
  const hook = matchHook(config.hooks, path)
  const refuse = (status: number, rejected: string, extra: Partial<WebhookEvent> = {}) => {
    const event = deps.inbox.add({ ...buildEvent(req, raw, { status, hook, rejected, started }), ...extra })
    void reply.code(status).header('x-vvpost-event', String(event.id)).send({ error: rejected })
  }

  // Remetentes de webhook são servidores: um navegador sempre manda Origin, então isso
  // barra uma página web disparando fluxos, e o Host conferido barra DNS rebinding.
  if (req.headers.origin !== undefined) return refuse(403, 'requisição de navegador (header Origin)')
  const host = req.hostname.replace(/:\d+$/, '').toLowerCase()
  if (!isLoopbackHost(host) && !hosts.some((h) => h(host))) {
    return refuse(403, `host "${host}" fora de allowHosts em ${WEBHOOKS_FILE}`)
  }
  if (hook?.methods && !hook.methods.includes(req.method as (typeof METHODS)[number])) {
    reply.header('allow', hook.methods.join(', '))
    return refuse(405, `o hook ${hook.id} só aceita ${hook.methods.join(', ')}`)
  }

  let signature: WebhookEvent['signature']
  if (hook?.signature) {
    const check = await verifySignature(hook, raw, req.headers, config, deps)
    signature = check.result
    if (check.result !== 'valid') return refuse(check.result === 'unconfigured' ? 500 : 401, check.message, { signature })
  }

  const response = hook?.response
  const status = response?.status ?? 200
  const event = deps.inbox.add(buildEvent(req, raw, { status, hook, started, ...(signature && { signature }) }))
  if (hook?.trigger) deps.onTrigger?.(event, hook)

  if (response?.delayMs) await new Promise((r) => setTimeout(r, response.delayMs))
  reply.code(status).header('x-vvpost-event', String(event.id))
  for (const [name, value] of Object.entries(response?.headers ?? {})) reply.header(name, value)
  const body = response && 'body' in response ? response.body : { received: true, id: event.id }
  if (typeof body === 'string') {
    if (!reply.hasHeader('content-type')) reply.type('text/plain; charset=utf-8')
    await reply.send(body)
  } else {
    if (!reply.hasHeader('content-type')) reply.type('application/json; charset=utf-8')
    await reply.send(JSON.stringify(body ?? null))
  }
  deps.inbox.update(event.id, { response: { status, durationMs: Math.round(performance.now() - started) } })
}

/**
 * HMAC do corpo cru com a chave da variável do hook, no ambiente do servidor. O valor da
 * chave nunca sai daqui: nem no evento, nem nas mensagens.
 */
async function verifySignature(
  hook: WebhookHook,
  raw: Buffer,
  headers: FastifyRequest['headers'],
  config: ResolvedWebhooksConfig,
  deps: WebhookServerDeps
): Promise<{ result: 'valid' | 'invalid' | 'missing' | 'unconfigured'; message: string }> {
  const sig = hook.signature!
  const name = variableName(sig.secret)
  let key: string | undefined
  let envId: string | null = null
  try {
    const ws = await deps.workspace()
    envId = config.environment ?? firstEnvironment(ws)
    key = envId ? environmentValues(ws, envId).values.get(name) : undefined
  } catch {
    key = undefined
  }
  if (!key) {
    return {
      result: 'unconfigured',
      message: `a variável ${name} da assinatura do hook ${hook.id} não tem valor ${envId ? `no ambiente ${envId}` : '(o workspace não tem ambiente)'}`
    }
  }
  const header = headers[sig.header.toLowerCase()]
  const received = Array.isArray(header) ? header[0] : header
  if (!received) return { result: 'missing', message: `assinatura ausente: o hook ${hook.id} exige o header ${sig.header}` }
  const prefix = sig.prefix ?? ''
  const value = received.startsWith(prefix) ? received.slice(prefix.length).trim() : null
  const expected = createHmac(sig.algorithm ?? 'sha256', key).update(raw).digest()
  let got: Buffer | null = null
  if (value !== null) {
    if ((sig.encoding ?? 'hex') === 'hex') got = /^[0-9a-f]+$/i.test(value) ? Buffer.from(value, 'hex') : null
    else got = Buffer.from(value, 'base64')
  }
  if (got && got.length === expected.length && timingSafeEqual(got, expected)) return { result: 'valid', message: '' }
  return { result: 'invalid', message: `assinatura inválida no header ${sig.header}` }
}

function buildEvent(
  req: FastifyRequest,
  raw: Buffer,
  opts: { status: number; hook: WebhookHook | undefined; rejected?: string; started: number; signature?: WebhookEvent['signature'] }
): Omit<WebhookEvent, 'id'> {
  const headers: HttpHeader[] = []
  const rawHeaders = req.raw.rawHeaders
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) headers.push({ name: rawHeaders[i]!, value: rawHeaders[i + 1]! })
  const contentType = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value
  const binary = isBinaryBody(contentType, raw)
  return {
    receivedAt: new Date().toISOString(),
    method: req.method,
    path: pathOf(req.url),
    url: req.url,
    query: queryOf(req.url),
    headers,
    body: binary ? '' : raw.toString('utf8'),
    ...(binary && { bodyBase64: raw.toString('base64') }),
    sizeBytes: raw.length || Number(req.headers['content-length'] ?? 0) || 0,
    truncated: false,
    ...(req.ip && { remoteAddress: req.ip }),
    ...(opts.hook && { hookId: opts.hook.id }),
    ...(opts.signature && { signature: opts.signature }),
    ...(opts.rejected && { rejected: opts.rejected }),
    response: { status: opts.status, durationMs: Math.round(performance.now() - opts.started) }
  }
}

function pathOf(url: string): string {
  const i = url.search(/[?#]/)
  const path = i < 0 ? url : url.slice(0, i)
  try {
    return decodeURI(path) || '/'
  } catch {
    return path || '/'
  }
}

function queryOf(url: string): Record<string, string | string[]> {
  const i = url.indexOf('?')
  const out: Record<string, string | string[]> = {}
  if (i < 0) return out
  for (const [k, v] of new URLSearchParams(url.slice(i + 1).split('#')[0])) {
    const prev = out[k]
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v]
  }
  return out
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]'
}

/** Um host de allowHosts, com * valendo um ou mais rótulos (ex.: *.ngrok-free.app). */
function hostPattern(pattern: string): (host: string) => boolean {
  const re = new RegExp(`^${pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9.-]+')}$`)
  return (host) => re.test(host)
}
