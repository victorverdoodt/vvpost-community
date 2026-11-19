import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { loadFlows } from '@vvpost/core/flows/workspace'
import { createHttpDispatcher } from '@vvpost/core/http/dispatcher'
import { pluginPublisher, publisherHostAllowed, type PluginPublisherInfo, type PublisherCredentials } from '@vvpost/core/docs/publish'
import { PluginManager } from '@vvpost/core/plugins/manager'
import { validatePluginManifest } from '@vvpost/schemas'
import { createPublishService } from '../src/main/docs/publish'
import { vaultCredentials } from '../src/main/docs/publisher-credentials'

// Publicadores remotos vindos de plugins (contributes.publishers): o plugin monta o plano e
// publica pelo ctx.http; o VVPost guarda a credencial, só deixa ir aos hosts declarados, põe a
// auth e confere o resultado contra a confirmação da pessoa.

const OFFICIAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins')
// Montado em tempo de execução: nada com cara de credencial fica no repositório.
const TOKEN = ['wiki', 'token', 'q8Zr3mT1xV'].join('-')

const memoryCredentials = (): PublisherCredentials & { store: Map<string, string> } => {
  const store = new Map<string, string>()
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k)
  }
}

describe('hosts de um publicador', () => {
  it('só HTTPS (HTTP só no loopback), com curinga e porta', () => {
    const ok = (url: string, hosts: string[]) => publisherHostAllowed(new URL(url), hosts)
    expect(ok('https://api.notion.com/v1/pages', ['api.notion.com'])).toBe(true)
    expect(ok('http://api.notion.com/v1/pages', ['api.notion.com'])).toBe(false)
    expect(ok('https://api.notion.com.evil.io/', ['api.notion.com'])).toBe(false)
    expect(ok('https://acme.atlassian.net/wiki', ['*.atlassian.net'])).toBe(true)
    expect(ok('https://atlassian.net/wiki', ['*.atlassian.net'])).toBe(false)
    expect(ok('https://evilatlassian.net/', ['*.atlassian.net'])).toBe(false)
    expect(ok('https://docs.empresa.com:8443/', ['docs.empresa.com'])).toBe(false)
    expect(ok('https://docs.empresa.com:8443/', ['docs.empresa.com:8443'])).toBe(true)
    expect(ok('http://127.0.0.1:4010/', ['127.0.0.1:4010'])).toBe(true)
    expect(ok('http://127.0.0.1:4011/', ['127.0.0.1:4010'])).toBe(false)
  })

  it('o manifesto pede hosts e auth, e não aceita um id do VVPost', () => {
    const manifest = (publisher: Record<string, unknown>) =>
      validatePluginManifest({ id: 'acme-wiki', name: 'Wiki', version: '1.0.0', main: 'index.js', apiVersion: 1, contributes: { publishers: [publisher] } }).ok
    expect(manifest({ id: 'wiki', title: 'Wiki', hosts: ['api.wiki.io', '*.wiki.io', '127.0.0.1:4010'], auth: { type: 'bearer', label: 'Token' } })).toBe(true)
    expect(manifest({ id: 'wiki', title: 'Wiki', auth: { type: 'bearer', label: 'Token' } })).toBe(false)
    expect(manifest({ id: 'wiki', title: 'Wiki', hosts: ['https://api.wiki.io'], auth: { type: 'bearer', label: 'Token' } })).toBe(false)
    expect(manifest({ id: 'wiki', title: 'Wiki', hosts: ['*'], auth: { type: 'bearer', label: 'Token' } })).toBe(false)
    expect(manifest({ id: 'confluence-cloud', title: 'X', hosts: ['a.io'], auth: { type: 'bearer', label: 'Token' } })).toBe(false)
    expect(manifest({ id: 'wiki', title: 'Wiki', hosts: ['a.io'], auth: { type: 'bearer', label: 'Token', help: 'http://a.io' } })).toBe(false)
    expect(manifest({ id: 'wiki', title: 'Wiki', hosts: ['a.io'], auth: { type: 'header', label: 'Chave' } })).toBe(false)
    expect(manifest({ id: 'wiki', title: 'Wiki', hosts: ['a.io'], auth: { type: 'header', header: 'X-API-Key', label: 'Chave' } })).toBe(true)
  })
})

describe('pluginPublisher', () => {
  const target = { id: 'wiki', name: 'Wiki', provider: 'wiki', destination: 'space:DOC', diagrams: 'code' as const }
  const bundle = {
    target,
    project: 'p',
    generatedAt: '2026-10-26T00:00:00Z',
    nodes: [
      { key: 'document', kind: 'page' as const, title: 'Doc', hash: 'a'.repeat(64), children: [] },
      { key: 'page:b', kind: 'page' as const, title: 'B', hash: 'b'.repeat(64), children: [] }
    ],
    assets: [],
    published: { 'page:old': { id: '9', kind: 'page' as const } }
  }

  function fake(answers: Partial<Record<'session' | 'plan' | 'publish', (input: Record<string, unknown>) => unknown>>): PluginPublisherInfo {
    return {
      pluginId: 'acme-wiki',
      pluginName: 'Wiki',
      id: 'wiki',
      title: 'Wiki',
      hosts: ['api.wiki.io'],
      auth: { type: 'bearer', label: 'Token de integração', help: 'https://wiki.io/tokens' },
      invoke: async (op, input) => {
        const answer = answers[op]
        if (!answer) return null
        return answer(input as Record<string, unknown>)
      }
    }
  }

  it('sem credencial pede o token; a recusada não fica guardada', async () => {
    const credentials = memoryCredentials()
    const p = pluginPublisher(
      fake({
        session: () => {
          throw new Error('401 unauthorized')
        }
      }),
      { send: async () => ({ ok: false, error: { code: 'NETWORK_ERROR', message: 'x' }, timings: { totalMs: 0 } }), credentials }
    )
    expect(await p.session(target)).toEqual({
      status: 'signedOut',
      message: expect.stringContaining('token de integração'),
      credential: { label: 'Token de integração', help: 'https://wiki.io/tokens' }
    })
    await expect(p.signIn!(target, { openExternal: async () => {}, credential: TOKEN })).rejects.toThrow(/recusou a credencial: .*401/)
    expect(credentials.store.size).toBe(0)
    await expect(p.plan(bundle, { openExternal: async () => {} })).rejects.toThrow(/Entre em Wiki primeiro/)
  })

  it('plano e resultado campo a campo; o que mudou sem confirmação vira falha', async () => {
    const credentials = memoryCredentials()
    credentials.store.set('acme-wiki/wiki', TOKEN)
    const p = pluginPublisher(
      fake({
        plan: () => ({
          destination: { label: 'Espaço DOC', url: 'javascript:alert(1)' },
          items: [
            { key: 'document', kind: 'page', title: 'Doc', path: [], action: 'update', before: 'a', after: 'b', remote: { id: '1', url: 'https://wiki.io/1' } },
            { key: 'page:b', kind: 'page', title: 'B', path: [], action: 'create' },
            { key: 'page:old', kind: 'page', title: 'Velha', path: [], action: 'orphan' },
            { key: 'inventada', kind: 'page', title: 'X', path: [], action: 'create' },
            { key: 'page:b', kind: 'page', title: 'repetida', path: [], action: 'same' }
          ]
        }),
        publish: () => ({
          items: [
            { key: 'document', outcome: 'updated', id: '1', version: 2, hash: 'f'.repeat(64) },
            { key: 'page:b', outcome: 'created', id: '2', url: 'https://wiki.io/2' },
            { key: 'page:old', outcome: 'archived' },
            { key: 'inventada', outcome: 'created', id: '3' }
          ]
        })
      }),
      { send: async () => ({ ok: false, error: { code: 'NETWORK_ERROR', message: 'x' }, timings: { totalMs: 0 } }), credentials }
    )
    const ctx = { openExternal: async () => {} }
    const plan = await p.plan(bundle, ctx)
    expect(plan.items.map((i) => [i.key, i.action])).toEqual([
      ['document', 'update'],
      ['page:b', 'create'],
      ['page:old', 'orphan']
    ])
    expect(plan.destination).toEqual({ label: 'Espaço DOC' })
    // A pessoa só confirmou a criação: a atualização e o arquivamento que o plugin fez sem ela viram falha.
    const result = await p.publish(bundle, plan, { update: [], conflicts: [], archive: [] }, ctx)
    expect(result.items).toEqual([
      expect.objectContaining({ key: 'document', outcome: 'failed', error: expect.stringContaining('sem a confirmação') }),
      { key: 'page:b', kind: 'page', title: 'B', outcome: 'created', id: '2', url: 'https://wiki.io/2', hash: 'b'.repeat(64) },
      expect.objectContaining({ key: 'page:old', outcome: 'failed' })
    ])
    const confirmed = await p.publish(bundle, plan, { update: ['document'], conflicts: [], archive: ['page:old'] }, ctx)
    // O hash gravado é o do pacote, não o que o plugin disse.
    expect(confirmed.items[0]).toMatchObject({ key: 'document', outcome: 'updated', version: 2, hash: 'a'.repeat(64) })
    expect(confirmed.items[2]).toMatchObject({ key: 'page:old', outcome: 'archived' })
  })
})

describe('publicador de plugin no processo do plugin, pelo "Enviar para…"', () => {
  let dir: string
  let userData: string
  let server: Server
  let origin: string
  const seen: { method: string; url: string; auth: string | undefined; cookie: string | undefined; body: string }[] = []
  const pages = new Map<string, { id: string; title: string; body: string; version: number }>()

  const read = (req: IncomingMessage) => new Promise<string>((r) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => r(body))
  })

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const body = await read(req)
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, cookie: req.headers.cookie, body })
      res.setHeader('content-type', 'application/json')
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = 401
        return res.end(JSON.stringify({ error: 'unauthorized' }))
      }
      if (req.url === '/me') return res.end(JSON.stringify({ name: 'Dana', echo: req.headers.authorization }))
      if (req.method === 'GET' && req.url === '/pages') return res.end(JSON.stringify([...pages.values()]))
      if (req.method === 'POST' && req.url === '/pages') {
        const page = JSON.parse(body) as { title: string; body: string }
        const id = String(pages.size + 1)
        pages.set(id, { id, ...page, version: 1 })
        return res.end(JSON.stringify({ id, version: 1 }))
      }
      res.statusCode = 404
      res.end('{}')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    origin = `http://127.0.0.1:${port}`

    dir = mkdtempSync(join(tmpdir(), 'vvpost-publish-plugin-'))
    const put = (path: string, data: unknown) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
    }
    put('docs/projeto.md', '## Visão geral\n\nTexto.')
    put('vvpost.publish.json', { targets: [{ id: 'wiki', provider: 'wiki', destination: 'space:DOC', diagrams: 'code', structure: [{ page: 'Documentação', source: 'document', children: [{ pages: 'docs/**/*.md' }] }] }] })

    userData = mkdtempSync(join(tmpdir(), 'vvpost-publish-plugin-ud-'))
    const plugin = join(userData, 'plugins/acme-wiki')
    mkdirSync(plugin, { recursive: true })
    writeFileSync(
      join(plugin, 'vvpost-plugin.json'),
      JSON.stringify({
        id: 'acme-wiki',
        name: 'Wiki',
        version: '1.0.0',
        main: 'index.js',
        apiVersion: 1,
        contributes: { publishers: [{ id: 'wiki', title: 'Wiki', hosts: [`127.0.0.1:${port}`], auth: { type: 'bearer', label: 'Token de integração' } }] }
      })
    )
    // Publicador de exemplo: lista as páginas, cria as novas e tenta coisas que não pode.
    writeFileSync(
      join(plugin, 'index.js'),
      `const base = ${JSON.stringify(origin)}
const walk = (nodes, out = []) => { for (const n of nodes) { if (n.page) out.push(n); walk(n.children, out) } return out }
module.exports = {
  publishers: {
    wiki: {
      async session(ctx) {
        const r = await ctx.http.send({ method: 'GET', url: base + '/me', headers: { authorization: 'Bearer outro', cookie: 'sid=1' } })
        if (r.status !== 200) throw new Error('HTTP ' + r.status)
        const me = r.json()
        return { account: me.name + ' ' + me.echo, destination: ctx.target.destination }
      },
      async plan(ctx) {
        let outside = 'passou'
        try { await ctx.http.send({ method: 'GET', url: 'https://evil.example.com/x' }) } catch (err) { outside = err.message }
        const remote = (await ctx.http.send({ method: 'GET', url: base + '/pages' })).json()
        const items = walk(ctx.bundle.nodes).map((n) => ({ key: n.key, kind: 'page', title: n.title, path: [], action: remote.some((p) => p.title === n.title) ? 'same' : 'create' }))
        return { destination: { label: ctx.target.destination }, items, warnings: [outside] }
      },
      async publish(ctx) {
        const out = []
        for (const item of ctx.plan.items) {
          if (item.action !== 'create') { out.push({ key: item.key, outcome: 'unchanged' }); continue }
          const node = walk(ctx.bundle.nodes).find((n) => n.key === item.key)
          const r = (await ctx.http.send({ method: 'POST', url: base + '/pages', body: { title: node.title, body: node.page.markdown } })).json()
          out.push({ key: item.key, outcome: 'created', id: r.id, version: r.version })
        }
        return { items: out }
      }
    }
  }
}
`
    )
  })
  afterAll(async () => {
    await new Promise((r) => server.close(r))
    rmSync(dir, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  })

  it('entra com o token colado, publica e grava o vvpost.publish.json; o plugin não vê o token', async () => {
    const manager = new PluginManager({ officialDir: OFFICIAL, userDir: join(userData, 'plugins'), stateFile: join(userData, 'plugins.json') })
    const http = createHttpDispatcher()
    const credentials = vaultCredentials(join(userData, 'publishers'))
    const svc = createPublishService({
      dir: async () => dir,
      workspace: () => loadWorkspace(dir),
      flows: (d) => loadFlows(d),
      openExternal: async () => {},
      svgToPng: async () => null,
      pluginPublishers: () => manager.publishers(),
      send: (input) => http.send(input),
      credentials
    })
    try {
      const { plugins } = await manager.catalog()
      const wiki = plugins.find((p) => p.id === 'acme-wiki')!
      expect(wiki.publishers).toEqual([{ id: 'wiki', title: 'Wiki', hosts: [`127.0.0.1:${(server.address() as AddressInfo).port}`] }])
      expect(wiki.permissions.summary).toContain(`publica em 127.0.0.1:${(server.address() as AddressInfo).port} com a sua conta (pelo VVPost)`)

      const before = await svc.targets()
      expect(before.targets[0]).toMatchObject({ provider: 'wiki', available: true, session: { status: 'signedOut', credential: { label: 'Token de integração' } } })
      await expect(svc.signIn('wiki', 'errado')).rejects.toThrow(/Wiki recusou a credencial: .*HTTP 401/)
      const session = await svc.signIn('wiki', TOKEN)
      // O header que o plugin pôs foi trocado pela credencial, e o eco do servidor volta mascarado.
      expect(session).toEqual({ status: 'signedIn', account: 'Dana Bearer [REDACTED]', destination: 'space:DOC' })
      expect(seen.at(-1)).toMatchObject({ url: '/me', auth: `Bearer ${TOKEN}`, cookie: undefined })

      const prepared = await svc.prepare('wiki')
      const plan = await svc.plan(prepared.id, [])
      expect(plan.warnings[0]).toMatch(/só fala com 127\.0\.0\.1/)
      expect(plan.items.every((i) => i.action === 'create')).toBe(true)
      const applied = await svc.apply(prepared.id, { update: [], conflicts: [], archive: [] })
      expect(applied.recorded).toBe(true)
      expect(applied.items.every((i) => i.outcome === 'created' && i.id)).toBe(true)
      const config = JSON.parse(readFileSync(join(dir, 'vvpost.publish.json'), 'utf8')) as { targets: { published: Record<string, { id: string }> }[] }
      expect(Object.keys(config.targets[0]!.published).length).toBe(plan.items.length)
      expect(readFileSync(join(dir, 'vvpost.publish.json'), 'utf8')).not.toContain(TOKEN)

      // Sair apaga a credencial do cofre.
      await svc.signOut('wiki')
      expect(await credentials.get('acme-wiki/wiki')).toBeNull()
      expect((await svc.targets()).targets[0]!.session?.status).toBe('signedOut')
    } finally {
      await manager.shutdown()
    }
  }, 30_000)
})
