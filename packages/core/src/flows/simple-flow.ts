import type { Flow, FlowEdge, FlowHttpMethod, FlowNode, FlowPosition, FlowRequest, RequestPayload, RequestScripts } from '@vvpost/schemas'

/**
 * Requisição e fluxo são o mesmo documento. Um fluxo que termina num nó de requisição abre no
 * Quick Request (a visão Simples): a aba edita esse nó, e os nós anteriores rodam em segundo
 * plano antes do envio, como a preparação, com a requisição lendo {{ $nodes... }} deles. O Flow
 * Studio é a visão Canvas do mesmo arquivo. Sem Node: o renderer usa.
 */

/** A requisição como a visão Simples a edita. */
export interface SimpleRequest {
  method: FlowHttpMethod
  url: string
  headers: { name: string; value: string }[]
  body?: string
  payload?: RequestPayload
  connector?: string
  /** Endpoint do conector: os scripts dele (e do conector) rodam em volta do envio. */
  endpoint?: string
  /** Scripts pre e post da própria requisição, depois dos herdados. */
  scripts?: RequestScripts
  timeoutMs?: number
  followRedirects?: boolean
}

/** O nó da requisição no fluxo: id, nome e posição voltam iguais ao salvar. */
export interface SimpleNode {
  id: string
  name: string
  position?: FlowPosition
}

/**
 * O que a visão Simples não edita e volta igual ao salvar: a herança do fluxo (extends) e o que
 * faz dele um endpoint (cenários, exemplos, a origem na spec, o schema do corpo).
 */
export interface SimpleKeep {
  flow?: Pick<Flow, 'extends' | 'version' | 'requiresAuth' | 'scenarios' | 'examples' | 'source'>
  request?: Pick<FlowRequest, 'bodySchema'>
}

/** Um fluxo na visão Simples: a requisição do último nó e o que roda antes dela. */
export interface SimpleFlow {
  request: SimpleRequest
  node: SimpleNode
  keep: SimpleKeep
  /** Os nós anteriores, como um fluxo (a preparação); null quando a requisição é o fluxo todo. */
  before: Flow | null
  /** Nós de `before` ligados direto à requisição. */
  incoming: string[]
}

/** Nome do nó de requisição de um fluxo novo. */
export const SIMPLE_NODE = 'Requisicao'

const has = (text: string | undefined): text is string => !!text?.trim()

function ownScripts(scripts: RequestScripts | undefined): RequestScripts | undefined {
  const pre = has(scripts?.pre) ? scripts.pre : undefined
  const post = has(scripts?.post) ? scripts.post : undefined
  return pre || post ? { ...(pre && { pre }), ...(post && { post }) } : undefined
}

function unique(base: string, taken: Set<string>): string {
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`
  return name
}

/** Os nós sem saída (onde o fluxo termina). */
function sinks(flow: Flow): FlowNode[] {
  const from = new Set((flow.edges ?? []).map((e) => e.from))
  return flow.nodes.filter((n) => !from.has(n.id))
}

/**
 * O fluxo que a requisição é. Com `before`, os nós dele vêm antes e os nós finais dele (ou
 * `incoming`) ligam na requisição. Uma resposta 4xx/5xx segue como resposta, como no Quick Request.
 */
export function requestToFlow(
  req: SimpleRequest,
  meta: { id: string; name: string; description?: string; keep?: SimpleKeep },
  options: { before?: Flow | null; node?: SimpleNode; incoming?: string[] } = {}
): Flow {
  const before = options.before?.nodes.length ? options.before : null
  const headers = req.headers.filter((h) => h.name.trim())
  const scripts = ownScripts(req.scripts)
  // O conector da base (extends) vem da herança: não vai para o nó.
  const connector = req.connector && req.connector !== meta.keep?.flow?.extends ? req.connector : undefined
  const request: FlowRequest = {
    ...(connector && { connector }),
    ...(connector && req.endpoint && { endpoint: req.endpoint }),
    method: req.method,
    url: req.url,
    ...(headers.length && { headers: Object.fromEntries(headers.map((h) => [h.name.trim(), h.value])) }),
    ...(req.payload ? { payload: req.payload } : has(req.body) && { body: req.body }),
    ...(req.timeoutMs !== undefined && { timeoutMs: req.timeoutMs }),
    ...(req.followRedirects !== undefined && { followRedirects: req.followRedirects }),
    ignoreHttpErrors: true,
    ...(scripts && { requestScripts: scripts }),
    ...meta.keep?.request
  }
  const nodes = before?.nodes ?? []
  const ids = new Set(nodes.map((n) => n.id))
  const names = new Set(nodes.map((n) => n.name))
  const id = options.node && !ids.has(options.node.id) ? options.node.id : unique('request', ids)
  const name = options.node && !names.has(options.node.name) ? options.node.name : unique(SIMPLE_NODE, names)
  const right = nodes.reduce((x, n) => Math.max(x, (n.position?.x ?? 0) + 260), 0)
  const position = options.node?.position ?? { x: right, y: 0 }
  const incoming = before ? (options.incoming?.filter((x) => ids.has(x)) ?? sinks(before).map((n) => n.id)) : []
  const edges: FlowEdge[] = [...(before?.edges ?? []), ...incoming.map((from) => ({ from, to: id }))]
  return {
    id: meta.id,
    name: meta.name,
    ...(meta.description && { description: meta.description }),
    ...meta.keep?.flow,
    nodes: [...nodes, { id, name, type: 'request', position, request }],
    edges
  }
}

/** Os ids dos nós anteriores a `id` no grafo. */
function ancestors(flow: Flow, id: string): Set<string> {
  const into = new Map<string, string[]>()
  for (const e of flow.edges ?? []) into.set(e.to, [...(into.get(e.to) ?? []), e.from])
  const seen = new Set<string>()
  const stack = [...(into.get(id) ?? [])]
  while (stack.length) {
    const next = stack.pop()!
    if (seen.has(next)) continue
    seen.add(next)
    stack.push(...(into.get(next) ?? []))
  }
  return seen
}

/**
 * O fluxo na visão Simples, quando ele cabe nela: termina num nó de requisição só, e todo outro
 * nó roda antes dele. O nó precisa de método e URL, sem polling, sem script anterior montando a
 * requisição e sem desligar os scripts herdados. null quando não cabe (o fluxo fica no canvas).
 */
export function splitFlow(flow: Flow): SimpleFlow | null {
  // Um fluxo-base (o login com cache e os defaults de quem herda) fica no canvas.
  if (flow.defaults || flow.nodes.some((n) => n.type === 'request' && n.cache)) return null
  const ends = sinks(flow)
  if (ends.length !== 1) return null
  const node = ends[0]!
  if (node.type !== 'request') return null
  const before = ancestors(flow, node.id)
  if (before.size !== flow.nodes.length - 1) return null
  const r = node.request
  if (!r.method || r.url === undefined || r.poll || r.fromScript || r.scripts === false || r.pathParams || r.rawPathParams) return null
  const headers: SimpleRequest['headers'] = []
  for (const [name, value] of Object.entries(r.headers ?? {})) {
    // Um header null remove um herdado: a visão Simples não tem como mostrar isso.
    if (value === null) return null
    headers.push({ name, value })
  }
  let url = r.url
  if (r.query && Object.keys(r.query).length) {
    if (Object.values(r.query).some((v) => v === null)) return null
    const qs = Object.entries(r.query)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
      .join('&')
    url = `${url}${url.includes('?') ? '&' : '?'}${qs}`
  }
  const body = r.body === undefined ? undefined : typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2)
  const scripts = ownScripts(r.requestScripts)
  const edges = flow.edges ?? []
  // Num fluxo que herda, a requisição vai pela base: é o conector dela no Quick Request.
  const connector = r.connector ?? flow.extends
  const keepFlow = Object.fromEntries((['extends', 'version', 'requiresAuth', 'scenarios', 'examples', 'source'] as const).filter((k) => flow[k] !== undefined).map((k) => [k, flow[k]]))
  return {
    keep: {
      ...(Object.keys(keepFlow).length && { flow: keepFlow }),
      ...(r.bodySchema && { request: { bodySchema: r.bodySchema } })
    },
    request: {
      method: r.method,
      url,
      headers,
      ...(r.payload ? { payload: r.payload } : body !== undefined && { body }),
      ...(connector && { connector }),
      ...(r.connector && r.endpoint && { endpoint: r.endpoint }),
      ...(scripts && { scripts }),
      ...(r.timeoutMs !== undefined && { timeoutMs: r.timeoutMs }),
      ...(r.followRedirects !== undefined && { followRedirects: r.followRedirects })
    },
    node: { id: node.id, name: node.name, ...(node.position && { position: node.position }) },
    before: before.size
      ? {
          id: flow.id,
          name: flow.name,
          nodes: flow.nodes.filter((n) => n.id !== node.id),
          edges: edges.filter((e) => e.to !== node.id && e.from !== node.id)
        }
      : null,
    incoming: edges.filter((e) => e.to === node.id).map((e) => e.from)
  }
}

/** A requisição do fluxo na visão Simples, ou null quando o fluxo não cabe nela. */
export function flowToRequest(flow: Flow): SimpleRequest | null {
  return splitFlow(flow)?.request ?? null
}

/** Texto estável da requisição, para saber se a visão Simples tem mudança não salva. */
export function simpleSignature(req: SimpleRequest | null): string {
  if (!req) return ''
  const headers = req.headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value])
  const scripts = ownScripts(req.scripts)
  return JSON.stringify([
    req.method,
    req.url,
    headers,
    req.payload ?? (has(req.body) ? req.body : ''),
    req.connector ?? '',
    (req.connector && req.endpoint) || '',
    scripts?.pre ?? '',
    scripts?.post ?? '',
    req.timeoutMs ?? null,
    req.followRedirects ?? null
  ])
}
