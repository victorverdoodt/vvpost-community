import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function arquivos(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? arquivos(p) : [p]
  })
}

test('nenhum código menciona a EntregaJá', () => {
  for (const f of arquivos('src')) assert.doesNotMatch(readFileSync(f, 'utf8'), /entrega\s*j[aá]|ENTREGAJA/i, f)
})

test('o frete padrão chama só a TransNorte e 503 quando ela falha', async () => {
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return { ok: false, status: 500, json: async () => ({}) }
  }
  const { criarApp } = await import('../src/app.js')
  const r = await criarApp().handle('POST', '/pedidos', { itens: [{ produtoId: 'p-100' }], cep: '01310100' })
  assert.equal(r.status, 503)
  assert.equal(r.body.erro.codigo, 'FRETE_INDISPONIVEL')
  assert.equal(urls.length, 1)
  assert.match(urls[0], /\/cotacoes$/)
})

test('com a TransNorte respondendo, o pedido sai pela TransNorte', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ valor: 10, prazoDiasUteis: 2 }) })
  const { criarApp } = await import('../src/app.js')
  const r = await criarApp().handle('POST', '/pedidos', { itens: [{ produtoId: 'p-100' }], cep: '01310100' })
  assert.equal(r.status, 201)
  assert.equal(r.body.transportadora, 'transnorte')
  assert.equal(r.body.freteCentavos, 1000)
})
