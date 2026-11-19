import { describe, expect, it } from 'vitest'
import { validateFlow, type Flow } from '@vvpost/schemas'
import { flowToRequest, requestToFlow, simpleSignature, splitFlow, type SimpleRequest } from '@vvpost/core/flows/simple-flow'

// Requisição e fluxo são o mesmo documento: a visão Simples (Quick Request) e a Canvas (Flow Studio).

const req: SimpleRequest = {
  method: 'POST',
  url: '/charges?x=1',
  headers: [
    { name: 'X-Tenant', value: '{{TENANT}}' },
    { name: ' ', value: 'ignorado' }
  ],
  body: '{\n  "valor": 10\n}',
  connector: 'payments',
  endpoint: 'create_charge',
  scripts: { pre: 'vv.request.headers.a = "1"', post: '   ' }
}

describe('requisição como fluxo de um nó', () => {
  it('vira um fluxo válido de um nó, que volta à mesma requisição', () => {
    const flow = requestToFlow(req, { id: 'flow.cobranca', name: 'Cobrança' })
    expect(validateFlow(flow).ok).toBe(true)
    expect(flow.nodes).toHaveLength(1)
    expect(flow.nodes[0]).toMatchObject({
      type: 'request',
      request: { connector: 'payments', endpoint: 'create_charge', ignoreHttpErrors: true, requestScripts: { pre: 'vv.request.headers.a = "1"' } }
    })
    const back = flowToRequest(flow)!
    expect(back).toMatchObject({ method: 'POST', url: '/charges?x=1', headers: [{ name: 'X-Tenant', value: '{{TENANT}}' }], body: req.body })
    expect(simpleSignature(back)).toBe(simpleSignature(req))
  })

  it('o endpoint só vale com o conector, e um corpo vazio fica de fora', () => {
    const flow = requestToFlow({ method: 'GET', url: 'https://x.dev', headers: [], body: '', endpoint: 'e' }, { id: 'f', name: 'F' })
    expect(validateFlow(flow).ok).toBe(true)
    const r = (flow.nodes[0] as Extract<Flow['nodes'][number], { type: 'request' }>).request
    expect(r.endpoint).toBeUndefined()
    expect('body' in r).toBe(false)
  })

  it('um corpo JSON e a query do nó entram como texto na visão Simples', () => {
    const flow: Flow = {
      id: 'f',
      name: 'F',
      nodes: [{ id: 'a', name: 'A', type: 'request', request: { method: 'POST', url: '/x', query: { q: 'a b' }, body: { n: 1 } } }]
    }
    expect(flowToRequest(flow)).toMatchObject({ url: '/x?q=a%20b', body: '{\n  "n": 1\n}' })
  })

  it('o que a visão Simples não mostra fica no canvas', () => {
    const one = (request: Record<string, unknown>): Flow => ({ id: 'f', name: 'F', nodes: [{ id: 'a', name: 'A', type: 'request', request: { method: 'GET', url: '/x', ...request } }] })
    expect(flowToRequest(one({}))).not.toBeNull()
    expect(flowToRequest(one({ fromScript: 'Pre' }))).toBeNull()
    expect(flowToRequest(one({ scripts: false }))).toBeNull()
    expect(flowToRequest(one({ headers: { Authorization: null } }))).toBeNull()
    expect(flowToRequest(one({ poll: { until: { target: '$nodes.A.status', operator: 'equals', expected: 200 } } }))).toBeNull()
    expect(flowToRequest({ id: 'f', name: 'F', nodes: [{ id: 'a', name: 'A', type: 'request', request: { connector: 'c', endpoint: 'e' } }] })).toBeNull()
    // Um nó solto, que não roda antes da requisição, não cabe.
    const two = one({})
    two.nodes.push({ id: 'b', name: 'B', type: 'wait', wait: { ms: 1 } })
    expect(flowToRequest(two)).toBeNull()
  })
})

describe('fluxo que termina numa requisição', () => {
  const login: Flow['nodes'][number] = { id: 'login', name: 'Login', type: 'request', position: { x: 0, y: 0 }, request: { method: 'POST', url: '/login' } }
  const espera: Flow['nodes'][number] = { id: 'espera', name: 'Espera', type: 'wait', position: { x: 260, y: 0 }, wait: { ms: 10 } }
  const flow: Flow = {
    id: 'flow.perfil',
    name: 'Perfil',
    nodes: [
      login,
      espera,
      { id: 'perfil', name: 'Perfil', type: 'request', position: { x: 520, y: 0 }, request: { method: 'GET', url: '/me', headers: { Authorization: 'Bearer {{ $nodes.Login.data.token }}' } } }
    ],
    edges: [
      { from: 'login', to: 'espera' },
      { from: 'espera', to: 'perfil' }
    ]
  }

  it('a visão Simples edita o último nó; os anteriores são a preparação', () => {
    const split = splitFlow(flow)!
    expect(split.request).toMatchObject({ method: 'GET', url: '/me', headers: [{ name: 'Authorization', value: 'Bearer {{ $nodes.Login.data.token }}' }] })
    expect(split.node).toEqual({ id: 'perfil', name: 'Perfil', position: { x: 520, y: 0 } })
    expect(split.before?.nodes.map((n) => n.name)).toEqual(['Login', 'Espera'])
    expect(split.before?.edges).toEqual([{ from: 'login', to: 'espera' }])
    expect(split.incoming).toEqual(['espera'])
  })

  it('salvar da visão Simples devolve o mesmo grafo, com a requisição editada', () => {
    const split = splitFlow(flow)!
    const saved = requestToFlow({ ...split.request, url: '/me?full=1' }, { id: flow.id, name: flow.name }, split)
    expect(validateFlow(saved).ok).toBe(true)
    expect(saved.nodes.map((n) => n.id)).toEqual(['login', 'espera', 'perfil'])
    expect(saved.edges).toEqual(flow.edges)
    expect(splitFlow(saved)!.request.url).toBe('/me?full=1')
  })

  it('uma preparação vira os nós de antes, ligada pelos nós finais dela', () => {
    const prep: Flow = { id: 'flow.login', name: 'Login', nodes: [login], edges: [] }
    const saved = requestToFlow({ method: 'GET', url: '/me', headers: [] }, { id: 'f', name: 'F' }, { before: prep })
    expect(validateFlow(saved).ok).toBe(true)
    expect(saved.nodes.map((n) => n.name)).toEqual(['Login', 'Requisicao'])
    expect(saved.edges).toEqual([{ from: 'login', to: 'request' }])
    expect(saved.nodes[1]!.position).toEqual({ x: 260, y: 0 })
  })

  it('dois finais, ou um final que não é requisição, ficam no canvas', () => {
    expect(splitFlow({ ...flow, edges: [{ from: 'login', to: 'perfil' }] })).toBeNull()
    expect(splitFlow({ ...flow, nodes: [login, espera], edges: [{ from: 'login', to: 'espera' }] })).toBeNull()
  })
})

describe('fluxo que herda na visão Simples', () => {
  const charge: Flow = {
    id: 'billing.charge',
    name: 'Cobrar',
    extends: 'billing',
    nodes: [{ id: 'request', name: 'Request', type: 'request', request: { method: 'POST', url: '/charges', body: { amount: 1 }, bodySchema: { type: 'object' } } }],
    scenarios: [{ id: 'ok', name: 'OK', assertions: [{ target: 'status', operator: 'equals', expected: 201 }] }],
    examples: [{ id: 'ok', name: 'OK', status: 201 }],
    source: { operation: 'POST /charges', hash: 'h' }
  }

  it('a base vira o conector da aba, e salvar devolve a herança, os cenários e o schema do corpo', () => {
    const split = splitFlow(charge)!
    expect(split.request.connector).toBe('billing')
    const saved = requestToFlow({ ...split.request, url: '/charges/v2' }, { id: charge.id, name: charge.name, keep: split.keep }, { node: split.node })
    expect(validateFlow(saved).ok).toBe(true)
    expect(saved).toMatchObject({ extends: 'billing', scenarios: charge.scenarios, examples: charge.examples, source: charge.source })
    // O conector da base não vai para o nó: ele continua sendo o endpoint da base.
    expect(saved.nodes[0]).toMatchObject({ request: { url: '/charges/v2', bodySchema: { type: 'object' } } })
    expect((saved.nodes[0] as { request: { connector?: string } }).request.connector).toBeUndefined()
  })

  it('um fluxo-base fica no canvas', () => {
    const base: Flow = {
      id: 'billing',
      name: 'Billing',
      defaults: { headers: { Authorization: 'Bearer {{ $nodes.Login.data.token }}' } },
      nodes: [{ id: 'login', name: 'Login', type: 'request', cache: {}, request: { method: 'POST', url: '/login' } }]
    }
    expect(splitFlow(base)).toBeNull()
  })
})
