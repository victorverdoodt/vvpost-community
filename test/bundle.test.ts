import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readVault, updateVault } from '@vvpost/core/vault'
import { validateBundle } from '@vvpost/schemas'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { resolveConnector } from '@vvpost/core/connectors/resolve'
import { exportBundle, exportOptions, ExportError } from '../src/main/bundle/export'
import { main, type Io } from '../src/main/cli'
import { prepareSources, previewImport, writeImport } from '../src/main/importers'
import { createMcpServer } from '../src/main/mcp/server'
import { SECRETS_FILE } from '../src/main/workspace/vault'

// Valores montados em tempo de execução: nada com cara de credencial fica no repositório.
const VAULT_TOKEN = ['vault', 'token', '7f3e9a1c5b'].join('-')
const LOCAL_PASSWORD = ['senha', 'local', '9d8c7b6a'].join('-')
const PLAIN_PASSWORD = ['senha', 'solta', '1a2b3c4d'].join('-')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function workspace(files: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-bundle-'))
  dirs.push(dir)
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
  }
  return dir
}

const scenario = { id: 'ok', name: 'OK', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }

/** Projeto com herança, cenários, docs, um fluxo, segredos no vault e uma senha numa variável comum. */
function seeded(extra: Record<string, unknown> = {}): string {
  return workspace({
    'connectors/base.connector.vvpost.json': {
      id: 'base',
      name: 'Base',
      version: '1.0.0',
      config: { baseUrl: '{{BASE_URL}}', auth: { type: 'bearer', token: '{{API_TOKEN}}' } }
    },
    'connectors/billing.connector.vvpost.json': {
      id: 'billing',
      name: 'Cobrança',
      version: '1.0.0',
      extends: 'base',
      endpoints: [
        { id: 'list', name: 'Listar', method: 'GET', path: '/charges', scenarios: [scenario] },
        { id: 'create', name: 'Criar', method: 'POST', path: '/charges' }
      ]
    },
    'connectors/billing.connector.vvpost.md': '# Cobrança\n\nDocumentação da API.\n',
    'connectors/users.connector.vvpost.json': {
      id: 'users',
      name: 'Usuários',
      version: '1.0.0',
      extends: 'base',
      endpoints: [{ id: 'me', name: 'Eu', method: 'GET', path: '/me' }]
    },
    'connectors/other.connector.vvpost.json': {
      id: 'other',
      name: 'Outro',
      version: '1.0.0',
      config: { baseUrl: 'https://outro.exemplo.com' },
      endpoints: [{ id: 'ping', name: 'Ping', method: 'GET', path: '/ping' }]
    },
    'environments/dev.env.json': {
      id: 'dev',
      name: 'Dev',
      variables: {
        BASE_URL: { type: 'string', value: 'https://api.exemplo.com' },
        API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
      }
    },
    // db_password tem valor no arquivo sem estar marcada como segredo.
    'environments/local.env.json': {
      id: 'local',
      name: 'Local',
      variables: {
        BASE_URL: { type: 'string', value: 'http://localhost:3000' },
        API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true },
        db_password: { type: 'string', value: PLAIN_PASSWORD }
      }
    },
    'flows/cobranca.flow.vvpost.json': {
      id: 'cobranca',
      name: 'Cobrança',
      nodes: [{ id: 'n1', name: 'Listar', type: 'request', request: { connector: 'billing', endpoint: 'list' } }],
      edges: []
    },
    [SECRETS_FILE]: { dev: { API_TOKEN: VAULT_TOKEN }, local: { API_TOKEN: LOCAL_PASSWORD } },
    ...extra
  })
}

const NO_SECRETS = [VAULT_TOKEN, LOCAL_PASSWORD, PLAIN_PASSWORD]

const read = (dir: string, path: string) => JSON.parse(readFileSync(join(dir, path), 'utf8'))

/** Todo arquivo do projeto que iria para o Git, num texto só. */
function versioned(dir: string): string {
  const out: string[] = []
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${e.name}` : e.name
      if (path === '.vvpost') continue
      if (e.isDirectory()) walk(path)
      else out.push(readFileSync(join(dir, path), 'utf8'))
    }
  }
  walk('')
  return out.join('\n')
}

describe('exportação do pacote', () => {
  it('exporta o projeto inteiro, válido no schema e sem nenhum valor de segredo', async () => {
    const dir = seeded()
    const result = await exportBundle(dir, {}, { name: 'Projeto', now: new Date('2026-10-24T12:00:00Z') })
    expect(validateBundle(JSON.parse(result.text)).ok).toBe(true)
    expect(result.bundle.exportedAt).toBe('2026-10-24T12:00:00.000Z')
    expect(result.summary).toEqual({ connectors: 4, endpoints: 4, scenarios: 1, environments: 2, flows: 1, docs: 1 })
    // Pai antes de filho.
    const ids = (result.bundle.connectors as { id: string }[]).map((c) => c.id)
    expect(ids.indexOf('base')).toBeLessThan(ids.indexOf('billing'))
    for (const secret of NO_SECRETS) expect(result.text).not.toContain(secret)
    const local = (result.bundle.environments as { id: string; variables: Record<string, { value: unknown; isSecret?: boolean }> }[]).find(
      (e) => e.id === 'local'
    )!
    expect(local.variables['API_TOKEN']).toEqual({ type: 'string', value: '__REQUIRED_SECRET__', isSecret: true })
    expect(local.variables['db_password']).toMatchObject({ value: '__REQUIRED_SECRET__', isSecret: true })
    expect(local.variables['BASE_URL']!.value).toBe('http://localhost:3000')
    expect(result.warnings.some((w) => w.includes('db_password'))).toBe(true)
    expect(result.bundle.docs).toEqual({ billing: '# Cobrança\n\nDocumentação da API.\n' })
  })

  it('recusa quando um valor do vault ou uma credencial literal iria para o pacote', async () => {
    const leaked = seeded({
      'connectors/other.connector.vvpost.json': {
        id: 'other',
        name: 'Outro',
        version: '1.0.0',
        description: `copiado do terminal: ${VAULT_TOKEN}`,
        config: { baseUrl: 'https://outro.exemplo.com' }
      }
    })
    const err = await exportBundle(leaked, {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ExportError)
    expect((err as Error).message).toContain('API_TOKEN do ambiente dev')
    expect((err as Error).message).not.toContain(VAULT_TOKEN)
    // Só o que foi escolhido é conferido: sem o conector, a exportação passa.
    expect((await exportBundle(leaked, { connectors: ['billing'] })).summary.connectors).toBe(2)

    const literal = seeded({
      'connectors/other.connector.vvpost.json': {
        id: 'other',
        name: 'Outro',
        version: '1.0.0',
        config: { baseUrl: 'https://outro.exemplo.com', auth: { type: 'bearer', token: PLAIN_PASSWORD } }
      }
    })
    await expect(exportBundle(literal, { connectors: ['other'] })).rejects.toThrow(/credencial literal/)
  })

  it('a seleção leva os pais, os conectores dos fluxos e só os endpoints pedidos', async () => {
    const dir = seeded()
    const onlyFlow = await exportBundle(dir, { flows: ['cobranca'] })
    expect((onlyFlow.bundle.connectors as { id: string }[]).map((c) => c.id)).toEqual(['base', 'billing'])
    expect(onlyFlow.bundle.environments).toEqual([])
    expect(onlyFlow.warnings).toEqual(
      expect.arrayContaining(['conector billing incluído porque o fluxo cobranca usa', 'conector base incluído porque billing herda dele'])
    )

    const endpoint = await exportBundle(dir, { endpoints: ['billing/create'], environments: ['dev'], scenarios: false, docs: false })
    const billing = (endpoint.bundle.connectors as { id: string; endpoints?: { id: string }[] }[]).find((c) => c.id === 'billing')!
    expect(billing.endpoints!.map((e) => e.id)).toEqual(['create'])
    expect(endpoint.bundle.docs).toBeUndefined()
    expect(endpoint.summary).toMatchObject({ connectors: 2, endpoints: 1, scenarios: 0, environments: 1, flows: 0 })

    const noScenarios = await exportBundle(dir, { connectors: ['billing'], scenarios: false })
    expect(noScenarios.text).not.toContain('"scenarios"')
    await expect(exportBundle(dir, { connectors: ['nada'] })).rejects.toThrow('conector "nada" não existe')
    await expect(exportBundle(dir, { endpoints: ['billing/nada'] })).rejects.toThrow('endpoint "nada" não existe')
  })

  it('lista as opções do projeto sem valores de variáveis', async () => {
    const options = await exportOptions(seeded())
    expect(options.connectors.map((c) => c.id)).toEqual(['base', 'billing', 'other', 'users'])
    expect(options.connectors.find((c) => c.id === 'billing')).toMatchObject({ extends: 'base', hasDocs: true })
    expect(options.environments.find((e) => e.id === 'local')).toEqual({ id: 'local', name: 'Local', variables: 3, secrets: 1 })
    expect(options.flows).toEqual([{ id: 'cobranca', name: 'Cobrança', nodes: 1, connectors: ['billing'] }])
    for (const secret of NO_SECRETS) expect(JSON.stringify(options)).not.toContain(secret)
  })
})

describe('importação do pacote', () => {
  it('ida e volta: o pacote entra num projeto vazio pela camada de escrita', async () => {
    const { text } = await exportBundle(seeded(), {})
    const target = workspace()
    const prepared = prepareSources([{ file: 'projeto.vvpost.bundle.json', data: JSON.parse(text) }])
    const preview = await previewImport(prepared, { dir: target, isWorkspace: true })
    expect(preview.errors).toEqual([])
    expect(preview.sources).toEqual([{ file: 'projeto.vvpost.bundle.json', kind: 'bundle', name: 'projeto.vvpost.bundle' }])
    expect(preview.flows.map((f) => f.id)).toEqual(['cobranca'])
    expect(preview.docs).toBe(1)
    await writeImport(prepared, { dir: target, isWorkspace: true })

    // Num projeto vazio, os conectores do pacote entram como fluxos.
    const ws = await loadWorkspace(target)
    expect(ws.issues).toEqual([])
    expect(ws.connectorFiles.get('billing')).toBe('flows/billing/billing.flow.vvpost.json')
    expect(ws.connectors.get('billing')).toMatchObject({ extends: 'base', endpoints: [{ id: 'list' }, { id: 'create' }] })
    expect(readFileSync(join(target, 'flows/billing/billing.flow.vvpost.md'), 'utf8')).toContain('Documentação da API.')
    expect(read(target, 'flows/cobranca.flow.vvpost.json').nodes[0].request.connector).toBe('billing')
    expect(read(target, 'environments/local.env.json').variables.API_TOKEN.value).toBe('__REQUIRED_SECRET__')
    expect(existsSync(join(target, SECRETS_FILE))).toBe(false)
    for (const secret of NO_SECRETS) expect(versioned(target)).not.toContain(secret)

    // De novo no mesmo projeto: mesclar não muda nada.
    const again = await previewImport(prepareSources([{ file: 'p.json', data: JSON.parse(text) }]), { dir: target, isWorkspace: true })
    expect(again.changes).toEqual([])

    // O pacote de um projeto em fluxos leva os conectores que eles são, não os fluxos-base de novo.
    const second = await exportBundle(target, {})
    const bundle = JSON.parse(second.text)
    expect(bundle.flows.map((f: { id: string }) => f.id)).toEqual(['cobranca'])
    expect(bundle.connectors.map((c: { id: string }) => c.id).sort()).toEqual([...ws.connectors.keys()].sort())
    const third = workspace()
    await writeImport(prepareSources([{ file: 'p.json', data: bundle }]), { dir: third, isWorkspace: true })
    const ws3 = await loadWorkspace(third)
    expect(ws3.issues).toEqual([])
    for (const id of ws.connectors.keys()) expect(resolveConnector(id, ws3.connectors)).toEqual(resolveConnector(id, ws.connectors))
    await expect(exportBundle(target, { flows: ['billing'] })).rejects.toThrow('"billing" é um fluxo-base: escolha-o entre os conectores')
  })

  it('no próprio projeto (arquivos escritos à mão, sem $schema) mesclar não regrava nada', async () => {
    const dir = seeded()
    const { text } = await exportBundle(dir, {})
    const preview = await previewImport(prepareSources([{ file: 'p.json', data: JSON.parse(text) }]), { dir, isWorkspace: true })
    expect(preview.errors).toEqual([])
    expect(preview.changes).toEqual([])
  })

  it('com o id já no projeto, rename importa ao lado e o fluxo acompanha; merge mantém o do projeto', async () => {
    const { text } = await exportBundle(seeded(), { flows: ['cobranca'] })
    const target = workspace({
      'connectors/billing.connector.vvpost.json': {
        id: 'billing',
        name: 'Billing do projeto',
        version: '1.0.0',
        config: { baseUrl: 'https://projeto.exemplo.com' },
        endpoints: [{ id: 'list', name: 'Listar', method: 'GET', path: '/x' }]
      },
      'flows/cobranca.flow.vvpost.json': { id: 'cobranca', name: 'Do projeto', nodes: [], edges: [] }
    })
    const prepared = prepareSources([{ file: 'p.json', data: JSON.parse(text) }])
    const dir = { dir: target, isWorkspace: true }
    const merged = await previewImport(prepared, dir)
    expect(merged.flows[0]).toMatchObject({ id: 'cobranca', origin: 'existing', conflict: 'merge' })

    const key = merged.connectors.find((c) => c.id === 'billing' && c.conflict)!.key
    const input = { conflicts: { [key]: 'rename' as const }, flowConflicts: { cobranca: 'rename' as const } }
    const renamed = await previewImport(prepared, dir, input)
    expect(renamed.errors).toEqual([])
    await writeImport(prepared, dir, input)
    const newBilling = renamed.connectors.find((c) => c.key === key)!.id
    expect(newBilling).not.toBe('billing')
    const flowFile = renamed.changes.find((c) => c.path.startsWith('flows/'))!.path
    expect(read(target, flowFile).nodes[0].request.connector).toBe(newBilling)
    expect(read(target, 'flows/cobranca.flow.vvpost.json').name).toBe('Do projeto')
    expect(read(target, 'connectors/billing.connector.vvpost.json').name).toBe('Billing do projeto')
    expect(existsSync(join(target, `connectors/${newBilling}.connector.vvpost.md`))).toBe(true)
  })

  it('valida cada documento e manda valor real de segredo para o vault, não para o arquivo', async () => {
    const { bundle } = await exportBundle(seeded(), { environments: ['dev'] })
    const env = (bundle.environments as { variables: Record<string, { value: string }> }[])[0]!
    env.variables['API_TOKEN']!.value = VAULT_TOKEN
    const broken = { ...bundle, connectors: [{ id: 'sem-nome' }], flows: [] }
    const prepared = prepareSources([{ file: 'p.json', data: broken }])
    expect(prepared.result.errors[0]!.file).toBe('p.json › connectors[0] (sem-nome)')
    expect(prepared.result.secrets).toEqual([{ environmentId: 'dev', variable: 'API_TOKEN', value: VAULT_TOKEN }])

    const ok = prepareSources([{ file: 'p.json', data: { ...bundle, connectors: [], flows: [] } }])
    const target = workspace()
    await writeImport(ok, { dir: target, isWorkspace: true })
    expect(read(target, 'environments/dev.env.json').variables.API_TOKEN.value).toBe('__REQUIRED_SECRET__')
    expect((await readVault(target))).toEqual({ dev: { API_TOKEN: VAULT_TOKEN } })
    expect(versioned(target)).not.toContain(VAULT_TOKEN)
  })
})

describe('pacote pelo MCP', () => {
  const call = async (dir: string, name: string, args: Record<string, unknown>) => {
    const server = createMcpServer({ workspaceDir: dir, http: { send: async () => ({}) as never, cancel() {} }, auth: createAuthEngine() })
    const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as {
      result: { isError: boolean; content: { text: string }[] }
    }
    return { isError: res.result.isError, text: res.result.content[0]!.text, data: JSON.parse(res.result.content[0]!.text) }
  }

  it('generate_docs gera a documentação rica de cada nível, sem segredo', async () => {
    const source = seeded({ 'environments/qa.env.json': { id: 'qa', name: 'QA', variables: { db_password: { type: 'string', value: PLAIN_PASSWORD } } } })
    const project = await call(source, 'generate_docs', {})
    expect(project.isError).toBe(false)
    expect(project.data.scope).toBe('Projeto')
    expect(project.data.markdown).toContain('### Mapa do projeto')
    const endpoint = await call(source, 'generate_docs', { connector: 'billing', endpoint: 'list' })
    expect(endpoint.data.title).toBe('GET /charges · Listar')
    expect(endpoint.data.markdown).toContain('#### Fluxos que usam este endpoint')
    expect(endpoint.data.markdown).toContain('Documentação da API.')
    for (const secret of NO_SECRETS) {
      expect(project.text).not.toContain(secret)
      expect(endpoint.text).not.toContain(secret)
    }
    const missing = await call(source, 'generate_docs', { connector: 'billing', endpoint: 'nada' })
    expect(missing.isError).toBe(true)
    expect((await call(source, 'generate_docs', { endpoint: 'list' })).isError).toBe(true)
  })

  it('export_project devolve o pacote e import_bundle planeja, e só grava com apply, sem segredo', async () => {
    const source = seeded()
    const exported = await call(source, 'export_project', { flows: ['cobranca'], environments: ['local'] })
    expect(exported.isError).toBe(false)
    expect(exported.data.summary).toMatchObject({ connectors: 2, flows: 1, environments: 1 })
    for (const secret of NO_SECRETS) expect(exported.text).not.toContain(secret)

    // O pacote volta para o MCP com um valor de segredo colocado à mão: a IA não grava.
    const bundle = exported.data.bundle
    bundle.environments[0].variables.API_TOKEN.value = LOCAL_PASSWORD
    const target = workspace()
    const planned = await call(target, 'import_bundle', { bundle: JSON.stringify(bundle) })
    expect(planned.data).toMatchObject({ ok: true, dryRun: true })
    expect(planned.data.changes.map((c: { path: string }) => c.path)).toEqual(
      expect.arrayContaining(['connectors/billing.connector.vvpost.json', 'flows/cobranca.flow.vvpost.json'])
    )
    expect(planned.data.pendingSecrets.variables).toEqual(['local/API_TOKEN'])
    expect(planned.text).not.toContain(LOCAL_PASSWORD)
    expect(existsSync(join(target, 'connectors'))).toBe(false)

    const applied = await call(target, 'import_bundle', {
      bundle,
      apply: true,
      adjustments: [{ op: 'renameConnector', id: 'billing', name: 'Cobrança (MCP)' }]
    })
    expect(applied.data.ok).toBe(true)
    expect(read(target, 'connectors/billing.connector.vvpost.json').name).toBe('Cobrança (MCP)')
    expect(existsSync(join(target, SECRETS_FILE))).toBe(false)
    expect(versioned(target)).not.toContain(LOCAL_PASSWORD)

    const notBundle = await call(target, 'import_bundle', { bundle: { info: {}, item: [] } })
    expect(notBundle.data.error).toContain('import_postman')
  })
})

describe('pacote pelo CLI', () => {
  async function cli(args: string[], cwd: string) {
    let stdout = ''
    let stderr = ''
    const io: Io = { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env: {}, cwd, isTTY: false, appDir: cwd }
    const code = await main(args, io)
    return { code, stdout, stderr }
  }

  it('vvpost export grava o pacote e vvpost import traz para outro workspace', async () => {
    const source = seeded()
    const out = workspace()
    const exported = await cli(['export', '--workspace', source, '--flow', 'cobranca', '--env', 'dev', '--out', 'pacote.json'], out)
    expect(exported.code).toBe(0)
    expect(exported.stdout).toContain('2 conectores')
    const text = readFileSync(join(out, 'pacote.json'), 'utf8')
    for (const secret of NO_SECRETS) expect(text).not.toContain(secret)
    const piped = await cli(['export', '--workspace', source, '--connector', 'other', '--out', '-'], out)
    expect(JSON.parse(piped.stdout).connectors.map((c: { id: string }) => c.id)).toEqual(['other'])

    const target = workspace()
    const dry = await cli(['import', join(out, 'pacote.json'), '--workspace', target, '--dry-run'], out)
    expect(dry.code).toBe(0)
    expect(dry.stdout).toContain('Mudaria')
    expect(existsSync(join(target, 'connectors'))).toBe(false)
    const imported = await cli(['import', join(out, 'pacote.json'), '--workspace', target], out)
    expect(imported.code).toBe(0)
    expect(read(target, 'flows/cobranca.flow.vvpost.json').id).toBe('cobranca')
    const again = await cli(['import', join(out, 'pacote.json'), '--workspace', target, '--json', '-'], out)
    expect(JSON.parse(again.stdout)).toMatchObject({ ok: true, changes: [] })

    const leaked = seeded({
      'connectors/other.connector.vvpost.json': {
        id: 'other',
        name: 'Outro',
        version: '1.0.0',
        description: VAULT_TOKEN,
        config: { baseUrl: 'https://outro.exemplo.com' }
      }
    })
    const refused = await cli(['export', '--workspace', leaked, '--out', '-'], out)
    expect(refused.code).toBe(1)
    expect(refused.stdout).toBe('')
    expect(refused.stderr).toContain('exportação recusada')
    expect((await cli(['import', '--workspace', target], out)).code).toBe(2)
    expect((await cli(['import', join(out, 'pacote.json'), '--workspace', target, '--conflict', 'x'], out)).code).toBe(2)
  })
})
