import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { createMcpServer, type McpServer } from '../src/main/mcp/server'

// Renomear um campo é uma chamada: replace_references troca a chave nos schemas compartilhados,
// nos exemplos e no required de cada endpoint e o nome nas páginas, no projeto do benchmark de agentes.

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-replace-'))
  dirs.push(dir)
  cpSync(join(__dirname, '..', 'bench', 'agentes', 'vvpost', 'api'), dir, { recursive: true })
  return dir
}

const http = { cancel() {}, send: async () => ({ ok: false as const, error: { code: 'X', message: 'sem rede' } }) }
const server = (dir: string): McpServer => createMcpServer({ workspaceDir: dir, http: http as never, auth: createAuthEngine() })

async function call(s: McpServer, name: string, args: Record<string, unknown>) {
  const res = (await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as {
    result: { isError: boolean; content: { text: string }[] }
  }
  return { isError: res.result.isError, data: JSON.parse(res.result.content[0]!.text) }
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8')
const lojaFlows = (dir: string) =>
  [...readdirSync(join(dir, 'flows', 'loja-api')).map((f) => `flows/loja-api/${f}`), ...readdirSync(join(dir, 'schemas')).map((f) => `schemas/${f}`)]
    .map((f) => read(dir, f))
    .join('\n')

describe('MCP: replace_references', () => {
  it('renomeia o campo no corpo, nas respostas, nos exemplos e nas páginas, só onde foi pedido', async () => {
    const dir = project()
    const s = server(dir)
    const transnorte = read(dir, 'flows/transnorte/listarPontos.flow.vvpost.json')
    const entregaja = read(dir, 'flows/entregaja/cotarFrete.flow.vvpost.json')

    const preview = await call(s, 'replace_references', { from: 'cep', to: 'cepEntrega', in: ['loja-api', 'docs/'], dryRun: true })
    expect(preview.data).toMatchObject({ ok: true, dryRun: true })
    expect(preview.data.replaced).toBeGreaterThan(5)
    // O schema compartilhado que os endpoints da Loja citam entra junto, mesmo com in só no conector.
    expect(preview.data.files.map((f: { file: string }) => f.file)).toEqual(expect.arrayContaining(['schemas/Pedido.schema.json', 'schemas/NovoPedido.schema.json']))
    expect(lojaFlows(dir)).toContain('"cep"')

    const done = await call(s, 'replace_references', { from: 'cep', to: 'cepEntrega', in: ['loja-api', 'docs/'] })
    expect(done.data).toMatchObject({ ok: true, replaced: preview.data.replaced, catalog: { issues: 0 } })
    expect(lojaFlows(dir)).not.toContain('"cep"')
    expect(lojaFlows(dir)).toContain('"cepEntrega"')
    expect(read(dir, 'docs/guia-de-integracao.md')).toContain('`cepEntrega` de entrega')
    // CEP em prosa e campos de outro conector ficam como estavam; o que só parece o termo vem em nearMisses.
    expect(read(dir, 'flows/transnorte/listarPontos.flow.vvpost.json')).toBe(transnorte)
    expect(read(dir, 'flows/entregaja/cotarFrete.flow.vvpost.json')).toBe(entregaja)
    expect(done.data.nearMisses?.some((m: { text: string }) => /CEP/.test(m.text))).toBe(true)

    // O catálogo continua válido e o endpoint exige o campo novo.
    const source = await call(s, 'get_source', { kind: 'schema', id: 'NovoPedido' })
    expect(source.data.schema.required).toEqual(['itens', 'cepEntrega'])

    expect((await call(s, 'replace_references', { from: 'cep', to: 'cepEntrega', in: ['loja-api'] })).data).toMatchObject({ ok: true, replaced: 0 })
  })

  it('id não muda por troca de texto, e um lote inválido não grava nada', async () => {
    const dir = project()
    const s = server(dir)
    const before = lojaFlows(dir)
    const ids = await call(s, 'replace_references', { from: 'criarPedido', to: 'novoPedido', in: ['loja-api'] })
    expect(ids.data.skipped?.[0]).toMatchObject({ reason: expect.stringContaining('moveEndpoint') })
    // O nome que é id em todo lugar não sobra para trocar, e o catálogo fica igual.
    expect(lojaFlows(dir)).toBe(before)

    const page = read(dir, 'docs/frete.md')
    const bad = await call(s, 'replace_references', { from: 'GET', to: 'BUSCAR', in: ['loja-api', 'docs/frete.md'] })
    expect(bad.data.ok).toBe(false)
    expect(lojaFlows(dir)).toBe(before)
    expect(read(dir, 'docs/frete.md')).toBe(page)
  })

  it('um campo obrigatório novo num schema compartilhado avisa dos exemplos que ficaram fora dele', async () => {
    const s = server(project())
    const res = await call(s, 'edit_project', {
      ops: [{ op: 'setSchemaField', name: 'Pedido', path: 'prazoEntregaDias', field: { type: 'integer', required: true } }]
    })
    expect(res.data.ok).toBe(true)
    // Antes, num projeto em fluxos, a validação do lote não via os endpoints e não avisava nada.
    expect(res.data.warnings.map((w: { message: string }) => w.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('"loja-api/criarPedido": exemplo de resposta "201 Pedido criado" fora do schema dele')])
    )
  })

  it('fillExamples leva o campo novo do schema para os exemplos que o citam, e o lote sai sem aviso', async () => {
    const dir = project()
    const s = server(dir)
    const res = await call(s, 'edit_project', {
      ops: [{ op: 'setSchemaField', name: 'Pedido', path: 'prazoEntregaDias', field: { type: 'integer', required: true, example: 3 }, fillExamples: true }]
    })
    expect(res.data.ok).toBe(true)
    expect(res.data.warnings).toBeUndefined()
    // Os quatro endpoints que devolvem o pedido, inclusive a lista de listarPedidos (pedidos[]).
    for (const f of ['criarPedido', 'obterPedido', 'cancelarPedido', 'listarPedidos']) {
      expect(read(dir, `flows/loja-api/${f}.flow.vvpost.json`)).toContain('"prazoEntregaDias": 3')
    }
    expect(read(dir, 'flows/loja-api/listarProdutos.flow.vvpost.json')).not.toContain('prazoEntregaDias')
  })

  it('patchConnector mescla config por chave e aceita headers como lista', async () => {
    const dir = project()
    const s = server(dir)
    const res = await call(s, 'edit_project', {
      ops: [{ op: 'patchConnector', id: 'transnorte', set: { config: { baseUrl: 'https://api.transnorte.example/v3', headers: [{ name: 'X-Cliente-Id', value: '{{TRANSNORTE_CLIENTE_ID}}' }] } } }]
    })
    expect(res.data.ok).toBe(true)
    expect(res.data.warnings?.[0]?.message).toContain('{"Nome": "valor"}')
    const base = JSON.parse(read(dir, 'flows/transnorte/transnorte.flow.vvpost.json'))
    expect(base.defaults).toMatchObject({ baseUrl: 'https://api.transnorte.example/v3', headers: { 'X-Cliente-Id': '{{TRANSNORTE_CLIENTE_ID}}' }, auth: { type: 'apiKey' } })
  })
})

describe('MCP: a mudança de API num edit_project só', () => {
  it('troca o nome, acrescenta o campo nos exemplos e edita o guia, tudo numa chamada', async () => {
    const dir = project()
    const s = server(dir)
    const res = await call(s, 'edit_project', {
      ops: [
        { op: 'replaceReferences', from: 'cep', to: 'cepEntrega', in: ['loja-api', 'docs/'] },
        { op: 'setSchemaField', name: 'Pedido', path: 'prazoEntregaDias', field: { type: 'integer', required: true, example: 4 }, fillExamples: true },
        // O find copiado da página de antes da troca ainda acha o trecho.
        { op: 'writePage', file: 'docs/guia-de-integracao.md', edits: [{ find: 'Mande os itens e o `cep` de entrega', replace: 'Mande os itens e o `cepEntrega` (o prazo volta em `prazoEntregaDias`)' }] }
      ]
    })
    expect(res.isError).toBe(false)
    expect(res.data).toMatchObject({ ok: true, catalog: { issues: 0 } })
    expect(res.data.replaced).toBeGreaterThan(5)
    expect(res.data.pages).toEqual([{ file: 'docs/guia-de-integracao.md' }])
    expect(lojaFlows(dir)).not.toContain('"cep"')
    expect(read(dir, 'flows/loja-api/obterPedido.flow.vvpost.json')).toContain('"prazoEntregaDias": 4')
    expect(read(dir, 'docs/guia-de-integracao.md')).toContain('o prazo volta em `prazoEntregaDias`')
  })

  it('com um erro no catálogo, a página não muda; replaceReferences roda primeiro em qualquer posição', async () => {
    const dir = project()
    const s = server(dir)
    const guia = read(dir, 'docs/guia-de-integracao.md')
    const bad = await call(s, 'edit_project', {
      ops: [
        { op: 'replaceReferences', from: 'cep', to: 'cepEntrega', in: ['loja-api', 'docs/'] },
        { op: 'deleteEndpoint', connectorId: 'loja-api', endpointId: 'naoExiste' }
      ]
    })
    expect(bad.data.ok).toBe(false)
    expect(read(dir, 'docs/guia-de-integracao.md')).toBe(guia)
    expect(lojaFlows(dir)).toContain('"cep"')

    const order = await call(s, 'edit_project', {
      ops: [
        { op: 'setSchemaField', name: 'Pedido', path: 'x', field: { type: 'string' } },
        { op: 'replaceReferences', from: 'cep', to: 'cepEntrega' }
      ]
    })
    expect(order.data.ok).toBe(true)
    const pedido = read(dir, 'schemas/Pedido.schema.json')
    expect(pedido).toContain('"cepEntrega"')
    expect(pedido).toContain('"x"')
  })
})

describe('MCP: replaceReferences sem acerto', () => {
  it('recusa o lote quando a troca não acha nada, e aceita o nome entre aspas e a pasta sem barra', async () => {
    const dir = project()
    const s = server(dir)
    const none = await call(s, 'edit_project', {
      ops: [
        { op: 'replaceReferences', from: 'cepp', to: 'cepEntrega' },
        { op: 'setSchemaField', name: 'Pedido', path: 'prazoEntregaDias', field: { type: 'integer' } }
      ]
    })
    expect(none.isError).toBe(true)
    expect(none.data).toMatchObject({ code: 'VALIDATION' })
    expect(none.data.error).toContain('ops[0]')
    expect(read(dir, 'schemas/Pedido.schema.json')).not.toContain('prazoEntregaDias')

    const quoted = await call(s, 'edit_project', { ops: [{ op: 'replaceReferences', from: '"cep"', to: '"cepEntrega"', in: ['schemas', 'flows/loja-api'] }] })
    expect(quoted.data).toMatchObject({ ok: true })
    expect(lojaFlows(dir)).not.toContain('"cep"')
  })

  it('aponta o erro na op que o agente mandou', async () => {
    const s = server(project())
    const res = await call(s, 'edit_project', {
      ops: [
        { op: 'replaceReferences', from: 'cep', to: 'cepEntrega', in: ['loja-api'] },
        { op: 'upsertSchema', name: 'Pedido', schema: null }
      ]
    })
    expect(res.data.ok).toBe(false)
    expect(res.data.errors[0].at).toBe('ops[1] (upsertSchema)')
  })
})

describe('MCP: erros que dizem o caminho certo', () => {
  it('o id de um endpoint no lugar do conector aponta o conector e o endpoint', async () => {
    const s = server(project())
    const patch = await call(s, 'edit_project', { ops: [{ op: 'patchConnector', id: 'loja-api.criarPedido', set: { description: 'x' } }] })
    expect(JSON.stringify(patch.data)).toContain('é o endpoint \\"criarPedido\\" do conector \\"loja-api\\"')
    const catalog = await call(s, 'get_api_catalog', { connectorId: 'loja-api.criarPedido' })
    expect(catalog.isError).toBe(true)
    expect(catalog.data.error).toContain('use connectorId "loja-api"')
  })

  it('um schema que só cita a si mesmo é recusado com a explicação', async () => {
    const s = server(project())
    const r = await call(s, 'edit_project', { ops: [{ op: 'upsertSchema', name: 'Pedido', schema: { $ref: 'schema:Pedido' } }] })
    expect(JSON.stringify(r.data)).toContain('não pode ser só a citação dele mesmo')
  })

  it('o detalhe do conector não repete o que o bodySchema e a herança já dizem', async () => {
    const s = server(project())
    const { data } = await call(s, 'get_api_catalog', { connectorId: 'loja-api' })
    expect(data.own).toBeUndefined()
    const criar = data.endpoints.find((e: { id: string }) => e.id === 'criarPedido')
    expect(criar.bodySchema).toBeDefined()
    expect(criar.fields).toBeUndefined()
    expect(criar.url).toBeUndefined()
    expect(criar.headers).toBeUndefined()
    expect(criar.examples).toContain('ok-201 (201)')
  })
})
