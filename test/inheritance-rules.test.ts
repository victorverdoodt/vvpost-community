import { describe, expect, it } from 'vitest'
import type { Connector, Environment } from '@vvpost/schemas'
import type { HttpRequestInput, HttpResult } from '@shared/ipc'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { sendHeadless } from '@vvpost/core/connectors/headless'
import { buildRegistry } from '@vvpost/core/connectors/registry'
import { MAX_INHERITANCE_DEPTH, resolveConnector } from '@vvpost/core/connectors/resolve'
import type { LoadedWorkspace } from '@vvpost/core/connectors/workspace'

// Regras de precedência e conflitos da herança.

const catalog = (...list: Connector[]) => new Map(list.map((c) => [c.id, c]))
const connector = (id: string, config: Connector['config'], parent?: string, endpoints?: Connector['endpoints']): Connector => ({
  id,
  name: id,
  version: '1.0.0',
  ...(parent && { extends: parent }),
  ...(config && { config }),
  ...(endpoints && { endpoints })
})

function workspace(connectors: Connector[], env?: Environment, secrets: Record<string, string> = {}): LoadedWorkspace {
  return {
    dir: '/ws',
    connectors: catalog(...connectors),
    connectorFiles: new Map(connectors.map((c) => [c.id, `${c.id}.connector.vvpost.json`])),
    environments: new Map(env ? [[env.id, env]] : []),
    secrets: env ? { [env.id]: secrets } : {},
    issues: []
  }
}

/** Dispatcher falso: guarda o que seria enviado e responde 200. */
function recorder() {
  const sent: HttpRequestInput[] = []
  return {
    sent,
    http: {
      async send(input: HttpRequestInput): Promise<HttpResult> {
        sent.push(input)
        const body = input.url.includes('/token') ? JSON.stringify({ access_token: 'tok', expires_in: 3600 }) : '{}'
        return {
          ok: true,
          response: { status: 200, statusText: 'OK', headers: [], body, sizeBytes: body.length, truncated: false, timings: { ttfbMs: 1, downloadMs: 0, totalMs: 1 } }
        }
      }
    }
  }
}

const header = (input: HttpRequestInput, name: string) => input.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value

describe('precedência', () => {
  const root = connector('root', {
    baseUrl: 'https://api.exemplo.com',
    basePath: '/v1',
    headers: { 'X-Layer': 'root', 'X-Root': 'r' },
    auth: { type: 'apiKey', name: 'X-Api-Key', value: '{{KEY}}' }
  })
  const child = connector('child', { basePath: '/billing', headers: { 'x-layer': 'child' } }, 'root')
  const env: Environment = { id: 'dev', name: 'Dev', variables: { KEY: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true } } }

  it('raiz < filho < requisição, por nome sem diferenciar maiúsculas; a auth entra por último', async () => {
    const { http, sent } = recorder()
    await sendHeadless(
      { id: '1', method: 'GET', url: '/charges', headers: [{ name: 'X-LAYER', value: 'request' }], connectorId: 'child', environmentId: 'dev' },
      { workspace: workspace([root, child], env, { KEY: 'k1' }), auth: createAuthEngine(), http }
    )
    expect(sent[0]!.url).toBe('https://api.exemplo.com/v1/billing/charges')
    expect(header(sent[0]!, 'x-layer')).toBe('request')
    expect(header(sent[0]!, 'x-root')).toBe('r')
    expect(header(sent[0]!, 'x-api-key')).toBe('k1')
  })

  it('header da requisição com o nome do header da auth substitui a auth inteira', async () => {
    const { http, sent } = recorder()
    const result = await sendHeadless(
      { id: '1', method: 'GET', url: '/x', headers: [{ name: 'x-api-key', value: 'manual' }], connectorId: 'child', environmentId: 'dev' },
      { workspace: workspace([root, child], env, { KEY: 'k1' }), auth: createAuthEngine(), http }
    )
    expect(sent.map((s) => header(s, 'x-api-key'))).toEqual(['manual'])
    expect(result.auth).toBeUndefined()
  })

  it('auth e tls vêm inteiros do conector mais próximo que define; none desliga', () => {
    const oauth = connector(
      'oauth',
      { auth: { type: 'oauth2', grantType: 'client_credentials', tokenUrl: '/token', clientId: 'id' } },
      'child'
    )
    const off = connector('off', { auth: { type: 'none' } }, 'oauth')
    const back = connector('back', { auth: { type: 'bearer', token: '{{T}}' } }, 'off')
    const all = catalog(root, child, oauth, off, back)
    expect(resolveConnector('oauth', all).auth?.config).toEqual(oauth.config!.auth)
    expect(resolveConnector('off', all).auth).toBeUndefined()
    expect(resolveConnector('back', all).auth).toEqual({ config: back.config!.auth, from: 'back' })
  })

  it('endpoints não são herdados: cada conector expõe só os próprios', () => {
    const parent = connector('p', { baseUrl: 'https://a.exemplo.com' }, undefined, [{ id: 'e', name: 'E', method: 'GET', path: '/e' }])
    const kid = connector('k', {}, 'p')
    expect(resolveConnector('k', catalog(parent, kid)).endpoints).toEqual([])
  })
})

describe('conflitos', () => {
  it('header da cadeia com o nome do header da auth é erro, em qualquer nível', () => {
    const parent = connector('p', { baseUrl: 'https://a.exemplo.com', headers: { Authorization: 'Bearer fixo' } })
    const kid = connector('k', { auth: { type: 'bearer', token: '{{T}}' } }, 'p')
    expect(() => resolveConnector('k', catalog(parent, kid))).toThrow(/conflito de herança: "p" define o header Authorization/)

    const authParent = connector('ap', { auth: { type: 'apiKey', name: 'X-Key', value: '{{K}}' } })
    const headerKid = connector('hk', { headers: { 'x-key': 'literal' } }, 'ap')
    expect(() => resolveConnector('hk', catalog(authParent, headerKid))).toThrow(/"hk" define o header x-key/)
  })

  it('auth na query não disputa header com o mesmo nome', () => {
    const c = connector('q', { headers: { 'api-key': 'h' }, auth: { type: 'apiKey', name: 'api-key', value: '{{K}}', in: 'query' } })
    expect(() => resolveConnector('q', catalog(c))).not.toThrow()
  })

  it(`cadeia com mais de ${MAX_INHERITANCE_DEPTH} níveis é erro`, () => {
    const list = Array.from({ length: MAX_INHERITANCE_DEPTH + 1 }, (_, i) => connector(`c${i}`, {}, i ? `c${i - 1}` : undefined))
    expect(() => resolveConnector(`c${MAX_INHERITANCE_DEPTH}`, catalog(...list))).toThrow(/mais de 16 níveis/)
    expect(() => resolveConnector(`c${MAX_INHERITANCE_DEPTH - 1}`, catalog(...list))).not.toThrow()
  })

  it('avisa quando um filho troca a origem e herda a auth definida para outra', async () => {
    const parent = connector('p', { baseUrl: 'https://a.exemplo.com', auth: { type: 'bearer', token: '{{T}}' } })
    const moved = connector('m', { baseUrl: 'https://b.exemplo.com' }, 'p')
    const grandchild = connector('g', { basePath: '/x' }, 'm')
    const own = connector('o', { baseUrl: 'https://c.exemplo.com', auth: { type: 'bearer', token: '{{U}}' } }, 'p')
    const templated = connector('t', { baseUrl: '{{OUTRA_URL}}' }, 'p')
    const all = catalog(parent, moved, grandchild, own, templated)

    expect(resolveConnector('m', all).warnings).toEqual([
      expect.objectContaining({ code: 'INHERITED_AUTH_NEW_ORIGIN', connector: 'm', message: expect.stringContaining('https://b.exemplo.com') })
    ])
    expect(resolveConnector('o', all).warnings).toEqual([])
    expect(resolveConnector('t', all).warnings).toEqual([])

    // O Catálogo mostra o aviso uma vez, no conector que troca a origem.
    const registry = await buildRegistry(workspace([parent, moved, grandchild, own, templated]))
    const warnings = registry.issues.filter((i) => i.message.includes('troca a origem'))
    expect(warnings.map((w) => w.file)).toEqual(['m.connector.vvpost.json'])
  })

  it('o conflito marca o conector no Catálogo sem derrubar os outros', async () => {
    const ok = connector('ok', { baseUrl: 'https://a.exemplo.com' })
    const bad = connector('bad', { headers: { Authorization: 'x' }, auth: { type: 'basic', username: 'u', password: '{{P}}' } })
    const registry = await buildRegistry(workspace([ok, bad]))
    expect(registry.connectors.find((c) => c.id === 'bad')?.error).toMatch(/conflito de herança/)
    expect(registry.connectors.find((c) => c.id === 'ok')?.error).toBeUndefined()
  })
})
