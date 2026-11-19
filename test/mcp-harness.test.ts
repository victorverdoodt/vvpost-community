import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { applyProjectOps, versionOf } from '../src/main/project/apply'
import type { ProjectOp } from '../src/main/project'
import { createMcpServer, INSTRUCTIONS_FIRST_LINE_MAX, INSTRUCTIONS_SUMMARY, type McpCallStats, type McpServer } from '../src/main/mcp/server'

// O harness do MCP pensado para agentes: concorrência por versão (a pessoa no app e o agente no
// mesmo arquivo), erros com code e hint, lotes de páginas tudo ou nada, respostas compactas.

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const CONNECTOR = 'connectors/api.connector.vvpost.json'

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-mcp-harness-'))
  dirs.push(dir)
  const files: Record<string, unknown> = {
    [CONNECTOR]: {
      id: 'api',
      name: 'API',
      version: '1.0.0',
      config: { baseUrl: 'https://api.exemplo.com' },
      endpoints: [{ id: 'me', name: 'Eu', method: 'GET', path: '/me' }]
    }
  }
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), `${JSON.stringify(data, null, 2)}\n`)
  }
  return dir
}

const http = { cancel() {}, send: async () => ({ ok: false as const, error: { code: 'X', message: 'sem rede' } }) }

function server(dir: string, stats?: (e: McpCallStats) => void): McpServer {
  return createMcpServer({ workspaceDir: dir, http: http as never, auth: createAuthEngine(), ...(stats && { stats }) })
}

async function call(s: McpServer, name: string, args: Record<string, unknown>) {
  const res = (await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as {
    result: { isError: boolean; content: { text: string }[] }
  }
  const text = res.result.content[0]!.text
  return { isError: res.result.isError, text, data: JSON.parse(text) }
}

const health = { op: 'upsertEndpoint', connectorId: 'api', endpoint: { id: 'health', name: 'Saúde', method: 'GET', path: '/health' } }

describe('MCP: harness para agentes', () => {
  it('get_source devolve a versão, e edit_project com expect recusa se a pessoa gravou depois', async () => {
    const dir = workspace()
    const s = server(dir)
    const read = await call(s, 'get_source', { kind: 'connector', id: 'api' })
    expect(read.data.version).toBe(versionOf(readFileSync(join(dir, CONNECTOR), 'utf8')))

    // A pessoa salva no app entre a leitura e a escrita do agente.
    const edited = readFileSync(join(dir, CONNECTOR), 'utf8').replace('"API"', '"API da pessoa"')
    writeFileSync(join(dir, CONNECTOR), edited)

    const write = await call(s, 'edit_project', { ops: [health], expect: { [CONNECTOR]: read.data.version } })
    expect(write.isError).toBe(true)
    expect(write.data).toMatchObject({ code: 'CONFLICT', conflicts: [{ path: CONNECTOR, expected: read.data.version, actual: versionOf(edited) }] })
    expect(write.data.hint).toContain('get_source')
    // Nada foi gravado: a mudança da pessoa continua lá.
    expect(readFileSync(join(dir, CONNECTOR), 'utf8')).toBe(edited)

    // Relendo, o lote passa e devolve a versão nova para a próxima escrita sem reler.
    const again = await call(s, 'get_source', { kind: 'connector', id: 'api' })
    const ok = await call(s, 'edit_project', { ops: [health], expect: { [CONNECTOR]: again.data.version } })
    expect(ok.data).toMatchObject({ ok: true })
    expect(ok.data.changes[0].version).toBe(versionOf(readFileSync(join(dir, CONNECTOR), 'utf8')))
    expect(JSON.parse(readFileSync(join(dir, CONNECTOR), 'utf8')).name).toBe('API da pessoa')
  })

  it('expect com null exige que o arquivo não exista', async () => {
    const dir = workspace()
    const s = server(dir)
    const res = await call(s, 'edit_project', { ops: [health], expect: { [CONNECTOR]: null } })
    expect(res.data.code).toBe('CONFLICT')
  })

  it('o lote não grava por cima de um arquivo que mudou entre a validação e a gravação', async () => {
    const dir = workspace()
    const original = readFileSync(join(dir, CONNECTOR), 'utf8')
    // checkText roda depois da leitura e antes da gravação: é aqui que a pessoa salva no app.
    const result = await applyProjectOps(dir, [health as ProjectOp], {
      checkText: () => {
        writeFileSync(join(dir, CONNECTOR), original.replace('"API"', '"No meio"'))
        return undefined
      }
    })
    expect(result.ok).toBe(false)
    expect(result.conflicts).toEqual([{ path: CONNECTOR, expected: versionOf(original), actual: expect.any(String) }])
    expect(JSON.parse(readFileSync(join(dir, CONNECTOR), 'utf8')).name).toBe('No meio')
  })

  it('menos passos: get_source em lote, e as escritas já trazem a conferência', async () => {
    const dir = workspace()
    const s = server(dir)
    // Gravar direto (sem dryRun) devolve o catálogo conferido.
    const write = await call(s, 'edit_project', { ops: [health] })
    expect(write.data.catalog).toMatchObject({ connectors: 1, endpoints: 2, issues: 0 })
    // Vários conectores numa leitura, cada um com o próprio erro.
    const batch = await call(s, 'get_source', { kind: 'connector', ids: ['api', 'nada'] })
    expect(batch.data.items[0]).toMatchObject({ id: 'api', file: CONNECTOR })
    expect(batch.data.items[1]).toMatchObject({ id: 'nada', code: 'NOT_FOUND' })
    // Página gravada devolve o documento do projeto montado.
    await call(s, 'save_docs_project', { source: '# Doc\n\n{{> include docs/a.md}}' })
    const page = await call(s, 'write_docs_page', { file: 'docs/a.md', markdown: '## A\n\nTexto.' })
    expect(page.data.document).toMatchObject({ errors: 0, chars: expect.any(Number) })
    expect(page.data.document.outline).toBeUndefined()
  })

  it('fluxograma grande sem etapas vira aviso na linha dele; com etapas, não', async () => {
    const dir = workspace()
    const s = server(dir)
    const chain = Array.from({ length: 30 }, (_, i) => `  N${i}["passo ${i}"] --> N${i + 1}["passo ${i + 1}"]`).join('\n')
    const staged = Array.from({ length: 3 }, (_, k) =>
      [`  subgraph S${k}["Etapa ${k}"]`, ...Array.from({ length: 10 }, (_, i) => `    M${k}_${i}["p"] --> M${k}_${i + 1}["p"]`), '  end'].join('\n')
    ).join('\n')
    await call(s, 'save_docs_project', { source: '# Doc\n\n{{> include docs/a.md}}' })
    const big = await call(s, 'write_docs_page', { file: 'docs/a.md', markdown: `## A\n\n\`\`\`mermaid\nflowchart TD\n${chain}\n\`\`\`` })
    expect(big.data.document.firstDiagnostics).toEqual([
      expect.objectContaining({ file: 'docs/a.md', line: 3, severity: 'warning', message: expect.stringContaining('divida em etapas') })
    ])
    const ok = await call(s, 'write_docs_page', { file: 'docs/a.md', markdown: `## A\n\n\`\`\`mermaid\nflowchart TD\n${staged}\n\`\`\`` })
    expect(ok.data.document.warnings).toBe(0)
  })

  it('apagar um conector citado no documento devolve a diretiva quebrada e avisa do PDF velho', async () => {
    const dir = workspace()
    const s = server(dir)
    await call(s, 'edit_project', { ops: [health] })
    await call(s, 'save_docs_project', { source: '# Doc\n\n{{> endpoint api/health}}' })
    mkdirSync(join(dir, 'docs/export'), { recursive: true })
    writeFileSync(join(dir, 'docs/export/api.pdf'), '%PDF-1.7')
    const del = await call(s, 'edit_project', { ops: [{ op: 'deleteEndpoint', connectorId: 'api', endpointId: 'health' }] })
    expect(del.data.documentErrors).toEqual([expect.objectContaining({ severity: 'error', message: expect.stringContaining('health') })])
    expect(del.data.stalePdf).toEqual(['docs/export/api.pdf'])
    expect(del.data.hint).toContain('export_docs')
  })

  it('install_agent_rules grava a regra no repositório de código, com o projeto, uma vez só', async () => {
    const dir = workspace()
    const s = server(dir)
    await call(s, 'create_project', { name: 'Estoque' })
    const repo = mkdtempSync(join(tmpdir(), 'vvpost-repo-'))
    dirs.push(repo)
    writeFileSync(join(repo, 'AGENTS.md'), '# Regras\n')
    const dry = await call(s, 'install_agent_rules', { project: 'estoque', repo, dryRun: true })
    expect(dry.data).toMatchObject({ ok: true, action: 'appended', dryRun: true })
    expect(readFileSync(join(repo, 'AGENTS.md'), 'utf8')).toBe('# Regras\n')
    const done = await call(s, 'install_agent_rules', { project: 'estoque', repo })
    expect(done.data).toMatchObject({ ok: true, action: 'appended', file: join(repo, 'AGENTS.md') })
    const text = readFileSync(join(repo, 'AGENTS.md'), 'utf8')
    expect(text).toContain('<!-- vvpost:docs -->')
    expect(text).toContain('projeto `estoque`')
    expect(text).toContain('Código e documentação andam juntos')
    expect((await call(s, 'install_agent_rules', { project: 'estoque', repo })).data.action).toBe('unchanged')
    expect((await call(s, 'install_agent_rules', { repo: 'relativo' })).data.code).toBe('INVALID_ARGS')
  })

  it('install_agent_rules sem arquivo escolhido: AGENTS.md com o CLAUDE.md importando-o; só com CLAUDE.md, avisa do Codex', async () => {
    const s = server(workspace())
    const empty = mkdtempSync(join(tmpdir(), 'vvpost-repo-'))
    dirs.push(empty)
    const dry = await call(s, 'install_agent_rules', { repo: empty, dryRun: true })
    expect(dry.data).toMatchObject({ action: 'created', file: join(empty, 'AGENTS.md'), claudeImport: { action: 'created' }, dryRun: true })
    expect(existsSync(join(empty, 'CLAUDE.md'))).toBe(false)
    expect((await call(s, 'install_agent_rules', { repo: empty })).data).toMatchObject({ action: 'created', file: join(empty, 'AGENTS.md') })
    expect(readFileSync(join(empty, 'AGENTS.md'), 'utf8')).toContain('<!-- vvpost:docs -->')
    expect(readFileSync(join(empty, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n')
    expect((await call(s, 'install_agent_rules', { repo: empty })).data).toMatchObject({ action: 'unchanged' })
    expect((await call(s, 'install_agent_rules', { repo: empty })).data.claudeImport).toBeUndefined()

    // Os dois arquivos, sem a importação: a regra no AGENTS.md e a linha no fim do CLAUDE.md, sem mexer no resto.
    const both = mkdtempSync(join(tmpdir(), 'vvpost-repo-'))
    dirs.push(both)
    writeFileSync(join(both, 'CLAUDE.md'), '# Regras do Claude')
    writeFileSync(join(both, 'AGENTS.md'), '# Regras\n')
    expect((await call(s, 'install_agent_rules', { repo: both })).data).toMatchObject({ file: join(both, 'AGENTS.md'), claudeImport: { action: 'appended' } })
    expect(readFileSync(join(both, 'CLAUDE.md'), 'utf8')).toBe('# Regras do Claude\n\n@AGENTS.md\n')

    const onlyClaude = mkdtempSync(join(tmpdir(), 'vvpost-repo-'))
    dirs.push(onlyClaude)
    writeFileSync(join(onlyClaude, 'CLAUDE.md'), '# Regras\n')
    const res = await call(s, 'install_agent_rules', { repo: onlyClaude })
    expect(res.data).toMatchObject({ action: 'appended', file: join(onlyClaude, 'CLAUDE.md') })
    expect(res.data.hint).toContain('Codex')
    expect(existsSync(join(onlyClaude, 'AGENTS.md'))).toBe(false)
  })

  it('get_source de um doc longo vem em trechos, com o offset para continuar', async () => {
    const s = server(workspace())
    await call(s, 'edit_project', { ops: [health] })
    const markdown = '# API\n\n' + 'texto do guia. '.repeat(3000)
    await call(s, 'edit_project', { ops: [{ op: 'writeDoc', connectorId: 'api', markdown }] })
    const first = await call(s, 'get_source', { kind: 'doc', id: 'api' })
    expect(first.data.markdown.length).toBe(30_000)
    expect(first.data.truncated).toMatchObject({ from: 0, to: 30_000, next: { offset: 30_000 } })
    const rest = await call(s, 'get_source', { kind: 'doc', id: 'api', offset: first.data.truncated.next.offset })
    expect(first.data.markdown.length + rest.data.markdown.length).toBe(first.data.truncated.total)
    expect(first.data.markdown + rest.data.markdown).toContain(markdown.trim())
    expect(rest.data.truncated.next).toBeUndefined()
  })

  it('a primeira linha das instruções cabe nos 250 caracteres que o Codex mostra e traz a regra da credencial', () => {
    expect(INSTRUCTIONS_SUMMARY.length).toBeLessThanOrEqual(INSTRUCTIONS_FIRST_LINE_MAX)
    expect(INSTRUCTIONS_SUMMARY).not.toContain('\n')
    expect(INSTRUCTIONS_SUMMARY).toContain('execute_dry_run')
    expect(INSTRUCTIONS_SUMMARY).toContain('nunca curl')
  })

  it('sem a regra no repositório de código da sessão, as instruções e a primeira resposta pedem para oferecer install_agent_rules', async () => {
    const dir = workspace()
    const repo = mkdtempSync(join(tmpdir(), 'vvpost-repo-'))
    dirs.push(repo)
    const s = createMcpServer({ workspaceDir: dir, http: http as never, auth: createAuthEngine(), codeRepo: repo })
    const init = (await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })) as { result: { instructions: string } }
    // A primeira linha continua o resumo (é o que o Codex mostra); o aviso vem logo na segunda.
    const [summary, notice] = init.result.instructions.split('\n')
    expect(summary).toBe(INSTRUCTIONS_SUMMARY)
    expect(notice!.startsWith(`O repositório de código desta sessão (${repo})`)).toBe(true)
    expect(notice).toContain(`install_agent_rules { repo: ${JSON.stringify(repo)} }`)
    const first = await call(s, 'list_projects', {})
    expect(first.data.agentRules).toMatchObject({ repo, installed: false })
    // Um lembrete só: a segunda resposta não repete.
    expect((await call(s, 'list_projects', {})).data.agentRules).toBeUndefined()

    await call(s, 'install_agent_rules', { repo })
    const after = (await s.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })) as { result: { instructions: string } }
    expect(after.result.instructions.startsWith('VVPost:')).toBe(true)
    expect(after.result.instructions).not.toContain('ainda não tem a regra')
    // Com a regra, um servidor novo nem lembra.
    const fresh = createMcpServer({ workspaceDir: dir, http: http as never, auth: createAuthEngine(), codeRepo: repo })
    expect((await call(fresh, 'list_projects', {})).data.agentRules).toBeUndefined()
  })

  it('find_references acha um nome nas páginas e nos campos dos conectores, sem acento nem caixa', async () => {
    const dir = workspace()
    const s = server(dir)
    await call(s, 'edit_project', { ops: [{ op: 'patchConnector', id: 'api', set: { description: 'Usa a BrasilAPI como reserva' } }] })
    await call(s, 'write_docs_page', { file: 'docs/a.md', markdown: '# A\n\nNada aqui.\n\nFallback na brasilapi e na Receitá.' })
    const found = await call(s, 'find_references', { terms: ['BRASILAPI', 'receita'] })
    expect(found.data.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: 'docs/a.md', line: 5 }),
        expect.objectContaining({ file: CONNECTOR, field: 'description', text: 'Usa a BrasilAPI como reserva' })
      ])
    )
    expect((await call(s, 'find_references', { terms: ['inexistente'] })).data).toEqual({ count: 0, matches: [] })
  })

  it('find_references diz em exact onde replaceReferences trocaria o termo, sem gravar', async () => {
    const dir = workspace()
    const s = server(dir)
    await call(s, 'write_docs_page', { file: 'docs/a.md', markdown: '# A\n\nMande o `cep`.\n\nO CEP e o cepDestino ficam.' })
    const found = await call(s, 'find_references', { terms: ['cep'] })
    expect(found.data.exact).toEqual({ cep: { count: 1, files: [{ file: 'docs/a.md', count: 1 }] } })
    expect(readFileSync(join(dir, 'docs/a.md'), 'utf8')).toContain('`cep`')
    expect((await call(s, 'find_references', { terms: ['CEP_X'] })).data.exact).toBeUndefined()
  })

  it('get_schema com part traz só a definição e as que ela usa', async () => {
    const dir = workspace()
    const s = server(dir)
    const whole = await call(s, 'get_schema', { name: 'connector' })
    const scenario = await call(s, 'get_schema', { name: 'connector', part: 'scenario' })
    expect(scenario.data.$ref).toBe('#/$defs/scenario')
    expect(Object.keys(scenario.data.$defs)).toEqual(expect.arrayContaining(['scenario', 'assertion']))
    expect(scenario.text.length).toBeLessThan(whole.text.length / 3)
    expect((await call(s, 'get_schema', { name: 'connector', part: 'nada' })).data).toMatchObject({ code: 'NOT_FOUND', hint: expect.stringContaining('scenario') })
  })

  it('get_source com endpoint traz só ele inteiro e a versão dos arquivos dele', async () => {
    const dir = workspace()
    const s = server(dir)
    await call(s, 'edit_project', { ops: [health] })
    const one = await call(s, 'get_source', { kind: 'connector', id: 'api', endpoint: 'health' })
    expect(one.data.connector.endpoints.map((e: { id: string }) => e.id)).toEqual(['health'])
    expect(one.data.connector.otherEndpoints).toEqual(['me'])
    expect(one.data.version).toEqual(expect.any(String))
    expect((await call(s, 'get_source', { kind: 'connector', id: 'api', endpoint: 'nada' })).data.code).toBe('NOT_FOUND')
  })

  it('upsertEndpoint enxerga o fluxo-base criado antes no mesmo lote', async () => {
    const dir = workspace()
    const s = server(dir)
    const base = { id: 'cnpj', name: 'CNPJ', version: '1.0.0', defaults: { baseUrl: 'https://cnpj.exemplo.com' }, nodes: [] }
    const res = await call(s, 'edit_project', {
      ops: [
        { op: 'upsertFlow', flow: base },
        { op: 'upsertEndpoint', connectorId: 'cnpj', endpoint: { id: 'consultar', name: 'Consultar', method: 'GET', path: '/cnpj/{cnpj}' } }
      ]
    })
    expect(res.data).toMatchObject({ ok: true })
    const source = await call(s, 'get_source', { kind: 'connector', id: 'cnpj' })
    expect(source.data.connector.endpoints).toEqual([expect.objectContaining({ id: 'consultar', path: '/cnpj/{cnpj}' })])
  })

  it('um fluxo de requisição que não vira endpoint, com cenários, é erro no lote (antes passava em silêncio)', async () => {
    const dir = workspace()
    const s = server(dir)
    const base = { id: 'cnpj', name: 'CNPJ', version: '1.0.0', defaults: { baseUrl: 'https://cnpj.exemplo.com' }, nodes: [] }
    const request = {
      id: 'cnpj.consultar',
      name: 'Consultar',
      extends: 'cnpj',
      nodes: [{ id: 'request', name: 'Request', type: 'request', request: { method: 'GET', url: '/cnpj/{cnpj}', pathParams: { cnpj: '1' } } }],
      scenarios: [{ id: 'ok', name: 'OK', assertions: [{ target: 'status', operator: 'equals', expected: 200 }] }]
    }
    const res = await call(s, 'edit_project', { ops: [{ op: 'upsertFlow', flow: base }, { op: 'upsertFlow', flow: request }], dryRun: true })
    expect(res.data).toMatchObject({ ok: false, code: 'VALIDATION' })
    expect(res.data.errors[0].message).toMatch(/não vira endpoint de "cnpj".*pathParams/)
  })

  it('o dryRun devolve planId, e aplicar pelo planId não reenvia as operações nem passa por cima de mudança', async () => {
    const dir = workspace()
    const s = server(dir)
    const dry = await call(s, 'edit_project', { ops: [health], dryRun: true })
    expect(dry.data.planId).toEqual(expect.any(String))
    const applied = await call(s, 'edit_project', { planId: dry.data.planId })
    expect(applied.data).toMatchObject({ ok: true, changes: [{ path: CONNECTOR, action: 'update' }] })
    // Usado, o plano acaba.
    expect((await call(s, 'edit_project', { planId: dry.data.planId })).data.code).toBe('NOT_FOUND')

    // A pessoa grava entre o dryRun e a aplicação: CONFLICT.
    const other = { op: 'upsertEndpoint', connectorId: 'api', endpoint: { id: 'ping', name: 'Ping', method: 'GET', path: '/ping' } }
    const dry2 = await call(s, 'edit_project', { ops: [other], dryRun: true })
    writeFileSync(join(dir, CONNECTOR), readFileSync(join(dir, CONNECTOR), 'utf8').replace('"API"', '"Mudou"'))
    expect((await call(s, 'edit_project', { planId: dry2.data.planId })).data.code).toBe('CONFLICT')
  })

  it('write_docs_page troca trechos com edits, sem reenviar a página', async () => {
    const dir = workspace()
    const s = server(dir)
    await call(s, 'write_docs_page', { file: 'docs/a.md', markdown: '# A\n\nUm texto.\n\nOutro texto.' })
    const ok = await call(s, 'write_docs_page', { file: 'docs/a.md', edits: [{ find: 'Um texto.', replace: 'Um texto melhor.' }] })
    expect(ok.data.ok).toBe(true)
    expect(readFileSync(join(dir, 'docs/a.md'), 'utf8')).toBe('# A\n\nUm texto melhor.\n\nOutro texto.\n')
    const twice = await call(s, 'write_docs_page', { file: 'docs/a.md', edits: [{ find: 'texto', replace: 'x' }] })
    expect(twice.data).toMatchObject({ code: 'VALIDATION', error: expect.stringContaining('mais de uma vez') })
    expect((await call(s, 'write_docs_page', { file: 'docs/a.md' })).data.code).toBe('INVALID_ARGS')

    // Página com \r\n (Windows): o trecho de várias linhas mandado com \n casa, e o arquivo fica em \r\n.
    writeFileSync(join(dir, 'docs/b.md'), '# B\r\n\r\nLinha 1\r\nLinha 2\r\n')
    const crlf = await call(s, 'write_docs_page', { file: 'docs/b.md', edits: [{ find: 'Linha 1\nLinha 2', replace: 'Linha nova' }] })
    expect(crlf.data.ok).toBe(true)
    expect(readFileSync(join(dir, 'docs/b.md'), 'utf8')).toBe('# B\r\n\r\nLinha nova\r\n')
  })

  it('repetir o mesmo lote não regrava nada (idempotente)', async () => {
    const dir = workspace()
    const s = server(dir)
    expect((await call(s, 'edit_project', { ops: [health] })).data.changes).toHaveLength(1)
    const again = await call(s, 'edit_project', { ops: [health] })
    expect(again.data).toMatchObject({ ok: true, unchanged: true, changes: [] })
    expect(again.data.versions).toBeUndefined()
  })

  it('write_docs_page grava várias páginas tudo ou nada', async () => {
    const dir = workspace()
    const s = server(dir)
    const ok = await call(s, 'write_docs_page', {
      pages: [
        { file: 'docs/visao-geral.md', markdown: '# Visão geral' },
        { file: 'docs/diagramas/contexto.mmd', markdown: 'flowchart LR\n  A --> B' }
      ]
    })
    expect(ok.data.ok).toBe(true)
    expect(ok.data.pages.map((p: { file: string }) => p.file)).toEqual(['docs/visao-geral.md', 'docs/diagramas/contexto.mmd'])
    expect(ok.data.note).toContain('{{> include docs/visao-geral.md}}')
    expect(ok.data.note).not.toContain('contexto.mmd')

    // A segunda página é inválida: a primeira volta ao que era.
    const bad = await call(s, 'write_docs_page', {
      pages: [
        { file: 'docs/visao-geral.md', markdown: '# Mudou' },
        { file: 'fora/x.md', markdown: 'x' }
      ]
    })
    expect(bad.isError).toBe(true)
    expect(bad.data).toMatchObject({ code: 'VALIDATION' })
    expect(bad.data.error).toContain('pages[1]')
    expect(readFileSync(join(dir, 'docs/visao-geral.md'), 'utf8')).toBe('# Visão geral\n')

    // De novo igual: unchanged.
    const same = await call(s, 'write_docs_page', { file: 'docs/visao-geral.md', markdown: '# Visão geral' })
    expect(same.data).toMatchObject({ ok: true, unchanged: true, version: versionOf('# Visão geral\n') })
  })

  it('save_docs_project confere expect e devolve as versões gravadas', async () => {
    const dir = workspace()
    const s = server(dir)
    const read = await call(s, 'get_docs_project', {})
    expect(read.data.versions).toEqual({ 'vvpost.docs.json': null, 'docs/projeto.md': null })
    const saved = await call(s, 'save_docs_project', { source: '# Doc', expect: read.data.versions })
    expect(saved.data.ok).toBe(true)
    expect(saved.data.versions['docs/projeto.md']).toBe(versionOf('# Doc\n'))
    // A versão lida antes não vale mais.
    const stale = await call(s, 'save_docs_project', { source: '# Outra', expect: read.data.versions })
    expect(stale.data.code).toBe('CONFLICT')
    expect(readFileSync(join(dir, 'docs/projeto.md'), 'utf8')).toBe('# Doc\n')
  })

  it('erros trazem code e hint, e generate_docs { outline } não devolve o Markdown', async () => {
    const dir = workspace()
    const s = server(dir)
    expect((await call(s, 'get_source', { kind: 'connector', id: 'nao-existe' })).data).toMatchObject({
      code: 'NOT_FOUND',
      hint: expect.stringContaining('get_api_catalog')
    })
    expect((await call(s, 'get_source', { kind: 'x' })).data).toMatchObject({ code: 'INVALID_ARGS' })
    expect((await call(s, 'list_projects', { project: 'nenhum' })).data).toMatchObject({ code: 'UNKNOWN_PROJECT' })
    const outline = await call(s, 'generate_docs', { outline: true })
    expect(outline.data.markdown).toBeUndefined()
    expect(outline.data.outline.length).toBeGreaterThan(0)
    expect(outline.data.chars).toBeGreaterThan(outline.text.length)
  })

  it('get_api_catalog com view summary e issues devolve só o essencial', async () => {
    const dir = workspace()
    const s = server(dir)
    const full = await call(s, 'get_api_catalog', {})
    const summary = await call(s, 'get_api_catalog', { view: 'summary' })
    expect(summary.data).toMatchObject({ counts: { connectors: 1, endpoints: 1 }, connectors: [{ id: 'api', endpoints: 1 }] })
    expect(summary.text.length).toBeLessThan(full.text.length)
    expect((await call(s, 'get_api_catalog', { view: 'issues' })).data).toEqual({ counts: expect.objectContaining({ issues: 0 }) })
  })

  it('a resposta é JSON compacto e --stats mede cada chamada', async () => {
    const dir = workspace()
    const stats: McpCallStats[] = []
    const s = server(dir, (e) => stats.push(e))
    const res = await call(s, 'get_api_catalog', {})
    expect(res.text).not.toContain('\n  ')
    await call(s, 'get_source', { kind: 'connector', id: 'nada' })
    expect(stats).toEqual([
      expect.objectContaining({ tool: 'get_api_catalog', outChars: res.text.length }),
      expect.objectContaining({ tool: 'get_source', error: 'NOT_FOUND' })
    ])
  })

  it('create_project cria o projeto e repetir não muda nada', async () => {
    const dir = workspace()
    const s = server(dir)
    expect((await call(s, 'create_project', { name: 'Estoque', description: 'CNPJ e veículos' })).data).toMatchObject({ ok: true, project: 'estoque' })
    expect((await call(s, 'create_project', { name: 'Estoque' })).data).toMatchObject({ ok: true, existed: true, project: 'estoque' })
    expect((await call(s, 'list_projects', {})).data.projects).toEqual([expect.objectContaining({ id: 'estoque', name: 'Estoque' })])
    expect((await call(s, 'get_api_catalog', { project: 'estoque' })).isError).toBe(false)
  })

  it('os projetos usam o modelo e o logo do Compartilhado', async () => {
    const dir = workspace()
    const s = server(dir)
    await call(s, 'create_project', { name: 'Estoque' })
    mkdirSync(join(dir, 'docs/assets'), { recursive: true })
    writeFileSync(join(dir, 'docs/assets/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    // Salvo na raiz, o modelo é do Compartilhado.
    const saved = await call(s, 'save_docs_template', { name: 'Padrão Porto', config: { title: 'X', logo: 'docs/assets/logo.svg' }, source: '# {{title}}' })
    expect(saved.data.ok).toBe(true)
    const inProject = await call(s, 'get_docs_project', { project: 'estoque' })
    const shared = inProject.data.templates.find((t: { origin: string }) => t.origin === 'shared')
    expect(shared).toMatchObject({ id: 'shared:docs/templates/padrao-porto.doc-template.vvpost.json', name: 'Padrão Porto' })
    const applied = await call(s, 'save_docs_project', { project: 'estoque', template: shared.id })
    expect(applied.data.ok).toBe(true)
    const { readDocsLogo } = await import('@vvpost/core/docs')
    expect(await readDocsLogo(join(dir, 'estoque'), 'docs/assets/logo.svg')).toMatch(/^data:image\/svg\+xml;base64,/)
  })

  it('export_docs grava Markdown dentro do projeto e recusa caminho de fora', async () => {
    const dir = workspace()
    const s = server(dir)
    const md = await call(s, 'export_docs', { format: 'md' })
    expect(md.data).toMatchObject({ ok: true, format: 'md', file: expect.stringMatching(/^docs\/export\/.+\.md$/) })
    expect(md.data.markdown).toBeUndefined()
    expect(readFileSync(join(dir, md.data.file), 'utf8')).toContain('# ')
    expect((await call(s, 'export_docs', { format: 'md', out: '../fora.md' })).data.code).toBe('INVALID_ARGS')
    expect((await call(s, 'export_docs', { format: 'pdf', out: 'docs/x.md' })).data.code).toBe('INVALID_ARGS')
  })

  it('export_docs { format: "site" } grava o site html com a página Mudanças, dentro do projeto', async () => {
    const dir = workspace()
    const { starterPublishConfig, PUBLISH_CONFIG_FILE } = await import('@vvpost/core/docs/publish')
    const config = starterPublishConfig('html', 'dist/site')
    config.targets[0]!.diagrams = 'code'
    writeFileSync(join(dir, PUBLISH_CONFIG_FILE), JSON.stringify(config))
    const s = server(dir)
    const site = await call(s, 'export_docs', { format: 'site', label: 'v1.0.0' })
    expect(site.data).toMatchObject({ ok: true, format: 'site', dir: 'dist/site', created: expect.any(Number) })
    expect(site.data.pages).toBeGreaterThan(0)
    expect(readFileSync(join(dir, 'dist/site/index.html'), 'utf8')).toContain('<html')
    expect(JSON.parse(readFileSync(join(dir, 'dist/site/vvpost-site.json'), 'utf8')).changelog[0]).toMatchObject({ label: 'v1.0.0' })
    // De novo, sem mudança: nada novo.
    const again = await call(s, 'export_docs', { format: 'site' })
    expect(again.data).toMatchObject({ created: 0, updated: 0 })
    // Página editada à mão: CONFLICT até force.
    writeFileSync(join(dir, 'dist/site/index.html'), '<html>editado</html>')
    const conflict = await call(s, 'export_docs', { format: 'site' })
    expect(conflict.data.code).toBe('CONFLICT')
    expect(conflict.data.error).toContain('force: true')
    expect((await call(s, 'export_docs', { format: 'site', force: true })).data.ok).toBe(true)
    expect((await call(s, 'export_docs', { format: 'site', out: '../fora' })).data.code).toBe('VALIDATION')
    expect((await call(s, 'export_docs', { format: 'site', target: 'nada' })).data.code).toBe('VALIDATION')
  })

  it('export_docs { format: "site" } não exporta para um publicador remoto nem com plugin', async () => {
    const dir = workspace()
    writeFileSync(
      join(dir, 'vvpost.publish.json'),
      JSON.stringify({
        targets: [
          { id: 'wiki', provider: 'confluence', destination: 'PAG', structure: [{ page: 'Docs', source: 'reference' }] },
          { id: 'mk', provider: 'mkdocs', destination: 'dist/mk', structure: [{ page: 'Docs', source: 'reference' }] }
        ]
      })
    )
    const s = server(dir)
    const remote = await call(s, 'export_docs', { format: 'site', target: 'wiki' })
    expect(remote.data).toMatchObject({ code: 'VALIDATION' })
    expect(remote.data.error).toContain('Enviar para')
    expect((await call(s, 'export_docs', { format: 'site' })).data.error).toContain('não tem destino')
  })
})
