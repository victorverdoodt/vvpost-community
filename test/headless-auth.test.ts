import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Connector } from '@vvpost/schemas'
import type { HttpRequestInput, HttpResult } from '@shared/ipc'
import { createAuthEngine, type AuthEngine } from '@vvpost/core/connectors/auth'
import { sendHeadless } from '@vvpost/core/connectors/headless'
import { resolveConnector } from '@vvpost/core/connectors/resolve'
import { summarizeWorkspace } from '@vvpost/core/connectors/summary'
import { interpolate, totp } from '@vvpost/core/connectors/template'
import { loadWorkspace, type LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import { createHttpDispatcher, type HttpDispatcher } from '@vvpost/core/http/dispatcher'
import { createTestPki } from './helpers/test-pki'

describe('variáveis {{VAR}}', () => {
  const scope = { values: new Map([['HOST', 'api.exemplo.com']]), missingSecrets: new Set(['TOKEN']) }

  it('troca variáveis do ambiente e dinâmicas', () => {
    expect(interpolate('https://{{ HOST }}/x', scope)).toBe('https://api.exemplo.com/x')
    expect(interpolate('{{$uuid}}', scope)).toMatch(/^[0-9a-f-]{36}$/)
    expect(Number(interpolate('{{$timestamp}}', scope))).toBeGreaterThan(1_700_000_000)
  })

  it('falha com variável ausente e explica quando é segredo sem valor local', () => {
    expect(() => interpolate('{{NOPE}}', scope)).toThrow('{{NOPE}} não definida')
    expect(() => interpolate('{{TOKEN}}', scope)).toThrow('sem valor no cofre local')
    expect(() => interpolate('{{$nope}}', scope)).toThrow('dinâmica desconhecida')
  })

  it('gera TOTP do RFC 6238 (vetor de teste SHA-1)', () => {
    // Semente "12345678901234567890" em base32; em T=59 s o código de 8 dígitos é 94287082.
    expect(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082')
    expect(totp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', 1_111_111_109_000)).toBe('081804')
  })
})

describe('herança de conectores', () => {
  const catalog = (...list: Connector[]) => new Map(list.map((c) => [c.id, c]))
  const base: Connector = {
    id: 'base',
    name: 'Base',
    version: '1.0.0',
    config: {
      baseUrl: 'https://api.exemplo.com/',
      basePath: '/v1',
      headers: { 'X-Trace': 'x', 'X-Tenant': 'a' },
      auth: { type: 'bearer', token: '{{T}}' },
      tls: { pfx: 'certs/a.p12' }
    }
  }

  it('acumula basePath, sobrescreve headers sem diferenciar maiúsculas e herda auth e tls', () => {
    const child: Connector = {
      id: 'child',
      name: 'Filho',
      version: '1.0.0',
      extends: 'base',
      config: { basePath: '/billing', headers: { 'x-tenant': 'b' } }
    }
    const r = resolveConnector('child', catalog(base, child))
    expect(r.chain).toEqual(['base', 'child'])
    expect(r.basePath).toBe('/v1/billing')
    expect(r.headers).toEqual({ 'X-Trace': 'x', 'x-tenant': 'b' })
    expect(r.warnings).toEqual([])
    expect(r.auth).toEqual({ config: base.config!.auth, from: 'base' })
    expect(r.tls?.from).toBe('base')
  })

  it('auth none no filho desliga a do pai', () => {
    const child: Connector = { id: 'c', name: 'C', version: '1.0.0', extends: 'base', config: { auth: { type: 'none' } } }
    expect(resolveConnector('c', catalog(base, child)).auth).toBeUndefined()
  })

  it('aponta pai ausente e herança circular', () => {
    const orphan: Connector = { id: 'o', name: 'O', version: '1.0.0', extends: 'sumiu' }
    expect(() => resolveConnector('o', catalog(orphan))).toThrow('"o" herda de "sumiu"')
    const a: Connector = { id: 'a', name: 'A', version: '1.0.0', extends: 'b' }
    const b: Connector = { id: 'b', name: 'B', version: '1.0.0', extends: 'a' }
    expect(() => resolveConnector('a', catalog(a, b))).toThrow('herança circular: a → b → a')
  })
})

// --- Servidor de teste: token endpoint OAuth2, login próprio e API protegida ---

let server: Server
let origin: string
const calls: { path: string; headers: IncomingMessage['headers']; body: string }[] = []
let issued = 0
/** Tokens que o servidor ainda aceita. Revogar simula um token que expirou do lado do servidor. */
const valid = new Set<string>()
let tokenDelayMs = 0

async function readAll(req: IncomingMessage): Promise<string> {
  let data = ''
  for await (const chunk of req) data += chunk
  return data
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x')
  const body = await readAll(req)
  calls.push({ path: url.pathname + url.search, headers: req.headers, body })
  if (url.pathname === '/oauth/token') {
    if (tokenDelayMs) await new Promise((r) => setTimeout(r, tokenDelayMs))
    // Corpo JSON (tokenRequestFormat: json) ou form, com os mesmos campos.
    const form = req.headers['content-type'] === 'application/json'
      ? new URLSearchParams(JSON.parse(body) as Record<string, string>)
      : new URLSearchParams(body)
    const clientOk =
      req.headers.authorization === `Basic ${Buffer.from('app%2Bid:s3cr%26t').toString('base64')}` ||
      (form.get('client_id') === 'app+id' && form.get('client_secret') === 's3cr&t')
    if (!clientOk) return json(res, 401, { error: 'invalid_client', error_description: 'segredo errado' })
    if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') !== 'r1') {
      return json(res, 400, { error: 'invalid_grant' })
    }
    const token = `tok-${++issued}`
    valid.add(token)
    return json(res, 200, { access_token: token, token_type: 'bearer', expires_in: 3600, refresh_token: 'r1' })
  }
  if (url.pathname === '/auth/login') {
    const { user, password, otp } = JSON.parse(body || '{}')
    if (user !== 'ana' || password !== 'pw' || !/^\d{6}$/.test(otp)) return json(res, 403, { message: 'negado' })
    const token = `sess-${++issued}`
    valid.add(token)
    res.setHeader('x-session-token', token)
    return json(res, 200, { data: { token, ttl: 120 } })
  }
  const presented =
    req.headers.authorization?.replace(/^Bearer /, '') ??
    (req.headers['x-session'] as string | undefined) ??
    url.searchParams.get('session') ??
    url.searchParams.get('api_key')
  if (!presented || !valid.has(presented)) return json(res, 401, { error: 'unauthorized' })
  return json(res, 200, { path: url.pathname, token: presented, tenant: req.headers['x-tenant'] ?? null })
}

let http: HttpDispatcher
beforeAll(async () => {
  server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  http = createHttpDispatcher()
})
afterAll(async () => {
  await http.close()
  server.close()
})

let dir: string
let clock: number
let engine: AuthEngine
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vvpost-headless-'))
  calls.length = 0
  valid.clear()
  issued = 0
  tokenDelayMs = 0
  clock = Date.now()
  engine = createAuthEngine(() => clock)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function write(path: string, data: unknown): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}

const connector = (id: string, config: Connector['config'], extra: Partial<Connector> = {}): Connector => ({
  $schema: 'https://vvpost.dev/schemas/v1/connector.json',
  id,
  name: id,
  version: '1.0.0',
  config,
  ...extra
})

/** Workspace com base OAuth2 (client credentials) e um filho Billing, o exemplo do guia. */
async function oauthWorkspace(auth: Partial<Record<string, unknown>> = {}): Promise<LoadedWorkspace> {
  write('connectors/base.connector.vvpost.json', connector('corp.base', {
    baseUrl: '{{BASE_URL}}',
    headers: { 'X-Tenant': '{{TENANT}}' },
    auth: {
      type: 'oauth2',
      grantType: 'client_credentials',
      tokenUrl: '/oauth/token',
      clientId: '{{CLIENT_ID}}',
      clientSecret: '{{CLIENT_SECRET}}',
      ...auth
    } as never
  }))
  write('connectors/billing/billing.connector.vvpost.json', connector('billing.v2', { basePath: '/billing/v2' }, {
    extends: 'corp.base',
    endpoints: [{ id: 'list', name: 'Listar', method: 'GET', path: '/charges' }]
  }))
  write('environments/dev.env.json', {
    id: 'env.dev',
    name: 'Dev',
    variables: {
      BASE_URL: { type: 'string', value: origin },
      TENANT: { type: 'string', value: 'acme' },
      CLIENT_ID: { type: 'string', value: 'app+id' },
      CLIENT_SECRET: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
    }
  })
  write('.vvpost/secrets.local.json', { 'env.dev': { CLIENT_SECRET: 's3cr&t' } })
  return loadWorkspace(dir)
}

let seq = 0
const input = (over: Partial<HttpRequestInput> = {}): HttpRequestInput => ({
  id: `r${++seq}`,
  method: 'GET',
  url: '/charges',
  headers: [],
  connectorId: 'billing.v2',
  environmentId: 'env.dev',
  ...over
})

const send = (ws: LoadedWorkspace, over?: Partial<HttpRequestInput>, signal?: AbortSignal) =>
  sendHeadless(input(over), { workspace: ws, auth: engine, http, signal })

function body(result: HttpResult): Record<string, unknown> {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return JSON.parse(result.response.body)
}

describe('workspace', () => {
  it('lê conectores em subpastas, ambientes e segredos; arquivo inválido vira issue', async () => {
    await oauthWorkspace()
    write('connectors/quebrado.connector.vvpost.json', '{ nope')
    write('connectors/sem-versao.connector.vvpost.json', { id: 'x', name: 'X' })
    write('node_modules/pkg/ignorado.connector.vvpost.json', '{ nope')
    const ws = await loadWorkspace(dir)
    expect([...ws.connectors.keys()]).toEqual(['corp.base', 'billing.v2'])
    expect(ws.secrets).toEqual({ 'env.dev': { CLIENT_SECRET: 's3cr&t' } })
    expect(ws.issues.map((i) => i.file)).toEqual([
      'connectors/quebrado.connector.vvpost.json',
      'connectors/sem-versao.connector.vvpost.json'
    ])
  })

  it('o resumo para o renderer não leva valores de segredo', async () => {
    const summary = summarizeWorkspace(await oauthWorkspace())
    expect(JSON.stringify(summary)).not.toContain('s3cr&t')
    const billing = summary.connectors.find((c) => c.id === 'billing.v2')!
    expect(billing).toMatchObject({
      chain: ['corp.base', 'billing.v2'],
      baseUrl: '{{BASE_URL}}/billing/v2',
      headers: [{ name: 'X-Tenant', value: '{{TENANT}}' }],
      auth: { type: 'oauth2', from: 'corp.base', summary: 'OAuth2 client credentials em /oauth/token' }
    })
    expect(summary.environments).toEqual([{ id: 'env.dev', name: 'Dev', missingSecrets: [], protected: false }])
  })
})

describe('Quick Request com conector (headless auth)', () => {
  it('busca o token OAuth2 em segundo plano, injeta, aplica headers herdados e reusa o token', async () => {
    const ws = await oauthWorkspace()
    const first = await send(ws)
    expect(body(first)).toEqual({ path: '/billing/v2/charges', token: 'tok-1', tenant: 'acme' })
    expect(first.auth).toMatchObject({ type: 'oauth2', from: 'corp.base', source: 'fetched' })
    expect(first.auth!.expiresAt).toBeGreaterThan(clock + 3_500_000)

    const token = calls.find((c) => c.path === '/oauth/token')!
    expect(new URLSearchParams(token.body).get('grant_type')).toBe('client_credentials')
    // client_secret_basic com form-urlencode antes do base64 (RFC 6749 2.3.1).
    expect(token.headers.authorization).toBe(`Basic ${Buffer.from('app%2Bid:s3cr%26t').toString('base64')}`)

    const second = await send(ws)
    expect(body(second).token).toBe('tok-1')
    expect(second.auth!.source).toBe('cache')
    expect(calls.filter((c) => c.path === '/oauth/token')).toHaveLength(1)
  })

  it('requisições simultâneas dividem um único fluxo de token', async () => {
    const ws = await oauthWorkspace()
    tokenDelayMs = 50
    const results = await Promise.all([send(ws), send(ws), send(ws)])
    expect(results.map((r) => body(r).token)).toEqual(['tok-1', 'tok-1', 'tok-1'])
    expect(calls.filter((c) => c.path === '/oauth/token')).toHaveLength(1)
  })

  it('token expirado é renovado com refresh_token', async () => {
    const ws = await oauthWorkspace()
    await send(ws)
    clock += 3600_000
    const r = await send(ws)
    expect(r.auth!.source).toBe('refreshed')
    expect(body(r).token).toBe('tok-2')
    const refresh = calls.filter((c) => c.path === '/oauth/token')[1]!
    expect(new URLSearchParams(refresh.body).get('grant_type')).toBe('refresh_token')
  })

  it('token em cache recusado com 401 é descartado e a requisição repete uma vez', async () => {
    const ws = await oauthWorkspace()
    await send(ws)
    valid.clear()
    const r = await send(ws)
    expect(r.ok && r.response.status).toBe(200)
    expect(body(r).token).toBe('tok-2')
    expect(r.auth).toMatchObject({ source: 'refreshed', retried: true })
  })

  it('client_secret no corpo quando clientAuthentication é body', async () => {
    const ws = await oauthWorkspace({ clientAuthentication: 'body', scope: 'billing.read' })
    expect(body(await send(ws)).token).toBe('tok-1')
    const form = new URLSearchParams(calls[0]!.body)
    expect(form.get('client_secret')).toBe('s3cr&t')
    expect(form.get('scope')).toBe('billing.read')
    expect(calls[0]!.headers.authorization).toBeUndefined()
  })

  it('pedido de token em JSON quando tokenRequestFormat é json', async () => {
    const ws = await oauthWorkspace({ clientAuthentication: 'body', tokenRequestFormat: 'json', extraParams: { tenant: '{{TENANT}}' } })
    expect(body(await send(ws)).token).toBe('tok-1')
    expect(calls[0]!.headers['content-type']).toBe('application/json')
    expect(JSON.parse(calls[0]!.body)).toEqual({
      grant_type: 'client_credentials',
      tenant: 'acme',
      client_id: 'app+id',
      client_secret: 's3cr&t'
    })
    clock += 3600_000
    expect(body(await send(ws)).token).toBe('tok-2')
    expect(JSON.parse(calls.filter((c) => c.path === '/oauth/token')[1]!.body)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'r1' })
  })

  it('credencial recusada vira AUTH_FAILED com o erro do token endpoint', async () => {
    const ws = await oauthWorkspace()
    ws.secrets['env.dev']!.CLIENT_SECRET = 'errado'
    const r = await send(ws)
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'AUTH_FAILED', message: 'token endpoint respondeu 401 (invalid_client: segredo errado)' }
    })
    expect(calls.map((c) => c.path)).toEqual(['/oauth/token'])
  })

  it('segredo sem valor local vira CONFIG_ERROR antes de qualquer rede', async () => {
    const ws = await oauthWorkspace()
    ws.secrets = {}
    const r = await send(ws)
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFIG_ERROR' } })
    expect(!r.ok && r.error.message).toContain('{{CLIENT_SECRET}} sem valor no cofre local')
    expect(calls).toHaveLength(0)
  })

  it('Authorization digitado à mão vence a herança e pula o fluxo de auth', async () => {
    const ws = await oauthWorkspace()
    valid.add('manual')
    const r = await send(ws, { headers: [{ name: 'authorization', value: 'Bearer manual' }] })
    expect(body(r).token).toBe('manual')
    expect(r.auth).toBeUndefined()
    expect(calls.map((c) => c.path)).toEqual(['/billing/v2/charges'])
  })

  it('nunca manda credencial herdada para outra origem', async () => {
    const ws = await oauthWorkspace()
    const r = await send(ws, { url: 'https://outro-host.exemplo.com/charges' })
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFIG_ERROR' } })
    expect(calls).toHaveLength(0)
    // Mesma origem em URL absoluta é aceita.
    expect(body(await send(ws, { url: `${origin}/billing/v2/charges?x=1` })).path).toBe('/billing/v2/charges')
  })

  it('login próprio com MFA (TOTP), token tirado de header e injetado em outro header', async () => {
    write('connectors/app.connector.vvpost.json', connector('app', {
      baseUrl: origin,
      auth: {
        type: 'login',
        request: { url: '/auth/login', json: { user: '{{USER}}', password: '{{PASSWORD}}', otp: '{{$totp:MFA_SEED}}' } },
        token: 'headers.x-session-token',
        expiresIn: 'body.data.ttl',
        inject: { name: 'X-Session', value: '{{$token}}' }
      }
    }))
    write('environments/dev.env.json', {
      id: 'env.dev',
      name: 'Dev',
      variables: {
        USER: { type: 'string', value: 'ana' },
        PASSWORD: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true },
        MFA_SEED: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
      }
    })
    write('.vvpost/secrets.local.json', { 'env.dev': { PASSWORD: 'pw', MFA_SEED: 'JBSWY3DPEHPK3PXP' } })
    const ws = await loadWorkspace(dir)
    const r = await send(ws, { connectorId: 'app', url: '/me' })
    expect(body(r)).toMatchObject({ path: '/me', token: 'sess-1' })
    expect(r.auth).toMatchObject({ type: 'login', source: 'fetched', expiresAt: clock + 120_000 })
    expect(calls[0]!.headers['content-type']).toBe('application/json')
  })

  it('login com token no corpo injetado na query', async () => {
    write('connectors/app.connector.vvpost.json', connector('app', {
      baseUrl: origin,
      auth: {
        type: 'login',
        request: { url: `${origin}/auth/login`, body: '{"user":"ana","password":"pw","otp":"123456"}' },
        token: 'body.data.token',
        inject: { in: 'query', name: 'session', value: '{{$token}}' }
      }
    }))
    const r = await send(await loadWorkspace(dir), { connectorId: 'app', url: '/me?a=1', environmentId: undefined })
    expect(body(r).token).toBe('sess-1')
    expect(calls[1]!.path).toBe('/me?a=1&session=sess-1')
  })

  it('API key na query e bearer fixo', async () => {
    valid.add('k-1')
    write('connectors/key.connector.vvpost.json', connector('key', {
      baseUrl: origin,
      auth: { type: 'apiKey', in: 'query', name: 'api_key', value: 'k-1' }
    }))
    write('connectors/fixo.connector.vvpost.json', connector('fixo', {
      baseUrl: origin,
      auth: { type: 'bearer', token: 'k-1' }
    }))
    const ws = await loadWorkspace(dir)
    const viaQuery = await send(ws, { connectorId: 'key', url: '/x', environmentId: undefined })
    expect(body(viaQuery).token).toBe('k-1')
    expect(viaQuery.auth).toMatchObject({ type: 'apiKey', source: 'static' })
    expect(body(await send(ws, { connectorId: 'fixo', url: '/x', environmentId: undefined })).token).toBe('k-1')
  })

  it('cancelar durante o fluxo de auth devolve ABORTED', async () => {
    const ws = await oauthWorkspace()
    tokenDelayMs = 300
    const controller = new AbortController()
    const pending = send(ws, undefined, controller.signal)
    setTimeout(() => controller.abort(), 20)
    expect(await pending).toMatchObject({ ok: false, error: { code: 'ABORTED' } })
  })

  it('só ambiente, sem conector: resolve {{VAR}} em URL, headers e corpo', async () => {
    await oauthWorkspace()
    valid.add('t')
    const r = await send(await loadWorkspace(dir), {
      connectorId: undefined,
      url: '{{BASE_URL}}/eco',
      headers: [{ name: 'Authorization', value: 'Bearer t' }, { name: 'X-Tenant', value: '{{TENANT}}' }]
    })
    expect(body(r)).toEqual({ path: '/eco', token: 't', tenant: 'acme' })
  })
})

describe('mTLS herdado do conector', () => {
  let pki: Awaited<ReturnType<typeof createTestPki>>
  let secure: ReturnType<typeof createHttpsServer>
  let secureOrigin: string

  beforeAll(async () => {
    pki = await createTestPki()
    secure = createHttpsServer(
      { key: pki.server.key, cert: pki.server.cert, ca: pki.ca, requestCert: true, rejectUnauthorized: true },
      (req, res) => {
        const peer = (req.socket as TLSSocket).getPeerCertificate()
        json(res, 200, { client: peer.subject?.CN, auth: req.headers.authorization ?? null })
      }
    )
    await new Promise<void>((r) => secure.listen(0, '127.0.0.1', r))
    secureOrigin = `https://127.0.0.1:${(secure.address() as AddressInfo).port}`
  })
  afterAll(() => {
    secure.close()
  })

  it('apresenta o certificado de cliente do conector pai, com caminhos relativos ao workspace', async () => {
    write('certs/client.crt', pki.client.cert)
    write('certs/client.key', pki.client.key)
    write('certs/ca.crt', pki.ca)
    write('connectors/base.connector.vvpost.json', connector('mtls.base', {
      baseUrl: secureOrigin,
      tls: { cert: 'certs/client.crt', key: '{{KEY_PATH}}', ca: 'certs/ca.crt' },
      auth: { type: 'bearer', token: 'abc' }
    }))
    write('connectors/child.connector.vvpost.json', connector('mtls.child', {}, { extends: 'mtls.base' }))
    write('environments/dev.env.json', {
      id: 'env.dev',
      name: 'Dev',
      variables: { KEY_PATH: { type: 'string', value: join(dir, 'certs/client.key') } }
    })
    const ws = await loadWorkspace(dir)
    const r = await send(ws, { connectorId: 'mtls.child', url: '/x' })
    expect(body(r)).toEqual({ client: 'vvpost-test-client', auth: 'Bearer abc' })

    // Sem certificado o servidor recusa o handshake.
    const plain = await http.send({ id: 'plain', method: 'GET', url: `${secureOrigin}/x`, headers: [] })
    expect(plain).toMatchObject({ ok: false })
  })

  it('arquivo de certificado ausente vira CONFIG_ERROR', async () => {
    write('connectors/base.connector.vvpost.json', connector('mtls.base', {
      baseUrl: secureOrigin,
      tls: { cert: 'certs/nao-existe.crt', key: 'certs/nao-existe.key' }
    }))
    const r = await send(await loadWorkspace(dir), { connectorId: 'mtls.base', environmentId: undefined })
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFIG_ERROR' } })
    expect(!r.ok && r.error.message).toContain('mTLS: não foi possível ler cert (certs/nao-existe.crt)')
  })
})
