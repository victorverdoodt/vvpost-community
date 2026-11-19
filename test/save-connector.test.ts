import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readConnectorSource } from '@vvpost/core/connectors/edit'
import { resolveConnector } from '@vvpost/core/connectors/resolve'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { applyProjectOps } from '../src/main/project'
import { opsInWorkspaceFormat, saveConnectorInFormat } from '../src/main/project/save-connector'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function workspace(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-save-connector-'))
  dirs.push(dir)
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), `${JSON.stringify(data, null, 2)}\n`)
  }
  return dir
}
const read = (dir: string, path: string) => JSON.parse(readFileSync(join(dir, path), 'utf8'))

const flows = {
  'flows/loja/loja.flow.vvpost.json': { id: 'loja', name: 'Loja', defaults: { baseUrl: 'https://loja.exemplo.com' }, nodes: [] },
  'flows/loja/pedidos.flow.vvpost.json': {
    id: 'loja.pedidos',
    name: 'Pedidos',
    extends: 'loja',
    order: 1,
    nodes: [{ id: 'request', name: 'Request', type: 'request', request: { method: 'GET', url: '/pedidos' } }]
  }
}

describe('editor de conector no formato de fluxos', () => {
  it('um fluxo-base abre como conector e grava de volta nos fluxos', async () => {
    const dir = workspace(flows)
    const source = await readConnectorSource(dir, 'loja')
    expect(source.file).toBe('flows/loja/loja.flow.vvpost.json')
    expect(source.connector.endpoints?.map((e) => e.id)).toEqual(['pedidos'])
    const edited = {
      ...source.connector,
      name: 'Loja online',
      endpoints: source.connector.endpoints!.map((e) => ({ ...e, path: '/v2/pedidos' }))
    }
    expect(await saveConnectorInFormat(dir, edited, source.file)).toEqual({ file: source.file })
    expect(read(dir, 'flows/loja/loja.flow.vvpost.json').name).toBe('Loja online')
    expect(read(dir, 'flows/loja/pedidos.flow.vvpost.json').nodes[0].request.url).toBe('/v2/pedidos')
    expect(existsSync(join(dir, 'connectors'))).toBe(false)
    expect(resolveConnector('loja', (await loadWorkspace(dir)).connectors).endpoints[0]!.path).toBe('/v2/pedidos')
  })

  it('trocar o id de uma base pelo editor é recusado', async () => {
    const dir = workspace(flows)
    const { connector, file } = await readConnectorSource(dir, 'loja')
    await expect(saveConnectorInFormat(dir, { ...connector, id: 'mercado' }, file)).rejects.toThrow('o id se troca pelo fluxo')
  })

  it('um conector novo nasce fluxo-base num workspace de fluxos, e conector num workspace antigo', async () => {
    const dir = workspace(flows)
    const novo = { id: 'estoque', name: 'Estoque', version: '1.0.0', config: { baseUrl: 'https://estoque.exemplo.com' } }
    expect(await saveConnectorInFormat(dir, novo)).toEqual({ file: 'flows/estoque/estoque.flow.vvpost.json' })
    expect(read(dir, 'flows/estoque/estoque.flow.vvpost.json').defaults.baseUrl).toBe('https://estoque.exemplo.com')

    const legacy = workspace({ 'connectors/api.connector.vvpost.json': { id: 'api', name: 'API', version: '1.0.0', config: { baseUrl: 'https://api.exemplo.com' } } })
    expect(await saveConnectorInFormat(legacy, novo)).toBeNull()
    expect(await saveConnectorInFormat(legacy, novo, 'connectors/estoque.connector.vvpost.json')).toBeNull()
  })

  it('credencial literal numa base não é gravada', async () => {
    const dir = workspace(flows)
    const { connector, file } = await readConnectorSource(dir, 'loja')
    const leaked = { ...connector, config: { ...connector.config, auth: { type: 'bearer' as const, token: 'abc123secreto' } } }
    await expect(saveConnectorInFormat(dir, leaked, file)).rejects.toThrow(/credencial/)
    expect(read(dir, 'flows/loja/loja.flow.vvpost.json').defaults.auth).toBeUndefined()
  })

  it('o lote da IA cria conector novo como fluxo-base num workspace de fluxos', async () => {
    const dir = workspace(flows)
    const novo = {
      id: 'estoque',
      name: 'Estoque',
      version: '1.0.0',
      config: { baseUrl: 'https://estoque.exemplo.com' },
      endpoints: [{ id: 'saldo', name: 'Saldo', method: 'GET' as const, path: '/saldo' }]
    }
    const ops = await opsInWorkspaceFormat(dir, [{ op: 'upsertConnector', connector: novo }])
    expect(ops.map((o) => o.op)).toEqual(['upsertConnector', 'migrateConnector'])
    const result = await applyProjectOps(dir, ops, { actor: 'ai' })
    expect(result.ok).toBe(true)
    expect(result.changes.map((c) => c.path).sort()).toEqual(['flows/estoque/estoque.flow.vvpost.json', 'flows/estoque/saldo.flow.vvpost.json'])
    expect(existsSync(join(dir, 'connectors'))).toBe(false)

    // Renomeado ou apagado no mesmo lote, ou num workspace antigo: o lote fica como veio.
    const renamed = [{ op: 'upsertConnector' as const, connector: { ...novo, id: 'deposito' } }, { op: 'moveConnector' as const, id: 'deposito', newId: 'armazem' }]
    expect(await opsInWorkspaceFormat(dir, renamed)).toEqual(renamed)
    const legacy = workspace({ 'connectors/api.connector.vvpost.json': { id: 'api', name: 'API', version: '1.0.0' } })
    const plain = [{ op: 'upsertConnector' as const, connector: novo }]
    expect(await opsInWorkspaceFormat(legacy, plain)).toEqual(plain)
  })
})
