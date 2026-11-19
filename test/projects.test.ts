import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { resolveConnector } from '@vvpost/core/connectors/resolve'
import { addFlowProjectRefs, environmentValues, loadWorkspace, otherProjectBases } from '@vvpost/core/connectors/workspace'
import { runFlow } from '@vvpost/core/flows/run'
import { loadFlows } from '@vvpost/core/flows/workspace'
import { createHttpDispatcher, type HttpDispatcher } from '@vvpost/core/http/dispatcher'
import { projectDir, projectLayout } from '@vvpost/core/projects'
import { validateProject } from '@vvpost/schemas'
import { summarizeWorkspace } from '@vvpost/core/connectors/summary'
import { applyProjectOps } from '../src/main/project/apply'
import { createProject } from '../src/main/workspace/projects'
import { main, type Io } from '../src/main/cli'
import { createMcpServer } from '../src/main/mcp/server'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function workspace(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-projects-'))
  dirs.push(dir)
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
  }
  return dir
}

const request = (id: string, extendsId: string, url: string) => ({
  id,
  name: id,
  extends: extendsId,
  nodes: [{ id: 'request', name: 'Request', type: 'request', request: { method: 'GET', url } }],
  edges: []
})

/**
 * Um workspace com a auth no Compartilhado, um projeto com duas APIs que herdam dela e outro
 * projeto que usa uma das APIs do primeiro.
 */
const files = (authUrl = 'https://auth.exemplo.com') => ({
  'flows/auth.flow.vvpost.json': {
    id: 'auth',
    name: 'Auth',
    defaults: { headers: { Authorization: 'Bearer {{ $nodes.Login.data.access_token }}' } },
    nodes: [
      {
        id: 'login',
        name: 'Login',
        type: 'request',
        cache: { expiresIn: 'data.expires_in' },
        request: { method: 'POST', url: '{{AUTH_URL}}/oauth/token', body: { client_secret: '{{CLIENT_SECRET}}' } }
      }
    ],
    edges: []
  },
  'environments/dev.env.json': {
    id: 'dev',
    name: 'Dev',
    variables: {
      AUTH_URL: { type: 'string', value: authUrl },
      CNPJ_URL: { type: 'string', value: 'https://cnpj.exemplo.com' },
      CLIENT_SECRET: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
    }
  },
  '.vvpost/secrets.local.json': { dev: { CLIENT_SECRET: 'root-secret' } },
  'estoque/vvpost.project.json': { id: 'estoque', name: 'Estoque' },
  'estoque/flows/cnpj.flow.vvpost.json': { id: 'cnpj', name: 'CNPJ', extends: 'auth', defaults: { baseUrl: '{{CNPJ_URL}}' }, nodes: [], edges: [] },
  'estoque/flows/veiculos.flow.vvpost.json': { id: 'veiculos', name: 'Veículos', extends: 'auth', defaults: { baseUrl: '{{VEICULOS_URL}}' }, nodes: [], edges: [] },
  'estoque/flows/cnpj.consultar.flow.vvpost.json': request('cnpj.consultar', 'cnpj', '/cnpj/1'),
  'estoque/environments/dev.env.json': {
    id: 'dev',
    name: 'Dev (Estoque)',
    variables: { VEICULOS_URL: { type: 'string', value: 'https://veiculos.exemplo.com' } }
  },
  'cobranca/vvpost.project.json': { id: 'cobranca', name: 'Cobrança' },
  // O mesmo id de outro projeto: cada projeto tem os seus.
  'cobranca/flows/veiculos.flow.vvpost.json': { id: 'veiculos', name: 'Estoque de cobrança', defaults: { baseUrl: 'https://outra.exemplo.com' }, nodes: [], edges: [] },
  'cobranca/flows/cnpj.validar.flow.vvpost.json': request('cnpj.validar', 'estoque:cnpj', '/cnpj/2/validar')
})

describe('projetos no workspace', () => {
  it('o manifesto tem id, nome e descrição; "flow" é reservado', () => {
    expect(validateProject({ id: 'estoque', name: 'Estoque', description: 'Consultas' }).ok).toBe(true)
    expect(validateProject({ id: 'Estoque', name: 'Estoque' }).ok).toBe(false)
    expect(validateProject({ id: 'flow', name: 'Fluxo' })).toMatchObject({ ok: false, issues: [{ path: '/id' }] })
  })

  it('lista os projetos pela raiz ou de dentro de um projeto', () => {
    const root = workspace(files())
    const expected = [
      { id: 'cobranca', name: 'Cobrança', folder: 'cobranca' },
      { id: 'estoque', name: 'Estoque', folder: 'estoque' }
    ]
    expect(projectLayout(root)).toMatchObject({ root, projects: expected, issues: [] })
    expect(projectLayout(join(root, 'estoque'))).toMatchObject({ root, current: expected[1] })
    expect(projectDir(root, 'estoque')).toBe(join(root, 'estoque'))
    expect(() => projectDir(root, 'nada')).toThrow('cobranca, estoque')
  })

  it('a raiz é o Compartilhado: os arquivos dos projetos ficam de fora', async () => {
    const root = workspace(files())
    const ws = await loadWorkspace(root)
    expect([...ws.connectors.keys()]).toEqual(['auth'])
    expect(ws.projects?.map((p) => p.id)).toEqual(['cobranca', 'estoque'])
    expect((await loadFlows(root)).flows.map((f) => f.flow.id)).toEqual(['auth'])
    expect(ws.issues).toEqual([])
  })

  it('o projeto vê o Compartilhado só para leitura, com ambientes e segredos complementados', async () => {
    const root = workspace(files())
    const ws = await loadWorkspace(join(root, 'estoque'))
    expect(ws.issues).toEqual([])
    expect(ws.project?.id).toBe('estoque')
    expect([...ws.connectors.keys()].sort()).toEqual(['auth', 'cnpj', 'veiculos'])
    expect(ws.shared?.get('auth')).toBe('Compartilhado do workspace')
    expect(ws.connectorFiles.get('auth')).toBe('../flows/auth.flow.vvpost.json')
    expect(resolveConnector('cnpj', ws.connectors)).toMatchObject({ chain: ['auth', 'cnpj'], baseUrl: '{{CNPJ_URL}}', auth: { from: 'auth' } })
    expect(resolveConnector('cnpj', ws.connectors).endpoints.map((e) => e.id)).toEqual(['consultar'])
    // O ambiente do projeto com o mesmo id acrescenta variáveis; o segredo vem da raiz.
    expect(ws.environments.get('dev')?.name).toBe('Dev (Estoque)')
    const { values } = environmentValues(ws, 'dev')
    expect(Object.fromEntries(values)).toMatchObject({
      AUTH_URL: 'https://auth.exemplo.com',
      VEICULOS_URL: 'https://veiculos.exemplo.com',
      CLIENT_SECRET: 'root-secret'
    })
  })

  it('outro projeto herda com "<projeto>:<id>", com a cadeia do projeto de origem', async () => {
    const root = workspace(files())
    const ws = await loadWorkspace(join(root, 'cobranca'))
    expect(ws.issues).toEqual([])
    expect(ws.connectors.get('veiculos')?.name).toBe('Estoque de cobrança')
    expect(ws.shared?.get('estoque:cnpj')).toBe('projeto Estoque')
    const cnpj = resolveConnector('estoque:cnpj', ws.connectors)
    expect(cnpj).toMatchObject({ chain: ['auth', 'estoque:cnpj'], baseUrl: '{{CNPJ_URL}}', auth: { from: 'auth' } })
    expect(cnpj.endpoints.map((e) => e.id)).toEqual(['consultar', 'validar'])
  })

  it('as bases dos outros projetos ficam à mão para um nó, e um fluxo não gravado pode citá-las', async () => {
    const root = workspace(files())
    const ws = await loadWorkspace(join(root, 'cobranca'))
    // estoque:cnpj já é citado por um arquivo; estoque:veiculos ainda não.
    expect(ws.connectors.has('estoque:veiculos')).toBe(false)
    const { ws: extra, ids } = await otherProjectBases(ws)
    expect(ids).toEqual(['estoque:veiculos'])
    expect(ws.connectors.has('estoque:veiculos')).toBe(false)
    expect(summarizeWorkspace(extra).connectors.find((c) => c.id === 'estoque:veiculos')).toMatchObject({
      name: 'Veículos',
      shared: 'projeto Estoque',
      chain: ['auth', 'estoque:veiculos'],
      baseUrl: '{{VEICULOS_URL}}'
    })
    // Fora de um projeto, nada a oferecer.
    expect((await otherProjectBases(await loadWorkspace(root))).ids).toEqual([])

    // O canvas cita estoque:veiculos num nó antes de gravar: a base entra no workspace já lido.
    const draft = {
      id: 'conferir',
      name: 'Conferir',
      nodes: [{ id: 'n', name: 'Veículo', type: 'request' as const, request: { connector: 'estoque:veiculos', method: 'GET' as const, url: '/1' } }],
      edges: []
    }
    await addFlowProjectRefs(ws, draft)
    expect(resolveConnector('estoque:veiculos', ws.connectors)).toMatchObject({ chain: ['auth', 'estoque:veiculos'] })
    expect(ws.issues).toEqual([])
    await addFlowProjectRefs(ws, { ...draft, nodes: [{ ...draft.nodes[0]!, request: { connector: 'estoque:nada', method: 'GET' as const, url: '/1' } }] })
    expect(ws.issues.map((i) => i.message)).toEqual(['"estoque:nada": o projeto "estoque" não tem a base "nada"'])
  })

  it('referências erradas viram aviso do arquivo, sem derrubar o resto', async () => {
    const root = workspace({
      ...files(),
      'cobranca/flows/a.flow.vvpost.json': request('a', 'nada:x', '/a'),
      'cobranca/flows/b.flow.vvpost.json': request('b', 'estoque:nao-existe', '/b'),
      'cobranca/flows/c.flow.vvpost.json': request('c', 'cobranca:veiculos', '/c'),
      // Compartilhado não é sobreposto pelo projeto.
      'cobranca/flows/auth.flow.vvpost.json': { id: 'auth', name: 'Outra', defaults: { baseUrl: 'https://x.exemplo.com' }, nodes: [], edges: [] }
    })
    const ws = await loadWorkspace(join(root, 'cobranca'))
    const messages = ws.issues.map((i) => `${i.file}: ${i.message}`).join('\n')
    expect(messages).toContain('"nada:x": o projeto "nada" não existe')
    expect(messages).toContain('"estoque:nao-existe": o projeto "estoque" não tem a base "nao-existe"')
    expect(messages).toContain('"cobranca:veiculos" é deste projeto: use só "veiculos"')
    expect(messages).toContain('flows/auth.flow.vvpost.json')
    expect(ws.connectors.get('auth')?.name).toBe('Auth')
    expect(resolveConnector('estoque:cnpj', ws.connectors).endpoints.map((e) => e.id)).toEqual(['consultar', 'validar'])
  })

  it('referência circular entre projetos vira aviso', async () => {
    const root = workspace({
      'a/vvpost.project.json': { id: 'a', name: 'A' },
      'a/flows/x.flow.vvpost.json': { id: 'x', name: 'X', extends: 'b:y', defaults: {}, nodes: [], edges: [] },
      'b/vvpost.project.json': { id: 'b', name: 'B' },
      'b/flows/y.flow.vvpost.json': { id: 'y', name: 'Y', extends: 'a:x', defaults: {}, nodes: [], edges: [] }
    })
    const ws = await loadWorkspace(join(root, 'a'))
    expect(ws.issues.map((i) => i.message).join('\n')).toContain('referência circular entre projetos')
  })

  it('um workspace sem projetos continua igual', async () => {
    const root = workspace({ 'flows/auth.flow.vvpost.json': files()['flows/auth.flow.vvpost.json'] })
    const ws = await loadWorkspace(root)
    expect(ws.projects).toEqual([])
    expect(ws.project).toBeUndefined()
    expect([...ws.connectors.keys()]).toEqual(['auth'])
  })

  it('a edição num projeto grava na pasta dele e não mexe no Compartilhado', async () => {
    const root = workspace(files())
    const estoque = join(root, 'estoque')
    const ok = await applyProjectOps(estoque, [{ op: 'upsertFlow', flow: request('veiculos.placa', 'veiculos', '/placa/X') as never }])
    expect(ok.errors).toEqual([])
    expect(existsSync(join(estoque, 'flows/veiculos.placa.flow.vvpost.json'))).toBe(true)
    const before = readFileSync(join(root, 'flows/auth.flow.vvpost.json'), 'utf8')
    for (const op of [
      { op: 'patchConnector', id: 'auth', set: { name: 'Outra' } },
      { op: 'upsertFlow', flow: { id: 'auth', name: 'Outra', defaults: {}, nodes: [], edges: [] } }
    ]) {
      const refused = await applyProjectOps(estoque, [op as never])
      expect(refused.errors[0]?.message).toContain('Compartilhado do workspace e aqui é só leitura')
    }
    expect(readFileSync(join(root, 'flows/auth.flow.vvpost.json'), 'utf8')).toBe(before)
  })
})

describe('projetos no app', () => {
  it('o explorador recebe a herança: o arquivo, o que é fluxo e o que é do Compartilhado', async () => {
    const root = workspace({
      ...files(),
      'estoque/connectors/legado.connector.vvpost.json': { id: 'legado', name: 'Legado', version: '1.0.0', config: { baseUrl: 'https://legado.exemplo.com' } }
    })
    const catalog = summarizeWorkspace(await loadWorkspace(join(root, 'estoque')))
    const by = (id: string) => catalog.connectors.find((c) => c.id === id)!
    // As duas APIs debaixo da mesma auth, que vem do Compartilhado e é só leitura aqui.
    expect(by('cnpj')).toMatchObject({ chain: ['auth', 'cnpj'], asFlow: true, file: 'flows/cnpj.flow.vvpost.json' })
    expect(by('veiculos').chain).toEqual(['auth', 'veiculos'])
    expect(by('auth').shared).toBeTruthy()
    expect(by('cnpj').endpoints).toMatchObject([{ id: 'consultar', flowFile: 'flows/cnpj.consultar.flow.vvpost.json' }])
    expect(by('legado')).toMatchObject({ file: 'connectors/legado.connector.vvpost.json' })
    expect(by('legado').asFlow).toBeUndefined()
    // Só o conector no formato antigo do projeto conta para o "Converter para fluxos".
    expect(catalog.legacy).toBe(1)
    expect(catalog.flowFiles).toEqual(
      expect.arrayContaining(['flows/cnpj.flow.vvpost.json', 'flows/veiculos.flow.vvpost.json', 'flows/cnpj.consultar.flow.vvpost.json'])
    )
  })

  it('"Novo projeto" cria a subpasta com o manifesto e recusa um nome repetido', async () => {
    const root = workspace(files())
    const folder = await createProject(root, 'Cadastro de Clientes', 'Consultas de cadastro')
    expect(folder).toBe(join(root, 'cadastro-de-clientes'))
    const doc = JSON.parse(readFileSync(join(folder, 'vvpost.project.json'), 'utf8'))
    expect(doc).toMatchObject({ id: 'cadastro-de-clientes', name: 'Cadastro de Clientes', description: 'Consultas de cadastro' })
    expect(validateProject(doc).ok).toBe(true)
    expect(projectLayout(root).projects.map((p) => p.id)).toEqual(['cadastro-de-clientes', 'cobranca', 'estoque'])
    // O projeto novo já vê o Compartilhado.
    expect([...(await loadWorkspace(folder)).connectors.keys()]).toEqual(['auth'])
    await expect(createProject(root, 'Estoque')).rejects.toThrow('já tem o projeto "Estoque"')
    await expect(createProject(root, '!!!')).rejects.toThrow('não dá um id de projeto válido')
  })
})

describe('execução entre projetos', () => {
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
        return res.end('{"access_token":"tok-root","expires_in":3600}')
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

  it('o fluxo de outro projeto roda com a auth do Compartilhado e o segredo da raiz', async () => {
    const root = workspace(files(origin))
    // A cobrança usa os ambientes da raiz: o da Estoque vale só dentro da Estoque.
    const env = JSON.parse(readFileSync(join(root, 'environments/dev.env.json'), 'utf8'))
    env.variables.CNPJ_URL.value = origin
    writeFileSync(join(root, 'environments/dev.env.json'), JSON.stringify(env))
    const dir = join(root, 'cobranca')
    const ws = await loadWorkspace(dir)
    const flow = (await loadFlows(dir)).flows.find((f) => f.flow.id === 'cnpj.validar')!.flow
    const report = await runFlow({ runId: 'r', flow, environmentId: 'dev' }, { workspace: ws, auth: createAuthEngine(), http })
    expect(report.outcome).toBe('success')
    expect(logins).toBe(1)
    expect(seen).toEqual([{ path: '/oauth/token' }, { path: '/cnpj/2/validar', auth: 'Bearer tok-root' }])
  })
})

async function cli(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  let stdout = ''
  let stderr = ''
  const io: Io = {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    env: { VVPOST_USER_DATA: join(cwd, '.user-data'), ...env },
    cwd,
    isTTY: false,
    appDir: join(cwd, '.app')
  }
  const code = await main(args, io)
  return { code, stdout, stderr }
}

describe('CLI com projetos', () => {
  it('vvpost projects lista os projetos e marca o atual', async () => {
    const root = workspace(files())
    const text = await cli(join(root, 'estoque/flows'), ['projects'])
    expect(text.code).toBe(0)
    expect(text.stdout).toContain('* estoque  Estoque  (estoque/)')
    expect(text.stdout).toContain('  cobranca  Cobrança  (cobranca/)')
    const json = JSON.parse((await cli(root, ['projects', '--json', '-'])).stdout)
    expect(json).toMatchObject({ workspace: root, current: null, projects: [{ id: 'cobranca' }, { id: 'estoque' }] })
  })

  it('a pasta de dentro de um projeto vale o projeto; --project e $VVPOST_PROJECT escolhem outro', async () => {
    const root = workspace(files())
    const inside = JSON.parse((await cli(join(root, 'estoque/flows'), ['list', '--json', '-'])).stdout)
    expect(inside).toMatchObject({ workspace: join(root, 'estoque'), project: 'estoque' })
    expect(inside.connectors.map((c: { id: string }) => c.id)).toEqual(['auth', 'cnpj', 'veiculos'])
    const other = JSON.parse((await cli(join(root, 'estoque'), ['list', '--json', '-', '--project', 'cobranca'])).stdout)
    expect(other.project).toBe('cobranca')
    expect(other.connectors.map((c: { id: string }) => c.id)).toContain('estoque:cnpj')
    expect(JSON.parse((await cli(root, ['list', '--json', '-'], { VVPOST_PROJECT: 'estoque' })).stdout).project).toBe('estoque')
    const missing = await cli(root, ['list', '--project', 'nada'])
    expect(missing).toMatchObject({ code: 2, stderr: expect.stringContaining('projeto "nada" não existe') })
    expect((await cli(join(root, 'cobranca'), ['validate'])).code).toBe(0)
  })
})

describe('MCP com projetos', () => {
  async function call(server: ReturnType<typeof createMcpServer>, name: string, args: Record<string, unknown>) {
    const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as {
      result: { isError: boolean; content: { text: string }[] }
    }
    return { isError: res.result.isError, data: JSON.parse(res.result.content[0]!.text) }
  }
  const fakeHttp = { cancel() {}, async send(): Promise<never> { throw new Error('sem rede no teste') } }

  it('list_projects e o argumento project em toda ferramenta', async () => {
    const root = workspace(files())
    const mcp = createMcpServer({ workspaceDir: root, http: fakeHttp, auth: createAuthEngine() })
    const tools = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as {
      result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }
    }
    for (const t of tools.result.tools) expect(t.inputSchema.properties).toHaveProperty('project')

    expect((await call(mcp, 'list_projects', {})).data).toMatchObject({
      workspace: root,
      current: null,
      note: expect.stringContaining('Compartilhado'),
      projects: [{ id: 'cobranca', name: 'Cobrança' }, { id: 'estoque', name: 'Estoque' }]
    })
    expect((await call(mcp, 'list_projects', { project: 'estoque' })).data.current).toBe('estoque')

    const shared = (await call(mcp, 'get_api_catalog', {})).data
    expect(shared).toMatchObject({ project: null, projects: ['cobranca', 'estoque'] })
    expect(shared.connectors.map((c: { id: string }) => c.id)).toEqual(['auth'])
    const estoque = (await call(mcp, 'get_api_catalog', { project: 'estoque' })).data
    expect(estoque.project).toBe('estoque')
    expect(estoque.tree).toContainEqual({ id: 'auth', name: 'Auth', children: [{ id: 'cnpj', name: 'CNPJ' }, { id: 'veiculos', name: 'Veículos' }] })
    expect(estoque.connectors.find((c: { id: string }) => c.id === 'auth').readOnly).toBe('Compartilhado do workspace')
    const cobranca = (await call(mcp, 'get_api_catalog', { project: 'cobranca', connectorId: 'estoque:cnpj' })).data
    expect(cobranca.resolved.auth).toMatchObject({ type: 'login', from: 'auth' })

    // A edição pelo MCP vai para a pasta do projeto pedido.
    const edit = await call(mcp, 'edit_project', { project: 'estoque', ops: [{ op: 'upsertFlow', flow: request('veiculos.placa', 'veiculos', '/placa/X') }] })
    expect(edit.data.changes).toEqual([{ path: 'flows/veiculos.placa.flow.vvpost.json', action: 'create', version: expect.any(String) }])
    expect(existsSync(join(root, 'estoque/flows/veiculos.placa.flow.vvpost.json'))).toBe(true)
    expect((await call(mcp, 'get_api_catalog', { project: 'nada' })).data.error).toContain('projeto "nada" não existe')
  })
})
