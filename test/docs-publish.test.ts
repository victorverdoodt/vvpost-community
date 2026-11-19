import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadWorkspace, type LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import { loadFlows } from '@vvpost/core/flows/workspace'
import {
  applyResult,
  blocksToText,
  buildPublishBundle,
  loadPublishConfig,
  markdownToBlocks,
  pendingDiagrams,
  recordPublished,
  type PublishBlock,
  type PublishTreeNode
} from '@vvpost/core/docs/publish'
import type { PublishTarget } from '@vvpost/schemas'
import type { FlowCatalog } from '@shared/ipc'

const VAULT_SECRET = 'vault-s3cr3t-Kp4!publish'

const none = { link: (href: string) => ({ href }), image: () => null, diagram: () => 'd.png' }

describe('Markdown para a árvore neutra do "Enviar para…"', () => {
  it('títulos com âncora, alertas, tarefas, tabelas, código e diagramas', () => {
    const blocks = markdownToBlocks(
      [
        '## Visão geral {#visao}',
        '',
        'Texto com **negrito**, `código` e [link](https://example.com).',
        '',
        '## Visão geral',
        '',
        '> [!WARNING]',
        '> Cuidado com o limite.',
        '',
        '- [x] feito',
        '- [ ] falta',
        '',
        '| Campo | Tipo |',
        '| :--- | ---: |',
        '| id | string |',
        '',
        '```json',
        '{ "a": 1 }',
        '```',
        '',
        '```mermaid',
        '%% vvpost:origem docs/a.md:3',
        'flowchart LR',
        '  A --> B',
        '```',
        '',
        '<div onclick="x()">cru</div>',
        '',
        'Fim &amp; mais.'
      ].join('\n'),
      none
    )
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 2, anchor: 'visao', children: [{ type: 'text', text: 'Visão geral' }] })
    // O mesmo título sem {#id}: âncora do GitHub; a explícita não conta como repetida.
    expect(blocks[2]).toMatchObject({ type: 'heading', anchor: 'visão-geral' })
    expect(blocks[1]).toMatchObject({
      type: 'paragraph',
      children: [
        { type: 'text', text: 'Texto com ' },
        { type: 'strong', children: [{ type: 'text', text: 'negrito' }] },
        { type: 'text', text: ', ' },
        { type: 'code', text: 'código' },
        { type: 'text', text: ' e ' },
        { type: 'link', href: 'https://example.com', children: [{ type: 'text', text: 'link' }] },
        { type: 'text', text: '.' }
      ]
    })
    expect(blocks[3]).toMatchObject({ type: 'alert', kind: 'warning', blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'Cuidado com o limite.' }] }] })
    expect(blocks[4]).toMatchObject({ type: 'list', ordered: false, items: [{ checked: true }, { checked: false }] })
    expect(blocks[5]).toMatchObject({ type: 'table', align: ['left', 'right'], rows: [[[{ type: 'text', text: 'id' }], [{ type: 'text', text: 'string' }]]] })
    expect(blocks[6]).toEqual({ type: 'code', language: 'json', text: '{ "a": 1 }' })
    expect(blocks[7]).toEqual({ type: 'diagram', asset: 'd.png', source: 'flowchart LR\n  A --> B' })
    expect(blocks[8]).toEqual({ type: 'html', text: '<div onclick="x()">cru</div>' })
    expect(blocks[9]).toEqual({ type: 'paragraph', children: [{ type: 'text', text: 'Fim & mais.' }] })
    const text = blocksToText(blocks)
    expect(text).toContain('## Visão geral')
    expect(text).toContain('- feito')
    expect(text).toContain('| id | string |')
  })

  it('links relativos viram links entre páginas ou âncoras', () => {
    const blocks = markdownToBlocks('Veja [o guia](guia.md#passo), [acima](#topo) e [fora](https://x.dev).', {
      ...none,
      link: (href) => (href.startsWith('#') ? { anchor: href.slice(1) } : href.startsWith('guia.md') ? { page: 'file:docs/guia.md', anchor: 'passo' } : { href })
    })
    const p = blocks[0] as Extract<PublishBlock, { type: 'paragraph' }>
    expect(p.children.map((c) => c.type)).toEqual(['text', 'pageLink', 'text', 'anchorLink', 'text', 'link', 'text'])
    expect(p.children[1]).toMatchObject({ page: 'file:docs/guia.md', anchor: 'passo' })
  })
})

describe('pacote de publicação', () => {
  let dir: string
  let ws: LoadedWorkspace
  let flows: FlowCatalog
  const put = (path: string, data: unknown) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  }
  const target = (structure: PublishTarget['structure'], extra: Partial<PublishTarget> = {}): PublishTarget => ({
    id: 'confluence',
    provider: 'confluence-cloud',
    destination: 'catalog:pagamentos',
    structure,
    ...extra
  })
  const build = (t: PublishTarget) => buildPublishBundle(ws, flows, t, { projectName: 'Pagamentos', now: new Date('2026-10-26T12:00:00Z') })
  const find = (nodes: PublishTreeNode[], key: string): PublishTreeNode | undefined => {
    for (const n of nodes) {
      if (n.key === key) return n
      const c = find(n.children, key)
      if (c) return c
    }
    return undefined
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vvpost-publish-'))
    put('connectors/billing.connector.vvpost.json', {
      id: 'billing',
      name: 'Billing',
      version: '1.0.0',
      config: { baseUrl: '{{BASE_URL}}', auth: { type: 'bearer', token: '{{API_TOKEN}}' } },
      endpoints: [
        { id: 'charge', name: 'Cobrar', method: 'POST', path: '/charges', body: { amount: 10 } },
        { id: 'list', name: 'Listar', method: 'GET', path: '/charges' }
      ]
    })
    put('connectors/users.connector.vvpost.json', { id: 'users', name: 'Accounts', version: '1.0.0', config: { baseUrl: 'https://users.dev' }, endpoints: [{ id: 'me', name: 'Eu', method: 'GET', path: '/me' }] })
    put('docs/projeto.md', ['## Visão geral', '', 'Leia o [guia](guias/inicio.md#passo-1).', '', '```mermaid', 'flowchart LR', '  A --> B', '```', '', '{{> summary}}'].join('\n'))
    put('docs/guias/inicio.md', ['# Primeiros passos', '', '## Passo 1', '', '![logo](../logo.png)', '', 'Volte ao [projeto](../projeto.md).'].join('\n'))
    put('docs/guias/zz-avancado.md', ['# Avançado', '', 'Texto.'].join('\n'))
    put('docs/arquitetura.md', ['# Arquitetura', '', '## Contexto', '', 'C4 aqui.', '', '```mermaid', 'flowchart LR', '  A --> B', '```', '', '## Outra', '', 'fora'].join('\n'))
    put('docs/vazado.md', `# Vazado\n\nO segredo é ${VAULT_SECRET}.`)
    writeFileSync(join(dir, 'docs/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    put('environments/dev.env.json', {
      id: 'dev',
      name: 'Dev',
      variables: {
        BASE_URL: { type: 'string', value: 'https://dev.api' },
        API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
      }
    })
    put('.vvpost/secrets.local.json', { dev: { API_TOKEN: VAULT_SECRET } })
    ws = await loadWorkspace(dir)
    flows = await loadFlows(dir)
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('monta pastas e páginas pela estrutura, com globs, conectores e endpoints como filhas', async () => {
    const { bundle, diagnostics } = await build(
      target([
        {
          page: 'Pagamentos',
          source: 'document',
          children: [
            { folder: 'Guias', children: [{ pages: 'docs/guias/*.md' }] },
            { folder: 'Arquitetura', children: [{ page: 'Contexto C4', source: 'docs/arquitetura.md#contexto' }] },
            { folder: 'Referência', children: [{ each: 'connector', split: 'endpoints' }] }
          ]
        }
      ])
    )
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const shape = (nodes: PublishTreeNode[]): unknown => nodes.map((n) => [n.kind, n.key, n.title, ...(n.children.length ? [shape(n.children)] : [])])
    expect(shape(bundle.nodes)).toEqual([
      [
        'page',
        'document',
        'Pagamentos',
        [
          ['folder', 'folder:pagamentos/guias', 'Guias', [
            ['page', 'file:docs/guias/inicio.md', 'Primeiros passos'],
            ['page', 'file:docs/guias/zz-avancado.md', 'Avançado']
          ]],
          ['folder', 'folder:pagamentos/arquitetura', 'Arquitetura', [['page', 'file:docs/arquitetura.md#contexto', 'Contexto C4']]],
          ['folder', 'folder:pagamentos/referência', 'Referência', [
            // Em ordem alfabética do nome: Accounts antes de Billing.
            ['page', 'connector:users', 'Accounts', [['page', 'endpoint:users/me', 'GET /me · Eu']]],
            ['page', 'connector:billing', 'Billing', [
              ['page', 'endpoint:billing/charge', 'POST /charges · Cobrar'],
              ['page', 'endpoint:billing/list', 'GET /charges · Listar']
            ]]
          ]]
        ]
      ]
    ])
    expect(bundle.target).toEqual({ id: 'confluence', name: 'confluence', provider: 'confluence-cloud', destination: 'catalog:pagamentos', diagrams: 'png' })
    expect(bundle.project).toBe('Pagamentos')
    // A página do conector com endpoints em páginas filhas não repete os endpoints.
    expect(find(bundle.nodes, 'connector:billing')!.page!.markdown).not.toContain('POST /charges')
    expect(find(bundle.nodes, 'endpoint:billing/charge')!.page!.markdown).toContain('/charges')
    // O título da página não se repete no corpo; a seção pedida vem sem o resto.
    expect(find(bundle.nodes, 'file:docs/guias/inicio.md')!.page!.markdown).not.toContain('# Primeiros passos')
    const c4 = find(bundle.nodes, 'file:docs/arquitetura.md#contexto')!.page!
    expect(c4.markdown).toContain('C4 aqui.')
    expect(c4.markdown).not.toContain('fora')
  })

  it('liga páginas entre si, anexa imagens e diagramas (o mesmo diagrama uma vez só)', async () => {
    const { bundle } = await build(
      target([
        { page: 'Pagamentos', source: 'document', children: [{ pages: 'docs/guias/*.md' }, { page: 'Arquitetura', source: 'docs/arquitetura.md' }] }
      ])
    )
    const doc = find(bundle.nodes, 'document')!.page!
    expect(doc.toc).toBe(true)
    expect(JSON.stringify(doc.blocks)).toContain('"type":"pageLink","page":"file:docs/guias/inicio.md","anchor":"passo-1"')
    const guide = find(bundle.nodes, 'file:docs/guias/inicio.md')!.page!
    expect(JSON.stringify(guide.blocks)).toContain('"type":"pageLink","page":"document"')
    const image = bundle.assets.find((a) => a.file === 'docs/logo.png')!
    expect(image.mediaType).toBe('image/png')
    expect([...image.data!]).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const diagrams = pendingDiagrams(bundle)
    expect(diagrams).toEqual([{ id: expect.stringMatching(/^vv-diagrama-[0-9a-f]{12}\.png$/), source: 'flowchart LR\n  A --> B' }])
  })

  it('hash estável: muda com o conteúdo, não com a hora', async () => {
    const t = target([{ page: 'Arquitetura', source: 'docs/arquitetura.md' }])
    const a = await build(t)
    const b = await buildPublishBundle(ws, flows, t, { projectName: 'Pagamentos', now: new Date('2027-01-01T00:00:00Z') })
    expect(b.bundle.nodes[0]!.hash).toBe(a.bundle.nodes[0]!.hash)
    const renamed = await build(target([{ page: 'Arquitetura nova', source: 'docs/arquitetura.md' }]))
    expect(renamed.bundle.nodes[0]!.hash).not.toBe(a.bundle.nodes[0]!.hash)
    expect(renamed.bundle.nodes[0]!.key).toBe(a.bundle.nodes[0]!.key)
  })

  it('origem que não existe e chave repetida viram diagnósticos, sem derrubar o resto', async () => {
    const { bundle, diagnostics } = await build(
      target([
        { page: 'Sumiu', source: 'docs/nao-existe.md' },
        { page: 'Conector', source: 'connector:nada' },
        { page: 'A', source: 'docs/arquitetura.md' },
        { page: 'B', source: 'docs/arquitetura.md' },
        { pages: 'docs/vazio/*.md' }
      ])
    )
    expect(bundle.nodes.map((n) => n.title)).toEqual(['A'])
    expect(diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining('nao-existe.md'),
      expect.stringContaining('conector "nada"'),
      expect.stringContaining('repete a chave'),
      expect.stringContaining('não encontrou nenhum .md')
    ])
  })

  it('nenhum valor de segredo entra no pacote', async () => {
    const { bundle } = await build(target([{ page: 'Vazado', source: 'docs/vazado.md' }, { each: 'connector' }]))
    expect(JSON.stringify(bundle)).not.toContain(VAULT_SECRET)
  })

  it('grava os ids publicados no vvpost.publish.json e recusa se o arquivo mudou no meio', async () => {
    const config = { targets: [target([{ page: 'Arquitetura', source: 'docs/arquitetura.md' }])] }
    put('vvpost.publish.json', config)
    const loaded = await loadPublishConfig(dir)
    expect(loaded.issues).toEqual([])
    const result = {
      destination: { label: 'PAG' },
      items: [{ key: 'file:docs/arquitetura.md', kind: 'page' as const, title: 'Arquitetura', outcome: 'created' as const, id: '42', version: 1, hash: 'h1', url: 'https://x/42' }]
    }
    await recordPublished(dir, loaded.text, 'confluence', result)
    const saved = JSON.parse(readFileSync(join(dir, 'vvpost.publish.json'), 'utf8'))
    expect(saved.targets[0].published).toEqual({ 'file:docs/arquitetura.md': { id: '42', kind: 'page', version: 1, hash: 'h1', url: 'https://x/42' } })
    await expect(recordPublished(dir, loaded.text, 'confluence', result)).rejects.toThrow(/mudou durante a publicação/)
    // Arquivar tira do mapa; pular mantém o que estava.
    const next = applyResult(saved.targets[0], {
      destination: { label: 'PAG' },
      items: [
        { key: 'file:docs/arquitetura.md', kind: 'page', title: 'Arquitetura', outcome: 'skipped' },
        { key: 'velha', kind: 'page', title: 'Velha', outcome: 'archived' }
      ]
    })
    expect(next).toEqual(saved.targets[0].published)
  })

  it('arquivo inválido vira problema com o caminho', async () => {
    put('vvpost.publish.json', { targets: [{ id: 'x', provider: 'p', destination: 'd', structure: [{ titulo: 'x' }] }] })
    const loaded = await loadPublishConfig(dir)
    expect(loaded.config).toBeNull()
    expect(loaded.issues[0]!.message).toMatch(/^\/targets\/0\/structure\/0/)
  })
})
