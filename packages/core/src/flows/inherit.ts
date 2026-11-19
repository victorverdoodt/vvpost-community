import type {
  AuthLogin,
  AuthLoginRequest,
  Connector,
  ConnectorConfig,
  ConnectorSource,
  Endpoint,
  EndpointSource,
  Flow,
  FlowNode,
  FlowOAuth2Node,
  FlowRequestNode
} from '@vvpost/schemas'
import { joinPath } from '../connectors/resolve'

/**
 * Herança entre fluxos (modelo unificado, docs/flows.md "Herança entre fluxos").
 *
 * Um fluxo-base (o que outros estendem, ou que tem `defaults`) faz o papel de conector, e
 * um fluxo que herda dele e é só um nó de requisição faz o papel de endpoint. Por enquanto
 * o motor continua trabalhando com conectores: `compileFlows` traduz os fluxos para o
 * catálogo de conectores (o login com cache vira a auth `login`, com o cache, o pedido único
 * e o retry no 401 do motor de auth), e `connectorToFlows` faz o caminho de volta. Um teste
 * confere que ida e volta dão a mesma requisição.
 */

/** Pai do nó de login criado de uma auth `login`. */
export const LOGIN_NODE = { id: 'login', name: 'Login' } as const
/** Nó criado de uma auth `oauth2`. */
export const OAUTH2_NODE = { id: 'oauth2', name: 'OAuth2' } as const
/** Nó do fluxo de requisição criado de um endpoint. */
export const REQUEST_NODE_OF_ENDPOINT = { id: 'request', name: 'Request' } as const

const CONNECTOR_ID = /^[a-z0-9]+([._-][a-z0-9]+)*$/
/** {{ $nodes.Nome.caminho }} num texto; o caminho começa com . ou [. */
const NODE_REF = /\{\{\s*\$nodes\.([A-Za-z_][A-Za-z0-9_]*)((?:\.[^\s.[\]}]+|\[[^\]]*\])+)\s*\}\}/g

/** Um fluxo-base: tem defaults ou um nó de auth (login com cache, oauth2), e vira um conector. */
export const isBaseFlow = (flow: Flow): boolean =>
  !!flow.defaults || flow.nodes.some((n) => (n.type === 'request' && !!n.cache) || n.type === 'oauth2')

export interface FlowFile {
  /** Caminho relativo ao workspace, com "/". */
  file: string
  flow: Flow
}

export type FlowRole =
  /** Fluxo-base: vira um conector. */
  | 'base'
  /** Fluxo de requisição: vira um endpoint do conector-pai. */
  | 'request'
  /** Fluxo comum que herda: as requisições dele usam o conector-pai. */
  | 'inheriting'
  /** Fluxo sem herança. */
  | 'plain'

export interface CompiledFlows {
  /** Conectores vindos de fluxos-base. */
  bases: { connector: Connector; file: string }[]
  /** Endpoints vindos de fluxos de requisição, com o conector-pai (de fluxo ou de arquivo de conector). */
  endpoints: { connectorId: string; endpoint: Endpoint; file: string; flowId: string }[]
  /** Papel de cada fluxo, pelo id. */
  roles: Map<string, FlowRole>
  issues: { file: string; message: string }[]
}

/**
 * Traduz os fluxos com herança para conectores e endpoints. `connectors` são os conectores
 * dos arquivos *.connector.vvpost.json (e os compartilhados): um fluxo pode herdar deles, e
 * um id de fluxo-base igual ao de um deles é recusado. Um fluxo que não dá para traduzir
 * vira issue e fica de fora do catálogo; o resto continua usável.
 */
export function compileFlows(flows: readonly FlowFile[], connectors: ReadonlyMap<string, Connector>): CompiledFlows {
  const out: CompiledFlows = { bases: [], endpoints: [], roles: new Map(), issues: [] }
  const extended = new Set(flows.map((f) => f.flow.extends).filter((id): id is string => !!id))
  const byId = new Map(flows.map((f) => [f.flow.id, f]))
  const issue = (file: string, message: string) => out.issues.push({ file, message })

  // 1. Papéis. Uma base precisa existir antes de alguém herdar dela.
  const baseIds = new Set<string>()
  /** Bases recusadas: já têm a issue delas. */
  const rejected = new Set<string>()
  for (const { file, flow } of flows) {
    const isBase = flow.defaults !== undefined || extended.has(flow.id)
    if (!isBase) continue
    rejected.add(flow.id)
    if (!CONNECTOR_ID.test(flow.id)) {
      issue(file, `"${flow.id}" é um fluxo-base (outros herdam dele) e o id precisa seguir o formato de conector: minúsculas, números e . _ -`)
      continue
    }
    if (connectors.has(flow.id)) {
      issue(file, `id "${flow.id}" já é de um conector; o fluxo-base foi ignorado`)
      continue
    }
    const other = flow.nodes.find((n) => !(n.type === 'request' && n.cache) && n.type !== 'oauth2')
    if (other) {
      issue(
        file,
        `o fluxo-base "${flow.id}" tem o nó "${other.name}" sem cache: por enquanto uma base só tem o nó de auth (um nó de requisição com cache, ou um nó oauth2), e os outros nós ficam nos fluxos que herdam`
      )
      continue
    }
    rejected.delete(flow.id)
    baseIds.add(flow.id)
  }

  // 2. Bases → conectores (o caminho do login é acertado depois, com a cadeia inteira).
  const logins: { connector: Connector; node: FlowRequestNode }[] = []
  for (const { file, flow } of flows) {
    if (!baseIds.has(flow.id)) continue
    out.roles.set(flow.id, 'base')
    const built = baseToConnector(flow)
    if (typeof built === 'string') {
      issue(file, built)
      baseIds.delete(flow.id)
      rejected.add(flow.id)
      out.roles.delete(flow.id)
      continue
    }
    out.bases.push({ connector: built.connector, file })
    if (built.login) logins.push({ connector: built.connector, node: built.login })
  }

  const catalog = new Map(connectors)
  for (const { connector } of out.bases) catalog.set(connector.id, connector)
  for (const { connector, node } of logins) {
    // A url relativa do login entra depois da baseUrl e do basePath da base (o da auth `login`
    // é só depois da baseUrl), a menos que o nó diga basePath: false.
    const auth = connector.config!.auth as AuthLogin
    if (node.request.basePath === false || !auth.request.url.startsWith('/')) continue
    const basePath = chainBasePath(connector.id, catalog)
    if (basePath) auth.request.url = joinPath(basePath, auth.request.url)
  }

  // 3. Fluxos que herdam: endpoints, ou fluxos comuns com o conector-pai.
  const endpointIds = new Map<string, Set<string>>()
  for (const [id, c] of catalog) endpointIds.set(id, new Set((c.endpoints ?? []).map((e) => e.id)))
  for (const { file, flow } of flows) {
    if (out.roles.has(flow.id) || baseIds.has(flow.id) || rejected.has(flow.id)) continue
    if (flow.nodes.some((n) => (n.type === 'request' && n.cache) || n.type === 'oauth2')) {
      issue(file, `"${flow.id}" tem um nó de auth (com cache, ou oauth2), que só vale num fluxo-base (com defaults, ou de quem outros herdam)`)
      continue
    }
    if (!flow.extends) {
      out.roles.set(flow.id, 'plain')
      if (flow.scenarios?.length || flow.examples?.length) issue(file, 'cenários e exemplos só valem num fluxo de requisição que herda de uma base (extends)')
      continue
    }
    if (!catalog.has(flow.extends)) {
      const parent = byId.get(flow.extends)
      issue(
        file,
        parent
          ? `"${flow.id}" herda de "${flow.extends}", que não é um fluxo-base válido (veja o aviso dele)`
          : `"${flow.id}" herda de "${flow.extends}", que não existe no workspace`
      )
      continue
    }
    const endpoint = requestFlowToEndpoint(flow)
    if (typeof endpoint === 'string') {
      if (flow.scenarios?.length || flow.examples?.length) {
        issue(file, `cenários e exemplos só valem num fluxo de requisição: ${endpoint}`)
        continue
      }
      out.roles.set(flow.id, 'inheriting')
      continue
    }
    const taken = endpointIds.get(flow.extends)!
    if (taken.has(endpoint.id)) {
      issue(file, `"${flow.extends}" já tem o endpoint "${endpoint.id}"; o fluxo "${flow.id}" foi ignorado`)
      continue
    }
    taken.add(endpoint.id)
    out.roles.set(flow.id, 'request')
    out.endpoints.push({ connectorId: flow.extends, endpoint, file, flowId: flow.id })
  }
  // A ordem dos endpoints é a do order de cada fluxo; sem order, depois, na ordem dos arquivos.
  const position = (flowId: string) => byId.get(flowId)?.flow.order ?? Number.MAX_SAFE_INTEGER
  out.endpoints.sort((a, b) => position(a.flowId) - position(b.flowId))
  return out
}

/** Um fluxo-base vira conector; o nó com cache, a auth `login`. Texto é o motivo de não traduzir. */
function baseToConnector(flow: Flow): { connector: Connector; login?: FlowRequestNode } | string {
  const d = flow.defaults ?? {}
  const config: ConnectorConfig = {
    ...(d.baseUrl !== undefined && { baseUrl: d.baseUrl }),
    ...(d.basePath !== undefined && { basePath: d.basePath }),
    ...(d.headers && { headers: { ...d.headers } }),
    ...(d.auth && { auth: structuredClone(d.auth) }),
    ...(d.tls && { tls: structuredClone(d.tls) }),
    ...(d.scripts && { scripts: { ...d.scripts } })
  }
  const login = flow.nodes.find((n): n is FlowRequestNode => n.type === 'request')
  const oauth2 = flow.nodes.find((n): n is FlowOAuth2Node => n.type === 'oauth2')
  if (flow.nodes.length > 1) return `o fluxo-base "${flow.id}" tem mais de um nó: por enquanto uma base tem só o nó de auth`
  if (d.auth?.type === 'login') return `o fluxo-base "${flow.id}" usa auth "login": o login é um nó de requisição com cache na própria base`
  if (oauth2) {
    if (d.auth) return `o fluxo-base "${flow.id}" tem o nó OAuth2 "${oauth2.name}" e também defaults.auth; fique com um dos dois`
    const ref = Object.entries(config.headers ?? {}).find(([, v]) => typeof v === 'string' && [...v.matchAll(NODE_REF)].length)
    if (ref) return `o header ${ref[0]} de "${flow.id}" lê $nodes: o token do nó OAuth2 já vai em Authorization sozinho`
    config.auth = structuredClone(oauth2.oauth2)
  } else if (login) {
    if (d.auth) return `o fluxo-base "${flow.id}" tem o nó de login "${login.name}" e também defaults.auth; fique com um dos dois`
    const auth = loginNodeToAuth(login, config.headers ?? {})
    if (typeof auth === 'string') return `fluxo-base "${flow.id}": ${auth}`
    delete config.headers![auth.header]
    if (!Object.keys(config.headers!).length) delete config.headers
    config.auth = auth.auth
  } else {
    const ref = Object.entries(config.headers ?? {}).find(([, v]) => typeof v === 'string' && [...v.matchAll(NODE_REF)].length)
    if (ref) return `o header ${ref[0]} de "${flow.id}" lê $nodes, mas a base não tem o nó de login com cache`
  }
  const source = flow.source && 'type' in flow.source ? (flow.source as ConnectorSource) : undefined
  const connector: Connector = {
    id: flow.id,
    name: flow.name,
    ...(flow.description !== undefined && { description: flow.description }),
    version: flow.version ?? '0.0.0',
    ...(flow.extends && { extends: flow.extends }),
    ...(Object.keys(config).length && { config }),
    ...(source && { source })
  }
  return { connector, ...(login && { login }) }
}

/** O nó de login com cache, e o header de `defaults` que lê a saída dele, viram a auth `login`. */
function loginNodeToAuth(node: FlowRequestNode, headers: Record<string, string>): { auth: AuthLogin; header: string } | string {
  const r = node.request
  const extra = (['connector', 'endpoint', 'query', 'pathParams', 'rawPathParams', 'timeoutMs', 'ignoreHttpErrors', 'followRedirects', 'fromScript', 'scripts', 'requestScripts', 'poll', 'bodySchema'] as const).filter(
    (k) => r[k] !== undefined
  )
  if (extra.length) return `o nó de login "${node.name}" não aceita ${extra.join(', ')} por enquanto`
  if (!r.method || !r.url) return `o nó de login "${node.name}" precisa de method e url`
  if (!/^(https?:\/\/|\/|\{\{)/.test(r.url)) return `a url do nó de login "${node.name}" precisa ser absoluta, começar com / ou com {{VAR}}`

  const users = Object.entries(headers).filter(([, v]) => typeof v === 'string' && [...v.matchAll(NODE_REF)].some((m) => m[1] === node.name))
  if (users.length === 0) {
    return `o nó "${node.name}" tem cache, mas nenhum header de defaults usa a saída dele (ex.: Authorization: Bearer {{ $nodes.${node.name}.data.token }})`
  }
  if (users.length > 1) return `só um header de defaults pode ler o login por enquanto (${users.map(([n]) => n).join(', ')} leem "${node.name}")`
  const [header, value] = users[0]!
  const refs = [...value.matchAll(NODE_REF)]
  if (refs.length !== 1) return `o header ${header} lê $nodes mais de uma vez; use uma referência só ao login`
  const path = refs[0]![2]!
  const token = path.startsWith('.data.') || path.startsWith('.data[') ? `body${path.slice(5)}` : /^\.headers\.[^.[]+$/.test(path) ? `headers${path.slice(8)}` : undefined
  if (!token) return `o header ${header} precisa ler $nodes.${node.name}.data.<campo> ou $nodes.${node.name}.headers.<nome>`
  for (const [name, v] of Object.entries(headers)) {
    if (name !== header && typeof v === 'string' && [...v.matchAll(NODE_REF)].length) return `o header ${name} lê $nodes, mas só o header do login pode ler a saída de um nó da base`
  }

  const request: AuthLoginRequest = { method: r.method, url: r.url }
  if (r.headers) {
    const nulls = Object.entries(r.headers).filter(([, v]) => v === null)
    if (nulls.length) return `o nó de login "${node.name}" não aceita header null`
    request.headers = r.headers as Record<string, string>
  }
  if (r.payload) {
    if (r.body !== undefined) return `o nó de login "${node.name}" tem body e payload`
    if (r.payload.mode !== 'urlencoded' || r.payload.fields.some((f) => f.value === undefined)) {
      return `o nó de login "${node.name}" só aceita payload urlencoded com valores de texto`
    }
    request.form = Object.fromEntries(r.payload.fields.map((f) => [f.name, f.value!]))
  } else if (typeof r.body === 'string') {
    request.body = r.body
  } else if (r.body !== undefined) {
    request.json = r.body
  }
  const ref = refs[0]![0]
  const auth: AuthLogin = {
    type: 'login',
    request,
    token,
    ...(node.cache?.expiresIn && { expiresIn: `body${node.cache.expiresIn.slice(4)}` }),
    ...(node.cache?.ttlSeconds !== undefined && { ttlSeconds: node.cache.ttlSeconds })
  }
  const template = value.replace(ref, '{{$token}}')
  if (header !== 'Authorization' || template !== 'Bearer {{$token}}') auth.inject = { in: 'header', name: header, value: template }
  return { auth, header }
}

/** Um fluxo que é só um nó de requisição vira endpoint. Texto é o motivo de não ser. */
export function requestFlowToEndpoint(flow: Flow): Endpoint | string {
  if (flow.nodes.length !== 1 || flow.edges?.length) return `"${flow.id}" tem mais de um nó`
  const node = flow.nodes[0]!
  if (node.type !== 'request') return `"${flow.id}" não termina num nó de requisição`
  if (node.cache) return `o nó de "${flow.id}" tem cache, que só vale num fluxo-base`
  const r = node.request
  const extra = (['connector', 'endpoint', 'pathParams', 'rawPathParams', 'timeoutMs', 'followRedirects', 'fromScript', 'scripts', 'poll', 'basePath'] as const).filter(
    (k) => r[k] !== undefined
  )
  if (extra.length) return `o nó de "${flow.id}" usa ${extra.join(', ')}`
  if (!r.method || !r.url?.startsWith('/')) return `o nó de "${flow.id}" precisa de method e de uma url começando com /`
  const nullHeader = Object.entries(r.headers ?? {}).some(([, v]) => v === null)
  const nullQuery = Object.entries(r.query ?? {}).some(([, v]) => v === null)
  if (nullHeader || nullQuery) return `o nó de "${flow.id}" tira um header ou parâmetro herdado (null)`
  const source = flow.source && 'operation' in flow.source ? (flow.source as EndpointSource) : undefined
  // Numa base de outro projeto ("estoque:cnpj"), o prefixo do id é o da base sem o projeto.
  const parent = flow.extends?.slice(flow.extends.indexOf(':') + 1)
  const id = parent && flow.id.startsWith(`${parent}.`) ? flow.id.slice(parent.length + 1) : flow.id
  return {
    id,
    name: flow.name,
    ...(flow.description !== undefined && { description: flow.description }),
    method: r.method,
    path: r.url,
    ...(flow.requiresAuth !== undefined && { requiresAuth: flow.requiresAuth }),
    ...(r.headers && { headers: r.headers as Record<string, string> }),
    ...(r.query && { query: r.query as Record<string, string> }),
    ...(r.bodySchema && { bodySchema: r.bodySchema }),
    ...(r.body !== undefined && { body: r.body }),
    ...(r.payload && { payload: r.payload }),
    ...(r.requestScripts && { scripts: r.requestScripts }),
    ...(source && { source }),
    ...(flow.scenarios && { scenarios: flow.scenarios }),
    ...(flow.examples && { examples: flow.examples })
  }
}

/**
 * basePath acumulado da raiz até o conector (inclusive), sem as outras conferências da
 * herança: serve para converter um conector cuja herança tem conflito, que continua com o
 * mesmo conflito depois.
 */
export function chainBasePath(id: string, catalog: ReadonlyMap<string, Connector>): string {
  const parts: string[] = []
  const seen = new Set<string>()
  for (let c = catalog.get(id); c && !seen.has(c.id); c = c.extends ? catalog.get(c.extends) : undefined) {
    seen.add(c.id)
    if (c.config?.basePath) parts.unshift(c.config.basePath)
  }
  return joinPath('', ...parts)
}

export interface ConnectorAsFlows {
  base: Flow
  requests: Flow[]
  /** O que ainda não tem forma de fluxo (o conector fica no formato antigo). */
  unsupported: string[]
}

/**
 * O caminho de volta: um conector vira um fluxo-base e um fluxo de requisição por
 * endpoint. `basePath` é o basePath acumulado da cadeia até este conector (inclusive),
 * para o login, que na auth `login` entra só depois da baseUrl.
 */
export function connectorToFlows(connector: Connector, basePath = ''): ConnectorAsFlows {
  const unsupported: string[] = []
  const c = connector.config ?? {}
  const headers: Record<string, string> = { ...c.headers }
  const nodes: FlowNode[] = []
  let auth = c.auth
  if (auth?.type === 'login') {
    if (auth.inject?.in === 'query') unsupported.push('auth login com o token na query')
    const tokenPath = auth.token.startsWith('body') ? `data${auth.token.slice(4)}` : auth.token
    const name = auth.inject?.name ?? 'Authorization'
    const template = auth.inject?.value ?? 'Bearer {{$token}}'
    headers[name] = template.replace('{{$token}}', `{{ $nodes.${LOGIN_NODE.name}.${tokenPath} }}`)
    const { request } = auth
    const body = request.form
      ? { payload: { mode: 'urlencoded' as const, fields: Object.entries(request.form).map(([name, value]) => ({ name, value })) } }
      : request.body !== undefined
        ? { body: request.body }
        : request.json !== undefined
          ? { body: request.json }
          : {}
    nodes.push({
      ...LOGIN_NODE,
      type: 'request',
      // O cache é o que faz do nó o login da base, mesmo sem validade conhecida.
      cache: {
        ...(auth.expiresIn && { expiresIn: `data${auth.expiresIn.slice(4)}` }),
        ...(auth.ttlSeconds !== undefined && { ttlSeconds: auth.ttlSeconds })
      },
      request: {
        method: request.method ?? 'POST',
        url: request.url,
        ...(basePath && request.url.startsWith('/') && { basePath: false }),
        ...(request.headers && { headers: request.headers }),
        ...body
      }
    } as FlowRequestNode)
    auth = undefined
  }
  if (auth?.type === 'oauth2') {
    nodes.push({ ...OAUTH2_NODE, type: 'oauth2', oauth2: auth })
    auth = undefined
  }
  const defaults = {
    ...(c.baseUrl !== undefined && { baseUrl: c.baseUrl }),
    ...(c.basePath !== undefined && { basePath: c.basePath }),
    ...(Object.keys(headers).length && { headers }),
    ...(auth && { auth }),
    ...(c.tls && { tls: c.tls }),
    ...(c.scripts && { scripts: c.scripts })
  }
  const base: Flow = {
    id: connector.id,
    name: connector.name,
    ...(connector.description !== undefined && { description: connector.description }),
    version: connector.version,
    ...(connector.extends && { extends: connector.extends }),
    // Sempre presente: é o que marca o fluxo como base, mesmo sem filhos.
    defaults,
    nodes,
    ...(connector.source && { source: connector.source })
  }
  const requests: Flow[] = []
  for (const [i, e] of (connector.endpoints ?? []).entries()) {
    if (e.plugin) {
      unsupported.push(`endpoint "${e.id}" com plugin (${e.plugin.adapter})`)
      continue
    }
    requests.push({
      id: `${connector.id}.${e.id}`,
      name: e.name,
      ...(e.description !== undefined && { description: e.description }),
      extends: connector.id,
      // Um arquivo por endpoint: a ordem do conector fica no order.
      order: i + 1,
      nodes: [
        {
          ...REQUEST_NODE_OF_ENDPOINT,
          type: 'request',
          request: {
            method: e.method,
            url: e.path,
            ...(e.headers && { headers: e.headers }),
            ...(e.query && { query: e.query }),
            ...(e.body !== undefined && { body: e.body }),
            ...(e.payload && { payload: e.payload }),
            ...(e.bodySchema && { bodySchema: e.bodySchema }),
            ...(e.scripts && { requestScripts: e.scripts })
          }
        }
      ],
      ...(e.requiresAuth !== undefined && { requiresAuth: e.requiresAuth }),
      ...(e.scenarios && { scenarios: e.scenarios }),
      ...(e.examples && { examples: e.examples }),
      ...(e.source && { source: e.source })
    })
  }
  return { base, requests, unsupported }
}
