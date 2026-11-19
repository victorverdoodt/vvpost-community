import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Endpoint, Scenario } from '@vvpost/schemas'
import type { HttpResponseData, ScenarioAssertion } from '@shared/ipc'
import { createAuthEngine, type AuthEngine } from '@vvpost/core/connectors/auth'
import { summarizeWorkspace } from '@vvpost/core/connectors/summary'
import { loadWorkspace, type LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import { createHttpDispatcher, type HttpDispatcher } from '@vvpost/core/http/dispatcher'
import { evaluateAssertion, toSubject } from '@vvpost/core/scenarios/assert'
import { buildScenarioRequest } from '@vvpost/core/scenarios/request'
import { runScenarios } from '@vvpost/core/scenarios/run'
import { accessCheckScenario } from '@vvpost/core/scenarios/access'
import { dataFormatOf, parseDataFile } from '@vvpost/core/scenarios/data'

const response = (over: Partial<HttpResponseData> = {}): HttpResponseData => ({
  status: 200,
  statusText: 'OK',
  headers: [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'X-Rate-Remaining', value: '42' }
  ],
  body: JSON.stringify({ status: 'PENDING', amount: 150, items: [{ id: 'a', tags: ['pix'] }, { id: 'b' }], note: null }),
  sizeBytes: 0,
  truncated: false,
  timings: { ttfbMs: 100, downloadMs: 20, totalMs: 120 },
  ...over
})

const check = (a: ScenarioAssertion, res = response()) => evaluateAssertion(a, toSubject(res))

describe('motor de asserções', () => {
  it('equals e notEquals com igualdade profunda', () => {
    expect(check({ target: 'status', operator: 'equals', expected: 200 }).passed).toBe(true)
    expect(check({ target: 'body.status', operator: 'equals', expected: 'PENDING' })).toMatchObject({
      passed: true,
      actual: 'PENDING'
    })
    expect(check({ target: 'body.items[1]', operator: 'equals', expected: { id: 'b' } }).passed).toBe(true)
    expect(check({ target: 'body.status', operator: 'equals', expected: 'PAID' })).toMatchObject({
      passed: false,
      message: 'esperado "PAID", recebido "PENDING"'
    })
    expect(check({ target: 'status', operator: 'notEquals', expected: 500 }).passed).toBe(true)
    // Só headers comparam texto com número: no corpo, "150" e 150 são valores diferentes.
    expect(check({ target: 'headers.x-rate-remaining', operator: 'equals', expected: 42 }).passed).toBe(true)
    expect(check({ target: 'body.amount', operator: 'equals', expected: '150' }).passed).toBe(false)
  })

  it('comparações numéricas', () => {
    expect(check({ target: 'responseTimeMs', operator: 'lessThan', expected: 800 })).toMatchObject({
      passed: true,
      message: '120 < 800'
    })
    expect(check({ target: 'responseTimeMs', operator: 'lessThan', expected: 100 })).toMatchObject({
      passed: false,
      message: 'esperado < 100, recebido 120'
    })
    expect(check({ target: 'body.amount', operator: 'greaterThanOrEqual', expected: 150 }).passed).toBe(true)
    expect(check({ target: 'headers.X-Rate-Remaining', operator: 'greaterThan', expected: 10 }).passed).toBe(true)
    expect(check({ target: 'body.status', operator: 'lessThan', expected: 1 })).toMatchObject({
      passed: false,
      message: 'body.status não é um número'
    })
  })

  it('exists e notExists distinguem campo ausente de campo null', () => {
    expect(check({ target: 'body.note', operator: 'exists' }).passed).toBe(true)
    expect(check({ target: 'body.items[0].tags[0]', operator: 'exists' }).passed).toBe(true)
    expect(check({ target: 'body.error', operator: 'notExists' }).passed).toBe(true)
    expect(check({ target: 'headers.set-cookie', operator: 'notExists' }).passed).toBe(true)
    expect(check({ target: 'body.items[5]', operator: 'exists' })).toMatchObject({
      passed: false,
      message: 'body.items[5] não existe na resposta'
    })
  })

  it('contains em texto, lista e objeto; matches com regex', () => {
    expect(check({ target: 'headers.content-type', operator: 'contains', expected: 'json' }).passed).toBe(true)
    expect(check({ target: 'body.items', operator: 'contains', expected: { id: 'a' } }).passed).toBe(true)
    expect(check({ target: 'body.items[0].tags', operator: 'contains', expected: 'pix' }).passed).toBe(true)
    expect(check({ target: 'body', operator: 'contains', expected: 'amount' }).passed).toBe(true)
    expect(check({ target: 'body', operator: 'contains', expected: { status: 'PAID' } }).passed).toBe(false)
    expect(check({ target: 'body.status', operator: 'matches', expected: '^PEND' }).passed).toBe(true)
    expect(check({ target: 'body.status', operator: 'matches', expected: '/^pend/i' }).passed).toBe(true)
    expect(check({ target: 'body.status', operator: 'matches', expected: '(' }).message).toMatch(/^expressão regular inválida/)
  })

  it('matchesSchema valida contra JSON Schema e aponta onde falhou', () => {
    const schema = {
      type: 'object',
      required: ['status', 'amount'],
      properties: { status: { enum: ['PENDING', 'PAID'] }, amount: { type: 'number', minimum: 0 } }
    }
    expect(check({ target: 'body', operator: 'matchesSchema', expected: schema }).passed).toBe(true)
    const bad = check(
      { target: 'body', operator: 'matchesSchema', expected: schema },
      response({ body: JSON.stringify({ status: 'X', amount: -1 }) })
    )
    expect(bad.passed).toBe(false)
    expect(bad.message).toMatch(/^fora do schema: .*\/status.*\/amount/)
  })

  it('matchesExample confere a resposta com o schema do exemplo do mesmo status', () => {
    const examples = [
      { id: 'ok', name: '200 ok', status: 200, body: { status: 'PAID', amount: 10 }, schema: { type: 'object', required: ['status'], properties: { status: { enum: ['PENDING', 'PAID'] } } } },
      { id: 'sem-schema', name: '404', status: 404, body: { error: 'NOT_FOUND' } }
    ]
    const run = (res: HttpResponseData) => evaluateAssertion({ target: 'body', operator: 'matchesExample' }, toSubject(res), examples)
    expect(run(response())).toMatchObject({ passed: true, message: 'body segue o schema do exemplo "200 ok"' })
    const bad = run(response({ body: JSON.stringify({ status: 'X' }) }))
    expect(bad.passed).toBe(false)
    expect(bad.message).toMatch(/^fora do schema do exemplo "200 ok": \/status/)
    // Status sem exemplo com schema: falha dizendo por quê.
    expect(run(response({ status: 404, statusText: 'Not Found' }))).toMatchObject({ passed: false, message: 'nenhum exemplo de resposta 404 com schema neste endpoint' })
    expect(evaluateAssertion({ target: 'body', operator: 'matchesExample' }, toSubject(response())).message).toBe('nenhum exemplo de resposta 200 com schema neste endpoint')
  })

  it('corpo que não é JSON falha com explicação, sem exceção', () => {
    const text = response({ body: '<html>erro</html>' })
    expect(check({ target: 'body.status', operator: 'equals', expected: 1 }, text).message).toBe(
      'o corpo da resposta não é JSON'
    )
    expect(check({ target: 'body', operator: 'contains', expected: 'erro' }, text).passed).toBe(true)
    expect(check({ target: 'body', operator: 'exists' }, response({ body: '' })).passed).toBe(false)
  })
})

describe('requisição do cenário', () => {
  const endpoint: Endpoint = {
    id: 'charge',
    name: 'Cobrar',
    method: 'POST',
    path: '/customers/{customerId}/charges',
    headers: { 'Content-Type': 'application/json', 'X-Trace': 'a' },
    query: { expand: 'items', debug: '1' },
    body: { amount: 10, method: 'PIX' }
  }
  const scenario = (overrides: Scenario['overrides']): Scenario => ({
    id: 's',
    name: 'S',
    overrides,
    assertions: [{ target: 'status', operator: 'equals', expected: 200 }]
  })

  it('preenche path params (sem tocar nos {{VAR}}), mescla query e headers e troca o corpo', () => {
    const r = buildScenarioRequest(
      endpoint,
      scenario({
        pathParams: { customerId: 'cust 1/{{TENANT}}' },
        query: { debug: null, page: '{{PAGE}}' },
        headers: { 'x-trace': 'b', 'X-Tenant': null },
        body: { amount: -10 }
      })
    )
    expect(r).toEqual({
      method: 'POST',
      url: '/customers/cust%201%2F{{TENANT}}/charges?expand=items&page={{PAGE}}',
      headers: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'x-trace', value: 'b' }
      ],
      body: '{"amount":-10}',
      options: { dropHeaders: ['X-Tenant'] }
    })
  })

  it('rawPathParams vai como está (valor já codificado chega cru); os outros continuam codificados', () => {
    const ep = { ...endpoint, path: '/customers/{customerId}/charges/{chargeId}' }
    const r = buildScenarioRequest(ep, scenario({ pathParams: { customerId: '%E0/{{X}}', chargeId: '%E0' }, rawPathParams: ['customerId'] }))
    expect(r.url).toBe('/customers/%E0/{{X}}/charges/%25E0?expand=items&debug=1')
  })

  it('headers null tira todos os headers, inclusive os herdados; body null tira o corpo', () => {
    const r = buildScenarioRequest(endpoint, scenario({ pathParams: { customerId: 'c' }, headers: null, body: null }))
    expect(r.headers).toEqual([])
    expect(r.body).toBeUndefined()
    expect(r.options).toEqual({ inheritHeaders: false })
  })

  it('sem overrides usa o corpo padrão do endpoint; path param sem valor é erro de configuração', () => {
    const plain = { ...endpoint, path: '/charges' }
    expect(buildScenarioRequest(plain, scenario(undefined)).body).toBe('{"amount":10,"method":"PIX"}')
    expect(() => buildScenarioRequest(endpoint, scenario({}))).toThrow('{customerId} sem valor')
  })
})

// --- Lote contra uma API de teste com auth OAuth2 herdada ---

let server: Server
let origin: string
let tokenCalls = 0
let slowMs = 0
const seen: { path: string; auth?: string; tenant?: string; body: string }[] = []

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body = ''
  for await (const chunk of req) body += chunk
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/oauth/token') {
    tokenCalls++
    await new Promise((r) => setTimeout(r, 20))
    return json(res, 200, { access_token: 'tok', token_type: 'Bearer', expires_in: 3600 })
  }
  seen.push({
    path: url.pathname + url.search,
    auth: req.headers.authorization,
    tenant: req.headers['x-tenant'] as string | undefined,
    body
  })
  if (slowMs) await new Promise((r) => setTimeout(r, slowMs))
  if (url.pathname === '/aberto') return json(res, 200, { ok: true })
  if (req.headers.authorization !== 'Bearer tok') return json(res, 401, { error: 'unauthorized' })
  const data = JSON.parse(body || '{}')
  if (url.pathname === '/orders' && req.method === 'POST') return json(res, 201, { id: 'ord_7', total: 30 })
  if (url.pathname.startsWith('/orders/')) {
    if (req.headers['x-tenant'] === 'globex') return json(res, 403, { error: 'FORBIDDEN' })
    if (url.pathname !== '/orders/ord_7') return json(res, 404, { error: 'NOT_FOUND' })
    return json(res, 200, { id: 'ord_7', total: Number(url.searchParams.get('total')) })
  }
  if (url.pathname.endsWith('/charges') && req.method === 'POST') {
    if (typeof data.amount !== 'number' || data.amount <= 0) return json(res, 400, { error: 'INVALID_AMOUNT' })
    return json(res, 200, { id: 'ch_1', status: 'PENDING', tenant: req.headers['x-tenant'] })
  }
  return json(res, 404, { error: 'NOT_FOUND' })
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
let engine: AuthEngine
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vvpost-scenarios-'))
  engine = createAuthEngine()
  tokenCalls = 0
  slowMs = 0
  seen.length = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function write(path: string, data: unknown): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), JSON.stringify(data, null, 2))
}

/** Exemplo: POST /charges com sucesso PIX, valor inválido e sem auth, em dois ambientes. */
async function billingWorkspace(): Promise<LoadedWorkspace> {
  write('connectors/base.connector.vvpost.json', {
    id: 'corp.base',
    name: 'Base',
    version: '1.0.0',
    config: {
      baseUrl: '{{BASE_URL}}',
      headers: { 'X-Tenant': '{{TENANT}}' },
      auth: { type: 'oauth2', grantType: 'client_credentials', tokenUrl: '/oauth/token', clientId: 'app' }
    }
  })
  write('connectors/billing.connector.vvpost.json', {
    id: 'billing.v2',
    name: 'Billing',
    version: '2.0.0',
    extends: 'corp.base',
    config: { basePath: '/billing/v2' },
    endpoints: [
      {
        id: 'charge',
        name: 'Efetuar cobrança',
        method: 'POST',
        path: '/charges',
        body: { amount: 150, customerId: 'cust_1', method: 'PIX' },
        scenarios: [
          {
            id: 'pix',
            name: 'Sucesso com PIX',
            assertions: [
              { target: 'status', operator: 'equals', expected: 200 },
              { target: 'responseTimeMs', operator: 'lessThan', expected: 5000 },
              { target: 'body.status', operator: 'equals', expected: 'PENDING' }
            ]
          },
          {
            id: 'invalid_amount',
            name: 'Erro: valor inválido',
            overrides: { body: { amount: -10, customerId: 'cust_1', method: 'PIX' } },
            assertions: [
              { target: 'status', operator: 'equals', expected: 400 },
              { target: 'body.error', operator: 'equals', expected: 'INVALID_AMOUNT' }
            ]
          },
          {
            id: 'no_auth',
            name: 'Erro: sem auth',
            overrides: { headers: null },
            assertions: [{ target: 'status', operator: 'equals', expected: 401 }]
          },
          {
            id: 'wrong',
            name: 'Expectativa errada',
            assertions: [
              { target: 'status', operator: 'equals', expected: 201 },
              { target: 'body.id', operator: 'exists' }
            ]
          }
        ]
      },
      {
        id: 'get',
        name: 'Consultar',
        method: 'GET',
        path: '/charges/{chargeId}',
        scenarios: [
          {
            id: 'missing_param',
            name: 'Sem path param',
            assertions: [{ target: 'status', operator: 'equals', expected: 200 }]
          }
        ]
      }
    ]
  })
  for (const [id, tenant] of [
    ['env.dev', 'acme'],
    ['env.hml', 'globex']
  ] as const) {
    write(`environments/${id}.env.json`, {
      id,
      name: id,
      variables: { BASE_URL: { type: 'string', value: origin }, TENANT: { type: 'string', value: tenant } }
    })
  }
  return loadWorkspace(dir)
}

/** Pedidos: criar captura o id, consultar depende de criar; a consulta é proibida no tenant de hml. */
async function ordersWorkspace(scenarios: { create?: unknown[]; get?: unknown[] }): Promise<LoadedWorkspace> {
  await billingWorkspace()
  write('connectors/orders.connector.vvpost.json', {
    id: 'orders',
    name: 'Pedidos',
    version: '1.0.0',
    extends: 'corp.base',
    endpoints: [
      { id: 'create', name: 'Criar', method: 'POST', path: '/orders', body: { sku: 'A' }, scenarios: scenarios.create ?? [] },
      { id: 'get', name: 'Consultar', method: 'GET', path: '/orders/{id}', scenarios: scenarios.get ?? [] }
    ]
  })
  return loadWorkspace(dir)
}

const created = { id: 'ok', name: 'Cria', capture: { orderId: 'body.id', total: 'body.total' }, assertions: [{ target: 'status', operator: 'equals', expected: 201 }] }
const afterCreate = {
  id: 'after_create',
  name: 'Consulta o criado',
  dependsOn: ['create/ok'],
  overrides: { pathParams: { id: '{{$capture.orderId}}' }, query: { total: '{{$capture.total}}' } },
  assertions: [
    { target: 'status', operator: 'equals', expected: 200, environments: ['env.dev'] },
    { target: 'status', operator: 'equals', expected: 403, environments: ['env.hml'] },
    { target: 'body.total', operator: 'equals', expected: 30, environments: ['env.dev'] }
  ]
}

describe('cenários encadeados e expectativa por ambiente', () => {
  it('a asserção com environments só vale nos ambientes dela: 200 num, 403 no outro', async () => {
    const ws = await ordersWorkspace({ create: [created], get: [afterCreate] })
    const report = await runScenarios({ runId: 'o1', connectorId: 'orders', environmentIds: ['env.dev', 'env.hml'], scenarioKeys: ['get/after_create'] }, { workspace: ws, auth: engine, http })
    const get = report.results.filter((r) => r.scenarioId === 'after_create')
    expect(get.map((r) => [r.environmentId, r.outcome, r.assertions.map((a) => a.expected)])).toEqual([
      ['env.dev', 'passed', [200, 30]],
      ['env.hml', 'passed', [403]]
    ])
    expect(get[0]!.assertions[1]).toMatchObject({ passed: true, actual: 30 })
  })

  it('dependsOn roda antes, entra no lote fora do filtro e passa o capture adiante', async () => {
    const ws = await ordersWorkspace({ create: [created], get: [afterCreate] })
    const report = await runScenarios({ runId: 'o2', connectorId: 'orders', environmentIds: ['env.dev'], scenarioKeys: ['get/after_create'] }, { workspace: ws, auth: engine, http })
    expect(report.error).toBeUndefined()
    expect(report.results.map((r) => `${r.endpointId}/${r.scenarioId}:${r.outcome}`)).toEqual(['create/ok:passed', 'get/after_create:passed'])
    expect(report.results[0]!.captures).toEqual({ orderId: 'ord_7', total: '30' })
    expect(seen.map((x) => x.path)).toEqual(['/orders', '/orders/ord_7?total=30'])
  })

  it('dependência que não passa: o dependente nem é enviado; ciclo e cenário inexistente são erro do lote', async () => {
    const bad = { ...created, assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }
    let ws = await ordersWorkspace({ create: [bad], get: [afterCreate] })
    const ctx = () => ({ workspace: ws, auth: engine, http })
    const report = await runScenarios({ runId: 'o3', connectorId: 'orders', environmentIds: ['env.dev'] }, ctx())
    expect(report.results[1]).toMatchObject({
      scenarioId: 'after_create',
      outcome: 'error',
      error: { code: 'DEPENDENCY_FAILED', message: 'depende de create/ok, que falhou; não foi enviado' }
    })
    expect(seen.map((x) => x.path)).toEqual(['/orders'])

    ws = await ordersWorkspace({ create: [{ ...created, dependsOn: ['get/after_create'] }], get: [afterCreate] })
    expect((await runScenarios({ runId: 'o4', connectorId: 'orders' }, ctx())).error).toBe(
      'dependsOn em ciclo: create/ok → get/after_create → create/ok'
    )
    ws = await ordersWorkspace({ get: [afterCreate] })
    expect((await runScenarios({ runId: 'o5', connectorId: 'orders' }, ctx())).error).toBe(
      'get/after_create depende de create/ok, que não existe em "orders"'
    )

    // Sem a dependência, o {{$capture...}} diz o que falta.
    ws = await ordersWorkspace({ get: [{ ...afterCreate, dependsOn: undefined }] })
    const alone = await runScenarios({ runId: 'o6', connectorId: 'orders', environmentIds: ['env.dev'] }, ctx())
    expect(alone.results[0]!.error).toMatchObject({ code: 'CONFIG_ERROR', message: expect.stringContaining('nenhum cenário de dependsOn capturou "orderId"') })
  })
})

/** Endpoints que dizem se exigem auth: o gate de acesso do vvpost run. */
async function accessWorkspace(): Promise<LoadedWorkspace> {
  await billingWorkspace()
  write('connectors/acesso.connector.vvpost.json', {
    id: 'acesso',
    name: 'Acesso',
    version: '1.0.0',
    extends: 'corp.base',
    config: { headers: { 'X-Api-Key': 'chave-fixa' } },
    endpoints: [
      { id: 'privado', name: 'Privado', method: 'POST', path: '/orders/{id}', requiresAuth: true, body: { sku: 'A' } },
      {
        id: 'privado_com_valor',
        name: 'Privado com o valor do cenário',
        method: 'GET',
        path: '/orders/{id}',
        requiresAuth: true,
        scenarios: [{ id: 'ok', name: 'Consulta', overrides: { pathParams: { id: 'ord_7' } }, assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }]
      },
      { id: 'privado_aberto', name: 'Diz que exige auth, mas está aberto', method: 'GET', path: '/aberto', requiresAuth: true },
      {
        id: 'publico',
        name: 'Público',
        method: 'GET',
        path: '/aberto',
        requiresAuth: false,
        headers: { Authorization: 'Bearer do-endpoint' },
        scenarios: [{ id: 'ok', name: 'Responde', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }]
      },
      { id: 'publico_sem_cenario', name: 'Público sem cenário', method: 'GET', path: '/aberto', requiresAuth: false },
      { id: 'publico_fechado', name: 'Diz que é público, mas exige auth', method: 'GET', path: '/charges/x', requiresAuth: false },
      { id: 'sem_declarar', name: 'Sem requiresAuth', method: 'GET', path: '/aberto' }
    ]
  })
  return loadWorkspace(dir)
}

describe('gate de acesso (requiresAuth)', () => {
  it('privado: $sem-credencial vai sem auth, sem credencial herdada e sem corpo, e passa com 401/403', async () => {
    const ws = await accessWorkspace()
    const report = await runScenarios({ runId: 'a1', connectorId: 'acesso', environmentIds: ['env.dev'] }, { workspace: ws, auth: engine, http })
    expect(report.error).toBeUndefined()
    expect(report.results.map((r) => `${r.endpointId}/${r.scenarioId} ${r.status} ${r.outcome}`)).toEqual([
      'privado/$sem-credencial 401 passed',
      'privado_com_valor/ok 200 passed',
      'privado_com_valor/$sem-credencial 401 passed',
      'privado_aberto/$sem-credencial 200 failed',
      'publico/ok 200 passed',
      'publico_sem_cenario/$sem-credencial 200 passed',
      'publico_fechado/$sem-credencial 401 failed'
    ])
    const sent = (path: string) => seen.filter((s) => s.path === path)
    // O id vem do cenário quando há; senão, o UUID zerado. Nada de token, de X-Api-Key nem de corpo.
    const [privado] = sent('/orders/00000000-0000-0000-0000-000000000000')
    expect(privado).toMatchObject({ auth: undefined, tenant: 'acme', body: '' })
    expect(sent('/orders/ord_7').map((s) => s.auth ?? '').sort()).toEqual(['', 'Bearer tok'])
    // O público vai sem a auth do conector e sem o Authorization do próprio endpoint.
    expect(sent('/aberto').every((s) => s.auth === undefined && s.tenant === 'acme')).toBe(true)
    expect(report.results.find((r) => r.endpointId === 'privado_aberto')!.assertions.find((a) => !a.passed)!.message).toBe('esperado ≥ 401, recebido 200')
  })

  it('não manda os headers de credencial herdados', async () => {
    const ws = await accessWorkspace()
    const keys: (string | undefined)[] = []
    const spy: typeof http = { ...http, send: (input, options) => (keys.push(input.headers.find((h) => h.name.toLowerCase() === 'x-api-key')?.value), http.send(input, options)) }
    await runScenarios({ runId: 'a2', connectorId: 'acesso', environmentIds: ['env.dev'], endpointIds: ['privado', 'publico'] }, { workspace: ws, auth: engine, http: spy })
    expect(keys).toEqual([undefined, undefined])
  })

  it('com filtro de cenário, o $sem-credencial só roda pedido pelo nome; accessCheck: false tira', async () => {
    const ws = await accessWorkspace()
    const ctx = { workspace: ws, auth: engine, http }
    const keys = async (input: Partial<Parameters<typeof runScenarios>[0]>) =>
      (await runScenarios({ runId: 'a3', connectorId: 'acesso', environmentIds: ['env.dev'], ...input }, ctx)).results.map((r) => `${r.endpointId}/${r.scenarioId}`)
    expect(await keys({ scenarioKeys: ['privado_com_valor/ok'] })).toEqual(['privado_com_valor/ok'])
    expect(await keys({ scenarioKeys: ['privado/$sem-credencial'] })).toEqual(['privado/$sem-credencial'])
    expect(await keys({ endpointIds: ['privado_com_valor'] })).toEqual(['privado_com_valor/ok', 'privado_com_valor/$sem-credencial'])
    expect(await keys({ endpointIds: ['privado_com_valor'], accessCheck: false })).toEqual(['privado_com_valor/ok'])
  })

  it('o cenário do gate: valores do caminho, corpo e asserções', () => {
    expect(accessCheckScenario({ path: '/x/{a}/{b}', requiresAuth: true, scenarios: [{ overrides: { pathParams: { a: '{{$capture.id}}', b: '7' } } }, { overrides: { pathParams: { a: '{{ID}}' } } }] })).toMatchObject({
      id: '$sem-credencial',
      overrides: { pathParams: { a: '{{ID}}', b: '7' }, body: null }
    })
    expect(accessCheckScenario({ path: '/x', requiresAuth: false })!.overrides).toBeUndefined()
    expect(accessCheckScenario({ path: '/x', requiresAuth: false, scenarios: [{}] })).toBeUndefined()
    expect(accessCheckScenario({ path: '/x' })).toBeUndefined()
    expect(accessCheckScenario({ path: '/x', requiresAuth: true, plugin: { adapter: 'grpc' } })).toBeUndefined()
  })
})

describe('disparo em lote', () => {
  it('roda a matriz cenário × ambiente com auth herdada, overrides e asserções', async () => {
    const ws = await billingWorkspace()
    const report = await runScenarios(
      { runId: 'r1', connectorId: 'billing.v2', environmentIds: ['env.dev', 'env.hml'] },
      { workspace: ws, auth: engine, http }
    )
    expect(report.error).toBeUndefined()
    expect(report.canceled).toBe(false)
    expect(report.totals).toEqual({ passed: 6, failed: 2, error: 2 })
    const grid = report.results.map((r) => `${r.environmentId} ${r.endpointId}/${r.scenarioId} ${r.outcome}`)
    expect(grid).toEqual([
      'env.dev charge/pix passed',
      'env.dev charge/invalid_amount passed',
      'env.dev charge/no_auth passed',
      'env.dev charge/wrong failed',
      'env.dev get/missing_param error',
      'env.hml charge/pix passed',
      'env.hml charge/invalid_amount passed',
      'env.hml charge/no_auth passed',
      'env.hml charge/wrong failed',
      'env.hml get/missing_param error'
    ])

    const wrong = report.results.find((r) => r.scenarioId === 'wrong')!
    expect(wrong.assertions.map((a) => [a.passed, a.message])).toEqual([
      [false, 'esperado 201, recebido 200'],
      [true, 'body.id existe']
    ])
    expect(wrong.request).toEqual({ method: 'POST', url: '/charges' })
    expect(report.results.find((r) => r.scenarioId === 'missing_param')!.error).toEqual({
      code: 'CONFIG_ERROR',
      message: 'parâmetro de rota {chargeId} sem valor em overrides.pathParams'
    })

    // Cada ambiente busca o token uma vez (pedidos simultâneos dividem o fluxo), e o cenário
    // sem auth não leva nem o token nem os headers herdados.
    expect(tokenCalls).toBe(2)
    const noAuth = seen.filter((s) => !s.auth)
    expect(noAuth).toHaveLength(2)
    expect(noAuth.every((s) => s.tenant === undefined && s.path === '/billing/v2/charges')).toBe(true)
    expect(new Set(seen.filter((s) => s.auth).map((s) => s.tenant))).toEqual(new Set(['acme', 'globex']))
  })

  it('filtra por endpoint e por cenário; sem ambiente usa a coluna ""', async () => {
    const ws = await billingWorkspace()
    const ctx = { workspace: ws, auth: engine, http }
    const one = await runScenarios(
      { runId: 'r2', connectorId: 'billing.v2', scenarioKeys: ['charge/invalid_amount'], environmentIds: ['env.dev'] },
      ctx
    )
    expect(one.results.map((r) => r.scenarioId)).toEqual(['invalid_amount'])
    expect(JSON.parse(seen[0]!.body)).toEqual({ amount: -10, customerId: 'cust_1', method: 'PIX' })

    const noEnv = await runScenarios({ runId: 'r3', connectorId: 'billing.v2', endpointIds: ['get'] }, ctx)
    expect(noEnv.results.map((r) => [r.environmentId, r.scenarioId])).toEqual([['', 'missing_param']])
  })

  it('matchesExample usa os exemplos de resposta do endpoint', async () => {
    const ws = await billingWorkspace()
    const charge = ws.connectors.get('billing.v2')!.endpoints!.find((e) => e.id === 'charge')!
    charge.examples = [
      { id: 'ok', name: 'Cobrança criada', status: 200, schema: { type: 'object', required: ['id', 'status'], properties: { status: { const: 'PENDING' } } } },
      { id: 'erro', name: 'Valor inválido', status: 400, schema: { type: 'object', required: ['code'] } }
    ]
    for (const sc of charge.scenarios!) sc.assertions = [{ target: 'body', operator: 'matchesExample' }]
    const report = await runScenarios(
      { runId: 'r4', connectorId: 'billing.v2', scenarioKeys: ['charge/pix', 'charge/invalid_amount'], environmentIds: ['env.dev'] },
      { workspace: ws, auth: engine, http }
    )
    expect(report.results.map((r) => [r.scenarioId, r.outcome, r.assertions[0]!.message])).toEqual([
      ['pix', 'passed', 'body segue o schema do exemplo "Cobrança criada"'],
      ['invalid_amount', 'failed', expect.stringMatching(/^fora do schema do exemplo "Valor inválido": \/: .*code/)]
    ])
  })

  it('conector ou ambiente inexistente devolvem erro sem rodar nada', async () => {
    const ws = await billingWorkspace()
    const ctx = { workspace: ws, auth: engine, http }
    expect((await runScenarios({ runId: 'r4', connectorId: 'nope' }, ctx)).error).toBe('conector "nope" não existe no workspace')
    expect((await runScenarios({ runId: 'r5', connectorId: 'billing.v2', environmentIds: ['env.x'] }, ctx)).error).toBe(
      'ambiente "env.x" não existe no workspace'
    )
    expect(seen).toHaveLength(0)
  })

  it('cancelar interrompe as requisições em voo e não começa as restantes', async () => {
    const ws = await billingWorkspace()
    slowMs = 2000
    const controller = new AbortController()
    const pending = runScenarios(
      { runId: 'r6', connectorId: 'billing.v2', environmentIds: ['env.dev', 'env.hml'] },
      { workspace: ws, auth: engine, http, signal: controller.signal, concurrency: 2 }
    )
    await new Promise((r) => setTimeout(r, 300))
    controller.abort()
    const start = performance.now()
    const report = await pending
    expect(performance.now() - start).toBeLessThan(1000)
    expect(report.canceled).toBe(true)
    expect(report.results.length).toBeLessThan(10)
    expect(report.results.every((r) => r.outcome === 'error' && r.error?.code === 'ABORTED')).toBe(true)
  })

  it('o catálogo leva os cenários ao renderer como escritos, sem valores do ambiente', async () => {
    const summary = summarizeWorkspace(await billingWorkspace())
    const charge = summary.connectors.find((c) => c.id === 'billing.v2')!.endpoints[0]!
    expect(charge.scenarios.map((s) => s.id)).toEqual(['pix', 'invalid_amount', 'no_auth', 'wrong'])
    expect(charge.scenarios[2]).toEqual({
      id: 'no_auth',
      name: 'Erro: sem auth',
      overrides: { headers: null },
      assertions: [{ target: 'status', operator: 'equals', expected: 401 }]
    })
    expect(JSON.stringify(summary)).not.toContain(origin)
  })
})

describe('execução orientada a dados', () => {
  it('lê CSV com aspas, ponto e vírgula e BOM, e JSON com lista de objetos', () => {
    expect(parseDataFile('﻿nome,obs\n"Silva, A.","disse ""oi"""\r\nB,\n\n', 'csv')).toEqual({
      columns: ['nome', 'obs'],
      rows: [
        { nome: 'Silva, A.', obs: 'disse "oi"' },
        { nome: 'B', obs: '' }
      ]
    })
    expect(parseDataFile('a;b\n1;2', 'csv').rows).toEqual([{ a: '1', b: '2' }])
    expect(parseDataFile('[{"id":1,"ok":true,"tags":["x"],"n":null},{"extra":"y"}]', 'json', 'd.json')).toEqual({
      name: 'd.json',
      columns: ['id', 'ok', 'tags', 'n', 'extra'],
      rows: [{ id: '1', ok: 'true', tags: '["x"]', n: '' }, { extra: 'y' }]
    })
    expect(() => parseDataFile('a,a\n1,2', 'csv')).toThrow('a coluna "a" aparece duas vezes')
    expect(() => parseDataFile('a\n1,2', 'csv')).toThrow('a linha 2 do CSV tem 2 valores')
    expect(() => parseDataFile('a\n"1', 'csv')).toThrow('aspas abertas')
    expect(() => parseDataFile('{"a":1}', 'json')).toThrow('lista de objetos')
    expect(() => parseDataFile('a\n', 'csv')).toThrow('nenhuma linha')
    expect(dataFormatOf('x.JSON')).toBe('json')
    expect(dataFormatOf('x.csv')).toBe('csv')
  })

  it('cada linha é uma iteração: colunas viram variáveis, o esperado lê a linha e o capture fica na iteração', async () => {
    const ws = await ordersWorkspace({
      create: [created],
      get: [
        {
          ...afterCreate,
          overrides: { pathParams: { id: '{{$capture.orderId}}' }, query: { total: '{{valor}}', linha: '{{$iteration}}', d: '{{$data.valor}}' } },
          assertions: [
            { target: 'status', operator: 'equals', expected: 200 },
            { target: 'body.total', operator: 'equals', expected: '{{esperado}}' }
          ]
        }
      ]
    })
    const report = await runScenarios(
      {
        runId: 'd1',
        connectorId: 'orders',
        environmentIds: ['env.dev'],
        data: { name: 'casos.csv', rows: [{ valor: '10', esperado: '10' }, { valor: '20', esperado: '21' }] }
      },
      { workspace: ws, auth: engine, http, concurrency: 1 }
    )
    expect(report.data).toEqual({ name: 'casos.csv', iterations: 2 })
    expect(report.results.map((r) => `#${r.iteration} ${r.endpointId}/${r.scenarioId}:${r.outcome}`)).toEqual([
      '#1 create/ok:passed',
      '#1 get/after_create:passed',
      '#2 create/ok:passed',
      '#2 get/after_create:failed'
    ])
    expect(report.results[3]!.assertions[1]).toMatchObject({ passed: false, expected: 21, actual: 20 })
    expect(seen.map((x) => x.path)).toEqual(['/orders', '/orders/ord_7?total=10&linha=1&d=10', '/orders', '/orders/ord_7?total=20&linha=2&d=20'])
    expect(report.totals).toEqual({ passed: 3, failed: 1, error: 0 })
  })

  it('a coluna vence a variável do ambiente, e arquivo vazio é erro do lote', async () => {
    const ws = await ordersWorkspace({ create: [created], get: [afterCreate] })
    const report = await runScenarios(
      { runId: 'd2', connectorId: 'orders', environmentIds: ['env.dev'], scenarioKeys: ['get/after_create'], data: { rows: [{ TENANT: 'globex' }] } },
      { workspace: ws, auth: engine, http }
    )
    expect(report.results.find((r) => r.scenarioId === 'after_create')).toMatchObject({ iteration: 1, status: 403, outcome: 'failed' })
    expect((await runScenarios({ runId: 'd3', connectorId: 'orders', data: { rows: [] } }, { workspace: ws, auth: engine, http })).error).toBe(
      'o arquivo de dados não tem nenhuma linha'
    )
  })
})
