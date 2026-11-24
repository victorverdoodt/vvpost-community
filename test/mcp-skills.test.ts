import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { createMcpServer, type JsonRpcResponse } from '../src/main/mcp/server'
import { serveHttp } from '../src/main/mcp/transports'
import type { McpTool } from '../src/main/mcp/tools'

// O servidor fala as duas eras do MCP (initialize e a 2026-07-28 sem sessão) e publica as skills do
// VVPost pela extensão io.modelcontextprotocol/skills (SEP-2640), que o Claude Code só lê na era moderna.

const dir = mkdtempSync(join(tmpdir(), 'vvpost-mcp-skills-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const http = { cancel() {}, send: async () => ({ ok: false as const, error: { code: 'X', message: 'sem rede' } }) }
let release: () => void = () => {}
const slow: McpTool = {
  name: 'demora',
  title: 'Demora',
  description: 'Espera até ser cancelada.',
  inputSchema: { type: 'object', properties: {} },
  call: (_args, ctx) =>
    new Promise((resolve) => {
      release = () => resolve({ ok: true })
      ctx.signal?.addEventListener('abort', () => resolve({ cancelada: true }))
    })
}
const server = createMcpServer({ workspaceDir: dir, http: http as never, auth: createAuthEngine(), tools: [slow] })

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'teste', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {}
}
let next = 1
const modern = async (method: string, params: Record<string, unknown> = {}) =>
  (await server.handle({ jsonrpc: '2.0', id: next++, method, params: { _meta: META, ...params } })) as JsonRpcResponse
const legacy = async (method: string, params: Record<string, unknown> = {}) =>
  (await server.handle({ jsonrpc: '2.0', id: next++, method, params })) as JsonRpcResponse

interface Entry {
  uri: string
  frontmatter: { name: string; description: string }
  resources: { uri: string; digest: string; size: number }[]
}

describe('MCP 2026-07-28 (sem sessão)', () => {
  it('server/discover anuncia as versões, a extensão de skills e as instruções', async () => {
    const r = (await modern('server/discover')).result as Record<string, any>
    expect(r.supportedVersions).toEqual(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])
    expect(r.capabilities.extensions['io.modelcontextprotocol/skills']).toEqual({ directoryRead: true })
    expect(r.capabilities.resources).toBeDefined()
    expect(r.instructions).toContain('skill://atualizar-docs-com-o-codigo/SKILL.md')
    expect(r).toMatchObject({ resultType: 'complete', cacheScope: 'private' })
    expect(r._meta['io.modelcontextprotocol/serverInfo']).toMatchObject({ name: 'vvpost' })
  })

  it('pedido moderno leva resultType e cache; versão desconhecida volta o erro com as suportadas', async () => {
    const list = (await modern('tools/list')).result as Record<string, any>
    expect(list).toMatchObject({ resultType: 'complete', ttlMs: 300_000, cacheScope: 'private' })
    expect(list.tools.map((t: { name: string }) => t.name)).toEqual(['demora'])
    const bad = (await server.handle({ jsonrpc: '2.0', id: 'v', method: 'tools/list', params: { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } })) as JsonRpcResponse
    expect(bad.error).toMatchObject({ code: -32022, data: { requested: '1900-01-01', supported: expect.arrayContaining(['2026-07-28']) } })
  })

  it('a era legada continua igual, e o initialize também anuncia as skills', async () => {
    const init = (await legacy('initialize', { protocolVersion: '2025-11-25' })).result as Record<string, any>
    expect(init.protocolVersion).toBe('2025-11-25')
    expect(init.capabilities.extensions['io.modelcontextprotocol/skills']).toEqual({ directoryRead: true })
    expect((await legacy('initialize', { protocolVersion: '2026-07-28' })).result).toMatchObject({ protocolVersion: '2025-11-25' })
    const list = (await legacy('tools/list')).result as Record<string, unknown>
    expect(list).not.toHaveProperty('resultType')
    expect(list).not.toHaveProperty('ttlMs')
  })

  it('notifications/cancelled para a ferramenta em andamento', async () => {
    const pending = server.handle({ jsonrpc: '2.0', id: 'longa', method: 'tools/call', params: { _meta: META, name: 'demora', arguments: {} } })
    await new Promise((r) => setTimeout(r, 10))
    await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'longa' } })
    const reply = (await pending) as JsonRpcResponse
    expect((reply.result as { structuredContent: unknown }).structuredContent).toEqual({ cancelada: true })
    release()
  })
})

describe('Skills over MCP', () => {
  it('skills/list traz manifestos completos, que batem byte a byte com o resources/read', async () => {
    const r = (await modern('skills/list')).result as { skills: Entry[]; ttlMs: number; cacheScope: string; resultType: string }
    expect(r).toMatchObject({ resultType: 'complete', cacheScope: 'public' })
    expect(r.ttlMs).toBeGreaterThan(0)
    const names = r.skills.map((s) => s.frontmatter.name)
    expect(names).toEqual(expect.arrayContaining(['atualizar-docs-com-o-codigo', 'chamar-api', 'documentar-projeto', 'documentar-conector', 'aplicar-modelo-de-docs']))
    for (const skill of r.skills) {
      const { name, description } = skill.frontmatter
      // Regras do Agent Skills: nome em minúsculas com hífen, até 64; descrição até 1024.
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(name.length).toBeLessThanOrEqual(64)
      expect(description.length).toBeLessThanOrEqual(1024)
      expect(skill.uri).toBe(`skill://${name}/SKILL.md`)
      expect(skill.resources.some((f) => f.uri === skill.uri)).toBe(true)
      for (const file of skill.resources) {
        const read = (await modern('resources/read', { uri: file.uri })).result as { contents: { text: string; mimeType: string }[] }
        const bytes = Buffer.from(read.contents[0]!.text, 'utf8')
        expect(bytes.length).toBe(file.size)
        expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(file.digest)
      }
      // O frontmatter do SKILL.md é o da entrada (o cliente compara campo a campo).
      const md = ((await modern('resources/read', { uri: skill.uri })).result as { contents: { text: string }[] }).contents[0]!.text
      const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(md)!
      expect(front[1]).toBe(name)
      expect(JSON.parse(front[2]!)).toBe(description)
    }
  })

  it('skills/get pela uri, -32602 para o que não é skill, e a skill guia cita só ferramentas que existem', async () => {
    const got = (await modern('skills/get', { uri: 'skill://documentar-projeto/SKILL.md' })).result as { skill: Entry }
    expect(got.skill.resources.map((f) => f.uri)).toEqual(['skill://documentar-projeto/SKILL.md', 'skill://documentar-projeto/references/guia.md'])
    expect((await modern('skills/get', { uri: 'skill://nada/SKILL.md' })).error?.code).toBe(-32602)
    expect((await modern('resources/read', { uri: 'skill://nada/SKILL.md' })).error?.code).toBe(-32602)
    // Na era legada as skills também respondem (cliente que lê a extensão do initialize).
    expect(((await legacy('skills/list')).result as { skills: unknown[] }).skills.length).toBeGreaterThan(0)
  })

  it('resources/directory/read lista os filhos diretos', async () => {
    const root = (await modern('resources/directory/read', { uri: 'skill://documentar-projeto' })).result as { resources: { uri: string; mimeType: string }[] }
    expect(root.resources).toEqual([
      { uri: 'skill://documentar-projeto/references', name: 'references', mimeType: 'inode/directory' },
      { uri: 'skill://documentar-projeto/SKILL.md', name: 'SKILL.md', mimeType: 'text/markdown' }
    ].sort((a, b) => a.uri.localeCompare(b.uri)))
    const refs = (await modern('resources/directory/read', { uri: 'skill://documentar-projeto/references' })).result as { resources: { name: string }[] }
    expect(refs.resources.map((r) => r.name)).toEqual(['guia.md'])
    expect((await modern('resources/directory/read', { uri: 'skill://documentar-projeto/SKILL.md' })).error?.code).toBe(-32602)
  })

  it('as skills citam só ferramentas do servidor', async () => {
    const { TOOLS } = await import('../src/main/mcp/tools')
    const { EDIT_TOOLS } = await import('../src/main/mcp/edit-tools')
    const { READINESS_TOOLS } = await import('../src/main/mcp/readiness-tools')
    const { LINT_TOOLS } = await import('../src/main/mcp/lint-tools')
    const names = new Set([...TOOLS, ...EDIT_TOOLS, ...READINESS_TOOLS, ...LINT_TOOLS].map((t) => t.name))
    const skills = ((await modern('skills/list')).result as { skills: Entry[] }).skills
    for (const s of skills) {
      const md = ((await modern('resources/read', { uri: s.uri })).result as { contents: { text: string }[] }).contents[0]!.text
      const cited = [...md.matchAll(/`([a-z]+(?:_[a-z]+)+)(?:[ `])/g)].map((m) => m[1]!)
      for (const tool of cited) expect(names, `${s.frontmatter.name} cita ${tool}`).toContain(tool)
    }
  })
})

describe('Streamable HTTP da era moderna', () => {
  const post = (port: number, headers: Record<string, string>, body: unknown) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }))
      })
      req.on('error', reject)
      req.end(JSON.stringify(body))
    })

  it('confere MCP-Protocol-Version, Mcp-Method e Mcp-Name e devolve os status da spec', async () => {
    const running = await serveHttp(server, { port: 0 })
    try {
      const v = { 'mcp-protocol-version': '2026-07-28' }
      const read = { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { _meta: META, uri: 'skill://chamar-api/SKILL.md' } }
      const okRead = await post(running.port, { ...v, 'mcp-method': 'resources/read', 'mcp-name': 'skill://chamar-api/SKILL.md' }, read)
      expect(okRead.status).toBe(200)
      expect(okRead.body.result.contents[0].uri).toBe('skill://chamar-api/SKILL.md')
      const b64 = `=?base64?${Buffer.from('skill://chamar-api/SKILL.md').toString('base64')}?=`
      expect((await post(running.port, { ...v, 'mcp-method': 'resources/read', 'mcp-name': b64 }, read)).status).toBe(200)
      const wrongName = await post(running.port, { ...v, 'mcp-method': 'resources/read', 'mcp-name': 'skill://outra/SKILL.md' }, read)
      expect(wrongName).toMatchObject({ status: 400, body: { id: 1, error: { code: -32020 } } })
      expect((await post(running.port, { 'mcp-method': 'resources/read', 'mcp-name': 'skill://chamar-api/SKILL.md' }, read)).status).toBe(400)
      expect((await post(running.port, { ...v, 'mcp-method': 'tools/list' }, { ...read, method: 'tools/list' })).status).toBe(200)
      expect((await post(running.port, { ...v, 'mcp-method': 'skills/list' }, read)).body.error.code).toBe(-32020)
      const unknown = await post(running.port, { ...v, 'mcp-method': 'nada/disso' }, { jsonrpc: '2.0', id: 2, method: 'nada/disso', params: { _meta: META } })
      expect(unknown).toMatchObject({ status: 404, body: { error: { code: -32601 } } })
      const old = { ...META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' }
      const version = await post(running.port, { 'mcp-protocol-version': '1900-01-01', 'mcp-method': 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: old } })
      expect(version).toMatchObject({ status: 400, body: { error: { code: -32022 } } })
      // Versão moderna no header sem o _meta no corpo é incoerente; cliente legado (header 2025-06-18) passa.
      expect((await post(running.port, v, { jsonrpc: '2.0', id: 4, method: 'tools/list' })).status).toBe(400)
      expect((await post(running.port, { 'mcp-protocol-version': '2025-06-18' }, { jsonrpc: '2.0', id: 5, method: 'tools/list' })).status).toBe(200)
      expect((await post(running.port, {}, { jsonrpc: '2.0', id: 6, method: 'nada/disso' })).status).toBe(200)
    } finally {
      await running.close()
    }
  })
})
