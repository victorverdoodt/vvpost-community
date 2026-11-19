import type {
  CatalogConnector,
  Flow,
  HttpHeader,
  HttpMethod,
  FlowEdge,
  FlowNode,
  FlowNodeResult,
  PluginContribution
} from '@shared/ipc'

export type FlowNodeType = FlowNode['type']

export const NODE_LABELS: Record<FlowNodeType, string> = {
  request: 'Requisição',
  condition: 'Condição',
  python: 'Python',
  plugin: 'Plugin',
  wait: 'Espera',
  webhook: 'Webhook',
  oauth2: 'OAuth2'
}

/** Chave de uma contribuição de plugin: node:javascript.script ou adapter:graphql. */
export const contributionKey = (kind: PluginContribution['kind'], name: string) => `${kind}:${name}`

/** A contribuição que um nó de plugin usa, como chave. */
export function pluginKeyOf(node: Extract<FlowNode, { type: 'plugin' }>): string {
  return node.plugin.node
    ? contributionKey('node', node.plugin.node)
    : contributionKey('adapter', node.plugin.adapter ?? '')
}

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Nome válido em $nodes.<nome> e ainda livre no fluxo (ignorando o próprio nó). */
export function nameProblem(flow: Flow, nodeId: string, name: string): string | null {
  if (!NAME_PATTERN.test(name)) return 'use letras, números e _, começando por letra (vai em $nodes.Nome)'
  if (name.length > 64) return 'no máximo 64 caracteres'
  if (flow.nodes.some((n) => n.id !== nodeId && n.name === name)) return `já existe um nó ${name}`
  return null
}

/** Slug para o id do fluxo: "Checkout PIX" → flow.checkout-pix. */
export function flowIdFor(name: string, taken: ReadonlySet<string>): string {
  const slug =
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'novo'
  let id = `flow.${slug}`
  for (let i = 2; taken.has(id); i++) id = `flow.${slug}-${i}`
  return id
}

/** Id e nome livres no fluxo: n3 e Request2, por exemplo. */
function freshIdentity(flow: Flow, prefix: string): { id: string; name: string } {
  const ids = new Set(flow.nodes.map((n) => n.id))
  const names = new Set(flow.nodes.map((n) => n.name))
  let i = 1
  while (ids.has(`n${i}`)) i++
  let j = 1
  while (names.has(`${prefix}${j}`)) j++
  return { id: `n${i}`, name: `${prefix}${j}` }
}

/** Novo nó com id e nome livres (Request1, Condition2...). */
export function newNode(
  flow: Flow,
  type: Exclude<FlowNodeType, 'plugin' | 'oauth2'>,
  position: { x: number; y: number }
): FlowNode {
  const prefix = { request: 'Request', condition: 'Condition', wait: 'Wait', webhook: 'Webhook', python: 'Python' }[
    type
  ]
  const { id, name } = freshIdentity(flow, prefix)
  switch (type) {
    case 'request':
      return { id, name, type, position, request: { method: 'GET', url: '' } }
    case 'condition':
      return { id, name, type, position, condition: { target: '$nodes.', operator: 'equals', expected: 200 } }
    case 'python':
      return { id, name, type, position, python: { code: '# nodes tem a saída dos nós anteriores\noutput = {}\n' } }
    case 'wait':
      return { id, name, type, position, wait: { ms: 1000 } }
    case 'webhook':
      return { id, name, type, position, webhook: { method: 'POST', path: '/' } }
  }
}

/** Tipo do arraste de um endpoint do catálogo para o canvas (dataTransfer). */
export const ENDPOINT_DRAG_TYPE = 'application/x-vvpost-endpoint'

export interface EndpointRef {
  connector: string
  endpoint: string
}

/** O endpoint de um arraste, ou null quando o que chegou não é um endpoint do catálogo. */
export function parseEndpointDrag(data: string): EndpointRef | null {
  try {
    const v = JSON.parse(data) as Partial<EndpointRef>
    return typeof v.connector === 'string' && typeof v.endpoint === 'string' && v.connector && v.endpoint
      ? { connector: v.connector, endpoint: v.endpoint }
      : null
  } catch {
    return null
  }
}

/** Nome de nó a partir do nome do endpoint: "Criar cobrança" → CriarCobranca. */
export function nodeNameFor(text: string): string {
  const name = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join('')
    .replace(/^[0-9]+/, '')
    .slice(0, 56)
  return name || 'Request'
}

/**
 * Nó de requisição de um endpoint do catálogo (arrastado para o canvas). Guarda só a referência
 * a conector e endpoint: método, caminho, headers, auth, base URL, scripts e corpo continuam
 * vindo da herança na hora de rodar, como no Quick Request e nos cenários.
 */
export function newEndpointNode(
  flow: Flow,
  ref: EndpointRef,
  endpointName: string,
  position: { x: number; y: number }
): FlowNode {
  const base = nodeNameFor(endpointName)
  const names = new Set(flow.nodes.map((n) => n.name))
  const { id, name: numbered } = freshIdentity(flow, base)
  const name = names.has(base) ? numbered : base
  return { id, name, type: 'request', position, request: { connector: ref.connector, endpoint: ref.endpoint } }
}

/** Novo nó de plugin, com os defaults dos campos já na config (o arquivo mostra o que o nó usa). */
export function newPluginNode(
  flow: Flow,
  contribution: PluginContribution,
  position: { x: number; y: number }
): FlowNode {
  const prefix =
    contribution.title
      .normalize('NFD')
      .replace(/[^A-Za-z0-9_]/g, '')
      .replace(/^[0-9]+/, '') || 'Plugin'
  const { id, name } = freshIdentity(flow, prefix.slice(0, 40))
  const config = Object.fromEntries(
    contribution.fields.filter((f) => f.default !== undefined).map((f) => [f.key, f.default])
  )
  const plugin =
    contribution.kind === 'node' ? { node: contribution.name, config } : { adapter: contribution.name, config }
  return { id, name, type: 'plugin', position, plugin }
}

/** Nomes dos nós anteriores a `nodeId` (o que ele enxerga em $nodes), na ordem do fluxo. */
export function ancestorsOf(flow: Flow, nodeId: string): string[] {
  const incoming = new Map<string, string[]>()
  for (const e of flow.edges ?? []) incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from])
  const found = new Set<string>()
  const stack = [...(incoming.get(nodeId) ?? [])]
  while (stack.length) {
    const id = stack.pop()!
    if (found.has(id)) continue
    found.add(id)
    stack.push(...(incoming.get(id) ?? []))
  }
  return flow.nodes.filter((n) => found.has(n.id)).map((n) => n.name)
}

/** Ligar from → to criaria um ciclo (to já alcança from)? */
export function createsCycle(flow: Flow, from: string, to: string): boolean {
  if (from === to) return true
  const next = new Map<string, string[]>()
  for (const e of flow.edges ?? []) next.set(e.from, [...(next.get(e.from) ?? []), e.to])
  const stack = [to]
  const seen = new Set<string>()
  while (stack.length) {
    const id = stack.pop()!
    if (id === from) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(next.get(id) ?? []))
  }
  return false
}

export function edgeKey(e: FlowEdge): string {
  return `${e.from}->${e.to}${e.branch ? `:${e.branch}` : ''}`
}

/** Posições para nós sem posição: uma coluna por profundidade no grafo. */
export function autoLayout(flow: Flow): Flow {
  if (flow.nodes.every((n) => n.position)) return flow
  const depth = new Map<string, number>()
  const incoming = new Map<string, string[]>()
  for (const e of flow.edges ?? []) incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from])
  const depthOf = (id: string, guard = 0): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    const d =
      guard > flow.nodes.length ? 0 : Math.max(-1, ...(incoming.get(id) ?? []).map((p) => depthOf(p, guard + 1))) + 1
    depth.set(id, d)
    return d
  }
  const rows = new Map<number, number>()
  return {
    ...flow,
    nodes: flow.nodes.map((n) => {
      if (n.position) return n
      const d = depthOf(n.id)
      const row = rows.get(d) ?? 0
      rows.set(d, row + 1)
      return { ...n, position: { x: d * 280, y: row * 140 } }
    })
  }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Caminho de uma expressão: ['Login', 'data', 'items', 0]. */
export function pathExpression(path: (string | number)[]): string {
  return path.reduce<string>(
    (acc, part) =>
      typeof part === 'number' ? `${acc}[${part}]` : IDENT.test(part) ? `${acc}.${part}` : `${acc}["${part}"]`,
    '$nodes'
  )
}

/** O mesmo caminho em JavaScript, para o nó do plugin JavaScript: nodes.Login.data.items[0]. */
export function javascriptExpression(path: (string | number)[]): string {
  return pathExpression(path).slice(1)
}

/** O mesmo caminho em Python, para o nó Python: nodes['Login']['data']['items'][0]. */
export function pythonExpression(path: (string | number)[]): string {
  return path.reduce<string>(
    (acc, part) => `${acc}[${typeof part === 'number' ? part : JSON.stringify(part)}]`,
    'nodes'
  )
}

/** Saídas conhecidas por nome de nó (da última execução), no formato de $nodes. */
export type KnownOutputs = ReadonlyMap<string, FlowNodeResult['output']>

export interface Completion {
  /** Texto que substitui o trecho digitado depois do último ponto. */
  insert: string
  label: string
  detail?: string
}

function childKeys(value: unknown): { key: string | number; value: unknown }[] {
  if (Array.isArray(value)) return value.slice(0, 50).map((v, i) => ({ key: i, value: v }))
  if (value && typeof value === 'object')
    return Object.entries(value)
      .slice(0, 200)
      .map(([key, v]) => ({ key, value: v }))
  return []
}

export function describeValue(value: unknown): string {
  if (Array.isArray(value)) return `lista (${value.length})`
  if (value === null) return 'null'
  if (typeof value === 'object') return 'objeto'
  if (typeof value === 'string') return value.length > 40 ? `"${value.slice(0, 40)}…"` : JSON.stringify(value)
  return String(value)
}

/**
 * Autocomplete de {{ $nodes... }}: dado o texto antes do cursor, o que pode vir em
 * seguida. Nomes vêm dos nós anteriores; campos, da saída da última execução (ou
 * data/status/headers quando o nó ainda não rodou). null: o cursor não está numa referência.
 */
export function completionsAt(
  before: string,
  ancestors: readonly string[],
  outputs: KnownOutputs
): { replaceFrom: number; items: Completion[] } | null {
  const ref = /\$nodes((?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\]|\["[^"]*"\])*)(\.?)$/.exec(before)
  if (!ref) {
    // Logo depois de "{{", sugere o começo da referência.
    const open = /\{\{\s*(\$?[A-Za-z_]*)$/.exec(before)
    if (!open || !'$nodes'.startsWith(open[1]!.slice(0, 6))) return null
    return {
      replaceFrom: before.length - open[1]!.length,
      items: ancestors.map((name) => ({ insert: `$nodes.${name}`, label: `$nodes.${name}` }))
    }
  }
  const tokens = [...ref[1]!.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]|\["([^"]*)"\]/g)]
  const parts = tokens.map((m) => m[1] ?? (m[2] !== undefined ? Number(m[2]) : m[3]!))
  let typed = ''
  if (!ref[2]) {
    // Sem ponto no fim: o último nome ainda está sendo digitado ("$nodes.Lo").
    const last = tokens.at(-1)
    if (!last?.[1]) return null
    typed = last[1]
    parts.pop()
  }
  const replaceFrom = before.length - typed.length
  if (parts.length === 0) {
    return {
      replaceFrom,
      items: ancestors.filter((n) => n.startsWith(typed)).map((name) => ({ insert: name, label: name }))
    }
  }
  const [name, ...rest] = parts as [string, ...(string | number)[]]
  if (!ancestors.includes(String(name))) return { replaceFrom, items: [] }
  const output = outputs.get(String(name))
  let value: unknown = output ?? { data: undefined, status: undefined, headers: undefined }
  for (const part of rest) value = (value as Record<string | number, unknown> | undefined)?.[part]
  const items = childKeys(value)
    .filter(({ key }) => String(key).startsWith(typed))
    .map(({ key, value: v }) => ({
      insert: typeof key === 'number' || !IDENT.test(key) ? '' : key,
      label: typeof key === 'number' ? `[${key}]` : key,
      detail: v === undefined ? undefined : describeValue(v)
    }))
    .filter((c) => c.insert)
  return { replaceFrom, items }
}

/** Cópia do nó com id e nome livres, um pouco abaixo e à direita do original. */
export function duplicateNode(flow: Flow, node: FlowNode): FlowNode {
  const base = node.name.replace(/[0-9]+$/, '') || 'Node'
  const { id, name } = freshIdentity(flow, base)
  const p = node.position ?? { x: 0, y: 0 }
  return { ...structuredClone(node), id, name, position: { x: p.x + 40, y: p.y + 60 } }
}

/** Só o nó e o que ele precisa antes ("Executar até aqui"): os ancestrais e as arestas entre eles. */
export function subflowUntil(flow: Flow, nodeId: string): Flow {
  const incoming = new Map<string, string[]>()
  for (const e of flow.edges ?? []) incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from])
  const keep = new Set<string>([nodeId])
  const stack = [...(incoming.get(nodeId) ?? [])]
  while (stack.length) {
    const id = stack.pop()!
    if (keep.has(id)) continue
    keep.add(id)
    stack.push(...(incoming.get(id) ?? []))
  }
  return {
    ...flow,
    nodes: flow.nodes.filter((n) => keep.has(n.id)),
    edges: (flow.edges ?? []).filter((e) => keep.has(e.from) && keep.has(e.to))
  }
}

const TEMPLATE = /\{\{\s*(\$nodes[.[][^{}]*?)\s*\}\}/g
const EXACT = /^\{\{\s*(\$nodes[.[][^{}]*?)\s*\}\}$/

/** Lê $nodes.Nome.data.campo na saída da última execução; undefined se o nó não rodou ou o campo não existe. */
export function readOutput(expression: string, outputs: KnownOutputs): unknown {
  const m = /^\$nodes\.([A-Za-z_][A-Za-z0-9_]*)(.*)$/s.exec(expression.trim())
  if (!m) return undefined
  let current: unknown = outputs.get(m[1]!)
  for (const part of m[2]!.match(/[^.[\]]+/g) ?? []) {
    const key = part.replace(/^(["'])(.*)\1$/, '$2')
    if (current && typeof current === 'object' && Object.hasOwn(current, key))
      current = (current as Record<string, unknown>)[key]
    else return undefined
  }
  return current
}

/**
 * Troca as referências {{ $nodes... }} de um texto pelos valores da última execução
 * (ao abrir um nó no Quick Request). As que não têm valor ficam como estão e vão para `missing`.
 */
export function fillNodeReferences(text: string, outputs: KnownOutputs, missing: Set<string>): string {
  return text.replace(TEMPLATE, (whole, inner: string) => {
    const value = readOutput(inner, outputs)
    if (value === undefined) {
      missing.add(inner.trim())
      return whole
    }
    return typeof value === 'string' ? value : JSON.stringify(value)
  })
}

/** Corpo JSON: um texto que é só uma referência vira o valor (objeto, número), como no motor. */
export function fillNodeReferencesJson(value: unknown, outputs: KnownOutputs, missing: Set<string>): unknown {
  if (typeof value === 'string') {
    const exact = EXACT.exec(value)?.[1]
    if (exact !== undefined) {
      const v = readOutput(exact, outputs)
      if (v !== undefined) return v
      missing.add(exact.trim())
      return value
    }
    return fillNodeReferences(value, outputs, missing)
  }
  if (Array.isArray(value)) return value.map((v) => fillNodeReferencesJson(v, outputs, missing))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillNodeReferencesJson(v, outputs, missing)]))
  return value
}

/** O formato de lib/open-request (sem importar o renderer: este arquivo também roda nos testes). */
export interface NodeAsRequest {
  method: HttpMethod
  url: string
  headers: HttpHeader[]
  body: string
  connectorId: string | null
  environmentId: string | null
  endpointId: string | null
}

/** Requisição do Quick Request a partir de um nó, com os $nodes da última execução já preenchidos. */
export function requestFromNode(
  node: Extract<FlowNode, { type: 'request' }>,
  connectors: readonly CatalogConnector[],
  outputs: KnownOutputs
): { request: NodeAsRequest; missing: string[] } {
  const r = node.request
  const missing = new Set<string>()
  const fill = (text: string) => fillNodeReferences(text, outputs, missing)
  const connector = connectors.find((c) => c.id === r.connector)
  const endpoint = connector?.endpoints.find((e) => e.id === r.endpoint)
  let url = fill(r.url ?? endpoint?.path ?? '')
  for (const [name, value] of Object.entries(r.pathParams ?? {}))
    url = url.split(`{${name}}`).join(encodeURIComponent(fill(value)))
  const query = Object.entries(r.query ?? {}).filter((e): e is [string, string] => e[1] !== null)
  if (query.length) {
    const qs = query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(fill(v))}`).join('&')
    url += `${url.includes('?') ? '&' : '?'}${qs}`
  }
  let headers = [...(endpoint?.headers ?? [])]
  for (const [name, value] of Object.entries(r.headers ?? {})) {
    headers = headers.filter((h) => h.name.toLowerCase() !== name.toLowerCase())
    if (value !== null) headers.push({ name, value: fill(value) })
  }
  const body =
    r.body === undefined
      ? (endpoint?.body ?? '')
      : typeof r.body === 'string'
        ? fill(r.body)
        : JSON.stringify(fillNodeReferencesJson(r.body, outputs, missing), null, 2)
  return {
    request: {
      method: r.method ?? endpoint?.method ?? 'GET',
      url,
      headers,
      body,
      connectorId: connector ? connector.id : null,
      environmentId: null,
      endpointId: endpoint?.id ?? null
    },
    missing: [...missing]
  }
}

/**
 * Ambiente protegido: o que o catálogo diz (`protected`, do arquivo ou do nome de produção) e,
 * sem o campo, o nome que parece de produção (env.prod, Produção, live).
 */
export const looksLikeProduction = (env: { id: string; name: string; protected?: boolean } | undefined): boolean =>
  !!env && (env.protected ?? /prod|produ[çc][ãa]o|\blive\b/i.test(`${env.id} ${env.name}`))

export interface HighImpact {
  nodeId: string
  name: string
  reason: string
}

/**
 * Operações externas de impacto elevado que pedem confirmação antes de
 * rodar: DELETE sempre; POST, PUT e PATCH num ambiente de produção; e, em produção, o nó
 * Python com rede para qualquer host. Os nós que só leem rodam sem perguntar.
 */
export function highImpactOperations(
  flow: Flow,
  connectors: readonly CatalogConnector[],
  env: { id: string; name: string; protected?: boolean } | undefined
): HighImpact[] {
  const production = looksLikeProduction(env)
  const out: HighImpact[] = []
  for (const node of flow.nodes) {
    if (node.type === 'request') {
      const endpoint = connectors
        .find((c) => c.id === node.request.connector)
        ?.endpoints.find((e) => e.id === node.request.endpoint)
      const method = node.request.method ?? endpoint?.method ?? 'GET'
      if (method === 'DELETE') out.push({ nodeId: node.id, name: node.name, reason: 'DELETE apaga um recurso' })
      else if (production && (method === 'POST' || method === 'PUT' || method === 'PATCH'))
        out.push({ nodeId: node.id, name: node.name, reason: `${method} grava em ${env!.name}` })
    } else if (node.type === 'python' && production && node.python.network?.includes('*'))
      out.push({ nodeId: node.id, name: node.name, reason: `Python com rede para qualquer host em ${env!.name}` })
  }
  return out
}

/**
 * Autocomplete do editor Python: depois de `nodes[` sugere os nós anteriores e, depois de
 * `nodes['Login'][`, as chaves da última execução (data, status, headers e o que veio dentro).
 * `typed` é o trecho já digitado, que a sugestão substitui; `quote` diz se ele abriu aspas.
 */
export function pythonCompletionsAt(
  before: string,
  ancestors: readonly string[],
  outputs: KnownOutputs
): { typed: string; quote: string; items: Completion[] } | null {
  const m = /nodes((?:\[(?:'[^']*'|"[^"]*"|\d+)\])*)\[(['"]?)([A-Za-z0-9_ -]*)$/.exec(before)
  if (!m) return null
  const parts = [...m[1]!.matchAll(/\[(?:'([^']*)'|"([^"]*)"|(\d+))\]/g)].map((p) => p[1] ?? p[2] ?? Number(p[3]))
  const quote = m[2]!
  const typed = m[3]!
  const key = (k: string | number) =>
    typeof k === 'number' ? (quote ? null : String(k)) : `${quote || "'"}${k}${quote || "'"}`
  if (parts.length === 0)
    return {
      typed,
      quote,
      items: ancestors
        .filter((n) => n.startsWith(typed))
        .map((name) => ({ insert: `${key(name)!.slice(quote.length)}]`, label: name }))
    }
  const [name, ...rest] = parts
  if (!ancestors.includes(String(name))) return { typed, quote, items: [] }
  let value: unknown = outputs.get(String(name)) ?? { data: undefined, status: undefined, headers: undefined }
  for (const part of rest) value = (value as Record<string | number, unknown> | undefined)?.[part]
  const items: Completion[] = []
  for (const { key: k, value: v } of childKeys(value)) {
    if (!String(k).startsWith(typed)) continue
    const text = key(k)
    if (text !== null)
      items.push({ insert: `${text.slice(quote.length)}]`, label: String(k), detail: describeValue(v) })
  }
  return { typed, quote, items }
}
