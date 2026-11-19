import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { main, type Io } from '../src/main/cli'
import { junitReport } from '../src/main/cli/reporters'
import { applyCiValues, secretsFromProcessEnv } from '../src/main/cli/secrets'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { defaultUserDataDir } from '@vvpost/core/paths'
import { openHistoryStore } from '../src/main/history/store'

// Gerados a cada execução: nenhum valor com cara de credencial fica commitado.
const API_TOKEN = `tok-${randomBytes(8).toString('hex')}`
const CI_TOKEN = `ci-${randomBytes(8).toString('hex')}`
const COOKIE = `sessao-${randomBytes(8).toString('hex')}`

let server: Server
let origin = ''
let root = ''
let workspace = ''

const put = (path: string, data: unknown) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      const reply = (status: number, data: unknown) => {
        res.statusCode = status
        res.end(JSON.stringify(data))
      }
      const auth = req.headers.authorization
      if (auth !== `Bearer ${API_TOKEN}` && auth !== `Bearer ${CI_TOKEN}`) return reply(401, { error: 'unauthorized' })
      // A API devolve o token no corpo: o relatório não pode trazê-lo de volta.
      if (req.url?.startsWith('/billing/echo')) {
        res.setHeader('set-cookie', `visto=${COOKIE}; Max-Age=600; Path=/`)
        return reply(200, { seen: auth, cookie: req.headers.cookie ?? null })
      }
      if (req.url?.startsWith('/billing/charges')) {
        const data = JSON.parse(body || '{}') as { amount?: number }
        if (!(Number(data.amount) > 0)) return reply(400, { error: 'INVALID_AMOUNT' })
        return reply(200, { id: 'ch_1', status: 'PENDING', env: req.headers['x-env'] })
      }
      // Caminho malformado (%E0 cru, que não é UTF-8) é 400; o %25E0 de um valor recodificado é só um código que não existe.
      if (req.url?.startsWith('/billing/pedidos/')) return req.url.includes('%E0') ? reply(400, { error: 'BAD_PATH' }) : reply(404, { error: 'not found' })
      reply(404, { error: 'not found' })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((r) => server.close(r))
})

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  root = mkdtempSync(join(tmpdir(), 'vvpost-cli-'))
  workspace = join(root, 'ws')
  put('connectors/billing.connector.vvpost.json', {
    id: 'billing',
    name: 'Billing',
    version: '1.0.0',
    config: { baseUrl: '{{BASE_URL}}', basePath: '/billing', headers: { 'X-Env': '{{ENV}}' }, auth: { type: 'bearer', token: '{{API_TOKEN}}' } },
    endpoints: [
      {
        id: 'charge',
        name: 'Cobrar',
        method: 'POST',
        path: '/charges',
        body: { amount: 150 },
        scenarios: [
          { id: 'ok', name: 'Sucesso', assertions: [{ target: 'body.status', operator: 'equals', expected: 'PENDING' }] },
          {
            id: 'invalid',
            name: 'Valor inválido',
            overrides: { body: { amount: -1 } },
            assertions: [{ target: 'status', operator: 'equals', expected: 400 }]
          },
          { id: 'no_auth', name: 'Sem auth', overrides: { headers: null }, assertions: [{ target: 'status', operator: 'equals', expected: 401 }] }
        ]
      },
      {
        id: 'echo',
        name: 'Eco',
        method: 'GET',
        path: '/echo',
        scenarios: [{ id: 'echo', name: 'Eco', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }]
      }
    ]
  })
  for (const env of ['dev', 'hml']) {
    put(`environments/${env}.env.json`, {
      id: env,
      name: env.toUpperCase(),
      variables: {
        BASE_URL: { type: 'string', value: origin },
        ENV: { type: 'string', value: env },
        API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
      }
    })
  }
  put('.vvpost/secrets.local.json', { dev: { API_TOKEN }, hml: { API_TOKEN } })
  put('flows/charge.flow.vvpost.json', {
    id: 'flow.charge',
    name: 'Charge',
    nodes: [
      { id: 'charge', name: 'Charge', type: 'request', request: { connector: 'billing', endpoint: 'charge' } },
      {
        id: 'pending',
        name: 'Pending',
        type: 'condition',
        condition: { target: '$nodes.Charge.data.status', operator: 'equals', expected: 'PENDING' }
      }
    ],
    edges: [{ from: 'charge', to: 'pending' }]
  })
})

interface Captured {
  code: number
  stdout: string
  stderr: string
}

const opened: string[] = []

async function cli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Captured> {
  let stdout = ''
  let stderr = ''
  const io: Io = {
    openExternal: async (url) => void opened.push(url),
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    env: { VVPOST_USER_DATA: join(root, 'user-data'), ...env },
    cwd: root,
    isTTY: false,
    appDir: join(root, 'app')
  }
  const code = await main(['--workspace', workspace, ...args], io)
  return { code, stdout, stderr }
}

const leaks = (text: string) => text.includes(API_TOKEN) || text.includes(CI_TOKEN)

describe('vvpost run', () => {
  it('rawPathParams manda o valor já codificado cru, e o ✗ mostra a URL montada', async () => {
    const connector = JSON.parse(readFileSync(join(workspace, 'connectors/billing.connector.vvpost.json'), 'utf8'))
    const malformado = (id: string, raw: boolean) => ({
      id,
      name: id,
      overrides: { pathParams: { codigo: '%E0' }, ...(raw && { rawPathParams: ['codigo'] }) },
      assertions: [{ target: 'status', operator: 'equals', expected: 400 }]
    })
    connector.endpoints.push({ id: 'pedido', name: 'Pedido', method: 'GET', path: '/pedidos/{codigo}', scenarios: [malformado('cru', true), malformado('codificado', false)] })
    put('connectors/billing.connector.vvpost.json', connector)
    const r = await cli(['run', '--env', 'dev', '--scenario', 'pedido'])
    expect(r.stderr).toBe('')
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('✓ dev pedido/cru 400')
    expect(r.stdout).toContain('✗ dev pedido/codificado 404')
    expect(r.stdout).toContain('GET /pedidos/%25E0')
    expect(r.stdout).not.toContain('GET /pedidos/%E0')
  })

  it('--ca ilegível é erro de configuração; --cookie-jar lê e grava os cookies da execução', async () => {
    const bad = await cli(['run', '--env', 'dev', '--ca', 'nao-existe.pem'])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('--ca nao-existe.pem')
    const first = await cli(['run', '--env', 'dev', '--scenario', 'echo', '--cookie-jar', 'cookies.json', '--proxy', 'off', '--insecure'])
    expect(first.code).toBe(0)
    const jar = JSON.parse(readFileSync(join(root, 'cookies.json'), 'utf8')) as { name: string; domain: string }[]
    expect(jar).toMatchObject([{ name: 'visto', domain: '127.0.0.1' }])
    const second = await cli(['run', '--env', 'dev', '--scenario', 'echo', '--cookie-jar', 'cookies.json', '--json', '-'])
    // O cookie voltou na segunda execução, e o relatório mostra só o nome: o valor é credencial.
    expect(second.stdout).toContain('\\"cookie\\":\\"[REDACTED_SECRET]\\"')
    expect(second.stdout).not.toContain(COOKIE)
  })

  it('roda todos os cenários e fluxos e sai com 0 quando tudo passa', async () => {
    const r = await cli(['run', '--env', 'dev'])
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('Cenários · billing')
    expect(r.stdout).toContain('✓ dev charge/ok')
    expect(r.stdout).toContain('Fluxo · flow.charge [dev]')
    expect(r.stdout).toMatch(/PASSOU · 4 cenários passaram · 1 fluxos ok/)
    expect(leaks(r.stdout)).toBe(false)
  })

  it('o relatório mostra a versão do Python de cada nó Python, e a versão pedida barra um Python antigo', async () => {
    const calc = (version: string) => ({
      id: 'flow.calc',
      name: 'Cálculo',
      nodes: [{ id: 'py', name: 'Soma', type: 'python', python: { code: 'output = 1 + 1', version } }],
      edges: []
    })
    put('flows/calc.flow.vvpost.json', calc('3.8'))
    const r = await cli(['run', '--flow', 'flow.calc'])
    expect(r.code).toBe(0)
    // A duração vem em ms ou, passando de 1 s (Python frio no Windows), em segundos.
    expect(r.stdout).toMatch(/✓ Soma · (\d+ ms|\d+(,\d+)? s) · Python 3\.\d+\.\d+/)
    const json = JSON.parse((await cli(['run', '--flow', 'flow.calc', '--json', '-'])).stdout)
    expect(json.flows[0].report.results[0].python).toMatch(/^3\.\d+\.\d+$/)

    put('flows/calc.flow.vvpost.json', calc('3.99'))
    const old = await cli(['run', '--flow', 'flow.calc', '--json', '-'])
    expect(old.code).toBe(1)
    expect(JSON.parse(old.stdout).flows[0].report.results[0].error).toMatchObject({
      code: 'PYTHON_NOT_FOUND',
      message: expect.stringContaining('O nó pede o Python 3.99 ou mais novo'),
      property: 'python.version'
    })
  })

  it('sai com 1 quando uma asserção falha, e o JUnit e o JSON descrevem a falha', async () => {
    put('flows/charge.flow.vvpost.json', '{ "nao": "é um fluxo" }')
    const connector = JSON.parse(readFileSync(join(workspace, 'connectors/billing.connector.vvpost.json'), 'utf8'))
    connector.endpoints[0].scenarios[0].assertions[0].expected = 'PAID'
    put('connectors/billing.connector.vvpost.json', connector)

    const r = await cli(['run', '--env', 'dev,hml', '--junit', 'out/junit.xml', '--json', 'out/report.json'])
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('aviso: flows/charge.flow.vvpost.json')
    expect(r.stdout).toContain('body.status equals: esperado "PAID", recebido "PENDING"')
    expect(r.stdout).toContain('FALHOU · 6 cenários passaram, 2 falharam')

    const junit = readFileSync(join(root, 'out/junit.xml'), 'utf8')
    expect(junit).toContain('<testsuites name="vvpost" tests="8" failures="2" errors="0" skipped="0"')
    expect(junit).toContain('<testcase classname="billing.charge" name="ok [hml]"')
    expect(junit).toContain('<failure message="body.status equals: esperado &quot;PAID&quot;, recebido &quot;PENDING&quot;">')

    const report = JSON.parse(readFileSync(join(root, 'out/report.json'), 'utf8'))
    expect(report).toMatchObject({
      version: 1,
      outcome: 'failed',
      scenarios: [{ connectorId: 'billing', totals: { passed: 6, failed: 2, error: 0 } }],
      environments: ['dev', 'hml'],
      flows: []
    })
    expect(new Set(report.issues.map((i: { file: string }) => i.file))).toEqual(new Set(['flows/charge.flow.vvpost.json']))
    // O token passou pela API (eco no corpo e no header Authorization), mas não chega aos artefatos.
    expect(leaks(junit) || leaks(JSON.stringify(report)) || leaks(r.stdout)).toBe(false)
    expect(JSON.stringify(report)).toContain('[REDACTED_SECRET]')
  })

  it('--strict transforma arquivo inválido em erro de configuração', async () => {
    put('environments/broken.env.json', '{')
    const r = await cli(['run', '--env', 'dev', '--strict', '--quiet'])
    expect(r.code).toBe(2)
    expect(r.stdout).toContain('ERRO DE CONFIGURAÇÃO')
  })

  it('filtra por conector, cenário e fluxo', async () => {
    const only = await cli(['run', '--env', 'dev', '--connector', 'billing', '--scenario', 'charge/invalid', '--json', '-'])
    expect(only.code).toBe(0)
    const report = JSON.parse(only.stdout)
    expect(report.scenarios[0].results.map((x: { scenarioId: string }) => x.scenarioId)).toEqual(['invalid'])
    expect(report.flows).toEqual([])

    const byEndpoint = JSON.parse((await cli(['run', '--env', 'dev', '--scenario', 'charge', '--json', '-'])).stdout)
    expect(byEndpoint.scenarios[0].results).toHaveLength(3)
    expect(byEndpoint.flows).toHaveLength(1)

    const flow = await cli(['run', '--env', 'all', '--flow', 'flows/charge.flow.vvpost.json', '--json', '-'])
    const flows = JSON.parse(flow.stdout)
    expect(flows.scenarios).toEqual([])
    expect(flows.flows.map((f: { environmentId: string }) => f.environmentId)).toEqual(['dev', 'hml'])
    expect(flows.flows[0].report.outcome).toBe('success')
  })

  it('erros de uso saem com 2 e dizem o que existe', async () => {
    const env = await cli(['run', '--env', 'prod'])
    expect(env.code).toBe(2)
    expect(env.stderr).toContain('ambiente "prod" não existe no workspace (disponíveis: dev, hml)')
    expect((await cli(['run', '--connector', 'nada'])).stderr).toContain('conector "nada" não existe')
    expect((await cli(['run', '--flow', 'nada'])).stderr).toContain('fluxo "nada" não existe')
    expect((await cli(['run', '--scenario', 'charge/nada', '--connector', 'billing'])).stderr).toContain('nenhum cenário corresponde')
    expect((await cli(['run', '--bogus'])).code).toBe(2)
    expect((await cli(['deploy'])).stderr).toContain('comando desconhecido')
    const missing = await main(['run', '--workspace', join(root, 'nao-existe')], {
      stdout: () => {},
      stderr: () => {},
      env: {},
      cwd: root,
      isTTY: false,
      appDir: root
    })
    expect(missing).toBe(2)
  })

  it('um segredo ausente é erro do cenário (código 1), sem vazar o nome da credencial como valor', async () => {
    rmSync(join(workspace, '.vvpost/secrets.local.json'))
    const r = await cli(['run', '--env', 'dev', '--connector', 'billing'])
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('CONFIG_ERROR')
  })

  it('segredos do CI por VVPOST_SECRET_* e --secrets, sem gravar nada no workspace', async () => {
    rmSync(join(workspace, '.vvpost/secrets.local.json'))
    const viaEnv = await cli(['run', '--env', 'dev', '--json', '-'], { VVPOST_SECRET_API_TOKEN: CI_TOKEN })
    expect(viaEnv.code).toBe(0)
    expect(leaks(viaEnv.stdout)).toBe(false)

    writeFileSync(join(root, 'ci-secrets.json'), JSON.stringify({ dev: { API_TOKEN: CI_TOKEN } }))
    const viaFile = await cli(['run', '--env', 'dev', '--secrets', 'ci-secrets.json', '--junit', 'j.xml'])
    expect(viaFile.code).toBe(0)
    expect(leaks(readFileSync(join(root, 'j.xml'), 'utf8'))).toBe(false)
    expect(() => readFileSync(join(workspace, '.vvpost/secrets.local.json'))).toThrow()

    const badFile = await cli(['run', '--secrets', 'nao-existe.json'])
    expect(badFile.code).toBe(2)
  })

  it('--data roda os cenários uma vez por linha do CSV, com a iteração no texto e no JUnit', async () => {
    const connector = JSON.parse(readFileSync(join(workspace, 'connectors/billing.connector.vvpost.json'), 'utf8'))
    connector.endpoints[0].scenarios[0] = {
      id: 'ok',
      name: 'Sucesso',
      overrides: { body: { amount: '{{valor}}' } },
      assertions: [{ target: 'status', operator: 'equals', expected: '{{status}}' }]
    }
    put('connectors/billing.connector.vvpost.json', connector)
    writeFileSync(join(root, 'casos.csv'), 'valor,status\n150,200\n-5,400\n10,201\n')
    const r = await cli(['run', '--env', 'dev', '--scenario', 'charge/ok', '--data', 'casos.csv', '--junit', 'junit.xml'])
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('(3, 3 iterações de casos.csv')
    expect(r.stdout).toContain('✓ #1 dev charge/ok')
    expect(r.stdout).toContain('✓ #2 dev charge/ok')
    expect(r.stdout).toContain('✗ #3 dev charge/ok')
    expect(readFileSync(join(root, 'junit.xml'), 'utf8')).toContain('name="ok [dev] #3"')

    const missing = await cli(['run', '--env', 'dev', '--data', 'nao-existe.csv'])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('--data: não foi possível ler')
    writeFileSync(join(root, 'ruim.json'), '{"a":1}')
    const bad = await cli(['run', '--env', 'dev', '--data', 'ruim.json'])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('--data ruim.json: o arquivo de dados em JSON precisa ser uma lista de objetos')
  })

  it('--var troca uma variável do ambiente (ex.: URL de um deploy de preview)', async () => {
    const r = await cli(['run', '--env', 'dev', '--var', 'BASE_URL=http://127.0.0.1:1', '--connector', 'billing', '--json', '-'])
    expect(r.code).toBe(1)
    const report = JSON.parse(r.stdout)
    expect(report.scenarios[0].results[0].error.code).toBe('CONNECTION_REFUSED')
  })
})

describe('vvpost run --history', () => {
  it('grava a execução com as requisições de cenários e fluxos, sem segredos', async () => {
    const r = await cli(['run', '--env', 'dev', '--history', 'full'])
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
    const path = join(root, 'user-data', 'vvpost.db')
    const store = await openHistoryStore(path)
    const [run] = await store.list()
    const detail = await store.get(run!.id)
    await store.close()
    expect(run).toMatchObject({ source: 'cli', level: 'full', outcome: 'passed', environmentId: 'dev', exchangeCount: 5 })
    expect(detail!.exchanges.map((x) => x.label)).toEqual(['charge/ok', 'charge/invalid', 'charge/no_auth', 'echo/echo', 'Charge'])
    const ok = detail!.exchanges[0]!
    expect(ok.template).toMatchObject({ body: '{"amount":150}' })
    expect(ok.sent!.url).toBe(`${origin}/billing/charges`)
    expect(ok.sent!.headers).toContainEqual({ name: 'Authorization', value: '[REDACTED_SECRET]' })
    expect(ok.assertions![0]).toMatchObject({ passed: true })
    expect(detail!.exchanges[2]!.template).toMatchObject({ inheritHeaders: false })
    expect(detail!.report).toMatchObject({ flows: [{ file: 'flows/charge.flow.vvpost.json', outcome: 'success' }] })
    expect(leaks(readFileSync(path).toString('latin1'))).toBe(false)
    expect(leaks(JSON.stringify(detail))).toBe(false)
  })

  it('--history-db escolhe o banco, o nível metadata não guarda corpos e nível inválido é erro de uso', async () => {
    const r = await cli(['run', '--env', 'dev', '--connector', 'billing', '--history', 'metadata', '--history-db', 'h.db'])
    expect(r.code).toBe(0)
    const store = await openHistoryStore(join(root, 'h.db'))
    const [run] = await store.list()
    const x = (await store.get(run!.id))!.exchanges[0]!
    await store.close()
    expect(run!.level).toBe('metadata')
    expect(x.sent).toBeUndefined()
    expect(x.response).toBeUndefined()
    expect(x.status).toBe(200)

    expect((await cli(['run', '--history', 'tudo'])).code).toBe(2)
  })
})

describe('vvpost list e validate', () => {
  it('lista conectores, cenários, ambientes e fluxos', async () => {
    const r = await cli(['list'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('billing  4 cenários')
    expect(r.stdout).toContain('    charge/no_auth')
    expect(r.stdout).toContain('flow.charge  2 nós')
    const json = JSON.parse((await cli(['list', '--json', '-'])).stdout)
    expect(json.environments.map((e: { id: string }) => e.id)).toEqual(['dev', 'hml'])
  })

  it('validate sai com 2 com herança quebrada', async () => {
    expect((await cli(['validate'])).code).toBe(0)
    put('connectors/child.connector.vvpost.json', { id: 'child', name: 'Child', version: '1.0.0', extends: 'nao-existe' })
    const r = await cli(['validate'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('connectors/child.connector.vvpost.json')
  })

  it('validate pega a documentação que ficou para trás', async () => {
    const file = 'connectors/billing.connector.vvpost.json'
    const billing = JSON.parse(readFileSync(join(workspace, file), 'utf8'))
    const charge = billing.endpoints[0]
    charge.bodySchema = { type: 'object', required: ['amount'], properties: { amount: { type: 'number' } } }
    charge.scenarios[1].overrides.body = { amount: 'menos um' }
    put(file, billing)
    put('vvpost.docs.json', { title: 'Docs' })
    put('docs/projeto.md', '## Cobrança\n\n{{> endpoint billing/charge}}\n')
    // Teste negativo manda corpo inválido de propósito: aviso, não erro (só com --strict).
    let r = await cli(['validate'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('aviso: connectors/billing.connector.vvpost.json: charge: cenário: valor inválido fora do bodySchema')
    expect((await cli(['validate', '--strict'])).code).toBe(2)

    charge.body = { amount: '150' }
    put(file, billing)
    put('docs/projeto.md', '## Cobrança\n\n{{> endpoint billing/cobrar}}\n')
    put('connectors/billing.connector.vvpost.md', 'Visão geral\n\n## Estornar {#refund}\n\nSem endpoint.\n')
    r = await cli(['validate'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('charge: corpo padrão fora do bodySchema')
    expect(r.stderr).toContain('docs/projeto.md:3: endpoint "billing/cobrar" não existe')
    expect(r.stderr).toContain('seção {#refund} não corresponde a nenhum endpoint')
  })

  it('validate reprova resposta de exemplo fora do schema dela', async () => {
    const file = 'connectors/billing.connector.vvpost.json'
    const billing = JSON.parse(readFileSync(join(workspace, file), 'utf8'))
    const schema = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }
    billing.endpoints[0].examples = [{ id: 'ok', name: 'Criada', status: 201, body: { id: '{{$uuid}}' }, schema }]
    put(file, billing)
    expect((await cli(['validate'])).code).toBe(0)
    // Corpo em texto que é JSON vale como o JSON.
    billing.endpoints[0].examples[0].body = '{"id": 7}'
    put(file, billing)
    const r = await cli(['validate'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain(`${file}: charge: exemplo de resposta "Criada" (201) fora do schema dele (/id: `)
  })

  it('--help e --version', async () => {
    expect((await cli(['--help'])).stdout).toContain('Uso: vvpost <comando>')
    expect((await cli(['--version'])).stdout).toMatch(/^vvpost \d+\.\d+\.\d+/)
  })
})

describe('vvpost docs', () => {
  it('gera o Markdown do projeto, de um conector, de um endpoint e de uma request, sem segredo', async () => {
    const project = await cli(['docs'])
    expect(project.code).toBe(0)
    expect(project.stdout).toContain('Documentação (projeto) gravada em')
    const md = readFileSync(join(root, 'ws.docs.md'), 'utf8')
    expect(md).toContain('# Documentação de ws')
    expect(md).toContain('```mermaid')
    expect(leaks(md)).toBe(false)

    const endpoint = await cli(['docs', '--endpoint', 'billing/charge', '--out', '-'])
    expect(endpoint.code).toBe(0)
    expect(endpoint.stdout).toMatch(/^# POST \/charges · Cobrar/)
    expect(endpoint.stdout).toContain('##### Valor inválido')
    expect(leaks(endpoint.stdout)).toBe(false)

    const request = await cli(['docs', '--connector', 'billing', '--scenario', 'charge/no_auth', '--out', 'out/r.md'])
    expect(request.code).toBe(0)
    expect(readFileSync(join(root, 'out/r.md'), 'utf8')).toContain('# Request Sem auth')
  })

  it('docs init cria o documento do projeto, e o docs passa a gerar ele no padrão do modelo', async () => {
    const init = await cli(['docs', 'init', '--title', 'API Exemplo'])
    expect(init.code).toBe(0)
    expect(init.stdout).toContain('Criados vvpost.docs.json e docs/projeto.md')
    expect((await cli(['docs', 'init'])).code).toBe(2)
    const doc = await cli(['docs', '--out', '-'])
    expect(doc.code).toBe(0)
    expect(doc.stdout).toMatch(/^# API Exemplo/)
    expect(doc.stdout).toContain('## Sumário')
    expect(doc.stdout).toContain('Conector ')
    expect(leaks(doc.stdout)).toBe(false)
    expect((await cli(['docs', '--generated', '--out', '-'])).stdout).toMatch(/^# Documentação de ws/)
    put('docs/projeto.md', '## A\n\n{{> endpoint billing/nada}}\n')
    const broken = await cli(['docs', '--out', '-'])
    expect(broken.code).toBe(0)
    expect(broken.stderr).toContain('erro: docs/projeto.md:3: endpoint "billing/nada" não existe')
    expect((await cli(['docs', '--strict', '--out', '-'])).code).toBe(1)
    rmSync(join(workspace, 'docs'), { recursive: true })
    rmSync(join(workspace, 'vvpost.docs.json'))

    // Modelos: os de metodologia e os do projeto.
    put('padroes/interno.doc-template.vvpost.json', { name: 'Padrão interno', description: 'Do time', config: { numberHeadings: true }, source: '## Interno\n\n{{> summary}}\n' })
    const list = await cli(['docs', 'templates'])
    expect(list.stdout).toContain('c4')
    expect(list.stdout).toContain('project:padroes/interno.doc-template.vvpost.json')
    expect((await cli(['docs', 'init', '--template', 'nada'])).code).toBe(2)
    expect((await cli(['docs', 'init', '--template', 'c4'])).stdout).toContain('com o modelo C4')
    const c4 = await cli(['docs', '--out', '-'])
    expect(c4.stdout).toContain('C4Context')
    expect(c4.stdout).toContain('## 1. Contexto do sistema (nível 1)')
    rmSync(join(workspace, 'docs'), { recursive: true })
    rmSync(join(workspace, 'vvpost.docs.json'))
    expect((await cli(['docs', 'init', '--template', 'padroes/interno.doc-template.vvpost.json'])).code).toBe(0)
    expect(readFileSync(join(workspace, 'docs/projeto.md'), 'utf8')).toContain('## Interno')
    rmSync(join(workspace, 'docs'), { recursive: true })
    rmSync(join(workspace, 'padroes'), { recursive: true })
    rmSync(join(workspace, 'vvpost.docs.json'))
  })

  it('docs agents mostra o trecho de CLAUDE.md / AGENTS.md e acrescenta uma vez só', async () => {
    const shown = await cli(['docs', 'agents'])
    expect(shown.code).toBe(0)
    expect(shown.stdout).toContain('<!-- vvpost:docs -->')
    expect(shown.stdout).toContain('não em arquivos .md soltos')
    writeFileSync(join(root, 'AGENTS.md'), '# Regras\n\nUse TypeScript.\n')
    expect((await cli(['docs', 'agents', '--out', 'AGENTS.md'])).stdout).toContain('acrescentado')
    expect((await cli(['docs', 'agents', '--out', 'AGENTS.md'])).stdout).toContain('já tem')
    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    expect(agents.startsWith('# Regras\n\nUse TypeScript.\n\n<!-- vvpost:docs -->')).toBe(true)
    expect(agents.split('<!-- vvpost:docs -->')).toHaveLength(2)
    rmSync(join(root, 'AGENTS.md'))
  })

  it('escopo inválido sai com 2', async () => {
    expect((await cli(['docs', '--connector', 'nada'])).code).toBe(2)
    expect((await cli(['docs', '--endpoint', 'charge'])).stderr).toContain('--endpoint precisa do conector')
    expect((await cli(['docs', '--connector', 'billing', '--endpoint', 'charge', '--scenario', 'x'])).stderr).toContain('request "x"')
  })
})

describe('segredos do CI e caminhos', () => {
  it('VVPOST_SECRET_* < --secrets < --var, só nos ambientes que declaram a variável', async () => {
    const ws = await loadWorkspace(workspace)
    applyCiValues(ws, {
      env: secretsFromProcessEnv({ VVPOST_SECRET_API_TOKEN: 'from-env', VVPOST_SECRET_OTHER: 'x', VVPOST_SECRET_: 'y' }),
      file: { hml: { API_TOKEN: 'from-file' } },
      vars: { ENV: 'qa' }
    })
    expect(ws.secrets['dev']).toEqual({ API_TOKEN: 'from-env' })
    expect(ws.secrets['hml']).toEqual({ API_TOKEN: 'from-file' })
    expect(ws.environments.get('dev')!.variables['ENV']!.value).toBe('qa')
    applyCiValues(ws, { env: {}, vars: { API_TOKEN: 'from-var' } })
    expect(ws.secrets['dev']!['API_TOKEN']).toBe('from-var')
    // Um --var de variável secreta nunca vai para o ambiente em texto.
    expect(ws.environments.get('dev')!.variables['API_TOKEN']!.value).toBe('__REQUIRED_SECRET__')
  })

  it('userData igual ao do Electron em cada sistema', () => {
    expect(defaultUserDataDir({ VVPOST_USER_DATA: '/x' })).toBe('/x')
    expect(defaultUserDataDir({ XDG_CONFIG_HOME: '/cfg' }, 'linux')).toBe(join('/cfg', 'vvpost'))
    expect(defaultUserDataDir({ APPDATA: 'C:\\Users\\v\\AppData\\Roaming' }, 'win32')).toBe(join('C:\\Users\\v\\AppData\\Roaming', 'vvpost'))
    expect(defaultUserDataDir({}, 'darwin')).toMatch(/Library[\\/]Application Support[\\/]vvpost$/)
  })

  it('JUnit escapa XML e tira caracteres inválidos', () => {
    const xml = junitReport({
      workspace: '/w',
      startedAt: 0,
      durationMs: 1,
      environments: [],
      issues: [],
      canceled: false,
      flows: [],
      scenarios: [
        {
          runId: 'r',
          connectorId: 'c<&>',
          startedAt: 0,
          durationMs: 1,
          totals: { passed: 0, failed: 0, error: 1 },
          canceled: false,
          results: [
            {
              endpointId: 'e',
              scenarioId: 's"',
              environmentId: '',
              outcome: 'error',
              request: { method: 'GET', url: '/x' },
              durationMs: 0,
              error: { code: 'NETWORK_ERROR', message: 'falhou \u0001 <aqui>' },
              assertions: []
            }
          ]
        }
      ]
    })
    expect(xml).toContain('<testsuite name="scenarios.c&lt;&amp;&gt;"')
    expect(xml).toContain('name="s&quot;"')
    expect(xml).toContain('NETWORK_ERROR: falhou  &lt;aqui&gt;')
    expect(xml).not.toContain('\u0001')
  })
})

describe('vvpost --catalog', () => {
  const corp = {
    id: 'corp.base',
    name: 'Corp Base',
    version: '2.0.0',
    config: { baseUrl: '{{BASE_URL}}', headers: { 'X-Env': '{{ENV}}' }, auth: { type: 'bearer', token: '{{API_TOKEN}}' } }
  }
  const child = {
    id: 'billing.v2',
    name: 'Billing v2',
    version: '1.0.0',
    extends: 'corp.base',
    config: { basePath: '/billing' },
    endpoints: [{ id: 'echo', name: 'Eco', method: 'GET', path: '/echo', scenarios: [{ id: 'echo', name: 'Eco', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }] }]
  }
  const catalog = (data: unknown) => {
    writeFileSync(join(root, 'catalog.json'), JSON.stringify(data))
    return 'catalog.json'
  }

  it('o snapshot do Control Plane entra como compartilhado e um conector local herda dele', async () => {
    put('connectors/billing-v2.connector.vvpost.json', child)
    const file = catalog({ source: 'cp.contoso.com/payments', etag: '"x"', connectors: [{ scope: 'org', version: 3, doc: corp }] })
    const r = await cli(['run', '--catalog', file, '--env', 'dev', '--connector', 'billing.v2', '--json', '-'])
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    const report = JSON.parse(r.stdout)
    expect(report.outcome).toBe('passed')
    expect(report.scenarios[0].totals.passed).toBe(1)
    expect(leaks(r.stdout)).toBe(false)

    const list = JSON.parse((await cli(['list', '--catalog', file, '--json', '-'])).stdout)
    expect(list.connectors.find((c: { id: string }) => c.id === 'corp.base').file).toBe('shared:cp.contoso.com/payments@org:3')
    // Sem --catalog o filho fica com herança quebrada.
    expect((await cli(['validate'])).code).toBe(2)
    expect((await cli(['validate', '--catalog', file])).code).toBe(0)
  })

  it('um arquivo local não troca o compartilhado, e lista ou conector único também valem', async () => {
    put('connectors/corp.connector.vvpost.json', { ...corp, config: { baseUrl: 'http://127.0.0.1:1' } })
    const r = await cli(['list', '--catalog', catalog([corp]), '--json', '-'])
    const json = JSON.parse(r.stdout)
    expect(json.connectors.find((c: { id: string }) => c.id === 'corp.base').file).toBe('shared:catalog.json')
    expect(json.issues).toContainEqual(expect.objectContaining({ file: 'connectors/corp.connector.vvpost.json' }))
    expect((await cli(['validate', '--catalog', catalog(corp)])).code).toBe(2)
  })

  it('arquivo de catálogo ilegível ou sem formato é erro de uso', async () => {
    writeFileSync(join(root, 'bad.json'), '{')
    expect((await cli(['run', '--catalog', 'bad.json'])).stderr).toContain('--catalog')
    expect((await cli(['run', '--catalog', catalog({ foo: 1 })])).code).toBe(2)
    expect((await cli(['run', '--catalog', 'nao-existe.json'])).code).toBe(2)
  })
})

describe('vvpost secrets', () => {
  const run = async (args: string[], value?: string) => {
    let stdout = ''
    let stderr = ''
    const prompts: string[] = []
    const io: Io = {
      stdout: (t) => (stdout += t),
      stderr: (t) => (stderr += t),
      env: { VVPOST_USER_DATA: join(root, 'user-data') },
      cwd: root,
      isTTY: false,
      appDir: join(root, 'app'),
      ...(value !== undefined && {
        readSecret: async (prompt: string) => {
          prompts.push(prompt)
          return value
        }
      })
    }
    const code = await main(['--workspace', workspace, ...args], io)
    return { code, stdout, stderr, prompts }
  }

  it('list mostra o estado sem valor; set grava no cofre e o run usa; rm apaga', async () => {
    rmSync(join(workspace, '.vvpost/secrets.local.json'))
    let r = await run(['secrets', 'list', '--json', '-'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).secrets).toEqual([
      { environment: 'dev', variable: 'API_TOKEN', state: 'missing' },
      { environment: 'hml', variable: 'API_TOKEN', state: 'missing' }
    ])

    r = await run(['secrets', 'set', 'dev', 'API_TOKEN'], API_TOKEN)
    expect(r.code, r.stderr).toBe(0)
    expect(r.prompts).toEqual(['Valor de API_TOKEN em dev: '])
    expect(leaks(r.stdout + r.stderr)).toBe(false)
    // Nada do valor no workspace: o cofre fica fora da pasta.
    expect(JSON.stringify((await loadWorkspace(workspace)).secrets.dev)).toContain(API_TOKEN)
    const files = readdirSync(workspace, { recursive: true }).map((f) => join(workspace, String(f))).filter((f) => statSync(f).isFile())
    expect(files.some((f) => readFileSync(f, 'utf8').includes(API_TOKEN))).toBe(false)

    r = await run(['secrets', 'list'])
    expect(r.stdout).toMatch(/dev\s+API_TOKEN\s+configurado/)
    expect(r.stdout).toMatch(/hml\s+API_TOKEN\s+pendente/)
    expect(leaks(r.stdout)).toBe(false)
    expect((await cli(['run', '--env', 'dev', '--connector', 'billing', '--scenario', 'charge/ok'])).code).toBe(0)

    r = await run(['secrets', 'rm', 'dev', 'API_TOKEN'])
    expect(r.code).toBe(0)
    expect((await loadWorkspace(workspace)).secrets.dev?.['API_TOKEN']).toBeUndefined()
  })

  it('recusa variável não secreta, ambiente inexistente, valor vazio e valor na linha de comando', async () => {
    let r = await run(['secrets', 'set', 'dev', 'ENV'], 'x')
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/não é secreta/)
    r = await run(['secrets', 'set', 'prod', 'API_TOKEN'], 'x')
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/"prod" não existe/)
    r = await run(['secrets', 'set', 'dev', 'API_TOKEN'], '')
    expect(r.code).toBe(2)
    r = await run(['secrets', 'set', 'dev', 'API_TOKEN', API_TOKEN])
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/não vai na linha de comando/)
    expect(leaks(r.stderr)).toBe(false)
  })
})

describe('vvpost login', () => {
  it('registra pelo módulo Enterprise, com o projeto do Control Plane; sem módulo ou com URL errada, sai com 2', async () => {
    const { registerEnterpriseModule } = await import('../src/main/secret-engine/backend')
    const calls: unknown[] = []
    registerEnterpriseModule({
      apiVersion: 1,
      createBackend: async () => {
        throw new Error('não usado')
      },
      audit: async () => {},
      organization: {
        use: () => {},
        register: async (ref: { controlPlane: string; project?: string }, open?: (url: string) => Promise<void>) => {
          calls.push(ref)
          await open?.('https://login.microsoftonline.com/contoso/oauth2/v2.0/authorize?x=1')
          return { name: 'Contoso', controlPlane: ref.controlPlane, project: ref.project, user: 'Ana' }
        }
      }
    } as never)
    try {
      // --project aqui é do Control Plane: o workspace não tem projeto "payments".
      let r = await cli(['login', 'https://cp.contoso.com/', '--project', 'payments'])
      expect(r.code, r.stderr).toBe(0)
      expect(calls).toEqual([{ controlPlane: 'https://cp.contoso.com', project: 'payments' }])
      expect(opened).toEqual(['https://login.microsoftonline.com/contoso/oauth2/v2.0/authorize?x=1'])
      expect(r.stdout).toMatch(/Contoso registrada \(cp\.contoso\.com, projeto payments\); login de Ana conferido/)
      r = await cli(['login', 'http://cp.contoso.com'])
      expect(r.code).toBe(2)
      expect(r.stderr).toMatch(/HTTPS/)
      expect((await cli(['login'])).code).toBe(2)
    } finally {
      registerEnterpriseModule(null)
    }
    const missing = await cli(['login', 'https://cp.contoso.com'], { VVPOST_ENTERPRISE_MODULE: join(root, 'nao-existe.mjs') })
    expect(missing.code).toBe(2)
  })
})

describe('recursos desligados pela organização', () => {
  it('o CLI aplica a política do módulo Enterprise; sem módulo e com a organização declarada, fica restrito e avisa', async () => {
    const { registerEnterpriseModule } = await import('../src/main/secret-engine/backend')
    const surfaces: string[] = []
    registerEnterpriseModule({
      apiVersion: 1,
      createBackend: async () => {
        throw new Error('não usado')
      },
      audit: async () => {},
      controlPlane: {
        activity: () => {},
        features: {
          open: async ({ surface }: { surface: string }) => {
            surfaces.push(surface)
            const state = { status: 'active', disabled: ['mockServer'], source: 'cp.contoso.com/org', fetchedAt: '2026-10-26T12:00:00Z', cached: true } as const
            return { state: () => state, ready: async () => state, close: async () => {} }
          }
        }
      }
    } as never)
    try {
      const r = await cli(['mock', '--port', '0'])
      expect(r.code).toBe(2)
      expect(r.stderr).toMatch(/Servidor mock: desligado pela política da organização \(cp\.contoso\.com\/org, cópia de 2026-10-26 12:00\)/)
      expect(surfaces).toEqual(['cli'])
    } finally {
      registerEnterpriseModule(null)
    }
    writeFileSync(join(workspace, '.vvpost', 'organization.json'), JSON.stringify({ controlPlane: 'https://cp.contoso.com' }))
    try {
      const r = await cli(['mock', '--port', '0'], { VVPOST_ENTERPRISE_MODULE: join(root, 'nao-existe.mjs') })
      expect(r.code).toBe(2)
      expect(r.stderr).toMatch(/política da organização indisponível .*Rode vvpost login/)
      expect(r.stderr).toMatch(/Servidor mock: desligado/)
    } finally {
      rmSync(join(workspace, '.vvpost', 'organization.json'), { force: true })
    }
  })
})
