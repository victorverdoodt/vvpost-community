import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connector } from '@vvpost/schemas'
import { checkExample } from '@vvpost/core/connectors/registry'
import { resolveSchemaRefs } from '@vvpost/core/connectors/shared-schemas'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { matchRoute, mockRoutes, pickExample, renderTemplate, startMockServer, type MockHit, type MockRoute, type MockServer } from '@vvpost/core/mock'
import { applyProjectOps } from '../src/main/project'
import { main, type Io } from '../src/main/cli'
import { convertOpenApi } from '../src/main/importers/openapi'
import { parseImportText } from '../src/main/importers/source'

let dir = ''
const put = (path: string, data: unknown) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), JSON.stringify(data, null, 2))
}

const base: Connector = { id: 'base', name: 'Base', version: '1.0.0', config: { baseUrl: '{{BASE_URL}}', basePath: '/api' } }
const users: Connector = {
  id: 'users',
  name: 'Usuários',
  version: '1.0.0',
  extends: 'base',
  config: { basePath: '/v1' },
  endpoints: [
    {
      id: 'get',
      name: 'Buscar',
      method: 'GET',
      path: '/users/{id}',
      examples: [
        { id: 'missing', name: 'Não achou', status: 404, body: { error: 'NOT_FOUND', id: '{{$path.id}}' } },
        { id: 'ok', name: 'Achou', status: 200, headers: { 'X-Origem': 'mock' }, body: { id: '{{$path.id}}', tipo: '{{$query.tipo}}', req: '{{$uuid}}', fica: '{{NAO_EXISTE}}' } }
      ]
    },
    { id: 'me', name: 'Eu', method: 'GET', path: '/users/me', examples: [{ id: 'me', name: 'Eu', status: 200, body: 'sou eu' }] },
    { id: 'create', name: 'Criar', method: 'POST', path: '/users' }
  ]
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vvpost-mock-'))
  put('connectors/base.connector.vvpost.json', base)
  put('connectors/users.connector.vvpost.json', users)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('rotas e escolha do exemplo', () => {
  it('basePath herdado + path; o caminho literal vence o parâmetro; o pedido escolhe o exemplo', async () => {
    const { routes, problems } = mockRoutes(await loadWorkspace(dir))
    expect(problems).toEqual([])
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/v1/users/{id}', 'GET /api/v1/users/me', 'POST /api/v1/users'])
    expect(matchRoute(routes, 'GET', '/api/v1/users/me')?.route.endpointId).toBe('me')
    expect(matchRoute(routes, 'get', '/api/v1/users/a%20b')).toMatchObject({ route: { endpointId: 'get' }, params: { id: 'a b' } })
    expect(matchRoute(routes, 'DELETE', '/api/v1/users/1')).toBeUndefined()
    expect(matchRoute(routes, 'GET', '/api/v1/users/1', 'outro')).toBeUndefined()

    const examples = routes[0]!.examples
    expect(pickExample(examples, {})?.id).toBe('ok')
    expect(pickExample(examples, { status: 404 })?.id).toBe('missing')
    expect(pickExample(examples, { example: 'Não achou' })?.id).toBe('missing')
    expect(pickExample(examples, { example: 'x' })).toBeUndefined()
    expect(pickExample([{ id: 'e', name: 'e', status: 500 }], {})?.id).toBe('e')
    expect(renderTemplate('{{$path.id}}-{{$timestamp}}-{{X}}', { '$path.id': '7' })).toMatch(/^7-\d+-\{\{X\}\}$/)
  })

  it('conector inexistente ou com herança quebrada vira problema, sem derrubar os outros', async () => {
    put('connectors/bad.connector.vvpost.json', { id: 'bad', name: 'Bad', version: '1.0.0', extends: 'nope' })
    const { routes, problems } = mockRoutes(await loadWorkspace(dir), ['users', 'bad', 'x'])
    expect(routes).toHaveLength(3)
    expect(problems).toEqual([expect.stringContaining('bad:'), 'conector "x" não existe no workspace'])
  })
})

describe('mock server', () => {
  let server: MockServer
  const hits: MockHit[] = []
  let routes: MockRoute[] = []
  beforeEach(async () => {
    hits.length = 0
    routes = mockRoutes(await loadWorkspace(dir)).routes
    server = await startMockServer({ port: 0, routes: () => routes, onHit: (h) => hits.push(h) })
  })
  afterEach(() => server.close())

  it('responde o exemplo com os valores da requisição, CORS e o header de origem', async () => {
    const res = await fetch(`${server.url}/api/v1/users/42?tipo=admin`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('x-origem')).toBe('mock')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('x-vvpost-mock')).toBe('users/get#ok')
    const body = (await res.json()) as Record<string, string>
    expect(body).toMatchObject({ id: '42', tipo: 'admin', fica: '{{NAO_EXISTE}}' })
    expect(body['req']).toMatch(/^[0-9a-f-]{36}$/)
    expect(hits[0]).toMatchObject({ method: 'GET', path: '/api/v1/users/42', status: 200, connectorId: 'users', endpointId: 'get', exampleId: 'ok' })

    expect((await fetch(`${server.url}/api/v1/users/42?__status=404`)).status).toBe(404)
    const prefer = await fetch(`${server.url}/api/v1/users/9`, { headers: { Prefer: 'code=404' } })
    expect(await prefer.json()).toEqual({ error: 'NOT_FOUND', id: '9' })
    const byHeader = await fetch(`${server.url}/api/v1/users/9`, { headers: { 'X-VVPost-Example': 'missing' } })
    expect(byHeader.status).toBe(404)
    const text = await fetch(`${server.url}/api/v1/users/me`)
    expect([text.headers.get('content-type'), await text.text()]).toEqual(['text/plain; charset=utf-8', 'sou eu'])
  })

  it('sem exemplo 501, exemplo pedido que não existe 404, método errado 405, caminho fora 404, preflight 204', async () => {
    const none = await fetch(`${server.url}/api/v1/users`, { method: 'POST', body: '{}' })
    expect(none.status).toBe(501)
    expect(await none.json()).toMatchObject({ error: 'EXAMPLE_NOT_FOUND', message: 'users/create não tem nenhum exemplo de resposta' })
    const missing = await fetch(`${server.url}/api/v1/users/1?__example=nada`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ examples: [{ id: 'missing' }, { id: 'ok' }] })
    const method = await fetch(`${server.url}/api/v1/users/1`, { method: 'DELETE' })
    expect(method.status).toBe(405)
    expect(((await method.json()) as { message: string }).message).toContain('o caminho existe com GET')
    expect((await fetch(`${server.url}/outro`)).status).toBe(404)
    const preflight = await fetch(`${server.url}/api/v1/users/1`, { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET', Origin: 'http://localhost:5173' } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toContain('GET')
  })

  it('delayMs atrasa a resposta', async () => {
    routes = [{ ...routes[1]!, examples: [{ id: 'lento', name: 'Lento', status: 200, body: 'ok', delayMs: 120 }] }]
    const start = performance.now()
    await (await fetch(`${server.url}/api/v1/users/me`)).text()
    expect(performance.now() - start).toBeGreaterThanOrEqual(110)
  })
})

describe('exemplos no projeto e no importador', () => {
  it('upsertExample e deleteExample editam o endpoint; upsertEndpoint sem examples mantém os existentes', async () => {
    const file = 'connectors/users.connector.vvpost.json'
    let r = await applyProjectOps(dir, [{ op: 'upsertExample', connectorId: 'users', endpointId: 'create', example: { id: 'criado', name: 'Criado', status: 201, body: { id: 1 } } }])
    expect(r.ok).toBe(true)
    const read = () => JSON.parse(readFileSync(join(dir, file), 'utf8')) as Connector
    expect(read().endpoints![2]!.examples).toEqual([{ id: 'criado', name: 'Criado', status: 201, body: { id: 1 } }])
    r = await applyProjectOps(dir, [{ op: 'upsertEndpoint', connectorId: 'users', endpoint: { id: 'create', name: 'Criar usuário', method: 'POST', path: '/users' } }])
    expect(read().endpoints![2]).toMatchObject({ name: 'Criar usuário', examples: [{ id: 'criado' }] })
    r = await applyProjectOps(dir, [{ op: 'deleteExample', connectorId: 'users', endpointId: 'create', exampleId: 'criado' }])
    expect(read().endpoints![2]!.examples).toBeUndefined()
    r = await applyProjectOps(dir, [{ op: 'deleteExample', connectorId: 'users', endpointId: 'create', exampleId: 'criado' }])
    expect(r.ok).toBe(false)
    // Status fora de 100-599 não passa no schema.
    r = await applyProjectOps(dir, [{ op: 'upsertExample', connectorId: 'users', endpointId: 'create', example: { id: 'x', name: 'x', status: 99 } }])
    expect(r.ok).toBe(false)
  })

  it('OpenAPI: as respostas viram exemplos (os nomeados e o gerado pelo schema), fora do hash', () => {
    const spec = parseImportText(readFileSync(join(__dirname, 'fixtures/openapi/petstore.openapi.yaml'), 'utf8'), 'petstore.openapi.yaml')
    const r = convertOpenApi('petstore.openapi.yaml', spec, '/specs/petstore.openapi.yaml')
    const get = r.connectors.flatMap((c) => c.endpoints ?? []).find((e) => e.id === 'getPet')!
    expect(get.examples).toEqual([
      {
        id: 'ok-200',
        name: '200 ok',
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: expect.objectContaining({ name: 'Rex' }),
        schema: { $ref: 'schema:NewPet' }
      },
      { id: 'erro-404', name: '404 Pet não encontrado (Apagado)', status: 404, headers: { 'Content-Type': 'application/json' }, body: { error: 'NOT_FOUND' } }
    ])
    // O exemplo gerado e o nomeado seguem o schema da resposta: o validate não reprova o import.
    const resolved = get.examples!.map((x) => (x.schema ? { ...x, schema: resolveSchemaRefs(x.schema, (n) => r.schemas?.[n]) } : x))
    expect(resolved.map((x) => checkExample(x))).toEqual([[], []])
    expect(r.warnings.some((w) => w.message.startsWith('exemplos de resposta fora do schema'))).toBe(false)
    const del = r.connectors.flatMap((c) => c.endpoints ?? []).find((e) => e.id === 'deletePet')!
    expect(del.examples).toEqual([{ id: 'ok-204', name: '204 apagado', status: 204 }])
  })
})

describe('exemplo da spec fora do schema dela', () => {
  it('entra com o schema e o import avisa a operação', () => {
    const spec = {
      openapi: '3.0.3',
      info: { title: 'Loja', version: '1.0.0' },
      servers: [{ url: 'https://loja.example' }],
      paths: {
        '/itens': {
          get: {
            operationId: 'listar',
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } }, example: [1, 2] } }
              }
            }
          }
        }
      }
    }
    const r = convertOpenApi('loja.json', spec, '/specs/loja.json')
    const example = r.connectors.flatMap((c) => c.endpoints ?? [])[0]!.examples![0]!
    expect(example.schema).toEqual({ type: 'array', items: { type: 'string' } })
    expect(checkExample(example).map((i) => i.path)).toEqual(['/0', '/1'])
    expect(r.warnings.map((w) => w.message)).toContainEqual(expect.stringMatching(/^exemplos de resposta fora do schema da própria spec: .*GET \/itens/))
  })
})

describe('vvpost mock', () => {
  it('liga na porta, lista as rotas, atende e sai no Ctrl+C', async () => {
    const controller = new AbortController()
    let stdout = ''
    let stderr = ''
    const io: Io = { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env: {}, cwd: dir, isTTY: false, appDir: dir, signal: controller.signal }
    const done = main(['mock', '--workspace', dir, '--port', '0', '--connector', 'users'], io)
    for (let i = 0; i < 100 && !stderr.includes('Mock em'); i++) await new Promise((r) => setTimeout(r, 20))
    const url = /Mock em (http:\/\/[^ ]+)/.exec(stderr)![1]!
    expect(stderr).toContain('GET    /api/v1/users/{id}  users/get  404 missing, 200 ok')
    expect(stderr).toContain('POST   /api/v1/users  users/create  (sem exemplo: 501)')
    expect((await fetch(`${url}/api/v1/users/me`)).status).toBe(200)
    controller.abort()
    expect(await done).toBe(0)
    expect(stdout).toMatch(/GET {4}\/api\/v1\/users\/me {2}200 {2}users\/me#me/)

    let err = ''
    const bad = await main(['mock', '--workspace', dir, '--connector', 'nada'], { ...io, stderr: (t) => (err += t), signal: undefined })
    expect([bad, err]).toEqual([2, 'vvpost: conector "nada" não existe no workspace\n'])
  })
})
