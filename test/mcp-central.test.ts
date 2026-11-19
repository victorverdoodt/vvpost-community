import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { createHttpDispatcher, type HttpDispatcher } from '@vvpost/core/http/dispatcher'
import type { AgentPolicy, AgentPolicyState, AgentReviewItem, AgentReviewRequest, AgentSession, AgentToolCallEvent } from '../src/main/enterprise/control-plane'
import { centralAgentPolicy, effectiveAgentPolicy, openAgentSession, toolCallEvent } from '../src/main/mcp/central'
import { createMcpServer, type JsonRpcResponse, type McpServer } from '../src/main/mcp/server'
import { addReviewMarks, applyApprovedReview, readReviewMarks, reviewSnapshot } from '../src/main/project/review'
import { EnterpriseModuleMissingError, type EnterpriseSecretsModule } from '../src/main/secret-engine/backend'

let dir: string
let api: Server
let origin: string
let http: HttpDispatcher
let hits = 0

function write(path: string, data: unknown): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), JSON.stringify(data, null, 2))
}

const env = (id: string) => ({ id, name: id.toUpperCase(), variables: { BASE_URL: { type: 'string', value: origin } } })

/** Sessão falsa do módulo Enterprise: a política em vigor, os eventos e os pedidos de revisão. */
function fakeSession(initial: AgentPolicyState) {
  let state = initial
  const events: (AgentToolCallEvent & { at: string })[] = []
  const requests: (AgentReviewRequest & { asked: AgentReviewItem[] })[] = []
  const session: AgentSession = {
    state: () => state,
    ready: async () => state,
    record: (e) => events.push(e),
    async requestReview({ items }) {
      const r = { id: requests.length + 1, status: 'pending' as const, items: items.map(({ key, hash }) => ({ key, hash })), asked: items }
      requests.push(r)
      return r
    },
    reviews: async (ids) => requests.filter((r) => ids.includes(r.id)),
    close: async () => {}
  }
  return { session, events, requests, set: (s: AgentPolicyState) => (state = s) }
}

const active = (policy: AgentPolicy): AgentPolicyState => ({ status: 'active', policy, fetchedAt: new Date().toISOString(), source: 'cp.test/payments' })

let nextId = 1
async function call(server: McpServer, name: string, args: Record<string, unknown>) {
  const reply = (await server.handle({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } })) as JsonRpcResponse
  const result = reply.result as { content: { text: string }[]; isError: boolean }
  return { data: JSON.parse(result.content[0]!.text) as Record<string, any>, isError: result.isError, text: result.content[0]!.text }
}

beforeAll(async () => {
  api = createServer((req, res) => {
    hits++
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, cpf: '123.456.789-09' }))
    })
  })
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
  dir = mkdtempSync(join(tmpdir(), 'vvpost-mcp-central-'))
  write('connectors/billing.connector.vvpost.json', {
    id: 'billing',
    name: 'Billing',
    version: '1.0.0',
    config: { baseUrl: '{{BASE_URL}}' },
    endpoints: [
      { id: 'get', name: 'Ler', method: 'GET', path: '/x', scenarios: [{ id: 'ok', name: 'OK', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }] },
      { id: 'post', name: 'Criar', method: 'POST', path: '/x', body: { a: 1 }, scenarios: [{ id: 'ok', name: 'OK', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }] }
    ]
  })
  write('environments/dev.env.json', env('dev'))
  write('environments/hml.env.json', env('hml'))
  http = createHttpDispatcher()
})

afterAll(async () => {
  await http.close()
  await new Promise((r) => api.close(r))
  rmSync(dir, { recursive: true, force: true })
})

describe('política do agente: efetiva', () => {
  it('sem Control Plane, só as flags locais', () => {
    const p = effectiveAgentPolicy({ readOnly: true, allowEnvironments: new Set(['dev']) }, { status: 'none' })
    expect(p).toMatchObject({ readOnly: true, noWrite: false, centralReview: false, piiDetect: false })
    expect([...p.allowEnvironments!]).toEqual(['dev'])
    expect(p.restrictedBy).toBeUndefined()
  })

  it('a central só restringe: cruza listas, soma proibições e fica com o menor limite', () => {
    const p = effectiveAgentPolicy(
      { allowMethods: new Set(['GET', 'POST']), allowEnvironments: new Set(['dev', 'hml']), limits: { rate: { requests: 10, perMs: 60_000 } } },
      active({ allowMethods: ['get', 'DELETE'], allowEnvironments: ['hml', 'prod'], noWrite: true, requestsPerMinute: 30, maxConcurrent: 2, reviewApprovers: ['Admin'], piiDetection: true })
    )
    expect([...p.allowMethods!]).toEqual(['GET'])
    expect([...p.allowEnvironments!]).toEqual(['hml'])
    expect(p).toMatchObject({ readOnly: false, noWrite: true, centralReview: true, piiDetect: true })
    // A flag local pediu 10/min: a central (30/min) não afrouxa.
    expect(p.limits.rate).toEqual({ requests: 10, perMs: 60_000 })
    expect(p.limits.maxConcurrent).toBe(2)
    const tighter = effectiveAgentPolicy({}, active({ requestsPerMinute: 5 }))
    expect(tighter.limits.rate).toEqual({ requests: 5, perMs: 60_000 })
    // Campo ausente na central: a flag local continua valendo.
    expect([...effectiveAgentPolicy({ allowEnvironments: new Set(['dev']) }, active({})).allowEnvironments!]).toEqual(['dev'])
  })

  it('sem política válida, o modo mais restrito (fail-closed)', () => {
    const p = effectiveAgentPolicy({}, { status: 'unavailable', reason: 'sem login' })
    expect(p).toMatchObject({ readOnly: true, noWrite: true, centralReview: true, piiDetect: true })
    expect(p.allowEnvironments!.size).toBe(0)
    expect(p.restrictedBy).toMatch(/sem login/)
  })
})

describe('política do agente: servidor MCP', () => {
  it('restringe as flags locais e muda a cada chamada', async () => {
    const fake = fakeSession(active({ allowMethods: ['GET'] }))
    const server = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine(), central: centralAgentPolicy(fake.session), surface: 'stdio' })
    const post = await call(server, 'execute_dry_run', { connectorId: 'billing', environmentIds: ['dev'], request: { endpointId: 'post' } })
    expect(post.isError).toBe(true)
    expect(post.data.error).toMatch(/não pode usar POST|POST/)
    const before = hits
    const get = await call(server, 'execute_dry_run', { connectorId: 'billing', environmentIds: ['dev'], request: { endpointId: 'get' } })
    expect(get.isError).toBe(false)
    expect(hits).toBe(before + 1)
    // A política nova vale na próxima chamada, sem reiniciar o servidor.
    fake.set(active({ readOnly: true }))
    const plan = await call(server, 'execute_dry_run', { connectorId: 'billing', environmentIds: ['dev'], request: { endpointId: 'get' } })
    expect(plan.data.mode).toBe('plan')
    expect(hits).toBe(before + 1)
  })

  it('fail-closed: sem política, nada sai e nada é gravado, mas o catálogo continua legível', async () => {
    const fake = fakeSession({ status: 'unavailable', reason: 'Control Plane fora do ar' })
    const server = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine(), central: centralAgentPolicy(fake.session) })
    const before = hits
    const run = await call(server, 'execute_dry_run', { connectorId: 'billing', environmentIds: ['dev'], request: { endpointId: 'get' } })
    expect(run.data.mode).toBe('plan')
    expect(hits).toBe(before)
    const edit = await call(server, 'edit_project', { ops: [{ op: 'setVariable', environmentId: 'dev', name: 'X', value: '1' }] })
    expect(edit.isError).toBe(true)
    expect(edit.data).toMatchObject({ code: 'BLOCKED', policy: expect.stringContaining('Control Plane fora do ar'), hint: expect.stringMatching(/Não contorne editando os arquivos/) })
    const catalog = await call(server, 'get_api_catalog', { view: 'summary' })
    expect(catalog.isError).toBe(false)
  })

  it('a política que cai e volta no meio da sessão aparece no log do processo, uma vez por mudança', async () => {
    const fake = fakeSession(active({}))
    const lines: string[] = []
    const server = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine(), central: centralAgentPolicy(fake.session), log: (l) => lines.push(l) })
    await call(server, 'get_api_catalog', { view: 'summary' })
    expect(lines.filter((l) => /política do agente/.test(l))).toEqual([])
    fake.set({ status: 'unavailable', reason: 'a sessão corporativa terminou' })
    await call(server, 'get_api_catalog', { view: 'summary' })
    await call(server, 'get_api_catalog', { view: 'summary' })
    fake.set(active({}))
    await call(server, 'get_api_catalog', { view: 'summary' })
    const notes = lines.filter((l) => /política do agente/.test(l))
    expect(notes).toHaveLength(2)
    expect(notes[0]).toMatch(/^AVISO: .*sessão corporativa terminou.*edição e disparos bloqueados/)
    expect(notes[1]).toMatch(/de volta/)
  })

  it('ambiente protegido pela política (por id) só aceita plan, nem com "protected": false no arquivo', async () => {
    write('environments/hml.env.json', { ...env('hml'), protected: false })
    try {
      const fake = fakeSession(active({ protectedEnvironments: ['hml'] }))
      const server = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine(), central: centralAgentPolicy(fake.session) })
      const run = await call(server, 'execute_dry_run', { connectorId: 'billing', environmentIds: ['hml'], request: { endpointId: 'get' } })
      expect(run.isError).toBe(true)
      expect(run.data.error).toMatch(/"hml" é ambiente protegido/)
      const catalog = await call(server, 'get_api_catalog', {})
      expect(catalog.data.environments.find((e: { id: string }) => e.id === 'hml').protected).toBe(true)
    } finally {
      write('environments/hml.env.json', env('hml'))
    }
  })

  it('a política força o mascaramento de dados pessoais pelo formato', async () => {
    const fake = fakeSession(active({}))
    const server = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine(), central: centralAgentPolicy(fake.session) })
    const args = { connectorId: 'billing', environmentIds: ['dev'], request: { endpointId: 'get' } }
    expect((await call(server, 'execute_dry_run', args)).text).toContain('123.456.789-09')
    fake.set(active({ piiDetection: true }))
    expect((await call(server, 'execute_dry_run', args)).text).not.toContain('123.456.789-09')
  })

  it('um evento por chamada, só com identificadores e o resultado', async () => {
    const fake = fakeSession(active({ allowMethods: ['GET'] }))
    const server = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine(), central: centralAgentPolicy(fake.session), surface: 'app' })
    await call(server, 'execute_dry_run', {
      connectorId: 'billing',
      environmentIds: ['dev'],
      request: { endpointId: 'post', overrides: { body: { cartao: '4111111111111111' }, headers: { Authorization: 'Bearer abc' } } }
    })
    await call(server, 'get_api_catalog', { view: 'summary' })
    expect(fake.events).toHaveLength(2)
    expect(fake.events[0]).toMatchObject({
      kind: 'mcpToolCall',
      action: 'execute_dry_run',
      surface: 'app',
      connectorId: 'billing',
      endpointId: 'post',
      environments: ['dev'],
      outcome: 'error'
    })
    expect(fake.events[1]).toMatchObject({ action: 'get_api_catalog', outcome: 'ok' })
    const text = JSON.stringify(fake.events)
    expect(text).not.toContain('4111')
    expect(text).not.toContain('Bearer')
    expect(text).not.toContain('overrides')
  })

  it('toolCallEvent descarta o que não é identificador', () => {
    const e = toolCallEvent('execute_dry_run', { connectorId: 'tem espaço e {{SEGREDO}}', environmentId: 'dev', project: 'p1' }, 'stdio', { ms: 12.4, errorCode: 'BLOCKED' })
    expect(e).toEqual({ kind: 'mcpToolCall', action: 'execute_dry_run', surface: 'stdio', workspaceProject: 'p1', environments: ['dev'], outcome: 'denied', errorCode: 'BLOCKED', durationMs: 12 })
  })
})

describe('revisão central', () => {
  it('abre o pedido no console e aplica só a aprovação do conteúdo pedido', async () => {
    await addReviewMarks(dir, ['billing'], new Date(), { billing: 'auth: nenhuma · destino: x' })
    const fake = fakeSession(active({ reviewApprovers: ['Admin'] }))
    let clock = 0
    const central = centralAgentPolicy(fake.session, () => {}, () => clock)
    const server = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine(), central })
    const blocked = await call(server, 'execute_dry_run', { connectorId: 'billing', environmentIds: ['dev'], request: { endpointId: 'get' } })
    expect(blocked.isError).toBe(true)
    expect(blocked.data.error).toMatch(/console do Control Plane/)
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]!.asked[0]).toMatchObject({ key: 'billing', kind: 'connector', reason: 'auth: nenhuma · destino: x' })
    expect((await readReviewMarks(dir))['billing']!.request).toBe(1)

    // Sem mudança, não abre outro pedido; aprovado no console, a marca sai na próxima chamada.
    fake.requests[0]!.status = 'approved'
    clock += 20_000
    const run = await call(server, 'execute_dry_run', { connectorId: 'billing', environmentIds: ['dev'], request: { endpointId: 'get' } })
    expect(run.isError).toBe(false)
    expect(fake.requests).toHaveLength(1)
    expect((await readReviewMarks(dir))['billing']).toBeUndefined()
  })

  it('aprovação de outro conteúdo não vale', async () => {
    await addReviewMarks(dir, ['billing'])
    const [item] = await reviewSnapshot(dir)
    expect(await applyApprovedReview(dir, [{ key: 'billing', hash: 'outro' }])).toEqual({ applied: [], stale: ['billing'] })
    expect(await applyApprovedReview(dir, [{ key: 'billing', hash: item!.hash }])).toEqual({ applied: ['billing'], stale: [] })
  })
})

describe('módulo Enterprise', () => {
  it('sem módulo ou sem agent, não há sessão', async () => {
    expect(await openAgentSession({ surface: 'stdio' }, async () => Promise.reject(new EnterpriseModuleMissingError()))).toBeNull()
    const mod = { apiVersion: 1, createBackend: async () => ({}), audit: async () => {}, controlPlane: { activity: () => {} } } as unknown as EnterpriseSecretsModule
    expect(await openAgentSession({ surface: 'stdio' }, async () => mod)).toBeNull()
  })

  it('workspace que declara a organização: sem módulo, com módulo antigo ou sem Control Plane, fica restrito', async () => {
    const declared = { controlPlane: 'https://cp.contoso.com', project: 'payments' }
    const missing = await openAgentSession({ surface: 'stdio' }, async () => Promise.reject(new EnterpriseModuleMissingError()), declared)
    expect(await missing!.ready()).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/cp\.contoso\.com.*não está instalado/) })
    const old = { apiVersion: 1, createBackend: async () => ({}), audit: async () => {}, controlPlane: { activity: () => {} } } as unknown as EnterpriseSecretsModule
    expect(await (await openAgentSession({ surface: 'stdio' }, async () => old, declared))!.ready()).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/atualize/) })

    const used: unknown[] = []
    const active: AgentPolicyState = { status: 'active', source: 'cp.contoso.com/payments', policy: {}, fetchedAt: '2026-10-26T00:00:00Z' }
    const withOrg = {
      ...old,
      organization: { use: (ref: unknown) => used.push(ref), register: async () => ({ name: 'x', controlPlane: '' }) },
      controlPlane: { activity: () => {}, agent: { open: async () => ({ state: () => active, ready: async () => active, record: () => {}, requestReview: async () => ({}), reviews: async () => [], close: async () => {} }) } }
    } as unknown as EnterpriseSecretsModule
    expect(await (await openAgentSession({ surface: 'stdio' }, async () => withOrg, declared))!.ready()).toEqual(active)
    expect(used).toEqual([declared])
    const noAgent = { ...withOrg, controlPlane: { activity: () => {} } } as unknown as EnterpriseSecretsModule
    expect(await (await openAgentSession({ surface: 'stdio' }, async () => noAgent, declared))!.ready()).toMatchObject({ status: 'unavailable' })
  })
})

describe('.vvpost/organization.json', () => {
  it('o projeto vence a raiz; URL sem HTTPS, com credencial ou projeto inválido é erro', async () => {
    const { readOrganization } = await import('../src/main/enterprise/organization')
    const root = mkdtempSync(join(tmpdir(), 'vvpost-org-'))
    const project = join(root, 'pagamentos')
    const put = (d: string, v: unknown) => {
      mkdirSync(join(d, '.vvpost'), { recursive: true })
      writeFileSync(join(d, '.vvpost/organization.json'), typeof v === 'string' ? v : JSON.stringify(v))
    }
    try {
      mkdirSync(project)
      expect(await readOrganization([project, root])).toBeNull()
      put(root, { controlPlane: 'https://cp.contoso.com/', project: 'org-wide' })
      expect(await readOrganization([project, root])).toEqual({ controlPlane: 'https://cp.contoso.com', project: 'org-wide' })
      put(project, { controlPlane: 'https://cp.contoso.com', project: 'payments', environment: 'hml' })
      expect(await readOrganization([project, root])).toEqual({ controlPlane: 'https://cp.contoso.com', project: 'payments', environment: 'hml' })
      put(project, { controlPlane: 'http://cp.contoso.com' })
      await expect(readOrganization([project, root])).rejects.toThrow(/HTTPS/)
      put(project, { controlPlane: 'https://u:p@cp.contoso.com' })
      await expect(readOrganization([project, root])).rejects.toThrow(/sem usuário ou senha/)
      put(project, { controlPlane: 'https://cp.contoso.com', project: 'Pagamentos' })
      await expect(readOrganization([project, root])).rejects.toThrow(/project não é uma chave válida/)
      put(project, '{')
      await expect(readOrganization([project, root])).rejects.toThrow(/JSON inválido/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
