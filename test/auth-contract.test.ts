import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Connector } from '@vvpost/schemas'
import connectorSchema from '@vvpost/schemas/schemas/connector.json'
import type { HttpRequestInput, HttpResult } from '@shared/ipc'
import { createAuthEngine, type AppliedAuth } from '@vvpost/core/connectors/auth'
import { AUTH_CONTRACT, authPlacement, type ActiveAuth, type AuthType } from '@vvpost/core/connectors/auth-contract'
import { literalSecrets } from '@vvpost/core/connectors/edit'
import { resolveConnector } from '@vvpost/core/connectors/resolve'

// Contrato de autenticação independente da interface: todo
// tipo de auth do schema passa pelas mesmas verificações, rodando só o motor.

const CANARY = 'canary-Zq8vX2pL0w'

/** Um exemplo de cada tipo, com as credenciais vindas de variáveis. */
const SAMPLES: { [T in AuthType]: Extract<ActiveAuth, { type: T }> } = {
  bearer: { type: 'bearer', token: '{{SECRET}}' },
  apiKey: { type: 'apiKey', name: 'X-Api-Key', value: '{{SECRET}}' },
  basic: { type: 'basic', username: 'user', password: '{{SECRET}}' },
  oauth2: { type: 'oauth2', grantType: 'client_credentials', tokenUrl: '/oauth/token', clientId: 'app', clientSecret: '{{SECRET}}' },
  login: { type: 'login', request: { url: '/login', json: { password: '{{SECRET}}' } }, token: 'body.token', ttlSeconds: 60 },
  digest: { type: 'digest', username: 'user', password: '{{SECRET}}' },
  ntlm: { type: 'ntlm', username: 'user', password: '{{SECRET}}', domain: 'CORP' },
  awsSigV4: { type: 'awsSigV4', accessKeyId: 'AKID', secretAccessKey: '{{SECRET}}', sessionToken: '{{SECRET}}', region: 'us-east-1', service: 'execute-api' },
  oauth1: { type: 'oauth1', consumerKey: 'ck', consumerSecret: '{{SECRET}}', token: 'tk', tokenSecret: '{{SECRET}}' }
}

/** Um challenge NTLM (mensagem 2) mínimo, com target info vazia. */
function ntlmChallenge(): string {
  const msg = Buffer.alloc(52)
  msg.write('NTLMSSP\0', 0, 'latin1')
  msg.writeUInt32LE(2, 8)
  msg.writeUInt32LE(0x00888205, 20)
  Buffer.from('0123456789abcdef', 'hex').copy(msg, 24)
  msg.writeUInt16LE(4, 40)
  msg.writeUInt16LE(4, 42)
  msg.writeUInt32LE(48, 44)
  return msg.toString('base64')
}

/** O 401 que cada auth por desafio espera, para chegar no header final. */
const CHALLENGE: Partial<Record<AuthType, string>> = {
  digest: 'Digest realm="api", nonce="abc", qop="auth"',
  ntlm: `NTLM ${ntlmChallenge()}`
}

/** Os headers que a auth põe na requisição final: os prontos, os da assinatura ou os da resposta ao desafio. */
function finalHeaders(type: AuthType, applied: AppliedAuth) {
  const sent = { method: 'POST', url: 'https://api.exemplo.com/recurso?x=1', headers: [], body: '{}' }
  if (applied.sign) return applied.sign(sent)
  if (applied.challenge) {
    const res = { status: 401, statusText: '', headers: [{ name: 'www-authenticate', value: CHALLENGE[type]! }], body: '', sizeBytes: 0, truncated: false, timings: { ttfbMs: 0, downloadMs: 0, totalMs: 0 } }
    return applied.challenge.respond(res, sent) ?? []
  }
  return applied.headers
}

const schemaTypes = (connectorSchema as { $defs: { auth: { oneOf: { $ref: string }[] }; [k: string]: unknown } }).$defs.auth.oneOf
  .map((ref) => ((connectorSchema as any).$defs[ref.$ref.split('/').pop()!].properties.type.const as string))
  .filter((t) => t !== 'none')

function engineRun(type: AuthType) {
  const sent: HttpRequestInput[] = []
  const send = async (input: HttpRequestInput): Promise<HttpResult> => {
    sent.push(input)
    const token = `tok-${sent.length}`
    const body = JSON.stringify(input.url.endsWith('/oauth/token') ? { access_token: token, expires_in: 3600 } : { token })
    return {
      ok: true,
      response: { status: 200, statusText: 'OK', headers: [], body, sizeBytes: body.length, truncated: false, timings: { ttfbMs: 1, downloadMs: 0, totalMs: 1 } }
    }
  }
  const c: Connector = { id: 'c', name: 'C', version: '1.0.0', config: { baseUrl: 'https://api.exemplo.com', auth: SAMPLES[type] } }
  const connector = resolveConnector('c', new Map([['c', c]]))
  const request = (engine: ReturnType<typeof createAuthEngine>, env = 'dev', forceRefresh = false) =>
    engine.apply({
      connector,
      scopeKey: `/ws\0${env}`,
      scope: { values: new Map([['SECRET', `${CANARY}-${env}`]]) },
      baseUrl: 'https://api.exemplo.com',
      send,
      forceRefresh
    })
  return { sent, request }
}

describe('contrato de auth', () => {
  it('todo tipo de auth do schema tem contrato, e só eles', () => {
    expect(new Set(schemaTypes)).toEqual(new Set(Object.keys(AUTH_CONTRACT)))
  })

  for (const type of Object.keys(AUTH_CONTRACT) as AuthType[]) {
    describe(type, () => {
      const contract = AUTH_CONTRACT[type]

      it('injeta só onde o contrato diz, e o resto do resultado não carrega a credencial', async () => {
        const { request } = engineRun(type)
        const applied = (await request(createAuthEngine()))!
        const placement = authPlacement(SAMPLES[type])
        const injected = placement.in === 'header' ? finalHeaders(type, applied) : applied.query.map(([name, value]) => ({ name, value }))
        // A assinatura SigV4 leva junto os X-Amz-* que ela cobre; nenhum carrega a credencial.
        expect(injected.map((h) => h.name).filter((name) => !/^x-amz-(date|security-token)$/i.test(name))).toEqual([placement.name])
        // Assinatura e resposta ao desafio provam a credencial sem mandá-la.
        if (applied.sign || applied.challenge) {
          expect(JSON.stringify(injected.filter((h) => !/security-token/i.test(h.name)))).not.toContain(CANARY)
        }
        expect(placement.in === 'header' ? applied.query : applied.headers).toEqual([])
        expect(applied.renewable).toBe(contract.renewable)
        // usage vai para a interface, o histórico e a IA: nunca a credencial nem o token.
        expect(JSON.stringify(applied.usage)).not.toMatch(/canary|tok-/)
        expect(applied.usage).toMatchObject({ type, from: 'c' })
      })

      it(contract.runsFlow ? 'roda o fluxo uma vez e serve o token do cache, por ambiente' : 'não faz requisição nenhuma', async () => {
        const { request, sent } = engineRun(type)
        const engine = createAuthEngine()
        const first = (await request(engine))!
        const second = (await request(engine))!
        const otherEnv = (await request(engine, 'prod'))!
        if (!contract.runsFlow) {
          expect(sent).toEqual([])
          expect(first.usage.source).toBe('static')
          return
        }
        expect(first.usage.source).toBe('fetched')
        expect(second.usage.source).toBe('cache')
        expect(otherEnv.usage.source).toBe('fetched')
        expect(sent).toHaveLength(2)
        // Tokens de um ambiente nunca servem outro.
        const value = (a: typeof first) => [...a.headers.map((h) => h.value), ...a.query.map(([, v]) => v)].join()
        expect(value(first)).toContain('tok-1')
        expect(value(second)).toBe(value(first))
        expect(value(otherEnv)).toContain('tok-2')
        // A credencial do ambiente certo foi para o fluxo de cada um.
        expect(sent[0]!.body ?? '').not.toContain(`${CANARY}-prod`)
        expect(JSON.stringify(sent[1])).toContain(type === 'oauth2' ? Buffer.from(`app:${CANARY}-prod`).toString('base64') : `${CANARY}-prod`)
        engine.clear()
        expect((await request(engine))!.usage.source).toBe('fetched')
      })

      it('campos de credencial literais são recusados num arquivo versionado', () => {
        for (const field of contract.secretFields) {
          const auth = { ...SAMPLES[type], [field]: 'literal-sem-variavel' } as ActiveAuth
          const found = literalSecrets({ id: 'c', name: 'C', version: '1.0.0', config: { auth } })
          expect(found).toContain(`auth.${field}`)
        }
      })
    })
  }

  it('o motor de auth e a herança não dependem do Electron nem da interface', () => {
    const roots = ['packages/core/src', 'src/main/mcp']
    const offenders: string[] = []
    const visit = (path: string) => {
      if (statSync(path).isDirectory()) return readdirSync(path).forEach((name) => visit(join(path, name)))
      if (!path.endsWith('.ts')) return
      const text = readFileSync(path, 'utf8')
      if (/from ['"]electron['"]|require\(['"]electron['"]\)|from ['"][./]*renderer/.test(text)) offenders.push(path)
    }
    roots.forEach(visit)
    expect(offenders).toEqual([])
  })
})
