import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HttpRequestInput } from '@shared/ipc'
import { createHttpDispatcher } from '@vvpost/core/http/dispatcher'
import { CookieJar, parseSetCookie } from '@vvpost/core/http/cookies'
import { bypasses, proxyFor } from '@vvpost/core/http/proxy'
import { createAuthEngine, sendHeadless, type LoadedWorkspace } from '@vvpost/core/connectors'
import { buildScenarioRequest } from '@vvpost/core/scenarios/request'
import type { RequestGuard } from '@vvpost/core/policy/request-policy'
import { createTestPki } from './helpers/test-pki'

let server: Server
let base: string
let other: Server
let otherBase: string
let dir: string

async function readAll(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

function echo(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: body.toString('latin1') }))
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x')
  void readAll(req).then((body) => {
    switch (url.pathname) {
      case '/login':
        res.statusCode = 302
        res.setHeader('set-cookie', ['sessao=abc123; Path=/; HttpOnly', 'tema=escuro; Path=/conta'])
        res.setHeader('location', '/conta/perfil')
        res.end()
        return
      case '/see-other':
        res.statusCode = 303
        res.setHeader('location', '/echo')
        res.end()
        return
      case '/temp':
        res.statusCode = 307
        res.setHeader('location', '/echo')
        res.end()
        return
      case '/away':
        res.statusCode = 302
        res.setHeader('location', `${otherBase}/echo`)
        res.end()
        return
      case '/logout':
        res.setHeader('set-cookie', 'sessao=; Max-Age=0; Path=/')
        res.end('ok')
        return
      default:
        echo(req, res, body)
    }
  })
}

beforeAll(async () => {
  server = createHttpServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  // Outra origem (porta diferente) para os redirecionamentos entre origens.
  other = createHttpServer((req, res) => void readAll(req).then((b) => echo(req, res, b)))
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r))
  otherBase = `http://localhost:${(other.address() as AddressInfo).port}`
  dir = await mkdtemp(join(tmpdir(), 'vvpost-http-'))
  await writeFile(join(dir, 'foto.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]))
  await writeFile(join(dir, 'dados.csv'), 'a,b\n1,2\n')
})

afterAll(async () => {
  for (const s of [server, other]) {
    s.closeAllConnections()
    await new Promise((r) => s.close(r))
  }
  await rm(dir, { recursive: true, force: true })
})

let seq = 0
const req = (over: Partial<HttpRequestInput>): HttpRequestInput => ({ id: `t${++seq}`, method: 'GET', url: `${base}/echo`, headers: [], ...over })
const json = (r: Awaited<ReturnType<ReturnType<typeof createHttpDispatcher>['send']>>) => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return JSON.parse(r.response.body) as { method: string; url: string; headers: Record<string, string>; body: string }
}

describe('corpo estruturado', () => {
  it('envia form urlencoded', async () => {
    const http = createHttpDispatcher()
    const echoed = json(
      await http.send(req({ method: 'POST', payload: { mode: 'urlencoded', fields: [{ name: 'nome', value: 'Ana Maria' }, { name: 'q', value: 'a&b=c' }] } }))
    )
    await http.close()
    expect(echoed.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(echoed.body).toBe('nome=Ana+Maria&q=a%26b%3Dc')
  })

  it('envia multipart com campos de texto e arquivos', async () => {
    const http = createHttpDispatcher()
    const echoed = json(
      await http.send(
        req({
          method: 'POST',
          payload: {
            mode: 'multipart',
            fields: [
              { name: 'descricao', value: 'olá' },
              { name: 'foto', file: join(dir, 'foto.png') },
              { name: 'planilha', file: join(dir, 'dados.csv'), filename: 'relatorio.csv', contentType: 'text/csv' }
            ]
          }
        })
      )
    )
    await http.close()
    const boundary = echoed.headers['content-type']!.match(/^multipart\/form-data; boundary=(.+)$/)![1]!
    const body = Buffer.from(echoed.body, 'latin1')
    const parts = body.toString('latin1').split(`--${boundary}`)
    expect(parts).toHaveLength(5)
    expect(parts[1]).toContain('Content-Disposition: form-data; name="descricao"\r\n\r\n')
    expect(Buffer.from(parts[1]!, 'latin1').toString('utf8')).toContain('olá')
    expect(parts[2]).toContain('name="foto"; filename="foto.png"\r\nContent-Type: image/png\r\n\r\n')
    expect(Buffer.from(parts[2]!.split('\r\n\r\n')[1]!.slice(0, 6), 'latin1')).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]))
    expect(parts[3]).toContain('filename="relatorio.csv"\r\nContent-Type: text/csv')
    expect(parts[4]).toBe('--\r\n')
  })

  it('envia um arquivo binário com o content-type pela extensão', async () => {
    const http = createHttpDispatcher()
    const echoed = json(await http.send(req({ method: 'PUT', payload: { mode: 'binary', file: join(dir, 'foto.png') } })))
    await http.close()
    expect(echoed.headers['content-type']).toBe('image/png')
    expect(Buffer.from(echoed.body, 'latin1')).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]))
  })

  it('arquivo ausente ou caminho relativo vira INVALID_REQUEST, sem enviar', async () => {
    const http = createHttpDispatcher()
    const missing = await http.send(req({ method: 'POST', payload: { mode: 'binary', file: join(dir, 'nao-existe.bin') } }))
    const relative = await http.send(req({ method: 'POST', payload: { mode: 'binary', file: 'foto.png' } }))
    await http.close()
    expect(!missing.ok && missing.error).toMatchObject({ code: 'INVALID_REQUEST', message: expect.stringContaining('não encontrado') })
    expect(!relative.ok && relative.error.code).toBe('INVALID_REQUEST')
  })

  it('na auth headless resolve {{VAR}} e caminhos relativos ao workspace; com guard, só arquivos de dentro', async () => {
    const ws = {
      dir,
      connectors: new Map(),
      environments: new Map([['dev', { id: 'dev', name: 'dev', variables: { ARQ: { value: 'foto.png' }, NOME: { value: 'Ana' } } }]]),
      secrets: {}
    } as unknown as LoadedWorkspace
    const http = createHttpDispatcher()
    const ctx = { workspace: ws, auth: createAuthEngine(), http }
    const ok = await sendHeadless(
      req({
        method: 'POST',
        environmentId: 'dev',
        payload: { mode: 'multipart', fields: [{ name: 'quem', value: '{{NOME}}' }, { name: 'f', file: '{{ARQ}}' }] }
      }),
      ctx
    )
    const guard = { admit: async () => ({ ok: true as const, timeoutMs: undefined, release: () => {} }) } as unknown as RequestGuard
    const outside = await sendHeadless(req({ method: 'POST', payload: { mode: 'binary', file: '/etc/hostname' } }), { ...ctx, guard })
    await http.close()
    const body = json(ok).body
    expect(body).toContain('Ana')
    expect(body).toContain('filename="foto.png"')
    expect(!outside.ok && outside.error.code).toBe('POLICY_DENIED')
  })

  it('o cenário troca o payload do endpoint, e overrides.body troca o corpo inteiro', () => {
    const endpoint = {
      id: 'up',
      name: 'Upload',
      method: 'POST' as const,
      path: '/up',
      payload: { mode: 'urlencoded' as const, fields: [{ name: 'a', value: '1' }] }
    }
    expect(buildScenarioRequest(endpoint, {}).payload).toEqual(endpoint.payload)
    expect(buildScenarioRequest(endpoint, { overrides: { payload: { mode: 'binary', file: 'x.bin' } } }).payload).toEqual({ mode: 'binary', file: 'x.bin' })
    const replaced = buildScenarioRequest(endpoint, { overrides: { body: { a: 2 } } })
    expect(replaced.payload).toBeUndefined()
    expect(replaced.body).toBe('{"a":2}')
    expect(buildScenarioRequest(endpoint, { overrides: { payload: null } }).payload).toBeUndefined()
  })
})

describe('redirecionamentos', () => {
  it('303 vira GET sem corpo; 307 mantém método e corpo', async () => {
    const http = createHttpDispatcher()
    const seeOther = json(await http.send(req({ method: 'POST', url: `${base}/see-other`, body: '{"x":1}' })))
    const temp = json(await http.send(req({ method: 'POST', url: `${base}/temp`, body: '{"x":1}' })))
    await http.close()
    expect(seeOther).toMatchObject({ method: 'GET', body: '' })
    expect(seeOther.headers['content-type']).toBeUndefined()
    expect(temp).toMatchObject({ method: 'POST', body: '{"x":1}' })
  })

  it('para outra origem não leva Authorization, Cookie nem headers de credencial', async () => {
    const http = createHttpDispatcher()
    const echoed = json(
      await http.send(
        req({
          url: `${base}/away`,
          headers: [
            { name: 'Authorization', value: 'Bearer segredo' },
            { name: 'Cookie', value: 'sessao=1' },
            { name: 'X-Api-Key', value: 'k' },
            { name: 'X-Livre', value: 'fica' }
          ]
        })
      )
    )
    await http.close()
    expect(echoed.headers['authorization']).toBeUndefined()
    expect(echoed.headers['cookie']).toBeUndefined()
    expect(echoed.headers['x-api-key']).toBeUndefined()
    expect(echoed.headers['x-livre']).toBe('fica')
  })
})

describe('cookie jar', () => {
  it('guarda o Set-Cookie de um redirect e reenvia por caminho; Max-Age=0 apaga', async () => {
    const cookies = new CookieJar()
    const http = createHttpDispatcher({}, { cookies })
    const profile = json(await http.send(req({ url: `${base}/login` })))
    expect(profile.url).toBe('/conta/perfil')
    expect(profile.headers['cookie']).toBe('tema=escuro; sessao=abc123')
    const root = json(await http.send(req({ url: `${base}/echo` })))
    expect(root.headers['cookie']).toBe('sessao=abc123')
    // O Cookie digitado vence o do jar com o mesmo nome.
    const own = json(await http.send(req({ url: `${base}/echo`, headers: [{ name: 'Cookie', value: 'sessao=minha' }] })))
    expect(own.headers['cookie']).toBe('sessao=minha')
    await http.send(req({ url: `${base}/logout` }))
    const after = json(await http.send(req({ url: `${base}/echo` })))
    await http.close()
    expect(after.headers['cookie']).toBeUndefined()
    expect(cookies.list().map((c) => c.name)).toEqual(['tema'])
  })

  it('sem jar não guarda nada', async () => {
    const http = createHttpDispatcher()
    await http.send(req({ url: `${base}/login`, followRedirects: false }))
    const echoed = json(await http.send(req({ url: `${base}/echo` })))
    await http.close()
    expect(echoed.headers['cookie']).toBeUndefined()
  })

  it('segue domínio, caminho, Secure e expiração', () => {
    let now = 1_000_000
    const jar = new CookieJar([], () => now)
    const url = new URL('https://api.exemplo.com.br/v1/login')
    jar.store(url, [
      'a=1; Domain=exemplo.com.br; Path=/',
      'b=2',
      'c=3; Secure; Max-Age=10',
      'd=4; Domain=outro.com',
      'e=5; Domain=com.br'
    ])
    expect(jar.cookieHeader(new URL('https://www.exemplo.com.br/'))).toBe('a=1')
    expect(jar.cookieHeader(new URL('https://api.exemplo.com.br/v1/x'))).toBe('b=2; c=3; a=1')
    expect(jar.cookieHeader(new URL('http://api.exemplo.com.br/v1/x'))).toBe('b=2; a=1')
    expect(jar.cookieHeader(new URL('https://api.exemplo.com.br/v2'))).toBe('a=1')
    now += 11_000
    expect(jar.cookieHeader(new URL('https://api.exemplo.com.br/v1/x'))).toBe('b=2; a=1')
    expect(jar.toJSON().map((c) => c.name).sort()).toEqual(['a', 'b'])
    expect(parseSetCookie('x=1; Domain=evil.com', url, now)).toBeNull()
  })

  it('edita e apaga pela tela', () => {
    const jar = new CookieJar()
    jar.set({ name: 'k', value: 'v', domain: '.api.local', path: '/', hostOnly: false, secure: false, httpOnly: false })
    expect(jar.cookieHeader(new URL('http://x.api.local/'))).toBe('k=v')
    expect(() => jar.set({ name: 'bad name', value: 'v', domain: 'a', path: '/', hostOnly: true, secure: false, httpOnly: false })).toThrow()
    expect(jar.delete({ domain: 'api.local' })).toBe(1)
    expect(jar.list()).toEqual([])
  })
})

describe('proxy', () => {
  it('NO_PROXY: curinga, sufixos, porta e CIDR', () => {
    const list = 'interno.corp, .exemplo.com, *.svc.local, api.x:8443, 10.0.0.0/8'
    expect(bypasses('interno.corp', '443', list)).toBe(true)
    expect(bypasses('a.interno.corp', '443', list)).toBe(true)
    expect(bypasses('exemplo.com', '443', list)).toBe(true)
    expect(bypasses('k.svc.local', '80', list)).toBe(true)
    expect(bypasses('api.x', '8443', list)).toBe(true)
    expect(bypasses('api.x', '443', list)).toBe(false)
    expect(bypasses('10.1.2.3', '80', list)).toBe(true)
    expect(bypasses('11.1.2.3', '80', list)).toBe(false)
    expect(bypasses('qualquer', '80', '*')).toBe(true)
  })

  it('escolhe pelo modo; loopback nunca usa proxy; usuário e senha vão na URL', async () => {
    const env = { HTTPS_PROXY: 'http://p:3128', http_proxy: 'http://q:3128', NO_PROXY: 'interno.corp' }
    expect(await proxyFor(new URL('https://api.com/'), { mode: 'env', env })).toBe('http://p:3128')
    expect(await proxyFor(new URL('http://api.com/'), { mode: 'env', env })).toBe('http://q:3128')
    expect(await proxyFor(new URL('https://interno.corp/'), { mode: 'env', env })).toBeNull()
    expect(await proxyFor(new URL('http://127.0.0.1:9/'), { mode: 'manual', url: 'http://p:1' })).toBeNull()
    // Valor gerado no teste: um literal com cara de senha dispara o scanner de segredos do repositório.
    const word = `${randomUUID().slice(0, 4)}@x`
    expect(await proxyFor(new URL('https://api.com/'), { mode: 'manual', url: 'p:8080', username: 'eu', password: word })).toBe(
      `http://eu:${encodeURIComponent(word)}@p:8080/`
    )
    expect(await proxyFor(new URL('https://api.com/'), { mode: 'system', resolveSystem: async () => 'http://sys:1' })).toBe('http://sys:1')
    expect(await proxyFor(new URL('https://api.com/'), { mode: 'off' })).toBeNull()
  })

  it('manda a requisição pelo proxy, com Proxy-Authorization', async () => {
    const seen: { url?: string; auth?: string } = {}
    const proxy = createHttpServer((r, res) => {
      seen.url = r.url
      seen.auth = r.headers['proxy-authorization']
      res.end('do proxy')
    })
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
    const port = (proxy.address() as AddressInfo).port
    const http = createHttpDispatcher({}, { proxy: { mode: 'manual', url: `http://127.0.0.1:${port}`, username: 'eu', password: 'senha' } })
    const result = await http.send(req({ url: 'http://api.exemplo.test/recurso?x=1' }))
    await http.close()
    proxy.closeAllConnections()
    await new Promise((r) => proxy.close(r))
    expect(result.ok && result.response.body).toBe('do proxy')
    expect(seen.url).toBe('http://api.exemplo.test/recurso?x=1')
    expect(seen.auth).toBe(`Basic ${Buffer.from('eu:senha').toString('base64')}`)
  })
})

describe('TLS', () => {
  it('recusa certificado desconhecido; aceita com a CA extra ou com a verificação desligada', async () => {
    const pki = await createTestPki()
    const https = createHttpsServer({ cert: pki.server.cert, key: pki.server.key }, (_r, res) => res.end('seguro'))
    await new Promise<void>((r) => https.listen(0, '127.0.0.1', r))
    const url = `https://127.0.0.1:${(https.address() as AddressInfo).port}/`
    const strict = createHttpDispatcher()
    const withCa = createHttpDispatcher({}, { ca: [pki.ca] })
    const insecure = createHttpDispatcher({}, { verifyTls: false })
    const results = [await strict.send(req({ url })), await withCa.send(req({ url })), await insecure.send(req({ url }))]
    // configure troca a política dos próximos envios.
    strict.configure({ verifyTls: false })
    const reconfigured = await strict.send(req({ url }))
    await Promise.all([strict.close(), withCa.close(), insecure.close()])
    https.closeAllConnections()
    await new Promise((r) => https.close(r))
    expect(!results[0]!.ok && results[0]!.error.code).toBe('TLS_FAILURE')
    expect(results[1]!.ok && results[1]!.response.body).toBe('seguro')
    expect(results[2]!.ok && results[2]!.response.body).toBe('seguro')
    expect(reconfigured.ok).toBe(true)
  })
})
