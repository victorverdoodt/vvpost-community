import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadWorkspace, type LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import { loadFlows } from '@vvpost/core/flows/workspace'
import {
  composeDocumentation,
  deleteDocsFile,
  renameDocsFile,
  DocsError,
  extractSection,
  listDocsFiles,
  loadDocsProject,
  readDocsLogo,
  shiftHeadings,
  workspaceWritePath,
  applyDocTemplate,
  BUILTIN_DOC_TEMPLATES,
  listDocTemplates,
  saveDocTemplate,
  type ComposeOptions,
  diagramFileName,
  docsAgentGuide,
  markdownFileName,
  readDiagram,
  readMarkdownFile,
  splitDiagramOrigin,
  writeDiagram,
  writeMarkdownFile
} from '@vvpost/core/docs'
import { fillPlaceholders, printLayout } from '@vvpost/core/docs/theme'
import type { FlowCatalog } from '@shared/ipc'

const VAULT_SECRET = 'vault-s3cr3t-Kp4!compose'

describe('documento do projeto (editor estilo Overleaf)', () => {
  let dir: string
  let ws: LoadedWorkspace
  let flows: FlowCatalog
  const put = (path: string, data: unknown) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  }
  const compose = (source: string, extra: Partial<ComposeOptions> = {}) =>
    composeDocumentation(ws, flows, {
      projectName: 'Pagamentos',
      now: new Date('2026-10-25T12:00:00Z'),
      source,
      ...extra
    })

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vvpost-compose-'))
    put('connectors/billing.connector.vvpost.json', {
      id: 'connector.billing.v2',
      name: 'Billing Service v2',
      version: '2.0.0',
      config: { baseUrl: '{{BASE_URL}}', basePath: '/billing/v2', auth: { type: 'bearer', token: '{{API_TOKEN}}' } },
      endpoints: [
        {
          id: 'charge_customer',
          name: 'Efetuar Cobrança',
          method: 'POST',
          path: '/customers/{customerId}/charges',
          body: { amount: 10 },
          scenarios: [
            { id: 'ok', name: 'Cobrança aprovada', assertions: [{ target: 'status', operator: 'equals', expected: 201 }] }
          ]
        },
        { id: 'list_charges', name: 'Listar cobranças', method: 'GET', path: '/charges' }
      ]
    })
    put(
      'connectors/billing.connector.vvpost.md',
      ['# Billing', 'Visão geral.', '## Cobrar {#charge_customer}', 'Cria a cobrança.', '### Detalhes', 'Idempotente.', '## Listar', 'Lista.'].join('\n')
    )
    put('docs/intro.md', ['# Introdução', 'Bem-vindo à API.', '', '## Como autenticar', 'Peça um token ao time.', '', '{{> include docs/glossario.md}}'].join('\n'))
    put('docs/glossario.md', '## Glossário\n\n- **PIX**: pagamento instantâneo.')
    put('docs/loop-a.md', '{{> include docs/loop-b.md}}')
    put('docs/loop-b.md', '{{> include docs/loop-a.md}}')
    put('docs/vazado.md', `O segredo é ${VAULT_SECRET}.`)
    put('docs/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')
    put('environments/dev.env.json', {
      id: 'dev',
      name: 'Desenvolvimento',
      variables: {
        BASE_URL: { type: 'string', value: 'https://dev.api.empresa.com' },
        API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
      }
    })
    put('.vvpost/secrets.local.json', { dev: { API_TOKEN: VAULT_SECRET } })
    ws = await loadWorkspace(dir)
    flows = await loadFlows(dir)
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('troca as diretivas pelos trechos gerados, abaixo do título em que estão', async () => {
    const { markdown, diagnostics } = await compose(
      ['## Visão geral', '', 'Texto escrito.', '', '{{> summary}}', '', '## Cobranças', '', '{{> endpoint connector.billing.v2/charge_customer}}'].join('\n')
    )
    expect(diagnostics).toEqual([])
    expect(markdown).toContain('Texto escrito.')
    expect(markdown).toContain('| Conectores | Endpoints |')
    // O endpoint (### no documento gerado) fica um nível abaixo de "## Cobranças".
    expect(markdown).toContain('### POST /customers/{customerId}/charges · Efetuar Cobrança')
    expect(markdown).toContain('#### Sequência')
    expect(markdown).not.toContain('{{>')
  })

  it('inclui trechos de outras docs pelo {#id} ou pelo título, com inclusões aninhadas', async () => {
    const { markdown, includes } = await compose(
      ['# Guia', '', '{{> include connectors/billing.connector.vvpost.md#charge_customer}}', '', '{{> include docs/intro.md#como-autenticar}}', '', '{{> include docs/intro.md}}'].join('\n')
    )
    expect(markdown).toContain('## Cobrar\n')
    expect(markdown).toContain('### Detalhes')
    expect(markdown).not.toContain('## Listar')
    expect(markdown).not.toContain('{#charge_customer}')
    expect(markdown).toContain('## Como autenticar')
    expect(markdown).toContain('## Introdução')
    // O glossário (## no arquivo) fica abaixo de "## Como autenticar" da intro incluída.
    expect(markdown).toContain('### Glossário')
    expect(includes.sort()).toEqual(['connectors/billing.connector.vvpost.md', 'docs/glossario.md', 'docs/intro.md'])
  })

  it('aponta os problemas com arquivo e linha, sem derrubar o resto', async () => {
    const { markdown, diagnostics } = await compose(
      [
        '## A',
        '{{> endpoint connector.billing.v2/nao_existe}}',
        '{{> connector}}',
        '{{> include docs/loop-a.md}}',
        '{{> include ../../fora.md}}',
        '{{> include docs/intro.md#secao-que-nao-existe}}',
        '{{> tabela}}',
        'Texto com {{> map}} no meio.',
        '```',
        '{{> map}}',
        '```',
        '{{> map}}'
      ].join('\n'),
      { sourceFile: 'docs/projeto.md' }
    )
    const at = (line: number) => diagnostics.find((d) => d.line === line)
    expect(at(2)).toMatchObject({ severity: 'error', file: 'docs/projeto.md', message: expect.stringMatching(/não existe/) })
    expect(at(3)?.message).toMatch(/use \{\{> connector <id>\}\}/)
    expect(diagnostics.find((d) => d.file === 'docs/loop-b.md')?.message).toMatch(/circular/)
    expect(at(5)?.message).toMatch(/fora do workspace/)
    expect(at(6)?.message).toMatch(/seção "secao-que-nao-existe"/)
    expect(at(7)?.message).toMatch(/diretiva desconhecida "tabela"/)
    expect(at(8)).toMatchObject({ severity: 'warning' })
    expect(at(10)).toBeUndefined()
    // O problema aparece no próprio documento; o bloco de código fica intacto; a última diretiva vale.
    expect(markdown).toContain('> ⚠️ **docs/projeto.md:2**')
    expect(markdown).toContain('```\n{{> map}}\n```')
    expect(markdown).toContain('```mermaid')
  })

  it('liga cada linha do documento montado à linha do fonte, com o sumário e os trechos', async () => {
    const source = ['## Visão', '', 'Texto do fonte.', '', '{{> include docs/intro.md}}', '', '## Fim', 'Última.'].join('\n')
    const plain = await compose(source)
    expect(plain.sourceLines).toBeUndefined()
    const r = await compose(source, { sourceMap: true, config: { numberHeadings: true } })
    const lines = r.printMarkdown.split('\n')
    expect(r.sourceLines).toHaveLength(lines.length)
    const at = (text: string) => r.sourceLines![lines.findLastIndex((l) => l.includes(text))]
    // O sumário é da montagem; o texto e os títulos numerados são do fonte.
    expect(lines[0]).toMatch(/Sumário|^- /)
    expect(r.sourceLines![0]).toBe(0)
    expect(at('Visão')).toBe(1)
    expect(at('Texto do fonte.')).toBe(3)
    // Tudo o que o include trouxe (com o include aninhado) aponta a linha da diretiva.
    expect(at('Bem-vindo à API.')).toBe(5)
    expect(at('Como autenticar')).toBe(5)
    expect(at('pagamento instantâneo')).toBe(5)
    expect(at('Fim')).toBe(7)
    expect(at('Última.')).toBe(8)
  })

  it('aplica o modelo: título, subtítulo, sumário e numeração', async () => {
    const source = ['## Introdução', 'Oi.', '### Contexto', '## Referência', '{{> connector connector.billing.v2}}'].join('\n')
    const { title, markdown, printMarkdown } = await compose(source, {
      config: { title: 'API de Pagamentos', subtitle: 'Guia', version: '2.1', organization: 'Equipe X', numberHeadings: true }
    })
    expect(title).toBe('API de Pagamentos')
    expect(markdown.startsWith('# API de Pagamentos\n\n_Guia_\n\n> Equipe X · versão 2.1 · 2026-10-25')).toBe(true)
    expect(markdown).toContain('## 1. Introdução')
    expect(markdown).toContain('### 1.1 Contexto')
    expect(markdown).toContain('## 2. Referência')
    expect(markdown).toContain('### 2.1 Conector Billing Service v2')
    expect(markdown).toContain('- [1. Introdução](#1-introdução)')
    expect(markdown).toContain('  - [2.1 Conector Billing Service v2](#21-conector-billing-service-v2)')
    // Com capa (padrão), o PDF não repete o bloco de título: a capa o traz.
    expect(printMarkdown.startsWith('## Sumário')).toBe(true)
    const plain = await compose(source, { config: { toc: false, cover: false } })
    expect(plain.markdown).not.toContain('## Sumário')
    expect(plain.printMarkdown).toBe(plain.markdown)
    expect(plain.title).toBe('Documentação de Pagamentos')
  })

  it('nunca leva valor de segredo: o gerado só pelo nome, o incluído mascarado', async () => {
    const { markdown, diagnostics } = await compose(['{{> variables}}', '{{> include docs/vazado.md}}', '{{> reference}}'].join('\n'))
    expect(markdown).not.toContain(VAULT_SECRET)
    expect(markdown).toContain('{{API_TOKEN}}')
    expect(diagnostics.some((d) => /mascarados/.test(d.message))).toBe(true)
  })

  it('prosa sobre autenticação não vira aviso de segredo', async () => {
    put('docs/auth.md', '## Autenticação\n\nToda rota exige `Authorization: Bearer <token>`: o header Authorization: Bearer leva o token do login.\n')
    const { markdown, diagnostics } = await compose('{{> include docs/auth.md}}')
    expect(markdown).toContain('o header Authorization: Bearer leva o token do login')
    expect(diagnostics.some((d) => /mascarados/.test(d.message))).toBe(false)
  })

  it('lê o modelo e a fonte do workspace, e recusa caminhos de fora', async () => {
    expect(await loadDocsProject(dir)).toMatchObject({ configExists: false, source: null, sourceFile: 'docs/projeto.md', config: {} })
    put('vvpost.docs.json', { source: 'docs/intro.md', logo: 'docs/logo.svg', theme: { primary: '#0B5FFF' } })
    const project = await loadDocsProject(dir)
    expect(project).toMatchObject({ configExists: true, sourceFile: 'docs/intro.md', configIssues: [] })
    expect(project.source).toContain('Bem-vindo')
    put('vvpost.docs.json', { theme: { primary: 'red' } })
    expect((await loadDocsProject(dir)).configIssues[0]?.message).toMatch(/theme\/primary/)
    rmSync(join(dir, 'vvpost.docs.json'))

    expect(await readDocsLogo(dir, 'docs/logo.svg')).toMatch(/^data:image\/svg\+xml;base64,/)
    await expect(readDocsLogo(dir, '../logo.svg')).rejects.toThrow(DocsError)
    await expect(readDocsLogo(dir, 'docs/intro.md')).rejects.toThrow(/PNG, JPEG/)
    const outside = mkdtempSync(join(tmpdir(), 'vvpost-fora-'))
    writeFileSync(join(outside, 'x.svg'), '<svg/>')
    // No Windows um link de arquivo pede privilégio; o de pasta (junction) não, e sai do workspace do mesmo jeito.
    if (process.platform === 'win32') symlinkSync(outside, join(dir, 'docs/link'), 'junction')
    else symlinkSync(join(outside, 'x.svg'), join(dir, 'docs/link.svg'))
    const link = process.platform === 'win32' ? 'docs/link/x.svg' : 'docs/link.svg'
    await expect(readDocsLogo(dir, link)).rejects.toThrow(/fora do workspace/)
    await expect(workspaceWritePath(dir, '../x.md')).rejects.toThrow(/inválido/)
    expect(await workspaceWritePath(dir, 'docs/novo/fonte.md')).toBe(join(await import('node:fs').then((f) => f.realpathSync.native(dir)), 'docs/novo/fonte.md'))
    rmSync(outside, { recursive: true, force: true })
    rmSync(join(dir, process.platform === 'win32' ? 'docs/link' : 'docs/link.svg'), { recursive: true, force: true })

    const files = await listDocsFiles(dir)
    expect(files.markdown.find((f) => f.file === 'connectors/billing.connector.vvpost.md')?.sections).toEqual([
      { id: 'billing', title: 'Billing', level: 1 },
      { id: 'charge_customer', title: 'Cobrar', level: 2 },
      { id: 'detalhes', title: 'Detalhes', level: 3 },
      { id: 'listar', title: 'Listar', level: 2 }
    ])
    expect(files.markdown.map((f) => f.file)).toContain('docs/intro.md')
    expect(files.images).toEqual(['docs/logo.svg'])
    expect(readFileSync(join(dir, 'docs/intro.md'), 'utf8')).toContain('Bem-vindo')
  })

  it('modelos de metodologia montam sem erro, e os próprios ficam no projeto ou no usuário', async () => {
    for (const t of BUILTIN_DOC_TEMPLATES) {
      const { diagnostics } = await compose(t.source, { config: t.config })
      expect(diagnostics.filter((d) => d.severity === 'error'), t.id).toEqual([])
    }
    const userDir = mkdtempSync(join(tmpdir(), 'vvpost-user-tpl-'))
    put('padroes/ruim.doc-template.vvpost.json', { name: 'Ruim', source: 1 })
    await saveDocTemplate(ws, { name: 'Padrão do Time', config: { numberHeadings: true, source: 'x/y.md' }, source: '## Nosso\n' }, { origin: 'project' })
    await saveDocTemplate(ws, { name: 'Meu', description: 'só meu', config: {}, source: '## Meu\n' }, { origin: 'user', dir: userDir })
    await expect(saveDocTemplate(ws, { name: 'Vaza', config: {}, source: VAULT_SECRET }, { origin: 'project' })).rejects.toThrow(/segredo/)
    const { templates, issues } = await listDocTemplates(dir, userDir)
    expect(templates.filter((t) => t.origin === 'builtin').map((t) => t.id)).toEqual(['builtin:api-guide', 'builtin:c4', 'builtin:arc42', 'builtin:diataxis', 'builtin:adr'])
    const team = templates.find((t) => t.origin === 'project')!
    expect(team).toMatchObject({ id: 'project:docs/templates/padrao-do-time.doc-template.vvpost.json', name: 'Padrão do Time', config: { numberHeadings: true } })
    // O modelo não leva o caminho da fonte: cada projeto mantém o seu.
    expect(team.config.source).toBeUndefined()
    expect(templates.find((t) => t.origin === 'user')).toMatchObject({ id: 'user:meu.doc-template.vvpost.json', description: 'só meu' })
    expect(issues).toEqual([{ file: 'padroes/ruim.doc-template.vvpost.json', message: expect.stringMatching(/"source"/) }])
    const applied = applyDocTemplate(BUILTIN_DOC_TEMPLATES[1]!, { title: 'Meu Projeto', logo: 'docs/logo.svg', numberHeadings: false, theme: { primary: '#000000' } })
    expect(applied.config).toMatchObject({ title: 'Meu Projeto', logo: 'docs/logo.svg', numberHeadings: true, subtitle: 'Arquitetura no modelo C4', methodology: 'C4 (contexto, contêineres, componentes)' })
    expect(applied.config.theme).toBeUndefined()
    expect(applied.source).toContain('C4Context')
    rmSync(userDir, { recursive: true, force: true })
    rmSync(join(dir, 'padroes'), { recursive: true, force: true })
    rmSync(join(dir, 'docs/templates'), { recursive: true, force: true })
  })

  it('seções e níveis de título fora dos blocos de código', () => {
    const md = ['# A', '```', '# não é título', '```', '## B {#b}', 'texto', '### C', '## D'].join('\n')
    expect(extractSection(md, 'b')).toBe(['## B {#b}', 'texto', '### C'].join('\n'))
    expect(extractSection(md, 'd')).toBe('## D')
    expect(extractSection(md, 'x')).toBeNull()
    expect(shiftHeadings(md, 3)).toBe(['### A', '```', '# não é título', '```', '#### B', 'texto', '##### C', '#### D'].join('\n'))
  })
})

describe('formato da página pelo modelo', () => {
  const ctx = { title: 'API <Pagamentos>', project: 'pagamentos', date: '25/10/2026', logo: 'data:image/png;base64,AAAA' }

  it('sem modelo, o PDF de sempre: título e página no rodapé, sem cabeçalho nem capa', () => {
    const layout = printLayout({}, ctx)
    expect(layout.headerTemplate).toBe('<span></span>')
    expect(layout.footerTemplate).toContain('API &lt;Pagamentos&gt;')
    expect(layout.footerTemplate).toContain('<span class="pageNumber"></span> / <span class="totalPages"></span>')
    expect(layout.cover).toBe('')
    expect(layout.pdf).toEqual({ pageSize: 'A4', landscape: false, margins: { top: 0.55, bottom: 0.65, left: 0.55, right: 0.55 } })
    expect(layout.css).toContain('#8b7cff')
  })

  it('cabeçalho com logo, rodapé, cores, fontes, página e capa', () => {
    const layout = printLayout(
      {
        title: 'ignorado aqui',
        subtitle: 'Guia <b>',
        version: '2.1',
        organization: 'Equipe X',
        theme: { primary: '#0B5FFF', heading: '#101010', font: 'serif' },
        page: { size: 'Letter', orientation: 'landscape', margins: 'wide' },
        header: { left: '{{organization}}', right: '{{title}} · v{{version}}', logo: 'right' },
        footer: { center: 'Página {{page}} de {{pages}} · {{date}} · {{desconhecido}}' }
      },
      ctx,
      { cover: true }
    )
    expect(layout.headerTemplate).toContain('Equipe X')
    expect(layout.headerTemplate).toContain('API &lt;Pagamentos&gt; · v2.1')
    expect(layout.headerTemplate).toContain('<img src="data:image/png;base64,AAAA"')
    expect(layout.footerTemplate).toContain('Página <span class="pageNumber"></span> de <span class="totalPages"></span> · 25/10/2026 · {{desconhecido}}')
    expect(layout.css).toContain('size: Letter landscape')
    expect(layout.css).toContain('#0B5FFF')
    expect(layout.css).toContain('Georgia')
    expect(layout.pdf).toMatchObject({ pageSize: 'Letter', landscape: true, margins: { top: 1.25, left: 0.9 } })
    expect(layout.cover).toContain('<div class="doc-cover-title">API &lt;Pagamentos&gt;</div>')
    expect(layout.cover).toContain('Guia &lt;b&gt;')
    expect(layout.cover).toContain('Equipe X · Versão 2.1 · 25/10/2026')
  })

  it('cor fora de #RRGGBB não chega ao CSS, e os textos ficam escapados', () => {
    const layout = printLayout({ theme: { primary: 'red;} body{display:none' } }, ctx)
    expect(layout.css).not.toContain('display:none')
    expect(fillPlaceholders('<script>{{title}}', {}, ctx)).toBe('&lt;script&gt;API &lt;Pagamentos&gt;')
  })
})

describe('diagramas do documento (editor Mermaid)', () => {
  let dir: string
  let ws: LoadedWorkspace
  const put = (path: string, data: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), data)
  }
  const read = (path: string) => readFileSync(join(dir, path), 'utf8')
  const compose = (source: string, diagramOrigins = true) =>
    composeDocumentation(ws, { flows: [], issues: [] } as unknown as FlowCatalog, { projectName: 'P', source, sourceFile: 'docs/projeto.md', diagramOrigins })

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vvpost-diagram-'))
    put('docs/arquitetura.md', ['# Arquitetura', '', 'Texto.', '', '## Contexto {#contexto}', '', '```mermaid', 'flowchart LR', '  a --> b', '```', ''].join('\n'))
    put('docs/diagramas/fila.mmd', 'sequenceDiagram\n  A->>B: oi\n')
    put('environments/dev.env.json', JSON.stringify({ id: 'dev', name: 'Dev', variables: { TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true } } }))
    put('.vvpost/secrets.local.json', JSON.stringify({ dev: { TOKEN: VAULT_SECRET } }))
    ws = await loadWorkspace(dir)
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('{{> diagram}} traz o .mmd, e a origem de cada diagrama escrito sai marcada com arquivo e linha', async () => {
    const source = ['# Doc', '', '```mermaid', 'graph TD', '  x --> y', '```', '', '{{> diagram docs/diagramas/fila.mmd}}', '', '{{> include docs/arquitetura.md#contexto}}'].join('\n')
    const { markdown, diagnostics, includes } = await compose(source)
    expect(diagnostics).toEqual([])
    expect(markdown).toContain('```mermaid\n%% vvpost:origem docs/projeto.md:3\ngraph TD')
    expect(markdown).toContain('```mermaid\n%% vvpost:origem docs/diagramas/fila.mmd\nsequenceDiagram\n  A->>B: oi\n```')
    // A seção incluída começa na linha 5 do arquivo: o bloco abre na 7.
    expect(markdown).toContain('%% vvpost:origem docs/arquitetura.md:7\nflowchart LR')
    expect(includes).toContain('docs/diagramas/fila.mmd')
    const plain = await compose(source, false)
    expect(plain.markdown).not.toContain('vvpost:origem')
    expect(plain.markdown).toContain('```mermaid\nsequenceDiagram')
  })

  it('erros do {{> diagram}} viram diagnóstico na linha', async () => {
    const { diagnostics } = await compose(['{{> diagram docs/nada.mmd}}', '{{> diagram docs/arquitetura.md}}', '{{> diagram ../../fora.mmd}}', '{{> diagram}}'].join('\n'))
    expect(diagnostics.map((d) => [d.line, d.severity])).toEqual([
      [1, 'error'],
      [2, 'error'],
      [3, 'error'],
      [4, 'error']
    ])
    expect(diagnostics[1]!.message).toContain('só arquivos .mmd')
  })

  it('o guia da IA lista todos os ícones vv do editor de diagramas', () => {
    const icons = Object.keys(JSON.parse(readFileSync('src/renderer/src/design-system/content/vv-icons.json', 'utf8')).icons)
    const guide = docsAgentGuide()
    expect(icons.length).toBeGreaterThan(40)
    for (const name of icons) expect(guide).toContain(name)
    expect(guide).toContain('{{> diagram docs/diagramas/nome.mmd}}')
  })

  it('splitDiagramOrigin separa a marca do código', () => {
    expect(splitDiagramOrigin('%% vvpost:origem docs/a.md:12\ngraph TD\n a-->b')).toEqual({ origin: { file: 'docs/a.md', line: 12 }, code: 'graph TD\n a-->b' })
    expect(splitDiagramOrigin('%% vvpost:origem docs/x.mmd\npie')).toEqual({ origin: { file: 'docs/x.mmd' }, code: 'pie' })
    expect(splitDiagramOrigin('graph TD')).toEqual({ code: 'graph TD' })
    expect(diagramFileName('Visão de Contêineres (C4)')).toBe('docs/diagramas/visao-de-conteineres-c4.mmd')
  })

  it('writeDiagram troca o bloco no Markdown e o .mmd, conferindo se nada mudou desde a abertura', async () => {
    await writeDiagram(ws, { file: 'docs/arquitetura.md', line: 7, previous: 'flowchart LR\n  a --> b', code: 'flowchart LR\n  a --> b\n  b --> c' })
    expect(read('docs/arquitetura.md')).toBe(['# Arquitetura', '', 'Texto.', '', '## Contexto {#contexto}', '', '```mermaid', 'flowchart LR', '  a --> b', '  b --> c', '```', ''].join('\n'))
    // Aberto antes da mudança: recusa, em vez de apagar o que mudou.
    await expect(writeDiagram(ws, { file: 'docs/arquitetura.md', line: 7, previous: 'flowchart LR\n  a --> b', code: 'graph TD' })).rejects.toThrow(/mudou/)
    await expect(writeDiagram(ws, { file: 'docs/arquitetura.md', line: 3, code: 'graph TD' })).rejects.toThrow(/não está mais na linha 3/)
    await writeDiagram(ws, { file: 'docs/diagramas/fila.mmd', previous: 'sequenceDiagram\n  A->>B: oi', code: 'sequenceDiagram\n  A->>B: olá' })
    expect(await readDiagram(ws, 'docs/diagramas/fila.mmd')).toBe('sequenceDiagram\n  A->>B: olá\n')
    await writeDiagram(ws, { file: 'docs/diagramas/novo.mmd', code: 'pie\n "a": 1', create: true })
    await expect(writeDiagram(ws, { file: 'docs/diagramas/novo.mmd', code: 'pie', create: true })).rejects.toThrow(/já existe/)
    await expect(writeDiagram(ws, { file: 'docs/diagramas/sumiu.mmd', code: 'pie' })).rejects.toThrow(/não existe/)
  })

  it('writeDiagram recusa segredo, cerca de código, caminho fora e arquivo que não é .md/.mmd', async () => {
    const before = read('docs/arquitetura.md')
    await expect(writeDiagram(ws, { file: 'docs/arquitetura.md', line: 7, code: `graph TD\n a[${VAULT_SECRET}]` })).rejects.toThrow(/segredo/)
    await expect(writeDiagram(ws, { file: 'docs/arquitetura.md', line: 7, code: 'graph TD\n```\n# injetado' })).rejects.toThrow(/cerca/)
    await expect(writeDiagram(ws, { file: '../fora.mmd', code: 'pie', create: true })).rejects.toThrow(DocsError)
    await expect(writeDiagram(ws, { file: '.vvpost/x.mmd', code: 'pie', create: true })).rejects.toThrow(/não pode/)
    await expect(writeDiagram(ws, { file: 'environments/dev.env.json', line: 1, code: 'pie' })).rejects.toThrow(/\.md ou \.mmd/)
    await expect(writeDiagram(ws, { file: 'docs/x.mmd', code: '   ', create: true })).rejects.toThrow(/vazio/)
    expect(read('docs/arquitetura.md')).toBe(before)
  })

  it('writeMarkdownFile grava o .md da aba de documento, conferindo se nada mudou fora desde a abertura', async () => {
    expect(markdownFileName('Guia de Integração')).toBe('docs/guia-de-integracao.md')
    await writeMarkdownFile(ws, { file: 'docs/guia.md', text: '# Guia', create: true })
    expect(await readMarkdownFile(ws, 'docs/guia.md')).toBe('# Guia\n')
    await expect(writeMarkdownFile(ws, { file: 'docs/guia.md', text: '# Outro', create: true })).rejects.toThrow(/já existe/)
    await writeMarkdownFile(ws, { file: 'docs/guia.md', previous: '# Guia', text: '# Guia\n\nTexto.\n' })
    expect(read('docs/guia.md')).toBe('# Guia\n\nTexto.\n')
    await expect(writeMarkdownFile(ws, { file: 'docs/guia.md', previous: '# Guia', text: '# x' })).rejects.toThrow(/mudou/)
    await expect(writeMarkdownFile(ws, { file: 'docs/sumiu.md', text: '# x' })).rejects.toThrow(/não existe/)
  })

  it('writeMarkdownFile recusa segredo, caminho fora e arquivo que não é .md', async () => {
    await expect(writeMarkdownFile(ws, { file: 'docs/vaza.md', text: `token ${VAULT_SECRET}`, create: true })).rejects.toThrow(/segredo/)
    await expect(writeMarkdownFile(ws, { file: '../fora.md', text: '# x', create: true })).rejects.toThrow(DocsError)
    await expect(writeMarkdownFile(ws, { file: '.git/x.md', text: '# x', create: true })).rejects.toThrow(/não pode/)
    await expect(writeMarkdownFile(ws, { file: 'environments/dev.env.json', text: '{}' })).rejects.toThrow(/\.md/)
    await expect(readMarkdownFile(ws, 'docs/diagramas/fila.mmd')).rejects.toThrow(/\.md/)
  })
})

describe('gerenciar documentos e diagramas pelo explorador', () => {
  it('renomeia (e move de pasta) um .md ou .mmd e exclui, sem sair do workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vvpost-docfiles-'))
    try {
      mkdirSync(join(dir, 'docs', 'diagramas'), { recursive: true })
      writeFileSync(join(dir, 'docs', 'guia.md'), '# Guia\n')
      writeFileSync(join(dir, 'docs', 'outro.md'), '# Outro\n')
      writeFileSync(join(dir, 'docs', 'diagramas', 'fila.mmd'), 'flowchart LR\n  a --> b\n')
      const ws = { dir } as LoadedWorkspace
      expect(await renameDocsFile(ws, { from: 'docs/guia.md', to: 'docs/c4/guia-novo.md' })).toEqual({ file: 'docs/c4/guia-novo.md' })
      expect(readFileSync(join(dir, 'docs', 'c4', 'guia-novo.md'), 'utf8')).toBe('# Guia\n')
      expect(existsSync(join(dir, 'docs', 'guia.md'))).toBe(false)
      await expect(renameDocsFile(ws, { from: 'docs/outro.md', to: 'docs/c4/guia-novo.md' })).rejects.toThrow(/já existe/)
      await expect(renameDocsFile(ws, { from: 'docs/outro.md', to: 'docs/outro.mmd' })).rejects.toThrow(/terminar em \.md/)
      await expect(renameDocsFile(ws, { from: 'docs/outro.md', to: '../fora.md' })).rejects.toThrow(DocsError)
      await expect(renameDocsFile(ws, { from: 'docs/outro.md', to: '.git/x.md' })).rejects.toThrow(/não é um documento/)
      await expect(renameDocsFile(ws, { from: 'docs/sumiu.md', to: 'docs/x.md' })).rejects.toThrow(DocsError)
      await deleteDocsFile(ws, 'docs/diagramas/fila.mmd')
      expect(existsSync(join(dir, 'docs', 'diagramas', 'fila.mmd'))).toBe(false)
      await expect(deleteDocsFile(ws, 'vvpost.docs.json')).rejects.toThrow(/só documentos/)
      await expect(deleteDocsFile(ws, '../x.md')).rejects.toThrow(DocsError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
