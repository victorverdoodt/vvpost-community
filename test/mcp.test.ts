import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { createHttpDispatcher, type HttpDispatcher } from '@vvpost/core/http/dispatcher'
import { createSecretSanitizer, isSensitiveName, REDACTED } from '@vvpost/core/sanitizer'
import { clearReviewMarks, readReviewMarks } from '../src/main/project/review'
import { createMcpServer, type JsonRpcResponse, type McpServer } from '../src/main/mcp/server'
import { serveHttp, serveStdio } from '../src/main/mcp/transports'
import { MCP_TOOL_SUMMARIES } from '../src/shared/mcp-tools'

// --- Segredos do workspace de teste e os que a API devolve nos fluxos de auth ---
// Gerados a cada execução: nenhum valor com cara de credencial fica commitado.

const fake = (prefix: string) => `${prefix}${randomBytes(6).toString('hex')}`
const CLIENT_SECRET = fake('cs-')
const API_KEY = fake('ak_')
/** Espaço, barra, + e = mudam em cada codificação (URL, form, base64). */
const LOGIN_PASSWORD = `${fake('S3')} F/+=x`
/** Não está marcada isSecret, mas o nome é de senha. */
const LEGACY_PASSWORD = fake('plain')
const SHORT_PIN = 'q7z'
/** Escrito direto no arquivo do conector, num header de nome sensível. */
const LITERAL_KEY = fake('lit-')
const ACCESS_TOKEN = fake('at-')
const REFRESH_TOKEN = fake('rt-')
const SESSION_TOKEN = fake('sess-')
const COOKIE_VALUE = fake('ck-')

const SECRETS = [
  CLIENT_SECRET,
  API_KEY,
  LOGIN_PASSWORD,
  LEGACY_PASSWORD,
  LITERAL_KEY,
  ACCESS_TOKEN,
  REFRESH_TOKEN,
  SESSION_TOKEN,
  COOKIE_VALUE,
  Buffer.from(`app:${CLIENT_SECRET}`).toString('base64'),
  Buffer.from(`svc:${LEGACY_PASSWORD}`).toString('base64')
]

const formsOf = (s: string) => [
  s,
  encodeURIComponent(s),
  encodeURIComponent(s).replace(/%20/g, '+'),
  JSON.stringify(s).slice(1, -1),
  Buffer.from(s).toString('base64').replace(/=+$/, ''),
  Buffer.from(s).toString('base64url')
]

/** Nenhum segredo, em nenhuma forma, nem pela metade (começo de 8 caracteres). */
function expectNoLeak(text: string): void {
  for (const secret of SECRETS) {
    for (const form of formsOf(secret)) {
      expect(text, `vazou ${secret}`).not.toContain(form)
      if (form.length > 12) expect(text, `vazou o começo de ${secret}`).not.toContain(form.slice(0, 8))
    }
  }
  expect(text).not.toMatch(new RegExp(`["\\s=:]${SHORT_PIN}["\\s&,}]`))
}

describe('Secret Sanitizer', () => {
  const s = createSecretSanitizer()
  s.add(API_KEY)
  s.add(LOGIN_PASSWORD)
  s.add(SHORT_PIN)

  it('mascara valores conhecidos em qualquer codificação', () => {
    for (const form of formsOf(LOGIN_PASSWORD)) {
      expect(s.text(`antes ${form} depois`)).toBe(`antes ${REDACTED} depois`)
    }
    expect(s.text(`?k=${encodeURIComponent(API_KEY)}`)).toBe(`?k=${REDACTED}`)
    // Segredo curto só quando é o valor inteiro: "q7z" no meio de uma palavra fica.
    expect(s.sanitize({ pin: SHORT_PIN, code: SHORT_PIN, note: `xq7zx` })).toEqual({ pin: REDACTED, code: REDACTED, note: 'xq7zx' })
  })

  it('esquema de auth sozinho em texto (documentação) não é credencial; o valor depois dele continua mascarado', () => {
    expect(s.text('inject: header Authorization: Bearer {{$token}}')).toBe('inject: header Authorization: Bearer {{$token}}')
    expect(s.text('client_id e client_secret em Authorization: Basic; body: no form.')).toBe(
      'client_id e client_secret em Authorization: Basic; body: no form.'
    )
    expect(s.text('o token vai em Authorization: Bearer.')).toBe('o token vai em Authorization: Bearer.')
    expect(s.text('injeta `Authorization: Bearer` em todos')).toBe('injeta `Authorization: Bearer` em todos')
    expect(s.text('enviou Authorization: Bearer abcdefgh')).not.toContain('abcdefgh')
    expect(s.text('enviou Authorization: Bearer abc-123456')).not.toContain('abc-123456')
  })

  it('em prosa (documentação), só mascara o valor com cara de credencial', () => {
    const p = createSecretSanitizer({ prose: true })
    p.add(LOGIN_PASSWORD)
    const prose = [
      'O token vai no header Authorization: Bearer seguido do JWT.',
      'Envie `Authorization: Bearer <token>` em todas as chamadas.',
      'Todas as rotas exigem Authorization: Bearer com o token do login.',
      '- Authorization: Bearer obtido via /auth',
      'O header Authorization: Bearer e o X-Api-Key: chave do cliente.',
      'O campo password: obrigatório, mínimo 8.',
      'client_secret = definido no cofre',
      'Authorization: Basic base64(usuario:senha)',
      'Cookie: sessão do usuário',
      'apiKey=SUA_CHAVE',
      'Authorization: Bearer xxxxxxxx'
    ]
    for (const line of prose) expect(p.text(line)).toBe(line)
    for (const secret of ['Authorization: Bearer abc123def456', 'password: hunter2024', 'X-Api-Key: 9f8e7d6c5b4a', 'Cookie: session=abc123def456', 'apiKey=a1b2c3d4e5f6']) {
      expect(p.text(secret)).toContain(REDACTED)
    }
    // Valores conhecidos e formatos valem em prosa como em qualquer texto.
    expect(p.text(`a senha é ${LOGIN_PASSWORD}`)).toBe(`a senha é ${REDACTED}`)
    expect(p.text('o token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc')).toBe(`o token ${REDACTED}`)
    // Fora da documentação (respostas, erros, logs), a regra segue estrita.
    expect(s.text('Authorization: Bearer seguido')).toContain(REDACTED)
  })

  it('mascara pela estrutura: headers, campos e parâmetros de nome sensível', () => {
    const out = s.sanitize({
      headers: [
        { name: 'Authorization', value: 'Bearer qualquer-coisa-1' },
        { name: 'Cookie', value: 'a=b; c=d' },
        { name: 'X-Custom-Api-Key', value: 'v1' },
        { name: 'Content-Type', value: 'application/json' },
        { name: 'X-Tenant', value: '{{TENANT}}' },
        { name: 'Authorization', value: 'Bearer {{TOKEN}}' }
      ],
      body: { user: 'victor', password: 'p1', nested: [{ client_secret: 'x', refreshToken: 99 }], token_type: 'Bearer' }
    })
    // "Bearer {{TOKEN}}" é o nome da variável, não o valor: a IA precisa dele para editar o conector.
    expect(out.headers.map((h) => h.value)).toEqual([REDACTED, REDACTED, REDACTED, 'application/json', '{{TENANT}}', 'Bearer {{TOKEN}}'])
    expect(out.body).toEqual({
      user: 'victor',
      password: REDACTED,
      nested: [{ client_secret: REDACTED, refreshToken: REDACTED }],
      token_type: 'Bearer'
    })
  })

  it('texto que é JSON, form ou JSON cortado no meio', () => {
    expect(JSON.parse(s.text('{"access_token":"zzz-1","expires_in":3600}'))).toEqual({ access_token: REDACTED, expires_in: 3600 })
    expect(s.text('grant_type=password&username=v&password=h2&scope=a')).toBe(
      `grant_type=password&username=v&password=${REDACTED}&scope=a`
    )
    expect(s.text('{"data":{"token": "abc.def-123", "name": "x"')).toBe(`{"data":{"token": "${REDACTED}", "name": "x"`)
    // \u escapes: só lendo como JSON se vê o valor.
    const escaped = JSON.stringify({ echo: API_KEY }).replace(/a/g, '\\u0061')
    expect(s.text(escaped)).not.toContain(API_KEY.slice(3))
  })

  it('mascara pelo formato: JWT, PEM, esquemas de auth, URL com senha, tokens de provedores', () => {
    // Montados na hora, para o scanner de segredos do repositório não confundir com credenciais reais.
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
    const jwt = `${b64({ alg: 'HS256' })}.${b64({ sub: fake('') })}.${randomBytes(32).toString('base64url')}`
    const pemBody = randomBytes(24).toString('base64')
    const label = ['RSA', 'PRIVATE', 'KEY'].join(' ')
    const pem = `-----BEGIN ${label}-----\n${pemBody}\n-----END ${label}-----`
    const bearer = fake('b1')
    const password = fake('pw')
    const aws = `AKIA${randomBytes(8).toString('hex').toUpperCase()}`
    const github = `ghp_${randomBytes(18).toString('hex')}`
    const basic = Buffer.from(`u:${fake('')}`).toString('base64')
    const text = [
      `id=${jwt}`,
      pem,
      `erro: Authorization recusado para Bearer ${bearer}`,
      `proxy https://admin:${password}@internal.example.com/x`,
      `aws ${aws} e github ${github}`,
      `Authorization: Basic ${basic}`,
      'Token expirado, faça login de novo'
    ].join('\n')
    const out = s.text(text)
    for (const leaked of [jwt.slice(0, 20), pemBody, bearer, password, aws, github.slice(0, 10), basic]) {
      expect(out).not.toContain(leaked)
    }
    expect(out).toContain('Token expirado, faça login de novo')
    expect(out).toContain('https://[REDACTED_SECRET]@internal.example.com/x')
  })

  it('nomes sensíveis', () => {
    for (const name of ['Authorization', 'x-api-key', 'client_secret', 'refreshToken', 'X-Internal-Key', 'passwd', 'Set-Cookie', 'ocp-apim-subscription-key']) {
      expect(isSensitiveName(name), name).toBe(true)
    }
    for (const name of ['Content-Type', 'token_type', 'expires_in', 'Idempotency-Key', 'key', 'name', 'keyboard']) {
      expect(isSensitiveName(name), name).toBe(false)
    }
  })
})

// --- API de teste que devolve tudo o que recebe (o pior caso para vazamento) ---

let api: Server
let origin: string
let dir: string
let http: HttpDispatcher
let server: McpServer

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body = ''
  for await (const chunk of req) body += chunk
  const url = new URL(req.url ?? '/', 'http://x')
  const echo = { method: req.method, url: req.url, headers: req.headers, body }
  switch (url.pathname) {
    case '/oauth/token':
      if (req.headers.authorization !== `Basic ${Buffer.from(`app:${CLIENT_SECRET}`).toString('base64')}`) {
        return json(res, 401, { error: 'invalid_client' })
      }
      return json(res, 200, { access_token: ACCESS_TOKEN, token_type: 'bearer', expires_in: 3600, refresh_token: REFRESH_TOKEN })
    case '/oauth/bad':
      // Servidor ruim que devolve o form recebido (com o client_secret) no erro.
      res.writeHead(400, { 'content-type': 'text/plain' })
      return void res.end(`invalid request: ${body}`)
    case '/login': {
      const data = JSON.parse(body || '{}')
      if (data.password !== LOGIN_PASSWORD) return json(res, 401, { error: 'bad credentials' })
      return json(res, 200, { data: { handle: SESSION_TOKEN, user: data.user } })
    }
    case '/long':
      res.writeHead(200, { 'content-type': 'text/plain' })
      return void res.end(`${'x'.repeat(3995)}${API_KEY}${'y'.repeat(50)}`)
    case '/encoded':
      return json(res, 200, {
        b64: Buffer.from(API_KEY).toString('base64'),
        url: encodeURIComponent(LOGIN_PASSWORD),
        inText: `o cliente usou ${req.headers['x-session'] ?? req.headers.authorization}`
      })
    case '/cookie':
      return json(res, 200, { ok: true }, { 'set-cookie': `session=${COOKIE_VALUE}; HttpOnly` })
    case '/whoami':
      return json(res, 200, { session: req.headers.cookie ?? null, echo })
    default:
      return json(res, 200, echo)
  }
}

function write(path: string, data: unknown): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), JSON.stringify(data, null, 2))
}

const env = (id: string) => ({
  id,
  name: id.toUpperCase(),
  variables: {
    BASE_URL: { type: 'string', value: origin },
    TENANT: { type: 'string', value: 'acme' },
    CLIENT_SECRET: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true },
    API_KEY: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true },
    LOGIN_PASSWORD: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true },
    SHORT_PIN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true },
    LEGACY_PASSWORD: { type: 'string', value: LEGACY_PASSWORD }
  }
})

const echoEndpoints = [
  {
    id: 'echo',
    name: 'Eco',
    method: 'POST',
    path: '/echo',
    headers: { 'Content-Type': 'application/json' },
    body: { hello: 'world' },
    scenarios: [{ id: 'reflect', name: 'Reflete a requisição', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }]
  },
  {
    id: 'long',
    name: 'Corpo longo',
    method: 'GET',
    path: '/long',
    scenarios: [{ id: 'cut', name: 'Segredo no limite do corte', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }]
  },
  {
    id: 'encoded',
    name: 'Segredos codificados',
    method: 'GET',
    path: '/encoded',
    scenarios: [{ id: 'enc', name: 'Codificado', assertions: [{ target: 'body.b64', operator: 'exists' }] }]
  },
  {
    id: 'cookie',
    name: 'Cookie',
    method: 'GET',
    path: '/cookie',
    scenarios: [{ id: 'set', name: 'Set-Cookie', assertions: [{ target: 'headers.set-cookie', operator: 'exists' }] }]
  }
]

beforeAll(async () => {
  api = createServer((req, res) => void handler(req, res))
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
  dir = mkdtempSync(join(tmpdir(), 'vvpost-mcp-'))

  write('connectors/base.connector.vvpost.json', {
    id: 'corp.base',
    name: 'Base corporativa',
    version: '1.0.0',
    config: {
      baseUrl: '{{BASE_URL}}',
      headers: { 'X-Tenant': '{{TENANT}}', 'X-Internal-Key': LITERAL_KEY },
      auth: { type: 'oauth2', grantType: 'client_credentials', tokenUrl: '/oauth/token', clientId: 'app', clientSecret: '{{CLIENT_SECRET}}' }
    }
  })
  write('connectors/billing.connector.vvpost.json', {
    id: 'billing',
    name: 'Billing',
    version: '2.0.0',
    extends: 'corp.base',
    endpoints: echoEndpoints
  })
  write('connectors/keyed.connector.vvpost.json', {
    id: 'keyed',
    name: 'API key na query',
    version: '1.0.0',
    config: { baseUrl: '{{BASE_URL}}', auth: { type: 'apiKey', in: 'query', name: 'api_key', value: '{{API_KEY}}' } },
    endpoints: echoEndpoints
  })
  write('connectors/session.connector.vvpost.json', {
    id: 'session',
    name: 'Login com sessão',
    version: '1.0.0',
    config: {
      baseUrl: '{{BASE_URL}}',
      auth: {
        type: 'login',
        request: { url: '/login', json: { user: 'victor', password: '{{LOGIN_PASSWORD}}' } },
        token: 'body.data.handle',
        inject: { name: 'X-Session', value: '{{$token}}' }
      }
    },
    endpoints: echoEndpoints
  })
  write('connectors/legacy.connector.vvpost.json', {
    id: 'legacy',
    name: 'Basic legado',
    version: '1.0.0',
    config: { baseUrl: '{{BASE_URL}}', auth: { type: 'basic', username: 'svc', password: '{{LEGACY_PASSWORD}}' } },
    endpoints: echoEndpoints
  })
  write('connectors/broken.connector.vvpost.json', {
    id: 'broken',
    name: 'Token endpoint que ecoa',
    version: '1.0.0',
    config: {
      baseUrl: '{{BASE_URL}}',
      auth: {
        type: 'oauth2',
        grantType: 'client_credentials',
        tokenUrl: '/oauth/bad',
        clientId: 'app',
        clientSecret: '{{CLIENT_SECRET}}',
        clientAuthentication: 'body'
      }
    },
    endpoints: echoEndpoints
  })
  write('environments/dev.env.json', env('dev'))
  write('environments/prod.env.json', env('prod'))
  const values = { CLIENT_SECRET, API_KEY, LOGIN_PASSWORD, SHORT_PIN }
  write('.vvpost/secrets.local.json', { dev: values, prod: values })

  http = createHttpDispatcher()
  server = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine(), allowEnvironments: new Set(['dev']) })
})

afterAll(async () => {
  await http.close()
  await new Promise((r) => api.close(r))
  rmSync(dir, { recursive: true, force: true })
})

let nextId = 1
async function rpc(method: string, params?: Record<string, unknown>, target: McpServer = server): Promise<JsonRpcResponse> {
  const reply = await target.handle({ jsonrpc: '2.0', id: nextId++, method, ...(params && { params }) })
  return reply as JsonRpcResponse
}

/** Chama a ferramenta e devolve o texto exato que a IA recebe, já conferido contra vazamentos. */
async function call(name: string, args: Record<string, unknown>, target?: McpServer) {
  const reply = await rpc('tools/call', { name, arguments: args }, target)
  const result = reply.result as { content: { text: string }[]; isError: boolean; structuredContent?: unknown }
  const text = result.content[0]!.text
  expectNoLeak(JSON.stringify(reply))
  return { text, data: JSON.parse(text) as Record<string, any>, isError: result.isError }
}

describe('protocolo MCP', () => {
  it('initialize negocia a versão e anuncia ferramentas', async () => {
    const reply = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    expect(reply.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'vvpost' } })
    const old = await rpc('initialize', { protocolVersion: '1999-01-01' })
    expect((old.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25')
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
  })

  it('tools/list, ping, método desconhecido, argumentos inválidos e lote', async () => {
    const list = (await rpc('tools/list')).result as { tools: { name: string; inputSchema: object }[] }
    expect(list.tools.map((t) => t.name)).toEqual([
      'list_projects',
      'create_project',
      'get_api_catalog',
      'execute_dry_run',
      'execute_flow',
      'validate_body',
      'install_agent_rules',
      'check_readiness',
      'get_schema',
      'get_source',
      'edit_project',
      'import_postman',
      'export_project',
      'import_bundle',
      'import_openapi',
      'sync_openapi',
      'import_collection',
      'generate_docs',
      'get_docs_project',
      'save_docs_project',
      'write_docs_page',
      'fix_diagrams',
      'save_docs_template',
      'find_references',
      'replace_references',
      'export_docs',
      'lint_project',
      'get_brand',
      'list_webhook_events',
      'get_webhook_event'
    ])
    // A tela MCP & IA lista as mesmas ferramentas, na mesma ordem.
    expect(MCP_TOOL_SUMMARIES.map(([name]) => name)).toEqual(list.tools.map((t) => t.name))
    expect((await rpc('ping')).result).toEqual({})
    expect((await rpc('nada/disso')).error?.code).toBe(-32601)
    expect((await rpc('tools/call', { name: 'nao_existe' })).error?.code).toBe(-32602)
    const bad = await call('execute_dry_run', { connectorId: 1 })
    expect(bad.isError).toBe(true)
    expect(bad.data.error).toBe('argumentos inválidos')
    const batch = (await server.handle([
      { jsonrpc: '2.0', id: 'a', method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/cancelled' }
    ])) as JsonRpcResponse[]
    expect(batch).toEqual([{ jsonrpc: '2.0', id: 'a', result: {} }])
  })
})

describe('harness de documentação', () => {
  it('initialize instrui a usar o VVPost como ferramenta de documentação', async () => {
    const reply = (await rpc('initialize', { protocolVersion: '2025-06-18' })).result as Record<string, any>
    expect(reply.capabilities).toMatchObject({ prompts: {}, resources: {} })
    expect(reply.instructions).toContain('não crie arquivos .md soltos')
    expect(reply.instructions).toContain('vvpost://docs/guia')
  })

  it('resources: guia e modelos', async () => {
    const list = (await rpc('resources/list')).result as { resources: { uri: string }[] }
    expect(list.resources.map((r) => r.uri)).toEqual(['vvpost://docs/guia', 'vvpost://docs/modelos'])
    const guide = (await rpc('resources/read', { uri: 'vvpost://docs/guia' })).result as { contents: { text: string; mimeType: string }[] }
    expect(guide.contents[0]!.mimeType).toBe('text/markdown')
    expect(guide.contents[0]!.text).toContain('{{> endpoint <conector>/<endpoint>}}')
    expect(guide.contents[0]!.text).toContain('builtin:c4')
    const models = (await rpc('resources/read', { uri: 'vvpost://docs/modelos' })).result as { contents: { text: string }[] }
    const ids = (JSON.parse(models.contents[0]!.text) as { templates: { id: string }[] }).templates.map((t) => t.id)
    expect(ids).toEqual(expect.arrayContaining(['builtin:c4', 'builtin:arc42', 'builtin:diataxis', 'builtin:adr']))
    expect((await rpc('resources/read', { uri: 'vvpost://nada' })).error?.code).toBe(-32602)
  })

  it('prompts: documentar o projeto, um conector e aplicar um modelo', async () => {
    const list = (await rpc('prompts/list')).result as { prompts: { name: string }[] }
    expect(list.prompts.map((p) => p.name)).toEqual(['documentar_projeto', 'documentar_conector', 'aplicar_template'])
    const text = async (name: string, args?: Record<string, unknown>) => {
      const r = await rpc('prompts/get', { name, ...(args && { arguments: args }) })
      return r.error ? r.error : ((r.result as { messages: { content: { text: string } }[] }).messages[0]!.content.text as string)
    }
    expect(await text('documentar_projeto', { template: 'builtin:arc42' })).toContain('template: "builtin:arc42"')
    expect(await text('documentar_conector', { connector: 'billing' })).toContain('{{> connector billing}}')
    expect(await text('aplicar_template')).toContain('C4Context')
    expect(await text('documentar_conector')).toMatchObject({ code: -32602, message: 'argumento obrigatório: connector' })
    expect(await text('documentar_projeto', { outro: 'x' })).toMatchObject({ code: -32602 })
    expect(await text('nao_existe')).toMatchObject({ code: -32602 })
  })
})

describe('get_api_catalog', () => {
  it('visão geral com a herança resolvida, ambientes e segredos só pelo nome', async () => {
    const { data } = await call('get_api_catalog', {})
    const billing = data.connectors.find((c: { id: string }) => c.id === 'billing')
    expect(billing).toMatchObject({ chain: ['corp.base', 'billing'], baseUrl: '{{BASE_URL}}' })
    expect(billing.endpoints.map((e: { id: string }) => e.id)).toEqual(['echo', 'long', 'encoded', 'cookie'])
    const dev = data.environments.find((e: { id: string }) => e.id === 'dev')
    const vars = Object.fromEntries(dev.variables.map((v: { name: string; value: unknown }) => [v.name, v.value]))
    expect(vars).toMatchObject({ BASE_URL: origin, TENANT: 'acme', CLIENT_SECRET: REDACTED, LEGACY_PASSWORD: REDACTED })
    expect(data.environments.find((e: { id: string }) => e.id === 'prod')).toMatchObject({ protected: true, execution: 'ambiente protegido (produção): só plan' })
    expect(data.environments.find((e: { id: string }) => e.id === 'dev').protected).toBeUndefined()
    // A hierarquia de herança, além da lista: billing fica sob a base corporativa.
    expect(data.tree.find((n: { id: string }) => n.id === 'corp.base')).toEqual({
      id: 'corp.base',
      name: 'Base corporativa',
      children: [{ id: 'billing', name: 'Billing' }]
    })
    expect(data.tree.map((n: { id: string }) => n.id)).not.toContain('billing')
  })

  it('detalhe do conector: headers com origem, literal mascarado, {{VAR}} visível, cenários', async () => {
    const { data } = await call('get_api_catalog', { connectorId: 'billing' })
    const headers = Object.fromEntries(data.resolved.headers.map((h: { name: string; value: string }) => [h.name, h.value]))
    expect(headers).toEqual({ 'X-Tenant': '{{TENANT}}', 'X-Internal-Key': REDACTED })
    expect(data.resolved.auth).toMatchObject({ type: 'oauth2', from: 'corp.base' })
    expect(data.endpoints[0].scenarios[0]).toMatchObject({ id: 'reflect', assertions: [{ target: 'status' }] })
    expect(data).not.toHaveProperty('diagrams')
    const missing = await call('get_api_catalog', { connectorId: 'nada' })
    expect(missing.isError).toBe(true)
  })
})

describe('execute_dry_run sem vazar segredos', () => {
  it.each(['billing', 'keyed', 'session', 'legacy'])('cenários de %s: a API reflete credenciais e nada sai', async (connectorId) => {
    const { data, text } = await call('execute_dry_run', { connectorId, environmentIds: ['dev'] })
    expect(data.mode).toBe('scenarios')
    expect(data.totals).toEqual({ passed: 4, failed: 0, error: 0 })
    expect(text).toContain(REDACTED)
    const reflect = data.results.find((r: { scenarioId: string }) => r.scenarioId === 'reflect')
    // A requisição chegou com a credencial (o eco prova), mas a IA só vê a máscara.
    expect(reflect.body).toContain(REDACTED)
    expect(reflect.body).toContain('world')
  })

  it('segredo que cruza o limite do corte do corpo não sai pela metade', async () => {
    const { data } = await call('execute_dry_run', { connectorId: 'keyed', environmentIds: ['dev'], endpointId: 'long' })
    const body: string = data.results[0].body
    expect(body.length).toBeLessThanOrEqual(4001)
    expect(body).not.toContain(API_KEY.slice(0, 5))
    // O corte não deixa a máscara pela metade.
    expect(body).toMatch(/x…$/)
  })

  it('request com select traz só os campos pedidos, ainda mascarados', async () => {
    const { data, text } = await call('execute_dry_run', {
      connectorId: 'billing',
      environmentIds: ['dev'],
      request: { endpointId: 'echo', select: ['method', 'headers.x-tenant', 'headers.authorization', 'nada'] }
    })
    const [result] = data.results
    expect(result.body).toEqual({ method: 'POST', headers: { 'x-tenant': 'acme', authorization: REDACTED } })
    expect(result.selectError).toContain('nada')
    expect(result).not.toHaveProperty('responseHeaders')
    expect(text).not.toContain(ACCESS_TOKEN)
    const wrong = await call('execute_dry_run', { connectorId: 'billing', environmentIds: ['dev'], request: { endpointId: 'nada' } })
    expect(wrong.data).toMatchObject({ code: 'NOT_FOUND', hint: expect.stringContaining('echo (POST /echo)') })
    expect((await call('execute_dry_run', { connectorId: 'nada' })).data.hint).toContain('billing')
  })

  it('Set-Cookie devolvido pela API e o cookie reenviado ficam mascarados', async () => {
    const { data } = await call('execute_dry_run', { connectorId: 'billing', environmentIds: ['dev'], endpointId: 'cookie' })
    expect(data.results[0].responseHeaders.find((h: { name: string }) => h.name === 'set-cookie').value).toBe(REDACTED)
  })

  it('erro da auth com o form ecoado (client_secret) chega sanitizado', async () => {
    const { data } = await call('execute_dry_run', { connectorId: 'broken', environmentIds: ['dev'], endpointId: 'echo' })
    expect(data.results[0].error.code).toBe('AUTH_FAILED')
    expect(data.results[0].error.message).toContain('client_secret=')
    expect(data.results[0].error.message).toContain(REDACTED)
  })

  it('requisição avulsa: overrides, asserções sobre a resposta sanitizada', async () => {
    const { data } = await call('execute_dry_run', {
      connectorId: 'session',
      environmentIds: ['dev'],
      request: {
        endpointId: 'echo',
        overrides: { body: { amount: 10, password: fake('chute-') }, query: { page: '2' } },
        assertions: [
          { target: 'status', operator: 'equals', expected: 200 },
          { target: 'body.url', operator: 'contains', expected: 'page=2' },
          { target: 'body.headers.x-session', operator: 'exists' }
        ]
      }
    })
    expect(data.results[0]).toMatchObject({ outcome: 'passed', status: 200 })
    expect(JSON.parse(data.results[0].body).headers['x-session']).toBe(REDACTED)
  })

  it('a IA não adivinha um segredo refletido pelo passou/falhou das asserções', async () => {
    const guess = (expected: string) =>
      call('execute_dry_run', {
        connectorId: 'session',
        environmentIds: ['dev'],
        request: { endpointId: 'echo', assertions: [{ target: 'body.headers.x-session', operator: 'matches', expected }] }
      })
    const right = await guess(`^${SESSION_TOKEN.slice(0, 4)}`)
    const wrong = await guess('^zzzz')
    expect(right.data.results[0].assertions[0].passed).toBe(false)
    expect(right.data.results[0].assertions[0].passed).toBe(wrong.data.results[0].assertions[0].passed)
  })

  it('overrides não podem referenciar variáveis secretas', async () => {
    for (const overrides of [
      { query: { leak: '{{API_KEY}}' } },
      { headers: { 'X-Echo': 'Bearer {{ CLIENT_SECRET }}' } },
      { body: { nested: ['{{LEGACY_PASSWORD}}'] } },
      { pathParams: { id: '{{$totp:SHORT_PIN}}' } }
    ]) {
      const { data, isError } = await call('execute_dry_run', {
        connectorId: 'billing',
        environmentIds: ['dev'],
        request: { endpointId: 'echo', overrides }
      })
      expect(isError).toBe(true)
      expect(data.error).toMatch(/referencia o segredo/)
    }
  })

  it('plan só monta a requisição, com os segredos mascarados e a auth descrita', async () => {
    const { data } = await call('execute_dry_run', { connectorId: 'billing', environmentIds: ['prod'], endpointId: 'echo', plan: true })
    expect(data.mode).toBe('plan')
    expect(data.requests[0]).toMatchObject({
      method: 'POST',
      url: `${origin}/echo`,
      body: '{"hello":"world"}',
      auth: expect.stringContaining('OAuth2 client credentials')
    })
    expect(data.requests[0].headers).toContainEqual({ name: 'X-Internal-Key', value: REDACTED })
    expect(data.requests[0].tokenUrl).toBe(`${origin}/oauth/token`)
    expect(data.requests[0]).not.toHaveProperty('tokenUrlNote')
  })

  it('plan mostra a URL do token resolvida e avisa quando a baseUrl tem caminho', async () => {
    write('connectors/pathed.connector.vvpost.json', {
      id: 'pathed',
      name: 'Base com caminho',
      version: '1.0.0',
      config: {
        baseUrl: '{{BASE_URL}}/api/v1',
        auth: { type: 'oauth2', grantType: 'client_credentials', tokenUrl: '/oauth/token', clientId: 'app', clientSecret: '{{CLIENT_SECRET}}' }
      },
      endpoints: [echoEndpoints[0]]
    })
    try {
      const { data } = await call('execute_dry_run', { connectorId: 'pathed', environmentIds: ['dev'], plan: true })
      expect(data.requests[0]).toMatchObject({
        url: `${origin}/api/v1/echo`,
        tokenUrl: `${origin}/api/v1/oauth/token`,
        tokenUrlNote: expect.stringContaining('para a raiz do host, use a URL absoluta')
      })
    } finally {
      rmSync(join(dir, 'connectors/pathed.connector.vvpost.json'))
    }
  })

  it('ambiente fora da lista permitida não dispara', async () => {
    const { data, isError } = await call('execute_dry_run', { connectorId: 'billing', environmentIds: ['prod'] })
    expect(isError).toBe(true)
    expect(data.error).toMatch(/bloqueada no\(s\) ambiente\(s\) "prod"/)
  })

  it('ambiente protegido (produção) só aceita plan, mesmo liberado no servidor', async () => {
    const open = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine(), allowEnvironments: new Set(['dev', 'prod']) })
    const run = await call('execute_dry_run', { connectorId: 'billing', environmentIds: ['prod'] }, open)
    expect(run.isError).toBe(true)
    expect(run.data.error).toMatch(/"prod" é ambiente protegido \(produção\).*plan: true/)
    expect((await call('execute_dry_run', { connectorId: 'billing', environmentIds: ['prod'], endpointId: 'echo', plan: true }, open)).data.mode).toBe('plan')
    // O arquivo do ambiente libera com "protected": false.
    write('environments/prod.env.json', { ...env('prod'), protected: false })
    try {
      const freed = await call('execute_dry_run', { connectorId: 'billing', environmentIds: ['prod'], endpointId: 'echo', plan: true }, open)
      expect(freed.isError).toBeFalsy()
      expect((await call('get_api_catalog', {}, open)).data.environments.find((e: { id: string }) => e.id === 'prod').protected).toBeUndefined()
    } finally {
      write('environments/prod.env.json', env('prod'))
    }
  })

  it('modo somente leitura vira plan', async () => {
    const readOnly = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine(), readOnly: true })
    const { data } = await call('execute_dry_run', { connectorId: 'keyed', environmentIds: ['dev'] }, readOnly)
    expect(data.mode).toBe('plan')
    expect(data.requests).toHaveLength(4)
  })

  it('validate_body confere com o bodySchema', async () => {
    const { data } = await call('validate_body', { connectorId: 'billing', endpointId: 'echo', body: { a: 1 } })
    expect(data).toEqual({ ok: false, message: 'o endpoint não tem bodySchema' })
  })
})

describe('execute_flow', () => {
  const flow = {
    id: 'flow.cobranca',
    name: 'Cobrança',
    nodes: [
      { id: 'a', name: 'Eco', type: 'request', request: { connector: 'billing', endpoint: 'echo', body: { step: 1 } } },
      { id: 'b', name: 'Passou', type: 'condition', condition: { target: '$nodes.Eco.status', operator: 'equals', expected: 200 } },
      { id: 'c', name: 'Segundo', type: 'request', request: { connector: 'keyed', endpoint: 'echo', body: { from: '{{ $nodes.Eco.data.body }}' } } }
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c', branch: 'true' }
    ]
  }
  beforeAll(() => write('flows/cobranca.flow.vvpost.json', flow))

  it('roda o fluxo pela auth dos conectores e devolve cada nó sem vazar segredos', async () => {
    const { data, text } = await call('execute_flow', { flowId: 'flow.cobranca', environmentId: 'dev' })
    expect(data).toMatchObject({ mode: 'flow', outcome: 'success' })
    expect(data.nodes.map((n: { name: string; status: string }) => [n.name, n.status])).toEqual([
      ['Eco', 'success'],
      ['Passou', 'success'],
      ['Segundo', 'success']
    ])
    expect(data.nodes[0].httpStatus).toBe(200)
    // A URL vem com a baseUrl do conector resolvida, não só o caminho.
    expect(data.nodes[0].request).toEqual({ method: 'POST', url: `${origin}/echo` })
    // O eco devolve o token e a chave que a auth mandou: a IA só vê a máscara.
    expect(text).toContain(REDACTED)
    expect(data.nodes[2].data).toContain('step')
  })

  it('plan só lista os nós e as requisições', async () => {
    const { data } = await call('execute_flow', { flowId: 'flow.cobranca', environmentId: 'prod', plan: true })
    expect(data.mode).toBe('plan')
    expect(data.requests).toEqual([
      { node: 'Eco', connector: 'billing', endpoint: 'echo', method: 'POST', path: '/echo' },
      { node: 'Segundo', connector: 'keyed', endpoint: 'echo', method: 'POST', path: '/echo' }
    ])
  })

  it('ambiente bloqueado, fluxo inexistente e código da IA sem revisão não disparam', async () => {
    const prod = await call('execute_flow', { flowId: 'flow.cobranca', environmentId: 'prod' })
    expect(prod.isError).toBe(true)
    expect(prod.data.error).toMatch(/bloqueada no ambiente "prod"/)
    const open = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine(), allowEnvironments: new Set(['dev', 'prod']) })
    const protectedRun = await call('execute_flow', { flowId: 'flow.cobranca', environmentId: 'prod' }, open)
    expect(protectedRun.data.error).toMatch(/"prod" é ambiente protegido \(produção\)/)
    const missing = await call('execute_flow', { flowId: 'nada', environmentId: 'dev' })
    expect(missing.data.error).toMatch(/fluxo "nada" não existe \(flow.cobranca\)/)
    write('.vvpost/mcp-review.local.json', { 'flow:flow.cobranca': { at: new Date().toISOString() } })
    try {
      const pending = await call('execute_flow', { flowId: 'flow.cobranca', environmentId: 'dev' })
      expect(pending.data.error).toMatch(/nós de código escritos ou mudados pela IA/)
      const catalog = await call('get_api_catalog', {})
      expect(catalog.data.flows[0].review).toMatch(/aguardando revisão/)
    } finally {
      rmSync(join(dir, '.vvpost/mcp-review.local.json'))
    }
  })

  it('fluxo com código que ninguém revisou nesta máquina ganha a marca (migração) até ser aprovado', async () => {
    write('flows/antigo.flow.vvpost.json', {
      id: 'flow.antigo',
      name: 'Antigo',
      nodes: [{ id: 'p', name: 'Calc', type: 'python', python: { code: 'output = 1' } }]
    })
    try {
      const { data } = await call('execute_flow', { flowId: 'flow.antigo', environmentId: 'dev' })
      expect(data.error).toMatch(/aguarda|revisado pelo usuário/)
      expect((await readReviewMarks(dir))['flow:flow.antigo']).toMatchObject({ reason: 'nós de código: Calc (ainda não revisados nesta máquina)' })
      // Aprovado, não volta a ser marcado enquanto o código não mudar; o fluxo sem código nunca é marcado.
      await clearReviewMarks(dir, ['flow:flow.antigo'])
      await call('get_api_catalog', {})
      expect(await readReviewMarks(dir)).toEqual({})
      write('flows/antigo.flow.vvpost.json', {
        id: 'flow.antigo',
        name: 'Antigo',
        nodes: [{ id: 'p', name: 'Calc', type: 'python', python: { code: 'output = 2' } }]
      })
      await call('get_api_catalog', {})
      expect(Object.keys(await readReviewMarks(dir))).toEqual(['flow:flow.antigo'])
    } finally {
      rmSync(join(dir, 'flows/antigo.flow.vvpost.json'))
      rmSync(join(dir, '.vvpost/mcp-review.local.json'), { force: true })
    }
  })

  it('o polling conta as tentativas no limite por chamada; espera e asserção aparecem no plano', async () => {
    write('flows/espera.flow.vvpost.json', {
      id: 'flow.espera',
      name: 'Espera',
      nodes: [
        { id: 'w', name: 'Wait', type: 'wait', wait: { ms: 10 } },
        {
          id: 'a',
          name: 'Eco',
          type: 'request',
          request: { connector: 'billing', endpoint: 'echo', poll: { until: { target: '$nodes.Eco.status', operator: 'equals', expected: 200 }, maxAttempts: 60 } }
        },
        { id: 'c', name: 'Ok', type: 'condition', failWhenFalse: true, condition: { target: '$nodes.Eco.status', operator: 'equals', expected: 200 } }
      ],
      edges: [{ from: 'w', to: 'a' }, { from: 'a', to: 'c' }]
    })
    try {
      const plan = await call('execute_flow', { flowId: 'flow.espera', environmentId: 'dev', plan: true })
      expect(plan.data.nodes).toEqual([
        { id: 'w', name: 'Wait', type: 'wait', waitMs: 10 },
        { id: 'a', name: 'Eco', type: 'request' },
        { id: 'c', name: 'Ok', type: 'condition', failWhenFalse: true }
      ])
      expect(plan.data.requests[0].poll).toMatchObject({ maxAttempts: 60 })
      const { data, isError } = await call('execute_flow', { flowId: 'flow.espera', environmentId: 'dev' })
      expect(isError).toBe(true)
      expect(data.error).toMatch(/pode mandar 60 requisições \(contando as tentativas de polling\)/)
    } finally {
      rmSync(join(dir, 'flows/espera.flow.vvpost.json'))
    }
  })

  it('os métodos fora da lista permitida não disparam', async () => {
    const onlyGet = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine(), allowMethods: new Set(['GET'] as const) })
    const { data, isError } = await call('execute_flow', { flowId: 'flow.cobranca', environmentId: 'dev' }, onlyGet)
    expect(isError).toBe(true)
    expect(data.error).toMatch(/o nó Eco faz POST/)
  })
})

describe('transportes', () => {
  it('stdio: uma mensagem por linha, notificação sem resposta, JSON inválido', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const lines: JsonRpcResponse[] = []
    output.on('data', (chunk: Buffer) => lines.push(...chunk.toString().trim().split('\n').map((l) => JSON.parse(l))))
    const done = serveStdio(server, input, output)
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
    input.write('isto não é json\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_api_catalog","arguments":{}}}\n')
    input.end()
    await done
    // Cada mensagem é tratada sem esperar a anterior: a ordem das respostas é livre (JSON-RPC casa pelo id).
    expect(lines.map((l) => l.id).sort()).toEqual([1, 2, null])
    expect(lines.find((l) => l.id === null)!.error?.code).toBe(-32700)
    expectNoLeak(JSON.stringify(lines))
  })

  const raw = (port: number, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: init.headers }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end(init.body)
    })

  it('Streamable HTTP em /mcp, com token, Host e Origin conferidos', async () => {
    const token = fake('t-')
    const running = await serveHttp(server, { port: 0, token })
    try {
      const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      const ping = await raw(running.port, '/mcp', { method: 'POST', headers: auth, body: '{"jsonrpc":"2.0","id":7,"method":"ping"}' })
      expect(ping).toEqual({ status: 200, body: '{"jsonrpc":"2.0","id":7,"result":{}}' })
      const note = await raw(running.port, '/mcp', { method: 'POST', headers: auth, body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' })
      expect(note.status).toBe(202)
      expect((await raw(running.port, '/mcp', { method: 'POST', body: '{}' })).status).toBe(401)
      expect((await raw(running.port, '/mcp', { method: 'POST', headers: { ...auth, authorization: 'Bearer errado' } })).status).toBe(401)
      expect((await raw(running.port, '/mcp', { method: 'POST', headers: { ...auth, origin: 'https://evil.example' } })).status).toBe(403)
      expect((await raw(running.port, '/mcp', { method: 'POST', headers: { ...auth, host: 'evil.example:4470' } })).status).toBe(403)
      expect((await raw(running.port, '/mcp', { method: 'POST', headers: { ...auth, origin: 'http://localhost:6274' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })).status).toBe(200)
    } finally {
      await running.close()
    }
  })

  it('HTTP+SSE: GET /sse anuncia o endpoint e as respostas voltam pelo stream', async () => {
    const running = await serveHttp(server, { port: 0 })
    try {
      const events: string[] = []
      let endpoint = ''
      const gotReply = new Promise<void>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: running.port, path: '/sse' }, (res) => {
          expect(res.headers['content-type']).toBe('text/event-stream')
          res.setEncoding('utf8')
          let buffer = ''
          res.on('data', (chunk: string) => {
            buffer += chunk
            let sep
            while ((sep = buffer.indexOf('\n\n')) !== -1) {
              const event = buffer.slice(0, sep)
              buffer = buffer.slice(sep + 2)
              events.push(event)
              if (event.startsWith('event: endpoint')) {
                endpoint = event.split('data: ')[1]!
                void raw(running.port, endpoint, {
                  method: 'POST',
                  body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_api_catalog', arguments: {} } })
                }).then((r) => expect(r.status).toBe(202))
              }
              if (event.startsWith('event: message')) {
                req.destroy()
                resolve()
              }
            }
          })
        })
        req.on('error', (err) => (events.length ? undefined : reject(err)))
        req.end()
      })
      await gotReply
      expect(endpoint).toMatch(/^\/messages\?sessionId=[0-9a-f-]{36}$/)
      const message = JSON.parse(events.at(-1)!.split('data: ')[1]!) as JsonRpcResponse
      expect(message.id).toBe(9)
      expectNoLeak(JSON.stringify(message))
      expect((await raw(running.port, '/messages?sessionId=nada', { method: 'POST', body: '{}' })).status).toBe(404)
    } finally {
      await running.close()
    }
  })
})
