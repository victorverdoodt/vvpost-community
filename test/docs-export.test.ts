import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { loadFlows } from '@vvpost/core/flows/workspace'
import { buildPublishBundle, type PublishBundle } from '@vvpost/core/docs/publish'
import {
  createFolderPublisher,
  exportToFolder,
  htmlExporter,
  pluginExporter,
  readSiteManifest,
  SITE_MANIFEST,
  type DocsExporter,
  type SiteManifest
} from '@vvpost/core/docs/export'
import { PluginManager } from '@vvpost/core/plugins/manager'
import type { PublishTarget } from '@vvpost/schemas'

const OFFICIAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins')

const VAULT_SECRET = 'vault-s3cr3t-Kp4!export'

describe('exportar a documentação como site HTML', () => {
  let dir: string
  let out: string
  const put = (path: string, data: unknown) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  }
  const read = (path: string) => readFileSync(join(out, path), 'utf8')
  const connector = (charge: Record<string, unknown> = {}) => ({
    id: 'billing',
    name: 'Billing',
    version: '1.0.0',
    config: { baseUrl: '{{BASE_URL}}', auth: { type: 'bearer', token: '{{API_TOKEN}}' } },
    endpoints: [
      { id: 'charge', name: 'Cobrar', method: 'POST', path: '/charges', body: { amount: 10 }, ...charge },
      { id: 'list', name: 'Listar', method: 'GET', path: '/charges' }
    ]
  })
  const target = (extra: Partial<PublishTarget> = {}): PublishTarget => ({
    id: 'site',
    provider: 'html',
    destination: 'dist/site',
    structure: [
      {
        page: 'Pagamentos',
        source: 'document',
        children: [
          { folder: 'Guias', children: [{ pages: 'docs/guias/*.md' }] },
          { folder: 'Referência da API', children: [{ each: 'connector', split: 'endpoints' }] }
        ]
      }
    ],
    ...extra
  })
  const bundleAt = async (when: string, t = target()): Promise<PublishBundle> => {
    const { bundle } = await buildPublishBundle(await loadWorkspace(dir), await loadFlows(dir), t, { projectName: 'Pagamentos', now: new Date(when) })
    // O app desenha os diagramas no renderer; aqui, um SVG qualquer.
    for (const a of bundle.assets) if (a.diagram !== undefined) a.data = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
    return bundle
  }
  const folder = () => ({ dir: out, label: 'dist/site', path: 'dist/site' })

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vvpost-export-'))
    out = join(dir, 'dist/site')
    put('connectors/billing.connector.vvpost.json', connector())
    put('vvpost.docs.json', { title: 'Portal de Pagamentos', version: '2.1', organization: 'Time Pagamentos', theme: { primary: '#0a7f5a' } })
    put(
      'docs/projeto.md',
      [
        '## Visão geral',
        '',
        'Leia o [guia](guias/inicio.md#passo-1). Nada de [script](javascript:alert(1)).',
        '',
        '<script>alert("cru")</script>',
        '',
        '```mermaid',
        'flowchart LR',
        '  A --> B',
        '```',
        '',
        '> [!WARNING]',
        '> Limite de 10 por segundo.'
      ].join('\n')
    )
    put('docs/guias/inicio.md', ['# Primeiros passos', '', '## Passo 1', '', '![logo](../logo.png)', '', `Token de exemplo: ${VAULT_SECRET}`].join('\n'))
    writeFileSync(join(dir, 'docs/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    put('environments/dev.env.json', {
      id: 'dev',
      name: 'Dev',
      variables: { BASE_URL: { type: 'string', value: 'https://dev.api' }, API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true } }
    })
    put('.vvpost/secrets.local.json', { dev: { API_TOKEN: VAULT_SECRET } })
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('diagrama sem imagem (CLI sem o executável do VVPost): o site leva o mermaid.min.js e desenha no navegador', async () => {
    const { bundle } = await buildPublishBundle(await loadWorkspace(dir), await loadFlows(dir), target(), { projectName: 'Pagamentos', now: new Date('2026-10-26T12:00:00Z') })
    const live = await htmlExporter.render(bundle, { changelog: [], previous: null, mermaidScript: '/* mermaid */' })
    const page = (path: string) => String(live.find((f) => f.path === path)!.data)
    expect(page('index.html')).toContain('<pre class="vv-mermaid" role="img" aria-label="Diagrama">flowchart LR\n  A --&gt; B</pre>')
    expect(page('index.html')).toContain('<script src="assets/mermaid.min.js" defer></script><script src="assets/vvpost-site.js" defer></script>')
    // Só a página com diagrama carrega o Mermaid; o arquivo vai uma vez.
    expect(page('guias-inicio.html')).not.toContain('mermaid.min.js')
    expect(page('assets/mermaid.min.js')).toBe('/* mermaid */')
    expect(page('assets/vvpost-site.js')).toContain("securityLevel: 'strict'")
    // Sem o script, fica o código, como antes.
    const code = await htmlExporter.render(bundle, { changelog: [], previous: null })
    expect(String(code.find((f) => f.path === 'index.html')!.data)).toContain('<figure class="vv-diagram vv-diagram-code">')
    expect(code.some((f) => f.path === 'assets/mermaid.min.js')).toBe(false)
  })

  it('grava o site: páginas, navegação, busca, diagramas, imagens e o vvpost-site.json, sem segredo', async () => {
    const result = await exportToFolder(await bundleAt('2026-10-26T12:00:00Z'), htmlExporter, folder())
    expect(result.items.every((i) => i.outcome === 'created')).toBe(true)
    expect(result.destination).toEqual({ label: 'dist/site', path: 'dist/site' })
    for (const f of ['index.html', 'guias-inicio.html', 'connector-billing.html', 'endpoint-billing-charge.html', 'mudancas.html', '404.html', 'assets/vvpost-site.css', 'assets/vvpost-site.js', 'assets/vvpost-search.js', SITE_MANIFEST]) {
      expect(existsSync(join(out, f)), f).toBe(true)
    }
    const index = read('index.html')
    expect(index).toContain('<title>Pagamentos · Portal de Pagamentos</title>')
    expect(index).toContain('<span class="vv-version">2.1</span>')
    // Link entre arquivos .md vira link entre páginas; javascript: some; HTML cru vira texto.
    expect(index).toContain('<a href="guias-inicio.html#passo-1">guia</a>')
    expect(index).not.toContain('javascript:')
    expect(index).not.toContain('<script>alert')
    expect(index).toContain('&lt;script&gt;alert(&quot;cru&quot;)&lt;/script&gt;')
    expect(index).toMatch(/<figure class="vv-diagram"><img src="assets\/vv-diagrama-[0-9a-f]{12}\.svg"/)
    expect(index).toContain('vv-alert-warning')
    // Navegação com a estrutura: a pasta e a página atual.
    expect(index).toContain('<summary>Referência da API</summary>')
    expect(index).toContain('<a href="index.html" class="vv-current" aria-current="page">Pagamentos</a>')
    expect(read('assets/vvpost-site.css')).toContain('--vv-accent:#0a7f5a')
    expect(read('guias-inicio.html')).toMatch(/<img src="assets\/vv-imagem-[0-9a-f]{12}\.png" alt="logo"/)
    expect(read('assets/vvpost-search.js')).toContain('"t":"Primeiros passos"')
    expect(read('mudancas.html')).toContain('Primeira publicação da documentação.')
    for (const f of ['index.html', 'guias-inicio.html', 'assets/vvpost-search.js', SITE_MANIFEST]) expect(read(f)).not.toContain(VAULT_SECRET)
    const manifest = (await readSiteManifest(out)) as SiteManifest
    expect(manifest.exporter).toBe('html')
    expect(manifest.pages['document']).toMatchObject({ kind: 'page', file: 'index.html' })
    expect(Object.keys(manifest.endpoints)).toEqual(['billing/charge', 'billing/list'])
    expect(manifest.changelog).toHaveLength(1)
  })

  it('a segunda exportação compara com a anterior: plano, página Mudanças e o que saiu da estrutura', async () => {
    put('connectors/billing.connector.vvpost.json', {
      ...connector({ description: 'Agora com idempotência.' }),
      endpoints: [connector({ description: 'Agora com idempotência.' }).endpoints[0], { id: 'refund', name: 'Estornar', method: 'POST', path: '/refunds' }]
    })
    put('docs/guias/novo.md', '# Guia novo\n\nOi.')
    const bundle = await bundleAt('2026-11-02T12:00:00Z')
    const publisher = createFolderPublisher(htmlExporter, { folder: async () => folder(), release: 'v2.2' })
    expect(await publisher.session(bundle.target)).toMatchObject({ status: 'signedIn', destination: 'dist/site' })
    const plan = await publisher.plan(bundle, { openExternal: async () => {} })
    const action = (key: string) => plan.items.find((i) => i.key === key)?.action
    expect(action('document')).toBe('same')
    expect(action('file:docs/guias/novo.md')).toBe('create')
    expect(action('endpoint:billing/refund')).toBe('create')
    expect(action('endpoint:billing/charge')).toBe('update')
    expect(action('endpoint:billing/list')).toBe('orphan')
    const charge = plan.items.find((i) => i.key === 'endpoint:billing/charge')!
    expect(charge.after).toContain('Agora com idempotência.')
    expect(charge.before).not.toContain('Agora com idempotência.')

    // Sem confirmar a mudança nem o arquivamento: a página antiga fica como estava.
    const before = read('endpoint-billing-charge.html')
    const result = await publisher.publish(bundle, plan, { update: [], conflicts: [], archive: [] }, { openExternal: async () => {} })
    const outcome = (key: string) => result.items.find((i) => i.key === key)?.outcome
    expect(outcome('endpoint:billing/charge')).toBe('skipped')
    expect(outcome('endpoint:billing/list')).toBe('skipped')
    expect(outcome('file:docs/guias/novo.md')).toBe('created')
    expect(read('endpoint-billing-charge.html')).toBe(before)
    expect(existsSync(join(out, 'endpoint-billing-list.html'))).toBe(true)

    const changes = read('mudancas.html')
    expect(changes).toContain('v2.2')
    expect(changes).toContain('<h3 class="vv-added">Endpoints novos</h3><ul><li><a href="endpoint-billing-refund.html">POST /refunds · Estornar</a></li></ul>')
    expect(changes).toContain('<h3 class="vv-changed">Endpoints alterados</h3><ul><li><a href="endpoint-billing-charge.html">POST /charges · Cobrar</a></li></ul>')
    expect(changes).toContain('<h3 class="vv-removed">Endpoints removidos</h3><ul><li>GET /charges · Listar</li></ul>')
    expect(changes).toContain('Páginas novas')

    // A próxima exportação, com tudo confirmado, ainda vê a mudança que ficou para trás.
    const again = await exportToFolder(await bundleAt('2026-11-03T12:00:00Z'), htmlExporter, folder())
    expect(again.items.find((i) => i.key === 'endpoint:billing/charge')?.outcome).toBe('updated')
    expect(again.items.find((i) => i.key === 'endpoint:billing/list')?.outcome).toBe('archived')
    expect(read('endpoint-billing-charge.html')).toContain('Agora com idempotência.')
    expect(existsSync(join(out, 'endpoint-billing-list.html'))).toBe(false)
  })

  it('página editada à mão na pasta é conflito; o CLI só sobrescreve com force', async () => {
    writeFileSync(join(out, 'guias-novo.html'), '<html><main>editado à mão</main></html>')
    const bundle = await bundleAt('2026-11-04T12:00:00Z')
    await expect(exportToFolder(bundle, htmlExporter, folder())).rejects.toThrow(/editadas à mão.*Guia novo.*--force/)
    const forced = await exportToFolder(bundle, htmlExporter, folder(), { force: true })
    expect(forced.items.find((i) => i.key === 'file:docs/guias/novo.md')?.outcome).toBe('updated')
    expect(read('guias-novo.html')).toContain('Oi.')
  })

  it('nada muda: o histórico não ganha entrada', async () => {
    const before = ((await readSiteManifest(out)) as SiteManifest).changelog.length
    await exportToFolder(await bundleAt('2026-11-05T12:00:00Z'), htmlExporter, folder())
    expect(((await readSiteManifest(out)) as SiteManifest).changelog).toHaveLength(before)
  })

  it('recusa pasta com arquivos que não é uma exportação, e exportação de outro exportador', async () => {
    const other = join(dir, 'outra')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'leia.txt'), 'meu')
    const bundle = await bundleAt('2026-11-06T12:00:00Z')
    await expect(exportToFolder(bundle, htmlExporter, { dir: other, label: 'outra' })).rejects.toThrow(/já tem arquivos/)
    const fake: DocsExporter = { id: 'docusaurus', title: 'D', render: async () => [{ path: 'a.md', data: 'x' }] }
    await expect(exportToFolder(bundle, fake, folder())).rejects.toThrow(/exportação de "html"/)
  })

  it('Backstage TechDocs e sitemap com baseUrl', async () => {
    const site = join(dir, 'dist/techdocs')
    const bundle = await bundleAt('2026-11-07T12:00:00Z', target({ site: { backstage: true, baseUrl: 'https://portal.example.com/pagamentos/', title: 'API de Pagamentos' } }))
    await exportToFolder(bundle, htmlExporter, { dir: site, label: 'dist/techdocs' })
    const meta = JSON.parse(readFileSync(join(site, 'techdocs_metadata.json'), 'utf8'))
    expect(meta).toMatchObject({ site_name: 'API de Pagamentos', build_timestamp: Date.parse('2026-11-07T12:00:00Z') / 1000 })
    expect(meta.files).toContain('index.html')
    expect(meta.etag).toMatch(/^[0-9a-f]{40}$/)
    expect(readFileSync(join(site, 'sitemap.xml'), 'utf8')).toContain('<loc>https://portal.example.com/pagamentos/index.html</loc>')
    expect(readFileSync(join(site, 'index.html'), 'utf8')).toContain('<link rel="canonical" href="https://portal.example.com/pagamentos/index.html">')
  })

  it('exportador de plugin: arquivos de texto e base64, caminhos fora da pasta recusados', async () => {
    const bundle = await bundleAt('2026-11-08T12:00:00Z', target({ provider: 'docusaurus' }))
    let received: unknown
    const ok = pluginExporter({ id: 'docusaurus', title: 'Docusaurus', pluginName: 'Acme' }, async (input) => {
      received = input
      return { files: [{ path: 'docs/intro.md', text: '# Oi', page: 'document' }, { path: 'static/img.bin', base64: Buffer.from([1, 2, 3]).toString('base64') }] }
    })
    const site = join(dir, 'dist/docusaurus')
    await exportToFolder(bundle, ok, { dir: site, label: 'dist/docusaurus' })
    expect(readFileSync(join(site, 'docs/intro.md'), 'utf8')).toBe('# Oi')
    expect([...readFileSync(join(site, 'static/img.bin'))]).toEqual([1, 2, 3])
    // Os anexos vão em base64 (o processo do plugin recebe JSON).
    const asset = (received as { bundle: { assets: { base64?: string; diagram?: string }[] } }).bundle.assets.find((a) => a.diagram)
    expect(asset?.base64).toBe(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'))
    expect(JSON.stringify(received)).not.toContain(VAULT_SECRET)

    for (const bad of ['../fora.txt', '/etc/x', 'a/../../b', SITE_MANIFEST, 'C:\\x']) {
      const exporter = pluginExporter({ id: 'docusaurus', title: 'D', pluginName: 'Acme' }, async () => ({ files: [{ path: bad, text: 'x' }] }))
      await expect(exportToFolder(bundle, exporter, { dir: join(dir, 'dist/ruim'), label: 'ruim' }), bad).rejects.toThrow(/caminho inválido|não pode gravar/)
    }
    expect(existsSync(join(dir, 'fora.txt'))).toBe(false)
    const empty = pluginExporter({ id: 'docusaurus', title: 'D', pluginName: 'Acme' }, async () => ({ nada: true }))
    await expect(exportToFolder(bundle, empty, { dir: join(dir, 'dist/ruim'), label: 'ruim' })).rejects.toThrow(/não devolveu \{ files/)
  })

  it('exportador de plugin no processo do plugin: o oficial do MkDocs e um que tenta gravar no disco', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'vvpost-export-ud-'))
    const userDir = join(userData, 'plugins')
    mkdirSync(join(userDir, 'acme-gravador'), { recursive: true })
    writeFileSync(
      join(userDir, 'acme-gravador/vvpost-plugin.json'),
      JSON.stringify({ id: 'acme-gravador', name: 'Gravador', version: '1.0.0', main: 'index.js', apiVersion: 1, contributes: { exporters: [{ id: 'gravador', title: 'Gravador' }] } })
    )
    writeFileSync(
      join(userDir, 'acme-gravador/index.js'),
      `module.exports = { exporters: { gravador: { export() { require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'invadido.txt'))}, 'x'); return { files: [] } } } } }`
    )
    const manager = new PluginManager({ officialDir: OFFICIAL, userDir, stateFile: join(userData, 'plugins.json') })
    try {
      const entries = await manager.exporters()
      expect(entries.map((e) => [e.pluginId, e.id])).toEqual([
        ['vvpost-plugin-mkdocs', 'mkdocs'],
        ['acme-gravador', 'gravador']
      ])
      const { plugins } = await manager.catalog()
      expect(plugins.find((p) => p.id === 'vvpost-plugin-mkdocs')?.exporters).toEqual([expect.objectContaining({ id: 'mkdocs', title: 'MkDocs (Backstage TechDocs)' })])

      const mk = entries.find((e) => e.id === 'mkdocs')!
      const exporter = pluginExporter({ ...mk }, (input, signal) => mk.invoke(input, signal))
      const site = join(dir, 'dist/mkdocs')
      const bundle = await bundleAt('2026-11-09T12:00:00Z', target({ provider: 'mkdocs', site: { backstage: true } }))
      await exportToFolder(bundle, exporter, { dir: site, label: 'dist/mkdocs' })
      const yml = readFileSync(join(site, 'mkdocs.yml'), 'utf8')
      expect(yml).toContain('site_name: "Portal de Pagamentos"')
      expect(yml).toContain('  - "Pagamentos":\n      - "index.md"')
      expect(yml).toContain('plugins:\n  - techdocs-core')
      const index = readFileSync(join(site, 'docs/index.md'), 'utf8')
      expect(index).toContain('[guia](guias-inicio.md#passo-1)')
      expect(index).toContain('!!! warning "Atenção"')
      expect(index).toMatch(/!\[Diagrama\]\(assets\/vv-diagrama-[0-9a-f]{12}\.png\)/)
      expect(readFileSync(join(site, 'docs/guias-inicio.md'), 'utf8')).toContain('## Passo 1 { #passo-1 }')
      expect(existsSync(join(site, 'docs/mudancas.md'))).toBe(true)
      expect(readFileSync(join(site, 'docs/guias-inicio.md'), 'utf8')).not.toContain(VAULT_SECRET)

      // O processo do plugin não escreve em disco (permissões do Node): a exportação falha e nada aparece.
      const bad = entries.find((e) => e.id === 'gravador')!
      const badExporter = pluginExporter({ ...bad }, (input) => bad.invoke(input))
      await expect(exportToFolder(bundle, badExporter, { dir: join(dir, 'dist/gravador'), label: 'gravador' })).rejects.toThrow(/gravador .*falhou/)
      expect(existsSync(join(dir, 'invadido.txt'))).toBe(false)
    } finally {
      await manager.shutdown()
      rmSync(userData, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('SVG do Mermaid como arquivo', () => {
  it('fecha <br>, troca &nbsp; e tira a largura de 100% (o diagrama não estica)', async () => {
    const { svgFile } = await import('@vvpost/core/docs/publish')
    const svg = '<svg id="m" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 243.5px;" viewBox="4 4 243.5 296"><foreignObject><p>A<br>B&nbsp;C<br/>D</p></foreignObject></svg>'
    expect(svgFile(svg)).toBe('<svg id="m" width="243.5" height="296" xmlns="http://www.w3.org/2000/svg" style="max-width: 243.5px;" viewBox="4 4 243.5 296"><foreignObject><p>A<br/>B&#160;C<br/>D</p></foreignObject></svg>')
    expect(svgFile('<svg width="120" height="40"></svg>')).toBe('<svg width="120" height="40"></svg>')
  })
})
