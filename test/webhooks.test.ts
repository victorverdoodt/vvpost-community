import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Flow } from '@vvpost/schemas'
import { validateFlow, validateWebhooksConfig } from '@vvpost/schemas'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { loadWorkspace, type LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import { pathMatches, webhookBody } from '@vvpost/core/flows/webhook'
import { createHttpDispatcher, type HttpDispatcher } from '@vvpost/core/http/dispatcher'
import { runFlowWith } from '@vvpost/core/run'
import { createCoreSession } from '@vvpost/core/session'
import type { WebhookEvent, WebhookSource } from '@vvpost/core/types'
import { main, type Io } from '../src/main/cli'
import { createMcpServer } from '../src/main/mcp/server'
import { addReviewMarks } from '../src/main/project/review'
import { loadWebhooksConfig } from '../src/main/webhooks/config'
import { createWebhookInbox, type WebhookInbox } from '../src/main/webhooks/inbox'
import { replayEvent } from '../src/main/webhooks/replay'
import { startWebhookServer, type RunningWebhookServer } from '../src/main/webhooks/server'
import { createTriggerQueue, runTrigger } from '../src/main/webhooks/triggers'

// Gerados a cada execução: nenhum valor com cara de credencial fica commitado.
const SIGNING_KEY = `whsec-${randomBytes(12).toString('hex')}`
const API_TOKEN = `tok-${randomBytes(8).toString('hex')}`

let api: Server
let origin = ''
let http: HttpDispatcher
let root = ''
let dir = ''
let running: RunningWebhookServer | null = null

const put = (path: string, data: unknown) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}

const sign = (body: string, key = SIGNING_KEY) => `sha256=${createHmac('sha256', key).update(body).digest('hex')}`

interface Sent {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** node:http no lugar do fetch: o teste precisa mandar Host e Origin à vontade. */
function send(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: opts.method ?? 'POST', headers: opts.headers ?? {} }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

const json = (data: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })

async function until<T>(check: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error('o tempo acabou esperando a condição')
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeAll(async () => {
  api = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.headers.authorization !== `Bearer ${API_TOKEN}`) {
      res.statusCode = 401
      return res.end('{"error":"unauthorized"}')
    }
    res.end(JSON.stringify({ id: 'ord_1', status: 'PENDING' }))
  })
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
  http = createHttpDispatcher()
})

afterAll(async () => {
  await http.close()
  await new Promise((r) => api.close(r))
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vvpost-webhooks-'))
  dir = join(root, 'ws')
  put('environments/dev.env.json', {
    id: 'dev',
    name: 'Dev',
    variables: {
      BASE_URL: { type: 'string', value: origin },
      API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true },
      GH_SECRET: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
    }
  })
  put('.vvpost/secrets.local.json', { dev: { API_TOKEN, GH_SECRET: SIGNING_KEY } })
  put('connectors/orders.connector.vvpost.json', {
    id: 'orders',
    name: 'Orders',
    version: '1.0.0',
    config: { baseUrl: '{{BASE_URL}}', auth: { type: 'bearer', token: '{{API_TOKEN}}' } },
    endpoints: [
      {
        id: 'get',
        name: 'Pedido',
        method: 'GET',
        path: '/orders/1',
        scenarios: [{ id: 'ok', name: 'Ok', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }]
      }
    ]
  })
  put('flows/paid.flow.vvpost.json', {
    id: 'flow.paid',
    name: 'Pago',
    nodes: [
      { id: 'evt', name: 'Evento', type: 'webhook', webhook: { hook: 'payments' } },
      {
        id: 'check',
        name: 'Pago',
        type: 'condition',
        failWhenFalse: true,
        condition: { target: '$nodes.Evento.data.body.status', operator: 'equals', expected: 'paid' }
      },
      { id: 'order', name: 'Pedido', type: 'request', request: { connector: 'orders', endpoint: 'get' } }
    ],
    edges: [
      { from: 'evt', to: 'check' },
      { from: 'check', to: 'order' }
    ]
  })
  put('.vvpost/webhooks.json', {
    maxBodyKB: 1,
    hooks: [
      {
        id: 'github',
        path: '/github',
        methods: ['POST'],
        signature: { header: 'X-Hub-Signature-256', secret: '{{GH_SECRET}}', prefix: 'sha256=' }
      },
      { id: 'nokey', path: '/nokey', signature: { header: 'X-Sig', secret: '{{SEM_VALOR}}' } },
      { id: 'deploys', path: '/deploys/*', response: { status: 202, headers: { 'x-hook': 'deploys' }, body: { ok: true } } },
      { id: 'deploy-prod', path: '/deploys/prod' },
      { id: 'payments', path: '/payments', trigger: { flow: 'flow.paid', environment: 'dev' } },
      { id: 'smoke', path: '/smoke', trigger: { connector: 'orders', scenarios: ['get'] } }
    ]
  })
})

afterEach(async () => {
  await running?.close()
  running = null
  rmSync(root, { recursive: true, force: true })
})

const start = (options: Partial<Parameters<typeof startWebhookServer>[1]> = {}) =>
  startWebhookServer(dir, { port: 0, workspace: () => loadWorkspace(dir), ...options }).then((s) => (running = s))

describe('webhooks.json', () => {
  it('a chave da assinatura só pode ser uma variável, nunca o valor', () => {
    const literal = validateWebhooksConfig({ hooks: [{ id: 'a', path: '/a', signature: { header: 'X-Sig', secret: 'abc123' } }] })
    expect(literal.ok).toBe(false)
    const ok = validateWebhooksConfig({ hooks: [{ id: 'a', path: '/a', signature: { header: 'X-Sig', secret: '{{ KEY }}' } }] })
    expect(ok.ok).toBe(true)
  })

  it('recusa hooks com o mesmo id ou o mesmo caminho, e trigger com fluxo e conector juntos', () => {
    expect(validateWebhooksConfig({ hooks: [{ id: 'a', path: '/a' }, { id: 'a', path: '/b' }] }).ok).toBe(false)
    expect(validateWebhooksConfig({ hooks: [{ id: 'a', path: '/a' }, { id: 'b', path: '/a/' }] }).ok).toBe(false)
    expect(validateWebhooksConfig({ hooks: [{ id: 'a', path: '/a', trigger: { flow: 'f', connector: 'c' } }] }).ok).toBe(false)
    expect(validateWebhooksConfig({ hooks: [{ id: 'a', path: '/a', trigger: { connector: 'c', scenarios: ['e/s'] } }] }).ok).toBe(true)
  })

  it('sem o arquivo, o servidor usa os padrões; arquivo inválido é erro com o caminho', async () => {
    rmSync(join(dir, '.vvpost/webhooks.json'))
    expect(await loadWebhooksConfig(dir)).toMatchObject({ file: false, port: 4480, hooks: [], maxBodyBytes: 1024 * 1024 })
    put('.vvpost/webhooks.json', { port: 80 })
    await expect(loadWebhooksConfig(dir)).rejects.toThrow(/webhooks.json inválido/)
  })

  it('o nó webhook é válido no schema de fluxo', () => {
    const flow = { id: 'f', name: 'F', nodes: [{ id: 'w', name: 'W', type: 'webhook', webhook: { path: '/cb/{{ $nodes.A.data.id }}', method: 'POST', timeoutMs: 500 } }], edges: [] }
    expect(validateFlow(flow).ok).toBe(true)
  })

  it('caminhos: exato, /* e o corpo lido por content-type', () => {
    expect(pathMatches('/a/', '/a')).toBe(true)
    expect(pathMatches('/a/*', '/a/b/c')).toBe(true)
    expect(pathMatches('/a/*', '/ab')).toBe(false)
    expect(pathMatches('/*', '/qualquer')).toBe(true)
    const headers = (type: string) => [{ name: 'Content-Type', value: type }]
    expect(webhookBody({ headers: headers('application/json'), body: '{"a":1}' })).toEqual({ a: 1 })
    expect(webhookBody({ headers: headers('application/x-www-form-urlencoded'), body: 'a=1&a=2&b=3' })).toEqual({ a: ['1', '2'], b: '3' })
    expect(webhookBody({ headers: headers('text/plain'), body: 'oi' })).toBe('oi')
  })
})

describe('caixa de entrada', () => {
  const event = (over: Partial<WebhookEvent> = {}): Omit<WebhookEvent, 'id'> => ({
    receivedAt: new Date().toISOString(),
    method: 'POST',
    path: '/x',
    url: '/x',
    query: {},
    headers: [],
    body: '',
    sizeBytes: 0,
    truncated: false,
    response: { status: 200, durationMs: 0 },
    ...over
  })

  it('guarda os últimos, do mais novo para o mais antigo, e os ids não voltam ao limpar', () => {
    const inbox = createWebhookInbox({ maxEvents: 2 })
    for (let i = 0; i < 3; i++) inbox.add(event())
    expect(inbox.list().map((e) => e.id)).toEqual([3, 2])
    inbox.clear()
    expect(inbox.add(event()).id).toBe(4)
  })

  it('quem espera recebe o próximo que casa; recusados não contam; o tempo acaba em null', async () => {
    const inbox = createWebhookInbox()
    inbox.add(event({ path: '/old' }))
    const waiting = inbox.wait((e) => e.path === '/old' || e.path === '/new', { since: inbox.cursor(), timeoutMs: 2000 })
    inbox.add(event({ path: '/new', rejected: 'assinatura inválida' }))
    const good = inbox.add(event({ path: '/new' }))
    expect((await waiting)?.id).toBe(good.id)
    expect(await inbox.wait(() => true, { since: inbox.cursor(), timeoutMs: 20 })).toBeNull()
    const controller = new AbortController()
    const aborted = inbox.wait(() => true, { since: inbox.cursor(), timeoutMs: 2000, signal: controller.signal })
    controller.abort()
    await expect(aborted).rejects.toBeDefined()
  })
})

describe('servidor local', () => {
  it('aceita qualquer caminho e responde como o hook manda, escolhendo o hook mais específico', async () => {
    const s = await start()
    const plain = await send(`${s.url}/qualquer/coisa?x=1&x=2`, json({ a: 1 }))
    expect(plain.status).toBe(200)
    expect(JSON.parse(plain.body)).toEqual({ received: true, id: Number(plain.headers['x-vvpost-event']) })
    const deploy = await send(`${s.url}/deploys/hml`, json({}))
    expect(deploy.status).toBe(202)
    expect(deploy.headers['x-hook']).toBe('deploys')
    expect(JSON.parse(deploy.body)).toEqual({ ok: true })
    await send(`${s.url}/deploys/prod`, json({}))
    const [prod, hml, first] = s.inbox.list()
    expect(prod!.hookId).toBe('deploy-prod')
    expect(hml!.hookId).toBe('deploys')
    expect(first!.hookId).toBeUndefined()
    expect(first!.query).toEqual({ x: ['1', '2'] })
    expect(first!.body).toBe('{"a":1}')
  })

  it('confere a assinatura HMAC com a chave do vault, sem a chave aparecer em lugar nenhum', async () => {
    const s = await start()
    const body = JSON.stringify({ action: 'opened' })
    const ok = await send(`${s.url}/github`, { headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body })
    expect(ok.status).toBe(200)
    const bad = await send(`${s.url}/github`, { headers: { 'x-hub-signature-256': sign(body, 'outra-chave') }, body })
    expect(bad.status).toBe(401)
    const missing = await send(`${s.url}/github`, { body })
    expect(missing.status).toBe(401)
    const noKey = await send(`${s.url}/nokey`, { headers: { 'x-sig': 'abc' }, body })
    expect(noKey.status).toBe(500)
    expect(noKey.body).toContain('SEM_VALOR')
    const events = s.inbox.list()
    expect(events.map((e) => e.signature)).toEqual(['unconfigured', 'missing', 'invalid', 'valid'])
    expect(events.slice(0, 3).every((e) => e.rejected)).toBe(true)
    expect(JSON.stringify(events) + bad.body + missing.body + noKey.body).not.toContain(SIGNING_KEY)
  })

  it('recusa navegador (Origin), host de fora (DNS rebinding), método fora do hook e corpo grande', async () => {
    const s = await start()
    expect((await send(`${s.url}/x`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await send(`${s.url}/x`, { headers: { host: 'evil.example' } })).status).toBe(403)
    const get = await send(`${s.url}/github`, { method: 'GET' })
    expect(get.status).toBe(405)
    expect(get.headers['allow']).toBe('POST')
    expect((await send(`${s.url}/big`, { headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(2048) })).status).toBe(413)
    const reasons = s.inbox.list().map((e) => e.rejected)
    expect(reasons).toEqual([expect.stringContaining('1 KB'), expect.stringContaining('POST'), expect.stringContaining('evil.example'), expect.stringContaining('Origin')])
  })

  it('allowHosts libera um túnel; corpo binário fica em base64', async () => {
    put('.vvpost/webhooks.json', { allowHosts: ['*.ngrok-free.app'] })
    const s = await start()
    expect((await send(`${s.url}/x`, { headers: { host: 'abc.ngrok-free.app' } })).status).toBe(200)
    const bytes = Buffer.from([0, 1, 2, 255])
    await send(`${s.url}/bin`, { headers: { 'content-type': 'application/octet-stream' }, body: bytes })
    const [bin] = s.inbox.list()
    expect(bin!.bodyBase64).toBe(bytes.toString('base64'))
    expect(bin!.sizeBytes).toBe(4)
  })

  it('reenviar um evento chega de novo, marcado como reenvio', async () => {
    const s = await start()
    await send(`${s.url}/replay?a=1`, json({ n: 1 }))
    const original = s.inbox.list()[0]!
    const again = await replayEvent(s.url, original)
    expect(again.status).toBe(200)
    const copy = s.inbox.get(again.id!)!
    expect(copy.url).toBe('/replay?a=1')
    expect(copy.body).toBe('{"n":1}')
    expect(copy.headers.find((h) => h.name.toLowerCase() === 'x-vvpost-replay-of')?.value).toBe(String(original.id))
  })
})

describe('disparos', () => {
  async function serveWithTriggers() {
    let inbox: WebhookInbox | null = null
    const core = createCoreSession({ workspaceDir: dir, http, webhooks: async () => inbox! })
    let queue: ReturnType<typeof createTriggerQueue> | null = null
    const s = await start({ onTrigger: (e, h) => queue?.enqueue(e, h) })
    inbox = s.inbox
    queue = createTriggerQueue({
      inbox: s.inbox,
      environment: s.environment,
      run: (job, signal) =>
        runTrigger(
          job,
          {
            workspaceDir: dir,
            loadWorkspace: () => core.load(),
            loadFlows: () => core.loadFlows(),
            runFlow: (input, ws, o) => core.runFlow(input, ws, o),
            runScenarios: (input, ws, sig) => core.runScenarios(input, ws, sig)
          },
          signal
        ).then(({ report: _, ...outcome }) => outcome)
    })
    const finished = (id: number) => until(() => {
      const t = s.inbox.get(id)?.trigger
      return t && !['queued', 'running'].includes(t.status) ? t : undefined
    })
    return { s, finished, close: async () => { queue?.close(); await core.close() } }
  }

  it('o hook dispara o fluxo, e o nó webhook do fluxo lê o evento que disparou', async () => {
    const { s, finished, close } = await serveWithTriggers()
    const paid = await send(`${s.url}/payments`, json({ status: 'paid' }))
    const ok = await finished(Number(paid.headers['x-vvpost-event']))
    expect(ok, JSON.stringify(ok)).toMatchObject({ kind: 'flow', target: 'flow.paid', environmentId: 'dev', status: 'passed' })
    const open = await send(`${s.url}/payments`, json({ status: 'open' }))
    const failed = await finished(Number(open.headers['x-vvpost-event']))
    expect(failed.status).toBe('failed')
    expect(failed.message).toContain('Pago')
    await close()
  })

  it('o hook dispara os cenários de um endpoint; conector mudado pela IA espera a revisão', async () => {
    const { s, finished, close } = await serveWithTriggers()
    const first = await send(`${s.url}/smoke`, {})
    expect(await finished(Number(first.headers['x-vvpost-event']))).toMatchObject({ kind: 'scenarios', status: 'passed', message: '1 passaram, 0 falharam, 0 com erro' })
    await addReviewMarks(dir, ['orders'])
    const second = await send(`${s.url}/smoke`, {})
    const skipped = await finished(Number(second.headers['x-vvpost-event']))
    expect(skipped.status).toBe('skipped')
    expect(skipped.message).toContain('revisão')
    await close()
  })

  it('disparo automático não roda em ambiente protegido (produção)', async () => {
    const ws = { environments: new Map([['env.prod', { id: 'env.prod', name: 'Produção', variables: {} }]]) }
    const fail = () => Promise.reject(new Error('não devia rodar'))
    const event = { id: 1 } as WebhookEvent
    const out = await runTrigger(
      { event, hook: { id: 'h', path: '/h', trigger: { flow: 'flow.paid' } }, environmentId: 'env.prod' },
      { workspaceDir: dir, loadWorkspace: async () => ws as unknown as LoadedWorkspace, loadFlows: fail, runFlow: fail, runScenarios: fail },
      new AbortController().signal
    )
    expect(out.status).toBe('skipped')
    expect(out.message).toMatch(/"Produção" é um ambiente protegido.*"protected": false/)
  })

  it('a fila tem limite: além dele o evento é pulado', async () => {
    const inbox = createWebhookInbox()
    const hook = { id: 'h', path: '/h', trigger: { flow: 'x' } }
    let release: () => void = () => {}
    const blocked = new Promise<void>((r) => (release = r))
    const queue = createTriggerQueue({ inbox, environment: null, concurrency: 1, maxQueued: 1, run: async () => { await blocked; return { status: 'passed' } } })
    const add = () => inbox.add({ receivedAt: '', method: 'POST', path: '/h', url: '/h', query: {}, headers: [], body: '', sizeBytes: 0, truncated: false, response: { status: 200, durationMs: 0 } })
    const [a, b, c] = [add(), add(), add()]
    for (const e of [a, b, c]) queue.enqueue(e, hook)
    expect(inbox.get(a.id)!.trigger!.status).toBe('running')
    expect(inbox.get(b.id)!.trigger!.status).toBe('queued')
    expect(inbox.get(c.id)!.trigger!.status).toBe('skipped')
    release()
    await until(() => inbox.get(b.id)!.trigger!.status === 'passed')
    queue.close()
  })
})

describe('nó webhook no fluxo', () => {
  const callbackFlow = (webhook: Record<string, unknown>): Flow =>
    ({
      id: 'flow.cb',
      name: 'Callback',
      nodes: [
        { id: 'order', name: 'Pedido', type: 'request', request: { connector: 'orders', endpoint: 'get' } },
        { id: 'cb', name: 'Retorno', type: 'webhook', webhook }
      ],
      edges: [{ from: 'order', to: 'cb' }]
    }) as Flow

  const runCallback = async (webhook: Record<string, unknown>, source?: WebhookSource) =>
    runFlowWith({ runId: 'r', flow: callbackFlow(webhook), environmentId: 'dev' }, await loadWorkspace(dir), {
      auth: createAuthEngine(),
      http,
      ...(source && { webhooks: async () => source })
    })

  it('espera o callback com o id da resposta anterior no caminho e a condição until', async () => {
    const s = await start()
    // Manda os callbacks com o nó já esperando: um timer fixo, com a suíte inteira em paralelo, chega antes dele.
    let waiting!: () => void
    const ready = new Promise<void>((r) => (waiting = r))
    const source: WebhookSource = {
      cursor: () => s.inbox.cursor(),
      wait: (accept, options) => {
        const found = s.inbox.wait(accept, options)
        waiting()
        return found
      }
    }
    const running = runCallback(
      {
        path: '/callbacks/{{ $nodes.Pedido.data.id }}',
        method: 'POST',
        until: { target: '$nodes.Retorno.data.body.status', operator: 'equals', expected: 'done' },
        timeoutMs: 5000
      },
      source
    )
    await ready
    await send(`${s.url}/callbacks/ord_2`, json({ status: 'done' }))
    await send(`${s.url}/callbacks/ord_1`, json({ status: 'working' }))
    await send(`${s.url}/callbacks/ord_1`, { method: 'PUT', ...json({ status: 'done' }) })
    await send(`${s.url}/callbacks/ord_1`, json({ status: 'done', n: 3 }))
    const report = await running
    expect(report.outcome).toBe('success')
    const cb = report.results.find((r) => r.nodeId === 'cb')!
    expect(cb.output).toMatchObject({ data: { method: 'POST', path: '/callbacks/ord_1', body: { status: 'done', n: 3 } } })
  })

  it('sem evento a tempo falha com WEBHOOK_TIMEOUT; sem servidor, WEBHOOK_UNAVAILABLE', async () => {
    const s = await start()
    const late = await runCallback({ path: '/never', timeoutMs: 100 }, s.inbox)
    expect(late.results.find((r) => r.nodeId === 'cb')?.error?.code).toBe('WEBHOOK_TIMEOUT')
    const none = await runCallback({ path: '/never' })
    expect(none.results.find((r) => r.nodeId === 'cb')?.error?.code).toBe('WEBHOOK_UNAVAILABLE')
  })
})

describe('MCP e CLI', () => {
  it('list_webhook_events e get_webhook_event devolvem eventos com credenciais mascaradas', async () => {
    const s = await start()
    await send(`${s.url}/github`, { headers: { authorization: `Bearer ${API_TOKEN}`, 'x-hub-signature-256': sign('{}') }, body: '{}' })
    await send(`${s.url}/echo`, json({ token: API_TOKEN, note: 'ok' }))
    const server = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine(), webhooks: () => ({ url: s.url, inbox: s.inbox }) })
    const call = async (name: string, args: Record<string, unknown>) => {
      const reply = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      const result = (reply as { result: { content: { text: string }[]; isError?: boolean } }).result
      return { text: result.content[0]!.text, isError: !!result.isError }
    }
    const list = await call('list_webhook_events', {})
    const parsed = JSON.parse(list.text) as { url: string; hooks: { id: string }[]; events: { id: number; hook?: string }[] }
    expect(parsed.url).toBe(s.url)
    expect(parsed.hooks.map((h) => h.id)).toContain('github')
    expect(parsed.events.map((e) => e.hook)).toEqual([undefined, 'github'])
    const all = list.text + (await call('get_webhook_event', { id: parsed.events[0]!.id })).text + (await call('get_webhook_event', { id: parsed.events[1]!.id })).text
    expect(all).not.toContain(API_TOKEN)
    expect(all).not.toContain(SIGNING_KEY)
    expect(all).toContain('[REDACTED')
    const off = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine() })
    const reply = await off.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_webhook_events', arguments: {} } })
    expect(JSON.stringify(reply)).toContain('desligado')
  })

  const io = (controller: AbortController, out: { stdout: string; stderr: string }): Io => ({
    stdout: (t) => (out.stdout += t),
    stderr: (t) => (out.stderr += t),
    env: { VVPOST_USER_DATA: join(root, 'user-data') },
    cwd: root,
    isTTY: false,
    appDir: join(root, 'app'),
    signal: controller.signal,
    http
  })

  it('vvpost webhooks mostra cada evento e roda o disparo até o Ctrl+C', async () => {
    const controller = new AbortController()
    const out = { stdout: '', stderr: '' }
    const code = main(['webhooks', '--workspace', dir, '--port', '0'], io(controller, out))
    const url = await until(() => /Webhooks em (http:\/\/127\.0\.0\.1:\d+)/.exec(out.stderr)?.[1], 3000).catch(() => { throw new Error(out.stderr + out.stdout) })
    await send(`${url}/payments`, { headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` }, body: '{"status":"paid"}' })
    await until(() => out.stdout.includes('fluxo flow.paid em dev: passed'), 3000).catch(() => { throw new Error(out.stdout + out.stderr) })
    controller.abort()
    expect(await code).toBe(0)
    expect(out.stdout).toMatch(/#1 {2}POST {2}\/payments {2}200 {2}hook payments/)
    expect(out.stdout + out.stderr).not.toContain(API_TOKEN)
  })

  it('vvpost run liga o servidor sozinho quando um fluxo tem nó webhook', async () => {
    const controller = new AbortController()
    const out = { stdout: '', stderr: '' }
    const code = main(['run', '--workspace', dir, '--env', 'dev', '--flow', 'flow.paid', '--port', '0'], io(controller, out))
    const url = await until(() => /Webhooks em (http:\/\/127\.0\.0\.1:\d+)/.exec(out.stderr)?.[1], 3000).catch(() => { throw new Error(out.stderr + out.stdout) })
    await send(`${url}/payments`, json({ status: 'paid' }))
    expect(await code).toBe(0)
    expect(out.stdout).toContain('Fluxo · flow.paid [dev]')
  })
})
