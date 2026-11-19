import type {
  Connector,
  ConnectorAuth,
  ConnectorConfig,
  Endpoint,
  Environment,
  EnvironmentVariable,
  HttpMethod,
  PayloadFormField,
  RequestPayload,
  RequestScripts,
  ResponseExample,
  Scenario
} from '@vvpost/schemas'
import { SECRET_PLACEHOLDER, SENSITIVE_HEADERS } from '@vvpost/core/secrets'
import { translatePmScript } from './pm-scripts'

/**
 * Importador de coleções Postman v2.0/v2.1 e de ambientes Postman (spec item 12).
 *
 * Cada coleção vira um conector raiz com a URL base e a autenticação da coleção;
 * cada pasta vira um conector filho que herda do pai (`extends`), então a
 * autenticação e os headers continuam em cascata como no Postman. Variáveis da
 * coleção e ambientes viram arquivos de ambiente. Todo valor que parece segredo
 * (pelo nome, pelo tipo "secret" do Postman, por ser usado em autenticação ou pelo
 * formato) sai do arquivo versionado como __REQUIRED_SECRET__, e o valor real
 * volta em `secrets` para ir só ao cofre local. Scripts de pre-request e de
 * teste viram scripts pre e post (fase 13), com o `pm.*` traduzido para a API `vv`.
 *
 * Módulo puro (sem Electron nem disco): recebe o JSON já lido e devolve os documentos.
 */

export interface PostmanSource {
  /** Nome do arquivo de origem, usado nos avisos. */
  file: string
  data: unknown
  /**
   * Ferramenta de onde a coleção veio, nos textos da revisão. Os importadores de Insomnia,
   * Bruno, HAR e WSDL montam uma coleção v2.1 e passam por aqui. Padrão: "Postman".
   */
  tool?: string
}

export interface ImportWarning {
  /** Onde está o problema, ex.: "Billing › Pagamentos › Criar cobrança". */
  source: string
  message: string
}

export interface ImportedSecret {
  environmentId: string
  variable: string
  value: string
}

export interface PostmanImportResult {
  sources: { file: string; kind: 'collection' | 'environment'; name: string }[]
  connectors: Connector[]
  environments: Environment[]
  /** Valores reais dos segredos. Nunca vão para arquivo versionado nem para o renderer. */
  secrets: ImportedSecret[]
  warnings: ImportWarning[]
  /** Arquivos que não puderam ser importados. */
  errors: { file: string; message: string }[]
}

// ---------------------------------------------------------------------------
// Formato do Postman (só o que o importador lê; o resto é ignorado)

type PmDescription = string | { content?: string } | null | undefined

interface PmKeyValue {
  key?: string | null
  value?: unknown
  type?: string
  disabled?: boolean
  enabled?: boolean
  src?: unknown
  contentType?: unknown
}

/** src do Postman: um caminho, ou uma lista (só o primeiro arquivo vai). */
function fileSrc(src: unknown): string | undefined {
  const first = Array.isArray(src) ? src[0] : src
  return typeof first === 'string' && first.trim() ? first.trim() : undefined
}

interface PmAuth {
  type?: string
  [param: string]: unknown
}

interface PmUrl {
  raw?: string
  protocol?: string
  host?: string | string[]
  port?: string
  path?: string | (string | { value?: string })[]
  query?: PmKeyValue[]
}

interface PmBody {
  mode?: string
  disabled?: boolean
  raw?: string
  urlencoded?: PmKeyValue[]
  formdata?: PmKeyValue[]
  file?: { src?: unknown }
  graphql?: { query?: string; variables?: string }
  options?: { raw?: { language?: string } }
}

interface PmRequest {
  method?: string
  url?: string | PmUrl
  header?: PmKeyValue[] | string
  body?: PmBody | null
  auth?: PmAuth | null
  description?: PmDescription
}

interface PmEvent {
  listen?: string
  disabled?: boolean
  script?: { exec?: string | string[] }
}

interface PmResponse {
  name?: string
  code?: number
  status?: string
  header?: PmKeyValue[] | null
  body?: string | null
}

interface PmItem {
  name?: string
  description?: PmDescription
  item?: PmItem[]
  request?: PmRequest | string
  /** Exemplos salvos da requisição. */
  response?: PmResponse[]
  auth?: PmAuth | null
  event?: PmEvent[]
}

interface PmCollection {
  info: { name?: string; description?: PmDescription; version?: unknown; schema?: string }
  item?: PmItem[]
  auth?: PmAuth | null
  variable?: PmKeyValue[]
  event?: PmEvent[]
}

interface PmEnvironment {
  name?: string
  values: PmKeyValue[]
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function detect(data: unknown): 'collection' | 'environment' | string {
  if (!isObject(data)) return 'o arquivo não contém um objeto JSON'
  const info = data['info']
  if (isObject(info)) {
    const schema = typeof info['schema'] === 'string' ? info['schema'] : ''
    if (/collection\/v1/.test(schema)) return 'coleção Postman v1 não é suportada; exporte como v2.1'
    if (Array.isArray(data['item'])) return 'collection'
  }
  if (Array.isArray(data['requests']) && Array.isArray(data['order'])) {
    return 'coleção Postman v1 não é suportada; exporte como v2.1'
  }
  if (Array.isArray(data['values'])) return 'environment'
  return 'não parece uma coleção (v2.0/v2.1) nem um ambiente do Postman'
}

// ---------------------------------------------------------------------------
// Nomes, ids e detecção de segredos

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

/** "Serviço de Cobrança" -> "servico-de-cobranca" (formato de id de conector). */
export function slug(s: string, sep = '-'): string {
  return stripAccents(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, sep)
    .replace(new RegExp(`^\\${sep}+|\\${sep}+$`, 'g'), '')
}

export class UniqueIds {
  private used: Set<string>
  constructor(used: Iterable<string> = []) {
    this.used = new Set(used)
  }
  take(base: string, sep: string): string {
    let id = base
    for (let n = 2; this.used.has(id); n++) id = `${base}${sep}${n}`
    this.used.add(id)
    return id
  }
}

/** Quebra um nome em palavras: "x-api-key" -> [x, api, key], "accessTokenUrl" -> [access, token, url]. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

const SECRET_WORDS = new Set([
  'secret',
  'password',
  'passwd',
  'pwd',
  'pass',
  'passphrase',
  'token',
  'credential',
  'credentials',
  'cookie',
  'signature',
  'apikey',
  'bearer',
  'jwt',
  'authorization'
])
// "key" sozinho é vago (partitionKey, idempotencyKey): só conta depois destas palavras.
const KEY_QUALIFIERS = new Set([
  'api',
  'access',
  'private',
  'subscription',
  'secret',
  'client',
  'signing',
  'master',
  'app',
  'auth'
])
// Termina com isto: é metadado do segredo, não o segredo (tokenUrl, token_type, passwordExpiry).
const NOT_SECRET_LAST_WORD = new Set([
  'url',
  'uri',
  'host',
  'endpoint',
  'domain',
  'path',
  'type',
  'header',
  'expiry',
  'expires',
  'expiration',
  'ttl',
  'timeout',
  'name',
  'id',
  'length',
  'size',
  'count',
  'enabled',
  'scope',
  'realm',
  'prefix'
])

export function isSecretName(name: string): boolean {
  const w = words(name)
  if (w.length === 0 || NOT_SECRET_LAST_WORD.has(w.at(-1)!)) return false
  return w.some(
    (word, i) =>
      SECRET_WORDS.has(word) ||
      (word === 'key' && i > 0 && KEY_QUALIFIERS.has(w[i - 1]!)) ||
      (word === 'auth' && w.length === 1)
  )
}

const SECRET_VALUE_PATTERNS = [
  /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/, // JWT
  /^(sk|rk)_(live|test)_\w{8,}/, // Stripe
  /^gh[pousr]_[A-Za-z0-9]{20,}$/, // GitHub
  /^github_pat_\w{20,}$/,
  /^AKIA[0-9A-Z]{16}$/, // AWS access key id
  /^xox[abprs]-[\w-]{10,}$/, // Slack
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----/
]

export function looksLikeSecretValue(value: unknown): boolean {
  return typeof value === 'string' && SECRET_VALUE_PATTERNS.some((re) => re.test(value.trim()))
}

// ---------------------------------------------------------------------------
// Variáveis {{nome}}

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g

/** Variáveis dinâmicas do Postman com equivalente no VVPost. */
const DYNAMIC_ALIASES: Record<string, string> = { $guid: '$uuid', $randomUUID: '$uuid' }
/** As que o VVPost já entende com o mesmo nome. */
const DYNAMIC_NATIVE = new Set(['$uuid', '$timestamp', '$isoTimestamp', '$randomInt'])

interface VarInfo {
  name: string
  secret: boolean
  /** Definida na coleção ou em algum ambiente importado. */
  defined: boolean
  used: boolean
  description?: string
}

/**
 * Registro de variáveis compartilhado pelo import inteiro, para que coleção e
 * ambientes usem o mesmo nome. O schema de ambiente só aceita [A-Za-z_][A-Za-z0-9_]*:
 * "base-url" vira "base_url" e todas as referências {{base-url}} são reescritas.
 */
class Variables {
  private byOriginal = new Map<string, VarInfo>()
  private taken = new UniqueIds()
  readonly unknownDynamic = new Set<string>()

  get(original: string): VarInfo {
    let info = this.byOriginal.get(original)
    if (!info) {
      let base = original.replace(/[^A-Za-z0-9_]/g, '_')
      if (!/^[A-Za-z_]/.test(base)) base = `_${base}`
      info = { name: this.taken.take(base, '_'), secret: isSecretName(original), defined: false, used: false }
      this.byOriginal.set(original, info)
    }
    return info
  }

  /** Cria uma variável nova para um segredo literal achado na coleção. */
  fresh(base: string): VarInfo {
    const name = this.taken.take(base, '_')
    const info: VarInfo = { name, secret: true, defined: true, used: true }
    this.byOriginal.set(`\0${name}`, info)
    return info
  }

  all(): VarInfo[] {
    return [...this.byOriginal.values()]
  }

  /** Reescreve as referências {{x}} de um texto e devolve as variáveis usadas. */
  rewrite(text: string, used?: VarInfo[]): string {
    return text.replace(TEMPLATE, (_m, raw: string) => {
      if (raw.startsWith('$')) {
        const alias = DYNAMIC_ALIASES[raw]
        if (!alias && !DYNAMIC_NATIVE.has(raw)) this.unknownDynamic.add(raw)
        return `{{${alias ?? raw}}}`
      }
      const info = this.get(raw)
      info.used = true
      used?.push(info)
      return `{{${info.name}}}`
    })
  }

  /** Marca como segredo as variáveis citadas num texto, sem contá-las como usadas. */
  markSecret(text: string): void {
    for (const m of text.matchAll(TEMPLATE)) if (!m[1]!.startsWith('$')) this.get(m[1]!).secret = true
  }

  /** Reescreve strings (chaves e valores) dentro de um JSON já parseado. */
  rewriteDeep(value: unknown): unknown {
    if (typeof value === 'string') return this.rewrite(value)
    if (Array.isArray(value)) return value.map((v) => this.rewriteDeep(v))
    if (isObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [this.rewrite(k), this.rewriteDeep(v)]))
    }
    return value
  }
}

const hasTemplate = (s: string): boolean => /\{\{[^{}]+\}\}/.test(s)

// ---------------------------------------------------------------------------
// Conversão de uma coleção

const METHODS = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

function text(d: PmDescription): string | undefined {
  const s = typeof d === 'string' ? d : d?.content
  return s?.trim() || undefined
}

function semver(v: unknown): string {
  if (
    typeof v === 'string' &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(v)
  ) {
    return v
  }
  if (
    isObject(v) &&
    [v['major'], v['minor'], v['patch']].every((n) => Number.isInteger(n) && (n as number) >= 0)
  ) {
    return `${v['major']}.${v['minor']}.${v['patch']}`
  }
  return '1.0.0'
}

/** Parâmetros de auth: v2.1 usa [{ key, value }], v2.0 usa { chave: valor }. */
function authParams(auth: PmAuth, type: string): Record<string, unknown> {
  const raw = auth[type]
  if (Array.isArray(raw)) {
    return Object.fromEntries(
      (raw as PmKeyValue[]).filter((p) => typeof p?.key === 'string').map((p) => [p.key as string, p.value])
    )
  }
  return isObject(raw) ? raw : {}
}

const str = (v: unknown): string =>
  v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v)

interface Credentials {
  headers: Record<string, string>
  query: Record<string, string>
  /** Auth que o VVPost executa no conector (Digest, AWS SigV4, NTLM, OAuth 1.0, OAuth2 com token endpoint). */
  auth?: ConnectorAuth
}

interface Draft {
  endpoint: Endpoint
  origin: string
  /** Auth própria que o endpoint não guarda: vai para um conector auxiliar, filho do da pasta. */
  auth?: ConnectorAuth
}

interface Node {
  name: string
  description?: string
  id: string
  /** Caminho legível para os avisos. */
  trail: string
  credentials: Credentials
  /** Algum ancestral (ou o próprio nó) define autenticação. */
  hasAuth: boolean
  drafts: Draft[]
  children: Node[]
  baseUrl?: string
  /** Scripts da coleção ou da pasta, que viram `config.scripts` do conector. */
  scripts?: RequestScripts
}

interface ParsedUrl {
  origin: string
  path: string
  query: Record<string, string>
}

class CollectionConverter {
  readonly secrets: { variable: VarInfo; value: string }[] = []
  /** Segredos sem valor conhecido, que o usuário precisa preencher. */
  readonly required: VarInfo[] = []
  private literalSecrets = new Map<string, VarInfo>()
  private scriptCount = 0
  private untranslated = 0
  private version = '1.0.0'
  private statusAssertions = 0

  private examples = 0

  constructor(
    private readonly vars: Variables,
    private readonly connectorIds: UniqueIds,
    private readonly warn: (source: string, message: string) => void,
    readonly tool = 'Postman'
  ) {}

  convert(collection: PmCollection): Connector[] {
    const name = collection.info.name?.trim() || 'Coleção sem nome'
    for (const v of collection.variable ?? []) {
      if (typeof v?.key !== 'string' || !v.key || v.disabled) continue
      const info = this.vars.get(v.key)
      info.defined = true
      if (v.type === 'secret' || looksLikeSecretValue(v.value)) info.secret = true
      info.description ??= text((v as { description?: PmDescription }).description)
    }

    this.version = semver(collection.info.version)
    const credentials = this.auth(collection.auth, name, false)
    const root: Node = {
      name,
      description: text(collection.info.description),
      id: this.connectorIds.take(`connector.${slug(name) || 'collection'}`, '-'),
      trail: name,
      credentials,
      hasAuth: hasCredentials(credentials),
      drafts: [],
      children: []
    }
    root.scripts = this.scriptsOf(this.countScripts(collection.event), name)
    this.walk(collection.item ?? [], root, root.credentials.query)

    if (this.scriptCount > 0) {
      const translated = this.scriptCount - this.untranslated
      this.warn(
        name,
        `${this.scriptCount} script(s) de pre-request/test viraram scripts pre e post com o pm.* traduzido para a API vv` +
          (this.untranslated ? ` (${this.untranslated} com partes sem equivalente, avisadas acima)` : '') +
          (translated && this.statusAssertions
            ? `; ${this.statusAssertions} verificação(ões) de status viraram também cenários de teste, para rodarem na matriz.`
            : '.')
      )
    }
    if (this.examples > 0) {
      this.warn(name, `${this.examples} resposta(s) salva(s) viraram exemplos dos endpoints, para a documentação e o mock server.`)
    }

    const origins = this.collectOrigins(root)
    root.baseUrl = mostCommon(origins)
    if (!root.baseUrl && countDrafts(root) > 0) {
      this.warn(name, 'nenhuma requisição tem URL absoluta; defina config.baseUrl no conector antes de usar.')
    }
    const connectors: Connector[] = []
    this.emit(root, undefined, root.baseUrl, connectors)
    return connectors
  }

  private countScripts(events: PmEvent[] | undefined): PmEvent[] {
    const active = (events ?? []).filter((e) => !e?.disabled && scriptOf(e).trim())
    this.scriptCount += active.length
    return active
  }

  /**
   * Os eventos `prerequest` e `test` como scripts pre e post, com o `pm.*` traduzido. Nomes de
   * variável seguem a mesma troca dos {{x}}, e um valor com cara de segredo passado a
   * `vv.variables.set` vai para o vault como os da coleção.
   */
  private scriptsOf(events: PmEvent[], trail: string): RequestScripts | undefined {
    const out: RequestScripts = {}
    for (const [listen, phase] of [['prerequest', 'pre'], ['test', 'post']] as const) {
      const sources = events.filter((e) => e.listen === listen).map(scriptOf)
      if (!sources.length) continue
      const { code, unsupported } = translatePmScript(sources.join('\n'))
      if (unsupported.length) {
        this.untranslated++
        this.warn(
          trail,
          `script ${phase === 'pre' ? 'de pre-request' : 'de teste'} usa ${unsupported.join(', ')} sem equivalente no VVPost; ` +
            'ficou no script como está e vai falhar ao rodar até ser reescrito.'
        )
      }
      out[phase] = this.scriptValues(code)
    }
    return out.pre || out.post ? out : undefined
  }

  private scriptValues(code: string): string {
    // Um valor fixo com cara de segredo não fica no arquivo: vai para o vault como variável do ambiente.
    const secured = code.replace(
      /\bvv\.variables\.set\(\s*(['"])([^'"\\]+)\1\s*,\s*(['"])([^'"\\]*)\3\s*\);?/g,
      (m, _q: string, name: string, _q2: string, value: string) => {
        if (!value || hasTemplate(value) || !(isSecretName(name) || looksLikeSecretValue(value))) return m
        const info = this.vars.get(name)
        info.secret = info.used = info.defined = true
        info.description ??= `Valor fixo de um script do ${this.tool}, movido para o vault.`
        if (!this.secrets.some((x) => x.variable === info)) this.secrets.push({ variable: info, value })
        return `/* ${info.name}: valor fixo movido para o vault do ambiente */`
      }
    )
    const named = secured.replace(
      /(\bvv\.variables\.(?:get|set|unset|has)\(\s*)(['"])([^'"\\]+)\2/g,
      (_m, call: string, quote: string, name: string) =>
        `${call}${quote}${/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : this.vars.get(name).name}${quote}`
    )
    return this.vars.rewrite(named)
  }

  private walk(items: PmItem[], parent: Node, inheritedQuery: Record<string, string>): void {
    const endpointIds = new UniqueIds()
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const itemName = item.name?.trim() || 'Sem nome'
      const trail = `${parent.trail} › ${itemName}`
      if (Array.isArray(item.item)) {
        if (item.item.length === 0) {
          this.warn(trail, 'pasta vazia ignorada.')
          continue
        }
        const credentials = this.auth(item.auth, trail, parent.hasAuth)
        const scripts = this.scriptsOf(this.countScripts(item.event), trail)
        const child: Node = {
          name: itemName,
          description: text(item.description),
          id: this.connectorIds.take(`${parent.id}.${slug(itemName) || 'folder'}`, '-'),
          trail,
          credentials,
          hasAuth: parent.hasAuth || hasCredentials(credentials),
          drafts: [],
          children: [],
          ...(scripts && { scripts })
        }
        parent.children.push(child)
        this.walk(item.item, child, { ...inheritedQuery, ...credentials.query })
      } else if (item.request !== undefined) {
        const draft = this.request(item, itemName, trail, endpointIds, parent.hasAuth, inheritedQuery)
        if (draft) parent.drafts.push(draft)
      }
    }
  }

  private request(
    item: PmItem,
    name: string,
    trail: string,
    ids: UniqueIds,
    inheritsAuth: boolean,
    inheritedQuery: Record<string, string>
  ): Draft | undefined {
    const req: PmRequest = typeof item.request === 'string' ? { url: item.request } : (item.request ?? {})
    const method = (req.method ?? 'GET').toUpperCase() as HttpMethod
    if (!METHODS.has(method)) {
      this.warn(trail, `método ${method} não é suportado; requisição ignorada.`)
      return undefined
    }
    const url = this.url(req.url, trail)
    if (!url) return undefined

    const endpoint: Endpoint = {
      id: ids.take(slug(name, '_') || `${method.toLowerCase()}_request`, '_'),
      name,
      method,
      path: url.path
    }
    const description = text(req.description) ?? text(item.description)
    if (description) endpoint.description = description

    const headers: Record<string, string> = {}
    for (const h of this.headerList(req.header)) {
      const headerName = h.key!.trim()
      if (!HEADER_NAME.test(headerName)) {
        this.warn(trail, `cabeçalho com nome inválido "${headerName}" ignorado.`)
        continue
      }
      if (headerName in headers) this.warn(trail, `cabeçalho "${headerName}" repetido; ficou o último valor.`)
      headers[headerName] = this.sensitive(
        headerName,
        str(h.value),
        SENSITIVE_HEADERS.has(headerName.toLowerCase())
      )
    }

    const query: Record<string, string> = { ...url.query }
    const explicitAuth = isObject(req.auth) && !!req.auth.type && req.auth.type !== 'inherit'
    const own = explicitAuth ? this.auth(req.auth, trail, inheritsAuth) : undefined
    if (own) {
      Object.assign(headers, own.headers)
      Object.assign(query, own.query)
    } else {
      // apikey "in query" de conector: o conector não tem query, então vai para cada endpoint.
      for (const [k, v] of Object.entries(inheritedQuery)) query[k] ??= v
    }
    if (Object.keys(query).length) endpoint.query = query

    const body = this.body(req.body, trail)
    if (body.value !== undefined) endpoint.body = body.value
    if (body.payload) {
      endpoint.payload = body.payload
      // O multipart precisa do boundary que o VVPost gera: um Content-Type fixo quebraria o corpo.
      if (body.payload.mode === 'multipart') {
        for (const name of Object.keys(headers)) {
          if (name.toLowerCase() === 'content-type' && /^multipart\/form-data/i.test(headers[name]!)) delete headers[name]
        }
      }
    } else if (body.contentType && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = body.contentType
    }
    if (Object.keys(headers).length) endpoint.headers = headers

    const events = this.countScripts(item.event)
    const scripts = this.scriptsOf(events, trail)
    if (scripts) endpoint.scripts = scripts
    const scenarios = this.scenarios(events)
    if (scenarios.length) endpoint.scenarios = scenarios
    const examples = this.responseExamples(item.response, trail)
    if (examples.length) endpoint.examples = examples
    return { endpoint, origin: url.origin, ...(own?.auth && { auth: own.auth }) }
  }

  private headerList(header: PmRequest['header']): PmKeyValue[] {
    const list: PmKeyValue[] =
      typeof header === 'string'
        ? header
            .split(/\r?\n/)
            .map((line) => line.match(/^\s*([^:]+?)\s*:\s*(.*)$/))
            .filter((m): m is RegExpMatchArray => !!m)
            .map((m) => ({ key: m[1], value: m[2] }))
        : (header ?? [])
    return list.filter((h) => isObject(h) && typeof h.key === 'string' && h.key.trim() && !h.disabled)
  }

  private url(input: PmRequest['url'], trail: string): ParsedUrl | undefined {
    let raw: string
    let structuredQuery: PmKeyValue[] | undefined
    if (typeof input === 'string') raw = input
    else if (input && typeof input === 'object') {
      structuredQuery = Array.isArray(input.query) ? input.query : undefined
      raw = typeof input.raw === 'string' ? input.raw : rebuildUrl(input)
    } else raw = ''
    raw = raw.trim()
    if (!raw) {
      this.warn(trail, 'requisição sem URL ignorada.')
      return undefined
    }

    const [beforeHash] = raw.split('#') as [string]
    const q = beforeHash.indexOf('?')
    const base = q === -1 ? beforeHash : beforeHash.slice(0, q)
    const qs = q === -1 ? '' : beforeHash.slice(q + 1)
    const m = base.match(/^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/]*)(.*)$/i)!
    const protocol = m[1]?.toLowerCase()
    const host = m[2] ?? ''
    if (protocol && protocol !== 'http' && protocol !== 'https') {
      this.warn(trail, `protocolo ${protocol}:// não é suportado; requisição ignorada.`)
      return undefined
    }
    // Sem protocolo: "{{baseUrl}}" fica como está; um host literal ganha http://, como no Postman.
    const origin = !host
      ? ''
      : protocol
        ? `${protocol}://${host}`
        : host.startsWith('{{')
          ? host
          : `http://${host}`

    const path = this.vars
      .rewrite(m[3] || '/')
      // Parâmetro de rota do Postman (:id) vira {id}.
      .replace(/(^|\/):([A-Za-z_][A-Za-z0-9_]*)(?=\/|$)/g, '$1{$2}')

    const query: Record<string, string> = {}
    const pairs: PmKeyValue[] =
      structuredQuery ??
      qs
        .split('&')
        .filter(Boolean)
        .map((pair) => {
          const eq = pair.indexOf('=')
          return eq === -1
            ? { key: decode(pair), value: '' }
            : { key: decode(pair.slice(0, eq)), value: decode(pair.slice(eq + 1)) }
        })
    for (const p of pairs) {
      if (!isObject(p) || typeof p.key !== 'string' || !p.key || p.disabled) continue
      const key = this.vars.rewrite(p.key)
      if (key in query) this.warn(trail, `parâmetro de query "${key}" repetido; ficou o último valor.`)
      query[key] = this.sensitive(key, str(p.value), isSecretName(p.key))
    }

    return { origin: this.vars.rewrite(origin), path: path.startsWith('/') ? path : `/${path}`, query }
  }

  /**
   * Reescreve as variáveis de um valor e, se ele for sensível, garante que nenhum
   * segredo literal fique no conector: um valor fixo vira variável secreta nova,
   * e variáveis referenciadas passam a ser tratadas como segredo.
   */
  private sensitive(label: string, value: string, isSensitive: boolean): string {
    const used: VarInfo[] = []
    const rewritten = this.vars.rewrite(value, used)
    if (!isSensitive && !looksLikeSecretValue(value)) return rewritten
    for (const v of used) v.secret = true
    if (used.length || !value.trim()) return rewritten
    // "Bearer abc" mantém o esquema e só o token vira variável.
    const scheme = value.match(/^(Bearer|Basic|Token|Digest|ApiKey)\s+(.+)$/i)
    return scheme
      ? `${scheme[1]} ${this.literalSecret(`${scheme[1]}_TOKEN`, scheme[2]!)}`
      : this.literalSecret(label, value)
  }

  private literalSecret(label: string, value: string): string {
    let info = this.literalSecrets.get(value)
    if (!info) {
      const base =
        label
          .replace(/[^A-Za-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .toUpperCase() || 'SECRET'
      info = this.vars.fresh(/^[A-Z_]/.test(base) ? base : `_${base}`)
      this.literalSecrets.set(value, info)
      this.secrets.push({ variable: info, value })
    }
    return `{{${info.name}}}`
  }

  /** Credencial requerida e sem valor conhecido (ex.: basic auth montado de variáveis). */
  private requiredSecret(base: string, description: string): string {
    const info = this.vars.fresh(base)
    info.description = description
    this.required.push(info)
    return `{{${info.name}}}`
  }

  private auth(auth: PmAuth | null | undefined, trail: string, inheritsAuth: boolean): Credentials {
    if (!isObject(auth) || !auth.type || auth.type === 'inherit') return { headers: {}, query: {} }
    const type = auth.type
    const p = authParams(auth, type)
    const secret = (label: string, v: unknown) => this.sensitive(label, str(v), true)
    switch (type) {
      case 'noauth':
        if (inheritsAuth) {
          this.warn(
            trail,
            `no ${this.tool} este item não usa autenticação, mas aqui herda a do conector pai. Para testar sem auth, use um cenário com headers: null.`
          )
        }
        return { headers: {}, query: {} }
      case 'bearer':
        return { headers: { Authorization: `Bearer ${secret('BEARER_TOKEN', p['token'])}` }, query: {} }
      case 'basic': {
        const user = str(p['username'])
        const pass = str(p['password'])
        if (hasTemplate(user) || hasTemplate(pass)) {
          this.vars.markSecret(pass)
          this.warn(
            trail,
            'basic auth montado a partir de variáveis: preencha BASIC_CREDENTIALS com base64 de "usuário:senha".'
          )
          return {
            headers: {
              Authorization: `Basic ${this.requiredSecret('BASIC_CREDENTIALS', 'base64 de "usuário:senha"')}`
            },
            query: {}
          }
        }
        const encoded = Buffer.from(`${user}:${pass}`).toString('base64')
        return {
          headers: { Authorization: `Basic ${this.literalSecret('BASIC_CREDENTIALS', encoded)}` },
          query: {}
        }
      }
      case 'apikey': {
        const key = str(p['key']).trim() || 'X-Api-Key'
        const value = secret(key, p['value'])
        if (p['in'] === 'query') return { headers: {}, query: { [this.vars.rewrite(key)]: value } }
        if (!HEADER_NAME.test(key)) {
          this.warn(trail, `API key com nome de cabeçalho inválido "${key}" foi ignorada.`)
          return { headers: {}, query: {} }
        }
        return { headers: { [key]: value }, query: {} }
      }
      case 'digest':
        return { headers: {}, query: {}, auth: { type: 'digest', username: this.vars.rewrite(str(p['username'])), password: secret('DIGEST_PASSWORD', p['password']) } }
      case 'ntlm': {
        const auth: ConnectorAuth = { type: 'ntlm', username: this.vars.rewrite(str(p['username'])), password: secret('NTLM_PASSWORD', p['password']) }
        if (str(p['domain']).trim()) auth.domain = this.vars.rewrite(str(p['domain']).trim())
        if (str(p['workstation']).trim()) auth.workstation = this.vars.rewrite(str(p['workstation']).trim())
        return { headers: {}, query: {}, auth }
      }
      case 'awsv4': {
        const accessKeyId = this.sensitive('AWS_ACCESS_KEY_ID', str(p['accessKey']), true)
        const region = this.vars.rewrite(str(p['region']).trim())
        const service = this.vars.rewrite(str(p['service']).trim())
        if (!accessKeyId || !region || !service) {
          this.warn(trail, 'AWS Signature v4 sem access key, região ou serviço: complete config.auth no conector.')
        }
        const auth: ConnectorAuth = {
          type: 'awsSigV4',
          accessKeyId: accessKeyId || this.requiredSecret('AWS_ACCESS_KEY_ID', 'Access key id da AWS.'),
          secretAccessKey: secret('AWS_SECRET_ACCESS_KEY', p['secretKey']) || this.requiredSecret('AWS_SECRET_ACCESS_KEY', 'Secret access key da AWS.'),
          region: region || 'us-east-1',
          service: service || 'execute-api'
        }
        if (str(p['sessionToken']).trim()) auth.sessionToken = secret('AWS_SESSION_TOKEN', p['sessionToken'])
        return { headers: {}, query: {}, auth }
      }
      case 'oauth1': {
        const consumerKey = this.vars.rewrite(str(p['consumerKey']).trim())
        if (!consumerKey) {
          this.warn(trail, 'OAuth 1.0 sem consumer key foi ignorado.')
          return { headers: {}, query: {} }
        }
        const method = str(p['signatureMethod']).toUpperCase()
        const auth: ConnectorAuth = { type: 'oauth1', consumerKey, consumerSecret: secret('OAUTH1_CONSUMER_SECRET', p['consumerSecret']) }
        if (str(p['token']).trim()) auth.token = secret('OAUTH1_TOKEN', p['token'])
        if (str(p['tokenSecret']).trim()) auth.tokenSecret = secret('OAUTH1_TOKEN_SECRET', p['tokenSecret'])
        if (method === 'HMAC-SHA1' || method === 'HMAC-SHA256' || method === 'PLAINTEXT') auth.signatureMethod = method
        else if (method) this.warn(trail, `OAuth 1.0 com assinatura ${method}: o VVPost assina com HMAC-SHA1, HMAC-SHA256 ou PLAINTEXT; ficou HMAC-SHA1.`)
        if (str(p['realm']).trim()) auth.realm = this.vars.rewrite(str(p['realm']).trim())
        return { headers: {}, query: {}, auth }
      }
      case 'oauth2': {
        const grant = str(p['grant_type'])
        const tokenUrl = this.vars.rewrite(str(p['accessTokenUrl']).trim())
        const clientId = this.vars.rewrite(str(p['clientId']).trim())
        if ((grant === 'client_credentials' || grant === 'password_credentials') && /^(https?:\/\/|\/|\{\{)/.test(tokenUrl) && clientId) {
          const auth: ConnectorAuth = {
            type: 'oauth2',
            grantType: grant === 'client_credentials' ? 'client_credentials' : 'password',
            tokenUrl,
            clientId
          }
          if (str(p['clientSecret']).trim()) auth.clientSecret = secret('OAUTH2_CLIENT_SECRET', p['clientSecret'])
          if (grant === 'password_credentials') {
            auth.username = this.vars.rewrite(str(p['username']))
            auth.password = secret('OAUTH2_PASSWORD', p['password'])
          }
          if (str(p['scope']).trim()) auth.scope = this.vars.rewrite(str(p['scope']).trim())
          if (p['client_authentication'] === 'body') auth.clientAuthentication = 'body'
          return { headers: {}, query: {}, auth }
        }
        this.warn(trail, 'OAuth2 importado como token fixo; o fluxo de obtenção do token não é convertido.')
        const token = secret('OAUTH2_ACCESS_TOKEN', p['accessToken'])
        const prefix = str(p['headerPrefix']).trim() || 'Bearer'
        return p['addTokenTo'] === 'queryParams'
          ? { headers: {}, query: { access_token: token } }
          : { headers: { Authorization: `${prefix} ${token}` }, query: {} }
      }
      default:
        this.warn(trail, `autenticação "${type}" não é suportada e foi ignorada.`)
        return { headers: {}, query: {} }
    }
  }

  private body(body: PmBody | null | undefined, trail: string): { value?: unknown; payload?: RequestPayload; contentType?: string } {
    if (!body || typeof body !== 'object' || body.disabled) return {}
    switch (body.mode) {
      case 'raw': {
        const raw = body.raw ?? ''
        if (!raw.trim()) return {}
        const language = body.options?.raw?.language ?? 'text'
        const contentType = RAW_CONTENT_TYPES[language] ?? 'text/plain'
        if (language === 'json') {
          try {
            return { value: this.vars.rewriteDeep(JSON.parse(raw)), contentType }
          } catch {
            // JSON com variável fora de aspas ({"n": {{n}}}) segue como texto.
          }
        }
        return { value: this.vars.rewrite(raw), contentType }
      }
      case 'urlencoded': {
        const fields: { name: string; value: string }[] = []
        for (const f of body.urlencoded ?? []) {
          if (!isObject(f) || typeof f.key !== 'string' || !f.key || f.disabled) continue
          fields.push({ name: this.vars.rewrite(f.key), value: this.sensitive(f.key, str(f.value), isSecretName(f.key)) })
        }
        return fields.length ? { payload: { mode: 'urlencoded', fields } } : {}
      }
      case 'formdata': {
        const fields: PayloadFormField[] = []
        for (const f of body.formdata ?? []) {
          if (!isObject(f) || typeof f.key !== 'string' || !f.key || f.disabled) continue
          const name = this.vars.rewrite(f.key)
          if (f.type === 'file') {
            const src = fileSrc(f.src)
            if (!src) {
              this.warn(trail, `campo de arquivo "${f.key}" do form-data sem arquivo escolhido no ${this.tool}; ficou de fora.`)
              continue
            }
            this.warn(trail, `campo de arquivo "${f.key}" aponta para ${src}, um caminho da máquina de quem exportou: confira o arquivo (caminhos relativos são da pasta do projeto).`)
            fields.push({ name, file: src, ...(typeof f.contentType === 'string' && f.contentType && { contentType: f.contentType }) })
            continue
          }
          fields.push({
            name,
            value: this.sensitive(f.key, str(f.value), isSecretName(f.key)),
            ...(typeof f.contentType === 'string' && f.contentType && { contentType: f.contentType })
          })
        }
        return fields.length ? { payload: { mode: 'multipart', fields } } : {}
      }
      case 'graphql': {
        const query = body.graphql?.query ?? ''
        let variables: unknown = {}
        const rawVars = body.graphql?.variables?.trim()
        if (rawVars) {
          try {
            variables = JSON.parse(rawVars)
          } catch {
            this.warn(trail, 'variáveis GraphQL não são JSON válido e foram ignoradas.')
          }
        }
        return { value: this.vars.rewriteDeep({ query, variables }), contentType: 'application/json' }
      }
      case 'file': {
        const src = fileSrc(body.file?.src)
        if (!src) {
          this.warn(trail, `corpo binário sem arquivo escolhido no ${this.tool}; ficou de fora.`)
          return {}
        }
        this.warn(trail, `corpo binário aponta para ${src}, um caminho da máquina de quem exportou: confira o arquivo (caminhos relativos são da pasta do projeto).`)
        return { payload: { mode: 'binary', file: src } }
      }
      default:
        return {}
    }
  }

  /**
   * Exemplos salvos da requisição viram `examples` do endpoint (documentação e mock). Headers de
   * credencial ficam de fora, e no corpo os valores com nome ou formato de credencial viram
   * um marcador: o exemplo vai para arquivo versionado.
   */
  private responseExamples(responses: PmResponse[] | undefined, trail: string): ResponseExample[] {
    if (!Array.isArray(responses)) return []
    const ids = new UniqueIds()
    const out: ResponseExample[] = []
    for (const r of responses) {
      if (!r || typeof r !== 'object') continue
      const status = Number(r.code)
      if (!Number.isInteger(status) || status < 100 || status > 599) continue
      const name = r.name?.trim() || `${status}${r.status ? ` ${r.status}` : ''}`
      const example: ResponseExample = { id: ids.take(slug(name, '_') || `status_${status}`, '_'), name, status }
      const headers: Record<string, string> = {}
      let redacted = false
      for (const h of r.header ?? []) {
        if (!isObject(h) || typeof h.key !== 'string' || !HEADER_NAME.test(h.key) || h.disabled) continue
        const key = h.key.toLowerCase()
        if (EXAMPLE_DROPPED_HEADERS.has(key)) continue
        if (SENSITIVE_HEADERS.has(key) || isSecretName(h.key) || looksLikeSecretValue(h.value)) {
          redacted = true
          continue
        }
        headers[h.key] = str(h.value)
      }
      if (Object.keys(headers).length) example.headers = headers
      const body = typeof r.body === 'string' ? r.body : ''
      if (body.length > MAX_EXAMPLE_BODY) {
        this.warn(trail, `o corpo do exemplo "${name}" tem mais de ${MAX_EXAMPLE_BODY / 1024} KB e ficou de fora.`)
      } else if (body.trim()) {
        const { value, changed } = redactBody(body)
        example.body = value
        redacted ||= changed
      }
      if (redacted) this.warn(trail, `o exemplo "${name}" tinha credenciais (headers ou campos do corpo); ficaram de fora do arquivo.`)
      out.push(example)
      this.examples++
    }
    return out
  }

  /** Testes do Postman que só checam o status viram um cenário com asserção de status. */
  private scenarios(events: PmEvent[]): Scenario[] {
    const statuses = new Set<number>()
    for (const e of events) {
      if (e.listen !== 'test') continue
      const script = scriptOf(e)
      for (const re of STATUS_TESTS) for (const m of script.matchAll(re)) statuses.add(Number(m[1]))
    }
    if (statuses.size !== 1) return []
    this.statusAssertions++
    const [status] = statuses
    return [
      {
        id: `postman_status_${status}`,
        name: `Status ${status} (teste do ${this.tool})`,
        assertions: [{ target: 'status', operator: 'equals', expected: status }]
      }
    ]
  }

  private collectOrigins(node: Node): string[] {
    const own = node.drafts.map((d) => d.origin).filter(Boolean)
    return [...own, ...node.children.flatMap((c) => this.collectOrigins(c))]
  }

  /**
   * Gera os conectores em pré-ordem (pai antes dos filhos). Uma pasta só define
   * baseUrl quando a maioria das suas requisições usa outra origem; requisições
   * que ainda assim divergem vão para um conector auxiliar por origem.
   */
  private emit(
    node: Node,
    parent: Node | undefined,
    inheritedBase: string | undefined,
    out: Connector[]
  ): void {
    let base = inheritedBase
    if (parent) {
      const common = mostCommon(this.collectOrigins(node), inheritedBase)
      if (common && common !== inheritedBase) base = common
    }
    const config: ConnectorConfig = {}
    if (base && (base !== inheritedBase || !parent)) config.baseUrl = base
    if (Object.keys(node.credentials.headers).length) config.headers = node.credentials.headers
    if (node.credentials.auth) config.auth = node.credentials.auth
    if (node.scripts) config.scripts = node.scripts

    const byOrigin = new Map<string, Endpoint[]>()
    const byAuth = new Map<string, { auth: ConnectorAuth; origin?: string; endpoints: Endpoint[] }>()
    const endpoints: Endpoint[] = []
    for (const d of node.drafts) {
      const origin = d.origin && d.origin !== base ? d.origin : undefined
      if (d.auth) {
        const key = JSON.stringify([d.auth, origin])
        const group = byAuth.get(key) ?? { auth: d.auth, origin, endpoints: [] }
        group.endpoints.push(d.endpoint)
        byAuth.set(key, group)
      } else if (!origin) endpoints.push(d.endpoint)
      else byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), d.endpoint])
    }

    const connector: Connector = {
      $schema: CONNECTOR_SCHEMA,
      id: node.id,
      name: node.name,
      version: this.version
    }
    if (node.description) connector.description = node.description
    if (parent) connector.extends = parent.id
    if (Object.keys(config).length) connector.config = config
    if (endpoints.length) connector.endpoints = endpoints
    out.push(connector)

    for (const [origin, list] of byOrigin) {
      const label = origin.replace(/^https?:\/\//, '')
      out.push({
        $schema: CONNECTOR_SCHEMA,
        id: this.connectorIds.take(`${node.id}.${slug(label) || 'origin'}`, '-'),
        name: `${node.name} (${label})`,
        version: this.version,
        extends: node.id,
        config: { baseUrl: origin },
        endpoints: list
      })
    }
    // No VVPost a auth executada é do conector: a requisição com auth própria fica num filho com ela.
    for (const { auth, origin, endpoints: list } of byAuth.values()) {
      const label = list.length === 1 ? list[0]!.name : (AUTH_LABELS[auth.type] ?? auth.type)
      out.push({
        $schema: CONNECTOR_SCHEMA,
        id: this.connectorIds.take(`${node.id}.${slug(label) || auth.type.toLowerCase()}`, '-'),
        name: `${node.name} (${label})`,
        version: this.version,
        extends: node.id,
        config: { ...(origin && { baseUrl: origin }), auth },
        endpoints: list
      })
      this.warn(
        `${node.trail} › ${list.map((e) => e.name).join(', ')}`,
        `a autenticação ${AUTH_LABELS[auth.type] ?? auth.type} da requisição ficou num conector filho, "${node.name} (${label})": no VVPost ela é do conector.`
      )
    }
    for (const child of node.children) this.emit(child, node, base, out)
  }
}

const CONNECTOR_SCHEMA = 'https://vvpost.dev/schemas/v1/connector.json'
const ENVIRONMENT_SCHEMA = 'https://vvpost.dev/schemas/v1/environment.json'

const RAW_CONTENT_TYPES: Record<string, string> = {
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  javascript: 'application/javascript',
  text: 'text/plain'
}

const AUTH_LABELS: Record<string, string> = {
  digest: 'Digest',
  ntlm: 'NTLM',
  awsSigV4: 'AWS SigV4',
  oauth1: 'OAuth 1.0',
  oauth2: 'OAuth2',
  basic: 'Basic',
  bearer: 'Bearer',
  apiKey: 'API key',
  login: 'login',
  none: 'sem auth'
}

const MAX_EXAMPLE_BODY = 256 * 1024
/** Headers de transporte que não fazem sentido num exemplo (o mock calcula os dele). */
const EXAMPLE_DROPPED_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'date', 'keep-alive', 'set-cookie'])
const REDACTED = '<removido no import>'

/** Corpo de exemplo: JSON parseado com os campos de credencial trocados; texto com os tokens conhecidos trocados. */
export function redactBody(body: string): { value: unknown; changed: boolean } {
  let changed = false
  const deep = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      if ((key && isSecretName(key) && v) || looksLikeSecretValue(v)) {
        changed = true
        return REDACTED
      }
      return v
    }
    if (Array.isArray(v)) return v.map((x) => deep(x))
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x, k)]))
    return v
  }
  try {
    return { value: deep(JSON.parse(body)), changed }
  } catch {
    const value = body.replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]*|\b(?:sk|rk)_(?:live|test)_\w{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b/g, () => {
      changed = true
      return REDACTED
    })
    return { value, changed }
  }
}

const STATUS_TESTS = [
  /pm\.response\.to\.have\.status\(\s*(\d{3})\s*\)/g,
  /pm\.expect\(\s*pm\.response\.code\s*\)\.to\.(?:eql|equal|be\.equal)\(\s*(\d{3})\s*\)/g,
  /responseCode\.code\s*===?\s*(\d{3})/g
]

function scriptOf(e: PmEvent): string {
  const exec = e?.script?.exec
  return Array.isArray(exec) ? exec.join('\n') : (exec ?? '')
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return s
  }
}

function rebuildUrl(u: PmUrl): string {
  const host = Array.isArray(u.host) ? u.host.join('.') : (u.host ?? '')
  const path = Array.isArray(u.path)
    ? u.path.map((s) => (typeof s === 'string' ? s : (s?.value ?? ''))).join('/')
    : (u.path ?? '')
  const origin = host ? `${u.protocol ? `${u.protocol}://` : ''}${host}${u.port ? `:${u.port}` : ''}` : ''
  return `${origin}${path ? `/${path.replace(/^\//, '')}` : ''}`
}

/** Valor mais frequente; em empate fica `preferred` (a origem herdada) ou o primeiro visto. */
function mostCommon(values: string[], preferred?: string): string | undefined {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best = preferred !== undefined && counts.has(preferred) ? preferred : undefined
  for (const [v, n] of counts) if (best === undefined || n > counts.get(best)!) best = v
  return best
}

function hasCredentials(c: Credentials): boolean {
  return Object.keys(c.headers).length > 0 || Object.keys(c.query).length > 0 || !!c.auth
}

function countDrafts(node: Node): number {
  return node.drafts.length + node.children.reduce((n, c) => n + countDrafts(c), 0)
}

// ---------------------------------------------------------------------------
// Ponto de entrada

/** Converte um lote de arquivos do Postman (coleções e ambientes) de uma vez. */
export function convertPostman(sources: PostmanSource[]): PostmanImportResult {
  const result: PostmanImportResult = {
    sources: [],
    connectors: [],
    environments: [],
    secrets: [],
    warnings: [],
    errors: []
  }
  const vars = new Variables()
  const connectorIds = new UniqueIds()
  const envIds = new UniqueIds()
  const warn = (source: string, message: string) => result.warnings.push({ source, message })

  const collections: { name: string; converter: CollectionConverter; variables: PmKeyValue[] }[] = []
  const environments: { name: string; values: PmKeyValue[] }[] = []

  // Ambientes primeiro: assim uma variável definida neles não é dada como "sem valor" na coleção.
  const kinds = sources.map((s) => detect(s.data))
  sources.forEach((s, i) => {
    if (kinds[i] !== 'environment') return
    const env = s.data as PmEnvironment
    const name = env.name?.trim() || s.file.replace(/\.json$/i, '')
    for (const v of env.values) {
      if (!isObject(v) || typeof v.key !== 'string' || !v.key) continue
      const info = vars.get(v.key)
      info.defined = true
      if (v.type === 'secret' || looksLikeSecretValue(v.value)) info.secret = true
    }
    environments.push({ name, values: env.values })
    result.sources.push({ file: s.file, kind: 'environment', name })
  })
  sources.forEach((s, i) => {
    const kind = kinds[i]!
    if (kind === 'environment') return
    if (kind !== 'collection') {
      result.errors.push({ file: s.file, message: kind })
      return
    }
    const collection = s.data as PmCollection
    const name = collection.info.name?.trim() || 'Coleção sem nome'
    const converter = new CollectionConverter(vars, connectorIds, warn, s.tool)
    result.connectors.push(...converter.convert(collection))
    collections.push({ name, converter, variables: collection.variable ?? [] })
    result.sources.push({ file: s.file, kind: 'collection', name })
  })

  if (vars.unknownDynamic.size) {
    warn(
      'Variáveis dinâmicas',
      `sem equivalente no VVPost ainda, ficaram como estão: ${[...vars.unknownDynamic].map((v) => `{{${v}}}`).join(', ')}.`
    )
  }

  // Um ambiente por arquivo de ambiente do Postman. Roda depois das coleções:
  // a essa altura já se sabe quais variáveis foram usadas em autenticação.
  for (const env of environments) {
    const id = envIds.take(`env.${slug(env.name) || 'postman'}`, '-')
    const variables: Record<string, EnvironmentVariable> = {}
    for (const v of env.values) {
      if (!isObject(v) || typeof v.key !== 'string' || !v.key || v.enabled === false || v.disabled) continue
      const info = vars.get(v.key)
      variables[info.name] = variable(v.value, info.secret, info.description)
      if (info.secret && str(v.value))
        result.secrets.push({ environmentId: id, variable: info.name, value: str(v.value) })
    }
    result.environments.push({ $schema: ENVIRONMENT_SCHEMA, id, name: env.name, variables })
  }

  // Um ambiente por coleção: variáveis da coleção e segredos literais extraídos.
  // Variáveis usadas sem valor em lugar nenhum entram no primeiro, para o onboarding pedir.
  const missing = vars.all().filter((v) => v.used && !v.defined)
  collections.forEach(({ name, converter, variables: pmVars }, i) => {
    const id = envIds.take(`env.${slug(name) || 'collection'}`, '-')
    const variables: Record<string, EnvironmentVariable> = {}
    for (const v of pmVars) {
      if (!isObject(v) || typeof v.key !== 'string' || !v.key || v.disabled) continue
      const info = vars.get(v.key)
      variables[info.name] = variable(v.value, info.secret, info.description)
      if (info.secret && str(v.value))
        result.secrets.push({ environmentId: id, variable: info.name, value: str(v.value) })
    }
    for (const { variable: info, value } of converter.secrets) {
      variables[info.name] = variable(
        value,
        true,
        info.description ?? `Extraído de um valor fixo na coleção do ${converter.tool}.`
      )
      result.secrets.push({ environmentId: id, variable: info.name, value })
    }
    for (const info of converter.required) variables[info.name] = variable('', true, info.description)
    if (i === 0) {
      for (const info of missing) {
        variables[info.name] = variable(
          '',
          info.secret,
          info.description ?? `Usada na coleção, sem valor no ${converter.tool}.`
        )
      }
    }
    if (Object.keys(variables).length) {
      result.environments.push({
        $schema: ENVIRONMENT_SCHEMA,
        id,
        name: `${name} (variáveis da coleção)`,
        variables
      })
    }
  })
  scrubScripts(result, warn)
  return result
}

/**
 * Um segredo do vault escrito no meio de um script (comparado num teste, montado num header) não
 * vai para o arquivo versionado: vira {{NOME}}, que o host resolve quando vai para a requisição.
 */
function scrubScripts(result: PostmanImportResult, warn: (source: string, message: string) => void): void {
  const secrets = result.secrets.filter((s) => s.value.length >= 6).sort((a, b) => b.value.length - a.value.length)
  if (!secrets.length) return
  const scrub = (scripts: RequestScripts | undefined, source: string) => {
    for (const phase of ['pre', 'post'] as const) {
      let code = scripts?.[phase]
      if (!code) continue
      const found = new Set<string>()
      for (const { variable, value } of secrets) {
        if (!code.includes(value)) continue
        code = code.split(value).join(`{{${variable}}}`)
        found.add(variable)
      }
      if (!found.size) continue
      scripts![phase] = code
      warn(source, `o script ${phase} tinha o valor de ${[...found].map((v) => `{{${v}}}`).join(', ')}; ficou a referência, e o valor só no vault.`)
    }
  }
  for (const c of result.connectors) {
    scrub(c.config?.scripts, c.name)
    for (const e of c.endpoints ?? []) scrub(e.scripts, `${c.name} › ${e.name}`)
  }
}

function variable(value: unknown, secret: boolean, description?: string): EnvironmentVariable {
  const v: EnvironmentVariable = secret
    ? { type: 'string', value: SECRET_PLACEHOLDER, isSecret: true }
    : typeof value === 'number' || typeof value === 'boolean'
      ? { type: typeof value as 'number' | 'boolean', value }
      : { type: 'string', value: str(value) }
  // O marcador numa variável comum reprova a validação: vira segredo sem valor.
  if (!secret && v.value === SECRET_PLACEHOLDER) return variable('', true, description)
  if (description) v.description = description
  return v
}
