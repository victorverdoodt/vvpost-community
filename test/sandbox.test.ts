import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Flow, FlowNode } from '@vvpost/schemas'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { runPython } from '@vvpost/core/flows/python'
import { runFlow } from '@vvpost/core/flows/run'
import { createHttpDispatcher, type HttpDispatcher } from '@vvpost/core/http/dispatcher'
import { PluginManager } from '@vvpost/core/plugins/manager'
import { callNetworkRules, describeNetworkRules, hostsOf, matchesNetworkRule, networkAllows } from '@vvpost/core/sandbox/network-rules'
import { netnsAvailable } from '@vvpost/core/sandbox/os'

const OFFICIAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins')

describe('regras de rede', () => {
  it('host exato, curinga de subdomínio, porta e IPv6', () => {
    expect(matchesNetworkRule('api.example.com', 'API.example.com.', 443)).toBe(true)
    expect(matchesNetworkRule('api.example.com', 'evil.com', 443)).toBe(false)
    expect(matchesNetworkRule('*.example.com', 'a.b.example.com', 1)).toBe(true)
    expect(matchesNetworkRule('*.example.com', 'example.com', 1)).toBe(false)
    expect(matchesNetworkRule('*.example.com', 'badexample.com', 1)).toBe(false)
    expect(matchesNetworkRule('broker:9092', 'broker', 9092)).toBe(true)
    expect(matchesNetworkRule('broker:9092', 'broker', 9093)).toBe(false)
    // Sem porta (consulta DNS), só o host é conferido.
    expect(matchesNetworkRule('broker:9092', 'broker', undefined)).toBe(true)
    expect(matchesNetworkRule('[::1]:8080', '::1', 8080)).toBe(true)
    expect(matchesNetworkRule('[::1]', '[::1]', 1)).toBe(true)
    expect(matchesNetworkRule('*', 'qualquer', 1)).toBe(true)
    expect(networkAllows(['a', 'b:1'], 'b', 1)).toBe(true)
  })

  it('connector e config:<campo> viram os hosts da chamada', () => {
    expect(hostsOf('b1:9092, b2:9092\nkafka://b3:9094 {{BROKERS}}')).toEqual(['b1', 'b2', 'b3'])
    expect(callNetworkRules(['connector', 'config:brokers', 'fixo.com'], { brokers: 'x:1,y:2' }, 'grpcs://API.acme.com:443/v1')).toEqual([
      'api.acme.com',
      'x',
      'y'
    ])
    expect(callNetworkRules(['connector'], {}, undefined)).toEqual([])
    expect(callNetworkRules(['connector'], {}, 'http://[::1]:50051')).toEqual(['[::1]'])
    expect(describeNetworkRules(['connector', 'config:brokers', 'x.com'], () => 'Brokers')).toEqual([
      'o host do conector do nó',
      'os hosts do campo "Brokers"',
      'x.com'
    ])
    expect(describeNetworkRules(['x', '*'])).toEqual(['qualquer host (rede sem restrição)'])
    expect(describeNetworkRules([])).toEqual([])
  })
})

let server: Server
let port: number
let http: HttpDispatcher
let hits = 0
beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++
    res.setHeader('content-type', 'application/json')
    res.end('{"ok":true}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  http = createHttpDispatcher()
})
afterAll(async () => {
  await http.close()
  server.close()
})

let ws: string
let userData: string
let manager: PluginManager
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'vvpost-sandbox-ws-'))
  userData = mkdtempSync(join(tmpdir(), 'vvpost-sandbox-ud-'))
  manager = new PluginManager({
    officialDir: OFFICIAL,
    userDir: join(userData, 'plugins'),
    stateFile: join(userData, 'plugins.json'),
    graceMs: 200
  })
  hits = 0
})
afterEach(async () => {
  await manager.shutdown()
  rmSync(ws, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

function write(root: string, path: string, data: unknown): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}

/**
 * Plugin de teste: o nó probe.run roda o código de config.code com require e ctx no
 * escopo (é o próprio plugin quem roda, então vale o que o processo dele pode).
 */
function installProbe(network?: string[]): void {
  const dir = join(userData, 'plugins', 'probe')
  write(dir, 'vvpost-plugin.json', {
    id: 'probe',
    name: 'Probe',
    version: '1.0.0',
    main: 'index.js',
    apiVersion: 1,
    ...(network && { permissions: { network } }),
    contributes: {
      nodes: [{ type: 'probe.run', title: 'Run', fields: [{ key: 'code', label: 'Código', type: 'code', templates: false }, { key: 'hosts', label: 'Hosts', type: 'text' }] }],
      adapters: [{ protocol: 'probe', title: 'Probe', fields: [{ key: 'code', label: 'Código', type: 'code', templates: false }] }]
    }
  })
  write(
    dir,
    'index.js',
    `const AsyncFunction = (async () => {}).constructor
const run = (ctx) => new AsyncFunction('ctx', 'require', ctx.config.code)(ctx, require)
module.exports = { nodes: { 'probe.run': { run } }, adapters: { probe: { async send(ctx) { return { data: await run(ctx) } } } } }`
  )
}

/** Código que tenta uma operação e devolve o code do erro (ou 'ok'). */
const attempt = (body: string) => `try { ${body}; return 'ok' } catch (e) { return e.code || e.message }`
const connect = (host: string, p = port) =>
  `return await new Promise((resolve) => { const s = require('node:net').connect(${p}, ${JSON.stringify(host)}); s.on('connect', () => { s.destroy(); resolve('ok') }); s.on('error', (e) => resolve(e.code)) })`

async function probe(code: string, extra: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  write(ws, 'connectors/api.connector.vvpost.json', { id: 'api.v1', name: 'API', version: '1.0.0', config: { baseUrl: '{{BASE_URL}}' } })
  write(ws, 'environments/dev.env.json', { id: 'env.dev', name: 'Dev', variables: { BASE_URL: { type: 'string', value: `http://127.0.0.1:${port}` } } })
  write(ws, '.vvpost/secrets.local.json', { 'env.dev': {} })
  const node = { id: 'a', name: 'P', type: 'plugin', plugin: { node: 'probe.run', config: { code, ...config }, ...extra } } as FlowNode
  const flow: Flow = { id: 'flow.p', name: 'P', nodes: [node] }
  const report = await runFlow(
    { runId: 'r', flow, environmentId: 'env.dev' },
    { workspace: await loadWorkspace(ws), auth: createAuthEngine(), http, plugins: await manager.runner() }
  )
  const result = report.results[0]!
  if (result.error) throw new Error(`${result.error.code}: ${result.error.message}`)
  return (result.output as { data: unknown }).data
}

describe('processo do plugin: permissões do Node', () => {
  it('lê só a própria pasta: os segredos do workspace, subprocessos e workers ficam fora', async () => {
    installProbe()
    write(ws, 'segredo.txt', 'abc')
    const secret = join(ws, 'segredo.txt')
    expect(await probe(attempt(`require('node:fs').readFileSync(${JSON.stringify(secret)})`))).toBe('ERR_ACCESS_DENIED')
    expect(await probe(attempt(`require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(userData)}, 'x'), '1')`))).toBe('ERR_ACCESS_DENIED')
    expect(await probe(attempt(`require('node:child_process').execSync('echo oi')`))).toBe('ERR_ACCESS_DENIED')
    expect(await probe(attempt(`new (require('node:worker_threads').Worker)('1', { eval: true })`))).toBe('ERR_ACCESS_DENIED')
    expect(await probe(attempt(`process.binding('tcp_wrap')`))).toBe('ERR_ACCESS_DENIED')
    // A própria pasta continua legível (o main, dependências em node_modules).
    expect(await probe("return require('node:fs').readFileSync(require.resolve('./index.js'), 'utf8').length > 0")).toBe(true)
  })
})

describe('processo do plugin: rede', () => {
  it('sem permissions.network, não conecta nem resolve nomes; ctx.http segue pelo host', async () => {
    installProbe()
    expect(await probe(connect('127.0.0.1'))).toBe('POLICY_DENIED')
    expect(await probe(attempt(`await require('node:dns').promises.lookup('localhost')`))).toBe('POLICY_DENIED')
    expect(await probe(attempt(`await require('node:dns/promises').resolve4('example.com')`))).toBe('POLICY_DENIED')
    expect(await probe(`try { await fetch('http://127.0.0.1:${port}/') } catch (e) { return e.cause && e.cause.code } return 'ok'`)).toBe('POLICY_DENIED')
    expect(await probe(attempt(`require('node:dgram').createSocket('udp4').send('x', 53, '127.0.0.1')`))).toBe('POLICY_DENIED')
    expect(
      await probe(`return await new Promise((resolve) => { const s = require('node:net').createServer(); s.on('error', (e) => resolve(e.code)); s.listen(0, () => resolve('ok')) })`)
    ).toBe('POLICY_DENIED')
    expect(await probe(attempt(`Object.defineProperty(require('node:net').Socket.prototype, 'connect', { value: () => 1 })`))).toMatch(/Cannot redefine/)
    expect(hits).toBe(0)
    expect(await probe(`return (await ctx.http.send({ url: '{{BASE_URL}}/x' })).status`, {})).toBe(200)
    expect(hits).toBe(1)
  })

  it('no Linux com user namespaces, o processo sem rede declarada roda num namespace de rede vazio', async () => {
    installProbe()
    await probe('return 1')
    const { plugins, sandbox } = await manager.catalog()
    expect(sandbox.kernelNetwork).toBe(await netnsAvailable())
    expect(plugins.find((p) => p.id === 'probe')?.permissions).toEqual({ network: [], connectorCredentials: false, summary: [] })
  })

  it('com hosts declarados, só eles: o nome conta, e o IP tem de ter vindo de uma consulta permitida', async () => {
    installProbe(['127.0.0.1'])
    expect(await probe(connect('127.0.0.1'))).toBe('ok')
    expect(await probe(connect('localhost'))).toBe('POLICY_DENIED')
    expect(await probe(`return (await fetch('http://127.0.0.1:${port}/')).status`)).toBe(200)
    // Mesmo pegando a classe do handle nativo, um IP fora das regras é recusado (UV_EACCES).
    expect(
      await probe(`return await new Promise((resolve) => {
        const s = require('node:net').connect(${port}, '127.0.0.1')
        s.on('connect', () => { const TCP = s._handle.constructor; s.destroy(); resolve(new TCP(0).connect({}, '10.255.255.1', 80)) })
        s.on('error', (e) => resolve(e.code))
      })`)
    ).toBe(-13)
  })

  it('"connector" libera o host da baseUrl do conector do nó, e "config:<campo>" os hosts do campo', async () => {
    installProbe(['connector', 'config:hosts'])
    const viaConnector = async (code: string) => {
      write(ws, 'connectors/api.connector.vvpost.json', { id: 'api.v1', name: 'API', version: '1.0.0', config: { baseUrl: '{{BASE_URL}}' } })
      write(ws, 'environments/dev.env.json', { id: 'env.dev', name: 'Dev', variables: { BASE_URL: { type: 'string', value: `http://127.0.0.1:${port}` } } })
      write(ws, '.vvpost/secrets.local.json', { 'env.dev': {} })
      const node = { id: 'a', name: 'P', type: 'plugin', plugin: { adapter: 'probe', connector: 'api.v1', config: { code } } } as FlowNode
      const report = await runFlow(
        { runId: 'r', flow: { id: 'f', name: 'F', nodes: [node] }, environmentId: 'env.dev' },
        { workspace: await loadWorkspace(ws), auth: createAuthEngine(), http, plugins: await manager.runner() }
      )
      return (report.results[0]!.output as { data: unknown }).data
    }
    expect(await viaConnector(connect('127.0.0.1'))).toBe('ok')
    // Sem conector no nó, "connector" não libera nada.
    expect(await probe(connect('127.0.0.1'))).toBe('POLICY_DENIED')
    expect(await probe(connect('localhost'), {}, { hosts: 'localhost:1, outro' })).toBe('ok')
    const { plugins } = await manager.catalog()
    expect(plugins.find((p) => p.id === 'probe')?.permissions.summary).toEqual(['o host do conector do nó', 'os hosts do campo "Hosts"'])
  })

  it('"*" deixa a rede livre', async () => {
    installProbe(['*'])
    expect(await probe(connect('localhost'))).toBe('ok')
    // O resto das permissões do Node continua valendo.
    expect(await probe(attempt(`require('node:child_process').execSync('echo oi')`))).toBe('ERR_ACCESS_DENIED')
  })

  it('mudar as permissões no manifesto reinicia o processo do plugin', async () => {
    installProbe()
    expect(await probe(connect('127.0.0.1'))).toBe('POLICY_DENIED')
    installProbe(['127.0.0.1'])
    expect(await probe(connect('127.0.0.1'))).toBe('ok')
  })
})

describe('nó Python: rede', () => {
  const get = (host: string) =>
    `import urllib.request\ntry:\n    output = urllib.request.urlopen('http://${host}:${port}/', timeout=5).status\nexcept Exception as e:\n    output = '%s: %s' % (type(e).__name__, e)`

  it('sem network, o script não tem rede', async () => {
    const out = await runPython(get('127.0.0.1'), {})
    expect(out).toMatchObject({ ok: true })
    expect(String((out as { output: unknown }).output)).toMatch(/\[VVPost\] o host 127\.0\.0\.1 não está liberado/)
    expect(hits).toBe(0)
  })

  it('com network, só os hosts listados; subprocessos e ctypes ficam bloqueados', async () => {
    expect(await runPython(get('127.0.0.1'), {}, { network: ['127.0.0.1'] })).toMatchObject({ ok: true, output: 200 })
    const other = await runPython(get('localhost'), {}, { network: ['127.0.0.1'] })
    expect(String((other as { output: unknown }).output)).toMatch(/\[VVPost\] o host localhost não está liberado/)
    expect(await runPython("import subprocess\nsubprocess.run(['echo', 'oi'])", {}, { network: ['127.0.0.1'] })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^PermissionError: \[VVPost\] subprocess.Popen está bloqueado/)
    })
    expect(await runPython('import ctypes', {}, { network: ['127.0.0.1'] })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^PermissionError: \[VVPost\] o módulo ctypes está bloqueado/)
    })
    expect(hits).toBe(1)
  })

  it('"*" devolve o acesso de rede do usuário', async () => {
    expect(await runPython(get('localhost'), {}, { network: ['*'] })).toMatchObject({ ok: true, output: 200 })
    expect(await runPython("import subprocess, sys\noutput = subprocess.run([sys.executable, '-c', 'pass']).returncode", {}, { network: ['*'] })).toMatchObject({ ok: true, output: 0 })
  })
})
