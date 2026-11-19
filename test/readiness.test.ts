import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { createHttpDispatcher } from '@vvpost/core/http/dispatcher'
import { checkReadiness, referencedVariables } from '@vvpost/core/readiness'
import { main, type Io } from '../src/main/cli'
import { createMcpServer, type JsonRpcResponse } from '../src/main/mcp/server'
import { addReviewMarks } from '../src/main/project/review'

// Prontidão (docs/readiness.md): o motor, o check_readiness do MCP e o vvpost doctor.

const API_TOKEN = `tok-${randomBytes(8).toString('hex')}`
let listening: Server
let open = ''
let closed = ''
let root = ''
let workspace = ''

const put = (path: string, data: unknown) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), JSON.stringify(data, null, 2))
}

beforeAll(async () => {
  listening = createServer((s) => s.destroy())
  await new Promise<void>((r) => listening.listen(0, '127.0.0.1', r))
  open = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`
  // Uma porta que acabou de fechar: ninguém escuta nela.
  const tmp = createServer()
  await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r))
  closed = `http://127.0.0.1:${(tmp.address() as AddressInfo).port}`
  await new Promise((r) => tmp.close(r))
})
afterAll(async () => {
  await new Promise((r) => listening.close(r))
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  root = mkdtempSync(join(tmpdir(), 'vvpost-readiness-'))
  workspace = join(root, 'ws')
  put('connectors/billing.connector.vvpost.json', {
    id: 'billing',
    name: 'Billing',
    version: '1.0.0',
    config: { baseUrl: '{{BASE_URL}}', headers: { 'X-Tenant': '{{TENANT}}' }, auth: { type: 'bearer', token: '{{API_TOKEN}}' } },
    endpoints: [{ id: 'echo', name: 'Eco', method: 'GET', path: '/echo', scenarios: [{ id: 'ok', name: 'Ok', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }] }]
  })
  const env = (id: string, baseUrl: string, extra: Record<string, unknown> = {}) =>
    put(`environments/${id}.env.json`, {
      id,
      name: id.toUpperCase(),
      variables: {
        BASE_URL: { type: 'string', value: baseUrl },
        TENANT: { type: 'string', value: 't1' },
        API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true },
        ...extra
      }
    })
  env('dev', open)
  env('hml', closed, { OTHER_KEY: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true } })
  put('environments/prod.env.json', { id: 'prod', name: 'Produção', variables: { BASE_URL: { type: 'string', value: open } } })
})

const loaded = async (secrets: Record<string, Record<string, string>> = {}) => {
  const ws = await loadWorkspace(workspace)
  for (const [env, vars] of Object.entries(secrets)) ws.secrets[env] = { ...ws.secrets[env], ...vars }
  return ws
}

describe('motor de prontidão', () => {
  it('pega as variáveis referenciadas, sem as dinâmicas, e o $totp pela semente', () => {
    expect([...referencedVariables({ a: '{{A}} e {{ $uuid }}', b: ['{{$totp:SEED}}', '{{$token}}'] })]).toEqual(['A', 'SEED'])
  })

  it('lista todos os bloqueios de cada ambiente de uma vez, com o próximo passo', async () => {
    const report = await checkReadiness(await loaded({ dev: { API_TOKEN } }))
    expect(report.ready).toBe(false)
    const [dev, hml, prod] = report.environments
    expect(dev).toMatchObject({ id: 'dev', canExecute: true, probes: [{ origin: open, ok: true }] })
    expect(dev!.findings).toEqual([])

    expect(hml!.canExecute).toBe(false)
    const codes = hml!.findings.map((f) => `${f.severity}:${f.code}:${f.variable ?? f.origin ?? ''}`)
    expect(codes).toEqual(['blocker:missing-secret:API_TOKEN', 'warning:missing-secret:OTHER_KEY', `blocker:unreachable:${closed}`])
    expect(hml!.findings[0]!.hint).toContain('vvpost secrets set hml API_TOKEN')
    expect(hml!.findings[2]!.message).toContain('conexão recusada')

    // prod não declara TENANT nem API_TOKEN: o conector não roda lá.
    expect(prod!.findings.filter((f) => f.code === 'undefined-variable').map((f) => f.variable)).toEqual(['TENANT', 'API_TOKEN'])
    expect(report.unverified.join(' ')).toContain('auth')
  })

  it('sem sondagem, nada abre conexão; ambiente pedido limita; origem pelo proxy fica não verificada', async () => {
    let calls = 0
    const ws = await loaded({ dev: { API_TOKEN } })
    const off = await checkReadiness(ws, { probe: false, connectTo: async () => void calls++ })
    expect(calls).toBe(0)
    expect(off.environments.every((e) => e.probes === undefined)).toBe(true)

    const viaProxy = await checkReadiness(ws, {
      environmentIds: ['dev'],
      proxy: { mode: 'manual', url: 'http://proxy.local:3128' },
      connectTo: async () => void calls++
    })
    // Loopback nunca passa pelo proxy: a conexão é direta.
    expect(calls).toBe(1)
    expect(viaProxy.environments.map((e) => e.id)).toEqual(['dev'])

    put('environments/dev.env.json', { id: 'dev', name: 'DEV', variables: { BASE_URL: { type: 'string', value: 'https://api.exemplo.com' }, TENANT: { type: 'string', value: 't' } } })
    const remote = await checkReadiness(await loaded(), { environmentIds: ['dev'], proxy: { mode: 'manual', url: 'http://proxy.local:3128' }, connectTo: async () => void calls++ })
    expect(calls).toBe(1)
    expect(remote.environments[0]!.probes).toEqual([{ origin: 'https://api.exemplo.com', ok: null, error: expect.stringContaining('proxy') }])
    expect(remote.unverified).toContain('as origens que passam pelo proxy')
  })

  it('workspace sem conector e conector com herança quebrada bloqueiam', async () => {
    put('connectors/filho.connector.vvpost.json', { id: 'filho', name: 'Filho', version: '1.0.0', extends: 'nao-existe', config: {}, endpoints: [] })
    const report = await checkReadiness(await loaded({ dev: { API_TOKEN } }), { environmentIds: ['dev'] })
    expect(report.workspace.map((f) => `${f.code}:${f.connector}`)).toContain('connector-error:filho')
    expect(report.ready).toBe(false)
    rmSync(join(workspace, 'connectors'), { recursive: true })
    const empty = await checkReadiness(await loaded(), { probe: false })
    expect(empty.workspace.map((f) => f.code)).toContain('empty-catalog')
  })
})

describe('check_readiness no MCP', () => {
  const http = createHttpDispatcher()
  afterAll(() => http.close())

  it('soma o que limita só a IA e nunca devolve o valor de um segredo', async () => {
    await addReviewMarks(workspace, ['billing'])
    const server = createMcpServer({ workspaceDir: workspace, http, auth: createAuthEngine(), allowEnvironments: new Set(['dev']) })
    const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_readiness', arguments: { probe: false } } })) as JsonRpcResponse
    const result = res.result as { isError: boolean; content: { text: string }[] }
    expect(result.isError).toBe(false)
    const report = JSON.parse(result.content[0]!.text) as {
      ready: boolean
      workspace: { code: string; severity: string }[]
      environments: { id: string; canExecute: boolean; agentCanExecute: boolean; findings: { code: string; severity: string }[] }[]
      hint: string
    }
    expect(report.workspace).toContainEqual(expect.objectContaining({ code: 'review-pending', severity: 'agent' }))
    const byId = Object.fromEntries(report.environments.map((e) => [e.id, e]))
    expect(byId['prod']!.findings.map((f) => f.code)).toContain('protected')
    expect(byId['hml']!.findings.map((f) => f.code)).toContain('not-allowed')
    expect(Object.values(byId).every((e) => !e.agentCanExecute)).toBe(true)
    expect(report.hint).toContain('bloqueio')

    const bad = (await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_readiness', arguments: { environmentIds: ['qa'] } } })) as JsonRpcResponse
    expect((bad.result as { isError: boolean; content: { text: string }[] }).content[0]!.text).toContain('dev, hml, prod')
  })
})

describe('vvpost doctor', () => {
  const cli = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
    let stdout = ''
    let stderr = ''
    const io: Io = {
      openExternal: async () => {},
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

  it('sai com 2 no bloqueio e 0 quando o segredo do CI chega; o valor nunca aparece', async () => {
    const blocked = await cli(['doctor', '--env', 'dev', '--proxy', 'off'])
    expect(blocked.code).toBe(2)
    expect(blocked.stdout).toContain('✗ dev')
    expect(blocked.stdout).toContain('vvpost secrets set dev API_TOKEN')

    const ok = await cli(['doctor', '--env', 'dev', '--proxy', 'off', '--json', '-'], { VVPOST_SECRET_API_TOKEN: API_TOKEN })
    expect(ok.code).toBe(0)
    const report = JSON.parse(ok.stdout) as { ready: boolean; environments: { id: string; probes: { ok: boolean }[] }[] }
    expect(report.ready).toBe(true)
    expect(report.environments[0]!.probes[0]!.ok).toBe(true)
    expect(ok.stdout + ok.stderr).not.toContain(API_TOKEN)

    const noProbe = await cli(['doctor', '--env', 'hml', '--no-probe'], { VVPOST_SECRET_API_TOKEN: API_TOKEN })
    expect(noProbe.stdout).not.toContain('não responde')
    expect(noProbe.stdout).toContain('OTHER_KEY')
    expect(noProbe.code).toBe(0)
  })
})
