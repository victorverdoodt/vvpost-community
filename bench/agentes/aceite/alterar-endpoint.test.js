import { test } from 'node:test'
import assert from 'node:assert/strict'
import { criarApp } from '../src/app.js'

const frete = { async cotar() { return { valorCentavos: 2500, prazoDias: 4, transportadora: 'transnorte' } } }
const app = () => criarApp({ frete, agora: () => new Date('2026-03-01T12:00:00Z') })

test('aceita cepEntrega e devolve cepEntrega e prazoEntregaDias', async () => {
  const r = await app().handle('POST', '/pedidos', { itens: [{ produtoId: 'p-100', quantidade: 1 }], cepEntrega: '01310-100' })
  assert.equal(r.status, 201)
  assert.equal(r.body.cepEntrega, '01310100')
  assert.equal(r.body.prazoEntregaDias, 4)
  assert.equal('cep' in r.body, false)
  assert.equal(r.body.totalCentavos, 4990 + 2500)
})

test('sem cepEntrega é 400', async () => {
  const r = await app().handle('POST', '/pedidos', { itens: [{ produtoId: 'p-100' }], cep: '01310-100' })
  assert.equal(r.status, 400)
})

test('cepEntrega inválido é 400 CEP_INVALIDO', async () => {
  const r = await app().handle('POST', '/pedidos', { itens: [{ produtoId: 'p-100' }], cepEntrega: '123' })
  assert.equal(r.status, 400)
  assert.equal(r.body.erro.codigo, 'CEP_INVALIDO')
})

test('GET /pedidos/{id} traz os campos novos', async () => {
  const a = app()
  const c = await a.handle('POST', '/pedidos', { itens: [{ produtoId: 'p-200' }], cepEntrega: '01310100' })
  const r = await a.handle('GET', `/pedidos/${c.body.id}`)
  assert.equal(r.body.cepEntrega, '01310100')
  assert.equal(r.body.prazoEntregaDias, 4)
})
