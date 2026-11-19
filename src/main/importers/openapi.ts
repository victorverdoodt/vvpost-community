import type { Connector, ConnectorAuth, ConnectorConfig, Endpoint, HttpMethod, PayloadFormField, RequestPayload, ResponseExample } from '@vvpost/schemas'
import { checkExample } from '@vvpost/core/connectors/registry'
import { schemaRef } from '@vvpost/core/connectors/shared-schemas'
import { SENSITIVE_KEYWORD, sensitiveType } from '@vvpost/core/pii'
import type { ImportSourceResult } from './bundle'
import { isSecretName, looksLikeSecretValue, slug, UniqueIds, type ImportWarning } from './postman'

/**
 * Importador de OpenAPI 3.x e Swagger 2.0 (fase 14).
 *
 * A spec vira um conector raiz com a URL base do primeiro servidor e a auth do
 * esquema de segurança global (sem valor: {{VAR}} para o ambiente preencher); cada
 * tag vira um conector filho que herda do raiz, e cada operação vira um endpoint com
 * headers e query obrigatórios (ou com exemplo), `bodySchema` e um corpo de exemplo.
 * O conector raiz guarda de onde a spec veio (`source`) e cada endpoint guarda a
 * operação e um hash do que veio dela, para a reimportação saber o que mudou na spec
 * e o que foi editado no projeto (src/main/importers/plan.ts).
 *
 * Módulo puro (sem Electron nem disco): recebe a spec já lida e devolve os documentos.
 */

type Obj = Record<string, unknown>

const CONNECTOR_SCHEMA = 'https://vvpost.dev/schemas/v1/connector.json'
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'] as const
/** bodySchema maior que isto (sem os componentes, que vão para os schemas compartilhados) fica de fora. */
const MAX_BODY_SCHEMA_BYTES = 256 * 1024
const MAX_SAMPLE_DEPTH = 6

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** A spec declara OpenAPI 3.x ou Swagger 2.0. */
export function isOpenApi(data: unknown): boolean {
  if (!isObject(data)) return false
  return (typeof data['openapi'] === 'string' && /^3\./.test(data['openapi'])) || data['swagger'] === '2.0'
}

import { endpointHash, schemaHash } from './spec-hash'

export { endpointHash, schemaHash, SPEC_FIELDS } from './spec-hash'

/**
 * Converte a spec. `location` é de onde ela veio (URL ou caminho do arquivo) e fica no
 * conector raiz para a reimportação; uma URL também resolve servidores relativos.
 */
export function convertOpenApi(file: string, data: unknown, location: string): ImportSourceResult {
  const out: ImportSourceResult = {
    sources: [],
    connectors: [],
    environments: [],
    flows: [],
    docs: {},
    secrets: [],
    warnings: [],
    errors: []
  }
  if (!isOpenApi(data)) {
    out.errors.push({ file, message: 'não é uma spec OpenAPI 3.x nem Swagger 2.0' })
    return out
  }
  const spec = data as Obj
  if (!isObject(spec['paths'])) {
    out.errors.push({ file, message: 'a spec não tem "paths"' })
    return out
  }
  new Converter(file, spec, location, out).run()
  if (out.schemas && !Object.keys(out.schemas).length) delete out.schemas
  return out
}

class Converter {
  private readonly v2: boolean
  private readonly info: Obj
  private readonly title: string
  private readonly warnings: ImportWarning[]
  /** Avisos repetidos por operação viram um só, com a contagem. */
  private readonly counted = new Map<string, string[]>()
  /** Prefixo das variáveis que a importação cria (auth e valores com cara de segredo). */
  private readonly prefix: string
  /** Componentes de schema usados, já traduzidos (com as citações entre eles como #/$defs/<Nome>). */
  private readonly components = new Map<string, Obj>()

  constructor(
    private readonly file: string,
    private readonly spec: Obj,
    private readonly location: string,
    private readonly out: ImportSourceResult
  ) {
    this.v2 = spec['swagger'] === '2.0'
    this.info = isObject(spec['info']) ? spec['info'] : {}
    this.title = str(this.info['title']) ?? file.replace(/\.(json|ya?ml)$/i, '')
    this.warnings = out.warnings
    this.prefix = (slug(this.title, '_') || 'api').toUpperCase()
  }

  run(): void {
    const rootId = slug(this.title) || 'openapi'
    const version = semver(this.info['version'])
    const root: Connector = { $schema: CONNECTOR_SCHEMA, id: rootId, name: this.title, version }
    const description = str(this.info['description'])
    if (description) root.description = description
    const config: ConnectorConfig = {}
    const baseUrl = this.baseUrl()
    if (baseUrl) config.baseUrl = baseUrl
    const auth = this.auth(rootId)
    if (auth) config.auth = auth
    if (Object.keys(config).length) root.config = config
    root.source = { type: 'openapi', location: this.location }
    const specVersion = str(this.info['version'])
    if (specVersion) root.source.version = specVersion

    // Tags na ordem da lista do topo e, depois, na ordem em que aparecem nas operações.
    const tagInfo = new Map<string, string | undefined>()
    for (const t of Array.isArray(this.spec['tags']) ? this.spec['tags'] : []) {
      if (isObject(t) && str(t['name'])) tagInfo.set(str(t['name'])!, str(t['description']))
    }
    const byTag = new Map<string, Endpoint[]>()
    const rootEndpoints: Endpoint[] = []
    const endpointIds = new Map<string, UniqueIds>()
    const ids = (key: string) => {
      let u = endpointIds.get(key)
      if (!u) endpointIds.set(key, (u = new UniqueIds()))
      return u
    }

    for (const [path, rawItem] of Object.entries(this.spec['paths'] as Obj)) {
      const item = this.deref(rawItem)
      if (!isObject(item)) continue
      if (!path.startsWith('/')) {
        this.warn(this.title, `caminho "${path}" ignorado: não começa com /.`)
        continue
      }
      if (isObject(item['trace'])) this.count('TRACE', `TRACE ${path}`)
      for (const m of METHODS) {
        const op = item[m]
        if (!isObject(op)) continue
        const tag = Array.isArray(op['tags']) ? op['tags'].map(str).find(Boolean) : undefined
        if (tag && !tagInfo.has(tag)) tagInfo.set(tag, undefined)
        const endpoint = this.endpoint(path, m, item, op, tag, ids(tag ?? ''))
        if (tag) byTag.set(tag, [...(byTag.get(tag) ?? []), endpoint])
        else rootEndpoints.push(endpoint)
      }
    }

    if (rootEndpoints.length) root.endpoints = rootEndpoints
    this.out.connectors.push(root)
    const connectorIds = new UniqueIds([rootId])
    for (const [tag, tagDescription] of tagInfo) {
      const endpoints = byTag.get(tag)
      if (!endpoints?.length) continue
      const child: Connector = {
        $schema: CONNECTOR_SCHEMA,
        id: connectorIds.take(`${rootId}.${slug(tag) || 'tag'}`, '-'),
        name: tag,
        ...(tagDescription && { description: tagDescription }),
        version,
        extends: rootId,
        endpoints
      }
      this.out.connectors.push(child)
    }

    // Cada componente usado vira um schema compartilhado do catálogo, citado pelos endpoints.
    this.out.schemas = {}
    for (const [name, schema] of [...this.components].sort(([a], [b]) => a.localeCompare(b))) {
      const body = this.cite(schema) as Obj
      this.out.schemas[name] = { ...body, 'x-vvpost': { source: this.location, hash: schemaHash(body) } }
    }

    this.flushCounts()
    const kind = this.v2 ? 'Swagger 2.0' : `OpenAPI ${String(this.spec['openapi'])}`
    this.out.sources.push({ file: this.file, kind: 'openapi', name: `${this.title} (${kind})` })
    if (!this.out.connectors.some((c) => c.endpoints?.length)) this.warn(this.title, 'a spec não tem operações.')
  }

  // -------------------------------------------------------------------------
  // Servidor e auth

  private baseUrl(): string | undefined {
    if (this.v2) {
      const fromLocation = /^https?:\/\//.test(this.location) ? new URL(this.location) : undefined
      const host = str(this.spec['host']) ?? fromLocation?.host
      const schemes = Array.isArray(this.spec['schemes']) ? this.spec['schemes'].map(str) : []
      const scheme = schemes.find((s) => s === 'https') ?? schemes.find((s) => s === 'http') ?? fromLocation?.protocol.slice(0, -1) ?? 'https'
      const basePath = (str(this.spec['basePath']) ?? '').replace(/\/+$/, '')
      if (!host) {
        this.warn(this.title, 'a spec não diz o host: a URL base ficou {{BASE_URL}}; defina BASE_URL no ambiente.')
        return `{{BASE_URL}}${basePath}`
      }
      return `${scheme}://${host}${basePath}`
    }
    const servers = (Array.isArray(this.spec['servers']) ? this.spec['servers'] : []).filter(isObject)
    const first = servers[0]
    let url = first ? (str(first['url']) ?? '/') : '/'
    if (first && isObject(first['variables'])) {
      for (const [name, v] of Object.entries(first['variables'])) {
        const value = isObject(v) ? v['default'] : undefined
        if (value !== undefined) url = url.split(`{${name}}`).join(String(value))
      }
    }
    if (servers.length > 1) {
      const others = servers.slice(1).map((s) => str(s['url'])).filter(Boolean)
      this.warn(this.title, `a spec declara ${servers.length} servidores; a URL base é o primeiro (${url}). Os outros: ${others.join(', ')}.`)
    }
    if (/^https?:\/\//i.test(url)) return url.replace(/\/+$/, '')
    if (/^https?:\/\//.test(this.location)) return new URL(url, this.location).href.replace(/\/+$/, '')
    const path = url.replace(/^\.?\/*/, '/').replace(/\/+$/, '')
    this.warn(this.title, `o servidor "${url}" é relativo: a URL base ficou {{BASE_URL}}${path}; defina BASE_URL no ambiente.`)
    return `{{BASE_URL}}${path}`
  }

  /** Esquema da primeira exigência de segurança global (ou o mais usado pelas operações). */
  private auth(rootId: string): ConnectorAuth | undefined {
    const schemes = this.v2
      ? this.spec['securityDefinitions']
      : isObject(this.spec['components'])
        ? (this.spec['components'] as Obj)['securitySchemes']
        : undefined
    if (!isObject(schemes) || !Object.keys(schemes).length) return undefined
    const requirementOf = (list: unknown): [string, string[]] | undefined => {
      if (!Array.isArray(list)) return undefined
      for (const r of list) {
        if (!isObject(r)) continue
        const [name, scopes] = Object.entries(r)[0] ?? []
        if (name) return [name, Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string') : []]
      }
      return undefined
    }
    let chosen = requirementOf(this.spec['security'])
    if (!chosen) {
      const uses = new Map<string, number>()
      for (const item of Object.values(this.spec['paths'] as Obj)) {
        const deref = this.deref(item)
        if (!isObject(deref)) continue
        for (const m of METHODS) {
          const r = isObject(deref[m]) ? requirementOf((deref[m] as Obj)['security']) : undefined
          if (r) uses.set(r[0], (uses.get(r[0]) ?? 0) + 1)
        }
      }
      const top = [...uses].sort((a, b) => b[1] - a[1])[0]
      if (!top) return undefined
      chosen = [top[0], []]
    }
    const [name, scopes] = chosen
    const scheme = this.deref(schemes[name])
    if (!isObject(scheme)) {
      this.warn(this.title, `esquema de segurança "${name}" não existe na spec.`)
      return undefined
    }
    const v = (suffix: string) => `{{${this.prefix}_${suffix}}}`
    const where = `${this.title} › segurança "${name}"`
    const type = str(scheme['type'])
    const kind = str(scheme['scheme'])?.toLowerCase()
    let auth: ConnectorAuth | undefined
    if (type === 'http' && kind === 'bearer') {
      auth = { type: 'bearer', token: v('TOKEN') }
    } else if ((type === 'http' && kind === 'basic') || type === 'basic') {
      auth = { type: 'basic', username: v('USERNAME'), password: v('PASSWORD') }
    } else if (type === 'apiKey') {
      const into = str(scheme['in'])
      const keyName = str(scheme['name'])
      if (!keyName || (into !== 'header' && into !== 'query')) {
        this.warn(where, `API key ${into === 'cookie' ? 'em cookie' : 'sem nome'} não tem equivalente na auth do conector; configure à mão.`)
        return undefined
      }
      auth = { type: 'apiKey', name: keyName, value: v('API_KEY'), in: into }
    } else if (type === 'oauth2') {
      auth = this.oauth2(scheme, scopes, v, where)
    } else {
      this.warn(where, `o tipo ${type ?? '?'}${kind ? ` (${kind})` : ''} não tem equivalente na auth do conector; configure à mão.`)
      return undefined
    }
    if (auth) {
      const vars = [...JSON.stringify(auth).matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1])
      this.warn(where, `a auth usa ${[...new Set(vars)].join(', ')}: defina no ambiente (como segredo).`)
    }
    return auth
  }

  private oauth2(scheme: Obj, scopes: string[], v: (s: string) => string, where: string): ConnectorAuth | undefined {
    const scope = scopes.length ? { scope: scopes.join(' ') } : {}
    const credentials = { clientId: v('CLIENT_ID'), clientSecret: v('CLIENT_SECRET') }
    if (this.v2) {
      const flow = str(scheme['flow'])
      const tokenUrl = str(scheme['tokenUrl'])
      if (tokenUrl && flow === 'application') return { type: 'oauth2', grantType: 'client_credentials', tokenUrl, ...credentials, ...scope }
      if (tokenUrl && flow === 'password') {
        return { type: 'oauth2', grantType: 'password', tokenUrl, ...credentials, username: v('USERNAME'), password: v('PASSWORD'), ...scope }
      }
      this.warn(where, `o fluxo OAuth2 "${flow ?? '?'}" pede o navegador e ainda não é suportado; configure a auth à mão.`)
      return undefined
    }
    const flows = isObject(scheme['flows']) ? scheme['flows'] : {}
    const cc = isObject(flows['clientCredentials']) ? flows['clientCredentials'] : undefined
    const pw = isObject(flows['password']) ? flows['password'] : undefined
    if (cc && str(cc['tokenUrl'])) {
      return { type: 'oauth2', grantType: 'client_credentials', tokenUrl: str(cc['tokenUrl'])!, ...credentials, ...scope }
    }
    if (pw && str(pw['tokenUrl'])) {
      return {
        type: 'oauth2',
        grantType: 'password',
        tokenUrl: str(pw['tokenUrl'])!,
        ...credentials,
        username: v('USERNAME'),
        password: v('PASSWORD'),
        ...scope
      }
    }
    this.warn(where, `os fluxos OAuth2 da spec (${Object.keys(flows).join(', ') || 'nenhum'}) pedem o navegador e ainda não são suportados; configure a auth à mão.`)
    return undefined
  }

  // -------------------------------------------------------------------------
  // Operações

  private endpoint(path: string, method: (typeof METHODS)[number], item: Obj, op: Obj, tag: string | undefined, ids: UniqueIds): Endpoint {
    const METHOD = method.toUpperCase() as HttpMethod
    const operation = `${METHOD} ${path}`
    const operationId = str(op['operationId'])
    const id = ids.take(
      operationId?.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[.-]+/, '') || slug(`${method} ${path}`, '_') || `${method}_root`,
      '_'
    )
    const endpoint: Endpoint = { id, name: str(op['summary']) ?? operationId ?? operation, method: METHOD, path }
    const description = [op['deprecated'] === true ? '**Obsoleto.**' : undefined, str(op['description'])].filter(Boolean).join('\n\n')
    if (description) endpoint.description = description

    // Parâmetros do caminho valem para todas as operações; os da operação sobrescrevem pelo nome e local.
    const params = new Map<string, Obj>()
    for (const raw of [...(Array.isArray(item['parameters']) ? item['parameters'] : []), ...(Array.isArray(op['parameters']) ? op['parameters'] : [])]) {
      const p = this.deref(raw)
      if (isObject(p) && str(p['name']) && str(p['in'])) params.set(`${p['in']}:${p['name']}`, p)
    }
    const headers: Record<string, string> = {}
    const query: Record<string, string> = {}
    let bodyParam: Obj | undefined
    const formParams: Obj[] = []
    for (const p of params.values()) {
      const name = str(p['name'])!
      const into = p['in']
      if (into === 'body') bodyParam = p
      else if (into === 'formData') formParams.push(p)
      else if (into === 'cookie') this.count('cookie', operation)
      else if (into === 'header' || into === 'query') {
        if (into === 'header' && /^(accept|content-type|authorization)$/i.test(name)) continue
        if (into === 'header' && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue
        const value = this.paramValue(p)
        if (value === undefined && p['required'] !== true) continue
        ;(into === 'header' ? headers : query)[name] = this.notSecret(name, value ?? '', operation)
      }
    }
    if (Object.keys(headers).length) endpoint.headers = headers
    if (Object.keys(query).length) endpoint.query = query

    const body = this.v2 ? this.bodyV2(op, bodyParam, formParams, operation) : this.bodyV3(op, operation)
    if (body.contentType) endpoint.headers = { ...endpoint.headers, 'Content-Type': body.contentType }
    if (body.schema) endpoint.bodySchema = this.cite(body.schema) as Obj
    if (body.example !== undefined) endpoint.body = this.redact(body.example, operation)
    if (body.payload) {
      endpoint.payload = body.payload
      if (body.payload.mode !== 'binary') for (const f of body.payload.fields) if (f.value !== undefined) f.value = this.notSecret(f.name, f.value, operation)
    }

    if (Array.isArray(op['servers']) && op['servers'].length) this.count('servers', operation)
    const requiresAuth = this.requiresAuth(op)
    if (requiresAuth !== undefined) endpoint.requiresAuth = requiresAuth
    if (requiresAuth === false && Array.isArray(op['security'])) this.count('noauth', operation)

    endpoint.source = { operation, hash: endpointHash(endpoint) }
    if (operationId) endpoint.source.operationId = operationId
    if (tag) endpoint.source.tag = tag
    // Fora do hash: a reimportação não mexe nos exemplos que o projeto já tem.
    const examples = this.responseExamples(op, operation)
    if (examples.length) endpoint.examples = examples
    return endpoint
  }

  /**
   * Exemplo da spec num campo com nome de credencial (api_key, password...) ou com formato de
   * credencial (JWT, chave da AWS) não vai para o arquivo versionado: vira {{VAR}} do ambiente.
   */
  private notSecret(name: string, value: string, operation: string): string {
    if (!value || /^\{\{[^{}]+\}\}$/.test(value) || (!isSecretName(name) && !looksLikeSecretValue(value))) return value
    this.count('secret', operation)
    return `{{${this.prefix}_${slug(name, '_').toUpperCase() || 'SECRET'}}}`
  }

  private redact(value: unknown, operation: string, key = ''): unknown {
    if (typeof value === 'string') return key ? this.notSecret(key, value, operation) : looksLikeSecretValue(value) ? this.notSecret('secret', value, operation) : value
    if (Array.isArray(value)) return value.map((v) => this.redact(v, operation, key))
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.redact(v, operation, k)]))
    return value
  }

  /**
   * O security da operação (ou o global): lista vazia é pública; uma exigência vazia ({}) na lista
   * deixa a auth opcional, e aí não se declara nada. Sem security na operação nem global, ela é
   * pública só quando a spec documenta a segurança (global ou em alguma operação); uma spec que só
   * define os esquemas, sem usar, não diz quais operações exigem auth.
   */
  private requiresAuth(op: Obj): boolean | undefined {
    const list = Array.isArray(op['security']) ? op['security'] : Array.isArray(this.spec['security']) ? this.spec['security'] : undefined
    if (list === undefined) return this.documentsSecurity() ? false : undefined
    if (list.length === 0) return false
    if (list.some((r) => !isObject(r) || Object.keys(r).length === 0)) return undefined
    return true
  }

  private securityDocumented?: boolean

  /** Alguma operação (ou o global) declara uma exigência de segurança. */
  private documentsSecurity(): boolean {
    if (this.securityDocumented !== undefined) return this.securityDocumented
    const uses = (list: unknown) => Array.isArray(list) && list.some((r) => isObject(r) && Object.keys(r).length > 0)
    let found = uses(this.spec['security'])
    for (const item of Object.values(isObject(this.spec['paths']) ? (this.spec['paths'] as Obj) : {})) {
      if (found) break
      const deref = this.deref(item)
      if (isObject(deref)) found = METHODS.some((m) => isObject(deref[m]) && uses((deref[m] as Obj)['security']))
    }
    return (this.securityDocumented = found)
  }

  private paramValue(p: Obj): string | undefined {
    const schema = this.deref(p['schema'])
    const s = isObject(schema) ? schema : p // Swagger 2.0: o tipo fica no próprio parâmetro.
    const firstExample = isObject(p['examples']) ? Object.values(p['examples']).map((e) => this.deref(e)).find(isObject) : undefined
    const candidates = [p['example'], firstExample?.['value'], s['example'], p['default'], s['default'], Array.isArray(s['enum']) ? s['enum'][0] : undefined]
    const value = candidates.find((c) => c !== undefined && c !== null)
    if (value === undefined) return undefined
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }

  private bodyV3(op: Obj, operation: string): BodyInfo {
    const rb = this.deref(op['requestBody'])
    if (!isObject(rb) || !isObject(rb['content'])) return {}
    const content = rb['content'] as Obj
    const types = Object.keys(content)
    const json = types.find((t) => /^application\/json\b/i.test(t)) ?? types.find((t) => /[/+]json\b/i.test(t))
    if (json) {
      const media = this.deref(content[json])
      if (!isObject(media)) return {}
      const schema = this.bodySchema(media['schema'], operation)
      const example = this.mediaExample(media) ?? (schema ? sample(schema, schema) : undefined)
      return { ...(schema && { schema }), ...(example !== undefined && { example }), ...(!/^application\/json\b/i.test(json) && { contentType: json }) }
    }
    const form = types.find((t) => /^application\/x-www-form-urlencoded/i.test(t)) ?? types.find((t) => /^multipart\/form-data/i.test(t))
    if (form) {
      const media = this.deref(content[form])
      const schema = isObject(media) ? this.bodySchema(media['schema'], operation) : undefined
      const example = isObject(media) ? this.mediaExample(media) : undefined
      return { payload: this.formPayload(/^multipart/i.test(form) ? 'multipart' : 'urlencoded', schema, example, operation) }
    }
    const text = types.find((t) => /^text\/|\/xml\b|\+xml\b/i.test(t))
    if (text) {
      const media = this.deref(content[text])
      const example = isObject(media) ? this.mediaExample(media) : undefined
      return { contentType: text, ...(example !== undefined && { example: typeof example === 'string' ? example : JSON.stringify(example) }) }
    }
    if (types.length) this.count('binary', operation)
    return {}
  }

  private bodyV2(op: Obj, bodyParam: Obj | undefined, formParams: Obj[], operation: string): BodyInfo {
    const consumes = (Array.isArray(op['consumes']) ? op['consumes'] : Array.isArray(this.spec['consumes']) ? this.spec['consumes'] : []).filter(
      (c): c is string => typeof c === 'string'
    )
    if (formParams.length) {
      const mode = consumes.some((c) => /^multipart\/form-data/i.test(c)) || formParams.some((p) => p['type'] === 'file') ? 'multipart' : 'urlencoded'
      const fields: PayloadFormField[] = []
      for (const p of formParams) {
        if (p['type'] === 'file') this.count('formFile', operation)
        else fields.push({ name: str(p['name'])!, value: this.paramValue(p) ?? '' })
      }
      return fields.length ? { payload: { mode, fields } } : {}
    }
    if (!bodyParam) return {}
    const json = consumes.length === 0 ? 'application/json' : consumes.find((c) => /[/+]json\b/i.test(c))
    if (!json) {
      this.count('binary', operation)
      return {}
    }
    const schema = this.bodySchema(bodyParam['schema'], operation)
    const examples = isObject(bodyParam['x-examples']) ? Object.values(bodyParam['x-examples'])[0] : undefined
    const example = examples ?? (schema ? sample(schema, schema) : undefined)
    return { ...(schema && { schema }), ...(example !== undefined && { example }), ...(!/^application\/json\b/i.test(json) && { contentType: json }) }
  }

  /** Corpo de formulário: um campo por propriedade do schema, com o exemplo (ou um gerado). Campos de arquivo ficam de fora. */
  private formPayload(mode: 'urlencoded' | 'multipart', schema: Obj | undefined, example: unknown, operation: string): RequestPayload | undefined {
    let target: unknown = schema
    for (let i = 0; i < 8 && isObject(target) && typeof target['$ref'] === 'string'; i++) target = sample.resolve(target['$ref'], schema!)
    const props = isObject(target) && isObject(target['properties']) ? (target['properties'] as Obj) : {}
    const fields: PayloadFormField[] = []
    for (const [name, raw] of Object.entries(props)) {
      let prop: unknown = raw
      for (let i = 0; i < 8 && isObject(prop) && typeof prop['$ref'] === 'string'; i++) prop = sample.resolve(prop['$ref'], schema!)
      if (!isObject(prop) || prop['readOnly'] === true) continue
      const binary = prop['format'] === 'binary' || prop['format'] === 'base64' || (isObject(prop['items']) && (prop['items'] as Obj)['format'] === 'binary')
      if (binary) {
        this.count('formFile', operation)
        continue
      }
      const given = isObject(example) ? example[name] : undefined
      const value = given !== undefined ? given : sample(prop, schema!)
      fields.push({ name, value: value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value) })
    }
    return fields.length ? { mode, fields } : undefined
  }

  /**
   * As respostas documentadas viram exemplos para o mock server: cada exemplo nomeado da
   * resposta JSON (ou o gerado pelo schema), com o status dela e o schema da resposta. "default" e respostas sem
   * corpo JSON entram só com o status. No máximo 8 por operação.
   */
  private responseExamples(op: Obj, operation: string): ResponseExample[] {
    const responses = isObject(op['responses']) ? op['responses'] : {}
    const out: ResponseExample[] = []
    const taken = new Set<string>()
    const add = (status: number, name: string, body: unknown, contentType?: string, schema?: Obj) => {
      const base = `${status >= 200 && status < 300 ? 'ok' : 'erro'}-${status}`
      let id = base
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
      taken.add(id)
      const example: ResponseExample = {
        id,
        name,
        status,
        ...(contentType && { headers: { 'Content-Type': contentType } }),
        ...(body !== undefined && { body: this.redact(body, operation) }),
        ...(schema && { schema })
      }
      if (checkExample(example).length) this.count('exampleOffSchema', operation)
      if (schema) example.schema = this.cite(schema) as Obj
      out.push(example)
    }
    for (const [code, raw] of Object.entries(responses)) {
      if (out.length >= 8) break
      const status = /^[1-5]\d\d$/.test(code) ? Number(code) : undefined
      if (status === undefined) continue
      const res = this.deref(raw)
      if (!isObject(res)) continue
      const label = str(res['description'])?.split('\n')[0]?.slice(0, 80)
      const name = label ? `${status} ${label}` : String(status)
      if (this.v2) {
        const mimes = isObject(res['examples']) ? (res['examples'] as Obj) : {}
        const mime = Object.keys(mimes).find((t) => /[/+]json\b/i.test(t))
        const schema = res['schema'] !== undefined ? this.bodySchema(res['schema'], operation) : undefined
        const body = mime ? mimes[mime] : schema ? sample(schema, schema) : undefined
        add(status, name, body, body !== undefined ? 'application/json' : undefined, schema)
        continue
      }
      const content = isObject(res['content']) ? (res['content'] as Obj) : {}
      const types = Object.keys(content)
      const json = types.find((t) => /^application\/json\b/i.test(t)) ?? types.find((t) => /[/+]json\b/i.test(t))
      const media = json ? this.deref(content[json]) : undefined
      if (!json || !isObject(media)) {
        add(status, name, undefined)
        continue
      }
      const schema = media['schema'] !== undefined ? this.bodySchema(media['schema'], operation) : undefined
      const named = isObject(media['examples']) ? Object.entries(media['examples'] as Obj) : []
      const values = named.map(([key, e]) => [key, this.deref(e)] as const).filter((x): x is readonly [string, Obj] => isObject(x[1]) && x[1]['value'] !== undefined)
      if (values.length) {
        for (const [key, e] of values.slice(0, 8 - out.length)) add(status, `${name} (${str(e['summary']) ?? key})`, e['value'], json, schema)
        continue
      }
      const body = media['example'] !== undefined ? media['example'] : schema ? sample(schema, schema) : undefined
      add(status, name, body, json, schema)
    }
    return out
  }

  private mediaExample(media: Obj): unknown {
    if (media['example'] !== undefined) return media['example']
    if (isObject(media['examples'])) {
      for (const e of Object.values(media['examples'])) {
        const ex = this.deref(e)
        if (isObject(ex) && ex['value'] !== undefined) return ex['value']
      }
    }
    const schema = this.deref(media['schema'])
    if (isObject(schema) && schema['example'] !== undefined) return schema['example']
    return undefined
  }

  // -------------------------------------------------------------------------
  // Schemas

  /**
   * JSON Schema 2020-12 do corpo: os componentes usados vão para `$defs` do próprio
   * bodySchema (referências recursivas continuam funcionando) e as palavras só do
   * OpenAPI (nullable, exclusiveMinimum booleano, discriminator...) são traduzidas ou tiradas.
   */
  private bodySchema(raw: unknown, operation: string): Obj | undefined {
    if (raw === undefined) return undefined
    const defs: Obj = {}
    const pending: [string, unknown][] = []
    const names = new Map<string, string>()
    const used = new Set<string>()
    const translate = (s: unknown, depth: number): unknown => {
      if (typeof s === 'boolean') return s
      if (!isObject(s)) return {}
      if (depth > 64) return {}
      const ref = typeof s['$ref'] === 'string' ? s['$ref'] : undefined
      if (ref) {
        const component = this.componentName(ref)
        if (component) {
          let name = names.get(ref)
          if (!name) {
            name = component
            for (let n = 2; used.has(name); n++) name = `${component}${n}`
            names.set(ref, name)
            used.add(name)
            pending.push([name, this.pointer(ref)])
          }
          return { $ref: `#/$defs/${name.replace(/~/g, '~0').replace(/\//g, '~1')}` }
        }
        const target = ref.startsWith('#/') ? this.pointer(ref) : undefined
        if (target === undefined) {
          this.count('externalRef', operation)
          return {}
        }
        return translate(target, depth + 1)
      }
      const out: Obj = {}
      for (const [k, v] of Object.entries(s)) {
        // A marca de dado pessoal (x-sensitive) fica: o MCP mascara o campo no que vai ao agente.
        if (k === SENSITIVE_KEYWORD) {
          if (sensitiveType(v)) out[k] = v
          continue
        }
        if (k.startsWith('x-') || k === 'discriminator' || k === 'xml' || k === 'externalDocs' || k === 'nullable') continue
        switch (k) {
          case 'properties':
          case 'patternProperties':
          case '$defs':
          case 'definitions':
            if (isObject(v)) out[k === 'definitions' ? '$defs' : k] = Object.fromEntries(Object.entries(v).map(([p, ps]) => [p, translate(ps, depth + 1)]))
            break
          case 'items':
            if (Array.isArray(v)) out['prefixItems'] = v.map((x) => translate(x, depth + 1))
            else out[k] = translate(v, depth + 1)
            break
          case 'additionalProperties':
          case 'not':
          case 'contains':
          case 'propertyNames':
          case 'if':
          case 'then':
          case 'else':
          case 'unevaluatedProperties':
          case 'unevaluatedItems':
            out[k] = translate(v, depth + 1)
            break
          case 'allOf':
          case 'anyOf':
          case 'oneOf':
          case 'prefixItems':
            if (Array.isArray(v)) out[k] = v.map((x) => translate(x, depth + 1))
            break
          case 'example':
            if (s['examples'] === undefined) out['examples'] = [v]
            break
          case 'exclusiveMinimum':
          case 'exclusiveMaximum':
            if (typeof v === 'number') out[k] = v
            break
          case 'type':
            out[k] = v === 'file' ? 'string' : v
            break
          default:
            out[k] = v
        }
      }
      // OpenAPI 3.0 e Swagger: exclusiveMinimum/Maximum booleanos acompanham minimum/maximum.
      if (s['exclusiveMinimum'] === true && typeof s['minimum'] === 'number') {
        out['exclusiveMinimum'] = s['minimum']
        delete out['minimum']
      }
      if (s['exclusiveMaximum'] === true && typeof s['maximum'] === 'number') {
        out['exclusiveMaximum'] = s['maximum']
        delete out['maximum']
      }
      if (s['nullable'] === true) {
        if (typeof out['type'] === 'string') out['type'] = [out['type'], 'null']
        else if (Array.isArray(out['type']) && !out['type'].includes('null')) out['type'] = [...out['type'], 'null']
        if (Array.isArray(out['enum']) && !out['enum'].includes(null)) out['enum'] = [...out['enum'], null]
      }
      return out
    }
    const schema = translate(raw, 0) as Obj
    for (let i = 0; i < pending.length; i++) {
      const [name, target] = pending[i]!
      defs[name] = target === undefined ? {} : translate(target, 1)
      if (target !== undefined && !this.components.has(name)) this.components.set(name, defs[name] as Obj)
    }
    const result = Object.keys(defs).length ? { ...schema, $defs: { ...(schema['$defs'] as Obj | undefined), ...defs } } : schema
    // O que vai para o endpoint é o schema sem os componentes (citados); eles ficam uma vez no catálogo.
    if (JSON.stringify(this.cite(result)).length > MAX_BODY_SCHEMA_BYTES) {
      this.count('bigSchema', operation)
      return undefined
    }
    return result
  }

  /**
   * O schema traduzido (com os componentes em $defs, para gerar exemplos e conferir) na forma que
   * vai para o arquivo: cada componente citado como "schema:<Nome>" e fora de $defs.
   */
  private cite(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => this.cite(v))
    if (!isObject(value)) return value
    const out: Obj = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === '$ref' && typeof v === 'string') {
        const m = /^#\/\$defs\/([^/]+)$/.exec(v)
        const name = m ? m[1]!.replace(/~1/g, '/').replace(/~0/g, '~') : undefined
        out[k] = name !== undefined && this.components.has(name) ? schemaRef(name) : v
      } else if (k === '$defs' && isObject(v)) {
        const own = Object.entries(v).filter(([name]) => !this.components.has(name))
        if (own.length) out[k] = Object.fromEntries(own.map(([name, d]) => [name, this.cite(d)]))
      } else out[k] = this.cite(v)
    }
    return out
  }

  /** Nome do componente de schema que a referência aponta (#/components/schemas/X ou #/definitions/X). */
  private componentName(ref: string): string | undefined {
    const m = ref.match(this.v2 ? /^#\/definitions\/([^/]+)$/ : /^#\/components\/schemas\/([^/]+)$/)
    return m ? decodeURIComponent(m[1]!.replace(/~1/g, '/').replace(/~0/g, '~')) : undefined
  }

  private pointer(ref: string): unknown {
    if (!ref.startsWith('#')) return undefined
    let cur: unknown = this.spec
    for (const raw of ref.slice(1).split('/').slice(1)) {
      const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~')
      if (!isObject(cur) && !Array.isArray(cur)) return undefined
      cur = (cur as Obj)[key]
    }
    return cur
  }

  /** Segue $ref locais de parâmetros, corpos, exemplos e esquemas de segurança. */
  private deref(v: unknown, depth = 0): unknown {
    if (!isObject(v) || typeof v['$ref'] !== 'string' || depth > 16) return v
    const target = this.pointer(v['$ref'])
    if (target === undefined) {
      this.warn(this.title, `referência ${v['$ref']} não encontrada${v['$ref'].startsWith('#') ? '' : ' (referências a outros arquivos não são seguidas)'}.`)
      return undefined
    }
    return this.deref(target, depth + 1)
  }

  // -------------------------------------------------------------------------
  // Avisos

  private warn(source: string, message: string): void {
    if (!this.warnings.some((w) => w.source === source && w.message === message)) this.warnings.push({ source, message })
  }

  private count(kind: string, operation: string): void {
    const list = this.counted.get(kind) ?? []
    if (!list.includes(operation)) list.push(operation)
    this.counted.set(kind, list)
  }

  private flushCounts(): void {
    const text: Record<string, string> = {
      TRACE: 'operações TRACE ignoradas (o VVPost não envia TRACE)',
      cookie: 'parâmetros em cookie não entram no endpoint; defina o header Cookie à mão',
      formFile: 'campos de arquivo do formulário ficam de fora; escolha o arquivo no Quick Request',
      binary: 'corpo que não é JSON nem texto não entra no endpoint',
      servers: 'operações com servidor próprio usam a URL base do conector',
      noauth: 'operações sem auth na spec (security: []) ficaram públicas (requiresAuth: false): o vvpost run roda os cenários delas sem a auth do conector',
      secret: 'exemplos com cara de credencial viraram variáveis {{...}} para o ambiente preencher',
      externalRef: 'referências a outros arquivos não são seguidas: o trecho ficou sem validação no bodySchema',
      exampleOffSchema: 'exemplos de resposta fora do schema da própria spec: o vvpost validate reprova até o exemplo ou o schema ser corrigido',
      bigSchema: `bodySchema maior que ${MAX_BODY_SCHEMA_BYTES / 1024} KB ficou de fora`
    }
    for (const [kind, ops] of this.counted) {
      const shown = ops.slice(0, 5).join(', ') + (ops.length > 5 ? ` e mais ${ops.length - 5}` : '')
      this.warn(this.title, `${text[kind] ?? kind}: ${shown}.`)
    }
  }
}

interface BodyInfo {
  schema?: Obj
  example?: unknown
  payload?: RequestPayload
  contentType?: string
}

function semver(v: unknown): string {
  const s = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : ''
  if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(s) && !/(^|\.)0\d/.test(s.split(/[-+]/)[0]!)) return s
  const m = s.match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  return m ? [m[1], m[2] ?? '0', m[3] ?? '0'].map((n) => String(Number(n))).join('.') : '1.0.0'
}

const FORMAT_SAMPLES: Record<string, string> = {
  'date-time': '2024-01-01T00:00:00Z',
  date: '2024-01-01',
  time: '00:00:00',
  email: 'user@example.com',
  uuid: '00000000-0000-0000-0000-000000000000',
  uri: 'https://example.com',
  url: 'https://example.com',
  hostname: 'example.com',
  ipv4: '127.0.0.1',
  ipv6: '::1',
  byte: 'U3dhZ2dlcg=='
}

/**
 * Corpo de exemplo a partir do schema já traduzido (com os $defs de `root`). `depth` conta só o aninhamento
 * do valor (propriedade, item): $ref, allOf e oneOf não somam, e o ciclo de $ref para em `seen`.
 */
export function sample(schema: unknown, root: Obj, depth = 0, seen: string[] = []): unknown {
  if (!isObject(schema)) return undefined
  if (typeof schema['$ref'] === 'string') {
    const ref = schema['$ref']
    if (seen.includes(ref) || depth > MAX_SAMPLE_DEPTH) return undefined
    return sample(sample.resolve(ref, root), root, depth, [...seen, ref])
  }
  if (Array.isArray(schema['examples']) && schema['examples'].length) return schema['examples'][0]
  if (schema['default'] !== undefined) return schema['default']
  if (schema['const'] !== undefined) return schema['const']
  if (Array.isArray(schema['enum']) && schema['enum'].length) return schema['enum'][0]
  if (Array.isArray(schema['allOf'])) {
    const parts = schema['allOf'].map((s) => sample(s, root, depth, seen))
    if (parts.every((p) => p === undefined || isObject(p))) return Object.assign({}, ...parts.filter(isObject), objectSample(schema, root, depth, seen))
    return parts.find((p) => p !== undefined)
  }
  for (const k of ['oneOf', 'anyOf'] as const) {
    if (!Array.isArray(schema[k]) || !schema[k].length) continue
    // `oneOf: [{type: null}, {$ref}]` é como geradores (ex.: .NET) marcam referência anulável: o exemplo usa o ramo com valor.
    const branch = schema[k].find((s) => !(isObject(s) && s['type'] === 'null'))
    return branch === undefined ? null : sample(branch, root, depth, seen)
  }
  const types = Array.isArray(schema['type']) ? schema['type'] : [schema['type']]
  const type = types.find((t) => t !== 'null') ?? (isObject(schema['properties']) ? 'object' : schema['items'] ? 'array' : undefined)
  switch (type) {
    case 'object':
      return objectSample(schema, root, depth, seen)
    case 'array': {
      if (depth >= MAX_SAMPLE_DEPTH) return []
      const item = sample(schema['items'], root, depth + 1, seen)
      return item === undefined ? [] : [item]
    }
    case 'string':
      return FORMAT_SAMPLES[String(schema['format'])] ?? sizedString(schema)
    case 'integer':
    case 'number':
      return typeof schema['minimum'] === 'number' ? schema['minimum'] : typeof schema['exclusiveMinimum'] === 'number' ? schema['exclusiveMinimum'] + 1 : 0
    case 'boolean':
      return true
    case undefined:
      return types.includes('null') ? null : undefined
    default:
      return undefined
  }
}

/** "string" no tamanho que o schema pede (ex.: UF com maxLength 2 vira "st"). */
function sizedString(schema: Obj): string {
  const max = typeof schema['maxLength'] === 'number' ? schema['maxLength'] : Infinity
  const min = typeof schema['minLength'] === 'number' ? Math.min(schema['minLength'], max) : 0
  return 'string'.padEnd(min, 'x').slice(0, max)
}

/** Alvo de uma referência local (#/...) dentro de `root`. */
sample.resolve = (ref: string, root: Obj): unknown => {
  let target: unknown = root
  for (const raw of ref.replace(/^#\/?/, '').split('/')) target = isObject(target) ? target[raw.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined
  return target
}

function objectSample(schema: Obj, root: Obj, depth: number, seen: string[]): Obj {
  const out: Obj = {}
  if (depth >= MAX_SAMPLE_DEPTH || !isObject(schema['properties'])) return out
  const required = Array.isArray(schema['required']) ? schema['required'] : []
  for (const [name, prop] of Object.entries(schema['properties'])) {
    if (isObject(prop) && prop['readOnly'] === true) continue
    const value = sample(prop, root, depth + 1, seen)
    // Obrigatória sem exemplo possível (schema livre como `{}`): null mantém a chave e o exemplo válido.
    if (value !== undefined) out[name] = value
    else if (required.includes(name)) out[name] = null
  }
  return out
}
