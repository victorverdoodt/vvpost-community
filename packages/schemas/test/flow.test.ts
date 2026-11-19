import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateFlow } from '../src/index.ts'
import { assertIssue, assertValid, fixture } from './helpers.ts'

const flow = (): any => fixture('checkout.flow.vvpost.json')

test('aceita o fluxo de exemplo (paralelo, Python e condição)', () => {
  assertValid(validateFlow(flow()))
})

test('fluxo vazio é válido', () => {
  assertValid(validateFlow({ id: 'flow.empty', name: 'Vazio', nodes: [] }))
})

test('tipo de nó desconhecido aponta o campo type', () => {
  const f = flow()
  f.nodes[0].type = 'javascript'
  assertIssue(validateFlow(f), '/nodes/0/type', /valor desconhecido/)
})

test('nome de nó precisa servir em $nodes.<nome>', () => {
  const f = flow()
  f.nodes[1].name = 'Get customer'
  assertIssue(validateFlow(f), '/nodes/1/name')
})

test('requisição sem endpoint exige method e url; endpoint exige connector', () => {
  const f = flow()
  delete f.nodes[0].request.method
  assertIssue(validateFlow(f), '/nodes/0/request', /method/)
  const g = flow()
  delete g.nodes[5].request.connector
  assertIssue(validateFlow(g), '/nodes/5/request', /connector/)
})

test('ids e nomes de nó são únicos', () => {
  const f = flow()
  f.nodes[2].id = 'customer'
  f.nodes[2].name = 'Customer'
  const result = validateFlow(f)
  assertIssue(result, '/nodes/2/id', /duplicado/)
  assertIssue(result, '/nodes/2/name', /duplicado/)
})

test('arestas apontam para nós que existem', () => {
  const f = flow()
  f.edges.push({ from: 'login', to: 'refund' })
  assertIssue(validateFlow(f), '/edges/6/to', /"refund" não existe/)
})

test('branch é obrigatório saindo de condição e proibido nas outras arestas', () => {
  const f = flow()
  delete f.edges[5].branch
  assertIssue(validateFlow(f), '/edges/5', /precisa de branch/)
  const g = flow()
  g.edges[0].branch = 'true'
  assertIssue(validateFlow(g), '/edges/0/branch')
})

test('ciclos são recusados com o caminho', () => {
  const f = flow()
  f.edges.push({ from: 'total', to: 'login' })
  assertIssue(validateFlow(f), '/edges', /ciclo: login → customer → total → login/)
  const g = flow()
  g.edges.push({ from: 'cart', to: 'cart' })
  assertIssue(validateFlow(g), '/edges/6/to', /a si mesmo/)
})

test('a condição lê um caminho em $nodes', () => {
  const f = flow()
  f.nodes[4].condition.target = 'status'
  assertIssue(validateFlow(f), '/nodes/4/condition/target')
  const g = flow()
  g.nodes[4].condition.target = '$nodes.Cart.data.items[0].price'
  assertValid(validateFlow(g))
})

test('mensagem de aresta duplicada', () => {
  const f = flow()
  f.edges.push({ from: 'login', to: 'cart' })
  assert.equal(validateFlow(f).ok, false)
  assertIssue(validateFlow(f), '/edges/6', /duplicada/)
})
