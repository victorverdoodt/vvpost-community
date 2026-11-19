import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { validateFlow, type Connector, type Flow, type FlowOAuth2Node } from '@vvpost/schemas'
import { createAuthEngine, type AuthEngine } from '@vvpost/core/connectors/auth'
import { sendHeadless } from '@vvpost/core/connectors/headless'
import { buildRegistry } from '@vvpost/core/connectors/registry'
import { resolveConnector } from '@vvpost/core/connectors/resolve'
import { loadWorkspace, type LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import { chainBasePath, compileFlows, connectorToFlows } from '@vvpost/core/flows/inherit'
import { runFlow } from '@vvpost/core/flows/run'
import { loadFlows } from '@vvpost/core/flows/workspace'
import { createRequestGuard } from '@vvpost/core/policy/request-policy'
import { createHttpDispatcher, type HttpDispatcher } from '@vvpost/core/http/dispatcher'
import { prepareImport } from '../src/main/importers'
import { applyProjectOps } from '../src/main/project/apply'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vvpost-inherit-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function write(path: string, data: unknown): void {
  const full = join(dir, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}

const base = (over: Partial<Flow> = {}): Flow => ({
  id: 'billing',
  name: 'Billing',
  version: '2.0.0',
  defaults: {
    baseUrl: '{{BASE_URL}}',
    basePath: '/billing/v2',
    headers: { 'X-Tenant': 'acme', Authorization: 'Bearer {{ $nodes.Login.data.token }}' }
  },
  nodes: [
    {
      id: 'login',
      name: 'Login',
      type: 'request',
      cache: { expiresIn: 'data.expires_in' },
      request: { method: 'POST', url: '/auth/login', body: { user: '{{API_USER}}', password: '{{API_PASSWORD}}' } }
    }
  ],
  ...over
})

const charge: Flow = {
  id: 'billing.charge',
  name: 'Cobrar',
  extends: 'billing',
  nodes: [{ id: 'request', name: 'Request', type: 'request', request: { method: 'POST', url: '/charges', body: { amount: 10 } } }],
  scenarios: [{ id: 'ok', name: 'OK', assertions: [{ target: 'status', operator: 'equals', expected: 201 }] }]
}

const files = (...flows: Flow[]) => flows.map((flow) => ({ file: `flows/${flow.id}.flow.vvpost.json`, flow }))

describe('schema do fluxo com herança', () => {
  it('aceita extends, defaults, cache, cenários e exemplos', () => {
    expect(validateFlow(base())).toMatchObject({ ok: true })
    expect(validateFlow({ ...charge, examples: [{ id: 'ok', name: 'OK', status: 201, body: {} }] })).toMatchObject({ ok: true })
  })

  it('valida as partes do conector reusadas pelo $ref e as regras do fluxo', () => {
    const bad = validateFlow({ ...base(), defaults: { auth: { type: 'bearer' } } })
    expect(bad.ok).toBe(false)
    const self = validateFlow({ ...charge, id: 'x', extends: 'x' })
    expect(self.ok || self.issues.map((i) => i.message)).toContain('um fluxo não pode herdar de si mesmo')
    const dup = validateFlow({ ...charge, scenarios: [charge.scenarios![0]!, charge.scenarios![0]!] })
    expect(dup.ok || dup.issues[0]!.message).toMatch(/cenário duplicado/)
    const outside = validateFlow({ ...charge, nodes: [{ ...charge.nodes[0]!, request: { method: 'GET', url: '/x', basePath: false } } as never] })
    expect(outside.ok || outside.issues[0]!.message).toMatch(/basePath: false só vale/)
  })
})

describe('compileFlows', () => {
  it('a base vira conector e o login com cache vira a auth login', () => {
    const out = compileFlows(files(base(), charge), new Map())
    expect(out.issues).toEqual([])
    expect(out.roles.get('billing')).toBe('base')
    expect(out.roles.get('billing.charge')).toBe('request')
    const c = out.bases[0]!.connector
    expect(c.config).toEqual({
      baseUrl: '{{BASE_URL}}',
      basePath: '/billing/v2',
      headers: { 'X-Tenant': 'acme' },
      auth: {
        type: 'login',
        // A url relativa do nó entra depois do basePath da base.
        request: { method: 'POST', url: '/billing/v2/auth/login', json: { user: '{{API_USER}}', password: '{{API_PASSWORD}}' } },
        token: 'body.token',
        expiresIn: 'body.expires_in'
      }
    })
    expect(out.endpoints[0]).toMatchObject({
      connectorId: 'billing',
      endpoint: { id: 'charge', name: 'Cobrar', method: 'POST', path: '/charges', body: { amount: 10 }, scenarios: charge.scenarios }
    })
  })

  it('basePath: false, inject fora do padrão e token num header da resposta', () => {
    const flow = base({
      defaults: { baseUrl: 'https://h', basePath: '/v1', headers: { 'X-Session': 'sid={{ $nodes.Login.headers.x-session }}' } },
      nodes: [{ id: 'l', name: 'Login', type: 'request', cache: { ttlSeconds: 60 }, request: { method: 'POST', url: '/login', basePath: false } }]
    })
    const auth = compileFlows(files(flow), new Map()).bases[0]!.connector.config!.auth
    expect(auth).toEqual({
      type: 'login',
      request: { method: 'POST', url: '/login' },
      token: 'headers.x-session',
      ttlSeconds: 60,
      inject: { in: 'header', name: 'X-Session', value: 'sid={{$token}}' }
    })
  })

  it('o que ainda não tem tradução vira issue, sem derrubar o resto', () => {
    const extra = base({ id: 'extra', nodes: [...base().nodes, { id: 'w', name: 'Espera', type: 'wait', wait: { ms: 1 } }] })
    const noUse = base({ id: 'nouse', defaults: { baseUrl: 'https://h' } })
    const orphan: Flow = { ...charge, id: 'orfao', extends: 'nada' }
    const scenariosOnPlain: Flow = { id: 'plain', name: 'P', nodes: [], scenarios: charge.scenarios }
    const out = compileFlows(files(extra, noUse, orphan, scenariosOnPlain, base(), charge), new Map())
    const messages = out.issues.map((i) => `${i.file}: ${i.message}`)
    expect(messages).toEqual([
      expect.stringContaining('flows/extra.flow.vvpost.json: o fluxo-base "extra" tem o nó "Espera" sem cache'),
      expect.stringContaining('flows/nouse.flow.vvpost.json: fluxo-base "nouse": o nó "Login" tem cache, mas nenhum header'),
      expect.stringContaining('flows/orfao.flow.vvpost.json: "orfao" herda de "nada", que não existe'),
      expect.stringContaining('flows/plain.flow.vvpost.json: cenários e exemplos só valem')
    ])
    expect(out.bases.map((b) => b.connector.id)).toEqual(['billing'])
    expect(out.endpoints.map((e) => e.flowId)).toEqual(['billing.charge'])
  })

  it('id de base fora do formato de conector, ou já usado por um conector, é recusado', () => {
    const upper = base({ id: 'Billing' })
    const taken = base({ id: 'corp' })
    const out = compileFlows(files(upper, taken), new Map([['corp', { id: 'corp', name: 'Corp', version: '1.0.0' } as Connector]]))
    expect(out.issues.map((i) => i.message)).toEqual([
      expect.stringContaining('formato de conector'),
      'id "corp" já é de um conector; o fluxo-base foi ignorado'
    ])
  })

  it('um fluxo de requisição pode herdar de um conector do formato antigo; endpoint repetido fica de fora', () => {
    const corp: Connector = { id: 'corp', name: 'Corp', version: '1.0.0', endpoints: [{ id: 'charge', name: 'X', method: 'GET', path: '/x' }] }
    const out = compileFlows(files({ ...charge, id: 'corp.charge', extends: 'corp' }, { ...charge, id: 'corp.novo', extends: 'corp' }), new Map([['corp', corp]]))
    expect(out.issues.map((i) => i.message)).toEqual(['"corp" já tem o endpoint "charge"; o fluxo "corp.charge" foi ignorado'])
    expect(out.endpoints.map((e) => `${e.connectorId}/${e.endpoint.id}`)).toEqual(['corp/novo'])
  })

  it('um fluxo com mais nós que herda fica como fluxo, com o conector-pai', () => {
    const flow: Flow = {
      id: 'checkout',
      name: 'Checkout',
      extends: 'billing',
      nodes: [
        { id: 'a', name: 'A', type: 'request', request: { method: 'GET', url: '/a' } },
        { id: 'b', name: 'B', type: 'request', request: { method: 'GET', url: '/b' } }
      ],
      edges: [{ from: 'a', to: 'b' }]
    }
    const out = compileFlows(files(base(), flow), new Map())
    expect(out.roles.get('checkout')).toBe('inheriting')
    expect(out.issues).toEqual([])
  })
})

describe('workspace com fluxos', () => {
  it('fluxos-base e de requisição entram no catálogo de conectores, com o arquivo de origem', async () => {
    write('connectors/corp.connector.vvpost.json', { id: 'corp', name: 'Corp', version: '1.0.0', config: { baseUrl: 'https://api.exemplo.com' } })
    write('flows/billing.flow.vvpost.json', base({ extends: 'corp', defaults: { ...base().defaults, baseUrl: undefined } as never }))
    write('flows/billing.charge.flow.vvpost.json', charge)
    write('flows/corp.ping.flow.vvpost.json', { id: 'corp.ping', name: 'Ping', extends: 'corp', nodes: [{ id: 'r', name: 'R', type: 'request', request: { method: 'GET', url: '/ping' } }] })
    const ws = await loadWorkspace(dir)
    expect(ws.issues).toEqual([])
    expect(resolveConnector('billing', ws.connectors)).toMatchObject({ chain: ['corp', 'billing'], baseUrl: 'https://api.exemplo.com', basePath: '/billing/v2' })
    expect(ws.connectors.get('billing')!.endpoints!.map((e) => e.id)).toEqual(['charge'])
    expect(ws.connectors.get('corp')!.endpoints!.map((e) => e.id)).toEqual(['ping'])
    expect(Object.fromEntries(ws.flowSources!)).toEqual({
      billing: 'flows/billing.flow.vvpost.json',
      'billing/charge': 'flows/billing.charge.flow.vvpost.json',
      'corp/ping': 'flows/corp.ping.flow.vvpost.json'
    })
    // A documentação escrita da base fica ao lado do fluxo.
    write('flows/billing.flow.vvpost.md', '# Billing\n\nCobranças.\n')
    const registry = await buildRegistry(await loadWorkspace(dir))
    expect(registry.connectors.find((c) => c.id === 'billing')!.docs).toMatchObject({ file: 'flows/billing.flow.vvpost.md' })
    // O conector do arquivo não ganha o endpoint no disco.
    expect(JSON.parse(readFileSync(join(dir, 'connectors/corp.connector.vvpost.json'), 'utf8')).endpoints).toBeUndefined()
  })
})

describe('equivalência com o formato antigo', () => {
  /** Os schemas compartilhados de cada conjunto que veio de uma spec OpenAPI. */
  const schemasOf = new Map<Connector[], Record<string, Record<string, unknown>>>()
  /** Conectores do workspace de exemplo e de cada fixture de import. */
  async function corpus(): Promise<Connector[][]> {
    const demo = await loadWorkspace(join(__dirname, 'fixtures', 'demo-legacy'))
    const sets: Connector[][] = [[...demo.connectors.values()]]
    // Login, mTLS, scripts e plugin, que o exemplo e os imports não cobrem.
    sets.push([
      {
        id: 'corp',
        name: 'Corp',
        version: '1.0.0',
        config: {
          baseUrl: 'https://api.exemplo.com/api',
          basePath: '/corp',
          headers: { 'X-Org': 'acme' },
          tls: { cert: 'certs/c.pem', key: 'certs/c.key' },
          scripts: { pre: 'vv.request.headers.a = 1' },
          auth: {
            type: 'login',
            request: { url: '/auth/login', json: { user: '{{U}}', password: '{{P}}' }, headers: { 'X-Client': 'vv' } },
            token: 'body.data.token',
            expiresIn: 'body.data.ttl'
          }
        }
      },
      {
        id: 'corp.billing',
        name: 'Billing',
        version: '2.1.0',
        extends: 'corp',
        config: { basePath: '/billing' },
        endpoints: [
          { id: 'charge', name: 'Cobrar', method: 'POST', path: '/charges', payload: { mode: 'multipart', fields: [{ name: 'f', file: 'a.txt' }] }, scripts: { post: 'vv.test("ok", () => {})' } },
          { id: 'rpc', name: 'RPC', method: 'POST', path: '/rpc', plugin: { adapter: 'grpc', config: { service: 'X' } } }
        ]
      },
      { id: 'corp.ntlm', name: 'NTLM', version: '1.0.0', extends: 'corp', config: { auth: { type: 'ntlm', username: 'u', password: '{{P}}' } } },
      { id: 'corp.none', name: 'Sem auth', version: '1.0.0', extends: 'corp', config: { auth: { type: 'none' } }, endpoints: [{ id: 'ping', name: 'Ping', method: 'GET', path: '/ping', query: { a: '1' } }] }
    ])
    const fixtures = join(__dirname, 'fixtures')
    for (const folder of readdirSync(fixtures)) {
      for (const name of readdirSync(join(fixtures, folder))) {
        const prepared = await prepareImport([join(fixtures, folder, name)])
        if (prepared.result.connectors.length) sets.push(prepared.result.connectors)
        if (prepared.result.schemas) schemasOf.set(prepared.result.connectors, prepared.result.schemas)
      }
    }
    return sets
  }

  const sorted = ({ $schema: _, ...c }: Connector) => ({ ...c, endpoints: [...(c.endpoints ?? [])].sort((a, b) => a.id.localeCompare(b.id)) })

  it('converter cada conector em fluxos e ler de volta dá a mesma herança e os mesmos endpoints', async () => {
    const sets = await corpus()
    expect(sets.length).toBeGreaterThan(5)
    let compared = 0
    for (const connectors of sets) {
      const catalog = new Map(connectors.map((c) => [c.id, c]))
      const out = mkdtempSync(join(tmpdir(), 'vvpost-equiv-'))
      try {
        const kept = new Set<string>()
        for (const c of connectors) {
          const flows = connectorToFlows(c, chainBasePath(c.id, catalog))
          if (flows.unsupported.length) {
            kept.add(c.id)
            writeFileSync(join(out, `${c.id}.connector.vvpost.json`), JSON.stringify(c))
            continue
          }
          for (const flow of [flows.base, ...flows.requests]) {
            expect(validateFlow(flow)).toMatchObject({ ok: true })
            mkdirSync(join(out, 'flows'), { recursive: true })
            writeFileSync(join(out, 'flows', `${flow.id}.flow.vvpost.json`), JSON.stringify(flow))
          }
        }
        // Os schemas compartilhados que o import do OpenAPI cria; os conectores comparam como estão nos arquivos.
        for (const [name, schema] of Object.entries(schemasOf.get(connectors) ?? {})) {
          mkdirSync(join(out, 'schemas'), { recursive: true })
          writeFileSync(join(out, 'schemas', `${name}.schema.json`), JSON.stringify(schema))
        }
        const loaded = await loadWorkspace(out)
        expect(loaded.issues).toEqual([])
        const ws = { connectors: new Map([...loaded.connectors].map(([id, c]) => [id, loaded.unresolved?.get(id) ?? c])) }
        for (const c of connectors) {
          // Uma herança que já não resolvia (conflito do próprio import) tem que falhar igual.
          const resolved = (map: ReadonlyMap<string, Connector>) => {
            try {
              const r = structuredClone(resolveConnector(c.id, map))
              // O login sem method é POST; o fluxo sempre escreve o method.
              if (r.auth?.config.type === 'login') r.auth.config.request.method ??= 'POST'
              return { ...r, endpoints: sorted(r as never).endpoints }
            } catch (err) {
              return { error: (err as Error).message }
            }
          }
          expect(resolved(ws.connectors)).toEqual(resolved(catalog))
          if (!kept.has(c.id) && c.config?.auth?.type !== 'login') expect(sorted(ws.connectors.get(c.id)!)).toEqual(sorted(c))
          compared++
        }
      } finally {
        rmSync(out, { recursive: true, force: true })
      }
    }
    expect(compared).toBeGreaterThan(10)
  })

  it('o login com basePath na cadeia volta igual (basePath: false)', () => {
    const c: Connector = {
      id: 'svc',
      name: 'Svc',
      version: '1.0.0',
      config: {
        baseUrl: 'https://h',
        basePath: '/v1',
        auth: { type: 'login', request: { url: '/auth', form: { u: '{{U}}' } }, token: 'body.t', inject: { in: 'header', name: 'X-Token', value: '{{$token}}' } }
      }
    }
    const flows = connectorToFlows(c, '/v1')
    expect(flows.base.nodes[0]).toMatchObject({ cache: {}, request: { method: 'POST', basePath: false, payload: { mode: 'urlencoded' } } })
    const back = compileFlows([{ file: 'f', flow: flows.base }], new Map()).bases[0]!.connector
    expect(back.config!.auth).toEqual({ ...c.config!.auth, request: { method: 'POST', url: '/auth', form: { u: '{{U}}' } } })
  })
})

describe('desempenho', () => {
  it('um projeto com mil fluxos de requisição carrega rápido', async () => {
    for (let i = 0; i < 20; i++) {
      const c: Connector = {
        id: `svc${i}`,
        name: `Serviço ${i}`,
        version: '1.0.0',
        config: { baseUrl: 'https://api.exemplo.com', basePath: `/s${i}` },
        endpoints: Array.from({ length: 50 }, (_, j) => ({ id: `e${j}`, name: `E${j}`, method: 'POST' as const, path: `/x/${j}`, body: { a: j } }))
      }
      const flows = connectorToFlows(c)
      for (const flow of [flows.base, ...flows.requests]) write(`flows/${c.id}/${flow.id}.flow.vvpost.json`, flow)
    }
    await loadWorkspace(dir)
    const start = performance.now()
    const ws = await loadWorkspace(dir)
    const ms = performance.now() - start
    expect(ws.issues).toEqual([])
    expect([...ws.connectors.values()].reduce((n, c) => n + (c.endpoints?.length ?? 0), 0)).toBe(1000)
    // ~25 ms numa máquina comum; o limite só pega uma regressão grosseira (leitura um a um, O(n²)).
    expect(ms).toBeLessThan(1000)
  })
})

describe('execução', () => {
  let server: Server
  let origin: string
  let http: HttpDispatcher
  let engine: AuthEngine
  const seen: { path: string; auth?: string; tenant?: string }[] = []
  let logins = 0

  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(data))
  }
  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      seen.push({ path, auth: req.headers.authorization, tenant: req.headers['x-tenant'] as string | undefined })
      if (path === '/billing/v2/auth/login') {
        logins++
        return json(res, 200, { token: 'tok-1', expires_in: 3600 })
      }
      if (req.headers.authorization !== 'Bearer tok-1') return json(res, 401, { error: 'unauthorized' })
      return json(res, 201, { ok: true, path })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    http = createHttpDispatcher()
  })
  afterAll(async () => {
    await http.close()
    server.close()
  })

  async function workspace(): Promise<LoadedWorkspace> {
    engine = createAuthEngine()
    seen.length = 0
    logins = 0
    write('flows/billing.flow.vvpost.json', base())
    write('flows/billing.charge.flow.vvpost.json', charge)
    write('environments/dev.env.json', {
      id: 'env.dev',
      name: 'Dev',
      variables: {
        BASE_URL: { type: 'string', value: origin },
        API_USER: { type: 'string', value: 'ana' },
        API_PASSWORD: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
      }
    })
    write('.vvpost/secrets.local.json', { 'env.dev': { API_PASSWORD: 'pw' } })
    return loadWorkspace(dir)
  }

  it('o endpoint de um fluxo de requisição faz o login da base uma vez e herda os headers', async () => {
    const ws = await workspace()
    for (let i = 0; i < 2; i++) {
      const result = await sendHeadless(
        { id: `r${i}`, method: 'POST', url: '/charges', headers: [], body: '{}', connectorId: 'billing', environmentId: 'env.dev' },
        { workspace: ws, auth: engine, http }
      )
      expect(result.ok && result.response.status).toBe(201)
    }
    expect(logins).toBe(1)
    expect(seen.filter((s) => s.path === '/billing/v2/charges')).toEqual([
      { path: '/billing/v2/charges', auth: 'Bearer tok-1', tenant: 'acme' },
      { path: '/billing/v2/charges', auth: 'Bearer tok-1', tenant: 'acme' }
    ])
  })

  it('rodar o fluxo de requisição usa a base; rodar a base testa o login, sem o token no resultado', async () => {
    const ws = await workspace()
    const report = await runFlow({ runId: 'r', flow: charge, environmentId: 'env.dev' }, { workspace: ws, auth: engine, http })
    expect(report.outcome).toBe('success')
    expect(report.results[0]!.output).toMatchObject({ status: 201, data: { path: '/billing/v2/charges' } })
    const alone = await runFlow({ runId: 'b', flow: base(), environmentId: 'env.dev' }, { workspace: ws, auth: engine, http })
    expect(alone).toMatchObject({
      outcome: 'success',
      results: [{ nodeId: 'login', name: 'Login', status: 'success', auth: { type: 'login', from: 'billing', source: 'fetched' }, output: { data: { result: 'token obtido', from: 'billing' } } }]
    })
    expect(JSON.stringify(alone)).not.toContain('tok-1')
    // Rodar a base pede um token novo de verdade: é o teste do login.
    expect(logins).toBe(2)
    const denied = await runFlow(
      { runId: 'c', flow: base(), environmentId: 'env.dev' },
      { workspace: ws, auth: engine, http, guard: createRequestGuard({ actor: 'a IA (MCP)', allowEnvironments: new Set(['hml']) }) }
    )
    expect(denied.results[0]).toMatchObject({ status: 'error', error: { code: 'POLICY_DENIED' } })
    expect(logins).toBe(2)
  })
})

describe('escrita do projeto', () => {
  beforeEach(() => {
    write('connectors/corp.connector.vvpost.json', { id: 'corp', name: 'Corp', version: '1.0.0', config: { baseUrl: 'https://api.exemplo.com' } })
    write('flows/billing.flow.vvpost.json', base({ extends: 'corp' }))
    write('flows/billing.charge.flow.vvpost.json', charge)
    write('flows/corp.ping.flow.vvpost.json', { id: 'corp.ping', name: 'Ping', extends: 'corp', nodes: [{ id: 'r', name: 'R', type: 'request', request: { method: 'GET', url: '/ping' } }] })
  })

  it('operações de conector num fluxo-base gravam nos fluxos, só o que mudou', async () => {
    const read = (file: string) => readFileSync(join(dir, file), 'utf8')
    const chargeBefore = read('flows/billing.charge.flow.vvpost.json')
    const authBefore = resolveConnector('billing', (await loadWorkspace(dir)).connectors).auth
    const r1 = await applyProjectOps(dir, [
      { op: 'patchConnector', id: 'billing', set: { name: 'Cobrança' } },
      { op: 'upsertEndpoint', connectorId: 'billing', endpoint: { id: 'refund', name: 'Estornar', method: 'POST', path: '/refunds' } },
      { op: 'upsertScenario', connectorId: 'billing', endpointId: 'refund', scenario: { id: 'ok', name: 'OK', assertions: [{ target: 'status', operator: 'equals', expected: 201 }] } },
      { op: 'writeDoc', connectorId: 'billing', markdown: '# Cobrança\n' }
    ])
    expect(r1.errors).toEqual([])
    expect(r1.changes.map((c) => [c.path, c.action])).toEqual([
      ['flows/billing.flow.vvpost.json', 'update'],
      ['flows/billing.flow.vvpost.md', 'create'],
      ['flows/billing.refund.flow.vvpost.json', 'create']
    ])
    expect(read('flows/billing.charge.flow.vvpost.json')).toBe(chargeBefore)
    // Trocar o nome não reescreve o resto da base.
    expect(JSON.parse(read('flows/billing.flow.vvpost.json'))).toEqual({ $schema: expect.any(String), ...base({ extends: 'corp' }), name: 'Cobrança' })
    const ws = await loadWorkspace(dir)
    expect(ws.issues).toEqual([])
    expect(ws.connectors.get('billing')).toMatchObject({ name: 'Cobrança', extends: 'corp' })
    expect(ws.connectors.get('billing')!.endpoints!.map((e) => [e.id, e.scenarios?.length])).toEqual([
      ['charge', 1],
      ['refund', 1]
    ])
    // A auth continua a da base: o login não muda com a edição do conector.
    expect(resolveConnector('billing', ws.connectors).auth).toEqual(authBefore)

    const r2b = await applyProjectOps(dir, [{ op: 'deleteEndpoint', connectorId: 'billing', endpointId: 'charge' }])
    expect(r2b.changes.map((c) => [c.path, c.action])).toEqual([['flows/billing.charge.flow.vvpost.json', 'delete']])
    const r2c = await applyProjectOps(dir, [{ op: 'moveConnector', id: 'billing', newId: 'billing2' }])
    expect(r2c.errors[0]!.message).toBe('"billing" é um fluxo-base (flows/billing.flow.vvpost.json): renomeie ou mova o fluxo com upsertFlow')
    const r2d = await applyProjectOps(dir, [{ op: 'migrateConnector', id: 'billing' }])
    expect(r2d.errors[0]!.message).toBe('"billing" já é um fluxo-base')
    const r2e = await applyProjectOps(dir, [{ op: 'deleteConnector', id: 'billing' }])
    expect(r2e.errors).toEqual([])
    expect(r2e.changes.map((c) => [c.path, c.action])).toEqual([
      ['flows/billing.flow.vvpost.json', 'delete'],
      ['flows/billing.flow.vvpost.md', 'delete'],
      ['flows/billing.refund.flow.vvpost.json', 'delete']
    ])
  })

  it('num endpoint de fluxo de um conector do formato antigo, as operações pedem para editar o fluxo', async () => {
    const r2 = await applyProjectOps(dir, [{ op: 'upsertEndpoint', connectorId: 'corp', endpoint: { id: 'ping', name: 'P', method: 'GET', path: '/p' } }])
    expect(r2.errors[0]!.message).toBe('"corp" já tem o endpoint "ping" no fluxo de requisição flows/corp.ping.flow.vvpost.json')
    const r3 = await applyProjectOps(dir, [{ op: 'deleteConnector', id: 'corp' }])
    expect(r3.errors[0]!.message).toBe('"corp" tem filhos (billing, corp.ping); mova ou apague os filhos antes')
  })

  it('gravar o conector do formato antigo não leva os endpoints dos fluxos; renomear leva o extends dos fluxos', async () => {
    const r = await applyProjectOps(dir, [{ op: 'moveConnector', id: 'corp', newId: 'corp2' }])
    expect(r.errors).toEqual([])
    const saved = JSON.parse(readFileSync(join(dir, 'connectors/corp2.connector.vvpost.json'), 'utf8'))
    expect(saved.endpoints).toBeUndefined()
    expect(JSON.parse(readFileSync(join(dir, 'flows/billing.flow.vvpost.json'), 'utf8')).extends).toBe('corp2')
    expect(JSON.parse(readFileSync(join(dir, 'flows/corp.ping.flow.vvpost.json'), 'utf8')).extends).toBe('corp2')
    expect((await loadWorkspace(dir)).issues).toEqual([])
  })

  it('a IA trocar o login de uma base pede revisão, como num conector', async () => {
    const changed = base({ extends: 'corp' })
    ;(changed.nodes[0] as { request: { url: string } }).request.url = 'https://outro.exemplo.com/login'
    const r = await applyProjectOps(dir, [{ op: 'upsertFlow', flow: changed }], { actor: 'ai' })
    expect(r.errors).toEqual([])
    expect(r.review).toContain('billing')
  })
})


describe('nó oauth2 na base', () => {
  let server: Server
  let origin: string
  let http: HttpDispatcher
  let grants = 0
  const seen: { path: string; auth?: string }[] = []
  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      seen.push({ path, ...(req.headers.authorization && { auth: req.headers.authorization }) })
      res.setHeader('content-type', 'application/json')
      if (path === '/oauth/token') {
        grants++
        return res.end(JSON.stringify({ access_token: `oa-${grants}`, token_type: 'Bearer', expires_in: 3600 }))
      }
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    http = createHttpDispatcher()
  })
  afterAll(async () => {
    await http.close()
    server.close()
  })

  const oauthBase = (): Flow => ({
    id: 'payments',
    name: 'Payments',
    defaults: { baseUrl: '{{BASE_URL}}' },
    nodes: [
      {
        id: 'oauth2',
        name: 'OAuth2',
        type: 'oauth2',
        oauth2: { type: 'oauth2', grantType: 'client_credentials', tokenUrl: '/oauth/token', clientId: 'app', clientSecret: '{{CLIENT_SECRET}}' }
      }
    ]
  })

  it('vira a auth oauth2 do conector, e o conector com oauth2 volta como nó', () => {
    const compiled = compileFlows([{ file: 'flows/payments.flow.vvpost.json', flow: oauthBase() }], new Map())
    expect(compiled.issues).toEqual([])
    const [node] = oauthBase().nodes as FlowOAuth2Node[]
    expect(compiled.bases[0]!.connector.config).toEqual({ baseUrl: '{{BASE_URL}}', auth: node!.oauth2 })
    const back = connectorToFlows(compiled.bases[0]!.connector)
    expect(back.base.nodes).toEqual(oauthBase().nodes)
    expect(back.base.defaults).toEqual({ baseUrl: '{{BASE_URL}}' })

    const both = compileFlows(
      [{ file: 'a.flow.vvpost.json', flow: { ...oauthBase(), defaults: { auth: { type: 'bearer', token: '{{T}}' } } } }],
      new Map()
    )
    expect(both.issues[0]!.message).toContain('também defaults.auth')
    const loose = compileFlows([{ file: 'b.flow.vvpost.json', flow: { ...oauthBase(), id: 'loose', defaults: undefined } as Flow }], new Map())
    expect(loose.issues[0]!.message).toContain('só vale num fluxo-base')
  })

  it('rodar a base pede o token; as requisições que herdam usam o mesmo token', async () => {
    write('flows/payments.flow.vvpost.json', oauthBase())
    write('flows/payments.list.flow.vvpost.json', { id: 'payments.list', name: 'Listar', extends: 'payments', nodes: [{ id: 'request', name: 'Request', type: 'request', request: { method: 'GET', url: '/payments' } }] })
    write('environments/dev.env.json', {
      id: 'dev',
      name: 'Dev',
      variables: { BASE_URL: { type: 'string', value: origin }, CLIENT_SECRET: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true } }
    })
    write('.vvpost/secrets.local.json', { dev: { CLIENT_SECRET: 'cs' } })
    const ws = await loadWorkspace(dir)
    const engine = createAuthEngine()
    const alone = await runFlow({ runId: 'b', flow: oauthBase(), environmentId: 'dev' }, { workspace: ws, auth: engine, http })
    expect(alone).toMatchObject({ outcome: 'success', results: [{ name: 'OAuth2', status: 'success', auth: { type: 'oauth2', from: 'payments' } }] })
    expect(JSON.stringify(alone)).not.toContain('oa-1')
    const list = (await loadFlows(dir)).flows.find((f) => f.flow.id === 'payments.list')!.flow
    expect((await runFlow({ runId: 'r', flow: list, environmentId: 'dev' }, { workspace: ws, auth: engine, http })).outcome).toBe('success')
    expect(grants).toBe(1)
    expect(seen.at(-1)).toEqual({ path: '/payments', auth: 'Bearer oa-1' })
  })
})
