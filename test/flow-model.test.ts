import { describe, expect, it } from 'vitest'
import type { Flow } from '@shared/ipc'
import {
  ancestorsOf,
  autoLayout,
  completionsAt,
  createsCycle,
  flowIdFor,
  highImpactOperations,
  looksLikeProduction,
  pythonCompletionsAt,
  requestFromNode,
  nameProblem,
  newEndpointNode,
  nodeNameFor,
  parseEndpointDrag,
  pathExpression,
  pythonExpression,
  type KnownOutputs
} from '../src/renderer/src/modules/flow-studio/model'

const flow: Flow = {
  id: 'flow.x',
  name: 'X',
  nodes: [
    { id: 'a', name: 'Login', type: 'request', request: { method: 'POST', url: '/login' } },
    { id: 'b', name: 'Cart', type: 'request', request: { method: 'GET', url: '/cart' } },
    { id: 'c', name: 'Total', type: 'python', python: { code: 'output = 1' } }
  ],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' }
  ]
}

const outputs: KnownOutputs = new Map([
  ['Login', { data: { token: 'tok', user: { id: 7 }, 'x-y': 1 }, status: 200, headers: {} }],
  ['Cart', { data: { items: [{ price: 1 }] }, status: 200 }]
])

describe('modelo do canvas', () => {
  it('nós anteriores e ciclos', () => {
    expect(ancestorsOf(flow, 'c')).toEqual(['Login', 'Cart'])
    expect(ancestorsOf(flow, 'a')).toEqual([])
    expect(createsCycle(flow, 'c', 'a')).toBe(true)
    expect(createsCycle(flow, 'a', 'c')).toBe(false)
    expect(createsCycle(flow, 'a', 'a')).toBe(true)
  })

  it('nomes e ids', () => {
    expect(nameProblem(flow, 'c', 'Login')).toBe('já existe um nó Login')
    expect(nameProblem(flow, 'c', 'Get user')).toMatch(/^use letras/)
    expect(nameProblem(flow, 'c', 'Sum')).toBeNull()
    expect(flowIdFor('Checkout Ágil', new Set())).toBe('flow.checkout-agil')
    expect(flowIdFor('Checkout', new Set(['flow.checkout']))).toBe('flow.checkout-2')
  })

  it('caminhos do Visual Data Picker', () => {
    expect(pathExpression(['Cart', 'data', 'items', 0, 'price'])).toBe('$nodes.Cart.data.items[0].price')
    expect(pathExpression(['Login', 'data', 'x-y'])).toBe('$nodes.Login.data["x-y"]')
    expect(pythonExpression(['Cart', 'data', 'items', 0])).toBe('nodes["Cart"]["data"]["items"][0]')
  })

  it('autoLayout põe cada nó numa coluna pela profundidade', () => {
    expect(autoLayout(flow).nodes.map((n) => n.position)).toEqual([
      { x: 0, y: 0 },
      { x: 280, y: 0 },
      { x: 560, y: 0 }
    ])
  })
})

describe('autocomplete de $nodes', () => {
  const ancestors = ['Login', 'Cart']
  const labels = (before: string) => completionsAt(before, ancestors, outputs)?.items.map((i) => i.label)

  it('depois de {{ sugere as referências aos nós anteriores', () => {
    expect(completionsAt('Bearer {{ ', ancestors, outputs)).toEqual({
      replaceFrom: 10,
      items: [
        { insert: '$nodes.Login', label: '$nodes.Login' },
        { insert: '$nodes.Cart', label: '$nodes.Cart' }
      ]
    })
    expect(completionsAt('sem referência', ancestors, outputs)).toBeNull()
  })

  it('nomes de nó e campos da última execução', () => {
    expect(labels('{{ $nodes.')).toEqual(['Login', 'Cart'])
    expect(labels('{{ $nodes.Ca')).toEqual(['Cart'])
    expect(labels('{{ $nodes.Login.')).toEqual(['data', 'status', 'headers'])
    expect(labels('{{ $nodes.Login.data.to')).toEqual(['token'])
    // Chave que não é identificador fica para o Data Picker (que usa ["x-y"]).
    expect(labels('{{ $nodes.Login.data.')).toEqual(['token', 'user'])
    expect(labels('{{ $nodes.Cart.data.items[0].')).toEqual(['price'])
    expect(completionsAt('{{ $nodes.Login.data.to', ancestors, outputs)!.replaceFrom).toBe(21)
  })

  it('nó que ainda não rodou mostra data, status e headers; nó que não é anterior, nada', () => {
    expect(labels('$nodes.Cart.')).toEqual(['data', 'status'])
    expect(completionsAt('$nodes.Login.', ['Login'], new Map())!.items.map((i) => i.label)).toEqual(['data', 'status', 'headers'])
    expect(labels('{{ $nodes.Total.')).toEqual([])
  })
})

describe('abrir um nó no Quick Request', () => {
  const outputs: KnownOutputs = new Map([['Login', { data: { token: 'tok-1', cart: { id: 7 } }, status: 200 }]])
  const connectors = [
    {
      id: 'c.billing',
      name: 'Billing',
      chain: ['c.billing'],
      headers: [{ name: 'X-Tenant', value: '{{TENANT}}' }],
      endpoints: [{ id: 'charge', name: 'Cobrar', method: 'POST', path: '/charges/{id}', headers: [{ name: 'Accept', value: 'application/json' }] }]
    }
  ] as never

  it('preenche os $nodes da última execução e monta a URL do endpoint', () => {
    const { request, missing } = requestFromNode(
      {
        id: 'n',
        name: 'Charge',
        type: 'request',
        request: {
          connector: 'c.billing',
          endpoint: 'charge',
          pathParams: { id: '{{ $nodes.Login.data.cart.id }}' },
          query: { t: '{{ $nodes.Login.data.token }}' },
          headers: { Authorization: 'Bearer {{ $nodes.Login.data.token }}', Accept: null },
          body: { cart: '{{ $nodes.Login.data.cart }}', who: '{{ $nodes.Customer.data.id }}' }
        }
      },
      connectors,
      outputs
    )
    expect(request).toMatchObject({ method: 'POST', url: '/charges/7?t=tok-1', connectorId: 'c.billing', endpointId: 'charge' })
    expect(request.headers).toEqual([{ name: 'Authorization', value: 'Bearer tok-1' }])
    expect(JSON.parse(request.body)).toEqual({ cart: { id: 7 }, who: '{{ $nodes.Customer.data.id }}' })
    expect(missing).toEqual(['$nodes.Customer.data.id'])
  })
})

describe('operações de impacto elevado', () => {
  const f: Flow = {
    id: 'f',
    name: 'F',
    nodes: [
      { id: 'a', name: 'Ler', type: 'request', request: { method: 'GET', url: '/x' } },
      { id: 'b', name: 'Criar', type: 'request', request: { method: 'POST', url: '/x' } },
      { id: 'c', name: 'Apagar', type: 'request', request: { method: 'DELETE', url: '/x' } },
      { id: 'd', name: 'Script', type: 'python', python: { code: '', network: ['*'] } }
    ],
    edges: []
  }

  it('DELETE sempre; escrita e Python com rede livre só em produção', () => {
    expect(highImpactOperations(f, [], { id: 'env.dev', name: 'Dev' }).map((r) => r.name)).toEqual(['Apagar'])
    expect(highImpactOperations(f, [], { id: 'env.prod', name: 'Produção' }).map((r) => r.name)).toEqual(['Criar', 'Apagar', 'Script'])
    expect(looksLikeProduction({ id: 'env.hml', name: 'Homologação' })).toBe(false)
    expect(looksLikeProduction({ id: 'env.x', name: 'Live' })).toBe(true)
    // O catálogo decide quando traz o campo: `protected: false` libera um nome de produção.
    expect(looksLikeProduction({ id: 'env.prod', name: 'Produção', protected: false })).toBe(false)
    expect(looksLikeProduction({ id: 'env.cliente', name: 'Cliente', protected: true })).toBe(true)
  })
})

describe('autocomplete do editor Python', () => {
  const outputs: KnownOutputs = new Map([['Login', { data: { token: 't' }, status: 200 }]])
  it('sugere os nós anteriores e as chaves da saída', () => {
    expect(pythonCompletionsAt("x = nodes['Lo", ['Login', 'Cart'], outputs)).toEqual({
      typed: 'Lo',
      quote: "'",
      items: [{ insert: "Login']", label: 'Login' }]
    })
    expect(pythonCompletionsAt('nodes[', ['Login'], outputs)!.items[0]!.insert).toBe("'Login']")
    expect(pythonCompletionsAt("nodes['Login']['data']['", ['Login'], outputs)!.items.map((i) => i.label)).toEqual(['token'])
    expect(pythonCompletionsAt('print(x)', ['Login'], outputs)).toBeNull()
  })
})

describe('endpoint arrastado para o canvas', () => {
  it('vira nó de requisição que referencia conector e endpoint (a herança vem na execução)', () => {
    const node = newEndpointNode(flow, { connector: 'pay', endpoint: 'createCharge' }, 'Criar cobrança', { x: 10, y: 20 })
    expect(node).toMatchObject({ type: 'request', name: 'CriarCobranca', position: { x: 10, y: 20 } })
    expect(node.type === 'request' && node.request).toEqual({ connector: 'pay', endpoint: 'createCharge' })
    expect(flow.nodes.some((n) => n.id === node.id)).toBe(false)
  })

  it('nome repetido ganha número; nome sem letras vira Request', () => {
    const taken = { ...flow, nodes: [...flow.nodes, newEndpointNode(flow, { connector: 'c', endpoint: 'e' }, 'Criar cobrança', { x: 0, y: 0 })] }
    expect(newEndpointNode(taken, { connector: 'c', endpoint: 'e' }, 'Criar cobrança', { x: 0, y: 0 }).name).toBe('CriarCobranca1')
    expect(nodeNameFor('2 · ...')).toBe('Request')
    expect(nodeNameFor('get /pets/{id}')).toBe('GetPetsId')
  })

  it('só aceita arraste com conector e endpoint', () => {
    expect(parseEndpointDrag('{"connector":"c","endpoint":"e"}')).toEqual({ connector: 'c', endpoint: 'e' })
    expect(parseEndpointDrag('{"connector":"c"}')).toBeNull()
    expect(parseEndpointDrag('GET /x')).toBeNull()
  })
})
