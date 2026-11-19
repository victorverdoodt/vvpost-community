import { test } from 'node:test'
import assert from 'node:assert/strict'

const chamadas = []
const conhecidos = new Set()
process.env.TRANSNORTE_API_KEY = 'chave-aceite'
globalThis.fetch = async (url, init = {}) => {
  url = String(url)
  chamadas.push({ url, init })
  if (url.endsWith('/cotacoes')) return { ok: true, status: 200, json: async () => ({ valor: 12.5, prazoDiasUteis: 3 }) }
  const m = url.match(/\/rastreamentos\/([^/?]+)$/)
  if (m && conhecidos.has(decodeURIComponent(m[1]))) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ codigo: m[1], eventos: [{ quando: '2026-03-02T09:00:00Z', descricao: 'Objeto postado', cidade: 'São Paulo' }] })
    }
  }
  return { ok: false, status: 404, json: async () => ({}) }
}

const { criarApp } = await import('../src/app.js')

test('GET /pedidos/{id}/rastreio consulta a TransNorte com o id do pedido', async () => {
  const app = criarApp()
  const p = await app.handle('POST', '/pedidos', { itens: [{ produtoId: 'p-100' }], cep: '01310100' })
  assert.equal(p.status, 201)
  conhecidos.add(p.body.id)
  const r = await app.handle('GET', `/pedidos/${p.body.id}/rastreio`)
  assert.equal(r.status, 200)
  assert.equal(r.body.codigo, p.body.id)
  assert.equal(r.body.eventos.length, 1)
  assert.equal(r.body.eventos[0].descricao, 'Objeto postado')
  const c = chamadas.find((x) => x.url.includes('/rastreamentos/'))
  assert.match(c.url, new RegExp(`/rastreamentos/${p.body.id}$`))
  const headers = Object.fromEntries(Object.entries(c.init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  assert.equal(headers['x-api-key'], 'chave-aceite')
})

test('pedido que não existe é 404 PEDIDO_NAO_ENCONTRADO', async () => {
  const r = await criarApp().handle('GET', '/pedidos/ped-1/rastreio')
  assert.equal(r.status, 404)
  assert.equal(r.body.erro.codigo, 'PEDIDO_NAO_ENCONTRADO')
})

test('código desconhecido na TransNorte é 404 RASTREIO_NAO_ENCONTRADO', async () => {
  conhecidos.clear()
  const app = criarApp()
  const p = await app.handle('POST', '/pedidos', { itens: [{ produtoId: 'p-100' }], cep: '01310100' })
  const r = await app.handle('GET', `/pedidos/${p.body.id}/rastreio`)
  assert.equal(r.status, 404)
  assert.equal(r.body.erro.codigo, 'RASTREIO_NAO_ENCONTRADO')
})
