import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Connector, Environment } from '@vvpost/schemas'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import type { ImportAdjustment } from '@shared/ipc'
import { preparePostmanImport, previewImport, writeImport } from '../src/main/importers'
import { convertPostman, type PostmanImportResult } from '../src/main/importers/postman'
import { matchPath, planImport, type ImportOp, type ProjectSnapshot } from '../src/main/importers/plan'

const users = (): PostmanImportResult =>
  convertPostman([
    {
      file: 'users.postman_collection.json',
      data: JSON.parse(readFileSync(join(__dirname, 'fixtures/postman/users.postman_collection.json'), 'utf8'))
    }
  ])

const ROOT = 'connector.usuarios'
const CAD = `${ROOT}.cadastro`
const ADMIN = `${ROOT}.admin`

const plan = (adjustments: ImportAdjustment[], project?: ProjectSnapshot, extra = {}) =>
  planImport(users(), project, { adjustments, ...extra })

const upserted = (ops: ImportOp[], id: string): Connector => {
  const op = ops.find((o) => o.op === 'upsertConnector' && o.connector.id === id)
  if (!op || op.op !== 'upsertConnector') throw new Error(`sem upsertConnector de ${id}`)
  return op.connector
}

const project = (connectors: Connector[], environments: Environment[] = []): ProjectSnapshot => ({
  connectors: new Map(connectors.map((c) => [c.id, c])),
  environments: new Map(environments.map((e) => [e.id, e]))
})

const merge = (endpointId: string, into: string): ImportAdjustment => ({
  op: 'mergeIntoScenario',
  connectorId: CAD,
  endpointId,
  into: { connector: { id: CAD }, endpointId: into }
})

describe('matchPath', () => {
  it('casa caminho concreto com parâmetros e recusa o resto', () => {
    expect(matchPath('/users/{id}', '/users/42')).toEqual({ id: '42' })
    expect(matchPath('/users/{id}', '/users/{{userId}}')).toEqual({ id: '{{userId}}' })
    expect(matchPath('/users', '/users')).toEqual({})
    expect(matchPath('/users/{id}', '/users/42/items')).toBeUndefined()
    expect(matchPath('/users/1', '/users/2')).toBeUndefined()
    expect(matchPath('/users/1', '/users/{id}')).toBeUndefined()
  })
})

describe('planImport: sugestões e mescla em cenários', () => {
  it('sugere as variações do mesmo endpoint', () => {
    const p = plan([])
    expect(p.suggestions.map((s) => [s.endpointId, s.into.endpointId, s.scenarioName])).toEqual([
      ['buscar_usuario_nao_encontrado', 'buscar_usuario', 'não encontrado'],
      ['criar_usuario_sem_email', 'criar_usuario', 'sem email'],
      ['criar_usuario_com_trace', 'criar_usuario', 'com trace'],
      ['listar_usuarios_pagina_2', 'listar_usuarios', 'página 2']
    ])
    // DELETE /users/{id} está em outro conector e tem outro método: não é variação.
    expect(p.suggestions.some((s) => s.endpointId === 'remover_usuario')).toBe(false)
  })

  it('caminho concreto vira pathParams e o teste de status do Postman vira a asserção', () => {
    const p = plan([merge('buscar_usuario_nao_encontrado', 'buscar_usuario')])
    expect(p.errors).toEqual([])
    const cad = upserted(p.ops, CAD)
    expect(cad.endpoints!.map((e) => e.id)).not.toContain('buscar_usuario_nao_encontrado')
    const target = cad.endpoints!.find((e) => e.id === 'buscar_usuario')!
    expect(target.scenarios).toEqual([
      expect.objectContaining({ id: 'postman_status_200' }),
      {
        id: 'nao_encontrado',
        name: 'não encontrado',
        overrides: { pathParams: { id: '999' } },
        assertions: [{ target: 'status', operator: 'equals', expected: 404 }]
      }
    ])
    expect(p.suggestions.some((s) => s.endpointId === 'buscar_usuario_nao_encontrado')).toBe(false)
  })

  it('corpo, headers e query diferentes viram overrides; sem teste usa status < 500 e avisa', () => {
    const p = plan([
      merge('criar_usuario_sem_email', 'criar_usuario'),
      merge('criar_usuario_com_trace', 'criar_usuario'),
      merge('listar_usuarios_pagina_2', 'listar_usuarios')
    ])
    expect(p.errors).toEqual([])
    const cad = upserted(p.ops, CAD)
    const create = cad.endpoints!.find((e) => e.id === 'criar_usuario')!
    expect(create.scenarios!.slice(1)).toEqual([
      {
        id: 'sem_email',
        name: 'sem email',
        overrides: { body: { name: 'Ana' } },
        assertions: [{ target: 'status', operator: 'equals', expected: 400 }]
      },
      {
        id: 'com_trace',
        name: 'com trace',
        overrides: { headers: { 'X-Trace': 'abc' } },
        assertions: [{ target: 'status', operator: 'lessThan', expected: 500 }]
      }
    ])
    const list = cad.endpoints!.find((e) => e.id === 'listar_usuarios')!
    // "size" some na variação: o override tira o parâmetro herdado.
    expect(list.scenarios![0]!.overrides).toEqual({ query: { page: '2', size: null } })
    expect(p.notes).toEqual([
      expect.objectContaining({ message: expect.stringContaining('status < 500'), source: expect.stringContaining('com trace') }),
      expect.objectContaining({ source: expect.stringContaining('página 2') })
    ])
    expect(cad.endpoints!.map((e) => e.id)).toEqual(['buscar_usuario', 'buscar_usuario_nao_encontrado', 'criar_usuario', 'listar_usuarios'])
  })

  it('recusa mesclar métodos ou caminhos diferentes, sem derrubar os outros ajustes', () => {
    const p = plan([
      { op: 'mergeIntoScenario', connectorId: CAD, endpointId: 'buscar_usuario', into: { connector: { id: ADMIN }, endpointId: 'remover_usuario' } },
      merge('listar_usuarios', 'buscar_usuario'),
      { op: 'renameConnector', id: ADMIN, name: 'Administração' }
    ])
    expect(p.errors.map((e) => e.adjustment)).toEqual([0, 1])
    expect(p.errors[0]!.message).toMatch(/métodos diferentes/)
    expect(p.errors[1]!.message).toMatch(/não corresponde/)
    expect(upserted(p.ops, ADMIN).name).toBe('Administração')
  })

  it('nome do cenário pode ser escolhido', () => {
    const p = plan([{ ...merge('buscar_usuario_nao_encontrado', 'buscar_usuario'), name: '404 sem usuário' } as ImportAdjustment])
    const target = upserted(p.ops, CAD).endpoints!.find((e) => e.id === 'buscar_usuario')!
    expect(target.scenarios![1]).toMatchObject({ id: '404_sem_usuario', name: '404 sem usuário' })
  })
})

describe('planImport: ajustes na hierarquia', () => {
  it('renomeia, move, agrupa e exclui', () => {
    const p = plan([
      { op: 'renameEndpoint', connectorId: CAD, endpointId: 'auditoria', name: 'x' }, // não está aqui: erro
      { op: 'renameEndpoint', connectorId: ADMIN, endpointId: 'auditoria', name: 'Log de auditoria' },
      { op: 'moveEndpoint', connectorId: ADMIN, endpointId: 'remover_usuario', to: { id: CAD } },
      { op: 'groupEndpoints', id: CAD, endpointIds: ['listar_usuarios', 'listar_usuarios_pagina_2'], name: 'Listagem' },
      { op: 'excludeEndpoint', connectorId: CAD, endpointId: 'criar_usuario_com_trace' }
    ])
    expect(p.errors.map((e) => e.adjustment)).toEqual([0])
    const ids = p.connectors.map((c) => c.id)
    expect(ids).toEqual([ROOT, CAD, `${CAD}.listagem`, ADMIN])
    expect(upserted(p.ops, `${CAD}.listagem`)).toMatchObject({ extends: CAD, name: 'Listagem' })
    expect(upserted(p.ops, `${CAD}.listagem`).endpoints!.map((e) => e.id)).toEqual(['listar_usuarios', 'listar_usuarios_pagina_2'])
    const cad = upserted(p.ops, CAD).endpoints!.map((e) => e.id)
    expect(cad).toContain('remover_usuario')
    expect(cad).not.toContain('criar_usuario_com_trace')
    expect(upserted(p.ops, ADMIN).endpoints).toEqual([expect.objectContaining({ id: 'auditoria', name: 'Log de auditoria' })])
  })

  it('setParent troca o pai, mantém pai antes de filho e recusa ciclos', () => {
    const p = plan([
      { op: 'setParent', id: ADMIN, parent: { id: CAD } },
      { op: 'setParent', id: CAD, parent: { id: ADMIN } },
      { op: 'setParent', id: ROOT, parent: { id: 'connector.nao-existe', existing: true } }
    ])
    expect(p.errors.map((e) => e.adjustment)).toEqual([1, 2])
    expect(p.connectors.map((c) => [c.id, c.extends])).toEqual([
      [ROOT, undefined],
      [CAD, ROOT],
      [ADMIN, CAD]
    ])
    const order = p.ops.filter((o) => o.op === 'upsertConnector').map((o) => (o.op === 'upsertConnector' ? o.connector.id : ''))
    expect(order).toEqual([ROOT, CAD, ADMIN])
  })

  it('desfazer a pasta sobe endpoints (com id livre) e filhos para o pai; excluir leva os filhos', () => {
    const dissolved = plan([
      { op: 'moveEndpoint', connectorId: ADMIN, endpointId: 'remover_usuario', to: { id: ROOT } },
      { op: 'groupEndpoints', id: ADMIN, endpointIds: ['auditoria'], name: 'Logs' },
      { op: 'moveEndpoint', connectorId: CAD, endpointId: 'buscar_usuario', to: { id: ADMIN } },
      { op: 'dissolveConnector', id: ADMIN }
    ])
    expect(dissolved.errors).toEqual([])
    expect(dissolved.connectors.map((c) => [c.id, c.extends])).toEqual([
      [ROOT, undefined],
      [CAD, ROOT],
      [`${ADMIN}.logs`, ROOT]
    ])
    expect(upserted(dissolved.ops, ROOT).endpoints!.map((e) => e.id)).toEqual(['remover_usuario', 'buscar_usuario'])

    const excluded = plan([{ op: 'excludeConnector', id: ROOT }])
    expect(excluded.connectors).toEqual([])
    expect(excluded.ops.some((o) => o.op === 'upsertConnector')).toBe(false)
    expect(plan([{ op: 'dissolveConnector', id: ROOT }]).errors[0]!.message).toMatch(/não tem pai/)
  })
})

describe('planImport: importar num projeto existente', () => {
  const existingRoot: Connector = {
    id: ROOT,
    name: 'Usuários (projeto)',
    version: '3.0.0',
    config: { baseUrl: 'https://prod.example.com' }
  }
  const existingCad: Connector = {
    id: CAD,
    name: 'Cadastro',
    version: '3.0.0',
    extends: ROOT,
    endpoints: [
      {
        id: 'get_user',
        name: 'Get user',
        method: 'GET',
        path: '/users/{id}',
        scenarios: [{ id: 'ok', name: 'ok', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }]
      }
    ]
  }
  const base: Connector = { id: 'connector.corp', name: 'Corp', version: '1.0.0', config: { baseUrl: 'https://corp' } }

  it('merge (padrão) mantém o conector do projeto e acrescenta só endpoints e cenários novos', () => {
    const p = plan([], project([existingRoot, existingCad]))
    const ops = p.ops.filter((o) => o.op !== 'upsertEnvironment' && o.op !== 'storeSecret')
    // Raiz e Cadastro existem: nada de upsertConnector para eles; Admin é novo.
    expect(ops.filter((o) => o.op === 'upsertConnector').map((o) => (o.op === 'upsertConnector' ? o.connector.id : ''))).toEqual([ADMIN])
    // "Buscar usuário" tem o mesmo método e caminho de get_user: só o cenário entra.
    expect(ops).toContainEqual({
      op: 'upsertScenario',
      connectorId: CAD,
      endpointId: 'get_user',
      scenario: expect.objectContaining({ id: 'postman_status_200' })
    })
    const endpoints = ops.filter((o) => o.op === 'upsertEndpoint').map((o) => (o.op === 'upsertEndpoint' ? o.endpoint.id : ''))
    expect(endpoints).not.toContain('buscar_usuario')
    expect(endpoints).toContain('criar_usuario')
    const cad = p.connectors.find((c) => c.id === CAD)!
    expect(cad).toMatchObject({ origin: 'existing', conflict: 'merge' })
    expect(cad.endpoints[0]).toMatchObject({ id: 'get_user', status: 'existing' })
    expect(cad.endpoints[0]!.scenarios).toEqual([
      { id: 'ok', name: 'ok', isNew: false },
      { id: 'postman_status_200', name: 'Status 200 (teste do Postman)', isNew: true }
    ])
  })

  it('rename importa com outro id e os filhos herdam do novo; replace regrava', () => {
    const p = plan([], project([existingRoot]), { conflicts: { [ROOT]: 'rename' } })
    expect(upserted(p.ops, `${ROOT}-2`).config?.baseUrl).toBe('{{baseUrl}}')
    expect(upserted(p.ops, CAD).extends).toBe(`${ROOT}-2`)
    expect(p.connectors[0]).toMatchObject({ key: ROOT, id: `${ROOT}-2`, conflict: 'rename', origin: 'imported' })

    const r = plan([], project([existingRoot]), { conflicts: { [ROOT]: 'replace' } })
    expect(upserted(r.ops, ROOT).name).toBe('Usuários')
  })

  it('move endpoints, mescla cenários e pendura conectores em conectores do projeto', () => {
    const p = plan(
      [
        { op: 'setParent', id: ROOT, parent: { id: base.id, existing: true } },
        { op: 'moveEndpoint', connectorId: ADMIN, endpointId: 'auditoria', to: { id: CAD, existing: true } },
        { op: 'moveEndpoint', connectorId: ADMIN, endpointId: 'remover_usuario', to: { id: CAD, existing: true } },
        {
          op: 'mergeIntoScenario',
          connectorId: CAD,
          endpointId: 'buscar_usuario_nao_encontrado',
          into: { connector: { id: CAD, existing: true }, endpointId: 'get_user' }
        }
      ],
      project([base, existingCad])
    )
    expect(p.errors).toEqual([])
    expect(upserted(p.ops, ROOT).extends).toBe(base.id)
    // CAD do import colide com o do projeto e é mesclado nele.
    expect(p.ops).toContainEqual({ op: 'upsertEndpoint', connectorId: CAD, endpoint: expect.objectContaining({ id: 'auditoria' }) })
    expect(p.ops).toContainEqual({
      op: 'upsertScenario',
      connectorId: CAD,
      endpointId: 'get_user',
      // O endpoint do projeto tem outro nome, então o cenário fica com o nome inteiro da requisição.
      scenario: expect.objectContaining({ id: 'buscar_usuario_nao_encontrado', overrides: { pathParams: { id: '999' } } })
    })
    // Pai do projeto aparece na árvore, sem mudança.
    expect(p.connectors[0]).toMatchObject({ id: base.id, origin: 'existing', untouched: true })
    expect(p.connectors.map((c) => c.id)).toEqual([base.id, ROOT, CAD, ADMIN])
  })

  it('endpoint movido para conector do projeto ganha id livre lá', () => {
    const other: Connector = { ...existingCad, id: 'connector.outro', extends: undefined }
    const p = plan(
      [{ op: 'moveEndpoint', connectorId: CAD, endpointId: 'buscar_usuario', to: { id: 'connector.outro', existing: true } }],
      project([other])
    )
    expect(p.ops).toContainEqual({
      op: 'upsertEndpoint',
      connectorId: 'connector.outro',
      endpoint: expect.objectContaining({ id: 'buscar_usuario', path: '/users/{id}' })
    })
    // O destino não tem a URL base do import: o aviso diz para onde o caminho passa a apontar.
    expect(p.notes).toEqual([
      expect.objectContaining({ message: 'o caminho /users/{id} passa a usar a URL base (nenhuma) em vez de {{baseUrl}}.' })
    ])
    const p2 = plan(
      [
        { op: 'renameEndpoint', connectorId: CAD, endpointId: 'buscar_usuario', name: 'b' },
        { op: 'moveEndpoint', connectorId: CAD, endpointId: 'buscar_usuario', to: { id: 'connector.outro', existing: true } },
        { op: 'moveEndpoint', connectorId: ADMIN, endpointId: 'remover_usuario', to: { id: 'connector.outro', existing: true } }
      ],
      project([{ ...other, endpoints: [{ id: 'remover_usuario', name: 'r', method: 'DELETE', path: '/u' }] }])
    )
    expect(p2.ops).toContainEqual({ op: 'upsertEndpoint', connectorId: 'connector.outro', endpoint: expect.objectContaining({ id: 'remover_usuario_2' }) })
  })

  it('ambientes: merge mantém valores do projeto; excluir e renomear', () => {
    const existingEnv: Environment = {
      id: 'env.usuarios',
      name: 'Usuários',
      variables: { baseUrl: { type: 'string', value: 'https://local' } }
    }
    const p = plan([], project([], [existingEnv]))
    expect(p.ops).toContainEqual({
      op: 'upsertEnvironment',
      environment: expect.objectContaining({ id: 'env.usuarios' }),
      overwriteValues: false
    })
    expect(p.environments[0]).toMatchObject({ origin: 'existing', conflict: 'merge' })
    expect(p.environments[0]!.variables.find((v) => v.name === 'baseUrl')).toMatchObject({ exists: true })

    const renamed = plan([], project([], [existingEnv]), { environmentConflicts: { 'env.usuarios': 'rename' } })
    expect(renamed.environments[0]!.id).toBe('env.usuarios-2')

    const excluded = plan([{ op: 'excludeEnvironment', id: 'env.usuarios' }])
    expect(excluded.ops.some((o) => o.op === 'upsertEnvironment')).toBe(false)
    expect(excluded.environments[0]!.excluded).toBe(true)
  })
})

describe('previewImport e writeImport: gravação pela camada de escrita do projeto', () => {
  const fixturePath = (n: string) => join(__dirname, 'fixtures/postman', n)
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const tempProject = () => {
    const dir = mkdtempSync(join(tmpdir(), 'vvpost-import-'))
    dirs.push(dir)
    return { dir, isWorkspace: true }
  }
  const read = (dir: string, path: string) => JSON.parse(readFileSync(join(dir, path), 'utf8'))

  it('prévia lista os arquivos; sem destino não grava; reimportar com merge não muda nada', async () => {
    const target = tempProject()
    const prepared = await preparePostmanImport([fixturePath('users.postman_collection.json')])
    const noTarget = await previewImport(prepared, null)
    expect(noTarget).toMatchObject({ target: null, canWrite: false, changes: [] })

    const preview = await previewImport(prepared, target)
    expect(preview.canWrite).toBe(true)
    // Num projeto vazio, cada conector vira uma pasta de fluxos: a base e um arquivo por endpoint.
    const created = preview.changes.map((c) => `${c.action} ${c.path}`).sort()
    expect(created.filter((c) => !c.includes('/connector.usuarios.cadastro/') && !c.includes('/connector.usuarios.admin/'))).toEqual([
      'create environments/usuarios.env.json',
      'create flows/connector.usuarios/connector.usuarios.flow.vvpost.json'
    ])
    expect(created).toContain('create flows/connector.usuarios.cadastro/connector.usuarios.cadastro.flow.vvpost.json')
    expect(created).toContain('create flows/connector.usuarios.admin/remover_usuario.flow.vvpost.json')
    await writeImport(prepared, target)

    const again = await previewImport(await preparePostmanImport([fixturePath('users.postman_collection.json')]), target)
    expect(again.changes).toEqual([])
    expect(again.canWrite).toBe(false)
    expect(again.connectors.every((c) => c.origin === 'existing' || c.conflict)).toBe(true)
  })

  it('num projeto com conectores no formato antigo, o import grava conectores', async () => {
    const target = tempProject()
    mkdirSync(join(target.dir, 'connectors'))
    writeFileSync(join(target.dir, 'connectors/outro.connector.vvpost.json'), JSON.stringify({ id: 'outro', name: 'Outro', version: '1.0.0' }))
    const preview = await previewImport(await preparePostmanImport([fixturePath('users.postman_collection.json')]), target)
    expect(preview.changes.map((c) => c.path).sort()).toEqual([
      'connectors/connector.usuarios.admin.connector.vvpost.json',
      'connectors/connector.usuarios.cadastro.connector.vvpost.json',
      'connectors/connector.usuarios.connector.vvpost.json',
      'environments/usuarios.env.json'
    ])
  })

  it('mescla variações em cenários de um endpoint do projeto e grava só o que muda', async () => {
    const target = tempProject()
    await writeImport(await preparePostmanImport([fixturePath('users.postman_collection.json')]), target)
    // O usuário apagou um endpoint no projeto e editou o nome de outro.
    const folder = `flows/${CAD}`
    rmSync(join(target.dir, folder, 'listar_usuarios_pagina_2.flow.vvpost.json'))
    const file = `${folder}/buscar_usuario.flow.vvpost.json`
    const edited = read(target.dir, file)
    edited.name = 'Buscar usuário (editado)'
    writeFileSync(join(target.dir, file), JSON.stringify(edited, null, 2))

    const prepared = await preparePostmanImport([fixturePath('users.postman_collection.json')])
    const input = {
      adjustments: [
        {
          op: 'mergeIntoScenario',
          connectorId: CAD,
          endpointId: 'listar_usuarios_pagina_2',
          into: { connector: { id: CAD, existing: true }, endpointId: 'listar_usuarios' },
          name: 'segunda página'
        }
      ] satisfies ImportAdjustment[]
    }
    const preview = await previewImport(prepared, target, input)
    expect(preview.adjustmentErrors).toEqual([])
    expect(preview.changes).toEqual([{ path: `${folder}/listar_usuarios.flow.vvpost.json`, action: 'update' }])
    await writeImport(prepared, target, input)
    expect(read(target.dir, file).name).toBe('Buscar usuário (editado)')
    const list = (await loadWorkspace(target.dir)).connectors.get(CAD)!.endpoints!.find((e) => e.id === 'listar_usuarios')!
    expect(list.scenarios).toEqual([
      expect.objectContaining({ id: 'segunda_pagina', overrides: { query: { page: '2', size: null } } })
    ])
  })

  it('erro da camada de escrita aparece na prévia e a gravação não muda nada', async () => {
    const target = tempProject()
    // O projeto já tem o ambiente da coleção, com accessToken como variável comum.
    mkdirSync(join(target.dir, 'environments'))
    const env = {
      id: 'env.servico-de-cobranca',
      name: 'Cobrança',
      variables: { accessToken: { type: 'string', value: '{{outra}}' } }
    }
    writeFileSync(join(target.dir, 'environments/servico-de-cobranca.env.json'), JSON.stringify(env))
    const prepared = await preparePostmanImport([fixturePath('billing.postman_collection.json')])
    const preview = await previewImport(prepared, target)
    expect(preview.canWrite).toBe(false)
    expect(preview.errors).toEqual([
      { file: expect.stringMatching(/^env\.servico-de-cobranca/), message: expect.stringContaining('accessToken') }
    ])
    await expect(writeImport(prepared, target)).rejects.toThrow(/accessToken/)
    expect(readdirSync(target.dir)).toEqual(['environments'])
    // Importar o ambiente como novo resolve.
    const renamed = await previewImport(prepared, target, { environmentConflicts: { 'env.servico-de-cobranca': 'rename' } })
    expect(renamed.errors).toEqual([])
    expect(renamed.canWrite).toBe(true)
  })
})
