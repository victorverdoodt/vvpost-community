import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { sendWithScripts } from '@vvpost/core/flows/scripted-send'
import { createHttpDispatcher } from '@vvpost/core/http/dispatcher'
import { PluginManager } from '@vvpost/core/plugins/manager'
import { convertPostman } from '../src/main/importers/postman'
import { validateImport } from '../src/main/importers/workspace'
import { translatePmScript } from '../src/main/importers/pm-scripts'

// Tradução do pm.* do Postman para a API vv dos scripts por requisição (fase 13).

// Chave de mentira no formato de uma chave da Stripe, montada em execução para não parecer segredo no repositório.
const FAKE_KEY = ['sk', 'live', randomBytes(12).toString('hex')].join('_')

describe('translatePmScript', () => {
  it('troca variáveis, resposta, requisição, testes e a API antiga', () => {
    const { code, unsupported } = translatePmScript(
      [
        "pm.environment.set('token', pm.response.json().token)",
        "pm.collectionVariables.get('tenant'); pm.globals.unset('x'); pm.variables.has('y')",
        "pm.test('status', () => { pm.response.to.have.status(200); pm.response.to.be.ok })",
        "pm.expect(pm.response.code).to.eql(200); pm.expect(pm.response.responseTime).to.be.below(500)",
        "pm.expect(pm.response.headers.get('Content-Type')).to.include('json')",
        "pm.request.headers.upsert({ key: 'X-Id', value: '1' }); pm.request.headers.remove('X-Old')",
        "const u = pm.request.url.toString(); const m = pm.request.method",
        "postman.setEnvironmentVariable('legado', JSON.parse(responseBody).id)",
        'if (responseCode.code === 201 && responseTime < 300) {}'
      ].join('\n')
    )
    expect(unsupported).toEqual([])
    expect(code).toBe(
      [
        "vv.variables.set('token', vv.response.json().token)",
        "vv.variables.get('tenant'); vv.variables.unset('x'); vv.variables.has('y')",
        "vv.test('status', () => { vv.expect(vv.response).to.have.status(200); vv.expect(vv.response.code).to.be.within(200, 299) })",
        'vv.expect(vv.response.code).to.eql(200); vv.expect(vv.response.responseTime).to.be.below(500)',
        "vv.expect(vv.response.header('Content-Type')).to.include('json')",
        "vv.request.setHeader({ key: 'X-Id', value: '1' }); vv.request.removeHeader('X-Old')",
        'const u = vv.request.url; const m = vv.request.method',
        "vv.variables.set('legado', JSON.parse(vv.response.text()).id)",
        'if (vv.response.code === 201 && vv.response.responseTime < 300) {}'
      ].join('\n')
    )
  })

  it('o que não tem equivalente fica no script e volta em unsupported', () => {
    const { code, unsupported } = translatePmScript(
      "pm.sendRequest('https://x', (err, res) => {})\nconst _ = require('lodash')\ntests['ok'] = true\npm.info.requestName"
    )
    expect(code).toContain('pm.sendRequest(')
    expect(unsupported).toEqual(["pm.info.requestName", "pm.sendRequest", "require('lodash')", 'tests[...]'])
  })
})

describe('importador do Postman', () => {
  const collection = {
    info: { name: 'Loja', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    event: [{ listen: 'prerequest', script: { exec: ["pm.request.headers.upsert({ key: 'X-Canal', value: 'app' })"] } }],
    item: [
      {
        name: 'Pedidos',
        event: [{ listen: 'test', script: { exec: ["pm.test('rápido', () => pm.expect(pm.response.responseTime).to.be.below(5000))"] } }],
        item: [
          {
            name: 'Login',
            event: [
              { listen: 'prerequest', script: { exec: [`pm.environment.set('api-key', '${FAKE_KEY}')`] } },
              {
                listen: 'test',
                script: {
                  exec: [
                    "pm.test('token', () => pm.expect(pm.response.json()).to.have.property('token'))",
                    "pm.environment.set('auth-token', pm.response.json().token)",
                    "pm.sendRequest('https://outra/api', () => {})"
                  ]
                }
              }
            ],
            request: { method: 'POST', url: 'https://loja.exemplo.com/login' }
          }
        ]
      }
    ]
  }

  it('scripts da coleção, da pasta e do item viram scripts do conector e do endpoint', () => {
    const r = convertPostman([{ file: 'loja.json', data: structuredClone(collection) }])
    expect(r.errors).toEqual([])
    expect(validateImport(r)).toEqual([])
    const root = r.connectors.find((c) => c.id === 'connector.loja')!
    const folder = r.connectors.find((c) => c.id === 'connector.loja.pedidos')!
    expect(root.config?.scripts).toEqual({ pre: "vv.request.setHeader({ key: 'X-Canal', value: 'app' })" })
    expect(folder.config?.scripts).toEqual({ post: "vv.test('rápido', () => vv.expect(vv.response.responseTime).to.be.below(5000))" })
    const login = folder.endpoints![0]!
    // O nome com hífen segue a troca dos {{x}}; a chave literal vai para o vault.
    expect(login.scripts!.pre).toBe('/* api_key: valor fixo movido para o vault do ambiente */')
    expect(login.scripts!.post).toContain("vv.variables.set('auth_token', vv.response.json().token)")
    expect(r.secrets).toContainEqual(expect.objectContaining({ variable: 'api_key', value: FAKE_KEY }))
    expect(r.environments[0]!.variables['api_key']).toMatchObject({ isSecret: true })
    expect(JSON.stringify(r.connectors)).not.toContain(FAKE_KEY)
    const warnings = r.warnings.map((w) => `${w.source}: ${w.message}`)
    expect(warnings).toContainEqual(expect.stringMatching(/Login: script de teste usa pm\.sendRequest sem equivalente/))
    expect(warnings).toContainEqual(expect.stringMatching(/4 script\(s\) de pre-request\/test viraram scripts pre e post.*1 com partes sem equivalente/))
  })
})

describe('script traduzido roda no VVPost', () => {
  let server: Server
  let origin = ''
  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('x-request-id', 'r-1')
      res.end(JSON.stringify({ token: 'tok-1', canal: req.headers['x-canal'] ?? null, itens: [1, 2, 3] }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => server.close())

  it('um teste típico do Postman passa depois da tradução', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'vvpost-pm-'))
    const manager = new PluginManager({
      officialDir: join(__dirname, '..', 'plugins'),
      userDir: join(userData, 'plugins'),
      stateFile: join(userData, 'plugins.json'),
      graceMs: 200
    })
    const http = createHttpDispatcher()
    try {
      const pre = translatePmScript("pm.request.headers.upsert({ key: 'X-Canal', value: pm.environment.get('CANAL') })").code
      const post = translatePmScript(
        [
          "pm.test('status 200', function () { pm.response.to.have.status(200) })",
          "pm.test('ok', () => pm.response.to.be.ok)",
          "pm.test('json', () => { const j = pm.response.json(); pm.expect(j.itens).to.have.lengthOf(3); pm.expect(j.canal).to.eql('app') })",
          "pm.test('header', () => pm.expect(pm.response.headers.get('X-Request-Id')).to.equal('r-1'))",
          "pm.test('tempo', () => pm.expect(pm.response.responseTime).to.be.below(5000))",
          "pm.environment.set('token', pm.response.json().token)"
        ].join('\n')
      ).code
      const ws = {
        dir: '/ws',
        connectors: new Map(),
        connectorFiles: new Map(),
        environments: new Map([['dev', { id: 'dev', name: 'Dev', variables: { CANAL: { type: 'string' as const, value: 'app' } } }]]),
        secrets: {},
        issues: []
      }
      const result = await sendWithScripts(
        { id: '1', method: 'GET', url: `${origin}/x`, headers: [], environmentId: 'dev', scripts: { pre, post } },
        { workspace: ws, auth: createAuthEngine(), http, plugins: await manager.runner() }
      )
      expect(result?.ok).toBe(true)
      expect(result!.scripts!.tests.map((t) => [t.name, t.passed, t.message])).toEqual([
        ['status 200', true, 'passou'],
        ['ok', true, 'passou'],
        ['json', true, 'passou'],
        ['header', true, 'passou'],
        ['tempo', true, 'passou']
      ])
      expect(result!.scripts!.variables).toEqual({ token: 'tok-1' })
    } finally {
      await manager.shutdown()
      await http.close()
      rmSync(userData, { recursive: true, force: true })
    }
  })
})
