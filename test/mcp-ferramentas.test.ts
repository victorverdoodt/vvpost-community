import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { createHttpDispatcher } from '@vvpost/core/http/dispatcher'
import { createMcpServer, type JsonRpcResponse, type McpServer } from '../src/main/mcp/server'
import { usageReport } from '../src/main/mcp/usage'
import { MCP_TOOL_PROFILES, MCP_TOOL_SUMMARIES, resolveToolSelection, type McpToolProfile } from '../src/shared/mcp-tools'

// Perfis do --tools, o relatório do --usage e o teto do tools/list: cada definição anunciada vai em
// todo turno do agente, então o catálogo servido tem orçamento como o cold start.

const dir = mkdtempSync(join(tmpdir(), 'vvpost-mcp-ferramentas-'))
const http = createHttpDispatcher()
afterAll(async () => {
  await http.close()
  rmSync(dir, { recursive: true, force: true })
})

const ALL = MCP_TOOL_SUMMARIES.map(([name]) => name)
const serverWith = (toolNames?: Set<string>) => createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine(), ...(toolNames && { toolNames }) })
let nextId = 1
const rpc = async (server: McpServer, method: string, params?: Record<string, unknown>) =>
  (await server.handle({ jsonrpc: '2.0', id: nextId++, method, ...(params && { params }) })) as JsonRpcResponse
const listed = async (server: McpServer) => (await rpc(server, 'tools/list')).result as { tools: { name: string }[] }

describe('perfis de ferramentas (--tools)', () => {
  it('todo nome de perfil é uma ferramenta do servidor', () => {
    for (const names of Object.values(MCP_TOOL_PROFILES)) for (const name of names) expect(ALL).toContain(name)
  })

  it('resolve perfis, nomes e tudo; o que não existe volta em unknown', () => {
    expect(resolveToolSelection('tudo', ALL)).toEqual({ tools: null, unknown: [] })
    const mixed = resolveToolSelection('leitura, get_webhook_event', ALL)
    expect([...mixed.tools!]).toEqual([...MCP_TOOL_PROFILES.leitura, 'get_webhook_event'])
    expect(resolveToolSelection('contrato,nada', ALL).unknown).toEqual(['nada'])
  })

  it('o servidor anuncia e atende só as ferramentas do perfil', async () => {
    const server = serverWith(new Set(MCP_TOOL_PROFILES.leitura))
    expect((await listed(server)).tools.map((t) => t.name)).toEqual(ALL.filter((n) => (MCP_TOOL_PROFILES.leitura as readonly string[]).includes(n)))
    const refused = await rpc(server, 'tools/call', { name: 'edit_project', arguments: { operations: [] } })
    expect(refused.error?.code).toBe(-32602)
    const ok = await rpc(server, 'tools/call', { name: 'list_projects', arguments: {} })
    expect((ok.result as { isError: boolean }).isError).toBe(false)
  })

  it('o tools/list cabe no orçamento de perf-budgets.json, e cada perfil fica abaixo do catálogo inteiro', async () => {
    const budget = (JSON.parse(readFileSync(join(__dirname, '..', 'perf-budgets.json'), 'utf8')) as Record<string, any>)['mcpToolsListChars']
    const size = async (names?: readonly string[]) => JSON.stringify((await listed(serverWith(names && new Set(names)))).tools).length
    const all = await size()
    expect(all).toBeLessThanOrEqual(budget.max)
    for (const profile of Object.keys(MCP_TOOL_PROFILES) as McpToolProfile[]) {
      const chars = await size(MCP_TOOL_PROFILES[profile])
      expect(chars, profile).toBeLessThanOrEqual(budget.profiles[profile])
      expect(chars, profile).toBeLessThan(all)
    }
  })
})

describe('relatório de uso (--usage)', () => {
  it('conta por ferramenta e sessão, lista as sem uso e sugere o menor perfil que cobre', () => {
    const report = usageReport([
      [
        { tool: 'get_api_catalog', ms: 3, inChars: 2, outChars: 100 },
        { tool: 'edit_project', ms: 9, inChars: 40, outChars: 300 },
        { tool: 'edit_project', ms: 9, inChars: 40, outChars: 100, error: 'INVALID_ARGS' }
      ],
      [{ tool: 'get_api_catalog', ms: 3, inChars: 2, outChars: 300 }]
    ])
    expect(report.sessions).toBe(2)
    expect(report.calls).toBe(4)
    expect(report.tools).toEqual([
      { tool: 'edit_project', calls: 2, sessions: 1, errors: 1, avgOutChars: 200 },
      { tool: 'get_api_catalog', calls: 2, sessions: 2, errors: 0, avgOutChars: 200 }
    ])
    expect(report.unused).not.toContain('edit_project')
    expect(report.unused).toContain('get_webhook_event')
    expect(report.suggestion).toBe('docs')
    expect(report.text).toContain('Sugestão: --tools docs')
  })

  it('sem perfil que cubra, sugere os nomes', () => {
    expect(usageReport([[{ tool: 'get_webhook_event', ms: 1, inChars: 1, outChars: 1 }]]).suggestion).toBe('get_webhook_event')
  })
})

describe('modo enxuto (--enxuto)', () => {
  const lean = () => createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine(), enxuto: true })

  it('anuncia as mesmas ferramentas mais describe_tool, com a primeira frase e só os tipos', async () => {
    const tools = (await listed(lean())).tools as { name: string; description: string; inputSchema: { properties: Record<string, object> } }[]
    expect(tools.map((t) => t.name)).toEqual([...ALL, 'describe_tool'])
    for (const t of tools.filter((x) => x.name !== 'describe_tool')) {
      expect(t.description.length, t.name).toBeLessThanOrEqual(120)
      for (const p of Object.values(t.inputSchema.properties)) expect(Object.keys(p).every((k) => k === 'type'), t.name).toBe(true)
    }
  })

  it('cabe no orçamento enxuto, abaixo de um terço do catálogo inteiro', async () => {
    const budget = (JSON.parse(readFileSync(join(__dirname, '..', 'perf-budgets.json'), 'utf8')) as Record<string, any>)['mcpToolsListChars']
    const chars = JSON.stringify((await listed(lean())).tools).length
    const all = JSON.stringify((await listed(serverWith())).tools).length
    expect(chars).toBeLessThanOrEqual(budget.enxuto)
    expect(chars).toBeLessThan(all / 3)
  })

  it('describe_tool devolve a descrição e o schema inteiros; o desconhecido é NOT_FOUND', async () => {
    const server = lean()
    const full = (await listed(serverWith())).tools.find((t) => t.name === 'edit_project')
    const r = (await rpc(server, 'tools/call', { name: 'describe_tool', arguments: { names: ['edit_project'] } })).result as any
    expect(r.isError).toBe(false)
    expect(r.structuredContent.tools[0]).toMatchObject({ name: 'edit_project', description: (full as any).description, inputSchema: (full as any).inputSchema })
    const miss = (await rpc(server, 'tools/call', { name: 'describe_tool', arguments: { names: ['nada'] } })).result as any
    expect(miss.isError).toBe(true)
    expect(JSON.parse(miss.content[0].text).code).toBe('NOT_FOUND')
  })

  it('a validação continua com o schema inteiro e aponta describe_tool', async () => {
    const r = (await rpc(lean(), 'tools/call', { name: 'edit_project', arguments: { operations: 'x' } })).result as any
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content[0].text).hint).toContain('describe_tool')
  })
})
