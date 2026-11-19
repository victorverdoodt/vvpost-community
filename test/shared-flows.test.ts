import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { resolveConnector } from '@vvpost/core/connectors/resolve'
import { summarizeWorkspace } from '@vvpost/core/connectors/summary'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { runFlow } from '@vvpost/core/flows/run'
import { loadFlows } from '@vvpost/core/flows/workspace'
import { createHttpDispatcher, type HttpDispatcher } from '@vvpost/core/http/dispatcher'
import { readCatalogFile } from '../src/main/cli/catalog'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function workspace(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-shared-flows-'))
  dirs.push(dir)
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
  }
  return dir
}

const request = (id: string, extendsId: string, url: string, name = id) => ({
  id,
  name,
  extends: extendsId,
  nodes: [{ id: 'request', name: 'Request', type: 'request', request: { method: 'GET', url } }]
})

/** A auth corporativa publicada no catálogo como fluxo-base, com uma requisição de exemplo. */
const catalog = (authUrl: string) => [
  {
    source: 'cp.exemplo.com/org@org:4',
    doc: {
      id: 'corp.auth',
      name: 'Auth corporativa',
      version: '2.0.0',
      defaults: { baseUrl: authUrl, headers: { Authorization: 'Bearer {{ $nodes.Login.data.access_token }}' } },
      nodes: [
        {
          id: 'login',
          name: 'Login',
          type: 'request',
          cache: { expiresIn: 'data.expires_in' },
          request: { method: 'POST', url: `${authUrl}/oauth/token`, body: { client_secret: '{{CLIENT_SECRET}}' } }
        }
      ]
    }
  },
  { source: 'cp.exemplo.com/org@org:4', doc: request('corp.auth.whoami', 'corp.auth', '/me', 'Quem sou eu') }
]

const env = (url: string) => ({
  'environments/dev.env.json': {
    id: 'dev',
    name: 'Dev',
    variables: { API_URL: { type: 'string', value: url }, CLIENT_SECRET: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true } }
  },
  '.vvpost/secrets.local.json': { dev: { CLIENT_SECRET: 's3cr3t' } }
})

describe('fluxos-base no catálogo compartilhado', () => {
  it('a base do catálogo vira conector compartilhado, com a requisição dela, e o workspace herda', async () => {
    const dir = workspace({
      ...env('https://api.exemplo.com'),
      'flows/empresas.flow.vvpost.json': { id: 'empresas', name: 'Empresas', extends: 'corp.auth', defaults: { baseUrl: '{{API_URL}}' }, nodes: [] },
      'flows/empresas.consultar.flow.vvpost.json': request('empresas.consultar', 'empresas', '/empresas/1')
    })
    const ws = await loadWorkspace(dir, { shared: catalog('https://sso.exemplo.com') })
    expect(ws.issues).toEqual([])
    expect(ws.shared?.get('corp.auth')).toBe('cp.exemplo.com/org@org:4')
    expect(ws.connectorFiles.get('corp.auth')).toBe('shared:cp.exemplo.com/org@org:4')
    const auth = resolveConnector('corp.auth', ws.connectors)
    expect(auth.auth?.config).toMatchObject({ type: 'login', request: { url: 'https://sso.exemplo.com/oauth/token' } })
    expect(auth.endpoints.map((e) => e.id)).toEqual(['whoami'])
    expect(resolveConnector('empresas', ws.connectors).chain).toEqual(['corp.auth', 'empresas'])
    const summary = summarizeWorkspace(ws)
    expect(summary.connectors.find((c) => c.id === 'corp.auth')?.shared).toBe('cp.exemplo.com/org@org:4')
    // Só o do workspace conta para "Converter"; o do catálogo não é do projeto.
    expect(summary.legacy).toBeUndefined()
  })

  it('fluxo inválido, com credencial literal ou de id repetido fica de fora, e o resto segue', async () => {
    const dir = workspace({ 'flows/corp.auth.flow.vvpost.json': { id: 'corp.auth', name: 'Imitação', defaults: { baseUrl: 'https://outra.exemplo.com' }, nodes: [] } })
    const ws = await loadWorkspace(dir, {
      shared: [
        ...catalog('https://sso.exemplo.com'),
        { source: 'cp', doc: { id: 'quebrado', name: 'Quebrado', nodes: [{ id: 'x' }] } },
        {
          source: 'cp',
          doc: { id: 'vazado', name: 'Vazado', defaults: { headers: { Authorization: 'Bearer abc123literal' } }, nodes: [] }
        }
      ]
    })
    expect(ws.connectors.has('quebrado')).toBe(false)
    expect(ws.connectors.has('vazado')).toBe(false)
    expect(ws.issues.map((i) => i.message).join('\n')).toMatch(/"vazado" tem credencial literal/)
    expect(ws.issues.some((i) => i.file === 'shared:cp' && i.message.startsWith('/nodes'))).toBe(true)
    // A base local com o id da organização não troca a dela.
    expect(ws.shared?.get('corp.auth')).toBe('cp.exemplo.com/org@org:4')
    expect(ws.issues.some((i) => i.file === 'flows/corp.auth.flow.vvpost.json')).toBe(true)
  })

  it('o --catalog do CLI aceita a resposta do Control Plane com fluxos', async () => {
    const dir = workspace({
      'catalogo.json': {
        source: 'cp.exemplo.com',
        connectors: catalog('https://sso.exemplo.com').map((c, i) => ({ scope: 'org', version: 4 + i, doc: c.doc }))
      }
    })
    const shared = await readCatalogFile(join(dir, 'catalogo.json'))
    expect(shared.map((s) => s.source)).toEqual(['cp.exemplo.com@org:4', 'cp.exemplo.com@org:5'])
    const ws = await loadWorkspace(dir, { shared })
    expect(resolveConnector('corp.auth', ws.connectors).endpoints).toHaveLength(1)
  })
})

describe('execução com a base do catálogo', () => {
  let server: Server
  let http: HttpDispatcher
  let logins = 0
  const seen: { path: string; auth?: string }[] = []
  let origin = ''
  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      seen.push({ path, ...(req.headers.authorization && { auth: req.headers.authorization }) })
      res.setHeader('content-type', 'application/json')
      if (path === '/oauth/token') {
        logins++
        return res.end('{"access_token":"tok-corp","expires_in":3600}')
      }
      res.end(JSON.stringify({ path }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    http = createHttpDispatcher()
  })
  afterAll(async () => {
    await http.close()
    server.close()
  })

  it('duas APIs do workspace herdam o login publicado e fazem um login só', async () => {
    const dir = workspace({
      ...env(origin),
      'flows/empresas.flow.vvpost.json': { id: 'empresas', name: 'Empresas', extends: 'corp.auth', defaults: { baseUrl: '{{API_URL}}', basePath: '/empresas' }, nodes: [] },
      'flows/estoques.flow.vvpost.json': { id: 'estoques', name: 'Estoques', extends: 'corp.auth', defaults: { baseUrl: '{{API_URL}}', basePath: '/estoques' }, nodes: [] },
      'flows/empresas.consultar.flow.vvpost.json': request('empresas.consultar', 'empresas', '/1'),
      'flows/estoques.consultar.flow.vvpost.json': request('estoques.consultar', 'estoques', '/2')
    })
    const ws = await loadWorkspace(dir, { shared: catalog(origin) })
    const flows = (await loadFlows(dir)).flows
    const engine = createAuthEngine()
    for (const id of ['empresas.consultar', 'estoques.consultar']) {
      const flow = flows.find((f) => f.flow.id === id)!.flow
      const report = await runFlow({ runId: id, flow, environmentId: 'dev' }, { workspace: ws, auth: engine, http })
      expect(report.outcome).toBe('success')
    }
    expect(logins).toBe(1)
    expect(seen).toEqual([
      { path: '/oauth/token' },
      { path: '/empresas/1', auth: 'Bearer tok-corp' },
      { path: '/estoques/2', auth: 'Bearer tok-corp' }
    ])
  })
})
