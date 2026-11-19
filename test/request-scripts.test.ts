import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { validateFlow, type Flow } from '@vvpost/schemas'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { loadWorkspace, type LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import { REQUEST_NODE } from '@vvpost/core/flows/request-scripts'
import { requestScriptFlow, sendWithScripts } from '@vvpost/core/flows/scripted-send'
import { runFlow } from '@vvpost/core/flows/run'
import { requestToFlow } from '@vvpost/core/flows/simple-flow'
import { createHttpDispatcher, type HttpDispatcher } from '@vvpost/core/http/dispatcher'
import { PluginManager } from '@vvpost/core/plugins/manager'
import { runScenarios } from '@vvpost/core/scenarios/run'

// Scripts por requisição (fase 13): a requisição com scripts roda como o fluxo
// script → requisição → script, no motor do Flow Studio e no runtime do plugin JavaScript.

const OFFICIAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins')
const SECRET = `segredo-${Math.random().toString(36).slice(2)}`

const seen: { url: string; headers: IncomingMessage['headers']; body: string }[] = []
let server: Server
let origin = ''
beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    for await (const chunk of req) body += chunk
    seen.push({ url: req.url ?? '', headers: req.headers, body })
    res.setHeader('content-type', 'application/json')
    if (req.url?.startsWith('/login')) return res.end(JSON.stringify({ token: 'tok-123', user: { id: 7 } }))
    if (req.url?.startsWith('/falha')) {
      res.statusCode = 500
      return res.end(JSON.stringify({ erro: 'quebrou' }))
    }
    res.end(JSON.stringify({ ok: true, auth: req.headers.authorization ?? null, assinatura: req.headers['x-assinatura'] ?? null }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())

let dir: string
let userData: string
let manager: PluginManager
let http: HttpDispatcher
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vvpost-scripts-ws-'))
  userData = mkdtempSync(join(tmpdir(), 'vvpost-scripts-ud-'))
  manager = new PluginManager({ officialDir: OFFICIAL, userDir: join(userData, 'plugins'), stateFile: join(userData, 'plugins.json'), graceMs: 200 })
  http = createHttpDispatcher()
  seen.length = 0
})
afterEach(async () => {
  await manager.shutdown()
  await http.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

function write(path: string, data: unknown): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), JSON.stringify(data, null, 2))
}

async function workspace(scripts: { connector?: object; endpoint?: object } = {}): Promise<LoadedWorkspace> {
  write('connectors/api.connector.vvpost.json', {
    id: 'api',
    name: 'API',
    version: '1.0.0',
    config: { baseUrl: '{{BASE_URL}}', ...(scripts.connector && { scripts: scripts.connector }) },
    endpoints: [
      {
        id: 'perfil',
        name: 'Perfil',
        method: 'GET',
        path: '/perfil',
        ...(scripts.endpoint && { scripts: scripts.endpoint }),
        scenarios: [{ id: 'ok', name: 'OK', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }]
      }
    ]
  })
  write('environments/dev.env.json', {
    id: 'env.dev',
    name: 'Dev',
    variables: {
      BASE_URL: { type: 'string', value: origin },
      TENANT: { type: 'string', value: 'acme' },
      API_SECRET: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
    }
  })
  write('.vvpost/secrets.local.json', { 'env.dev': { API_SECRET: SECRET } })
  return loadWorkspace(dir)
}

const input = (extra: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  method: 'GET' as const,
  url: '/perfil',
  headers: [],
  connectorId: 'api',
  environmentId: 'env.dev',
  ...extra
})

const ctx = async (ws: LoadedWorkspace) => ({ workspace: ws, auth: createAuthEngine(), http, plugins: await manager.runner() })

describe('scripts por requisição', () => {
  it('o pre muda a requisição, o post testa a resposta e define variáveis', async () => {
    const ws = await workspace()
    const result = await sendWithScripts(
      input({
        scripts: {
          pre: `
            vv.request.headers['X-Assinatura'] = 'tenant-' + vv.variables.get('TENANT')
            vv.request.query.pagina = 2
            console.log('pre rodou')`,
          post: `
            vv.test('status 200', () => vv.expect(vv.response.status).to.equal(200))
            vv.test('tem ok', () => vv.expect(vv.response.json()).to.have.property('ok', true))
            vv.test('falha de propósito', () => vv.expect(vv.response.body.ok).toBe(false))
            vv.variables.set('ultimo', vv.response.body.assinatura)`
        }
      }),
      await ctx(ws)
    )
    expect(result?.ok).toBe(true)
    if (!result?.ok) return
    expect(JSON.parse(result.response.body)).toMatchObject({ ok: true, assinatura: 'tenant-acme' })
    expect(seen[0]!.url).toBe('/perfil?pagina=2')
    expect(result.scripts!.tests.map((t) => [t.name, t.passed])).toEqual([
      ['status 200', true],
      ['tem ok', true],
      ['falha de propósito', false]
    ])
    expect(result.scripts!.tests[2]!.message).toMatch(/esperava true/)
    expect(result.scripts!.variables).toEqual({ ultimo: 'tenant-acme' })
    expect(result.scripts!.logs).toBe('[pre:request] pre rodou')
    expect(result.scripts!.ran).toEqual(['pre:request', 'post:request'])
  })

  it('segredos chegam ao script como {{NOME}} e só o host resolve no envio', async () => {
    const ws = await workspace()
    const result = await sendWithScripts(
      input({
        scripts: {
          pre: `
            const s = vv.variables.get('API_SECRET')
            console.log('segredo visto: ' + s)
            vv.request.headers.Authorization = 'Bearer ' + s`
        }
      }),
      await ctx(ws)
    )
    expect(result?.ok && JSON.parse(result.response.body).auth).toBe(`Bearer ${SECRET}`)
    expect(result!.scripts!.logs).toBe('[pre:request] segredo visto: {{API_SECRET}}')
  })

  it('scripts do conector e do endpoint rodam da raiz para a requisição, e as variáveis seguem', async () => {
    const ws = await workspace({
      connector: { pre: `vv.variables.set('ordem', 'conector')`, post: `vv.test('conector', () => {})` },
      endpoint: { pre: `vv.variables.set('ordem', vv.variables.get('ordem') + ',endpoint'); vv.request.headers['X-Assinatura'] = '{{ordem}}'` }
    })
    const result = await sendWithScripts(input({ endpointId: 'perfil' }), await ctx(ws))
    expect(result?.ok && JSON.parse(result.response.body).assinatura).toBe('conector,endpoint')
    expect(result!.scripts!.ran).toEqual(['pre:api', 'pre:endpoint', 'post:api'])
    expect(result!.scripts!.variables).toEqual({ ordem: 'conector,endpoint' })
  })

  it('um pre que lança erro não envia a requisição: SCRIPT_ERROR com a linha', async () => {
    const ws = await workspace()
    const result = await sendWithScripts(input({ scripts: { pre: `\nthrow new Error('sem token')` } }), await ctx(ws))
    expect(result?.ok).toBe(false)
    expect(!result!.ok && result!.error).toMatchObject({ code: 'SCRIPT_ERROR', message: expect.stringMatching(/pre:request.*sem token \(linha 2\)/) })
    expect(seen).toHaveLength(0)
  })

  it('um 500 ainda passa pelo post, e sem scripts devolve null', async () => {
    const ws = await workspace()
    const result = await sendWithScripts(input({ url: '/falha', scripts: { post: `vv.test('500', () => vv.expect(vv.response.code).to.be.above(499))` } }), await ctx(ws))
    expect(result?.ok && result.response.status).toBe(500)
    expect(result!.scripts!.tests[0]!.passed).toBe(true)
    expect(await sendWithScripts(input(), await ctx(ws))).toBeNull()
  })

  it('"Ver como fluxo" é um fluxo válido: script, requisição e script em fila', async () => {
    const ws = await workspace({ connector: { pre: '// a' } })
    const flow = requestScriptFlow(input({ scripts: { post: '// b' } }), ws)
    expect(validateFlow(flow).ok).toBe(true)
    expect(flow.nodes.map((n) => n.name)).toEqual(['Pre_api', REQUEST_NODE, 'Post_request'])
    expect(flow.edges).toEqual([
      { from: flow.nodes[0]!.id, to: 'request' },
      { from: 'request', to: flow.nodes[2]!.id }
    ])
    // E roda como qualquer fluxo do Flow Studio.
    const report = await runFlow({ runId: 'r', flow, environmentId: 'env.dev' }, await ctx(ws))
    expect(report.results.map((r) => r.status)).toEqual(['success', 'success', 'success'])
  })

  it('num fluxo, o nó de requisição de um endpoint com scripts roda os scripts e falha num teste', async () => {
    const ws = await workspace({ endpoint: { post: `vv.test('nunca', () => { throw new Error('não') })` } })
    const flow: Flow = { id: 'f', name: 'F', nodes: [{ id: 'a', name: 'A', type: 'request', request: { connector: 'api', endpoint: 'perfil' } }] }
    const report = await runFlow({ runId: 'r', flow, environmentId: 'env.dev' }, await ctx(ws))
    expect(report.results[0]).toMatchObject({ status: 'error', error: { code: 'ASSERTION_FAILED', message: 'teste "nunca": não' }, tests: [{ name: 'nunca', passed: false }] })
  })

  it('a requisição salva como fluxo de um nó roda os scripts na mesma ordem do Quick Request', async () => {
    const ws = await workspace({
      connector: { pre: `vv.variables.set('ordem', 'conector')` },
      endpoint: { pre: `vv.variables.set('ordem', vv.variables.get('ordem') + ',endpoint')` }
    })
    const flow = requestToFlow(
      {
        method: 'GET',
        url: '/perfil',
        headers: [],
        connector: 'api',
        endpoint: 'perfil',
        scripts: {
          pre: `vv.request.headers['X-Assinatura'] = vv.variables.get('ordem') + ',request'`,
          post: `vv.test('post da requisição', () => {})`
        }
      },
      { id: 'flow.perfil', name: 'Perfil' }
    )
    expect(validateFlow(flow).ok).toBe(true)
    const report = await runFlow({ runId: 'r', flow, environmentId: 'env.dev' }, await ctx(ws))
    expect(report.results[0]).toMatchObject({ status: 'success', tests: [{ name: 'post da requisição', passed: true }] })
    expect(seen.at(-1)!.headers['x-assinatura']).toBe('conector,endpoint,request')
  })

  it('nos cenários, os testes entram como asserções', async () => {
    const ws = await workspace({ endpoint: { post: `vv.test('tem ok', () => vv.expect(vv.response.body.ok).to.be.true)` } })
    const report = await runScenarios(
      { runId: 's', connectorId: 'api', environmentIds: ['env.dev'] },
      { workspace: ws, auth: createAuthEngine(), http, plugins: () => manager.runner() }
    )
    expect(report.results[0]).toMatchObject({ outcome: 'passed' })
    expect(report.results[0]!.assertions.map((a) => a.target)).toEqual(['status', 'test: tem ok'])
  })
})
