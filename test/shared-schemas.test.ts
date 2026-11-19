import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import { validateJsonSchema, type Connector } from '@vvpost/schemas'
import { readConnectorSource } from '@vvpost/core/connectors/edit'
import { buildRegistry } from '@vvpost/core/connectors/registry'
import { extractSharedSchemas, resolveSchemaRefs } from '@vvpost/core/connectors/shared-schemas'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { prepareImport, prepareSources, previewImport, writeImport } from '../src/main/importers'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { createMcpServer } from '../src/main/mcp/server'
import { applyProjectOps } from '../src/main/project'
import { migrateWorkspace } from '../src/main/project/migrate'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function workspace(files: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-schemas-'))
  dirs.push(dir)
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
  }
  return dir
}

const read = (dir: string, path: string) => JSON.parse(readFileSync(join(dir, path), 'utf8'))

const pedido = {
  type: 'object',
  required: ['cliente', 'itens'],
  properties: {
    cliente: { $ref: 'schema:Cliente' },
    itens: { type: 'array', items: { $ref: '#/$defs/Item' } }
  },
  $defs: { Item: { type: 'object', required: ['sku'], properties: { sku: { type: 'string' } } } }
}
const cliente = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['nome'], properties: { nome: { type: 'string' } } }

const loja: Connector = {
  id: 'loja',
  name: 'Loja',
  version: '1.0.0',
  config: { baseUrl: 'https://loja.exemplo.com' },
  endpoints: [
    {
      id: 'criar',
      name: 'Criar pedido',
      method: 'POST',
      path: '/pedidos',
      bodySchema: { $ref: 'schema:Pedido' },
      body: { cliente: { nome: 'Ana' }, itens: [{ sku: 'A1' }] },
      examples: [{ id: 'ok', name: 'Criado', status: 201, body: { cliente: { nome: 'Ana' }, itens: [] }, schema: { $ref: 'schema:Pedido' } }]
    },
    { id: 'trocar', name: 'Trocar pedido', method: 'PUT', path: '/pedidos/{id}', bodySchema: { $ref: 'schema:Pedido', description: 'O pedido inteiro' } }
  ]
}

function seeded(): string {
  return workspace({
    'connectors/loja.connector.vvpost.json': loja,
    'schemas/Pedido.schema.json': pedido,
    'schemas/Cliente.schema.json': cliente
  })
}

describe('schemas compartilhados na leitura do workspace', () => {
  it('troca as citações pelos schemas em $defs, com as referências internas apontando para dentro deles', async () => {
    const ws = await loadWorkspace(seeded())
    expect(ws.issues).toEqual([])
    const criar = ws.connectors.get('loja')!.endpoints![0]!
    expect(criar.bodySchema).toEqual({
      $ref: '#/$defs/Pedido',
      $defs: {
        Pedido: {
          type: 'object',
          required: ['cliente', 'itens'],
          properties: { cliente: { $ref: '#/$defs/Cliente' }, itens: { type: 'array', items: { $ref: '#/$defs/Pedido/$defs/Item' } } },
          $defs: { Item: pedido.$defs.Item }
        },
        // Sem o $schema do arquivo: um schema embutido não declara dialeto.
        Cliente: { type: 'object', required: ['nome'], properties: { nome: { type: 'string' } } }
      }
    })
    expect(validateJsonSchema(criar.bodySchema!, criar.body)).toMatchObject({ ok: true })
    expect(validateJsonSchema(criar.bodySchema!, { cliente: {}, itens: [{}] })).toMatchObject({ ok: false })
    expect(validateJsonSchema(criar.examples![0]!.schema!, { cliente: { nome: 'x' }, itens: [] })).toMatchObject({ ok: true })
    // O que fica ao lado da citação continua.
    expect(ws.connectors.get('loja')!.endpoints![1]!.bodySchema).toMatchObject({ $ref: '#/$defs/Pedido', description: 'O pedido inteiro' })
    expect(ws.schemas?.get('Pedido')).toMatchObject({ name: 'Pedido', file: 'schemas/Pedido.schema.json' })
    expect(ws.schemaUses?.get('Pedido')).toEqual(['loja/criar', 'loja/criar#ok', 'loja/trocar'])
    // O conector como está no arquivo continua disponível, para quem grava.
    expect(ws.unresolved?.get('loja')).toEqual(loja)
  })

  it('a doc (registry) mostra os campos do schema compartilhado e confere o corpo com ele', async () => {
    const dir = seeded()
    const registry = await buildRegistry(await loadWorkspace(dir))
    const criar = registry.connectors.find((c) => c.id === 'loja')!.endpoints.find((e) => e.id === 'criar')!
    expect(criar.fields.map((f) => f.path)).toEqual(expect.arrayContaining(['cliente', 'cliente.nome', 'itens', 'itens[].sku']))
    expect(criar.checks.map((c) => c.issues)).toEqual([[]])
    expect(criar.exampleChecks?.map((c) => c.issues)).toEqual([[]])
  })

  it('schema que não existe vira aviso e aceita tudo; nome inválido e JSON quebrado ficam de fora', async () => {
    const dir = workspace({
      'connectors/loja.connector.vvpost.json': loja,
      'schemas/Pedido.schema.json': pedido,
      'schemas/nome com espaço.schema.json': {},
      'schemas/Quebrado.schema.json': '{'
    })
    const ws = await loadWorkspace(dir)
    expect(ws.issues.map((i) => `${i.file}: ${i.message}`)).toEqual([
      expect.stringMatching(/^schemas\/Quebrado\.schema\.json: JSON inválido/),
      'schemas/nome com espaço.schema.json: nome de schema inválido: "nome com espaço" (letras, números, _, . e -, começando por letra ou _)',
      'connectors/loja.connector.vvpost.json: loja/criar: o schema "Cliente" não existe (crie schemas/Cliente.schema.json)',
      'connectors/loja.connector.vvpost.json: loja/criar#ok: o schema "Cliente" não existe (crie schemas/Cliente.schema.json)',
      'connectors/loja.connector.vvpost.json: loja/trocar: o schema "Cliente" não existe (crie schemas/Cliente.schema.json)'
    ])
    const schema = ws.connectors.get('loja')!.endpoints![0]!.bodySchema!
    expect(validateJsonSchema(schema, { cliente: 42, itens: [] })).toMatchObject({ ok: true })
  })

  it('um projeto cita os schemas do Compartilhado, e o dele com o mesmo nome vence', async () => {
    const dir = workspace({
      'schemas/Cliente.schema.json': cliente,
      'schemas/Pedido.schema.json': pedido,
      'vendas/vvpost.project.json': { id: 'vendas', name: 'Vendas' },
      'vendas/connectors/loja.connector.vvpost.json': loja,
      'vendas/schemas/Cliente.schema.json': { type: 'object', required: ['cpf'], properties: { cpf: { type: 'string' } } }
    })
    const ws = await loadWorkspace(join(dir, 'vendas'))
    expect(ws.issues).toEqual([])
    expect(ws.schemas?.get('Pedido')).toMatchObject({ file: '../schemas/Pedido.schema.json', shared: 'Compartilhado do workspace' })
    expect(ws.schemas?.get('Cliente')).toMatchObject({ file: 'schemas/Cliente.schema.json' })
    expect(ws.schemas?.get('Cliente')?.shared).toBeUndefined()
    const schema = ws.connectors.get('loja')!.endpoints![0]!.bodySchema!
    expect(validateJsonSchema(schema, { cliente: { cpf: '1' }, itens: [] })).toMatchObject({ ok: true })
    expect(validateJsonSchema(schema, { cliente: { nome: 'Ana' }, itens: [] })).toMatchObject({ ok: false })
  })

  it('o editor de um fluxo-base recebe as citações, não as cópias', async () => {
    const dir = seeded()
    expect((await applyProjectOps(dir, [{ op: 'migrateConnector', id: 'loja' }])).errors).toEqual([])
    const flow = read(dir, 'flows/loja/criar.flow.vvpost.json')
    expect(flow.nodes[0].request.bodySchema).toEqual({ $ref: 'schema:Pedido' })
    const source = await readConnectorSource(dir, 'loja')
    expect(source.connector.endpoints?.find((e) => e.id === 'criar')?.bodySchema).toEqual({ $ref: 'schema:Pedido' })
    // E a leitura do catálogo resolve igual no formato de fluxos.
    const ws = await loadWorkspace(dir)
    expect(ws.issues).toEqual([])
    expect(ws.connectors.get('loja')!.endpoints!.find((e) => e.id === 'criar')!.bodySchema).toMatchObject({ $ref: '#/$defs/Pedido' })
  })
})

describe('schemas compartilhados na escrita do projeto', () => {
  it('upsertSchema grava o arquivo, e um campo novo vale para todos os endpoints que o citam', async () => {
    const dir = seeded()
    const r = await applyProjectOps(dir, [{ op: 'setSchemaField', name: 'Pedido', path: 'obs', field: { type: 'string', description: 'Observação' } }])
    expect(r.errors).toEqual([])
    expect(r.changes.map((c) => c.path)).toEqual(['schemas/Pedido.schema.json'])
    expect(read(dir, 'schemas/Pedido.schema.json').properties.obs).toEqual({ type: 'string', description: 'Observação' })
    const ws = await loadWorkspace(dir)
    for (const e of ws.connectors.get('loja')!.endpoints!) {
      expect(JSON.stringify(e.bodySchema)).toContain('Observação')
    }
  })

  it('setBodyField num corpo que é um schema compartilhado muda o schema, e avisa onde', async () => {
    const dir = seeded()
    const r = await applyProjectOps(dir, [{ op: 'setBodyField', connectorId: 'loja', endpointId: 'criar', path: 'cupom', field: { type: 'string' } }])
    expect(r.errors).toEqual([])
    expect(r.changes.map((c) => c.path)).toEqual(['schemas/Pedido.schema.json'])
    expect(r.warnings.map((w) => w.message)).toEqual([
      'o corpo de "loja/criar" é o schema compartilhado "Pedido": o campo mudou em schemas/Pedido.schema.json, que vale para conector loja'
    ])
    expect(read(dir, 'connectors/loja.connector.vvpost.json').endpoints[0].bodySchema).toEqual({ $ref: 'schema:Pedido' })
  })

  it('citação de um schema que não existe é recusada; apagar um schema em uso também', async () => {
    const dir = seeded()
    const missing = await applyProjectOps(dir, [{ op: 'setBodySchema', connectorId: 'loja', endpointId: 'trocar', schema: { $ref: 'schema:Nada' } }])
    expect(missing.errors.map((e) => e.message)).toEqual(['o conector "loja" cita o schema "Nada", que não existe (crie com upsertSchema)'])
    const used = await applyProjectOps(dir, [{ op: 'deleteSchema', name: 'Cliente' }])
    expect(used.errors.map((e) => e.message)).toEqual(['o schema "Cliente" é citado por schema Pedido; troque as citações antes de apagar'])
    const bad = await applyProjectOps(dir, [{ op: 'upsertSchema', name: '../fora', schema: {} }])
    expect(bad.errors[0]!.message).toMatch(/nome de schema inválido/)
    const invalid = await applyProjectOps(dir, [{ op: 'upsertSchema', name: 'Ruim', schema: { type: 'objeto' } }])
    expect(invalid.errors[0]!.message).toMatch(/^schema "Ruim" inválido/)
  })

  it('apagar depois de trocar as citações apaga o arquivo; um campo que quebra o corpo padrão avisa todos os endpoints', async () => {
    const dir = seeded()
    const r = await applyProjectOps(dir, [{ op: 'setSchemaField', name: 'Cliente', path: 'cpf', field: { type: 'string', required: true } }])
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.message)).toEqual([
      expect.stringMatching(/^endpoint "loja\/criar": corpo padrão fora do bodySchema/),
      expect.stringMatching(/^endpoint "loja\/criar": exemplo de resposta "Criado" fora do schema dele/)
    ])
    const del = await applyProjectOps(dir, [
      { op: 'upsertSchema', name: 'Pedido', schema: { ...pedido, properties: { ...pedido.properties, cliente: { type: 'object' } } } },
      { op: 'deleteSchema', name: 'Cliente' }
    ])
    expect(del.errors).toEqual([])
    expect(existsSync(join(dir, 'schemas/Cliente.schema.json'))).toBe(false)
  })

  it('o schema do Compartilhado é só de leitura no projeto', async () => {
    const dir = workspace({
      'schemas/Cliente.schema.json': cliente,
      'vendas/vvpost.project.json': { id: 'vendas', name: 'Vendas' }
    })
    const r = await applyProjectOps(join(dir, 'vendas'), [{ op: 'setSchemaField', name: 'Cliente', path: 'cpf', field: { type: 'string' } }])
    expect(r.errors[0]!.message).toMatch(/é de Compartilhado do workspace \(\.\.\/schemas\/Cliente\.schema\.json\) e aqui é só leitura/)
    const own = await applyProjectOps(join(dir, 'vendas'), [
      { op: 'upsertSchema', name: 'Cliente', schema: { type: 'object' } },
      { op: 'upsertConnector', connector: { ...loja, endpoints: [loja.endpoints![1]!].map((e) => ({ ...e, bodySchema: { $ref: 'schema:Cliente' } })) } }
    ])
    expect(own.errors).toEqual([])
    expect(own.warnings.map((w) => w.message)).toEqual(['o schema "Cliente" do projeto passa a valer aqui no lugar do de Compartilhado do workspace'])
  })
})

describe('migração dos catálogos que copiam o schema em cada endpoint', () => {
  const copied = (extra: Record<string, unknown> = {}) => ({
    $ref: '#/$defs/Pedido',
    $defs: {
      Pedido: { type: 'object', properties: { cliente: { $ref: '#/$defs/Cliente' }, total: { type: 'number' } } },
      Cliente: { type: 'object', properties: { nome: { type: 'string' } } },
      ...extra
    }
  })

  it('extractSharedSchemas tira as entradas iguais de $defs e cita no lugar', () => {
    const a = copied()
    const b = { type: 'object', properties: { pedido: { $ref: '#/$defs/Pedido' } }, $defs: copied().$defs }
    const c = copied({ Pedido: { type: 'string' } })
    const found = extractSharedSchemas([a, b, c], new Map())
    expect([...found.schemas.keys()]).toEqual(['Pedido', 'Cliente'])
    expect(found.schemas.get('Pedido')).toEqual({ type: 'object', properties: { cliente: { $ref: 'schema:Cliente' }, total: { type: 'number' } } })
    expect(a).toEqual({ $ref: 'schema:Pedido' })
    expect(b).toEqual({ type: 'object', properties: { pedido: { $ref: 'schema:Pedido' } } })
    // O Pedido diferente fica onde está; o Cliente igual sai.
    expect(c).toEqual({ $ref: '#/$defs/Pedido', $defs: { Pedido: { type: 'string' } } })
    expect(found.uses).toEqual(new Map([['Pedido', 2], ['Cliente', 3]]))
  })

  it('um nome que o projeto já usa com outro conteúdo ganha sufixo; com o mesmo, é reaproveitado', () => {
    const a = copied()
    const b = copied()
    const found = extractSharedSchemas([a, b], new Map([['Pedido', { type: 'string' }], ['Cliente', { 'x-vvpost': {}, ...copied().$defs.Cliente }]]))
    expect([...found.schemas.keys()]).toEqual(['Pedido_2'])
    expect(found.schemas.get('Pedido_2')!.properties).toMatchObject({ cliente: { $ref: 'schema:Cliente' } })
    expect(a).toEqual({ $ref: 'schema:Pedido_2' })
  })

  it('vvpost migrate (extractSchemas) compartilha o que o import antigo copiou, e a reimportação não vê edição', async () => {
    const spec = parse(readFileSync(join(__dirname, 'fixtures/openapi/petstore.openapi.yaml'), 'utf8'))
    const dir = workspace({ 'petstore.openapi.yaml': stringify(spec), 'connectors/.keep': '' })
    // Um projeto no formato antigo, importado antes dos schemas compartilhados: cada endpoint com a cópia.
    const target = { dir, isWorkspace: true }
    const prepared = await prepareImport([join(dir, 'petstore.openapi.yaml')])
    const schemas = prepared.result.schemas!
    const inline = (s: Record<string, unknown> | undefined) => s && resolveSchemaRefs(s, (n) => schemas[n])
    const { endpointHash } = await import('../src/main/importers/openapi')
    for (const c of prepared.result.connectors) {
      for (const e of c.endpoints ?? []) {
        if (e.bodySchema) e.bodySchema = inline(e.bodySchema)
        for (const x of e.examples ?? []) if (x.schema) x.schema = inline(x.schema)
        if (e.source) e.source.hash = endpointHash(e)
      }
    }
    delete prepared.result.schemas
    await writeImport(prepared, target)
    const before = await loadWorkspace(dir)
    expect(before.schemas?.size).toBe(0)
    expect(JSON.stringify(before.connectors.get('loja-de-pets.pets'))).toContain('"$defs"')

    const { plan, result } = await migrateWorkspace(dir)
    expect(result?.errors).toEqual([])
    expect(plan.schemas).toEqual([
      { name: 'NewPet', uses: expect.any(Number) },
      { name: 'Owner', uses: expect.any(Number) }
    ])
    expect(read(dir, 'schemas/NewPet.schema.json').properties.owner).toEqual({ $ref: 'schema:Owner' })
    const after = await loadWorkspace(dir)
    expect(after.issues).toEqual([])
    const create = after.unresolved!.get('loja-de-pets.pets')!.endpoints!.find((e) => e.id === 'createPet')!
    expect(create.bodySchema).toEqual({ $ref: 'schema:NewPet' })
    // O resolvido valida igual ao de antes.
    const old = before.connectors.get('loja-de-pets.pets')!.endpoints!.find((e) => e.id === 'createPet')!
    const now = after.connectors.get('loja-de-pets.pets')!.endpoints!.find((e) => e.id === 'createPet')!
    for (const body of [old.body, { name: 1 }, { name: 'x', owner: { pets: [{}] } }]) {
      expect(validateJsonSchema(now.bodySchema!, body).ok).toBe(validateJsonSchema(old.bodySchema!, body).ok)
    }
    // A reimportação da mesma spec não muda nada: o hash acompanhou a migração.
    const again = await previewImport(await prepareImport([join(dir, 'petstore.openapi.yaml')]), target)
    expect(again.changes).toEqual([])
    // E migrar de novo não tem o que compartilhar.
    expect((await migrateWorkspace(dir)).plan.schemas).toEqual([])
  })
})

describe('import do OpenAPI com schemas compartilhados', () => {
  const project = () => {
    const dir = mkdtempSync(join(tmpdir(), 'vvpost-schemas-import-'))
    dirs.push(dir)
    copyFileSync(join(__dirname, 'fixtures/openapi/petstore.openapi.yaml'), join(dir, 'petstore.openapi.yaml'))
    return { dir, isWorkspace: true }
  }
  const editSpec = (dir: string, edit: (spec: any) => void) => {
    const path = join(dir, 'petstore.openapi.yaml')
    const spec = parse(readFileSync(path, 'utf8'))
    edit(spec)
    writeFileSync(path, stringify(spec))
  }

  it('grava cada componente uma vez em schemas/, e renomear um campo é uma edição só', async () => {
    const target = project()
    const { written } = await writeImport(await prepareImport([join(target.dir, 'petstore.openapi.yaml')]), target)
    expect(written).toEqual(expect.arrayContaining(['schemas/NewPet.schema.json', 'schemas/Owner.schema.json']))
    const file = read(target.dir, 'schemas/NewPet.schema.json')
    expect(file['x-vvpost']).toEqual({ source: 'petstore.openapi.yaml', hash: expect.any(String) })
    const flows = ['flows/loja-de-pets.pets/createPet.flow.vvpost.json', 'flows/loja-de-pets.pets/getPet.flow.vvpost.json']
    expect(read(target.dir, flows[0]!).nodes[0].request.bodySchema).toEqual({ $ref: 'schema:NewPet' })
    expect(read(target.dir, flows[1]!).examples[0].schema).toEqual({ $ref: 'schema:NewPet' })

    // Renomear name para nome: um arquivo muda, e todo endpoint que usa o NewPet vê o campo novo.
    const r = await applyProjectOps(target.dir, [
      { op: 'setSchemaField', name: 'NewPet', path: 'name', field: null },
      { op: 'setSchemaField', name: 'NewPet', path: 'nome', field: { type: 'string', required: true } }
    ])
    expect(r.changes.map((c) => c.path)).toEqual(['schemas/NewPet.schema.json'])
    const ws = await loadWorkspace(target.dir)
    const uses = ws.schemaUses!.get('NewPet')!
    expect(uses.length).toBeGreaterThanOrEqual(2)
    for (const where of uses) {
      const [connectorId, rest] = where.split('/') as [string, string]
      const [endpointId, exampleId] = rest.split('#') as [string, string | undefined]
      const e = ws.connectors.get(connectorId)!.endpoints!.find((x) => x.id === endpointId)!
      const schema = exampleId ? e.examples!.find((x) => x.id === exampleId)!.schema : e.bodySchema
      expect(JSON.stringify(schema)).toContain('"nome"')
    }

    // Reimportar a mesma spec com o schema editado no projeto: fica como está, e a revisão diz.
    const again = await previewImport(await prepareImport([join(target.dir, 'petstore.openapi.yaml')]), target)
    expect(again.notes).toEqual(expect.arrayContaining([{ source: 'Schemas', message: 'NewPet foi editado no projeto e ficou como está; a versão da spec não foi aplicada.' }]))
    expect(again.changes.map((c) => c.path)).not.toContain('schemas/NewPet.schema.json')
  })

  it('reimportar atualiza o schema que ninguém editou', async () => {
    const target = project()
    const specPath = join(target.dir, 'petstore.openapi.yaml')
    await writeImport(await prepareImport([specPath]), target)
    editSpec(target.dir, (spec) => {
      // Só a descrição: o corpo de exemplo gerado do schema não muda, então os endpoints ficam.
      spec.components.schemas.Owner.description = 'Tutor do pet'
    })
    const prepared = await prepareImport([specPath])
    const preview = await previewImport(prepared, target)
    expect(preview.errors).toEqual([])
    expect(preview.changes).toEqual([{ path: 'schemas/Owner.schema.json', action: 'update' }])
    await writeImport(prepared, target)
    expect(read(target.dir, 'schemas/Owner.schema.json').description).toBe('Tutor do pet')
  })

  it('leva os schemas citados em qualquer profundidade (endpoint → A → B → C)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vvpost-schemas-deep-'))
    dirs.push(dir)
    const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` })
    writeFileSync(join(dir, 'fundo.openapi.json'), JSON.stringify({
      openapi: '3.1.1',
      info: { title: 'Fundo', version: '1' },
      paths: { '/a': { get: { operationId: 'lerA', responses: { '200': { description: 'ok', content: { 'application/json': { schema: ref('A') } } } } } } },
      components: {
        schemas: {
          A: { type: 'object', properties: { b: ref('B') } },
          B: { type: 'object', properties: { c: ref('C') } },
          C: { type: 'string', enum: ['x', 'y'] }
        }
      }
    }))
    const prepared = await prepareImport([join(dir, 'fundo.openapi.json')])
    const preview = await previewImport(prepared, { dir, isWorkspace: true })
    expect(preview.errors).toEqual([])
    const { written } = await writeImport(prepared, { dir, isWorkspace: true })
    expect(written).toEqual(expect.arrayContaining(['schemas/A.schema.json', 'schemas/B.schema.json', 'schemas/C.schema.json']))
  })

  it('duas specs com o mesmo nome de schema e conteúdos diferentes não se misturam', () => {
    const spec = (title: string, props: Record<string, unknown>) => ({
      openapi: '3.0.3',
      info: { title, version: '1.0.0' },
      paths: { '/x': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pedido' } } } }, responses: {} } } },
      components: { schemas: { Pedido: { type: 'object', properties: props } } }
    })
    const prepared = prepareSources([
      { file: 'a.json', data: spec('Vendas', { total: { type: 'number' } }) },
      { file: 'b.json', data: spec('Compras', { fornecedor: { type: 'string' } }) }
    ])
    expect(Object.keys(prepared.result.schemas!)).toEqual(['Pedido', 'Pedido_2'])
    const body = (id: string) => prepared.result.connectors.find((c) => c.id === id)!.endpoints![0]!.bodySchema
    expect(body('vendas')).toEqual({ $ref: 'schema:Pedido' })
    expect(body('compras')).toEqual({ $ref: 'schema:Pedido_2' })
  })
})

describe('schemas compartilhados pelo MCP', () => {
  const noHttp = {
    cancel() {},
    async send(): Promise<never> {
      throw new Error('sem rede no teste')
    }
  }
  async function call(dir: string, name: string, args: Record<string, unknown>) {
    const server = createMcpServer({ workspaceDir: dir, http: noHttp as never, auth: createAuthEngine() })
    const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as {
      result: { isError: boolean; content: { text: string }[] }
    }
    return { isError: res.result.isError, data: JSON.parse(res.result.content[0]!.text) }
  }

  it('o catálogo lista os schemas e diz qual o corpo cita; get_source traz o arquivo e a escrita muda todos os usos', async () => {
    const dir = seeded()
    const summary = await call(dir, 'get_api_catalog', { view: 'summary' })
    expect(summary.data.schemas).toEqual([
      { name: 'Cliente', file: 'schemas/Cliente.schema.json', uses: 3 },
      { name: 'Pedido', file: 'schemas/Pedido.schema.json', uses: 3 }
    ])
    const detail = await call(dir, 'get_api_catalog', { connectorId: 'loja' })
    const criar = detail.data.endpoints.find((e: { id: string }) => e.id === 'criar')
    expect(criar.sharedSchema).toMatchObject({ name: 'Pedido', file: 'schemas/Pedido.schema.json' })
    // O bodySchema vem resolvido: a IA vê os campos sem ler outro arquivo.
    // (com bodySchema, os fields não vêm repetidos).
    expect(JSON.stringify(criar.bodySchema)).toContain('"cliente"')
    expect(JSON.stringify(criar.bodySchema)).toContain('"nome"')
    expect(criar.fields).toBeUndefined()

    // get_source do conector traz a citação (gravar de volta não copia o schema).
    const source = await call(dir, 'get_source', { kind: 'connector', id: 'loja' })
    expect(source.data.connector.endpoints[0].bodySchema).toEqual({ $ref: 'schema:Pedido' })
    const schema = await call(dir, 'get_source', { kind: 'schema', id: 'Pedido' })
    expect(schema.data).toMatchObject({ file: 'schemas/Pedido.schema.json', schema: pedido, uses: ['loja/criar', 'loja/criar#ok', 'loja/trocar'] })
    expect(schema.data.version).toEqual(expect.any(String))

    const edit = await call(dir, 'edit_project', { ops: [{ op: 'setSchemaField', name: 'Pedido', path: 'obs', field: { type: 'string' } }] })
    expect(edit.isError).toBe(false)
    expect(edit.data.ok).toBe(true)
    expect(read(dir, 'schemas/Pedido.schema.json').properties.obs).toEqual({ type: 'string' })
  })
})
