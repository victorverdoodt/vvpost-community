import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Connector } from '@vvpost/schemas'
import { readConnectorSource, saveConnector } from '@vvpost/core/connectors/edit'
import { resolveConnector } from '@vvpost/core/connectors/resolve'
import { setSharedConnectors } from '@vvpost/core/connectors/shared'
import { summarizeWorkspace } from '@vvpost/core/connectors/summary'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { setControlPlaneForTests, sharedConnectors } from '../src/main/enterprise/control-plane'

const dirs: string[] = []
const workspace = () => {
  const d = mkdtempSync(join(tmpdir(), 'vvpost-shared-'))
  dirs.push(d)
  mkdirSync(join(d, 'connectors'))
  return d
}
const write = (dir: string, path: string, data: unknown) => writeFileSync(join(dir, path), `${JSON.stringify(data, null, 2)}\n`)

afterEach(() => {
  setSharedConnectors(null)
  setControlPlaneForTests(undefined)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const corp: Connector = {
  id: 'corp.base',
  name: 'Corporate Base',
  version: '1.4.0',
  config: { baseUrl: '{{BASE_URL}}', headers: { Authorization: 'Bearer {{ACCESS_TOKEN}}', 'X-Org': 'contoso' } }
}
const billing: Connector = { id: 'billing', name: 'Billing', version: '1.0.0', extends: 'corp.base', config: { basePath: '/billing' } }
const shared = [{ source: 'cp.contoso.com/payments@org:3', doc: corp }]

describe('conectores compartilhados (catálogo centralizado)', () => {
  it('entram no workspace e um conector local herda deles', async () => {
    const dir = workspace()
    write(dir, 'connectors/billing.connector.vvpost.json', billing)
    const ws = await loadWorkspace(dir, { shared })
    expect(ws.issues).toEqual([])
    expect(ws.shared?.get('corp.base')).toBe('cp.contoso.com/payments@org:3')
    expect(ws.connectorFiles.get('corp.base')).toBe('shared:cp.contoso.com/payments@org:3')
    const resolved = resolveConnector('billing', ws.connectors)
    expect(resolved.chain).toEqual(['corp.base', 'billing'])
    expect(resolved.headers['X-Org']).toBe('contoso')

    const summary = summarizeWorkspace(ws)
    expect(summary.connectors.find((c) => c.id === 'corp.base')?.shared).toBe('cp.contoso.com/payments@org:3')
    expect(summary.connectors.find((c) => c.id === 'billing')?.shared).toBeUndefined()
  })

  it('um arquivo local com o mesmo id não troca o conector da organização', async () => {
    const dir = workspace()
    write(dir, 'connectors/corp.connector.vvpost.json', { ...corp, config: { baseUrl: 'https://evil.example.com' } })
    const ws = await loadWorkspace(dir, { shared })
    expect(ws.connectors.get('corp.base')?.config?.baseUrl).toBe('{{BASE_URL}}')
    expect(ws.issues).toEqual([
      {
        file: 'connectors/corp.connector.vvpost.json',
        message: 'id "corp.base" é do conector compartilhado de cp.contoso.com/payments@org:3; arquivo ignorado (use outro id com "extends": "corp.base")'
      }
    ])
  })

  it('compartilhado inválido ou com credencial literal fica de fora, e o resto segue', async () => {
    const dir = workspace()
    write(dir, 'connectors/billing.connector.vvpost.json', { ...billing, extends: undefined })
    const ws = await loadWorkspace(dir, {
      shared: [
        { source: 'cp/x@org:1', doc: { id: 'Sem Formato' } },
        { source: 'cp/x@org:1', doc: { ...corp, id: 'corp.leak', config: { auth: { type: 'bearer', token: 'eyJhbGciOi' } } } },
        { source: 'cp/x@org:1', doc: corp },
        { source: 'cp/x@payments:2', doc: corp }
      ]
    })
    expect([...ws.connectors.keys()].sort()).toEqual(['billing', 'corp.base'])
    expect(ws.issues.map((i) => i.file)).toEqual(expect.arrayContaining(['shared:cp/x@org:1', 'shared:cp/x@payments:2']))
    expect(ws.issues.some((i) => i.message.includes('credencial literal (auth.token)'))).toBe(true)
    expect(ws.issues.some((i) => i.message.includes('já usado em shared:cp/x@org:1'))).toBe(true)
  })

  it('não se edita pelo app: ler para editar e gravar com o id são recusados', async () => {
    const dir = workspace()
    setSharedConnectors(async () => shared)
    await expect(readConnectorSource(dir, 'corp.base')).rejects.toThrow(/compartilhado de cp\.contoso\.com\/payments@org:3 e não se edita aqui/)
    await expect(saveConnector(dir, { ...corp, name: 'Meu' })).rejects.toThrow(/é de um conector compartilhado/)
    await expect(saveConnector(dir, billing)).resolves.toEqual({ file: 'connectors/billing.connector.vvpost.json' })
  })

  it('o provider registrado vale para todo loadWorkspace, e a falha dele vira issue', async () => {
    const dir = workspace()
    write(dir, 'connectors/billing.connector.vvpost.json', billing)
    setSharedConnectors(async () => shared)
    expect((await loadWorkspace(dir)).connectors.has('corp.base')).toBe(true)
    // `shared` explícito ganha do provider (o CLI pode passar o próprio catálogo).
    expect((await loadWorkspace(dir, { shared: [] })).connectors.has('corp.base')).toBe(false)

    setSharedConnectors(async () => {
      throw new Error('módulo fora do ar')
    })
    const ws = await loadWorkspace(dir)
    expect(ws.connectors.has('billing')).toBe(true)
    expect(ws.issues).toContainEqual({ file: 'shared', message: 'conectores compartilhados indisponíveis: módulo fora do ar' })
  })

  it('sharedConnectors traduz o catálogo do Control Plane, e sem catálogo é vazio', async () => {
    setControlPlaneForTests({ activity: () => {} })
    expect(await sharedConnectors()).toEqual([])
    setControlPlaneForTests({
      activity: () => {},
      catalog: async () => ({
        source: 'cp.contoso.com/payments',
        etag: '"v1"',
        syncedAt: '2026-10-24T00:00:00Z',
        connectors: [
          { scope: 'org', version: 3, doc: corp },
          { scope: 'payments', version: 7, doc: billing }
        ]
      })
    })
    expect(await sharedConnectors()).toEqual([
      { source: 'cp.contoso.com/payments@org:3', doc: corp },
      { source: 'cp.contoso.com/payments@payments:7', doc: billing }
    ])
  })
})
