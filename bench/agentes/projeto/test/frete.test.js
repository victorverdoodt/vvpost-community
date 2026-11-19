import { test } from 'node:test'
import assert from 'node:assert/strict'
import { criarFrete } from '../src/frete/index.js'
import { criarTransNorte } from '../src/frete/transnorte.js'
import { criarEntregaJa } from '../src/frete/entregaja.js'
import { fetchFalso } from './apoio.js'

test('TransNorte cota em reais e converte para centavos', async () => {
  const fetch = fetchFalso({ valor: 23.5, prazoDiasUteis: 3 })
  const r = await criarTransNorte({ fetch, apiKey: 'k' }).cotar({ cepDestino: '01310100', pesoGramas: 1500 })
  assert.deepEqual(r, { valorCentavos: 2350, prazoDias: 3, transportadora: 'transnorte' })
  assert.match(fetch.chamadas[0].url, /\/cotacoes$/)
  assert.equal(JSON.parse(fetch.chamadas[0].init.body).pesoKg, 1.5)
  assert.equal(fetch.chamadas[0].init.headers['x-api-key'], 'k')
})

test('EntregaJá cota por query string', async () => {
  const fetch = fetchFalso({ precoCentavos: 1800, prazo: 5 })
  const r = await criarEntregaJa({ fetch, token: 't' }).cotar({ cepDestino: '01310100', pesoGramas: 700 })
  assert.deepEqual(r, { valorCentavos: 1800, prazoDias: 5, transportadora: 'entregaja' })
  assert.match(fetch.chamadas[0].url, /\/v1\/frete\?cep=01310100&peso=700$/)
})

test('frete usa a EntregaJá quando a TransNorte falha', async () => {
  const falha = { nome: 'transnorte', cotar: async () => { throw new Error('timeout') } }
  const ok = { nome: 'entregaja', cotar: async () => ({ valorCentavos: 1000, prazoDias: 6, transportadora: 'entregaja' }) }
  const r = await criarFrete({ provedores: [falha, ok] }).cotar({ cepDestino: '01310100', pesoGramas: 100 })
  assert.equal(r.transportadora, 'entregaja')
})

test('frete falha com a lista de erros quando todas falham', async () => {
  const falha = (nome) => ({ nome, cotar: async () => { throw new Error('fora') } })
  await assert.rejects(criarFrete({ provedores: [falha('a'), falha('b')] }).cotar({}), /a: fora; b: fora/)
})
