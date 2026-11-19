import { test } from 'node:test'
import assert from 'node:assert/strict'
import { criarApp } from '../src/app.js'
import { freteFixo, agoraFixo } from './apoio.js'

const novoApp = (frete = freteFixo()) => criarApp({ frete, agora: agoraFixo })

test('POST /pedidos cria o pedido com frete e total', async () => {
  const frete = freteFixo({ valorCentavos: 1990 })
  const app = novoApp(frete)
  const r = await app.handle('POST', '/pedidos', { itens: [{ produtoId: 'p-100', quantidade: 2 }], cep: '01310-100' })
  assert.equal(r.status, 201)
  assert.equal(r.body.subtotalCentavos, 9980)
  assert.equal(r.body.freteCentavos, 1990)
  assert.equal(r.body.totalCentavos, 11970)
  assert.equal(r.body.cep, '01310100')
  assert.equal(r.body.status, 'aguardando_pagamento')
  assert.deepEqual(frete.chamadas[0], { cepDestino: '01310100', pesoGramas: 700 })
})

test('POST /pedidos recusa CEP inválido', async () => {
  const r = await novoApp().handle('POST', '/pedidos', { itens: [{ produtoId: 'p-100' }], cep: '123' })
  assert.equal(r.status, 400)
  assert.equal(r.body.erro.codigo, 'CEP_INVALIDO')
})

test('POST /pedidos recusa pedido sem itens', async () => {
  const r = await novoApp().handle('POST', '/pedidos', { itens: [], cep: '01310100' })
  assert.equal(r.status, 400)
  assert.equal(r.body.erro.codigo, 'ITENS_OBRIGATORIOS')
})

test('POST /pedidos recusa produto inexistente', async () => {
  const r = await novoApp().handle('POST', '/pedidos', { itens: [{ produtoId: 'p-999' }], cep: '01310100' })
  assert.equal(r.status, 422)
})

test('GET /pedidos filtra por status', async () => {
  const app = novoApp()
  const a = await app.handle('POST', '/pedidos', { itens: [{ produtoId: 'p-100' }], cep: '01310100' })
  await app.handle('POST', '/pedidos', { itens: [{ produtoId: 'p-200' }], cep: '01310100' })
  await app.handle('POST', `/pedidos/${a.body.id}/cancelamento`, { motivo: 'desistiu' })
  const r = await app.handle('GET', '/pedidos?status=cancelado')
  assert.equal(r.body.pedidos.length, 1)
  assert.equal(r.body.pedidos[0].motivoCancelamento, 'desistiu')
})

test('GET /pedidos/{id} devolve 404 para pedido que não existe', async () => {
  const r = await novoApp().handle('GET', '/pedidos/ped-1')
  assert.equal(r.status, 404)
  assert.equal(r.body.erro.codigo, 'PEDIDO_NAO_ENCONTRADO')
})

test('POST /pedidos devolve 503 quando nenhuma transportadora cota', async () => {
  const frete = { cotar: async () => { throw new Error('fora do ar') } }
  const r = await novoApp(frete).handle('POST', '/pedidos', { itens: [{ produtoId: 'p-100' }], cep: '01310100' })
  assert.equal(r.status, 503)
  assert.equal(r.body.erro.codigo, 'FRETE_INDISPONIVEL')
})
