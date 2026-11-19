import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Connector, ConnectorAuth } from '@vvpost/schemas'
import type { HttpRequestInput } from '@shared/ipc'
import { createAuthEngine, type AuthHooks } from '@vvpost/core/connectors/auth'
import { ntowfv2, parseChallenge, signOAuth1 } from '@vvpost/core/connectors/auth-sign'
import { sendHeadless } from '@vvpost/core/connectors/headless'
import type { LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import { createHttpDispatcher } from '@vvpost/core/http/dispatcher'
import type { RequestGuard } from '@vvpost/core/policy/request-policy'

// As auths da fase 15 contra servidores locais que conferem o protocolo do lado de lá: o
// desafio Digest, o handshake NTLM na mesma conexão, a assinatura SigV4 sobre os bytes do
// multipart, a assinatura OAuth 1.0 com o corpo urlencoded e o login OAuth2 com PKCE.

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void
let handler: Handler = (_req, res) => res.end()
let server: Server
let base = ''
let dir = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => handler(req, res, Buffer.concat(chunks)))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  dir = await mkdtemp(join(tmpdir(), 'vvpost-auth-'))
  await writeFile(join(dir, 'nota.txt'), 'conteúdo do arquivo')
})

afterAll(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
})

const SECRET = 'segredo-do-ambiente-7f3a'

function workspace(auth: ConnectorAuth): LoadedWorkspace {
  const connector: Connector = { id: 'api', name: 'API', version: '1.0.0', config: { baseUrl: base, auth } }
  return {
    dir,
    connectors: new Map([['api', connector]]),
    environments: new Map([['dev', { id: 'dev', name: 'dev', variables: { SECRET: { value: SECRET } } }]]),
    secrets: {}
  } as unknown as LoadedWorkspace
}

function send(auth: ConnectorAuth, input: Partial<HttpRequestInput> = {}, hooks: AuthHooks = {}, guard?: RequestGuard) {
  const http = createHttpDispatcher()
  const ctx = { workspace: workspace(auth), auth: createAuthEngine(Date.now, hooks), http, ...(guard && { guard }) }
  return sendHeadless({ id: crypto.randomUUID(), method: 'GET', url: '/recurso', headers: [], connectorId: 'api', environmentId: 'dev', ...input }, ctx).finally(
    () => http.close()
  )
}

const md5 = (text: string) => createHash('md5').update(text).digest('hex')

describe('Digest', () => {
  it('responde ao desafio e o servidor confere a resposta', async () => {
    let calls = 0
    handler = (req, res) => {
      calls++
      const header = req.headers.authorization
      if (!header) {
        res.writeHead(401, { 'www-authenticate': 'Digest realm="api", nonce="n0nce", qop="auth", opaque="op"' }).end()
        return
      }
      const p = parseChallenge(header).params
      const ha1 = md5(`ana:api:${SECRET}`)
      const ha2 = md5(`${req.method}:${p['uri']}`)
      const ok = p['uri'] === req.url && p['response'] === md5(`${ha1}:n0nce:${p['nc']}:${p['cnonce']}:auth:${ha2}`) && p['opaque'] === 'op'
      res.writeHead(ok ? 200 : 403).end(ok ? 'entrou' : 'negado')
    }
    const result = await send({ type: 'digest', username: 'ana', password: '{{SECRET}}' }, { url: '/recurso?x=1' })
    expect(result.ok && result.response.status).toBe(200)
    expect(result.ok && result.response.body).toBe('entrou')
    expect(calls).toBe(2)
    expect(result.auth).toMatchObject({ type: 'digest', source: 'static' })
  })

  it('senha errada volta o 401 do servidor, sem repetir de novo', async () => {
    let calls = 0
    handler = (_req, res) => {
      calls++
      res.writeHead(401, { 'www-authenticate': 'Digest realm="api", nonce="n", qop="auth"' }).end()
    }
    const result = await send({ type: 'digest', username: 'ana', password: '{{SECRET}}' })
    expect(result.ok && result.response.status).toBe(401)
    expect(calls).toBe(2)
  })
})

describe('NTLM', () => {
  it('faz o handshake inteiro na mesma conexão e o servidor confere o NTLMv2', async () => {
    const serverChallenge = Buffer.from('0123456789abcdef', 'hex')
    const sockets: Socket[] = []
    let verified = false
    handler = (req, res) => {
      sockets.push(req.socket)
      const auth = req.headers.authorization ?? ''
      const msg = Buffer.from(auth.replace(/^NTLM /, ''), 'base64')
      const type = msg.length >= 12 ? msg.readUInt32LE(8) : 0
      if (type === 1) {
        const challenge = Buffer.alloc(48)
        challenge.write('NTLMSSP\0', 0, 'latin1')
        challenge.writeUInt32LE(2, 8)
        challenge.writeUInt32LE(0x00888205, 20)
        serverChallenge.copy(challenge, 24)
        res.writeHead(401, { 'www-authenticate': `NTLM ${challenge.toString('base64')}` }).end()
        return
      }
      if (type === 3) {
        const field = (i: number) => msg.subarray(msg.readUInt32LE(12 + i * 8 + 4), msg.readUInt32LE(12 + i * 8 + 4) + msg.readUInt16LE(12 + i * 8))
        const nt = field(1)
        const user = field(3).toString('utf16le')
        const domain = field(2).toString('utf16le')
        const key = ntowfv2(user, SECRET, domain)
        const proof = createHmac('md5', key).update(Buffer.concat([serverChallenge, nt.subarray(16)])).digest()
        verified = user === 'ana' && domain === 'CORP' && proof.equals(nt.subarray(0, 16)) && req.socket === sockets[0]
        res.writeHead(verified ? 200 : 403).end()
        return
      }
      res.writeHead(401, { 'www-authenticate': 'NTLM' }).end()
    }
    const result = await send({ type: 'ntlm', username: 'ana', password: '{{SECRET}}', domain: 'CORP' }, { method: 'POST', url: '/dados', body: '{"a":1}' })
    expect(result.ok && result.response.status).toBe(200)
    expect(verified).toBe(true)
    expect(sockets).toHaveLength(2)
  })
})

describe('AWS SigV4', () => {
  it('assina os bytes do multipart que vão na rede (S3 confere o hash do corpo)', async () => {
    let seen: { auth?: string; hash?: string; bodyHash?: string; type?: string } = {}
    handler = (req, res, body) => {
      seen = {
        auth: req.headers.authorization,
        hash: req.headers['x-amz-content-sha256'] as string,
        bodyHash: createHash('sha256').update(body).digest('hex'),
        type: req.headers['content-type']
      }
      res.end()
    }
    const result = await send(
      { type: 'awsSigV4', accessKeyId: 'AKID', secretAccessKey: '{{SECRET}}', region: 'sa-east-1', service: 's3' },
      { method: 'PUT', url: '/bucket/nota.txt', payload: { mode: 'multipart', fields: [{ name: 'f', file: 'nota.txt' }] } }
    )
    expect(result.ok && result.response.status).toBe(200)
    expect(seen.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/sa-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/)
    expect(seen.hash).toBe(seen.bodyHash)
    expect(seen.type).toMatch(/^multipart\/form-data; boundary=/)
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })
})

describe('OAuth 1.0', () => {
  it('a assinatura cobre a query e o corpo urlencoded', async () => {
    let valid = false
    handler = (req, res, body) => {
      const p = parseChallenge(req.headers.authorization ?? '').params
      const [expected] = signOAuth1(
        { method: req.method!, url: `${base}${req.url}`, headers: [{ name: 'Content-Type', value: req.headers['content-type']! }], body: body.toString() },
        { consumerKey: 'ck', consumerSecret: SECRET, token: 'tk', tokenSecret: 'ts' },
        { nonce: p['oauth_nonce']!, timestamp: Number(p['oauth_timestamp']) }
      )
      valid = expected!.value === req.headers.authorization
      res.writeHead(valid ? 200 : 401).end()
    }
    const result = await send(
      { type: 'oauth1', consumerKey: 'ck', consumerSecret: '{{SECRET}}', token: 'tk', tokenSecret: 'ts' },
      { method: 'POST', url: '/status?modo=teste', payload: { mode: 'urlencoded', fields: [{ name: 'texto', value: 'olá mundo' }] } }
    )
    expect(result.ok && result.response.status).toBe(200)
    expect(valid).toBe(true)
  })
})

describe('OAuth2 authorization code com PKCE', () => {
  const auth = (): ConnectorAuth => ({
    type: 'oauth2',
    grantType: 'authorization_code',
    authUrl: `${base}/authorize`,
    tokenUrl: '/token',
    clientId: 'app',
    scope: 'leitura'
  })

  /** Provedor de mentira: /authorize redireciona com o code, /token confere o code_verifier. */
  function provider() {
    const state = { challenge: '', redirect: '', tokens: 0, api: [] as string[] }
    handler = (req, res, body) => {
      const url = new URL(req.url!, base)
      if (url.pathname === '/authorize') {
        state.challenge = url.searchParams.get('code_challenge') ?? ''
        state.redirect = url.searchParams.get('redirect_uri')!
        const back = new URL(state.redirect)
        back.searchParams.set('code', 'code-123')
        back.searchParams.set('state', url.searchParams.get('state')!)
        res.writeHead(302, { location: back.toString() }).end()
        return
      }
      if (url.pathname === '/token') {
        const form = new URLSearchParams(body.toString())
        const ok =
          form.get('grant_type') === 'authorization_code' &&
          form.get('code') === 'code-123' &&
          form.get('redirect_uri') === state.redirect &&
          createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === state.challenge
        state.tokens++
        res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify(ok ? { access_token: 'at-1', expires_in: 3600 } : { error: 'invalid_grant' }))
        return
      }
      state.api.push(req.headers.authorization ?? '')
      res.end('ok')
    }
    return state
  }

  it('abre o login, recebe o code no loopback e troca pelo token com o code_verifier', async () => {
    const state = provider()
    const opened: string[] = []
    // O "navegador" segue o redirect do provedor até o loopback do VVPost.
    const openBrowser = async (url: string) => {
      opened.push(url)
      void fetch(url).then((r) => r.text())
    }
    const result = await send(auth(), {}, { openBrowser })
    expect(result.ok && result.response.status).toBe(200)
    expect(state.api).toEqual(['Bearer at-1'])
    expect(state.tokens).toBe(1)
    const asked = new URL(opened[0]!)
    expect(asked.searchParams.get('code_challenge_method')).toBe('S256')
    expect(asked.searchParams.get('scope')).toBe('leitura')
    expect(state.redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(result.auth).toMatchObject({ type: 'oauth2', source: 'fetched' })
  })

  it('sem navegador (MCP, hooks) falha com uma mensagem clara, sem abrir nada', async () => {
    provider()
    let opened = false
    const none = await send(auth())
    const guard = { admit: async () => ({ ok: true as const, timeoutMs: undefined, release: () => {} }) } as unknown as RequestGuard
    const guarded = await send(auth(), {}, { openBrowser: () => void (opened = true) }, guard)
    expect(!none.ok && none.error).toMatchObject({ code: 'AUTH_FAILED', message: expect.stringContaining('navegador') })
    expect(!guarded.ok && guarded.error.code).toBe('AUTH_FAILED')
    expect(opened).toBe(false)
  })

  it('o provedor recusando o login vira AUTH_FAILED com o motivo', async () => {
    handler = (req, res) => {
      const url = new URL(req.url!, base)
      const back = new URL(url.searchParams.get('redirect_uri')!)
      back.searchParams.set('error', 'access_denied')
      back.searchParams.set('state', url.searchParams.get('state')!)
      res.writeHead(302, { location: back.toString() }).end()
    }
    const result = await send(auth(), {}, { openBrowser: (url) => void fetch(url).then((r) => r.text()) })
    expect(!result.ok && result.error).toMatchObject({ code: 'AUTH_FAILED', message: expect.stringContaining('access_denied') })
  })

  it('redirectUri fora do loopback é recusado', async () => {
    const result = await send({ ...auth(), redirectUri: 'http://exemplo.com/cb' } as ConnectorAuth, {}, { openBrowser: () => {} })
    expect(!result.ok && result.error.code).toBe('CONFIG_ERROR')
  })
})
