import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { HttpMethod, ResponseExample } from '@vvpost/schemas'
import { ConfigError } from '../connectors/errors'
import { joinPath, resolveConnector } from '../connectors/resolve'
import { interpolate } from '../connectors/template'
import type { LoadedWorkspace } from '../connectors/workspace'
import { assertFeature } from '../policy/features'

/** Porta padrão do mock server (o servidor de webhooks usa a 4480, o MCP a 4470). */
export const MOCK_DEFAULT_PORT = 4490

/** Um endpoint servido pelo mock: o caminho completo (basePath + path) e os exemplos dele. */
export interface MockRoute {
  connectorId: string
  endpointId: string
  method: HttpMethod
  /** basePath do conector + path do endpoint, com os parâmetros em {nome}. */
  path: string
  examples: ResponseExample[]
}

/**
 * As rotas do mock a partir do workspace: todo endpoint HTTP (os de plugin ficam de fora) dos
 * conectores escolhidos (padrão: todos), com a herança resolvida. Um conector com herança
 * quebrada fica de fora e volta em `problems`.
 */
export function mockRoutes(ws: Pick<LoadedWorkspace, 'connectors'>, connectorIds?: string[]): { routes: MockRoute[]; problems: string[] } {
  const routes: MockRoute[] = []
  const problems: string[] = []
  const ids = connectorIds?.length ? connectorIds : [...ws.connectors.keys()].sort()
  for (const id of ids) {
    if (!ws.connectors.has(id)) {
      problems.push(`conector "${id}" não existe no workspace`)
      continue
    }
    try {
      const resolved = resolveConnector(id, ws.connectors)
      for (const endpoint of resolved.endpoints) {
        if (endpoint.plugin) continue
        routes.push({
          connectorId: id,
          endpointId: endpoint.id,
          method: endpoint.method,
          path: joinPath(resolved.basePath, endpoint.path),
          examples: endpoint.examples ?? []
        })
      }
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err
      problems.push(`${id}: ${err.message}`)
    }
  }
  return { routes, problems }
}

export interface MockMatch {
  route: MockRoute
  params: Record<string, string>
}

const segments = (path: string) => path.split('/').filter(Boolean)

/**
 * A rota de um método e caminho. Entre várias que casam, vence a com menos parâmetros (o
 * caminho literal /users/me antes de /users/{id}); o header X-VVPost-Connector desempata.
 */
export function matchRoute(routes: readonly MockRoute[], method: string, pathname: string, connectorId?: string): MockMatch | undefined {
  const wanted = segments(pathname)
  let best: (MockMatch & { score: number }) | undefined
  for (const route of routes) {
    if (route.method !== method.toUpperCase()) continue
    if (connectorId && route.connectorId !== connectorId) continue
    const parts = segments(route.path)
    if (parts.length !== wanted.length) continue
    const params: Record<string, string> = {}
    let score = 0
    let ok = true
    for (let i = 0; i < parts.length; i++) {
      const param = /^\{(.+)\}$/.exec(parts[i]!)
      if (param) {
        params[param[1]!] = decodeURIComponent(wanted[i]!)
        score++
      } else if (parts[i] !== wanted[i]) {
        ok = false
        break
      }
    }
    if (ok && (!best || score < best.score)) best = { route, params, score }
  }
  return best && { route: best.route, params: best.params }
}

/**
 * O exemplo pedido: pelo id ou nome (`?__example=` ou o header X-VVPost-Example), pelo status
 * (`?__status=`, X-VVPost-Status ou `Prefer: code=404`, como no Prism) ou, sem pedido, o
 * primeiro 2xx do endpoint (ou o primeiro de todos).
 */
export function pickExample(examples: readonly ResponseExample[], ask: { example?: string; status?: number }): ResponseExample | undefined {
  if (ask.example) return examples.find((e) => e.id === ask.example || e.name === ask.example)
  if (ask.status !== undefined) return examples.find((e) => e.status === ask.status)
  return examples.find((e) => e.status >= 200 && e.status < 300) ?? examples[0]
}

/** Troca {{$path.x}}, {{$query.x}} e as variáveis dinâmicas; o que não for conhecido fica como está. */
export function renderTemplate(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, name: string) => {
    if (values[name] !== undefined) return values[name]!
    if (!name.startsWith('$')) return whole
    try {
      return interpolate(whole, { values: new Map() })
    } catch {
      return whole
    }
  })
}

function renderDeep(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === 'string') return renderTemplate(value, values)
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, values))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, values)]))
  return value
}

export interface MockResponse {
  status: number
  headers: Record<string, string>
  body: string
  delayMs: number
}

/** A resposta de um exemplo: o corpo com os valores da requisição e o Content-Type que faltar. */
export function renderExample(example: ResponseExample, values: Record<string, string>): MockResponse {
  const headers: Record<string, string> = { ...example.headers }
  const hasType = Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')
  let body = ''
  if (typeof example.body === 'string') {
    body = renderTemplate(example.body, values)
    if (!hasType) headers['Content-Type'] = /^\s*[[{]/.test(body) ? 'application/json' : 'text/plain; charset=utf-8'
  } else if (example.body !== undefined) {
    body = JSON.stringify(renderDeep(example.body, values), null, 2)
    if (!hasType) headers['Content-Type'] = 'application/json'
  }
  return { status: example.status, headers, body, delayMs: example.delayMs ?? 0 }
}

/** Uma requisição atendida, para o log do app e do CLI. */
export interface MockHit {
  at: string
  method: string
  path: string
  status: number
  connectorId?: string
  endpointId?: string
  exampleId?: string
  durationMs: number
}

export interface MockServerOptions {
  /** Rotas atuais; chamado a cada requisição, então editar o workspace vale sem reiniciar. */
  routes: () => Promise<MockRoute[]> | MockRoute[]
  port?: number
  host?: string
  onHit?: (hit: MockHit) => void
}

export interface MockServer {
  url: string
  port: number
  close(): Promise<void>
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
  'Access-Control-Expose-Headers': '*'
}

/**
 * Mock server local (fase 15): cada endpoint do workspace responde com os exemplos salvos
 * nele, no caminho basePath + path, só em 127.0.0.1. Libera CORS para um front-end local
 * chamar direto. Sem exemplo, responde 501; sem rota, 404 com o que existe naquele caminho.
 */
export async function startMockServer(options: MockServerOptions): Promise<MockServer> {
  assertFeature('mockServer')
  const server: Server = createServer((req, res) => void handle(req, res, options))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? MOCK_DEFAULT_PORT, options.host ?? '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, options: MockServerOptions): Promise<void> {
  const start = performance.now()
  const url = new URL(req.url ?? '/', 'http://mock')
  const method = (req.method ?? 'GET').toUpperCase()
  // O corpo não importa para escolher o exemplo, mas precisa ser lido para a conexão seguir.
  req.resume()
  const send = (status: number, headers: Record<string, string>, body: string, hit: Partial<MockHit> = {}) => {
    res.writeHead(status, { ...CORS, ...headers })
    res.end(method === 'HEAD' ? undefined : body)
    options.onHit?.({ at: new Date().toISOString(), method, path: url.pathname, status, durationMs: Math.round(performance.now() - start), ...hit })
  }
  const json = (status: number, data: unknown) => send(status, { 'Content-Type': 'application/json' }, JSON.stringify(data))
  if (method === 'OPTIONS' && req.headers['access-control-request-method']) return send(204, {}, '')

  let routes: MockRoute[]
  try {
    routes = await options.routes()
  } catch (err) {
    return json(500, { error: 'MOCK_WORKSPACE', message: (err as Error).message })
  }
  const connector = header(req, 'x-vvpost-connector')
  const match = matchRoute(routes, method === 'HEAD' ? 'GET' : method, url.pathname, connector)
  if (!match) {
    const allowed = [...new Set(routes.filter((r) => matchRoute([r], r.method, url.pathname)).map((r) => r.method))]
    return json(allowed.length ? 405 : 404, {
      error: allowed.length ? 'METHOD_NOT_MOCKED' : 'ROUTE_NOT_MOCKED',
      message: allowed.length
        ? `${method} ${url.pathname} não está no workspace; o caminho existe com ${allowed.join(', ')}`
        : `nenhum endpoint do workspace responde em ${url.pathname}`
    })
  }
  const { route, params } = match
  const ids = { connectorId: route.connectorId, endpointId: route.endpointId }
  const prefer = /(?:^|[;,\s])code=(\d{3})/.exec(header(req, 'prefer') ?? '')?.[1]
  const exampleAsk = url.searchParams.get('__example') ?? header(req, 'x-vvpost-example') ?? /(?:^|[;,\s])example=([^;,\s]+)/.exec(header(req, 'prefer') ?? '')?.[1]
  const statusText = url.searchParams.get('__status') ?? header(req, 'x-vvpost-status') ?? prefer
  const example = pickExample(route.examples, { ...(exampleAsk && { example: exampleAsk }), ...(statusText && { status: Number(statusText) }) })
  if (!example) {
    const asked = exampleAsk ? `o exemplo "${exampleAsk}"` : statusText ? `exemplo com status ${statusText}` : 'nenhum exemplo de resposta'
    return json(route.examples.length ? 404 : 501, {
      error: 'EXAMPLE_NOT_FOUND',
      message: `${route.connectorId}/${route.endpointId} não tem ${asked}`,
      examples: route.examples.map((e) => ({ id: e.id, name: e.name, status: e.status }))
    })
  }
  const values: Record<string, string> = {}
  for (const [k, v] of Object.entries(params)) values[`$path.${k}`] = v
  for (const [k, v] of url.searchParams) if (values[`$query.${k}`] === undefined) values[`$query.${k}`] = v
  const out = renderExample(example, values)
  if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs))
  send(out.status, { ...out.headers, 'X-VVPost-Mock': `${route.connectorId}/${route.endpointId}#${example.id}` }, out.body, { ...ids, exampleId: example.id })
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}
