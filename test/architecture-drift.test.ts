import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyDriftFixes, architectureDiagrams, architectureDrift, parseC4Diagram, staleReferences } from '@vvpost/core/docs/architecture'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { composeDocumentation } from '@vvpost/core/docs'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { loadFlows } from '@vvpost/core/flows/workspace'
import { main, type Io } from '../src/main/cli'
import { lintWorkspace } from '../src/main/lint'
import { createMcpServer } from '../src/main/mcp/server'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function workspace(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-drift-'))
  dirs.push(dir)
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
  }
  return dir
}

const endpoint = (id: string, path: string) => ({ id, name: id, method: 'GET', path })
const connector = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  version: '1.0.0',
  config: { baseUrl: 'https://api.exemplo.com' },
  endpoints: [endpoint('listar', `/${id.split('.').at(-1)}`)],
  ...extra
})

const C4 = `# Arquitetura

\`\`\`mermaid
C4Container
  title Contêineres
  Person(cliente, "Cliente")
  System_Boundary(loja, "Loja") {
    Container(pedidos, "Pedidos", "Node", "Pedidos do cliente")
    Container(estoque, "Estoque", "Node")
  }
  System_Ext(checkout, "Checkout")
  Rel(cliente, pedidos, "Compra", "HTTPS")
  Rel(checkout, estoque, "Reserva")
  Rel(checkout, fantasma, "Chama")
  %% vvpost:bind estoque connector:svc.estoque
\`\`\`
`

function seeded(extra: Record<string, unknown> = {}): string {
  return workspace({
    'connectors/pedidos.connector.vvpost.json': connector('svc.pedidos', 'Pedidos'),
    'connectors/clientes.connector.vvpost.json': connector('svc.clientes', 'Clientes'),
    'flows/checkout.flow.vvpost.json': {
      id: 'checkout',
      name: 'Checkout',
      nodes: [
        { id: 'a', name: 'Lista', type: 'request', request: { connector: 'svc.pedidos', endpoint: 'listar' } },
        { id: 'b', name: 'Cliente', type: 'request', request: { connector: 'svc.clientes', endpoint: 'listar' } }
      ],
      edges: [{ from: 'a', to: 'b' }]
    },
    'docs/arquitetura.md': C4,
    ...extra
  })
}

describe('leitor de C4', () => {
  it('elementos, fronteiras, relações e anotações, com a linha no arquivo', () => {
    const [d] = architectureDiagrams('docs/arquitetura.md', C4)
    expect(d).toMatchObject({ file: 'docs/arquitetura.md', line: 3, type: 'C4Container', title: 'Contêineres' })
    expect(d!.elements.map((e) => [e.alias, e.kind, e.external, e.parent ?? '', e.line])).toEqual([
      ['cliente', 'person', false, '', 6],
      ['loja', 'boundary', false, '', 7],
      ['pedidos', 'container', false, 'loja', 8],
      ['estoque', 'container', false, 'loja', 9],
      ['checkout', 'system', true, '', 11]
    ])
    expect(d!.elements[2]).toMatchObject({ label: 'Pedidos', technology: 'Node', description: 'Pedidos do cliente' })
    expect(d!.relations.map((r) => `${r.from}>${r.to}@${r.line}`)).toEqual(['cliente>pedidos@12', 'checkout>estoque@13', 'checkout>fantasma@14'])
    expect(d!.bindings).toEqual([{ alias: 'estoque', kind: 'connector', id: 'svc.estoque', line: 15 }])
  })

  it('vírgula dentro das aspas, $parâmetros, RelIndex e diagrama que não é C4', () => {
    const d = parseC4Diagram('%% vvpost:cover connectors flows\nC4Dynamic\n  ContainerDb_Ext(db, "Banco, legado", "SQL", $tags="x")\n  RelIndex(1, a, db, "Lê")\n  %% vvpost:ignore connector:x flow:y\n  %% vvpost:qualquer coisa', { file: 'd.mmd' })!
    expect(d.elements[0]).toMatchObject({ alias: 'db', macro: 'ContainerDb_Ext', kind: 'container', external: true, label: 'Banco, legado', technology: 'SQL' })
    expect(d.relations[0]).toMatchObject({ from: 'a', to: 'db', label: 'Lê', line: 4 })
    expect(d.covers).toEqual(['connectors', 'flows'])
    expect(d.ignores.map((i) => `${i.kind}:${i.id}`)).toEqual(['connector:x', 'flow:y'])
    expect(d.invalid).toEqual([{ line: 6, text: '%% vvpost:qualquer coisa' }])
    expect(parseC4Diagram('graph LR\n  a --> b', { file: 'x.mmd' })).toBeNull()
    // Bloco de outra linguagem com ```mermaid dentro não conta.
    expect(architectureDiagrams('a.md', '````md\n```mermaid\nC4Context\n```\n````\n')).toEqual([])
  })
})

describe('drift do C4 contra o catálogo', () => {
  const flows = [
    {
      file: 'flows/checkout.flow.vvpost.json',
      flow: {
        id: 'checkout',
        name: 'Checkout',
        nodes: [{ id: 'a', name: 'a', type: 'request', request: { connector: 'svc.pedidos', endpoint: 'listar' } }]
      }
    }
  ] as never

  it('conector novo fora do C4, elemento de conector removido e relação com alias desconhecido', () => {
    const connectors = [connector('svc.pedidos', 'Pedidos'), connector('svc.clientes', 'Clientes')] as never[]
    const items = architectureDrift(architectureDiagrams('docs/arquitetura.md', C4), { connectors, ownConnectors: connectors, flows })
    const byCode = (code: string) => items.filter((i) => i.code === code)
    expect(byCode('c4-binding-unknown')).toEqual([
      expect.objectContaining({ line: 15, connectorId: 'svc.estoque', message: 'o elemento "estoque" representa o conector svc.estoque, que não existe mais no workspace' })
    ])
    expect(byCode('c4-connector-missing')).toEqual([expect.objectContaining({ connectorId: 'svc.clientes', line: 3, message: 'o conector svc.clientes (Clientes) não aparece em nenhum diagrama de arquitetura' })])
    expect(byCode('c4-connector-missing')[0]!.hint).toContain('%% vvpost:bind svc_clientes connector:svc.clientes')
    expect(byCode('c4-relation-unknown-element')).toEqual([expect.objectContaining({ line: 14 })])
    // "checkout" casa pelo nome com o fluxo; ele chama svc.pedidos e a relação dele vai para o estoque.
    expect(byCode('c4-relation-missing')).toEqual([expect.objectContaining({ flowId: 'checkout', connectorId: 'svc.pedidos', line: 11, hint: 'Acrescente a relação: Rel(checkout, pedidos, "Chama")' })])
    expect(byCode('c4-relation-stale')).toEqual([]) // estoque não existe: o binding já acusa
  })

  it('cover, ignore, família pelo conector-base e nome ambíguo', () => {
    const base = { id: 'corp.base', name: 'Corp', version: '1.0.0', config: { baseUrl: 'https://x' } }
    const a = connector('corp.pagamentos.v1', 'Pagamentos v1', { extends: 'corp.base' })
    const b = connector('corp.pagamentos.v2', 'Pagamentos v2', { extends: 'corp.base' })
    const c = connector('corp.clientes', 'Clientes')
    const all = [base, a, b, c] as never[]
    const family = '```mermaid\nC4Context\n  System(corp, "Corporativo")\n  %% vvpost:bind corp connector:corp.base\n  %% vvpost:ignore connector:corp.clientes\n```\n'
    expect(architectureDrift(architectureDiagrams('a.md', family), { connectors: all, ownConnectors: all, flows: [] })).toEqual([])

    const ambiguous = '```mermaid\nC4Context\n  System(pagamentos, "Pagamentos")\n  System(clientes, "Clientes")\n```\n'
    const items = architectureDrift(architectureDiagrams('a.md', ambiguous), { connectors: all, ownConnectors: all, flows: [] })
    expect(items.map((i) => `${i.code} ${i.connectorId ?? i.label}`).sort()).toEqual([
      'c4-connector-missing corp.pagamentos.v1',
      'c4-connector-missing corp.pagamentos.v2',
      'c4-element-ambiguous pagamentos'
    ])

    // Com cover, cada diagrama que pede precisa mostrar tudo; o outro não conta.
    const two = `${family}\n\`\`\`mermaid\n%% vvpost:cover connectors flows\nC4Container\n  Container(v1, "Pagamentos v1")\n\`\`\`\n`
    const covered = architectureDrift(architectureDiagrams('a.md', two), { connectors: all, ownConnectors: all, flows })
    expect(covered.map((i) => `${i.code} ${i.connectorId ?? i.flowId} ${i.line}`).sort()).toEqual([
      'c4-connector-missing corp.clientes 8',
      'c4-connector-missing corp.pagamentos.v2 8',
      'c4-flow-missing checkout 8'
    ])
  })

  it('relação de um fluxo com um conector que ele não chama mais', () => {
    const connectors = [connector('svc.pedidos', 'Pedidos'), connector('svc.clientes', 'Clientes')] as never[]
    const text = '```mermaid\nC4Container\n  Component(fluxo, "Fechar pedido")\n  Container(p, "Pedidos")\n  Container(c, "Clientes")\n  Rel(fluxo, p, "Lista")\n  Rel(fluxo, c, "Busca")\n  %% vvpost:bind fluxo flow:checkout\n```\n'
    const items = architectureDrift(architectureDiagrams('a.md', text), { connectors, ownConnectors: connectors, flows })
    expect(items).toEqual([expect.objectContaining({ code: 'c4-relation-stale', line: 7, connectorId: 'svc.clientes', flowId: 'checkout' })])
  })

  it('citações no texto de endpoint, cenário, conector e fluxo que não existem mais', () => {
    const connectors = [
      connector('svc.pedidos', 'Pedidos', { endpoints: [{ ...endpoint('listar', '/p'), scenarios: [{ id: 'ok', name: 'OK' }] }] }),
      connector('svc.clientes', 'Clientes')
    ] as never[]
    const text = [
      '# ADR 3: cache dos pedidos',
      'Usamos `svc.pedidos/listar` e `svc.pedidos/listar/ok`, não `svc.pedidos/buscar` nem `svc.pedidos/listar/erro`.',
      'O `svc.estoque` saiu; `svc.clientes` ficou; o fluxo `checkout` também. Arquivo `svc.antigo.flow.vvpost.json`.',
      '{{> endpoint svc.pedidos/sumiu}}',
      '```json',
      '{ "x": "`svc.velho`" }',
      '```'
    ].join('\n')
    const items = staleReferences('docs/adr.md', text, { connectors, ownConnectors: connectors, flows })
    expect(items.map((i) => `${i.line} ${i.label}`)).toEqual(['2 svc.pedidos/buscar', '2 svc.pedidos/listar/erro', '3 svc.estoque'])
  })
})

describe('drift no lint, no CLI e no MCP', () => {
  it('o lint do workspace traz o drift com a linha no Markdown e a severidade do ruleset', async () => {
    const dir = seeded()
    const { findings } = await lintWorkspace(dir)
    const drift = findings.filter((f) => f.code.startsWith('c4-')).map((f) => `${f.severity} ${f.code} ${f.file}:${f.line}`)
    expect(drift).toEqual([
      'warn c4-connector-missing docs/arquitetura.md:3',
      'warn c4-relation-missing docs/arquitetura.md:11',
      'warn c4-relation-unknown-element docs/arquitetura.md:14',
      'error c4-binding-unknown docs/arquitetura.md:15'
    ])
    const missing = findings.find((f) => f.code === 'c4-connector-missing')!
    expect(missing.target).toEqual({ kind: 'doc', file: 'docs/arquitetura.md', line: 3 })
    expect(missing.hint).toContain('System_Ext(svc_clientes, "Clientes")')

    mkdirSync(join(dir, '.vvpost'), { recursive: true })
    writeFileSync(join(dir, '.vvpost/ruleset.yaml'), 'extends: vvpost:recommended\nrules:\n  c4-binding-unknown: off\n  c4-connector-missing: error\n')
    const team = await lintWorkspace(dir)
    expect(team.findings.filter((f) => f.code === 'c4-binding-unknown')).toEqual([])
    expect(team.findings.find((f) => f.code === 'c4-connector-missing')!.severity).toBe('error')
  })

  it('o .mmd de docs/ também conta, e o ruleset do time lê $.diagrams', async () => {
    const dir = seeded({
      'docs/arquitetura.md': '# Arquitetura\n\n{{> diagram docs/diagramas/c4.mmd}}\n',
      'docs/diagramas/c4.mmd': 'C4Context\n  System(pedidos, "Pedidos")\n  System(clientes, "Clientes", "")\n',
      '.vvpost/ruleset.yaml':
        'extends: vvpost:recommended\nrules:\n  c4-descricao:\n    message: elemento sem descrição\n    severity: warn\n    given: $.diagrams[*].elements[?(@.kind != "person")]\n    then: { field: description, function: truthy }\n'
    })
    const { findings } = await lintWorkspace(dir)
    expect(findings.filter((f) => f.code.startsWith('c4-')).map((f) => `${f.code} ${f.file}:${f.line} ${f.label}`)).toEqual([
      'c4-descricao docs/diagramas/c4.mmd:2 pedidos',
      'c4-descricao docs/diagramas/c4.mmd:3 clientes'
    ])
  })

  it('vvpost lint reprova o C4 que liga a um conector removido', async () => {
    const dir = seeded()
    let stdout = ''
    const io: Io = { stdout: (t) => (stdout += t), stderr: () => {}, env: {}, cwd: dir, isTTY: false, appDir: dir }
    expect(await main(['--workspace', dir, 'lint'], io)).toBe(2)
    expect(stdout).toMatch(/15 +erro +c4-binding-unknown +estoque: .*svc\.estoque/)
  })

  it('o agente que cria um conector fica sabendo que o C4 não o mostra', async () => {
    const dir = seeded({ 'docs/arquitetura.md': C4.replace('  %% vvpost:bind estoque connector:svc.estoque\n', '').replace('  Rel(checkout, fantasma, "Chama")\n', '') })
    const http = { cancel() {}, send: async () => ({ ok: false, error: { code: 'NETWORK', message: 'sem rede' } }) as never }
    const call = async (name: string, args: Record<string, unknown>) => {
      const server = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine() })
      const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as { result: { content: { text: string }[] } }
      return JSON.parse(res.result.content[0]!.text)
    }
    await call('lint_project', {})
    const res = await call('edit_project', { ops: [{ op: 'upsertConnector', connector: connector('svc.frete', 'Frete', { description: 'Cálculo de frete' }) }] })
    expect(res.ok).toBe(true)
    expect(res.lint.new).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'c4-connector-missing', file: 'docs/arquitetura.md', line: 3, hint: expect.stringContaining('connector:svc.frete') })]))
  })
})

describe('C4 gerado do catálogo', () => {
  it('{{> c4}} desenha o projeto, os conectores por família e os fluxos que chamam cada um', async () => {
    const dir = seeded({
      'connectors/base.connector.vvpost.json': { id: 'svc.base', name: 'Base corporativa', version: '1.0.0', config: { baseUrl: 'https://x' } },
      'connectors/pedidos.connector.vvpost.json': connector('svc.pedidos', 'Pedidos', { extends: 'svc.base' }),
      'docs/arquitetura.md': '# Arquitetura\n\n{{> c4}}\n'
    })
    const ws = await loadWorkspace(dir)
    const { markdown: md } = await composeDocumentation(ws, await loadFlows(dir), { projectName: 'Loja', source: '# Arquitetura\n\n{{> c4}}\n' })
    expect(md).toContain('C4Context')
    expect(md).toMatch(/Enterprise_Boundary\(b\d+, "Base corporativa"\) \{/)
    expect(md).toMatch(/System_Ext\(c\d+, "Pedidos"/)
    expect(md).toMatch(/Rel\(projeto, c\d+, "Checkout"/)
    // O C4 gerado nunca fica velho, e o lint não cobra nada dele.
    const { findings } = await lintWorkspace(dir)
    expect(findings.filter((f) => f.code.startsWith('c4-'))).toEqual([])
  })
})

describe('fluxograma e architecture-beta com anotação', () => {
  it('só contam com %% vvpost:, e têm elementos, fronteiras e relações', () => {
    expect(architectureDiagrams('a.md', '```mermaid\nflowchart LR\n  a --> b\n```\n')).toEqual([])
    const flow = '```mermaid\nflowchart LR\n  %% vvpost:cover connectors\n  subgraph loja [Loja]\n    pedidos["Pedidos"]\n    api@{ icon: "vv:servidor", label: "API" }\n  end\n  cliente((Cliente)) --> api & pedidos\n  api --> pedidos\n```\n'
    const [d] = architectureDiagrams('a.md', flow)
    expect(d).toMatchObject({ type: 'flowchart', syntax: 'flowchart', line: 1, end: 9 })
    expect(d!.elements.map((e) => `${e.alias}:${e.kind}:${e.label}:${e.parent ?? ''}:${e.alone}`)).toEqual([
      'loja:boundary:Loja::false',
      'pedidos:container:Pedidos:loja:true',
      'api:container:API:loja:true',
      'cliente:container:Cliente::false'
    ])
    expect(d!.relations.map((r) => `${r.from}>${r.to}@${r.line}:${r.alone}`)).toEqual(['cliente>api@8:false', 'cliente>pedidos@8:false', 'api>pedidos@9:true'])

    const arch = 'architecture-beta\n  %% vvpost:bind pay connector:svc.pedidos\n  group loja(cloud)[Loja]\n  service pay(server)[Pagamentos] in loja\n  service db(database)[Banco] in loja\n  pay:R --> L:db\n'
    const [a] = architectureDiagrams('docs/x.mmd', arch)
    expect(a).toMatchObject({ syntax: 'architecture', end: 6 })
    expect(a!.elements.map((e) => `${e.alias}:${e.kind}:${e.label}:${e.parent ?? ''}`)).toEqual(['loja:boundary:Loja:', 'pay:container:Pagamentos:loja', 'db:container:Banco:loja'])
    expect(a!.relations).toEqual([expect.objectContaining({ from: 'pay', to: 'db', line: 6, alone: true })])
  })

  it('o drift e a correção saem na sintaxe do diagrama', () => {
    const connectors = [connector('svc.pedidos', 'Pedidos'), connector('svc.clientes', 'Clientes')] as never[]
    const text = '```mermaid\nflowchart LR\n  %% vvpost:cover connectors\n  pedidos["Pedidos"]\n```\n'
    const items = architectureDrift(architectureDiagrams('a.md', text), { connectors, ownConnectors: connectors, flows: [] })
    expect(items).toEqual([expect.objectContaining({ code: 'c4-connector-missing', fix: { insert: { after: 4, lines: ['  svc_clientes["Clientes"]', '  %% vvpost:bind svc_clientes connector:svc.clientes'] } } })])
    expect(applyDriftFixes(text, items.map((i) => i.fix!))).toBe('```mermaid\nflowchart LR\n  %% vvpost:cover connectors\n  pedidos["Pedidos"]\n  svc_clientes["Clientes"]\n  %% vvpost:bind svc_clientes connector:svc.clientes\n```\n')
  })
})

describe('correção automática', () => {
  it('tira o elemento removido com as relações, acrescenta o que falta e a relação do fluxo', () => {
    const connectors = [connector('svc.pedidos', 'Pedidos'), connector('svc.clientes', 'Clientes')] as never[]
    const flows = [{ file: 'f.json', flow: { id: 'checkout', name: 'Checkout', nodes: [{ id: 'a', name: 'a', type: 'request', request: { connector: 'svc.pedidos' } }] } }] as never
    const items = architectureDrift(architectureDiagrams('docs/arquitetura.md', C4), { connectors, ownConnectors: connectors, flows })
    const fixed = applyDriftFixes(C4, items.filter((i) => i.fix).map((i) => i.fix!))
    expect(fixed).not.toContain('estoque')
    expect(fixed).toContain('  System_Ext(svc_clientes, "Clientes")\n  %% vvpost:bind svc_clientes connector:svc.clientes\n  Rel(checkout, pedidos, "Chama")\n```')
    // Depois da correção só sobra o que precisa de gente: a relação com um alias que ninguém declarou.
    const after = architectureDrift(architectureDiagrams('docs/arquitetura.md', fixed), { connectors, ownConnectors: connectors, flows })
    expect(after.map((i) => i.code)).toEqual(['c4-relation-unknown-element'])
  })

  it('fix_diagrams mostra o plano, grava com apply e o lint fica limpo', async () => {
    const dir = seeded({ 'docs/arquitetura.md': C4.replace('  Rel(checkout, fantasma, "Chama")\n', '') })
    const http = { cancel() {}, send: async () => ({ ok: false, error: { code: 'NETWORK', message: 'sem rede' } }) as never }
    const call = async (name: string, args: Record<string, unknown>) => {
      const server = createMcpServer({ workspaceDir: dir, http, auth: createAuthEngine() })
      const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as { result: { content: { text: string }[] } }
      return JSON.parse(res.result.content[0]!.text)
    }
    const plan = await call('fix_diagrams', {})
    expect(plan).toMatchObject({ ok: true, applied: false, total: 3 })
    // O conector que entra já vem com a relação do fluxo que o chama.
    expect(plan.files[0].added).toEqual(['  System_Ext(svc_clientes, "Clientes")', '  %% vvpost:bind svc_clientes connector:svc.clientes', '  Rel(checkout, svc_clientes, "Chama")', '  Rel(checkout, pedidos, "Chama")'])
    expect(plan.files[0].removed).toEqual(['    Container(estoque, "Estoque", "Node")', '  Rel(checkout, estoque, "Reserva")', '  %% vvpost:bind estoque connector:svc.estoque'])
    expect(readFileSync(join(dir, 'docs/arquitetura.md'), 'utf8')).toContain('estoque')
    const done = await call('fix_diagrams', { apply: true })
    expect(done).toMatchObject({ ok: true, applied: true, total: 3 })
    const { findings, fixable } = await lintWorkspace(dir)
    expect(findings.filter((f) => f.code.startsWith('c4-'))).toEqual([])
    expect(fixable).toBe(0)
  })

  it('vvpost lint --fix corrige e lista o que mudou', async () => {
    const dir = seeded()
    let stdout = ''
    let stderr = ''
    const io: Io = { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env: {}, cwd: dir, isTTY: false, appDir: dir }
    expect(await main(['--workspace', dir, 'lint', '--fix'], io)).toBe(0)
    expect(stderr).toContain('corrigido: docs/arquitetura.md (')
    expect(stdout).not.toContain('c4-binding-unknown')
    expect(stdout).toContain('c4-relation-unknown-element')
  })
})

describe('página velha pelo histórico do Git', () => {
  const run = (dir: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' })

  it('acusa o conector que mudou depois do último commit da página, e some quando a página é revista', async () => {
    const dir = seeded({
      'docs/arquitetura.md': '# Arquitetura\n\n```mermaid\nC4Context\n  System(pedidos, "Pedidos")\n  System(clientes, "Clientes")\n```\n',
      'docs/adr-001.md': '# ADR 1: cache\n\nO `svc.clientes/listar` responde do cache.\n'
    })
    run(dir, 'init', '-q')
    run(dir, 'add', '.')
    run(dir, 'commit', '-q', '-m', 'inicial')
    expect((await lintWorkspace(dir)).findings.filter((f) => f.code === 'doc-stale-since-change')).toEqual([])

    const file = join(dir, 'connectors/pedidos.connector.vvpost.json')
    const c = JSON.parse(readFileSync(file, 'utf8'))
    c.endpoints.push(endpoint('criar', '/pedidos'))
    c.config.auth = { type: 'bearer', token: '{{TOKEN}}' }
    writeFileSync(file, JSON.stringify(c, null, 2))
    const cl = join(dir, 'connectors/clientes.connector.vvpost.json')
    writeFileSync(cl, JSON.stringify({ ...JSON.parse(readFileSync(cl, 'utf8')), endpoints: [] }, null, 2))
    const stale = (await lintWorkspace(dir)).findings.filter((f) => f.code === 'doc-stale-since-change')
    expect(stale.map((f) => `${f.severity} ${f.file}:${f.line ?? ''} ${f.label}`).sort()).toEqual(['info docs/adr-001.md: svc.clientes', 'info docs/arquitetura.md:3 svc.clientes', 'info docs/arquitetura.md:3 svc.pedidos'])
    expect(stale.find((f) => f.label === 'svc.pedidos')!.message).toMatch(/mudou depois do último commit desta página \([0-9a-f]{7}, \d{4}-\d\d-\d\d\): \+endpoint criar, auth \(nenhum\) → bearer$/)

    // Página em edição conta como revisada; commitada depois da mudança, também.
    writeFileSync(join(dir, 'docs/arquitetura.md'), `${readFileSync(join(dir, 'docs/arquitetura.md'), 'utf8')}\n<!-- vvpost:revisado -->\n`)
    expect((await lintWorkspace(dir)).findings.filter((f) => f.code === 'doc-stale-since-change' && f.file === 'docs/arquitetura.md')).toEqual([])
    run(dir, 'add', '.')
    run(dir, 'commit', '-q', '-m', 'revisado')
    // O ADR, que ninguém revisou, continua avisando.
    expect((await lintWorkspace(dir)).findings.filter((f) => f.code === 'doc-stale-since-change').map((f) => f.file)).toEqual(['docs/adr-001.md'])
  })

  it('conector em fluxos num projeto dentro de uma pasta do repositório: endpoint novo e página em edição', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'vvpost-drift-repo-'))
    dirs.push(repo)
    const dir = join(repo, 'projetos', 'cobrança')
    const write = (path: string, data: unknown) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
    }
    const request = (id: string, url: string) => ({
      id,
      name: id,
      extends: 'billing',
      nodes: [{ id: 'request', name: 'Request', type: 'request', request: { method: 'POST', url } }]
    })
    write('flows/billing/billing.flow.vvpost.json', { id: 'billing', name: 'Billing', defaults: { baseUrl: 'https://api.test' }, nodes: [] })
    write('flows/billing/billing.charge.flow.vvpost.json', request('billing.charge', '/charges'))
    write('docs/adr-001.md', '# ADR 1: cobrança\n\nO conector billing cobra na hora.\n')
    run(repo, 'init', '-q')
    run(repo, 'add', '.')
    run(repo, 'commit', '-q', '-m', 'inicial')
    expect((await lintWorkspace(dir)).findings.filter((f) => f.code === 'doc-stale-since-change')).toEqual([])

    write('flows/billing/billing.refund.flow.vvpost.json', request('billing.refund', '/refunds'))
    const stale = (await lintWorkspace(dir)).findings.filter((f) => f.code === 'doc-stale-since-change')
    expect(stale.map((f) => `${f.file} ${f.label}`)).toEqual(['docs/adr-001.md billing'])
    expect(stale[0]!.message).toMatch(/\+endpoint billing\.refund/)

    // A página em edição (o status vem relativo à raiz do repositório) conta como revisada.
    write('docs/adr-001.md', '# ADR 1: cobrança\n\nO conector billing cobra e estorna.\n')
    expect((await lintWorkspace(dir)).findings.filter((f) => f.code === 'doc-stale-since-change')).toEqual([])
  })

  it('fora de um repositório não diz nada', async () => {
    const dir = seeded()
    expect((await lintWorkspace(dir)).findings.filter((f) => f.code === 'doc-stale-since-change')).toEqual([])
  })
})
