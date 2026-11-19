import { asString, baseName, isObject, postmanAuth, postmanUrl, rawBody, type ForeignConversion, type KeyValue } from './foreign'
import type { ImportWarning } from './postman'

/**
 * Importador de HAR (HTTP Archive 1.2, o que o DevTools do navegador, o Charles, o Fiddler e o
 * mitmproxy exportam). Cada origem vira uma pasta (ou a coleção, quando só há uma), e cada
 * método + caminho vira uma requisição, com a primeira chamada capturada como modelo e uma resposta
 * de exemplo por status. Arquivos estáticos, preflights de CORS e WebSockets ficam de fora; os
 * headers que o navegador põe sozinho também. Um `Authorization` igual em todas as requisições de
 * uma origem vira a auth da pasta, e o valor, como qualquer credencial, vai para o vault.
 */

type Obj = Record<string, unknown>

interface HarPair {
  name?: string
  value?: string
}

interface HarEntry {
  request?: {
    method?: string
    url?: string
    headers?: HarPair[]
    postData?: { mimeType?: string; text?: string; params?: (HarPair & { fileName?: string; contentType?: string })[] }
  }
  response?: {
    status?: number
    statusText?: string
    headers?: HarPair[]
    content?: { mimeType?: string; text?: string; encoding?: string }
  }
  _resourceType?: string
}

export function isHar(data: unknown): boolean {
  return isObject(data) && isObject(data['log']) && Array.isArray((data['log'] as Obj)['entries'])
}

/** Headers que o navegador ou o transporte põem sozinhos: não descrevem a API. */
const NOISE_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'accept-encoding',
  'accept-language',
  'user-agent',
  'referer',
  'origin',
  'cache-control',
  'pragma',
  'priority',
  'upgrade-insecure-requests',
  'dnt',
  'te',
  'keep-alive',
  'if-none-match',
  'if-modified-since',
  'purpose',
  'x-requested-with'
])
const NOISE_PREFIXES = ['sec-', ':']

const STATIC_TYPES = new Set(['image', 'stylesheet', 'script', 'font', 'media', 'manifest', 'texttrack', 'websocket', 'ping', 'cspviolationreport', 'preflight'])
const STATIC_MIME = /^(image|font|audio|video)\/|^text\/(css|javascript)|application\/(javascript|x-javascript|font|wasm)|\+(?:woff2?)$/i
const STATIC_EXT = /\.(png|jpe?g|gif|svg|ico|webp|avif|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|mp3)$/i

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

interface Group {
  origin: string
  requests: Map<string, { entry: HarEntry; name: string; responses: Map<number, Obj> }>
}

export function convertHar(file: string, data: unknown): ForeignConversion {
  const warnings: ImportWarning[] = []
  const name = baseName(file)
  const out: ForeignConversion = { format: 'har', name, postman: [], warnings, errors: [] }
  if (!isHar(data)) {
    out.errors.push({ file, message: 'não parece um arquivo HAR (log.entries)' })
    return out
  }
  const entries = ((data as Obj)['log'] as Obj)['entries'] as unknown[]
  const groups = new Map<string, Group>()
  const skipped = { static: 0, preflight: 0, other: 0 }
  let repeated = 0
  for (const raw of entries) {
    if (!isObject(raw)) continue
    const entry = raw as HarEntry
    const req = entry.request
    const method = asString(req?.method).toUpperCase()
    let url: URL
    try {
      url = new URL(asString(req?.url))
    } catch {
      skipped.other++
      continue
    }
    if (!/^https?:$/.test(url.protocol) || !METHODS.has(method)) {
      skipped.other++
      continue
    }
    const headers = req?.headers ?? []
    if (method === 'OPTIONS' && headers.some((h) => asString(h.name).toLowerCase() === 'access-control-request-method')) {
      skipped.preflight++
      continue
    }
    if (isStatic(entry, url)) {
      skipped.static++
      continue
    }
    const group = groups.get(url.origin) ?? { origin: url.origin, requests: new Map() }
    groups.set(url.origin, group)
    const key = `${method} ${url.pathname}`
    let item = group.requests.get(key)
    if (item) repeated++
    else {
      item = { entry, name: key, responses: new Map() }
      group.requests.set(key, item)
    }
    const status = Number(entry.response?.status)
    if (Number.isInteger(status) && status >= 100 && status <= 599 && !item.responses.has(status)) {
      item.responses.set(status, responseOf(entry))
    }
  }
  if (!groups.size) {
    out.errors.push({ file, message: 'o HAR não tem chamadas de API (só arquivos estáticos ou nada)' })
    return out
  }
  const left: string[] = []
  if (skipped.static) left.push(`${skipped.static} arquivo(s) estático(s)`)
  if (skipped.preflight) left.push(`${skipped.preflight} preflight(s) de CORS`)
  if (skipped.other) left.push(`${skipped.other} chamada(s) sem URL HTTP(S) ou com método sem suporte`)
  if (left.length) warnings.push({ source: name, message: `ficaram de fora: ${left.join(', ')}.` })
  if (repeated) warnings.push({ source: name, message: `${repeated} chamada(s) repetida(s) do mesmo método e caminho entraram só como exemplos de resposta da primeira.` })

  const folders = [...groups.values()].map((g) => folder(g, name, warnings))
  const collection: Obj = {
    info: { name, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: folders.length === 1 ? folders[0]!['item'] : folders,
    ...(folders.length === 1 && folders[0]!['auth'] ? { auth: folders[0]!['auth'] } : {})
  }
  out.postman.push({ file, tool: 'HAR', data: collection })
  return out
}

function isStatic(entry: HarEntry, url: URL): boolean {
  const type = asString(entry._resourceType).toLowerCase()
  if (type && type !== 'xhr' && type !== 'fetch' && type !== 'document' && STATIC_TYPES.has(type)) return true
  const mime = asString(entry.response?.content?.mimeType)
  return STATIC_MIME.test(mime) || STATIC_EXT.test(url.pathname)
}

function folder(group: Group, trail: string, warnings: ImportWarning[]): Obj {
  const items = [...group.requests.values()]
  // Mesmo Authorization em todas: vira a auth da pasta.
  const auths = items.map((i) => headerValue(i.entry.request?.headers ?? [], 'authorization'))
  const shared = auths[0] && auths.every((a) => a === auths[0]) ? auths[0] : undefined
  const auth = shared ? authOf(shared) : undefined
  const host = group.origin.replace(/^https?:\/\//, '')
  if (shared && !auth) warnings.push({ source: `${trail} › ${host}`, message: 'Authorization repetido em todas as chamadas ficou em cada requisição.' })
  return {
    name: host,
    item: items.map((i) => request(i.entry, i.name, auth ? 'authorization' : undefined, [...i.responses.values()])),
    ...(auth && { auth })
  }
}

function authOf(value: string): Obj | undefined {
  const bearer = value.match(/^Bearer\s+(.+)$/i)
  if (bearer) return postmanAuth('bearer', { token: bearer[1]!.trim() })
  const basic = value.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i)
  if (basic) {
    const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8')
    const colon = decoded.indexOf(':')
    if (colon > 0) return postmanAuth('basic', { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) })
  }
  return postmanAuth('apikey', { key: 'Authorization', value, in: 'header' })
}

const headerValue = (headers: HarPair[], name: string): string | undefined =>
  headers.find((h) => asString(h.name).toLowerCase() === name)?.value

function request(entry: HarEntry, name: string, omit: string | undefined, responses: Obj[]): Obj {
  const req = entry.request!
  const header: KeyValue[] = []
  for (const h of req.headers ?? []) {
    const key = asString(h.name)
    const lower = key.toLowerCase()
    if (!key || lower === omit || NOISE_HEADERS.has(lower) || NOISE_PREFIXES.some((p) => lower.startsWith(p))) continue
    if (header.some((x) => x.key.toLowerCase() === lower)) continue
    header.push({ key, value: asString(h.value) })
  }
  const post = req.postData
  let body: Obj | undefined
  const mime = asString(post?.mimeType).toLowerCase()
  if (post && /x-www-form-urlencoded/.test(mime)) {
    const params = post.params?.length
      ? post.params.map((p) => ({ key: asString(p.name), value: asString(p.value) }))
      : postmanUrl(`?${asString(post.text)}`).query ?? []
    body = { mode: 'urlencoded', urlencoded: params }
  } else if (post && /multipart\/form-data/.test(mime)) {
    body = {
      mode: 'formdata',
      formdata: (post.params ?? []).map((p) =>
        p.fileName ? { key: asString(p.name), type: 'file', src: '' } : { key: asString(p.name), value: asString(p.value) }
      )
    }
  } else if (post && asString(post.text).trim()) {
    body = rawBody(asString(post.text), mime)
  }
  return {
    name,
    request: { method: asString(req.method).toUpperCase(), url: postmanUrl(asString(req.url)), header, ...(body && { body }) },
    ...(responses.length && { response: responses })
  }
}

function responseOf(entry: HarEntry): Obj {
  const res = entry.response ?? {}
  const content = res.content ?? {}
  let body = asString(content.text)
  if (content.encoding === 'base64') {
    body = /json|xml|text|javascript|html/i.test(asString(content.mimeType)) ? Buffer.from(body, 'base64').toString('utf8') : ''
  }
  return {
    name: `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
    code: res.status,
    header: (res.headers ?? []).map((h) => ({ key: asString(h.name), value: asString(h.value) })),
    body
  }
}
