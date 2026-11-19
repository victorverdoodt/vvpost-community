import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RemoteRun } from '@shared/ipc'
import { setControlPlaneForTests, type RemoteRunRequest } from '../src/main/enterprise/control-plane'
import { pollRemoteRun, remoteRunTarget, startRemoteRun, workspaceBundle } from '../src/main/enterprise/remote-runs'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { resolveConnector } from '@vvpost/core/connectors/resolve'

const dirs: string[] = []
afterEach(() => {
  setControlPlaneForTests(undefined)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const workspace = () => {
  const d = mkdtempSync(join(tmpdir(), 'vvpost-remote-'))
  dirs.push(d)
  return d
}
const put = (dir: string, path: string, data: unknown) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), typeof data === 'string' ? data : JSON.stringify(data))
}

const corp = { id: 'corp.base', name: 'Corp', version: '1.0.0', config: { baseUrl: '{{BASE_URL}}' } }

describe('execução remota: o workspace que vai para o runner', () => {
  it('leva conectores, fluxos e ambientes, nunca .vvpost/ nem valor de segredo, e o catálogo em shared/', async () => {
    const dir = workspace()
    put(dir, 'connectors/billing.connector.vvpost.json', { id: 'billing', name: 'Billing', version: '1.0.0', extends: 'corp.base' })
    put(dir, 'flows/a.flow.vvpost.json', { id: 'flow.a', name: 'A', nodes: [], edges: [] })
    put(dir, 'environments/dev.env.json', {
      id: 'env.dev',
      name: 'Dev',
      variables: { BASE_URL: { type: 'string', value: 'https://api' }, TOKEN: { type: 'string', value: 'vazou-se-aparecer', isSecret: true } }
    })
    put(dir, '.vvpost/secrets.local.json', { 'env.dev': { TOKEN: 'segredo-local' } })
    put(dir, '.hidden/x.connector.vvpost.json', { id: 'x', name: 'X', version: '1.0.0' })
    put(dir, 'node_modules/y/y.connector.vvpost.json', { id: 'y', name: 'Y', version: '1.0.0' })
    put(dir, 'connectors/quebrado.connector.vvpost.json', '{')
    setControlPlaneForTests({
      activity: () => {},
      catalog: async () => ({
        source: 'cp/payments',
        etag: '"1"',
        syncedAt: '',
        connectors: [
          { scope: 'org', version: 1, doc: corp },
          // Mesmo id de um arquivo local: fica o local, como no app.
          { scope: 'org', version: 1, doc: { id: 'billing', name: 'Org Billing', version: '9.0.0' } }
        ]
      })
    })

    const files = await workspaceBundle(dir)
    expect(Object.keys(files).sort()).toEqual([
      'connectors/billing.connector.vvpost.json',
      'environments/dev.env.json',
      'flows/a.flow.vvpost.json',
      'shared/corp.base.connector.vvpost.json'
    ])
    const text = JSON.stringify(files)
    expect(text).not.toContain('vazou-se-aparecer')
    expect(text).not.toContain('segredo-local')
    expect((files['environments/dev.env.json'] as { variables: Record<string, { value: string }> }).variables['TOKEN']!.value).toBe('__REQUIRED_SECRET__')
    expect((files['connectors/billing.connector.vvpost.json'] as { name: string }).name).toBe('Billing')
  })

  it('um fluxo-base local vale como o conector local de mesmo id: o do catálogo não vai junto', async () => {
    const dir = workspace()
    put(dir, 'flows/billing/billing.flow.vvpost.json', { id: 'billing', name: 'Billing', extends: 'corp.base', defaults: {}, nodes: [], edges: [] })
    setControlPlaneForTests({
      activity: () => {},
      catalog: async () => ({
        source: 'cp/payments',
        etag: '"1"',
        syncedAt: '',
        connectors: [
          { scope: 'org', version: 1, doc: corp },
          { scope: 'org', version: 1, doc: { id: 'billing', name: 'Org Billing', version: '9.0.0' } }
        ]
      })
    })
    expect(Object.keys(await workspaceBundle(dir)).sort()).toEqual(['flows/billing/billing.flow.vvpost.json', 'shared/corp.base.connector.vvpost.json'])
  })

  it('fluxos do catálogo vão como fluxos, e o runner os lê como base e endpoint', async () => {
    const dir = workspace()
    put(dir, 'flows/checkout.flow.vvpost.json', { id: 'checkout', name: 'Checkout', nodes: [] })
    const base = { id: 'org.pagamentos', name: 'Pagamentos', defaults: { baseUrl: 'https://pagamentos.exemplo.com' }, nodes: [] }
    const request = {
      id: 'org.pagamentos.cobrar',
      name: 'Cobrar',
      extends: 'org.pagamentos',
      nodes: [{ id: 'request', name: 'Request', type: 'request', request: { method: 'POST', url: '/cobrancas' } }]
    }
    setControlPlaneForTests({
      activity: () => {},
      catalog: async () => ({
        source: 'cp/payments',
        etag: '"1"',
        syncedAt: '',
        connectors: [
          { scope: 'org', version: 1, doc: base },
          { scope: 'org', version: 1, doc: request }
        ]
      })
    })
    const files = await workspaceBundle(dir)
    expect(Object.keys(files).sort()).toEqual([
      'flows/checkout.flow.vvpost.json',
      'shared/org.pagamentos.cobrar.flow.vvpost.json',
      'shared/org.pagamentos.flow.vvpost.json'
    ])
    // O que o runner grava e lê: a base vira conector, a requisição, endpoint dela.
    const runner = mkdtempSync(join(tmpdir(), 'vvpost-runner-'))
    dirs.push(runner)
    for (const [path, doc] of Object.entries(files)) put(runner, path, doc)
    setControlPlaneForTests({ activity: () => {} })
    const ws = await loadWorkspace(runner)
    expect(ws.issues).toEqual([])
    expect(ws.connectors.get('org.pagamentos')?.endpoints?.map((e) => e.id)).toEqual(['cobrar'])
  })

  it('um projeto leva o Compartilhado da raiz, e o runner vê o mesmo workspace que o app', async () => {
    const root = workspace()
    put(root, 'flows/corp/corp.flow.vvpost.json', { id: 'corp', name: 'Corp', defaults: { baseUrl: '{{BASE_URL}}' }, nodes: [] })
    put(root, 'environments/dev.env.json', {
      id: 'env.dev',
      name: 'Dev',
      variables: { BASE_URL: { type: 'string', value: 'https://raiz' }, TENANT: { type: 'string', value: 'raiz' }, TOKEN: { type: 'string', value: 'vazou-raiz', isSecret: true } }
    })
    put(root, '.vvpost/secrets.local.json', { 'env.dev': { TOKEN: 'segredo-raiz' } })
    put(root, 'pagamentos/vvpost.project.json', { id: 'pagamentos', name: 'Pagamentos' })
    put(root, 'pagamentos/flows/cobrancas/cobrancas.flow.vvpost.json', { id: 'cobrancas', name: 'Cobranças', extends: 'corp', defaults: {}, nodes: [] })
    put(root, 'pagamentos/flows/cobrancas/listar.flow.vvpost.json', {
      id: 'cobrancas.listar',
      name: 'Listar',
      extends: 'cobrancas',
      nodes: [{ id: 'request', name: 'Request', type: 'request', request: { method: 'GET', url: '/cobrancas' } }]
    })
    // Mesmo id do Compartilhado: fica o da raiz, como no app.
    put(root, 'pagamentos/flows/corp.flow.vvpost.json', { id: 'corp', name: 'Corp do projeto', defaults: {}, nodes: [] })
    put(root, 'pagamentos/environments/dev.env.json', { id: 'env.dev', name: 'Dev', variables: { TENANT: { type: 'string', value: 'pagamentos' } } })
    // Outro projeto não vai junto.
    put(root, 'estoque/vvpost.project.json', { id: 'estoque', name: 'Estoque' })
    put(root, 'estoque/flows/saldo.flow.vvpost.json', { id: 'saldo', name: 'Saldo', nodes: [] })
    setControlPlaneForTests({ activity: () => {} })

    const project = join(root, 'pagamentos')
    const files = await workspaceBundle(project)
    expect(Object.keys(files).sort()).toEqual([
      'compartilhado/flows/corp/corp.flow.vvpost.json',
      'environments/dev.env.json',
      'flows/cobrancas/cobrancas.flow.vvpost.json',
      'flows/cobrancas/listar.flow.vvpost.json'
    ])
    expect(JSON.stringify(files)).not.toMatch(/vazou-raiz|segredo-raiz/)

    const app = await loadWorkspace(project)
    const runner = mkdtempSync(join(tmpdir(), 'vvpost-runner-'))
    dirs.push(runner)
    for (const [path, doc] of Object.entries(files)) put(runner, path, doc)
    const ws = await loadWorkspace(runner)
    expect(ws.issues).toEqual([])
    expect([...ws.connectors.keys()].sort()).toEqual([...app.connectors.keys()].sort())
    expect(ws.connectors.get('cobrancas')?.endpoints?.map((e) => e.id)).toEqual(['listar'])
    const env = ws.environments.get('env.dev')!
    expect(Object.fromEntries(Object.entries(env.variables).map(([k, v]) => [k, v.value]))).toEqual({ BASE_URL: 'https://raiz', TENANT: 'pagamentos', TOKEN: '__REQUIRED_SECRET__' })

    // A raiz de um workspace com projetos não leva as pastas dos projetos.
    expect(Object.keys(await workspaceBundle(root)).sort()).toEqual(['environments/dev.env.json', 'flows/corp/corp.flow.vvpost.json'])
  })

  it('bases de outro projeto ("<projeto>:<id>") vão junto em projetos/, e o runner resolve a mesma herança', async () => {
    const root = workspace()
    put(root, 'flows/auth/auth.flow.vvpost.json', {
      id: 'auth',
      name: 'Auth corporativa',
      defaults: { headers: { Authorization: 'Bearer {{TOKEN}}' } },
      nodes: []
    })
    put(root, 'environments/dev.env.json', { id: 'env.dev', name: 'Dev', variables: { CNPJ_URL: { type: 'string', value: 'https://cnpj' } } })
    put(root, 'estoque/vvpost.project.json', { id: 'estoque', name: 'Estoque' })
    put(root, 'estoque/flows/cnpj/cnpj.flow.vvpost.json', { id: 'cnpj', name: 'CNPJ', extends: 'auth', defaults: { baseUrl: '{{CNPJ_URL}}' }, nodes: [] })
    put(root, 'estoque/flows/cnpj/consultar.flow.vvpost.json', {
      id: 'cnpj.consultar',
      name: 'Consultar',
      extends: 'cnpj',
      nodes: [{ id: 'request', name: 'Request', type: 'request', request: { method: 'GET', url: '/cnpj/{{CNPJ}}' } }],
      scenarios: [{ id: 'ok', name: 'OK', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }]
    })
    put(root, 'cadastro/vvpost.project.json', { id: 'cadastro', name: 'Cadastro' })
    put(root, 'cadastro/flows/empresas/empresas.flow.vvpost.json', { id: 'empresas', name: 'Empresas', extends: 'estoque:cnpj', defaults: { basePath: '/empresas' }, nodes: [] })
    put(root, 'cadastro/flows/validar.flow.vvpost.json', {
      id: 'validar',
      name: 'Validar',
      nodes: [{ id: 'n1', name: 'Consultar', type: 'request', request: { connector: 'estoque:cnpj', endpoint: 'consultar' } }]
    })
    setControlPlaneForTests({ activity: () => {} })

    const project = join(root, 'cadastro')
    const files = await workspaceBundle(project)
    expect(Object.keys(files).filter((p) => p.startsWith('projetos/'))).toEqual(['projetos/estoque/estoque.cnpj.connector.vvpost.json'])
    const base = files['projetos/estoque/estoque.cnpj.connector.vvpost.json'] as { extends: string; endpoints: { id: string; scenarios?: unknown }[] }
    // A cadeia segue no Compartilhado; os cenários do outro projeto não vão.
    expect(base.extends).toBe('auth')
    expect(base.endpoints.map((e) => [e.id, e.scenarios])).toEqual([['consultar', undefined]])
    expect((files['flows/empresas/empresas.flow.vvpost.json'] as { extends: string }).extends).toBe('estoque.cnpj')
    expect((files['flows/validar.flow.vvpost.json'] as { nodes: { request: { connector: string } }[] }).nodes[0]!.request.connector).toBe('estoque.cnpj')

    const app = await loadWorkspace(project)
    const runner = workspace()
    for (const [path, doc] of Object.entries(files)) put(runner, path, doc)
    const ws = await loadWorkspace(runner)
    expect(ws.issues).toEqual([])
    const there = resolveConnector('empresas', ws.connectors)
    const here = resolveConnector('empresas', app.connectors)
    expect(there.chain).toEqual(['auth', 'estoque.cnpj', 'empresas'])
    expect(here.chain).toEqual(['auth', 'estoque:cnpj', 'empresas'])
    expect({ baseUrl: there.baseUrl, basePath: there.basePath, headers: there.headers }).toEqual({ baseUrl: here.baseUrl, basePath: here.basePath, headers: here.headers })
    expect(there.baseUrl).toBe('{{CNPJ_URL}}')

    // A prévia conta o que veio de outros projetos.
    expect(Object.keys(files).filter((p) => p.startsWith('projetos/')).length).toBe(1)
  })

  it('sem módulo não há destino, e com ele o pedido leva o bundle e os filtros', async () => {
    setControlPlaneForTests({ activity: () => {} })
    expect(await remoteRunTarget()).toBeNull()
    await expect(startRemoteRun(workspace(), { environments: [], connectors: [], scenarios: [], flows: [] })).rejects.toThrow(/Control Plane configurado/)

    const dir = workspace()
    put(dir, 'connectors/a.connector.vvpost.json', { id: 'a', name: 'A', version: '1.0.0' })
    const sent: RemoteRunRequest[] = []
    const run: RemoteRun = { id: 7, project: 'payments', status: 'queued', requestedBy: 'ana', createdAt: '', finishedAt: null, cancelRequested: false, exitCode: null, error: null }
    let status: RemoteRun['status'] = 'running'
    setControlPlaneForTests({
      activity: () => {},
      runs: {
        target: async () => ({ source: 'cp/payments', signedIn: true }),
        start: async (req) => (sent.push(req), run),
        get: async () => ({ run: { ...run, status }, report: { outcome: status, scenarios: [] } }),
        events: async (_id, after) => [{ seq: after + 1, at: '', kind: 'log', data: { lines: ['ok'] } }],
        cancel: async () => run
      }
    })
    expect(await remoteRunTarget()).toEqual({ source: 'cp/payments', signedIn: true })
    expect(await startRemoteRun(dir, { environments: ['env.dev'], connectors: ['a'], scenarios: ['echo'], flows: [] })).toEqual(run)
    expect(sent[0]).toMatchObject({ environments: ['env.dev'], connectors: ['a'], scenarios: ['echo'], flows: [], files: { 'connectors/a.connector.vvpost.json': { id: 'a' } } })

    // Rodando: eventos sem relatório; no fim, o relatório vem junto.
    expect(await pollRemoteRun(7, 3)).toEqual({ run: { ...run, status: 'running' }, events: [{ seq: 4, at: '', kind: 'log', data: { lines: ['ok'] } }] })
    status = 'passed'
    expect((await pollRemoteRun(7, 4)).report).toEqual({ outcome: 'passed', scenarios: [] })
  })
})
