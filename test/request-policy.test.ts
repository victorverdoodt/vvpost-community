import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HttpRequestInput, HttpResult } from '@shared/ipc'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { sendHeadless } from '@vvpost/core/connectors/headless'
import { createMcpServer } from '../src/main/mcp/server'
import { createRequestGuard, parseOriginPattern } from '@vvpost/core/policy/request-policy'

// Permissões e limites de quem dispara requisições sem um humano.

function fakeHttp(delayMs = 0) {
  const sent: HttpRequestInput[] = []
  return {
    sent,
    cancel() {},
    async send(input: HttpRequestInput): Promise<HttpResult> {
      sent.push(input)
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      const body = input.url.endsWith('/token') ? JSON.stringify({ access_token: 'tok', expires_in: 3600 }) : '{"ok":true}'
      return {
        ok: true,
        response: { status: 200, statusText: 'OK', headers: [], body, sizeBytes: body.length, truncated: false, timings: { ttfbMs: 1, downloadMs: 0, totalMs: 1 } }
      }
    }
  }
}

describe('guard de requisições', () => {
  it('origens: exata, subdomínio e porta curinga', () => {
    const exact = parseOriginPattern('https://api.exemplo.com')
    expect(exact(new URL('https://api.exemplo.com/x'))).toBe(true)
    expect(exact(new URL('https://api.exemplo.com:443/x'))).toBe(true)
    expect(exact(new URL('http://api.exemplo.com/x'))).toBe(false)
    expect(exact(new URL('https://api.exemplo.com:8443/x'))).toBe(false)
    expect(exact(new URL('https://api.exemplo.com.evil.io/x'))).toBe(false)
    const sub = parseOriginPattern('https://*.exemplo.com')
    expect(sub(new URL('https://a.b.exemplo.com'))).toBe(true)
    expect(sub(new URL('https://exemplo.com'))).toBe(false)
    expect(sub(new URL('https://maliciosoexemplo.com'))).toBe(false)
    expect(parseOriginPattern('http://localhost:*')(new URL('http://localhost:4460'))).toBe(true)
    expect(() => parseOriginPattern('api.exemplo.com')).toThrow(/origem inválida/)
  })

  it('método, ambiente, origem, total e taxa', async () => {
    let now = 0
    const guard = createRequestGuard(
      {
        actor: 'teste',
        allowMethods: new Set(['GET']),
        allowEnvironments: new Set(['dev']),
        allowOrigins: ['https://api.exemplo.com'],
        maxRequests: 3,
        rate: { requests: 2, perMs: 1000 }
      },
      () => now
    )
    const req = { method: 'GET' as const, url: 'https://api.exemplo.com/a', environmentId: 'dev' }
    const deny = async (r: typeof req | Record<string, unknown>) => {
      const d = await guard.admit(r as typeof req)
      return d.ok ? 'ok' : d.message
    }
    expect(await deny({ ...req, method: 'DELETE' })).toMatch(/não pode usar DELETE/)
    expect(await deny({ ...req, environmentId: 'prod' })).toMatch(/ambiente "prod"/)
    expect(await deny({ ...req, environmentId: undefined })).toMatch(/sem ambiente/)
    expect(await deny({ ...req, url: 'https://outra.com/a' })).toMatch(/https:\/\/outra.com/)
    expect(await deny(req)).toBe('ok')
    expect(await deny(req)).toBe('ok')
    expect(await deny(req)).toMatch(/2 requisições em 1 s; tente de novo em 1 s/)
    now = 1000
    expect(await deny(req)).toBe('ok')
    now = 5000
    expect(await deny(req)).toMatch(/limite de 3 requisições por execução/)
    // Recusas não contam.
    expect(guard.count).toBe(3)
  })

  it('concorrência: o excedente espera a vez, e o timeout respeita o teto', async () => {
    const guard = createRequestGuard({ actor: 't', maxConcurrent: 2, maxTimeoutMs: 5000 })
    const req = { method: 'GET' as const, url: 'https://a.com' }
    const a = await guard.admit(req)
    const b = await guard.admit({ ...req, timeoutMs: 60_000 })
    expect(a.ok && a.timeoutMs).toBe(5000)
    expect(b.ok && b.timeoutMs).toBe(5000)
    let third = false
    const c = guard.admit(req).then((d) => ((third = true), d))
    await new Promise((r) => setTimeout(r, 10))
    expect(third).toBe(false)
    if (a.ok) a.release()
    expect((await c).ok).toBe(true)
    // Cancelar quem espera tira da fila.
    const controller = new AbortController()
    const d = guard.admit(req, controller.signal)
    controller.abort()
    expect(await d).toEqual({ ok: false, message: 'Requisição cancelada' })
  })
})

describe('sendHeadless com guard', () => {
  it('recusa com POLICY_DENIED antes do fluxo de auth, e cada tentativa conta', async () => {
    const http = fakeHttp()
    const ws = {
      dir: '/ws',
      connectors: new Map([
        [
          'c',
          {
            id: 'c',
            name: 'C',
            version: '1.0.0',
            config: { baseUrl: 'https://api.exemplo.com', auth: { type: 'oauth2' as const, grantType: 'client_credentials' as const, tokenUrl: '/token', clientId: 'x' } }
          }
        ]
      ]),
      connectorFiles: new Map(),
      environments: new Map(),
      secrets: {},
      issues: []
    }
    const guard = createRequestGuard({ actor: 'a IA (MCP)', allowMethods: new Set(['GET']) })
    const ctx = { workspace: ws, auth: createAuthEngine(), http, guard }
    const denied = await sendHeadless({ id: '1', method: 'DELETE', url: '/x', headers: [], connectorId: 'c' }, ctx)
    expect(denied).toMatchObject({ ok: false, error: { code: 'POLICY_DENIED', message: expect.stringContaining('DELETE') } })
    expect(http.sent).toEqual([])
    const ok = await sendHeadless({ id: '2', method: 'GET', url: '/x', headers: [], connectorId: 'c' }, ctx)
    expect(ok.ok).toBe(true)
    // O token endpoint (POST) é do conector: passa mesmo com só GET permitido.
    expect(http.sent.map((s) => `${s.method} ${s.url}`)).toEqual(['POST https://api.exemplo.com/token', 'GET https://api.exemplo.com/x'])
    expect(guard.count).toBe(1)
  })
})

describe('MCP', () => {
  let dir: string
  const write = (path: string, data: unknown) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), JSON.stringify(data, null, 2))
  }
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vvpost-policy-'))
    write('connectors/api.connector.vvpost.json', {
      id: 'api',
      name: 'API',
      version: '1.0.0',
      config: { baseUrl: 'https://api.exemplo.com' },
      endpoints: [
        { id: 'list', name: 'Listar', method: 'GET', path: '/items', scenarios: [{ id: 'ok', name: 'OK', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }] },
        { id: 'drop', name: 'Apagar', method: 'DELETE', path: '/items/1', scenarios: [{ id: 'ok', name: 'OK', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }] }
      ]
    })
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const call = async (server: ReturnType<typeof createMcpServer>, args: Record<string, unknown>) => {
    const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'execute_dry_run', arguments: args } })) as {
      result: { isError: boolean; content: { text: string }[] }
    }
    return { isError: res.result.isError, data: JSON.parse(res.result.content[0]!.text) }
  }

  it('--allow-methods bloqueia o método antes de enviar, e plan continua livre', async () => {
    const http = fakeHttp()
    const server = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine(), allowMethods: new Set(['GET', 'HEAD']) })
    const blocked = await call(server, { connectorId: 'api', endpointId: 'drop' })
    expect(blocked.isError).toBe(true)
    expect(blocked.data.error).toMatch(/DELETE drop bloqueado.*GET, HEAD/)
    expect((await call(server, { connectorId: 'api', endpointId: 'drop', plan: true })).isError).toBe(false)
    expect((await call(server, { connectorId: 'api', endpointId: 'list' })).data.totals).toMatchObject({ passed: 1 })
    expect(http.sent.map((s) => s.method)).toEqual(['GET'])
  })

  it('o limite de taxa vale entre chamadas e volta como POLICY_DENIED', async () => {
    const http = fakeHttp()
    const server = createMcpServer({
      workspaceDir: dir,
      http,
      auth: createAuthEngine(),
      limits: { rate: { requests: 2, perMs: 60_000 }, maxConcurrent: 4 }
    })
    const req = { connectorId: 'api', request: { endpointId: 'list' } }
    expect((await call(server, req)).data.results[0].outcome).toBe('passed')
    expect((await call(server, req)).data.results[0].outcome).toBe('passed')
    const third = (await call(server, req)).data.results[0]
    expect(third).toMatchObject({ outcome: 'error', error: { code: 'POLICY_DENIED', message: expect.stringMatching(/a IA \(MCP\) passou do limite de 2/) } })
    expect(http.sent).toHaveLength(2)
  })

  it('padrão: no máximo 4 requisições da IA ao mesmo tempo', async () => {
    const http = fakeHttp(30)
    let peak = 0
    let active = 0
    const send = http.send
    http.send = async (input) => {
      peak = Math.max(peak, ++active)
      try {
        return await send(input)
      } finally {
        active--
      }
    }
    const server = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine() })
    const req = { connectorId: 'api', request: { endpointId: 'list' } }
    await Promise.all(Array.from({ length: 8 }, () => call(server, req)))
    expect(http.sent).toHaveLength(8)
    expect(peak).toBe(4)
  })
})
