import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Flow } from '@vvpost/schemas'
import type { HttpRequestInput } from '@vvpost/core/types'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { sendHeadless } from '@vvpost/core/connectors/headless'
import { loadWorkspace, type LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import { prepareRequest } from '@vvpost/core/flows/prepare'
import { runFlow } from '@vvpost/core/flows/run'
import { createHttpDispatcher, type HttpDispatcher } from '@vvpost/core/http/dispatcher'

// Fluxo de preparação no Quick Request: o fluxo roda antes e a requisição lê os $nodes dele.
let server: Server
let origin: string
let http: HttpDispatcher
const seen: { path: string; auth?: string; body: string }[] = []

const json = (res: ServerResponse, status: number, data: unknown) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(data))
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body = ''
  for await (const chunk of req) body += chunk
  const url = new URL(req.url ?? '/', 'http://x')
  seen.push({ path: url.pathname + url.search, auth: req.headers.authorization, body })
  if (url.pathname === '/login') return json(res, 200, { token: 'prep-tok', tenant: 't-7' })
  if (url.pathname === '/fail') return json(res, 500, { error: 'boom' })
  return json(res, 200, { ok: true })
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
let ws: LoadedWorkspace
beforeEach(async () => {
  seen.length = 0
  dir = mkdtempSync(join(tmpdir(), 'vvpost-prepare-'))
  mkdirSync(join(dir, 'environments'))
  writeFileSync(
    join(dir, 'environments/dev.env.json'),
    JSON.stringify({ id: 'env.dev', name: 'Dev', variables: { ORIGIN: { type: 'string', value: origin, isSecret: false } } })
  )
  ws = await loadWorkspace(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const flow = (path: string): Flow => ({
  id: 'flow.prepare',
  name: 'Login',
  nodes: [{ id: 'login', name: 'Login', type: 'request', request: { method: 'POST', url: `{{ORIGIN}}${path}` } }],
  edges: []
})

const input: HttpRequestInput = {
  id: 'req-1',
  method: 'POST',
  url: '{{ORIGIN}}/orders?tenant={{ $nodes.Login.data.tenant }}',
  headers: [{ name: 'Authorization', value: 'Bearer {{ $nodes.Login.data.token }}' }],
  body: '{"tenant": "{{ $nodes.Login.data.tenant }}"}',
  environmentId: 'env.dev',
  prepareFlowId: 'flow.prepare'
}

const ctx = () => ({ workspace: ws, auth: createAuthEngine(), http })
const run = (f: Flow) => runFlow({ runId: 'prep', flow: f, environmentId: 'env.dev' }, ctx())

describe('fluxo de preparação no Quick Request', () => {
  it('roda o fluxo antes e a requisição lê a saída dos nós em $nodes', async () => {
    const prepared = await prepareRequest(input, flow('/login'), run)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.prepare).toMatchObject({ flowId: 'flow.prepare', flowName: 'Login', outcome: 'success', nodes: ['Login'] })
    // O modelo continua com marcadores: o valor do token só existe no extra, para o envio.
    expect(JSON.stringify(prepared.input)).not.toContain('prep-tok')
    const result = await sendHeadless(prepared.input, ctx(), { extra: prepared.extra })
    expect(result.ok).toBe(true)
    const sent = seen.at(-1)!
    expect(sent.path).toBe('/orders?tenant=t-7')
    expect(sent.auth).toBe('Bearer prep-tok')
    expect(JSON.parse(sent.body)).toEqual({ tenant: 't-7' })
    expect(seen.map((s) => s.path)).toEqual(['/login', '/orders?tenant=t-7'])
  })

  it('não envia a requisição quando um nó da preparação falha, e diz qual', async () => {
    const prepared = await prepareRequest(input, flow('/fail'), run)
    expect(prepared.ok).toBe(false)
    if (prepared.ok) return
    expect(prepared.result).toMatchObject({ ok: false, error: { code: 'PREPARE_FAILED' } })
    if (prepared.result.ok) return
    expect(prepared.result.error.message).toContain('o nó Login falhou')
    expect(prepared.result.prepare?.failed).toMatchObject({ nodeId: 'login', code: 'HTTP_STATUS' })
    expect(seen.map((s) => s.path)).toEqual(['/fail'])
  })

  it('recusa um fluxo que não existe e um campo que não está na saída', async () => {
    const missing = await prepareRequest(input, undefined, run)
    expect(!missing.ok && missing.result).toMatchObject({ error: { code: 'CONFIG_ERROR', message: expect.stringContaining('flow.prepare') } })
    const wrongField = await prepareRequest({ ...input, url: '{{ORIGIN}}/x/{{ $nodes.Login.data.nada }}' }, flow('/login'), run)
    expect(!wrongField.ok && wrongField.result).toMatchObject({ error: { code: 'CONFIG_ERROR', message: expect.stringContaining('não existe na saída') } })
  })
})
