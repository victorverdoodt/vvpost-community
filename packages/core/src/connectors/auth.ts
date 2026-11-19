import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AuthLogin, AuthOAuth2 } from '@vvpost/schemas'
import type { AuthUsage, HttpHeader, HttpRequestInput, HttpResponseData, HttpResult } from '../types'
import { AUTH_CONTRACT } from './auth-contract'
import {
  challengesOf,
  digestAuthorization,
  ntlmAuthenticate,
  ntlmNegotiate,
  parseNtlmChallenge,
  signOAuth1,
  signSigV4,
  type SignableRequest
} from './auth-sign'
import { AuthError, ConfigError } from './errors'
import type { ResolvedConnector } from './resolve'
import { interpolate, interpolateDeep, type VariableScope } from './template'

/** Tokens são renovados um pouco antes de expirar, para não morrerem no meio da requisição. */
const EXPIRY_SKEW_MS = 30_000
const AUTH_TIMEOUT_MS = 30_000
/** Quanto o login pelo navegador (authorization_code) espera o usuário voltar. */
const BROWSER_LOGIN_TIMEOUT_MS = 5 * 60_000

export interface AuthRequest {
  connector: ResolvedConnector
  /** Chave do contexto de variáveis (workspace + ambiente): tokens não vazam entre ambientes. */
  scopeKey: string
  scope: VariableScope
  /** baseUrl do conector já interpolada, para tokenUrl e login relativos. */
  baseUrl: string | undefined
  /** Dispara pelo dispatcher com o mesmo certificado mTLS do conector. */
  send: (input: HttpRequestInput) => Promise<HttpResult>
  /** Ignora o token em cache e busca outro (ex.: depois de um 401). */
  forceRefresh?: boolean
  /** false: ninguém do outro lado (hook, MCP com política); o login no navegador nunca abre. */
  interactive?: boolean
  signal?: AbortSignal
}

export interface AppliedAuth {
  headers: HttpHeader[]
  query: [string, string][]
  usage: AuthUsage
  /** O token veio de um fluxo (OAuth2, login) e pode ser buscado de novo após um 401. */
  renewable: boolean
  /** Assina a requisição final (AWS SigV4, OAuth 1.0): headers que dependem do método, da URL e do corpo. */
  sign?: (req: SignableRequest) => HttpHeader[]
  /** Auth por desafio (Digest, NTLM): `headers` vão na primeira tentativa, e o 401 do servidor é respondido uma vez. */
  challenge?: {
    respond(res: HttpResponseData, req: { method: string; url: string }): HttpHeader[] | null
    /** O handshake precisa da mesma conexão do começo ao fim (NTLM): requisições com a mesma chave não se intercalam. */
    affinity?: string
  }
}

/** O que o motor pede a quem roda a auth com uma pessoa do outro lado (app, CLI). */
export interface AuthHooks {
  /**
   * Abre o login do provedor no navegador do sistema (OAuth2 authorization_code). Sem ele (MCP,
   * hooks, processos sem pessoa), o motor só usa token em cache ou refresh_token.
   */
  openBrowser?: (url: string) => void | Promise<void>
}

interface Token {
  /** Valor pronto para o header/query (ex.: "Bearer abc"). */
  value: string
  expiresAt?: number
  refreshToken?: string
}

/**
 * Executa a auth do conector em segundo plano. Tokens de OAuth2 e de
 * login ficam só em memória, por conector + contexto de variáveis, e pedidos
 * simultâneos dividem o mesmo fluxo em vez de abrir um por requisição.
 */
export function createAuthEngine(now: () => number = Date.now, hooks: AuthHooks = {}) {
  const cache = new Map<string, Token>()
  const pending = new Map<string, Promise<{ token: Token; source: AuthUsage['source'] }>>()

  async function apply(req: AuthRequest): Promise<AppliedAuth | null> {
    const auth = req.connector.auth
    if (!auth) return null
    const { config, from } = auth
    const started = performance.now()
    const done = (
      headers: HttpHeader[],
      query: [string, string][],
      source: AuthUsage['source'],
      token?: Token
    ): AppliedAuth => ({
      headers,
      query,
      renewable: AUTH_CONTRACT[config.type].renewable,
      usage: {
        type: config.type,
        from,
        source,
        ms: Math.round((performance.now() - started) * 100) / 100,
        ...(token?.expiresAt !== undefined && { expiresAt: token.expiresAt })
      }
    })
    const v = (text: string) => interpolate(text, req.scope)

    switch (config.type) {
      case 'bearer': {
        const prefix = config.prefix ?? 'Bearer'
        const token = v(config.token)
        return done([{ name: config.header ?? 'Authorization', value: prefix ? `${prefix} ${token}` : token }], [], 'static')
      }
      case 'apiKey': {
        const pair: [string, string] = [config.name, v(config.value)]
        return config.in === 'query'
          ? done([], [pair], 'static')
          : done([{ name: pair[0], value: pair[1] }], [], 'static')
      }
      case 'basic': {
        const encoded = Buffer.from(`${v(config.username)}:${v(config.password)}`).toString('base64')
        return done([{ name: 'Authorization', value: `Basic ${encoded}` }], [], 'static')
      }
      case 'digest': {
        const creds = { username: v(config.username), password: v(config.password) }
        return {
          ...done([], [], 'static'),
          challenge: {
            respond: (res, sent) => {
              const value = digestAuthorization(challengesOf(res.headers, 'Digest'), sent, creds)
              return value ? [{ name: 'Authorization', value }] : null
            }
          }
        }
      }
      case 'ntlm': {
        const creds = {
          username: v(config.username),
          password: v(config.password),
          ...(config.domain !== undefined && { domain: v(config.domain) }),
          ...(config.workstation !== undefined && { workstation: v(config.workstation) })
        }
        return {
          ...done([{ name: 'Authorization', value: `NTLM ${ntlmNegotiate()}` }], [], 'static'),
          challenge: {
            respond: (res) => {
              const [offer] = challengesOf(res.headers, 'NTLM')
              const parsed = offer && parseNtlmChallenge(offer.slice(4).trim())
              return parsed ? [{ name: 'Authorization', value: `NTLM ${ntlmAuthenticate(parsed, creds)}` }] : null
            },
            affinity: createHash('sha256').update(`${from}\0${req.scopeKey}\0${creds.domain ?? ''}\\${creds.username}`).digest('base64url')
          }
        }
      }
      case 'awsSigV4': {
        const creds = {
          accessKeyId: v(config.accessKeyId),
          secretAccessKey: v(config.secretAccessKey),
          ...(config.sessionToken !== undefined && { sessionToken: v(config.sessionToken) }),
          region: v(config.region),
          service: v(config.service)
        }
        return { ...done([], [], 'static'), sign: (sent) => signSigV4(sent, creds, new Date(now())) }
      }
      case 'oauth1': {
        const creds = {
          consumerKey: v(config.consumerKey),
          consumerSecret: v(config.consumerSecret),
          ...(config.token !== undefined && { token: v(config.token) }),
          ...(config.tokenSecret !== undefined && { tokenSecret: v(config.tokenSecret) }),
          ...(config.signatureMethod && { signatureMethod: config.signatureMethod }),
          ...(config.realm !== undefined && { realm: v(config.realm) })
        }
        return { ...done([], [], 'static'), sign: (sent) => signOAuth1(sent, creds, { timestamp: Math.floor(now() / 1000) }) }
      }
      case 'oauth2':
      case 'login': {
        const key = cacheKey(req, from, config)
        const { token, source } = await obtain(key, req, config)
        if (config.type === 'oauth2') return done([{ name: 'Authorization', value: token.value }], [], source, token)
        const inject = config.inject ?? {}
        const name = inject.name ?? 'Authorization'
        return inject.in === 'query'
          ? done([], [[name, token.value]], source, token)
          : done([{ name, value: token.value }], [], source, token)
      }
    }
  }

  async function obtain(key: string, req: AuthRequest, config: AuthOAuth2 | AuthLogin) {
    const cached = cache.get(key)
    if (cached && !req.forceRefresh && !isExpired(cached)) return { token: cached, source: 'cache' as const }
    let flow = pending.get(key)
    if (!flow) {
      flow = (async () => {
        // Depois de expirar, o refresh_token evita repetir o grant inteiro.
        if (cached?.refreshToken && config.type === 'oauth2') {
          const refreshed = await oauth2Token(req, config, cached.refreshToken).catch(() => null)
          if (refreshed) return { token: refreshed, source: 'refreshed' as const }
        }
        const token =
          config.type === 'login'
            ? await loginToken(req, config)
            : config.grantType === 'authorization_code'
              ? await authorizationCode(req, config)
              : await oauth2Token(req, config)
        return { token, source: 'fetched' as const }
      })()
        .then((r) => {
          cache.set(key, r.token)
          return r
        })
        .finally(() => pending.delete(key))
      pending.set(key, flow)
    }
    // Cancelar a requisição não cancela o fluxo, que pode estar servindo outras.
    return req.signal ? raceAbort(flow, req.signal) : flow
  }

  function isExpired(token: Token): boolean {
    if (token.expiresAt === undefined) return false
    return now() >= token.expiresAt - EXPIRY_SKEW_MS
  }

  function expiry(seconds: unknown, fallbackSeconds?: number): number | undefined {
    const n = typeof seconds === 'string' ? Number(seconds) : seconds
    const s = typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallbackSeconds
    return s === undefined ? undefined : now() + s * 1000
  }

  /**
   * OAuth2 authorization_code com PKCE (RFC 7636 e 8252): abre o login do provedor no navegador
   * do sistema, recebe o code num servidor de loopback só pelo tempo do login e troca pelo token.
   */
  async function authorizationCode(req: AuthRequest, config: AuthOAuth2): Promise<Token> {
    if (!hooks.openBrowser || req.interactive === false) {
      throw new AuthError('OAuth2 authorization_code precisa do login no navegador: entre pelo app ou pelo CLI e tente de novo')
    }
    const v = (text: string) => interpolate(text, req.scope)
    if (!config.authUrl) throw new ConfigError('OAuth2 authorization_code exige authUrl')
    const parse = (text: string, field: string) => {
      try {
        return new URL(text)
      } catch {
        throw new ConfigError(`${field} inválida: ${text}`)
      }
    }
    const redirect = parse(config.redirectUri ? v(config.redirectUri) : 'http://127.0.0.1/callback', 'redirectUri')
    if (redirect.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname)) {
      throw new ConfigError(`redirectUri precisa ser http em loopback (127.0.0.1, localhost ou [::1]); veio ${redirect.origin}`)
    }
    const state = randomBytes(16).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const pkce = config.pkce !== false

    const server = createServer()
    let settle: { resolve: (code: string) => void; reject: (err: Error) => void } | undefined
    const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }))
    server.on('request', (r, res) => {
      const got = new URL(r.url ?? '/', redirect)
      if (got.pathname !== redirect.pathname) {
        res.writeHead(404).end()
        return
      }
      const error = got.searchParams.get('error')
      const ok = !error && got.searchParams.get('state') === state && !!got.searchParams.get('code')
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        `<!doctype html><meta charset="utf-8"><title>VVPost</title><body style="font-family:sans-serif;padding:2rem">${
          ok ? 'Login concluído. Pode fechar esta aba e voltar ao VVPost.' : 'O login não foi concluído. Volte ao VVPost para ver o motivo.'
        }</body>`
      )
      if (error) settle!.reject(new AuthError(`o provedor recusou o login (${[error, got.searchParams.get('error_description')].filter(Boolean).join(': ')})`))
      else if (got.searchParams.get('state') !== state) settle!.reject(new AuthError('o retorno do login veio com state diferente; tente de novo'))
      else if (ok) settle!.resolve(got.searchParams.get('code')!)
    })
    const host = redirect.hostname.replace(/^\[|\]$/g, '')
    await new Promise<void>((resolve, reject) => {
      server.once('error', (err) => reject(new ConfigError(`não foi possível abrir ${redirect.host} para receber o login: ${(err as NodeJS.ErrnoException).code ?? err.message}`)))
      server.listen(Number(redirect.port || 0), host, resolve)
    })
    try {
      const port = (server.address() as { port: number }).port
      const redirectUri = new URL(redirect)
      redirectUri.port = String(port)
      const target = parse(v(config.authUrl), 'authUrl')
      if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new ConfigError(`authUrl precisa ser http ou https; veio ${target.protocol}`)
      const q = target.searchParams
      q.set('response_type', 'code')
      q.set('client_id', v(config.clientId))
      q.set('redirect_uri', redirectUri.toString())
      q.set('state', state)
      if (config.scope) q.set('scope', v(config.scope))
      if (config.audience) q.set('audience', v(config.audience))
      if (pkce) {
        q.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'))
        q.set('code_challenge_method', 'S256')
      }
      await hooks.openBrowser(target.toString())
      const timeout = new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new AuthError('o login no navegador não terminou em 5 minutos')), BROWSER_LOGIN_TIMEOUT_MS)
        t.unref?.()
        void code.catch(() => {}).finally(() => clearTimeout(t))
      })
      const got = await (req.signal ? raceAbort(Promise.race([code, timeout]), req.signal) : Promise.race([code, timeout]))
      return await oauth2Token(req, config, undefined, {
        code: got,
        redirect_uri: redirectUri.toString(),
        ...(pkce && { code_verifier: verifier })
      })
    } finally {
      server.close()
      server.closeAllConnections()
    }
  }

  async function oauth2Token(req: AuthRequest, config: AuthOAuth2, refreshToken?: string, grant?: Record<string, string>): Promise<Token> {
    const v = (text: string) => interpolate(text, req.scope)
    // Os campos são os mesmos nos dois formatos; json só muda como o corpo é serializado.
    const form = new Map<string, string>()
    const json = config.tokenRequestFormat === 'json'
    const headers: HttpHeader[] = [
      { name: 'Content-Type', value: json ? 'application/json' : 'application/x-www-form-urlencoded' },
      { name: 'Accept', value: 'application/json' }
    ]
    if (refreshToken) {
      form.set('grant_type', 'refresh_token')
      form.set('refresh_token', refreshToken)
    } else {
      form.set('grant_type', config.grantType)
      for (const [k, val] of Object.entries(grant ?? {})) form.set(k, val)
      if (config.grantType === 'password') {
        form.set('username', v(config.username ?? ''))
        form.set('password', v(config.password ?? ''))
      }
      if (config.audience) form.set('audience', v(config.audience))
      for (const [k, val] of Object.entries(config.extraParams ?? {})) form.set(k, v(val))
    }
    if (config.scope) form.set('scope', v(config.scope))
    const clientId = v(config.clientId)
    const clientSecret = config.clientSecret === undefined ? undefined : v(config.clientSecret)
    if (config.clientAuthentication === 'body' || clientSecret === undefined) {
      form.set('client_id', clientId)
      if (clientSecret !== undefined) form.set('client_secret', clientSecret)
    } else {
      // RFC 6749 2.3.1: id e segredo passam por form-urlencode antes do base64 (também com corpo JSON).
      const pair = `${formEncode(clientId)}:${formEncode(clientSecret)}`
      headers.push({ name: 'Authorization', value: `Basic ${Buffer.from(pair).toString('base64')}` })
    }

    const res = await call(req, {
      method: 'POST',
      url: resolveUrl(v(config.tokenUrl), req.baseUrl, 'tokenUrl'),
      headers,
      body: json ? JSON.stringify(Object.fromEntries(form)) : new URLSearchParams([...form]).toString()
    })
    const body = parseJson(res.body)
    if (res.status < 200 || res.status >= 300) {
      const detail = isRecord(body)
        ? [body['error'], body['error_description']].filter((x) => typeof x === 'string').join(': ')
        : ''
      throw new AuthError(`token endpoint respondeu ${res.status}${detail ? ` (${detail})` : snippet(res.body)}`)
    }
    if (!isRecord(body) || typeof body['access_token'] !== 'string' || !body['access_token']) {
      throw new AuthError('resposta do token endpoint sem access_token')
    }
    const type = typeof body['token_type'] === 'string' ? body['token_type'] : 'Bearer'
    return {
      // "bearer" minúsculo é comum nas respostas; vários servidores só aceitam "Bearer".
      value: `${type.toLowerCase() === 'bearer' ? 'Bearer' : type} ${body['access_token']}`,
      expiresAt: expiry(body['expires_in']),
      refreshToken:
        typeof body['refresh_token'] === 'string' ? body['refresh_token'] : refreshToken
    }
  }

  async function loginToken(req: AuthRequest, config: AuthLogin): Promise<Token> {
    const v = (text: string) => interpolate(text, req.scope)
    const { request } = config
    const headers: HttpHeader[] = Object.entries(request.headers ?? {}).map(([name, value]) => ({
      name,
      value: v(value)
    }))
    const has = (name: string) => headers.some((h) => h.name.toLowerCase() === name)
    let body: string | undefined
    if (request.json !== undefined) {
      body = JSON.stringify(interpolateDeep(request.json, req.scope))
      if (!has('content-type')) headers.push({ name: 'Content-Type', value: 'application/json' })
    } else if (request.form) {
      body = new URLSearchParams(Object.entries(request.form).map(([k, val]): [string, string] => [k, v(val)])).toString()
      if (!has('content-type')) headers.push({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' })
    } else if (request.body !== undefined) {
      body = v(request.body)
    }

    const res = await call(req, {
      method: request.method ?? 'POST',
      url: resolveUrl(v(request.url), req.baseUrl, 'login'),
      headers,
      body
    })
    if (res.status < 200 || res.status >= 300) {
      throw new AuthError(`login respondeu ${res.status}${snippet(res.body)}`)
    }
    const raw = extract(res, config.token)
    if ((typeof raw !== 'string' && typeof raw !== 'number') || raw === '') {
      throw new AuthError(`token não encontrado em ${config.token} na resposta do login`)
    }
    const token = String(raw)
    const template = config.inject?.value ?? 'Bearer {{$token}}'
    return {
      value: interpolate(template, { ...req.scope, extra: { $token: token } }),
      expiresAt: expiry(config.expiresIn ? extract(res, config.expiresIn) : undefined, config.ttlSeconds)
    }
  }

  async function call(req: AuthRequest, input: Omit<HttpRequestInput, 'id'>): Promise<HttpResponseData> {
    const result = await req.send({ id: `auth:${crypto.randomUUID()}`, timeoutMs: AUTH_TIMEOUT_MS, ...input })
    if (!result.ok) throw new AuthError(`${input.url}: ${result.error.code} (${result.error.message})`)
    return result.response
  }

  return {
    apply,
    /** Esquece tokens: de um conector (o que define a auth), ou todos. */
    clear(connectorId?: string): void {
      if (!connectorId) return cache.clear()
      for (const key of cache.keys()) if (key.startsWith(`${connectorId}\0`)) cache.delete(key)
    }
  }
}

export type AuthEngine = ReturnType<typeof createAuthEngine>

/**
 * Mesma auth, mesmas variáveis: mesmo token. Entra o texto cru da config e os
 * valores do ambiente (não a config interpolada, que muda a cada {{$uuid}}).
 */
function cacheKey(req: Pick<AuthRequest, 'scopeKey' | 'scope'>, from: string, config: unknown): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(config))
    .update('\0')
    .update(req.scopeKey)
    .update('\0')
    .update(JSON.stringify([...req.scope.values].sort(([a], [b]) => a.localeCompare(b))))
    .digest('base64url')
  return `${from}\0${hash}`
}

/** URL absoluta, ou caminho relativo à baseUrl do conector. */
export function resolveUrl(url: string, baseUrl: string | undefined, field: string): string {
  if (/^https?:\/\//i.test(url)) return url
  if (!baseUrl) throw new ConfigError(`${field} relativo ("${url}") exige baseUrl no conector`)
  return `${baseUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`
}

/** Lê body.<caminho> (com .chave e [índice]) ou headers.<nome> da resposta. */
function extract(res: HttpResponseData, path: string): unknown {
  if (path.startsWith('headers.')) {
    const name = path.slice('headers.'.length).toLowerCase()
    return res.headers.find((h) => h.name.toLowerCase() === name)?.value
  }
  let current: unknown = parseJson(res.body)
  for (const part of path.slice('body'.length).match(/[^.[\]]+/g) ?? []) {
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)]
    else if (isRecord(current)) current = current[part]
    else return undefined
  }
  return current
}

function formEncode(text: string): string {
  return encodeURIComponent(text).replace(/%20/g, '+')
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function snippet(body: string): string {
  const text = body.trim().replace(/\s+/g, ' ')
  return text ? `: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}` : ''
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
