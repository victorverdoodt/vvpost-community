import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPiiMasker, loadPrivacy, peopleMasker, piiPlaceholder } from '@vvpost/core/pii'
import {
  peopleExchange,
  peopleFlowReport,
  peopleHttpResult,
  peopleRealtimeEvent,
  peopleScenarioReport,
  peopleWebhookEvent
} from '@vvpost/core/pii-people'
import { DISABLE_FEATURES_ENV, featureDenial } from '@vvpost/core/policy/features'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { createSecretSanitizer } from '@vvpost/core/sanitizer'
import type { FlowRunReport, HttpResult, ScenarioRunReport } from '@shared/ipc'
import { openHistoryStore } from '../src/main/history/store'
import { main, type Io } from '../src/main/cli'

// Dados pessoais mascarados também para pessoas (app e CLI), quando o privacy.json ou a
// organização pedem. Os valores reais continuam indo para a rede.

const CPF = '529.982.247-25'
const EMAIL = 'ana.souza@exemplo.com.br'
const NAME = 'Ana Souza'

const dirs: string[] = []
const servers: Server[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'vvpost-pii-people-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env[DISABLE_FEATURES_ENV]
})
const write = (dir: string, path: string, data: unknown) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
}

const marked = () => {
  const m = createPiiMasker()
  m.addSchema({ properties: { cpf: { 'x-sensitive': 'cpf' }, email: { 'x-sensitive': 'email' }, name: { 'x-sensitive': 'name' } } })
  return m
}

const body = JSON.stringify({ cliente: { name: NAME, cpf: CPF, email: EMAIL, cidade: 'São Paulo' } })
const leaks = (value: unknown) => [NAME, CPF, EMAIL].filter((v) => JSON.stringify(value).includes(v))

describe('visões para pessoas', () => {
  it('Quick Request: corpo, headers, URL enviada, scripts e logs; o resto fica', () => {
    const result: HttpResult = {
      ok: true,
      response: { status: 200, statusText: 'OK', headers: [{ name: 'x-trace', value: 'abc' }, { name: 'cpf', value: CPF }], body, sizeBytes: body.length, truncated: false, timings: { ttfbMs: 1, downloadMs: 0, totalMs: 1 } },
      sent: { method: 'GET', url: `https://crm.exemplo.com/clientes?cpf=${CPF}`, headers: [{ name: 'email', value: EMAIL }] },
      scripts: { tests: [{ name: 'tem cpf', passed: true, message: `achou cpf=${CPF}` }], variables: { cpf: CPF, total: '1' }, logs: `email: "${EMAIL}"` }
    } as unknown as HttpResult
    const out = peopleHttpResult(result, marked())
    expect(leaks(out)).toEqual([])
    expect(out.ok && JSON.parse(out.response.body)).toEqual({ cliente: { name: piiPlaceholder('name'), cpf: piiPlaceholder('cpf'), email: piiPlaceholder('email'), cidade: 'São Paulo' } })
    expect(out.ok && out.response.headers[0]).toEqual({ name: 'x-trace', value: 'abc' })
    expect(out.scripts!.variables['total']).toBe('1')
    expect(out.scripts!.tests[0]!.name).toBe('tem cpf')
    // O original não muda: é o que foi para a rede.
    expect(result.ok && result.response.body).toBe(body)
  })

  it('cenários: o valor das asserções e capturas pelo alvo, sem tocar nos nomes', () => {
    const report = {
      results: [
        {
          connectorId: 'crm',
          endpointId: 'clientes',
          scenarioId: 'ok',
          environmentId: 'Ambiente de teste',
          request: { method: 'GET', url: `https://crm/clientes?cpf=${CPF}` },
          assertions: [
            { target: 'body.cliente.cpf', operator: 'equals', expected: CPF, actual: CPF, passed: true, message: `esperado ${CPF}` },
            { target: 'status', operator: 'equals', expected: 200, actual: 200, passed: true, message: 'ok' }
          ],
          captures: { cpf: CPF, id: '7' },
          bodyPreview: body
        }
      ]
    } as unknown as ScenarioRunReport
    const out = peopleScenarioReport(report, marked())
    expect(leaks(out)).toEqual([])
    const r = out.results[0]!
    expect(r.environmentId).toBe('Ambiente de teste')
    expect(r.assertions[0]).toMatchObject({ actual: piiPlaceholder('cpf'), expected: piiPlaceholder('cpf') })
    expect(r.assertions[1]).toMatchObject({ actual: 200, expected: 200 })
    expect(r.captures).toEqual({ cpf: piiPlaceholder('cpf'), id: '7' })
  })

  it('fluxos: a saída do nó mascara pela chave, o nome do nó fica', () => {
    const report = {
      results: [{ nodeId: 'lista', name: 'Lista', type: 'request', status: 'passed', output: { data: { name: NAME, itens: [{ email: EMAIL }] }, headers: { cpf: CPF } }, logs: `cpf=${CPF}` }]
    } as unknown as FlowRunReport
    const out = peopleFlowReport(report, marked())
    expect(leaks(out)).toEqual([])
    expect(out.results[0]).toMatchObject({ nodeId: 'lista', name: 'Lista' })
  })

  it('histórico, realtime e webhooks', () => {
    const m = marked()
    const x = peopleExchange(
      { sent: { url: `https://x/?email=${EMAIL}`, headers: [], body }, response: { headers: [{ name: 'cpf', value: CPF }], body }, logs: `cpf=${CPF}`, errorMessage: null },
      m
    )
    expect(leaks(x)).toEqual([])
    expect(x.errorMessage).toBeNull()
    const message = peopleRealtimeEvent({ type: 'message', message: { direction: 'in', data: body, binary: false } } as never, m)
    expect(leaks(message)).toEqual([])
    const hook = peopleWebhookEvent({ url: `/hook?cpf=${CPF}`, query: { cpf: CPF, outro: ['1'] }, headers: [{ name: 'email', value: EMAIL }], body }, m)
    expect(leaks(hook)).toEqual([])
    expect(hook.query['outro']).toEqual(['1'])
  })
})

function seed(dir: string, baseUrl = 'https://crm.exemplo.com'): void {
  write(dir, 'schemas/Cliente.schema.json', {
    type: 'object',
    properties: { nome: { type: 'string', 'x-sensitive': 'name' }, cpf: { type: 'string', 'x-sensitive': 'cpf' } }
  })
  write(dir, 'connectors/crm.connector.vvpost.json', {
    $schema: 'https://vvpost.dev/schemas/v1/connector.json',
    id: 'crm',
    name: 'CRM',
    version: '1.0.0',
    config: { baseUrl },
    endpoints: [
      {
        id: 'cliente',
        name: 'Cliente',
        method: 'GET',
        path: '/cliente',
        scenarios: [
          {
            id: 'ok',
            name: 'OK',
            assertions: [
              { target: 'status', operator: 'equals', expected: 200 },
              { target: 'body.cpf', operator: 'equals', expected: 'outro' }
            ]
          }
        ]
      }
    ]
  })
}

describe('peopleMasker', () => {
  it('desligado por padrão; liga pelo privacy.json (com detecção) ou pela política', async () => {
    const dir = tmp()
    seed(dir)
    const ws = await loadWorkspace(dir)
    expect(await peopleMasker(ws, [dir])).toBeNull()
    const byPolicy = await peopleMasker(ws, [dir], true)
    expect(byPolicy!.text(JSON.stringify({ cpf: CPF }))).toBe(JSON.stringify({ cpf: piiPlaceholder('cpf') }))
    expect(byPolicy!.detecting.size).toBe(0)

    write(dir, '.vvpost/privacy.json', { people: { mask: true, detect: ['email'] } })
    const byFile = await peopleMasker(ws, [dir])
    expect(byFile!.text(`fale com ${EMAIL}`)).toBe(`fale com ${piiPlaceholder('email')}`)
    // A detecção para pessoas não liga a do agente, e vice-versa.
    expect((await loadPrivacy([dir])).agent).toEqual([])
  })

  it('detect sem mask não liga a máscara para pessoas', async () => {
    const dir = tmp()
    write(dir, '.vvpost/privacy.json', { people: { mask: false, detect: true } })
    expect((await loadPrivacy([dir])).people).toEqual({ mask: false, detect: [] })
  })

  it('privacy.json inválido é erro, não máscara desligada em silêncio', async () => {
    const dir = tmp()
    write(dir, '.vvpost/privacy.json', { people: { mask: 'sim' } })
    await expect(loadPrivacy([dir])).rejects.toThrow(/inválido/)
  })

  it('a organização desliga a visão dos dados pelo recurso piiVisible', () => {
    expect(featureDenial('piiVisible')).toBeNull()
    process.env[DISABLE_FEATURES_ENV] = 'piiVisible'
    expect(featureDenial('piiVisible')).toMatch(/Dados pessoais/)
  })
})

describe('CLI e histórico', () => {
  async function api(): Promise<string> {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ nome: NAME, cpf: CPF, cidade: 'São Paulo' }))
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  async function cli(args: string[], cwd: string) {
    let stdout = ''
    let stderr = ''
    const io: Io = { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env: {}, cwd, isTTY: false, appDir: cwd }
    const code = await main(args, io)
    return { code, stdout, stderr }
  }

  it('vvpost run mostra os dados como estão, e mascarados com people.mask ou piiVisible desligado', async () => {
    const dir = tmp()
    seed(dir, await api())
    const plain = await cli(['run', '--workspace', dir, '--json', '-'], dir)
    expect(plain.stdout).toContain(CPF)

    write(dir, '.vvpost/privacy.json', { people: { mask: true } })
    const masked = await cli(['run', '--workspace', dir, '--json', '-'], dir)
    expect(masked.code).toBe(plain.code)
    expect(masked.stdout).not.toContain(CPF)
    expect(masked.stdout).toContain(piiPlaceholder('cpf'))

    rmSync(join(dir, '.vvpost/privacy.json'))
    process.env[DISABLE_FEATURES_ENV] = 'piiVisible'
    const policy = await cli(['run', '--workspace', dir, '--json', '-', '--history', 'full', '--history-db', join(dir, 'h.db')], dir)
    expect(policy.stdout).not.toContain(CPF)
    const store = await openHistoryStore(join(dir, 'h.db'))
    const [last] = await store.list({})
    const detail = await store.get(last!.id)
    await store.close()
    expect(JSON.stringify(detail)).not.toContain(CPF)
  })

  it('vvpost run com privacy.json inválido para antes de qualquer requisição', async () => {
    const dir = tmp()
    let hits = 0
    const server = createServer((_req, res) => (hits++, res.end('{}')))
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    seed(dir, `http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    write(dir, '.vvpost/privacy.json', { people: { mask: 'sim' } })
    const out = await cli(['run', '--workspace', dir], dir)
    expect(out.code).toBe(2)
    expect(out.stderr).toMatch(/privacy\.json inválido/)
    expect(hits).toBe(0)
  })

  it('addRun com pii mascara resposta e asserções, e deixa o modelo para reproduzir', async () => {
    const dir = tmp()
    const store = await openHistoryStore(join(dir, 'h.db'))
    const timings = { ttfbMs: 1, downloadMs: 0, totalMs: 1 }
    const id = await store.addRun(
      {
        createdAt: Date.now(),
        source: 'request',
        title: 'GET /cliente',
        outcome: 'passed',
        status: 200,
        durationMs: 1,
        exchanges: [
          {
            createdAt: Date.now(),
            method: 'GET',
            url: 'https://crm/cliente',
            status: 200,
            errorCode: null,
            durationMs: 1,
            sizeBytes: body.length,
            connectorId: null,
            environmentId: null,
            template: { headers: [], body: '{"cpf":"{{cpf}}"}' },
            sent: { url: 'https://crm/cliente', headers: [], body: JSON.stringify({ cpf: CPF }) },
            response: { status: 200, statusText: 'OK', headers: [], body, truncated: false, sizeBytes: body.length, timings },
            assertions: [{ target: 'body.cliente.cpf', operator: 'exists', actual: CPF, passed: true, message: 'ok' }] as never
          }
        ]
      },
      { level: 'full', sanitizer: createSecretSanitizer(), pii: marked() }
    )
    const x = (await store.get(id!))!.exchanges[0]!
    await store.close()
    expect(leaks(x)).toEqual([])
    expect(x.template!.body).toBe('{"cpf":"{{cpf}}"}')
  })
})
