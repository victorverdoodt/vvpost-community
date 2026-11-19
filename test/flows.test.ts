import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Flow, FlowNode } from '@vvpost/schemas'
import type { FlowRunEvent, FlowRunReport } from '@shared/ipc'
import { createAuthEngine, type AuthEngine } from '@vvpost/core/connectors/auth'
import { loadWorkspace, type LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import { Substitutions, readPath } from '@vvpost/core/flows/expressions'
import { findPython, runPython } from '@vvpost/core/flows/python'
import { runFlow } from '@vvpost/core/flows/run'
import { loadFlows, saveFlow } from '@vvpost/core/flows/workspace'
import { createHttpDispatcher, type HttpDispatcher } from '@vvpost/core/http/dispatcher'

let server: Server
let origin: string
let http: HttpDispatcher
const seen: { method: string; path: string; auth?: string; body: string; headers: IncomingMessage['headers'] }[] = []
let active = 0
let maxActive = 0
const jobPolls = new Map<string, number>()

const json = (res: ServerResponse, status: number, data: unknown) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(data))
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body = ''
  for await (const chunk of req) body += chunk
  const url = new URL(req.url ?? '/', 'http://x')
  seen.push({ method: req.method ?? '', path: url.pathname + url.search, auth: req.headers.authorization, body, headers: req.headers })
  active++
  maxActive = Math.max(maxActive, active)
  try {
    const delay = Number(url.searchParams.get('delay') ?? 0)
    if (delay) await new Promise((r) => setTimeout(r, delay))
    if (url.pathname === '/auth/login') return json(res, 200, { token: 'tok-1', cartId: 'c 1/x' })
    if (url.pathname === '/leak') return json(res, 200, { text: '{{API_TOKEN}}' })
    if (url.pathname === '/echo') return json(res, 200, { headers: req.headers, query: Object.fromEntries(url.searchParams), body })
    if (url.pathname.startsWith('/jobs/')) {
      // Processamento assíncrono: PENDING (às vezes 503) até a terceira consulta.
      const n = (jobPolls.get(url.pathname) ?? 0) + 1
      jobPolls.set(url.pathname, n)
      if (n === 1) return json(res, 503, { state: 'BUSY' })
      return json(res, 200, { state: n >= 3 ? 'DONE' : 'PENDING', polls: n })
    }
    if (req.headers.authorization !== 'Bearer tok-1' && !url.pathname.startsWith('/billing')) return json(res, 401, { error: 'unauthorized' })
    if (url.pathname === '/customers/me') return json(res, 200, { id: 'cust_9', name: 'Ana "A"' })
    if (url.pathname.startsWith('/carts/')) {
      const empty = url.pathname.endsWith('empty')
      return json(res, 200, { items: empty ? [] : [{ price: 10 }, { price: 5.5 }] })
    }
    if (url.pathname === '/billing/v2/charges') {
      if (req.headers.authorization !== 'Bearer env-token') return json(res, 401, { error: 'unauthorized' })
      return json(res, 200, { status: 'PENDING', received: JSON.parse(body) })
    }
    return json(res, 404, { error: 'NOT_FOUND' })
  } finally {
    active--
  }
}

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
  dir = mkdtempSync(join(tmpdir(), 'vvpost-flows-'))
  engine = createAuthEngine()
  seen.length = 0
  jobPolls.clear()
  active = 0
  maxActive = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function write(path: string, data: unknown): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), JSON.stringify(data, null, 2))
}

async function workspace(): Promise<LoadedWorkspace> {
  write('connectors/billing.connector.vvpost.json', {
    id: 'billing.v2',
    name: 'Billing',
    version: '2.0.0',
    config: { baseUrl: '{{BASE_URL}}', basePath: '/billing/v2', auth: { type: 'bearer', token: '{{API_TOKEN}}' } },
    endpoints: [
      { id: 'charge', name: 'Cobrar', method: 'POST', path: '/charges', body: { amount: 1, customerId: 'x', method: 'CARD' } }
    ]
  })
  write('environments/dev.env.json', {
    id: 'env.dev',
    name: 'Dev',
    variables: {
      BASE_URL: { type: 'string', value: origin },
      API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
    }
  })
  write('.vvpost/secrets.local.json', { 'env.dev': { API_TOKEN: 'env-token' } })
  return loadWorkspace(dir)
}

const request = (id: string, name: string, req: Record<string, unknown>): FlowNode =>
  ({ id, name, type: 'request', request: req }) as FlowNode

/** O exemplo do fixture do schema: login, cliente e carrinho em paralelo, total em Python, condição e cobrança. */
function checkout(cart = '{{ $nodes.Login.data.cartId }}'): Flow {
  return {
    id: 'flow.checkout',
    name: 'Checkout',
    nodes: [
      request('login', 'Login', { method: 'POST', url: '{{BASE_URL}}/auth/login', body: { user: 'ana' } }),
      request('customer', 'Customer', {
        method: 'GET',
        url: '{{BASE_URL}}/customers/me?delay=60',
        headers: { Authorization: 'Bearer {{ $nodes.Login.data.token }}' }
      }),
      request('cart', 'Cart', {
        method: 'GET',
        url: '{{BASE_URL}}/carts/{cartId}',
        pathParams: { cartId: cart },
        query: { delay: '60' },
        headers: { Authorization: 'Bearer {{ $nodes.Login.data.token }}' }
      }),
      {
        id: 'total',
        name: 'Total',
        type: 'python',
        python: {
          code: "items = nodes['Cart']['data']['items']\nprint('itens:', len(items))\noutput = {'count': len(items), 'amount': sum(i['price'] for i in items)}"
        }
      },
      { id: 'has_items', name: 'HasItems', type: 'condition', condition: { target: '$nodes.Total.data.count', operator: 'greaterThan', expected: 0 } },
      request('charge', 'Charge', {
        connector: 'billing.v2',
        endpoint: 'charge',
        body: { amount: '{{ $nodes.Total.data.amount }}', customerId: '{{ $nodes.Customer.data.id }}', note: 'para {{ $nodes.Customer.data.name }}' }
      }),
      request('empty', 'EmptyCart', { method: 'GET', url: '{{BASE_URL}}/echo?reason=vazio' })
    ],
    edges: [
      { from: 'login', to: 'customer' },
      { from: 'login', to: 'cart' },
      { from: 'customer', to: 'total' },
      { from: 'cart', to: 'total' },
      { from: 'total', to: 'has_items' },
      { from: 'has_items', to: 'charge', branch: 'true' },
      { from: 'has_items', to: 'empty', branch: 'false' }
    ]
  }
}

async function run(
  flow: Flow,
  ws?: LoadedWorkspace,
  extra: { signal?: AbortSignal; environmentId?: string; onEvent?: (e: FlowRunEvent) => void } = {}
) {
  const events: FlowRunEvent[] = []
  const onEvent = (e: FlowRunEvent) => {
    events.push(e)
    extra.onEvent?.(e)
  }
  const report = await runFlow(
    { runId: 'r1', flow, environmentId: extra.environmentId ?? 'env.dev' },
    { workspace: ws ?? (await workspace()), auth: engine, http, onEvent, ...(extra.signal && { signal: extra.signal }) }
  )
  return { report, events }
}

const byName = (report: FlowRunReport, name: string) => report.results.find((r) => r.name === name)!

describe('Context Engine', () => {
  it('roda em ordem topológica, em paralelo, acumulando $nodes até a cobrança pelo conector', async () => {
    const { report, events } = await run(checkout())
    expect(report.error).toBeUndefined()
    expect(report.outcome).toBe('success')
    expect(report.results.map((r) => r.name)).toEqual(
      expect.arrayContaining(['Login', 'Customer', 'Cart', 'Total', 'HasItems', 'Charge', 'EmptyCart'])
    )
    // Cliente e carrinho dependem só do login: rodam ao mesmo tempo.
    expect(maxActive).toBe(2)
    expect(seen.find((s) => s.path.startsWith('/carts/'))!.path).toBe('/carts/c%201%2Fx?delay=60')
    expect(seen.filter((s) => s.path.startsWith('/customers')).map((s) => s.auth)).toEqual(['Bearer tok-1'])

    expect(byName(report, 'Total')).toMatchObject({ status: 'success', output: { data: { count: 2, amount: 15.5 } }, logs: 'itens: 2' })
    expect(byName(report, 'HasItems').output!.data).toMatchObject({ result: true })
    // O corpo do endpoint é a base; o valor tipado (15.5) entra como número e o texto com aspas é escapado.
    const charge = byName(report, 'Charge')
    expect(charge).toMatchObject({ status: 'success', output: { status: 200 }, auth: { type: 'bearer', from: 'billing.v2' } })
    expect(charge.output!.data).toMatchObject({ received: { amount: 15.5, customerId: 'cust_9', note: 'para Ana "A"' } })
    expect(byName(report, 'EmptyCart')).toMatchObject({ status: 'skipped', reason: 'a condição HasItems seguiu o ramo true' })

    // running chega antes do resultado de cada nó, e o total só depois dos dois paralelos.
    const order = events.map((e) => `${e.nodeId}:${e.status}`)
    expect(order.indexOf('total:running')).toBeGreaterThan(order.indexOf('customer:success'))
    expect(order.indexOf('total:running')).toBeGreaterThan(order.indexOf('cart:success'))
    expect(order.indexOf('login:running')).toBe(0)
  })

  it('rawPathParams manda o valor como está; os outros pathParams, com $nodes, continuam codificados', async () => {
    const flow: Flow = {
      id: 'flow.raw',
      name: 'Raw',
      nodes: [
        request('login', 'Login', { method: 'POST', url: '{{BASE_URL}}/auth/login', body: { user: 'ana' } }),
        request('cart', 'Cart', {
          method: 'GET',
          url: '{{BASE_URL}}/carts/{cartId}/{item}',
          pathParams: { cartId: '{{ $nodes.Login.data.cartId }}', item: '%E0' },
          rawPathParams: ['item'],
          headers: { Authorization: 'Bearer {{ $nodes.Login.data.token }}' }
        })
      ],
      edges: [{ from: 'login', to: 'cart' }]
    }
    const { report } = await run(flow)
    expect(report.outcome).toBe('success')
    expect(seen.find((s) => s.path.startsWith('/carts/'))!.path).toBe('/carts/c%201%2Fx/%E0')
  })

  it('a saída de cada nó fica congelada', async () => {
    const { report } = await run(checkout())
    // O relatório traz as mesmas saídas que entraram em $nodes.
    const data = byName(report, 'Login').output!.data as { token: string }
    expect(Object.isFrozen(data)).toBe(true)
    expect(() => {
      ;(data as { token: string }).token = 'outro'
    }).toThrow(TypeError)
  })

  it('ramo false: o carrinho vazio pula a cobrança e segue pelo outro lado', async () => {
    const { report } = await run(checkout('empty'))
    expect(report.outcome).toBe('success')
    expect(byName(report, 'Charge')).toMatchObject({ status: 'skipped', reason: 'a condição HasItems seguiu o ramo false' })
    expect(byName(report, 'EmptyCart').status).toBe('success')
    expect(seen.some((s) => s.path.startsWith('/billing'))).toBe(false)
  })

  it('nó que junta dois ramos roda com o ramo que foi seguido', async () => {
    const flow = checkout('empty')
    flow.nodes.push({ id: 'done', name: 'Done', type: 'condition', condition: { target: '$nodes.Charge', operator: 'notExists' } })
    flow.edges!.push({ from: 'charge', to: 'done' }, { from: 'empty', to: 'done' })
    const { report } = await run(flow)
    expect(byName(report, 'Done')).toMatchObject({ status: 'success', output: { data: { result: true } } })
  })

  it('erro num nó pula os seguintes, mas os ramos independentes continuam', async () => {
    const flow: Flow = {
      id: 'flow.err',
      name: 'Erro',
      nodes: [
        request('a', 'Private', { method: 'GET', url: '{{BASE_URL}}/customers/me' }),
        request('b', 'After', { method: 'GET', url: '{{BASE_URL}}/echo' }),
        request('c', 'Other', { method: 'GET', url: '{{BASE_URL}}/echo?x=1' }),
        request('d', 'Tolerant', { method: 'GET', url: '{{BASE_URL}}/customers/me', ignoreHttpErrors: true })
      ],
      edges: [{ from: 'a', to: 'b' }]
    }
    const { report } = await run(flow)
    expect(report.outcome).toBe('failed')
    expect(byName(report, 'Private')).toMatchObject({ status: 'error', error: { code: 'HTTP_STATUS', message: 'HTTP 401 Unauthorized' }, output: { status: 401 } })
    expect(byName(report, 'After')).toMatchObject({ status: 'skipped', reason: 'Private falhou' })
    expect(byName(report, 'Other').status).toBe('success')
    expect(byName(report, 'Tolerant')).toMatchObject({ status: 'success', output: { status: 401, data: { error: 'unauthorized' } } })
  })

  it('referência a um nó que não é anterior, ou a um campo que não existe, é erro de expressão', async () => {
    const flow: Flow = {
      id: 'flow.refs',
      name: 'Refs',
      nodes: [
        request('a', 'First', { method: 'GET', url: '{{BASE_URL}}/echo' }),
        request('b', 'Sibling', { method: 'GET', url: '{{BASE_URL}}/echo?v={{ $nodes.Other.data.x }}' }),
        request('c', 'Other', { method: 'GET', url: '{{BASE_URL}}/echo' }),
        request('d', 'Missing', { method: 'GET', url: '{{BASE_URL}}/echo?v={{ $nodes.First.data.nope }}' }),
        request('e', 'Ghost', { method: 'GET', url: '{{BASE_URL}}/echo?v={{ $nodes.Nobody.data }}' })
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'd' }
      ]
    }
    const { report } = await run(flow)
    expect(byName(report, 'Sibling').error).toEqual({ code: 'EXPRESSION_ERROR', message: '$nodes.Other: o nó Other não é anterior a este nó no grafo', property: 'request.url' })
    expect(byName(report, 'Missing').error).toEqual({ code: 'EXPRESSION_ERROR', message: '{{ $nodes.First.data.nope }} não existe na saída de First', property: 'request.url' })
    expect(byName(report, 'Ghost').error!.message).toBe('$nodes.Nobody: o nó Nobody não existe no fluxo ou não rodou')
  })

  it('dados de uma resposta nunca são interpolados de novo (sem vazar segredos do ambiente)', async () => {
    const flow: Flow = {
      id: 'flow.leak',
      name: 'Leak',
      nodes: [
        request('a', 'Leak', { method: 'GET', url: '{{BASE_URL}}/leak' }),
        request('b', 'Echo', {
          method: 'POST',
          url: '{{BASE_URL}}/echo',
          query: { q: '{{ $nodes.Leak.data.text }}' },
          headers: { 'X-Copy': '{{ $nodes.Leak.data.text }}' },
          body: { copy: '{{ $nodes.Leak.data.text }}', whole: '{{ $nodes.Leak.data }}' }
        })
      ],
      edges: [{ from: 'a', to: 'b' }]
    }
    const { report } = await run(flow)
    const echoed = byName(report, 'Echo').output!.data as { headers: Record<string, string>; query: Record<string, string>; body: string }
    expect(echoed.headers['x-copy']).toBe('{{API_TOKEN}}')
    expect(echoed.query.q).toBe('{{API_TOKEN}}')
    expect(JSON.parse(echoed.body)).toEqual({ copy: '{{API_TOKEN}}', whole: { text: '{{API_TOKEN}}' } })
    expect(JSON.stringify(report)).not.toContain('env-token')
  })

  it('fluxo inválido não roda', async () => {
    const flow = checkout()
    flow.edges!.push({ from: 'total', to: 'login' })
    const { report } = await run(flow)
    expect(report.results).toEqual([])
    expect(report.error).toMatch(/^fluxo inválido: \/edges: o fluxo tem um ciclo/)
    expect(seen).toEqual([])
  })

  it('cancelar interrompe o que está em voo e não começa o resto', async () => {
    const controller = new AbortController()
    const flow: Flow = {
      id: 'flow.slow',
      name: 'Slow',
      nodes: [request('a', 'Slow', { method: 'GET', url: '{{BASE_URL}}/echo?delay=2000' }), request('b', 'Next', { method: 'GET', url: '{{BASE_URL}}/echo' })],
      edges: [{ from: 'a', to: 'b' }]
    }
    const onEvent = (e: FlowRunEvent) => e.type === 'node' && e.nodeId === 'a' && e.status === 'running' && setTimeout(() => controller.abort(), 100)
    const { report } = await run(flow, undefined, { signal: controller.signal, onEvent })
    expect(report.outcome).toBe('canceled')
    expect(report.results.map((r) => [r.name, r.error?.code])).toEqual([['Slow', 'ABORTED']])
  })
})

describe('espera, polling e asserções', () => {
  const job = (poll: Record<string, unknown>, id = 1): FlowNode =>
    request('job', 'Job', { method: 'GET', url: `{{BASE_URL}}/jobs/${id}`, poll: { until: { target: '$nodes.Job.data.state', operator: 'equals', expected: 'DONE' }, intervalMs: 100, ...poll } })

  it('polling repete a requisição até a condição valer, passando por 5xx no caminho', async () => {
    const { report } = await run({ id: 'flow.poll', name: 'Poll', nodes: [job({})] })
    expect(report.outcome).toBe('success')
    expect(byName(report, 'Job')).toMatchObject({ status: 'success', attempts: 3, output: { status: 200, data: { state: 'DONE', polls: 3 } } })
    expect(seen.filter((s) => s.path === '/jobs/1')).toHaveLength(3)
  })

  it('polling sem a condição valer a tempo falha com POLL_TIMEOUT e a última resposta', async () => {
    const { report } = await run({ id: 'flow.poll', name: 'Poll', nodes: [job({ maxAttempts: 2 })] })
    expect(report.outcome).toBe('failed')
    expect(byName(report, 'Job')).toMatchObject({
      status: 'error',
      attempts: 2,
      error: { code: 'POLL_TIMEOUT', message: 'a condição do polling não valeu em 2 tentativas: esperado "DONE", recebido "PENDING"' },
      output: { data: { state: 'PENDING' } }
    })
    const { report: slow } = await run({ id: 'flow.poll', name: 'Poll', nodes: [job({ intervalMs: 300, timeoutMs: 400 }, 2)] })
    expect(byName(slow, 'Job').error).toMatchObject({ code: 'POLL_TIMEOUT', message: expect.stringContaining('em 400 ms') })
  })

  it('nó de espera segue depois do tempo, e cancelar interrompe a espera', async () => {
    const flow: Flow = {
      id: 'flow.wait',
      name: 'Wait',
      nodes: [{ id: 'w', name: 'Wait', type: 'wait', wait: { ms: 80 } }, request('next', 'Next', { method: 'GET', url: '{{BASE_URL}}/echo' })],
      edges: [{ from: 'w', to: 'next' }]
    }
    const started = performance.now()
    const { report } = await run(flow)
    expect(performance.now() - started).toBeGreaterThanOrEqual(75)
    expect(byName(report, 'Wait')).toMatchObject({ status: 'success', output: { data: { waitedMs: 80 } } })
    expect(byName(report, 'Next').status).toBe('success')

    const controller = new AbortController()
    flow.nodes[0] = { id: 'w', name: 'Wait', type: 'wait', wait: { ms: 5000 } }
    // Cancela com a espera já rodando: um timer fixo, com a suíte inteira em paralelo, chega antes do nó.
    const onEvent = (e: FlowRunEvent) => e.type === 'node' && e.nodeId === 'w' && e.status === 'running' && setTimeout(() => controller.abort(), 20)
    const { report: canceled } = await run(flow, undefined, { signal: controller.signal, onEvent })
    expect(canceled.outcome).toBe('canceled')
    expect(canceled.results.map((r) => [r.name, r.error?.code])).toEqual([['Wait', 'ABORTED']])
  })

  it('condição com failWhenFalse falha o fluxo e não segue; quando vale, segue sem branch', async () => {
    const flow = (expected: number): Flow => ({
      id: 'flow.assert',
      name: 'Assert',
      nodes: [
        request('echo', 'Echo', { method: 'GET', url: '{{BASE_URL}}/echo' }),
        { id: 'ok', name: 'IsOk', type: 'condition', failWhenFalse: true, condition: { target: '$nodes.Echo.status', operator: 'equals', expected } },
        request('next', 'Next', { method: 'GET', url: '{{BASE_URL}}/echo' })
      ],
      edges: [{ from: 'echo', to: 'ok' }, { from: 'ok', to: 'next' }]
    })
    const { report } = await run(flow(500))
    expect(report.outcome).toBe('failed')
    expect(byName(report, 'IsOk')).toMatchObject({
      status: 'error',
      error: { code: 'ASSERTION_FAILED', message: 'esperado 500, recebido 200' },
      output: { data: { result: false, actual: 200 } }
    })
    expect(byName(report, 'Next')).toMatchObject({ status: 'skipped', reason: 'IsOk falhou' })
    const { report: passed } = await run(flow(200))
    expect(passed.outcome).toBe('success')
    expect(byName(passed, 'Next').status).toBe('success')

    const bad = flow(200)
    bad.edges![1] = { from: 'ok', to: 'next', branch: 'false' }
    expect((await run(bad)).report.error).toMatch(/o ramo "false" nunca roda/)
  })

  it('a requisição de um nó com conector mostra a URL com a baseUrl e o basePath', async () => {
    const { report } = await run(checkout())
    expect(byName(report, 'Charge').request).toEqual({ method: 'POST', url: '{{BASE_URL}}/billing/v2/charges' })
  })
})

describe('referências $nodes', () => {
  const nodes = Object.freeze({ Login: { data: { token: 't"1', items: [{ id: 7 }] }, status: 200 } })

  it('lê caminhos com chave e índice', () => {
    expect(readPath('$nodes.Login.data.items[0].id', nodes)).toBe(7)
    expect(readPath('$nodes.Login.status', nodes)).toBe(200)
    expect(readPath('$nodes.Login.data.none', nodes)).toBeUndefined()
  })

  it('no JSON, a referência inteira vira o valor tipado e no meio do texto é escapada', () => {
    const subs = new Substitutions(nodes)
    const text = subs.json({ items: '{{ $nodes.Login.data.items }}', note: 'token {{ $nodes.Login.data.token }}', n: 1 })
    const resolved = text.replace(/\{\{(\$flow:\d+)\}\}/g, (_, k: string) => subs.extra[k]!)
    expect(JSON.parse(resolved)).toEqual({ items: [{ id: 7 }], note: 'token t"1', n: 1 })
  })
})

describe('nó Python', () => {
  it('encontra um Python 3', async () => {
    expect(await findPython()).not.toBeNull()
  })

  it('recebe os nós como JSON e devolve output e logs', async () => {
    const out = await runPython("print('oi')\noutput = {'dobro': nodes['A']['data'] * 2}", { A: { data: 21 } })
    expect(out).toMatchObject({ ok: true, output: { dobro: 42 }, logs: 'oi' })
  })

  it('erro de execução e de sintaxe trazem tipo e linha', async () => {
    expect(await runPython('x = 1\nraise ValueError("ruim")', {})).toMatchObject({ ok: false, code: 'PYTHON_ERROR', message: 'ValueError: ruim (linha 2)' })
    expect(await runPython('def (:', {})).toMatchObject({ ok: false, code: 'PYTHON_ERROR', message: expect.stringMatching(/^SyntaxError: .*\(linha 1\)$/) })
    expect(await runPython('output = object()', {})).toMatchObject({ ok: false, message: expect.stringMatching(/^output não é serializável em JSON/) })
  })

  it('roda isolado: sem as variáveis de ambiente do app, numa pasta temporária vazia', async () => {
    process.env['VVPOST_TEST_SECRET'] = 's3cr3t'
    try {
      const out = await runPython("import os\noutput = {'secret': os.environ.get('VVPOST_TEST_SECRET'), 'files': os.listdir('.')}", {})
      expect(out).toMatchObject({ ok: true, output: { secret: null, files: [] } })
    } finally {
      delete process.env['VVPOST_TEST_SECRET']
    }
  })

  it('passou do tempo, o processo é encerrado', async () => {
    const out = await runPython('while True: pass', {}, { timeoutMs: 300 })
    expect(out).toMatchObject({ ok: false, code: 'TIMEOUT' })
    expect(out.durationMs).toBeLessThan(3000)
  })

  it('devolve a versão que rodou e recusa sem rodar um Python mais antigo que o pedido', async () => {
    const ok = await runPython('output = 1', {}, { version: '3.8' })
    expect(ok).toMatchObject({ ok: true, output: 1, python: expect.stringMatching(/^3\.\d+\.\d+$/) })
    const old = await runPython("print('rodou')\noutput = 1", {}, { version: '3.99' })
    expect(old).toMatchObject({
      ok: false,
      code: 'PYTHON_NOT_FOUND',
      python: ok.python,
      message: expect.stringMatching(/^O nó pede o Python 3\.99 ou mais novo, e o encontrado \(.+\) é o 3\.\d+\.\d+\. Instale/)
    })
    expect(old.logs).toBe('')
  })

  it('sem interpretador, o erro diz como resolver', async () => {
    const out = await runPython('output = 1', {}, { interpreter: ['vvpost-python-inexistente'] })
    expect(out).toMatchObject({ ok: false, code: 'PYTHON_NOT_FOUND' })
  })
})

describe('arquivos de fluxo', () => {
  it('grava em flows/<id>.flow.vvpost.json, relê e recusa id repetido em outro arquivo', async () => {
    const flow = checkout()
    expect(await saveFlow(dir, flow)).toEqual({ file: 'flows/flow.checkout.flow.vvpost.json' })
    const saved = JSON.parse(readFileSync(join(dir, 'flows/flow.checkout.flow.vvpost.json'), 'utf8'))
    expect(Object.keys(saved)[0]).toBe('$schema')
    await expect(saveFlow(dir, flow)).rejects.toThrow(/já existe/)
    await expect(saveFlow(dir, flow, 'outro/x.flow.vvpost.json')).rejects.toThrow(/já é do fluxo em flows\/flow.checkout/)
    await expect(saveFlow(dir, flow, '../fora.flow.vvpost.json')).rejects.toThrow(/caminho de fluxo inválido/)
    // Regravar no mesmo arquivo vale.
    flow.name = 'Checkout 2'
    expect(await saveFlow(dir, flow, 'flows/flow.checkout.flow.vvpost.json')).toEqual({ file: 'flows/flow.checkout.flow.vvpost.json' })

    write('flows/broken.flow.vvpost.json', { id: 'flow.broken', name: 'x', nodes: [{ id: 'a', name: 'A', type: 'nope' }] })
    const catalog = await loadFlows(dir)
    expect(catalog.flows.map((f) => [f.file, f.flow.name])).toEqual([['flows/flow.checkout.flow.vvpost.json', 'Checkout 2']])
    expect(catalog.issues).toEqual([{ file: 'flows/broken.flow.vvpost.json', message: '/nodes/0/type: valor desconhecido "nope"' }])
  })
})
