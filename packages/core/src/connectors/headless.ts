import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { ConnectorTls } from '@vvpost/schemas'
import type { AuthUsage, HttpHeader, HttpRequestInput, HttpResult, RequestPayload } from '../types'
import type { HttpDispatcher, SendOptions, TlsConnectOptions } from '../http/dispatcher'
import { encodePayload, PayloadError } from '../http/payload'
import { isCredentialHeader } from '../secrets'
import type { AppliedAuth, AuthEngine } from './auth'
import { AUTH_CONTRACT, authHeaderName } from './auth-contract'
import type { RequestGuard } from '../policy/request-policy'
import { AuthError, ConfigError, PolicyError } from './errors'
import { joinPath, resolveConnector, type ResolvedConnector } from './resolve'
import { interpolate, type VariableScope } from './template'
import { environmentValues, type LoadedWorkspace } from './workspace'

export { authHeaderName } from './auth-contract'

export interface HeadlessContext {
  workspace: LoadedWorkspace
  auth: AuthEngine
  http: Pick<HttpDispatcher, 'send'>
  /** Cancela a fase de auth; a fase de rede é cancelada pelo dispatcher. */
  signal?: AbortSignal
  /** Permissões e limites do chamador (MCP, plugin); a requisição recusada volta como POLICY_DENIED. */
  guard?: RequestGuard
}

/** Ajustes da herança para uma requisição, usados pelos cenários de teste. */
export interface HeadlessOptions {
  /** false: nem headers nem auth do conector entram (overrides.headers = null, ex.: testar 401). */
  inheritHeaders?: boolean
  /** Sem credencial (endpoint público, ou o gate de acesso): sem a auth do conector e sem os headers de credencial herdados. */
  anonymous?: boolean
  /** Headers herdados retirados pelo nome; retirar o header da auth desliga a auth. */
  dropHeaders?: string[]
  /** Valores já prontos para {{nome}}, sem nova interpolação (ex.: dados de $nodes no Flow Studio). */
  extra?: Readonly<Record<string, string>>
}

/**
 * Quick Request com herança headless: resolve as variáveis do ambiente,
 * aplica baseUrl, headers e mTLS herdados do conector, roda a auth em segundo
 * plano (com token em cache) e dispara. Um token em cache recusado com 401 é
 * descartado e a requisição é repetida uma vez com um token novo.
 */
export async function sendHeadless(
  input: HttpRequestInput,
  ctx: HeadlessContext,
  { inheritHeaders = true, dropHeaders = [], extra, anonymous = false }: HeadlessOptions = {}
): Promise<HttpResult> {
  const start = performance.now()
  const elapsed = () => Math.round((performance.now() - start) * 100) / 100
  let usage: AuthUsage | undefined
  try {
    const { values, missingSecrets } = environmentValues(ctx.workspace, input.environmentId)
    const scope: VariableScope = { values, missingSecrets, ...(extra && { extra }) }
    const v = (text: string) => interpolate(text, scope)

    const connector = input.connectorId ? resolveConnector(input.connectorId, ctx.workspace.connectors) : undefined
    const baseUrl = connector?.baseUrl === undefined ? undefined : v(connector.baseUrl)
    const url = connector ? targetUrl(v(input.url.trim()), baseUrl, connector) : v(input.url.trim())

    const dropped = new Set(dropHeaders.map((name) => name.trim().toLowerCase()))
    const inherited = inheritHeaders ? Object.entries(connector?.headers ?? {}) : []
    const headers = mergeHeaders(
      inherited.filter(([name]) => !dropped.has(name.toLowerCase()) && !(anonymous && isCredentialHeader(name))).map(([name, value]) => ({ name, value: v(value) })),
      input.headers.filter((h) => h.name.trim()).map((h) => ({ name: h.name, value: v(h.value) }))
    )
    const body = input.body === undefined ? undefined : v(input.body)
    const payload = input.payload && resolvePayload(input.payload, v, ctx.workspace.dir, !!ctx.guard)
    const options: SendOptions = connector?.tls ? { tls: await loadTls(connector.tls.config, ctx.workspace.dir, scope) } : {}
    const send = (req: HttpRequestInput) => ctx.http.send(req, options)

    // Um header de auth digitado à mão vence a herança: dá para testar outro token sem editar o conector.
    const authConfig = connector?.auth?.config
    const authHeader = authConfig && authHeaderName(authConfig)?.toLowerCase()
    const overridden = authHeader !== undefined && headers.some((h) => h.name.toLowerCase() === authHeader)
    const authOff = anonymous || !inheritHeaders || (authHeader !== undefined && dropped.has(authHeader))
    const authorize = async (forceRefresh = false): Promise<AppliedAuth | null> =>
      connector && !overridden && !authOff
        ? ctx.auth.apply({
            connector,
            scopeKey: `${ctx.workspace.dir}\0${input.environmentId ?? ''}`,
            scope,
            baseUrl,
            send,
            forceRefresh,
            ...(ctx.guard && { interactive: false }),
            signal: ctx.signal
          })
        : null
    // O header da auth não segue um redirecionamento para outra origem, qualquer que seja o nome dele.
    const trace = {
      template: input,
      ...(!inheritHeaders && { inheritHeaders }),
      ...(dropHeaders.length && { dropHeaders }),
      ...(extra && { extra }),
      ...(anonymous && { anonymous })
    }
    const dispatchOptions: SendOptions = { ...options, ...(authHeader && { secretHeaders: [authHeader] }), trace }
    const withBody = input.method !== 'GET' && input.method !== 'HEAD'
    /** `answer`: a resposta ao desafio (Digest, NTLM), que substitui os headers iniciais da auth. */
    const dispatch = async (applied: AppliedAuth | null, timeoutMs: number | undefined, answer: HttpHeader[] = []) => {
      const finalUrl = withQuery(url, applied?.query ?? [])
      let finalHeaders = mergeHeaders(mergeHeaders(headers, applied?.headers ?? []), answer)
      let encoded: SendOptions['encoded']
      if (applied?.sign) {
        // A assinatura cobre os bytes do corpo: o multipart é codificado aqui, uma vez, com o boundary que vai na rede.
        if (payload && withBody) {
          encoded = await encodePayload(payload)
          if (!finalHeaders.some((h) => h.name.trim().toLowerCase() === 'content-type')) {
            finalHeaders = [...finalHeaders, { name: 'Content-Type', value: encoded.contentType }]
          }
        }
        const signed = encoded?.body ?? (withBody ? body : undefined)
        finalHeaders = mergeHeaders(finalHeaders, applied.sign({ method: input.method, url: finalUrl, headers: finalHeaders, ...(signed !== undefined && { body: signed }) }))
      }
      const affinity = applied?.challenge?.affinity
      return {
        url: finalUrl,
        result: await ctx.http.send(
          {
            ...input,
            ...(timeoutMs !== undefined && { timeoutMs }),
            url: finalUrl,
            headers: finalHeaders,
            body,
            ...(payload && { payload })
          },
          { ...dispatchOptions, ...(encoded && { encoded }), ...(affinity && { affinity }) }
        )
      }
    }
    // A política vale para a requisição do chamador (cada tentativa conta), não para o fluxo de auth do conector.
    const attempt = async (forceRefresh: boolean) => {
      const slot = ctx.guard
        ? await ctx.guard.admit(
            { method: input.method, url, ...(input.environmentId && { environmentId: input.environmentId }), ...(input.timeoutMs && { timeoutMs: input.timeoutMs }) },
            ctx.signal
          )
        : { ok: true as const, timeoutMs: input.timeoutMs, release: () => {} }
      if (!slot.ok) throw ctx.signal?.aborted ? new Error(slot.message) : new PolicyError(slot.message)
      try {
        const applied = await authorize(forceRefresh)
        const run = async () => {
          const first = await dispatch(applied, slot.timeoutMs)
          // Digest e NTLM: o 401 traz o desafio, e a mesma requisição vai de novo com a resposta.
          if (!applied?.challenge || !first.result.ok || first.result.response.status !== 401) return first.result
          const answer = applied.challenge.respond(first.result.response, { method: input.method, url: first.url })
          return answer ? (await dispatch(applied, slot.timeoutMs, answer)).result : first.result
        }
        const affinity = applied?.challenge?.affinity
        return { applied, result: await (affinity ? exclusive(affinity, run) : run()) }
      } finally {
        slot.release()
      }
    }

    let { applied, result } = await attempt(false)
    usage = applied?.usage
    if (result.ok && result.response.status === 401 && applied?.renewable && applied.usage.source === 'cache') {
      ;({ applied, result } = await attempt(true))
      usage = applied ? { ...applied.usage, retried: true } : undefined
    }
    return usage ? { ...result, auth: usage } : result
  } catch (err) {
    const code =
      err instanceof ConfigError
        ? 'CONFIG_ERROR'
        : err instanceof AuthError
          ? 'AUTH_FAILED'
          : err instanceof PolicyError
            ? 'POLICY_DENIED'
            : err instanceof PayloadError
              ? 'INVALID_REQUEST'
              : ctx.signal?.aborted
              ? 'ABORTED'
              : null
    if (!code) throw err
    const message = code === 'ABORTED' ? 'Requisição cancelada' : (err as Error).message
    return { ok: false, error: { code, message }, timings: { totalMs: elapsed() }, ...(usage && { auth: usage }) }
  }
}

/** Handshakes por conexão (NTLM) com a mesma chave rodam um de cada vez: no mesmo socket, um não pode atravessar o outro. */
const handshakes = new Map<string, Promise<unknown>>()
function exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = handshakes.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(run)
  const tail = next.catch(() => {})
  handshakes.set(key, tail)
  void tail.then(() => {
    if (handshakes.get(key) === tail) handshakes.delete(key)
  })
  return next
}

/**
 * O corpo estruturado com {{VAR}} resolvido e os caminhos de arquivo absolutos (relativos são da
 * pasta do workspace). Quem dispara sem humano (a IA pelo MCP, um hook) só envia arquivos de dentro
 * do workspace: um endpoint editado não vira um jeito de mandar ~/.ssh para uma API.
 */
function resolvePayload(payload: RequestPayload, v: (text: string) => string, dir: string, confined: boolean): RequestPayload {
  const path = (raw: string) => {
    const value = v(raw)
    const full = isAbsolute(value) ? value : resolve(dir, value)
    const rel = relative(dir, full)
    if (confined && (rel.startsWith('..') || isAbsolute(rel))) {
      throw new PolicyError(`o arquivo do corpo (${value}) fica fora do workspace`)
    }
    return full
  }
  switch (payload.mode) {
    case 'urlencoded':
      return { mode: 'urlencoded', fields: payload.fields.map((f) => ({ name: v(f.name), ...(f.value !== undefined && { value: v(f.value) }) })) }
    case 'binary':
      return { mode: 'binary', file: path(payload.file), ...(payload.contentType && { contentType: v(payload.contentType) }) }
    case 'multipart':
      return {
        mode: 'multipart',
        fields: payload.fields.map((f) => ({
          name: v(f.name),
          ...(f.value !== undefined && { value: v(f.value) }),
          ...(f.file !== undefined && { file: path(f.file) }),
          ...(f.filename !== undefined && { filename: v(f.filename) }),
          ...(f.contentType !== undefined && { contentType: v(f.contentType) })
        }))
      }
  }
}

/**
 * Com conector, a URL digitada é um caminho relativo a baseUrl + basePath. Uma URL
 * absoluta só é aceita na mesma origem da baseUrl: credenciais herdadas nunca vão
 * para outro host por engano.
 */
function targetUrl(url: string, baseUrl: string | undefined, connector: ResolvedConnector): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    if (baseUrl && originOf(url) !== originOf(baseUrl)) {
      throw new ConfigError(
        `a URL ${originOf(url) ?? url} não é da origem do conector (${originOf(baseUrl) ?? baseUrl}); use um caminho relativo como /recurso`
      )
    }
    return url
  }
  if (!baseUrl) throw new ConfigError(`o conector "${connector.id}" não define baseUrl; use uma URL absoluta`)
  const [path = '', query] = splitQuery(url)
  const joined = joinPath(baseUrl, connector.basePath, path)
  return query === undefined ? joined : `${joined}?${query}`
}

function splitQuery(url: string): [string, string | undefined] {
  const i = url.indexOf('?')
  return i < 0 ? [url, undefined] : [url.slice(0, i), url.slice(i + 1)]
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

function withQuery(url: string, query: [string, string][]): string {
  if (!query.length) return url
  const parsed = new URL(url)
  for (const [name, value] of query) parsed.searchParams.set(name, value)
  return parsed.toString()
}

/** Os headers de `over` substituem os de `base` com o mesmo nome (sem diferenciar maiúsculas). */
export function mergeHeaders(base: HttpHeader[], over: HttpHeader[]): HttpHeader[] {
  const names = new Set(over.map((h) => h.name.trim().toLowerCase()))
  return [...base.filter((h) => !names.has(h.name.trim().toLowerCase())), ...over]
}

/** Lê os arquivos do certificado (caminhos relativos ao workspace). A key do pool é o hash do conteúdo. */
async function loadTls(tls: ConnectorTls, dir: string, scope: VariableScope): Promise<NonNullable<SendOptions['tls']>> {
  const hash = createHash('sha256')
  const read = async (field: 'cert' | 'key' | 'pfx' | 'ca'): Promise<Buffer | undefined> => {
    const raw = tls[field]
    if (raw === undefined) return undefined
    const path = interpolate(raw, scope)
    const full = isAbsolute(path) ? path : join(dir, path)
    try {
      const data = await readFile(full)
      hash.update(field).update(data)
      return data
    } catch (err) {
      throw new ConfigError(`mTLS: não foi possível ler ${field} (${path}): ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`)
    }
  }
  const connect: TlsConnectOptions = {}
  const [cert, key, pfx, ca] = [await read('cert'), await read('key'), await read('pfx'), await read('ca')]
  if (cert) connect.cert = cert
  if (key) connect.key = key
  if (pfx) connect.pfx = pfx
  if (ca) connect.ca = ca
  if (tls.passphrase !== undefined) {
    connect.passphrase = interpolate(tls.passphrase, scope)
    hash.update('passphrase').update(connect.passphrase)
  }
  return { key: hash.digest('base64url'), connect }
}

/**
 * A conexão de um conector já resolvida (baseUrl com basePath, headers herdados com a auth
 * aplicada, credenciais e mTLS), para um plugin que fala um protocolo próprio e declara
 * `permissions.connectorCredentials` (gRPC, Kafka). O processo do plugin só conecta aos
 * hosts do conector e do nó, então as credenciais só seguem para lá (docs/plugins.md).
 */
/**
 * Roda só a auth de um conector (o login de um fluxo-base, o OAuth2), sem a requisição: é o
 * "rodar a base" do Flow Studio e do execute_flow. Pede um token novo (o teste é o login de
 * verdade) e o deixa no cache, que é o mesmo das requisições. null: a auth não pede token.
 */
export async function testConnectorAuth(
  connectorId: string,
  environmentId: string | undefined,
  ctx: HeadlessContext
): Promise<AppliedAuth | null> {
  const connector = resolveConnector(connectorId, ctx.workspace.connectors)
  if (!connector.auth || !AUTH_CONTRACT[connector.auth.config.type].renewable) return null
  const { values, missingSecrets } = environmentValues(ctx.workspace, environmentId)
  const scope: VariableScope = { values, missingSecrets }
  const baseUrl = connector.baseUrl === undefined ? undefined : interpolate(connector.baseUrl, scope)
  const options: SendOptions = connector.tls ? { tls: await loadTls(connector.tls.config, ctx.workspace.dir, scope) } : {}
  return ctx.auth.apply({
    connector,
    scopeKey: `${ctx.workspace.dir}\0${environmentId ?? ''}`,
    scope,
    baseUrl,
    send: (req) => ctx.http.send(req, options),
    forceRefresh: true,
    ...(ctx.guard && { interactive: false }),
    signal: ctx.signal
  })
}

export interface ConnectorConnection {
  /** baseUrl + basePath, com as variáveis do ambiente resolvidas (ex.: grpcs://api:443, kafka://b1:9092). */
  url: string
  /** Headers do conector e os da auth (Authorization...), por nome em minúsculas. */
  headers: Record<string, string>
  /** Parâmetros de query da auth (apiKey em query). */
  query: Record<string, string>
  /** Credenciais da auth do conector, para protocolos que não usam headers (SASL do Kafka). */
  auth?: { type: string; username?: string; password?: string; token?: string }
  /** mTLS do conector: PEM em texto, pfx em base64. */
  tls?: { ca?: string; cert?: string; key?: string; pfx?: string; passphrase?: string }
}

export async function resolveConnection(connectorId: string, environmentId: string | undefined, ctx: HeadlessContext): Promise<ConnectorConnection> {
  const { values, missingSecrets } = environmentValues(ctx.workspace, environmentId)
  const scope: VariableScope = { values, missingSecrets }
  const v = (text: string) => interpolate(text, scope)
  const connector = resolveConnector(connectorId, ctx.workspace.connectors)
  if (connector.baseUrl === undefined) throw new ConfigError(`o conector "${connector.id}" não define baseUrl`)
  const baseUrl = v(connector.baseUrl)
  const url = joinPath(baseUrl, connector.basePath ?? '')
  const tls = connector.tls ? await loadTls(connector.tls.config, ctx.workspace.dir, scope) : undefined
  const options: SendOptions = tls ? { tls } : {}
  const applied = await ctx.auth.apply({
    connector,
    scopeKey: `${ctx.workspace.dir}\0${environmentId ?? ''}`,
    scope,
    baseUrl,
    send: (req) => ctx.http.send(req, options),
    signal: ctx.signal
  })
  const headers: Record<string, string> = {}
  for (const h of mergeHeaders(
    Object.entries(connector.headers ?? {}).map(([name, value]) => ({ name, value: v(value) })),
    applied?.headers ?? []
  )) {
    headers[h.name.toLowerCase()] = h.value
  }
  const config = connector.auth?.config
  let auth: ConnectorConnection['auth']
  if (config?.type === 'basic' || config?.type === 'digest' || config?.type === 'ntlm') {
    auth = { type: config.type, username: v(config.username), password: v(config.password) }
  }
  else if (config) {
    const value = applied?.headers[0]?.value ?? applied?.query[0]?.[1]
    auth = { type: config.type, ...(value && { token: value.replace(/^Bearer\s+/i, '') }) }
  }
  const c = tls?.connect
  return {
    url,
    headers,
    query: Object.fromEntries(applied?.query ?? []),
    ...(auth && { auth }),
    ...(c && {
      tls: {
        ...(c.ca && { ca: c.ca.toString() }),
        ...(c.cert && { cert: c.cert.toString() }),
        ...(c.key && { key: c.key.toString() }),
        ...(c.pfx && { pfx: Buffer.from(c.pfx as Buffer).toString('base64') }),
        ...(c.passphrase && { passphrase: c.passphrase })
      }
    })
  }
}

/** A abertura de uma conexão realtime já resolvida: URL http(s), headers com a auth e o mTLS. */
export interface ResolvedHandshake {
  /** URL http(s) com a query da auth; o WebSocket troca o esquema para ws(s). */
  url: string
  headers: HttpHeader[]
  tls?: NonNullable<SendOptions['tls']>
  /** Nomes (em minúsculas) dos headers que carregam credencial: o da auth do conector e os de nome sensível. */
  secretHeaders: string[]
  auth?: AuthUsage
  /** Resolve {{VAR}} das mensagens enviadas com o mesmo ambiente da abertura. */
  interpolate: (text: string) => string
}

/**
 * Abertura de WebSocket, SSE e Socket.IO (fase 15) com a herança do sendHeadless: URL relativa à
 * baseUrl + basePath, headers do conector, auth em segundo plano e mTLS. Uma URL ws(s):// vale na
 * origem http(s) do conector. A auth por desafio (Digest, NTLM) responde a um 401 por requisição
 * e não abre conexão persistente: volta CONFIG_ERROR para usar um header de auth na aba.
 */
export async function resolveHandshake(
  input: Pick<HttpRequestInput, 'url' | 'headers' | 'connectorId' | 'environmentId'> & { method?: HttpRequestInput['method']; body?: string },
  ctx: HeadlessContext
): Promise<ResolvedHandshake> {
  const { values, missingSecrets } = environmentValues(ctx.workspace, input.environmentId)
  const scope: VariableScope = { values, missingSecrets }
  const v = (text: string) => interpolate(text, scope)
  const connector = input.connectorId ? resolveConnector(input.connectorId, ctx.workspace.connectors) : undefined
  const baseUrl = connector?.baseUrl === undefined ? undefined : asHttp(v(connector.baseUrl))
  const typed = asHttp(v(input.url.trim()))
  const url = connector ? targetUrl(typed, baseUrl, connector) : typed
  if (!/^https?:\/\//i.test(url)) throw new ConfigError(`URL inválida para a conexão: ${url || '(vazia)'}`)
  const headers = mergeHeaders(
    Object.entries(connector?.headers ?? {}).map(([name, value]) => ({ name, value: v(value) })),
    input.headers.filter((h) => h.name.trim()).map((h) => ({ name: h.name, value: v(h.value) }))
  )
  const tls = connector?.tls ? await loadTls(connector.tls.config, ctx.workspace.dir, scope) : undefined
  const authConfig = connector?.auth?.config
  const authHeader = authConfig && authHeaderName(authConfig)?.toLowerCase()
  const overridden = authHeader !== undefined && headers.some((h) => h.name.toLowerCase() === authHeader)
  const applied =
    connector && !overridden
      ? await ctx.auth.apply({
          connector,
          scopeKey: `${ctx.workspace.dir}\0${input.environmentId ?? ''}`,
          scope,
          baseUrl,
          send: (req) => ctx.http.send(req, tls ? { tls } : {}),
          signal: ctx.signal
        })
      : null
  if (applied?.challenge) {
    throw new ConfigError(`a auth ${authConfig?.type} do conector responde a um desafio por requisição e não abre conexão persistente; mande o header de auth na aba`)
  }
  const finalUrl = withQuery(url, applied?.query ?? [])
  let finalHeaders = mergeHeaders(headers, applied?.headers ?? [])
  const method = input.method ?? 'GET'
  if (applied?.sign) {
    const body = input.body === undefined ? undefined : v(input.body)
    finalHeaders = mergeHeaders(finalHeaders, applied.sign({ method, url: finalUrl, headers: finalHeaders, ...(body !== undefined && { body }) }))
  }
  return {
    url: finalUrl,
    headers: finalHeaders,
    ...(tls && { tls }),
    secretHeaders: [...new Set([...(authHeader ? [authHeader] : []), ...(applied?.headers ?? []).map((h) => h.name.toLowerCase())])],
    ...(applied && { auth: applied.usage }),
    interpolate: v
  }
}

/** ws:// e wss:// viram http:// e https:// para casar com a origem do conector. */
const asHttp = (url: string) => url.replace(/^ws(s?):\/\//i, 'http$1://')
