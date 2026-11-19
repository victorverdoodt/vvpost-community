import type { Bundle, Connector, ConnectorAuth, Endpoint, Environment, ResponseExample } from '@vvpost/schemas'
import { joinPath, type ResolvedConnector } from '@vvpost/core/connectors/resolve'
import { resolveUrl } from '@vvpost/core/connectors/auth'
import { authHeaderName } from '@vvpost/core/connectors/auth-contract'
import { authVariables, fillPublic, headerValue, mergeHeaders, publicValue, viewBundle, type BundleView } from './targets'

/**
 * Exporta o pacote do VVPost como spec OpenAPI 3.1: cada endpoint vira uma operação (o caminho
 * com o basePath herdado), o conector vira a tag, o bodySchema vira o requestBody (os `$defs`
 * sobem para components.schemas), os exemplos viram respostas e a auth vira securitySchemes,
 * com as variáveis {{VAR}} de cada campo na descrição. Os servidores saem da URL base em cada
 * ambiente; só valores de variáveis que não são segredo entram. Módulo puro.
 */

export const OPENAPI_JSON_SUFFIX = '.openapi.json'
export const OPENAPI_YAML_SUFFIX = '.openapi.yaml'

type Obj = Record<string, unknown>

export interface OpenApiExport {
  spec: Obj
  warnings: string[]
}

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
/** Headers que o OpenAPI não aceita como parâmetro (vêm do requestBody, das respostas e da segurança). */
const RESERVED_HEADERS = /^(accept|content-type|authorization)$/i

export function bundleToOpenApi(bundle: Bundle): OpenApiExport {
  return new OpenApiWriter(bundle, viewBundle(bundle)).run()
}

interface Operation {
  connector: Connector
  resolved: ResolvedConnector
  endpoint: Endpoint
}

class OpenApiWriter {
  private readonly warnings: string[]
  private readonly counted = new Map<string, Set<string>>()
  private readonly schemas: Obj = {}
  private readonly securitySchemes: Obj = {}
  /** Esquema de segurança por conector que define a auth. */
  private readonly schemeOf = new Map<string, string>()
  private readonly operationIds = new Set<string>()
  private readonly env: Environment | undefined

  constructor(
    private readonly bundle: Bundle,
    private readonly view: BundleView
  ) {
    this.warnings = [...view.warnings]
    this.env = view.environments[0]
  }

  run(): OpenApiExport {
    const { roots } = this.view
    const single = roots.length === 1 ? roots[0]! : undefined
    const ops: Operation[] = []
    for (const c of this.view.connectors) {
      const resolved = this.view.resolved.get(c.id)
      if (!resolved) continue
      for (const endpoint of c.endpoints ?? []) {
        if (endpoint.plugin) this.count('plugin', `${c.name} › ${endpoint.name}`)
        else ops.push({ connector: c, resolved, endpoint })
      }
    }

    // O servidor da spec é a URL base mais usada; operações de outra origem levam o servidor delas.
    const bases = new Map<string, number>()
    for (const op of ops) if (op.resolved.baseUrl) bases.set(op.resolved.baseUrl, (bases.get(op.resolved.baseUrl) ?? 0) + 1)
    const mainBase = [...bases].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (!mainBase && ops.length) this.warnings.push('nenhum conector tem URL base: a spec saiu sem servers.')

    const tags: Obj[] = []
    const tagged = new Set<string>()
    const tagOf = (c: Connector): string | undefined => {
      // Com um conector raiz só, os endpoints dele ficam sem tag e cada filho é uma tag (como no import).
      if (single && c.id === single.id) return undefined
      if (!tagged.has(c.id)) {
        tagged.add(c.id)
        const description = [c.description, this.view.docs[c.id]].filter((p): p is string => !!p?.trim()).join('\n\n')
        tags.push({ name: c.name, ...(description && { description }) })
      }
      return c.name
    }

    const paths: Obj = {}
    for (const op of ops) {
      const { endpoint: e, resolved, connector } = op
      const path = joinPath(resolved.basePath, e.path) || '/'
      const item = (paths[path] ??= {}) as Obj
      const method = e.method.toLowerCase()
      const trail = `${connector.name} › ${e.name}`
      if (item[method]) {
        this.warnings.push(`${trail}: ${e.method} ${path} já saiu por outro endpoint e ficou de fora (no OpenAPI cada método e caminho é uma operação).`)
        continue
      }
      const operation = this.operation(op, path, tagOf(connector), trail)
      if (resolved.baseUrl && resolved.baseUrl !== mainBase) operation['servers'] = this.servers(resolved.baseUrl)
      item[method] = operation
    }

    // Segurança: a auth de todas as operações vai para o topo; o resto fica por operação.
    // As públicas (requiresAuth: false) ficam com security: [] e não contam para a auth do topo.
    const operations = Object.values(paths).flatMap((item) => Object.values(item as Obj) as Obj[])
    const requirements = operations.map((op) => JSON.stringify(op['security'] ?? null)).filter((r) => r !== '[]')
    const global = requirements.length && requirements.every((r) => r === requirements[0]) && requirements[0] !== 'null' ? requirements[0] : undefined
    for (const op of operations) {
      if (op['security'] === null || (global && JSON.stringify(op['security']) !== '[]')) delete op['security']
    }

    const description = [this.bundle.description, single?.description, single ? this.view.docs[single.id] : undefined]
      .filter((p): p is string => !!p?.trim())
      .join('\n\n')
    const spec: Obj = {
      openapi: '3.1.0',
      info: {
        title: this.bundle.name || single?.name || 'VVPost',
        version: single?.version ?? this.view.connectors[0]?.version ?? '1.0.0',
        ...(description && { description })
      },
      ...(mainBase && { servers: this.servers(mainBase) }),
      ...(global && { security: JSON.parse(global) }),
      ...(tags.length && { tags }),
      paths
    }
    const components: Obj = {}
    if (Object.keys(this.schemas).length) components['schemas'] = this.schemas
    if (Object.keys(this.securitySchemes).length) components['securitySchemes'] = this.securitySchemes
    if (Object.keys(components).length) spec['components'] = components
    this.flushCounts()
    return { spec, warnings: this.warnings }
  }

  // -------------------------------------------------------------------------
  // Servidores

  /**
   * A URL base em cada ambiente do pacote (só com variáveis que não são segredo). O que não
   * resolve vira variável do servidor: {{BASE_URL}}/v1 → {BASE_URL}/v1.
   */
  private servers(baseUrl: string): Obj[] {
    const out: Obj[] = []
    const seen = new Set<string>()
    for (const env of this.view.environments) {
      const url = fillPublic(baseUrl, env).replace(/\/+$/, '')
      if (url.includes('{{') || seen.has(url)) continue
      seen.add(url)
      out.push({ url, description: env.name })
    }
    if (out.length) return out
    const variables: Obj = {}
    const url = baseUrl.replace(/\/+$/, '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_all, name: string) => {
      const key = name.replace(/[{}]/g, '')
      variables[key] = {
        default: publicValue(this.env, name) ?? '',
        description: `Variável {{${name}}} do ambiente no VVPost.`
      }
      return `{${key}}`
    })
    return [{ url, ...(Object.keys(variables).length && { variables }) }]
  }

  // -------------------------------------------------------------------------
  // Operações

  private operation(op: Operation, path: string, tag: string | undefined, trail: string): Obj {
    const { endpoint: e, resolved, connector } = op
    const out: Obj = {}
    if (tag) out['tags'] = [tag]
    out['summary'] = e.name
    if (e.description) out['description'] = e.description
    out['operationId'] = this.operationId(e.source?.operationId ?? e.id, connector)

    const parameters: Obj[] = []
    for (const m of path.matchAll(/\{([^{}/]+)\}/g)) {
      if (parameters.some((p) => p['name'] === m[1])) continue
      parameters.push({
        name: m[1],
        in: 'path',
        required: true,
        schema: { type: 'string' }
      })
    }
    for (const [name, value] of Object.entries(e.query ?? {})) parameters.push(this.parameter(name, 'query', value))
    const auth = resolved.auth?.config
    const authHeader = auth ? authHeaderName(auth)?.toLowerCase() : undefined
    const headers = mergeHeaders(resolved.headers, e.headers)
    for (const [name, value] of Object.entries(headers)) {
      if (RESERVED_HEADERS.test(name) || name.toLowerCase() === authHeader) continue
      parameters.push(this.parameter(name, 'header', value))
    }
    if (parameters.length) out['parameters'] = parameters

    const body = this.requestBody(e, headerValue(headers, 'content-type'), trail)
    if (body) out['requestBody'] = body
    out['responses'] = this.responses(e.examples ?? [], trail)
    out['security'] = e.requiresAuth === false ? [] : resolved.auth ? [{ [this.scheme(resolved, trail)]: this.scopes(resolved.auth.config) }] : null
    if (resolved.scripts.length || e.scripts?.pre?.trim() || e.scripts?.post?.trim()) this.count('scripts', trail)
    if (e.scenarios?.length) this.count('scenarios', trail)
    return out
  }

  private operationId(base: string, connector: Connector): string {
    let id = base
    if (this.operationIds.has(id)) id = `${connector.id.replace(/^connector\./, '')}.${base}`
    for (let n = 2; this.operationIds.has(id); n++) id = `${base}_${n}`
    this.operationIds.add(id)
    return id
  }

  private parameter(name: string, into: 'query' | 'header', value: string): Obj {
    const vars = /\{\{[^{}]+\}\}/.test(value)
    return {
      name,
      in: into,
      ...(vars && { description: `No VVPost: ${value}` }),
      schema: { type: 'string' },
      ...(value !== '' && { example: value })
    }
  }

  private requestBody(e: Endpoint, contentType: string | undefined, trail: string): Obj | undefined {
    const p = e.payload
    if (p?.mode === 'urlencoded' || p?.mode === 'multipart') {
      const properties: Obj = {}
      const example: Obj = {}
      for (const f of p.fields) {
        if ('file' in f && f.file !== undefined) properties[f.name] = { type: 'string', format: 'binary' }
        else {
          properties[f.name] = { type: 'string' }
          if (f.value !== undefined) example[f.name] = f.value
        }
      }
      const schema = e.bodySchema ? this.schema(e.bodySchema, trail) : { type: 'object', properties }
      const type = p.mode === 'urlencoded' ? 'application/x-www-form-urlencoded' : 'multipart/form-data'
      return {
        content: {
          [type]: { schema, ...(Object.keys(example).length && { example }) }
        }
      }
    }
    if (p?.mode === 'binary') {
      return {
        content: {
          [p.contentType ?? contentType ?? 'application/octet-stream']: {
            schema: { type: 'string', format: 'binary' }
          }
        }
      }
    }
    if (e.body === undefined && !e.bodySchema) return undefined
    const type = contentType ?? (typeof e.body === 'string' && !e.bodySchema ? 'text/plain' : 'application/json')
    const media: Obj = {}
    if (e.bodySchema) media['schema'] = this.schema(e.bodySchema, trail)
    else if (typeof e.body === 'string') media['schema'] = { type: 'string' }
    if (e.body !== undefined) media['example'] = e.body
    return {
      content: { [type]: media },
      ...(e.bodySchema && { required: true })
    }
  }

  /**
   * Respostas por status, com os exemplos nomeados e o schema do primeiro exemplo que tem um;
   * sem exemplos, só a resposta padrão.
   */
  private responses(examples: ResponseExample[], trail: string): Obj {
    const out: Obj = {}
    const byStatus = new Map<number, ResponseExample[]>()
    for (const x of examples) byStatus.set(x.status, [...(byStatus.get(x.status) ?? []), x])
    for (const [status, list] of [...byStatus].sort((a, b) => a[0] - b[0])) {
      const first = list[0]!
      const response: Obj = { description: first.description ?? first.name }
      const headers: Obj = {}
      for (const [name, value] of Object.entries(first.headers ?? {})) {
        if (name.toLowerCase() === 'content-type') continue
        headers[name] = { schema: { type: 'string' }, example: value }
      }
      if (Object.keys(headers).length) response['headers'] = headers
      const content: Obj = {}
      for (const x of list) {
        if (x.body === undefined) continue
        const type = headerValue(x.headers, 'content-type') ?? (typeof x.body === 'string' ? 'text/plain' : 'application/json')
        const media = (content[type] ??= { examples: {} }) as { schema?: Obj; examples: Obj }
        if (x.schema && !media.schema) media.schema = this.schema(x.schema, trail)
        media.examples[x.id] = {
          summary: x.name,
          ...(x.description && { description: x.description }),
          value: x.body
        }
      }
      if (Object.keys(content).length) response['content'] = content
      out[String(status)] = response
    }
    if (!Object.keys(out).length) out['default'] = { description: 'Resposta' }
    return out
  }

  /**
   * O bodySchema na spec: os `$defs` dele vão para components.schemas (no OpenAPI, "#/" é a
   * raiz do documento, não do schema), com nome novo se outro corpo já usar o mesmo nome.
   */
  private schema(bodySchema: Record<string, unknown>, trail: string): Obj {
    const { $defs, $schema: _, ...rest } = bodySchema as Obj
    const renamed = new Map<string, string>()
    if (isObject($defs)) {
      for (const [name, def] of Object.entries($defs)) {
        let target = name
        for (let n = 2; this.schemas[target] !== undefined && JSON.stringify(this.schemas[target]) !== JSON.stringify(def); n++) target = `${name}${n}`
        renamed.set(name, target)
      }
      for (const [name, def] of Object.entries($defs)) this.schemas[renamed.get(name)!] = this.rewriteRefs(def, renamed, trail)
    }
    return this.rewriteRefs(rest, renamed, trail) as Obj
  }

  private rewriteRefs(value: unknown, renamed: Map<string, string>, trail: string): unknown {
    if (Array.isArray(value)) return value.map((v) => this.rewriteRefs(v, renamed, trail))
    if (!isObject(value)) return value
    const out: Obj = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === '$ref' && typeof v === 'string' && v.startsWith('#')) {
        const m = /^#\/\$defs\/([^/]+)$/.exec(v)
        const name = m ? decodeURIComponent(m[1]!).replace(/~1/g, '/').replace(/~0/g, '~') : undefined
        if (name && renamed.has(name)) out[k] = `#/components/schemas/${encodePointer(renamed.get(name)!)}`
        else {
          this.count('ref', trail)
          out[k] = v
        }
      } else out[k] = this.rewriteRefs(v, renamed, trail)
    }
    return out
  }

  // -------------------------------------------------------------------------
  // Segurança

  /** Um esquema por conector que define a auth, nomeado pelo conector. */
  private scheme(resolved: ResolvedConnector, trail: string): string {
    const { config, from } = resolved.auth!
    const known = this.schemeOf.get(from)
    if (known) return known
    let name = from.replace(/^connector\./, '').replace(/[^A-Za-z0-9._-]+/g, '_') || 'auth'
    for (let n = 2; this.securitySchemes[name] !== undefined; n++) name = `${name}_${n}`
    this.schemeOf.set(from, name)
    const vars = authVariables(config)
    const note = vars.length ? `Variáveis no VVPost: ${vars.join(', ')}.` : undefined
    const describe = (text?: string) => [text, note].filter(Boolean).join(' ') || undefined
    const base = this.view.resolved.get(from)?.baseUrl
    let scheme: Obj
    switch (config.type) {
      case 'bearer': {
        const header = config.header ?? 'Authorization'
        scheme =
          header.toLowerCase() === 'authorization' && (config.prefix ?? 'Bearer') === 'Bearer'
            ? { type: 'http', scheme: 'bearer' }
            : { type: 'apiKey', in: 'header', name: header }
        break
      }
      case 'apiKey':
        scheme = {
          type: 'apiKey',
          in: config.in ?? 'header',
          name: config.name
        }
        break
      case 'basic':
        scheme = { type: 'http', scheme: 'basic' }
        break
      case 'digest':
        scheme = { type: 'http', scheme: 'digest' }
        break
      case 'ntlm':
        scheme = { type: 'http', scheme: 'ntlm' }
        break
      case 'oauth1':
        scheme = { type: 'http', scheme: 'oauth' }
        break
      case 'awsSigV4':
        scheme = {
          type: 'apiKey',
          in: 'header',
          name: 'Authorization',
          'x-amazon-apigateway-authtype': 'awsSigv4'
        }
        scheme['description'] = describe(`AWS Signature Version 4 (região ${config.region}, serviço ${config.service}).`)
        break
      case 'oauth2': {
        const scopes = Object.fromEntries(
          (config.scope ?? '')
            .split(/\s+/)
            .filter(Boolean)
            .map((s) => [s, ''])
        )
        const tokenUrl = this.url(config.tokenUrl, base, trail)
        const flow =
          config.grantType === 'client_credentials'
            ? { clientCredentials: { tokenUrl, scopes } }
            : config.grantType === 'password'
              ? { password: { tokenUrl, scopes } }
              : {
                  authorizationCode: {
                    authorizationUrl: this.url(config.authUrl ?? '', base, trail),
                    tokenUrl,
                    scopes
                  }
                }
        scheme = { type: 'oauth2', flows: flow }
        break
      }
      case 'login': {
        const inject = config.inject ?? {}
        const into = inject.in ?? 'header'
        const header = inject.name ?? (into === 'query' ? 'access_token' : 'Authorization')
        const login = `${config.request.method ?? 'POST'} ${this.url(config.request.url, base, trail)}`
        scheme =
          into === 'header' && header.toLowerCase() === 'authorization' && (inject.value ?? 'Bearer {{$token}}') === 'Bearer {{$token}}'
            ? { type: 'http', scheme: 'bearer' }
            : { type: 'apiKey', in: into, name: header }
        scheme['description'] = describe(`Token obtido por ${login}, em ${config.token}.`)
        break
      }
    }
    if (scheme['description'] === undefined && describe()) scheme['description'] = describe()
    this.securitySchemes[name] = scheme
    return name
  }

  private scopes(auth: ConnectorAuth): string[] {
    return auth.type === 'oauth2' ? (auth.scope ?? '').split(/\s+/).filter(Boolean) : []
  }

  /** URL absoluta para a spec, com as variáveis públicas do primeiro ambiente trocadas. */
  private url(url: string, base: string | undefined, trail: string): string {
    let out = fillPublic(url, this.env)
    if (!/^https?:\/\//i.test(out) && base && !out.startsWith('{{')) {
      try {
        out = resolveUrl(out, fillPublic(base, this.env), 'url')
      } catch {
        // Fica relativo; o aviso abaixo diz o que falta.
      }
    }
    if (out.includes('{{')) this.count('authVars', trail)
    return out
  }

  private count(kind: string, where: string): void {
    const set = this.counted.get(kind) ?? new Set()
    set.add(where)
    this.counted.set(kind, set)
  }

  private flushCounts(): void {
    const text: Record<string, string> = {
      plugin: 'endpoints de plugin (gRPC, Kafka...) não são HTTP e ficaram fora da spec',
      scripts: 'os scripts pre e post só vão no pacote do VVPost e no Postman',
      scenarios: 'os cenários de teste só vão no pacote do VVPost',
      ref: 'referências do bodySchema fora de $defs ficaram como estão',
      authVars: 'URLs da auth com variável sem valor público no ambiente ficaram com {{VAR}}'
    }
    for (const [kind, set] of this.counted) {
      const list = [...set]
      const shown = list.slice(0, 5).join(', ') + (list.length > 5 ? ` e mais ${list.length - 5}` : '')
      this.warnings.push(`${text[kind] ?? kind}: ${shown}.`)
    }
  }
}

function encodePointer(name: string): string {
  return name.replace(/~/g, '~0').replace(/\//g, '~1')
}
