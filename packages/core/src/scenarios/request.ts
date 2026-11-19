import type { Endpoint, Scenario } from '@vvpost/schemas'
import type { HttpHeader, HttpMethod, RequestPayload } from '../types'
import { ConfigError } from '../connectors/errors'
import type { HeadlessOptions } from '../connectors/headless'
import { isCredentialHeader } from '../secrets'
import { ACCESS_CHECK_ID } from './access'

export interface ScenarioRequest {
  method: HttpMethod
  /** Caminho relativo à baseUrl do conector, com query; ainda com {{VAR}}. */
  url: string
  headers: HttpHeader[]
  body?: string
  /** Corpo estruturado (form, multipart, binário), no lugar de body. */
  payload?: RequestPayload
  options: HeadlessOptions
}

/** {nome} do path, sem pegar os {{VAR}}. */
const PATH_PARAM = /(?<!\{)\{([A-Za-z0-9_.-]+)\}(?!\})/g
const TEMPLATE = /(\{\{[^{}]+\}\})/

/**
 * Monta a requisição de um cenário a partir do endpoint: overrides.body
 * substitui o corpo padrão (null tira o corpo), headers e query são mesclados (null
 * remove; headers: null remove todos, inclusive os herdados e a auth do conector) e
 * pathParams preenche os {nome} do path, codificados para URL, menos os de rawPathParams, que vão
 * como estão (um %E0 já codificado chega cru ao servidor). As variáveis {{VAR}} ficam para o envio.
 *
 * O endpoint público (requiresAuth: false) e o gate de acesso ($sem-credencial) vão sem credencial:
 * sem a auth do conector e sem os headers de credencial do endpoint e herdados. Um header de
 * credencial escrito no próprio cenário vai.
 */
export function buildScenarioRequest(endpoint: Endpoint, scenario: Pick<Scenario, 'overrides'> & { id?: string }): ScenarioRequest {
  const anonymous = endpoint.requiresAuth === false || scenario.id === ACCESS_CHECK_ID
  const overrides = scenario.overrides ?? {}
  const params = overrides.pathParams ?? {}
  const raw = new Set(overrides.rawPathParams ?? [])
  const path = endpoint.path.replace(PATH_PARAM, (_, name: string) => {
    const value = params[name]
    if (value === undefined) throw new ConfigError(`parâmetro de rota {${name}} sem valor em overrides.pathParams`)
    return raw.has(name) ? value : encodeKeepingTemplates(value)
  })

  const query = new Map<string, string>()
  for (const [name, value] of Object.entries(endpoint.query ?? {})) query.set(name, value)
  for (const [name, value] of Object.entries(overrides.query ?? {})) {
    if (value === null) query.delete(name)
    else query.set(name, value)
  }
  const search = [...query].map(([k, v]) => `${encodeKeepingTemplates(k)}=${encodeKeepingTemplates(v)}`).join('&')

  const options: HeadlessOptions = anonymous ? { anonymous } : {}
  let headers = Object.entries(endpoint.headers ?? {})
    .filter(([name]) => !anonymous || !isCredentialHeader(name))
    .map(([name, value]) => ({ name, value }))
  if (overrides.headers === null) {
    headers = []
    options.inheritHeaders = false
  } else if (overrides.headers) {
    const drop: string[] = []
    for (const [name, value] of Object.entries(overrides.headers)) {
      const lower = name.toLowerCase()
      headers = headers.filter((h) => h.name.toLowerCase() !== lower)
      if (value === null) drop.push(name)
      else headers.push({ name, value })
    }
    if (drop.length) options.dropHeaders = drop
  }

  // overrides.payload vence; overrides.body troca o corpo inteiro, inclusive o estruturado do endpoint.
  const payload = 'payload' in overrides ? (overrides.payload ?? undefined) : 'body' in overrides ? undefined : endpoint.payload
  const rawBody = payload ? undefined : 'body' in overrides ? overrides.body : endpoint.body
  const body = rawBody === undefined || rawBody === null ? undefined : typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody)

  return {
    method: endpoint.method,
    url: search ? `${path}?${search}` : path,
    headers,
    ...(body !== undefined && { body }),
    ...(payload && { payload }),
    options
  }
}

/** Codifica para URL, mas deixa os {{VAR}} intactos para a interpolação do envio. */
function encodeKeepingTemplates(text: string): string {
  return text
    .split(TEMPLATE)
    .map((part, i) => (i % 2 ? part : encodeURIComponent(part)))
    .join('')
}
