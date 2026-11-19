import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Connector } from '@vvpost/schemas'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { resolveConnector } from '@vvpost/core/connectors/resolve'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { loadFlows } from '@vvpost/core/flows/workspace'
import { generateDocumentation } from '@vvpost/core/docs/build'
import { main, type Io } from '../src/main/cli'
import { createMcpServer } from '../src/main/mcp/server'
import { exportAs } from '../src/main/bundle/export'
import { applyProjectOps } from '../src/main/project'
import { migrateWorkspace } from '../src/main/project/migrate'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function demo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-migrate-'))
  dirs.push(dir)
  cpSync(join(__dirname, 'fixtures', 'demo-legacy'), dir, { recursive: true })
  return dir
}

function write(dir: string, path: string, data: unknown): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}

/** A herança resolvida de cada conector, comparável entre os dois formatos. */
function resolvedAll(connectors: ReadonlyMap<string, Connector>) {
  return Object.fromEntries(
    [...connectors.keys()].sort().map((id) => {
      const r = structuredClone(resolveConnector(id, connectors))
      if (r.auth?.config.type === 'login') r.auth.config.request.method ??= 'POST'
      // Com a ordem dos endpoints: cada fluxo de requisição guarda a dele no order.
      return [id, r]
    })
  )
}

const files = (dir: string, sub: string) => readdirSync(join(dir, sub), { recursive: true }).map(String).sort()

describe('vvpost migrate', () => {
  it('converte o projeto de demonstração inteiro sem mudar nenhuma requisição', async () => {
    const dir = demo()
    const before = await loadWorkspace(dir)
    const flowsBefore = (await loadFlows(dir)).flows.map((f) => f.flow.id).sort()
    const connectorFiles = files(dir, 'connectors')

    const dry = await migrateWorkspace(dir, { dryRun: true })
    expect(dry.result?.ok).toBe(true)
    expect(dry.result?.changes.length).toBeGreaterThan(0)
    expect(files(dir, 'connectors')).toEqual(connectorFiles)

    const { plan, result } = await migrateWorkspace(dir)
    expect(result?.errors).toEqual([])
    expect(plan.ops.length).toBe(before.connectors.size - plan.skipped.length)
    expect(result?.review).toEqual([])
    const after = await loadWorkspace(dir)
    expect(after.issues).toEqual(before.issues)
    expect(resolvedAll(after.connectors)).toEqual(resolvedAll(before.connectors))
    // Os fluxos do Flow Studio continuam, e cada conector convertido virou uma pasta em flows/.
    const flowsAfter = (await loadFlows(dir)).flows.map((f) => f.flow.id)
    expect(flowsAfter).toEqual(expect.arrayContaining(flowsBefore))
    for (const { id } of plan.ops as { id: string }[]) {
      expect(existsSync(join(dir, `flows/${id}/${id}.flow.vvpost.json`))).toBe(true)
      expect(after.flowSources?.get(id)).toBe(`flows/${id}/${id}.flow.vvpost.json`)
    }
    // A documentação de cada conector foi junto.
    for (const md of connectorFiles.filter((f) => f.endsWith('.connector.vvpost.md'))) {
      const text = readFileSync(join(__dirname, 'fixtures', 'demo-legacy', 'connectors', md), 'utf8')
      const moved = files(dir, 'flows').find((f) => f.endsWith('.flow.vvpost.md') && readFileSync(join(dir, 'flows', f), 'utf8') === text)
      expect(moved, md).toBeDefined()
    }
    expect(files(dir, 'connectors').filter((f) => f.endsWith('.vvpost.json') || f.endsWith('.vvpost.md'))).toEqual([])
    // De novo: nada para converter.
    expect((await migrateWorkspace(dir)).result).toBeNull()
  })

  it('as exportações (pacote, Postman e OpenAPI) saem iguais antes e depois de converter', async () => {
    const dir = demo()
    const now = new Date('2026-01-01T00:00:00Z')
    const all = async () =>
      Promise.all((['vvpost', 'postman', 'openapi'] as const).map(async (format) => (await exportAs(dir, { format }, { now })).files.map((f) => JSON.parse(f.text) as unknown)))
    const before = await all()
    await migrateWorkspace(dir)
    expect(await all()).toEqual(before)
  })

  it('a documentação gerada sai igual depois de converter, só com o arquivo de cada conector', async () => {
    const dir = demo()
    const docs = async () =>
      (await generateDocumentation(await loadWorkspace(dir), await loadFlows(dir), { kind: 'project' }, { now: new Date('2026-01-01T00:00:00Z') })).markdown
    const before = await docs()
    await migrateWorkspace(dir)
    const after = await docs()
    const files = /\| Arquivo \| `[^`]+` \|/g
    expect(after.replace(files, '| Arquivo |')).toBe(before.replace(files, '| Arquivo |'))
    expect(after).toContain('| Arquivo | `flows/connector.payments.v1/connector.payments.v1.flow.vvpost.json` |')
    // Fluxos-base e de requisição não aparecem de novo como fluxos.
    expect(after).not.toContain('create_charge.flow.vvpost.json')
  })

  it('um endpoint novo vai para o fim sem renumerar; inserir no meio renumera só o que muda', async () => {
    const dir = demo()
    await migrateWorkspace(dir)
    const ws = await loadWorkspace(dir)
    const [id, connector] = [...ws.connectors].find(([, c]) => (c.endpoints?.length ?? 0) >= 3)!
    const ids = connector.endpoints!.map((e) => e.id)
    const endpoint = { id: 'novo', name: 'Novo', method: 'GET' as const, path: '/novo' }
    const added = await applyProjectOps(dir, [{ op: 'upsertEndpoint', connectorId: id, endpoint }])
    expect(added.changes.map((c) => [c.path, c.action])).toEqual([[`flows/${id}/novo.flow.vvpost.json`, 'create']])
    expect((await loadWorkspace(dir)).connectors.get(id)!.endpoints!.map((e) => e.id)).toEqual([...ids, 'novo'])

    const moved = await applyProjectOps(dir, [{ op: 'moveEndpoint', connectorId: id, endpointId: 'novo', index: 1 }])
    expect(moved.errors).toEqual([])
    expect(moved.changes.length).toBe(ids.length)
    expect((await loadWorkspace(dir)).connectors.get(id)!.endpoints!.map((e) => e.id)).toEqual([ids[0], 'novo', ...ids.slice(1)])
  })

  it('o que ainda não cabe fica no formato antigo, e os filhos dele continuam herdando', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vvpost-migrate-'))
    dirs.push(dir)
    write(dir, 'connectors/corp.connector.vvpost.json', { id: 'corp', name: 'Corp', version: '1.0.0', config: { baseUrl: 'https://api.exemplo.com', headers: { 'X-Org': 'acme' } } })
    write(dir, 'connectors/rpc.connector.vvpost.json', {
      id: 'rpc',
      name: 'RPC',
      version: '1.0.0',
      extends: 'corp',
      endpoints: [{ id: 'call', name: 'Call', method: 'POST', path: '/rpc', plugin: { adapter: 'grpc', config: {} } }]
    })
    write(dir, 'connectors/billing.connector.vvpost.json', {
      id: 'billing',
      name: 'Billing',
      version: '1.0.0',
      extends: 'corp',
      config: { basePath: '/billing' },
      endpoints: [{ id: 'charge', name: 'Cobrar', method: 'POST', path: '/charges' }]
    })
    write(dir, 'connectors/billing.connector.vvpost.md', '# Billing\n')
    // Um fluxo de requisição que já herdava continua endpoint do conector convertido.
    write(dir, 'flows/billing.refund.flow.vvpost.json', {
      id: 'billing.refund',
      name: 'Estornar',
      extends: 'billing',
      nodes: [{ id: 'request', name: 'Request', type: 'request', request: { method: 'POST', url: '/refunds' } }]
    })
    const before = await loadWorkspace(dir)
    const { plan, result } = await migrateWorkspace(dir)
    expect(result?.errors).toEqual([])
    expect(plan.skipped).toEqual([{ id: 'rpc', file: 'connectors/rpc.connector.vvpost.json', reason: expect.stringContaining('plugin (grpc)') }])
    expect(result?.changes.map((c) => `${c.action} ${c.path}`).sort()).toEqual([
      'create flows/billing/billing.flow.vvpost.json',
      'create flows/billing/billing.flow.vvpost.md',
      'create flows/billing/charge.flow.vvpost.json',
      'create flows/corp/corp.flow.vvpost.json',
      'delete connectors/billing.connector.vvpost.json',
      'delete connectors/billing.connector.vvpost.md',
      'delete connectors/corp.connector.vvpost.json'
    ])
    const after = await loadWorkspace(dir)
    expect(after.issues).toEqual([])
    expect(resolvedAll(after.connectors)).toEqual(resolvedAll(before.connectors))
    expect(resolveConnector('billing', after.connectors).endpoints.map((e) => e.id)).toEqual(['charge', 'refund'])
  })

  it('vvpost list e o catálogo do MCP mostram os mesmos fluxos e conectores antes e depois', async () => {
    const dir = demo()
    const listJson = async () => {
      let stdout = ''
      const io: Io = { stdout: (t) => (stdout += t), stderr: () => {}, env: { VVPOST_USER_DATA: join(dir, '.ud') }, cwd: dir, isTTY: false, appDir: join(dir, '.app') }
      expect(await main(['list', '--json', '-'], io)).toBe(0)
      const { connectors, flows } = JSON.parse(stdout)
      return { connectors: connectors.map((c: { id: string; scenarios: string[] }) => [c.id, c.scenarios]), flows }
    }
    const mcp = createMcpServer({ workspaceDir: dir, http: { send: async () => ({ ok: false }) as never, cancel() {} }, auth: createAuthEngine() })
    const catalog = async () => {
      const res = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_api_catalog', arguments: {} } })) as {
        result: { content: { text: string }[] }
      }
      const data = JSON.parse(res.result.content[0]!.text)
      return { tree: data.tree, flows: data.flows }
    }
    const before = [await listJson(), await catalog()]
    await migrateWorkspace(dir)
    expect([await listJson(), await catalog()]).toEqual(before)
  })

  it('pelo CLI (--dry-run, --connector, --json -) e pelo edit_project do MCP', async () => {
    const dir = demo()
    let stdout = ''
    let stderr = ''
    const io: Io = { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env: { VVPOST_USER_DATA: join(dir, '.ud') }, cwd: dir, isTTY: false, appDir: join(dir, '.app') }
    const ws = await loadWorkspace(dir)
    const [first] = [...ws.connectors.keys()].sort()
    expect(await main(['migrate', '--dry-run', '--connector', first!, '--json', '-'], io)).toBe(0)
    const json = JSON.parse(stdout)
    expect(json).toMatchObject({ dryRun: true, ok: true, converted: [first] })
    expect(json.changes).toContainEqual({ path: `flows/${first}/${first}.flow.vvpost.json`, action: 'create' })
    expect(existsSync(join(dir, `flows/${first}`))).toBe(false)
    stdout = ''
    expect(await main(['migrate', '--connector', 'nada'], io)).toBe(0)
    expect(stdout).toContain('nada: não existe no workspace')
    expect(stderr).toBe('')

    const mcp = createMcpServer({ workspaceDir: dir, http: { cancel() {}, send: async () => Promise.reject(new Error('sem rede')) }, auth: createAuthEngine() })
    const res = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'edit_project', arguments: { ops: [{ op: 'migrateConnector', id: first }] } } })) as {
      result: { content: { text: string }[] }
    }
    const edit = JSON.parse(res.result.content[0]!.text)
    expect(edit).toMatchObject({ ok: true })
    expect(edit.review).toBeUndefined()
    expect(existsSync(join(dir, `flows/${first}/${first}.flow.vvpost.json`))).toBe(true)
  })
})
