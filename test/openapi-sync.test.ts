import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import type { Connector } from '@vvpost/schemas'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { prepareImport, writeImport } from '../src/main/importers'
import { syncSpecSources } from '../src/main/importers/spec-sync'
import { applyProjectOps } from '../src/main/project'
import { main, type Io } from '../src/main/cli'
import { createMcpServer } from '../src/main/mcp/server'
import { createAuthEngine } from '@vvpost/core/connectors/auth'

const fixture = join(__dirname, 'fixtures/openapi/petstore.openapi.yaml')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-sync-test-'))
  dirs.push(dir)
  return dir
}

/** Projeto com a spec importada (em fluxos, o formato padrão) e a spec dentro dele. */
async function imported(): Promise<string> {
  const dir = temp()
  copyFileSync(fixture, join(dir, 'openapi.yaml'))
  await writeImport(await prepareImport([join(dir, 'openapi.yaml')]), { dir, isWorkspace: true })
  return dir
}

const editSpec = (dir: string, edit: (spec: any) => void, file = 'openapi.yaml') => {
  const path = join(dir, file)
  const spec = parse(readFileSync(path, 'utf8'))
  edit(spec)
  writeFileSync(path, stringify(spec))
}

const read = async (dir: string, id: string): Promise<Connector> => {
  const ws = await loadWorkspace(dir)
  return ws.unresolved?.get(id) ?? ws.connectors.get(id)!
}
const endpointOf = async (dir: string, connector: string, id: string) => (await read(dir, connector)).endpoints?.find((e) => e.id === id)

const ops = async (dir: string, list: Parameters<typeof applyProjectOps>[1]) => {
  const r = await applyProjectOps(dir, list)
  expect(r.errors).toEqual([])
}

describe('sync com a spec do código', () => {
  it('logo depois do import não há drift nem nada a gravar', async () => {
    const dir = await imported()
    const report = await syncSpecSources(dir)
    expect(report.ok).toBe(true)
    expect(report.results).toHaveLength(1)
    expect(report.results[0]).toMatchObject({ connector: 'loja-de-pets', location: 'openapi.yaml', drift: false, breaking: false, changes: [], endpoints: [], breaks: [] })
  })

  it('a spec ganha no contrato, o VVPost guarda cenários e exemplos, e rodar de novo não grava nada', async () => {
    const dir = await imported()
    // No VVPost: cenário com corpo em createPet, cenário em deletePet, um exemplo de resposta e uma edição de contrato em getPet.
    const create = (await endpointOf(dir, 'loja-de-pets.pets', 'createPet'))!
    await ops(dir, [
      {
        op: 'upsertScenario',
        connectorId: 'loja-de-pets.pets',
        endpointId: 'createPet',
        scenario: { id: 'ok', name: 'Cria', overrides: { body: { name: 'Rex' } }, assertions: [{ target: 'status', operator: 'equals', expected: 201 }] }
      },
      {
        op: 'upsertScenario',
        connectorId: 'loja-de-pets.pets',
        endpointId: 'deletePet',
        scenario: { id: 'apaga', name: 'Apaga', assertions: [{ target: 'status', operator: 'equals', expected: 204 }] }
      },
      { op: 'upsertEndpoint', connectorId: 'loja-de-pets.pets', endpoint: { ...(await endpointOf(dir, 'loja-de-pets.pets', 'getPet'))!, name: 'Buscar pet (editado)' }, keepScenarios: true }
    ])
    expect(create.name).toBe('Cadastrar pet')

    editSpec(dir, (spec) => {
      spec.info.version = '1.3'
      spec.paths['/pets'].post.summary = 'Cadastrar um pet'
      // Campo obrigatório novo: o corpo do cenário "ok" deixa de passar no schema.
      spec.components.schemas.NewPet.required = ['name', 'species']
      spec.components.schemas.NewPet.properties.species = { type: 'string' }
      delete spec.paths['/pets/{petId}'].delete
      spec.paths['/vacinas'] = { get: { tags: ['Vacinas'], operationId: 'listVaccines', responses: {} } }
    })

    const check = await syncSpecSources(dir)
    expect(check.dryRun).toBe(true)
    const r = check.results[0]!
    expect(r.drift).toBe(true)
    expect(r.breaking).toBe(true)
    const byKey = Object.fromEntries(r.endpoints.map((e) => [e.key, e]))
    expect(byKey['loja-de-pets.pets/createPet']).toMatchObject({ status: 'updated', applied: true, fields: ['name', 'body'] })
    expect(byKey['loja-de-pets.pets/getPet']).toMatchObject({ status: 'edited', applied: true, fields: ['name'] })
    expect(byKey['loja-de-pets.pets/deletePet']).toMatchObject({ status: 'removed', applied: false, dependents: ['cenário apaga'] })
    expect(byKey['loja-de-pets.vacinas/listVaccines']).toMatchObject({ status: 'new', applied: true })
    expect(r.schemas).toEqual([{ name: 'NewPet', status: 'updated', applied: true }])
    expect(r.breaks.some((b) => /createPet: cenário: cria fora do bodySchema/i.test(b.message) && /species/.test(b.message))).toBe(true)
    // Só conferir não grava.
    expect((await endpointOf(dir, 'loja-de-pets.pets', 'getPet'))!.name).toBe('Buscar pet (editado)')

    const applied = await syncSpecSources(dir, { apply: true })
    expect(applied.ok).toBe(true)
    expect(applied.results[0]!.changes.length).toBeGreaterThan(0)
    const created = (await endpointOf(dir, 'loja-de-pets.pets', 'createPet'))!
    expect(created.name).toBe('Cadastrar um pet')
    expect(created.scenarios?.map((s) => s.id)).toEqual(['ok'])
    expect((await endpointOf(dir, 'loja-de-pets.pets', 'getPet'))!.name).toBe('Buscar pet')
    expect((await endpointOf(dir, 'loja-de-pets.pets', 'getPet'))!.examples?.length).toBeGreaterThan(0)
    expect(await endpointOf(dir, 'loja-de-pets.pets', 'deletePet')).toBeDefined()
    expect((await read(dir, 'loja-de-pets.vacinas')).endpoints?.map((e) => e.id)).toEqual(['listVaccines'])
    expect((await read(dir, 'loja-de-pets')).source).toEqual({ type: 'openapi', location: 'openapi.yaml', version: '1.3' })

    // Idempotente: só o removido continua como drift, e nada é gravado.
    const again = await syncSpecSources(dir, { apply: true })
    expect(again.results[0]!.changes).toEqual([])
    expect(again.results[0]!.endpoints.map((e) => [e.key, e.status])).toEqual([['loja-de-pets.pets/deletePet', 'removed']])

    // Com prune, sai; depois disso o projeto bate com a spec.
    const pruned = await syncSpecSources(dir, { apply: true, prune: true })
    expect(pruned.results[0]!.endpoints).toMatchObject([{ key: 'loja-de-pets.pets/deletePet', status: 'removed', applied: true }])
    expect(await endpointOf(dir, 'loja-de-pets.pets', 'deletePet')).toBeUndefined()
    expect((await syncSpecSources(dir)).results[0]).toMatchObject({ drift: false, changes: [] })
  })

  it('requiresAuth segue a spec: o público que passa a exigir auth é quebra, e o fluxo guarda o campo', async () => {
    const dir = await imported()
    expect((await endpointOf(dir, 'loja-de-pets', 'health'))!.requiresAuth).toBe(false)
    const file = join(dir, 'flows/loja-de-pets/health.flow.vvpost.json')
    // Uma ordem de chaves feita à mão, com o cenário no fim: a regravação mantém.
    const handmade = JSON.parse(readFileSync(file, 'utf8'))
    const { requiresAuth, ...rest } = handmade
    expect(requiresAuth).toBe(false)
    writeFileSync(file, JSON.stringify({ ...rest, requiresAuth, scenarios: [{ id: 'ok', name: 'OK', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }] }, null, 2) + '\n')
    const keys = Object.keys(JSON.parse(readFileSync(file, 'utf8')))

    editSpec(dir, (spec) => delete spec.paths['/health'].get.security)
    const r = (await syncSpecSources(dir)).results[0]!
    expect(r.endpoints).toMatchObject([{ key: 'loja-de-pets/health', status: 'updated', fields: ['requiresAuth'] }])
    expect(r.breaking).toBe(true)
    expect(r.breaks).toEqual([
      { file: 'loja-de-pets/health', message: 'GET /health era público e passou a exigir autenticação: quem chama sem credencial passa a receber 401/403' }
    ])
    await syncSpecSources(dir, { apply: true })
    expect((await endpointOf(dir, 'loja-de-pets', 'health'))!.requiresAuth).toBe(true)
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual(keys)

    // O caminho contrário só atualiza.
    editSpec(dir, (spec) => (spec.paths['/health'].get.security = []))
    const back = (await syncSpecSources(dir)).results[0]!
    expect(back).toMatchObject({ breaking: false, breaks: [] })
  })

  it('com keepEdits, a edição do projeto fica e continua contando como drift no conflito', async () => {
    const dir = await imported()
    const get = (await endpointOf(dir, 'loja-de-pets.pets', 'getPet'))!
    await ops(dir, [{ op: 'upsertEndpoint', connectorId: 'loja-de-pets.pets', endpoint: { ...get, name: 'Meu nome' }, keepScenarios: true }])
    // Sem mudança na spec, a edição local não é drift quando o projeto manda.
    expect((await syncSpecSources(dir, { keepEdits: true })).results[0]!.drift).toBe(false)
    editSpec(dir, (spec) => (spec.paths['/pets/{petId}'].get.summary = 'Obter pet'))
    const r = (await syncSpecSources(dir, { keepEdits: true, apply: true })).results[0]!
    expect(r.endpoints).toMatchObject([{ key: 'loja-de-pets.pets/getPet', status: 'conflict', applied: false }])
    expect(r.drift).toBe(true)
    expect((await endpointOf(dir, 'loja-de-pets.pets', 'getPet'))!.name).toBe('Meu nome')
  })

  it('a marca x-sensitive posta no projeto fica com a spec ganhando, e a da spec entra', async () => {
    const dir = await imported()
    // O usuário marca o e-mail do tutor como dado pessoal no schema compartilhado que veio da spec.
    const path = join(dir, 'schemas/Owner.schema.json')
    const owner = JSON.parse(readFileSync(path, 'utf8'))
    owner.properties.email['x-sensitive'] = 'email'
    writeFileSync(path, JSON.stringify(owner, null, 2))
    // Só a marca não é drift.
    expect((await syncSpecSources(dir)).results[0]).toMatchObject({ drift: false, changes: [] })

    editSpec(dir, (spec) => {
      spec.components.schemas.Owner.properties.phone = { type: 'string' }
      spec.components.schemas.Owner.properties.name['x-sensitive'] = true
    })
    // Pela IA (actor ai), que não pode tirar a marca: o lote passa porque ela fica.
    const r = (await syncSpecSources(dir, { apply: true, actor: 'ai' })).results[0]!
    expect(r.errors).toEqual([])
    expect(r.schemas).toEqual([{ name: 'Owner', status: 'updated', applied: true }])
    const after = JSON.parse(readFileSync(path, 'utf8'))
    expect(after.properties.email['x-sensitive']).toBe('email')
    expect(after.properties.name['x-sensitive']).toBe(true)
    expect(after.properties.phone).toEqual({ type: 'string' })
    expect((await syncSpecSources(dir)).results[0]).toMatchObject({ drift: false, changes: [] })
  })

  it('só o info.version mudou: nada a gravar', async () => {
    const dir = await imported()
    editSpec(dir, (spec) => (spec.info.version = '9.9.9'))
    const r = (await syncSpecSources(dir, { apply: true })).results[0]!
    expect(r).toMatchObject({ drift: false, changes: [], version: '9.9.9' })
  })

  it('vincula um conector feito à mão: adota os endpoints pelo método e caminho, sem duplicar, e guarda os cenários', async () => {
    const dir = temp()
    mkdirSync(join(dir, 'specs'))
    copyFileSync(fixture, join(dir, 'specs/openapi.yaml'))
    await ops(dir, [
      {
        op: 'upsertConnector',
        connector: {
          id: 'pets',
          name: 'Pets',
          version: '1.0.0',
          config: { baseUrl: '{{PETS_URL}}', headers: { 'X-Tenant': '{{TENANT}}' } },
          endpoints: [
            {
              id: 'buscar',
              name: 'Buscar',
              method: 'GET',
              path: '/pets/{id}',
              scenarios: [{ id: 'existe', name: 'Existe', overrides: { pathParams: { id: '1' } }, assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }]
            },
            { id: 'status', name: 'Status interno', method: 'GET', path: '/interno/status' }
          ]
        }
      }
    ])

    const plan = await syncSpecSources(dir, { link: { connector: 'pets', location: join(dir, 'specs/openapi.yaml') } })
    expect(plan.errors).toEqual([])
    expect(plan.results[0]!.errors).toEqual([])
    expect(plan.ok).toBe(true)
    const r = plan.results[0]!
    expect(r).toMatchObject({ connector: 'pets', location: 'specs/openapi.yaml' })
    const byKey = Object.fromEntries(r.endpoints.map((e) => [e.key, e]))
    expect(byKey['pets/buscar']).toMatchObject({ status: 'linked', applied: true })
    expect(byKey['pets/buscar']!.fields).toContain('name')
    expect(byKey['pets.pets/listPets']).toMatchObject({ status: 'new' })
    expect(Object.keys(byKey).some((k) => k.endsWith('/getPet'))).toBe(false)
    expect(r.onlyInProject).toEqual(['pets/status'])
    // O caminho da spec chama o parâmetro de petId: o cenário que dava valor a {id} quebra.
    expect(r.breaks).toEqual([expect.objectContaining({ message: 'buscar: o cenário Existe dá valor a {id}, que o caminho /pets/{petId} não tem' })])
    expect(r.breaking).toBe(true)
    // O plano não grava o vínculo.
    expect((await read(dir, 'pets')).source).toBeUndefined()

    await syncSpecSources(dir, { link: { connector: 'pets', location: 'specs/openapi.yaml' }, apply: true })
    const pets = await read(dir, 'pets')
    expect(pets.source).toEqual({ type: 'openapi', location: 'specs/openapi.yaml', version: '1.2' })
    expect(pets.config).toMatchObject({ baseUrl: '{{PETS_URL}}', headers: { 'X-Tenant': '{{TENANT}}' } })
    const buscar = pets.endpoints!.find((e) => e.id === 'buscar')!
    expect(buscar).toMatchObject({ name: 'Buscar pet', path: '/pets/{petId}', source: { operationId: 'getPet' } })
    expect(buscar.scenarios?.map((s) => s.id)).toEqual(['existe'])
    expect(pets.endpoints!.some((e) => e.id === 'status' && !e.source)).toBe(true)
    expect((await read(dir, 'pets.pets')).endpoints!.map((e) => e.id).sort()).toEqual(['createPet', 'deletePet', 'listPets', 'uploadPhoto'])

    // Vinculado, o sync segue a spec como num projeto importado.
    const again = (await syncSpecSources(dir)).results[0]!
    expect(again).toMatchObject({ drift: false, changes: [] })
    expect(again.onlyInProject).toEqual(['pets/status'])

    // Outra spec no mesmo conector: recusa.
    copyFileSync(fixture, join(dir, 'outra.yaml'))
    const other = await syncSpecSources(dir, { link: { connector: 'pets', location: 'outra.yaml' } })
    expect(other.ok).toBe(false)
    expect(other.errors[0]!.message).toMatch(/já segue a spec specs\/openapi.yaml/)
  })

  it('vincula também um fluxo-base (workspace em fluxos), num lote só', async () => {
    const dir = temp()
    copyFileSync(fixture, join(dir, 'openapi.yaml'))
    await ops(dir, [
      {
        op: 'upsertConnector',
        connector: {
          id: 'pets',
          name: 'Pets',
          version: '1.0.0',
          config: { baseUrl: '{{PETS_URL}}' },
          endpoints: [
            {
              id: 'listar',
              name: 'Listar',
              method: 'GET',
              path: '/pets',
              scenarios: [{ id: 'lista', name: 'Lista', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }]
            }
          ]
        }
      },
      { op: 'migrateConnector', id: 'pets' }
    ])
    expect((await loadWorkspace(dir)).flowSources?.has('pets')).toBe(true)
    const linked = await syncSpecSources(dir, { link: { connector: 'pets', location: 'openapi.yaml' }, apply: true })
    expect(linked.ok).toBe(true)
    expect(linked.results[0]!.changes.some((c) => c.path.endsWith('.connector.vvpost.json'))).toBe(false)
    const pets = await read(dir, 'pets')
    expect(pets.source).toMatchObject({ type: 'openapi', location: 'openapi.yaml' })
    const listar = pets.endpoints!.find((e) => e.id === 'listar')!
    expect(listar).toMatchObject({ name: 'Listar pets', source: { operationId: 'listPets' } })
    expect(listar.scenarios?.map((s) => s.id)).toEqual(['lista'])
    expect((await read(dir, 'pets.pets')).endpoints!.some((e) => e.id === 'listPets')).toBe(false)
    expect((await syncSpecSources(dir)).results[0]).toMatchObject({ drift: false, changes: [] })
  })

  it('sem spec vinculada, ou com a spec ilegível, diz o que fazer', async () => {
    const dir = temp()
    const none = await syncSpecSources(dir)
    expect(none.ok).toBe(false)
    expect(none.errors[0]!.message).toMatch(/nenhum conector vinculado/)

    const withSpec = await imported()
    rmSync(join(withSpec, 'openapi.yaml'))
    const broken = await syncSpecSources(withSpec)
    expect(broken.ok).toBe(false)
    expect(broken.results[0]!.errors[0]!.message).toMatch(/não foi possível ler a spec/)
    expect((await syncSpecSources(withSpec, { connectors: ['nao-existe'] })).errors[0]!.message).toMatch(/não existe/)
  })
})

describe('vvpost sync e sync_openapi', () => {
  async function cli(args: string[], cwd: string) {
    let stdout = ''
    let stderr = ''
    const io: Io = { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env: {}, cwd, isTTY: false, appDir: cwd }
    const code = await main(args, io)
    return { code, stdout, stderr }
  }

  it('--check falha no drift, --fail-on breaking só na quebra, e sync aplica', async () => {
    const dir = await imported()
    expect((await cli(['sync', '--check', '--workspace', dir], dir)).code).toBe(0)

    editSpec(dir, (spec) => (spec.paths['/pets'].get.summary = 'Listar todos os pets'))
    const check = await cli(['sync', '--check', '--workspace', dir], dir)
    expect(check.code).toBe(1)
    expect(check.stdout).toContain('loja-de-pets.pets/listPets: name (a spec ganha)')
    expect(check.stdout).toContain('Drift: 1 diferença(s)')
    // Mudar o nome não quebra nada.
    expect((await cli(['sync', '--check', '--fail-on', 'breaking', '--workspace', dir], dir)).code).toBe(0)

    const json = await cli(['sync', '--check', '--json', '-', '--workspace', dir], dir)
    expect(JSON.parse(json.stdout).results[0].endpoints).toMatchObject([{ key: 'loja-de-pets.pets/listPets', status: 'updated' }])

    const applied = await cli(['sync', '--workspace', dir], dir)
    expect(applied.code).toBe(0)
    expect(applied.stdout).toMatch(/1 arquivo\(s\) gravado/)
    expect((await cli(['sync', '--check', '--workspace', dir], dir)).stdout).toContain('Em dia com a spec')

    rmSync(join(dir, 'openapi.yaml'))
    expect((await cli(['sync', '--check', '--workspace', dir], dir)).code).toBe(2)
    expect((await cli(['sync', '--link', 'x.yaml', '--workspace', dir], dir)).code).toBe(2)
    expect((await cli(['sync', '--check', '--fail-on', 'sempre', '--workspace', dir], dir)).code).toBe(2)
  })

  it('vvpost sync --link vincula pela linha de comando', async () => {
    const dir = temp()
    copyFileSync(fixture, join(dir, 'openapi.yaml'))
    await ops(dir, [{ op: 'upsertConnector', connector: { id: 'pets', name: 'Pets', version: '1.0.0', endpoints: [{ id: 'saude', name: 'Saúde', method: 'GET', path: '/health' }] } }])
    const r = await cli(['sync', '--link', 'openapi.yaml', '--connector', 'pets', '--workspace', dir], dir)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('pets ← openapi.yaml (1.2)')
    expect((await read(dir, 'pets')).endpoints!.find((e) => e.id === 'saude')!.source).toMatchObject({ operationId: 'health' })
    expect((await cli(['sync', '--check', '--workspace', dir], dir)).code).toBe(0)
  })

  it('sync_openapi relata sem gravar e grava com apply', async () => {
    const dir = await imported()
    editSpec(dir, (spec) => delete spec.paths['/health'])
    const call = async (args: Record<string, unknown>) => {
      const server = createMcpServer({ workspaceDir: dir, http: { send: async () => ({}) as never, cancel() {} }, auth: createAuthEngine() })
      const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sync_openapi', arguments: args } })) as {
        result: { isError: boolean; content: { text: string }[] }
      }
      return { isError: res.result.isError, data: JSON.parse(res.result.content[0]!.text) }
    }
    const report = await call({})
    expect(report.data).toMatchObject({ ok: true, dryRun: true, inSync: false })
    expect(report.data.results[0].endpoints).toMatchObject([{ key: 'loja-de-pets/health', status: 'removed', applied: false }])
    const pruned = await call({ prune: true, apply: true })
    expect(pruned.data.ok).toBe(true)
    expect((await read(dir, 'loja-de-pets')).endpoints).toBeUndefined()
    expect((await call({})).data.inSync).toBe(true)
    expect((await call({ link: '../fora.yaml', connector: 'loja-de-pets' })).isError).toBe(true)
  })
})
