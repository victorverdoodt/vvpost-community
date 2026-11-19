import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { main, type Io } from '../src/main/cli'
import { createMcpServer } from '../src/main/mcp/server'
import { parse, stringify } from 'yaml'
import { validateJsonSchema, type Connector } from '@vvpost/schemas'
import { prepareImport, prepareSources, prepareUrlImport, previewImport, writeImport } from '../src/main/importers'
import { convertOpenApi, endpointHash, isOpenApi, sample, schemaHash } from '../src/main/importers/openapi'
import { resolveSchemaRefs } from '@vvpost/core/connectors/shared-schemas'
import { parseImportText, storedLocation } from '../src/main/importers/source'
import { validateImport } from '../src/main/importers/workspace'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { applyProjectOps } from '../src/main/project'
import { exportAs } from '../src/main/bundle/export'

const fixturePath = (n: string) => join(__dirname, 'fixtures/openapi', n)
const load = (n: string) => parseImportText(readFileSync(fixturePath(n), 'utf8'), n)
const byId = (cs: Connector[], id: string) => {
  const c = cs.find((x) => x.id === id)
  if (!c) throw new Error(`conector ${id} não gerado: ${cs.map((x) => x.id).join(', ')}`)
  return c
}
const endpoint = (cs: Connector[], connectorId: string, id: string) => {
  const e = byId(cs, connectorId).endpoints?.find((x) => x.id === id)
  if (!e) throw new Error(`endpoint ${id} não está em ${connectorId}`)
  return e
}

describe('convertOpenApi', () => {
  it('reconhece OpenAPI 3.x e Swagger 2.0, em JSON e YAML', () => {
    expect(isOpenApi(load('petstore.openapi.yaml'))).toBe(true)
    expect(isOpenApi(load('petstore.swagger.json'))).toBe(true)
    expect(isOpenApi({ info: { name: 'x' }, item: [] })).toBe(false)
    expect(isOpenApi({ openapi: '2.0' })).toBe(false)
    // YAML com outro nome de arquivo também entra, desde que seja uma spec.
    expect(isOpenApi(parseImportText('openapi: 3.1.0\ninfo: {title: x, version: "1"}\npaths: {}\n', 'spec.txt'))).toBe(true)
    expect(() => parseImportText('nao: e: json', 'colecao.json')).toThrow(/JSON inválido/)
  })

  it('OpenAPI 3: raiz com servidor e auth, tags como filhos, endpoints com query, headers, bodySchema e exemplo', () => {
    const r = convertOpenApi('petstore.openapi.yaml', load('petstore.openapi.yaml'), '/specs/petstore.openapi.yaml')
    expect(r.errors).toEqual([])
    expect(validateImport(r)).toEqual([])
    expect(r.sources).toEqual([{ file: 'petstore.openapi.yaml', kind: 'openapi', name: 'Loja de Pets (OpenAPI 3.0.3)' }])
    expect(r.connectors.map((c) => c.id)).toEqual(['loja-de-pets', 'loja-de-pets.pets', 'loja-de-pets.tutores'])

    const root = byId(r.connectors, 'loja-de-pets')
    expect(root).toMatchObject({
      version: '1.2.0',
      description: 'API de exemplo para o importador.',
      config: { baseUrl: 'https://sa.pets.example.com/v1', auth: { type: 'bearer', token: '{{LOJA_DE_PETS_TOKEN}}' } },
      source: { type: 'openapi', location: '/specs/petstore.openapi.yaml', version: '1.2' }
    })
    // Operação sem tag fica no raiz; os filhos herdam dele.
    expect(root.endpoints?.map((e) => e.id)).toEqual(['health'])
    expect(byId(r.connectors, 'loja-de-pets.pets')).toMatchObject({ extends: 'loja-de-pets', description: 'Cadastro de pets.' })

    const list = endpoint(r.connectors, 'loja-de-pets.pets', 'listPets')
    expect(list).toMatchObject({ name: 'Listar pets', method: 'GET', path: '/pets' })
    // Obrigatórios e os com default/exemplo; o opcional sem valor fica de fora.
    expect(list.query).toEqual({ limit: '20', status: 'available' })
    expect(list.headers).toEqual({ 'X-Trace-Id': 'abc-123' })
    expect(list.source).toEqual({ operation: 'GET /pets', operationId: 'listPets', tag: 'Pets', hash: endpointHash(list) })

    const create = endpoint(r.connectors, 'loja-de-pets.pets', 'createPet')
    // Os componentes viram schemas compartilhados, citados pelo endpoint em vez de copiados nele.
    expect(create.bodySchema).toEqual({ $ref: 'schema:NewPet' })
    expect(Object.keys(r.schemas!).sort()).toEqual(['NewPet', 'Owner'])
    const defs = r.schemas as Record<string, { properties: Record<string, unknown> }>
    // nullable e exclusiveMinimum booleano viram JSON Schema 2020-12; a referência recursiva continua.
    expect(defs['NewPet']!.properties['nickname']).toEqual({ type: ['string', 'null'] })
    expect(defs['NewPet']!.properties['weight']).toEqual({ type: 'number', exclusiveMinimum: 0 })
    expect(defs['Owner']!.properties['pets']).toEqual({ type: 'array', items: { $ref: 'schema:NewPet' } })
    // A marca diz de onde veio e o hash do que veio, para a reimportação ver se o schema foi editado.
    expect(r.schemas!['NewPet']!['x-vvpost']).toEqual({ source: '/specs/petstore.openapi.yaml', hash: schemaHash(r.schemas!['NewPet']!) })
    // Corpo gerado do schema: sem o readOnly, com o exemplo do campo, e válido para o próprio schema.
    expect(create.body).toMatchObject({ name: 'Rex', birth: '2024-01-01', owner: { email: 'user@example.com' } })
    expect(create.body).not.toHaveProperty('id')
    const full = resolveSchemaRefs(create.bodySchema!, (n) => r.schemas?.[n])
    expect(validateJsonSchema(full, create.body)).toMatchObject({ ok: true })
    expect(validateJsonSchema(full, { name: 1 })).toMatchObject({ ok: false })

    // Exemplo da spec vence o gerado.
    expect(endpoint(r.connectors, 'loja-de-pets.tutores', 'createOwner').body).toEqual({ name: 'Ana', pets: [] })
    expect(endpoint(r.connectors, 'loja-de-pets.pets', 'deletePet').description).toBe('**Obsoleto.**\n\nUse o arquivamento.')

    const warnings = r.warnings.map((w) => w.message).join('\n')
    expect(warnings).toMatch(/2 servidores.*sandbox\.pets\.example\.com/)
    expect(warnings).toMatch(/LOJA_DE_PETS_TOKEN/)
    expect(warnings).toMatch(/arquivo do formulário.*PUT \/pets\/\{petId\}\/photo/)
    // Corpo multipart vira payload com os campos de texto; o de arquivo fica de fora.
    expect(endpoint(r.connectors, 'loja-de-pets.pets', 'uploadPhoto').payload).toEqual({
      mode: 'multipart',
      fields: [
        { name: 'caption', value: 'Rex no parque' },
        { name: 'featured', value: 'true' }
      ]
    })
    expect(warnings).toMatch(/sem auth.*GET \/health/)
  })

  it('Swagger 2.0: host, basePath e schemes viram a URL base; corpo do parâmetro in: body', () => {
    const r = convertOpenApi('petstore.swagger.json', load('petstore.swagger.json'), 'https://x.example.com/swagger.json')
    expect(validateImport(r)).toEqual([])
    const root = byId(r.connectors, 'petstore-legado')
    expect(root.config).toEqual({
      baseUrl: 'https://legacy.pets.example.com/api',
      auth: { type: 'apiKey', name: 'X-Api-Key', value: '{{PETSTORE_LEGADO_API_KEY}}', in: 'header' }
    })
    const add = endpoint(r.connectors, 'petstore-legado', 'addPet')
    expect(add.query).toEqual({ dryRun: 'false' })
    expect(add.body).toEqual({ name: 'string', age: 0, tags: ['string'] })
    expect(validateJsonSchema(resolveSchemaRefs(add.bodySchema!, (n) => r.schemas?.[n]), add.body)).toMatchObject({ ok: true })
    expect(r.warnings.map((w) => w.message).join('\n')).toMatch(/arquivo do formulário.*POST \/pets\/\{id\}\/photo/)
  })

  it('servidor relativo usa a URL da spec ou {{BASE_URL}}; OAuth2 client credentials; esquemas sem equivalente avisam', () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'Interna', version: 'v2' },
      servers: [{ url: '/api/v2/' }],
      components: {
        securitySchemes: {
          oauth: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://auth.example.com/token', scopes: {} } } }
        }
      },
      security: [{ oauth: ['read', 'write'] }],
      paths: { '/itens': { get: { responses: {} } } }
    }
    const fromUrl = convertOpenApi('openapi.json', spec, 'https://interna.example.com/docs/openapi.json')
    expect(fromUrl.connectors[0]!.config).toEqual({
      baseUrl: 'https://interna.example.com/api/v2',
      auth: {
        type: 'oauth2',
        grantType: 'client_credentials',
        tokenUrl: 'https://auth.example.com/token',
        clientId: '{{INTERNA_CLIENT_ID}}',
        clientSecret: '{{INTERNA_CLIENT_SECRET}}',
        scope: 'read write'
      }
    })
    expect(fromUrl.connectors[0]!.version).toBe('2.0.0')
    expect(fromUrl.connectors[0]!.endpoints![0]!.id).toBe('get_itens')

    const fromFile = convertOpenApi('openapi.json', spec, '/specs/openapi.json')
    expect(fromFile.connectors[0]!.config!.baseUrl).toBe('{{BASE_URL}}/api/v2')
    expect(fromFile.warnings.map((w) => w.message).join('\n')).toMatch(/BASE_URL/)

    const code = convertOpenApi('x.json', {
      ...spec,
      components: { securitySchemes: { oauth: { type: 'oauth2', flows: { authorizationCode: { authorizationUrl: 'a', tokenUrl: 'b' } } } } }
    }, '/x.json')
    expect(code.connectors[0]!.config?.auth).toBeUndefined()
    expect(code.warnings.map((w) => w.message).join('\n')).toMatch(/navegador/)
    expect(validateImport(code)).toEqual([])
  })

  it('formulário urlencoded (OpenAPI 3 com $ref e Swagger 2.0 formData) vira payload', () => {
    const v3 = convertOpenApi('f.yaml', {
      openapi: '3.0.0',
      info: { title: 'Form', version: '1.0.0' },
      servers: [{ url: 'https://f.example.com' }],
      paths: {
        '/login': {
          post: {
            operationId: 'login',
            requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { $ref: '#/components/schemas/Login' } } } },
            responses: {}
          }
        }
      },
      components: { schemas: { Login: { type: 'object', properties: { user: { type: 'string', example: 'ana' }, remember: { type: 'boolean', default: false } } } } }
    }, '/f.yaml')
    expect(validateImport(v3)).toEqual([])
    expect(v3.connectors[0]!.endpoints![0]!.payload).toEqual({
      mode: 'urlencoded',
      fields: [
        { name: 'user', value: 'ana' },
        { name: 'remember', value: 'false' }
      ]
    })
    const v2 = convertOpenApi('f.json', {
      swagger: '2.0',
      info: { title: 'Form', version: '1.0.0' },
      host: 'f.example.com',
      paths: { '/login': { post: { consumes: ['application/x-www-form-urlencoded'], parameters: [{ name: 'user', in: 'formData', type: 'string', required: true }], responses: {} } } }
    }, '/f.json')
    expect(validateImport(v2)).toEqual([])
    expect(v2.connectors[0]!.endpoints![0]!.payload).toEqual({ mode: 'urlencoded', fields: [{ name: 'user', value: '' }] })
  })

  it('exemplo gerado respeita $ref recursivo, allOf e oneOf', () => {
    const root = {
      $defs: { Node: { type: 'object', properties: { name: { type: 'string' }, child: { $ref: '#/$defs/Node' } } } }
    }
    expect(sample({ $ref: '#/$defs/Node' }, root)).toEqual({ name: 'string' })
    expect(sample({ allOf: [{ type: 'object', properties: { a: { type: 'integer', minimum: 3 } } }, { type: 'object', properties: { b: { type: 'boolean' } } }] }, {})).toEqual({ a: 3, b: true })
    expect(sample({ oneOf: [{ type: 'string', format: 'uuid' }, { type: 'integer' }] }, {})).toBe('00000000-0000-0000-0000-000000000000')
  })

  it('exemplo de propriedade anulável (oneOf com null, como o .NET gera) usa o ramo com valor e não perde obrigatórias', () => {
    const root = { $defs: { Sinais: { type: 'object', properties: { pa: { type: 'integer' } } } } }
    const schema = {
      type: 'object',
      required: ['sinais', 'dados', 'nota'],
      properties: { sinais: { oneOf: [{ type: 'null' }, { $ref: '#/$defs/Sinais' }] }, dados: {}, nota: { type: ['null', 'string'] }, extra: {} }
    }
    const value = sample(schema, root)
    expect(value).toEqual({ sinais: { pa: 0 }, dados: null, nota: 'string' })
    expect(validateJsonSchema({ ...schema, $defs: root.$defs }, value)).toMatchObject({ ok: true })
    expect(sample({ oneOf: [{ type: 'null' }] }, {})).toBeNull()
    expect(sample({ type: 'string', maxLength: 2 }, {})).toBe('st')
    expect(sample({ type: 'string', minLength: 8 }, {})).toBe('stringxx')
  })

  it('$ref e oneOf não gastam a profundidade do exemplo: o objeto citado lá no fundo sai completo', () => {
    const nullable = (n: string) => ({ oneOf: [{ type: 'null' }, { $ref: `#/$defs/${n}` }] })
    const root = {
      $defs: {
        Paciente: { type: 'object', properties: { contato: nullable('Contato') } },
        Contato: { type: 'object', properties: { endereco: nullable('Endereco') } },
        Endereco: { type: 'object', properties: { pais: nullable('Codigo') } },
        Codigo: { type: 'object', required: ['nome'], properties: { nome: { type: 'string' } } }
      }
    }
    expect(sample({ type: 'object', properties: { paciente: nullable('Paciente') } }, root)).toEqual({
      paciente: { contato: { endereco: { pais: { nome: 'string' } } } }
    })
  })

  it('o security da operação vira requiresAuth: exigência, lista vazia, sem security e auth opcional', () => {
    const op = (security?: unknown) => ({ ...(security !== undefined && { security }), responses: {} })
    const spec = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      openapi: '3.0.3',
      info: { title: 'Seg', version: '1.0.0' },
      components: { securitySchemes: { b: { type: 'http', scheme: 'bearer' } } },
      paths,
      ...extra
    })
    const auth = (data: unknown) =>
      Object.fromEntries(convertOpenApi('s.json', data, 's.json').connectors.flatMap((c) => c.endpoints ?? []).map((e) => [e.path, e.requiresAuth]))
    expect(auth(spec({ '/priv': { get: op([{ b: [] }]) }, '/pub': { get: op([]) }, '/sem': { get: op() }, '/opc': { get: op([{}, { b: [] }]) } }))).toEqual({
      '/priv': true,
      '/pub': false,
      // A spec declara segurança em alguma operação: a que não declara nenhuma é pública.
      '/sem': false,
      // {} na lista deixa a auth opcional: nada se declara.
      '/opc': undefined
    })
    // Global: vale para quem não declara; security: [] na operação tira.
    expect(auth(spec({ '/a': { get: op() }, '/b': { get: op([]) } }, { security: [{ b: [] }] }))).toEqual({ '/a': true, '/b': false })
    // Só os esquemas, sem nenhuma exigência: a spec não diz quem exige auth.
    expect(auth(spec({ '/a': { get: op() } }))).toEqual({ '/a': undefined })
    const pets = convertOpenApi('petstore.openapi.yaml', load('petstore.openapi.yaml'), 'petstore.openapi.yaml')
    expect(endpoint(pets.connectors, 'loja-de-pets', 'health').requiresAuth).toBe(false)
    expect(endpoint(pets.connectors, 'loja-de-pets.pets', 'createPet').requiresAuth).toBe(true)
  })

  it('guarda o caminho da spec relativo ao projeto quando ela está dentro dele', () => {
    expect(storedLocation('/p/specs/api.yaml', '/p')).toBe('specs/api.yaml')
    expect(storedLocation('/outro/api.yaml', '/p')).toBe('/outro/api.yaml')
    expect(storedLocation('https://x/api.yaml', '/p')).toBe('https://x/api.yaml')
  })
})

describe('reimportar uma spec OpenAPI', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const project = () => {
    const dir = mkdtempSync(join(tmpdir(), 'vvpost-openapi-'))
    dirs.push(dir)
    copyFileSync(fixturePath('petstore.openapi.yaml'), join(dir, 'petstore.openapi.yaml'))
    return { dir, isWorkspace: true }
  }
  // O import grava fluxos num workspace sem conectores no formato antigo: lê o conector que eles dão.
  const read = async (dir: string, id: string): Promise<Connector> => {
    const ws = await loadWorkspace(dir)
    // Como está nos arquivos: o teste grava de volta, e o conector resolvido copiaria os schemas.
    return ws.unresolved?.get(id) ?? ws.connectors.get(id)!
  }
  const write = async (dir: string, c: Connector) => expect((await applyProjectOps(dir, [{ op: 'upsertConnector', connector: c }])).errors).toEqual([])
  const editSpec = (dir: string, edit: (spec: any) => void) => {
    const path = join(dir, 'petstore.openapi.yaml')
    const spec = parse(readFileSync(path, 'utf8'))
    edit(spec)
    writeFileSync(path, stringify(spec))
  }

  it('a exportação para OpenAPI devolve o security: [] do público e a exigência global dos outros', async () => {
    const target = project()
    await writeImport(await prepareImport([join(target.dir, 'petstore.openapi.yaml')]), target)
    const spec = (await exportAs(target.dir, { format: 'openapi' })).files[0]!.data as any
    expect(spec.security).toEqual([{ 'loja-de-pets': [] }])
    expect(spec.paths['/health'].get.security).toEqual([])
    expect(spec.paths['/pets'].post.security).toBeUndefined()
    // E volta igual pelo importador.
    const back = convertOpenApi('x.json', spec, 'x.json')
    expect(back.connectors.flatMap((c) => c.endpoints ?? []).map((e) => [e.path, e.requiresAuth])).toEqual(
      expect.arrayContaining([['/health', false], ['/pets', true]])
    )
  })

  it('grava com o caminho relativo e reimportar sem mudanças não altera nada', async () => {
    const target = project()
    await writeImport(await prepareImport([join(target.dir, 'petstore.openapi.yaml')]), target)
    expect((await read(target.dir, 'loja-de-pets')).source).toEqual({ type: 'openapi', location: 'petstore.openapi.yaml', version: '1.2' })
    const again = await previewImport(await prepareImport([join(target.dir, 'petstore.openapi.yaml')]), target)
    expect(again.changes).toEqual([])
    expect(again.connectors.flatMap((c) => c.endpoints).every((e) => e.status === 'existing')).toBe(true)
  })

  it('novos entram, alterados na spec atualizam, editados nos dois lados viram conflito e removidos ficam até pedir', async () => {
    const target = project()
    const specPath = join(target.dir, 'petstore.openapi.yaml')
    await writeImport(await prepareImport([specPath]), target)

    // No projeto: um cenário em createPet e uma edição no nome de getPet.
    const pets = await read(target.dir, 'loja-de-pets.pets')
    const create = pets.endpoints!.find((e) => e.id === 'createPet')!
    create.scenarios = [{ id: 'ok', name: 'Cria', assertions: [{ target: 'status', operator: 'equals', expected: 201 }] }]
    pets.endpoints!.find((e) => e.id === 'getPet')!.name = 'Buscar pet pelo id'
    await write(target.dir, pets)

    editSpec(target.dir, (spec) => {
      spec.info.version = '1.3'
      spec.paths['/pets'].post.summary = 'Cadastrar um pet'
      spec.paths['/pets'].post.requestBody.content['application/json'].example = { name: 'Bidu' }
      spec.paths['/pets/{petId}'].get.summary = 'Obter pet'
      delete spec.paths['/pets/{petId}'].delete
      spec.paths['/pets/{petId}'].patch = { tags: ['Pets'], operationId: 'updatePet', summary: 'Atualizar pet', responses: {} }
      spec.paths['/vacinas'] = { get: { tags: ['Vacinas'], operationId: 'listVaccines', responses: {} } }
    })

    const prepared = await prepareImport([specPath])
    const preview = await previewImport(prepared, target)
    expect(preview.errors).toEqual([])
    const status = (connectorId: string) =>
      Object.fromEntries(preview.connectors.find((c) => c.id === connectorId)!.endpoints.map((e) => [e.id, e.status]))
    expect(status('loja-de-pets.pets')).toEqual({
      listPets: 'existing',
      createPet: 'updated',
      getPet: 'conflict',
      deletePet: 'removed',
      uploadPhoto: 'existing',
      updatePet: 'new'
    })
    const createPlan = preview.connectors.find((c) => c.id === 'loja-de-pets.pets')!.endpoints.find((e) => e.id === 'createPet')!
    expect(createPlan.sync).toMatchObject({ key: 'loja-de-pets.pets/createPet', decision: 'spec' })
    expect(createPlan.sync!.changes.map((c) => c.field)).toEqual(['name', 'body'])
    expect(createPlan.sync!.changes[0]).toEqual({ field: 'name', before: 'Cadastrar pet', after: 'Cadastrar um pet' })
    expect(preview.connectors.find((c) => c.id === 'loja-de-pets.vacinas')).toMatchObject({ origin: 'imported', extends: 'loja-de-pets' })

    // Padrão: aplica o que mudou só na spec, mantém o conflito e o removido.
    await writeImport(prepared, target)
    let after = await read(target.dir, 'loja-de-pets.pets')
    const created = after.endpoints!.find((e) => e.id === 'createPet')!
    expect(created).toMatchObject({ name: 'Cadastrar um pet', body: { name: 'Bidu' } })
    expect(created.scenarios).toEqual(create.scenarios)
    expect(after.endpoints!.find((e) => e.id === 'getPet')!.name).toBe('Buscar pet pelo id')
    expect(after.endpoints!.some((e) => e.id === 'deletePet')).toBe(true)
    expect(after.endpoints!.some((e) => e.id === 'updatePet')).toBe(true)
    expect((await read(target.dir, 'loja-de-pets')).source!.version).toBe('1.3')
    expect((await read(target.dir, 'loja-de-pets.vacinas')).endpoints!.map((e) => e.id)).toEqual(['listVaccines'])

    // Agora o usuário escolhe a spec no conflito e apagar o removido.
    const again = await prepareImport([specPath])
    const input = { syncDecisions: { 'loja-de-pets.pets/getPet': 'spec' as const, 'loja-de-pets.pets/deletePet': 'spec' as const } }
    const second = await previewImport(again, target, input)
    expect(second.changes.map((c) => [c.path, c.action])).toEqual([
      ['flows/loja-de-pets.pets/deletePet.flow.vvpost.json', 'delete'],
      ['flows/loja-de-pets.pets/getPet.flow.vvpost.json', 'update']
    ])
    await writeImport(again, target, input)
    after = await read(target.dir, 'loja-de-pets.pets')
    expect(after.endpoints!.find((e) => e.id === 'getPet')!.name).toBe('Obter pet')
    expect(after.endpoints!.some((e) => e.id === 'deletePet')).toBe(false)
    expect((await previewImport(await prepareImport([specPath]), target)).changes).toEqual([])
  })

  it('operação que mudou de tag fica onde está, sem duplicar; spec com outro título mescla pelo caminho', async () => {
    const target = project()
    const specPath = join(target.dir, 'petstore.openapi.yaml')
    await writeImport(await prepareImport([specPath]), target)
    editSpec(target.dir, (spec) => {
      spec.info.title = 'Pet Shop'
      spec.paths['/owners'].post.tags = ['Clientes']
    })
    const preview = await previewImport(await prepareImport([specPath]), target)
    expect(preview.connectors.map((c) => c.id)).not.toContain('pet-shop')
    expect(preview.connectors.map((c) => c.id)).not.toContain('loja-de-pets.clientes')
    // A operação só trocou de tag: continua em Tutores, sem conector novo nem mudança.
    expect(preview.changes).toEqual([])
    expect(preview.connectors.filter((c) => c.origin === 'imported')).toEqual([])
  })

  it('import por conteúdo (MCP, CLI) usa o nome do arquivo como origem', () => {
    const prepared = prepareSources([{ file: 'api.yaml', data: load('petstore.openapi.yaml'), location: 'specs/api.yaml' }])
    expect(prepared.invalid).toEqual([])
    expect(prepared.result.connectors[0]!.source!.location).toBe('specs/api.yaml')
  })
})

describe('OpenAPI pela URL, pelo CLI e pelo MCP', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const temp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'vvpost-openapi-'))
    dirs.push(dir)
    return dir
  }
  // O import grava fluxos num workspace sem conectores no formato antigo: lê o conector que eles dão.
  const read = async (dir: string, id: string): Promise<Connector> => (await loadWorkspace(dir)).connectors.get(id)!

  /** Servidor local com a spec em YAML; `spec` pode mudar entre as chamadas. */
  async function serve(spec: () => string) {
    const server = createServer((req, res) => {
      if (req.url !== '/openapi.yaml') {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/yaml' }).end(spec())
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/openapi.yaml`, close: () => server.close() }
  }

  it('importa pela URL e a reimportação relê de lá', async () => {
    let text = readFileSync(fixturePath('petstore.openapi.yaml'), 'utf8')
    const http = await serve(() => text)
    try {
      const target = { dir: temp(), isWorkspace: true }
      const prepared = await prepareUrlImport(http.url)
      expect(prepared.readErrors).toEqual([])
      await writeImport(prepared, target)
      expect((await read(target.dir, 'loja-de-pets')).source!.location).toBe(http.url)

      text = text.replace('summary: Listar pets', 'summary: Listar todos os pets')
      const { prepareSpecReimport } = await import('../src/main/importers')
      const again = await prepareSpecReimport(target.dir, 'loja-de-pets.pets')
      const preview = await previewImport(again, target)
      const list = preview.connectors.find((c) => c.id === 'loja-de-pets.pets')!.endpoints.find((e) => e.id === 'listPets')!
      expect(list.status).toBe('updated')

      const missing = await prepareUrlImport(http.url.replace('openapi.yaml', 'nada.yaml'))
      expect(missing.readErrors[0]!.message).toMatch(/404/)
    } finally {
      http.close()
    }
  })

  async function cli(args: string[], cwd: string) {
    let stdout = ''
    let stderr = ''
    const io: Io = { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env: {}, cwd, isTTY: false, appDir: cwd }
    const code = await main(args, io)
    return { code, stdout, stderr }
  }

  it('vvpost import aceita a spec em YAML e --reimport com --prune', async () => {
    const dir = temp()
    copyFileSync(fixturePath('petstore.openapi.yaml'), join(dir, 'api.yaml'))
    const first = await cli(['import', 'api.yaml', '--workspace', dir], dir)
    expect(first.code).toBe(0)
    expect(first.stdout).toContain('flows/loja-de-pets.pets/loja-de-pets.pets.flow.vvpost.json')
    expect((await read(dir, 'loja-de-pets')).source!.location).toBe('api.yaml')

    writeFileSync(join(dir, 'api.yaml'), readFileSync(join(dir, 'api.yaml'), 'utf8').replace(/  \/health:[\s\S]*?'200': \{ description: ok \}\r?\n/, ''))
    const kept = await cli(['import', '--reimport', 'loja-de-pets', '--workspace', dir, '--json', '-'], dir)
    expect(kept.code).toBe(0)
    expect(JSON.parse(kept.stdout).sync).toEqual([{ endpoint: 'loja-de-pets/health', status: 'removed', decision: 'keep', changes: [] }])
    expect((await read(dir, 'loja-de-pets')).endpoints?.map((e) => e.id)).toEqual(['health'])

    const pruned = await cli(['import', '--reimport', 'loja-de-pets', '--prune', '--workspace', dir], dir)
    expect(pruned.code).toBe(0)
    expect(pruned.stdout).toContain('saiu da spec  loja-de-pets/health')
    expect((await read(dir, 'loja-de-pets')).endpoints).toBeUndefined()

    const notSpec = await cli(['import', '--reimport', 'nao-existe', '--workspace', dir], dir)
    expect(notSpec.code).toBe(2)
  })

  it('import_openapi planeja, grava com apply e recusa caminho fora do projeto', async () => {
    const dir = temp()
    copyFileSync(fixturePath('petstore.swagger.json'), join(dir, 'swagger.json'))
    const call = async (args: Record<string, unknown>) => {
      const server = createMcpServer({ workspaceDir: dir, http: { send: async () => ({}) as never, cancel() {} }, auth: createAuthEngine() })
      const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'import_openapi', arguments: args } })) as {
        result: { isError: boolean; content: { text: string }[] }
      }
      return { isError: res.result.isError, data: JSON.parse(res.result.content[0]!.text) }
    }
    const planned = await call({ location: 'swagger.json' })
    expect(planned.data).toMatchObject({ ok: true, dryRun: true })
    expect(existsSync(join(dir, 'connectors'))).toBe(false)
    const applied = await call({ location: 'swagger.json', apply: true })
    expect(applied.data.ok).toBe(true)
    expect((await read(dir, 'petstore-legado')).source).toEqual({ type: 'openapi', location: 'swagger.json', version: '1.0.0' })

    // Spec mandada pela IA, com uma operação a menos: o removido aparece em specSync e só sai com "spec".
    const spec = JSON.parse(readFileSync(join(dir, 'swagger.json'), 'utf8'))
    delete spec.paths['/pets/{id}/photo']
    const resync = await call({ location: 'swagger.json', spec: JSON.stringify(spec) })
    expect(resync.data.connectors[0].specSync).toEqual([{ key: 'petstore-legado/photo', status: 'removed', decision: 'keep', changes: [] }])
    await call({ location: 'swagger.json', spec, apply: true, syncDecisions: { 'petstore-legado/photo': 'spec' } })
    expect((await read(dir, 'petstore-legado')).endpoints!.map((e) => e.id)).toEqual(['addPet'])

    expect((await call({ location: '../fora.json' })).isError).toBe(true)
    expect((await call({ location: 'swagger.json', spec: { info: {}, item: [] } })).data.error).toMatch(/OpenAPI/)
  })
})
