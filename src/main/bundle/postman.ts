import { REQUIRED_SECRET, type Bundle, type Connector, type ConnectorAuth, type Endpoint, type Environment, type RequestScripts } from '@vvpost/schemas'
import { joinPath } from '@vvpost/core/connectors/resolve'
import { resolveUrl } from '@vvpost/core/connectors/auth'
import { headerValue, mergeHeaders, templateVars, varPrefix, viewBundle, type BundleView } from './targets'

/**
 * Exporta o pacote do VVPost como coleção v2.1 do Postman, mais um ambiente do Postman por
 * ambiente do pacote. Cada conector vira uma pasta (a hierarquia do `extends`), com a auth
 * do conector na pasta e os headers herdados em cada requisição. A auth vai como variáveis
 * {{VAR}}, como no projeto; segredos vão vazios e do tipo secret nos ambientes. Módulo puro.
 */

export const POSTMAN_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
export const COLLECTION_SUFFIX = '.postman_collection.json'
export const ENVIRONMENT_SUFFIX = '.postman_environment.json'

type Obj = Record<string, unknown>

interface PmKv {
  key: string
  value: string
  type?: string
  description?: string
  disabled?: boolean
}

export interface PostmanExport {
  collection: Obj
  environments: { id: string; name: string; data: Obj }[]
  warnings: string[]
}

/** As variáveis dinâmicas do VVPost com outro nome no Postman. */
const DYNAMIC: Record<string, string> = { $uuid: '$randomUUID' }
const POSTMAN_DYNAMIC = new Set(['$randomUUID', '$guid', '$timestamp', '$isoTimestamp', '$randomInt'])

const RAW_LANGUAGES: [RegExp, string][] = [
  [/[/+]json\b/i, 'json'],
  [/[/+]xml\b/i, 'xml'],
  [/^text\/html/i, 'html'],
  [/javascript/i, 'javascript']
]

export function bundleToPostman(bundle: Bundle): PostmanExport {
  const view = viewBundle(bundle)
  return new PostmanWriter(bundle, view).run()
}

class PostmanWriter {
  private readonly warnings: string[]
  private readonly counted = new Map<string, Set<string>>()
  /** Variáveis que o login de um conector define com o token. */
  private readonly tokenVars = new Set<string>()

  constructor(
    private readonly bundle: Bundle,
    private readonly view: BundleView
  ) {
    this.warnings = [...view.warnings]
  }

  run(): PostmanExport {
    const { roots } = this.view
    const single = roots.length === 1 ? roots[0]! : undefined
    const name = this.bundle.name || single?.name || 'VVPost'
    const collection: Obj = {
      info: {
        name,
        ...(this.description(single, this.bundle.description) && {
          description: this.description(single, this.bundle.description)
        }),
        ...(single?.version && { version: single.version }),
        schema: POSTMAN_SCHEMA
      }
    }
    if (single) {
      const { login, ...parts } = this.folderParts(single)
      Object.assign(collection, parts)
      collection['item'] = this.items(single, login)
    } else {
      collection['item'] = roots.map((c) => this.folder(c))
    }

    const environments = this.view.environments.map((env) => ({
      id: env.id,
      name: env.name,
      data: this.environment(env)
    }))
    const defined = new Set(this.view.environments.flatMap((e) => Object.keys(e.variables)))
    const missing = templateVars(collection).filter((v) => !defined.has(v) && !this.tokenVars.has(v))
    if (missing.length) {
      collection['variable'] = missing.sort().map((key) => ({
        key,
        value: '',
        type: 'string',
        description: 'Defina no ambiente do Postman.'
      }))
    }
    const text = this.dynamic(JSON.stringify(collection))
    this.flushCounts()
    return {
      collection: JSON.parse(text) as Obj,
      environments,
      warnings: this.warnings
    }
  }

  // -------------------------------------------------------------------------
  // Pastas e requisições

  private folder(c: Connector): Obj {
    const out: Obj = { name: c.name }
    const description = this.description(c)
    if (description) out['description'] = description
    const { login, ...parts } = this.folderParts(c)
    Object.assign(out, parts)
    out['item'] = this.items(c, login)
    return out
  }

  /** Auth e scripts do próprio conector (o que ele herda vem da pasta de cima). */
  private folderParts(c: Connector): {
    auth?: Obj
    event?: Obj[]
    login: Obj[]
  } {
    const login: Obj[] = []
    const auth = c.config?.auth ? this.auth(c, c.config.auth, login) : undefined
    const events = this.events(c.config?.scripts, c.name)
    return {
      ...(auth && { auth }),
      ...(events.length && { event: events }),
      login
    }
  }

  /** O login da auth (se houver) primeiro, depois os endpoints e as pastas dos filhos. */
  private items(c: Connector, login: Obj[]): Obj[] {
    const resolved = this.view.resolved.get(c.id)!
    const endpoints = (resolved.endpoints ?? []).flatMap((e): Obj[] => {
      const r = this.request(c, e)
      return r ? [r] : []
    })
    const children = (this.view.children.get(c.id) ?? []).map((child) => this.folder(child))
    return [...login, ...endpoints, ...children]
  }

  private request(c: Connector, e: Endpoint): Obj | undefined {
    const trail = `${c.name} › ${e.name}`
    if (e.plugin) {
      this.count('plugin', trail)
      return undefined
    }
    const resolved = this.view.resolved.get(c.id)!
    const headers = mergeHeaders(resolved.headers, e.headers)
    const request: Obj = { method: e.method }
    const contentType = headerValue(headers, 'content-type')
    const body = this.body(e, contentType)
    // O Postman não manda Content-Type sozinho no raw de texto: fica o do endpoint (ou o do corpo).
    if (body?.['mode'] === 'raw' && !contentType && body['$contentType']) headers['Content-Type'] = body['$contentType'] as string
    if (body) delete body['$contentType']
    const header = Object.entries(headers).map(([key, value]) => ({
      key,
      value
    }))
    if (header.length) request['header'] = header
    if (body) request['body'] = body
    request['url'] = this.url(resolved.baseUrl, joinPath(resolved.basePath, e.path) || '/', e.query, trail)
    const description = this.endpointDescription(e)
    if (description) request['description'] = description

    const item: Obj = { name: e.name, request }
    const events = this.events(e.scripts, trail)
    if (events.length) item['event'] = events
    if (e.scenarios?.length) this.count('scenarios', trail)
    const responses = (e.examples ?? []).map((x) => {
      const exampleHeaders = Object.entries(x.headers ?? {}).map(([key, value]) => ({ key, value }))
      const text = x.body === undefined ? '' : typeof x.body === 'string' ? x.body : JSON.stringify(x.body, null, 2)
      const json = x.body !== undefined && typeof x.body !== 'string'
      return {
        name: x.name,
        originalRequest: {
          method: request['method'],
          header: request['header'] ?? [],
          url: request['url'],
          ...(request['body'] ? { body: request['body'] } : {})
        },
        code: x.status,
        status: STATUS_TEXT[x.status] ?? '',
        ...(json && { _postman_previewlanguage: 'json' }),
        header: json && !headerValue(x.headers, 'content-type') ? [{ key: 'Content-Type', value: 'application/json' }, ...exampleHeaders] : exampleHeaders,
        body: text
      }
    })
    if (responses.length) item['response'] = responses
    return item
  }

  private url(baseUrl: string | undefined, path: string, query: Record<string, string> | undefined, trail: string): Obj {
    if (!baseUrl) this.count('baseUrl', trail)
    const base = (baseUrl ?? '{{baseUrl}}').replace(/\/+$/, '')
    const variables: PmKv[] = []
    const pmPath = path.replace(/\{([^{}/]+)\}/g, (_all, name: string) => {
      if (!variables.some((v) => v.key === name)) variables.push({ key: name, value: '' })
      return `:${name}`
    })
    const q = Object.entries(query ?? {}).map(([key, value]) => ({
      key,
      value
    }))
    const search = q.length ? `?${q.map((p) => `${p.key}=${p.value}`).join('&')}` : ''
    const raw = `${base}${pmPath}${search}`
    const out: Obj = { raw }
    const m = /^(https?):\/\/([^/:?#]+)(?::(\d+))?(\/[^?#]*)?$/i.exec(base)
    if (m) {
      out['protocol'] = m[1]!.toLowerCase()
      out['host'] = m[2]!.split('.')
      if (m[3]) out['port'] = m[3]
      out['path'] = `${m[4] ?? ''}${pmPath}`.split('/').filter(Boolean)
    } else {
      // URL base com variável ({{BASE_URL}}/v1): o host é a variável, o resto é caminho.
      const [host, ...rest] = base.split('/')
      out['host'] = [host]
      out['path'] = [...rest, ...pmPath.split('/')].filter(Boolean)
    }
    if (q.length) out['query'] = q
    if (variables.length) out['variable'] = variables
    return out
  }

  private body(e: Endpoint, contentType: string | undefined): Obj | undefined {
    const p = e.payload
    if (p?.mode === 'urlencoded') {
      return {
        mode: 'urlencoded',
        urlencoded: p.fields.map((f) => ({
          key: f.name,
          value: f.value ?? '',
          type: 'text'
        }))
      }
    }
    if (p?.mode === 'multipart') {
      return {
        mode: 'formdata',
        formdata: p.fields.map((f) =>
          f.file !== undefined
            ? {
                key: f.name,
                type: 'file',
                src: f.file,
                ...(f.contentType && { contentType: f.contentType })
              }
            : {
                key: f.name,
                value: f.value ?? '',
                type: 'text',
                ...(f.contentType && { contentType: f.contentType })
              }
        )
      }
    }
    if (p?.mode === 'binary') return { mode: 'file', file: { src: p.file } }
    if (e.body === undefined || e.body === null) return undefined
    if (typeof e.body === 'string') {
      const language = RAW_LANGUAGES.find(([re]) => contentType && re.test(contentType))?.[1] ?? 'text'
      return { mode: 'raw', raw: e.body, options: { raw: { language } } }
    }
    return {
      mode: 'raw',
      raw: JSON.stringify(e.body, null, 2),
      options: { raw: { language: 'json' } },
      $contentType: 'application/json'
    }
  }

  // -------------------------------------------------------------------------
  // Auth

  /**
   * A auth do conector na pasta, com os valores como estão no projeto ({{VAR}}). O login
   * próprio da API vira uma requisição "Login" na pasta, que guarda o token numa variável.
   */
  private auth(c: Connector, auth: ConnectorAuth, login: Obj[]): Obj {
    const kv = (type: string, values: Record<string, string | boolean | undefined>): Obj => ({
      type,
      [type]: Object.entries(values)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([key, value]) => ({
          key,
          value,
          type: typeof value === 'boolean' ? 'boolean' : 'string'
        }))
    })
    switch (auth.type) {
      case 'none':
        return { type: 'noauth' }
      case 'bearer': {
        const header = auth.header ?? 'Authorization'
        const prefix = auth.prefix ?? 'Bearer'
        if (header.toLowerCase() === 'authorization' && prefix === 'Bearer') return kv('bearer', { token: auth.token })
        return kv('apikey', {
          key: header,
          value: prefix ? `${prefix} ${auth.token}` : auth.token,
          in: 'header'
        })
      }
      case 'apiKey':
        return kv('apikey', {
          key: auth.name,
          value: auth.value,
          in: auth.in ?? 'header'
        })
      case 'basic':
        return kv('basic', {
          username: auth.username,
          password: auth.password
        })
      case 'digest':
        return kv('digest', {
          username: auth.username,
          password: auth.password
        })
      case 'ntlm':
        return kv('ntlm', {
          username: auth.username,
          password: auth.password,
          domain: auth.domain,
          workstation: auth.workstation
        })
      case 'awsSigV4':
        return kv('awsv4', {
          accessKey: auth.accessKeyId,
          secretKey: auth.secretAccessKey,
          sessionToken: auth.sessionToken,
          region: auth.region,
          service: auth.service
        })
      case 'oauth1':
        return kv('oauth1', {
          consumerKey: auth.consumerKey,
          consumerSecret: auth.consumerSecret,
          token: auth.token,
          tokenSecret: auth.tokenSecret,
          signatureMethod: auth.signatureMethod ?? 'HMAC-SHA1',
          realm: auth.realm,
          addParamsToHeader: true
        })
      case 'oauth2': {
        const base = this.view.resolved.get(c.id)?.baseUrl
        const grant =
          auth.grantType === 'client_credentials'
            ? 'client_credentials'
            : auth.grantType === 'password'
              ? 'password_credentials'
              : auth.pkce === false
                ? 'authorization_code'
                : 'authorization_code_with_pkce'
        if (auth.tokenRequestFormat === 'json') this.count('oauth2Json', c.name)
        return kv('oauth2', {
          grant_type: grant,
          accessTokenUrl: this.absolute(auth.tokenUrl, base),
          authUrl: auth.authUrl,
          redirect_uri: auth.redirectUri,
          clientId: auth.clientId,
          clientSecret: auth.clientSecret,
          username: auth.username,
          password: auth.password,
          scope: auth.scope,
          client_authentication: auth.clientAuthentication === 'body' ? 'body' : 'header',
          addTokenTo: 'header',
          tokenName: c.name
        })
      }
      case 'login': {
        const tokenVar = `${varPrefix(c.id)}_TOKEN`
        this.tokenVars.add(tokenVar)
        login.push(this.loginItem(c, auth, tokenVar))
        const inject = auth.inject ?? {}
        const value = (inject.value ?? 'Bearer {{$token}}').split('{{$token}}').join(`{{${tokenVar}}}`)
        const name = inject.name ?? (inject.in === 'query' ? 'access_token' : 'Authorization')
        if (inject.in !== 'query' && name.toLowerCase() === 'authorization' && value === `Bearer {{${tokenVar}}}`) {
          return kv('bearer', { token: `{{${tokenVar}}}` })
        }
        return kv('apikey', { key: name, value, in: inject.in ?? 'header' })
      }
    }
  }

  /** A requisição de login do conector, com um teste que guarda o token na variável da pasta. */
  private loginItem(c: Connector, auth: Extract<ConnectorAuth, { type: 'login' }>, tokenVar: string): Obj {
    const base = this.view.resolved.get(c.id)?.baseUrl
    const r = auth.request
    const header = Object.entries(r.headers ?? {}).map(([key, value]) => ({
      key,
      value
    }))
    let body: Obj | undefined
    if (r.json !== undefined) {
      body = {
        mode: 'raw',
        raw: JSON.stringify(r.json, null, 2),
        options: { raw: { language: 'json' } }
      }
      if (!headerValue(r.headers, 'content-type')) header.push({ key: 'Content-Type', value: 'application/json' })
    } else if (r.form) {
      body = {
        mode: 'urlencoded',
        urlencoded: Object.entries(r.form).map(([key, value]) => ({
          key,
          value,
          type: 'text'
        }))
      }
    } else if (r.body !== undefined) {
      body = { mode: 'raw', raw: r.body }
    }
    const read = auth.token.startsWith('headers.')
      ? `pm.response.headers.get(${JSON.stringify(auth.token.slice('headers.'.length))})`
      : `pm.response.json()${(auth.token.slice('body'.length).match(/[^.[\]]+/g) ?? [])
          .map((k) => (/^\d+$/.test(k) ? `[${k}]` : `[${JSON.stringify(k)}]`))
          .join('')}`
    return {
      name: `Login (${c.name})`,
      request: {
        method: r.method ?? 'POST',
        ...(header.length && { header }),
        ...(body && { body }),
        url: { raw: this.absolute(r.url, base) },
        auth: { type: 'noauth' },
        description: `Login da auth do conector no VVPost: rode antes das outras requisições da pasta. O token vai para {{${tokenVar}}}.`
      },
      event: [
        {
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec: [`pm.collectionVariables.set(${JSON.stringify(tokenVar)}, ${read});`]
          }
        }
      ]
    }
  }

  private absolute(url: string, base: string | undefined): string {
    if (/^(https?:)?\/\//i.test(url) || url.startsWith('{{') || !base) return url
    try {
      return resolveUrl(url, base, 'url')
    } catch {
      return `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`
    }
  }

  // -------------------------------------------------------------------------
  // Scripts, ambientes e textos

  /** Scripts pre e post como eventos prerequest e test, com a API vv trocada pelo pm. */
  private events(scripts: RequestScripts | undefined, trail: string): Obj[] {
    const out: Obj[] = []
    for (const [phase, listen] of [
      ['pre', 'prerequest'],
      ['post', 'test']
    ] as const) {
      const code = scripts?.[phase]
      if (!code?.trim()) continue
      const { code: translated, unsupported } = translateVvScript(code)
      if (unsupported.length) this.warnings.push(`${trail}: o script ${phase} usa ${unsupported.join(', ')} sem equivalente no Postman; ficou como está.`)
      out.push({
        listen,
        script: { type: 'text/javascript', exec: translated.split('\n') }
      })
    }
    return out
  }

  private environment(env: Environment): Obj {
    const values = Object.entries(env.variables).map(([key, v]) => {
      const secret = v.isSecret || v.value === REQUIRED_SECRET
      return {
        key,
        value: secret ? '' : String(v.value),
        type: secret ? 'secret' : 'default',
        enabled: true,
        ...(v.description && { description: v.description })
      }
    })
    const pending = values.filter((v) => v.type === 'secret').length
    if (pending) this.warnings.push(`${env.id}: ${pending} segredo(s) vão vazios no ambiente do Postman; quem importar preenche.`)
    return { name: env.name, values, _postman_variable_scope: 'environment' }
  }

  /** Descrição do conector com a documentação Markdown dele, se houver. */
  private description(c: Connector | undefined, extra?: string): string | undefined {
    const parts = [extra, c?.description, c ? this.view.docs[c.id] : undefined].filter((p): p is string => !!p?.trim())
    return parts.length ? parts.join('\n\n') : undefined
  }

  /** Descrição do endpoint com o schema do corpo, que o Postman não tem onde guardar. */
  private endpointDescription(e: Endpoint): string | undefined {
    const parts: string[] = []
    if (e.description?.trim()) parts.push(e.description)
    if (e.bodySchema) parts.push(`### Schema do corpo\n\n\`\`\`json\n${JSON.stringify(e.bodySchema, null, 2)}\n\`\`\``)
    return parts.length ? parts.join('\n\n') : undefined
  }

  /** {{$uuid}} do VVPost é {{$randomUUID}} no Postman; $capture, $data e afins não existem lá. */
  private dynamic(text: string): string {
    return text.replace(/\{\{\s*(\$[^{}\s]+?)\s*\}\}/g, (all, name: string) => {
      const mapped = DYNAMIC[name] ?? name
      if (!POSTMAN_DYNAMIC.has(mapped)) this.count('dynamic', name)
      return POSTMAN_DYNAMIC.has(mapped) ? `{{${mapped}}}` : all
    })
  }

  private count(kind: string, where: string): void {
    const set = this.counted.get(kind) ?? new Set()
    set.add(where)
    this.counted.set(kind, set)
  }

  private flushCounts(): void {
    const text: Record<string, string> = {
      plugin: 'endpoints de plugin (gRPC, Kafka...) não têm equivalente no Postman e ficaram de fora',
      scenarios: 'os cenários de teste só vão no pacote do VVPost',
      baseUrl: 'sem URL base no conector: a URL usa {{baseUrl}}, defina no Postman',
      oauth2Json: 'OAuth2 com pedido de token em JSON: o Postman manda em form',
      dynamic: 'variáveis do VVPost sem equivalente no Postman ficaram como estão'
    }
    for (const [kind, set] of this.counted) {
      const list = [...set]
      const shown = list.slice(0, 5).join(', ') + (list.length > 5 ? ` e mais ${list.length - 5}` : '')
      this.warnings.push(`${text[kind] ?? kind}: ${shown}.`)
    }
  }
}

/** Trocas da API vv dos scripts pelo pm do Postman, o caminho de volta do pm-scripts.ts. */
const VV_RULES: [RegExp, string][] = [
  [/\bvv\.expect\(vv\.response\)\.to\.have\.status\(/g, 'pm.response.to.have.status('],
  [/\bvv\.response\.header\(/g, 'pm.response.headers.get('],
  [/\bvv\.response\.json\(\)/g, 'pm.response.json()'],
  [/\bvv\.response\.text\(\)/g, 'pm.response.text()'],
  [/\bvv\.response\.(?:code|status)\b/g, 'pm.response.code'],
  [/\bvv\.response\.responseTime\b/g, 'pm.response.responseTime'],
  [/\bvv\.response\.headers\b/g, 'pm.response.headers.toObject()'],
  [/\bvv\.request\.header\(/g, 'pm.request.headers.get('],
  [/\bvv\.request\.removeHeader\(/g, 'pm.request.headers.remove('],
  [/\bvv\.request\.setHeader\(/g, 'vvSetHeader('],
  [/\bvv\.request\.headers\b/g, 'pm.request.headers.toObject()'],
  [/\bvv\.request\.url\b/g, 'pm.request.url'],
  [/\bvv\.request\.method\b/g, 'pm.request.method'],
  [/\bvv\.request\.body\b/g, 'pm.request.body.raw'],
  [/\bvv\.(?:variables|environment)\.(get|has|toObject)\(/g, 'pm.variables.$1('],
  [/\bvv\.(?:variables|environment)\.(set|unset)\(/g, 'pm.collectionVariables.$1('],
  [/\bvv\.test\(/g, 'pm.test('],
  [/\bvv\.expect\(/g, 'pm.expect(']
]

const SET_HEADER_SHIM =
  "const vvSetHeader = (key, value) => pm.request.headers.upsert(typeof key === 'object' ? key : { key: String(key), value: String(value) })"

export function translateVvScript(source: string): {
  code: string
  unsupported: string[]
} {
  let code = source
  for (const [re, to] of VV_RULES) code = code.replace(re, to)
  if (code.includes('vvSetHeader(')) code = `${SET_HEADER_SHIM}\n${code}`
  const unsupported = new Set<string>()
  for (const m of code.matchAll(/\bvv\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?/g)) unsupported.add(m[0])
  return { code, unsupported: [...unsupported].sort() }
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable'
}
