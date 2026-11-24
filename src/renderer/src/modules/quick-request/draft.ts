import type { CatalogConnector, Flow, HttpHeader, HttpMethod, HttpResult, RealtimeEvent, RealtimeMessage, RealtimeProtocol, RealtimeStatus, RequestPayload, RequestScripts } from '@shared/ipc'
import type { FlowRef } from '../../lib/open-request'
import { simpleSignature, type SimpleRequest } from '@vvpost/core/flows/simple-flow'
import { fromGraphqlBody } from './graphql'

export interface HeaderRow extends HttpHeader {
  key: number
  enabled: boolean
}

/** Modo da aba Body: texto (JSON, XML...), form urlencoded, multipart/form-data, um arquivo ou GraphQL. */
export type BodyMode = 'raw' | 'urlencoded' | 'multipart' | 'binary' | 'graphql'

/** Linha dos forms da aba Body: texto, ou (no multipart) um arquivo. */
export interface FormRow {
  key: number
  enabled: boolean
  name: string
  value: string
  /** Caminho absoluto do arquivo, quando a linha é de arquivo. */
  file?: string
  contentType?: string
}

/** Uma aba do Quick Request: a requisição em edição e a última resposta dela. */
export interface RequestDraft {
  id: string
  method: HttpMethod
  url: string
  headers: HeaderRow[]
  body: string
  /** Padrão: raw (o texto de body). */
  bodyMode?: BodyMode
  /** No modo raw de um endpoint com bodySchema: formulário gerado do schema (padrão) ou o JSON. */
  bodyView?: 'form' | 'json'
  /** Campos do form (urlencoded e multipart dividem a lista, como no Postman). */
  formRows?: FormRow[]
  /** Arquivo do modo binário e o content-type dele (vazio: pela extensão). */
  binaryFile?: string
  binaryType?: string
  /** Modo GraphQL: a consulta, as variáveis (JSON) e a operação; o body da aba é o JSON montado deles. */
  graphql?: { query: string; variables: string; operationName?: string }
  /** Endpoint do conector que preencheu a aba, para o inspector. */
  endpointId: string | null
  /** Endpoint público (requiresAuth: false): manda a auth do conector mesmo assim (padrão: sem credencial). */
  withAuth?: boolean
  result: HttpResult | null
  /** Resposta do envio anterior, para "Comparar com a resposta anterior". */
  previous: HttpResult | null
  /** Id da requisição em andamento (para cancelar). */
  pendingId: string | null
  /** Parâmetros desativados na aba Params: fora da URL, mas guardados para voltar. */
  disabledParams?: QueryParam[]
  /** Template do modo Visualize da resposta desta aba. */
  visualizer?: string
  /** Fluxo de preparação: roda antes do envio; a requisição lê os $nodes dele. */
  prepareFlowId?: string | null
  /** Scripts pre e post da aba (fase 13): rodam, com os do conector e do endpoint, como um fluxo. */
  scripts?: RequestScripts
  /** Protocolo de plugin (gRPC, Kafka...): a aba chama o adapter com pluginConfig, não HTTP. */
  adapter?: string | null
  pluginConfig?: Record<string, unknown>
  /** Conexão persistente (WebSocket, SSE, Socket.IO): a aba conecta em vez de enviar. */
  realtime?: RealtimeProtocol | null
  live?: LiveState
  /** Mensagem em edição: o texto e, no Socket.IO, o nome do evento. */
  compose?: { data: string; event: string }
  /** WebSocket: subprotocolos separados por vírgula. */
  subprotocols?: string
  /** O arquivo de fluxo que a aba é (visão Simples do fluxo de um nó); ausente até o primeiro Ctrl+S. */
  flow?: FlowRef
}

/** Rótulo de cada protocolo realtime no seletor e no título da aba. */
export const REALTIME_LABEL: Record<RealtimeProtocol, string> = { websocket: 'WebSocket', sse: 'SSE', socketio: 'Socket.IO' }

/** A conexão de uma aba: o estado e as mensagens, as mais novas no fim. */
export interface LiveState {
  connectionId: string | null
  status: RealtimeStatus | 'idle'
  detail?: string
  code?: string
  url?: string
  messages: RealtimeMessage[]
  /** Mensagens antigas que saíram da tela pelo teto. */
  dropped: number
}

/** Mensagens guardadas por aba; as mais antigas saem primeiro. */
export const MAX_LIVE_MESSAGES = 2000

export const idleLive = (): LiveState => ({ connectionId: null, status: 'idle', messages: [], dropped: 0 })

/** Os eventos de uma conexão aplicados ao estado da aba (os de outra conexão ficam de fora). */
export function applyRealtime(live: LiveState, events: RealtimeEvent[]): LiveState {
  let next = live
  const added: RealtimeMessage[] = []
  for (const e of events) {
    if (e.id !== live.connectionId) continue
    if (e.type === 'message') added.push(e.message)
    else {
      next = { ...next, status: e.status, ...(e.status === 'connecting' && { messages: [], dropped: 0 }) }
      if (e.detail !== undefined) next.detail = e.detail
      if (e.code !== undefined) next.code = e.code
      if (e.url !== undefined) next.url = e.url
      if (e.status === 'connecting') {
        delete next.detail
        delete next.code
      }
    }
  }
  if (!added.length) return next
  const all = [...next.messages, ...added]
  const over = Math.max(0, all.length - MAX_LIVE_MESSAGES)
  return { ...next, messages: over ? all.slice(over) : all, dropped: next.dropped + over }
}

export type Endpoint = CatalogConnector['endpoints'][number]

let rowKey = 0
export const emptyRow = (): HeaderRow => ({ key: ++rowKey, enabled: true, name: '', value: '' })
export const toRows = (headers: HttpHeader[]): HeaderRow[] => [
  ...headers.map((h) => ({ ...h, key: ++rowKey, enabled: true })),
  emptyRow()
]

export const emptyFormRow = (): FormRow => ({ key: ++rowKey, enabled: true, name: '', value: '' })

/** O corpo estruturado da aba, ou undefined no modo raw (ou sem campos). */
export function draftPayload(d: RequestDraft): RequestPayload | undefined {
  const rows = (d.formRows ?? []).filter((r) => r.enabled && r.name.trim())
  switch (d.bodyMode) {
    case 'urlencoded':
      // Campos de arquivo só existem no form-data.
      return rows.some((r) => r.file === undefined)
        ? { mode: 'urlencoded', fields: rows.filter((r) => r.file === undefined).map((r) => ({ name: r.name, value: r.value })) }
        : undefined
    case 'multipart':
      return rows.length
        ? {
            mode: 'multipart',
            fields: rows.map((r) =>
              r.file !== undefined
                ? { name: r.name, file: r.file, ...(r.contentType && { contentType: r.contentType }) }
                : { name: r.name, value: r.value, ...(r.contentType && { contentType: r.contentType }) }
            )
          }
        : undefined
    case 'binary':
      return d.binaryFile ? { mode: 'binary', file: d.binaryFile, ...(d.binaryType && { contentType: d.binaryType }) } : undefined
    default:
      return undefined
  }
}

/** Corpo { query, variables } (de um endpoint GraphQL salvo): a aba abre no modo GraphQL. */
export function graphqlDraft(body: string | undefined): Pick<RequestDraft, 'bodyMode' | 'graphql'> | { graphql: undefined } {
  const graphql = body ? fromGraphqlBody(body) : undefined
  return graphql ? { bodyMode: 'graphql', graphql } : { graphql: undefined }
}

/** Os campos da aba a partir de um corpo estruturado (endpoint, histórico); sem payload, o modo raw. */
export function payloadDraft(payload: RequestPayload | undefined): Pick<RequestDraft, 'bodyMode' | 'formRows' | 'binaryFile' | 'binaryType'> {
  if (!payload) return { bodyMode: 'raw', formRows: [emptyFormRow()], binaryFile: '', binaryType: '' }
  if (payload.mode === 'binary') return { bodyMode: 'binary', formRows: [emptyFormRow()], binaryFile: payload.file, binaryType: payload.contentType ?? '' }
  const rows: FormRow[] = payload.fields.map((f) => ({
    key: ++rowKey,
    enabled: true,
    name: f.name,
    value: 'value' in f ? (f.value ?? '') : '',
    ...('file' in f && f.file !== undefined && { file: f.file }),
    ...('contentType' in f && f.contentType && { contentType: f.contentType })
  }))
  return { bodyMode: payload.mode, formRows: [...rows, emptyFormRow()], binaryFile: '', binaryType: '' }
}

let draftKey = 0
export function newDraft(): RequestDraft {
  return {
    id: `req-${++draftKey}`,
    method: 'GET',
    url: '',
    headers: [emptyRow()],
    body: '',
    endpointId: null,
    result: null,
    previous: null,
    pendingId: null
  }
}

/** Título da aba: método e caminho, sem esquema e host. */
export function draftTitle(d: RequestDraft): string {
  if (d.adapter) return `${d.adapter} ${d.url.trim()}`.trim()
  if (d.realtime) return `${REALTIME_LABEL[d.realtime]} ${d.url.trim().replace(/^[a-z]+:\/\/[^/]+/i, '') || '/'}`
  if (!d.url.trim()) return 'Nova requisição'
  const path = d.url.trim().replace(/^[a-z]+:\/\/[^/]+/i, '') || '/'
  return `${d.method} ${path}`
}

export const activeHeaders = (d: RequestDraft): HttpHeader[] =>
  d.headers.filter((h) => h.enabled && h.name.trim()).map(({ name, value }) => ({ name, value }))

/** Um parâmetro da query string, na ordem da URL (aba Params). */
export interface QueryParam {
  name: string
  value: string
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return s
  }
}
// {{VAR}} fica legível na URL: só o que quebraria a query é codificado.
const encode = (s: string) => encodeURIComponent(s).replace(/%7B/gi, '{').replace(/%7D/gi, '}').replace(/%24/g, '$')

/** Parâmetros da query de `url` (sem o fragmento). */
export function parseQuery(url: string): QueryParam[] {
  const q = url.split('#')[0]!.split('?').slice(1).join('?')
  if (!q) return []
  return q
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf('=')
      return at < 0 ? { name: decode(pair), value: '' } : { name: decode(pair.slice(0, at)), value: decode(pair.slice(at + 1)) }
    })
}

/** `url` com a query trocada por `params` (os de nome vazio ficam de fora). */
export function withQuery(url: string, params: QueryParam[]): string {
  const [beforeHash, ...hash] = url.split('#')
  const base = beforeHash!.split('?')[0]!
  const query = params
    .filter((p) => p.name.trim())
    .map((p) => (p.value === '' ? encode(p.name) : `${encode(p.name)}=${encode(p.value)}`))
    .join('&')
  return `${base}${query ? `?${query}` : ''}${hash.length ? `#${hash.join('#')}` : ''}`
}

/** Parâmetros de rota da URL: {id} do modelo do endpoint, ou :id. */
export function pathParams(url: string): string[] {
  const path = url.split(/[?#]/)[0]!
  return [...new Set([...path.matchAll(/(?<!\{)\{([A-Za-z0-9_]+)\}(?!\})|\/:([A-Za-z0-9_]+)/g)].map((m) => (m[1] ?? m[2])!))]
}

/** Os scripts da aba que têm código, para o envio; undefined sem nenhum. */
export function draftScripts(d: Pick<RequestDraft, 'scripts'>): RequestScripts | undefined {
  const pre = d.scripts?.pre?.trim() ? d.scripts.pre : undefined
  const post = d.scripts?.post?.trim() ? d.scripts.post : undefined
  return pre || post ? { ...(pre && { pre }), ...(post && { post }) } : undefined
}

/** A aba como o fluxo de um nó que ela é; null para realtime e protocolos de plugin, que não viram fluxo. */
export function draftRequest(d: RequestDraft, connectorId: string | undefined): SimpleRequest | null {
  if (d.realtime || d.adapter) return null
  const payload = draftPayload(d)
  const scripts = draftScripts(d)
  return {
    method: d.method,
    url: d.url.trim(),
    headers: activeHeaders(d),
    ...(payload ? { payload } : d.body && { body: d.body }),
    ...(connectorId && { connector: connectorId }),
    ...(connectorId && d.endpointId && { endpoint: d.endpointId }),
    ...(scripts && { scripts }),
    ...(d.flow?.keep?.timeoutMs !== undefined && { timeoutMs: d.flow.keep.timeoutMs }),
    ...(d.flow?.keep?.followRedirects !== undefined && { followRedirects: d.flow.keep.followRedirects })
  }
}

/** Texto estável do que a aba grava no fluxo: a requisição, a preparação escolhida e os nós de antes. */
export function flowSignature(req: SimpleRequest | null, prepareFlowId: string, before: Flow | null | undefined): string {
  return JSON.stringify([simpleSignature(req), prepareFlowId, before ? [before.nodes, before.edges ?? []] : null])
}

export const draftSignature = (d: RequestDraft, connectorId: string | undefined) =>
  flowSignature(draftRequest(d, connectorId), d.prepareFlowId ?? '', d.flow?.before)
