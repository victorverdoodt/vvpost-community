import { test } from 'node:test'
import assert from 'node:assert/strict'

delete process.env.TRANSNORTE_URL
process.env.TRANSNORTE_CLIENTE_ID = 'cli-aceite'
process.env.TRANSNORTE_API_KEY = 'chave-aceite'
const { criarTransNorte } = await import('../src/frete/transnorte.js')

test('a cotação vai para a v3 com X-Cliente-Id e X-Api-Key', async () => {
  const chamadas = []
  const fetch = async (url, init = {}) => {
    chamadas.push({ url: String(url), init })
    return { ok: true, status: 200, json: async () => ({ valor: 10, prazoDiasUteis: 2 }) }
  }
  const r = await criarTransNorte({ fetch }).cotar({ cepDestino: '01310100', pesoGramas: 500 })
  assert.equal(r.valorCentavos, 1000)
  assert.equal(chamadas[0].url, 'https://api.transnorte.example/v3/cotacoes')
  const h = Object.fromEntries(Object.entries(chamadas[0].init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  assert.equal(h['x-cliente-id'], 'cli-aceite')
  assert.equal(h['x-api-key'], 'chave-aceite')
})
