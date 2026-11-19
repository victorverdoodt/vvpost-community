import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Flow, FlowNode } from '@vvpost/schemas'
import type { FlowRunEvent, FlowRunReport } from '@shared/ipc'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { loadWorkspace, type LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import { buildPluginConfig } from '@vvpost/core/flows/plugin-node'
import { runFlow } from '@vvpost/core/flows/run'
import { createHttpDispatcher, type HttpDispatcher } from '@vvpost/core/http/dispatcher'
import { PluginWorker } from '@vvpost/core/plugins/host'
import { PluginManager } from '@vvpost/core/plugins/manager'

const OFFICIAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins')

let server: Server
let origin: string
let http: HttpDispatcher
const seen: { path: string; auth?: string; body: string; headers: IncomingMessage['headers'] }[] = []

const json = (res: ServerResponse, status: number, data: unknown) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(data))
}

/** Servidor GraphQL de mentira: user(id), echo das variáveis e um erro de campo. */
async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body = ''
  for await (const chunk of req) body += chunk
  const url = new URL(req.url ?? '/', 'http://x')
  seen.push({ path: url.pathname, auth: req.headers.authorization, body, headers: req.headers })
  if (url.pathname === '/login') return json(res, 200, { userId: 7, note: '{{API_TOKEN}}' })
  if (url.pathname === '/slow') return void setTimeout(() => json(res, 200, { ok: true }), 2_000)
  if (url.pathname !== '/api/graphql') return json(res, 404, { error: 'NOT_FOUND' })
  if (req.headers.authorization !== 'Bearer env-token') return json(res, 401, { errors: [{ message: 'unauthorized' }] })
  const { query, variables } = JSON.parse(body) as { query: string; variables?: Record<string, unknown> }
  if (query.includes('broken')) return json(res, 200, { data: null, errors: [{ message: 'Cannot query field "broken"' }] })
  if (query.includes('echo')) return json(res, 200, { data: { echo: variables } })
  return json(res, 200, { data: { user: { id: variables?.['id'], name: 'Ana' } } })
}

beforeAll(async () => {
  server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  http = createHttpDispatcher()
})
afterAll(async () => {
  await http.close()
  server.close()
})

let dir: string
let userData: string
let manager: PluginManager
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vvpost-plugins-ws-'))
  userData = mkdtempSync(join(tmpdir(), 'vvpost-plugins-ud-'))
  manager = new PluginManager({
    officialDir: OFFICIAL,
    userDir: join(userData, 'plugins'),
    stateFile: join(userData, 'plugins.json'),
    graceMs: 200
  })
  seen.length = 0
})
afterEach(async () => {
  await manager.shutdown()
  rmSync(dir, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

function write(root: string, path: string, data: unknown): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}

async function workspace(): Promise<LoadedWorkspace> {
  write(dir, 'connectors/api.connector.vvpost.json', {
    id: 'api.v1',
    name: 'API',
    version: '1.0.0',
    config: { baseUrl: '{{BASE_URL}}', basePath: '/api', auth: { type: 'bearer', token: '{{API_TOKEN}}' } }
  })
  write(dir, 'environments/dev.env.json', {
    id: 'env.dev',
    name: 'Dev',
    variables: {
      BASE_URL: { type: 'string', value: origin },
      API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
    }
  })
  write(dir, '.vvpost/secrets.local.json', { 'env.dev': { API_TOKEN: 'env-token' } })
  return loadWorkspace(dir)
}

const js = (id: string, name: string, code: string, extra: Record<string, unknown> = {}): FlowNode =>
  ({ id, name, type: 'plugin', plugin: { node: 'javascript.script', config: { code }, ...extra } }) as FlowNode

const gql = (id: string, name: string, config: Record<string, unknown>, extra: Record<string, unknown> = {}): FlowNode =>
  ({ id, name, type: 'plugin', plugin: { adapter: 'graphql', connector: 'api.v1', config, ...extra } }) as FlowNode

async function run(flow: Flow, signal?: AbortSignal, onEvent?: (e: FlowRunEvent) => void): Promise<FlowRunReport> {
  return runFlow(
    { runId: 'r1', flow, environmentId: 'env.dev' },
    { workspace: await workspace(), auth: createAuthEngine(), http, plugins: await manager.runner(), ...(signal && { signal }), ...(onEvent && { onEvent }) }
  )
}

const byName = (report: FlowRunReport, name: string) => report.results.find((r) => r.name === name)!

describe('catálogo de plugins', () => {
  it('lista os plugins oficiais ligados, sem subir nenhum worker', async () => {
    const { plugins, issues } = await manager.catalog()
    expect(issues).toEqual([])
    expect(plugins.map((p) => [p.id, p.source, p.enabled, p.state])).toEqual([
      ['vvpost-plugin-graphql', 'official', true, 'stopped'],
      ['vvpost-plugin-grpc', 'official', true, 'stopped'],
      ['vvpost-plugin-javascript', 'official', true, 'stopped'],
      ['vvpost-plugin-kafka', 'official', true, 'stopped'],
      ['vvpost-plugin-mkdocs', 'official', true, 'stopped']
    ])
    expect(plugins[0]!.contributions).toMatchObject([{ kind: 'adapter', name: 'graphql', title: 'GraphQL' }])
    expect(plugins[1]!.contributions).toMatchObject([{ kind: 'adapter', name: 'grpc', title: 'gRPC' }])
    expect(plugins[2]!.contributions).toMatchObject([
      { kind: 'node', name: 'javascript.script' },
      { kind: 'node', name: 'javascript.request-script', title: 'Script da requisição' }
    ])
    expect(plugins[3]!.contributions).toMatchObject([{ kind: 'adapter', name: 'kafka', title: 'Kafka' }])
    expect(plugins[4]!.contributions).toEqual([])
    expect(plugins[4]!.exporters).toMatchObject([{ id: 'mkdocs', title: 'MkDocs (Backstage TechDocs)' }])
  })

  it('desligar um plugin deixa os nós dele indisponíveis, e o estado fica gravado', async () => {
    await manager.setEnabled('vvpost-plugin-javascript', false)
    expect(JSON.parse(readFileSync(join(userData, 'plugins.json'), 'utf8'))).toEqual({ disabled: ['vvpost-plugin-javascript'] })
    const report = await run({ id: 'flow.x', name: 'X', nodes: [js('a', 'A', 'return 1')] })
    expect(byName(report, 'A').error).toEqual({
      code: 'PLUGIN_UNAVAILABLE',
      message: 'o tipo de nó javascript.script é do plugin JavaScript, que está desligado no Extensions Hub'
    })
    await manager.setEnabled('vvpost-plugin-javascript', true)
    expect(byName(await run({ id: 'flow.x', name: 'X', nodes: [js('a', 'A', 'return 1')] }), 'A').output).toEqual({ data: 1 })
  })

  it('nó de um plugin que não existe aponta o Extensions Hub', async () => {
    const node = { id: 'a', name: 'A', type: 'plugin', plugin: { node: 'acme.nothing' } } as FlowNode
    const report = await run({ id: 'flow.x', name: 'X', nodes: [node] })
    expect(byName(report, 'A').error?.code).toBe('PLUGIN_UNAVAILABLE')
    expect(byName(report, 'A').error?.message).toMatch(/não vem de nenhum plugin instalado/)
  })
})

describe('vvpost-plugin-javascript', () => {
  it('roda o script com nodes, return, output, console e http pelo host', async () => {
    const report = await run({
      id: 'flow.js',
      name: 'JS',
      nodes: [
        js('a', 'Login', "const res = await http.send({ method: 'POST', url: '{{BASE_URL}}/login', body: { user: 'ana' } })\nconsole.log('status', res.status)\nreturn res.json()"),
        js('b', 'Double', 'output = { id: nodes.Login.data.userId * 2 }'),
        js('c', 'Env', 'return { env: typeof process, require: typeof require }')
      ],
      edges: [{ from: 'a', to: 'b' }]
    })
    expect(report.outcome).toBe('success')
    expect(byName(report, 'Login').output).toEqual({ data: { userId: 7, note: '{{API_TOKEN}}' } })
    expect(byName(report, 'Login').logs).toBe('status 200\n')
    expect(byName(report, 'Login').request).toEqual({ method: 'POST', url: '{{BASE_URL}}/login' })
    expect(seen[0]!.body).toBe('{"user":"ana"}')
    expect(seen[0]!.headers['content-type']).toBe('application/json')
    expect(byName(report, 'Double').output).toEqual({ data: { id: 14 } })
    // O contexto do script não tem require nem process.
    expect(byName(report, 'Env').output).toEqual({ data: { env: 'undefined', require: 'undefined' } })
  })

  it('erro de sintaxe e exceção apontam a linha do script', async () => {
    const report = await run({
      id: 'flow.js',
      name: 'JS',
      nodes: [js('a', 'Syntax', 'const x = 1\nreturn {'), js('b', 'Throws', "const a = 1\nthrow new Error('falhou aqui')")]
    })
    expect(byName(report, 'Syntax').error?.code).toBe('PLUGIN_ERROR')
    expect(byName(report, 'Syntax').error?.message).toMatch(/^erro de sintaxe: .+/)
    expect(byName(report, 'Throws').error).toEqual({ code: 'PLUGIN_ERROR', message: 'falhou aqui (linha 2)' })
  })

  it('um laço infinito estoura o tempo do nó, e o próximo uso funciona', async () => {
    const report = await run({ id: 'flow.js', name: 'JS', nodes: [js('a', 'Loop', 'while (true) {}', { timeoutMs: 300 })] })
    expect(byName(report, 'Loop').error).toEqual({ code: 'TIMEOUT', message: 'o plugin não respondeu em 300 ms' })
    const again = await run({ id: 'flow.js', name: 'JS', nodes: [js('a', 'Ok', 'return 42')] })
    expect(byName(again, 'Ok').output).toEqual({ data: 42 })
  })

  it('uma espera assíncrona longa estoura o tempo do nó e um cancelamento chega ao script', async () => {
    const report = await run({
      id: 'flow.js',
      name: 'JS',
      nodes: [js('a', 'Slow', "await http.send({ url: '{{BASE_URL}}/slow' })\nreturn 1", { timeoutMs: 200 })]
    })
    expect(byName(report, 'Slow').error).toEqual({ code: 'TIMEOUT', message: 'o plugin não respondeu em 200 ms' })

    const controller = new AbortController()
    // Cancela com o nó já rodando: um timer fixo, com a suíte inteira em paralelo, chega antes do nó.
    const onEvent = (e: FlowRunEvent) => e.type === 'node' && e.nodeId === 'a' && e.status === 'running' && setTimeout(() => controller.abort(), 150)
    const canceled = await run({ id: 'flow.js', name: 'JS', nodes: [js('a', 'Slow', "await http.send({ url: '{{BASE_URL}}/slow' })")] }, controller.signal, onEvent)
    expect(canceled.outcome).toBe('canceled')
    expect(byName(canceled, 'Slow').error?.code).toBe('ABORTED')
  })
})

describe('vvpost-plugin-graphql', () => {
  it('envia a operação pelo conector (auth herdada) com variáveis tipadas de $nodes', async () => {
    const report = await run({
      id: 'flow.gql',
      name: 'GQL',
      nodes: [
        js('a', 'Login', "return (await http.send({ url: '{{BASE_URL}}/login' })).json()"),
        gql('b', 'User', { query: 'query ($id: Int!) { user(id: $id) { id name } }', variables: { id: '{{ $nodes.Login.data.userId }}' } })
      ],
      edges: [{ from: 'a', to: 'b' }]
    })
    expect(report.outcome).toBe('success')
    const user = byName(report, 'User')
    expect(user.output).toMatchObject({ data: { data: { user: { id: 7, name: 'Ana' } } }, status: 200 })
    expect(user.output?.headers?.['content-type']).toBe('application/json')
    expect(user.auth).toMatchObject({ type: 'bearer', from: 'api.v1', source: 'static' })
    expect(user.request).toEqual({ method: 'POST', url: '/graphql' })
    expect(user.logs).toMatch(/^HTTP 200 em \d+ ms\n$/)
    const sent = seen.find((s) => s.path === '/api/graphql')!
    expect(sent.auth).toBe('Bearer env-token')
    expect(JSON.parse(sent.body)).toEqual({ query: 'query ($id: Int!) { user(id: $id) { id name } }', variables: { id: 7 } })
  })

  it('errors na resposta falham o nó, a menos que ignoreErrors esteja marcado', async () => {
    const report = await run({
      id: 'flow.gql',
      name: 'GQL',
      nodes: [gql('a', 'Broken', { query: '{ broken }' }), gql('b', 'Allowed', { query: '{ broken }', ignoreErrors: true })]
    })
    expect(byName(report, 'Broken').error).toEqual({ code: 'PLUGIN_ERROR', message: '[GRAPHQL_ERRORS] GraphQL: Cannot query field "broken"' })
    expect(byName(report, 'Allowed').output?.data).toEqual({ data: null, errors: [{ message: 'Cannot query field "broken"' }] })
  })

  it('status 4xx falha o nó, ou segue com ignoreHttpErrors', async () => {
    const node = { id: 'a', name: 'NoAuth', type: 'plugin', plugin: { adapter: 'graphql', config: { url: '{{BASE_URL}}/api/graphql', query: '{ me }', ignoreErrors: true } } } as FlowNode
    const report = await run({ id: 'flow.gql', name: 'GQL', nodes: [node] })
    expect(byName(report, 'NoAuth').error).toEqual({ code: 'HTTP_STATUS', message: 'HTTP 401' })
    const soft = { ...node, plugin: { ...(node as { plugin: object }).plugin, ignoreHttpErrors: true } } as FlowNode
    expect(byName(await run({ id: 'flow.gql', name: 'GQL', nodes: [soft] }), 'NoAuth').output?.status).toBe(401)
  })

  it('um "{{API_TOKEN}}" vindo de uma resposta segue literal, sem virar o segredo', async () => {
    const report = await run({
      id: 'flow.gql',
      name: 'GQL',
      nodes: [
        js('a', 'Login', "return (await http.send({ url: '{{BASE_URL}}/login' })).json()"),
        gql('b', 'Echo', {
          query: 'query ($note: String) { echo }',
          variables: { note: '{{ $nodes.Login.data.note }}', inline: 'x {{ $nodes.Login.data.note }} y' },
          headers: { 'X-Note': '{{ $nodes.Login.data.note }}' }
        })
      ],
      edges: [{ from: 'a', to: 'b' }]
    })
    expect(report.outcome).toBe('success')
    const sent = seen.find((s) => s.path === '/api/graphql')!
    expect(JSON.parse(sent.body).variables).toEqual({ note: '{{API_TOKEN}}', inline: 'x {{API_TOKEN}} y' })
    expect(sent.headers['x-note']).toBe('{{API_TOKEN}}')
    expect(sent.body).not.toContain('env-token')
  })

  it('o mesmo vale para um script que lê o texto direto de nodes', async () => {
    const report = await run({
      id: 'flow.js',
      name: 'JS',
      nodes: [
        js('a', 'Login', "return (await http.send({ url: '{{BASE_URL}}/login' })).json()"),
        js('b', 'Send', "await http.send({ method: 'POST', url: '{{BASE_URL}}/login?n=' + encodeURIComponent(nodes.Login.data.note), body: { note: nodes.Login.data.note } })")
      ],
      edges: [{ from: 'a', to: 'b' }]
    })
    expect(report.outcome).toBe('success')
    expect(seen.at(-1)!.body).toBe('{"note":"{{API_TOKEN}}"}')
  })

  it('campo obrigatório vazio e variáveis que não são objeto são erro de configuração', async () => {
    const report = await run({
      id: 'flow.gql',
      name: 'GQL',
      nodes: [gql('a', 'NoQuery', { query: '' }), gql('b', 'BadVars', { query: '{ me }', variables: [1] })]
    })
    expect(byName(report, 'NoQuery').error).toEqual({ code: 'CONFIG_ERROR', message: 'o campo "Operação" é obrigatório' })
    expect(byName(report, 'BadVars').error?.message).toBe('[INVALID_VARIABLES] as variáveis precisam ser um objeto JSON')
  })
})

describe('plugins instalados pelo usuário', () => {
  const source = () => mkdtempSync(join(tmpdir(), 'vvpost-plugin-src-'))
  const manifest = (extra: Record<string, unknown> = {}) => ({
    id: 'acme-tools',
    name: 'Acme Tools',
    version: '0.1.0',
    main: 'index.js',
    apiVersion: 1,
    contributes: {
      nodes: [
        { type: 'acme.env', title: 'Env' },
        { type: 'acme.crash', title: 'Crash' },
        { type: 'acme.loop', title: 'Loop' },
        { type: 'acme.wait', title: 'Wait' },
        { type: 'acme.hello', title: 'Hello', fields: [{ key: 'name', label: 'Nome', type: 'text', default: 'mundo' }] }
      ]
    },
    ...extra
  })
  const code = `module.exports = { nodes: {
    'acme.env': { run: () => ({ keys: Object.keys(process.env), home: process.env.HOME ?? null }) },
    'acme.crash': { run: () => new Promise(() => setTimeout(() => { throw new Error('boom') }, 10)) },
    'acme.loop': { run: () => new Promise((r) => setTimeout(() => { for (;;) {} }, 50)) },
    'acme.wait': { run: () => new Promise((r) => setTimeout(() => r('esperou'), 2000)) },
    'acme.hello': { run: (ctx) => { console.log('oi de', ctx.node.name); return 'olá ' + ctx.config.name } }
  } }`

  it('prévia, instalação, uso num fluxo e remoção', async () => {
    const src = source()
    write(src, 'vvpost-plugin.json', manifest())
    write(src, 'index.js', code)
    write(src, '.git/HEAD', 'ref: refs/heads/main')

    const preview = await manager.previewInstall(src)
    expect(preview).toMatchObject({ canInstall: true, problems: [], conflicts: [], files: 2, plugin: { id: 'acme-tools', version: '0.1.0' } })
    expect(preview.plugin?.contributions.map((c) => c.name)).toEqual(['acme.env', 'acme.crash', 'acme.loop', 'acme.wait', 'acme.hello'])
    const { plugins } = await manager.install(preview.id)
    expect(plugins.find((p) => p.id === 'acme-tools')).toMatchObject({ source: 'user', enabled: true })
    expect(() => readFileSync(join(userData, 'plugins/acme-tools/.git/HEAD'))).toThrow()
    await expect(manager.install(preview.id)).rejects.toThrow(/não está mais disponível/)

    const report = await run({
      id: 'flow.acme',
      name: 'Acme',
      nodes: [
        { id: 'a', name: 'Hi', type: 'plugin', plugin: { node: 'acme.hello' } },
        { id: 'b', name: 'Env', type: 'plugin', plugin: { node: 'acme.env' } }
      ] as FlowNode[]
    })
    expect(byName(report, 'Hi')).toMatchObject({ output: { data: 'olá mundo' }, logs: 'oi de Hi\n' })
    // O worker roda com o ambiente vazio: nenhuma variável do app chega ao plugin.
    // (No Windows só SYSTEMROOT fica, porque sockets e crypto dependem dela.)
    const env = (byName(report, 'Env').output as { data: { keys: string[]; home: string | null } }).data
    expect({ keys: env.keys.filter((k) => process.platform !== 'win32' || k.toUpperCase() !== 'SYSTEMROOT'), home: env.home }).toEqual({ keys: [], home: null })

    await manager.remove('acme-tools')
    expect((await manager.catalog()).plugins.map((p) => p.id)).not.toContain('acme-tools')
    await expect(manager.remove('vvpost-plugin-graphql')).rejects.toThrow(/Nenhum plugin instalado/)
  })

  it('uma exceção fora da chamada derruba só o worker do plugin; o próximo uso sobe outro', async () => {
    const src = source()
    write(src, 'vvpost-plugin.json', manifest())
    write(src, 'index.js', code)
    await manager.install((await manager.previewInstall(src)).id)
    const report = await run({
      id: 'flow.acme',
      name: 'Acme',
      nodes: [
        { id: 'a', name: 'Crash', type: 'plugin', plugin: { node: 'acme.crash' } },
        js('b', 'Other', 'return 1')
      ] as FlowNode[]
    })
    expect(byName(report, 'Crash').error).toEqual({ code: 'PLUGIN_CRASHED', message: 'o processo de acme-tools caiu: boom' })
    // Outro plugin, outro worker: não é afetado.
    expect(byName(report, 'Other').output).toEqual({ data: 1 })
    expect((await manager.catalog()).plugins.find((p) => p.id === 'acme-tools')?.lastError).toBe('o processo de acme-tools caiu: boom')
    const again = await run({ id: 'flow.acme', name: 'Acme', nodes: [{ id: 'a', name: 'Hi', type: 'plugin', plugin: { node: 'acme.hello' } }] as FlowNode[] })
    expect(byName(again, 'Hi').output).toEqual({ data: 'olá mundo' })
  })

  it('código que não para depois do tempo encerra o worker; as outras chamadas dele falham com PLUGIN_CRASHED', async () => {
    const src = source()
    write(src, 'vvpost-plugin.json', manifest())
    write(src, 'index.js', code)
    await manager.install((await manager.previewInstall(src)).id)
    const report = await run({
      id: 'flow.acme',
      name: 'Acme',
      nodes: [
        { id: 'a', name: 'Loop', type: 'plugin', plugin: { node: 'acme.loop', timeoutMs: 200 } },
        { id: 'b', name: 'Wait', type: 'plugin', plugin: { node: 'acme.wait' } }
      ] as FlowNode[]
    })
    expect(byName(report, 'Loop').error).toEqual({ code: 'TIMEOUT', message: 'o plugin não respondeu em 200 ms' })
    expect(byName(report, 'Wait').error).toEqual({
      code: 'PLUGIN_CRASHED',
      message: 'o processo de acme-tools foi encerrado: uma chamada não parou depois de estourar o tempo'
    })
    const again = await run({ id: 'flow.acme', name: 'Acme', nodes: [{ id: 'a', name: 'Hi', type: 'plugin', plugin: { node: 'acme.hello' } }] as FlowNode[] })
    expect(byName(again, 'Hi').output).toEqual({ data: 'olá mundo' })
  })

  it('recusa o id de um plugin oficial e marca conflito de tipo de nó', async () => {
    const official = source()
    write(official, 'vvpost-plugin.json', manifest({ id: 'vvpost-plugin-graphql' }))
    write(official, 'index.js', code)
    const preview = await manager.previewInstall(official)
    expect(preview.canInstall).toBe(false)
    expect(preview.problems).toEqual(['o id vvpost-plugin-graphql é de um plugin oficial'])

    const clash = source()
    write(clash, 'vvpost-plugin.json', manifest({ id: 'other-js', contributes: { nodes: [{ type: 'javascript.script', title: 'JS 2' }] } }))
    write(clash, 'index.js', code)
    const clashPreview = await manager.previewInstall(clash)
    expect(clashPreview.conflicts).toEqual(['o nó javascript.script já vem de JavaScript'])
    const { plugins } = await manager.install(clashPreview.id)
    expect(plugins.find((p) => p.id === 'other-js')?.error).toBe('conflito: o nó javascript.script já vem de JavaScript')
  })

  it('manifesto inválido vira problema na prévia e issue no catálogo', async () => {
    const src = source()
    write(src, 'vvpost-plugin.json', { ...manifest(), apiVersion: 2 })
    expect((await manager.previewInstall(src)).problems).toEqual(['vvpost-plugin.json: /apiVersion: deve ser 1'])
    write(userData, 'plugins/broken/vvpost-plugin.json', '{ nope')
    expect((await manager.catalog()).issues).toMatchObject([{ dir: join(userData, 'plugins/broken'), message: expect.stringMatching(/JSON inválido/) }])
  })
})

describe('worker do plugin', () => {
  it('para depois do tempo sem uso e sobe de novo na próxima chamada', async () => {
    const worker = new PluginWorker('vvpost-plugin-javascript', join(OFFICIAL, 'vvpost-plugin-javascript/index.js'), { idleMs: 50 })
    const invoke = () =>
      worker.invoke({
        kind: 'node',
        name: 'javascript.script',
        context: { config: { code: 'return nodes.A.data + 1' }, nodes: { A: { data: 1 } }, node: { id: 'x', name: 'X' }, timeoutMs: 5_000 },
        onHttp: async () => ({ ok: false, error: { code: 'X', message: 'x' } })
      })
    expect(await invoke()).toMatchObject({ ok: true, value: 2 })
    expect(worker.state).toBe('running')
    await new Promise((r) => setTimeout(r, 150))
    expect(worker.state).toBe('stopped')
    expect(await invoke()).toMatchObject({ ok: true, value: 2 })
    await worker.terminate()
  })

  it('main que não carrega vira erro do plugin, sem derrubar o host', async () => {
    const src = mkdtempSync(join(tmpdir(), 'vvpost-plugin-bad-'))
    write(src, 'index.js', 'throw new Error("não carrego")')
    const worker = new PluginWorker('bad', join(src, 'index.js'))
    const outcome = await worker.invoke({
      kind: 'node',
      name: 'bad.x',
      context: { config: {}, nodes: {}, node: { id: 'x', name: 'X' }, timeoutMs: 5_000 },
      onHttp: async () => ({ ok: false, error: { code: 'X', message: 'x' } })
    })
    expect(outcome).toMatchObject({ ok: false, code: 'PLUGIN_UNAVAILABLE' })
    expect(outcome.ok || outcome.message).toMatch(/o plugin bad não carregou: .*não carrego/)
    expect(worker.lastError).toMatch(/não carrego/)
    rmSync(src, { recursive: true, force: true })
  })
})

describe('configuração do nó de plugin', () => {
  const fields = [
    { key: 'n', label: 'N', type: 'number' as const },
    { key: 'mode', label: 'Modo', type: 'select' as const, options: [{ value: 'a', label: 'A' }] as [{ value: string; label: string }], default: 'a' },
    { key: 'code', label: 'Código', type: 'code' as const, templates: false },
    { key: 'text', label: 'Texto', type: 'text' as const }
  ]
  const nodes = { Prev: { data: { n: 3, label: 'x' } } }

  it('aplica defaults, resolve referências com tipo e deixa {{VAR}} e campos sem templates como estão', () => {
    const tainted = new Set<string>()
    const config = buildPluginConfig(
      fields,
      { n: '{{ $nodes.Prev.data.n }}', code: 'return "{{ $nodes.Prev.data.n }}"', text: '{{BASE_URL}}/{{ $nodes.Prev.data.label }}' },
      nodes,
      new Set(),
      tainted
    )
    expect(config).toEqual({ n: 3, mode: 'a', code: 'return "{{ $nodes.Prev.data.n }}"', text: '{{BASE_URL}}/x' })
  })

  it('tipo errado e nó que não é anterior são erro', () => {
    expect(() => buildPluginConfig(fields, { n: 'três' }, nodes, new Set(), new Set())).toThrow('o campo "N" precisa ser um número')
    expect(() => buildPluginConfig(fields, { mode: 'b' }, nodes, new Set(), new Set())).toThrow('precisa ser um de a')
    expect(() => buildPluginConfig(fields, { text: '{{ $nodes.Later.data }}' }, nodes, new Set(['Later']), new Set())).toThrow(
      /não é anterior/
    )
  })
})

describe('limites do plugin', () => {
  it('uma execução do nó não passa de 100 requisições pelo host', async () => {
    const report = await run({
      id: 'flow.loop',
      name: 'Laço',
      nodes: [
        js(
          'a',
          'Loop',
          "for (let i = 0; i < 101; i++) {\n  try { await http.send({ method: 'POST', url: '{{BASE_URL}}/login' }) }\n  catch (e) { return { i, code: e.code, message: e.message } }\n}\nreturn 'sem limite'"
        )
      ]
    })
    expect(byName(report, 'Loop').output).toEqual({
      data: { i: 100, code: 'POLICY_DENIED', message: 'o plugin vvpost-plugin-javascript passou do limite de 100 requisições por execução' }
    })
    expect(seen).toHaveLength(100)
  })
})

describe('extensões do editor de diagramas (contributes.diagrams)', () => {
  const plugin = (id: string, diagrams: Record<string, unknown>) => {
    const root = join(userData, 'plugins', id)
    write(root, 'vvpost-plugin.json', { id, name: `Plugin ${id}`, version: '1.0.0', main: 'index.js', apiVersion: 1, contributes: { diagrams } })
    write(root, 'index.js', 'module.exports = {}')
    return root
  }

  it('lê os pacotes de ícones e os blocos dos plugins ligados, sem subir processo', async () => {
    const root = plugin('nuvem', {
      iconPacks: [
        { prefix: 'nuvem', title: 'Nuvem', file: 'icons/nuvem.json' },
        { prefix: 'quebrado', title: 'Quebrado', file: 'icons/nada.json' }
      ],
      blocks: [{ title: 'Função', category: 'Nuvem', code: 'service f(nuvem:funcao)[Função]', icon: 'nuvem:funcao' }]
    })
    write(root, 'icons/nuvem.json', {
      prefix: 'outro',
      width: 24,
      height: 24,
      info: { name: 'ignorado' },
      icons: { funcao: { body: '<path d="M0 0h24v24H0z"/>', width: 32, extra: 'fora' }, 'Nome Ruim': { body: '<g/>' } },
      aliases: { lambda: { parent: 'funcao' }, orfao: { parent: 'nada' } }
    })
    const catalog = await manager.diagramCatalog()
    expect(catalog.blocks).toEqual([{ title: 'Função', category: 'Nuvem', code: 'service f(nuvem:funcao)[Função]', icon: 'nuvem:funcao', pluginId: 'nuvem', pluginName: 'Plugin nuvem' }])
    expect(catalog.iconPacks).toEqual([
      {
        prefix: 'nuvem',
        title: 'Nuvem',
        pluginId: 'nuvem',
        pluginName: 'Plugin nuvem',
        icons: { prefix: 'nuvem', width: 24, height: 24, icons: { funcao: { body: '<path d="M0 0h24v24H0z"/>', width: 32 } }, aliases: { lambda: { parent: 'funcao' } } }
      }
    ])
    expect(catalog.issues).toEqual([{ pluginId: 'nuvem', message: expect.stringContaining('quebrado') }])
    const { plugins } = await manager.catalog()
    expect(plugins.find((p) => p.id === 'nuvem')).toMatchObject({ state: 'stopped', diagrams: { iconPacks: [{ prefix: 'nuvem', title: 'Nuvem' }, { prefix: 'quebrado', title: 'Quebrado' }], blocks: 1 } })
  })

  it('prefixo repetido entre plugins é conflito, desligado não entra, e arquivo fora da pasta é recusado', async () => {
    plugin('a-icons', { iconPacks: [{ prefix: 'comum', title: 'A', file: 'a.json' }] })
    write(join(userData, 'plugins', 'a-icons'), 'a.json', { icons: { x: { body: '<g/>' } } })
    plugin('b-icons', { iconPacks: [{ prefix: 'comum', title: 'B', file: 'b.json' }] })
    write(join(userData, 'plugins', 'b-icons'), 'b.json', { icons: { y: { body: '<g/>' } } })
    const fora = plugin('c-icons', { iconPacks: [{ prefix: 'fora', title: 'C', file: 'sub/../../a-icons/a.json' }] })
    write(fora, 'sub/.keep', '')
    const { plugins, issues } = await manager.catalog()
    expect(plugins.find((p) => p.id === 'b-icons')?.error).toContain('os ícones comum: já vêm de Plugin a-icons')
    expect(issues.find((i) => i.dir.endsWith('c-icons'))?.message).toContain('dentro da pasta do plugin')
    let catalog = await manager.diagramCatalog()
    expect(catalog.iconPacks.map((p) => p.prefix)).toEqual(['comum'])
    expect(catalog.issues).toEqual([])
    await manager.setEnabled('a-icons', false)
    catalog = await manager.diagramCatalog()
    expect(catalog.iconPacks.map((p) => p.pluginId)).toEqual(['b-icons'])
  })

  it('o manifesto recusa o prefixo vv (do VVPost) e arquivo que não é .json', async () => {
    plugin('vv-falso', { iconPacks: [{ prefix: 'vv', title: 'X', file: 'x.json' }] })
    plugin('svg-solto', { iconPacks: [{ prefix: 'svg', title: 'X', file: 'x.svg' }] })
    const { issues } = await manager.catalog()
    expect(issues.map((i) => i.dir.split(/[\\/]/).pop())).toEqual(expect.arrayContaining(['vv-falso', 'svg-solto']))
  })
})
