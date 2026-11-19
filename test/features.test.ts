import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Flow } from '@vvpost/schemas'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { sendWithScripts } from '@vvpost/core/flows/scripted-send'
import { runFlow } from '@vvpost/core/flows/run'
import { createHttpDispatcher } from '@vvpost/core/http/dispatcher'
import { startMockServer } from '@vvpost/core/mock'
import { PluginManager } from '@vvpost/core/plugins/manager'
import { assertFeature, DISABLE_FEATURES_ENV, disabledFeatures, FEATURE_IDS, FeatureDisabledError, featureDenial, setFeaturePolicy } from '@vvpost/core/policy/features'
import { openRealtime } from '@vvpost/core/realtime'
import type { FeaturePolicySession, FeaturePolicyState } from '../src/main/enterprise/control-plane'
import { applyFeaturePolicy, featurePolicyOf, openFeaturePolicy } from '../src/main/enterprise/features'
import { createMcpServer, type JsonRpcResponse } from '../src/main/mcp/server'
import { EnterpriseModuleMissingError, type EnterpriseSecretsModule } from '../src/main/secret-engine/backend'
import { startSecretEngine } from '../src/main/secret-engine/server'
import { startWebhookServer } from '../src/main/webhooks/server'

const OFFICIAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins')

let dir: string
let userData: string

function write(path: string, data: unknown): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}

/** Política central falsa: o que a organização desligou agora. */
function central(disabled: string[], source = 'política da organização (cp.test/org)') {
  setFeaturePolicy(() => ({ disabled, source }))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vvpost-features-ws-'))
  userData = mkdtempSync(join(tmpdir(), 'vvpost-features-ud-'))
  write('environments/dev.env.json', { id: 'dev', name: 'Dev', variables: { BASE_URL: { type: 'string', value: 'http://127.0.0.1:9' } } })
})
afterEach(() => {
  setFeaturePolicy(null)
  delete process.env[DISABLE_FEATURES_ENV]
  rmSync(dir, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

describe('lista de recursos desligados', () => {
  it('sem política nem variável, nada está desligado', () => {
    expect(disabledFeatures()).toEqual([])
    expect(() => assertFeature('pythonNode')).not.toThrow()
  })

  it('a variável e a política central só somam; a política aparece como origem', () => {
    process.env[DISABLE_FEATURES_ENV] = 'mcp, plugins, desconhecido'
    central(['plugins', 'pythonNode'])
    expect(disabledFeatures().map((f) => [f.id, f.source])).toEqual([
      ['pythonNode', 'política da organização (cp.test/org)'],
      ['plugins', 'política da organização (cp.test/org)'],
      ['mcp', DISABLE_FEATURES_ENV]
    ])
    expect(featureDenial('mcp')).toBe(`Servidor MCP para agentes de IA: desligado pela variável ${DISABLE_FEATURES_ENV}`)
    expect(() => assertFeature('pythonNode')).toThrow(FeatureDisabledError)
    try {
      assertFeature('plugins')
    } catch (err) {
      expect((err as FeatureDisabledError).code).toBe('POLICY_DENIED')
      expect((err as Error).message).toBe('Plugins instalados pelo usuário: desligado pela política da organização (cp.test/org)')
    }
  })
})

describe('o core recusa o recurso desligado', () => {
  it('nó Python: POLICY_DENIED apontando o código, sem rodar o Python', async () => {
    central(['pythonNode'])
    const flow: Flow = {
      id: 'flow.py',
      name: 'Py',
      nodes: [{ id: 'n1', name: 'Calc', type: 'python', python: { code: 'output = 1' } }],
      edges: []
    } as unknown as Flow
    const report = await runFlow({ runId: 'r1', flow }, { workspace: await loadWorkspace(dir), auth: createAuthEngine(), http: createHttpDispatcher() })
    const node = report.results.find((r) => r.nodeId === 'n1')!
    expect(node.status).toBe('error')
    expect(node.error).toMatchObject({ code: 'POLICY_DENIED', property: 'python.code' })
    expect(node.error!.message).toMatch(/Nó Python do Flow Studio: desligado pela política da organização/)
  })

  it('scripts: a requisição com script não sai', async () => {
    central(['scripts'])
    const http = createHttpDispatcher()
    const result = await sendWithScripts(
      { id: 'q1', method: 'GET', url: 'http://127.0.0.1:9/x', headers: [], scripts: { pre: 'vv.request.headers.A = 1' } },
      { workspace: await loadWorkspace(dir), auth: createAuthEngine(), http }
    )
    await http.close()
    expect(result).toMatchObject({ ok: false, error: { code: 'POLICY_DENIED' } })
  })

  it('servidor mock, webhooks, emulador de cofres e realtime não ligam', async () => {
    central(['mockServer', 'webhooks', 'secretEmulator', 'protocols'])
    await expect(startMockServer({ port: 0, routes: async () => [] })).rejects.toThrow(/Servidor mock: desligado/)
    await expect(startWebhookServer(dir, { port: 0, workspace: () => loadWorkspace(dir) })).rejects.toThrow(/Servidor local de webhooks: desligado/)
    await expect(startSecretEngine(dir, { port: 0 })).rejects.toThrow(/Emulador local de cofres/)
    expect(() =>
      openRealtime({ id: 'c1', protocol: 'websocket', url: 'ws://127.0.0.1:9', headers: [] }, { workspace: { connectors: [], environments: [] } as never, auth: createAuthEngine(), http: createHttpDispatcher() }, () => {})
    ).toThrow(/Protocolos além do HTTP/)
  })

  it('MCP: as ferramentas respondem POLICY_DENIED', async () => {
    central(['mcp'])
    const http = createHttpDispatcher()
    const server = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine() })
    const reply = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_api_catalog', arguments: {} } })) as JsonRpcResponse
    await http.close()
    const result = reply.result as { content: { text: string }[]; isError: boolean }
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ code: 'POLICY_DENIED', error: expect.stringMatching(/Servidor MCP/) })
  })

  it('plugins: os do usuário não rodam nem instalam; adapters seguem protocolos e o JavaScript segue scripts', async () => {
    const pluginDir = join(userData, 'fonte')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(
      join(pluginDir, 'vvpost-plugin.json'),
      JSON.stringify({ id: 'acme-hello', name: 'Hello', version: '1.0.0', main: 'index.js', apiVersion: 1, contributes: { nodes: [{ type: 'acme.hello', title: 'Hello' }] } })
    )
    writeFileSync(join(pluginDir, 'index.js'), 'module.exports = { nodes: { "acme.hello": async () => ({ ok: true }) } }\n')
    const manager = new PluginManager({ officialDir: OFFICIAL, userDir: join(userData, 'plugins'), stateFile: join(userData, 'plugins.json'), graceMs: 200 })
    try {
      const preview = await manager.previewInstall(pluginDir)
      await manager.install(preview.id)

      central(['plugins'])
      await expect(manager.previewInstall(pluginDir)).rejects.toThrow(/Plugins instalados pelo usuário: desligado/)
      let runner = await manager.runner()
      expect(runner.find('node', 'acme.hello')).toEqual({ denied: expect.stringMatching(/Plugins instalados pelo usuário/) })
      // Os oficiais continuam.
      expect(runner.find('adapter', 'graphql')).toMatchObject({ pluginId: 'vvpost-plugin-graphql' })
      expect((await manager.catalog()).plugins.find((p) => p.id === 'acme-hello')?.error).toMatch(/desligado pela política/)

      central(['protocols', 'scripts'])
      runner = await manager.runner()
      expect(runner.find('node', 'acme.hello')).toMatchObject({ pluginId: 'acme-hello' })
      expect(runner.find('adapter', 'graphql')).toEqual({ denied: expect.stringMatching(/Protocolos além do HTTP/) })
      expect(runner.find('node', 'javascript.request-script')).toEqual({ denied: expect.stringMatching(/Scripts por requisição/) })
    } finally {
      await manager.shutdown()
    }
  })
})

describe('sessão do módulo Enterprise', () => {
  const module = (features?: { open: () => Promise<FeaturePolicySession | null> }, organization = true): EnterpriseSecretsModule =>
    ({
      apiVersion: 1,
      createBackend: async () => {
        throw new Error('não usado')
      },
      audit: async () => {},
      controlPlane: { activity: () => {}, ...(features && { features }) },
      ...(organization && { organization: { use: () => {}, register: async () => ({ name: 'x', controlPlane: 'https://cp.test' }) } })
    }) as unknown as EnterpriseSecretsModule
  const session = (state: FeaturePolicyState): FeaturePolicySession => ({ state: () => state, ready: async () => state, close: async () => {} })
  const declared = { controlPlane: 'https://cp.test' }

  it('o estado vira o que o core aplica: ativo, cópia em disco e indisponível', () => {
    expect(featurePolicyOf({ status: 'none' })).toBeNull()
    expect(featurePolicyOf({ status: 'active', disabled: ['mcp'], source: 'cp.test/org', fetchedAt: '2026-10-26T12:00:00Z' })).toEqual({
      disabled: ['mcp'],
      source: 'política da organização (cp.test/org)'
    })
    expect(featurePolicyOf({ status: 'active', disabled: [], source: 'cp.test/org', fetchedAt: '2026-10-26T12:00:00Z', cached: true })!.source).toBe(
      'política da organização (cp.test/org, cópia de 2026-10-26 12:00)'
    )
    expect(featurePolicyOf({ status: 'unavailable', reason: 'sem login' })).toEqual({ disabled: FEATURE_IDS, source: 'política da organização, indisponível (sem login)' })
  })

  it('aplica a sessão do módulo e acompanha a mudança de estado', async () => {
    let state: FeaturePolicyState = { status: 'active', disabled: ['webhooks'], source: 'cp.test/org', fetchedAt: new Date().toISOString() }
    const s: FeaturePolicySession = { state: () => state, ready: async () => state, close: async () => {} }
    applyFeaturePolicy(await openFeaturePolicy({ surface: 'cli' }, async () => module({ open: async () => s })))
    expect(disabledFeatures().map((f) => f.id)).toEqual(['webhooks'])
    state = { status: 'active', disabled: [], source: 'cp.test/org', fetchedAt: new Date().toISOString() }
    expect(disabledFeatures()).toEqual([])
  })

  it('sem módulo: nada muda sem organização declarada; com ela, tudo desligado', async () => {
    const missing = async () => {
      throw new EnterpriseModuleMissingError()
    }
    expect(await openFeaturePolicy({ surface: 'cli' }, missing)).toBeNull()
    const restricted = await openFeaturePolicy({ surface: 'cli' }, missing, declared)
    expect(restricted!.state()).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/módulo VVPost Enterprise não está instalado/) })
    applyFeaturePolicy(restricted)
    expect(disabledFeatures().map((f) => f.id)).toEqual(FEATURE_IDS)
  })

  it('módulo anterior aos recursos desligados: restrito só com a organização declarada', async () => {
    expect(await openFeaturePolicy({ surface: 'app' }, async () => module())).toBeNull()
    expect((await openFeaturePolicy({ surface: 'app' }, async () => module(), declared))!.state()).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/atualize-o/) })
    expect((await openFeaturePolicy({ surface: 'app' }, async () => module({ open: async () => null }), declared))!.state()).toMatchObject({ status: 'unavailable' })
    expect(await openFeaturePolicy({ surface: 'app' }, async () => module({ open: async () => session({ status: 'none' }) }))).not.toBeNull()
  })
})
