import { STATUS_CODES } from 'node:http'
import type { Readable } from 'node:stream'
import { rootCertificates } from 'node:tls'
import { createBrotliDecompress, createGunzip, createInflate, createZstdDecompress } from 'node:zlib'
import { Agent, ProxyAgent, request, type Dispatcher } from 'undici'
import type { HttpError, HttpErrorCode, HttpHeader, HttpRequestInput, HttpResult } from '../types'
import { SENSITIVE_HEADERS, isSensitiveName } from '../secrets'
import { isBinaryBody } from './body'
import type { CookieJar } from './cookies'
import { encodePayload, PayloadError } from './payload'
import { proxyFor, type ProxyConfig } from './proxy'

export { isBinaryBody } from './body'
export type { ProxyConfig } from './proxy'

/** Acima disso o corpo continua sendo lido (para medir tamanho e tempo), mas não é guardado. */
export const BODY_LIMIT_BYTES = 10 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_REDIRECTIONS = 5
const USER_AGENT = 'VVPost/0.1'

/**
 * Configuração do cliente HTTP que vale para todas as requisições (spec, fase 12): proxy,
 * verificação TLS, CAs extras e o cookie jar. O app lê de userData e aplica com `configure`;
 * o CLI e o MCP montam pelas flags e pelas variáveis de ambiente.
 */
export interface HttpClientConfig {
  /** Padrão: sem proxy. */
  proxy?: ProxyConfig
  /** false aceita certificado inválido (autoassinado, expirado, de outro host). Padrão: true. */
  verifyTls?: boolean
  /** CAs extras em PEM, além das do sistema (e da `tls.ca` do conector). */
  ca?: string[]
  /** Cookies recebidos voltam nas requisições seguintes para o mesmo domínio. Sem jar: nada é guardado. */
  cookies?: CookieJar | null
}

/**
 * Pool único de conexões para o app inteiro. O Agent mantém um pool por origem e
 * reaproveita sockets TCP/TLS em keep-alive, que é de onde vem o overhead baixo
 * por disparo: a segunda requisição para a mesma origem não paga handshake.
 */
export function createHttpDispatcher(options: Agent.Options = {}, initial: HttpClientConfig = {}) {
  let config = initial
  const tlsDefaults = (): TlsConnectOptions & { rejectUnauthorized?: boolean } => ({
    ...(config.verifyTls === false && { rejectUnauthorized: false }),
    ...(config.ca?.length && { ca: [...rootCertificates, ...config.ca] })
  })
  const createPool = (tls: TlsConnectOptions | undefined, proxy: string | null, affinity: boolean): Dispatcher => {
    const connect = { timeout: 10_000, ...options.connect, ...tlsDefaults(), ...mergeCa(tls, config.ca) }
    const base = {
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 10 * 60_000,
      ...options,
      // Auth por conexão (NTLM): um socket por origem, para o handshake não trocar de conexão.
      ...(affinity && { connections: 1, pipelining: 1 })
    }
    if (!proxy) return new Agent({ ...base, connect })
    return new ProxyAgent({
      ...base,
      uri: proxy,
      requestTls: connect,
      proxyTls: { timeout: 10_000, ...tlsDefaults() }
    })
  }
  // Certificado de cliente (mTLS), proxy e afinidade de conexão mudam o socket: cada combinação
  // ganha um pool próprio, senão um socket aberto com o certificado de um conector serviria outro.
  const pools = new Map<string, Dispatcher>()
  const poolFor = (tls: SendOptions['tls'], proxy: string | null, affinity: string | undefined) => {
    const key = `${proxy ?? ''}\0${tls?.key ?? ''}\0${affinity ?? ''}`
    let pool = pools.get(key)
    if (!pool) {
      pool = createPool(tls?.connect, proxy, affinity !== undefined)
      pools.set(key, pool)
    }
    return pool
  }
  const inFlight = new Map<string, AbortController>()

  async function send(input: HttpRequestInput, { tls, secretHeaders, affinity, encoded: preEncoded }: SendOptions = {}): Promise<HttpResult> {
    const start = performance.now()
    const elapsed = () => round(performance.now() - start)

    let url: URL
    try {
      url = new URL(input.url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
    } catch {
      return fail({ code: 'INVALID_URL', message: `URL inválida: ${input.url}` }, elapsed())
    }

    const controller = new AbortController()
    inFlight.set(input.id, controller)
    const timeout = AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const signal = AbortSignal.any([controller.signal, timeout])

    try {
      let body: string | Buffer | undefined = hasBody(input) ? input.body : undefined
      let headers = input.headers
      if (input.payload && input.method !== 'GET' && input.method !== 'HEAD') {
        const encoded = preEncoded ?? (await encodePayload(input.payload))
        body = encoded.body
        if (!headers.some((h) => h.name.trim().toLowerCase() === 'content-type')) {
          headers = [...headers, { name: 'Content-Type', value: encoded.contentType }]
        }
      }
      const follow = input.followRedirects ?? true
      const strip = crossOriginStrip(input, secretHeaders)
      const jar = config.cookies ?? null
      let method: string = input.method
      let current = url
      let sameOrigin = true
      for (let hop = 0; ; hop++) {
        const proxy = await proxyFor(current, config.proxy)
        const res = await request(current, {
          method: method as Dispatcher.HttpMethod,
          headers: buildHeaders(headers, body, jar?.cookieHeader(current) ?? ''),
          body,
          dispatcher: poolFor(tls, proxy, affinity),
          signal
        })
        const setCookie = res.headers['set-cookie']
        if (jar && setCookie) jar.store(current, Array.isArray(setCookie) ? setCookie : [setCookie])
        const location = res.headers['location']
        if (follow && REDIRECT.has(res.statusCode) && typeof location === 'string' && hop < MAX_REDIRECTIONS) {
          await res.body.dump()
          const next = new URL(location, current)
          if (next.protocol !== 'http:' && next.protocol !== 'https:') {
            throw Object.assign(new Error(`redirecionamento para ${next.protocol} não é seguido`), { code: 'UND_ERR_INVALID_ARG' })
          }
          // 303, e 301/302 depois de POST, viram GET sem corpo (como navegadores e o fetch).
          if (res.statusCode === 303 ? method !== 'HEAD' : (res.statusCode === 301 || res.statusCode === 302) && method === 'POST') {
            method = 'GET'
            body = undefined
            headers = headers.filter((h) => !BODY_HEADERS.has(h.name.trim().toLowerCase()))
          }
          if (sameOrigin && next.origin !== url.origin) {
            sameOrigin = false
            headers = headers.filter((h) => !strip.has(h.name.trim().toLowerCase()))
          }
          current = next
          continue
        }
        const ttfbMs = elapsed()
        const contentType = res.headers['content-type']
        const read = await readBody(
          decode(res.body, res.headers['content-encoding']),
          Array.isArray(contentType) ? contentType[0] : contentType
        )
        const totalMs = elapsed()
        return {
          ok: true,
          response: {
            status: res.statusCode,
            statusText: STATUS_CODES[res.statusCode] ?? '',
            headers: toHeaderList(res.headers),
            ...read,
            timings: { ttfbMs, downloadMs: round(totalMs - ttfbMs), totalMs }
          }
        }
      }
    } catch (err) {
      if (timeout.aborted) {
        return fail({ code: 'TIMEOUT', message: 'Tempo limite da requisição esgotado' }, elapsed())
      }
      if (err instanceof PayloadError) return fail({ code: 'INVALID_REQUEST', message: err.message }, elapsed())
      return fail(toHttpError(err), elapsed())
    } finally {
      inFlight.delete(input.id)
    }
  }

  const closeAll = () => {
    const all = [...pools.values()]
    pools.clear()
    return Promise.all(all.map((p) => p.close())).then(() => {})
  }

  return {
    send,
    cancel(id: string): void {
      inFlight.get(id)?.abort()
    },
    /**
     * O pool de uma conexão que não é uma requisição (WebSocket e SSE, fase 15), com o proxy, a
     * verificação TLS e as CAs da configuração e o mTLS do conector.
     */
    async connectionPool(url: URL, tls?: SendOptions['tls']): Promise<Dispatcher> {
      const http = new URL(url.href.replace(/^ws(s?):/i, 'http$1:'))
      return poolFor(tls, await proxyFor(http, config.proxy), undefined)
    },
    /** Troca proxy, TLS e cookie jar; as conexões abertas são fechadas quando terminarem. */
    configure(next: HttpClientConfig): void {
      config = next
      void closeAll()
    },
    get config(): HttpClientConfig {
      return config
    },
    close: closeAll
  }
}

const REDIRECT = new Set([301, 302, 303, 307, 308])
const BODY_HEADERS = new Set(['content-type', 'content-length', 'content-encoding', 'transfer-encoding'])

/** A CA do conector, somada às extras globais e às do sistema quando há extras. */
function mergeCa(tls: TlsConnectOptions | undefined, extra: string[] | undefined): TlsConnectOptions {
  if (!tls) return {}
  if (!tls.ca || !extra?.length) return tls
  return { ...tls, ca: [...rootCertificates, ...extra, ...(Array.isArray(tls.ca) ? tls.ca : [tls.ca])] }
}

export type HttpDispatcher = ReturnType<typeof createHttpDispatcher>

/** Opções de TLS do undici (certificado de cliente, CA extra) para um pool. */
export type TlsConnectOptions = Pick<
  import('node:tls').ConnectionOptions,
  'cert' | 'key' | 'pfx' | 'passphrase' | 'ca'
>

export interface SendOptions {
  /** `key` identifica o certificado: requisições com a mesma key dividem o pool. */
  tls?: { key: string; connect: TlsConnectOptions }
  /** Headers que carregam credencial além dos de nome sensível (ex.: o header da auth do conector). */
  secretHeaders?: readonly string[]
  /**
   * Requisições com a mesma afinidade usam um pool de uma conexão por origem: o handshake de
   * uma auth por conexão (NTLM) acontece todo no mesmo socket.
   */
  affinity?: string
  /** Corpo estruturado já codificado (a auth assinou estes bytes, com este boundary): vale no lugar de `payload`. */
  encoded?: { body: Buffer; contentType: string }
  /**
   * A requisição como o chamador montou (URL relativa, {{VAR}}, sem a herança), para quem
   * observa o dispatcher (o histórico). O dispatcher ignora.
   */
  trace?: RequestTrace
}

/** Origem de uma requisição já resolvida: o bastante para refazê-la com outra resolução de {{VAR}}. */
export interface RequestTrace {
  template: HttpRequestInput
  /** false: sem headers nem auth do conector (cenário com overrides.headers = null). */
  inheritHeaders?: boolean
  dropHeaders?: string[]
  /** Sem credencial: sem a auth do conector e sem os headers de credencial herdados (endpoint público, gate de acesso). */
  anonymous?: boolean
  /** Valores prontos para {{nome}} vindos de $nodes (Flow Studio). */
  extra?: Readonly<Record<string, string>>
}

/**
 * Headers que não seguem um redirecionamento para outra origem: Authorization, Cookie e
 * Proxy-Authorization, e os outros de credencial (X-Api-Key, um header de token qualquer, o
 * header da auth do conector). Os cookies do jar valem por domínio, a cada salto.
 */
function crossOriginStrip(input: HttpRequestInput, extra: readonly string[] = []): Set<string> {
  const names = new Set(['authorization', 'cookie', 'proxy-authorization', ...extra.map((n) => n.trim().toLowerCase())])
  for (const { name } of input.headers) {
    const lower = name.trim().toLowerCase()
    if (SENSITIVE_HEADERS.has(lower) || isSensitiveName(lower)) names.add(lower)
  }
  names.delete('')
  return names
}

function hasBody(input: HttpRequestInput): boolean {
  return !!input.body && input.method !== 'GET' && input.method !== 'HEAD'
}

function buildHeaders(headers: HttpHeader[], body: string | Buffer | undefined, jarCookies: string): string[] {
  const flat: string[] = []
  const names = new Set<string>()
  let cookie: string | undefined
  for (const { name, value } of headers) {
    const trimmed = name.trim()
    if (!trimmed) continue
    const lower = trimmed.toLowerCase()
    // Vários Cookie viram um só, com os do jar que a requisição não definiu.
    if (lower === 'cookie') {
      cookie = cookie ? `${cookie}; ${value}` : value
      continue
    }
    names.add(lower)
    flat.push(trimmed, value)
  }
  if (jarCookies) {
    const own = new Set((cookie ?? '').split(';').map((p) => p.split('=')[0]!.trim()).filter(Boolean))
    const extra = jarCookies.split('; ').filter((p) => !own.has(p.split('=')[0]!))
    if (extra.length) cookie = [cookie, ...extra].filter(Boolean).join('; ')
  }
  if (cookie) flat.push('cookie', cookie)
  if (!names.has('user-agent')) flat.push('user-agent', USER_AGENT)
  if (body !== undefined && body.length > 0 && !names.has('content-type')) {
    flat.push('content-type', typeof body === 'string' && looksLikeJson(body) ? 'application/json' : 'text/plain;charset=UTF-8')
  }
  return flat
}

function looksLikeJson(body: string): boolean {
  const first = body.trimStart()[0]
  if (first !== '{' && first !== '[') return false
  try {
    JSON.parse(body)
    return true
  } catch {
    return false
  }
}

/** O undici entrega o corpo comprimido; descomprimimos aqui para exibir. */
function decode(body: Readable, encoding: string | string[] | undefined): Readable {
  const value = (Array.isArray(encoding) ? encoding.at(-1) : encoding)?.trim().toLowerCase()
  const decoder =
    value === 'gzip' || value === 'x-gzip'
      ? createGunzip()
      : value === 'deflate'
        ? createInflate()
        : value === 'br'
          ? createBrotliDecompress()
          : value === 'zstd'
            ? createZstdDecompress()
            : null
  if (!decoder) return body
  body.on('error', (err) => decoder.destroy(err))
  return body.pipe(decoder)
}

async function readBody(stream: Readable, contentType: string | undefined) {
  const chunks: Buffer[] = []
  let kept = 0
  let sizeBytes = 0
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    sizeBytes += chunk.length
    if (kept < BODY_LIMIT_BYTES) {
      const slice = chunk.subarray(0, BODY_LIMIT_BYTES - kept)
      chunks.push(slice)
      kept += slice.length
    }
  }
  const bytes = Buffer.concat(chunks, kept)
  return {
    body: bytes.toString('utf8'),
    ...(isBinaryBody(contentType, bytes) && { bodyBase64: bytes.toString('base64') }),
    sizeBytes,
    truncated: sizeBytes > kept
  }
}


function toHeaderList(headers: Record<string, string | string[] | undefined>): HttpHeader[] {
  const list: HttpHeader[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    for (const v of Array.isArray(value) ? value : [value]) list.push({ name, value: v })
  }
  return list
}

function fail(error: HttpError, totalMs: number): HttpResult {
  return { ok: false, error, timings: { totalMs } }
}

const TLS_CODES = /^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_(GET|VERIFY))/

export function toHttpError(err: unknown): HttpError {
  const e = err as {
    name?: string
    code?: string
    message?: string
    cause?: { code?: string; message?: string }
  }
  const code = e.code ?? ''
  const causeCode = e.cause?.code ?? ''
  const message = e.cause?.message ?? e.message ?? String(err)
  const as = (c: HttpErrorCode, msg = message): HttpError => ({ code: c, message: msg })

  if (e.name === 'AbortError' || code === 'UND_ERR_ABORTED' || code === 'ABORT_ERR') {
    return as('ABORTED', 'Requisição cancelada')
  }
  if (['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) {
    return as('TIMEOUT')
  }
  for (const c of [code, causeCode]) {
    if (c === 'ECONNREFUSED') return as('CONNECTION_REFUSED')
    if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return as('DNS_FAILURE')
    if (TLS_CODES.test(c)) return as('TLS_FAILURE')
  }
  if (code === 'UND_ERR_INVALID_ARG' || code === 'UND_ERR_NOT_SUPPORTED') return as('INVALID_REQUEST')
  return as('NETWORK_ERROR')
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100
}
