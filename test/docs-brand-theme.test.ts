import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fontStack, loadDocsBrand, parseTokensFile, resolveDocsBrand } from '@vvpost/core/brand'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { printLayout } from '@vvpost/core/docs/theme'
import { buildPublishBundle } from '@vvpost/core/docs/publish'
import { loadFlows } from '@vvpost/core/flows/workspace'
import { validateDocsConfig, type DocsConfig, type PublishTarget } from '@vvpost/schemas'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function workspace(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vvpost-docs-brand-'))
  dirs.push(dir)
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
  }
  return dir
}

/** Marca rosé de uma clínica fictícia: clara, com a fonte Quicksand e o título em outra fonte. */
const ROSE = {
  color: {
    $type: 'color',
    primary: { $value: '#bd948a' },
    'primary-dark': { $value: '#8a5f55' },
    text: { $value: '#262626' },
    heading: { $value: '{color.primary-dark}' }
  },
  font: {
    body: { $type: 'fontFamily', $value: ['Quicksand', 'sans-serif'] },
    heading: { $type: 'fontFamily', $value: 'Playfair Display' }
  }
}

/** Tema escuro no padrão, claro como modo (o caso do padrão visual VV). */
const DARK = {
  color: { accent: { $type: 'color', $value: '#8b7cff' }, fg: { $type: 'color', $value: '#e7eaf0' }, glass: { $type: 'color', $value: '#00000080' } },
  font: { ui: { $type: 'fontFamily', $value: ['Inter Variable', 'system-ui'] } },
  $extensions: { vvpost: { modes: { light: { 'color.accent': '#6d5dfc', 'color.fg': '#1b1f24' } } } }
}

const file = (tokens: unknown, name = 'brand/marca.tokens.json') => parseTokensFile(name, JSON.stringify(tokens))
const ctx = { title: 'API', project: 'p', date: '24/11/2026' }

describe('tema da documentação pelos tokens da marca', () => {
  it('nomes de costume: cores em #rrggbb com alias resolvido e fontes como pilha de CSS', () => {
    const { theme, issues } = resolveDocsBrand({ theme: { tokens: {} } }, [file(ROSE)])
    expect(issues).toEqual([])
    expect(theme).toEqual({
      file: 'brand/marca.tokens.json',
      primary: '#bd948a',
      text: '#262626',
      heading: '#8a5f55',
      font: '"Quicksand", sans-serif',
      headingFont: '"Playfair Display", Inter, "Segoe UI", system-ui, -apple-system, Roboto, sans-serif'
    })
  })

  it('token pedido pelo nome, modo claro e cor translúcida sobre o papel branco', () => {
    const config: DocsConfig = { theme: { tokens: { primary: 'color.accent', heading: 'color.glass', mode: 'light' } } }
    const { theme, issues } = resolveDocsBrand(config, [file(DARK)])
    expect(issues).toEqual([])
    expect(theme).toMatchObject({ primary: '#6d5dfc', text: '#1b1f24', heading: '#7f7f7f', font: '"Inter Variable", system-ui' })
  })

  it('token que não existe, de outro tipo ou modo desconhecido vira problema; o resto vale', () => {
    const config: DocsConfig = { theme: { tokens: { primary: 'color.nada', font: 'color.text', mode: 'sepia' } } }
    const { theme, issues } = resolveDocsBrand(config, [file(ROSE)])
    expect(issues.map((i) => i.message)).toEqual([
      'o modo "sepia" não existe nos tokens; valem os valores padrão',
      'theme.tokens.primary: o token color.nada não existe nos tokens da marca',
      'o token color.text não é uma fonte (fontFamily) que dê para usar na documentação'
    ])
    expect(theme?.primary).toBeUndefined()
    expect(theme?.text).toBe('#262626')
    expect(theme?.font).toBeUndefined()
    expect(theme?.headingFont).toBe('"Playfair Display", Inter, "Segoe UI", system-ui, -apple-system, Roboto, sans-serif')
  })

  it('sem arquivo de tokens não há tema; nome de fonte com cara de CSS fica de fora', () => {
    expect(resolveDocsBrand({ theme: { tokens: {} } }, [])).toEqual({ theme: null, issues: [] })
    expect(fontStack(['Evil"; } body { display:none', 'serif'])).toBe('serif')
    expect(fontStack('url(x)')).toBeNull()
  })

  it('o PDF usa as cores e as fontes da marca, e o que o modelo escreve ganha', () => {
    const brand = resolveDocsBrand({ theme: { tokens: {} } }, [file(ROSE)]).theme!
    const fromTokens = printLayout({ theme: { tokens: {} } }, ctx, { brand })
    expect(fromTokens.css).toContain('border-bottom: 3px solid #bd948a')
    expect(fromTokens.css).toContain('color: #262626')
    expect(fromTokens.css).toContain('"Quicksand", sans-serif')
    expect(fromTokens.css).toContain('font-family: "Playfair Display"')
    expect(fromTokens.footerTemplate).toContain('&quot;Quicksand&quot;, sans-serif')
    expect(fromTokens.mermaidInit).toContain('"primaryBorderColor":"#bd948a"')

    const overridden = printLayout({ theme: { tokens: {}, primary: '#0b5fff', font: 'serif' } }, ctx, { brand })
    expect(overridden.css).toContain('3px solid #0b5fff')
    expect(overridden.css).toContain('Georgia')
    expect(overridden.css).not.toContain('Quicksand')

    // Segunda trava: uma pilha que não veio do resolvedor não entra no CSS.
    const hostile = printLayout({}, ctx, { brand: { font: 'x; } body { display:none', primary: 'red;}' } })
    expect(hostile.css).not.toContain('display:none')
    expect(hostile.css).toContain('#8b7cff')
  })

  it('o schema aceita theme.tokens e recusa nome com alias', () => {
    expect(validateDocsConfig({ theme: { tokens: { primary: 'color.primary', mode: 'light' } } }).ok).toBe(true)
    expect(validateDocsConfig({ theme: { tokens: { primary: '{color.primary}' } } }).ok).toBe(false)
    expect(validateDocsConfig({ theme: { tokens: { outra: 'x' } } }).ok).toBe(false)
  })

  it('lê o brand/ do projeto, senão o da raiz do workspace', async () => {
    const root = workspace({
      'vvpost.workspace.json': { $schema: 'https://vvpost.dev/schemas/v1/workspace.json' },
      'brand/vv.tokens.json': DARK,
      'pagamentos/vvpost.project.json': { name: 'Pagamentos' },
      'clinica/vvpost.project.json': { name: 'Clínica' },
      'clinica/brand/rose.tokens.json': ROSE
    })
    const own = await loadDocsBrand(join(root, 'clinica'), { theme: { tokens: {} } })
    expect(own.theme).toMatchObject({ file: 'brand/rose.tokens.json', primary: '#bd948a' })
    expect((await loadDocsBrand(root, { theme: { tokens: {} } })).theme).toMatchObject({ primary: '#8b7cff' })
    expect((await loadDocsBrand(workspace({ 'x.json': {} }), { theme: { tokens: {} } })).theme).toBeNull()
  })

  it('o site usa a cor de destaque dos tokens', async () => {
    const dir = workspace({
      'vvpost.docs.json': { theme: { tokens: {} } },
      'brand/marca.tokens.json': ROSE,
      'connectors/api/connector.json': { id: 'api', name: 'API', version: '1.0.0', config: { baseUrl: 'https://x' }, endpoints: [{ id: 'a', name: 'A', method: 'GET', path: '/a' }] }
    })
    const target: PublishTarget = { id: 'site', provider: 'html', destination: 'dist/site', structure: [{ page: 'API', source: 'document' }] }
    const { bundle } = await buildPublishBundle(await loadWorkspace(dir), await loadFlows(dir), target, { projectName: 'API', now: new Date('2026-11-24T12:00:00Z') })
    expect(bundle.meta?.primary).toBe('#bd948a')
  })
})
