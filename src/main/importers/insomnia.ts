import {
  asString,
  baseName,
  hasHeader,
  isObject,
  needsContentType,
  postmanAuth,
  postmanUrl,
  rawBody,
  type ForeignConversion,
  type KeyValue
} from './foreign'
import type { ImportWarning } from './postman'

/**
 * Importador do Insomnia: a exportação v4 (JSON, `__export_format: 4`, com a lista `resources`) e
 * a v5 (YAML, `type: collection.insomnia.rest/5.0`). Pastas viram pastas, requisições viram
 * requisições, o ambiente base e os subambientes viram ambientes, e as variáveis das pastas entram
 * nas variáveis da coleção. `{{ _.nome }}` vira `{{nome}}`, e as tags `{% uuid %}` e `{% now %}`
 * viram as variáveis dinâmicas do VVPost. Os scripts (Insomnia 9+) usam a API `insomnia.*`, que é
 * a do Postman com outro nome: viram `pm.*` e seguem a tradução para a API `vv`.
 */

type Obj = Record<string, unknown>

interface InsAuth {
  type?: string
  disabled?: boolean
  [param: string]: unknown
}

interface InsNode {
  kind: 'folder' | 'request'
  id: string
  name: string
  description?: string
  sortKey: number
  // Pasta
  children: InsNode[]
  environment?: Obj
  // Requisição e pasta
  headers: KeyValue[]
  auth?: InsAuth
  preRequest?: string
  afterResponse?: string
  // Requisição
  url?: string
  method?: string
  body?: Obj
  parameters?: KeyValue[]
  protocol?: string
}

interface InsEnvironment {
  name: string
  data: Obj
  isPrivate: boolean
  children: InsEnvironment[]
}

/** Exportação do Insomnia v4 (JSON) ou v5 (YAML). */
export function isInsomnia(data: unknown): boolean {
  if (!isObject(data)) return false
  if (data['_type'] === 'export' && Array.isArray(data['resources'])) return true
  return typeof data['type'] === 'string' && /insomnia\.rest\/5\./.test(data['type'])
}

export function convertInsomnia(file: string, data: unknown): ForeignConversion {
  const warnings: ImportWarning[] = []
  const out: ForeignConversion = { format: 'insomnia', name: baseName(file), postman: [], warnings, errors: [] }
  if (!isObject(data) || !isInsomnia(data)) {
    out.errors.push({ file, message: 'não parece uma exportação do Insomnia (v4 ou v5)' })
    return out
  }
  const parsed = data['_type'] === 'export' ? fromV4(data, file, warnings) : fromV5(data, warnings)
  if (!parsed.length) {
    out.errors.push({ file, message: 'a exportação do Insomnia não tem coleção de requisições' })
    return out
  }
  const templates = new Set<string>()
  for (const ws of parsed) {
    const conv = new Converter(ws.name, warnings, templates)
    const collection = conv.collection(ws)
    out.postman.push({ file, tool: 'Insomnia', data: collection })
    for (const env of conv.environments(ws.environment)) out.postman.push({ file, tool: 'Insomnia', data: env })
  }
  out.name = parsed.map((w) => w.name).join(', ')
  if (templates.size) {
    warnings.push({
      source: out.name,
      message: `tags de template do Insomnia sem equivalente no VVPost ficaram como estão: ${[...templates].map((t) => `{% ${t} %}`).join(', ')}. Troque por {{VAR}} ou por um script pre.`
    })
  }
  return out
}

interface InsWorkspace {
  name: string
  description?: string
  children: InsNode[]
  environment?: InsEnvironment
}

// ---------------------------------------------------------------------------
// v4: lista plana de recursos ligados por parentId

function fromV4(data: Obj, file: string, warnings: ImportWarning[]): InsWorkspace[] {
  const resources = (data['resources'] as unknown[]).filter(isObject)
  const byParent = new Map<string, Obj[]>()
  for (const r of resources) {
    const parent = asString(r['parentId'])
    byParent.set(parent, [...(byParent.get(parent) ?? []), r])
  }
  const ignored = new Map<string, number>()
  const node = (r: Obj): InsNode | undefined => {
    const type = r['_type']
    if (type === 'request_group') {
      const n = baseNode('folder', r)
      n.environment = isObject(r['environment']) ? r['environment'] : undefined
      n.children = children(asString(r['_id']))
      return n
    }
    if (type === 'request') return requestNode(r)
    if (type === 'grpc_request' || type === 'websocket_request' || type === 'socketio_request') {
      ignored.set(String(type), (ignored.get(String(type)) ?? 0) + 1)
    }
    return undefined
  }
  const children = (parentId: string): InsNode[] =>
    (byParent.get(parentId) ?? [])
      .map(node)
      .filter((n): n is InsNode => !!n)
      .sort((a, b) => a.sortKey - b.sortKey)
  const environmentTree = (parentId: string): InsEnvironment | undefined => {
    const base = (byParent.get(parentId) ?? []).find((r) => r['_type'] === 'environment')
    if (!base) return undefined
    const subs = (byParent.get(asString(base['_id'])) ?? []).filter((r) => r['_type'] === 'environment')
    return { ...envOf(base), children: subs.map(envOf) }
  }
  let workspaces = resources.filter((r) => r['_type'] === 'workspace')
  if (!workspaces.length) {
    // Exportação de uma pasta só: a raiz é o que não tem pai conhecido.
    const ids = new Set(resources.map((r) => asString(r['_id'])))
    const roots = [...new Set(resources.map((r) => asString(r['parentId'])).filter((p) => !ids.has(p)))]
    workspaces = roots.map((id) => ({ _id: id, name: baseName(file) }))
  }
  const result = workspaces
    .map((w) => ({
      name: asString(w['name']).trim() || baseName(file),
      description: asString(w['description']).trim() || undefined,
      children: children(asString(w['_id'])),
      environment: environmentTree(asString(w['_id']))
    }))
    .filter((w) => w.children.length > 0)
  const label = result.map((w) => w.name).join(', ') || baseName(file)
  const specs = resources.filter((r) => r['_type'] === 'api_spec' && asString(r['contents']).trim()).length
  if (specs) warnings.push({ source: label, message: `${specs} documento(s) de design (spec OpenAPI) do Insomnia ficaram de fora: importe a spec pelo importador de OpenAPI.` })
  const tests = resources.filter((r) => r['_type'] === 'unit_test').length
  if (tests) warnings.push({ source: label, message: `${tests} teste(s) de unidade do Insomnia ficaram de fora: use os scripts post ou os cenários.` })
  for (const [type, n] of ignored) {
    warnings.push({ source: label, message: `${n} requisição(ões) ${type.replace('_request', '')} do Insomnia ficaram de fora: crie no Quick Request.` })
  }
  return result
}

function baseNode(kind: InsNode['kind'], r: Obj): InsNode {
  const meta = isObject(r['meta']) ? r['meta'] : {}
  const scripts = isObject(r['scripts']) ? r['scripts'] : {}
  return {
    kind,
    id: asString(r['_id'] ?? meta['id']),
    name: asString(r['name']).trim() || (kind === 'folder' ? 'Pasta' : 'Requisição'),
    description: (asString(r['description'] ?? meta['description']).trim() || undefined),
    sortKey: Number(r['metaSortKey'] ?? meta['sortKey'] ?? 0) || 0,
    children: [],
    headers: pairs(r['headers']),
    auth: isObject(r['authentication']) ? (r['authentication'] as InsAuth) : undefined,
    preRequest: asString(r['preRequestScript'] ?? scripts['preRequest']).trim() || undefined,
    afterResponse: asString(r['afterResponseScript'] ?? scripts['afterResponse']).trim() || undefined
  }
}

function requestNode(r: Obj): InsNode {
  const n = baseNode('request', r)
  n.url = asString(r['url'])
  n.method = asString(r['method']) || 'GET'
  n.body = isObject(r['body']) ? r['body'] : undefined
  n.parameters = pairs(r['parameters'])
  return n
}

function pairs(list: unknown): KeyValue[] {
  if (!Array.isArray(list)) return []
  return list
    .filter(isObject)
    .map((p) => ({
      key: asString(p['name']).trim(),
      value: asString(p['value']),
      disabled: p['disabled'] === true,
      ...(p['type'] === 'file' && { type: 'file', src: asString(p['fileName']) }),
      ...(asString(p['description']) && { description: asString(p['description']) })
    }))
    .filter((p) => p.key)
}

function envOf(r: Obj): InsEnvironment {
  return {
    name: asString(r['name']).trim() || 'Ambiente',
    data: isObject(r['data']) ? r['data'] : {},
    isPrivate: r['isPrivate'] === true,
    children: []
  }
}

// ---------------------------------------------------------------------------
// v5: árvore em YAML

function fromV5(data: Obj, warnings: ImportWarning[]): InsWorkspace[] {
  const name = asString(data['name']).trim() || 'Coleção do Insomnia'
  const items = Array.isArray(data['collection']) ? data['collection'].filter(isObject) : []
  let ignored = 0
  const node = (r: Obj): InsNode | undefined => {
    if (Array.isArray(r['children'])) {
      const n = baseNode('folder', r)
      n.environment = isObject(r['environment']) ? r['environment'] : undefined
      n.children = r['children'].filter(isObject).map(node).filter((x): x is InsNode => !!x)
      return n
    }
    if (typeof r['url'] !== 'string') return undefined
    if (/^wss?:/i.test(r['url']) || typeof r['protoMethodName'] === 'string') {
      ignored++
      return undefined
    }
    return requestNode(r)
  }
  const children = items.map(node).filter((x): x is InsNode => !!x)
  if (ignored) warnings.push({ source: name, message: `${ignored} requisição(ões) gRPC ou WebSocket do Insomnia ficaram de fora: crie no Quick Request.` })
  const envs = isObject(data['environments']) ? data['environments'] : undefined
  const environment = envs
    ? {
        ...envOf(envs),
        children: (Array.isArray(envs['subEnvironments']) ? envs['subEnvironments'] : []).filter(isObject).map(envOf)
      }
    : undefined
  const meta = isObject(data['meta']) ? data['meta'] : {}
  return children.length ? [{ name, description: asString(meta['description']).trim() || undefined, children, environment }] : []
}

// ---------------------------------------------------------------------------
// Para a coleção v2.1

const TAG = /\{%\s*([\s\S]*?)\s*%\}/g

class Converter {
  /** Variáveis das pastas, que entram nas da coleção. */
  private folderVars = new Map<string, unknown>()

  constructor(
    private readonly name: string,
    private readonly warnings: ImportWarning[],
    private readonly templates: Set<string>
  ) {}

  private warn(source: string, message: string) {
    this.warnings.push({ source, message })
  }

  /** Templates do Insomnia (Nunjucks) para `{{x}}`. */
  text(value: string): string {
    return value
      .replace(/\{\{\s*_\.([\w$.-]+)\s*\}\}/g, '{{$1}}')
      .replace(/\{\{\s*_\[\s*(['"])(.+?)\1\s*\]\s*\}\}/g, '{{$2}}')
      .replace(TAG, (m, body: string) => {
        const [tag = '', ...args] = body.split(/\s+/)
        const arg = args.join(' ').replace(/['"]/g, '')
        if (tag === 'uuid') return '{{$uuid}}'
        if (tag === 'now' && /iso/i.test(arg)) return '{{$isoTimestamp}}'
        if (tag === 'now' && (!arg || /unix/i.test(arg))) return '{{$timestamp}}'
        this.templates.add(tag)
        return m
      })
  }

  collection(ws: InsWorkspace): Obj {
    const items = ws.children.map((c) => this.item(c, ws.name)).filter((x): x is Obj => !!x)
    const variable: KeyValue[] = [...this.folderVars].map(([key, value]) => ({ key, value: asString(value) }))
    return {
      info: {
        name: ws.name,
        ...(ws.description && { description: ws.description }),
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      item: items,
      ...(variable.length && { variable })
    }
  }

  private item(node: InsNode, parentTrail: string): Obj | undefined {
    const trail = `${parentTrail} › ${node.name}`
    const auth = this.auth(node.auth, trail)
    const event = this.events(node)
    if (node.kind === 'folder') {
      for (const [key, value] of flatten(node.environment ?? {})) {
        if (this.folderVars.has(key) && this.folderVars.get(key) !== value) {
          this.warn(trail, `a variável "${key}" da pasta tem outro valor em outra pasta; no VVPost as variáveis são do ambiente, ficou a primeira.`)
          continue
        }
        this.folderVars.set(key, value)
      }
      if (node.headers.some((h) => !h.disabled)) {
        this.warn(trail, 'os headers da pasta foram copiados para cada requisição dela.')
        for (const child of node.children) inheritHeaders(child, node.headers)
      }
      return {
        name: node.name,
        ...(node.description && { description: node.description }),
        item: node.children.map((c) => this.item(c, trail)).filter((x): x is Obj => !!x),
        ...(auth && { auth }),
        ...(event.length && { event })
      }
    }
    const headers = node.headers.map((h) => ({ ...h, key: h.key, value: this.text(h.value) }))
    const body = this.body(node.body, headers, trail)
    const query = (node.parameters ?? []).map((p) => ({ ...p, value: this.text(p.value) }))
    return {
      name: node.name,
      request: {
        method: (node.method ?? 'GET').toUpperCase(),
        url: postmanUrl(this.text(node.url ?? ''), query),
        header: headers,
        ...(body && { body }),
        ...(auth && { auth }),
        ...(node.description && { description: node.description })
      },
      ...(event.length && { event })
    }
  }

  private events(node: InsNode): Obj[] {
    const script = (code: string) => code.replace(/\binsomnia\./g, 'pm.')
    return [
      ...(node.preRequest ? [{ listen: 'prerequest', script: { exec: script(node.preRequest) } }] : []),
      ...(node.afterResponse ? [{ listen: 'test', script: { exec: script(node.afterResponse) } }] : [])
    ]
  }

  private body(body: Obj | undefined, headers: KeyValue[], trail: string): Obj | undefined {
    if (!body) return undefined
    const mime = asString(body['mimeType']).toLowerCase()
    const params = pairs(body['params']).map((p) => ({ ...p, value: this.text(p.value) }))
    if (/x-www-form-urlencoded/.test(mime)) return { mode: 'urlencoded', urlencoded: params }
    if (/multipart\/form-data/.test(mime)) return { mode: 'formdata', formdata: params }
    if (/graphql/.test(mime)) {
      try {
        const parsed = JSON.parse(asString(body['text'])) as { query?: string; variables?: unknown }
        return {
          mode: 'graphql',
          graphql: { query: this.text(parsed.query ?? ''), variables: parsed.variables ? this.text(JSON.stringify(parsed.variables)) : '' }
        }
      } catch {
        this.warn(trail, 'corpo GraphQL do Insomnia ilegível; ficou como texto.')
      }
    }
    if (typeof body['fileName'] === 'string' && body['fileName']) return { mode: 'file', file: { src: body['fileName'] } }
    const text = asString(body['text'])
    if (!text.trim()) return undefined
    if (needsContentType(mime) && !hasHeader(headers, 'content-type')) headers.push({ key: 'Content-Type', value: mime })
    return rawBody(this.text(text), mime)
  }

  private auth(auth: InsAuth | undefined, trail: string): Obj | undefined {
    if (!auth || !auth.type || auth.disabled) return undefined
    const t = (k: string) => this.text(asString(auth[k]))
    switch (auth.type) {
      case 'none':
        return { type: 'noauth' }
      case 'inherit':
        return undefined
      case 'bearer': {
        const prefix = t('prefix').trim()
        return prefix && prefix.toLowerCase() !== 'bearer'
          ? postmanAuth('apikey', { key: 'Authorization', value: `${prefix} ${t('token')}`, in: 'header' })
          : postmanAuth('bearer', { token: t('token') })
      }
      case 'basic':
        return postmanAuth('basic', { username: t('username'), password: t('password') })
      case 'apikey':
        if (auth['addTo'] === 'cookie') {
          this.warn(trail, 'API key em cookie virou header Cookie.')
          return postmanAuth('apikey', { key: 'Cookie', value: `${t('key')}=${t('value')}`, in: 'header' })
        }
        return postmanAuth('apikey', { key: t('key'), value: t('value'), in: auth['addTo'] === 'queryParams' ? 'query' : 'header' })
      case 'digest':
        return postmanAuth('digest', { username: t('username'), password: t('password') })
      case 'ntlm': {
        const [domain, user] = t('username').includes('\\') ? t('username').split('\\', 2) : ['', t('username')]
        return postmanAuth('ntlm', { username: user, password: t('password'), domain })
      }
      case 'iam':
        return postmanAuth('awsv4', {
          accessKey: t('accessKeyId'),
          secretKey: t('secretAccessKey'),
          sessionToken: t('sessionToken'),
          region: t('region'),
          service: t('service')
        })
      case 'oauth1':
        return postmanAuth('oauth1', {
          consumerKey: t('consumerKey'),
          consumerSecret: t('consumerSecret'),
          token: t('tokenKey'),
          tokenSecret: t('tokenSecret'),
          signatureMethod: t('signatureMethod'),
          realm: t('realm')
        })
      case 'oauth2': {
        const grant = asString(auth['grantType'])
        return postmanAuth('oauth2', {
          grant_type: grant === 'password' ? 'password_credentials' : grant,
          accessTokenUrl: t('accessTokenUrl'),
          clientId: t('clientId'),
          clientSecret: t('clientSecret'),
          scope: t('scope'),
          username: t('username'),
          password: t('password'),
          client_authentication: auth['credentialsInBody'] === true ? 'body' : 'header',
          accessToken: t('accessToken')
        })
      }
      default:
        this.warn(trail, `autenticação "${auth.type}" do Insomnia não é suportada e foi ignorada.`)
        return undefined
    }
  }

  /** O ambiente base e cada subambiente (com o base por baixo) viram ambientes do Postman. */
  environments(env: InsEnvironment | undefined): Obj[] {
    if (!env) return []
    const values = (e: InsEnvironment, base: Map<string, unknown> = new Map()) => {
      const own = new Map(flatten(e.data))
      return [...new Map([...base, ...own])].map(([key, value]) => ({
        key,
        value: typeof value === 'string' ? this.text(value) : value,
        // Ambiente privado do Insomnia não é sincronizado: o que ele define é tratado como segredo.
        ...(e.isPrivate && own.has(key) && { type: 'secret' }),
        enabled: true
      }))
    }
    const base = new Map(flatten(env.data))
    if (!env.children.length) return base.size ? [{ name: `${this.name} (${env.name})`, values: values(env) }] : []
    return env.children.map((sub) => ({ name: `${this.name} (${sub.name})`, values: values(sub, base) }))
  }
}

/** Headers da pasta valem para as requisições dela (o Insomnia herda; o VVPost guarda no endpoint). */
function inheritHeaders(node: InsNode, headers: KeyValue[]) {
  for (const h of headers) {
    if (h.disabled || node.headers.some((x) => x.key.toLowerCase() === h.key.toLowerCase())) continue
    node.headers.push(h)
  }
}

/** `{ a: { b: 1 } }` vira `a.b = 1`, como o Insomnia referencia (`{{ _.a.b }}`). */
function flatten(data: Obj, prefix = ''): [string, unknown][] {
  return Object.entries(data).flatMap(([k, v]): [string, unknown][] =>
    isObject(v) && Object.keys(v).length ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, Array.isArray(v) || isObject(v) ? JSON.stringify(v) : v]]
  )
}
